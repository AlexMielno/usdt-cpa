/**
 * Prueba de la lógica de conciliación (app/src/conciliacion.js) contra la muestra REAL del libro de bancos
 * (herramientas/fixtures/bancos_muestra.json). Incluye un conversor mínimo del fixture al formato de la respuesta
 * `bancos` del backend (§2.2 + §6.2: activos, hojasActivo, movimientos con clase y nroNorm, tasas).
 *
 * Uso: cd app && npm run probar:conciliacion        (sale con código 1 si alguna verificación falla)
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  prepararOperaciones, emparejar, movimientosSinPareja, tasaBcvPara, calcularFila, reporteDiferencialBancos,
  derivarDeDiferenciales, CATEGORIAS, normalizarClave, categoriaDePartida,
} from '../src/conciliacion.js';
import { num, signo, signoUsd, aNumero } from '../src/formato.js';

// ------------------------------------------------------------------------------------------------
// Conversor del fixture crudo → respuesta `bancos` (mismas reglas que el backend, §2.2 y §6.2)
// ------------------------------------------------------------------------------------------------
const SERIAL0 = Date.UTC(1899, 11, 30);
const HOJAS_ACTIVO = ['BINANCE', 'Efectivo $'];
const MARGEN_DIAS = 7;

const normaCab = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, '');
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const isoUTC = ms => new Date(ms).toISOString().slice(0, 10);
const sumarDias = (iso, d) => isoUTC(Date.parse(iso + 'T00:00:00Z') + d * 86400000);
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100, r4 = n => Math.round((n + Number.EPSILON) * 10000) / 10000;

/** Número desde número o texto es-VE ("$6.264,34", "  1.000,00 ", "  -   ", ""). */
function numeroCelda(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v || '').replace(/[$\s]/g, '');
  if (!s || /^-+$/.test(s)) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const x = parseFloat(s);
  return isFinite(x) ? x : 0;
}

/** Fecha desde serial de Sheets o texto d/m/yyyy, d/m/yy, d-m-yy, d-m-yyyy, d/m (año = columna YEAR o el de la fila anterior). */
function fechaCelda(v, anioColumna, anioPrevio) {
  if (typeof v === 'number' && v > 20000) return { iso: isoUTC(SERIAL0 + Math.round(v) * 86400000) };
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return { iso: '' };
  const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(s);
  if (!m) return { iso: '', aviso: 'fecha "' + s + '" no reconocida' };
  let anio = m[3] ? Number(m[3]) : 0, aviso = '';
  if (m[3] && m[3].length === 2) anio += 2000;
  if (!m[3]) {
    const col = numeroCelda(anioColumna);
    anio = col > 1900 ? col : anioPrevio;
    aviso = 'fecha "' + s + '" sin año, se asumió ' + anio + (col > 1900 ? ' por la columna YEAR' : ' por la fila anterior');
  }
  const d = Number(m[1]), mes = Number(m[2]);
  const t = Date.UTC(anio, mes - 1, d);
  if (!anio || mes < 1 || mes > 12 || new Date(t).getUTCDate() !== d) return { iso: '', aviso: 'fecha "' + s + '" inválida' };
  return { iso: isoUTC(t), aviso };
}

function claseLinea(r) {
  const p = norm(r[5]), d = norm(r[2]) + ' ' + norm(r[3]);
  if (p.includes('BINANCE')) return 'BINANCE';
  if (/EFECTIVO (DOLARES|\$)/.test(p)) return 'EFECTIVO';
  if (p.includes('DIFERENCIAL')) return 'DIFERENCIAL';
  if (/USDT|USTD|BINANCE/.test(d)) return 'OTRO';
  return '';
}

