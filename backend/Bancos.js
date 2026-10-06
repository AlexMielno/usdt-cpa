/**
 * Diferencial desde bancos (v1.6)
 * --------------------------------
 * Lee el libro de contabilidad bancaria "ADM.-002 BANCOS CPA" (OTRO archivo de Sheets, se abre con openById)
 * y devuelve a la app, SIN interpretarlas, las filas que necesita para reconstruir el diferencial cambiario:
 *   - las pestañas de ACTIVO en $ (CONFIG.BANCOS.HOJAS_ACTIVO: BINANCE y Efectivo $): cada entrada o salida;
 *   - las pestañas de banco, detectadas por su cabecera (nunca por una lista fija de nombres): las líneas contra
 *     partida BINANCE, EFECTIVO DOLARES o DIFERENCIAL CAMBIARIO, las que mencionan USDT / BINANCE y las
 *     "líneas principales candidatas" de cada DIFERENCIAL (mismo Nro o vecinas con la misma fecha);
 *   - la pestaña TASA: BCV por día.
 * Regla de oro: TODO sale de las hojas de banco; la pestaña "R. Partidas" (se llena a mano) NO se usa.
 * El emparejamiento lo hace la app (app/src/conciliacion.js). Lo que el usuario confirma o excluye se guarda en la
 * pestaña DIF_BANCOS del libro de la app (acciones "bancosDecisiones" y "bancosGuardar").
 *
 * Rendimiento: cada pestaña tiene ~30.000 filas (hay fórmulas en SALDO hasta abajo), así que se hace UNA sola
 * lectura getValues() por pestaña y el bucle descarta enseguida las filas vacías y las que no interesan.
 * Nada de llamadas por celda. Las fechas Date se formatean con caché (pocas fechas distintas, miles de filas).
 *
 * Convención (igual que app/src/calculos.js): diferencial POSITIVO = a favor de la empresa, NEGATIVO = en contra.
 */

// Cabecera de la pestaña DIF_BANCOS (libro de la app). Se lee por NOMBRE de columna, así que una hoja creada
// con otro orden (o sin CATEGORIA) se sigue leyendo y se reescribe en este orden al guardar.
const COLUMNAS_DIF_BANCOS = ['CLAVE', 'FECHA', 'TIPO', 'CATEGORIA', 'USDT', 'BANCO', 'REFS', 'TOTAL BS', 'TASA PACTADA', 'TASA BCV', 'ESTADO', 'NOTA', 'ACTUALIZADO', 'DISPOSITIVO'];
const TIPOS_DIF_BANCOS = ['COMPRA', 'VENTA', 'PAGO', 'EXCLUIR'];
const ESTADOS_DIF_BANCOS = ['CONFIRMADA', 'EXCLUIDA'];
const CATEGORIAS_DIF_BANCOS = ['usdt', 'efectivo', 'materia', 'otros'];
const MAX_DECISIONES_BANCOS = 500;   // por llamada a bancosGuardar
const MAX_AVISOS_BANCOS = 200;       // el resto se resume en un último aviso
const VECINDAD_FILAS_BANCOS = 4;     // una línea principal está a ±4 filas de su DIFERENCIAL (misma fecha)

// Columnas (base 0) de las pestañas del libro de bancos: misma cabecera de 21 columnas en todas (salvo TASA)
const COL_BANCOS = {
  FECHA: 0, NRO: 1, DESCRIPCION: 2, CONCEPTO: 3, TIPO: 4, PARTIDA: 5, DEBE: 7, HABER: 8, COMISION: 9, IGTF: 10,
  SALDO: 11, TASA: 12, DEBE_USD: 13, HABER_USD: 14, YEAR: 18,
};
const COLUMNAS_LEIDAS_BANCOS = 20;   // A..T: una sola lectura por pestaña

// ---------------------------------------------------------------------------------------
// Acción "bancos"
// ---------------------------------------------------------------------------------------

/**
 * Acción "bancos": { desde: 'YYYY-MM-DD' | '', hasta: 'YYYY-MM-DD' | '' } (vacío = sin límite).
 * Devuelve { libro, hojaUsdt, hojasActivo, activos, usdt, bancos, movimientos, tasas, avisos }
 * (ver ESPEC_DIFERENCIAL_BANCOS.md §2.2 y §6.2).
 *  - activos[hoja]: filas con entrada o salida > 0 dentro del rango pedido (las que no tienen fecha legible
 *    también van). usdt = activos[hojaUsdt] (compatibilidad).
 *  - movimientos y tasas: dentro del rango ± CONFIG.BANCOS.MARGEN_DIAS (todo si no hay rango).
 *  - resumenPartidas: { 'YYYY-MM': { materiaCompras: { n, bs, usd }, cobranzas: { n, bs, usd } } } de todas las
 *    hojas de banco, solo con líneas dentro del rango pedido (sin margen). Contexto para el reporte de materia prima.
 */
