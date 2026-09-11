/** Ajustes: seguridad (PIN, huella, sesión), dispositivo, enlaces e información. */
import { el, montar, toast, icono, confirmar, modal } from '../ui.js';
import { cabecera, conNavegacion } from './cascaron.js';
import { navegar } from '../estado.js';
import * as almacen from '../almacen.js';
import * as api from '../api.js';
import { biometria, esMovil, plataforma, abrirEnlaceExterno } from '../nativo.js';
import { crearTecladoPin } from './teclado.js';
import { comprobarActualizacion, descargar, esInstaladorWindows } from '../actualizador.js';
import { estado, emitir } from '../estado.js';

const URL_HOJA = 'https://docs.google.com/spreadsheets/d/1HR_0qXnZN-i7tw4fSAOqjUc_ZQornHsNG3eM6PasVBc/edit#gid=117236580';

export function pantallaAjustes({ alDesvincular, alBloquear }) {
  const cfg = window.CONFIG_USDT || {};
  const meta = almacen.obtenerMeta();
  const zonaHuella = el('div');

  const pintarHuella = async () => {
    if (!esMovil) { zonaHuella.replaceChildren(el('div.mini', {}, 'El desbloqueo por huella solo está disponible en el teléfono.')); return; }
    const b = await biometria.disponible();
    if (!b.ok) { zonaHuella.replaceChildren(el('div.mini', {}, 'Biometría no disponible en este equipo: ' + (b.motivo || ''))); return; }
    const activa = almacen.obtenerMeta().huella;
    zonaHuella.replaceChildren(el('button.btn', { type: 'button', clase: activa ? 'peligro' : 'secundario', onClick: async () => {
      if (activa) { await almacen.desactivarHuella(); toast('Huella desactivada', 'ok'); }
      else {
        const ok = await biometria.autenticar('Activar desbloqueo con ' + b.tipo.toLowerCase());
        if (!ok) return;
        try { await almacen.activarHuella(); toast(b.tipo + ' activada', 'ok'); } catch (e) { toast(e.message, 'error'); }
      }
      pintarHuella();
    } }, icono('huella'), activa ? 'Desactivar ' + b.tipo.toLowerCase() : 'Activar ' + b.tipo.toLowerCase()));
  };
  pintarHuella();

  const cambiarPin = () => {
    let nuevo = '';
    const m = modal({ titulo: 'Nuevo PIN', contenido: (cerrar) => {
      const titulo = el('p.texto-suave', {}, 'Escribe el nuevo PIN de 6 dígitos');
      const t = crearTecladoPin({ alCompletar: async (pin) => {
        if (!nuevo) { nuevo = pin; titulo.textContent = 'Repite el nuevo PIN'; t.limpiar(); return; }
        if (pin !== nuevo) { nuevo = ''; t.error(); titulo.textContent = 'No coinciden. Escribe el nuevo PIN otra vez'; return; }
        titulo.textContent = 'Guardando…';
        try { await almacen.cambiarPin(pin); toast('PIN actualizado', 'ok'); cerrar(); } catch (e) { toast(e.message, 'error'); }
      } });
      return [titulo, t.elemento];
    } });
    return m;
  };

  const iDisp = el('input', { type: 'text', value: meta.dispositivo || '', maxlength: 40 });
  iDisp.addEventListener('change', () => { almacen.actualizarMeta({ dispositivo: iDisp.value.trim() || meta.dispositivo }); toast('Nombre guardado (aplica en la próxima sesión)', 'ok'); });

  const zonaActualizacion = el('div');
  const pintarActualizacion = (info, buscando) => {
    const a = info || estado.actualizacion;
    zonaActualizacion.replaceChildren(
      a && a.hay
        ? el('div.aviso-inline', {}, el('b', {}, 'Nueva versión ' + a.nueva + '. '), a.descargada ? 'Descargada; se instala al reiniciar.' : (esInstaladorWindows() ? 'Descargando en segundo plano…' : 'Pulsa para descargar e instalar.'),
            el('div.acciones', {}, a.descargada ? el('button.btn.peq', { type: 'button', onClick: () => window.electronUSDT.actualizador.instalar() }, 'Reiniciar e instalar') : (!esInstaladorWindows() ? el('button.btn.peq', { type: 'button', onClick: () => descargar(a) }, 'Descargar') : null)))
        : el('div.mini', { estilo: { marginBottom: '8px' } }, a && a.motivo === 'sin_versiones' ? 'Aún no hay versiones publicadas en GitHub.' : a ? 'Tienes la versión más reciente (' + (cfg.VERSION || '') + ').' : ''),
      el('button.btn.secundario', { type: 'button', disabled: !!buscando, onClick: async () => {
        pintarActualizacion(null, true);
        try {
          const r = await comprobarActualizacion();
          if (r.hay) { estado.actualizacion = r; emitir('actualizacion', r); }
          if (esInstaladorWindows()) window.electronUSDT.actualizador.comprobar().catch(() => {});
          pintarActualizacion(Object.assign({ consultado: true }, r), false);
        } catch (e) { toast('No se pudo consultar GitHub: ' + e.message, 'error'); pintarActualizacion(null, false); }
      } }, icono('refrescar'), buscando ? 'Buscando…' : 'Buscar actualizaciones'),
    );
  };
  pintarActualizacion();

  const contenido = el('div.pantalla', {},
    cabecera('Ajustes', 'Seguridad y dispositivo'),
    el('div.grid-desktop-2', {},
      el('div', {},
        el('div.tarjeta', {}, el('h2', {}, 'Seguridad'),
          el('button.btn.secundario', { type: 'button', estilo: { marginBottom: '10px' }, onClick: cambiarPin }, icono('candado'), 'Cambiar PIN'),
          zonaHuella,
          el('div.separador'),
          el('button.btn.secundario', { type: 'button', estilo: { marginBottom: '10px' }, onClick: alBloquear }, icono('candado'), 'Bloquear ahora'),
          el('button.btn.fantasma', { type: 'button', onClick: async () => { await api.cerrarSesion(); toast('Sesión cerrada; se pedirá verificación al continuar', 'ok'); navegar('inicio'); } }, icono('salir'), 'Cerrar sesión con el servidor'),
        ),
        el('div.tarjeta', {}, el('h2', {}, 'Este dispositivo'),
          el('div.campo', {}, el('label', {}, 'Nombre con el que se registran las operaciones'), iDisp),
          el('button.btn.peligro', { type: 'button', onClick: async () => {
            const ok = await confirmar({ titulo: 'Desvincular dispositivo', mensaje: 'Se borrarán la clave de enlace, el PIN y la copia local cifrada. Los datos en Google Sheets se conservan. Para volver a usar la app necesitarás la clave de enlace.', textoOk: 'Desvincular', peligro: true });
            if (ok) { await almacen.borrarTodo(); alDesvincular(); }
          } }, 'Desvincular este dispositivo'),
        ),
      ),
      el('div', {},
        el('div.tarjeta', {}, el('h2', {}, 'Base de datos'),
          el('p.mini', {}, 'Las operaciones viven en la hoja BD_USDT del libro "Control De Compra Venta USDT". La pestaña PANEL_USDT resume la cartera con fórmulas y TASAS guarda el histórico cada 30 minutos.'),
          el('button.btn.secundario', { type: 'button', onClick: () => abrirEnlaceExterno(URL_HOJA) }, 'Abrir Google Sheets'),
        ),
        el('div.tarjeta', {}, el('h2', {}, 'Acerca de'),
          el('table.tabla', {},
            el('tr', {}, el('td.etq', {}, 'Versión'), el('td', {}, cfg.VERSION || '')),
            el('tr', {}, el('td.etq', {}, 'Plataforma'), el('td', {}, plataforma)),
            el('tr', {}, el('td.etq', {}, 'Anti-bot'), el('td', {}, cfg.TURNSTILE_SITEKEY ? 'Cloudflare Turnstile' : 'Desactivado')),
            el('tr', {}, el('td.etq', {}, 'Enlazado'), el('td', {}, meta.creado ? new Date(meta.creado).toLocaleDateString('es-VE') : '')),
            el('tr', {}, el('td.etq', {}, 'Backend'), el('td', { estilo: { fontSize: '11px', wordBreak: 'break-all', textAlign: 'right' } }, (cfg.API_URL || '').replace(/^https?:\/\//, '').slice(0, 42) + '…')),
          ),
          el('div.separador'),
          zonaActualizacion,
          el('p.mini', { estilo: { marginTop: '10px' } }, 'CPA Bejuma C.A. · Panamericana. Diferencial positivo = a favor; negativo = en contra.'),
        ),
      ),
    ),
  );
  montar(conNavegacion(contenido, 'ajustes'));
}
