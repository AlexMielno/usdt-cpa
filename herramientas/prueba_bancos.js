/**
 * Prueba del backend "Diferencial desde bancos" (backend/Bancos.js) contra el simulador local.
 *
 * Uso:  node herramientas/simulador_backend.js [puerto]        (en otra terminal; por defecto 8787)
 *       node herramientas/prueba_bancos.js [puerto | url]       (por defecto http://localhost:8787/)
 *
 *  1. Pruebas unitarias de los parseadores (fechaDesdeCelda_, numeroCelda_, nroNormalizado_, claseMovimientoBanco_):
 *     carga backend/Config.js y backend/Bancos.js en un vm. La muestra real no trae fechas de texto en BINANCE
 *     ("15/08", "30-05-26"…), así que esos formatos se prueban aquí.
 *  2. sesion -> bancos sin rango y con rango 2026-01-01..2026-01-31: conteos por hoja/clase, ejemplos, avisos y
 *     comprobaciones contra la muestra herramientas/fixtures/bancos_muestra.json.
 *  3. bancosGuardar (2 decisiones) -> bancosDecisiones -> upsert -> validación -> borrar -> limpieza.
 * Sale con código 1 si algo falla. Sin dependencias (Node 18+ por fetch).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const arg = process.argv[2] || '';
const URL_API = /^https?:\/\//.test(arg) ? arg : 'http://localhost:' + (parseInt(arg, 10) || 8787) + '/';
const CLAVE = 'CLAVE-DE-PRUEBA-LOCAL-1234';
const DISPOSITIVO = 'prueba-bancos';
const FIXTURE = path.join(__dirname, 'fixtures', 'bancos_muestra.json');

let fallos = 0;
function comprobar(cond, msg) {
  if (cond) console.log('  OK     ' + msg);
  else { fallos++; console.log('  FALLA  ' + msg); }
}
const titulo = t => console.log('\n=== ' + t + ' ===');
const cerca = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol);

async function llamar(accion, extra) {
  const r = await fetch(URL_API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(Object.assign({ accion: accion }, extra || {})) });
  return r.json();
}

// ---------------------------------------------------------------------------------------- 1. unitarias
function pruebasUnitarias() {
  titulo('1. Parseadores (vm con backend/Config.js + backend/Bancos.js)');
  const formatDate = (d, tz, patron) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
    return patron.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day);
  };
  const ctx = vm.createContext({ Date, Session: { getScriptTimeZone: () => 'America/Caracas' }, Utilities: { formatDate }, console });
  ['Config.js', 'Bancos.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'backend', f), 'utf8'), ctx, { filename: f }));
  const F = (v, anio, o) => ctx.fechaDesdeCelda_(v, anio, o);
  const casos = [
    ['"15/08" YEAR 2026 (número)', F('15/08', 2026), '2026-08-15', /sin año, se asumió 2026 por la columna YEAR/],
    ['"15/08" YEAR "2026" (texto)', F('15/08', '2026'), '2026-08-15', /columna YEAR/],
    ['"15/08" sin YEAR, fila anterior 2025', F('15/08', '', { anioRespaldo: '2025' }), '2025-08-15', /por la fila anterior/],
    ['"15/08" sin YEAR ni fila anterior', F('15/08', ''), '', /sin año/],
    ['"30-05-26"', F('30-05-26', 2026), '2026-05-30', null],
    ['"01/10/25"', F('01/10/25', 2025), '2025-10-01', null],
    ['"3/1/2026"', F('3/1/2026', 2026), '2026-01-03', null],
    ['"30-05-2026"', F('30-05-2026'), '2026-05-30', null],
    ['" 3/1/2026 " con espacios', F(' 3/1/2026 '), '2026-01-03', null],
    ['serial 46025', F(46025), '2026-01-03', null],
    ['serial 45941', F(45941), '2025-10-11', null],
    ['Date medianoche Caracas 3/1/2026', F(new Date('2026-01-03T04:00:00Z'), '', { zona: 'America/Caracas', cache: {} }), '2026-01-03', null],
    ['"31/02/2026" (no existe)', F('31/02/2026'), '', /no válida/],
    ['"hola"', F('hola'), '', /no reconocida/],
    ['celda vacía', F(''), '', /sin fecha/],
  ];
  casos.forEach(([nombre, r, fecha, aviso]) => {
    const okAviso = aviso ? aviso.test(r.aviso) : r.aviso === '';
    comprobar(r.fecha === fecha && okAviso, 'fecha ' + nombre + ' -> ' + JSON.stringify(r));
  });
  const N = v => ctx.numeroCelda_(v);
  [['$6.264,34', 6264.34], ['  1.000,00 ', 1000], ['  -   ', 0], ['', 0], ['50.610,03', 50610.03], ['6872,7', 6872.7],
   ['1.000', 1000], ['-1.234,5', -1234.5], ['(1.000,00)', -1000], ['1,234.56', 1234.56], ['#N/A', 0], [2591.55, 2591.55], [null, 0]]
    .forEach(([v, esperado]) => comprobar(cerca(N(v), esperado), 'numero ' + JSON.stringify(v) + ' -> ' + N(v)));
  comprobar(ctx.nroNormalizado_(47900093210) === '47900093210', 'nroNormalizado_ número 47900093210');
  comprobar(ctx.nroNormalizado_(' 4790 0093 ') === '47900093', 'nroNormalizado_ quita espacios');
  comprobar(ctx.nroNormalizado_('0') === '' && ctx.nroNormalizado_('-') === '', 'nroNormalizado_ "0" y "-" = vacío');
  const C = (p, d, c) => ctx.claseMovimientoBanco_(p, d || '', c || '');
  comprobar(C('BINANCE') === 'BINANCE' && C('EFECTIVO DOLARES') === 'EFECTIVO' && C('Efectivo $') === 'EFECTIVO' &&
    C('DIFERENCIAL CAMBIARIO') === 'DIFERENCIAL' && C('GASTOS', 'compra usdt para aire') === 'OTRO' && C('EFECTIVO BOLIVARES') === '' &&
    C('SUELDOS Y SALARIOS', 'NOMINA') === '', 'claseMovimientoBanco_ (BINANCE, EFECTIVO, DIFERENCIAL, OTRO, nada)');
}

// ---------------------------------------------------------------------------------------- muestra cruda
// Lectura independiente de la muestra para comparar conteos (no usa el código del backend)
function esperadoDeMuestra() {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const num = v => (typeof v === 'number' ? v : (typeof v === 'string' && /\d/.test(v) ? parseFloat(v.replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0 : 0));
  const filasActivo = h => fx.hojas[h].slice(1).filter(f => num(f[7]) > 0 || num(f[8]) > 0).length;
  const difPorHoja = {};
  Object.keys(fx.hojas).forEach(h => {
    if (h === 'BINANCE' || h === 'TASA') return;
    difPorHoja[h] = fx.hojas[h].slice(1).filter(f => {
      const p = String(f[5]).toUpperCase();
      return p.includes('DIFERENCIAL') && !p.includes('BINANCE') && !/EFECTIVO ?(DOLAR|\$)/.test(p) && (num(f[7]) || num(f[8]) || num(f[13]) || num(f[14]));
    }).length;
  });
  // resumenPartidas de enero 2026 (serial 46023 = 2026-01-01 .. 46053 = 2026-01-31)
  const materiaEnero = { n: 0, bs: 0 }, cobranzasEnero = { n: 0, bs: 0 };
  Object.keys(fx.hojas).forEach(h => {
    if (h === 'BINANCE' || h === 'TASA') return;
    fx.hojas[h].slice(1).forEach(f => {
      if (!(typeof f[0] === 'number' && f[0] >= 46023 && f[0] <= 46053)) return;
      const p = String(f[5]).toUpperCase();
      if (/MATERIA PRIMA|COMPRAS|INVENTARIO/.test(p) && num(f[8]) > 0) { materiaEnero.n++; materiaEnero.bs += num(f[8]); }
      if (/CUENTAS POR COBRAR COMERCIALES|VENTAS|ANTICIPO (DE )?CLIENTES/.test(p) && num(f[7]) > 0) { cobranzasEnero.n++; cobranzasEnero.bs += num(f[7]); }
    });
  });
  return {
    materiaEnero: materiaEnero,
    cobranzasEnero: cobranzasEnero,
    usdt: filasActivo('BINANCE'),
    efectivo: filasActivo('Efectivo $'),
    tasas: new Set(fx.hojas.TASA.slice(1).filter(f => num(f[1]) > 0).map(f => f[0])).size,
    difPorHoja: difPorHoja,
  };
}

function conteoPorHojaYClase(movs) {
  const t = {};
  movs.forEach(m => { t[m.banco] = t[m.banco] || {}; t[m.banco][m.clase] = (t[m.banco][m.clase] || 0) + 1; });
  const clases = ['BINANCE', 'EFECTIVO', 'DIFERENCIAL', 'OTRO', 'VECINA'];
  console.log('  ' + 'Hoja'.padEnd(14) + clases.map(c => c.padStart(12)).join(''));
  Object.keys(t).forEach(h => console.log('  ' + h.padEnd(14) + clases.map(c => String(t[h][c] || 0).padStart(12)).join('')));
}

const corto = m => JSON.stringify(m);

// ---------------------------------------------------------------------------------------- 2 y 3. extremo a extremo
async function main() {
  pruebasUnitarias();
  const esperado = esperadoDeMuestra();

  titulo('2. Sesión contra ' + URL_API);
  let r;
  try {
    r = await llamar('sesion', { claveEnlace: CLAVE, dispositivo: DISPOSITIVO });
  } catch (e) {
    console.log('  No se pudo conectar con el simulador (' + e.message + '). ¿Está corriendo "node herramientas/simulador_backend.js"?');
    process.exit(1);
  }
  comprobar(r.ok && r.datos && r.datos.token, 'sesión emitida');
  if (!r.ok) { console.log(r); process.exit(1); }
  const token = r.datos.token;

  // ---- bancos sin rango
  titulo('2a. bancos SIN rango');
  let t0 = Date.now();
  r = await llamar('bancos', { token: token, datos: { desde: '', hasta: '' } });
  comprobar(r.ok, 'respuesta ok (' + (Date.now() - t0) + ' ms)' + (r.ok ? '' : ': ' + r.error + ' ' + r.mensaje));
  if (!r.ok) process.exit(1);
  let b = r.datos;
  console.log('  libro:', JSON.stringify(b.libro));
  console.log('  hojaUsdt:', b.hojaUsdt, '| hojasActivo:', JSON.stringify(b.hojasActivo), '| bancos:', JSON.stringify(b.bancos));
  console.log('  activos:', JSON.stringify(Object.fromEntries(Object.keys(b.activos).map(h => [h, b.activos[h].length]))),
    '| movimientos:', b.movimientos.length, '| tasas:', Object.keys(b.tasas).length, '| avisos:', b.avisos.length);
  conteoPorHojaYClase(b.movimientos);
  console.log('  3 ejemplos de usdt:'); b.usdt.slice(0, 3).forEach(u => console.log('    ' + corto(u)));
  console.log('  3 ejemplos de movimientos:'); b.movimientos.slice(0, 3).forEach(m => console.log('    ' + corto(m)));
  console.log('  avisos:'); (b.avisos.length ? b.avisos.slice(0, 20) : ['(ninguno)']).forEach(a => console.log('    ' + a));

  comprobar(b.libro.titulo === 'ADM.-002 BANCOS CPA' && /^\d{4}-\d{2}-\d{2}T/.test(b.libro.leido), 'libro: título y hora de lectura');
  comprobar(b.hojaUsdt === 'BINANCE', 'hojaUsdt = BINANCE');
  comprobar(JSON.stringify(b.hojasActivo) === JSON.stringify(['BINANCE', 'Efectivo $']), 'hojasActivo = [BINANCE, Efectivo $]');
  comprobar(JSON.stringify(b.bancos) === JSON.stringify(['MERCANTIL', 'BANESCO', 'BNC', 'VENEZUELA', 'BPLUS', 'BBVA', 'Efectivo BsS', 'Efectivo $', 'CRUCE']),
    'bancos detectados por cabecera, en el orden del libro (sin BINANCE ni TASA)');
  comprobar(JSON.stringify(b.usdt) === JSON.stringify(b.activos.BINANCE), 'usdt === activos.BINANCE');
  comprobar(b.usdt.length === esperado.usdt, 'usdt: ' + b.usdt.length + ' filas con entrada o salida (muestra: ' + esperado.usdt + ')');
  comprobar(b.activos['Efectivo $'].length === esperado.efectivo && esperado.efectivo > 0, "activos['Efectivo $']: " + b.activos['Efectivo $'].length + ' filas (muestra: ' + esperado.efectivo + ')');
  comprobar(Object.keys(b.tasas).length === esperado.tasas, 'tasas: ' + Object.keys(b.tasas).length + ' días (muestra: ' + esperado.tasas + ')');
  const refs = new Set(b.movimientos.map(m => m.ref));
  comprobar(refs.size === b.movimientos.length, 'cada línea de banco se envía una sola vez');
  comprobar(b.movimientos.every(m => ['BINANCE', 'EFECTIVO', 'DIFERENCIAL', 'OTRO', 'VECINA'].includes(m.clase) && typeof m.nroNorm === 'string'), 'clases válidas y nroNorm presente');
  const difs = {};
  b.movimientos.filter(m => m.clase === 'DIFERENCIAL').forEach(m => { difs[m.banco] = (difs[m.banco] || 0) + 1; });
  comprobar(Object.keys(esperado.difPorHoja).every(h => (difs[h] || 0) === esperado.difPorHoja[h]),
    'TODAS las líneas DIFERENCIAL de cada banco vienen: ' + JSON.stringify(difs));
  const sinFecha = b.usdt.filter(u => !u.fecha).length + b.movimientos.filter(m => !m.fecha).length;
  comprobar(sinFecha === 0 || b.avisos.length > 0, 'filas sin fecha legible: ' + sinFecha + ' (con aviso si hay)');

  // ---- bancos enero 2026
  titulo('2b. bancos 2026-01-01 .. 2026-01-31');
  t0 = Date.now();
  r = await llamar('bancos', { token: token, datos: { desde: '2026-01-01', hasta: '2026-01-31' } });
  comprobar(r.ok, 'respuesta ok (' + (Date.now() - t0) + ' ms)' + (r.ok ? '' : ': ' + r.error + ' ' + r.mensaje));
  if (!r.ok) process.exit(1);
  b = r.datos;
  console.log('  activos:', JSON.stringify(Object.fromEntries(Object.keys(b.activos).map(h => [h, b.activos[h].length]))),
    '| movimientos:', b.movimientos.length, '| tasas:', Object.keys(b.tasas).length, '| avisos:', b.avisos.length);
  conteoPorHojaYClase(b.movimientos);
  console.log('  3 ejemplos de usdt:'); b.usdt.slice(0, 3).forEach(u => console.log('    ' + corto(u)));
  const compra = b.movimientos.find(m => m.banco === 'MERCANTIL' && m.nro === '47900093210' && m.clase === 'BINANCE');
  const difCompra = b.movimientos.find(m => m.banco === 'MERCANTIL' && m.nroNorm === '47900093210' && m.clase === 'DIFERENCIAL');
  const efectivo = b.movimientos.find(m => m.clase === 'EFECTIVO' && m.fecha >= '2026-01-01' && m.fecha <= '2026-01-31');
  const vecina = b.movimientos.find(m => m.clase === 'VECINA' && m.fecha >= '2026-01-01' && m.fecha <= '2026-01-31');
  console.log('  movimientos de ejemplo:');
  [compra, difCompra, efectivo, vecina].forEach(m => console.log('    ' + (m ? corto(m) : '(no encontrado)')));
  console.log('  avisos:'); (b.avisos.length ? b.avisos.slice(0, 20) : ['(ninguno)']).forEach(a => console.log('    ' + a));

  comprobar(b.desde === '2026-01-01' && b.hasta === '2026-01-31', 'eco del rango pedido');
  comprobar(compra && compra.fecha === '2026-01-03' && compra.haberUsd === 2591.55 && compra.haberBs === 781015.42 && compra.tasa === 301.37 && compra.nroNorm === '47900093210',
    'compra MERCANTIL 3/1/2026 Nro 47900093210: clase BINANCE, haberBs 781015.42, haberUsd 2591.55, tasa 301.37');
  comprobar(difCompra && difCompra.fecha === '2026-01-03' && difCompra.haberBs === 742334.58 && difCompra.ref !== (compra && compra.ref),
    'su línea DIFERENCIAL con el mismo Nro (haberBs 742334.58)');
  comprobar(compra && difCompra && cerca((compra.haberBs + difCompra.haberBs) / compra.haberUsd, 587.8, 0.05),
    'tasa pactada implícita ≈ 587,8 Bs/USDT (' + (compra && difCompra ? ((compra.haberBs + difCompra.haberBs) / compra.haberUsd).toFixed(4) : '-') + ')');
  comprobar(b.tasas['2026-01-03'] === 301.37, "tasas['2026-01-03'] = 301.37");
  comprobar(Object.keys(b.tasas).every(f => f >= '2025-12-25' && f <= '2026-02-07'), 'tasas solo dentro del rango ± 7 días');
  comprobar(b.usdt.some(u => u.fecha === '2026-01-03' && u.entrada === 2591.55), 'usdt trae la entrada de 2591.55 del 2026-01-03');
  comprobar(b.usdt.every(u => !u.fecha || (u.fecha >= '2026-01-01' && u.fecha <= '2026-01-31')), 'usdt solo dentro del rango (sin margen)');
  comprobar(b.movimientos.every(m => !m.fecha || (m.fecha >= '2025-12-25' && m.fecha <= '2026-02-07')), 'movimientos solo dentro del rango ± 7 días');
  comprobar(!!efectivo, 'en enero 2026 vienen líneas clase EFECTIVO (' + b.movimientos.filter(m => m.clase === 'EFECTIVO').length + ')');
  comprobar(!!vecina, 'en enero 2026 vienen líneas clase VECINA (' + b.movimientos.filter(m => m.clase === 'VECINA').length + ')');
  const kleiber = b.movimientos.find(m => m.banco === 'MERCANTIL' && /KLEIBER LEON BONIF MES DIC$/.test(m.descripcion));
  comprobar(kleiber && kleiber.clase === 'VECINA', 'línea principal vecina de un DIFERENCIAL (sueldo "KLEIBER LEON BONIF MES DIC") = VECINA');
  const efectivoJuan = b.movimientos.find(m => m.banco === 'MERCANTIL' && m.nro === '47900096524' && m.clase === 'EFECTIVO');
  comprobar(efectivoJuan && b.movimientos.some(m => m.nro === '47900096524' && m.clase === 'DIFERENCIAL'),
    'compra de efectivo "JUAN CARLOS ROMERO COMPRA 100": línea EFECTIVO + su DIFERENCIAL (mismo Nro)');
  comprobar(Array.isArray(b.activos['Efectivo $']), "activos['Efectivo $'] presente (" + b.activos['Efectivo $'].length + ' filas en enero; la muestra no tiene efectivo en enero 2026)');
  console.log('  resumenPartidas:', JSON.stringify(b.resumenPartidas));
  const rp = b.resumenPartidas && b.resumenPartidas['2026-01'];
  comprobar(rp && rp.materiaCompras.n > 0, "resumenPartidas['2026-01'].materiaCompras.n > 0 (" + (rp ? rp.materiaCompras.n : '-') + ')');
  comprobar(rp && rp.materiaCompras.n === esperado.materiaEnero.n && cerca(rp.materiaCompras.bs, esperado.materiaEnero.bs, 0.01) &&
    rp.cobranzas.n === esperado.cobranzasEnero.n && cerca(rp.cobranzas.bs, esperado.cobranzasEnero.bs, 0.01),
    'resumenPartidas 2026-01 cuadra con la muestra (materia ' + esperado.materiaEnero.n + ' líneas / ' + esperado.materiaEnero.bs.toFixed(2) +
    ' Bs; cobranzas ' + esperado.cobranzasEnero.n + ' / ' + esperado.cobranzasEnero.bs.toFixed(2) + ' Bs)');
  comprobar(Object.keys(b.resumenPartidas).every(m => m === '2026-01'), 'resumenPartidas solo trae meses del rango pedido (sin margen)');

  // ---- decisiones
  titulo('3. Decisiones (DIF_BANCOS)');
  const d1 = { clave: 'BINANCE|2026-01-03|E|2591.55|#1', fecha: '2026-01-03', tipo: 'COMPRA', categoria: 'usdt', usdt: 2591.55, banco: 'MERCANTIL',
    refs: [compra ? compra.ref : 'MERCANTIL!313', difCompra ? difCompra.ref : 'MERCANTIL!314'], totalBs: 1523350, tasaPactada: 587.8, tasaBcv: 301.37,
    estado: 'CONFIRMADA', nota: 'prueba automática' };
  const d2 = { clave: 'BINANCE|2026-01-16|S|611.00|#1', fecha: '2026-01-16', tipo: 'EXCLUIR', categoria: 'otros', usdt: 611, banco: '', refs: [], estado: 'EXCLUIDA', nota: '-activos fijos (moldes)' };
  const nuestras = lista => lista.filter(x => x.clave === d1.clave || x.clave === d2.clave);

  r = await llamar('bancosGuardar', { token: token, datos: { decisiones: [d1, d2], borrar: [] } });
  comprobar(r.ok && r.datos.guardadas === 2 && r.datos.borradas === 0, 'bancosGuardar 2 decisiones -> ' + JSON.stringify(r.datos || r));
  r = await llamar('bancosDecisiones', { token: token });
  let mias = r.ok ? nuestras(r.datos.decisiones) : [];
  console.log('  decisiones leídas:'); mias.forEach(x => console.log('    ' + corto(x)));
  const l1 = mias.find(x => x.clave === d1.clave), l2 = mias.find(x => x.clave === d2.clave);
  comprobar(r.ok && mias.length === 2, 'bancosDecisiones devuelve las 2');
  comprobar(l1 && l1.fecha === '2026-01-03' && l1.tipo === 'COMPRA' && l1.categoria === 'usdt' && l1.usdt === 2591.55 && l1.banco === 'MERCANTIL' &&
    JSON.stringify(l1.refs) === JSON.stringify(d1.refs) && l1.totalBs === 1523350 && l1.tasaPactada === 587.8 && l1.tasaBcv === 301.37 &&
    l1.estado === 'CONFIRMADA' && l1.dispositivo === DISPOSITIVO && /^\d{4}-\d{2}-\d{2}T/.test(l1.actualizado), 'decisión 1: todos los campos vuelven iguales (refs como lista, dispositivo de la sesión)');
  comprobar(l2 && l2.tipo === 'EXCLUIR' && l2.estado === 'EXCLUIDA' && l2.categoria === 'otros' && l2.nota === d2.nota && Array.isArray(l2.refs) && l2.refs.length === 0,
    'decisión 2: EXCLUIR/EXCLUIDA, nota que empieza con "-" se guarda como texto');

  r = await llamar('bancosGuardar', { token: token, datos: { decisiones: [Object.assign({}, d1, { nota: 'editada', tasaPactada: 590 })] } });
  comprobar(r.ok && r.datos.guardadas === 1 && r.datos.borradas === 0, 'upsert de la decisión 1 -> ' + JSON.stringify(r.datos || r));
  r = await llamar('bancosDecisiones', { token: token });
  mias = r.ok ? nuestras(r.datos.decisiones) : [];
  const e1 = mias.find(x => x.clave === d1.clave);
  comprobar(mias.length === 2 && e1 && e1.nota === 'editada' && e1.tasaPactada === 590, 'upsert reescribe la fila (siguen 2, nota y tasa nuevas)');

  r = await llamar('bancosGuardar', { token: token, datos: { decisiones: [Object.assign({}, d1, { tipo: 'TRUEQUE' })] } });
  comprobar(!r.ok && r.error === 'dato_invalido', 'tipo inválido -> dato_invalido (' + (r.mensaje || '') + ')');
  r = await llamar('bancosGuardar', { token: token, datos: { decisiones: [Object.assign({}, d1, { categoria: 'cripto' })] } });
  comprobar(!r.ok && r.error === 'dato_invalido', 'categoría inválida -> dato_invalido (' + (r.mensaje || '') + ')');
  r = await llamar('bancosGuardar', { token: token, datos: { decisiones: new Array(501).fill(d1) } });
  comprobar(!r.ok && r.error === 'dato_invalido', 'más de 500 decisiones -> dato_invalido');

  r = await llamar('bancosGuardar', { token: token, datos: { decisiones: [], borrar: [d2.clave] } });
  comprobar(r.ok && r.datos.guardadas === 0 && r.datos.borradas === 1, 'borrar la decisión 2 -> ' + JSON.stringify(r.datos || r));
  r = await llamar('bancosDecisiones', { token: token });
  mias = r.ok ? nuestras(r.datos.decisiones) : [];
  comprobar(mias.length === 1 && mias[0].clave === d1.clave, 'queda solo la decisión 1');

  r = await llamar('bancosGuardar', { token: token, datos: { borrar: [d1.clave] } });
  r = await llamar('bancosDecisiones', { token: token });
  comprobar(r.ok && nuestras(r.datos.decisiones).length === 0, 'limpieza: sin decisiones de prueba');

  console.log('\n' + (fallos ? 'RESULTADO: ' + fallos + ' comprobación(es) FALLARON' : 'RESULTADO: todas las comprobaciones pasaron'));
  process.exit(fallos ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