function leerBancos_(datos) {
  const d = datos || {};
  const desde = fechaPeticionBancos_(d.desde, 'desde');
  const hasta = fechaPeticionBancos_(d.hasta, 'hasta');
  if (desde && hasta && desde > hasta) throw new ErrorApi('dato_invalido', 'La fecha "desde" es posterior a "hasta".');
  const cfg = CONFIG.BANCOS;
  const margen = Math.max(parseInt(cfg.MARGEN_DIAS, 10) || 0, 0);
  const desdeMargen = desde ? sumarDiasIso_(desde, -margen) : '';
  const hastaMargen = hasta ? sumarDiasIso_(hasta, margen) : '';

  const libro = libroBancos_();   // lanza bancos_sin_acceso si no se puede abrir
  const hojas = libro.getSheets();
  const nombresActivo = (cfg.HOJAS_ACTIVO && cfg.HOJAS_ACTIVO.length) ? cfg.HOJAS_ACTIVO : [cfg.HOJA_USDT];
  const hojaUsdt = hojaUsdtBancos_(libro, hojas, nombresActivo[0]);
  if (!hojaUsdt) throw new ErrorApi('bancos_sin_hoja_usdt', 'El libro de bancos no tiene la pestaña ' + nombresActivo[0] + ' (ni otra cuyo nombre contenga BINANCE o USDT).');
  const nombreUsdt = hojaUsdt.getName();
  const tasaNormalizada = normalizarCabecera_(cfg.HOJA_TASA);

  // Avisos con tope para no inflar la respuesta si una pestaña entera viene mal
  const avisos = [];
  let avisosOmitidos = 0;
  const avisar = t => { if (avisos.length < MAX_AVISOS_BANCOS) avisos.push(t); else avisosOmitidos++; };
  // Estado compartido del parseo de fechas: zona del libro + caché de Date ya formateadas
  const lector = { zona: zonaLibroBancos_(libro), cache: {}, anioRespaldo: '' };

  // Hojas de activo: la de USDT siempre; las demás si existen (por nombre, sin importar mayúsculas/espacios)
  const hojasActivo = [hojaUsdt];
  nombresActivo.slice(1).forEach(nombre => {
    const h = hojaPorNombreBancos_(libro, hojas, nombre);
    if (h && hojasActivo.indexOf(h) === -1 && h.getName() !== nombreUsdt) hojasActivo.push(h);
    else if (!h) avisar('No existe la pestaña de activo ' + nombre + ' en el libro de bancos.');
  });
  const activos = {};
  hojasActivo.forEach(h => { activos[h.getName()] = leerHojaActivoBancos_(h, desde, hasta, lector, avisar); });

  // Bancos: toda pestaña con la cabecera de banco salvo la de USDT y TASA. "Efectivo $" es activo Y banco a la
  // vez: sus líneas contra partida BINANCE son la contraparte de las ventas de USDT por efectivo.
  const bancos = [];
  const movimientos = [];
  // Contexto para el reporte de materia prima: totales por mes (rango pedido, SIN margen) de compras a
  // proveedores y cobranzas, acumulados en la misma pasada por cada hoja de banco (no se envían filas)
  const resumen = { desde: desde, hasta: hasta, meses: {} };
  let hojaTasa = null;
  hojas.forEach(h => {
    const nombre = h.getName();
    if (nombre === nombreUsdt) return;
    if (normalizarCabecera_(nombre) === tasaNormalizada) { hojaTasa = h; return; }
    if (!esHojaBanco_(h)) return;
    bancos.push(nombre);
    leerHojaBanco_(h, desdeMargen, hastaMargen, lector, avisar, resumen).forEach(m => movimientos.push(m));
  });
  const resumenPartidas = {};
  Object.keys(resumen.meses).sort().forEach(mes => {
    const m = resumen.meses[mes];
    resumenPartidas[mes] = {};
    ['materiaCompras', 'cobranzas'].forEach(k => {
      resumenPartidas[mes][k] = { n: m[k].n, bs: redondear_(m[k].bs, 2), usd: redondear_(m[k].usd, 2) };
    });
  });

  let tasas = {};
  if (hojaTasa) tasas = leerHojaTasaBancos_(hojaTasa, desdeMargen, hastaMargen, lector, avisar);
  else avisar('No existe la pestaña ' + cfg.HOJA_TASA + ' en el libro de bancos: no hay tasas BCV del libro.');

  if (avisosOmitidos) avisos.push('… y ' + avisosOmitidos + ' avisos más.');
  return {
    libro: { id: idLibroBancos_(), titulo: libro.getName(), leido: ahora_().toISOString() },
    desde: desde, hasta: hasta,
    hojaUsdt: nombreUsdt,
    hojasActivo: hojasActivo.map(h => h.getName()),
    activos: activos,
    usdt: activos[nombreUsdt],
    bancos: bancos,
    movimientos: movimientos,
    resumenPartidas: resumenPartidas,
    tasas: tasas,
    avisos: avisos,
  };
}

// Partidas que dan contexto al reporte de materia prima (ver acumularResumenPartidas_)
const RE_MATERIA_COMPRAS_BANCOS = /MATERIA PRIMA|COMPRAS|INVENTARIO/;
const RE_COBRANZAS_BANCOS = /CUENTAS POR COBRAR COMERCIALES|VENTAS|ANTICIPO (DE )?CLIENTES/;

/**
 * Suma una línea de banco al resumen mensual si corresponde:
 *   materiaCompras = HABER > 0 con partida MATERIA PRIMA / COMPRAS / INVENTARIO   (usd = HABER $)
 *   cobranzas      = DEBE > 0 con partida CUENTAS POR COBRAR COMERCIALES / VENTAS / ANTICIPO CLIENTES (usd = DEBE $)
 * fechaIso() se llama solo si la partida y el monto califican (la fecha se parsea una vez por fila, con caché).
 */