function convertirFixture(fx, { desde = '', hasta = '' } = {}) {
  const avisos = [];
  const hojas = fx.hojas;
  const conRango = !!(desde || hasta);
  const dDesde = desde ? sumarDias(desde, -MARGEN_DIAS) : '', dHasta = hasta ? sumarDias(hasta, MARGEN_DIAS) : '';
  const enRango = f => !f || ((!desde || f >= desde) && (!hasta || f <= hasta));
  const enMargen = f => (conRango ? !!f && (!dDesde || f >= dDesde) && (!dHasta || f <= dHasta) : true);
  const hojasActivo = HOJAS_ACTIVO.filter(h => hojas[h]);
  const bancos = Object.keys(hojas).filter(h => h !== 'TASA' && h !== 'BINANCE' /* el backend lista 'Efectivo $' también como banco; BINANCE no */ && (() => {
    const c = hojas[h][0] || [];
    return normaCab(c[0]) === 'FECHA' && normaCab(c[5]) === 'PARTIDA' && normaCab(c[7]) === 'DEBE' && normaCab(c[8]) === 'HABER';
  })());

  const leerFilas = hoja => {
    let anioPrevio = 2026;
    return hojas[hoja].map((r, i) => {
      if (!i) return null;
      const f = fechaCelda(r[0], r[18], anioPrevio);
      if (f.iso) anioPrevio = Number(f.iso.slice(0, 4));
      if (f.aviso) avisos.push(hoja + ' fila ' + (i + 1) + ': ' + f.aviso);
      return { r, fila: i + 1, fecha: f.iso, fechaTexto: typeof r[0] === 'string' ? r[0] : '' };
    });
  };

  // activos (BINANCE, Efectivo $): una fila por entrada/salida dentro del rango
  const activos = {};
  hojasActivo.forEach(h => {
    activos[h] = leerFilas(h).filter(Boolean).map(({ r, fila, fecha, fechaTexto }) => ({
      ref: h + '!' + fila, fila, fecha, fechaTexto, descripcion: String(r[2] || '').trim(), concepto: String(r[3] || '').trim(),
      tipo: String(r[4] || '').trim(), partida: String(r[5] || '').trim(), entrada: r4(numeroCelda(r[7])), salida: r4(numeroCelda(r[8])), saldo: r4(numeroCelda(r[11])),
    })).filter(u => (u.entrada > 0 || u.salida > 0) && enRango(u.fecha));
  });

  // movimientos de bancos: BINANCE > EFECTIVO > DIFERENCIAL > OTRO > VECINA
  // + resumenPartidas: todos los pagos de materia prima (HABER) y cobranzas (DEBE) del mes, tengan o no diferencial
  const movimientos = [], resumenPartidas = {};
  const sumarPartida = (mes, k, bs, usdv) => {
    const m = resumenPartidas[mes] || (resumenPartidas[mes] = { materiaCompras: { n: 0, bs: 0, usd: 0 }, cobranzas: { n: 0, bs: 0, usd: 0 } });
    m[k].n++; m[k].bs = r2(m[k].bs + bs); m[k].usd = r4(m[k].usd + usdv);
  };
  bancos.forEach(h => {
    const filas = leerFilas(h);
    filas.forEach(x => {
      if (!x || !x.fecha || !enRango(x.fecha)) return;
      const p = norm(x.r[5]), debe = numeroCelda(x.r[7]), haber = numeroCelda(x.r[8]);
      if (haber > 0 && /MATERIA PRIMA|\bCOMPRAS\b|INVENTARIO/.test(p)) sumarPartida(x.fecha.slice(0, 7), 'materiaCompras', haber, numeroCelda(x.r[14]));
      if (debe > 0 && /CUENTAS POR COBRAR COMERCIAL|\bVENTAS\b|ANTICIPO CLIENTES/.test(p)) sumarPartida(x.fecha.slice(0, 7), 'cobranzas', debe, numeroCelda(x.r[13]));
    });
    const clases = filas.map(x => (x ? claseLinea(x.r) : ''));
    const nroDe = x => String(x.r[1] === undefined || x.r[1] === null ? '' : x.r[1]).replace(/\s+/g, '');
    const nrosDif = new Set(filas.filter((x, i) => x && clases[i] === 'DIFERENCIAL' && nroDe(x)).map(nroDe));
    filas.forEach((x, i) => {
      if (!x || clases[i]) return;
      if (nroDe(x) && nrosDif.has(nroDe(x))) { clases[i] = 'VECINA'; return; }
      for (let k = Math.max(1, i - 4); k <= Math.min(filas.length - 1, i + 4); k++) {
        if (k !== i && clases[k] === 'DIFERENCIAL' && filas[k].fecha === x.fecha) { clases[i] = 'VECINA'; return; }
      }
    });
    filas.forEach((x, i) => {
      if (!x || !clases[i] || !enMargen(x.fecha)) return;
      const r = x.r;
      const debeBs = r2(numeroCelda(r[7])), haberBs = r2(numeroCelda(r[8]));
      if (!debeBs && !haberBs) return;
      const nro = String(r[1] === undefined || r[1] === null ? '' : r[1]).trim();
      movimientos.push({
        ref: h + '!' + x.fila, banco: h, fila: x.fila, fecha: x.fecha, fechaTexto: x.fechaTexto, nro, nroNorm: nro.replace(/\s+/g, ''),
        descripcion: String(r[2] || '').trim(), concepto: String(r[3] || '').trim(), tipo: String(r[4] || '').trim(), partida: String(r[5] || '').trim(),
        debeBs, haberBs, comisionBs: r2(numeroCelda(r[9])), igtfBs: r2(numeroCelda(r[10])), tasa: r4(numeroCelda(r[12])),
        debeUsd: r4(numeroCelda(r[13])), haberUsd: r4(numeroCelda(r[14])), clase: clases[i],
      });
    });
  });

  const tasas = {};
  (hojas.TASA || []).forEach((r, i) => {
    if (!i) return;
    const f = fechaCelda(r[0], '', 2026);
    const t = numeroCelda(r[1]);
    if (f.iso && t > 0 && enMargen(f.iso)) tasas[f.iso] = r4(t);
  });

  return {
    libro: { id: 'fixture', titulo: fx.titulo, leido: '2026-10-06T13:00:00.000Z' },
    hojaUsdt: 'BINANCE', hojasActivo, bancos, activos, usdt: activos.BINANCE || [], movimientos, tasas, resumenPartidas, avisos,
  };
}

// ------------------------------------------------------------------------------------------------
// Utilidades de la prueba
// ------------------------------------------------------------------------------------------------
let fallos = 0, verificaciones = 0;
function verificar(nombre, fn) {
  verificaciones++;
  try { fn(); console.log('  ✔ ' + nombre); } catch (e) { fallos++; console.log('  ✘ ' + nombre + '\n      ' + String(e.message).split('\n').join('\n      ')); }
}
const valorTexto = t => { const s = String(t).replace(/[^\d.,-]/g, ''); return (String(t).trim().startsWith('-') ? -1 : 1) * Math.abs(aNumero(s.replace(/^-/, '')) || 0); };
const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
const padI = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
function tabla(sec) {
  const filas = sec.filas.concat(sec.totales ? [sec.totales] : []);
  const anchos = sec.columnas.map((c, i) => Math.min(28, Math.max(String(c).length, ...filas.map(f => String(f[i]).length))));
  const izq = new Set(sec.alinear || []);
  const linea = f => '  ' + f.map((v, i) => (izq.has(i) ? pad(v, anchos[i]) : padI(v, anchos[i]))).join(' │ ');
  console.log(linea(sec.columnas));
  console.log('  ' + anchos.map(a => '─'.repeat(a)).join('─┼─'));
  sec.filas.forEach(f => console.log(linea(f)));
  if (sec.totales) { console.log('  ' + anchos.map(a => '─'.repeat(a)).join('─┼─')); console.log(linea(sec.totales)); }
}

