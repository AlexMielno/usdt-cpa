/**
 * Conciliación de los activos en dólares (hoja BINANCE = USDT, hoja "Efectivo $") contra el libro de bancos
 * "ADM.-002 BANCOS CPA", y derivación del diferencial cambiario de TODAS las líneas DIFERENCIAL de los bancos
 * (reporte "Diferencial desde bancos", v1.6). Funciones puras: sin DOM, sin red, sin estado global.
 *
 * Flujo recomendado para la pantalla:
 *   const ops = prepararOperaciones(respuesta, { decisiones, desde, hasta });   // activos + derivadas de DIFERENCIAL
 *   const sug = emparejar(ops, respuesta.movimientos, { decisiones, tasas: respuesta.tasas });
 *   const calc = calcularFila(op, decisionOSugerencia, respuesta.tasas, movimientosPorRef);
 *   const rep = reporteDiferencialBancos(filas, desde, hasta, { categoria: 'todas', soloConfirmadas, libro: respuesta.libro });
 *
 * Cómo se arma el libro de bancos (lo que esta lógica asume, visto en la muestra real):
 *  - Una compra de USDT sale del banco como UNA O VARIAS transferencias; cada una se parte en una línea con partida
 *    BINANCE (USDT × BCV) y, a veces, otra con partida DIFERENCIAL CAMBIARIO (lo pagado por encima del BCV). La suma de
 *    los "$" de las líneas BINANCE es igual a los USDT de la operación en la hoja BINANCE.
 *  - Las dos partes de una transferencia suelen compartir el Nro; si no hay Nro (2025) van en filas vecinas con la
 *    misma descripción. Varias operaciones del mismo día pueden pagarse con transferencias que no se reparten una a
 *    una (19/11/2025: 5 compras, 6 transferencias): se concilian como GRUPO a la tasa promedio.
 *  - La partida DIFERENCIAL también se usa para compras de efectivo, proveedores, nómina... Esas líneas, si no quedan
 *    dentro de una operación de los activos, se convierten en operaciones "derivadas" con su categoría.
 *
 * Convención de signos (igual que calculos.js): diferencial POSITIVO = a favor de la empresa, NEGATIVO = en contra.
 *   COMPRA: dif = −(tasaPactada − BCV) × monto      VENTA / PAGO: dif = +(tasaPactada − BCV) × monto
 */
import { redondear } from './calculos.js';
import { num, usd, ves, signo, signoUsd, fechaCorta, nombreMes, mesDe } from './formato.js';

/** Categorías del diferencial: [clave, etiqueta para la pantalla]. */
export const CATEGORIAS = [['usdt', 'USDT (Binance)'], ['efectivo', 'Efectivo $'], ['materia', 'Materia prima y clientes'], ['otros', 'Otros pagos']];
const NOMBRE_CATEGORIA = Object.fromEntries(CATEGORIAS);
const TITULO_CATEGORIA = { usdt: 'USDT (Binance)', efectivo: 'Efectivo $', materia: 'Materia prima y clientes', otros: 'Otros pagos' };

const OPCIONES_DEF = { diasTolerancia: 3, tolUsd: 0.015, diasAmplios: 30 };
const RATIO_MIN = 0.9, RATIO_MAX = 2.5;      // tasa pactada razonable respecto al BCV
const DIAS_CANDIDATOS = 7;                    // ventana de la lista de candidatos para el selector manual
const MAX_POOL = 16, MAX_NODOS = 150000;      // límites de la búsqueda de combinaciones de transferencias
const FILAS_VECINAS = 4, FILAS_MISMA_DESC = 20;
const RATIO_DIF_MIN = 0.8, RATIO_DIF_MAX = 3;   // tasa implícita aceptable (× BCV) al elegir la principal de un diferencial

// ------------------------------------------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------------------------------------------

/** Número desde número o texto es-VE ("$6.264,34", " 1.000,00 ", " - ", ""). Nunca devuelve NaN. */
function aNum(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v === undefined || v === null ? '' : v).replace(/[$\s]|Bs\.?/gi, '');
  if (!s || /^-+$/.test(s)) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const x = parseFloat(s);
  return isFinite(x) ? x : 0;
}
const presente = v => v !== undefined && v !== null && v !== '' && isFinite(aNum(v)) && !(typeof v === 'string' && !v.trim());

/** Mayúsculas, sin acentos, espacios simples. */
function normalizar(s) {
  return String(s === undefined || s === null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}
function diaNum(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN;
}
/** Días entre dos fechas ISO (con signo: b − a). NaN si alguna no es válida. */
function difDias(a, b) { return diaNum(b) - diaNum(a); }
function sumarDias(iso, d) { const x = diaNum(iso); return isNaN(x) ? '' : new Date((x + d) * 86400000).toISOString().slice(0, 10); }
const ddmm = iso => fechaCorta(iso).slice(0, 5);
const plural = (n, uno, varios) => n + ' ' + (n === 1 ? uno : varios);
const leer = (cont, k) => (cont instanceof Map ? cont.get(k) : cont ? cont[k] : undefined);

/** Clase del movimiento según el backend; si no viene, se deduce de la partida y la descripción. */
function claseDe(m) {
  const c = normalizar(m && m.clase);
  if (c) return c;
  const p = normalizar(m && m.partida), d = normalizar(m && m.descripcion) + ' ' + normalizar(m && m.concepto);
  if (p.includes('BINANCE')) return 'BINANCE';
  if (/EFECTIVO (DOLARES|\$|USD)/.test(p)) return 'EFECTIVO';
  if (p.includes('DIFERENCIAL')) return 'DIFERENCIAL';
  if (/USDT|USTD|BINANCE/.test(d)) return 'OTRO';
  return 'VECINA';
}

/** Descripciones "iguales": idénticas, una contenida en la otra o con un prefijo común largo ("…COMPRA USDT 1" / "…USDT 2"). */
function similares(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const corta = Math.min(a.length, b.length), larga = Math.max(a.length, b.length);
  if (corta >= 10 && (a.includes(b) || b.includes(a))) return true;
  let i = 0; while (i < corta && a[i] === b[i]) i++;
  return corta >= 8 && i / larga >= 0.85;
}

/** Junta refs de: Set, array de refs, array de objetos con refs, Map/objeto de sugerencias. */
function refsDe(x) {
  const out = [];
  const tomar = v => {
    if (!v) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v.refs)) v.refs.forEach(r => { if (r) out.push(String(r)); });
  };
  if (!x) return out;
  if (x instanceof Set) x.forEach(tomar);
  else if (x instanceof Map) x.forEach(tomar);
  else if (Array.isArray(x)) x.forEach(tomar);
  else if (typeof x === 'object') Object.values(x).forEach(tomar);
  return out;
}

/**
 * Clave estable de una decisión. Las claves de v1.6 inicial no tenían prefijo de hoja ('2026-01-03|E|2591.55|#1'):
 * se leen como de la hoja BINANCE.
 */
export function normalizarClave(clave) {
  const c = String(clave || '');
  if (/^(\d{4}-\d{2}-\d{2})?\|[ES]\|/.test(c)) return 'BINANCE|' + c;
  return c;
}

// ------------------------------------------------------------------------------------------------
// Bancos y categorías
// ------------------------------------------------------------------------------------------------

const SINONIMOS = [
  [/PROVINCIAL/, 'BBVA'], [/\bBDV\b/, 'VENEZUELA'], [/PLUS/, 'BPLUS'],
  [/EFECTIVO (DOLARES|\$|USD)/, 'EFECTIVO $'], [/EFECTIVO (BOL|BS)|\bBSS\b/, 'EFECTIVO BSS'],
];
function nombreBanco(s) { return normalizar(s).replace(/\bBANCO\b|\bBCO\b/g, ' ').replace(/\s+/g, ' ').trim(); }

/** Nombre de la hoja (de `nombres`) a la que se refiere una partida, o ''. */
function resolverBanco(partida, nombres) {
  const p = nombreBanco(partida);
  if (!p) return '';
  const lista = (nombres || []).map(b => [b, nombreBanco(b)]).filter(([, nb]) => nb);
  for (const [re, destino] of SINONIMOS) {
    if (re.test(p)) { const hit = lista.find(([, nb]) => nb === destino); if (hit) return hit[0]; }
  }
  const exacto = lista.find(([, nb]) => nb === p);
  if (exacto) return exacto[0];
  const pal = ' ' + p + ' ';
  const cont = lista.find(([, nb]) => nb.length >= 3 && (pal.includes(' ' + nb + ' ') || (' ' + nb + ' ').includes(pal)));
  return cont ? cont[0] : '';
}

/** Partidas que son traslados entre cuentas propias (nunca son la "línea principal" de un diferencial). */
function esTraslado(partida, bancos) {
  const p = normalizar(partida);
  // EFECTIVO DOLARES es el activo de la categoría "efectivo" (el backend lista "Efectivo $" entre los bancos): sí puede ser principal
  if (/EFECTIVO/.test(p)) return false;
  return /^(BANCO\b|BANESCO|BANPLUS|BNC\b|BBVA|PROVINCIAL|MERCANTIL$|VENEZUELA$)/.test(p) || !!resolverBanco(partida, bancos);
}
/** Partidas que nunca son la línea principal de un diferencial: comisiones, IGTF, intereses, traslados entre cuentas. */
function noEsPrincipal(partida, bancos) {
  return /COMISION|IGTF|INTERES|TRASLADO|ENTRE CUENTAS/.test(normalizar(partida)) || esTraslado(partida, bancos);
}

/**
 * Categoría del diferencial según la partida de la línea principal (§6.1):
 * BINANCE → usdt; EFECTIVO DOLARES → efectivo; materia prima, compras, inventario, cuentas por cobrar comerciales,
 * ventas y anticipos de clientes → materia; cualquier otra → otros.
 */
export function categoriaDePartida(partida) {
  const p = normalizar(partida);
  if (!p) return 'otros';
  if (/BINANCE|USDT|USTD/.test(p)) return 'usdt';
  if (/EFECTIVO (DOLARES|\$|USD)/.test(p)) return 'efectivo';
  if (/MATERIA|^COMPRAS?\b|INVENTARIO|CUENTAS POR COBRAR COMERCIAL|^CXC COMERCIAL|^VENTAS?\b|ANTICIPOS? (DE )?CLIENTES?/.test(p)) return 'materia';
  return 'otros';
}
function categoriaDeHoja(hoja) { return /EFECTIVO/.test(normalizar(hoja)) ? 'efectivo' : 'usdt'; }
function categoriaDeLinea(x) { return x.clase === 'BINANCE' ? 'usdt' : x.clase === 'EFECTIVO' ? 'efectivo' : categoriaDePartida(x.m.partida); }
const unidadDe = categoria => (categoria === 'usdt' || !categoria ? 'USDT' : '$');

// ------------------------------------------------------------------------------------------------
// Movimientos: índice interno
// ------------------------------------------------------------------------------------------------