function acumularResumenPartidas_(resumen, f, fechaIso) {
  const p = normalizarTexto_(f[COL_BANCOS.PARTIDA]);
  const reglas = [];
  if (RE_MATERIA_COMPRAS_BANCOS.test(p)) reglas.push(['materiaCompras', COL_BANCOS.HABER, COL_BANCOS.HABER_USD]);
  // "SUELDOS Y SALARIOS VENTAS" (nómina del área de ventas) no es una cobranza
  if (RE_COBRANZAS_BANCOS.test(p) && !/SUELDO|SALARIO|NOMINA/.test(p)) reglas.push(['cobranzas', COL_BANCOS.DEBE, COL_BANCOS.DEBE_USD]);
  reglas.forEach(r => {
    const bs = numeroCelda_(f[r[1]]);
    if (!(bs > 0)) return;
    const fecha = fechaIso();
    if (!fecha || !enRangoIso_(fecha, resumen.desde, resumen.hasta)) return;
    const mes = fecha.slice(0, 7);
    const m = resumen.meses[mes] || (resumen.meses[mes] = { materiaCompras: { n: 0, bs: 0, usd: 0 }, cobranzas: { n: 0, bs: 0, usd: 0 } });
    const a = m[r[0]];
    a.n++;
    a.bs += bs;
    a.usd += numeroCelda_(f[r[2]]);
  });
}

/** Pestaña de USDT: la del nombre configurado o, si no existe, la primera cuyo nombre contenga BINANCE o USDT. */
function hojaUsdtBancos_(libro, hojas, nombre) {
  const exacta = hojaPorNombreBancos_(libro, hojas, nombre);
  if (exacta) return exacta;
  for (let i = 0; i < hojas.length; i++) {
    const n = normalizarCabecera_(hojas[i].getName());
    if (n.indexOf('BINANCE') !== -1 || n.indexOf('USDT') !== -1) return hojas[i];
  }
  return null;
}

/** Pestaña por nombre exacto o, si no, por nombre normalizado ("EFECTIVO $" = "Efectivo $"). */
function hojaPorNombreBancos_(libro, hojas, nombre) {
  const exacta = libro.getSheetByName(nombre);
  if (exacta) return exacta;
  const buscado = normalizarCabecera_(nombre);
  for (let i = 0; i < hojas.length; i++) if (normalizarCabecera_(hojas[i].getName()) === buscado) return hojas[i];
  return null;
}

/** Una pestaña es de banco si su fila 1 tiene FECHA en A, PARTIDA en F, DEBE en H y HABER en I (normalizados). */
function esHojaBanco_(hoja) {
  if (hoja.getLastRow() < 1 || hoja.getLastColumn() < 9) return false;
  return esCabeceraBanco_(hoja.getRange(1, 1, 1, 9).getValues()[0]);
}

function esCabeceraBanco_(fila) {
  const c = i => normalizarCabecera_(fila[i]);
  return c(COL_BANCOS.FECHA).indexOf('FECHA') === 0 && c(COL_BANCOS.PARTIDA).indexOf('PARTIDA') === 0 &&
    c(COL_BANCOS.DEBE).indexOf('DEBE') === 0 && c(COL_BANCOS.HABER).indexOf('HABER') === 0;
}

/** UNA lectura de toda la pestaña (A..T, o menos si la pestaña es más angosta). Fila 0 = cabecera. */
function valoresHojaBancos_(hoja, columnas) {
  const filas = hoja.getLastRow();
  const cols = Math.min(columnas, hoja.getLastColumn());
  if (filas < 1 || cols < 1) return [];
  return hoja.getRange(1, 1, filas, cols).getValues();
}

/** Pestaña de activo en $ (BINANCE, Efectivo $): DEBE = entra (compra), HABER = sale (venta o pago). */
function leerHojaActivoBancos_(hoja, desde, hasta, lector, avisar) {
  const nombre = hoja.getName();
  const v = valoresHojaBancos_(hoja, COLUMNAS_LEIDAS_BANCOS);
  const out = [];
  if (!v.length) return out;
  if (!esCabeceraBanco_(v[0])) avisar('La pestaña ' + nombre + ' no tiene la cabecera esperada (FECHA … Partida … DEBE, HABER); se leyó por posición de columna.');
  let anio = '';
  for (let i = 1; i < v.length; i++) {
    const f = v[i];
    const entrada = numeroCelda_(f[COL_BANCOS.DEBE]);
    const salida = numeroCelda_(f[COL_BANCOS.HABER]);
    if (!(entrada > 0) && !(salida > 0)) continue;   // filas vacías o solo con la fórmula del saldo
    lector.anioRespaldo = anio;
    const fe = fechaDesdeCelda_(f[COL_BANCOS.FECHA], f[COL_BANCOS.YEAR], lector);
    if (fe.fecha) {
      anio = fe.fecha.slice(0, 4);
      if (!enRangoIso_(fe.fecha, desde, hasta)) continue;
    }
    const fila = i + 1;
    if (fe.aviso) avisar(nombre + ' fila ' + fila + ': ' + fe.aviso);
    out.push({
      ref: nombre + '!' + fila,
      fila: fila,
      fecha: fe.fecha,
      fechaTexto: fechaTextoCelda_(f[COL_BANCOS.FECHA], fe.fecha),
      descripcion: texto_(f[COL_BANCOS.DESCRIPCION], 300),
      concepto: texto_(f[COL_BANCOS.CONCEPTO], 200),
      tipo: texto_(f[COL_BANCOS.TIPO], 100),
      partida: texto_(f[COL_BANCOS.PARTIDA], 200),
      entrada: redondear_(Math.max(entrada, 0), 4),
      salida: redondear_(Math.max(salida, 0), 4),
      saldo: redondear_(numeroCelda_(f[COL_BANCOS.SALDO]), 4),
    });
  }
  return out;
}

