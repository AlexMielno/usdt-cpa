/** Estado compartido en memoria + mini bus de eventos + navegación. */
export const estado = {
  cartera: 'CPA BEJUMA',
  tasas: null, tasasHora: 0,
  historico: [],
  operaciones: [], operacionesHora: 0,
  resumen: null,
};

const oyentes = {};
export function en(evento, fn) { (oyentes[evento] = oyentes[evento] || []).push(fn); return () => { oyentes[evento] = oyentes[evento].filter(f => f !== fn); }; }
export function emitir(evento, datos) { (oyentes[evento] || []).forEach(f => { try { f(datos); } catch (e) { console.error(e); } }); }

let _navegar = () => {};
export function definirNavegar(fn) { _navegar = fn; }
export function navegar(pantalla, parametros) { _navegar(pantalla, parametros); }
