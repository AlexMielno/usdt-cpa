/**
 * Cálculos de una operación. ES LA MISMA FÓRMULA que usa el backend (Operaciones.js);
 * aquí sirve para la vista previa en vivo mientras el usuario escribe.
 *
 * Convención: diferencial POSITIVO = a favor del usuario, NEGATIVO = en contra.
 */
export function redondear(n, dec = 2) {
  const f = Math.pow(10, dec);
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function calcularOperacion(d) {
  const monto = Number(d.montoUsdt) || 0, tasa = Number(d.tasa) || 0;
  const comisionUsdt = Number(d.comisionUsdt) || 0, comisionVes = Number(d.comisionVes) || 0;
  const tasaBcv = Number(d.tasaBcv) || 0, tasaP2p = Number(d.tasaP2p) || 0;
  const totalVes = monto * tasa;
  const esCompra = d.tipo === 'COMPRA';
  const usdtNeto = esCompra ? monto - comisionUsdt : monto + comisionUsdt;
  const vesNeto = esCompra ? totalVes + comisionVes : totalVes - comisionVes;
  const tasaEfectiva = usdtNeto > 0 ? vesNeto / usdtNeto : 0;
  const signo = esCompra ? -1 : 1;
  return {
    totalVes: redondear(totalVes, 2),
    usdtNeto: redondear(usdtNeto, 4),
    vesNeto: redondear(vesNeto, 2),
    tasaEfectiva: redondear(tasaEfectiva, 4),
    difBcvVes: tasaBcv > 0 ? redondear(signo * (tasa - tasaBcv) * monto, 2) : 0,
    difBcvPct: tasaBcv > 0 ? redondear(signo * (tasa / tasaBcv - 1), 6) : 0,
    difP2pVes: tasaP2p > 0 ? redondear(signo * (tasa - tasaP2p) * monto, 2) : 0,
    equivUsdBcv: tasaBcv > 0 ? redondear(vesNeto / tasaBcv, 2) : 0,
  };
}

/**
 * Tasa P2P sugerida para una operación concreta.
 * Toma los anuncios del lado correcto (compra -> vendedores, venta -> compradores), se queda con los
 * anunciantes serios (>= 50 órdenes/mes, >= 95 % finalización) cuyos límites admiten el monto en VES,
 * y promedia los 5 mejores precios. Si no hay suficientes, cae al promedio general del backend.
 */
export function sugerirTasa(tasas, tipo, montoUsdt) {
  if (!tasas || !tasas.p2p) return { valor: 0, motivo: 'Sin datos P2P' };
  const lado = tipo === 'COMPRA' ? tasas.p2p.compra : tasas.p2p.venta;
  if (!lado) return { valor: 0, motivo: 'Sin datos P2P' };
  const anuncios = lado.anuncios || [];
  const monto = Number(montoUsdt) || 0;
  const serios = anuncios.filter(a => a.ordenesMes >= 50 && a.finalizacion >= 0.95);
  let compatibles = serios;
  if (monto > 0) {
    compatibles = serios.filter(a => {
      const totalVes = monto * a.precio;
      return totalVes >= (a.minVes || 0) && totalVes <= (a.maxVes || Infinity) && (a.disponible || 0) >= monto;
    });
  }
  if (compatibles.length >= 3) {
    const top = compatibles.slice(0, 5).map(a => a.precio);
    return { valor: redondear(top.reduce((s, p) => s + p, 0) / top.length, 4), motivo: 'Promedio de ' + top.length + ' anuncios compatibles con el monto', anuncios: compatibles.slice(0, 5) };
  }
  if (lado.promedio5) return { valor: lado.promedio5, motivo: lado.respaldo ? 'Última captura guardada (Binance no respondió)' : 'Promedio de los 5 mejores anuncios', anuncios: anuncios.slice(0, 5) };
  return { valor: lado.mejor || 0, motivo: 'Mejor precio publicado', anuncios: anuncios.slice(0, 5) };
}

/** Resumen de cartera calculado localmente a partir de la lista de operaciones (mismo criterio que el backend). */
export function resumirCartera(operaciones, cartera) {
  const ops = operaciones.filter(o => o.estado === 'ACTIVA' && (!cartera || o.cartera === cartera))
    .sort((a, b) => (a.fecha + a.hora + a.id).localeCompare(b.fecha + b.hora + b.id));
  const r = { saldoUsdt: 0, costoPromedio: 0, costoTotalVes: 0, comprasUsdt: 0, comprasVes: 0, ventasUsdt: 0, ventasVes: 0,
              comisionesUsdt: 0, comisionesVes: 0, difBcvVes: 0, difP2pVes: 0, resultadoRealizadoVes: 0, equivUsdBcvCompras: 0, equivUsdBcvVentas: 0,
              // en dólares al BCV del día de cada operación (lo que se reporta a la gerencia)
              difBcvUsd: 0, difP2pUsd: 0, resultadoRealizadoUsd: 0, comisionesUsd: 0, operaciones: ops.length };
  ops.forEach(o => {
    const bcv = Number(o.tasaBcv) > 0 ? Number(o.tasaBcv) : 0;
    r.comisionesUsdt += o.comisionUsdt; r.comisionesVes += o.comisionVes;
    r.difBcvVes += o.difBcvVes; r.difP2pVes += o.difP2pVes;
    if (bcv) { r.difBcvUsd += o.difBcvVes / bcv; r.difP2pUsd += o.difP2pVes / bcv; r.comisionesUsd += o.comisionUsdt + o.comisionVes / bcv; } else { r.comisionesUsd += o.comisionUsdt; }
    if (o.tipo === 'COMPRA') {
      r.comprasUsdt += o.usdtNeto; r.comprasVes += o.vesNeto; r.equivUsdBcvCompras += o.equivUsdBcv;
      r.costoTotalVes += o.vesNeto; r.saldoUsdt += o.usdtNeto;
      r.costoPromedio = r.saldoUsdt > 0 ? r.costoTotalVes / r.saldoUsdt : 0;
    } else {
      r.ventasUsdt += o.usdtNeto; r.ventasVes += o.vesNeto; r.equivUsdBcvVentas += o.equivUsdBcv;
      if (r.costoPromedio > 0) { const res = (o.tasaEfectiva - r.costoPromedio) * o.usdtNeto; r.resultadoRealizadoVes += res; if (bcv) r.resultadoRealizadoUsd += res / bcv; }
      r.saldoUsdt -= o.usdtNeto;
      r.costoTotalVes = r.saldoUsdt > 0 ? r.saldoUsdt * r.costoPromedio : 0;
    }
  });
  Object.keys(r).forEach(k => { if (k !== 'operaciones') r[k] = redondear(r[k], 4); });
  return r;
}