/**
 * Pestaña de banco: solo las líneas que pueden formar parte de una operación con diferencial. Clase (prioridad):
 *   BINANCE     partida contiene BINANCE
 *   EFECTIVO    partida EFECTIVO DOLARES / EFECTIVO $
 *   DIFERENCIAL partida contiene DIFERENCIAL (TODAS, de cualquier banco: también bonos, efectivo, proveedores…)
 *   OTRO        descripción o concepto con USDT / USTD / BINANCE
 *   VECINA      línea principal candidata de un DIFERENCIAL: mismo Nro (no vacío) en esta pestaña, o a ±4 filas
 *               de él con la misma fecha
 * Cada línea va una sola vez, con la clase de mayor prioridad. Se lee en tres pasadas sobre el MISMO arreglo:
 * clase propia -> vecinas de cada DIFERENCIAL -> salida filtrada por rango (± margen).
 */
function leerHojaBanco_(hoja, desde, hasta, lector, avisar, resumen) {
  const nombre = hoja.getName();
  const v = valoresHojaBancos_(hoja, COLUMNAS_LEIDAS_BANCOS);
  const n = v.length;
  const clases = new Array(n);   // clase de cada fila (undefined = no se envía)
  const nros = new Array(n);     // nroNorm de las filas con contenido (undefined = fila vacía)
  const fechas = new Array(n);   // { fecha, aviso } parseada una sola vez, solo para filas candidatas
  const difNros = {};            // Nro de las líneas DIFERENCIAL con montos
  const difFilas = [];           // índices de las líneas DIFERENCIAL con montos
  let anio = '';
  const fechaFila = i => {
    if (fechas[i] === undefined) {
      lector.anioRespaldo = anio;
      fechas[i] = fechaDesdeCelda_(v[i][COL_BANCOS.FECHA], v[i][COL_BANCOS.YEAR], lector);
      if (fechas[i].fecha) anio = fechas[i].fecha.slice(0, 4);
    }
    return fechas[i];
  };

  // 1) Clase propia de cada línea con contenido
  for (let i = 1; i < n; i++) {
    const f = v[i];
    const partida = f[COL_BANCOS.PARTIDA], descripcion = f[COL_BANCOS.DESCRIPCION], concepto = f[COL_BANCOS.CONCEPTO];
    if (celdaVacia_(partida) && celdaVacia_(descripcion) && celdaVacia_(concepto)) continue;   // fila vacía (solo SALDO)
    nros[i] = nroNormalizado_(f[COL_BANCOS.NRO]);
    if (resumen) acumularResumenPartidas_(resumen, f, () => fechaFila(i).fecha);
    const clase = claseMovimientoBanco_(partida, descripcion, concepto);
    if (!clase) continue;
    clases[i] = clase;
    if (clase === 'DIFERENCIAL' && filaConMontos_(f)) {
      difFilas.push(i);
      if (nros[i]) difNros[nros[i]] = true;
    }
  }

  // 2) Líneas principales candidatas (VECINA) de cada DIFERENCIAL
  if (difFilas.length) {
    for (let i = 1; i < n; i++) {
      if (!clases[i] && nros[i] && difNros[nros[i]]) clases[i] = 'VECINA';
    }
    difFilas.forEach(k => {
      const fk = fechaFila(k).fecha;
      if (!fk) return;
      const ini = Math.max(1, k - VECINDAD_FILAS_BANCOS), fin = Math.min(n - 1, k + VECINDAD_FILAS_BANCOS);
      for (let j = ini; j <= fin; j++) {
        if (j === k || clases[j] || nros[j] === undefined) continue;
        if (fechaFila(j).fecha === fk) clases[j] = 'VECINA';
      }
    });
  }

  // 3) Salida: líneas con clase y con montos, dentro del rango (± margen) o sin fecha legible
  const out = [];
  for (let i = 1; i < n; i++) {
    const clase = clases[i];
    if (!clase) continue;
    const f = v[i];
    const debeBs = numeroCelda_(f[COL_BANCOS.DEBE]), haberBs = numeroCelda_(f[COL_BANCOS.HABER]);
    const debeUsd = numeroCelda_(f[COL_BANCOS.DEBE_USD]), haberUsd = numeroCelda_(f[COL_BANCOS.HABER_USD]);
    if (!debeBs && !haberBs && !debeUsd && !haberUsd) continue;   // línea sin montos: no sirve para emparejar
    const fe = fechaFila(i);
    if (fe.fecha && !enRangoIso_(fe.fecha, desde, hasta)) continue;
    const fila = i + 1;
    if (fe.aviso) avisar(nombre + ' fila ' + fila + ': ' + fe.aviso);
    out.push({
      ref: nombre + '!' + fila,
      banco: nombre,
      fila: fila,
      fecha: fe.fecha,
      fechaTexto: fechaTextoCelda_(f[COL_BANCOS.FECHA], fe.fecha),
      nro: texto_(f[COL_BANCOS.NRO], 40),
      nroNorm: nros[i] || '',
      descripcion: texto_(f[COL_BANCOS.DESCRIPCION], 300),
      concepto: texto_(f[COL_BANCOS.CONCEPTO], 200),
      tipo: texto_(f[COL_BANCOS.TIPO], 100),
      partida: texto_(f[COL_BANCOS.PARTIDA], 200),
      debeBs: redondear_(debeBs, 2),
      haberBs: redondear_(haberBs, 2),
      comisionBs: redondear_(numeroCelda_(f[COL_BANCOS.COMISION]), 2),
      igtfBs: redondear_(numeroCelda_(f[COL_BANCOS.IGTF]), 2),
      tasa: redondear_(numeroCelda_(f[COL_BANCOS.TASA]), 4),
      debeUsd: redondear_(debeUsd, 4),
      haberUsd: redondear_(haberUsd, 4),
      clase: clase,
    });
  }
  return out;
}