// ------------------------------------------------------------------------------------------------
// 1. Datos
// ------------------------------------------------------------------------------------------------
const fixture = JSON.parse(fs.readFileSync(new URL('../../herramientas/fixtures/bancos_muestra.json', import.meta.url), 'utf8'));
const resp = convertirFixture(fixture);
const porClase = {};
resp.movimientos.forEach(m => { porClase[m.clase] = (porClase[m.clase] || 0) + 1; });
console.log('\n== Datos convertidos del fixture «' + resp.libro.titulo + '»');
console.log('  hojas de activo: ' + resp.hojasActivo.join(', ') + ' · bancos: ' + resp.bancos.join(', '));
console.log('  filas de activo: ' + resp.hojasActivo.map(h => h + ' ' + resp.activos[h].length).join(' · ') + ' · tasas: ' + Object.keys(resp.tasas).length);
console.log('  movimientos: ' + resp.movimientos.length + ' ' + JSON.stringify(porClase) + (resp.avisos.length ? ' · avisos: ' + resp.avisos.length : ''));

const t0 = Date.now();
const ops = prepararOperaciones(resp);
const sug = emparejar(ops, resp.movimientos, { diasTolerancia: 3, tolUsd: 0.015, tasas: resp.tasas });
const ms = Date.now() - t0;
const movPorRef = new Map(resp.movimientos.map(m => [m.ref, m]));
const filas = ops.map(op => {
  const s = sug.get(op.clave);
  const calculo = calcularFila(op, s, resp.tasas, movPorRef);
  return { op, decision: s, sugerencia: s, calculo, estado: calculo.estado };
});
const filaDe = clave => filas.find(f => f.op.clave === clave);
const activos = filas.filter(f => !f.op.derivada), derivadas = filas.filter(f => f.op.derivada);
const cuenta = (xs, k) => xs.reduce((o, x) => { const v = k(x); o[v] = (o[v] || 0) + 1; return o; }, {});
console.log('  ops: ' + ops.length + ' (activos ' + activos.length + ', derivadas de DIFERENCIAL ' + derivadas.length + ') en ' + ms + ' ms');
console.log('  por categoría: ' + JSON.stringify(cuenta(filas, f => f.op.categoria)) + ' · por estado: ' + JSON.stringify(cuenta(filas, f => f.estado)));
console.log('  activos relevantes por confianza: ' + JSON.stringify(cuenta(activos.filter(f => f.op.relevante), f => f.sugerencia.confianza)));

// ------------------------------------------------------------------------------------------------
// 2. Enero 2026: cada operación de los activos con su sugerencia
// ------------------------------------------------------------------------------------------------
console.log('\n== Enero 2026: operaciones de BINANCE / Efectivo $ y su sugerencia');
activos.filter(f => f.op.fecha.startsWith('2026-01')).sort((a, b) => a.op.fecha.localeCompare(b.op.fecha) || a.op.fila - b.op.fila).forEach(f => {
  const s = f.sugerencia, c = f.calculo;
  console.log('  ' + f.op.clave + ' · ' + f.op.tipoSugerido + ' · «' + f.op.descripcion + '» · ' + (f.op.relevante ? '' : 'NO RELEVANTE · ') + 'confianza ' + s.confianza);
  if (s.refs.length) console.log('      refs: ' + s.refs.join(', '));
  console.log('      total Bs ' + num(c.totalBs) + ' · tasa pactada ' + num(c.tasaPactada) + ' · BCV ' + num(c.tasaBcv) + ' · dif ' + signo(c.difBs) + ' Bs / ' + signoUsd(c.difUsd) + ' · ' + c.estado);
  console.log('      motivo: ' + s.motivo);
});

