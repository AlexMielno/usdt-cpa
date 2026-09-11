/**
 * Reportes por rango de fechas (cálculo puro; la pantalla y el PDF solo los pintan).
 *
 *  - Utilidades: resultado realizado en ventas (neto de comisiones, contra el costo promedio),
 *    diferenciales, comisiones, saldos inicial/final y desglose mensual.
 *  - Diferenciales: vs BCV y vs P2P operación por operación y por mes.
 *  - Compras / Ventas: detalle de cada operación del período con totales.
 *
 * Todos devuelven la misma estructura genérica que entiende pdf.js:
 *   { titulo, subtitulo, cartera, desde, hasta, kpis: [{etq, val, clase?}], secciones: [{titulo, columnas, filas, totales?, alinear?}], nota }
 */
import { redondear } from './calculos.js';
import { num, ves, signo, fechaCorta, mesDe, nombreMes } from './formato.js';

const cmp = (a, b) => (a.fecha + a.hora + a.id).localeCompare(b.fecha + b.hora + b.id);

/** Recorre TODAS las operaciones activas en orden y devuelve, por ID, el costo promedio vigente y el resultado de cada venta. */
export function simularCartera(todas) {
  const porId = {};
  const estado = {};
  todas.filter(o => o.estado === 'ACTIVA').slice().sort(cmp).forEach(o => {
    const c = estado[o.cartera] || (estado[o.cartera] = { saldo: 0, costoTotal: 0, costoProm: 0 });
    if (o.tipo === 'COMPRA') {
      c.costoTotal += o.vesNeto; c.saldo += o.usdtNeto;
      c.costoProm = c.saldo > 0 ? c.costoTotal / c.saldo : 0;
      porId[o.id] = { costoPromedio: c.costoProm, resultadoVes: 0, saldoDespues: c.saldo };
    } else {
      const res = c.costoProm > 0 ? (o.tasaEfectiva - c.costoProm) * o.usdtNeto : 0;
      c.saldo -= o.usdtNeto;
      c.costoTotal = c.saldo > 0 ? c.saldo * c.costoProm : 0;
      porId[o.id] = { costoPromedio: c.costoProm, resultadoVes: res, saldoDespues: c.saldo };
    }
  });
  return porId;
}

export function enRango(todas, desde, hasta, cartera) {
  return todas.filter(o => o.estado === 'ACTIVA' && (!cartera || cartera === 'AMBAS' || o.cartera === cartera)
    && (!desde || o.fecha >= desde) && (!hasta || o.fecha <= hasta)).sort(cmp);
}

function saldoHasta(todas, fechaExclusiva, cartera) {
  let s = 0;
  todas.filter(o => o.estado === 'ACTIVA' && (!cartera || cartera === 'AMBAS' || o.cartera === cartera) && o.fecha < fechaExclusiva)
    .forEach(o => { s += o.tipo === 'COMPRA' ? o.usdtNeto : -o.usdtNeto; });
  return s;
}

function sumar(ops, campo) { return ops.reduce((s, o) => s + (Number(o[campo]) || 0), 0); }
function textoRango(desde, hasta) { return (desde ? fechaCorta(desde) : 'inicio') + ' al ' + (hasta ? fechaCorta(hasta) : 'hoy'); }
const cl = v => v > 0 ? 'positivo' : v < 0 ? 'negativo' : 'neutro';

function porMes(ops, sim) {
  const g = {};
  ops.forEach(o => {
    const m = mesDe(o.fecha);
    const r = g[m] || (g[m] = { mes: m, comprasUsdt: 0, comprasVes: 0, ventasUsdt: 0, ventasVes: 0, resultado: 0, difBcv: 0, difP2p: 0, comisionesVes: 0, comisionesUsdt: 0, n: 0 });
    r.n++;
    if (o.tipo === 'COMPRA') { r.comprasUsdt += o.usdtNeto; r.comprasVes += o.vesNeto; } else { r.ventasUsdt += o.usdtNeto; r.ventasVes += o.vesNeto; r.resultado += (sim[o.id] || {}).resultadoVes || 0; }
    r.difBcv += o.difBcvVes; r.difP2p += o.difP2pVes; r.comisionesVes += o.comisionVes; r.comisionesUsdt += o.comisionUsdt;
  });
  return Object.values(g).sort((a, b) => a.mes.localeCompare(b.mes));
}

