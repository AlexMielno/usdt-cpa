/** Inicio: tasas del momento, estado de la cartera y últimas operaciones. */
import { el, montar, toast, icono, cargando, ayuda } from '../ui.js';
import { cabecera, selectorCartera, conNavegacion } from './cascaron.js';
import { estado, navegar, en, registrarError } from '../estado.js';
import * as datos from '../datos.js';
import { num, ves, pct, signo, haceCuanto, fechaCorta } from '../formato.js';
import { resumirCartera } from '../calculos.js';
import { filaOperacion } from './historial.js';
import { descargar, esInstaladorWindows } from '../actualizador.js';

export function pantallaInicio({ manejarError }) {
  const zonaTasas = el('div');
  const zonaResumen = el('div');
  const zonaUltimas = el('div');
  const btnRefrescar = el('button.btn-icono', { type: 'button', title: 'Actualizar', 'aria-label': 'Actualizar', onClick: () => actualizar(true) }, icono('refrescar'));

  /** Pinta una sección; si falla, muestra el motivo en su lugar en vez de dejar la pantalla vacía. */
  const seguro = (zona, titulo, fn) => {
    try { fn(); } catch (e) {
      registrarError(e, 'inicio/' + titulo);
      zona.replaceChildren(el('div.tarjeta', {}, el('h2', {}, titulo),
        el('div.aviso-inline.error', {}, 'No se pudo mostrar esta sección: ' + (e && e.message ? e.message : e)),
        el('p.mini', {}, 'Pulsa el botón de actualizar o revisa Ajustes ▸ Diagnóstico.')));
    }
  };

  const pintarTasas = () => seguro(zonaTasas, 'Tasas del momento', () => {
    const t = estado.tasas;
    if (!t) { zonaTasas.replaceChildren(el('div.tarjeta', {}, el('h2', {}, 'Tasas del momento'), cargando('Consultando BCV y Binance…'))); return; }
    const bcv = t.bcv || {}, p2p = t.p2p || {};
    const antiguedad = haceCuanto(t.actualizado);
    zonaTasas.replaceChildren(el('div.tarjeta.resaltada', {},
      el('h2', {}, el('span', {}, 'Tasas del momento', ayuda('tasas')), el('span.accion.mini', {}, antiguedad)),
      el('div.grid-3', {},
        el('div.dato', {}, el('div.etq', {}, 'BCV oficial'), el('div.val', {}, bcv.valor ? num(bcv.valor, 4) : '—'), el('div.nota', {}, bcv.fechaValor ? 'Valor ' + fechaCorta(bcv.fechaValor) : (bcv.fuente || 'sin datos'))),
        el('div.dato.amarillo', {}, el('div.etq', {}, 'P2P compra'), el('div.val', {}, p2p.compra ? num(p2p.compra.promedio5 || p2p.compra.mejor, 2) : '—'), el('div.nota', {}, p2p.compra ? 'Mejor ' + num(p2p.compra.mejor, 2) : 'sin datos')),
        el('div.dato.amarillo', {}, el('div.etq', {}, 'P2P venta'), el('div.val', {}, p2p.venta ? num(p2p.venta.promedio5 || p2p.venta.mejor, 2) : '—'), el('div.nota', {}, p2p.venta ? 'Mejor ' + num(p2p.venta.mejor, 2) : 'sin datos')),
      ),
      el('div', { estilo: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px', fontSize: '12.5px' } },
        el('span.texto-suave', {}, 'Brecha P2P venta vs BCV: ', el('b', { clase: (t.brechaPct || 0) >= 0 ? 'positivo' : 'negativo' }, (t.brechaPct !== undefined ? signo(t.brechaPct, 2) + ' %' : '—')), ayuda('brecha')),
        el('span.mini', {}, (t.errores || []).length ? '⚠ ' + t.errores.join(' · ') : (p2p.compra && p2p.compra.respaldo ? '⚠ P2P de respaldo' : 'Promedio de los 5 mejores anuncios')),
      ),
      sparkline(estado.historico),
    ));
  });

  const pintarResumen = () => seguro(zonaResumen, 'Cartera', () => {
    const r = resumirCartera(estado.operaciones, estado.cartera);
    const t = estado.tasas || {};
    const valorActualVes = t.p2p && t.p2p.venta ? r.saldoUsdt * (t.p2p.venta.promedio5 || t.p2p.venta.mejor) : 0;
    const noRealizado = r.saldoUsdt > 0 && r.costoPromedio > 0 && valorActualVes ? valorActualVes - r.saldoUsdt * r.costoPromedio : 0;
    zonaResumen.replaceChildren(el('div.tarjeta', {},
      el('h2', {}, el('span', {}, 'Cartera ' + estado.cartera, ayuda('resumen')), el('span.accion.mini', {}, r.operaciones + ' operaciones')),
      el('div.grid-2', {},
        el('div.dato', {}, el('div.etq', {}, 'Saldo USDT'), el('div.val', {}, num(r.saldoUsdt, 2)), el('div.nota', {}, valorActualVes ? '≈ ' + ves(valorActualVes) + ' al P2P' : '')),
        el('div.dato', {}, el('div.etq', {}, 'Costo promedio'), el('div.val.peq', {}, r.costoPromedio ? num(r.costoPromedio, 4) : '—'), el('div.nota', {}, 'VES por USDT')),
      ),
      el('table.tabla', { estilo: { marginTop: '10px' } },
        fila('Diferencial vs BCV (acumulado)', r.difBcvVes, ' Bs'),
        fila('Diferencial vs P2P (acumulado)', r.difP2pVes, ' Bs'),
        fila('Resultado realizado en ventas', r.resultadoRealizadoVes, ' Bs'),
        fila('Resultado no realizado (saldo)', noRealizado, ' Bs'),
        el('tr', {}, el('td.etq', {}, 'Comisiones pagadas'), el('td', {}, num(r.comisionesUsdt, 2) + ' USDT · ' + ves(r.comisionesVes))),
        el('tr', {}, el('td.etq', {}, 'Comprado / vendido'), el('td', {}, num(r.comprasUsdt, 2) + ' / ' + num(r.ventasUsdt, 2) + ' USDT')),
      ),
    ));
  });

  const fila = (etq, v, suf) => el('tr', {}, el('td.etq', {}, etq), el('td', { clase: v > 0 ? 'positivo' : v < 0 ? 'negativo' : 'neutro' }, signo(v, 2) + suf));

  const pintarUltimas = () => seguro(zonaUltimas, 'Últimas operaciones', () => {
    const ops = (estado.operaciones || []).filter(o => o.cartera === estado.cartera).slice(0, 5);
    zonaUltimas.replaceChildren(el('div.tarjeta', {},
      el('h2', {}, el('span', {}, 'Últimas operaciones', ayuda('ultimas')), el('button.enlace.accion', { type: 'button', onClick: () => navegar('historial') }, 'Ver todas')),
      ops.length ? ops.map(o => filaOperacion(o)) : el('div.vacio', {}, 'Todavía no hay operaciones en esta cartera.'),
    ));
  });

  const actualizar = async (forzar) => {
    btnRefrescar.classList.add('girando');
    try {
      await Promise.all([
        datos.cargarTasas(forzar).then(pintarTasas),
        datos.cargarOperaciones(forzar).then(() => { pintarResumen(); pintarUltimas(); }),
      ]);
      datos.cargarHistorico().then(pintarTasas);
      if (forzar) toast('Actualizado', 'ok', 1500);
    } catch (e) { manejarError(e); }
    finally { btnRefrescar.classList.remove('girando'); }
  };

  const zonaActualizacion = el('div');
  const pintarActualizacion = () => seguro(zonaActualizacion, 'Actualización', () => {
    const a = estado.actualizacion;
    if (!a || !a.hay) { zonaActualizacion.replaceChildren(); return; }
    const instalador = esInstaladorWindows();
    zonaActualizacion.replaceChildren(el('div.aviso-inline', { estilo: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
      el('span', { estilo: { flex: 1 } }, el('b', {}, 'Nueva versión ' + a.nueva + ' disponible. '), a.descargada ? 'Ya está descargada: se instala al reiniciar.' : (instalador ? 'Se está descargando en segundo plano.' : 'Descárgala e instálala sobre la actual (conserva tus datos).')),
      a.descargada ? el('button.btn.peq', { type: 'button', onClick: () => window.electronUSDT.actualizador.instalar() }, 'Reiniciar e instalar')
        : (!instalador ? el('button.btn.peq', { type: 'button', onClick: () => descargar(a) }, icono('descargar'), 'Descargar') : null),
    ));
  });
  pintarActualizacion();

  const contenido = el('div.pantalla', {},
    cabecera('USDT CPA', 'Compra · venta · diferenciales', el('div', { estilo: { display: 'flex', alignItems: 'center', gap: '6px' } }, ayuda('actualizar'), btnRefrescar)),
    zonaActualizacion,
    selectorCartera(() => { pintarResumen(); pintarUltimas(); }),
    el('div.grid-desktop-2', {}, el('div', {}, zonaTasas, el('button.btn', { type: 'button', estilo: { marginBottom: '12px' }, onClick: () => navegar('registro') }, icono('mas'), 'Registrar operación')), el('div', {}, zonaResumen, zonaUltimas)),
  );
  montar(conNavegacion(contenido, 'inicio'));
  pintarTasas(); pintarResumen(); pintarUltimas();
  actualizar(false);

  const quitar = [en('operaciones', () => { pintarResumen(); pintarUltimas(); }), en('tasas', pintarTasas), en('actualizacion', pintarActualizacion)];
  const timer = setInterval(() => { if (document.body.contains(contenido)) actualizar(false); else { clearInterval(timer); quitar.forEach(f => f()); } }, ((window.CONFIG_USDT || {}).MINUTOS_REFRESCO_TASAS || 5) * 60000);
}

/** Gráfica de tendencia sencilla (SVG) con las últimas capturas: P2P venta (amarillo) y BCV (gris). */
function sparkline(hist) {
  if (!Array.isArray(hist) || hist.length < 3) return el('div');
  hist = hist.filter(h => h && typeof h === 'object');
  if (hist.length < 3) return el('div');
  const W = 600, H = 54, m = 4;
  const series = [{ k: 'venta', color: 'var(--amarillo)' }, { k: 'bcv', color: 'var(--texto-3)' }];
  const vals = hist.flatMap(h => [Number(h.venta), Number(h.bcv)]).filter(v => v > 0);
  if (!vals.length) return el('div');
  const min = Math.min(...vals), max = Math.max(...vals) || 1;
  const x = i => m + (i / (hist.length - 1)) * (W - 2 * m);
  const y = v => H - m - ((v - min) / (max - min || 1)) * (H - 2 * m);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'sparkline'); svg.setAttribute('preserveAspectRatio', 'none');
  series.forEach(s => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    p.setAttribute('points', hist.map((h, i) => x(i) + ',' + y(h[s.k] || min)).join(' '));
    p.setAttribute('fill', 'none'); p.setAttribute('stroke', s.color); p.setAttribute('stroke-width', '2'); p.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(p);
  });
  const primero = hist[0].t, ultimo = hist[hist.length - 1].t;
  return el('div', { estilo: { marginTop: '10px' } }, svg,
    el('div', { estilo: { display: 'flex', justifyContent: 'space-between' }, clase: 'mini' }, el('span', {}, 'Tendencia ' + hist.length + ' capturas · amarillo P2P venta · gris BCV'), el('span', {}, haceCuanto(primero) + ' → ' + haceCuanto(ultimo))));
}
