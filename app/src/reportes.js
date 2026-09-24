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
import { num, ves, usd, signoUsd, enUsd, signo, fechaCorta, mesDe, nombreMes } from './formato.js';

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
      porId[o.id] = { costoPromedio: c.costoProm, resultadoVes: 0, resultadoUsd: 0, saldoDespues: c.saldo };
    } else {
      const res = c.costoProm > 0 ? (o.tasaEfectiva - c.costoProm) * o.usdtNeto : 0;
      c.saldo -= o.usdtNeto;
      c.costoTotal = c.saldo > 0 ? c.saldo * c.costoProm : 0;
      porId[o.id] = { costoPromedio: c.costoProm, resultadoVes: res, resultadoUsd: enUsd(res, o.tasaBcv), saldoDespues: c.saldo };
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
/** Suma un campo en bolívares convertido a $ con la tasa BCV de cada operación. */
function sumarUsd(ops, campo) { return ops.reduce((s, o) => s + enUsd(o[campo], o.tasaBcv), 0); }
/** Comisiones totales en $: las de USDT (1 USDT ≈ 1 $) más las de bolívares al BCV. */
function comisionesUsd(ops) { return ops.reduce((s, o) => s + (Number(o.comisionUsdt) || 0) + enUsd(o.comisionVes, o.tasaBcv), 0); }
function textoRango(desde, hasta) { return (desde ? fechaCorta(desde) : 'inicio') + ' al ' + (hasta ? fechaCorta(hasta) : 'hoy'); }
const cl = v => v > 0 ? 'positivo' : v < 0 ? 'negativo' : 'neutro';

function porMes(ops, sim) {
  const g = {};
  ops.forEach(o => {
    const m = mesDe(o.fecha);
    const r = g[m] || (g[m] = { mes: m, comprasUsdt: 0, comprasVes: 0, ventasUsdt: 0, ventasVes: 0, pagosUsdt: 0, pagosVes: 0, resultado: 0, resultadoUsd: 0, difBcv: 0, difP2p: 0, difBcvUsd: 0, difP2pUsd: 0, comisionesVes: 0, comisionesUsdt: 0, comisionesUsd: 0, n: 0 });
    r.n++;
    if (o.tipo === 'COMPRA') { r.comprasUsdt += o.usdtNeto; r.comprasVes += o.vesNeto; }
    else {
      if (o.tipo === 'PAGO') { r.pagosUsdt += o.usdtNeto; r.pagosVes += o.vesNeto; } else { r.ventasUsdt += o.usdtNeto; r.ventasVes += o.vesNeto; }
      r.resultado += (sim[o.id] || {}).resultadoVes || 0; r.resultadoUsd += (sim[o.id] || {}).resultadoUsd || 0;
    }
    r.difBcv += o.difBcvVes; r.difP2p += o.difP2pVes; r.difBcvUsd += enUsd(o.difBcvVes, o.tasaBcv); r.difP2pUsd += enUsd(o.difP2pVes, o.tasaBcv);
    r.comisionesVes += o.comisionVes; r.comisionesUsdt += o.comisionUsdt; r.comisionesUsd += (Number(o.comisionUsdt) || 0) + enUsd(o.comisionVes, o.tasaBcv);
  });
  return Object.values(g).sort((a, b) => a.mes.localeCompare(b.mes));
}

// ---------------------------------------------------------------------------------------
export function reporteUtilidades(todas, desde, hasta, cartera) {
  const sim = simularCartera(todas);
  const ops = enRango(todas, desde, hasta, cartera);
  const compras = ops.filter(o => o.tipo === 'COMPRA'), ventas = ops.filter(o => o.tipo === 'VENTA'), pagos = ops.filter(o => o.tipo === 'PAGO');
  const salidas = ventas.concat(pagos);   // ventas y pagos sacan USDT de la cartera y generan resultado contra el costo promedio
  const cU = sumar(compras, 'usdtNeto'), cV = sumar(compras, 'vesNeto'), vU = sumar(ventas, 'usdtNeto'), vV = sumar(ventas, 'vesNeto'), pU = sumar(pagos, 'usdtNeto'), pV = sumar(pagos, 'vesNeto');
  const resultado = salidas.reduce((s, o) => s + ((sim[o.id] || {}).resultadoVes || 0), 0);
  const resultadoUsd = salidas.reduce((s, o) => s + ((sim[o.id] || {}).resultadoUsd || 0), 0);
  const difBcv = sumar(ops, 'difBcvVes'), difP2p = sumar(ops, 'difP2pVes');
  const difBcvUsd = sumarUsd(ops, 'difBcvVes'), difP2pUsd = sumarUsd(ops, 'difP2pVes');
  const comUsd = comisionesUsd(ops);
  const saldoIni = saldoHasta(todas, desde || '0000', cartera);
  const saldoFin = saldoIni + cU - vU - pU;
  const meses = porMes(ops, sim);
  const col = (grupo) => [String(grupo.length), num(sumar(grupo, 'usdtNeto'), 2), usd(sumar(grupo, 'equivUsdBcv')), ves(sumar(grupo, 'vesNeto')),
    sumar(grupo, 'usdtNeto') ? num(sumar(grupo, 'vesNeto') / sumar(grupo, 'usdtNeto'), 4) : '—', usd(comisionesUsd(grupo)),
    num(sumar(grupo, 'comisionUsdt'), 4) + ' · ' + ves(sumar(grupo, 'comisionVes')), signoUsd(sumarUsd(grupo, 'difBcvVes')), signoUsd(sumarUsd(grupo, 'difP2pVes'))];
  const cc = col(compras), cv = col(ventas), cp = col(pagos);
  const conceptos = ['Operaciones', 'USDT (neto)', 'Equivalente $ al BCV', 'Bolívares (neto)', 'Tasa promedio ponderada', 'Comisiones ($ al BCV)', 'Comisiones USDT · Bs', 'Diferencial vs BCV ($)', 'Diferencial vs P2P ($)'];
  return {
    tipo: 'utilidades', titulo: 'Reporte de utilidades', subtitulo: 'Período ' + textoRango(desde, hasta), cartera: cartera || 'AMBAS', desde, hasta,
    kpis: [
      { etq: 'Resultado realizado (ventas y pagos)', val: signoUsd(resultadoUsd), clase: cl(resultadoUsd), sub: 'neto de comisiones · ' + signo(resultado, 2) + ' Bs' },
      { etq: 'Diferencial vs BCV', val: signoUsd(difBcvUsd), clase: cl(difBcvUsd), sub: signo(difBcv, 2) + ' Bs' },
      { etq: 'Diferencial vs P2P', val: signoUsd(difP2pUsd), clase: cl(difP2pUsd), sub: signo(difP2p, 2) + ' Bs' },
      { etq: 'Comisiones', val: usd(comUsd), sub: num(sumar(ops, 'comisionUsdt'), 2) + ' USDT · ' + ves(sumar(ops, 'comisionVes')) },
      { etq: 'Saldo USDT inicial → final', val: num(saldoIni, 2) + ' → ' + num(saldoFin, 2) },
      { etq: 'Operaciones', val: compras.length + ' compras · ' + ventas.length + ' ventas · ' + pagos.length + ' pagos' },
    ],
    secciones: [
      { titulo: 'Resumen del período', columnas: ['Concepto', 'Compras', 'Ventas', 'Pagos'], alinear: [0], filas: conceptos.map((c, i) => [c, cc[i], cv[i], cp[i]]) },
      { titulo: 'Desglose mensual (en $ al BCV)', columnas: ['Mes', 'Compras USDT', 'Ventas USDT', 'Pagos USDT', 'Resultado $', 'Dif. BCV $', 'Dif. P2P $', 'Comisiones $'], alinear: [0],
        filas: meses.map(m => [nombreMes(m.mes), num(m.comprasUsdt, 2), num(m.ventasUsdt, 2), num(m.pagosUsdt, 2), signoUsd(m.resultadoUsd), signoUsd(m.difBcvUsd), signoUsd(m.difP2pUsd), usd(m.comisionesUsd)]),
        totales: ['Total', num(cU, 2), num(vU, 2), num(pU, 2), signoUsd(resultadoUsd), signoUsd(difBcvUsd), signoUsd(difP2pUsd), usd(comUsd)] },
      { titulo: 'Detalle de ventas y pagos (resultado contra costo promedio)', columnas: ['Fecha', 'ID', 'Tipo', 'USDT', 'Tasa efectiva', 'Costo prom.', 'BCV', 'Resultado $', 'Resultado Bs'], alinear: [0, 1, 2],
        filas: salidas.map(o => { const s = sim[o.id] || {}; return [fechaCorta(o.fecha), o.id, o.tipo, num(o.usdtNeto, 2), num(o.tasaEfectiva, 4), num(s.costoPromedio || 0, 4), num(o.tasaBcv, 2), signoUsd(s.resultadoUsd || 0), signo(s.resultadoVes || 0, 2)]; }),
        totales: ['Total', '', '', num(vU + pU, 2), '', '', '', signoUsd(resultadoUsd), signo(resultado, 2)] },
    ],
    nota: 'Resultado realizado = (tasa efectiva de la venta o del pago − costo promedio ponderado de las compras) × USDT entregados; incluye el efecto de las comisiones. Un PAGO se valora a la tasa pactada con el beneficiario (valor de la factura en Bs). Los $ son bolívares convertidos a la tasa BCV del día de cada operación. Diferencial positivo = a favor.',
  };
}

export function reporteDiferenciales(todas, desde, hasta, cartera) {
  const sim = simularCartera(todas);
  const ops = enRango(todas, desde, hasta, cartera);
  const difBcv = sumar(ops, 'difBcvVes'), difP2p = sumar(ops, 'difP2pVes');
  const difBcvUsd = sumarUsd(ops, 'difBcvVes'), difP2pUsd = sumarUsd(ops, 'difP2pVes');
  const meses = porMes(ops, sim);
  return {
    tipo: 'diferenciales', titulo: 'Reporte de diferenciales', subtitulo: 'Período ' + textoRango(desde, hasta), cartera: cartera || 'AMBAS', desde, hasta,
    kpis: [
      { etq: 'Diferencial vs BCV', val: signoUsd(difBcvUsd), clase: cl(difBcvUsd), sub: signo(difBcv, 2) + ' Bs' },
      { etq: 'Diferencial vs P2P', val: signoUsd(difP2pUsd), clase: cl(difP2pUsd), sub: signo(difP2p, 2) + ' Bs' },
      { etq: 'Brecha promedio vs BCV', val: ops.length ? signo(ops.reduce((s, o) => s + o.difBcvPct, 0) / ops.length * 100, 2) + ' %' : '—' },
      { etq: 'Operaciones', val: String(ops.length) },
    ],
    secciones: [
      { titulo: 'Por mes (en $ al BCV)', columnas: ['Mes', 'Operaciones', 'Dif. BCV $', 'Dif. P2P $', 'Dif. BCV Bs', 'Dif. P2P Bs'], alinear: [0],
        filas: meses.map(m => [nombreMes(m.mes), String(m.n), signoUsd(m.difBcvUsd), signoUsd(m.difP2pUsd), signo(m.difBcv, 2), signo(m.difP2p, 2)]),
        totales: ['Total', String(ops.length), signoUsd(difBcvUsd), signoUsd(difP2pUsd), signo(difBcv, 2), signo(difP2p, 2)] },
      { titulo: 'Por operación (en $ al BCV del día)', columnas: ['Fecha', 'ID', 'Tipo', 'USDT', 'Tasa', 'BCV', 'P2P ref.', 'Dif. BCV $', 'Dif. BCV %', 'Dif. P2P $'], alinear: [0, 1, 2],
        filas: ops.map(o => [fechaCorta(o.fecha), o.id, o.tipo, num(o.montoUsdt, 2), num(o.tasa, 2), num(o.tasaBcv, 2), num(o.tasaP2p, 2), signoUsd(enUsd(o.difBcvVes, o.tasaBcv)), signo(o.difBcvPct * 100, 2), signoUsd(enUsd(o.difP2pVes, o.tasaBcv))]),
        totales: ['Total', '', '', num(sumar(ops, 'montoUsdt'), 2), '', '', '', signoUsd(difBcvUsd), '', signoUsd(difP2pUsd)] },
    ],
    nota: 'Compra: diferencial = (referencia − tasa pagada) × USDT. Venta: diferencial = (tasa cobrada − referencia) × USDT. Se muestra en $ convirtiendo los bolívares a la tasa BCV del día de cada operación. Positivo = a favor de la empresa.',
  };
}

export function reporteOperaciones(todas, desde, hasta, cartera, tipo) {
  const sim = simularCartera(todas);
  const ops = enRango(todas, desde, hasta, cartera).filter(o => o.tipo === tipo);
  const esCompra = tipo === 'COMPRA', esPago = tipo === 'PAGO';
  const u = sumar(ops, 'usdtNeto'), v = sumar(ops, 'vesNeto');
  const meses = porMes(ops, sim);
  return {
    tipo: esCompra ? 'compras' : esPago ? 'pagos' : 'ventas', titulo: esPago ? 'Reporte de pagos con USDT' : 'Reporte de ' + (esCompra ? 'compras' : 'ventas') + ' de USDT', subtitulo: 'Período ' + textoRango(desde, hasta), cartera: cartera || 'AMBAS', desde, hasta,
    kpis: [
      { etq: 'USDT ' + (esCompra ? 'comprados' : esPago ? 'pagados' : 'vendidos'), val: num(u, 2) },
      { etq: 'Equivalente $ al BCV', val: usd(sumar(ops, 'equivUsdBcv')), sub: (esCompra ? 'pagados: ' : esPago ? 'valor cancelado: ' : 'recibidos: ') + ves(v) },
      { etq: 'Tasa promedio', val: u ? num(v / u, 4) : '—' },
      { etq: 'Comisiones', val: usd(comisionesUsd(ops)), sub: num(sumar(ops, 'comisionUsdt'), 2) + ' USDT · ' + ves(sumar(ops, 'comisionVes')) },
      { etq: 'Diferencial vs P2P', val: signoUsd(sumarUsd(ops, 'difP2pVes')), clase: cl(sumarUsd(ops, 'difP2pVes')), sub: signo(sumar(ops, 'difP2pVes'), 2) + ' Bs' },
      { etq: 'Operaciones', val: String(ops.length) },
    ],
    secciones: [
      { titulo: 'Por mes', columnas: ['Mes', 'Operaciones', 'USDT', '$ al BCV', 'Bolívares', 'Tasa promedio'], alinear: [0],
        filas: meses.map(m => { const mu = esCompra ? m.comprasUsdt : esPago ? m.pagosUsdt : m.ventasUsdt, mv = esCompra ? m.comprasVes : esPago ? m.pagosVes : m.ventasVes; const mo = ops.filter(o => mesDe(o.fecha) === m.mes); return [nombreMes(m.mes), String(m.n), num(mu, 2), usd(sumar(mo, 'equivUsdBcv')), ves(mv), mu ? num(mv / mu, 4) : '—']; }),
        totales: ['Total', String(ops.length), num(u, 2), usd(sumar(ops, 'equivUsdBcv')), ves(v), u ? num(v / u, 4) : '—'] },
      { titulo: 'Detalle', columnas: ['Fecha', 'ID', 'USDT', 'Tasa', 'Total Bs', 'Com. USDT', 'Com. Bs', 'Neto Bs', '$ BCV', 'Dif. BCV $', 'Dif. P2P $', esPago ? 'Beneficiario' : 'Contraparte', 'Referencia', 'Observaciones'], alinear: [0, 1, 11, 12, 13],
        filas: ops.map(o => [fechaCorta(o.fecha), o.id, num(o.montoUsdt, 2), num(o.tasa, 2), num(o.totalVes, 2), num(o.comisionUsdt, 2), num(o.comisionVes, 2), num(o.vesNeto, 2), usd(o.equivUsdBcv), signoUsd(enUsd(o.difBcvVes, o.tasaBcv)), signoUsd(enUsd(o.difP2pVes, o.tasaBcv)), o.contraparte || '', o.referencia || '', o.observaciones || '']),
        totales: ['Total', '', num(sumar(ops, 'montoUsdt'), 2), '', num(sumar(ops, 'totalVes'), 2), num(sumar(ops, 'comisionUsdt'), 2), num(sumar(ops, 'comisionVes'), 2), num(v, 2), usd(sumar(ops, 'equivUsdBcv')), signoUsd(sumarUsd(ops, 'difBcvVes')), signoUsd(sumarUsd(ops, 'difP2pVes')), '', '', ''] },
    ],
    nota: (esCompra ? 'Neto Bs = total pagado incluyendo comisiones en bolívares. ' : esPago ? 'Neto Bs = valor de la factura cancelada con USDT a la tasa pactada. Dif. BCV positivo = la factura valía más $ al BCV que los USDT entregados. ' : 'Neto Bs = total recibido después de comisiones en bolívares. ') + '$ BCV = neto en bolívares convertido a la tasa BCV del día de la operación.',
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
