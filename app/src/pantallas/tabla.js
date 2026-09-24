/**
 * Modo tabulador: todas las operaciones de la cartera en una tabla editable, como en una hoja de cálculo.
 *  - Las columnas editables son inputs; las calculadas (totales, tasa efectiva, diferenciales) se actualizan
 *    en vivo con la misma fórmula del backend (calcularOperacion).
 *  - "Nueva fila" agrega una operación en blanco; el ícono de papelera la elimina (definitivo).
 *  - Los cambios se acumulan (filas resaltadas) y se envían con "Guardar cambios": el backend revalida,
 *    recalcula y reescribe la fila completa en la hoja.
 *  - Teclado: Tab/Shift+Tab entre celdas, Enter o flechas ↑↓ para moverse por la misma columna.
 */
import { el, montar, toast, icono, confirmar, ayuda, cargando } from '../ui.js';
import { cabecera, conNavegacion } from './cascaron.js';
import { estado, navegar, en } from '../estado.js';
import * as datos from '../datos.js';
import { num, aNumero, hoyISO, horaActual, signo, signoUsd, enUsd } from '../formato.js';
import { calcularOperacion } from '../calculos.js';

const TIPOS = ['COMPRA', 'VENTA', 'PAGO'];
const EDITABLES = [
  { k: 'fecha', etq: 'Fecha', tipo: 'date', ancho: 135 },
  { k: 'hora', etq: 'Hora', tipo: 'time', ancho: 95 },
  { k: 'tipo', etq: 'Tipo', tipo: 'select', opciones: TIPOS, ancho: 100 },
  { k: 'montoUsdt', etq: 'Monto USDT', tipo: 'num', dec: 4, ancho: 110 },
  { k: 'tasa', etq: 'Tasa Bs/USDT', tipo: 'num', dec: 4, ancho: 110 },
  { k: 'comisionUsdt', etq: 'Com. USDT', tipo: 'num', dec: 4, ancho: 95 },
  { k: 'comisionVes', etq: 'Com. Bs', tipo: 'num', dec: 2, ancho: 95 },
  { k: 'tasaBcv', etq: 'Tasa BCV', tipo: 'num', dec: 4, ancho: 100 },
  { k: 'tasaP2p', etq: 'P2P ref.', tipo: 'num', dec: 4, ancho: 100 },
  { k: 'contraparte', etq: 'Contraparte / beneficiario', tipo: 'text', ancho: 170 },
  { k: 'referencia', etq: 'Referencia', tipo: 'text', ancho: 140 },
  { k: 'observaciones', etq: 'Observaciones', tipo: 'text', ancho: 220 },
  { k: 'estado', etq: 'Estado', tipo: 'select', opciones: ['ACTIVA', 'ANULADA'], ancho: 105 },
];
const CALCULADAS = [
  { k: 'totalVes', etq: 'Total Bs', dec: 2 },
  { k: 'usdtNeto', etq: 'USDT neto', dec: 4 },
  { k: 'vesNeto', etq: 'Bs neto', dec: 2 },
  { k: 'tasaEfectiva', etq: 'Tasa efectiva', dec: 4 },
  { k: 'equivUsdBcv', etq: '$ al BCV', dec: 2 },
  { k: 'difBcvUsd', etq: 'Dif. BCV $', usd: true },
  { k: 'difBcvVes', etq: 'Dif. BCV Bs', dec: 2, conSigno: true },
  { k: 'difP2pUsd', etq: 'Dif. P2P $', usd: true },
  { k: 'difP2pVes', etq: 'Dif. P2P Bs', dec: 2, conSigno: true },
];
const NUMERICOS = ['montoUsdt', 'tasa', 'comisionUsdt', 'comisionVes', 'tasaBcv', 'tasaP2p'];

