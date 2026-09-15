/**
 * Operaciones (pestaña BD_USDT)
 * -----------------------------
 * Cada compra o venta es una fila. NUNCA se borran filas: anular cambia el ESTADO a "ANULADA"
 * y deja el motivo, para que la pista de auditoría sea completa.
 *
 * Convención de diferenciales: signo POSITIVO = a favor del usuario, NEGATIVO = en contra.
 *   COMPRA: dif vs BCV = (tasaBCV - tasa) * USDT   (comprar por encima del BCV es "en contra")
 *           dif vs P2P = (tasaP2P - tasa) * USDT   (comprar más barato que el mercado es "a favor")
 *   VENTA : dif vs BCV = (tasa - tasaBCV) * USDT   (vender por encima del BCV es "a favor")
 *           dif vs P2P = (tasa - tasaP2P) * USDT
 */

/** Calcula todos los campos derivados de una operación. Se usa igual en el backend y (copiado) en la app. */
function calcularOperacion_(d) {
  const monto = d.montoUsdt, tasa = d.tasa;
  const totalVes = monto * tasa;
  const esCompra = d.tipo === 'COMPRA';
  // Comisiones: en una compra la comisión USDT reduce lo recibido y la comisión VES aumenta lo pagado.
  //             en una venta la comisión USDT aumenta lo entregado y la comisión VES reduce lo recibido.
  const usdtNeto = esCompra ? monto - d.comisionUsdt : monto + d.comisionUsdt;
  const vesNeto = esCompra ? totalVes + d.comisionVes : totalVes - d.comisionVes;
  const tasaEfectiva = usdtNeto > 0 ? vesNeto / usdtNeto : 0;
  const signo = esCompra ? -1 : 1;
  const difBcvVes = d.tasaBcv > 0 ? signo * (tasa - d.tasaBcv) * monto : 0;
  const difBcvPct = d.tasaBcv > 0 ? signo * (tasa / d.tasaBcv - 1) : 0;
  const difP2pVes = d.tasaP2p > 0 ? signo * (tasa - d.tasaP2p) * monto : 0;
  const equivUsdBcv = d.tasaBcv > 0 ? vesNeto / d.tasaBcv : 0;
  return {
    totalVes: redondear_(totalVes, 2), usdtNeto: redondear_(usdtNeto, 4), vesNeto: redondear_(vesNeto, 2),
    tasaEfectiva: redondear_(tasaEfectiva, 4), difBcvVes: redondear_(difBcvVes, 2), difBcvPct: redondear_(difBcvPct, 6),
    difP2pVes: redondear_(difP2pVes, 2), equivUsdBcv: redondear_(equivUsdBcv, 2),
  };
}

function validarOperacion_(datos, sesion) {
  const d = datos || {};
  const tipo = texto_(d.tipo, 10).toUpperCase();
  if (CONFIG.TIPOS.indexOf(tipo) === -1) throw new ErrorApi('dato_invalido', 'Tipo inválido (COMPRA o VENTA).');
  const cartera = texto_(d.cartera, 30).toUpperCase();
  if (CONFIG.CARTERAS.indexOf(cartera) === -1) throw new ErrorApi('dato_invalido', 'Cartera inválida.');
  let fecha = texto_(d.fecha, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) fecha = formatoFecha_(ahora_());
  let hora = texto_(d.hora, 5);
  if (!/^\d{2}:\d{2}$/.test(hora)) hora = formatoHora_(ahora_());
  const op = {
    fecha: fecha, hora: hora, cartera: cartera, tipo: tipo,
    montoUsdt: numero_(d.montoUsdt, 'monto USDT', { min: 0.000001, max: 1e9 }),
    tasa: numero_(d.tasa, 'tasa', { min: 0.000001, max: 1e9 }),
    comisionUsdt: numero_(d.comisionUsdt, 'comisión USDT', { opcional: true, min: 0, max: 1e9 }),
    comisionVes: numero_(d.comisionVes, 'comisión VES', { opcional: true, min: 0, max: 1e12 }),
    tasaBcv: numero_(d.tasaBcv, 'tasa BCV', { opcional: true, min: 0, max: 1e9 }),
    tasaP2p: numero_(d.tasaP2p, 'tasa P2P', { opcional: true, min: 0, max: 1e9 }),
    contraparte: texto_(d.contraparte, 80),
    metodoPago: texto_(d.metodoPago, 60),
    referencia: texto_(d.referencia, 60),
    observaciones: texto_(d.observaciones, 1000),
    dispositivo: texto_(sesion.d, 60),
  };
  Object.assign(op, calcularOperacion_(op));
  return op;
}

