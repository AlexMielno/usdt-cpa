/**
 * Tasas de cambio
 * ---------------
 *  - BCV: se lee la página oficial (www.bcv.org.ve); si falla, se usa ve.dolarapi.com como respaldo.
 *  - Binance P2P (par USDT/VES): se consultan los anuncios públicos de ambos lados del libro.
 *
 * Convención de nombres (desde el punto de vista del usuario de la app):
 *   p2p.compra = precio al que el usuario COMPRA USDT  -> anuncios de VENTA de Binance (tradeType SELL)
 *   p2p.venta  = precio al que el usuario VENDE USDT   -> anuncios de COMPRA de Binance (tradeType BUY)
 *
 * "Tasa sugerida": promedio de los 5 mejores anuncios de anunciantes serios
 * (>= 50 órdenes/mes y >= 95 % de finalización). El usuario siempre puede cambiarla.
 */

// ---------------------------------------------------------------------------------------
// BCV
// ---------------------------------------------------------------------------------------
function obtenerBcv_() {
  try {
    const html = UrlFetchApp.fetch('https://www.bcv.org.ve/', {
      validateHttpsCertificates: false, muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (USDT-CPA)' },
    }).getContentText();
    const bloque = html.split('id="dolar"')[1] || '';
    const m = bloque.match(/<strong[^>]*>\s*([\d\.]+,\d+)\s*<\/strong>/);
    const f = html.match(/Fecha Valor:.*?content="(\d{4}-\d{2}-\d{2})/s);
    if (m) {
      const valor = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
      if (valor > 0) return { valor: valor, fechaValor: f ? f[1] : '', fuente: 'bcv.org.ve' };
    }
  } catch (e) { /* se intenta el respaldo */ }
  try {
    const d = JSON.parse(UrlFetchApp.fetch('https://ve.dolarapi.com/v1/dolares/oficial', { muteHttpExceptions: true }).getContentText());
    if (d && d.promedio > 0) return { valor: Number(d.promedio), fechaValor: String(d.fechaActualizacion || '').slice(0, 10), fuente: 'dolarapi.com' };
  } catch (e) { /* sin datos */ }
  return null;
}

// ---------------------------------------------------------------------------------------
// Binance P2P
// ---------------------------------------------------------------------------------------
function obtenerAnunciosBinance_(tradeType) {
  const resp = UrlFetchApp.fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (USDT-CPA)', 'Accept': 'application/json' },
    payload: JSON.stringify({ fiat: 'VES', page: 1, rows: CONFIG.ANUNCIOS_P2P, tradeType: tradeType, asset: 'USDT', payTypes: [], publisherType: null }),
  });
  if (resp.getResponseCode() !== 200) throw new Error('Binance respondió ' + resp.getResponseCode());
  const d = JSON.parse(resp.getContentText());
  if (!d || !d.data) throw new Error('Respuesta de Binance sin datos');
  return d.data.map(a => ({
    precio: parseFloat(a.adv.price),
    disponible: parseFloat(a.adv.tradableQuantity),
    minVes: parseFloat(a.adv.minSingleTransAmount),
    maxVes: parseFloat(a.adv.maxSingleTransAmount),
    anunciante: a.advertiser.nickName,
    tipoUsuario: a.advertiser.userType,
    ordenesMes: Number(a.advertiser.monthOrderCount || 0),
    finalizacion: Number(a.advertiser.monthFinishRate || 0),
    metodos: (a.adv.tradeMethods || []).map(m => m.tradeMethodName || m.identifier),
  }));
}

/** Calcula mejor precio, promedio de 5 y mediana sobre la lista (ya ordenada por Binance de mejor a peor). */
function resumirAnuncios_(anuncios) {
  const serios = anuncios.filter(a => a.ordenesMes >= CONFIG.FILTRO_P2P.ordenesMes && a.finalizacion >= CONFIG.FILTRO_P2P.tasaFinalizacion);
  const base = serios.length >= 3 ? serios : anuncios;
  const top5 = base.slice(0, 5).map(a => a.precio);
  const precios = base.map(a => a.precio).sort((x, y) => x - y);
  const mediana = precios.length ? (precios.length % 2 ? precios[(precios.length - 1) / 2] : (precios[precios.length / 2 - 1] + precios[precios.length / 2]) / 2) : 0;
  return {
    mejor: anuncios.length ? anuncios[0].precio : 0,
    promedio5: top5.length ? redondear_(top5.reduce((s, p) => s + p, 0) / top5.length, 4) : 0,
    mediana: redondear_(mediana, 4),
    cantidad: anuncios.length,
    anuncios: anuncios,
  };
}

