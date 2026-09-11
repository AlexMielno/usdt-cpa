/** Ajustes: seguridad (PIN, huella, sesión), dispositivo, enlaces e información. */
import { el, montar, toast, icono, confirmar, modal, ayuda } from '../ui.js';
import { cabecera, conNavegacion } from './cascaron.js';
import { navegar } from '../estado.js';
import * as almacen from '../almacen.js';
import * as api from '../api.js';
import { biometria, esMovil, plataforma, abrirEnlaceExterno } from '../nativo.js';
import { crearTecladoPin } from './teclado.js';
import { comprobarActualizacion, descargar, esInstaladorWindows } from '../actualizador.js';
import { estado, emitir, en } from '../estado.js';
import { comisionesConfiguradas, guardarComisiones, reglasPorDefecto } from '../comisiones.js';
import { aNumero, num } from '../formato.js';

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

  // ---- comisiones por defecto ----
  const zonaComisiones = el('div', {}, el('span.spinner'));
  const pintarComisiones = (reglas) => {
    const campos = {};
    const inputNum = (tipo, clave, valor) => { const i = el('input', { type: 'text', inputmode: 'decimal', value: num(valor, 2) }); campos[tipo + '.' + clave] = i; return i; };
    const bloque = (tipo, titulo) => el('div', { estilo: { marginBottom: '10px' } },
      el('div.mini', { estilo: { fontWeight: 700, color: 'var(--texto)', marginBottom: '6px' } }, titulo),
      el('div.fila', {},
        el('div.campo', {}, el('label', {}, '% del monto en USDT'), el('div.sufijo', {}, inputNum(tipo, 'usdtPct', reglas[tipo].usdtPct), el('span', {}, '%'))),
        el('div.campo', {}, el('label', {}, 'USDT fijos'), el('div.sufijo', {}, inputNum(tipo, 'usdtFijo', reglas[tipo].usdtFijo), el('span', {}, 'USDT')))),
      el('div.fila', {},
        el('div.campo', {}, el('label', {}, '% del total en Bs'), el('div.sufijo', {}, inputNum(tipo, 'vesPct', reglas[tipo].vesPct), el('span', {}, '%'))),
        el('div.campo', {}, el('label', {}, 'Bs fijos'), el('div.sufijo', {}, inputNum(tipo, 'vesFijo', reglas[tipo].vesFijo), el('span', {}, 'Bs')))));
    const leer = () => ({ compra: {}, venta: {} });
    zonaComisiones.replaceChildren(
      bloque('compra', 'Al COMPRAR USDT'), bloque('venta', 'Al VENDER USDT'),
      el('div.acciones', {},
        el('button.btn.fantasma', { type: 'button', onClick: async () => { pintarComisiones(reglasPorDefecto()); } }, 'Valores de fábrica'),
        el('button.btn', { type: 'button', onClick: async () => {
          const r = leer();
          Object.entries(campos).forEach(([k, i]) => { const [t, c] = k.split('.'); r[t][c] = aNumero(i.value) || 0; });
          try { await guardarComisiones(r); toast('Reglas de comisión guardadas', 'ok'); } catch (e) { toast(e.message, 'error'); }
        } }, 'Guardar reglas')),
    );
  };
  comisionesConfiguradas().then(pintarComisiones);

  // ---- diagnóstico: últimos errores de la app, copiables para enviarlos al soporte
  const zonaDiagnostico = el('div');
  const textoDiagnostico = () => {
    const l = ['USDT CPA ' + (cfg.VERSION || '') + ' · ' + plataforma + ' · ' + navigator.userAgent, 'Pantalla: ' + (estado.pantalla || '') + ' · ' + new Date().toISOString(),
      'Tasas en memoria: ' + (estado.tasas ? 'sí (' + (estado.tasas.actualizado || '') + ')' : 'no') + ' · histórico: ' + (Array.isArray(estado.historico) ? estado.historico.length : typeof estado.historico) + ' · operaciones: ' + (estado.operaciones || []).length,
      'Errores (' + estado.errores.length + '):'];
    estado.errores.forEach(e => l.push('- ' + e.hora + ' [' + e.origen + '] ' + e.mensaje + (e.pila ? '\n    ' + e.pila : '')));
    return l.join('\n');
  };
  const copiarTexto = async (t) => {
    try { await navigator.clipboard.writeText(t); return true; } catch (e) { /* sin permiso: método clásico */ }
    const ta = el('textarea', { estilo: { position: 'fixed', opacity: 0 } }); ta.value = t; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; } ta.remove(); return ok;
  };
  const pintarDiagnostico = () => {
    const errs = estado.errores;
    zonaDiagnostico.replaceChildren(
      el('p.mini', {}, errs.length ? 'Últimos errores registrados en esta sesión (los más recientes primero).' : 'Sin errores en esta sesión. Si una pantalla se queda vacía, vuelve aquí y copia el diagnóstico.'),
      errs.length ? el('div', { estilo: { maxHeight: '220px', overflow: 'auto', marginBottom: '10px' } }, errs.slice(0, 10).map(e => el('div', { estilo: { fontSize: '12px', padding: '6px 0', borderBottom: '1px solid var(--borde)' } },
        el('div', {}, el('b', {}, e.mensaje)), el('div.mini', {}, new Date(e.hora).toLocaleTimeString('es-VE') + ' · ' + e.origen + (e.pila ? ' · ' + e.pila.slice(0, 160) : ''))))) : null,
      el('div', { estilo: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        el('button.btn.secundario.peq', { type: 'button', onClick: async () => { toast((await copiarTexto(textoDiagnostico())) ? 'Diagnóstico copiado: pégalo en el chat de soporte' : 'No se pudo copiar', 'ok'); } }, icono('copiar'), 'Copiar diagnóstico'),
        errs.length ? el('button.btn.secundario.peq', { type: 'button', onClick: () => { estado.errores.length = 0; emitir('errores', estado.errores); } }, 'Limpiar') : null,
      ),
    );
  };

  const contenido = el('div.pantalla', {},
    cabecera('Ajustes', 'Seguridad y dispositivo'),
    el('div.grid-desktop-2', {},
      el('div', {},
        el('div.tarjeta', {}, el('h2', {}, el('span', {}, 'Seguridad', ayuda('seguridad'))),
          el('button.btn.secundario', { type: 'button', estilo: { marginBottom: '10px' }, onClick: cambiarPin }, icono('candado'), 'Cambiar PIN'),
          zonaHuella,
          el('div.separador'),
          el('button.btn.secundario', { type: 'button', estilo: { marginBottom: '10px' }, onClick: alBloquear }, icono('candado'), 'Bloquear ahora'),
          el('button.btn.fantasma', { type: 'button', onClick: async () => { await api.cerrarSesion(); toast('Sesión cerrada; se pedirá verificación al continuar', 'ok'); navegar('inicio'); } }, icono('salir'), 'Cerrar sesión con el servidor'),
        ),
        el('div.tarjeta', {}, el('h2', {}, el('span', {}, 'Este dispositivo', ayuda('dispositivo'))),
          el('div.campo', {}, el('label', {}, 'Nombre con el que se registran las operaciones'), iDisp),
          el('button.btn.peligro', { type: 'button', onClick: async () => {
            const ok = await confirmar({ titulo: 'Desvincular dispositivo', mensaje: 'Se borrarán la clave de enlace, el PIN y la copia local cifrada. Los datos en Google Sheets se conservan. Para volver a usar la app necesitarás la clave de enlace.', textoOk: 'Desvincular', peligro: true });
            if (ok) { await almacen.borrarTodo(); alDesvincular(); }
          } }, 'Desvincular este dispositivo'),
        ),
      ),
      el('div', {},
        el('div.tarjeta', {}, el('h2', {}, el('span', {}, 'Comisiones por defecto', ayuda('comisionesConfig'))),
          el('p.mini', {}, 'Se calculan solas al registrar; en cada operación puedes corregir el valor.'),
          zonaComisiones),
        el('div.tarjeta', {}, el('h2', {}, el('span', {}, 'Base de datos', ayuda('baseDatos'))),
          el('p.mini', {}, 'Las operaciones viven en la hoja BD_USDT del libro "Control De Compra Venta USDT". La pestaña PANEL_USDT resume la cartera con fórmulas y TASAS guarda el histórico cada 30 minutos.'),
          el('button.btn.secundario', { type: 'button', onClick: () => abrirEnlaceExterno(URL_HOJA) }, 'Abrir Google Sheets'),
        ),
        el('div.tarjeta', {}, el('h2', {}, el('span', {}, 'Acerca de', ayuda('acercaDe'))),
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
        el('div.tarjeta', {}, el('h2', {}, el('span', {}, 'Diagnóstico', ayuda('diagnostico'))),
          zonaDiagnostico),
      ),
    ),
  );
  montar(conNavegacion(contenido, 'ajustes'));
  pintarDiagnostico();
  const quitarErrores = en('errores', () => { if (document.body.contains(contenido)) pintarDiagnostico(); else quitarErrores(); });
}