// ------------------------------------------------------------------------------------------------
// 3. Verificaciones
// ------------------------------------------------------------------------------------------------
console.log('\n== Verificaciones');
const compra0301 = filaDe('BINANCE|2026-01-03|E|2591.55|#1');
verificar('(a) compra MERCANTIL 03/01/2026 por 2.591,55 USDT = BINANCE + DIFERENCIAL del mismo Nro, tasa ≈ 587,8', () => {
  assert.ok(compra0301, 'no existe la op');
  assert.deepEqual(compra0301.sugerencia.refs, ['MERCANTIL!313', 'MERCANTIL!314']);
  const [b, d] = compra0301.sugerencia.refs.map(r => movPorRef.get(r));
  assert.equal(b.clase, 'BINANCE'); assert.equal(d.clase, 'DIFERENCIAL'); assert.equal(b.nroNorm, '47900093210'); assert.equal(d.nroNorm, b.nroNorm);
  assert.equal(compra0301.sugerencia.confianza, 'alta');
  assert.ok(Math.abs(compra0301.calculo.tasaPactada - 587.8) < 0.05, 'tasa ' + compra0301.calculo.tasaPactada);
  assert.ok(Math.abs(compra0301.calculo.totalBs - 1523350) < 0.01, 'total ' + compra0301.calculo.totalBs);
  assert.ok(Math.abs(compra0301.calculo.difBs + 742334.58) < 0.5, 'dif ' + compra0301.calculo.difBs + ' (debe ser −Bs de la línea DIFERENCIAL)');
});
verificar('(b) las salidas contra ACTIVOS FIJOS no son relevantes y quedan excluidas', () => {
  const af = activos.filter(f => f.op.lado === 'S' && /ACTIVOS FIJOS/i.test(f.op.partida));
  assert.ok(af.length >= 5, 'solo ' + af.length);
  af.forEach(f => { assert.equal(f.op.relevante, false, f.op.clave); assert.equal(f.sugerencia.tipo, 'EXCLUIR'); assert.equal(f.estado, 'EXCLUIDA'); assert.equal(f.calculo.difBs, 0); });
});
verificar('(c) signos: compra sobre el BCV negativa, venta sobre el BCV positiva, fórmula (tasa − BCV) × USDT', () => {
  const v = filaDe('BINANCE|2026-05-29|S|5500.00|#1');
  assert.ok(v && v.sugerencia.confianza === 'alta', 'venta 29/05 sin emparejar');
  assert.ok(compra0301.calculo.difBs < 0 && compra0301.calculo.difUsd < 0 && compra0301.calculo.difPct < 0);
  assert.ok(v.calculo.tasaPactada > v.calculo.tasaBcv && v.calculo.difBs > 0 && v.calculo.difUsd > 0);
  const esperado = (v.calculo.tasaPactada - v.calculo.tasaBcv) * 5500;
  assert.ok(Math.abs(v.calculo.difBs - esperado) < 1, v.calculo.difBs + ' vs ' + esperado);
  assert.ok(Math.abs(v.calculo.difUsd - v.calculo.difBs / v.calculo.tasaBcv) < 0.01);
  const exc = calcularFila(v.op, { tipo: 'EXCLUIR' }, resp.tasas, movPorRef);
  assert.deepEqual([exc.difBs, exc.totalBs, exc.estado], [0, 0, 'EXCLUIDA']);
  const manual = calcularFila(compra0301.op, { tipo: 'COMPRA', tasaPactada: 600 }, resp.tasas, movPorRef);
  assert.equal(manual.totalBs, 1554930);
  assert.ok(Math.abs(manual.difBs - (-(600 - 301.37) * 2591.55)) < 0.01);
  const deRefs = calcularFila(compra0301.op, { tipo: 'COMPRA', refs: ['MERCANTIL!313', 'MERCANTIL!314'] }, resp.tasas, movPorRef);
  assert.equal(deRefs.totalBs, 1523350);
});
verificar('tasaBcvPara: día exacto, día anterior (≤ 7), columna tasa de la línea, 0', () => {
  assert.equal(tasaBcvPara('2026-01-03', resp.tasas, []), 301.37);
  assert.equal(tasaBcvPara('2026-01-03', { '2025-12-30': 298.14 }, []), 298.14);
  assert.equal(tasaBcvPara('2026-01-20', { '2026-01-03': 301.37 }, [{ tasa: 1 }, { tasa: 341.74 }]), 341.74);
  assert.equal(tasaBcvPara('', {}, []), 0);
});

// casos reales difíciles descritos en la especificación
verificar('16/01/2026: compra de 20.701,67 = 4 transferencias BINANCE + 1 DIFERENCIAL (Nro), confianza alta', () => {
  const f = filaDe('BINANCE|2026-01-16|E|20701.67|#1');
  assert.deepEqual(f.sugerencia.refs, ['MERCANTIL!422', 'MERCANTIL!424', 'MERCANTIL!425', 'MERCANTIL!430', 'MERCANTIL!435']);
  assert.equal(f.sugerencia.confianza, 'alta');
});
verificar('16/01/2026: venta de 14.000 = 4 líneas BINANCE del 15/01 + DIFERENCIAL huérfano entre ellas; 5.300 = su par', () => {
  assert.deepEqual(filaDe('BINANCE|2026-01-16|S|14000.00|#1').sugerencia.refs, ['MERCANTIL!407', 'MERCANTIL!408', 'MERCANTIL!409', 'MERCANTIL!410', 'MERCANTIL!411']);
  assert.deepEqual(filaDe('BINANCE|2026-01-16|S|5300.00|#1').sugerencia.refs, ['MERCANTIL!416', 'MERCANTIL!417']);
});
verificar('11/10/2025: etiquetas BINANCE/DIFERENCIAL cruzadas (3 líneas) → las 3, sin el bono vecino', () => {
  const f = filaDe('BINANCE|2025-10-11|E|10121.99|#1');
  assert.deepEqual(f.sugerencia.refs, ['MERCANTIL!68', 'MERCANTIL!69', 'MERCANTIL!70']);
});
verificar('19/11/2025: 5 compras ~6.87x pagadas con 6 transferencias → un grupo, misma tasa, total repartido', () => {
  const g = activos.filter(f => f.op.fecha === '2025-11-19' && f.op.lado === 'E');
  assert.equal(g.length, 5);
  g.forEach(f => { assert.equal((f.sugerencia.grupo || []).length, 5, f.op.clave); assert.equal(f.sugerencia.confianza, 'media'); });
  const tasas = new Set(g.map(f => f.calculo.tasaPactada.toFixed(2)));
  assert.equal(tasas.size, 1, [...tasas].join(' / '));
  const total = g.reduce((s, f) => s + f.calculo.totalBs, 0);
  assert.ok(Math.abs(total - 11910000.01) < 0.05, 'total ' + total);
  assert.ok(g[0].sugerencia.refs.includes('MERCANTIL!148') && g[0].sugerencia.refs.includes('MERCANTIL!153'));
});
verificar('cada movimiento lo usa una sola operación (salvo dentro de un mismo grupo)', () => {
  const uso = new Map();
  filas.filter(f => f.estado !== 'EXCLUIDA').forEach(f => (f.sugerencia.refs || []).forEach(r => {
    const g = (f.sugerencia.grupo || [f.op.clave]).join(',');
    if (uso.has(r)) assert.equal(uso.get(r), g, r + ' usado por ' + uso.get(r) + ' y ' + f.op.clave);
    uso.set(r, g);
  }));
});
verificar('(d) reporte USDT: 3 secciones y totales coherentes (meses = detalle = KPI)', () => {
  const rep = reporteDiferencialBancos(filas, '', '', { categoria: 'usdt', libro: resp.libro });
  assert.equal(rep.tipo, 'diferencial-usdt');
  assert.deepEqual(rep.secciones.map(s => s.titulo), ['Resumen por mes', 'Detalle por operación', 'Por revisar (no incluidas)']);
  assert.equal(rep.kpis.length, 6);
  const [meses, detalle] = rep.secciones;
  assert.equal(meses.totales[7], rep.kpis[0].val);
  assert.equal(detalle.totales[8], rep.kpis[0].val);
  const suma = meses.filas.reduce((s, f) => s + valorTexto(f[7]), 0);
  assert.ok(Math.abs(suma - valorTexto(rep.kpis[0].val)) <= 0.01 * meses.filas.length, suma + ' vs ' + rep.kpis[0].val);
  const sumaDet = detalle.filas.reduce((s, f) => s + valorTexto(f[7]), 0);
  assert.ok(Math.abs(sumaDet - valorTexto(meses.totales[8])) <= 0.01 * detalle.filas.length, 'Bs ' + sumaDet + ' vs ' + meses.totales[8]);
  const inc = filas.filter(f => f.op.categoria === 'usdt' && (f.estado === 'CONFIRMADA' || f.estado === 'SUGERIDA'));
  assert.equal(detalle.filas.length, inc.length);
  assert.equal(rep.secciones[2].filas.length, filas.filter(f => f.op.categoria === 'usdt' && f.estado === 'REVISAR').length);
  const legado = reporteDiferencialBancos(filas, '', '', {});
  assert.equal(legado.tipo, 'diferencial-bancos'); assert.equal(legado.secciones.length, 3);
  const solo = reporteDiferencialBancos(filas, '', '', { categoria: 'usdt', soloConfirmadas: true });
  assert.equal(solo.secciones[1].filas.length, 0, 'sin confirmadas no hay detalle');
});

