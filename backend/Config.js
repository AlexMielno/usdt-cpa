/**
 * USDT CPA — Backend en Google Apps Script
 * ==========================================
 * Este script vive "pegado" al libro de Google Sheets y se publica como aplicación web.
 * La app de escritorio (.exe) y la de Android (.apk) le envían peticiones JSON por POST.
 *
 * Archivos:
 *   Config.js      -> constantes, configuración inicial y utilidades comunes (este archivo)
 *   Seguridad.js   -> clave de enlace, Cloudflare Turnstile, tokens de sesión, anti fuerza bruta
 *   Tasas.js       -> tasa BCV y Binance P2P (lectura en vivo + captura periódica en la pestaña TASAS)
 *   Operaciones.js -> registrar / listar / anular operaciones y resumen de cartera (pestaña BD_USDT)
 *   Api.js         -> punto de entrada doPost / doGet y enrutador de acciones
 *
 * Los secretos NUNCA van en el código: se guardan en "Propiedades del script"
 * (PropertiesService). Ver configuracionInicial().
 */

const CONFIG = {
  HOJA_BD: 'BD_USDT',
  HOJA_TASAS: 'TASAS',
  CARTERAS: ['CPA BEJUMA', 'PANAMERICANA'],
  TIPOS: ['COMPRA', 'VENTA'],
  SESION_HORAS: 12,              // duración de un token de sesión
  CACHE_TASAS_SEG: 300,          // las tasas en vivo se cachean 5 minutos
  MAX_INTENTOS: 10,              // intentos fallidos de autenticación permitidos...
  BLOQUEO_MIN: 15,               // ...en esta ventana (minutos) antes de bloquear
  MINUTOS_CAPTURA: 30,           // cada cuánto se guarda una fila en TASAS
  ANUNCIOS_P2P: 20,              // anuncios por lado que se devuelven a la app
  FILTRO_P2P: { ordenesMes: 50, tasaFinalizacion: 0.95 }, // filtro de anunciantes "serios"
};

// Nombres de las columnas de BD_USDT en el orden exacto de la hoja (27 columnas, A..AA)
const COLUMNAS = [
  'id', 'fecha', 'hora', 'cartera', 'tipo', 'montoUsdt', 'tasa', 'totalVes',
  'comisionUsdt', 'comisionVes', 'usdtNeto', 'vesNeto', 'tasaEfectiva',
  'tasaBcv', 'tasaP2p', 'difBcvVes', 'difBcvPct', 'difP2pVes', 'equivUsdBcv',
  'contraparte', 'metodoPago', 'referencia', 'observaciones', 'estado',
  'dispositivo', 'registrado', 'motivoAnulacion',
];

/**
 * EJECUTAR UNA VEZ desde el editor de Apps Script (botón ▶) con la cuenta que publica la app web.
 *  1. Genera la CLAVE DE ENLACE (API_KEY) y el secreto de sesión si no existen.
 *  2. Instala el disparador que captura las tasas cada 30 minutos.
 *  3. Muestra en el registro (Ver > Registros) la clave de enlace que hay que escribir en cada dispositivo.
 * Es seguro ejecutarla varias veces: no cambia las claves ya creadas.
 */
function configuracionInicial() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_KEY')) props.setProperty('API_KEY', generarClave_(24));
  if (!props.getProperty('SESSION_SECRET')) props.setProperty('SESSION_SECRET', generarClave_(48));
  instalarDisparadores_();
  const clave = props.getProperty('API_KEY');
  Logger.log('================================================');
  Logger.log('CLAVE DE ENLACE (escríbela en la app al configurar cada dispositivo):');
  Logger.log(clave);
  Logger.log('Turnstile configurado: ' + (props.getProperty('TURNSTILE_SECRET') ? 'SÍ' : 'NO (se omite la verificación anti-bot)'));
  Logger.log('================================================');
  return clave;
}