export function pantallaTabla({ manejarError }) {
  let filas = [];          // { id, nuevo, valores, original, sucio, errores }
  let texto = '';
  const cuerpo = el('tbody');
  const zona = el('div.hoja-contenedor');
  const resumen = el('span.mini');

  // ---- modelo ----
  const desdeOperacion = (o) => {
    const v = {};
    EDITABLES.forEach(c => { v[c.k] = o[c.k] === undefined || o[c.k] === null ? '' : String(o[c.k]); });
    return { id: o.id, nuevo: false, valores: v, original: Object.assign({}, v), sucio: false, cartera: o.cartera };
  };
  const filaNueva = () => {
    const t = estado.tasas || {};
    const v = { fecha: hoyISO(), hora: horaActual(), tipo: 'COMPRA', montoUsdt: '', tasa: '', comisionUsdt: '0', comisionVes: '0',
      tasaBcv: t.bcv && t.bcv.valor ? String(t.bcv.valor) : '', tasaP2p: t.p2p && t.p2p.compra ? String(t.p2p.compra.promedio5 || t.p2p.compra.mejor || '') : '',
      contraparte: '', referencia: '', observaciones: '', estado: 'ACTIVA' };
    return { id: 'NUEVA-' + Date.now(), nuevo: true, valores: v, original: {}, sucio: true, cartera: estado.cartera };
  };
  const cargar = () => {
    const pendientes = filas.filter(f => f.nuevo);
    filas = pendientes.concat(estado.operaciones.filter(o => o.cartera === estado.cartera).map(desdeOperacion));
  };
  const calculo = (f) => {
    const v = f.valores;
    const c = calcularOperacion({ tipo: v.tipo, montoUsdt: aNumero(v.montoUsdt) || 0, tasa: aNumero(v.tasa) || 0, comisionUsdt: aNumero(v.comisionUsdt) || 0, comisionVes: aNumero(v.comisionVes) || 0, tasaBcv: aNumero(v.tasaBcv) || 0, tasaP2p: aNumero(v.tasaP2p) || 0 });
    c.difBcvUsd = enUsd(c.difBcvVes, aNumero(v.tasaBcv)); c.difP2pUsd = enUsd(c.difP2pVes, aNumero(v.tasaBcv));
    return c;
  };
  const cargaUtil = (f) => {
    const v = f.valores, d = {};
    EDITABLES.forEach(c => { d[c.k] = NUMERICOS.includes(c.k) ? (aNumero(v[c.k]) || 0) : v[c.k]; });
    d.cartera = f.cartera || estado.cartera; d.metodoPago = '';
    if (d.estado === 'ANULADA') d.motivoAnulacion = 'Anulada desde el modo tabulador';
    return d;
  };
  const valida = (f) => {
    const v = f.valores; const e = [];
    if (!(aNumero(v.montoUsdt) > 0)) e.push('montoUsdt');
    if (!(aNumero(v.tasa) > 0)) e.push('tasa');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.fecha)) e.push('fecha');
    f.errores = e; return !e.length;
  };

  // ---- celdas ----
  const celdaEditable = (f, col, idx) => {
    const v = f.valores[col.k];
    let e;
    if (col.tipo === 'select') e = el('select.celda', {}, col.opciones.map(o => el('option', { value: o, selected: o === v }, o)));
    else e = el('input.celda', { type: col.tipo === 'date' ? 'date' : col.tipo === 'time' ? 'time' : 'text', inputmode: col.tipo === 'num' ? 'decimal' : undefined, value: col.tipo === 'num' && v !== '' ? num(aNumero(v) || 0, col.dec) : v, autocomplete: 'off' });
    e.dataset.col = col.k; e.dataset.fila = String(idx);
    if (f.errores && f.errores.includes(col.k)) e.classList.add('error');
    const aplicar = () => {
      const nuevo = col.tipo === 'num' ? (e.value.trim() === '' ? '' : String(aNumero(e.value) || 0)) : e.value;
      if (nuevo === f.valores[col.k]) return;
      f.valores[col.k] = nuevo; f.sucio = true; f.errores = null;
      const tr = e.closest('tr'); if (tr) { tr.classList.add('sucia'); pintarCalculadas(tr, f); }
      pintarResumen();
    };
    e.addEventListener(col.tipo === 'select' ? 'change' : 'input', aplicar);
    if (col.tipo === 'num') e.addEventListener('blur', () => { if (e.value.trim() !== '') e.value = num(aNumero(e.value) || 0, col.dec); });
    e.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (col.tipo === 'select' && ev.key !== 'Enter') return;
        ev.preventDefault();
        const dir = ev.key === 'ArrowUp' ? -1 : 1;
        const destino = cuerpo.querySelector(`.celda[data-col="${col.k}"][data-fila="${idx + dir}"]`);
        if (destino) { destino.focus(); if (destino.select) destino.select(); }
      }
    });
    return el('td', {}, e);
  };
  const pintarCalculadas = (tr, f) => {
    const c = calculo(f);
    CALCULADAS.forEach(col => {
      const td = tr.querySelector(`td[data-calc="${col.k}"]`); if (!td) return;
      const val = c[col.k] || 0;
      td.textContent = col.usd ? signoUsd(val) : col.conSigno ? signo(val, col.dec) : num(val, col.dec);
      td.className = 'calc ' + ((col.usd || col.conSigno) ? (val > 0 ? 'positivo' : val < 0 ? 'negativo' : 'neutro') : '');
    });
  };
  const filaDom = (f, idx) => {
    const tr = el('tr', { clase: (f.sucio ? 'sucia ' : '') + (f.valores.estado === 'ANULADA' ? 'anulada' : '') });
    tr.appendChild(el('td.fija', {}, el('div.mini', {}, f.nuevo ? 'nueva' : f.id)));
    EDITABLES.forEach(col => tr.appendChild(celdaEditable(f, col, idx)));
    CALCULADAS.forEach(col => { const td = el('td.calc'); td.dataset.calc = col.k; tr.appendChild(td); });
    tr.appendChild(el('td', {}, el('button.btn-icono.peq', { type: 'button', title: 'Eliminar', 'aria-label': 'Eliminar', onClick: () => eliminar(f) }, icono('borrar'))));
    pintarCalculadas(tr, f);
    return tr;
  };
  const pintar = () => {
    let visibles = filas;
    if (texto) visibles = filas.filter(f => f.nuevo || [f.id, f.valores.contraparte, f.valores.referencia, f.valores.observaciones, f.valores.montoUsdt, f.valores.tasa].join(' ').toLowerCase().includes(texto));
    cuerpo.replaceChildren(...visibles.map((f, i) => filaDom(f, i)));
    if (!visibles.length) cuerpo.replaceChildren(el('tr', {}, el('td', { colspan: String(EDITABLES.length + CALCULADAS.length + 2) }, el('div.vacio', {}, 'Sin operaciones. Pulsa "Nueva fila" para agregar una.'))));
    pintarResumen();
  };
  const pintarResumen = () => {
    const sucias = filas.filter(f => f.sucio).length;
    resumen.textContent = filas.length + ' filas · ' + (sucias ? sucias + ' con cambios sin guardar' : 'sin cambios pendientes');
    btnGuardar.disabled = !sucias;
    btnGuardar.replaceChildren(icono('ok'), sucias ? 'Guardar cambios (' + sucias + ')' : 'Guardar cambios');
  };

  // ---- acciones ----
  const eliminar = async (f) => {
    if (f.nuevo) { filas = filas.filter(x => x !== f); pintar(); return; }
    const ok = await confirmar({ titulo: 'Eliminar ' + f.id, mensaje: 'Se borra la fila de la hoja de forma definitiva (no se puede deshacer). Si prefieres conservar el rastro, cambia su estado a ANULADA y guarda.', textoOk: 'Eliminar', peligro: true });
    if (!ok) return;
    try { await datos.borrarOperacion(f.id); toast(f.id + ' eliminada', 'ok'); } catch (e) { manejarError(e); }
  };
  const guardar = async () => {
    const sucias = filas.filter(f => f.sucio);
    const invalidas = sucias.filter(f => !valida(f));
    if (invalidas.length) { pintar(); toast('Revisa las celdas en rojo (monto, tasa o fecha) de ' + invalidas.length + ' fila(s).', 'error', 5000); return; }
    btnGuardar.disabled = true; btnGuardar.replaceChildren(el('span.spinner'), ' Guardando…');
    let ok = 0, fallos = 0;
    for (const f of sucias) {
      try {
        if (f.nuevo) { await datos.registrarOperacion(cargaUtil(f)); filas = filas.filter(x => x !== f); }
        else { await datos.actualizarOperacion(f.id, cargaUtil(f)); f.sucio = false; f.original = Object.assign({}, f.valores); }
        ok++;
      } catch (e) { fallos++; f.errores = ['montoUsdt']; toast(f.id + ': ' + (e.message || e), 'error', 6000); }
    }
    cargar(); pintar();
    toast(ok + ' fila(s) guardada(s)' + (fallos ? ' · ' + fallos + ' con error' : ''), fallos ? 'error' : 'ok', 4000);
  };
  const btnGuardar = el('button.btn.peq', { type: 'button', onClick: guardar }, icono('ok'), 'Guardar cambios');
  const btnNueva = el('button.btn.secundario.peq', { type: 'button', onClick: () => { filas.unshift(filaNueva()); pintar(); const primera = cuerpo.querySelector('.celda[data-col="montoUsdt"][data-fila="0"]'); if (primera) primera.focus(); } }, icono('mas'), 'Nueva fila');
  const btnDescartar = el('button.btn.fantasma.peq', { type: 'button', onClick: () => { filas = []; cargar(); pintar(); } }, 'Descartar cambios');
  const busq = el('input', { type: 'search', placeholder: 'Filtrar por ID, contraparte, nota, monto…' });
  busq.addEventListener('input', () => { texto = busq.value.trim().toLowerCase(); pintar(); });

  const tabla = el('table.hoja', {},
    el('thead', {}, el('tr', {},
      el('th.fija', {}, 'ID'),
      EDITABLES.map(c => el('th', { estilo: { minWidth: (c.ancho || 100) + 'px' } }, c.etq)),
      CALCULADAS.map(c => el('th.calc', {}, c.etq)),
      el('th', {}, ''),
    )),
    cuerpo);
  zona.appendChild(tabla);

  const contenido = el('div.pantalla.ancha', {},
    cabecera('Modo tabulador', 'Edita, agrega o elimina operaciones como en una hoja de cálculo', el('div', { estilo: { display: 'flex', alignItems: 'center', gap: '6px' } }, ayuda('tabla'), el('button.btn-icono', { type: 'button', 'aria-label': 'Volver al historial', title: 'Volver al historial', onClick: () => navegar('historial') }, icono('atras')))),
    el('div', { estilo: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '10px' } }, btnNueva, btnGuardar, btnDescartar, resumen),
    el('div.filtros', { estilo: { marginBottom: '8px' } }, busq),
    el('p.mini', {}, 'Cartera ' + estado.cartera + ' · columnas amarillas = editables, grises = calculadas al instante. Tab avanza, Enter baja.'),
    zona,
  );
  montar(conNavegacion(contenido, 'historial'));
  if (!estado.operaciones.length) cuerpo.replaceChildren(el('tr', {}, el('td', { colspan: '24' }, cargando())));
  cargar(); pintar();
  datos.cargarOperaciones(false).then(() => { cargar(); pintar(); }).catch(manejarError);
  const quitar = en('operaciones', () => { if (document.body.contains(contenido)) { cargar(); pintar(); } else quitar(); });
}
