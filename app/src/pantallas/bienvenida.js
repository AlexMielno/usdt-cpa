/** Primera vez: clave de enlace + nombre del dispositivo + crear PIN (+ huella si hay). */
import { el, montar, toast, icono } from '../ui.js';
import { crearTecladoPin } from './teclado.js';
import * as almacen from '../almacen.js';
import { biometria, nombreDispositivoSugerido, esMovil } from '../nativo.js';

export function pantallaBienvenida({ alTerminar }) {
  let paso = 1;
  let datos = { claveEnlace: '', dispositivo: nombreDispositivoSugerido(), pin: '' };

  const render = () => {
    if (paso === 1) return montar(pasoClave());
    if (paso === 2) return montar(pasoPin('Crea un PIN de 6 dígitos', 'Lo pedirá cada vez que abras la app.', async (pin) => { datos.pin = pin; paso = 3; render(); }));
    if (paso === 3) return montar(pasoPin('Repite el PIN', 'Para confirmar que lo escribiste bien.', async (pin) => {
      if (pin !== datos.pin) { toast('Los PIN no coinciden. Inténtalo otra vez.', 'error'); datos.pin = ''; paso = 2; render(); return; }
      await finalizar();
    }));
  };

  const pasoClave = () => {
    const inputClave = el('input', { type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'Pega aquí la clave de enlace', value: datos.claveEnlace });
    const inputDisp = el('input', { type: 'text', maxlength: 40, placeholder: 'Ej. PC Oficina, Teléfono Juan', value: datos.dispositivo });
    const ver = el('button.enlace', { type: 'button', onClick: () => { inputClave.type = inputClave.type === 'password' ? 'text' : 'password'; ver.textContent = inputClave.type === 'password' ? 'Mostrar' : 'Ocultar'; } }, 'Mostrar');
    return el('div.pantalla.centrada', {},
      el('img.logo-grande', { src: 'img/logo.png', alt: 'USDT CPA' }),
      el('div.titulo-grande', {}, 'USDT CPA'),
      el('p.texto-suave', {}, 'Control de compra y venta de USDT con tasa BCV y Binance P2P.'),
      el('div.tarjeta', { estilo: { width: '100%', textAlign: 'left', marginTop: '14px' } },
        el('h2', {}, 'Enlazar este dispositivo'),
        el('div.campo', {}, el('label', {}, 'Clave de enlace ', ver), inputClave,
          el('div.ayuda', {}, 'La genera el backend con configuracionInicial() en Apps Script. Se guarda cifrada con tu PIN.')),
        el('div.campo', {}, el('label', {}, 'Nombre de este dispositivo'), inputDisp,
          el('div.ayuda', {}, 'Queda registrado en cada operación que hagas desde aquí.')),
        el('button.btn', { type: 'button', onClick: () => {
          datos.claveEnlace = inputClave.value.trim();
          datos.dispositivo = inputDisp.value.trim() || nombreDispositivoSugerido();
          if (datos.claveEnlace.length < 16) { inputClave.classList.add('error'); toast('La clave de enlace parece incompleta.', 'error'); return; }
          paso = 2; render();
        } }, 'Continuar', icono('flecha')),
      ),
      el('p.mini', {}, 'Los datos se guardan en tu Google Sheets y en este dispositivo solo queda una copia cifrada.'),
    );
  };

  const pasoPin = (titulo, sub, alCompletar) => {
    const t = crearTecladoPin({ alCompletar });
    return el('div.pantalla.centrada', {},
      el('div', { estilo: { color: 'var(--amarillo)' } }, icono('candado')),
      el('div.titulo-grande', {}, titulo),
      el('p.texto-suave', {}, sub),
      t.elemento,
      el('button.enlace', { type: 'button', estilo: { marginTop: '18px' }, onClick: () => { paso = 1; render(); } }, 'Volver'),
    );
  };

  const finalizar = async () => {
    montar(el('div.pantalla.centrada', {}, el('span.spinner'), el('p.texto-suave', {}, 'Protegiendo el dispositivo…')));
    try {
      await almacen.crear(datos);
    } catch (e) { toast('No se pudo guardar: ' + e.message, 'error'); paso = 1; render(); return; }
    if (esMovil) {
      const b = await biometria.disponible();
      if (b.ok) {
        const ok = await biometria.autenticar('Activar desbloqueo con ' + b.tipo.toLowerCase());
        if (ok) { try { await almacen.activarHuella(); toast(b.tipo + ' activada', 'ok'); } catch (e) { toast('No se pudo activar la huella: ' + e.message, 'aviso'); } }
      }
    }
    alTerminar();
  };

  render();
}
