/**
 * Cliente de la API (Google Apps Script).
 * Todas las llamadas son POST con JSON en texto plano. La sesión (token firmado) se guarda cifrada.
 */
import { http, nombreDispositivoSugerido } from './nativo.js';
import * as almacen from './almacen.js';

export class SesionRequerida extends Error { constructor(m) { super(m || 'Se requiere verificación'); this.codigo = 'sesion_requerida'; } }
export class ErrorApi extends Error { constructor(codigo, mensaje) { super(mensaje); this.codigo = codigo; } }

const cfg = () => window.CONFIG_USDT || {};

async function enviar(cuerpo) {
  if (!cfg().API_URL) throw new ErrorApi('sin_url', 'Falta configurar API_URL en config.js');
  let r;
  try {
    r = await http(cfg().API_URL, { metodo: 'POST', cabeceras: { 'Content-Type': 'text/plain;charset=utf-8' }, cuerpo: JSON.stringify(cuerpo) });
  } catch (e) {
    throw new ErrorApi('red', 'Sin conexión con el servidor (' + (e.message || 'red') + ')');
  }
  let json;
  try { json = JSON.parse(r.texto); } catch (e) {
    if (/necesitas acceso|need access|Toegang|autorizaci|authorization/i.test(r.texto)) {
      throw new ErrorApi('backend_sin_autorizar', 'El backend aún no está autorizado en Google: abre el proyecto de Apps Script y ejecuta configuracionInicial().');
    }
    throw new ErrorApi('respuesta_invalida', 'El servidor respondió algo inesperado (HTTP ' + r.status + ')');
  }
  if (!json.ok) throw new ErrorApi(json.error || 'error', json.mensaje || 'Error desconocido');
  return json.datos;
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
export const editar = (id, cambios) => llamar('editar', Object.assign({ id }, cambios));
export const resumen = () => llamar('resumen');