function infoMov(m) {
  const tasa = aNum(m.tasa);
  const dolares = Math.abs(tasa - 1) < 1e-9;   // cuentas en dólares (Efectivo $, CRUCE): tasa 1, montos en $
  const haber = Math.max(0, aNum(m.haberBs)), debe = Math.max(0, aNum(m.debeBs));
  const usdH = aNum(m.haberUsd) > 0 ? aNum(m.haberUsd) : (dolares ? haber : tasa > 0 ? haber / tasa : 0);
  const usdD = aNum(m.debeUsd) > 0 ? aNum(m.debeUsd) : (dolares ? debe : tasa > 0 ? debe / tasa : 0);
  let nro = String(m.nroNorm !== undefined && m.nroNorm !== null && m.nroNorm !== '' ? m.nroNorm : (m.nro === undefined || m.nro === null ? '' : m.nro)).replace(/\s+/g, '');
  if (/^0*$/.test(nro)) nro = '';
  const ref = String(m.ref || ((m.banco || '') + '!' + (m.fila || '')));
  return {
    m, ref, banco: String(m.banco || ref.split('!')[0]), fila: Number(m.fila) || 0, fecha: String(m.fecha || '').slice(0, 10),
    nro, clase: claseDe(m), desc: normalizar(m.descripcion), tasa, dolares, haber, debe, usdH, usdD,
  };
}
const bsLado = (x, lado) => (lado === 'H' ? x.haber : x.debe);
const usdLado = (x, lado) => (lado === 'H' ? x.usdH : x.usdD);
/** Lado del banco que corresponde a la operación: entra el activo (compra) → salen Bs (HABER); sale el activo → entran Bs (DEBE). */
const ladoMov = op => (op.lado === 'E' ? 'H' : 'D');
const tolExacta = monto => Math.max(0.05, monto * 0.0005);

function indexar(movimientos) {
  const lista = (Array.isArray(movimientos) ? movimientos : []).filter(m => m && typeof m === 'object').map(infoMov);
  const porRef = new Map(), porBancoFila = new Map(), porFecha = new Map(), porBancoNro = new Map(), nrosNoDif = new Set(), bancos = new Set();
  const agregar = (mapa, k, x) => { if (!mapa.has(k)) mapa.set(k, []); mapa.get(k).push(x); };
  lista.forEach(x => {
    porRef.set(x.ref, x);
    bancos.add(x.banco);
    if (!porBancoFila.has(x.banco)) porBancoFila.set(x.banco, new Map());
    porBancoFila.get(x.banco).set(x.fila, x);
    if (x.fecha) agregar(porFecha, x.fecha, x);
    if (x.nro) agregar(porBancoNro, x.banco + '|' + x.nro, x);
    if (x.nro && x.clase !== 'DIFERENCIAL') nrosNoDif.add(x.banco + '|' + x.nro);
  });
  return { lista, porRef, porBancoFila, porFecha, porBancoNro, nrosNoDif, bancos: [...bancos] };
}
/** Movimientos con fecha a ± dias de `fecha` (usa el índice por día; no recorre toda la lista). */
function cercanos(idx, fecha, dias) {
  const out = [];
  if (!fecha || isNaN(diaNum(fecha))) return out;
  for (let k = -dias; k <= dias; k++) { const xs = idx.porFecha.get(sumarDias(fecha, k)); if (xs) for (const x of xs) out.push(x); }
  return out;
}
/** Línea DIFERENCIAL "huérfana": sin Nro, o con un Nro que no comparte con ninguna línea que no sea DIFERENCIAL. */
const huerfana = (idx, d) => !d.nro || !idx.nrosNoDif.has(d.banco + '|' + d.nro);

/** Posibles líneas principales de una línea DIFERENCIAL: misma hoja, ±4 filas, misma fecha, mismo lado, no DIFERENCIAL. */
function vecinasDe(idx, d, lado) {
  const mapa = idx.porBancoFila.get(d.banco);
  const res = [];
  if (!mapa || !d.fila) return res;
  for (let k = -FILAS_VECINAS; k <= FILAS_VECINAS; k++) {
    if (!k) continue;
    const x = mapa.get(d.fila + k);
    if (!x || x.clase === 'DIFERENCIAL' || x.fecha !== d.fecha || !(bsLado(x, lado) > 0)) continue;
    res.push({ x, dist: Math.abs(k), antes: k < 0 ? 1 : 0, similar: similares(x.desc, d.desc) ? 1 : 0, traslado: noEsPrincipal(x.m.partida, idx.bancos) ? 1 : 0 });
  }
  // primero la de descripción parecida; si ninguna se parece (el diferencial suele decir otro nombre) decide la distancia;
  // las que no pueden ser principal (traslados, comisiones, IGTF, intereses: marcadas `traslado`) van al final
  res.sort((a, b) => (a.traslado - b.traslado) || (b.similar - a.similar) || (a.dist - b.dist) || (b.antes - a.antes));
  return res;
}

// ------------------------------------------------------------------------------------------------
// 3.1 / 6.3  Operaciones
// ------------------------------------------------------------------------------------------------

function opsDeActivos(r) {
  const bancos = (Array.isArray(r.bancos) ? r.bancos : []).map(String);
  let activos = r.activos && typeof r.activos === 'object' ? r.activos : null;
  let hojas;
  if (activos) {
    hojas = Array.isArray(r.hojasActivo) && r.hojasActivo.length ? r.hojasActivo.filter(h => Array.isArray(activos[h])) : [];
    Object.keys(activos).forEach(h => { if (Array.isArray(activos[h]) && !hojas.includes(h)) hojas.push(h); });
  } else {
    hojas = [r.hojaUsdt || 'BINANCE'];
    activos = { [hojas[0]]: Array.isArray(r.usdt) ? r.usdt : [] };
  }
  const ops = [];
  hojas.forEach(hoja => {
    const categoria = categoriaDeHoja(hoja);
    const otrosActivos = hojas.filter(h => h !== hoja);
    const nombres = bancos.filter(b => b !== hoja).concat(otrosActivos.filter(h => !bancos.includes(h)));
    const cuenta = {};
    activos[hoja].slice().sort((a, b) => (Number(a.fila) || 0) - (Number(b.fila) || 0)).forEach(u => {
      const entrada = aNum(u.entrada), salida = aNum(u.salida);
      if (!(entrada > 0) && !(salida > 0)) return;
      const lado = entrada > 0 ? 'E' : 'S';
      const monto = redondear(lado === 'E' ? entrada : salida, 4);
      const fecha = String(u.fecha || '').slice(0, 10);
      const base = fecha + '|' + lado + '|' + monto.toFixed(2);
      cuenta[base] = (cuenta[base] || 0) + 1;
      const pN = normalizar(u.partida);
      const texto = normalizar(u.descripcion) + ' ' + normalizar(u.concepto);
      let banco = '', intercambio = false;
      if (pN.includes('BINANCE') || (categoria !== 'usdt' && /USDT|USTD/.test(pN))) {
        intercambio = categoria !== 'usdt';            // efectivo contra USDT: no pasa por bolívares
      } else {
        const b = resolverBanco(u.partida, nombres);
        if (b && otrosActivos.includes(b)) intercambio = true;   // USDT contra efectivo $
        else banco = b;
      }
      // efectivo sin banco y sin contrapartida propia ("ENTREGADO A … PARA COMPRA USDT", partida EFECTIVO DOLARES): cambio por USDT
      const partidaPropia = !pN || /EFECTIVO (DOLARES|\$|USD)/.test(pN);
      if (!banco && !intercambio && categoria !== 'usdt' && partidaPropia && /USDT|USTD|BINANCE/.test(texto)) intercambio = true;
      const relevante = !intercambio && (!!banco || (categoria === 'usdt' ? /USDT|USTD|COMPRA|VENTA/ : /COMPRA|VENTA|DIVISA|CAMBIO/).test(texto));
      const tipoSugerido = lado === 'E' ? 'COMPRA' : (banco || /VENTA/.test(texto) ? 'VENTA' : 'PAGO');
      let nota = '';
      if (intercambio) nota = 'Cambio entre USDT y dólares en efectivo: no pasa por bolívares y no genera diferencial; queda excluida.';
      else if (!relevante) nota = 'No parece compra ni venta' + (u.partida ? ' (partida «' + String(u.partida).trim() + '»)' : '') + ': queda excluida. Si fue un pago con ' + (categoria === 'usdt' ? 'USDT' : 'dólares') + ', cámbiala a PAGO y escribe el valor de la factura en Bs.';
      ops.push({
        clave: hoja + '|' + base + '|#' + cuenta[base], hoja, categoria, derivada: false,
        ref: String(u.ref || hoja + '!' + u.fila), fila: Number(u.fila) || 0, fecha, fechaTexto: u.fechaTexto === undefined ? '' : String(u.fechaTexto),
        descripcion: String(u.descripcion || '').trim(), concepto: String(u.concepto || '').trim(), partida: String(u.partida || '').trim(),
        lado, usdt: monto, tipoSugerido, bancoSugerido: banco, relevante, intercambio, nota,
      });
    });
  });
  return ops;
}

/**
 * Operaciones de TODAS las categorías: una por fila de cada hoja de activo (BINANCE → 'usdt', Efectivo $ → 'efectivo')
 * más las derivadas de las líneas DIFERENCIAL que no quedan dentro de ninguna operación de activo.
 * Para eso empareja primero los activos (así ninguna línea DIFERENCIAL cuenta dos veces) y luego deriva.
 *
 * `opciones` (opcional): { decisiones, desde, hasta, diasTolerancia, tolUsd }. Con `decisiones` (las guardadas) las
 * líneas que el usuario ya asignó no se derivan; con `desde`/`hasta` solo se devuelven derivadas dentro del rango
 * (los movimientos llegan con ± margen).
 *
 * Cada op: { clave, hoja, categoria, derivada, ref, fila, fecha, fechaTexto, descripcion, concepto, partida, lado: 'E'|'S',
 *            usdt (monto en USDT o $), tipoSugerido, bancoSugerido, relevante, intercambio?, nota?, sugerencia? (derivadas) }
 */
export function prepararOperaciones(respuestaBancos, opciones) {
  const r = respuestaBancos || {};
  const opc = { tasas: r.tasas, ...(opciones || {}) };
  const activos = opsDeActivos(r);
  const movs = Array.isArray(r.movimientos) ? r.movimientos : [];
  if (!movs.some(m => m && claseDe(m) === 'DIFERENCIAL')) return activos;
  const sug = emparejar(activos, movs, opc);
  const usadas = new Set(refsDe(sug));
  refsDe(opc.decisiones).forEach(x => usadas.add(x));
  let derivadas = derivarDeDiferenciales(movs, usadas);
  if (opc.desde || opc.hasta) derivadas = derivadas.filter(o => !o.fecha || ((!opc.desde || o.fecha >= opc.desde) && (!opc.hasta || o.fecha <= opc.hasta)));
  return activos.concat(derivadas);
}

