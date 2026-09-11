/**
 * Almacén local cifrado.
 *
 *  localStorage['usdt.meta']      -> { sal, verificador, dispositivo, huella, creado }   (sin cifrar; no contiene secretos)
 *  localStorage['usdt.d.<clave>'] -> valor JSON cifrado con AES-GCM usando la llave derivada del PIN
 *
 * La llave vive solo en memoria mientras la app está desbloqueada. Al bloquear se descarta.
 * Con la huella activada, la llave (exportada) se guarda en el almacenamiento seguro del sistema
 * y se recupera cuando la biometría del teléfono confirma la identidad.
 */
import * as cripto from './cripto.js';
import { secreto } from './nativo.js';

const META = 'usdt.meta';
const PREFIJO = 'usdt.d.';
const NOMBRE_LLAVE_HUELLA = 'llave-huella';

let llave = null;         // CryptoKey en memoria
let meta = null;

function leerMeta() {
  if (meta) return meta;
  try { meta = JSON.parse(localStorage.getItem(META) || 'null'); } catch (e) { meta = null; }
  return meta;
}

function guardarMeta(m) {
  meta = m;
  localStorage.setItem(META, JSON.stringify(m));
}

export function existeConfiguracion() { return !!leerMeta(); }
export function estaDesbloqueado() { return !!llave; }
export function obtenerMeta() { return leerMeta() || {}; }

/** Primera configuración del dispositivo: crea la llave a partir del PIN y guarda la clave de enlace cifrada. */
export async function crear({ pin, claveEnlace, dispositivo }) {
  const sal = cripto.aBase64(cripto.aleatorioBytes(16));
  llave = await cripto.derivarLlave(pin, sal);
  const verificador = await cripto.cifrar(llave, 'USDT-CPA-OK');
  guardarMeta({ sal, verificador, dispositivo, huella: false, creado: new Date().toISOString(), version: 1 });
  await guardar('claveEnlace', claveEnlace);
}

export async function desbloquearConPin(pin) {
  const m = leerMeta();
  if (!m) throw new Error('No hay configuración');
  const candidata = await cripto.derivarLlave(pin, m.sal);
  try {
    const v = await cripto.descifrar(candidata, m.verificador);
    if (v !== 'USDT-CPA-OK') return false;
  } catch (e) { return false; }
  llave = candidata;
  return true;
}

export async function desbloquearConHuella() {
  const exportada = await secreto.leer(NOMBRE_LLAVE_HUELLA);
  if (!exportada) return false;
  const m = leerMeta();
  try {
    const candidata = await cripto.importarLlave(exportada);
    const v = await cripto.descifrar(candidata, m.verificador);
    if (v !== 'USDT-CPA-OK') return false;
    llave = candidata;
    return true;
  } catch (e) { return false; }
}

export async function activarHuella() {
  if (!llave) throw new Error('Bloqueado');
  const ok = await secreto.guardar(NOMBRE_LLAVE_HUELLA, await cripto.exportarLlave(llave));
  if (!ok) throw new Error('Este dispositivo no tiene almacenamiento seguro');
  guardarMeta(Object.assign({}, leerMeta(), { huella: true }));
}

export async function desactivarHuella() {
  await secreto.borrar(NOMBRE_LLAVE_HUELLA);
  guardarMeta(Object.assign({}, leerMeta(), { huella: false }));
}

export async function cambiarPin(pinNuevo) {
  if (!llave) throw new Error('Bloqueado');
  // Re-cifrar todos los datos con la llave nueva
  const claves = Object.keys(localStorage).filter(k => k.startsWith(PREFIJO));
  const valores = {};
  for (const k of claves) valores[k] = await cripto.descifrar(llave, localStorage.getItem(k));
  const sal = cripto.aBase64(cripto.aleatorioBytes(16));
  const nueva = await cripto.derivarLlave(pinNuevo, sal);
  for (const k of claves) localStorage.setItem(k, await cripto.cifrar(nueva, valores[k]));
  const verificador = await cripto.cifrar(nueva, 'USDT-CPA-OK');
  llave = nueva;
  const m = leerMeta();
  guardarMeta(Object.assign({}, m, { sal, verificador }));
  if (m.huella) await secreto.guardar(NOMBRE_LLAVE_HUELLA, await cripto.exportarLlave(llave));
}

export function bloquear() { llave = null; }

export async function guardar(nombre, valor) {
  if (!llave) throw new Error('Bloqueado');
  localStorage.setItem(PREFIJO + nombre, await cripto.cifrar(llave, JSON.stringify(valor)));
}

export async function leer(nombre, porDefecto = null) {
  if (!llave) throw new Error('Bloqueado');
  const c = localStorage.getItem(PREFIJO + nombre);
  if (!c) return porDefecto;
  try { return JSON.parse(await cripto.descifrar(llave, c)); } catch (e) { return porDefecto; }
}

export function eliminar(nombre) { localStorage.removeItem(PREFIJO + nombre); }

/** Borra TODO lo local (para desvincular el dispositivo). */
export async function borrarTodo() {
  await secreto.borrar(NOMBRE_LLAVE_HUELLA);
  Object.keys(localStorage).filter(k => k.startsWith('usdt.')).forEach(k => localStorage.removeItem(k));
  llave = null; meta = null;
}

export function actualizarMeta(cambios) {
  guardarMeta(Object.assign({}, leerMeta() || {}, cambios));
}