// §6.3 categorías
verificar('§6.3 compra de efectivo a un empleado → categoría efectivo con principal EFECTIVO DOLARES', () => {
  const f = derivadas.find(x => x.op.ref === 'MERCANTIL!1071');
  assert.ok(f, 'no hay op derivada de MERCANTIL!1071');
  assert.ok(/COMPRA \$ 200/.test(f.op.descripcion), f.op.descripcion);
  assert.equal(f.op.categoria, 'efectivo'); assert.equal(f.op.tipoSugerido, 'COMPRA'); assert.equal(f.sugerencia.confianza, 'alta');
  const p = movPorRef.get(f.sugerencia.refs[0]);
  assert.equal(p.partida, 'EFECTIVO DOLARES'); assert.equal(p.clase, 'EFECTIVO');
  assert.ok(Math.abs(f.op.usdt - 200) < 0.01 && f.calculo.difBs < 0);
  // toda derivada cuya principal es una línea EFECTIVO DOLARES queda en la categoría efectivo
  const conEfectivo = derivadas.filter(x => x.op.usdt > 0 && movPorRef.get(x.sugerencia.refs[0]).clase === 'EFECTIVO');
  assert.ok(conEfectivo.length >= 100, 'solo ' + conEfectivo.length);
  assert.deepEqual(conEfectivo.filter(x => x.op.categoria !== 'efectivo').map(x => x.op.clave), []);
});
verificar('principal plausible: 29/09/2026 MERCANTIL, la vecina es una comisión de 0,11 $ → sin principal, por revisar', () => {
  const f = derivadas.find(x => (x.sugerencia.refs || []).includes('MERCANTIL!1173'));
  assert.ok(f, 'no hay op derivada de MERCANTIL!1173');
  assert.deepEqual(f.sugerencia.refs, ['MERCANTIL!1173'], 'no debe tomar la comisión MERCANTIL!1175');
  assert.equal(f.op.usdt, 0); assert.equal(f.sugerencia.confianza, 'sin'); assert.equal(f.estado, 'REVISAR');
  assert.ok(/no cuadra como principal/.test(f.sugerencia.motivo), f.sugerencia.motivo);
  assert.equal(f.calculo.difBs, -38736);
});
verificar('principal plausible: ninguna derivada con principal tiene tasa pactada fuera de 0,8× a 3× el BCV', () => {
  const malas = derivadas.filter(f => f.op.usdt > 0 && f.calculo.tasaBcv > 0 && f.estado !== 'EXCLUIDA')
    .filter(f => f.calculo.tasaPactada > 3 * f.calculo.tasaBcv || f.calculo.tasaPactada < 0.8 * f.calculo.tasaBcv);
  assert.deepEqual(malas.map(f => f.op.clave + ' ' + num(f.calculo.tasaPactada / f.calculo.tasaBcv) + '×'), []);
  // y una línea con la misma referencia que no cuadra no se cambia por otra vecina (16/06/2026: 16,96 × BCV)
  const g = derivadas.find(x => (x.sugerencia.refs || []).includes('MERCANTIL!911'));
  assert.deepEqual(g.sugerencia.refs, ['MERCANTIL!911']); assert.ok(/misma referencia/.test(g.sugerencia.motivo), g.sugerencia.motivo);
});
verificar('§6.3 «VENPACK BOLSAS» en VENEZUELA → categoría materia (COMPRA)', () => {
  const v = derivadas.filter(f => f.op.hoja === 'VENEZUELA' && /VENPACK BOLSAS/.test(f.op.descripcion));
  assert.ok(v.length >= 1);
  v.forEach(f => { assert.equal(f.op.categoria, 'materia'); assert.equal(f.op.tipoSugerido, 'COMPRA'); });
});
verificar('§6.3 compras de efectivo de la hoja «Efectivo $» se emparejan con su línea EFECTIVO DOLARES', () => {
  const e = activos.filter(f => f.op.categoria === 'efectivo' && f.op.relevante);
  assert.ok(e.length >= 6);
  const bbva = filaDe('Efectivo $|2026-05-26|E|1550.00|#1');
  assert.ok(bbva.sugerencia.refs.includes('BBVA!517'), bbva.sugerencia.refs.join(','));
  assert.ok(e.filter(f => f.sugerencia.refs.length).length >= 6);
  const cambio = filaDe('Efectivo $|2025-10-18|E|2501.00|#1');
  assert.equal(cambio.op.relevante, false, 'cambio USDT → efectivo debe quedar excluido');
});
verificar('§6.3 cada línea DIFERENCIAL queda en exactamente una operación (nada cuenta dos veces)', () => {
  const difs = resp.movimientos.filter(m => m.clase === 'DIFERENCIAL').map(m => m.ref);
  const usos = new Map();
  filas.filter(f => f.estado !== 'EXCLUIDA').forEach(f => {
    const vistos = new Set();
    (f.sugerencia.refs || []).forEach(r => { if (vistos.has(r)) return; vistos.add(r); usos.set(r, (usos.get(r) || 0) + (f.sugerencia.grupo ? 1 / f.sugerencia.grupo.length : 1)); });
  });
  const faltan = difs.filter(r => !usos.has(r)), dobles = difs.filter(r => Math.abs((usos.get(r) || 0) - 1) > 1e-9 && usos.has(r));
  assert.deepEqual(faltan, [], 'sin operación: ' + faltan.slice(0, 10).join(', '));
  assert.deepEqual(dobles, [], 'en dos operaciones: ' + dobles.slice(0, 10).join(', '));
});