/**
 * Ops derivadas de las líneas DIFERENCIAL no usadas (§6.3). Cada línea busca su principal: mismo Nro en la misma
 * hoja (clase ≠ DIFERENCIAL, mismo lado); si no, una vecina (±4 filas, misma fecha y lado; primero la de descripción
 * parecida, luego una que no haya tomado otro diferencial, luego la más cercana). Las líneas DIFERENCIAL con la misma
 * principal forman UNA op. Nunca son principal: comisiones, IGTF, intereses ni traslados entre cuentas; y se descarta
 * toda candidata con la que la tasa implícita ((Bs principal + Bs diferencial) / $ principal) quede fuera de 0,8× a 3×
 * el BCV de la línea. Si el Nro señala la transferencia pero no cuadra, no se busca otra vecina; una principal que ya
 * tiene su diferencial por Nro no acepta diferenciales vecinos. Si ninguna sirve, la op queda sin principal (monto 0,
 * confianza «sin») y el motivo dice qué línea se descartó y por qué.
 * Op: { clave: 'DIF|banco|fecha|bs|#n', categoria, tipoSugerido COMPRA (HABER) / VENTA (DEBE), usdt = $ de la principal,
 *       descripcion: principal · diferencial, sugerencia: { refs, totalBs, tasaPactada, confianza, motivo, ... } }.
 * Sin principal: usdt 0, totalBs = Bs del diferencial, confianza 'sin' (el usuario puede escribir el monto en $).
 * `usadas`: refs ya tomadas (Set, array, Map de sugerencias o lista de decisiones).
 */
export function derivarDeDiferenciales(movimientos, usadas) {
  const idx = movimientos && movimientos.lista && movimientos.porRef ? movimientos : indexar(movimientos);
  const usad = new Set(refsDe(usadas));
  const difs = idx.lista.filter(x => x.clase === 'DIFERENCIAL' && (x.haber > 0 || x.debe > 0))
    .sort((a, b) => a.banco.localeCompare(b.banco) || a.fila - b.fila);
  // clave estable de cada línea DIFERENCIAL (no depende de cuáles estén usadas)
  const claveDif = new Map(), cuenta = {};
  difs.forEach(d => {
    const lado = d.haber > 0 ? 'H' : 'D';
    const base = 'DIF|' + d.banco + '|' + d.fecha + '|' + bsLado(d, lado).toFixed(2);
    cuenta[base] = (cuenta[base] || 0) + 1;
    claveDif.set(d.ref, base + '|#' + cuenta[base]);
  });
  const grupos = new Map();
  const tomadas = new Set();     // principales ya elegidas por otra línea DIFERENCIAL (se prefiere una libre parecida)
  const completas = new Set();   // principales con su propio diferencial por Nro: no aceptan diferenciales vecinos
  // primero los diferenciales que comparten Nro con alguna línea: así ya se sabe qué transferencias están completas
  const conNro = d => !!d.nro && (idx.porBancoNro.get(d.banco + '|' + d.nro) || []).some(x => x.clase !== 'DIFERENCIAL');
  const orden = difs.filter(conNro).concat(difs.filter(d => !conNro(d)));
  const acumulado = new Map();   // principal(es) → Bs de diferencial ya asignados (la tasa se mide con todo el grupo)
  const llaveDe = (prs, lado) => prs.map(x => x.ref).sort().join(',') + '|' + lado;
  /** Tasa implícita (× BCV de la línea) si `prs` fueran la principal de `bsDif` Bs de diferencial; null si no hay BCV. */
  const ratioCon = (prs, bsDif, lado) => {
    const usdP = prs.reduce((s, x) => s + usdLado(x, lado), 0);
    if (!(usdP > 0)) return Infinity;
    const bcv = prs[0].dolares ? 1 : prs[0].tasa > 0 ? prs[0].tasa : 0;
    if (!(bcv > 0)) return null;
    return (prs.reduce((s, x) => s + bsLado(x, lado), 0) + bsDif) / usdP / bcv;
  };
  const plausible = r => r === null || (r >= RATIO_DIF_MIN && r <= RATIO_DIF_MAX);
  orden.forEach(d => {
    if (usad.has(d.ref)) return;
    const lado = d.haber > 0 ? 'H' : 'D';
    const bsD = bsLado(d, lado);
    const conAcum = prs => (acumulado.get(llaveDe(prs, lado)) || 0) + bsD;
    let modo = 'ninguna', principales = [], usadaPor = null, candidatos = [];
    const rechazos = [];   // candidatas descartadas, para explicarle al usuario por qué quedó sin principal
    if (d.nro) {
      const mismos = (idx.porBancoNro.get(d.banco + '|' + d.nro) || []).filter(x => x.clase !== 'DIFERENCIAL' && bsLado(x, lado) > 0);
      candidatos = mismos.map(x => x.ref);
      mismos.filter(x => noEsPrincipal(x.m.partida, idx.bancos)).forEach(x => rechazos.push({ x, razon: 'partida', nro: true }));
      const validos = mismos.filter(x => !noEsPrincipal(x.m.partida, idx.bancos));
      const libres = validos.filter(x => !usad.has(x.ref));
      if (libres.length) {
        const r = ratioCon(libres, conAcum(libres), lado);
        if (plausible(r)) { modo = 'nro'; principales = libres; libres.forEach(x => completas.add(x.ref)); }
        else { modo = 'rechazada'; rechazos.unshift({ x: libres[0], razon: 'tasa', ratio: r, nro: true }); }
      } else if (validos.length) { modo = 'usada'; usadaPor = validos[0]; }
    }
    // si el Nro señala la transferencia y no cuadra, no se busca otra vecina (tendría otro Nro: sería otra operación)
    if (modo === 'ninguna') {
      // la mejor vecina que pueda ser principal y dé una tasa razonable; si ya pertenece a una operación, el diferencial
      // es de esa operación (dos transferencias VENPACK seguidas, cada una con su diferencial: cada una toma la suya)
      const vec = vecinasDe(idx, d, lado);
      candidatos = candidatos.concat(vec.map(v => v.x.ref));
      vec.filter(v => v.traslado).forEach(v => rechazos.push({ x: v.x, razon: 'partida', dist: v.dist }));
      vec.filter(v => !v.traslado && completas.has(v.x.ref)).forEach(v => rechazos.push({ x: v.x, razon: 'completa', dist: v.dist }));
      const utiles = vec.filter(v => !v.traslado && !completas.has(v.x.ref))
        .sort((a, b) => (b.similar - a.similar) || (tomadas.has(a.x.ref) - tomadas.has(b.x.ref)) || (a.dist - b.dist) || (b.antes - a.antes));
      for (const v of utiles) {
        const usadaYa = usad.has(v.x.ref);
        const r = ratioCon([v.x], usadaYa ? bsD : conAcum([v.x]), lado);
        if (!plausible(r)) { rechazos.push({ x: v.x, razon: 'tasa', ratio: r, dist: v.dist }); continue; }
        if (usadaYa) { modo = 'usada'; usadaPor = v.x; } else { modo = 'vecina'; principales = [v.x]; }
        break;
      }
    }
    // explicación: primero lo que dijo el Nro; si no, la vecina descartada más cercana
    const rechazo = (modo === 'ninguna' || modo === 'rechazada') && rechazos.length
      ? (rechazos.find(z => z.nro) || rechazos.slice().sort((a, b) => (a.dist || 0) - (b.dist || 0))[0]) : null;
    principales.forEach(x => tomadas.add(x.ref));
    if (principales.length) acumulado.set(llaveDe(principales, lado), conAcum(principales));
    const llave = principales.length ? llaveDe(principales, lado) : 'solo|' + d.ref;
    if (!grupos.has(llave)) grupos.set(llave, { difs: [], principales, modo, usadaPor, rechazo, lado, candidatos: new Set() });
    const g = grupos.get(llave);
    g.difs.push(d);
    candidatos.forEach(c => g.candidatos.add(c));
  });
  const ops = [];
  grupos.forEach(g => {
    g.difs.sort((a, b) => a.fila - b.fila);   // la clave del grupo es la de su primera línea DIFERENCIAL (estable)
    const d0 = g.difs[0], lado = g.lado;
    const pr = g.principales;
    const usdP = pr.reduce((s, x) => s + usdLado(x, lado), 0);
    const bsP = pr.reduce((s, x) => s + bsLado(x, lado), 0), bsD = g.difs.reduce((s, x) => s + bsLado(x, lado), 0);
    const dolares = pr.concat(g.difs).some(x => x.dolares);
    const totalBs = dolares ? null : redondear(bsP + bsD, 2);
    const mayor = pr.slice().sort((a, b) => bsLado(b, lado) - bsLado(a, lado))[0];
    // sin principal: si el Nro señaló una línea (aunque no cuadre), su partida sigue diciendo la categoría
    const categoria = mayor ? categoriaDeLinea(mayor) : g.usadaPor ? categoriaDeLinea(g.usadaPor)
      : g.rechazo && g.rechazo.nro && g.rechazo.razon === 'tasa' ? categoriaDeLinea(g.rechazo.x) : 'otros';
    const confianza = g.modo === 'nro' ? 'alta' : g.modo === 'vecina' ? 'media' : g.modo === 'usada' ? 'baja' : 'sin';
    const tipo = lado === 'H' ? 'COMPRA' : 'VENTA';
    const descP = mayor ? String(mayor.m.descripcion || '').trim() : '';
    const descD = String(d0.m.descripcion || '').trim();
    const montoDif = (dolares ? usd(bsD) : ves(bsD));
    const nDifs = g.difs.length > 1 ? ' (' + g.difs.length + ' líneas)' : '';
    let motivo;
    if (g.modo === 'nro') motivo = 'Diferencial de ' + d0.banco + ' del ' + ddmm(d0.fecha) + nDifs + ' con su línea principal «' + (descP || 'sin descripción') + '» (' + String(mayor.m.partida || '').trim() + ') de la misma referencia ' + d0.nro + '.';
    else if (g.modo === 'vecina') motivo = 'Diferencial de ' + d0.banco + ' del ' + ddmm(d0.fecha) + nDifs + ' emparejado por cercanía de fila con «' + (descP || 'sin descripción') + '» (' + String(mayor.m.partida || '').trim() + '); no comparten referencia, revisa.';
    else if (g.modo === 'usada') motivo = 'Su línea principal («' + (String(g.usadaPor.m.descripcion || '').trim() || g.usadaPor.ref) + '») ya está en otra operación: se cuenta solo el diferencial (' + montoDif + '). Revisa si es parte de esa operación.';
    else if (g.rechazo) {
      const z = g.rechazo, zx = z.x;
      const quien = (z.nro ? 'La línea con la misma referencia' : 'La línea vecina más cercana') + ' («' + (String(zx.m.descripcion || '').trim() || 'sin descripción')
        + '», partida ' + (String(zx.m.partida || '').trim() || '—') + ', ' + num(usdLado(zx, lado)) + ' $)';
      const porque = z.razon === 'partida' ? 'las comisiones, el IGTF, los intereses y los traslados entre cuentas no son la operación'
        : z.razon === 'completa' ? 'ya tiene su propio diferencial con la misma referencia'
        : 'daría una tasa de ' + (isFinite(z.ratio) ? num(z.ratio) + ' veces el BCV' : 'valor infinito') + ' (lo razonable es de ' + num(RATIO_DIF_MIN, 1) + ' a ' + num(RATIO_DIF_MAX, 0) + ' veces)';
      motivo = quien + ' no cuadra como principal: ' + porque + '. Se cuenta solo el diferencial (' + montoDif + '); si conoces el monto en $, escríbelo.';
    } else motivo = 'No se encontró la línea principal (misma referencia o fila vecina): se cuenta solo el diferencial (' + montoDif + '). Si conoces el monto en $, escríbelo.';
    const refs = pr.map(x => x.ref).concat(g.difs.map(x => x.ref));
    const monto = redondear(usdP, 4);
    const sugerencia = {
      refs, totalBs: pr.length ? totalBs : (dolares ? null : redondear(bsD, 2)), tasaPactada: pr.length && totalBs !== null && monto > 0 ? redondear(totalBs / monto, 4) : 0,
      tipo, confianza, motivo, candidatos: [...g.candidatos].filter(c => !refs.includes(c)), banco: d0.banco, categoria, derivada: true,
    };
    ops.push({
      clave: claveDif.get(d0.ref), hoja: d0.banco, categoria, derivada: true, ref: d0.ref, fila: d0.fila,
      fecha: (mayor && mayor.fecha) || d0.fecha, fechaTexto: String(d0.m.fechaTexto || ''),
      descripcion: [descP, descD].filter(Boolean).join(' · '), concepto: String(d0.m.concepto || '').trim(),
      partida: mayor ? String(mayor.m.partida || '').trim() : String(d0.m.partida || '').trim(),
      lado: lado === 'H' ? 'E' : 'S', usdt: pr.length ? monto : 0, tipoSugerido: tipo, bancoSugerido: d0.banco, relevante: true, sugerencia,
    });
  });
  return ops.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '') || a.hoja.localeCompare(b.hoja) || a.fila - b.fila);
}