/**
 * Guarda el secreto de Cloudflare Turnstile. Ejecutar desde el editor así:
 *   establecerTurnstile('0x4AAAAAAA...secreto...', 'localhost')
 * El segundo parámetro son los hostnames permitidos separados por coma (los mismos del panel de Cloudflare).
 * Para desactivar la verificación: establecerTurnstile('')
 */
function establecerTurnstile(secreto, hostnames) {
  const props = PropertiesService.getScriptProperties();
  if (secreto) {
    props.setProperty('TURNSTILE_SECRET', String(secreto).trim());
    props.setProperty('TURNSTILE_HOSTNAMES', String(hostnames || 'localhost'));
    Logger.log('Turnstile ACTIVADO. Hostnames: ' + (hostnames || 'localhost'));
  } else {
    props.deleteProperty('TURNSTILE_SECRET');
    Logger.log('Turnstile DESACTIVADO.');
  }
}

/** Genera una nueva clave de enlace (invalida la anterior: habrá que re-enlazar los dispositivos). */
function rotarClaveDeEnlace() {
  const clave = generarClave_(24);
  PropertiesService.getScriptProperties().setProperty('API_KEY', clave);
  Logger.log('NUEVA CLAVE DE ENLACE: ' + clave);
  return clave;
}

/** Instala (si no existe) el disparador temporal que captura las tasas. */
function instalarDisparadores_() {
  const existe = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'capturarTasas');
  if (!existe) {
    ScriptApp.newTrigger('capturarTasas').timeBased().everyMinutes(CONFIG.MINUTOS_CAPTURA).create();
    Logger.log('Disparador de captura de tasas instalado (cada ' + CONFIG.MINUTOS_CAPTURA + ' min).');
  }
}

// ---------------------------------------------------------------------------------------
// Utilidades comunes
// ---------------------------------------------------------------------------------------

function generarClave_(bytes) {
  const arr = [];
  for (let i = 0; i < bytes; i++) arr.push(Math.floor(Math.random() * 256));
  // Math.random no es criptográfico en V8 de Apps Script, así que lo mezclamos con un UUID y un hash
  const semilla = Utilities.getUuid() + Date.now() + arr.join(',');
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, semilla + Utilities.getUuid());
  return base64url_(hash.concat(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + semilla))).slice(0, Math.ceil(bytes * 4 / 3));
}

function base64url_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function libro_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function hoja_(nombre) {
  const h = libro_().getSheetByName(nombre);
  if (!h) throw new ErrorApi('hoja_no_existe', 'No existe la pestaña ' + nombre);
  return h;
}

/** Error controlado que se devuelve a la app con un código corto. */
class ErrorApi extends Error {
  constructor(codigo, mensaje, http) {
    super(mensaje);
    this.codigo = codigo;
    this.http = http || 400;
  }
}

function numero_(v, nombre, opciones) {
  const o = opciones || {};
  if (v === '' || v === null || v === undefined) {
    if (o.opcional) return 0;
    throw new ErrorApi('dato_invalido', 'Falta el campo ' + nombre);
  }
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  if (!isFinite(n)) throw new ErrorApi('dato_invalido', 'El campo ' + nombre + ' no es un número válido');
  if (o.min !== undefined && n < o.min) throw new ErrorApi('dato_invalido', 'El campo ' + nombre + ' debe ser ≥ ' + o.min);
  if (o.max !== undefined && n > o.max) throw new ErrorApi('dato_invalido', 'El campo ' + nombre + ' es demasiado grande');
  return n;
}

function texto_(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max || 500);
}

function redondear_(n, dec) {
  const f = Math.pow(10, dec === undefined ? 2 : dec);
  return Math.round((n + Number.EPSILON) * f) / f;
}

function ahora_() {
  return new Date();
}

function formatoFecha_(d) {
  return Utilities.formatDate(d, CONFIG_TZ_(), 'yyyy-MM-dd');
}

function formatoHora_(d) {
  return Utilities.formatDate(d, CONFIG_TZ_(), 'HH:mm');
}

function CONFIG_TZ_() {
  return Session.getScriptTimeZone() || 'America/Caracas';
}
