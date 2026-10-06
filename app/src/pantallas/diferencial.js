/**
 * Diferencial desde bancos (v1.6): reconstruye el diferencial cambiario REAL a partir del libro de bancos
 * "ADM.-002 BANCOS CPA". Es independiente de las operaciones registradas en la app.
 *
 *  - Cada fila de las hojas de activo (BINANCE, Efectivo $) se cruza con las líneas de los bancos (partidas BINANCE,
 *    EFECTIVO DOLARES y DIFERENCIAL CAMBIARIO). Las líneas de DIFERENCIAL que no quedan unidas a ninguna fila de activo
 *    generan operaciones "derivadas" (materia prima y clientes, otros pagos). La lógica pura vive en conciliacion.js.
 *  - Vista Conciliar: tabla editable como el modo tabulador (Tab avanza, Enter/↑↓ por columna). ✓ aprueba la sugerencia;
 *    cualquier cambio en una fila también la aprueba si queda completa; ↺ vuelve a la sugerencia automática.
 *    El selector de líneas del banco se abre en un modal.
 *  - Vista Reporte: mismo pintado que Reportes (vista_reporte.js), por categoría o todas juntas, exportable a PDF.
 *  - Solo se guardan (pestaña DIF_BANCOS) las decisiones confirmadas o excluidas; lo demás se recalcula al abrir.
 *    Los cambios sin guardar sobreviven al bloqueo por inactividad (memoria del módulo) y se pide confirmación al salir.
 */
import { el, montar, toast, icono, confirmar, ayuda, cargando, modal } from '../ui.js';
import { cabecera, conNavegacion } from './cascaron.js';
import { estado, navegar, definirGuardiaSalida } from '../estado.js';
import * as datos from '../datos.js';
import { num, aNumero, signo, signoUsd, fechaCorta, haceCuanto } from '../formato.js';
import { redondear } from '../calculos.js';
import { rangoPredefinido } from '../reportes.js';
import { exportarPdf } from '../pdf.js';
import { vistaReporte } from './vista_reporte.js';
import {
  CATEGORIAS, prepararOperaciones, emparejar, derivarDeDiferenciales, movimientosSinPareja,
  tasaBcvPara, calcularFila, reporteDiferencialBancos, normalizarClave,
} from '../conciliacion.js';

const TIPOS = ['COMPRA', 'VENTA', 'PAGO', 'EXCLUIR'];
const RANGOS = [['mes', 'Este mes'], ['mes_anterior', 'Mes anterior'], ['trimestre', 'Trimestre'], ['anio', 'Este año'], ['todo', 'Todo']];
const FILTROS = [['todas', 'Todas'], ['SUGERIDA', 'Sugeridas'], ['REVISAR', 'Por revisar'], ['CONFIRMADA', 'Confirmadas'], ['EXCLUIDA', 'Excluidas']];
const VISTAS = [['conciliar', 'Conciliar'], ['reporte', 'Reporte']];
const OPCIONES_EMPAREJAR = { diasTolerancia: 3, tolUsd: 0.015 };
const DIAS = [[3, '±3 días'], [7, '±7 días'], [15, '±15 días'], [30, '±30 días'], [0, 'Todas las fechas']];
const CLASES = { BINANCE: 'Binance', EFECTIVO: 'Efectivo $', DIFERENCIAL: 'Diferencial', OTRO: 'Otro', VECINA: 'Principal' };
const TITULO_CLASE = { VECINA: 'Línea con el mismo Nro o junto a una línea de diferencial (p. ej. el pago de la factura)' };
// [título, ancho en px, calculada, clase]. Tabla de anchos fijos (table-layout: fixed): de Fecha a Dif. $ suman 858 px
// + 46 de Confirmar (fija a la derecha) = 904, que caben a 1000 px de ventana sin desplazarse (≈920 útiles).
const COLUMNAS = [
  ['Fecha', 80], ['Descripción', 160], ['Tipo', 86], ['Categoría', 108], ['USDT / $', 80], ['Total Bs', 104], ['Tasa pactada', 80],
  ['BCV', 76], ['Dif. $', 84, true], ['Dif. Bs', 104, true], ['Banco', 118], ['Movimientos', 118], ['Nota', 160], ['Estado', 178],
  ['✓', 46, false, 'der'],
];
const ANCHO_TABLA = COLUMNAS.reduce((s, c) => s + c[1], 0);
/** Etiquetas cortas para el select de la tabla (la completa va en el title de cada opción). */
const CATEGORIA_CORTA = { usdt: 'USDT Binance', efectivo: 'Efectivo $', materia: 'Materia prima', otros: 'Otros pagos' };
const MAX_SELECTOR = 300, MAX_SIN_PAREJA = 300;

/** Lo que sobrevive al salir y volver (p. ej. tras el bloqueo por inactividad): filtros y cambios sin guardar. */
const memoria = {
  rango: '', desde: null, hasta: '', vista: 'conciliar', categoria: 'todas', filtro: 'todas', texto: '',
  soloConfirmadas: false, verSinPareja: false,
  cambios: new Map(),     // clave -> instantánea de la fila editada { modo, confirmada, quitada, bancoElegido, edicion }
  manuales: new Map(),    // clave -> op manual creada desde un movimiento bancario y aún no guardada
};

// ---------------------------------------------------------------------------------------
// utilidades puras
// ---------------------------------------------------------------------------------------
const r2 = n => redondear(Number(n) || 0, 2);
const r4 = n => redondear(Number(n) || 0, 4);
const cl = v => v > 0 ? 'positivo' : v < 0 ? 'negativo' : 'neutro';
const obtener = (mapa, k) => !mapa ? undefined : mapa instanceof Map ? mapa.get(k) : mapa[k];
const dia = (iso) => /^\d{4}-\d{2}-\d{2}/.test(iso || '') ? Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5 : NaN;
const hojaDe = (ref) => String(ref || '').split('!')[0];
const esDerivada = (op) => /^DIF\|/.test(op.clave || '') || op.derivada === true;
const esActivo = (op) => !op.manual && !esDerivada(op);
const etiquetaCategoria = (k) => (CATEGORIAS.find(c => c[0] === k) || [k, k || '—'])[1];
const categoriaDeClase = (c) => c === 'EFECTIVO' ? 'efectivo' : c === 'BINANCE' || c === 'OTRO' ? 'usdt' : 'otros';
const textoRango = (r) => (r.desde ? fechaCorta(r.desde) : 'inicio') + ' al ' + (r.hasta ? fechaCorta(r.hasta) : 'hoy');
/** Número escrito por el usuario. Además de lo que entiende aNumero, acepta puntos de miles sin coma ("1.523.350"). */
const leerNumero = (t) => { const s = String(t || '').trim().replace(/\s/g, ''); return /^\d{1,3}(\.\d{3})+$/.test(s) ? Number(s.replace(/\./g, '')) : aNumero(s); };
/** Cuentas en dólares (Efectivo $, CRUCE): tasa 1 y montos en $. */
const esDolares = (m) => Math.abs((Number(m.tasa) || 0) - 1) < 1e-9;
/** Monto de una línea con signo: + entra a la cuenta (DEBE), − sale (HABER). En Bs, o en $ si es cuenta en dólares. */
const bsDe = (m) => (Number(m.debeBs) || 0) - (Number(m.haberBs) || 0);
const textoBs = (b, dolares) => (b > 0 ? '+' : b < 0 ? '−' : '') + (dolares ? '$ ' : '') + num(Math.abs(b), 2);
/** $ al BCV de una línea, con el mismo signo que bsDe. */
const usdDe = (m) => { const u = (Number(m.debeUsd) || 0) - (Number(m.haberUsd) || 0); if (u) return u; const t = Number(m.tasa) || 0; return t > 0 ? bsDe(m) / t : 0; };
/**
 * Total en Bs de varias líneas visto desde la operación (mismo criterio que calcularFila de conciliacion.js): cada línea
 * aporta su monto del lado de la operación (HABER en una COMPRA, DEBE en VENTA/PAGO) o, si no tiene, el del otro lado;
 * las de cuentas en dólares se pasan a Bs con la tasa BCV.
 */
const sumaBs = (refs, tipo, idx, bcv) => refs.reduce((s, r) => {
  const m = idx.get(r); if (!m) return s;
  const h = Math.max(0, Number(m.haberBs) || 0), d = Math.max(0, Number(m.debeBs) || 0);
  const v = tipo === 'COMPRA' ? (h || d) : (d || h);
  return s + (esDolares(m) ? v * (bcv || 0) : v);
}, 0);
/** refs puede llegar como lista o como texto JSON (celda de la hoja). */
function refsDe(x) {
  if (Array.isArray(x)) return x.map(String);
  if (typeof x === 'string' && x.trim()) {
    try { const v = JSON.parse(x); return Array.isArray(v) ? v.map(String) : []; } catch (e) { return x.split(/[,;]+/).map(s => s.trim()).filter(Boolean); }
  }
  return [];
}
/** Índice ref -> movimiento. Es un Map y además lleva cada ref como propiedad: sirve como Map o como objeto. */
function indicePorRef(movs) { const m = new Map(); (movs || []).forEach(x => { m.set(x.ref, x); m[x.ref] = x; }); return m; }
/** Conjunto de refs que también responde a includes() (por si quien lo recibe lo trata como lista). */
function conjunto(iterable) { const s = new Set(iterable); s.includes = (x) => s.has(x); return s; }
/** replaceChildren sin nulos (replaceChildren convertiría null en el texto "null"). */
function poner(padre, ...hijos) { padre.replaceChildren(...hijos.flat(Infinity).filter(h => h !== null && h !== undefined && h !== false && h !== '')); return padre; }
const mostrar = (nodo, si) => { if (nodo) nodo.style.display = si ? '' : 'none'; };