// ------------------------------------------------------------------------------------------------
// 3.2  Emparejar
// ------------------------------------------------------------------------------------------------

/** Mejor combinación (≥ minLineas) de líneas cuyo monto en $ suma `objetivo` ± tol. Prefiere menor diferencia, luego menos días. */
function mejorSubconjunto(pool, objetivo, tol, lado, fechaRef, minLineas) {
  const items = pool.map(x => ({ x, v: usdLado(x, lado), d: Math.abs(difDias(fechaRef, x.fecha)) || 0 }))
    .filter(i => i.v > 0).sort((a, b) => (a.d - b.d) || (b.v - a.v)).slice(0, MAX_POOL).sort((a, b) => b.v - a.v);
  const k = items.length;
  if (k < minLineas) return null;
  const sufijo = new Array(k + 1).fill(0);
  for (let i = k - 1; i >= 0; i--) sufijo[i] = sufijo[i + 1] + items[i].v;
  let mejor = null, nodos = 0;
  const sel = [];
  const dfs = (i, suma, dias) => {
    if (++nodos > MAX_NODOS) return;
    const diff = Math.abs(suma - objetivo);
    if (sel.length >= minLineas && diff <= tol) {
      const cubeta = Math.round(diff / 0.05);
      if (!mejor || cubeta < mejor.cubeta || (cubeta === mejor.cubeta && (dias < mejor.dias || (dias === mejor.dias && sel.length < mejor.lineas.length)))) {
        mejor = { cubeta, dias, diff, suma, lineas: sel.map(j => items[j].x) };
      }
    }
    if (i >= k || suma > objetivo + tol || suma + sufijo[i] < objetivo - tol) return;
    if (suma + items[i].v <= objetivo + tol) { sel.push(i); dfs(i + 1, suma + items[i].v, dias + items[i].d); sel.pop(); }
    dfs(i + 1, suma, dias);
  };
  dfs(0, 0, 0);
  return mejor;
}

function subconjuntosPorTamano(lista, minimo) {
  const n = lista.length, res = [];
  for (let mask = 1; mask < (1 << n); mask++) {
    const sub = lista.filter((_, i) => mask & (1 << i));
    if (sub.length >= minimo) res.push(sub);
  }
  return res.sort((a, b) => b.length - a.length);
}

/**
 * Sugerencias de emparejado. Devuelve Map<clave, sugerencia> para TODAS las ops recibidas (también las no relevantes,
 * con tipo 'EXCLUIR' y el motivo). Sugerencia: { refs, totalBs, tasaPactada, tipo, confianza: 'alta'|'media'|'baja'|'sin',
 * motivo, candidatos, banco, categoria, grupo? (claves de las ops pagadas juntas), dias? }.
 *
 * Orden (de lo más seguro a lo menos; cada movimiento se usa UNA sola vez, salvo dentro de un grupo):
 *  1. una transferencia BINANCE/EFECTIVO con el monto exacto el mismo día; 2. igual con ± diasTolerancia;
 *  3. varias transferencias que suman el monto; 4. GRUPO: varias ops del mismo día que suman lo mismo que varias
 *  transferencias; 5. una transferencia que difiere hasta tolUsd (1,5 %); 6. monto exacto pero lejos en fecha
 *  (hasta diasAmplios) u otro banco [baja]; 7. línea OTRO (dice USDT/BINANCE) por Bs/tasa [baja].
 *  Después se pegan las líneas DIFERENCIAL: mismo Nro; o huérfanas con la misma descripción el mismo día; o la vecina
 *  más cercana (±4 filas) cuya línea principal es de la operación.
 * Las ops derivadas (op.derivada) reciben la sugerencia de derivarDeDiferenciales calculada DESPUÉS de los activos.
 *
 * `opciones`: { diasTolerancia: 3, tolUsd: 0.015, diasAmplios: 30, tasas?, decisiones?, usados? }. Con `decisiones`
 * (guardadas) esas ops conservan sus refs y nadie más puede usarlas.
 */
export function emparejar(ops, movimientos, opciones) {
  const opc = { ...OPCIONES_DEF, ...(opciones || {}) };
  const idx = indexar(movimientos);
  const usados = new Set(refsDe(opc.usados));
  const decisiones = new Map();
  (Array.isArray(opc.decisiones) ? opc.decisiones : opc.decisiones instanceof Map ? [...opc.decisiones.values()] : []).forEach(d => {
    if (!d || !d.clave) return;
    decisiones.set(normalizarClave(d.clave), d);
    refsDe([d]).forEach(r => usados.add(r));
  });
  const res = new Map();
  const lista = (Array.isArray(ops) ? ops : []).filter(o => o && o.clave);
  const hojasActivo = new Set(lista.filter(o => !o.derivada && o.hoja).map(o => o.hoja));
  const ctx = { idx, opc, usados, hojasActivo, asignadas: new Map(), entradas: [] };

  const pendientes = [];
  lista.filter(o => !o.derivada).forEach(op => {
    const dec = decisiones.get(normalizarClave(op.clave));
    if (dec) { res.set(op.clave, sugerenciaDeDecision(op, dec)); return; }
    if (!op.relevante || !op.fecha || !(aNum(op.usdt) > 0)) return;
    pendientes.push(op);
  });
  pendientes.sort((a, b) => a.fecha.localeCompare(b.fecha) || (a.fila - b.fila));

  faseIndividual(ctx, pendientes, { dias: 0, tol: tolExacta, orden: 'dias', fase: 'exacta' });
  faseIndividual(ctx, pendientes, { dias: opc.diasTolerancia, tol: tolExacta, orden: 'dias', fase: 'exacta' });
  faseSubconjuntos(ctx, pendientes, { dias: opc.diasTolerancia, fase: 'suma' });
  faseGrupos(ctx, pendientes);
  faseIndividual(ctx, pendientes, { dias: opc.diasTolerancia, tol: u => u * opc.tolUsd, orden: 'monto', fase: 'aprox' });
  faseIndividual(ctx, pendientes, { dias: opc.diasAmplios, tol: tolExacta, orden: 'dias', fase: 'lejana' });
  faseSubconjuntos(ctx, pendientes, { dias: opc.diasAmplios, fase: 'lejana' });
  faseIndividual(ctx, pendientes, { dias: opc.diasTolerancia, tol: tolExacta, orden: 'dias', fase: 'otroBanco', todosLosBancos: true });
  faseIndividual(ctx, pendientes, { dias: opc.diasTolerancia, tol: u => u * opc.tolUsd, orden: 'monto', fase: 'otro', clases: ['OTRO'] });
  pegarDiferenciales(ctx);

  ctx.entradas.forEach(e => construirSugerencias(ctx, e).forEach((s, clave) => res.set(clave, s)));
  lista.filter(o => !o.derivada && !res.has(o.clave)).forEach(op => res.set(op.clave, sugerenciaVacia(ctx, op)));

  // ops derivadas: se recalculan con lo que quedó libre tras emparejar los activos (nada cuenta dos veces)
  const derivadas = lista.filter(o => o.derivada);
  if (derivadas.length) {
    const ocupadas = new Set(usados);
    res.forEach(s => (s.refs || []).forEach(r => ocupadas.add(r)));
    const nuevas = new Map(derivarDeDiferenciales(idx, ocupadas).map(o => [o.clave, o]));
    derivadas.forEach(op => {
      const dec = decisiones.get(normalizarClave(op.clave));
      if (dec) { res.set(op.clave, sugerenciaDeDecision(op, dec)); return; }
      const nueva = nuevas.get(op.clave);
      if (nueva) res.set(op.clave, nueva.sugerencia);
      else res.set(op.clave, { refs: [], totalBs: 0, tasaPactada: 0, tipo: 'EXCLUIR', confianza: 'sin', duplicada: true, banco: op.hoja, categoria: op.categoria,
        motivo: 'Esta línea de diferencial ya quedó dentro de otra operación (no se cuenta dos veces); puedes excluirla.', candidatos: [op.ref] });
    });
  }
  return res;
}

function sugerenciaDeDecision(op, d) {
  return { refs: Array.isArray(d.refs) ? d.refs.slice() : [], totalBs: d.totalBs, tasaPactada: d.tasaPactada, tasaBcv: d.tasaBcv, tipo: d.tipo || op.tipoSugerido,
    confianza: 'alta', motivo: 'Decisión guardada (' + String(d.estado || 'CONFIRMADA').toLowerCase() + ').', candidatos: [], banco: d.banco || op.bancoSugerido || '',
    categoria: d.categoria || op.categoria, decision: true };
}

/** Líneas candidatas para una op (no usadas, del lado correcto, de su banco salvo `todosLosBancos`, nunca de las hojas de activo). */
function lineasPara(ctx, op, { dias, clases, todosLosBancos }) {
  const lado = ladoMov(op);
  const banco = todosLosBancos ? '' : op.bancoSugerido;
  return cercanos(ctx.idx, op.fecha, dias).filter(x => !ctx.usados.has(x.ref) && clases.includes(x.clase) && bsLado(x, lado) > 0
    && (!banco || x.banco === banco)
    && !ctx.hojasActivo.has(x.banco) && x.banco !== op.hoja);
}
const clasePrincipal = op => (op.categoria === 'efectivo' ? 'EFECTIVO' : 'BINANCE');

function asignar(ctx, opsGrupo, lineas, fase, extra) {
  const e = { ops: opsGrupo, lineas, difs: [], modosDif: new Set(), fase, ...(extra || {}) };
  opsGrupo.forEach(o => ctx.asignadas.set(o.clave, e));
  lineas.forEach(x => ctx.usados.add(x.ref));
  ctx.entradas.push(e);
}