// ---------------------------------------------------------------------------------------
export function reporteUtilidades(todas, desde, hasta, cartera) {
  const sim = simularCartera(todas);
  const ops = enRango(todas, desde, hasta, cartera);
  const compras = ops.filter(o => o.tipo === 'COMPRA'), ventas = ops.filter(o => o.tipo === 'VENTA');
  const cU = sumar(compras, 'usdtNeto'), cV = sumar(compras, 'vesNeto'), vU = sumar(ventas, 'usdtNeto'), vV = sumar(ventas, 'vesNeto');
  const resultado = ventas.reduce((s, o) => s + ((sim[o.id] || {}).resultadoVes || 0), 0);
  const resultadoUsd = ventas.reduce((s, o) => s + (o.tasaBcv > 0 ? ((sim[o.id] || {}).resultadoVes || 0) / o.tasaBcv : 0), 0);
  const difBcv = sumar(ops, 'difBcvVes'), difP2p = sumar(ops, 'difP2pVes');
  const saldoIni = saldoHasta(todas, desde || '0000', cartera);
  const saldoFin = saldoIni + cU - vU;
  const meses = porMes(ops, sim);
  return {
    tipo: 'utilidades', titulo: 'Reporte de utilidades', subtitulo: 'Período ' + textoRango(desde, hasta), cartera: cartera || 'AMBAS', desde, hasta,
    kpis: [
      { etq: 'Resultado realizado en ventas', val: signo(resultado, 2) + ' Bs', clase: cl(resultado), sub: 'neto de comisiones · ≈ $ ' + num(resultadoUsd, 2) + ' al BCV' },
      { etq: 'Diferencial vs BCV', val: signo(difBcv, 2) + ' Bs', clase: cl(difBcv) },
      { etq: 'Diferencial vs P2P', val: signo(difP2p, 2) + ' Bs', clase: cl(difP2p) },
      { etq: 'Comisiones', val: num(sumar(ops, 'comisionUsdt'), 2) + ' USDT · ' + ves(sumar(ops, 'comisionVes')) },
      { etq: 'Saldo USDT inicial → final', val: num(saldoIni, 2) + ' → ' + num(saldoFin, 2) },
      { etq: 'Operaciones', val: compras.length + ' compras · ' + ventas.length + ' ventas' },
    ],
    secciones: [
      { titulo: 'Resumen del período', columnas: ['Concepto', 'Compras', 'Ventas'], alinear: [0], filas: [
        ['Operaciones', String(compras.length), String(ventas.length)],
        ['USDT (neto)', num(cU, 2), num(vU, 2)],
        ['Bolívares (neto)', ves(cV), ves(vV)],
        ['Tasa promedio ponderada', cU ? num(cV / cU, 4) : '—', vU ? num(vV / vU, 4) : '—'],
        ['Equivalente USD al BCV', '$ ' + num(sumar(compras, 'equivUsdBcv'), 2), '$ ' + num(sumar(ventas, 'equivUsdBcv'), 2)],
        ['Comisiones USDT', num(sumar(compras, 'comisionUsdt'), 4), num(sumar(ventas, 'comisionUsdt'), 4)],
        ['Comisiones Bs', ves(sumar(compras, 'comisionVes')), ves(sumar(ventas, 'comisionVes'))],
        ['Diferencial vs BCV', signo(sumar(compras, 'difBcvVes'), 2) + ' Bs', signo(sumar(ventas, 'difBcvVes'), 2) + ' Bs'],
        ['Diferencial vs P2P', signo(sumar(compras, 'difP2pVes'), 2) + ' Bs', signo(sumar(ventas, 'difP2pVes'), 2) + ' Bs'],
      ] },
      { titulo: 'Desglose mensual', columnas: ['Mes', 'Compras USDT', 'Ventas USDT', 'Resultado Bs', 'Dif. BCV Bs', 'Dif. P2P Bs'], alinear: [0],
        filas: meses.map(m => [nombreMes(m.mes), num(m.comprasUsdt, 2), num(m.ventasUsdt, 2), signo(m.resultado, 2), signo(m.difBcv, 2), signo(m.difP2p, 2)]),
        totales: ['Total', num(cU, 2), num(vU, 2), signo(resultado, 2), signo(difBcv, 2), signo(difP2p, 2)] },
      { titulo: 'Detalle de ventas (resultado contra costo promedio)', columnas: ['Fecha', 'ID', 'USDT', 'Tasa efectiva', 'Costo prom.', 'Resultado Bs'], alinear: [0, 1],
        filas: ventas.map(o => [fechaCorta(o.fecha), o.id, num(o.usdtNeto, 2), num(o.tasaEfectiva, 4), num((sim[o.id] || {}).costoPromedio || 0, 4), signo((sim[o.id] || {}).resultadoVes || 0, 2)]),
        totales: ['Total', '', num(vU, 2), '', '', signo(resultado, 2)] },
    ],
    nota: 'Resultado realizado = (tasa efectiva de venta − costo promedio ponderado de las compras) × USDT vendidos; incluye el efecto de las comisiones. Diferencial positivo = a favor.',
  };
}

