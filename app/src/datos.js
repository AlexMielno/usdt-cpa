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