// suma por mes: Σ difBs de las operaciones ≈ Σ líneas DIFERENCIAL del banco (DEBE − HABER, cuentas en $ al BCV)
const porMes = new Map();
const acum = (mes, k, v) => { if (!porMes.has(mes)) porMes.set(mes, { banco: 0, bruto: 0, ops: 0, incl: 0 }); porMes.get(mes)[k] += v; };
resp.movimientos.filter(m => m.clase === 'DIFERENCIAL' && m.fecha).forEach(m => {
  const bcv = Math.abs(m.tasa - 1) < 1e-9 ? tasaBcvPara(m.fecha, resp.tasas, []) : 1;
  acum(m.fecha.slice(0, 7), 'banco', (m.debeBs - m.haberBs) * bcv);
  acum(m.fecha.slice(0, 7), 'bruto', (m.debeBs + m.haberBs) * bcv);
});
filas.filter(f => f.estado !== 'EXCLUIDA' && f.op.fecha).forEach(f => {
  acum(f.op.fecha.slice(0, 7), 'ops', f.calculo.difBs);
  if (f.estado === 'SUGERIDA' || f.estado === 'CONFIRMADA') acum(f.op.fecha.slice(0, 7), 'incl', f.calculo.difBs);
});
console.log('\n== Diferencial por mes: líneas DIFERENCIAL del banco vs operaciones (todas las categorías)');
console.log('  (neto = DEBE − HABER de las líneas DIFERENCIAL; bruto = DEBE + HABER; las cuentas en $ se pasan a Bs al BCV)');
console.log('  ' + pad('Mes', 8) + padI('Líneas DIF neto', 18) + padI('bruto', 16) + padI('Σ difBs ops', 18) + padI('dif. Bs', 12) + padI('vs neto', 9) + padI('vs bruto', 9) + padI('incluidas', 18));
[...porMes.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([mes, v]) => {
  console.log('  ' + pad(mes, 8) + padI(signo(v.banco), 18) + padI(num(v.bruto), 16) + padI(signo(v.ops), 18) + padI(signo(v.ops - v.banco), 12)
    + padI(v.banco ? num((v.ops / v.banco - 1) * 100, 1) + ' %' : '—', 9) + padI(v.bruto ? num(Math.abs(v.ops - v.banco) / v.bruto * 100, 2) + ' %' : '—', 9) + padI(signo(v.incl), 18));
});
verificar('§6.3 en cada mes Σ difBs de todas las categorías ≈ Σ líneas DIFERENCIAL (±5 % del monto de esas líneas)', () => {
  const malos = [...porMes.entries()].filter(([, v]) => Math.abs(v.ops - v.banco) > 0.05 * v.bruto);
  assert.deepEqual(malos.map(([m]) => m), []);
  const total = [...porMes.values()].reduce((s, v) => ({ banco: s.banco + v.banco, ops: s.ops + v.ops }), { banco: 0, ops: 0 });
  assert.ok(Math.abs(total.ops / total.banco - 1) <= 0.05, 'total del período ' + total.ops + ' vs ' + total.banco);
});
verificar('aBcv: compra sin línea de diferencial (17/08 «compra usdt para aire») → tasa = BCV, dif 0, por revisar con explicación', () => {
  const f = activos.find(x => x.op.fecha === '2026-08-17' && x.op.lado === 'E');
  assert.ok(f, 'no está la op del 17/08');
  assert.equal(f.calculo.aBcv, true); assert.equal(f.calculo.difBs, 0); assert.equal(f.estado, 'REVISAR');
  assert.equal(compra0301.calculo.aBcv, false);
  const r = reporteDiferencialBancos(filas, '2026-08-01', '2026-08-31', { categoria: 'usdt' });
  const fila = r.secciones[2].filas.find(x => x[0] === '17/08/2026');
  assert.ok(fila && fila[3].startsWith('Tasa pactada igual al BCV: revisar la línea de diferencial'), fila && fila[3]);
});
verificar('resumenPartidas: reporte materia y todas con «Pagos MP del mes (n)», «Con diferencial (n)» y KPI «Pagos a BCV»', () => {
  const rp = resp.resumenPartidas;
  assert.ok(Object.keys(rp).length >= 10);
  const m = reporteDiferencialBancos(filas, '', '', { categoria: 'materia', resumenPartidas: rp });
  const sec = m.secciones[0];
  assert.deepEqual(sec.columnas.slice(-2), ['Pagos MP del mes (n)', 'Con diferencial (n)']);
  assert.ok(sec.filas.every(f => f.length === sec.columnas.length) && sec.totales.length === sec.columnas.length);
  const k = m.kpis.find(x => x.etq === 'Pagos a BCV');
  assert.ok(k && / de /.test(k.val), JSON.stringify(k));
  const totMp = Object.values(rp).reduce((s, x) => s + x.materiaCompras.n, 0);
  const conDif = filas.filter(f => f.op.categoria === 'materia' && f.op.tipoSugerido === 'COMPRA' && f.estado !== 'EXCLUIDA').length;
  assert.equal(sec.totales.slice(-2).join('|'), totMp + '|' + conDif);
  assert.equal(k.val, Math.max(0, totMp - conDif) + ' de ' + totMp);
  const todasRp = reporteDiferencialBancos(filas, '', '', { categoria: 'todas', resumenPartidas: rp });
  assert.deepEqual(todasRp.secciones[1].columnas.slice(-2), ['Pagos MP del mes (n)', 'Con diferencial (n)']);
  assert.ok(todasRp.kpis.some(x => x.etq === 'Pagos a BCV'));
  assert.equal(todasRp.secciones[1].totales[5], todasRp.kpis[0].val);
  const sinRp = reporteDiferencialBancos(filas, '', '', { categoria: 'materia' });
  assert.equal(sinRp.secciones[0].columnas.length, 9); assert.ok(!sinRp.kpis.some(x => x.etq === 'Pagos a BCV'));
  const usdtRp = reporteDiferencialBancos(filas, '', '', { categoria: 'usdt', resumenPartidas: rp });
  assert.equal(usdtRp.secciones[0].columnas.length, 9, 'solo materia y todas llevan las columnas de partidas');
});
verificar('§6.3 reporte «todas»: 4 secciones, KPI por categoría y totales coherentes', () => {
  const rep = reporteDiferencialBancos(filas, '', '', { categoria: 'todas', libro: resp.libro });
  assert.equal(rep.tipo, 'diferencial-todas');
  assert.deepEqual(rep.secciones.map(s => s.titulo.split(' (')[0]), ['Resumen por categoría', 'Resumen por mes y categoría', 'Detalle por operación', 'Por revisar']);
  assert.equal(rep.kpis.length, 6);
  const [cat, mes] = rep.secciones;
  assert.equal(cat.totales[4], rep.kpis[0].val); assert.equal(mes.totales[5], rep.kpis[0].val);
  CATEGORIAS.forEach(([k], i) => {
    const r = reporteDiferencialBancos(filas, '', '', { categoria: k });
    assert.equal(r.kpis[0].val, rep.kpis[i + 1].val, k);
    assert.equal(cat.filas[i][4], rep.kpis[i + 1].val, k);
  });
  const suma = CATEGORIAS.reduce((s, _, i) => s + valorTexto(rep.kpis[i + 1].val), 0);
  assert.ok(Math.abs(suma - valorTexto(rep.kpis[0].val)) <= 0.03, suma + ' vs ' + rep.kpis[0].val);
});
verificar('decisiones guardadas: conservan sus refs, nadie más las usa; clave antigua sin prefijo = BINANCE', () => {
  assert.equal(normalizarClave('2026-01-03|E|2591.55|#1'), 'BINANCE|2026-01-03|E|2591.55|#1');
  assert.equal(normalizarClave('DIF|MERCANTIL|2026-01-03|25863.00|#1'), 'DIF|MERCANTIL|2026-01-03|25863.00|#1');
  const dec = [{ clave: '2026-01-03|E|2591.55|#1', tipo: 'COMPRA', refs: ['MERCANTIL!362', 'MERCANTIL!363'], estado: 'CONFIRMADA' }];
  const ops2 = prepararOperaciones(resp, { decisiones: dec });
  const s2 = emparejar(ops2, resp.movimientos, { decisiones: dec, tasas: resp.tasas });
  assert.deepEqual(s2.get('BINANCE|2026-01-03|E|2591.55|#1').refs, ['MERCANTIL!362', 'MERCANTIL!363']);
  s2.forEach((s, k) => { if (k !== 'BINANCE|2026-01-03|E|2591.55|#1') assert.ok(!s.refs.includes('MERCANTIL!362') && !s.refs.includes('MERCANTIL!363'), k); });
  assert.equal(s2.get('BINANCE|2026-01-03|E|4913.97|#1').confianza, 'sin', 'la otra compra se quedó sin sus líneas');
  // las líneas que la decisión dejó libres (313 BINANCE + 314 DIFERENCIAL) no se pierden: pasan a una op derivada
  const libre = ops2.find(o => o.derivada && o.ref === 'MERCANTIL!314');
  assert.ok(libre && libre.categoria === 'usdt', 'la línea DIFERENCIAL 314 debe derivarse en categoría usdt');
  assert.deepEqual(s2.get(libre.clave).refs, ['MERCANTIL!313', 'MERCANTIL!314']);
});
verificar('derivarDeDiferenciales: sin principal → monto 0, confianza sin, difBs con el signo del lado', () => {
  const movs = [{ ref: 'X!10', banco: 'X', fila: 10, fecha: '2026-01-05', nroNorm: '', descripcion: 'DIF SUELTO', partida: 'DIFERENCIAL CAMBIARIO', debeBs: 0, haberBs: 3047, tasa: 304.67, clase: 'DIFERENCIAL' }];
  const [op] = derivarDeDiferenciales(movs, new Set());
  assert.equal(op.clave, 'DIF|X|2026-01-05|3047.00|#1'); assert.equal(op.usdt, 0); assert.equal(op.categoria, 'otros'); assert.equal(op.sugerencia.confianza, 'sin');
  const c = calcularFila(op, op.sugerencia, { '2026-01-05': 304.67 }, new Map(movs.map(m => [m.ref, m])));
  assert.equal(c.difBs, -3047); assert.ok(Math.abs(c.difUsd + 3047 / 304.67) < 0.0001, c.difUsd); assert.equal(c.estado, 'REVISAR');
  assert.equal(categoriaDePartida('COSTO DE MATERIA PRIMA'), 'materia'); assert.equal(categoriaDePartida('CUENTAS POR COBRAR COMERCIALES'), 'materia');
  assert.equal(categoriaDePartida('SUELDOS Y SALARIOS'), 'otros'); assert.equal(categoriaDePartida('EFECTIVO DOLARES'), 'efectivo');
});
verificar('rango enero 2026 (respuesta con margen ± 7 días): mismas sugerencias y derivadas solo del mes', () => {
  const rEne = convertirFixture(fixture, { desde: '2026-01-01', hasta: '2026-01-31' });
  const oEne = prepararOperaciones(rEne, { desde: '2026-01-01', hasta: '2026-01-31' });
  const sEne = emparejar(oEne, rEne.movimientos, { tasas: rEne.tasas });
  assert.ok(oEne.every(o => !o.fecha || (o.fecha >= '2026-01-01' && o.fecha <= '2026-01-31')));
  activos.filter(f => f.op.fecha.startsWith('2026-01')).forEach(f => assert.deepEqual(sEne.get(f.op.clave).refs, f.sugerencia.refs, f.op.clave));
  const sinTasas = emparejar(ops, resp.movimientos, {});
  activos.forEach(f => assert.deepEqual(sinTasas.get(f.op.clave).refs, f.sugerencia.refs, 'sin tasas: ' + f.op.clave));
});

