/**
 * Pintado común de un reporte con la estructura genérica de reportes.js / conciliacion.js
 * ({ titulo, subtitulo, kpis: [{etq, val, clase?, sub?}], secciones: [{titulo, columnas, filas, totales?, alinear?}], nota }):
 * tarjeta resaltada con los KPIs (+ lo que se pase en extraKpi, p. ej. el botón de PDF), una tarjeta por tabla y la nota.
 * Lo usan Reportes y Diferencial desde bancos. Devuelve una lista de nodos: zona.replaceChildren(...vistaReporte(rep)).
 */
import { el } from '../ui.js';

export function vistaReporte(rep, extraKpi) {
  const tablas = rep.secciones.filter(s => s.filas.length).map(sec => el('div.tarjeta', {},
    el('h2', {}, sec.titulo),
    el('div', { estilo: { overflowX: 'auto' } }, el('table.tabla.reporte', {},
      el('thead', {}, el('tr', {}, sec.columnas.map((c, i) => el('th', { clase: (sec.alinear || []).includes(i) ? 'izq' : '' }, c)))),
      el('tbody', {}, sec.filas.map(f => el('tr', {}, f.map((v, i) => el('td', { clase: ((sec.alinear || []).includes(i) ? 'izq ' : '') + colorValor(v) }, v)))),
        sec.totales ? el('tr.total', {}, sec.totales.map((v, i) => el('td', { clase: ((sec.alinear || []).includes(i) ? 'izq ' : '') + colorValor(v) }, v))) : null),
    ))));
  return [
    el('div.tarjeta.resaltada', {},
      el('h2', {}, el('span', {}, rep.titulo), el('span.accion.mini', {}, rep.subtitulo)),
      el('div.grid-2', {}, rep.kpis.map(k => el('div.dato', {}, el('div.etq', {}, k.etq), el('div.val.peq', { clase: k.clase || '' }, k.val), k.sub ? el('div.nota', {}, k.sub) : null))),
      extraKpi ? el('div', { estilo: { marginTop: '12px', display: 'flex', alignItems: 'center', gap: '8px' } }, extraKpi) : null,
    ),
    ...(tablas.length ? tablas : [el('div.vacio', {}, 'Sin operaciones en este período.')]),
    rep.nota ? el('p.mini', {}, rep.nota) : null,
  ].filter(Boolean);
}

/** Colorea los valores con signo: "+…" verde, "-$…"/"-1.234" rojo. */
export function colorValor(v) {
  const t = String(v || '');
  if (/^\+/.test(t)) return 'positivo';
  if (/^-(\$|[\d.,])/.test(t)) return 'negativo';
  return '';
}
