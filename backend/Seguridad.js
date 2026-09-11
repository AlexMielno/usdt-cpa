/**
 * Seguridad del backend
 * ---------------------
 * Capas, de afuera hacia adentro:
 *  1. CLAVE DE ENLACE (API_KEY): secreto largo que se escribe una sola vez en cada dispositivo.
 *     Sin ella no se puede ni abrir sesión. Se guarda cifrada en el dispositivo con el PIN del usuario.
 *  2. CLOUDFLARE TURNSTILE: al abrir sesión, la app resuelve un desafío anti-bot y el backend lo
 *     verifica contra Cloudflare (si hay TURNSTILE_SECRET configurado).
 *  3. TOKEN DE SESIÓN: firmado con HMAC-SHA256 y con vencimiento (12 h). Todas las acciones de datos lo exigen.
 *  4. ANTI FUERZA BRUTA: tras 10 fallos de autenticación en 15 min se rechaza todo durante 15 min.
 */

function props_() {
  return PropertiesService.getScriptProperties();
}

/** Compara dos cadenas en tiempo constante (evita ataques por tiempo de respuesta). */
function igualSeguro_(a, b) {
  a = String(a || ''); b = String(b || '');
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function hmac_(texto, secreto) {
  return base64url_(Utilities.computeHmacSha256Signature(texto, secreto));
}

// ---- anti fuerza bruta (contador global en caché) -------------------------------------
function verificarBloqueo_() {
  const n = parseInt(CacheService.getScriptCache().get('auth_fallos') || '0', 10);
  if (n >= CONFIG.MAX_INTENTOS) throw new ErrorApi('bloqueado', 'Demasiados intentos fallidos. Espera ' + CONFIG.BLOQUEO_MIN + ' minutos.', 429);
}

function registrarFallo_() {
  const cache = CacheService.getScriptCache();
  const n = parseInt(cache.get('auth_fallos') || '0', 10) + 1;
  cache.put('auth_fallos', String(n), CONFIG.BLOQUEO_MIN * 60);
}

// ---- clave de enlace ----------------------------------------------------------------------
function verificarClaveEnlace_(clave) {
  verificarBloqueo_();
  const esperada = props_().getProperty('API_KEY');
  if (!esperada) throw new ErrorApi('sin_configurar', 'Ejecuta configuracionInicial() en el editor de Apps Script.', 500);
  if (!igualSeguro_(clave, esperada)) {
    registrarFallo_();
    throw new ErrorApi('clave_invalida', 'La clave de enlace no es válida.', 401);
  }
}

// ---- Cloudflare Turnstile ---------------------------------------------------------------------
function verificarTurnstile_(token) {
  const secreto = props_().getProperty('TURNSTILE_SECRET');
  if (!secreto) return { omitido: true };        // no configurado -> no se exige
  if (!token) throw new ErrorApi('turnstile_requerido', 'Falta la verificación anti-bot.', 401);
  const resp = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'post',
    payload: { secret: secreto, response: String(token).slice(0, 4096) },
    muteHttpExceptions: true,
  });
  let datos = {};
  try { datos = JSON.parse(resp.getContentText()); } catch (e) { datos = {}; }
  if (!datos.success) {
    registrarFallo_();
    throw new ErrorApi('turnstile_fallido', 'La verificación anti-bot falló: ' + ((datos['error-codes'] || []).join(', ') || 'sin detalle'), 401);
  }
  const permitidos = (props_().getProperty('TURNSTILE_HOSTNAMES') || 'localhost').split(',').map(s => s.trim()).filter(Boolean);
  if (permitidos.length && datos.hostname && permitidos.indexOf(datos.hostname) === -1) {
    registrarFallo_();
    throw new ErrorApi('turnstile_host', 'El desafío se resolvió desde un origen no permitido (' + datos.hostname + ').', 401);
  }
  return { omitido: false, hostname: datos.hostname };
}

// ---- tokens de sesión ------------------------------------------------------------------------
function emitirSesion_(dispositivo) {
  const secreto = props_().getProperty('SESSION_SECRET');
  const exp = Date.now() + CONFIG.SESION_HORAS * 3600 * 1000;
  const cuerpo = base64url_(Utilities.newBlob(JSON.stringify({ d: texto_(dispositivo, 60), exp: exp, n: Utilities.getUuid().slice(0, 8) })).getBytes());
  return { token: cuerpo + '.' + hmac_(cuerpo, secreto), expira: exp };
}

function verificarSesion_(token) {
  verificarBloqueo_();
  const secreto = props_().getProperty('SESSION_SECRET');
  const partes = String(token || '').split('.');
  if (partes.length !== 2 || !secreto) { registrarFallo_(); throw new ErrorApi('sesion_invalida', 'Sesión no válida.', 401); }
  if (!igualSeguro_(hmac_(partes[0], secreto), partes[1])) { registrarFallo_(); throw new ErrorApi('sesion_invalida', 'Sesión no válida.', 401); }
  let datos;
  try { datos = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(partes[0])).getDataAsString()); } catch (e) { throw new ErrorApi('sesion_invalida', 'Sesión no válida.', 401); }
  if (!datos.exp || Date.now() > datos.exp) throw new ErrorApi('sesion_vencida', 'La sesión venció; vuelve a verificar.', 401);
  return datos;   // { d: dispositivo, exp, n }
}
