/** Historial con filtros, agrupado por mes, y detalle con anulación / edición de notas. */
import { el, montar, toast, icono, modal, confirmar, cargando, ayuda } from '../ui.js';
import { cabecera, selectorCartera, conNavegacion } from './cascaron.js';
import { estado, en } from '../estado.js';
import * as datos from '../datos.js';
import { num, ves, signo, fechaCorta, fechaLarga, mesDe, nombreMes, pct } from '../formato.js';

export function filaOperacion(o) {
  const anulada = o.estado === 'ANULADA';
  const dif = o.difP2pVes;
  return el('div.op', { clase: anulada ? 'anulada' : '', onClick: () => verDetalle(o) },
    el('div.icono', { clase: anulada ? 'anulada' : o.tipo.toLowerCase() }, o.tipo === 'COMPRA' ? 'C' : 'V'),
    el('div.centro', {},
      el('div.titulo', {}, num(o.montoUsdt, 2) + ' USDT @ ' + num(o.tasa, 2), anulada ? el('span.etiqueta.anulada', {}, 'ANULADA') : null),
      el('div.detalle', {}, fechaCorta(o.fecha) + ' ' + (o.hora || '') + (o.observaciones ? ' · ' + o.observaciones : (o.contraparte ? ' · ' + o.contraparte : '')))),
    el('div.derecha', {},
      el('div.monto', {}, ves(o.vesNeto)),
      el('div.dif', { clase: dif > 0 ? 'positivo' : dif < 0 ? 'negativo' : 'neutro' }, 'P2P ' + signo(dif, 0) + ' Bs')),
  );
}