function filaDesdeOperacion_(op) {
  return COLUMNAS.map(c => {
    if (c === 'fecha') return new Date(op.fecha + 'T00:00:00');
    if (c === 'registrado') return op.registrado;
    return op[c] === undefined ? '' : op[c];
  });
}

function operacionDesdeFila_(f) {
  const o = {};
  COLUMNAS.forEach((c, i) => {
    let v = f[i];
    if (v instanceof Date) {
      if (c === 'fecha') v = formatoFecha_(v);
      else if (c === 'hora') v = formatoHora_(v);
      else v = v.toISOString();
    }
    o[c] = v;
  });
  ['montoUsdt', 'tasa', 'totalVes', 'comisionUsdt', 'comisionVes', 'usdtNeto', 'vesNeto', 'tasaEfectiva', 'tasaBcv', 'tasaP2p', 'difBcvVes', 'difBcvPct', 'difP2pVes', 'equivUsdBcv']
    .forEach(c => { o[c] = Number(o[c]) || 0; });
  return o;
}

/**
 * Siguiente ID: contador en propiedades del script (ULTIMO_ID) reconciliado con la última fila, para que
 * un ID nunca se reutilice aunque se borre la última operación.
 */
function siguienteId_(hoja) {
  const props = props_();
  let n = parseInt(props.getProperty('ULTIMO_ID') || '0', 10) || 0;
  const ultima = hoja.getLastRow();
  if (ultima >= 2) {
    const ultimoId = String(hoja.getRange(ultima, 1).getValue());
    const m = parseInt((ultimoId.match(/(\d+)$/) || [0, 0])[1], 10) || 0;
    if (m > n) n = m;
  }
  n += 1;
  props.setProperty('ULTIMO_ID', String(n));
  return 'OP-' + ('000000' + n).slice(-6);
}

/** Acción "registrar": agrega una fila. Protegido con bloqueo para que dos dispositivos no choquen. */
function registrarOperacion_(datos, sesion) {
  const op = validarOperacion_(datos, sesion);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const hoja = hoja_(CONFIG.HOJA_BD);
    op.id = siguienteId_(hoja);
    op.estado = 'ACTIVA';
    op.registrado = ahora_();
    op.motivoAnulacion = '';
    hoja.appendRow(filaDesdeOperacion_(op));
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  op.registrado = op.registrado.toISOString();
  return op;
}

