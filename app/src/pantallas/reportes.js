/** Reportes por rango de fechas con exportación a PDF. */
import { el, montar, toast, icono, cargando } from '../ui.js';
import { cabecera, conNavegacion } from './cascaron.js';
import { estado, en } from '../estado.js';
import * as datos from '../datos.js';
import { reporteUtilidades, reporteDiferenciales, reporteOperaciones, rangoPredefinido } from '../reportes.js';
import { exportarPdf } from '../pdf.js';

const TIPOS = [['utilidades', 'Utilidades'], ['diferenciales', 'Diferenciales'], ['compras', 'Compras'], ['ventas', 'Ventas']];
const RANGOS = [['mes', 'Este mes'], ['mes_anterior', 'Mes anterior'], ['30', '30 días'], ['trimestre', 'Trimestre'], ['anio', 'Este año'], ['todo', 'Todo']];

export function pantallaReportes({ manejarError }) {
  const cfg = window.CONFIG_USDT || {};
  let tipo = 'utilidades', cartera = estado.cartera, rango = 'mes';
  let { desde, hasta } = rangoPredefinido(rango);
  const zona = el('div');

  const iDesde = el('input', { type: 'date', value: desde }), iHasta = el('input', { type: 'date', value: hasta });
  iDesde.addEventListener('change', () => { desde = iDesde.value; rango = ''; pintarChipsRango(); pintar(); });
  iHasta.addEventListener('change', () => { hasta = iHasta.value; rango = ''; pintarChipsRango(); pintar(); });

  const chipsRango = el('div.chips', { estilo: { marginBottom: '10px' } });
  const pintarChipsRango = () => chipsRango.replaceChildren(...RANGOS.map(([k, t]) => el('button.chip', { type: 'button', clase: rango === k ? 'activo' : '', onClick: () => { rango = k; ({ desde, hasta } = rangoPredefinido(k)); iDesde.value = desde; iHasta.value = hasta; pintarChipsRango(); pintar(); } }, t)));
  const chipsCartera = el('div.chips', { estilo: { marginBottom: '10px' } });
  const pintarChipsCartera = () => chipsCartera.replaceChildren(...[...(cfg.CARTERAS || []), 'AMBAS'].map(c => el('button.chip', { type: 'button', clase: cartera === c ? 'activo' : '', onClick: () => { cartera = c; pintarChipsCartera(); pintar(); } }, c)));
  const selTipo = el('div.selector');
  const pintarTipo = () => selTipo.replaceChildren(...TIPOS.map(([k, t]) => el('button', { type: 'button', clase: tipo === k ? 'activo' : '', estilo: { fontSize: '12.5px', padding: '9px 4px' }, onClick: () => { tipo = k; pintarTipo(); pintar(); } }, t)));
  pintarChipsRango(); pintarChipsCartera(); pintarTipo();

  const generar = () => {
    const todas = estado.operaciones;
    if (tipo === 'utilidades') return reporteUtilidades(todas, desde, hasta, cartera);
    if (tipo === 'diferenciales') return reporteDiferenciales(todas, desde, hasta, cartera);
    return reporteOperaciones(todas, desde, hasta, cartera, tipo === 'compras' ? 'COMPRA' : 'VENTA');
  };

  const btnPdf = el('button.btn', { type: 'button', onClick: async () => {
    btnPdf.disabled = true; btnPdf.replaceChildren(el('span.spinner'), ' Generando PDF…');
    try {
      const r = await exportarPdf(generar());
      toast(r && r.mensaje ? r.mensaje : 'PDF generado', 'ok', 4000);
    } catch (e) { manejarError(e); }
    finally { btnPdf.disabled = false; btnPdf.replaceChildren(icono('copiar'), 'Exportar a PDF'); }
  } }, icono('copiar'), 'Exportar a PDF');

  const pintar = () => {
    if (!estado.operaciones.length) { zona.replaceChildren(el('div.vacio', {}, 'No hay operaciones registradas todavía.')); return; }
    const rep = generar();
    const tablas = rep.secciones.filter(s => s.filas.length).map(sec => el('div.tarjeta', {},
      el('h2', {}, sec.titulo),
      el('div', { estilo: { overflowX: 'auto' } }, el('table.tabla.reporte', {},
        el('thead', {}, el('tr', {}, sec.columnas.map((c, i) => el('th', { clase: (sec.alinear || []).includes(i) ? 'izq' : '' }, c)))),
        el('tbody', {}, sec.filas.map(f => el('tr', {}, f.map((v, i) => el('td', { clase: ((sec.alinear || []).includes(i) ? 'izq ' : '') + colorValor(v) }, v)))),
          sec.totales ? el('tr.total', {}, sec.totales.map((v, i) => el('td', { clase: ((sec.alinear || []).includes(i) ? 'izq ' : '') + colorValor(v) }, v))) : null),
      ))));
    zona.replaceChildren(
      el('div.tarjeta.resaltada', {},
        el('h2', {}, el('span', {}, rep.titulo), el('span.accion.mini', {}, rep.subtitulo)),
        el('div.grid-2', {}, rep.kpis.map(k => el('div.dato', {}, el('div.etq', {}, k.etq), el('div.val.peq', { clase: k.clase || '' }, k.val), k.sub ? el('div.nota', {}, k.sub) : null))),
        el('div', { estilo: { marginTop: '12px' } }, btnPdf),
      ),
      tablas.length ? tablas : el('div.vacio', {}, 'Sin operaciones en este período.'),
      rep.nota ? el('p.mini', {}, rep.nota) : null,
    );
  };

  const contenido = el('div.pantalla', {},
    cabecera('Reportes', 'Para la gerencia · exportables a PDF'),
    selTipo, chipsCartera, chipsRango,
    el('div.fila', { estilo: { marginBottom: '12px' } }, el('div.campo', { estilo: { marginBottom: 0 } }, el('label', {}, 'Desde'), iDesde), el('div.campo', { estilo: { marginBottom: 0 } }, el('label', {}, 'Hasta'), iHasta)),
    zona,
  );
  montar(conNavegacion(contenido, 'reportes'));
  if (!estado.operaciones.length) zona.replaceChildren(cargando());
  pintar();
  datos.cargarOperaciones(false).then(pintar).catch(manejarError);
  const quitar = en('operaciones', () => { if (document.body.contains(contenido)) pintar(); else quitar(); });
}

function colorValor(v) {
  const t = String(v || '');
  if (/^\+[\d.,]/.test(t)) return 'positivo';
  if (/^-[\d.,]/.test(t)) return 'negativo';
  return '';
}