export function verDetalle(o) {
  const cl = v => v > 0 ? 'positivo' : v < 0 ? 'negativo' : 'neutro';
  const fila = (etq, val, clase) => el('tr', {}, el('td.etq', {}, etq), el('td', { clase: clase || '' }, val));
  modal({
    titulo: o.tipo + ' · ' + o.id,
    contenido: (cerrar) => [
      el('div.mini', { estilo: { marginBottom: '8px' } }, fechaLarga(o.fecha) + ' ' + (o.hora || '') + ' · ' + o.cartera + (o.estado === 'ANULADA' ? ' · ANULADA: ' + (o.motivoAnulacion || '') : '')),
      el('table.tabla', {},
        fila('Monto', num(o.montoUsdt, 4) + ' USDT'),
        fila('Tasa de la operación', num(o.tasa, 4) + ' Bs/USDT'),
        fila('Total en bolívares', ves(o.totalVes)),
        fila('Comisiones', num(o.comisionUsdt, 4) + ' USDT · ' + ves(o.comisionVes)),
        fila(o.tipo === 'COMPRA' ? 'USDT netos recibidos' : 'USDT entregados', num(o.usdtNeto, 4)),
        fila(o.tipo === 'COMPRA' ? 'Total pagado' : 'Total neto recibido', ves(o.vesNeto)),
        fila('Tasa efectiva', num(o.tasaEfectiva, 4)),
        fila('Tasa BCV del día', num(o.tasaBcv, 4)),
        fila('Tasa P2P de referencia', num(o.tasaP2p, 4)),
        fila('Diferencial vs BCV', signo(o.difBcvVes, 2) + ' Bs (' + signo(o.difBcvPct * 100, 2) + ' %)', cl(o.difBcvVes)),
        fila('Diferencial vs P2P', signo(o.difP2pVes, 2) + ' Bs', cl(o.difP2pVes)),
        fila('Equivalente USD al BCV', '$ ' + num(o.equivUsdBcv, 2)),
        o.contraparte ? fila('Contraparte', o.contraparte) : null,
        (o.metodoPago || o.referencia) ? fila('Método / referencia', (o.metodoPago || '—') + ' · ' + (o.referencia || '—')) : null,
        fila('Observaciones', o.observaciones || '—'),
        fila('Registrado desde', (o.dispositivo || '—') + ' · ' + (o.registrado ? new Date(o.registrado).toLocaleString('es-VE') : '')),
      ),
      o.estado === 'ACTIVA' ? el('div.acciones', {},
        el('button.btn.secundario', { type: 'button', onClick: () => { cerrar(); editarNotas(o); } }, 'Editar notas'),
        el('button.btn.peligro', { type: 'button', onClick: async () => {
          const motivo = await confirmar({ titulo: 'Anular ' + o.id, mensaje: 'La operación quedará marcada como ANULADA en la hoja (no se borra) y dejará de contar en la cartera.', textoOk: 'Anular', peligro: true, campo: { etiqueta: 'Motivo', placeholder: 'Ej. registrada dos veces', obligatorio: true } });
          if (!motivo) return;
          try { await datos.anularOperacion(o.id, motivo); toast('Operación anulada', 'ok'); cerrar(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Anular'),
      ) : null,
    ],
  });
}

function editarNotas(o) {
  const iContra = el('input', { type: 'text', value: o.contraparte || '', maxlength: 80 });
  const iRef = el('input', { type: 'text', value: o.referencia || '', maxlength: 60 });
  const iObs = el('textarea', { maxlength: 1000 }); iObs.value = o.observaciones || '';
  modal({ titulo: 'Editar notas de ' + o.id, contenido: (cerrar) => [
    el('p.mini', {}, 'Solo se pueden corregir las observaciones. Para cambiar montos o tasas, anula la operación y regístrala de nuevo.'),
    el('div.campo', {}, el('label', {}, 'Observaciones'), iObs),
    el('button.btn', { type: 'button', onClick: async () => {
      try { await datos.editarOperacion(o.id, { observaciones: iObs.value.trim() }); toast('Notas actualizadas', 'ok'); cerrar(); } catch (e) { toast(e.message, 'error'); }
    } }, 'Guardar'),
  ] });
}

export function pantallaHistorial({ manejarError }) {
  let filtroTipo = 'TODAS', texto = '', mes = '';
  const lista = el('div');
  const busq = el('input', { type: 'search', placeholder: 'Buscar por nota, ID o monto…' });
  busq.addEventListener('input', () => { texto = busq.value.trim().toLowerCase(); pintar(); });
  const selMes = el('select', { estilo: { background: 'var(--fondo-2)', color: 'var(--texto)', border: '1px solid var(--borde)', borderRadius: '999px', padding: '8px 12px', fontSize: '14px' } });
  selMes.addEventListener('change', () => { mes = selMes.value; pintar(); });
  const chips = el('div.chips');
  const pintarChips = () => chips.replaceChildren(...[['TODAS', 'Todas'], ['COMPRA', 'Compras'], ['VENTA', 'Ventas'], ['ANULADA', 'Anuladas']].map(([v, t]) => el('button.chip', { type: 'button', clase: filtroTipo === v ? 'activo' : '', onClick: () => { filtroTipo = v; pintarChips(); pintar(); } }, t)));
  pintarChips();

  const pintar = () => {
    let ops = estado.operaciones.filter(o => o.cartera === estado.cartera);
    const meses = [...new Set(ops.map(o => mesDe(o.fecha)))].sort().reverse();
    const actual = selMes.value;
    selMes.replaceChildren(el('option', { value: '' }, 'Todos los meses'), ...meses.map(m => el('option', { value: m, selected: m === actual }, nombreMes(m))));
    if (filtroTipo === 'ANULADA') ops = ops.filter(o => o.estado === 'ANULADA');
    else if (filtroTipo !== 'TODAS') ops = ops.filter(o => o.tipo === filtroTipo && o.estado === 'ACTIVA');
    if (mes) ops = ops.filter(o => mesDe(o.fecha) === mes);
    if (texto) ops = ops.filter(o => [o.id, o.contraparte, o.referencia, o.observaciones, o.metodoPago, String(o.montoUsdt), String(o.tasa)].join(' ').toLowerCase().includes(texto));
    if (!ops.length) { lista.replaceChildren(el('div.vacio', {}, estado.operaciones.length ? 'Nada coincide con el filtro.' : 'Aún no hay operaciones. Registra la primera desde el botón +.')); return; }
    const grupos = {};
    ops.forEach(o => { (grupos[mesDe(o.fecha)] = grupos[mesDe(o.fecha)] || []).push(o); });
    lista.replaceChildren(...Object.keys(grupos).sort().reverse().map(m => {
      const g = grupos[m], activas = g.filter(o => o.estado === 'ACTIVA');
      const compras = activas.filter(o => o.tipo === 'COMPRA').reduce((s, o) => s + o.usdtNeto, 0);
      const ventas = activas.filter(o => o.tipo === 'VENTA').reduce((s, o) => s + o.usdtNeto, 0);
      const difP2p = activas.reduce((s, o) => s + o.difP2pVes, 0), difBcv = activas.reduce((s, o) => s + o.difBcvVes, 0);
      return el('div.tarjeta', {},
        el('h2', {}, el('span', {}, nombreMes(m)), el('span.accion.mini', {}, `C ${num(compras, 0)} · V ${num(ventas, 0)} USDT`)),
        el('div.mini', { estilo: { marginBottom: '6px' } }, 'Dif. P2P ', el('b', { clase: difP2p >= 0 ? 'positivo' : 'negativo' }, signo(difP2p, 0) + ' Bs'), ' · Dif. BCV ', el('b', { clase: difBcv >= 0 ? 'positivo' : 'negativo' }, signo(difBcv, 0) + ' Bs')),
        g.map(filaOperacion));
    }));
  };

  const btnRefrescar = el('button.btn-icono', { type: 'button', 'aria-label': 'Actualizar', onClick: async () => { btnRefrescar.classList.add('girando'); try { await datos.cargarOperaciones(true); pintar(); } catch (e) { manejarError(e); } finally { btnRefrescar.classList.remove('girando'); } } }, icono('refrescar'));
  const contenido = el('div.pantalla', {},
    cabecera('Historial', 'Operaciones registradas', btnRefrescar),
    selectorCartera(pintar),
    el('div.filtros', {}, busq, selMes, ayuda('filtros')),
    el('div', { estilo: { display: 'flex', alignItems: 'center', gap: '4px' } }, chips, ayuda('detalleOperacion')),
    el('div', { estilo: { height: '10px' } }),
    lista,
  );
  montar(conNavegacion(contenido, 'historial'));
  if (!estado.operaciones.length) lista.replaceChildren(cargando());
  pintar();
  datos.cargarOperaciones(false).then(pintar).catch(manejarError);
  const quitar = en('operaciones', () => { if (document.body.contains(contenido)) pintar(); else quitar(); });
}
