/** Pantalla de bloqueo: PIN o huella. Tras varios fallos impone esperas crecientes. */
import { el, montar, toast, icono, confirmar } from '../ui.js';
import { crearTecladoPin } from './teclado.js';
import * as almacen from '../almacen.js';
import { biometria, esMovil } from '../nativo.js';

let fallos = 0;
let esperaHasta = 0;

export function pantallaBloqueo({ alDesbloquear, alDesvincular }) {
  const meta = almacen.obtenerMeta();
  const conHuella = esMovil && meta.huella;
  const estado = el('p.texto-suave', {}, conHuella ? 'Usa tu huella o escribe el PIN' : 'Escribe tu PIN');

  const intentarHuella = async () => {
    const ok = await biometria.autenticar('Desbloquear USDT CPA');
    if (!ok) return;
    if (await almacen.desbloquearConHuella()) { fallos = 0; alDesbloquear(); }
    else toast('La huella ya no es válida; usa el PIN y vuelve a activarla en Ajustes.', 'aviso');
  };

  const t = crearTecladoPin({
    alCompletar: async (pin) => {
      if (Date.now() < esperaHasta) { t.error(); estado.textContent = 'Espera ' + Math.ceil((esperaHasta - Date.now()) / 1000) + ' s antes de reintentar'; return; }
      estado.textContent = 'Verificando…';
      const ok = await almacen.desbloquearConPin(pin);
      if (ok) { fallos = 0; alDesbloquear(); return; }
      fallos++;
      t.error();
      if (fallos >= 3) { esperaHasta = Date.now() + Math.min(60, 5 * Math.pow(2, fallos - 3)) * 1000; }
      estado.textContent = 'PIN incorrecto' + (fallos >= 3 ? ' — espera ' + Math.round((esperaHasta - Date.now()) / 1000) + ' s' : '');
    },
    extra: conHuella ? { icono: 'huella', texto: 'Huella', onClick: intentarHuella } : null,
  });

  montar(el('div.pantalla.centrada', {},
    el('img.logo-grande', { src: 'img/logo.png', alt: 'USDT CPA', estilo: { width: '84px', height: '84px', borderRadius: '22px' } }),
    el('div.titulo-grande', {}, 'USDT CPA'),
    estado,
    t.elemento,
    el('button.enlace', { type: 'button', estilo: { marginTop: '22px' }, onClick: async () => {
      const ok = await confirmar({ titulo: '¿Olvidaste el PIN?', mensaje: 'La única forma de recuperar el acceso es desvincular este dispositivo y volver a enlazarlo con la clave de enlace. Los datos en Google Sheets NO se pierden.', textoOk: 'Desvincular', peligro: true });
      if (ok) { await almacen.borrarTodo(); alDesvincular(); }
    } }, 'Olvidé mi PIN'),
  ));

  if (conHuella) setTimeout(intentarHuella, 350);
}