/** Acción "anular": marca ESTADO = ANULADA (no borra). */
function anularOperacion_(datos, sesion) {
  const id = texto_((datos || {}).id, 20);
  const motivo = texto_((datos || {}).motivo, 200) || 'Sin motivo';
  if (!id) throw new ErrorApi('dato_invalido', 'Falta el ID.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const hoja = hoja_(CONFIG.HOJA_BD);
    const ids = hoja.getRange(2, 1, Math.max(hoja.getLastRow() - 1, 1), 1).getValues().map(r => String(r[0]));
    const idx = ids.indexOf(id);
    if (idx === -1) throw new ErrorApi('no_existe', 'No existe la operación ' + id, 404);
    const fila = idx + 2;
    const colEstado = COLUMNAS.indexOf('estado') + 1;
    if (String(hoja.getRange(fila, colEstado).getValue()) === 'ANULADA') throw new ErrorApi('ya_anulada', 'La operación ya estaba anulada.');
    hoja.getRange(fila, colEstado).setValue('ANULADA');
    hoja.getRange(fila, COLUMNAS.indexOf('motivoAnulacion') + 1).setValue(motivo + ' [' + texto_(sesion.d, 60) + ' ' + Utilities.formatDate(ahora_(), CONFIG_TZ_(), 'dd/MM/yyyy HH:mm') + ']');
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { id: id, estado: 'ANULADA' };
}

/** Acción "borrar": elimina la fila definitivamente (a diferencia de anular). La app pide escribir BORRAR. */
function borrarOperacion_(datos, sesion) {
  const id = texto_((datos || {}).id, 20);
  if (!id) throw new ErrorApi('dato_invalido', 'Falta el ID.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const hoja = hoja_(CONFIG.HOJA_BD);
    const ids = hoja.getRange(2, 1, Math.max(hoja.getLastRow() - 1, 1), 1).getValues().map(r => String(r[0]));
    const idx = ids.indexOf(id);
    if (idx === -1) throw new ErrorApi('no_existe', 'No existe la operación ' + id, 404);
    const fila = idx + 2;
    const op = operacionDesdeFila_(hoja.getRange(fila, 1, 1, COLUMNAS.length).getValues()[0]);
    hoja.deleteRow(fila);
    SpreadsheetApp.flush();
    // Queda rastro en el registro de ejecuciones de Apps Script por si hay que reconstruirla
    console.log('BORRADA ' + id + ' por ' + texto_(sesion.d, 60) + ': ' + JSON.stringify(op));
  } finally {
    lock.releaseLock();
  }
  return { id: id, borrada: true };
}

/** Acción "editar": permite corregir solo observaciones, contraparte, método de pago y referencia (datos no financieros). */
function editarOperacion_(datos, sesion) {
  const id = texto_((datos || {}).id, 20);
  if (!id) throw new ErrorApi('dato_invalido', 'Falta el ID.');
  const hoja = hoja_(CONFIG.HOJA_BD);
  const ids = hoja.getRange(2, 1, Math.max(hoja.getLastRow() - 1, 1), 1).getValues().map(r => String(r[0]));
  const idx = ids.indexOf(id);
  if (idx === -1) throw new ErrorApi('no_existe', 'No existe la operación ' + id, 404);
  const fila = idx + 2;
  const permitidos = { contraparte: 80, metodoPago: 60, referencia: 60, observaciones: 1000 };
  let cambios = 0;
  Object.keys(permitidos).forEach(c => {
    if (datos[c] !== undefined) { hoja.getRange(fila, COLUMNAS.indexOf(c) + 1).setValue(texto_(datos[c], permitidos[c])); cambios++; }
  });
  SpreadsheetApp.flush();
  return { id: id, cambios: cambios };
}

function todasLasOperaciones_() {
  const hoja = hoja_(CONFIG.HOJA_BD);
  const n = hoja.getLastRow() - 1;
  if (n < 1) return [];
  return hoja.getRange(2, 1, n, COLUMNAS.length).getValues().filter(f => f[0] !== '').map(operacionDesdeFila_);
}

/** Acción "listar": operaciones más recientes primero. */
function listarOperaciones_(datos) {
  const d = datos || {};
  const limite = Math.min(Math.max(parseInt(d.limite, 10) || 300, 1), 5000);
  const cartera = texto_(d.cartera, 30).toUpperCase();
  const incluirAnuladas = d.incluirAnuladas !== false;
  let ops = todasLasOperaciones_();
  if (cartera) ops = ops.filter(o => o.cartera === cartera);
  if (!incluirAnuladas) ops = ops.filter(o => o.estado === 'ACTIVA');
  ops.sort((a, b) => (b.fecha + b.hora + b.id).localeCompare(a.fecha + a.hora + a.id));
  return { total: ops.length, operaciones: ops.slice(0, limite) };
}

/**
 * Acción "resumen": estado de la cartera por empresa.
 *  - Saldo USDT = compras netas - ventas (USDT neto entregado).
 *  - Costo promedio ponderado (VES/USDT) de las compras; cada venta "sale" al costo promedio vigente,
 *    y su resultado realizado = (tasa efectiva de venta - costo promedio) * USDT vendidos.
 */
function resumenCartera_() {
  const ops = todasLasOperaciones_().filter(o => o.estado === 'ACTIVA');
  ops.sort((a, b) => (a.fecha + a.hora + a.id).localeCompare(b.fecha + b.hora + b.id));
  const res = {};
  CONFIG.CARTERAS.forEach(c => {
    res[c] = { cartera: c, saldoUsdt: 0, costoPromedio: 0, costoTotalVes: 0, comprasUsdt: 0, comprasVes: 0, ventasUsdt: 0, ventasVes: 0,
               comisionesUsdt: 0, comisionesVes: 0, difBcvVes: 0, difP2pVes: 0, resultadoRealizadoVes: 0, equivUsdBcvCompras: 0, equivUsdBcvVentas: 0,
               difBcvUsd: 0, difP2pUsd: 0, resultadoRealizadoUsd: 0, comisionesUsd: 0,
               operaciones: 0, ultimaFecha: '' };
  });
  ops.forEach(o => {
    const r = res[o.cartera]; if (!r) return;
    r.operaciones++; r.ultimaFecha = o.fecha;
    const bcv = o.tasaBcv > 0 ? o.tasaBcv : 0;
    r.comisionesUsdt += o.comisionUsdt; r.comisionesVes += o.comisionVes;
    r.difBcvVes += o.difBcvVes; r.difP2pVes += o.difP2pVes;
    r.comisionesUsd += o.comisionUsdt + (bcv ? o.comisionVes / bcv : 0);
    if (bcv) { r.difBcvUsd += o.difBcvVes / bcv; r.difP2pUsd += o.difP2pVes / bcv; }
    if (o.tipo === 'COMPRA') {
      r.comprasUsdt += o.usdtNeto; r.comprasVes += o.vesNeto; r.equivUsdBcvCompras += o.equivUsdBcv;
      r.costoTotalVes += o.vesNeto; r.saldoUsdt += o.usdtNeto;
      r.costoPromedio = r.saldoUsdt > 0 ? r.costoTotalVes / r.saldoUsdt : 0;
    } else {
      r.ventasUsdt += o.usdtNeto; r.ventasVes += o.vesNeto; r.equivUsdBcvVentas += o.equivUsdBcv;
      if (r.costoPromedio > 0) { const res = (o.tasaEfectiva - r.costoPromedio) * o.usdtNeto; r.resultadoRealizadoVes += res; if (bcv) r.resultadoRealizadoUsd += res / bcv; }
      r.saldoUsdt -= o.usdtNeto;
      r.costoTotalVes = Math.max(r.saldoUsdt, 0) * r.costoPromedio;
      if (r.saldoUsdt <= 0) { r.costoTotalVes = 0; }
    }
  });
  Object.keys(res).forEach(c => {
    const r = res[c];
    ['saldoUsdt', 'costoPromedio', 'costoTotalVes', 'comprasUsdt', 'comprasVes', 'ventasUsdt', 'ventasVes', 'comisionesUsdt', 'comisionesVes',
     'difBcvVes', 'difP2pVes', 'resultadoRealizadoVes', 'equivUsdBcvCompras', 'equivUsdBcvVentas', 'difBcvUsd', 'difP2pUsd', 'resultadoRealizadoUsd', 'comisionesUsd'].forEach(k => { r[k] = redondear_(r[k], 4); });
  });
  return { carteras: res, totalOperaciones: ops.length, generado: ahora_().toISOString() };
}
