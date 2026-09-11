/** Cascarón común: cabecera con marca y selector de cartera + barra de navegación inferior. */
import { el, icono, ayuda } from '../ui.js';
import { estado, navegar } from '../estado.js';
import { cambiarCartera } from '../datos.js';

export function cabecera(titulo, sub, extra) {
  return el('div.cabecera', {},
    el('div.cabecera-marca', {},
      el('img', { src: 'img/logo.png', alt: '' }),
      el('div', {}, el('h1', {}, titulo), sub ? el('div.sub', {}, sub) : null),
    ),
    extra || null,
  );
}

export function selectorCartera(alCambiar) {
  const carteras = (window.CONFIG_USDT || {}).CARTERAS || ['CPA BEJUMA', 'PANAMERICANA'];
  const cont = el('div.chips', { estilo: { marginBottom: '12px', alignItems: 'center' } });
  if (carteras.length < 2) return el('div');
  const pintar = () => {
    cont.replaceChildren(...carteras.map(c => el('button.chip', { type: 'button', clase: c === estado.cartera ? 'activo' : '', onClick: async () => { await cambiarCartera(c); pintar(); if (alCambiar) alCambiar(c); } }, c)), ayuda('cartera'));
  };
  pintar();
  return cont;
}

export function barraNavegacion(activa) {
  const item = (nombre, etiqueta, ico) => el('button', { type: 'button', clase: activa === nombre ? 'activo' : '', onClick: () => navegar(nombre) }, icono(ico), etiqueta);
  return el('nav.nav', {}, el('div.nav-int', {},
    item('inicio', 'Inicio', 'inicio'),
    item('historial', 'Historial', 'lista'),
    el('button.principal', { type: 'button', clase: activa === 'registro' ? 'activo' : '', onClick: () => navegar('registro') }, el('span.circulo', {}, icono('mas')), el('small', {}, 'Registrar')),
    item('reportes', 'Reportes', 'reporte'),
    item('ajustes', 'Ajustes', 'ajustes'),
  ));
}

export function conNavegacion(contenido, activa) {
  return el('div', {}, contenido, barraNavegacion(activa));
}