function obtenerP2p_() {
  const compra = resumirAnuncios_(obtenerAnunciosBinance_('SELL'));   // el usuario compra a quien vende
  const venta = resumirAnuncios_(obtenerAnunciosBinance_('BUY'));     // el usuario vende a quien compra
  return { compra: compra, venta: venta };
}

// ---------------------------------------------------------------------------------------
// Tasas en vivo (con caché de 5 min) + última captura guardada como respaldo
// ---------------------------------------------------------------------------------------
function tasasEnVivo_(forzar) {
  const cache = CacheService.getScriptCache();
  if (!forzar) {
    const c = cache.get('tasas_vivo');
    if (c) return JSON.parse(c);
  }
  const errores = [];
  let bcv = null, p2p = null;
  try { bcv = obtenerBcv_(); if (!bcv) errores.push('BCV no disponible'); } catch (e) { errores.push('BCV: ' + e.message); }
  try { p2p = obtenerP2p_(); } catch (e) { errores.push('Binance P2P: ' + e.message); }

  const ultima = ultimaCaptura_();
  const r = {
    actualizado: ahora_().toISOString(),
    bcv: bcv || (ultima ? { valor: ultima.bcv, fechaValor: ultima.bcvFechaValor, fuente: 'última captura ' + ultima.fechaHora } : null),
    p2p: p2p || (ultima ? {
      compra: { mejor: ultima.p2pCompraMejor, promedio5: ultima.p2pCompraProm5, mediana: 0, cantidad: 0, anuncios: [], respaldo: true },
      venta: { mejor: ultima.p2pVentaMejor, promedio5: ultima.p2pVentaProm5, mediana: 0, cantidad: 0, anuncios: [], respaldo: true },
    } : null),
    errores: errores,
  };
  if (r.bcv && r.p2p) {
    r.brechaPct = r.bcv.valor ? redondear_((r.p2p.venta.promedio5 / r.bcv.valor - 1) * 100, 2) : 0;
    r.sugerida = { compra: r.p2p.compra.promedio5 || r.p2p.compra.mejor, venta: r.p2p.venta.promedio5 || r.p2p.venta.mejor };
  }
  if (bcv && p2p) {
    try { cache.put('tasas_vivo', JSON.stringify(r), CONFIG.CACHE_TASAS_SEG); } catch (e) { /* demasiado grande para caché: se ignora */ }
  }
  return r;
}

function ultimaCaptura_() {
  const h = libro_().getSheetByName(CONFIG.HOJA_TASAS);
  if (!h || h.getLastRow() < 2) return null;
  const f = h.getRange(h.getLastRow(), 1, 1, 9).getValues()[0];
  return {
    fechaHora: f[0] instanceof Date ? Utilities.formatDate(f[0], CONFIG_TZ_(), 'dd/MM/yyyy HH:mm') : String(f[0]),
    bcv: Number(f[1]), bcvFechaValor: f[2] instanceof Date ? formatoFecha_(f[2]) : String(f[2]),
    p2pCompraMejor: Number(f[3]), p2pCompraProm5: Number(f[4]),
    p2pVentaMejor: Number(f[5]), p2pVentaProm5: Number(f[6]),
    brechaPct: Number(f[7]), fuenteBcv: String(f[8]),
  };
}

/**
 * Captura periódica (disparador cada 30 min): guarda una fila en la pestaña TASAS.
 * Así queda un histórico consultable desde Google Sheets aunque la app no esté abierta.
 */
function capturarTasas() {
  const t = tasasEnVivo_(true);
  if (!t.bcv || !t.p2p) { Logger.log('Captura omitida: ' + t.errores.join(' | ')); return; }
  const h = hoja_(CONFIG.HOJA_TASAS);
  const fechaValor = t.bcv.fechaValor ? new Date(t.bcv.fechaValor + 'T12:00:00') : '';
  h.appendRow([
    ahora_(), t.bcv.valor, fechaValor,
    t.p2p.compra.mejor, t.p2p.compra.promedio5,
    t.p2p.venta.mejor, t.p2p.venta.promedio5,
    t.bcv.valor ? (t.p2p.venta.promedio5 / t.bcv.valor - 1) : 0,
    t.bcv.fuente,
  ]);
}

/** Últimas N capturas (para la gráfica de tendencia de la app). */
function historicoTasas_(n) {
  const h = libro_().getSheetByName(CONFIG.HOJA_TASAS);
  if (!h || h.getLastRow() < 2) return [];
  const total = h.getLastRow() - 1;
  const cant = Math.min(total, Math.max(1, Math.min(n || 96, 500)));
  return h.getRange(h.getLastRow() - cant + 1, 1, cant, 8).getValues().map(f => ({
    t: f[0] instanceof Date ? f[0].toISOString() : String(f[0]),
    bcv: Number(f[1]), compra: Number(f[4]), venta: Number(f[6]), brecha: Number(f[7]),
  }));
}
