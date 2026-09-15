/**
 * Reglas de comisiones por defecto. Se aplican automáticamente al registrar (el usuario puede
 * corregir el valor en cada operación). Se guardan cifradas en el dispositivo; si no hay nada
 * guardado se usan las de config.js.
 *
 *   usdtPct : % del monto en USDT (comisión de Binance / del comercio)
 *   usdtFijo: USDT fijos por operación
 *   vesPct  : % del total en bolívares (comisión bancaria, pago móvil)
 *   vesFijo : bolívares fijos por operación
 */
import * as almacen from './almacen.js';

const POR_DEFECTO = {
  compra: { usdtPct: 0.24, usdtFijo: 0, vesPct: 0, vesFijo: 0 },
  venta: { usdtPct: 0.24, usdtFijo: 0, vesPct: 0, vesFijo: 0 },
};
const ESQUEMA = 2;   // las reglas guardadas con un esquema anterior (valores provisionales) se descartan

export function reglasPorDefecto() {
  const c = (window.CONFIG_USDT || {}).COMISIONES || {};
  return { compra: Object.assign({}, POR_DEFECTO.compra, c.compra || {}), venta: Object.assign({}, POR_DEFECTO.venta, c.venta || {}) };
}

export async function comisionesConfiguradas() {
  try {
    const g = await almacen.leer('comisiones');
    if (g && g.compra && g.venta && g.esquema === ESQUEMA) return g;
  } catch (e) { /* bloqueado o sin datos */ }
  return reglasPorDefecto();
}

export async function guardarComisiones(reglas) {
  const limpiar = (r) => ({ usdtPct: Math.max(0, Number(r.usdtPct) || 0), usdtFijo: Math.max(0, Number(r.usdtFijo) || 0), vesPct: Math.max(0, Number(r.vesPct) || 0), vesFijo: Math.max(0, Number(r.vesFijo) || 0) });
  const r = { compra: limpiar(reglas.compra || {}), venta: limpiar(reglas.venta || {}), esquema: ESQUEMA };
  await almacen.guardar('comisiones', r);
  return r;
}
