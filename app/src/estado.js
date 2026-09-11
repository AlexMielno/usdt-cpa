/** Estado compartido en memoria + mini bus de eventos + navegación. */
export const estado = {
  cartera: 'CPA BEJUMA',
  tasas: null, tasasHora: 0,
  historico: [],
  operaciones: [], operacionesHora: 0,
  resumen: null,
  errores: [],          // últimos errores de la app (para Ajustes ▸ Diagnóstico)
  pantalla: '',
};

/** Guarda un error (máx. 30) para poder verlo y copiarlo desde Ajustes ▸ Diagnóstico. */
export function registrarError(e, origen) {
  const err = e || {};
  const pila = String(err.stack || '').split('\n').slice(0, 4).join(' | ');
  estado.errores.unshift({ hora: new Date().toISOString(), origen: origen || estado.pantalla || '', mensaje: String(err.message || err), pila });
  estado.errores.splice(30);
  try { console.error('[' + (origen || '') + ']', e); } catch (x) { /* nada */ }
  emitir('errores', estado.errores);
}

const oyentes = {};
export function en(evento, fn) { (oyentes[evento] = oyentes[evento] || []).push(fn); return () => { oyentes[evento] = oyentes[evento].filter(f => f !== fn); }; }
export function emitir(evento, datos) { (oyentes[evento] || []).forEach(f => { try { f(datos); } catch (e) { console.error(e); } }); }

let _navegar = () => {};
export function definirNavegar(fn) { _navegar = fn; }
export function navegar(pantalla, parametros) { _navegar(pantalla, parametros); }
