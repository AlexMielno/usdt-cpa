/**
 * Simulador local del backend de Apps Script (para probar sin publicar en Google).
 *
 * Carga los archivos de backend/ tal cual y emula los servicios de Apps Script que usan
 * (SpreadsheetApp con una hoja en memoria, PropertiesService, CacheService, LockService,
 * UrlFetchApp con curl síncrono, Utilities, ContentService, ScriptApp, Session, Logger).
 *
 * Uso:  node herramientas/simulador_backend.js [puerto]   (por defecto 8787)
 *       -> API en http://localhost:8787/  con la clave de enlace "CLAVE-DE-PRUEBA-LOCAL-1234"
 *
 * SpreadsheetApp.openById(cualquier id) devuelve el libro de bancos construido desde la muestra real
 * herramientas/fixtures/bancos_muestra.json (los seriales de la columna A pasan a Date, como en Apps Script).
 * Con la variable de entorno SIM_BANCOS_SIN_ACCESO=1, openById falla (para probar el error bancos_sin_acceso).
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
const ZONA = 'America/Caracas';   // zona del script (appsscript.json) y de los libros
const FIXTURE_BANCOS = process.env.SIM_BANCOS_FIXTURE || path.join(__dirname, 'fixtures', 'bancos_muestra.json');

// Como Sheets: un texto que empieza con apóstrofo se guarda sin él (el apóstrofo solo fuerza "texto")
const valorCelda = v => (typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v);

// ------------------------------------------------------------------ hoja en memoria
class Hoja {
  constructor(nombre, filas) { this.nombre = nombre; this.filas = filas || []; }
  getName() { return this.nombre; }
  getLastRow() { return this.filas.length; }
  getLastColumn() { return this.filas.reduce((m, f) => Math.max(m, f.length), 0); }
  getMaxColumns() { return Math.max(26, this.getLastColumn()); }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  clearContents() { this.filas = []; return this; }
  setFrozenRows() { return this; }
  // Quita las filas vacías del final (Sheets no las cuenta en getLastRow)
  recortar() { while (this.filas.length && (this.filas[this.filas.length - 1] || []).every(v => v === '' || v === undefined || v === null)) this.filas.pop(); }
  getRange(fila, col, nFilas = 1, nCols = 1) {
    const h = this;
    return {
      getValues() { const out = []; for (let r = 0; r < nFilas; r++) { const f = h.filas[fila - 1 + r] || []; out.push(Array.from({ length: nCols }, (_, c) => f[col - 1 + c] === undefined ? '' : f[col - 1 + c])); } return out; },
      getValue() { return this.getValues()[0][0]; },
      setValue(v) { while (h.filas.length < fila) h.filas.push([]); h.filas[fila - 1][col - 1] = valorCelda(v); },
      setValues(vals) { vals.forEach((f, r) => f.forEach((v, c) => { while (h.filas.length < fila + r) h.filas.push([]); h.filas[fila - 1 + r][col - 1 + c] = valorCelda(v); })); },
      clearContent() { for (let r = 0; r < nFilas; r++) { const f = h.filas[fila - 1 + r]; if (f) for (let c = 0; c < nCols; c++) if (col - 1 + c < f.length) f[col - 1 + c] = ''; } h.recortar(); return this; },
    };
  }
  appendRow(f) { this.filas.push(f.slice()); }
  deleteRow(fila) { this.filas.splice(fila - 1, 1); }
}
const encabezadoBD = ['ID', 'FECHA', 'HORA', 'CARTERA', 'TIPO', 'MONTO USDT', 'TASA', 'TOTAL VES', 'COMISION USDT', 'COMISION VES', 'USDT NETO', 'VES NETO', 'TASA EFECTIVA', 'TASA BCV', 'TASA P2P REF', 'DIF BCV', 'DIF BCV %', 'DIF P2P', 'EQUIV USD', 'CONTRAPARTE', 'METODO', 'REF', 'OBS', 'ESTADO', 'DISPOSITIVO', 'REGISTRADO', 'MOTIVO'];
const hojas = { BD_USDT: new Hoja('BD_USDT', [encabezadoBD]), TASAS: new Hoja('TASAS', [['FECHA HORA', 'BCV', 'BCV FECHA VALOR', 'PC MEJOR', 'PC PROM5', 'PV MEJOR', 'PV PROM5', 'BRECHA', 'FUENTE']]) };
// Historial de tasas de ejemplo (como lo deja el disparador real) para que la gráfica de inicio se pruebe
for (let i = 8; i >= 1; i--) hojas.TASAS.appendRow([new Date(Date.now() - i * 1800000), 832.4883, new Date('2026-09-11T16:00:00Z'), 958, 956.14 + i * 0.3, 954.69, 957.62 - i * 0.2, 0.1503, 'bcv.org.ve']);

// Libro de la app (getActiveSpreadsheet): mismas hojas de siempre + insertSheet (la pestaña DIF_BANCOS se crea sola)
const libroApp = {
  getId: () => 'LIBRO-APP-SIMULADO',
  getName: () => 'USDT CPA (simulador)',
  getSpreadsheetTimeZone: () => ZONA,
  getSheetByName: n => hojas[n] || null,
  getSheets: () => Object.values(hojas),
  insertSheet(n) {
    if (hojas[n]) throw new Error('Ya existe una hoja con el nombre "' + n + '"');
    hojas[n] = new Hoja(n, []);
    return hojas[n];
  },
};

// ------------------------------------------------------------------ libro de bancos (SpreadsheetApp.openById)
// Desfase (ms) de la zona respecto a UTC en un instante dado (Caracas: -4 h)
function desfaseZona(ms, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).reduce((o, x) => (o[x.type] = x.value, o), {});
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
}
// Serial de Sheets -> Date. Apps Script entrega una celda de fecha como la MEDIANOCHE en la zona del libro
// (3/1/2026 = 2026-01-03T04:00Z en Caracas), no como medianoche UTC: así se imita exactamente.
function fechaDesdeSerial(serial) {
  const utc = Date.UTC(1899, 11, 30) + serial * 86400000;
  return new Date(utc - desfaseZona(utc, ZONA));
}
let hojasBancos = null;   // se construye una sola vez, al primer openById
function abrirLibroBancos(id) {
  if (process.env.SIM_BANCOS_SIN_ACCESO === '1') throw new Error('No tienes permiso para acceder al documento solicitado. (simulado)');
  if (!hojasBancos) {
    if (!fs.existsSync(FIXTURE_BANCOS)) throw new Error('No se encontró la muestra ' + FIXTURE_BANCOS);
    const fx = JSON.parse(fs.readFileSync(FIXTURE_BANCOS, 'utf8'));
    hojasBancos = {
      titulo: fx.titulo,
      lista: Object.keys(fx.hojas).map(nombre => new Hoja(nombre, fx.hojas[nombre].map((f, i) =>
        (i === 0 ? f.slice() : f.map((v, c) => (c === 0 && typeof v === 'number' ? fechaDesdeSerial(v) : v)))))),
    };
  }
  const lista = hojasBancos.lista;
  return {
    getId: () => id,
    getName: () => hojasBancos.titulo,
    getSpreadsheetTimeZone: () => ZONA,
    getSheets: () => lista.slice(),
    getSheetByName: n => lista.find(h => h.getName() === n) || null,
  };
}

// ------------------------------------------------------------------ servicios emulados
const propiedades = { API_KEY: CLAVE_PRUEBA, SESSION_SECRET: 'secreto-de-sesion-local' };
const cache = {};
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytes = s => (typeof s === 'string' ? [...Buffer.from(s, 'utf8')] : s);

const servicios = {
  SpreadsheetApp: { getActiveSpreadsheet: () => libroApp, openById: id => abrirLibroBancos(id), flush() {} },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => propiedades[k] === undefined ? null : propiedades[k], setProperty: (k, v) => { propiedades[k] = v; }, deleteProperty: k => { delete propiedades[k]; } }) },
  CacheService: { getScriptCache: () => ({ get: k => (cache[k] && cache[k].exp > Date.now()) ? cache[k].v : null, put: (k, v, s) => { cache[k] = { v, exp: Date.now() + (s || 600) * 1000 }; }, putAll: (obj, s) => { Object.keys(obj).forEach(k => { cache[k] = { v: obj[k], exp: Date.now() + (s || 600) * 1000 }; }); }, remove: k => { delete cache[k]; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }) },
  Session: { getScriptTimeZone: () => ZONA },
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
['Config.js', 'Seguridad.js', 'Tasas.js', 'Operaciones.js', 'Bancos.js', 'Api.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), contexto, { filename: f }));

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
