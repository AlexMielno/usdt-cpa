/**
 * Capa de datos: habla con la API y mantiene una copia cifrada en el dispositivo para que la app
 * abra al instante y funcione en modo lectura sin conexión.
 */
import * as api from './api.js';
import * as almacen from './almacen.js';
import { estado, emitir } from './estado.js';

const MIN_TASAS = () => ((window.CONFIG_USDT || {}).MINUTOS_REFRESCO_TASAS || 5) * 60000;

/** Carga desde el almacén cifrado lo que haya (al desbloquear). */
export async function restaurarLocal() {
  const t = await almacen.leer('tasas');
  if (t) { estado.tasas = t.datos; estado.tasasHora = t.hora; }
  const o = await almacen.leer('operaciones');
  if (o) { estado.operaciones = o.datos || []; estado.operacionesHora = o.hora || 0; }
  const h = await almacen.leer('historico');
  if (h) estado.historico = h;
  const carteras = (window.CONFIG_USDT || {}).CARTERAS || [];
  const guardada = await almacen.leer('cartera');
  estado.cartera = carteras.includes(guardada) ? guardada : (carteras[0] || estado.cartera);
}

export async function cambiarCartera(c) {
  estado.cartera = c;
  await almacen.guardar('cartera', c);
  emitir('cartera', c);
}

export async function cargarTasas(forzar) {
  if (!forzar && estado.tasas && Date.now() - estado.tasasHora < MIN_TASAS()) return estado.tasas;
  const datos = await api.tasas(forzar);
  estado.tasas = datos; estado.tasasHora = Date.now();
  await almacen.guardar('tasas', { datos, hora: estado.tasasHora });
  emitir('tasas', datos);
  return datos;
}

export async function cargarHistorico() {
  try {
    const h = await api.historico(96);
    estado.historico = h;
    await almacen.guardar('historico', h);
    emitir('historico', h);
  } catch (e) { /* la gráfica es opcional */ }
  return estado.historico;
}

export async function cargarOperaciones(forzar) {
  if (!forzar && estado.operaciones.length && Date.now() - estado.operacionesHora < 120000) return estado.operaciones;
  const r = await api.listar({ limite: 3000 });
  estado.operaciones = r.operaciones || [];
  estado.operacionesHora = Date.now();
  await almacen.guardar('operaciones', { datos: estado.operaciones, hora: estado.operacionesHora });
  emitir('operaciones', estado.operaciones);
  return estado.operaciones;
}

export async function registrarOperacion(op) {
  const creada = await api.registrar(op);
  estado.operaciones = [creada, ...estado.operaciones.filter(o => o.id !== creada.id)];
  estado.operacionesHora = Date.now();
  await almacen.guardar('operaciones', { datos: estado.operaciones, hora: estado.operacionesHora });
  emitir('operaciones', estado.operaciones);
  return creada;
}

export async function anularOperacion(id, motivo) {
  await api.anular(id, motivo);
  estado.operaciones = estado.operaciones.map(o => o.id === id ? Object.assign({}, o, { estado: 'ANULADA', motivoAnulacion: motivo }) : o);
  await almacen.guardar('operaciones', { datos: estado.operaciones, hora: estado.operacionesHora });
  emitir('operaciones', estado.operaciones);
}

/** Modo tabulador: reemplaza los campos editables; el backend devuelve la operación recalculada. */
export async function actualizarOperacion(id, cambios) {
  const op = await api.actualizar(id, cambios);
  estado.operaciones = estado.operaciones.map(o => o.id === id ? op : o);
  await almacen.guardar('operaciones', { datos: estado.operaciones, hora: estado.operacionesHora });
  emitir('operaciones', estado.operaciones);
  return op;
}

export async function borrarOperacion(id) {
  await api.borrar(id);
  estado.operaciones = estado.operaciones.filter(o => o.id !== id);
  await almacen.guardar('operaciones', { datos: estado.operaciones, hora: estado.operacionesHora });
  emitir('operaciones', estado.operaciones);
}