// ------------------------------------------------------------------------------------------------
// 4. Resúmenes
// ------------------------------------------------------------------------------------------------
const repUsdt = reporteDiferencialBancos(filas, '', '', { categoria: 'usdt', libro: resp.libro });
console.log('\n== Reporte «' + repUsdt.titulo + '» · ' + repUsdt.subtitulo + ' · resumen por mes');
repUsdt.kpis.forEach(k => console.log('  ' + k.etq + ': ' + k.val + (k.sub ? '  (' + k.sub + ')' : '')));
tabla(repUsdt.secciones[0]);
const repTodas = reporteDiferencialBancos(filas, '', '', { categoria: 'todas', libro: resp.libro });
console.log('\n== Reporte «' + repTodas.titulo + '»');
repTodas.kpis.forEach(k => console.log('  ' + k.etq + ': ' + k.val + (k.sub ? '  (' + k.sub + ')' : '')));
tabla(repTodas.secciones[0]);
console.log('');
tabla(repTodas.secciones[1]);

const repMat = reporteDiferencialBancos(filas, '', '', { categoria: 'materia', libro: resp.libro, resumenPartidas: resp.resumenPartidas });
console.log('\n== Reporte «' + repMat.titulo + '» (con resumenPartidas del conversor)');
repMat.kpis.forEach(k => console.log('  ' + k.etq + ': ' + k.val + (k.sub ? '  (' + k.sub + ')' : '')));
tabla(repMat.secciones[0]);