export function reporteDiferenciales(todas, desde, hasta, cartera) {
  const sim = simularCartera(todas);
  const ops = enRango(todas, desde, hasta, cartera);
  const difBcv = sumar(ops, 'difBcvVes'), difP2p = sumar(ops, 'difP2pVes');
  const meses = porMes(ops, sim);
  const usdBcv = ops.reduce((s, o) => s + (o.tasaBcv > 0 ? o.difBcvVes / o.tasaBcv : 0), 0);
  return {
    tipo: 'diferenciales', titulo: 'Reporte de diferenciales', subtitulo: 'Período ' + textoRango(desde, hasta), cartera: cartera || 'AMBAS', desde, hasta,
    kpis: [
      { etq: 'Diferencial vs BCV', val: signo(difBcv, 2) + ' Bs', clase: cl(difBcv), sub: '≈ $ ' + num(usdBcv, 2) + ' al BCV' },
      { etq: 'Diferencial vs P2P', val: signo(difP2p, 2) + ' Bs', clase: cl(difP2p) },
      { etq: 'Brecha promedio vs BCV', val: ops.length ? signo(ops.reduce((s, o) => s + o.difBcvPct, 0) / ops.length * 100, 2) + ' %' : '—' },
      { etq: 'Operaciones', val: String(ops.length) },
    ],
    secciones: [
      { titulo: 'Por mes', columnas: ['Mes', 'Operaciones', 'Dif. BCV Bs', 'Dif. P2P Bs'], alinear: [0],
        filas: meses.map(m => [nombreMes(m.mes), String(m.n), signo(m.difBcv, 2), signo(m.difP2p, 2)]), totales: ['Total', String(ops.length), signo(difBcv, 2), signo(difP2p, 2)] },
      { titulo: 'Por operación', columnas: ['Fecha', 'ID', 'Tipo', 'USDT', 'Tasa', 'BCV', 'P2P ref.', 'Dif. BCV Bs', 'Dif. BCV %', 'Dif. P2P Bs'], alinear: [0, 1, 2],
        filas: ops.map(o => [fechaCorta(o.fecha), o.id, o.tipo, num(o.montoUsdt, 2), num(o.tasa, 2), num(o.tasaBcv, 2), num(o.tasaP2p, 2), signo(o.difBcvVes, 2), signo(o.difBcvPct * 100, 2), signo(o.difP2pVes, 2)]),
        totales: ['Total', '', '', num(sumar(ops, 'montoUsdt'), 2), '', '', '', signo(difBcv, 2), '', signo(difP2p, 2)] },
    ],
    nota: 'Compra: diferencial = (referencia − tasa pagada) × USDT. Venta: diferencial = (tasa cobrada − referencia) × USDT. Positivo = a favor de la empresa.',
  };
}