function faseIndividual(ctx, pendientes, { dias, tol, orden, fase, clases, todosLosBancos }) {
  const pares = [];
  pendientes.forEach(op => {
    if (ctx.asignadas.has(op.clave)) return;
    if (todosLosBancos && !op.bancoSugerido) return;   // solo tiene sentido si el banco sugerido falló
    const lado = ladoMov(op), t = tol(op.usdt);
    lineasPara(ctx, op, { dias, clases: clases || [clasePrincipal(op)], todosLosBancos }).forEach(x => {
      if (todosLosBancos && x.banco === op.bancoSugerido) return;
      const diff = Math.abs(usdLado(x, lado) - op.usdt);
      if (diff <= t) pares.push({ op, x, d: Math.abs(difDias(op.fecha, x.fecha)), diff: diff / op.usdt });
    });
  });
  pares.sort(orden === 'monto'
    ? (a, b) => (a.diff - b.diff) || (a.d - b.d) || (a.op.fila - b.op.fila) || (a.x.fila - b.x.fila)
    : (a, b) => (a.d - b.d) || (a.diff - b.diff) || (a.op.fila - b.op.fila) || (a.x.fila - b.x.fila));
  pares.forEach(p => {
    if (ctx.asignadas.has(p.op.clave) || ctx.usados.has(p.x.ref)) return;
    asignar(ctx, [p.op], [p.x], fase);
  });
}

function faseSubconjuntos(ctx, pendientes, { dias, fase }) {
  pendientes.forEach(op => {
    if (ctx.asignadas.has(op.clave)) return;
    const lado = ladoMov(op), tol = tolExacta(op.usdt);
    const todas = lineasPara(ctx, op, { dias, clases: [clasePrincipal(op)] });
    const porBanco = new Map();
    todas.forEach(x => { if (!porBanco.has(x.banco)) porBanco.set(x.banco, []); porBanco.get(x.banco).push(x); });
    let mejor = null;
    porBanco.forEach(pool => {
      const mismoDia = pool.filter(x => x.fecha === op.fecha);
      const r = mejorSubconjunto(mismoDia, op.usdt, tol, lado, op.fecha, 2) || mejorSubconjunto(pool, op.usdt, tol, lado, op.fecha, 2);
      if (r && (!mejor || r.dias < mejor.dias || (r.dias === mejor.dias && r.diff < mejor.diff))) mejor = r;
    });
    if (mejor) asignar(ctx, [op], mejor.lineas, fase);
  });
}

/** Varias ops del mismo día y hoja, pagadas con transferencias que no se reparten una a una (19/11/2025). */
function faseGrupos(ctx, pendientes) {
  const clusters = new Map();
  pendientes.forEach(op => {
    if (ctx.asignadas.has(op.clave)) return;
    const k = op.hoja + '|' + op.fecha + '|' + op.lado;
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k).push(op);
  });
  clusters.forEach(cluster => {
    let restantes = cluster.slice(0, 8);
    let progreso = true;
    while (restantes.length >= 2 && progreso) {
      progreso = false;
      for (const sub of subconjuntosPorTamano(restantes, 2)) {
        const bancosSug = [...new Set(sub.map(o => o.bancoSugerido).filter(Boolean))];
        if (bancosSug.length > 1) continue;
        const op0 = { ...sub[0], bancoSugerido: bancosSug[0] || '' };
        const objetivo = sub.reduce((s, o) => s + o.usdt, 0);
        const lado = ladoMov(op0);
        const todas = lineasPara(ctx, op0, { dias: ctx.opc.diasTolerancia, clases: [clasePrincipal(op0)] });
        const porBanco = new Map();
        todas.forEach(x => { if (!porBanco.has(x.banco)) porBanco.set(x.banco, []); porBanco.get(x.banco).push(x); });
        let mejor = null;
        porBanco.forEach(pool => {
          const mismoDia = pool.filter(x => x.fecha === op0.fecha);
          const r = mejorSubconjunto(mismoDia, objetivo, tolExacta(objetivo), lado, op0.fecha, 1) || mejorSubconjunto(pool, objetivo, tolExacta(objetivo), lado, op0.fecha, 1);
          if (r && (!mejor || r.dias < mejor.dias || (r.dias === mejor.dias && r.diff < mejor.diff))) mejor = r;
        });
        if (mejor) {
          asignar(ctx, sub, mejor.lineas, 'grupo');
          restantes = restantes.filter(o => !sub.includes(o));
          progreso = true;
          break;
        }
      }
    }
  });
}

/** Pega las líneas DIFERENCIAL a las operaciones ya emparejadas (ver emparejar). */
function pegarDiferenciales(ctx) {
  const { idx, usados, opc } = ctx;
  const entradas = ctx.entradas;
  const tomar = (e, d, modo) => { e.difs.push(d); e.modosDif.add(modo); usados.add(d.ref); };
  const libre = d => d && d.clase === 'DIFERENCIAL' && !usados.has(d.ref);
  // a) mismo Nro que alguna línea principal
  entradas.forEach(e => {
    const lado = ladoMov(e.ops[0]);
    e.lineas.filter(x => x.nro).forEach(x => {
      (idx.porBancoNro.get(x.banco + '|' + x.nro) || []).forEach(d => {
        if (libre(d) && bsLado(d, lado) > 0 && e.lineas.some(l => Math.abs(difDias(l.fecha, d.fecha)) <= opc.diasTolerancia)) tomar(e, d, 'nro');
      });
    });
  });
  // b) huérfanas con la misma descripción, mismo día, banco y lado (gana la operación más cercana por fila)
  const lineasDia = new Map();   // banco|fecha → [{ e, x }] de las líneas principales ya emparejadas
  entradas.forEach(e => e.lineas.forEach(x => { const k = x.banco + '|' + x.fecha; if (!lineasDia.has(k)) lineasDia.set(k, []); lineasDia.get(k).push({ e, x }); }));
  idx.lista.filter(libre).forEach(d => {
    if (!huerfana(idx, d) || !d.desc) return;
    let mejor = null;
    (lineasDia.get(d.banco + '|' + d.fecha) || []).forEach(({ e, x }) => {
      if (!(bsLado(d, ladoMov(e.ops[0])) > 0) || !similares(x.desc, d.desc)) return;
      const dist = Math.abs(x.fila - d.fila);
      if (dist <= FILAS_MISMA_DESC && (!mejor || dist < mejor.dist)) mejor = { e, dist };
    });
    if (mejor) tomar(mejor.e, d, 'desc');
  });
  // c) operaciones aún sin diferencial: la huérfana más cercana (±4 filas) cuya mejor principal es una línea de la operación
  entradas.forEach(e => {
    if (e.difs.length) return;
    const lado = ladoMov(e.ops[0]);
    const propias = new Set(e.lineas.map(x => x.ref));
    let mejor = null;
    e.lineas.forEach(x => {
      const mapa = idx.porBancoFila.get(x.banco);
      for (let k = -FILAS_VECINAS; k <= FILAS_VECINAS && mapa; k++) {
        const d = mapa.get(x.fila + k);
        if (!k || !libre(d) || d.fecha !== x.fecha || !huerfana(idx, d) || !(bsLado(d, lado) > 0)) continue;
        const vec = vecinasDe(idx, d, lado);
        if (!vec.length || !propias.has(vec[0].x.ref)) continue;
        if (!mejor || Math.abs(k) < mejor.dist) mejor = { d, dist: Math.abs(k) };
      }
    });
    if (mejor) tomar(e, mejor.d, 'vecina');
  });
}

/** Suma en Bs de unas líneas; las de cuentas en dólares se pasan a Bs con `bcv` (null si no hay tasa). */
function sumaBs(lineas, lado, bcv) {
  let s = 0;
  for (const x of lineas) {
    const v = bsLado(x, lado) || bsLado(x, lado === 'H' ? 'D' : 'H');
    if (x.dolares) { if (!(bcv > 1)) return null; s += v * bcv; } else s += v;
  }
  return s;
}

function construirSugerencias(ctx, e) {
  const out = new Map();
  const op0 = e.ops[0], lado = ladoMov(op0), u = unidadDe(op0.categoria);
  const todas = e.lineas.concat(e.difs);
  const refs = todas.slice().sort((a, b) => a.banco.localeCompare(b.banco) || a.fila - b.fila).map(x => x.ref);
  // BCV del día en que el banco movió los bolívares (no el de la fila de BINANCE): así el diferencial cuadra con la
  // línea DIFERENCIAL del libro aunque la operación esté anotada otro día (01/09 en BINANCE, pagada el 15/09).
  const fechaBcv = e.lineas.map(x => x.fecha).filter(Boolean).sort()[0] || op0.fecha;
  const bcv = tasaBcvPara(fechaBcv, ctx.opc.tasas, e.lineas.map(x => x.m));
  const total = sumaBs(todas, lado, bcv);
  const montoOps = e.ops.reduce((s, o) => s + o.usdt, 0);
  const sumaLineas = e.lineas.reduce((s, x) => s + usdLado(x, lado), 0);
  const tasaP = total !== null && montoOps > 0 ? total / montoOps : null;
  const ratio = tasaP && bcv > 0 ? tasaP / bcv : null;
  const banco = e.lineas[0].banco;
  const fechasL = [...new Set(e.lineas.map(x => x.fecha))].sort();
  const mismaFecha = fechasL.length === 1 && fechasL[0] === op0.fecha;
  const soloDolares = todas.every(x => x.dolares);
  const nombreClase = e.lineas[0].clase === 'EFECTIVO' ? 'EFECTIVO DOLARES' : e.lineas[0].clase === 'OTRO' ? 'sin marcar' : 'BINANCE';
  const nL = e.lineas.length, nD = e.difs.length;
  const textoDifs = nD ? ' + ' + plural(nD, 'línea', 'líneas') + ' de diferencial' + (e.modosDif.has('nro') ? ' con la misma referencia' : e.modosDif.has('desc') ? ' con la misma descripción' : ' por cercanía de fila') : '';
  const textoLineas = (nL === 1 ? 'transferencia ' : nL + ' transferencias ') + nombreClase + (nL === 1 ? ' por ' : ' que suman ') + num(sumaLineas) + ' ' + u;
  const textoTasa = tasaP ? ' Tasa ' + num(tasaP) + (ratio ? ' (' + num(ratio) + ' × BCV)' : '') + '.' : '';
  const dias = Math.max(...e.lineas.map(x => Math.abs(difDias(op0.fecha, x.fecha)) || 0));
  const textoFecha = mismaFecha ? '' : ' El banco la registró el ' + fechasL.map(ddmm).join(' y ') + ' (' + plural(dias, 'día', 'días') + (difDias(op0.fecha, fechasL[0]) < 0 ? ' antes' : ' después') + ').';

  let confianza, motivo;
  if (e.fase === 'grupo') {
    confianza = 'media';
    motivo = (e.ops.length === 2 ? 'Pagada junto con otra operación' : 'Pagada junto con ' + (e.ops.length - 1) + ' operaciones más') + ' del ' + ddmm(op0.fecha) + ': ' + nL + ' ' + (nL === 1 ? 'transferencia' : 'transferencias') + ' ' + nombreClase
      + (nD ? ' + ' + nD + ' de diferencial' : '') + ' en ' + banco + (total !== null ? ' por ' + ves(total) : '') + ' (' + num(montoOps) + ' ' + u + ' en total). Se reparte a la tasa promedio' + (tasaP ? ' ' + num(tasaP) : '') + '.' + textoFecha;
  } else if (e.fase === 'lejana' || e.fase === 'otroBanco' || e.fase === 'otro') {
    // Monto exacto pero el banco lo registró otro día: es lo normal (BINANCE anota la orden; el banco, el pago, a veces
    // semanas después). Si además trae su línea de diferencial, cuenta como media (se incluye en el reporte).
    confianza = e.fase === 'lejana' && nD ? 'media' : 'baja';
    if (e.fase === 'otro') motivo = 'Solo se encontró una línea no marcada como ' + (clasePrincipal(op0) === 'EFECTIVO' ? 'EFECTIVO DOLARES' : 'BINANCE') + ' («' + String(e.lineas[0].m.descripcion || '').trim() + '», partida ' + String(e.lineas[0].m.partida || '').trim() + ') por ~' + num(sumaLineas) + ' ' + u + '. Revisa.';
    else if (e.fase === 'otroBanco') motivo = 'No apareció en ' + op0.bancoSugerido + '; se encontró en ' + banco + ' el ' + ddmm(e.lineas[0].fecha) + ': ' + textoLineas + textoDifs + '. Revisa.' + textoTasa;
    else motivo = 'Monto exacto en ' + banco + ', registrado ' + plural(dias, 'día', 'días') + (difDias(op0.fecha, fechasL[0]) < 0 ? ' antes' : ' después') + ' (' + fechasL.map(ddmm).join(' y ') + '): ' + textoLineas + textoDifs + '.' + (nD ? ' La fecha distinta es normal (BINANCE anota la orden y el banco el pago).' : ' Sin línea de diferencial: revisa la fecha.') + textoTasa;
  } else {
    const razones = [];
    if (!nD && !soloDolares) razones.push('sin línea de diferencial: queda a tasa BCV, revisa si falta el diferencial');
    if (ratio && !soloDolares && (ratio < RATIO_MIN || ratio > RATIO_MAX)) razones.push('la tasa resultante es ' + num(ratio) + ' veces el BCV, fuera de lo normal');
    if (e.fase === 'aprox') razones.push('el monto difiere en ' + num(Math.abs(sumaLineas - montoOps)) + ' ' + u + ' (' + num(Math.abs(sumaLineas - montoOps) / montoOps * 100) + ' %) de lo anotado en ' + op0.hoja);
    confianza = mismaFecha && !razones.length ? 'alta' : 'media';
    motivo = banco + ' ' + fechasL.map(ddmm).join(' y ') + ': ' + textoLineas + textoDifs + '.' + (soloDolares ? ' Cuenta en dólares: se valora al BCV del día.' : '') + textoTasa + textoFecha
      + (razones.length ? ' Ojo: ' + razones.join('; ') + '.' : '');
  }
  const grupo = e.ops.length > 1 ? e.ops.map(o => o.clave) : undefined;
  let acumulado = 0;
  e.ops.forEach((op, i) => {
    let totalBs = null;
    if (total !== null) {
      totalBs = i === e.ops.length - 1 ? redondear(total - acumulado, 2) : redondear(op.usdt * (total / montoOps), 2);
      acumulado += totalBs;
    }
    out.set(op.clave, {
      refs: refs.slice(), totalBs, tasaPactada: totalBs !== null && op.usdt > 0 ? redondear(totalBs / op.usdt, 4) : null, tasaBcv: bcv > 0 ? redondear(bcv, 4) : undefined, tipo: op.tipoSugerido,
      confianza, motivo, candidatos: candidatosPara(ctx, op, refs), banco, categoria: op.categoria, grupo, dias: dias || 0, fase: e.fase,
    });
  });
  return out;
}

