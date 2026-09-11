/**
 * Simulador local del backend de Apps Script (para probar sin publicar en Google).
 *
 * Carga los archivos de backend/ tal cual y emula los servicios de Apps Script que usan
 * (SpreadsheetApp con una hoja en memoria, PropertiesService, CacheService, LockService,
 * UrlFetchApp con curl síncrono, Utilities, ContentService, ScriptApp, Session, Logger).
 *
 * Uso:  node herramientas/simulador_backend.js [puerto]   (por defecto 8787)
 *       -> API en http://localhost:8787/  con la clave de enlace "CLAVE-DE-PRUEBA-LOCAL-1234"
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PUERTO = parseInt(process.argv[2], 10) || 8787;
const DIR = path.join(__dirname, '..', 'backend');
const CLAVE_PRUEBA = 'CLAVE-DE-PRUEBA-LOCAL-1234';

// ------------------------------------------------------------------ hoja en memoria
class Hoja {
  constructor(nombre, filas) { this.nombre = nombre; this.filas = filas || []; }
  getName() { return this.nombre; }
  getLastRow() { return this.filas.length; }
  getRange(fila, col, nFilas = 1, nCols = 1) {
    const h = this;
    return {
      getValues() { const out = []; for (let r = 0; r < nFilas; r++) { const f = h.filas[fila - 1 + r] || []; out.push(Array.from({ length: nCols }, (_, c) => f[col - 1 + c] === undefined ? '' : f[col - 1 + c])); } return out; },
      getValue() { return this.getValues()[0][0]; },
      setValue(v) { while (h.filas.length < fila) h.filas.push([]); h.filas[fila - 1][col - 1] = v; },
      setValues(vals) { vals.forEach((f, r) => f.forEach((v, c) => { while (h.filas.length < fila + r) h.filas.push([]); h.filas[fila - 1 + r][col - 1 + c] = v; })); },
    };
  }
  appendRow(f) { this.filas.push(f.slice()); }
}
const encabezadoBD = ['ID', 'FECHA', 'HORA', 'CARTERA', 'TIPO', 'MONTO USDT', 'TASA', 'TOTAL VES', 'COMISION USDT', 'COMISION VES', 'USDT NETO', 'VES NETO', 'TASA EFECTIVA', 'TASA BCV', 'TASA P2P REF', 'DIF BCV', 'DIF BCV %', 'DIF P2P', 'EQUIV USD', 'CONTRAPARTE', 'METODO', 'REF', 'OBS', 'ESTADO', 'DISPOSITIVO', 'REGISTRADO', 'MOTIVO'];
const hojas = { BD_USDT: new Hoja('BD_USDT', [encabezadoBD]), TASAS: new Hoja('TASAS', [['FECHA HORA', 'BCV', 'BCV FECHA VALOR', 'PC MEJOR', 'PC PROM5', 'PV MEJOR', 'PV PROM5', 'BRECHA', 'FUENTE']]) };
// Historial de tasas de ejemplo (como lo deja el disparador real) para que la gráfica de inicio se pruebe
for (let i = 8; i >= 1; i--) hojas.TASAS.appendRow([new Date(Date.now() - i * 1800000), 832.4883, new Date('2026-09-11T16:00:00Z'), 958, 956.14 + i * 0.3, 954.69, 957.62 - i * 0.2, 0.1503, 'bcv.org.ve']);

// ------------------------------------------------------------------ servicios emulados
const propiedades = { API_KEY: CLAVE_PRUEBA, SESSION_SECRET: 'secreto-de-sesion-local' };
const cache = {};
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytes = s => (typeof s === 'string' ? [...Buffer.from(s, 'utf8')] : s);

const servicios = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => hojas[n] || null }), flush() {} },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => propiedades[k] === undefined ? null : propiedades[k], setProperty: (k, v) => { propiedades[k] = v; }, deleteProperty: k => { delete propiedades[k]; } }) },
  CacheService: { getScriptCache: () => ({ get: k => (cache[k] && cache[k].exp > Date.now()) ? cache[k].v : null, put: (k, v, s) => { cache[k] = { v, exp: Date.now() + (s || 600) * 1000 }; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }) },
  Session: { getScriptTimeZone: () => 'America/Caracas' },
  Logger: { log: (...a) => console.log('[Logger]', ...a) },
  console,
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ texto: t, setMimeType() { return this; } }) },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    base64EncodeWebSafe: b => b64url(Buffer.from(b)),
    base64DecodeWebSafe: s => [...Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')],
    computeHmacSha256Signature: (t, s) => [...crypto.createHmac('sha256', Buffer.from(bytes(s))).update(Buffer.from(bytes(t))).digest()],
    computeDigest: (_a, t) => [...crypto.createHash('sha256').update(String(t)).digest()],
    DigestAlgorithm: { SHA_256: 'sha256' },
    newBlob: (d) => ({ getBytes: () => bytes(d), getDataAsString: () => Buffer.from(d).toString('utf8') }),
    formatDate: (d, tz, patron) => {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
      return patron.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour === '24' ? '00' : p.hour).replace('mm', p.minute).replace('ss', p.second);
    },
  },
  UrlFetchApp: {
    fetch(url, o = {}) {
      const args = ['-s', '-L', '-m', '25', '-o', '-', '-w', '\n%{http_code}', '-A', 'Mozilla/5.0'];
      if (o.validateHttpsCertificates === false) args.push('-k');
      if (o.method && o.method.toLowerCase() === 'post') { args.push('-X', 'POST'); }
      Object.entries(o.headers || {}).forEach(([k, v]) => args.push('-H', k + ': ' + v));
      if (o.contentType) args.push('-H', 'Content-Type: ' + o.contentType);
      if (o.payload !== undefined) {
        if (typeof o.payload === 'string') args.push('--data-binary', o.payload);
        else Object.entries(o.payload).forEach(([k, v]) => args.push('--data-urlencode', k + '=' + v));
      }
      args.push(url);
      let salida;
      try { salida = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); }
      catch (e) { if (o.muteHttpExceptions) return { getResponseCode: () => 0, getContentText: () => '' }; throw e; }
      const i = salida.lastIndexOf('\n');
      const codigo = parseInt(salida.slice(i + 1), 10), cuerpo = salida.slice(0, i);
      if (codigo >= 400 && !o.muteHttpExceptions) throw new Error('HTTP ' + codigo);
      return { getResponseCode: () => codigo, getContentText: () => cuerpo };
    },
  },
};

// ------------------------------------------------------------------ cargar backend/*.js en un mismo contexto
const contexto = vm.createContext(Object.assign({ Date, JSON, Math, Number, String, Object, Array, parseInt, parseFloat, isFinite, RegExp, Error, Map, Set }, servicios));
['Config.js', 'Seguridad.js', 'Tasas.js', 'Operaciones.js', 'Api.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), contexto, { filename: f }));

// ------------------------------------------------------------------ servidor HTTP
http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json; charset=utf-8' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    try {
      const salida = req.method === 'POST' ? contexto.doPost({ postData: { contents: cuerpo } }) : contexto.doGet({});
      res.writeHead(200, cors); res.end(salida.texto);
    } catch (e) { res.writeHead(500, cors); res.end(JSON.stringify({ ok: false, error: 'simulador', mensaje: String(e.stack || e) })); }
  });
}).listen(PUERTO, '127.0.0.1', () => {
  console.log('Simulador del backend en http://localhost:' + PUERTO + '  (clave de enlace: ' + CLAVE_PRUEBA + ')');
});