console.log('\n== Operaciones relevantes de los activos con confianza baja o sin pareja, o a tasa BCV');
activos.filter(f => f.op.relevante && (f.sugerencia.confianza === 'baja' || f.sugerencia.confianza === 'sin' || f.calculo.aBcv)).forEach(f => {
  console.log('  [' + f.sugerencia.confianza + (f.calculo.aBcv ? ' · a BCV' : '') + '] ' + f.op.clave + ' «' + f.op.descripcion + '» → ' + f.sugerencia.motivo);
});
console.log('\n== Derivadas por revisar (REVISAR)');
derivadas.filter(f => f.estado === 'REVISAR').forEach(f => console.log('  [' + f.sugerencia.confianza + '] ' + f.op.clave + ' ' + f.op.categoria + ' «' + f.op.descripcion + '» → ' + f.sugerencia.motivo));
const sinPareja = movimientosSinPareja(resp.movimientos, sug, []);
console.log('\n== Movimientos BINANCE sin operación (' + sinPareja.length + ')');
sinPareja.forEach(m => console.log('  ' + m.ref + ' ' + m.fecha + ' «' + m.descripcion + '» ' + (m.debeBs ? 'DEBE ' + num(m.debeBs) : 'HABER ' + num(m.haberBs)) + ' Bs = ' + num(m.debeUsd || m.haberUsd) + ' $'));
console.log('\n== Derivadas por confianza: ' + JSON.stringify(cuenta(derivadas, f => f.sugerencia.confianza)) + ' · por categoría: ' + JSON.stringify(cuenta(derivadas, f => f.op.categoria)));

console.log('\n' + (fallos ? '✘ ' + fallos + ' de ' + verificaciones + ' verificaciones fallaron' : '✔ ' + verificaciones + ' verificaciones correctas'));
process.exit(fallos ? 1 : 0);