/** Clase propia de una línea de banco por su partida (o por el texto si no); '' = no interesa por sí sola. */
function claseMovimientoBanco_(partida, descripcion, concepto) {
  const p = normalizarTexto_(partida);
  if (p.indexOf('BINANCE') !== -1) return 'BINANCE';
  if (/EFECTIVO ?(DOLAR|\$|USD)/.test(p)) return 'EFECTIVO';
  if (p.indexOf('DIFERENCIAL') !== -1) return 'DIFERENCIAL';
  const t = normalizarTexto_(descripcion) + ' ' + normalizarTexto_(concepto);
  if (/USDT|USTD|BINANCE/.test(t)) return 'OTRO';
  return '';
}

function filaConMontos_(f) {
  return !!(numeroCelda_(f[COL_BANCOS.DEBE]) || numeroCelda_(f[COL_BANCOS.HABER]) ||
    numeroCelda_(f[COL_BANCOS.DEBE_USD]) || numeroCelda_(f[COL_BANCOS.HABER_USD]));
}

/** Nro como texto sin espacios (47900093210). '' si está vacío o no identifica nada ("0", "-"). */
function nroNormalizado_(v) {
  if (v === '' || v === null || v === undefined) return '';
  const s = String(v).replace(/\s+/g, '');
  return /[1-9A-Za-z]/.test(s) ? s : '';
}

/** Pestaña TASA: A FECHA | B TASA BCV. No siempre ordenada; si una fecha se repite, gana la última fila. */
function leerHojaTasaBancos_(hoja, desde, hasta, lector, avisar) {
  const nombre = hoja.getName();
  const v = valoresHojaBancos_(hoja, 2);
  const tasas = {};
  let anio = '';
  for (let i = 1; i < v.length; i++) {
    const f = v[i];
    if (celdaVacia_(f[0]) && celdaVacia_(f[1])) continue;
    const tasa = numeroCelda_(f[1]);
    if (!(tasa > 0)) continue;
    lector.anioRespaldo = anio;
    const fe = fechaDesdeCelda_(f[0], '', lector);
    if (!fe.fecha) { avisar(nombre + ' fila ' + (i + 1) + ': ' + fe.aviso + ' (tasa ' + tasa + ' ignorada)'); continue; }
    anio = fe.fecha.slice(0, 4);
    if (!enRangoIso_(fe.fecha, desde, hasta)) continue;
    if (fe.aviso) avisar(nombre + ' fila ' + (i + 1) + ': ' + fe.aviso);
    tasas[fe.fecha] = redondear_(tasa, 4);
  }
  return tasas;
}

// ---------------------------------------------------------------------------------------
// Parseo de celdas (fechas y números escritos a mano en la contabilidad)
// ---------------------------------------------------------------------------------------

/**
 * Convierte una celda de fecha a 'YYYY-MM-DD'.
 *   Date   -> se formatea en la zona del libro (opciones.zona; por defecto la del script), con caché.
 *   número -> serial de Sheets (días desde 1899-12-30), calculado en UTC para no perder un día.
 *   texto  -> d/m/yyyy, d/m/yy, d-m-yy, d-m-yyyy (también yyyy-mm-dd) y d/m sin año: el año sale de la
 *             columna YEAR (anioColumna) o, si no sirve, de la última fila válida (opciones.anioRespaldo).
 * Devuelve { fecha: 'YYYY-MM-DD' | '', aviso: '' | 'texto para el usuario' }. Nunca lanza.
 */
function fechaDesdeCelda_(valor, anioColumna, opciones) {
  const o = opciones || {};
  if (valor instanceof Date) {
    const t = valor.getTime();
    if (!isFinite(t)) return { fecha: '', aviso: 'fecha inválida' };
    if (o.cache && o.cache[t] !== undefined) return { fecha: o.cache[t], aviso: '' };
    const iso = Utilities.formatDate(valor, o.zona || CONFIG_TZ_(), 'yyyy-MM-dd');
    if (o.cache) o.cache[t] = iso;
    return { fecha: iso, aviso: '' };
  }
  if (typeof valor === 'number') {
    const iso = fechaDesdeSerial_(valor);
    return iso ? { fecha: iso, aviso: '' } : { fecha: '', aviso: 'fecha "' + valor + '" no reconocida' };
  }
  const s = texto_(valor, 40);
  if (!s) return { fecha: '', aviso: 'sin fecha' };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return fechaArmada_(+m[1], +m[2], +m[3], s);
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s);
  if (m) return fechaArmada_(m[3].length === 2 ? 2000 + (+m[3]) : +m[3], +m[2], +m[1], s);
  m = /^(\d{1,2})[\/\-.](\d{1,2})$/.exec(s);
  if (m) {
    const anioCol = anioValido_(anioColumna);
    const anioPrev = anioValido_(o.anioRespaldo);
    const anio = anioCol || anioPrev;
    if (!anio) return { fecha: '', aviso: 'fecha "' + s + '" sin año y sin columna YEAR' };
    const r = fechaArmada_(anio, +m[2], +m[1], s);
    if (r.fecha) r.aviso = 'fecha "' + s + '" sin año, se asumió ' + anio + (anioCol ? ' por la columna YEAR' : ' por la fila anterior');
    return r;
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) {   // un serial pegado como texto
    const iso = fechaDesdeSerial_(parseFloat(s));
    if (iso) return { fecha: iso, aviso: '' };
  }
  return { fecha: '', aviso: 'fecha "' + s + '" no reconocida' };
}

