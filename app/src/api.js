/**
 * Cliente de la API (Google Apps Script).
 * Todas las llamadas son POST con JSON en texto plano. La sesión (token firmado) se guarda cifrada.
 */
import { http, nombreDispositivoSugerido } from './nativo.js';
import * as almacen from './almacen.js';

export class SesionRequerida extends Error { constructor(m) { super(m || 'Se requiere verificación'); this.codigo = 'sesion_requerida'; } }
export class ErrorApi extends Error { constructor(codigo, mensaje) { super(mensaje); this.codigo = codigo; } }

const cfg = () => window.CONFIG_USDT || {};

const ESPERAS_REINTENTO = [800, 2000, 4000];   // ms entre intentos cuando Google responde una página de error (404/5xx)
const pausa = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Envía una petición al backend. Apps Script, sobre todo justo después de publicar una versión o cuando
 * la app dispara varias llamadas a la vez, a veces responde con la página genérica de error de Google
 * (HTTP 404/5xx sin JSON); en ese caso se reintenta hasta 3 veces con una espera creciente.
 */
async function enviar(cuerpo) {
  if (!cfg().API_URL) throw new ErrorApi('sin_url', 'Falta configurar API_URL en config.js');
  const carga = JSON.stringify(cuerpo);
  for (let intento = 0; ; intento++) {
    let r;
    try {
      r = await http(cfg().API_URL, { metodo: 'POST', cabeceras: { 'Content-Type': 'text/plain;charset=utf-8' }, cuerpo: carga });
    } catch (e) {
      if (intento < ESPERAS_REINTENTO.length) { await pausa(ESPERAS_REINTENTO[intento]); continue; }
      throw new ErrorApi('red', 'Sin conexión con el servidor (' + (e.message || 'red') + ')');
    }
    let json;
    try { json = JSON.parse(r.texto); } catch (e) {
      if (/necesitas acceso|need access|Toegang|autorizaci|authorization/i.test(r.texto)) {
        throw new ErrorApi('backend_sin_autorizar', 'El backend aún no está autorizado en Google: abre el proyecto de Apps Script y ejecuta configuracionInicial().');
      }
      if (intento < ESPERAS_REINTENTO.length && (r.status >= 400 || !String(r.texto || '').trim())) { await pausa(ESPERAS_REINTENTO[intento]); continue; }
      throw new ErrorApi('respuesta_invalida', 'El servidor respondió algo inesperado (HTTP ' + r.status + ') tras ' + (intento + 1) + ' intentos. Vuelve a intentarlo en unos segundos.');
    }
    if (!json.ok) throw new ErrorApi(json.error || 'error', json.mensaje || 'Error desconocido');
    return json.datos;
  }
}

export async function ping() { return enviar({ accion: 'ping' }); }

/** Abre sesión con la clave de enlace guardada y (si aplica) el token de Turnstile. */
export async function abrirSesion(turnstileToken) {
  const claveEnlace = await almacen.leer('claveEnlace');
  const dispositivo = almacen.obtenerMeta().dispositivo || nombreDispositivoSugerido();
  const d = await enviar({ accion: 'sesion', claveEnlace, turnstile: turnstileToken || '', dispositivo });
  await almacen.guardar('sesion', { token: d.token, expira: d.expira });
  return d;
}

export async function haySesion() {
  const s = await almacen.leer('sesion');
  return !!(s && s.token && s.expira > Date.now() + 60000);
}

export async function cerrarSesion() { almacen.eliminar('sesion'); }

/** Llama una acción protegida. Si la sesión no sirve, lanza SesionRequerida para que la UI pida verificación. */
export async function llamar(accion, datos) {
  const s = await almacen.leer('sesion');
  if (!s || !s.token || s.expira <= Date.now()) throw new SesionRequerida();
  try {
    return await enviar({ accion, token: s.token, datos: datos || {} });
  } catch (e) {
    if (e.codigo === 'sesion_invalida' || e.codigo === 'sesion_vencida') { almacen.eliminar('sesion'); throw new SesionRequerida(e.message); }
    throw e;
  }
}

export const tasas = (forzar) => llamar('tasas', { forzar: !!forzar });
export const historico = (n) => llamar('historico', { n: n || 96 });
export const listar = (opciones) => llamar('listar', opciones || {});
export const registrar = (op) => llamar('registrar', op);
export const anular = (id, motivo) => llamar('anular', { id, motivo });
export const borrar = (id) => llamar('borrar', { id });
export const actualizar = (id, cambios) => llamar('actualizar', Object.assign({ id }, cambios));
export const editar = (id, cambios) => llamar('editar', Object.assign({ id }, cambios));
export const resumen = () => llamar('resumen');
// Diferencial desde bancos (libro "ADM.-002 BANCOS CPA"); fechas 'YYYY-MM-DD' o '' = sin límite
export const bancos = (desde, hasta, forzar) => llamar('bancos', { desde: desde || '', hasta: hasta || '', forzar: !!forzar });
export const bancosDecisiones = () => llamar('bancosDecisiones');
export const bancosGuardar = (decisiones, borrar) => llamar('bancosGuardar', { decisiones: decisiones || [], borrar: borrar || [] });
