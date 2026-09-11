/**
 * Punto de entrada de la aplicación web.
 *
 * La app envía SIEMPRE un POST con cuerpo JSON (Content-Type text/plain para evitar el "preflight" CORS
 * que Apps Script no soporta):
 *   { "accion": "sesion",   "claveEnlace": "...", "turnstile": "...", "dispositivo": "PC-Oficina" }
 *   { "accion": "tasas",    "token": "..." }
 *   { "accion": "listar",   "token": "...", "datos": { "cartera": "CPA BEJUMA", "limite": 300 } }
 *   { "accion": "registrar","token": "...", "datos": { ...operación... } }
 *   { "accion": "anular",   "token": "...", "datos": { "id": "OP-000001", "motivo": "..." } }
 *   { "accion": "editar",   "token": "...", "datos": { "id": "OP-000001", "observaciones": "..." } }
 *   { "accion": "resumen",  "token": "..." }
 *   { "accion": "historico","token": "...", "datos": { "n": 96 } }
 *
 * Respuesta: { ok: true, datos: {...} }  ó  { ok: false, error: "codigo", mensaje: "..." }
 */

function doGet(e) {
  return responder_({ ok: true, datos: { servicio: 'USDT CPA API', version: '1.0.0', hora: ahora_().toISOString() } });
}

function doPost(e) {
  let peticion = {};
  try {
    peticion = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return responder_({ ok: false, error: 'json_invalido', mensaje: 'El cuerpo no es JSON válido.' });
  }
  try {
    const accion = texto_(peticion.accion, 30);
    let datos;
    switch (accion) {
      case 'sesion': {
        verificarClaveEnlace_(peticion.claveEnlace);
        const ts = verificarTurnstile_(peticion.turnstile);
        const s = emitirSesion_(peticion.dispositivo);
        datos = { token: s.token, expira: s.expira, turnstile: ts, carteras: CONFIG.CARTERAS };
        break;
      }
      case 'ping': {
        datos = { hora: ahora_().toISOString(), turnstileActivo: !!props_().getProperty('TURNSTILE_SECRET') };
        break;
      }
      default: {
        const sesion = verificarSesion_(peticion.token);
        datos = ejecutar_(accion, peticion.datos || {}, sesion);
      }
    }
    return responder_({ ok: true, datos: datos });
  } catch (err) {
    if (err instanceof ErrorApi) return responder_({ ok: false, error: err.codigo, mensaje: err.message });
    console.error(err && err.stack ? err.stack : err);
    return responder_({ ok: false, error: 'interno', mensaje: 'Error interno: ' + (err && err.message ? err.message : err) });
  }
}

function ejecutar_(accion, datos, sesion) {
  switch (accion) {
    case 'tasas': return tasasEnVivo_(!!datos.forzar);
    case 'historico': return historicoTasas_(datos.n);
    case 'listar': return listarOperaciones_(datos);
    case 'registrar': return registrarOperacion_(datos, sesion);
    case 'anular': return anularOperacion_(datos, sesion);
    case 'borrar': return borrarOperacion_(datos, sesion);
    case 'editar': return editarOperacion_(datos, sesion);
    case 'resumen': return resumenCartera_();
    default: throw new ErrorApi('accion_desconocida', 'Acción no reconocida: ' + accion, 404);
  }
}

function responder_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------------------
// Pruebas manuales desde el editor (Ejecutar > probarTasas / probarResumen)
// ---------------------------------------------------------------------------------------
function probarTasas() {
  const t = tasasEnVivo_(true);
  Logger.log(JSON.stringify({ bcv: t.bcv, sugerida: t.sugerida, brecha: t.brechaPct, errores: t.errores,
    compra: t.p2p && t.p2p.compra.anuncios.slice(0, 3), venta: t.p2p && t.p2p.venta.anuncios.slice(0, 3) }, null, 2));
}

function probarResumen() {
  Logger.log(JSON.stringify(resumenCartera_(), null, 2));
}