export async function editarOperacion(id, cambios) {
  await api.editar(id, cambios);
  estado.operaciones = estado.operaciones.map(o => o.id === id ? Object.assign({}, o, cambios) : o);
  await almacen.guardar('operaciones', { datos: estado.operaciones, hora: estado.operacionesHora });
  emitir('operaciones', estado.operaciones);
}

// ---------------------------------------------------------------------------------------
// Diferencial desde bancos (v1.6)
// ---------------------------------------------------------------------------------------
const MIN_BANCOS = 10 * 60000;
const MAX_CACHE_BANCOS = 1500000;   // caracteres JSON: más que eso no se guarda (localStorage es compartido con el resto)
let pedidoBancos = 0;

/** Copia local cifrada de la última lectura del libro de bancos y de las decisiones, para abrir la pantalla al instante. */
export async function restaurarBancosLocal() {
  if (!estado.bancos) {
    const c = await almacen.leer('bancos');
    if (c && c.datos) { estado.bancos = c.datos; estado.bancosHora = c.hora || 0; estado.bancosRango = { desde: c.desde || '', hasta: c.hasta || '' }; }
  }
  if (!estado.decisionesBancos.length) {
    const d = await almacen.leer('decisionesBancos');
    if (Array.isArray(d)) estado.decisionesBancos = d;
  }
  return estado.bancos;
}

/** Lee el libro de bancos. Usa la copia en memoria si es del mismo rango y tiene menos de 10 min (salvo forzar). */
export async function cargarBancos(desde, hasta, forzar) {
  desde = desde || ''; hasta = hasta || '';
  const r = estado.bancosRango || {};
  if (!forzar && estado.bancos && r.desde === desde && r.hasta === hasta && Date.now() - estado.bancosHora < MIN_BANCOS) return estado.bancos;
  const n = ++pedidoBancos;
  const datos = await api.bancos(desde, hasta, forzar);   // forzar = saltar también la caché del servidor
  if (n !== pedidoBancos) return datos;   // llegó tarde: manda la lectura más reciente
  estado.bancos = datos; estado.bancosHora = Date.now(); estado.bancosRango = { desde, hasta };
  try {
    if (JSON.stringify(datos).length <= MAX_CACHE_BANCOS) await almacen.guardar('bancos', { datos, hora: estado.bancosHora, desde, hasta });
    else almacen.eliminar('bancos');
  } catch (e) { almacen.eliminar('bancos'); }   // la copia local es opcional (p. ej. almacenamiento lleno)
  emitir('bancos', datos);
  return datos;
}

export async function cargarDecisionesBancos() {
  const r = await api.bancosDecisiones();
  estado.decisionesBancos = (r && r.decisiones) || [];
  try { await almacen.guardar('decisionesBancos', estado.decisionesBancos); } catch (e) { /* copia opcional */ }
  emitir('decisionesBancos', estado.decisionesBancos);
  return estado.decisionesBancos;
}

/** Envía las decisiones cambiadas (upsert por clave) y las claves a borrar, en lotes de 500. Actualiza estado.decisionesBancos. */
export async function guardarDecisionesBancos(cambiadas, borrar) {
  cambiadas = cambiadas || []; borrar = borrar || [];
  const LOTE = 500;
  let guardadas = 0, borradas = 0;
  for (let i = 0; i === 0 || i < cambiadas.length; i += LOTE) {
    const r = await api.bancosGuardar(cambiadas.slice(i, i + LOTE), i === 0 ? borrar : []);
    guardadas += (r && r.guardadas) || 0; borradas += (r && r.borradas) || 0;
  }
  const ahora = new Date().toISOString(), dispositivo = almacen.obtenerMeta().dispositivo || '';
  const fuera = new Set(borrar.concat(cambiadas.map(d => d.clave)));
  estado.decisionesBancos = estado.decisionesBancos.filter(d => !fuera.has(d.clave))
    .concat(cambiadas.map(d => Object.assign({ actualizado: ahora, dispositivo }, d)));
  try { await almacen.guardar('decisionesBancos', estado.decisionesBancos); } catch (e) { /* copia opcional */ }
  emitir('decisionesBancos', estado.decisionesBancos);
  return { guardadas, borradas };
}
