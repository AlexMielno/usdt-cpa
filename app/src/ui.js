/** Utilidades de interfaz: creación de elementos, toasts, modales, íconos. */

/** el('div.clase#id', { atributos }, ...hijos) */
export function el(selector, attrs, ...hijos) {
  const partes = selector.split(/(?=[.#])/);
  const e = document.createElement(partes[0] || 'div');
  partes.slice(1).forEach(p => { if (p[0] === '.') e.classList.add(p.slice(1)); else if (p[0] === '#') e.id = p.slice(1); });
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    Object.entries(attrs).forEach(([k, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (k === 'html') e.innerHTML = v;
      else if (k === 'texto') e.textContent = v;
      else if (k === 'clase') e.className += ' ' + v;
      else if (k === 'estilo') Object.assign(e.style, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    });
  } else if (attrs !== undefined) {
    hijos.unshift(attrs);
  }
  agregar(e, hijos);
  return e;
}

export function agregar(padre, hijos) {
  hijos.flat(Infinity).forEach(h => {
    if (h === null || h === undefined || h === false) return;
    padre.appendChild(h instanceof Node ? h : document.createTextNode(String(h)));
  });
  return padre;
}

export function vaciar(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }

export function montar(contenido) {
  const app = document.getElementById('app');
  vaciar(app);
  agregar(app, [contenido]);
  window.scrollTo(0, 0);
}

export function toast(mensaje, tipo = 'info', ms = 3200) {
  const cont = document.getElementById('toasts');
  const t = el('div.toast', { clase: tipo, texto: mensaje });
  cont.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, ms);
}

/** Modal genérico. Devuelve { cerrar }. */
export function modal({ titulo, contenido, alCerrar }) {
  const fondo = el('div.modal-fondo');
  const caja = el('div.modal');
  const cerrar = () => { fondo.remove(); document.removeEventListener('keydown', esc); if (alCerrar) alCerrar(); };
  const esc = (ev) => { if (ev.key === 'Escape') cerrar(); };
  document.addEventListener('keydown', esc);
  fondo.addEventListener('click', (ev) => { if (ev.target === fondo) cerrar(); });
  caja.appendChild(el('button.cerrar', { type: 'button', 'aria-label': 'Cerrar', html: '&times;', onClick: cerrar }));
  if (titulo) caja.appendChild(el('h3', {}, titulo));
  agregar(caja, [typeof contenido === 'function' ? contenido(cerrar) : contenido]);
  fondo.appendChild(caja);
  document.body.appendChild(fondo);
  return { cerrar };
}

/** Confirmación simple. Devuelve Promise<boolean>. */
export function confirmar({ titulo, mensaje, textoOk = 'Confirmar', peligro = false, campo }) {
  return new Promise(resolve => {
    let entrada = null;
    const m = modal({
      titulo,
      contenido: (cerrar) => {
        const partes = [el('p.texto-suave', {}, mensaje)];
        if (campo) {
          entrada = el('input', { type: 'text', placeholder: campo.placeholder || '', maxlength: campo.max || 200 });
          partes.push(el('div.campo', {}, el('label', {}, campo.etiqueta), entrada));
        }
        partes.push(el('div.acciones', {},
          el('button.btn.fantasma', { type: 'button', onClick: () => { cerrar(); resolve(false); } }, 'Cancelar'),
          el('button.btn', { type: 'button', clase: peligro ? 'peligro' : '', onClick: () => {
            if (campo && campo.obligatorio && !(entrada.value || '').trim()) { entrada.classList.add('error'); return; }
            cerrar(); resolve(campo ? (entrada.value || '').trim() : true);
          } }, textoOk),
        ));
        return partes;
      },
      alCerrar: () => resolve(false),
    });
    if (entrada) setTimeout(() => entrada.focus(), 50);
  });
}

// ---- íconos SVG (trazos simples, heredan el color) ----
const I = {
  inicio: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/>',
  mas: '<path d="M12 5v14M5 12h14"/>',
  lista: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  ajustes: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  refrescar: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  borrar: '<path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><path d="m18 9-6 6M12 9l6 6"/>',
  huella: '<path d="M12 10a2 2 0 0 0-2 2c0 1.5.5 3.7 1.8 5.5"/><path d="M8.5 20c-.9-1.6-1.5-3.6-1.5-6a5 5 0 0 1 10 0c0 1 .1 2 .3 3"/><path d="M5 17.5A11 11 0 0 1 4 14a8 8 0 0 1 16 0"/><path d="M6.5 8.5A11 11 0 0 1 12 6c2 0 3.8.5 5.5 1.5"/>',
  candado: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  escudo: '<path d="M12 22s8-3 8-10V5l-8-3-8 3v7c0 7 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  flecha: '<path d="m9 18 6-6-6-6"/>',
  atras: '<path d="m15 18-6-6 6-6"/>',
  ok: '<path d="m5 12 5 5L20 7"/>',
  alerta: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  copiar: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  salir: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  reporte: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 17v-3M12 17v-6M16 17v-4"/>',
  descargar: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
};

/**
 * Botón "?" de ayuda. Al pasar el mouse (PC) muestra una burbuja; al tocar/clic abre una ventana con
 * la explicación y ejemplos. Los textos viven en ayudas.js.
 */
import { AYUDAS } from './ayudas.js';
const conMouse = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(hover: hover)').matches;
let burbuja = null;

export function ayuda(clave) {
  const a = AYUDAS[clave];
  if (!a) return el('span');
  const b = el('button.btn-ayuda', { type: 'button', 'aria-label': 'Ayuda: ' + a.titulo, title: '' }, '?');
  b.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); ocultarBurbuja(); modalAyuda(a); });
  if (conMouse) {
    b.addEventListener('mouseenter', () => mostrarBurbuja(b, a));
    b.addEventListener('mouseleave', ocultarBurbuja);
  }
  return b;
}

function contenidoAyuda(a, completo) {
  return [
    el('div.ayuda-titulo', {}, a.titulo),
    el('div.ayuda-texto', {}, a.texto),
    a.ejemplos && a.ejemplos.length ? el('div.ayuda-ejemplos', {}, el('div.ayuda-etq', {}, 'Ejemplos'), el('ul', {}, (completo ? a.ejemplos : a.ejemplos.slice(0, 2)).map(e => el('li', {}, e)))) : null,
  ];
}

function mostrarBurbuja(boton, a) {
  ocultarBurbuja();
  burbuja = el('div.burbuja-ayuda', {}, contenidoAyuda(a, false));
  document.body.appendChild(burbuja);
  const r = boton.getBoundingClientRect();
  const ancho = Math.min(340, window.innerWidth - 24);
  burbuja.style.width = ancho + 'px';
  let x = r.left + r.width / 2 - ancho / 2;
  x = Math.max(12, Math.min(x, window.innerWidth - ancho - 12));
  const alto = burbuja.offsetHeight;
  const arriba = r.top - alto - 10 > 8;
  burbuja.style.left = x + 'px';
  burbuja.style.top = (arriba ? r.top - alto - 10 : r.bottom + 10) + 'px';
  burbuja.classList.add(arriba ? 'arriba' : 'abajo');
}

function ocultarBurbuja() { if (burbuja) { burbuja.remove(); burbuja = null; } }

function modalAyuda(a) {
  modal({ titulo: null, contenido: el('div.ayuda-modal', {}, contenidoAyuda(a, true)) });
}

export function icono(nombre) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = I[nombre] || '';
  return s;
}

export function cargando(texto = 'Cargando…') {
  return el('div.vacio', {}, el('span.spinner'), el('div', { estilo: { marginTop: '8px' } }, texto));
}
