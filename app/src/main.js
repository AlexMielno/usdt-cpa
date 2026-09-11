/**
 * Arranque y flujo de pantallas.
 *
 *   sin configuración -> Bienvenida (clave de enlace + PIN)
 *   bloqueada         -> Bloqueo (PIN / huella)
 *   sin sesión        -> Verificación (Turnstile + token del backend)
 *   normal            -> Inicio / Registro / Historial / Ajustes
 */
import { el, montar, toast } from './ui.js';
import * as almacen from './almacen.js';
import * as api from './api.js';
import * as datos from './datos.js';
import { definirNavegar } from './estado.js';
import { pantallaBienvenida } from './pantallas/bienvenida.js';
import { pantallaBloqueo } from './pantallas/bloqueo.js';
import { pantallaVerificacion } from './pantallas/verificacion.js';
import { pantallaInicio } from './pantallas/inicio.js';
import { pantallaRegistro } from './pantallas/registro.js';
import { pantallaHistorial } from './pantallas/historial.js';
import { pantallaAjustes } from './pantallas/ajustes.js';
import { pantallaReportes } from './pantallas/reportes.js';
import { comprobarActualizacion } from './actualizador.js';
import { estado, emitir } from './estado.js';

let pantallaActual = 'inicio';
let pendiente = null;          // pantalla a la que volver tras verificar
let ultimaActividad = Date.now();

function manejarError(e) {
  if (e instanceof api.SesionRequerida || (e && e.codigo === 'sesion_requerida')) { pendiente = pantallaActual; irAVerificacion(); return; }
  console.error(e);
  toast(e && e.message ? e.message : String(e), 'error', 5000);
}

function irABienvenida() { pantallaBienvenida({ alTerminar: () => irAVerificacion() }); }

function irABloqueo() {
  almacen.bloquear();
  pantallaBloqueo({
    alDesbloquear: async () => { await datos.restaurarLocal(); ultimaActividad = Date.now(); if (await api.haySesion()) navegar(pendiente || 'inicio'); else irAVerificacion(); },
    alDesvincular: irABienvenida,
  });
}

function irAVerificacion() {
  pantallaVerificacion({
    alListo: async () => { await datos.restaurarLocal(); navegar(pendiente || 'inicio'); pendiente = null; },
    alDesvincular: async () => { await almacen.borrarTodo(); irABienvenida(); },
  });
}

function navegar(nombre) {
  if (!almacen.estaDesbloqueado()) { pendiente = nombre; irABloqueo(); return; }
  pantallaActual = nombre;
  const ctx = { manejarError, alDesvincular: irABienvenida, alBloquear: irABloqueo };
  switch (nombre) {
    case 'registro': return pantallaRegistro(ctx);
    case 'historial': return pantallaHistorial(ctx);
    case 'ajustes': return pantallaAjustes(ctx);
    case 'reportes': return pantallaReportes(ctx);
    default: pantallaActual = 'inicio'; return pantallaInicio(ctx);
  }
}
definirNavegar(navegar);

// ---- bloqueo por inactividad y al ocultar la app ----
['click', 'keydown', 'touchstart', 'input'].forEach(ev => document.addEventListener(ev, () => { ultimaActividad = Date.now(); }, { passive: true }));
setInterval(() => {
  const min = (window.CONFIG_USDT || {}).MINUTOS_BLOQUEO || 5;
  if (almacen.estaDesbloqueado() && Date.now() - ultimaActividad > min * 60000) { pendiente = pantallaActual; irABloqueo(); }
}, 15000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) ultimaActividad = Math.min(ultimaActividad, Date.now() - 4 * 60000); // al volver tras >1 min oculta, se bloquea
});

// ---- actualizaciones: una comprobación al arrancar (GitHub Releases) y avisos del actualizador de Electron ----
async function comprobarVersionAlArrancar() {
  try {
    const info = await comprobarActualizacion();
    if (info && info.hay) { estado.actualizacion = info; emitir('actualizacion', info); }
  } catch (e) { /* sin red o sin repositorio: silencio */ }
}
if (window.electronUSDT && window.electronUSDT.actualizador) {
  window.electronUSDT.actualizador.alCambiar(({ evento, datos }) => {
    if (evento === 'descargada') { estado.actualizacion = Object.assign({}, estado.actualizacion || {}, { hay: true, nueva: datos.version, descargada: true }); emitir('actualizacion', estado.actualizacion); toast('Versión ' + datos.version + ' descargada: se instalará al cerrar la app', 'ok', 6000); }
    else if (evento === 'disponible') { estado.actualizacion = Object.assign({}, estado.actualizacion || {}, { hay: true, nueva: datos.version }); emitir('actualizacion', estado.actualizacion); }
  });
}
setTimeout(comprobarVersionAlArrancar, 4000);

// ---- arranque ----
window.addEventListener('error', (ev) => { console.error(ev.error || ev.message); });
window.addEventListener('unhandledrejection', (ev) => { manejarError(ev.reason || new Error('Error inesperado')); });

(function arrancar() {
  if (!window.crypto || !window.crypto.subtle) { montar(el('div.pantalla.centrada', {}, el('p', {}, 'Este entorno no soporta cifrado (WebCrypto). Abre la app desde el ejecutable o el APK.'))); return; }
  if (!almacen.existeConfiguracion()) irABienvenida();
  else irABloqueo();
})();
