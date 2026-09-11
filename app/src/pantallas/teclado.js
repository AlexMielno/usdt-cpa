/** Teclado numérico para el PIN (compartido por bienvenida, bloqueo y cambio de PIN). */
import { el, icono } from '../ui.js';

export const LARGO_PIN = 6;

/**
 * Crea un teclado con puntos. opciones: { alCompletar(pin), extra: { texto|icono, onClick } }
 * Devuelve { elemento, limpiar(), error() }
 */
export function crearTecladoPin({ alCompletar, extra }) {
  let pin = '';
  const puntos = el('div.pin-puntos', {}, Array.from({ length: LARGO_PIN }, () => el('span')));
  const pintar = () => { [...puntos.children].forEach((p, i) => p.classList.toggle('lleno', i < pin.length)); };
  const tecla = (n) => el('button', { type: 'button', onClick: () => { if (pin.length < LARGO_PIN) { pin += n; pintar(); if (pin.length === LARGO_PIN) setTimeout(() => alCompletar(pin), 80); } } }, String(n));
  const borrar = el('button.suave', { type: 'button', 'aria-label': 'Borrar', onClick: () => { pin = pin.slice(0, -1); pintar(); } }, icono('borrar'));
  const extraBtn = extra
    ? el('button.suave', { type: 'button', onClick: extra.onClick, 'aria-label': extra.texto || '' }, extra.icono ? icono(extra.icono) : extra.texto)
    : el('button.suave', { type: 'button', disabled: true });
  const teclado = el('div.teclado', {}, [1, 2, 3, 4, 5, 6, 7, 8, 9].map(tecla), extraBtn, tecla(0), borrar);
  const elemento = el('div', {}, puntos, teclado);
  // teclado físico
  const fisico = (ev) => {
    if (!document.body.contains(elemento)) { document.removeEventListener('keydown', fisico); return; }
    if (/^[0-9]$/.test(ev.key) && pin.length < LARGO_PIN) { pin += ev.key; pintar(); if (pin.length === LARGO_PIN) setTimeout(() => alCompletar(pin), 80); }
    else if (ev.key === 'Backspace') { pin = pin.slice(0, -1); pintar(); }
  };
  document.addEventListener('keydown', fisico);
  return {
    elemento,
    limpiar() { pin = ''; pintar(); puntos.classList.remove('error'); },
    error() { puntos.classList.add('error'); setTimeout(() => { pin = ''; pintar(); puntos.classList.remove('error'); }, 450); },
  };
}