/** Serial de Sheets -> 'YYYY-MM-DD' (en UTC; la fracción de día, si la hay, se ignora). */
function fechaDesdeSerial_(serial) {
  if (!isFinite(serial) || serial < 1 || serial > 2958465) return '';
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial + 1e-7) * 86400000).toISOString().slice(0, 10);
}

function fechaArmada_(anio, mes, dia, original) {
  const iso = isoDesdePartes_(anio, mes, dia);
  return iso ? { fecha: iso, aviso: '' } : { fecha: '', aviso: 'fecha "' + original + '" no válida' };
}

/** 'YYYY-MM-DD' si la fecha existe (rechaza 31/02, mes 13, etc.); '' si no. */
function isoDesdePartes_(anio, mes, dia) {
  if (!(anio >= 1900 && anio <= 2200) || !(mes >= 1 && mes <= 12) || !(dia >= 1 && dia <= 31)) return '';
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  if (d.getUTCFullYear() !== anio || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return '';
  return d.toISOString().slice(0, 10);
}

/** Año utilizable de la columna YEAR (número o texto de 4 dígitos); 0 si no sirve. */
function anioValido_(v) {
  let n = 0;
  if (typeof v === 'number') n = Math.floor(v);
  else if (typeof v === 'string' && /^\s*\d{4}\s*$/.test(v)) n = parseInt(v, 10);
  return n >= 1900 && n <= 2200 ? n : 0;
}

/** Lo que había en la celda, para mostrarlo: el texto tal cual, o dd/mm/yyyy si era fecha de verdad. */
function fechaTextoCelda_(valor, iso) {
  if (typeof valor === 'string') return texto_(valor, 40);
  if (iso) return iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
  return valor === null || valor === undefined ? '' : texto_(valor, 40);
}

/**
 * Número de una celda: si ya es número, tal cual; si es texto, estilo es-VE ("$6.264,34", "  1.000,00 ",
 * "  -   " = 0, "(1.000,00)" = negativo). Lo ilegible (#N/A, textos) vale 0.
 */
function numeroCelda_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (typeof v !== 'string' || v === '') return 0;
  let s = v.replace(/[^0-9.,()\-]/g, '');
  if (!/\d/.test(s)) return 0;   // '', '-', '  -   ', '#N/A'
  const negativo = /^\(.*\)$/.test(s) || s.charAt(0) === '-' || s.charAt(s.length - 1) === '-';
  s = s.replace(/[()\-]/g, '');
  const coma = s.lastIndexOf(','), punto = s.lastIndexOf('.');
  if (coma !== -1 && punto !== -1) {
    // Los dos separadores: el último es el decimal (1.234,56 es-VE; 1,234.56 en-US)
    s = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (coma !== -1) {
    s = (s.indexOf(',') === coma) ? s.replace(',', '.') : s.replace(/,/g, '');   // 1234,5  |  1,234,567
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');   // 1.000 / 1.234.567: puntos de miles (es-VE)
  }
  const n = parseFloat(s);
  if (!isFinite(n)) return 0;
  return negativo ? -n : n;
}

function celdaVacia_(v) {
  return v === '' || v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Mayúsculas, sin acentos y con espacios simples (para comparar partidas y descripciones). */
function normalizarTexto_(v) {
  if (v === '' || v === null || v === undefined) return '';
  let s = String(v).toUpperCase();
  if (/[^\x00-\x7F]/.test(s)) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** Como normalizarTexto_ pero sin ningún espacio (para cabeceras y nombres de pestaña: "DEBE " = "DEBE"). */
function normalizarCabecera_(v) {
  return normalizarTexto_(v).replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------------------
// Fechas ISO (texto 'YYYY-MM-DD'): se comparan como cadenas, sin zonas horarias
// ---------------------------------------------------------------------------------------

function fechaPeticionBancos_(v, nombre) {
  const s = texto_(v, 10);
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m || !isoDesdePartes_(+m[1], +m[2], +m[3])) throw new ErrorApi('dato_invalido', 'La fecha "' + nombre + '" no es válida (AAAA-MM-DD).');
  return s;
}

function sumarDiasIso_(iso, dias) {
  const p = iso.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + dias)).toISOString().slice(0, 10);
}

/** desde/hasta vacíos = sin límite por ese lado. */
function enRangoIso_(iso, desde, hasta) {
  return (!desde || iso >= desde) && (!hasta || iso <= hasta);
}

/** Zona horaria del libro de bancos: Sheets entrega las fechas a medianoche en ESA zona. */
function zonaLibroBancos_(libro) {
  try {
    return (libro.getSpreadsheetTimeZone && libro.getSpreadsheetTimeZone()) || CONFIG_TZ_();
  } catch (e) {
    return CONFIG_TZ_();
  }
}

// ---------------------------------------------------------------------------------------
// Decisiones del usuario (pestaña DIF_BANCOS del libro de la app)
// ---------------------------------------------------------------------------------------

/** Pestaña DIF_BANCOS; con crear = true la agrega (con cabecera) si no existe. */
function hojaDecisionesBancos_(crear) {
  const nombre = CONFIG.BANCOS.HOJA_DECISIONES;
  let h = libro_().getSheetByName(nombre);
  if (!h && !crear) return null;
  if (!h) h = libro_().insertSheet(nombre);
  if (h.getLastRow() < 1) {
    h.getRange(1, 1, 1, COLUMNAS_DIF_BANCOS.length).setValues([COLUMNAS_DIF_BANCOS]);
    h.setFrozenRows(1);
  }
  return h;
}

/**
 * Lee DIF_BANCOS por NOMBRE de columna y devuelve las filas en el orden de COLUMNAS_DIF_BANCOS
 * (columnas que falten, p. ej. CATEGORIA en una hoja vieja, quedan ''). { filas, ultimaFila, ancho }
 */
function tablaDecisionesBancos_(hoja) {
  const ultimaFila = hoja.getLastRow();
  const ancho = Math.max(hoja.getLastColumn(), COLUMNAS_DIF_BANCOS.length);
  if (ultimaFila < 1) return { filas: [], ultimaFila: 0, ancho: ancho };
  const v = hoja.getRange(1, 1, ultimaFila, ancho).getValues();
  const cabecera = v[0].map(normalizarCabecera_);
  let indices = COLUMNAS_DIF_BANCOS.map(c => cabecera.indexOf(normalizarCabecera_(c)));
  if (indices[0] === -1) indices = COLUMNAS_DIF_BANCOS.map((c, j) => j);   // sin cabecera reconocible: orden estándar
  const filas = v.slice(1).map(f => indices.map(j => (j === -1 ? '' : f[j])));
  return { filas: filas, ultimaFila: ultimaFila, ancho: ancho };
}

/** Acción "bancosDecisiones": todas las decisiones guardadas. */
function decisionesBancos_() {
  const hoja = hojaDecisionesBancos_(false);
  if (!hoja) return { decisiones: [] };
  const t = tablaDecisionesBancos_(hoja);
  return { decisiones: t.filas.filter(f => String(f[0]).trim() !== '').map(decisionDesdeFilaBancos_) };
}

/**
 * Acción "bancosGuardar": { decisiones: [...], borrar: ['clave', ...] }.
 * Upsert por clave (reescribe la fila existente o agrega una nueva) y borra las claves pedidas.
 * Si una clave viene en las dos listas, gana la decisión (se guarda). Devuelve { guardadas, borradas }.
 */
function guardarDecisionesBancos_(datos, sesion) {
  const d = datos || {};
  const lista = d.decisiones === undefined || d.decisiones === null ? [] : d.decisiones;
  const borrar = d.borrar === undefined || d.borrar === null ? [] : d.borrar;
  if (!Array.isArray(lista) || !Array.isArray(borrar)) throw new ErrorApi('dato_invalido', '"decisiones" y "borrar" deben ser listas.');
  if (lista.length > MAX_DECISIONES_BANCOS || borrar.length > MAX_DECISIONES_BANCOS) {
    throw new ErrorApi('dato_invalido', 'Máximo ' + MAX_DECISIONES_BANCOS + ' decisiones por llamada.');
  }
  const dispositivo = texto_((sesion || {}).d || (sesion || {}).dispositivo, 60);
  const ahora = ahora_();
  // Se valida TODO antes de tocar la hoja: si una decisión es inválida no se guarda ninguna
  const nuevas = {};
  lista.forEach((x, i) => {
    const dec = validarDecisionBancos_(x, i);
    nuevas[dec.clave] = filaDesdeDecisionBancos_(dec, ahora, dispositivo);
  });
  const aBorrar = {};
  borrar.forEach(c => {
    const k = texto_(c, 120);
    if (k && !Object.prototype.hasOwnProperty.call(nuevas, k)) aBorrar[k] = true;
  });
  if (!Object.keys(nuevas).length && !Object.keys(aBorrar).length) return { guardadas: 0, borradas: 0 };

  const columnas = COLUMNAS_DIF_BANCOS.length;
  let guardadas = 0, borradas = 0;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const hoja = hojaDecisionesBancos_(true);
    const t = tablaDecisionesBancos_(hoja);
    const filas = [];
    const escritas = {};
    t.filas.forEach(f => {
      const clave = String(f[0]).trim();
      if (!clave) return;   // filas vacías: se compactan
      if (aBorrar[clave]) { borradas++; return; }
      if (Object.prototype.hasOwnProperty.call(nuevas, clave)) {
        if (!escritas[clave]) { filas.push(nuevas[clave]); escritas[clave] = true; guardadas++; }
        return;   // una clave repetida en la hoja queda una sola vez
      }
      filas.push(f);
    });
    Object.keys(nuevas).forEach(clave => {
      if (!escritas[clave]) { filas.push(nuevas[clave]); escritas[clave] = true; guardadas++; }
    });
    // Cabecera + bloque completo en UNA escritura (así una hoja vieja queda con el orden actual)
    // y se limpian las filas que sobran abajo
    hoja.getRange(1, 1, filas.length + 1, columnas).setValues([COLUMNAS_DIF_BANCOS].concat(filas));
    const sobran = t.ultimaFila - (filas.length + 1);
    if (sobran > 0) hoja.getRange(filas.length + 2, 1, sobran, t.ancho).clearContent();
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { guardadas: guardadas, borradas: borradas };
}

function validarDecisionBancos_(x, i) {
  const d = x || {};
  const donde = ' (decisión ' + (i + 1) + ')';
  const clave = texto_(d.clave, 120);
  if (!clave) throw new ErrorApi('dato_invalido', 'Falta la clave' + donde + '.');
  const fecha = texto_(d.fecha, 10);
  if (fecha) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
    if (!m || !isoDesdePartes_(+m[1], +m[2], +m[3])) throw new ErrorApi('dato_invalido', 'Fecha inválida' + donde + ' (AAAA-MM-DD).');
  }
  const tipo = texto_(d.tipo, 10).toUpperCase();
  if (TIPOS_DIF_BANCOS.indexOf(tipo) === -1) throw new ErrorApi('dato_invalido', 'Tipo inválido' + donde + ': COMPRA, VENTA, PAGO o EXCLUIR.');
  let categoria = texto_(d.categoria, 12).toLowerCase();
  if (!categoria) categoria = categoriaPorClaveBancos_(clave);
  if (CATEGORIAS_DIF_BANCOS.indexOf(categoria) === -1) throw new ErrorApi('dato_invalido', 'Categoría inválida' + donde + ': usdt, efectivo, materia u otros.');
  let estado = texto_(d.estado, 12).toUpperCase();
  if (tipo === 'EXCLUIR') estado = 'EXCLUIDA';
  else if (!estado) estado = 'CONFIRMADA';
  if (ESTADOS_DIF_BANCOS.indexOf(estado) === -1) throw new ErrorApi('dato_invalido', 'Estado inválido' + donde + ': CONFIRMADA o EXCLUIDA.');
  let refs = d.refs;
  if (typeof refs === 'string') {
    try { refs = JSON.parse(refs); } catch (e) { refs = refs.split(/[,;]/); }
  }
  if (refs === undefined || refs === null || refs === '') refs = [];
  if (!Array.isArray(refs)) throw new ErrorApi('dato_invalido', 'refs debe ser una lista' + donde + '.');
  if (refs.length > 50) throw new ErrorApi('dato_invalido', 'Demasiadas líneas bancarias' + donde + ' (máximo 50).');
  return {
    clave: clave,
    fecha: fecha,
    tipo: tipo,
    categoria: categoria,
    usdt: redondear_(numero_(d.usdt, 'USDT' + donde, { opcional: true, min: 0, max: 1e9 }), 4),
    banco: texto_(d.banco, 60),
    refs: refs.map(r => texto_(r, 80)).filter(r => r),
    totalBs: redondear_(numero_(d.totalBs, 'total Bs' + donde, { opcional: true, min: 0, max: 1e15 }), 2),
    tasaPactada: redondear_(numero_(d.tasaPactada, 'tasa pactada' + donde, { opcional: true, min: 0, max: 1e9 }), 4),
    tasaBcv: redondear_(numero_(d.tasaBcv, 'tasa BCV' + donde, { opcional: true, min: 0, max: 1e9 }), 4),
    estado: estado,
    nota: texto_(d.nota, 500),
  };
}