export function reporteOperaciones(todas, desde, hasta, cartera, tipo) {
  const sim = simularCartera(todas);
  const ops = enRango(todas, desde, hasta, cartera).filter(o => o.tipo === tipo);
  const esCompra = tipo === 'COMPRA';
  const u = sumar(ops, 'usdtNeto'), v = sumar(ops, 'vesNeto');
  const meses = porMes(ops, sim);
  return {
    tipo: esCompra ? 'compras' : 'ventas', titulo: 'Reporte de ' + (esCompra ? 'compras' : 'ventas') + ' de USDT', subtitulo: 'Período ' + textoRango(desde, hasta), cartera: cartera || 'AMBAS', desde, hasta,
    kpis: [
      { etq: 'USDT ' + (esCompra ? 'comprados' : 'vendidos'), val: num(u, 2) },
      { etq: esCompra ? 'Bolívares pagados' : 'Bolívares recibidos', val: ves(v) },
      { etq: 'Tasa promedio', val: u ? num(v / u, 4) : '—' },
      { etq: 'Equivalente USD BCV', val: '$ ' + num(sumar(ops, 'equivUsdBcv'), 2) },
      { etq: 'Comisiones', val: num(sumar(ops, 'comisionUsdt'), 2) + ' USDT · ' + ves(sumar(ops, 'comisionVes')) },
      { etq: 'Operaciones', val: String(ops.length) },
    ],
    secciones: [
      { titulo: 'Por mes', columnas: ['Mes', 'Operaciones', 'USDT', 'Bolívares', 'Tasa promedio'], alinear: [0],
        filas: meses.map(m => { const mu = esCompra ? m.comprasUsdt : m.ventasUsdt, mv = esCompra ? m.comprasVes : m.ventasVes; return [nombreMes(m.mes), String(m.n), num(mu, 2), ves(mv), mu ? num(mv / mu, 4) : '—']; }),
        totales: ['Total', String(ops.length), num(u, 2), ves(v), u ? num(v / u, 4) : '—'] },
      { titulo: 'Detalle', columnas: ['Fecha', 'ID', 'Cartera', 'USDT', 'Tasa', 'Total Bs', 'Com. USDT', 'Com. Bs', 'Neto Bs', 'Contraparte', 'Método', 'Observaciones'], alinear: [0, 1, 2, 9, 10, 11],
        filas: ops.map(o => [fechaCorta(o.fecha), o.id, o.cartera, num(o.montoUsdt, 2), num(o.tasa, 2), num(o.totalVes, 2), num(o.comisionUsdt, 2), num(o.comisionVes, 2), num(o.vesNeto, 2), o.contraparte || '', o.metodoPago || '', o.observaciones || '']),
        totales: ['Total', '', '', num(sumar(ops, 'montoUsdt'), 2), '', num(sumar(ops, 'totalVes'), 2), num(sumar(ops, 'comisionUsdt'), 2), num(sumar(ops, 'comisionVes'), 2), num(v, 2), '', '', ''] },
    ],
    nota: esCompra ? 'Neto Bs = total pagado incluyendo comisiones en bolívares.' : 'Neto Bs = total recibido después de comisiones en bolívares.',
  };
}

/** Rangos rápidos. */
export function rangoPredefinido(clave) {
  const hoy = new Date(); const y = hoy.getFullYear(), m = hoy.getMonth();
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  switch (clave) {
    case 'mes': return { desde: iso(new Date(y, m, 1)), hasta: iso(hoy) };
    case 'mes_anterior': return { desde: iso(new Date(y, m - 1, 1)), hasta: iso(new Date(y, m, 0)) };
    case '30': { const d = new Date(hoy); d.setDate(d.getDate() - 29); return { desde: iso(d), hasta: iso(hoy) }; }
    case 'trimestre': { const q = Math.floor(m / 3) * 3; return { desde: iso(new Date(y, q, 1)), hasta: iso(hoy) }; }
    case 'anio': return { desde: y + '-01-01', hasta: iso(hoy) };
    default: return { desde: '', hasta: '' };
  }
}