/** Refs cercanas y del lado correcto para el selector manual: primero la clase principal, luego diferencial y el resto. */
function candidatosPara(ctx, op, excluir) {
  if (!op.fecha) return [];
  const lado = ladoMov(op), quitar = new Set(excluir || []);
  const peso = { BINANCE: 0, EFECTIVO: 0, DIFERENCIAL: 1, OTRO: 2, VECINA: 3 };
  const principal = clasePrincipal(op);
  return cercanos(ctx.idx, op.fecha, Math.max(DIAS_CANDIDATOS, ctx.opc.diasTolerancia)).filter(x => !quitar.has(x.ref) && bsLado(x, lado) > 0
      && (!op.bancoSugerido || x.banco === op.bancoSugerido) && !ctx.hojasActivo.has(x.banco))
    .map(x => ({ x, p: x.clase === principal ? 0 : (peso[x.clase] === undefined ? 4 : peso[x.clase] + 1), d: Math.abs(difDias(op.fecha, x.fecha)), a: Math.abs(usdLado(x, lado) - op.usdt) }))
    .sort((a, b) => (a.p - b.p) || (a.d - b.d) || (a.a - b.a))
    .slice(0, 80).map(c => c.x.ref);
}

function sugerenciaVacia(ctx, op) {
  const u = unidadDe(op.categoria);
  const base = { refs: [], totalBs: 0, tasaPactada: 0, confianza: 'sin', banco: op.bancoSugerido || '', categoria: op.categoria, candidatos: candidatosPara(ctx, op, []) };
  if (!op.relevante) return { ...base, tipo: 'EXCLUIR', motivo: op.nota || 'No parece compra ni venta: queda excluida.' };
  if (!op.fecha) return { ...base, tipo: op.tipoSugerido, motivo: 'La fila no tiene una fecha válida' + (op.fechaTexto ? ' («' + op.fechaTexto + '»)' : '') + ': corrígela en el libro o elige los movimientos a mano.' };
  const lado = ladoMov(op), principal = clasePrincipal(op);
  const desde = sumarDias(op.fecha, -ctx.opc.diasTolerancia), hasta = sumarDias(op.fecha, ctx.opc.diasTolerancia);
  const nombre = principal === 'EFECTIVO' ? 'EFECTIVO DOLARES' : 'BINANCE';
  // la línea de la clase principal más parecida (aunque esté usada), como pista para el usuario
  const parecida = cercanos(ctx.idx, op.fecha, ctx.opc.diasAmplios).filter(x => x.clase === principal && bsLado(x, lado) > 0
      && (!op.bancoSugerido || x.banco === op.bancoSugerido) && !ctx.hojasActivo.has(x.banco))
    .sort((a, b) => Math.abs(usdLado(a, lado) - op.usdt) - Math.abs(usdLado(b, lado) - op.usdt))[0];
  let motivo = 'No se encontró en ' + (op.bancoSugerido || 'los bancos') + ' una línea ' + nombre + ' por ~' + num(op.usdt) + ' ' + u + ' entre el ' + ddmm(desde) + ' y el ' + ddmm(hasta) + '.';
  if (parecida) motivo += ' La más parecida: ' + parecida.banco + ' ' + ddmm(parecida.fecha) + ' por ' + num(usdLado(parecida, lado)) + ' ' + u + (ctx.usados.has(parecida.ref) ? ' (ya usada en otra operación)' : '') + '.';
  if (op.tipoSugerido === 'PAGO') motivo += ' Si fue un pago con ' + (u === 'USDT' ? 'USDT' : 'dólares') + ', escribe el valor de la factura en Bs.';
  else motivo += ' Elige los movimientos a mano o exclúyela.';
  return { ...base, tipo: op.tipoSugerido, motivo };
}

/**
 * Movimientos de clase BINANCE (o las `clases` pedidas) que no usa ninguna sugerencia ni decisión: transferencias del
 * banco sin operación en la hoja BINANCE. `sugerencias`: Map/objeto/array; `decisiones`: array.
 */
export function movimientosSinPareja(movimientos, sugerencias, decisiones, clases) {
  const usados = new Set(refsDe(sugerencias).concat(refsDe(decisiones)));
  const cl = (clases && clases.length ? clases : ['BINANCE']).map(c => String(c).toUpperCase());
  return (Array.isArray(movimientos) ? movimientos : [])
    .filter(m => m && cl.includes(claseDe(m)) && !usados.has(String(m.ref)) && (aNum(m.debeBs) > 0 || aNum(m.haberBs) > 0))
    .sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')) || String(a.banco || '').localeCompare(String(b.banco || '')) || (Number(a.fila) || 0) - (Number(b.fila) || 0));
}

// ------------------------------------------------------------------------------------------------
// 3.3  Tasa BCV
// ------------------------------------------------------------------------------------------------

/**
 * Tasa BCV para una fecha: la de `tasas[fecha]`; si no, la anterior más cercana (hasta 7 días); si no, la columna
 * `tasa` de la primera línea elegida que no sea de una cuenta en dólares (tasa 1); si no, 0.
 */
export function tasaBcvPara(fecha, tasas, movimientosElegidos) {
  const f = String(fecha || '').slice(0, 10);
  if (f && tasas) {
    const v = aNum(leer(tasas, f));
    if (v > 0) return v;
    for (let i = 1; i <= 7; i++) { const w = aNum(leer(tasas, sumarDias(f, -i))); if (w > 0) return w; }
  }
  for (const m of movimientosElegidos || []) {
    if (!m || typeof m !== 'object') continue;
    const t = aNum(m.tasa);
    if (t > 0 && Math.abs(t - 1) > 1e-9) return t;
  }
  return 0;
}

// ------------------------------------------------------------------------------------------------
// 3.4  Cálculo de una fila
// ------------------------------------------------------------------------------------------------

/**
 * Cálculo de una op con su decisión (guardada, sugerencia aplicada o edición manual: tipo, refs, totalBs, tasaPactada, tasaBcv).
 * totalBs: el que venga; si no, tasaPactada × monto; si no, la suma de las refs (cuentas en $ al BCV).
 * tasaBcv: la que venga; si no, la del día del primer movimiento bancario principal de las refs (para cuadrar con la
 * línea DIFERENCIAL del libro); si no hay refs, la del día de la op (tasaBcvPara).
 * Monto 0 (derivada sin principal): difBs = Bs del diferencial con signo (HABER/COMPRA negativo, DEBE/VENTA positivo).
 * aBcv: true si la tasa pactada difiere del BCV menos de 0,2 % (dif = 0): casi siempre falta la línea de diferencial.
 * estado: EXCLUIDA (tipo EXCLUIR) · CONFIRMADA (decisión confirmada) · SUGERIDA (confianza alta/media o edición con
 * datos completos) · REVISAR (confianza baja/sin, falta total en Bs o tasa BCV, o tasa pactada igual al BCV).
 */
