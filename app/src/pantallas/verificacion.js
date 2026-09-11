/**
 * Verificación anti-bot (Cloudflare Turnstile) + apertura de sesión con el backend.
 * Si no hay TURNSTILE_SITEKEY configurada, abre sesión directamente (el backend también lo permite
 * solo cuando no tiene secreto configurado).
 */
import { el, montar, icono, ayuda } from '../ui.js';
import * as api from '../api.js';

let scriptCargado = null;

function cargarTurnstile() {
  if (window.turnstile) return Promise.resolve();
  if (scriptCargado) return scriptCargado;
  scriptCargado = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptCargado = null; reject(new Error('No se pudo cargar Cloudflare Turnstile')); };
    document.head.appendChild(s);
  });
  return scriptCargado;
}

export function pantallaVerificacion({ alListo, alDesvincular }) {
  const cfg = window.CONFIG_USDT || {};
  const estado = el('p.texto-suave', {}, 'Comprobando que no eres un robot…');
  const caja = el('div.turnstile-caja');
  const errores = el('div');

  const abrir = async (token) => {
    estado.textContent = 'Abriendo sesión segura…';
    try {
      await api.abrirSesion(token);
      alListo();
    } catch (e) {
      mostrarError(e);
    }
  };

  const mostrarError = (e) => {
    errores.replaceChildren(
      el('div.aviso-inline.error', {}, el('b', {}, 'No se pudo abrir sesión. '), e.message || String(e)),
      el('div.acciones', {},
        el('button.btn.secundario', { type: 'button', onClick: () => iniciar() }, icono('refrescar'), 'Reintentar'),
        e.codigo === 'clave_invalida' ? el('button.btn.peligro', { type: 'button', onClick: alDesvincular }, 'Desvincular') : null,
      ),
    );
    estado.textContent = '';
  };

  const iniciar = async () => {
    errores.replaceChildren();
    caja.replaceChildren();
    if (!cfg.TURNSTILE_SITEKEY) { await abrir(''); return; }
    estado.textContent = 'Comprobando que no eres un robot…';
    try {
      await cargarTurnstile();
      window.turnstile.render(caja, {
        sitekey: cfg.TURNSTILE_SITEKEY,
        theme: 'dark',
        language: 'es',
        callback: (token) => abrir(token),
        'error-callback': (codigo) => mostrarError(new Error('Turnstile devolvió un error (' + codigo + '). Revisa que el hostname "localhost" esté permitido en Cloudflare.')),
        'expired-callback': () => { estado.textContent = 'El desafío venció; resolviendo de nuevo…'; },
      });
    } catch (e) { mostrarError(e); }
  };

  montar(el('div.pantalla.centrada', {},
    el('div', { estilo: { color: 'var(--amarillo)' } }, icono('escudo')),
    el('div.titulo-grande', {}, 'Verificación', ayuda('verificacion')),
    estado, caja, errores,
    el('p.mini', {}, 'Protección anti-bot de Cloudflare + sesión firmada de 12 horas.'),
  ));
  iniciar();
}