// ---------------------------------------------------------------------------------------
/** « · en 12 s (caché)» con los tiempos que devuelve el backend, para saber cuánto tarda la lectura real. */
function duracionLectura(resp) {
  const t = resp && resp.tiempos;
  if (!t || !(t.total >= 0)) return '';
  const seg = t.total >= 1000 ? (t.total / 1000).toFixed(t.total >= 10000 ? 0 : 1) + ' s' : t.total + ' ms';
  return ' · en ' + seg + (resp.cache ? ' (caché del servidor)' : '');
}

export function pantallaDiferencial({ manejarError }) {
  let resp = null, idx = new Map(), tasas = {}, bancos = [];
  let hojasActivo = [];
  // f = { op, guardada, claveAntigua, sugerencia, modo: 'auto'|'manual', confirmada, quitada, bancoElegido, edicion, calc,
  //       bcvSug (BCV del día en que el banco movió el dinero, según la sugerencia o las líneas elegidas), bcvAuto, dom }
  let filas = [];
  let huerfanas = 0, leyendo = true, errorLibro = null, secuencia = 0, guardando = false, temporizadorRango = null;

  const rangoDatos = () => estado.bancosRango || { desde: memoria.desde || '', hasta: memoria.hasta || '' };
  const enRangoDatos = (fecha) => { const r = rangoDatos(); return !fecha || ((!r.desde || fecha >= r.desde) && (!r.hasta || fecha <= r.hasta)); };

  // =====================================================================================
  // modelo de una fila
  // =====================================================================================
  const usdtEditable = (op) => !esActivo(op);     // manuales y derivadas: el monto en $ lo puede corregir el usuario
  const usdtDe = (f) => usdtEditable(f.op) ? (Number(f.edicion.usdt) || 0) : (Number(f.op.usdt) || 0);
  const opDe = (f) => Object.assign({}, f.op, { usdt: usdtDe(f), categoria: f.edicion.categoria });
  const excluida = (f) => f.edicion.tipo === 'EXCLUIR';
  const movsDe = (f) => f.edicion.refs.map(r => idx.get(r)).filter(Boolean);
  const bcvDe = (f) => { const t = f.edicion.tasaBcv; return t !== '' && Number(t) > 0 ? Number(t) : (f.bcvAuto || 0); };
  const vivas = () => filas.filter(f => !f.quitada);

  const recalcular = (f) => {
    const e = f.edicion;
    const fija = e.tasaBcv !== '' && Number(e.tasaBcv) > 0 ? Number(e.tasaBcv) : 0;
    // sin tasa escrita ni sugerida, calcularFila toma el BCV del día en que el banco movió el dinero
    f.calc = calcularFila(opDe(f), {
      tipo: e.tipo, categoria: e.categoria, banco: e.banco, refs: excluida(f) ? [] : e.refs,
      totalBs: e.totalBs === '' ? undefined : Number(e.totalBs), tasaBcv: fija || f.bcvSug || undefined,
    }, tasas, idx) || {};
    f.bcvAuto = f.bcvSug || Number(f.calc.tasaBcv) || Number(tasaBcvPara(f.op.fecha, tasas, movsDe(f))) || 0;
  };
  /** Le falta algo para poder confirmarse (las EXCLUIR nunca). Las derivadas sin pago principal pueden ir con $ = 0. */
  const incompleta = (f) => {
    if (excluida(f)) return false;
    const c = f.calc || {};
    if (!f.op.fecha || !(c.totalBs > 0) || !(bcvDe(f) > 0)) return true;
    return !esDerivada(f.op) && !(usdtDe(f) > 0);
  };
  const confianzaDe = (f) => f.modo === 'auto' ? ((f.sugerencia && f.sugerencia.confianza) || 'sin') : '';
  const estadoDe = (f) => {
    if (excluida(f)) return 'EXCLUIDA';
    if (incompleta(f)) return 'REVISAR';
    if (f.confirmada) return 'CONFIRMADA';
    if (f.calc && f.calc.aBcv) return 'REVISAR';     // tasa pactada = BCV: casi siempre falta la línea de diferencial
    const c = confianzaDe(f);
    return c === 'alta' || c === 'media' ? 'SUGERIDA' : 'REVISAR';
  };
  /** [clase css, texto] del chip de estado. */
  const chipDe = (f) => {
    const est = estadoDe(f), c = f.calc || {};
    if (est === 'EXCLUIDA') return ['ex', f.confirmada ? 'Excluida' : 'Excluida · auto'];
    if (est === 'CONFIRMADA') return ['ok', 'Confirmada'];
    if (est === 'SUGERIDA') return [confianzaDe(f), 'auto · ' + confianzaDe(f)];
    if (!f.op.fecha) return ['sin', 'Sin fecha'];
    if (f.modo === 'auto' && !f.edicion.refs.length) return ['sin', 'Sin pareja'];
    if (!(c.totalBs > 0)) return ['sin', 'Falta Total Bs'];
    if (!(bcvDe(f) > 0)) return ['sin', 'Falta tasa BCV'];
    if (!esDerivada(f.op) && !(usdtDe(f) > 0)) return ['sin', 'Falta monto'];
    if (c.aBcv) return ['baja', 'a BCV'];
    return ['baja', f.modo !== 'auto' ? 'Por revisar' : confianzaDe(f) === 'baja' ? 'Revisar · baja' : 'Revisar'];
  };
  const motivoDe = (f) => {
    let t = chipDe(f)[1];
    if (t === 'a BCV') t = 'Tasa pactada igual al BCV (diferencial 0): casi siempre falta la línea de DIFERENCIAL CAMBIARIO; revísala o confírmala si de verdad fue a BCV';
    const m = f.modo === 'auto' && f.sugerencia && f.sugerencia.motivo;
    return m ? t + ' · ' + m : t;
  };

  /** Decisión tal como se guarda en DIF_BANCOS. */
  const decisionDe = (f) => {
    const e = f.edicion, excl = excluida(f), c = f.calc || {};
    return {
      clave: f.op.clave, fecha: f.op.fecha || '', tipo: e.tipo, categoria: e.categoria, usdt: r4(usdtDe(f)), banco: String(e.banco || '').trim(),
      refs: excl ? [] : e.refs.slice(), totalBs: excl ? 0 : r2(c.totalBs), tasaPactada: excl ? 0 : r4(c.tasaPactada), tasaBcv: r4(bcvDe(f)),
      estado: excl ? 'EXCLUIDA' : 'CONFIRMADA', nota: String(e.nota || '').trim(),
    };
  };
  /** ¿La decisión de la fila es la misma que la guardada? (con tolerancia: el backend puede redondear) */
  const iguales = (x, d, categoriaPorDefecto) => {
    const n = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.006;
    const refs = (tipo, l) => tipo === 'EXCLUIR' ? '' : refsDe(l).slice().sort().join('|');
    return x.tipo === d.tipo && x.categoria === (d.categoria || categoriaPorDefecto) && x.banco === String(d.banco || '').trim()
      && refs(x.tipo, x.refs) === refs(d.tipo, d.refs) && n(x.usdt, d.usdt) && x.nota === String(d.nota || '').trim()
      && (x.tipo === 'EXCLUIR' || (n(x.totalBs, d.totalBs) && n(x.tasaBcv, d.tasaBcv)));
  };
  /** Qué hay que enviar al guardar: 'guardar' (upsert), 'borrar' (la fila ya no está confirmada) o null. */
  const accion = (f) => {
    if (f.quitada) return f.guardada ? 'borrar' : null;
    if (f.confirmada && !incompleta(f)) return f.guardada && !f.claveAntigua && iguales(decisionDe(f), f.guardada, f.op.categoria) ? null : 'guardar';
    return f.guardada ? 'borrar' : null;
  };
  const pendientes = () => filas.filter(f => accion(f));

  const desdeDecision = (d, op) => ({
    tipo: TIPOS.includes(d.tipo) ? d.tipo : 'EXCLUIR',
    categoria: d.categoria || op.categoria || 'otros',
    banco: String(d.banco || ''),
    refs: refsDe(d.refs),
    totalBs: d.tipo === 'EXCLUIR' || !(Number(d.totalBs) > 0) ? '' : Number(d.totalBs),
    tasaBcv: Number(d.tasaBcv) > 0 ? Number(d.tasaBcv) : '',
    nota: String(d.nota || ''),
    usdt: usdtEditable(op) ? (Number(d.usdt) || 0) : (Number(op.usdt) || 0),
  });
  /** Valores de la fila según la sugerencia automática (también fija bcvSug). */
  const desdeSugerencia = (f) => {
    const op = f.op, sug = f.sugerencia;
    const refs = sug ? refsDe(sug.refs) : [];
    const primera = refs.map(r => idx.get(r)).find(Boolean);
    const relevante = op.relevante !== false || !!f.bancoElegido;
    const tipoBase = TIPOS.includes(op.tipoSugerido) ? op.tipoSugerido : op.lado === 'E' ? 'COMPRA' : 'VENTA';
    f.bcvSug = sug && Number(sug.tasaBcv) > 0 ? Number(sug.tasaBcv) : 0;
    return {
      tipo: sug && TIPOS.includes(sug.tipo) ? sug.tipo : relevante ? tipoBase : 'EXCLUIR',
      categoria: op.categoria || (sug && sug.categoria) || 'otros',
      banco: f.bancoElegido || (sug && sug.banco) || op.bancoSugerido || (primera ? primera.banco : ''),
      // totalBs null/0 (p. ej. cuentas en dólares): lo calcula calcularFila con las líneas y el BCV
      refs, totalBs: sug && Number(sug.totalBs) > 0 ? r2(sug.totalBs) : '', tasaBcv: '', nota: '', usdt: Number(op.usdt) || 0,
    };
  };
  const nuevaFila = (op, d) => {
    const f = { op, guardada: d || null, claveAntigua: null, sugerencia: null, modo: 'auto', confirmada: false, quitada: false, bancoElegido: '', edicion: null, calc: null, bcvSug: 0, bcvAuto: 0, dom: null };
    if (d) { f.modo = 'manual'; f.confirmada = true; f.edicion = desdeDecision(d, op); if (d.clave !== op.clave) f.claveAntigua = d.clave; recalcular(f); }
    return f;
  };
  /** Op de una decisión guardada que no sale de las hojas de activo (manual o derivada de una línea de diferencial). */
  const opDesdeDecision = (d) => {
    const refs = refsDe(d.refs), movs = refs.map(r => idx.get(r)).filter(Boolean), m = movs[0] || {};
    const manual = /^MANUAL\|/.test(d.clave);
    return {
      clave: d.clave, ref: refs[0] || '', fila: m.fila || 0, fecha: d.fecha || m.fecha || '', fechaTexto: m.fechaTexto || '',
      descripcion: movs.map(x => x.descripcion).filter(Boolean).join(' · ') || (manual ? 'Operación manual' : 'Diferencial cambiario'),
      partida: m.partida || '', lado: d.tipo === 'COMPRA' ? 'E' : 'S', usdt: Number(d.usdt) || 0,
      tipoSugerido: TIPOS.includes(d.tipo) && d.tipo !== 'EXCLUIR' ? d.tipo : 'COMPRA', bancoSugerido: d.banco || m.banco || '',
      categoria: d.categoria || 'otros', relevante: true, manual, derivada: !manual,
    };
  };
  /** Op derivada de una línea de DIFERENCIAL (conciliacion.derivarDeDiferenciales), normalizada a la forma de las de activo. */
  const normalizarDerivada = (o) => {
    const s = o.sugerencia || {};
    const tipo = TIPOS.includes(o.tipoSugerido) && o.tipoSugerido !== 'EXCLUIR' ? o.tipoSugerido : TIPOS.includes(s.tipo) && s.tipo !== 'EXCLUIR' ? s.tipo : 'COMPRA';
    const refs = refsDe(s.refs || o.refs);
    return Object.assign({}, o, {
      derivada: true, relevante: true, tipoSugerido: tipo, lado: o.lado || (tipo === 'COMPRA' ? 'E' : 'S'),
      bancoSugerido: o.bancoSugerido || s.banco || o.hoja || '', categoria: o.categoria || s.categoria || 'otros', usdt: Number(o.usdt) || 0,
      ref: o.ref || refs[refs.length - 1] || '', descripcion: o.descripcion || '',
    });
  };
  /** La sugerencia de una derivada viene dentro de la op (op.sugerencia) desde derivarDeDiferenciales. */
  const sugerenciaDerivada = (o) => {
    const s = o.sugerencia || {}, refs = refsDe(s.refs || o.refs);
    return Object.assign({}, s, {
      refs, candidatos: Array.isArray(s.candidatos) ? s.candidatos : [],
      confianza: s.confianza || (refs.length > 1 ? 'media' : 'sin'),
      motivo: s.motivo || (refs.length > 1 ? 'línea de diferencial unida a su pago o cobro principal' : 'línea de diferencial sin pago principal: escribe el monto en $'),
    });
  };
  const edicionManual = (op) => ({ tipo: op.tipoSugerido || 'COMPRA', categoria: op.categoria || 'usdt', banco: op.bancoSugerido || '', refs: op.ref ? [op.ref] : [], totalBs: '', tasaBcv: '', nota: '', usdt: Number(op.usdt) || 0 });

  // ---- memoria de cambios sin guardar ----
  const recordar = (f) => {
    if (accion(f) || f.bancoElegido || (f.op.manual && !f.guardada)) {
      memoria.cambios.set(f.op.clave, { modo: f.modo, confirmada: f.confirmada, quitada: f.quitada, bancoElegido: f.bancoElegido, bcvSug: f.bcvSug, edicion: Object.assign({}, f.edicion, { refs: f.edicion.refs.slice() }) });
    } else memoria.cambios.delete(f.op.clave);
  };
  const aplicarMemoria = (f) => {
    const c = memoria.cambios.get(f.op.clave); if (!c) return;
    Object.assign(f, { modo: c.modo, confirmada: c.confirmada, quitada: !!c.quitada, bancoElegido: c.bancoElegido || '', bcvSug: c.bcvSug || 0 });
    f.edicion = Object.assign({}, c.edicion, { refs: c.edicion.refs.slice() });
    recalcular(f);
  };
  const olvidarCambios = () => { memoria.cambios.clear(); memoria.manuales.clear(); };

  /** refs ocupadas por las filas vivas que no están excluidas (salvo las de `fuera`). */
  const refsUsadas = (fuera) => {
    const s = new Set();
    filas.forEach(f => { if (f.quitada || !f.edicion || excluida(f) || (fuera && fuera.has(f))) return; f.edicion.refs.forEach(r => s.add(r)); });
    return s;
  };

  /** Recalcula la sugerencia de filas de activo (BINANCE / Efectivo $) con los movimientos que no usan las demás filas. */
  const sugerir = (lista) => {
    lista = lista.filter(f => esActivo(f.op) && !f.quitada);
    if (!lista.length || !resp) return;
    const usados = conjunto(refsUsadas(new Set(lista)));
    const ops = lista.map(f => f.bancoElegido ? Object.assign({}, f.op, { bancoSugerido: f.bancoElegido, relevante: true }) : f.op);
    let mapa = null;
    // todos los movimientos (las vecinas de fila importan) y como "usados" lo que ya tienen las demás filas
    try { mapa = emparejar(ops, resp.movimientos || [], Object.assign({}, OPCIONES_EMPAREJAR, { tasas, usados })); } catch (e) { manejarError(e); }
    lista.forEach(f => { f.sugerencia = obtener(mapa, f.op.clave) || null; f.modo = 'auto'; f.confirmada = false; f.edicion = desdeSugerencia(f); recalcular(f); });
  };

  /** Agrega las operaciones derivadas de líneas de DIFERENCIAL que no usa ninguna fila (siempre DESPUÉS del emparejado). */
  const derivar = () => {
    if (!resp) return;
    const presentes = new Set(filas.map(f => f.op.clave));
    let nuevas = [];
    try { nuevas = derivarDeDiferenciales(resp.movimientos || [], conjunto(refsUsadas())) || []; } catch (e) { manejarError(e); }
    nuevas.forEach(o => {
      const op = normalizarDerivada(o);
      if (!op.clave || presentes.has(op.clave) || !enRangoDatos(op.fecha)) return;
      presentes.add(op.clave);
      const f = nuevaFila(op, null);
      f.sugerencia = sugerenciaDerivada(o);
      f.edicion = desdeSugerencia(f); recalcular(f);
      aplicarMemoria(f);
      filas.push(f);
    });
  };

  const ordenar = () => filas.sort((a, b) => (b.op.fecha || '9999-99-99').localeCompare(a.op.fecha || '9999-99-99') || String(a.op.clave).localeCompare(String(b.op.clave)));

  /** Arma todas las filas a partir de la lectura del libro, las decisiones guardadas y los cambios sin guardar. */
  const construir = () => {
    resp = estado.bancos;
    if (!resp) { filas = []; return; }
    idx = indicePorRef(resp.movimientos); tasas = resp.tasas || {};
    hojasActivo = Array.isArray(resp.hojasActivo) ? resp.hojasActivo : [resp.hojaUsdt || 'BINANCE'];
    bancos = (resp.bancos || []).filter(b => !hojasActivo.includes(b));
    // claves normalizadas: las de la primera v1.6 no tenían prefijo de hoja y se leen como de BINANCE
    const guardadas = new Map((estado.decisionesBancos || []).map(d => [normalizarClave(d.clave), d]));
    const vistas = new Set();     // claves normalizadas ya representadas por una fila
    const r = rangoDatos();
    let ops = [];
    try {
      // las derivadas que trae se descartan: se vuelven a derivar abajo, después de emparejar con los cambios sin guardar
      ops = (prepararOperaciones(resp, { decisiones: estado.decisionesBancos || [], desde: r.desde, hasta: r.hasta }) || []).filter(op => !esDerivada(op));
    } catch (e) { manejarError(e); }
    filas = ops.map(op => {
      if (!op.categoria) op.categoria = /efectivo/i.test(op.hoja || hojaDe(op.ref)) ? 'efectivo' : 'usdt';
      vistas.add(op.clave);
      return nuevaFila(op, guardadas.get(op.clave));
    });
    guardadas.forEach((d, k) => {
      if (vistas.has(k) || !/^(MANUAL|DIF)\|/.test(k) || !enRangoDatos(d.fecha)) return;
      vistas.add(k); filas.push(nuevaFila(opDesdeDecision(d), d));
    });
    memoria.manuales.forEach((op, k) => {
      if (vistas.has(k)) return;
      vistas.add(k);
      const f = nuevaFila(op, null);
      f.modo = 'manual'; f.edicion = edicionManual(op); f.bcvSug = 0; recalcular(f); f.confirmada = !incompleta(f);
      filas.push(f);
    });
    filas.forEach(aplicarMemoria);
    sugerir(filas.filter(f => f.modo === 'auto'));
    derivar();
    const claves = new Set(filas.map(f => f.op.clave));
    huerfanas = [...guardadas.entries()].filter(([k, d]) => !vistas.has(k) && !claves.has(k) && d.fecha && enRangoDatos(d.fecha)).length;
    ordenar();
  };

  // =====================================================================================
  // acciones sobre las filas
  // =====================================================================================
  /** Edición de una celda: la fila pasa a manual y queda confirmada si tiene los datos completos. */
  const editar = (f, col, texto) => {
    const e = f.edicion, t = String(texto === undefined || texto === null ? '' : texto), vacio = t.trim() === '';
    if (col === 'tipo') e.tipo = t;
    else if (col === 'categoria') e.categoria = t;
    else if (col === 'banco') e.banco = t;
    else if (col === 'nota') e.nota = t;
    else if (col === 'totalBs') e.totalBs = vacio ? '' : r2(Math.abs(leerNumero(t) || 0));
    else if (col === 'tasaPactada') { const tp = leerNumero(t); e.totalBs = vacio || !(tp > 0) ? '' : r2(tp * usdtDe(f)); }
    else if (col === 'tasaBcv') e.tasaBcv = vacio ? '' : Math.abs(leerNumero(t) || 0);
    else if (col === 'usdt') e.usdt = vacio ? 0 : Math.abs(leerNumero(t) || 0);
    f.modo = 'manual'; f.bancoElegido = '';
    recalcular(f);
    f.confirmada = !incompleta(f);
    recordar(f);
    refrescarFila(f, col);
    pintarResumen();
  };

  const confirmarFila = (f) => {
    if (incompleta(f)) { toast('A esta fila le faltan datos (líneas del banco, Total Bs o tasa BCV).', 'aviso'); return; }
    f.confirmada = true; f.modo = 'manual';
    recordar(f); refrescarFila(f); pintarResumen();
  };

  const volverAuto = (f) => {
    f.bancoElegido = '';
    if (esActivo(f.op)) sugerir([f]);
    else if (f.sugerencia) { f.modo = 'auto'; f.confirmada = false; f.edicion = desdeSugerencia(f); recalcular(f); }
    recordar(f); refrescarFila(f); pintarResumen(); pintarSinPareja();
  };

  /** Cambiar el banco de una fila de activo vuelve a buscar la pareja en ese banco (queda como sugerencia, sin confirmar). */
  const cambiarBanco = (f, banco) => {
    if (!esActivo(f.op)) { editar(f, 'banco', banco); return; }
    f.bancoElegido = banco;
    sugerir([f]);
    if (banco) f.edicion.banco = banco;
    recordar(f); refrescarFila(f); pintarResumen(); pintarSinPareja();
    const n = f.edicion.refs.length, donde = banco || 'los bancos';
    toast(n ? 'Se encontr' + (n === 1 ? 'ó 1 línea' : 'aron ' + n + ' líneas') + ' en ' + donde + ': revísala' + (n === 1 ? '' : 's') + ' y pulsa ✓'
      : 'No hay líneas que cuadren en ' + donde + ' cerca de esa fecha: usa «elegir…» para buscarlas a mano', n ? 'ok' : 'aviso', 4500);
  };

  const quitarManual = (f) => {
    f.quitada = true; memoria.manuales.delete(f.op.clave);
    if (!f.guardada) filas = filas.filter(x => x !== f);
    recordar(f); pintarTabla(); pintarResumen(); pintarSinPareja();
    toast(f.guardada ? 'Operación manual quitada: se borra al pulsar Guardar' : 'Operación manual quitada', 'ok');
  };

  /** "Crear operación" desde una línea bancaria sin pareja: fila manual con el monto estimado en $ al BCV. */
  const crearManual = (m) => {
    const bs = bsDe(m), lado = bs < 0 ? 'E' : 'S';     // salen Bs del banco -> entraron USDT/$ (compra)
    const usd = r2(Math.abs(usdDe(m)));
    const clave = 'MANUAL|' + (m.fecha || 'sin-fecha') + '|' + m.ref;
    if (filas.some(f => f.op.clave === clave && !f.quitada)) { toast('Ya creaste una operación con esa línea', 'aviso'); return; }
    const op = {
      clave, ref: m.ref, fila: m.fila || 0, fecha: m.fecha || '', fechaTexto: m.fechaTexto || '', descripcion: m.descripcion || 'Operación manual',
      partida: m.partida || '', lado, usdt: usd, tipoSugerido: lado === 'E' ? 'COMPRA' : 'VENTA', bancoSugerido: m.banco || hojaDe(m.ref),
      categoria: categoriaDeClase(m.clase), relevante: true, manual: true,
    };
    memoria.manuales.set(clave, op);
    const f = nuevaFila(op, null);
    f.modo = 'manual'; f.edicion = edicionManual(op); f.bcvSug = 0;
    recalcular(f); f.confirmada = !incompleta(f);
    filas.push(f); ordenar(); recordar(f);
    memoria.filtro = 'todas'; memoria.texto = ''; busq.value = '';
    if (memoria.categoria !== 'todas' && memoria.categoria !== op.categoria) memoria.categoria = 'todas';
    pintarVista();
    if (f.dom && f.dom.usdt) { f.dom.usdt.scrollIntoView({ block: 'center' }); f.dom.usdt.focus(); f.dom.usdt.select(); }
    toast('Operación manual creada: escribe el monto real (USDT o $) y revisa la tasa', 'ok', 5000);
  };

  const autoEmparejar = () => {
    if (!resp) return;
    const lista = filas.filter(f => esActivo(f.op) && !f.quitada && !f.confirmada);
    // las derivadas automáticas se vuelven a derivar después del emparejado para no contar dos veces una línea
    filas = filas.filter(f => !(esDerivada(f.op) && f.modo === 'auto' && !f.guardada && !f.confirmada));
    sugerir(lista);
    derivar(); ordenar();
    lista.forEach(recordar);
    pintarVista();
    const con = lista.filter(f => f.edicion.refs.length).length;
    toast(lista.length ? 'Sugerencias recalculadas: ' + con + ' de ' + lista.length + ' filas sin confirmar tienen pareja en los bancos' : 'No hay filas sin confirmar', 'ok', 4500);
  };

  const guardar = async () => {
    const pend = pendientes();
    if (!pend.length || guardando) return;
    const subir = pend.filter(f => accion(f) === 'guardar'), quitar = pend.filter(f => accion(f) === 'borrar');
    const decisiones = subir.map(decisionDe);
    const borrar = quitar.map(f => f.guardada.clave).concat(subir.filter(f => f.claveAntigua).map(f => f.claveAntigua));
    guardando = true; pintarResumen();
    try {
      await datos.guardarDecisionesBancos(decisiones, borrar);
      subir.forEach((f, i) => { f.guardada = Object.assign({}, decisiones[i]); f.claveAntigua = null; f.bancoElegido = ''; if (f.op.manual) memoria.manuales.delete(f.op.clave); });
      quitar.forEach(f => { f.guardada = null; f.claveAntigua = null; });
      filas = filas.filter(f => !(f.quitada && !f.guardada));
      pend.forEach(recordar);
      const partes = [];
      if (subir.length) partes.push(subir.length === 1 ? '1 decisión guardada' : subir.length + ' decisiones guardadas');
      if (quitar.length) partes.push(quitar.length === 1 ? '1 decisión borrada (vuelve a automático)' : quitar.length + ' decisiones borradas (vuelven a automático)');
      toast(partes.join(' · '), 'ok', 4000);
    } catch (e) { manejarError(e); }
    finally { guardando = false; if (document.body.contains(contenido)) pintarVista(); }
  };

  const descartar = async () => {
    const ok = await confirmar({ titulo: 'Descartar cambios', mensaje: 'Se pierden los cambios que no has guardado: cada fila vuelve a lo guardado o a la sugerencia automática.', textoOk: 'Descartar', peligro: true });
    if (!ok) return;
    olvidarCambios(); construir(); pintarVista();
  };

  // =====================================================================================
  // selector de líneas del banco (modal)
  // =====================================================================================
  const abrirSelector = (f) => {
    if (!resp || excluida(f)) return;
    const op = f.op, e = f.edicion, tipo = e.tipo, u = usdtDe(f), d0 = dia(op.fecha);
    const sel = new Set(e.refs), iniciales = new Set(e.refs);
    const entra = tipo !== 'COMPRA';     // VENTA y PAGO: entran Bs al banco (DEBE); COMPRA: salen (HABER)
    let banco = e.banco || '', dias = 7, ambos = false, txt = '', cerrarSel = () => {};
    // líneas que usa otra fila; no cuentan las de las filas del mismo grupo (operaciones pagadas juntas comparten
    // transferencias) ni las que esta fila ya tenía
    const grupo = new Set((f.sugerencia && Array.isArray(f.sugerencia.grupo)) ? f.sugerencia.grupo : []);
    const usadoPor = new Map();
    vivas().forEach(g => {
      if (g === f || excluida(g) || grupo.has(g.op.clave)) return;
      g.edicion.refs.forEach(r => { if (!iniciales.has(r)) usadoPor.set(r, g); });
    });
    const bcvVivo = () => {
      const movs = [...sel].map(r => idx.get(r)).filter(Boolean), pr = movs.filter(m => m.clase !== 'DIFERENCIAL');
      const fecha = (pr.length ? pr : movs).map(m => m.fecha).filter(Boolean).sort()[0];
      return (f.edicion.tasaBcv !== '' && Number(f.edicion.tasaBcv) > 0 ? Number(f.edicion.tasaBcv) : 0)
        || (fecha ? Number(tasaBcvPara(fecha, tasas, pr.length ? pr : movs)) || 0 : 0) || bcvDe(f);
    };

    const lista = () => {
      const l = (resp.movimientos || []).filter(m => {
        if (sel.has(m.ref)) return true;      // lo marcado siempre se ve, para poder desmarcarlo
        if (hojasActivo.includes(m.banco)) return false;   // las hojas BINANCE / Efectivo $ son la operación, no su pago
        if (banco && m.banco !== banco) return false;
        if (!ambos && !(entra ? Number(m.debeBs) > 0 : Number(m.haberBs) > 0)) return false;
        if (dias && !isNaN(d0)) { const dm = dia(m.fecha); if (isNaN(dm) || Math.abs(dm - d0) > dias) return false; }
        if (txt && ![m.banco, fechaCorta(m.fecha), m.fechaTexto, m.nro, m.descripcion, m.concepto, m.partida, num(Math.abs(bsDe(m)), 2), CLASES[m.clase]].join(' ').toLowerCase().includes(txt)) return false;
        return true;
      });
      return l.sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')) || String(a.banco).localeCompare(String(b.banco)) || (a.fila || 0) - (b.fila || 0));
    };
    const cuerpoSel = el('tbody'), pie = el('div.pie-mov'), cuenta = el('p.mini');
    const pintarPie = () => {
      const refs = [...sel], bcv = bcvVivo(), total = sumaBs(refs, tipo, idx, bcv), ajenas = refs.filter(r => usadoPor.has(r)).length;
      poner(pie,
        el('div', {}, el('b', {}, refs.length + (refs.length === 1 ? ' línea marcada' : ' líneas marcadas')), ' · Total ', el('b', {}, 'Bs ' + num(total, 2)),
          u > 0 && total > 0 ? ' · tasa resultante ' + num(total / u, 4) : '', bcv > 0 && total > 0 ? ' · $ ' + num(total / bcv, 2) + ' al BCV ' + num(bcv, 2) : ''),
        ajenas ? el('div.aviso-inline', {}, (ajenas === 1 ? '1 línea marcada ya está' : ajenas + ' líneas marcadas ya están') + ' en otra operación: al aplicar se quitará' + (ajenas === 1 ? '' : 'n') + ' de allá.') : null);
    };
    const filaMov = (m) => {
      const usado = usadoPor.get(m.ref), usd = usdDe(m);
      const cuadra = u > 0 && Math.abs(Math.abs(usd) - u) / u <= OPCIONES_EMPAREJAR.tolUsd;
      const chk = el('input', { type: 'checkbox', checked: sel.has(m.ref), 'aria-label': 'Usar esta línea' });
      const tr = el('tr', { clase: (usado ? 'usado' : '') + (sel.has(m.ref) ? ' marcada' : '') },
        el('td', {}, chk),
        el('td.izq', {}, m.banco || hojaDe(m.ref)),
        el('td.izq', {}, m.fecha ? fechaCorta(m.fecha) : (m.fechaTexto || '—')),
        el('td.izq', {}, m.nro || ''),
        el('td.izq', { title: m.descripcion || '' }, m.descripcion || '',
          usado ? el('div.uso', {}, 'usado en ' + (usado.op.fecha ? fechaCorta(usado.op.fecha).slice(0, 5) : 'otra fila') + ' · ' + num(usdtDe(usado), 2) + (usado.edicion.categoria === 'usdt' ? ' USDT' : ' $')) : null),
        el('td.izq', {}, m.partida || ''),
        el('td', {}, textoBs(bsDe(m), esDolares(m))),
        el('td', { clase: cuadra ? 'cuadra' : '', title: cuadra ? 'Coincide con el monto de la operación' : '' }, usd ? '$ ' + num(Math.abs(usd), 2) + (cuadra ? ' ≈' : '') : '—'),
        el('td.izq', {}, el('span.estado-chip.clase-' + String(m.clase || 'otro').toLowerCase(), { title: TITULO_CLASE[m.clase] || '' }, CLASES[m.clase] || m.clase || '—')));
      chk.addEventListener('change', () => { if (chk.checked) sel.add(m.ref); else sel.delete(m.ref); tr.classList.toggle('marcada', chk.checked); pintarPie(); });
      tr.addEventListener('click', (ev) => { if (ev.target === chk) return; chk.checked = !chk.checked; chk.dispatchEvent(new Event('change')); });
      return tr;
    };
    const pintarLista = () => {
      const l = lista();
      poner(cuerpoSel, l.length ? l.slice(0, MAX_SELECTOR).map(filaMov)
        : el('tr', {}, el('td', { colspan: '9' }, el('div.vacio', {}, 'No hay líneas con estos filtros. Prueba con más días, «Todos los bancos» o «Ver entradas y salidas».'))));
      cuenta.textContent = l.length > MAX_SELECTOR ? 'Se muestran las primeras ' + MAX_SELECTOR + ' de ' + l.length + ' líneas: usa el buscador para acotar.' : l.length + (l.length === 1 ? ' línea' : ' líneas') + ' · toca una fila para marcarla o desmarcarla';
      pintarPie();
    };

    const aplicar = async () => {
      const refs = [...sel];
      const ajenas = refs.filter(r => usadoPor.has(r));
      if (ajenas.length) {
        const otras = [...new Set(ajenas.map(r => usadoPor.get(r)))];
        const ok = await confirmar({
          titulo: 'Mover líneas a esta operación',
          mensaje: (ajenas.length === 1 ? 'Una línea marcada ya está' : ajenas.length + ' líneas marcadas ya están') + ' en ' + (otras.length === 1 ? 'la operación' : 'las operaciones') + ' '
            + otras.map(g => (g.op.fecha ? fechaCorta(g.op.fecha) : 'sin fecha') + ' · ' + num(usdtDe(g), 2)).join('; ') + '. Si continúas se quitan de allá y esa operación queda por revisar.',
          textoOk: 'Mover aquí',
        });
        if (!ok) return;
        otras.forEach(g => {
          g.edicion.refs = g.edicion.refs.filter(r => !sel.has(r));
          g.edicion.totalBs = '';          // calcularFila lo suma con las líneas que le quedan
          g.modo = 'manual'; g.confirmada = false; g.bancoElegido = ''; g.bcvSug = 0;
          recalcular(g); recordar(g);
        });
      }
      e.refs = refs;
      e.totalBs = '';                      // el total sale de las líneas elegidas (calcularFila, con cuentas en $ al BCV)
      if (refs.length) { const bs = [...new Set(refs.map(r => (idx.get(r) || {}).banco).filter(Boolean))]; if (bs.length === 1) e.banco = bs[0]; }
      f.modo = 'manual'; f.bancoElegido = ''; f.bcvSug = 0;
      recalcular(f); f.confirmada = !incompleta(f); recordar(f);
      cerrarSel();
      pintarTabla(); pintarResumen(); pintarSinPareja();
    };

    const selBanco = el('select', { 'aria-label': 'Banco' }, el('option', { value: '' }, 'Todos los bancos'), bancos.map(b => el('option', { value: b, selected: b === banco }, b)));
    if (banco && !bancos.includes(banco)) selBanco.appendChild(el('option', { value: banco, selected: true }, banco));
    selBanco.addEventListener('change', () => { banco = selBanco.value; pintarLista(); });
    const selDias = el('select', { 'aria-label': 'Días alrededor de la fecha' }, DIAS.map(([v, t]) => el('option', { value: String(v), selected: v === dias }, t)));
    selDias.addEventListener('change', () => { dias = Number(selDias.value); pintarLista(); });
    const chkAmbos = el('input', { type: 'checkbox' });
    chkAmbos.addEventListener('change', () => { ambos = chkAmbos.checked; pintarLista(); });
    const busqSel = el('input', { type: 'search', placeholder: 'Buscar por descripción, Nro, monto…' });
    busqSel.addEventListener('input', () => { txt = busqSel.value.trim().toLowerCase(); pintarLista(); });

    const raiz = el('div.cuerpo-mov', {},
      el('p.mini', {}, el('b', {}, (op.fecha ? fechaCorta(op.fecha) : 'Sin fecha') + ' · ' + tipo + ' · ' + num(u, 2) + (e.categoria === 'usdt' ? ' USDT' : ' $')),
        ' · ' + (op.descripcion || '') + (bcvDe(f) > 0 ? ' · BCV ' + num(bcvDe(f), 2) : '')),
      el('p.mini', {}, entra ? 'Se muestran las ENTRADAS de bolívares (DEBE): en una venta o un cobro entra dinero al banco.' : 'Se muestran las SALIDAS de bolívares (HABER): en una compra o un pago sale dinero del banco.'),
      el('div.filtros', {}, selBanco, selDias, el('label.interruptor.peq', {}, chkAmbos, 'Ver entradas y salidas'), busqSel),
      el('div.lista-mov', {}, el('table.tabla.reporte', {},
        el('thead', {}, el('tr', {}, ['', 'Banco', 'Fecha', 'Nro', 'Descripción', 'Partida', 'Bs', '$ al BCV', 'Clase'].map((t, i) => el('th', { clase: [1, 2, 3, 4, 5, 8].includes(i) ? 'izq' : '' }, t)))),
        cuerpoSel)),
      cuenta, pie,
      el('div.acciones', {},
        el('button.btn.fantasma', { type: 'button', onClick: () => cerrarSel() }, 'Cancelar'),
        el('button.btn.fantasma', { type: 'button', onClick: () => { sel.clear(); pintarLista(); } }, 'Desmarcar todo'),
        el('button.btn', { type: 'button', onClick: () => aplicar() }, icono('ok'), 'Aplicar')));
    modal({ titulo: 'Líneas del banco para esta operación', contenido: (cerrar) => { cerrarSel = cerrar; return raiz; } });
    if (raiz.parentElement) raiz.parentElement.classList.add('selector-mov');
    pintarLista();
    setTimeout(() => busqSel.focus(), 60);
  };

  // =====================================================================================
  // pintado
  // =====================================================================================
  const cuerpo = el('tbody');
  const zona = el('div');
  const lectura = el('div.lectura-dif');
  const resumen = el('div.resumen-dif');
  const avisos = el('div');
  const selVista = el('div.selector');
  const chipsRango = el('div.chips');
  const chipsCategoria = el('div.chips.chips-categoria');
  const chipsFiltro = el('div.chips');
  const iDesde = el('input', { type: 'date' }), iHasta = el('input', { type: 'date' });
  const busq = el('input', { type: 'search', placeholder: 'Buscar por descripción, monto, banco, nota…' });
  const notaHuerfanas = el('p.mini');
  const sinPareja = el('details.plegable');
  const chkSolo = el('input', { type: 'checkbox' });
  const zonaReporte = el('div');
  // botones "?" que se reutilizan al repintar (si se recrearan, la burbuja abierta quedaría huérfana)
  const ayudaCategorias = ayuda('categoriasDiferencial'), ayudaSinPareja = ayuda('movimientosBancarios'), ayudaPdf = ayuda('exportar');

  const enCategoria = (f) => memoria.categoria === 'todas' || f.edicion.categoria === memoria.categoria;
  const pasaTexto = (f) => {
    const t = memoria.texto; if (!t) return true;
    const e = f.edicion;
    return [fechaCorta(f.op.fecha), f.op.fechaTexto, f.op.descripcion, f.op.partida, f.op.ref, num(usdtDe(f), 2), e.banco, e.tipo, e.nota, e.refs.join(' '), etiquetaCategoria(e.categoria)]
      .join(' ').toLowerCase().includes(t);
  };
  const visibles = () => vivas().filter(f => enCategoria(f) && (memoria.filtro === 'todas' || estadoDe(f) === memoria.filtro) && pasaTexto(f));
  const origenDe = (op) => op.manual ? 'manual · ' + (op.bancoSugerido || hojaDe(op.ref))
    : esDerivada(op) ? (op.bancoSugerido || hojaDe(op.ref)) + ' · diferencial' : hojaDe(op.ref) + ' fila ' + (op.fila || '?');
  const asegurarOpcion = (select, v, texto) => { if (v && ![...select.options].some(o => o.value === v)) select.appendChild(el('option', { value: v }, texto || v)); };
  const inputNum = () => el('input.celda', { type: 'text', inputmode: 'decimal', autocomplete: 'off' });

  /** Enter / ↑ / ↓ saltan a la misma columna de la fila anterior o siguiente (como el modo tabulador). */
  const navegarTeclado = (ev, col, nodo) => {
    if (ev.key !== 'Enter' && ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    if (nodo.tagName === 'SELECT' && ev.key !== 'Enter') return;
    ev.preventDefault();
    const lista = [...cuerpo.querySelectorAll(`.celda[data-col="${col}"]`)].filter(x => !x.disabled);
    const destino = lista[lista.indexOf(nodo) + (ev.key === 'ArrowUp' ? -1 : 1)];
    if (destino) { destino.focus(); if (destino.select) destino.select(); }
  };

  /** Pone en un input numérico el valor del modelo ya formateado (al salir de la celda o al cambiar otra). */
  const mostrarValor = (f, col) => {
    const d = f.dom; if (!d) return;
    const c = f.calc || {}, excl = excluida(f);
    if (col === 'totalBs') d.totalBs.value = excl || !(c.totalBs > 0) ? '' : num(c.totalBs, 2);
    else if (col === 'tasaPactada') d.tasaPactada.value = excl || !(c.tasaPactada > 0) ? '' : num(c.tasaPactada, 4);
    else if (col === 'tasaBcv') { const b = bcvDe(f); d.tasaBcv.value = b > 0 ? num(b, 4) : ''; d.tasaBcv.classList.toggle('auto', f.edicion.tasaBcv === ''); }
    else if (col === 'usdt' && d.usdt) d.usdt.value = usdtDe(f) ? num(usdtDe(f), 2) : '';
  };

  /** Actualiza una fila ya pintada sin rehacerla (para no perder el foco de la celda que se está escribiendo). */
  const refrescarFila = (f, excepto) => {
    const d = f.dom; if (!d) return;
    const e = f.edicion, c = f.calc || {}, excl = excluida(f);
    if (excepto !== 'tipo') d.tipo.value = e.tipo;
    if (excepto !== 'categoria') { asegurarOpcion(d.categoria, e.categoria); d.categoria.value = e.categoria; }
    if (excepto !== 'banco') { asegurarOpcion(d.banco, e.banco); d.banco.value = e.banco || ''; }
    ['usdt', 'totalBs', 'tasaPactada', 'tasaBcv'].forEach(col => { if (col !== excepto) mostrarValor(f, col); });
    d.totalBs.disabled = d.tasaPactada.disabled = d.tasaBcv.disabled = excl;
    if (d.usdt) d.usdt.disabled = excl;
    const n = e.refs.length;
    d.btnMov.disabled = excl;
    d.btnMov.className = 'btn-mov' + (!excl && !n ? ' sin-lineas' : '');
    d.btnMov.textContent = excl ? '—' : n ? n + (n === 1 ? ' línea' : ' líneas') + (f.modo === 'auto' && f.sugerencia ? ' · ' + confianzaDe(f) : '') : 'elegir…';
    d.btnMov.title = excl ? 'Fila excluida' : n ? e.refs.join(', ') + ' · clic para revisar o cambiar' : 'Elegir las líneas del banco';
    const difBs = Number(c.difBs) || 0, difUsd = Number(c.difUsd) || 0;
    d.difBs.textContent = excl ? '—' : signo(difBs, 2); d.difBs.className = 'calc ' + (excl ? '' : cl(difBs));
    d.difUsd.textContent = excl ? '—' : signoUsd(difUsd); d.difUsd.className = 'calc ' + (excl ? '' : cl(difUsd));
    const est = estadoDe(f), [clase, texto] = chipDe(f);
    d.chip.className = 'estado-chip ' + clase; d.chip.textContent = texto; d.chip.title = motivoDe(f);
    d.tr.className = ({ CONFIRMADA: 'confirmada', REVISAR: 'revisar', EXCLUIDA: 'excluida', SUGERIDA: 'sugerida' })[est] + (accion(f) ? ' sucia' : '');
    mostrar(d.btnOk, !f.confirmada && !incompleta(f));
    d.btnOk.title = excl ? 'Confirmar que esta fila se excluye' : 'Confirmar esta pareja';
    mostrar(d.marcaOk, f.confirmada && est !== 'REVISAR');
    mostrar(d.btnAuto, !f.op.manual && (esActivo(f.op) || !!f.sugerencia) && (f.modo === 'manual' || !!f.guardada || !!f.bancoElegido));
    mostrar(d.btnQuitar, !!f.op.manual);
  };

  const filaDom = (f, i) => {
    const op = f.op, e = f.edicion;
    const tr = el('tr'); tr.dataset.clave = op.clave;
    const d = f.dom = { tr };
    const celda = (col, nodo) => { nodo.dataset.col = col; nodo.dataset.fila = String(i); nodo.addEventListener('keydown', (ev) => navegarTeclado(ev, col, nodo)); return nodo; };
    const conectarNum = (nodo, col) => { nodo.addEventListener('input', () => editar(f, col, nodo.value)); nodo.addEventListener('blur', () => mostrarValor(f, col)); return nodo; };

    // Orden: lo necesario para decidir primero (hasta Dif. $ cabe a 1000 px), luego banco, líneas, nota y estado.
    const fecha = op.fecha ? fechaCorta(op.fecha) : el('span.negativo', { title: 'El libro tiene una fecha que no se pudo leer' }, op.fechaTexto ? '«' + op.fechaTexto + '»' : 'sin fecha');
    tr.appendChild(el('td.fija', { title: origenDe(op) }, fecha));
    tr.appendChild(el('td', {},
      el('div.desc-dif', { title: op.descripcion || '' }, op.manual ? el('span.etiqueta.manual', {}, 'MANUAL') : null, op.descripcion || '—'),
      el('div.mini.desc-dif', { title: origenDe(op) + ' · Partida: ' + (op.partida || '—') }, origenDe(op) + ' · ' + (op.partida || 'sin partida'))));
    d.tipo = celda('tipo', el('select.celda', { 'aria-label': 'Tipo' }, TIPOS.map(t => el('option', { value: t, selected: t === e.tipo }, t))));
    d.tipo.addEventListener('change', () => editar(f, 'tipo', d.tipo.value));
    tr.appendChild(el('td', {}, d.tipo));
    d.categoria = celda('categoria', el('select.celda', { 'aria-label': 'Categoría' }, CATEGORIAS.map(([k, t]) => el('option', { value: k, selected: k === e.categoria, title: t }, CATEGORIA_CORTA[k] || t))));
    d.categoria.addEventListener('change', () => editar(f, 'categoria', d.categoria.value));
    tr.appendChild(el('td', {}, d.categoria));
    if (usdtEditable(op)) { d.usdt = conectarNum(celda('usdt', inputNum()), 'usdt'); d.usdt.setAttribute('aria-label', 'Monto'); tr.appendChild(el('td', {}, d.usdt)); }
    else tr.appendChild(el('td.num', { title: op.lado === 'E' ? 'Entrada a la cuenta' : 'Salida de la cuenta' }, (op.lado === 'E' ? '↓ ' : '↑ ') + num(op.usdt, 2)));
    d.totalBs = conectarNum(celda('totalBs', inputNum()), 'totalBs');
    d.tasaPactada = conectarNum(celda('tasaPactada', inputNum()), 'tasaPactada');
    d.tasaBcv = conectarNum(celda('tasaBcv', inputNum()), 'tasaBcv');
    d.totalBs.setAttribute('aria-label', 'Total Bs'); d.tasaPactada.setAttribute('aria-label', 'Tasa pactada'); d.tasaBcv.setAttribute('aria-label', 'Tasa BCV');
    tr.appendChild(el('td', {}, d.totalBs)); tr.appendChild(el('td', {}, d.tasaPactada)); tr.appendChild(el('td', {}, d.tasaBcv));
    d.difUsd = el('td.calc'); d.difBs = el('td.calc');
    tr.appendChild(d.difUsd); tr.appendChild(d.difBs);
    d.banco = celda('banco', el('select.celda', { 'aria-label': 'Banco' }, el('option', { value: '' }, '—'), bancos.map(b => el('option', { value: b }, b))));
    d.banco.addEventListener('change', () => cambiarBanco(f, d.banco.value));
    tr.appendChild(el('td', {}, d.banco));
    d.btnMov = el('button.btn-mov', { type: 'button', onClick: () => abrirSelector(f) });
    tr.appendChild(el('td', {}, d.btnMov));
    d.nota = celda('nota', el('input.celda', { type: 'text', maxlength: '200', autocomplete: 'off', placeholder: 'nota…', 'aria-label': 'Nota' }));
    d.nota.value = e.nota || '';
    d.nota.addEventListener('input', () => editar(f, 'nota', d.nota.value));
    tr.appendChild(el('td', {}, d.nota));
    d.chip = el('span.estado-chip');
    d.btnAuto = el('button.btn-icono.peq', { type: 'button', title: 'Volver a la sugerencia automática', 'aria-label': 'Volver a la sugerencia automática', onClick: () => volverAuto(f) }, '↺');
    d.btnQuitar = el('button.btn-icono.peq', { type: 'button', title: 'Quitar esta operación manual', 'aria-label': 'Quitar operación manual', onClick: () => quitarManual(f) }, icono('borrar'));
    tr.appendChild(el('td', {}, el('div.acciones-fila', {}, d.chip, d.btnAuto, d.btnQuitar)));
    // Confirmar: única columna fija a la derecha
    d.btnOk = el('button.btn-ok', { type: 'button', 'aria-label': 'Confirmar', onClick: () => confirmarFila(f) }, '✓');
    d.marcaOk = el('span.marca-ok', { title: 'Confirmada' }, icono('ok'));
    tr.appendChild(el('td.der', {}, d.btnOk, d.marcaOk));
    refrescarFila(f);
    return tr;
  };

  const pintarTabla = () => {
    filas.forEach(f => { f.dom = null; });
    const vis = visibles();
    if (vis.length) poner(cuerpo, vis.map((f, i) => filaDom(f, i)));
    else poner(cuerpo, el('tr', {}, el('td', { colspan: String(COLUMNAS.length) }, el('div.vacio', {},
      vivas().length ? 'Ninguna fila con este filtro.' : 'No hay movimientos en BINANCE, Efectivo $ ni líneas de diferencial en este período.'))));
    notaHuerfanas.textContent = huerfanas ? 'Hay ' + huerfanas + (huerfanas === 1 ? ' decisión guardada' : ' decisiones guardadas') + ' de este período que ya no coincide' + (huerfanas === 1 ? '' : 'n') + ' con ninguna fila del libro (¿se modificó el libro de bancos?).' : '';
  };

  const pintarChips = () => {
    const v = vivas(), porCat = {};
    v.forEach(f => { porCat[f.edicion.categoria] = (porCat[f.edicion.categoria] || 0) + 1; });
    poner(chipsCategoria, el('span.chips-etq', {}, 'Categoría'),
      [['todas', 'Todas']].concat(CATEGORIAS).map(([k, t]) => el('button.chip', { type: 'button', clase: memoria.categoria === k ? 'activo' : '', onClick: () => { memoria.categoria = k; pintarVista(); } },
        t + ' (' + (k === 'todas' ? v.length : porCat[k] || 0) + ')')),
      ayudaCategorias);
    const enCat = v.filter(enCategoria), porEst = {};
    enCat.forEach(f => { const s = estadoDe(f); porEst[s] = (porEst[s] || 0) + 1; });
    poner(chipsFiltro, FILTROS.map(([k, t]) => el('button.chip', { type: 'button', clase: memoria.filtro === k ? 'activo' : '', onClick: () => { memoria.filtro = k; pintarChips(); pintarTabla(); } },
      t + ' (' + (k === 'todas' ? enCat.length : porEst[k] || 0) + ')')));
  };

  const btnLeer = el('button.btn.secundario.peq', { type: 'button', onClick: () => leer(true) }, icono('refrescar'), 'Leer bancos');
  const btnAuto = el('button.btn.secundario.peq', { type: 'button', onClick: () => autoEmparejar() }, icono('lista'), 'Auto-emparejar');
  const grupoAuto = el('span.grupo-dif', {}, btnAuto, ayuda('emparejar'));
  const btnGuardar = el('button.btn.peq', { type: 'button', onClick: () => guardar() }, icono('ok'), 'Guardar');
  const btnDescartar = el('button.btn.fantasma.peq', { type: 'button', onClick: () => descartar() }, 'Descartar cambios');
  const btnPdf = el('button.btn', { type: 'button', onClick: async () => {
    if (!resp) return;
    btnPdf.disabled = true; poner(btnPdf, el('span.spinner'), ' Generando PDF…');
    try { const r = await exportarPdf(generarReporte()); toast(r && r.mensaje ? r.mensaje : 'PDF generado', r && r.ok === false ? 'aviso' : 'ok', 4000); }
    catch (e) { manejarError(e); }
    finally { btnPdf.disabled = false; poner(btnPdf, icono('copiar'), 'Exportar a PDF'); }
  } }, icono('copiar'), 'Exportar a PDF');

  const pintarResumen = () => {
    const enCat = vivas().filter(enCategoria);
    const n = { CONFIRMADA: 0, SUGERIDA: 0, REVISAR: 0, EXCLUIDA: 0 };
    let neto = 0;
    enCat.forEach(f => { const s = estadoDe(f); n[s]++; if (s === 'CONFIRMADA' || s === 'SUGERIDA') neto += Number((f.calc || {}).difUsd) || 0; });
    if (!resp) poner(resumen);
    else poner(resumen,
      el('span', {}, enCat.length + (enCat.length === 1 ? ' operación' : ' operaciones') + (memoria.categoria === 'todas' ? '' : ' de ' + etiquetaCategoria(memoria.categoria))),
      ' · ', el('span.positivo', {}, n.CONFIRMADA + ' confirmadas'), ' · ', n.SUGERIDA + ' sugeridas', ' · ',
      el('span', { clase: n.REVISAR ? 'texto-revisar' : '' }, n.REVISAR + ' por revisar'), ' · ', n.EXCLUIDA + ' excluidas', ' · ',
      el('b', { clase: cl(neto), title: 'Confirmadas + sugeridas, en $ al BCV del día de cada operación' }, 'Dif. neto ' + signoUsd(neto)));
    const p = pendientes().length;
    btnGuardar.disabled = !p || guardando;
    if (guardando) poner(btnGuardar, el('span.spinner.peq'), ' Guardando…');
    else poner(btnGuardar, icono('ok'), p ? 'Guardar (' + p + ')' : 'Guardar');
    mostrar(btnDescartar, p && !guardando);
    pintarChips();
  };

  const pintarLectura = () => {
    btnLeer.disabled = leyendo;
    poner(btnLeer, leyendo ? [el('span.spinner.peq'), ' Leyendo…'] : [icono('refrescar'), 'Leer bancos']);
    if (leyendo) { poner(lectura, el('span.spinner.peq'), ' Leyendo el libro de bancos…'); return; }
    if (!resp) { poner(lectura); return; }
    const lib = resp.libro || {}, hojas = resp.hojasActivo || [resp.hojaUsdt || 'BINANCE'];
    const cuando = haceCuanto(lib.leido || (estado.bancosHora ? new Date(estado.bancosHora).toISOString() : ''));
    poner(lectura, 'Libro «' + (lib.titulo || 'bancos') + '» · ' + hojas.join(' y ') + ' + ' + bancos.length + ' bancos · período ' + textoRango(rangoDatos()) + (cuando ? ' · leído ' + cuando : '') + duracionLectura(resp));
  };

  const pintarAvisos = () => {
    const l = (resp && resp.avisos) || [];
    poner(avisos, l.length ? el('details.plegable.avisos-dif', {},
      el('summary', {}, '⚠ ' + l.length + (l.length === 1 ? ' aviso' : ' avisos') + ' al leer el libro (fechas o montos que no se pudieron leer bien)'),
      el('ul.mini', {}, l.slice(0, 200).map(a => el('li', {}, a)))) : null);
  };

  const pintarSinPareja = () => {
    if (!resp) { poner(sinPareja); return; }
    const usadas = refsUsadas(), auto = new Map(), decididas = [];
    vivas().forEach(f => {
      if (excluida(f)) return;
      if (f.modo === 'auto') auto.set(f.op.clave, { refs: f.edicion.refs.slice(), totalBs: f.edicion.totalBs, confianza: confianzaDe(f) });
      else decididas.push({ clave: f.op.clave, tipo: f.edicion.tipo, refs: f.edicion.refs.slice(), estado: 'CONFIRMADA' });
    });
    let lista = [];
    try { lista = movimientosSinPareja(resp.movimientos || [], auto, decididas, ['BINANCE', 'EFECTIVO']) || []; } catch (e) { manejarError(e); }
    lista = lista.filter(m => !usadas.has(m.ref) && !hojasActivo.includes(m.banco) && enRangoDatos(m.fecha) && (memoria.categoria === 'todas' || categoriaDeClase(m.clase) === memoria.categoria))
      .sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')) || String(a.banco).localeCompare(String(b.banco)));
    const titulo = el('summary', {}, 'Movimientos bancarios sin operación en BINANCE / Efectivo $ (' + lista.length + ')', ayudaSinPareja);
    if (!sinPareja.open) { poner(sinPareja, titulo); return; }
    poner(sinPareja, titulo,
      lista.length ? el('div', { estilo: { overflowX: 'auto' } }, el('table.tabla.reporte', {},
        el('thead', {}, el('tr', {}, ['Banco', 'Fecha', 'Nro', 'Descripción', 'Partida', 'Bs', '$ al BCV', ''].map((t, i) => el('th', { clase: i < 5 ? 'izq' : '' }, t)))),
        el('tbody', {}, lista.slice(0, MAX_SIN_PAREJA).map(m => el('tr', {},
          el('td.izq', {}, m.banco || hojaDe(m.ref)), el('td.izq', {}, m.fecha ? fechaCorta(m.fecha) : (m.fechaTexto || '—')), el('td.izq', {}, m.nro || ''),
          el('td.izq', { title: m.descripcion || '' }, m.descripcion || ''), el('td.izq', {}, m.partida || ''),
          el('td', {}, textoBs(bsDe(m), esDolares(m))), el('td', {}, '$ ' + num(Math.abs(usdDe(m)), 2)),
          el('td', {}, el('button.btn.secundario.peq', { type: 'button', onClick: () => crearManual(m) }, icono('mas'), 'Crear operación')))))))
        : el('div.vacio', {}, 'Todas las líneas BINANCE y de efectivo del período tienen su operación.'),
      lista.length > MAX_SIN_PAREJA ? el('p.mini', {}, 'Se muestran ' + MAX_SIN_PAREJA + ' de ' + lista.length + ' líneas.') : null);
  };
  sinPareja.addEventListener('toggle', () => { memoria.verSinPareja = sinPareja.open; if (sinPareja.open) pintarSinPareja(); });

  /** Filas en la forma que espera reporteDiferencialBancos (con la categoría y el estado que ve el usuario). */
  const generarReporte = () => {
    const r = rangoDatos();
    const lista = vivas().filter(enCategoria).map(f => {
      const estadoFila = estadoDe(f), motivo = motivoDe(f);
      const decision = Object.assign(decisionDe(f), { estado: estadoFila, motivo, confianza: confianzaDe(f) });
      return { op: opDe(f), decision, calculo: f.calc || {}, estado: estadoFila, categoria: f.edicion.categoria, sugerencia: f.sugerencia, motivo };
    });
    return reporteDiferencialBancos(lista, r.desde || '', r.hasta || '', {
      soloConfirmadas: memoria.soloConfirmadas, categoria: memoria.categoria, cartera: estado.cartera,
      libro: resp && resp.libro, resumenPartidas: resp && resp.resumenPartidas, tasas,
    });
  };
  chkSolo.addEventListener('change', () => { memoria.soloConfirmadas = chkSolo.checked; pintarReporte(); });
  const pintarReporte = () => {
    chkSolo.checked = memoria.soloConfirmadas;
    let nodos;
    try { nodos = vistaReporte(generarReporte(), [btnPdf, ayudaPdf]); }
    catch (e) { manejarError(e); nodos = [el('div.vacio', {}, 'No se pudo armar el reporte.')]; }
    poner(zonaReporte, chipsCategoria,
      el('label.interruptor', {}, chkSolo, el('span', {}, 'Solo confirmadas'),
        el('span.mini', {}, memoria.soloConfirmadas ? '· sin las sugerencias automáticas' : '· incluye también las sugerencias automáticas de confianza alta y media')),
      nodos);
  };

  const zonaConciliar = el('div', {},
    chipsCategoria,
    el('div.filtros', {}, chipsFiltro, busq),
    el('p.mini', {}, 'Toca ✓ para aprobar una sugerencia; cualquier cambio en una fila también la aprueba. Tab avanza, Enter baja. ', ayuda('decisionFila')),
    el('div.hoja-contenedor', {}, el('table.hoja.tabla-dif', { estilo: { width: ANCHO_TABLA + 'px' } },
      el('thead', {}, el('tr', {}, COLUMNAS.map(([t, ancho, calc, clase], i) => el(i === 0 ? 'th.fija' : calc ? 'th.calc' : 'th', { clase: clase || '', estilo: { width: ancho + 'px' }, title: t === '✓' ? 'Confirmar' : undefined }, t)))),
      cuerpo)),
    notaHuerfanas,
    sinPareja);
  busq.addEventListener('input', () => { memoria.texto = busq.value.trim().toLowerCase(); pintarTabla(); });

  const pintarSelVista = () => poner(selVista, VISTAS.map(([k, t]) => el('button', { type: 'button', clase: memoria.vista === k ? 'activo' : '', onClick: () => { memoria.vista = k; pintarVista(); } }, t)));

  const vistaError = (e) => {
    const sinAcceso = e.codigo === 'bancos_sin_acceso', sinHoja = e.codigo === 'bancos_sin_hoja_usdt';
    return el('div.vacio', {},
      el('div.titulo-error', {}, sinAcceso ? 'No se pudo abrir el libro de bancos' : sinHoja ? 'El libro de bancos no tiene la hoja BINANCE' : 'No se pudo leer el libro de bancos'),
      el('p', {}, sinAcceso
        ? 'La cuenta de Google que usa el sistema (la del backend) necesita acceso al libro «ADM.-002 BANCOS CPA». Pide a quien administra el libro que lo comparta con esa cuenta (basta con permiso de lector) y luego pulsa «Leer bancos».'
        : sinHoja ? 'Se esperaba una pestaña llamada BINANCE (o que contenga BINANCE o USDT en el nombre). Revisa el libro y pulsa «Leer bancos».'
          : 'Revisa la conexión y pulsa «Leer bancos» para intentarlo de nuevo.'),
      el('p.mini', {}, 'Detalle: ' + (e.message || e)));
  };

  /** Repinta todo según la vista activa. */
  const pintarVista = () => {
    pintarSelVista(); pintarLectura(); pintarAvisos(); pintarResumen();
    mostrar(grupoAuto, memoria.vista === 'conciliar');
    if (errorLibro) { poner(zona, vistaError(errorLibro)); return; }
    if (!resp) { poner(zona, leyendo ? cargando('Leyendo el libro de bancos…') : el('div.vacio', {}, 'Pulsa «Leer bancos» para traer los movimientos del libro de bancos.')); return; }
    if (memoria.vista === 'reporte') { poner(zona, zonaReporte); pintarReporte(); return; }
    zonaConciliar.prepend(chipsCategoria);
    busq.value = memoria.texto;
    sinPareja.open = memoria.verSinPareja;
    poner(zona, zonaConciliar);
    pintarTabla(); pintarSinPareja();
  };

  // =====================================================================================
  // lectura del libro y período
  // =====================================================================================
  const leer = async (forzar) => {
    const n = ++secuencia;
    leyendo = true; pintarLectura();
    if (!resp) pintarVista();
    try {
      const [rb, rd] = await Promise.allSettled([datos.cargarBancos(memoria.desde, memoria.hasta, forzar), datos.cargarDecisionesBancos()]);
      if (n !== secuencia) return;
      if (rb.status === 'rejected') throw rb.reason;
      if (rd.status === 'rejected') manejarError(rd.reason);   // se sigue con las decisiones de la copia local
      errorLibro = null;
      construir();
    } catch (e) {
      if (n !== secuencia) return;
      if (e && /^bancos_/.test(e.codigo || '')) errorLibro = e;
      else { manejarError(e); if (!estado.bancos && !(e && e.codigo === 'sesion_requerida')) errorLibro = e; }
    } finally {
      if (n === secuencia) { leyendo = false; if (document.body.contains(contenido)) pintarVista(); }
    }
  };

  const pintarRango = () => {
    iDesde.value = memoria.desde || ''; iHasta.value = memoria.hasta || '';
    poner(chipsRango, RANGOS.map(([k, t]) => el('button.chip', { type: 'button', clase: memoria.rango === k ? 'activo' : '', onClick: () => aplicarRango(Object.assign({ rango: k }, rangoPredefinido(k))) }, t)));
  };
  const aplicarRango = async (nuevo) => {
    if (nuevo.desde === memoria.desde && nuevo.hasta === memoria.hasta) { memoria.rango = nuevo.rango; pintarRango(); return; }
    const p = pendientes().length;
    if (p) {
      const ok = await confirmar({ titulo: 'Cambios sin guardar', mensaje: 'Tienes ' + p + (p === 1 ? ' cambio' : ' cambios') + ' sin guardar. Si cambias el período se descartan; pulsa «Guardar» antes si quieres conservarlos.', textoOk: 'Cambiar y descartar', peligro: true });
      if (!ok) { pintarRango(); return; }
      olvidarCambios();
    }
    Object.assign(memoria, nuevo);
    pintarRango(); leer(false);
  };
  const alCambiarFecha = () => { clearTimeout(temporizadorRango); temporizadorRango = setTimeout(() => aplicarRango({ rango: '', desde: iDesde.value, hasta: iHasta.value }), 700); };
  iDesde.addEventListener('change', alCambiarFecha); iHasta.addEventListener('change', alCambiarFecha);
  /** Primer ingreso: se arranca con el período de la última lectura guardada (o "Este año"). */
  const iniciarRango = () => {
    if (memoria.desde !== null) return;
    const r = estado.bancosRango;
    if (!r) { Object.assign(memoria, { rango: 'anio' }, rangoPredefinido('anio')); return; }
    memoria.desde = r.desde || ''; memoria.hasta = r.hasta || '';
    memoria.rango = (RANGOS.find(([k]) => { const p = rangoPredefinido(k); return p.desde === memoria.desde && p.hasta === memoria.hasta; }) || [''])[0];
  };

  // =====================================================================================
  // montaje
  // =====================================================================================
  const contenido = el('div.pantalla.ancha.dif', {},
    cabecera('Diferencial desde bancos', 'Diferencial cambiario real según el libro de bancos', el('div', { estilo: { display: 'flex', alignItems: 'center', gap: '6px' } },
      ayuda('diferencialBancos'),
      el('button.btn-icono', { type: 'button', 'aria-label': 'Volver a reportes', title: 'Volver a reportes', onClick: () => navegar('reportes') }, icono('atras')))),
    selVista,
    // período en una sola fila compacta: deja más alto para la tabla
    el('div.periodo-dif', {}, el('span.chips-etq', {}, 'Período'), chipsRango,
      el('label.fecha-dif', {}, 'Desde', iDesde), el('label.fecha-dif', {}, 'Hasta', iHasta), ayuda('rango')),
    el('div.barra-dif', {}, btnLeer, grupoAuto, btnGuardar, btnDescartar),
    lectura, resumen, avisos,
    zona);
  montar(conNavegacion(contenido, 'reportes'));

  definirGuardiaSalida(async () => {
    if (!document.body.contains(contenido)) return true;     // ya no está en pantalla (p. ej. tras el bloqueo)
    const p = pendientes().length;
    if (!p) return true;
    const ok = await confirmar({ titulo: 'Cambios sin guardar', mensaje: 'Tienes ' + p + (p === 1 ? ' cambio' : ' cambios') + ' sin guardar en el diferencial desde bancos. Si sales ahora se pierden.', textoOk: 'Salir sin guardar', peligro: true });
    if (ok) olvidarCambios();
    return ok;
  });

  // Con lectura en memoria se pinta al instante; si no, se intenta la copia local cifrada y luego se lee el libro.
  if (estado.bancos) { iniciarRango(); construir(); }
  pintarRango(); pintarVista();
  (async () => {
    if (!estado.bancos) { try { await datos.restaurarBancosLocal(); } catch (e) { /* sin copia local */ } }
    iniciarRango();
    if (estado.bancos && !resp) construir();
    pintarRango(); pintarVista();
    leer(false);
  })();
}