/** Categoría por defecto si la app no la manda (o en filas viejas): por el prefijo de la clave. */
function categoriaPorClaveBancos_(clave) {
  const c = normalizarCabecera_(String(clave).split('|')[0]);
  if (c === 'EFECTIVO$' || c === 'EFECTIVO') return 'efectivo';
  if (c === 'DIF') return 'otros';
  return 'usdt';
}

/** Fila de DIF_BANCOS (orden de COLUMNAS_DIF_BANCOS). FECHA va como 'YYYY-MM-DD' (Sheets la vuelve fecha). */
function filaDesdeDecisionBancos_(dec, ahora, dispositivo) {
  return [
    celdaTextoSegura_(dec.clave), dec.fecha, dec.tipo, dec.categoria, dec.usdt, celdaTextoSegura_(dec.banco),
    JSON.stringify(dec.refs), dec.totalBs, dec.tasaPactada, dec.tasaBcv, dec.estado, celdaTextoSegura_(dec.nota),
    ahora, celdaTextoSegura_(dispositivo),
  ];
}

function decisionDesdeFilaBancos_(f) {
  let refs = [];
  const r = f[6];
  if (!celdaVacia_(r)) {
    try {
      const p = JSON.parse(String(r));
      refs = Array.isArray(p) ? p.map(x => String(x)) : [String(p)];
    } catch (e) {
      refs = String(r).split(/[,;\s]+/).filter(x => x);   // editada a mano en la hoja
    }
  }
  const clave = String(f[0]).trim();
  const categoria = texto_(f[3], 12).toLowerCase();
  return {
    clave: clave,
    fecha: f[1] instanceof Date ? formatoFecha_(f[1]) : texto_(f[1], 10),
    tipo: texto_(f[2], 10).toUpperCase(),
    categoria: CATEGORIAS_DIF_BANCOS.indexOf(categoria) !== -1 ? categoria : categoriaPorClaveBancos_(clave),
    usdt: Number(f[4]) || 0,
    banco: texto_(f[5], 60),
    refs: refs,
    totalBs: Number(f[7]) || 0,
    tasaPactada: Number(f[8]) || 0,
    tasaBcv: Number(f[9]) || 0,
    estado: texto_(f[10], 12).toUpperCase(),
    nota: texto_(f[11], 500),
    actualizado: f[12] instanceof Date ? f[12].toISOString() : texto_(f[12], 40),
    dispositivo: texto_(f[13], 60),
  };
}

/** Evita que un texto del usuario se interprete como fórmula en la hoja (=, +, -, @ al inicio). */
function celdaTextoSegura_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