export function calcularFila(op, decision, tasas, movimientosPorRef) {
  const o = op || {}, d = decision || {};
  let tipo = String(d.tipo || (o.relevante === false ? 'EXCLUIR' : o.tipoSugerido) || (o.lado === 'E' ? 'COMPRA' : 'VENTA')).toUpperCase();
  if (d.estado === 'EXCLUIDA') tipo = 'EXCLUIR';
  if (tipo === 'EXCLUIR') return { totalBs: 0, tasaPactada: 0, tasaBcv: 0, difBs: 0, difUsd: 0, difPct: 0, equivUsdBcv: 0, tipo, estado: 'EXCLUIDA', aBcv: false };
  const monto = aNum(o.usdt);
  const movs = (Array.isArray(d.refs) ? d.refs : []).map(r => leer(movimientosPorRef, r)).filter(m => m && typeof m === 'object');
  const fechasBanco = movs.filter(m => claseDe(m) !== 'DIFERENCIAL' && m.fecha).map(m => String(m.fecha).slice(0, 10)).sort();
  const tasaBcv = aNum(d.tasaBcv) > 0 ? aNum(d.tasaBcv) : tasaBcvPara(fechasBanco[0] || o.fecha, tasas, movs);
  const lado = tipo === 'COMPRA' ? 'H' : 'D';
  let totalBs = 0;
  if (presente(d.totalBs)) totalBs = aNum(d.totalBs);
  else if (aNum(d.tasaPactada) > 0 && monto > 0) totalBs = aNum(d.tasaPactada) * monto;
  else if (movs.length) totalBs = sumaBs(movs.map(infoMov), lado, tasaBcv) || 0;
  const s = tipo === 'COMPRA' ? -1 : 1;
  let difBs = 0, tasaPactada = 0, difPct = 0;
  if (monto > 0) {
    tasaPactada = totalBs / monto;
    if (tasaBcv > 0 && totalBs > 0) { difBs = s * (totalBs - tasaBcv * monto); difPct = s * (tasaPactada / tasaBcv - 1); }
  } else if (totalBs > 0) {
    difBs = s * totalBs;
  }
  const aBcv = monto > 0 && tasaBcv > 0 && totalBs > 0 && Math.abs(tasaPactada - tasaBcv) / tasaBcv < 0.002;
  if (aBcv) { difBs = 0; difPct = 0; }
  let estado;
  if (d.estado === 'CONFIRMADA') estado = 'CONFIRMADA';
  else if (d.confianza) estado = d.confianza === 'alta' || d.confianza === 'media' ? 'SUGERIDA' : 'REVISAR';
  else estado = 'SUGERIDA';
  if (estado === 'SUGERIDA' && (!(tasaBcv > 0) || !(totalBs > 0) || aBcv)) estado = 'REVISAR';
  return {
    totalBs: redondear(totalBs, 2), tasaPactada: redondear(tasaPactada, 4), tasaBcv: redondear(tasaBcv, 4),
    difBs: redondear(difBs, 2), difUsd: tasaBcv > 0 ? redondear(difBs / tasaBcv, 4) : 0, difPct: redondear(difPct, 6),
    equivUsdBcv: tasaBcv > 0 ? redondear(totalBs / tasaBcv, 4) : 0, tipo, estado, aBcv,
  };
}

// ------------------------------------------------------------------------------------------------
// 3.5 / 6.3  Reporte
// ------------------------------------------------------------------------------------------------

const cl = v => (v > 0.004 ? 'positivo' : v < -0.004 ? 'negativo' : 'neutro');
const pctTxt = (dif, base) => (base > 0 ? signo(dif / base * 100, 2) + ' %' : '—');
const nombreMesSeguro = m => (/^\d{4}-\d{2}$/.test(m) ? nombreMes(m) : 'Sin fecha');
function textoRango(desde, hasta) { return (desde ? fechaCorta(desde) : 'inicio') + ' al ' + (hasta ? fechaCorta(hasta) : 'hoy'); }
function leidoTexto(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = x => String(x).padStart(2, '0');
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** Datos normalizados de una fila del reporte. */
function datosFila(f, soloConfirmadas) {
  const op = f.op || {}, c = f.calculo || {}, d = f.decision || {}, sg = f.sugerencia || {};
  const tipo = String(c.tipo || d.tipo || op.tipoSugerido || '').toUpperCase();
  const estado = f.estado || c.estado || (tipo === 'EXCLUIR' ? 'EXCLUIDA' : 'REVISAR');
  const categoria = d.categoria || f.categoria || op.categoria || 'usdt';
  const refs = Array.isArray(d.refs) ? d.refs : Array.isArray(sg.refs) ? sg.refs : [];
  const banco = d.banco || f.banco || sg.banco || op.bancoSugerido || (refs[0] ? String(refs[0]).split('!')[0] : '');
  const confianza = d.confianza || sg.confianza || f.confianza || '';
  const incluida = tipo !== 'EXCLUIR' && (estado === 'CONFIRMADA' || (!soloConfirmadas && estado === 'SUGERIDA'));
  const revisar = tipo !== 'EXCLUIR' && !incluida && estado !== 'EXCLUIDA';
  let motivo = f.motivo || d.motivo || sg.motivo || '';
  if (c.aBcv) motivo = 'Tasa pactada igual al BCV: revisar la línea de diferencial' + (motivo ? ' · ' + motivo : '');
  if (revisar && estado === 'SUGERIDA') motivo = 'Sugerida, sin confirmar' + (motivo ? ' · ' + motivo : '');
  return {
    op, tipo, estado, categoria, banco, confianza, incluida, revisar, motivo, mes: mesDe(op.fecha) || 'sin fecha',
    usdt: aNum(op.usdt), totalBs: aNum(c.totalBs), tasaPactada: aNum(c.tasaPactada), tasaBcv: aNum(c.tasaBcv),
    difBs: aNum(c.difBs), difUsd: aNum(c.difUsd), equiv: aNum(c.equivUsdBcv),
  };
}
const etiquetaEstado = x => (x.estado === 'CONFIRMADA' ? 'Confirmada' : x.estado === 'SUGERIDA' ? 'Sugerida' + (x.confianza ? ' · ' + x.confianza : '') : x.estado === 'REVISAR' ? 'Por revisar' : 'Excluida');
const sumar = (xs, k) => xs.reduce((s, x) => s + (Number(x[k]) || 0), 0);

/**
 * Reporte con la misma estructura que reportes.js ({ tipo, titulo, subtitulo, cartera, desde, hasta, kpis, secciones, nota }).
 * filas = [{ op, decision, calculo, estado, sugerencia? }]; se suman CONFIRMADA y SUGERIDA (con opciones.soloConfirmadas,
 * solo CONFIRMADA). opciones: { categoria: 'usdt'|'efectivo'|'materia'|'otros'|'todas' (sin categoría = reporte de §3.5
 * con todas las filas), soloConfirmadas, libro: { titulo, leido }, cartera, resumenPartidas }.
 * resumenPartidas (del backend): { 'YYYY-MM': { materiaCompras: { n, bs, usd }, cobranzas: { n, bs, usd } } } = todos los pagos
 * de materia prima y cobranzas del mes, tengan o no diferencial. Con él, los reportes 'materia' y 'todas' añaden al
 * resumen por mes "Pagos MP del mes (n)" y "Con diferencial (n)", y el KPI "Pagos a BCV: N de M".
 */
export function reporteDiferencialBancos(filas, desde, hasta, opciones) {
  const opc = opciones || {};
  const categoria = opc.categoria || '';
  const enRango = f => { const fe = f.op && f.op.fecha; return !fe || ((!desde || fe >= desde) && (!hasta || fe <= hasta)); };
  let todas = (Array.isArray(filas) ? filas : []).filter(f => f && f.op && enRango(f)).map(f => datosFila(f, !!opc.soloConfirmadas));
  if (categoria && categoria !== 'todas') todas = todas.filter(x => x.categoria === categoria);
  todas.sort((a, b) => (a.op.fecha || '').localeCompare(b.op.fecha || '') || String(a.op.clave || '').localeCompare(String(b.op.clave || '')));
  const libro = opc.libro || (opc.respuesta && opc.respuesta.libro) || {};
  const fuente = 'Fuente: libro «' + (libro.titulo || 'de bancos') + '»' + (libro.leido ? ' leído el ' + leidoTexto(libro.leido) : '')
    + '; tasa BCV de la pestaña TASA; diferencial = (tasa pactada − BCV) × monto, positivo a favor de la empresa (en una compra, pagar por encima del BCV es negativo). '
    + (opc.soloConfirmadas ? 'Solo operaciones confirmadas.' : 'Incluye operaciones confirmadas y sugeridas (confianza alta o media) aún sin confirmar.');
  const base = { cartera: opc.cartera || 'CPA BEJUMA', desde, hasta, subtitulo: textoRango(desde, hasta) };
  const cp = categoria === 'materia' || categoria === 'todas' ? conteoPartidas(opc.resumenPartidas, todas, desde, hasta) : null;
  if (categoria === 'todas') return reporteTodas(todas, base, fuente, !!opc.soloConfirmadas, cp);
  return reporteUnaCategoria(todas, base, fuente, categoria, !!opc.soloConfirmadas, cp);
}

/** Pagos de materia prima y cobranzas del mes (resumenPartidas del backend) frente a los que tienen línea de diferencial. */
function conteoPartidas(rp, todas, desde, hasta) {
  if (!rp || typeof rp !== 'object' || !Object.keys(rp).length) return null;
  const mDesde = desde ? String(desde).slice(0, 7) : '', mHasta = hasta ? String(hasta).slice(0, 7) : '';
  const meses = new Map();
  const nuevo = () => ({ mp: 0, cob: 0, mpDif: 0, cobDif: 0 });
  Object.keys(rp).forEach(mes => {
    if (!/^\d{4}-\d{2}$/.test(mes) || (mDesde && mes < mDesde) || (mHasta && mes > mHasta)) return;
    const r = rp[mes] || {};
    meses.set(mes, { ...nuevo(), mp: aNum(r.materiaCompras && r.materiaCompras.n), cob: aNum(r.cobranzas && r.cobranzas.n) });
  });
  todas.filter(x => x.categoria === 'materia' && x.tipo !== 'EXCLUIR' && x.estado !== 'EXCLUIDA').forEach(x => {
    if (!meses.has(x.mes)) meses.set(x.mes, nuevo());
    if (x.tipo === 'COMPRA') meses.get(x.mes).mpDif++; else meses.get(x.mes).cobDif++;
  });
  const tot = nuevo();
  meses.forEach(m => { tot.mp += m.mp; tot.cob += m.cob; tot.mpDif += m.mpDif; tot.cobDif += m.cobDif; });
  return { meses, tot };
}
function kpiPagosBcv(cp) {
  const t = cp.tot;
  return { etq: 'Pagos a BCV', val: Math.max(0, t.mp - t.mpDif) + ' de ' + t.mp,
    sub: 'pagos de materia prima sin línea de diferencial' + (t.cob ? ' · cobranzas a BCV: ' + Math.max(0, t.cob - t.cobDif) + ' de ' + t.cob : '') };
}
/** Une los meses con operaciones y los del conteo de partidas, en orden. */
function mesesCon(mapa, cp, vacio) {
  if (cp) cp.meses.forEach((_, mes) => { if (!mapa.has(mes)) mapa.set(mes, vacio()); });
  return [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
const colsPartidas = cp => (cp ? ['Pagos MP del mes (n)', 'Con diferencial (n)'] : []);
const celdasPartidas = (cp, mes) => { if (!cp) return []; const m = cp.meses.get(mes) || { mp: 0, mpDif: 0 }; return [String(m.mp), String(m.mpDif)]; };
const totalesPartidas = cp => (cp ? [String(cp.tot.mp), String(cp.tot.mpDif)] : []);

function kpiOperaciones(todas, soloConfirmadas) {
  const n = e => todas.filter(x => x.estado === e && x.tipo !== 'EXCLUIR').length;
  const excl = todas.filter(x => x.tipo === 'EXCLUIR' || x.estado === 'EXCLUIDA').length;
  const sug = n('SUGERIDA');
  return { etq: 'Operaciones', val: n('CONFIRMADA') + ' confirmadas · ' + todas.filter(x => x.revisar).length + ' por revisar · ' + excl + ' excluidas',
    sub: sug + ' sugeridas ' + (soloConfirmadas ? 'sin incluir' : 'incluidas') };
}

function reporteUnaCategoria(todas, base, fuente, categoria, soloConfirmadas, cp) {
  const u = unidadDe(categoria);
  const inc = todas.filter(x => x.incluida);
  const compras = inc.filter(x => x.tipo === 'COMPRA'), ventas = inc.filter(x => x.tipo !== 'COMPRA');
  const difBs = sumar(inc, 'difBs'), difUsd = sumar(inc, 'difUsd');
  const cU = sumar(compras, 'usdt'), vU = sumar(ventas, 'usdt');
  const cBs = sumar(compras, 'totalBs'), vBs = sumar(ventas, 'totalBs');
  const conMonto = compras.filter(x => x.usdt > 0 && x.tasaBcv > 0);
  const mU = sumar(conMonto, 'usdt');
  const tasaProm = mU > 0 ? sumar(conMonto, 'totalBs') / mU : 0;
  const bcvProm = mU > 0 ? conMonto.reduce((s, x) => s + x.usdt * x.tasaBcv, 0) / mU : 0;
  const meses = new Map();
  const vacio = () => ({ cU: 0, cBs: 0, cDif: 0, vU: 0, vBs: 0, vDif: 0, dif: 0, difBs: 0 });
  inc.forEach(x => {
    if (!meses.has(x.mes)) meses.set(x.mes, vacio());
    const m = meses.get(x.mes);
    if (x.tipo === 'COMPRA') { m.cU += x.usdt; m.cBs += x.totalBs; m.cDif += x.difUsd; } else { m.vU += x.usdt; m.vBs += x.totalBs; m.vDif += x.difUsd; }
    m.dif += x.difUsd; m.difBs += x.difBs;
  });
  const listaMeses = mesesCon(meses, cp, vacio);
  const sufijo = categoria ? ' · ' + TITULO_CATEGORIA[categoria] : '';
  const revisar = todas.filter(x => x.revisar);
  return {
    tipo: categoria ? 'diferencial-' + categoria : 'diferencial-bancos',
    titulo: categoria ? 'Diferencial cambiario' + sufijo : 'Diferencial cambiario desde bancos', ...base,
    kpis: [
      { etq: 'Diferencial neto $', val: signoUsd(difUsd), clase: cl(difUsd), sub: signo(difBs, 2) + ' Bs' },
      { etq: 'Diferencial neto Bs', val: signo(difBs, 2) + ' Bs', clase: cl(difBs), sub: 'al BCV: ' + signoUsd(difUsd) },
      { etq: 'Compras', val: num(cU, 2) + ' ' + u, sub: usd(sumar(compras, 'equiv')) + ' al BCV · ' + ves(cBs) + ' pagados' },
      { etq: 'Ventas / pagos', val: num(vU, 2) + ' ' + u, sub: usd(sumar(ventas, 'equiv')) + ' al BCV · ' + ves(vBs) + ' recibidos' },
      { etq: 'Tasa pactada promedio (compras) vs BCV', val: tasaProm ? num(tasaProm, 2) + ' vs ' + num(bcvProm, 2) : '—', sub: tasaProm && bcvProm ? 'brecha ' + signo((tasaProm / bcvProm - 1) * 100, 2) + ' %' : '' },
      ...(cp ? [kpiPagosBcv(cp)] : []),
      kpiOperaciones(todas, soloConfirmadas),
    ],
    secciones: [
      { titulo: 'Resumen por mes', columnas: ['Mes', 'Compras ' + u, 'Bs pagados', 'Dif. compras $', 'Ventas ' + u, 'Bs recibidos', 'Dif. ventas $', 'Dif. neto $', 'Dif. neto Bs', ...colsPartidas(cp)], alinear: [0],
        filas: listaMeses.map(([mes, m]) => [nombreMesSeguro(mes), num(m.cU, 2), num(m.cBs, 2), signoUsd(m.cDif), num(m.vU, 2), num(m.vBs, 2), signoUsd(m.vDif), signoUsd(m.dif), signo(m.difBs, 2), ...celdasPartidas(cp, mes)]),
        totales: ['Total', num(cU, 2), num(cBs, 2), signoUsd(sumar(compras, 'difUsd')), num(vU, 2), num(vBs, 2), signoUsd(sumar(ventas, 'difUsd')), signoUsd(difUsd), signo(difBs, 2), ...totalesPartidas(cp)] },
      { titulo: 'Detalle por operación', columnas: ['Fecha', 'Tipo', u, 'Banco', 'Total Bs', 'Tasa pactada', 'Tasa BCV', 'Dif. Bs', 'Dif. $', 'Estado'], alinear: [0, 1, 3, 9],
        filas: inc.map(x => [fechaCorta(x.op.fecha), x.tipo, num(x.usdt, 2), x.banco || '—', num(x.totalBs, 2), x.tasaPactada ? num(x.tasaPactada, 2) : '—', num(x.tasaBcv, 2), signo(x.difBs, 2), signoUsd(x.difUsd), etiquetaEstado(x)]),
        totales: ['Total', plural(inc.length, 'op.', 'op.'), '', '', '', '', '', signo(difBs, 2), signoUsd(difUsd), ''] },
      { titulo: 'Por revisar (no incluidas)', columnas: ['Fecha', 'Descripción', u, 'Motivo'], alinear: [0, 1, 3],
        filas: revisar.map(x => [fechaCorta(x.op.fecha) || '—', x.op.descripcion || x.op.partida || '', num(x.usdt, 2), x.motivo]) },
    ],
    nota: fuente + (categoria === 'usdt' || !categoria ? ' "Ventas / pagos" incluye pagos hechos con USDT.' : '')
      + (cp ? ' "Pagos MP del mes" = todos los pagos de materia prima del mes según las partidas de los bancos; los que no tienen línea de diferencial se hicieron a tasa BCV.' : ''),
  };
}

function reporteTodas(todas, base, fuente, soloConfirmadas, cp) {
  const inc = todas.filter(x => x.incluida);
  const difBs = sumar(inc, 'difBs'), difUsd = sumar(inc, 'difUsd');
  const porCat = CATEGORIAS.map(([k, nombre]) => {
    const xs = inc.filter(x => x.categoria === k);
    const baseBs = xs.reduce((s, x) => s + x.usdt * x.tasaBcv, 0);
    return { k, nombre, xs, n: xs.length, usdt: sumar(xs, 'usdt'), bs: sumar(xs, 'totalBs'), dif: sumar(xs, 'difUsd'), difBs: sumar(xs, 'difBs'), baseBs };
  });
  const meses = new Map();
  const vacio = () => ({ usdt: 0, efectivo: 0, materia: 0, otros: 0, total: 0 });
  inc.forEach(x => {
    if (!meses.has(x.mes)) meses.set(x.mes, vacio());
    const m = meses.get(x.mes);
    m[CATEGORIAS.some(([k]) => k === x.categoria) ? x.categoria : 'otros'] += x.difUsd;
    m.total += x.difUsd;
  });
  const listaMeses = mesesCon(meses, cp, vacio);
  const revisar = todas.filter(x => x.revisar);
  const baseTotal = porCat.reduce((s, c) => s + c.baseBs, 0);
  return {
    tipo: 'diferencial-todas', titulo: 'Diferencial cambiario · todas las categorías', ...base,
    kpis: [
      { etq: 'Diferencial neto total', val: signoUsd(difUsd), clase: cl(difUsd), sub: signo(difBs, 2) + ' Bs · ' + plural(inc.length, 'operación', 'operaciones') },
      ...porCat.map(c => ({ etq: c.nombre, val: signoUsd(c.dif), clase: cl(c.dif), sub: plural(c.n, 'op.', 'op.') + ' · ' + signo(c.difBs, 2) + ' Bs' })),
      ...(cp ? [kpiPagosBcv(cp)] : []),
      kpiOperaciones(todas, soloConfirmadas),
    ],
    secciones: [
      { titulo: 'Resumen por categoría', columnas: ['Categoría', 'Operaciones', '$ al BCV', 'Bs', 'Dif. $', 'Dif. Bs', '% sobre BCV'], alinear: [0],
        filas: porCat.map(c => [c.nombre, String(c.n), usd(c.usdt), ves(c.bs), signoUsd(c.dif), signo(c.difBs, 2), pctTxt(c.difBs, c.baseBs)]),
        totales: ['Total', String(inc.length), usd(sumar(inc, 'usdt')), ves(sumar(inc, 'totalBs')), signoUsd(difUsd), signo(difBs, 2), pctTxt(difBs, baseTotal)] },
      { titulo: 'Resumen por mes y categoría (diferencial en $ al BCV)', columnas: ['Mes', 'USDT $', 'Efectivo $', 'Materia prima $', 'Otros $', 'Total $', ...colsPartidas(cp)], alinear: [0],
        filas: listaMeses.map(([mes, m]) => [nombreMesSeguro(mes), signoUsd(m.usdt), signoUsd(m.efectivo), signoUsd(m.materia), signoUsd(m.otros), signoUsd(m.total), ...celdasPartidas(cp, mes)]),
        totales: ['Total', ...porCat.map(c => signoUsd(c.dif)), signoUsd(difUsd), ...totalesPartidas(cp)] },
      { titulo: 'Detalle por operación', columnas: ['Fecha', 'Categoría', 'Tipo', 'Monto $', 'Banco', 'Total Bs', 'Tasa pactada', 'Tasa BCV', 'Dif. Bs', 'Dif. $', 'Estado'], alinear: [0, 1, 2, 4, 10],
        filas: inc.map(x => [fechaCorta(x.op.fecha), NOMBRE_CATEGORIA[x.categoria] || x.categoria, x.tipo, num(x.usdt, 2), x.banco || '—', num(x.totalBs, 2), x.tasaPactada ? num(x.tasaPactada, 2) : '—', num(x.tasaBcv, 2), signo(x.difBs, 2), signoUsd(x.difUsd), etiquetaEstado(x)]),
        totales: ['Total', '', plural(inc.length, 'op.', 'op.'), '', '', '', '', '', signo(difBs, 2), signoUsd(difUsd), ''] },
      { titulo: 'Por revisar (no incluidas)', columnas: ['Fecha', 'Categoría', 'Descripción', 'Monto $', 'Motivo'], alinear: [0, 1, 2, 4],
        filas: revisar.map(x => [fechaCorta(x.op.fecha) || '—', NOMBRE_CATEGORIA[x.categoria] || x.categoria, x.op.descripcion || x.op.partida || '', num(x.usdt, 2), x.motivo]) },
    ],
    nota: fuente + ' Categorías según la partida de la línea principal de cada diferencial: BINANCE → USDT; EFECTIVO DOLARES → efectivo; materia prima, compras y cobros de clientes → materia prima y clientes; el resto → otros pagos. "Monto $" = USDT, dólares o factura al BCV.'
      + (cp ? ' "Pagos MP del mes" = todos los pagos de materia prima del mes según las partidas de los bancos; los que no tienen línea de diferencial se hicieron a tasa BCV.' : ''),
  };
}
