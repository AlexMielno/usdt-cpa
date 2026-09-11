/** Registrar una compra o venta con vista previa en vivo de totales y diferenciales. */
import { el, montar, toast, icono, modal } from '../ui.js';
import { cabecera, conNavegacion } from './cascaron.js';
import { estado, navegar } from '../estado.js';
import * as datos from '../datos.js';
import { num, ves, aNumero, hoyISO, horaActual, signo, pct } from '../formato.js';
import { calcularOperacion, sugerirTasa } from '../calculos.js';

const METODOS = ['Pago Móvil', 'Banesco', 'Mercantil', 'Banco de Venezuela', 'BNC', 'BBVA Provincial', 'Bancamiga', 'Banplus', 'Zelle', 'Efectivo', 'Otro'];

export function pantallaRegistro({ manejarError }) {
  const cfg = window.CONFIG_USDT || {};
  const f = {
    tipo: 'COMPRA', cartera: estado.cartera, fecha: hoyISO(), hora: horaActual(),
    montoUsdt: '', tasa: '', tasaP2p: '', tasaBcv: '', comisionUsdt: '', comisionVes: '',
    contraparte: '', metodoPago: METODOS[0], referencia: '', observaciones: '',
  };
  let sugerencia = { valor: 0, motivo: '' };
  let tasaTocada = false, p2pTocada = false;

  // ---- campos ----
  const inp = (nombre, opts = {}) => {
    const e = el('input', Object.assign({ type: opts.tipo || 'text', inputmode: opts.numerico ? 'decimal' : undefined, placeholder: opts.placeholder || '', value: f[nombre], maxlength: opts.max || 80, autocomplete: 'off' }, opts.attrs || {}));
    e.addEventListener('input', () => { f[nombre] = e.value; if (opts.alCambiar) opts.alCambiar(e.value); previsualizar(); });
    return e;
  };
  const iMonto = inp('montoUsdt', { numerico: true, placeholder: '0,00', alCambiar: () => sugerir(false) });
  const iTasa = inp('tasa', { numerico: true, placeholder: '0,0000', alCambiar: () => { tasaTocada = true; } });
  const iP2p = inp('tasaP2p', { numerico: true, placeholder: '0,0000', alCambiar: () => { p2pTocada = true; } });
  const iBcv = inp('tasaBcv', { numerico: true, placeholder: '0,0000' });
  const iComUsdt = inp('comisionUsdt', { numerico: true, placeholder: '0' });
  const iComVes = inp('comisionVes', { numerico: true, placeholder: '0' });
  const iFecha = inp('fecha', { tipo: 'date' });
  const iHora = inp('hora', { tipo: 'time' });
  const iContra = inp('contraparte', { placeholder: 'Nombre o usuario en Binance' });
  const iRef = inp('referencia', { placeholder: 'Nº de orden / referencia bancaria', max: 60 });
  const iObs = el('textarea', { placeholder: 'Observaciones (opcional)', maxlength: 1000 });
  iObs.addEventListener('input', () => { f.observaciones = iObs.value; });
  const sMetodo = el('select', {}, METODOS.map(m => el('option', { value: m, selected: m === f.metodoPago }, m)));
  sMetodo.addEventListener('change', () => { f.metodoPago = sMetodo.value; });

  const chipsTasa = el('div.chips', { estilo: { marginTop: '6px' } });
  const notaSug = el('div.ayuda');
  const previa = el('div.previa');

  // ---- selectores de tipo y cartera ----
  const selTipo = el('div.selector', {});
  const pintarTipo = () => selTipo.replaceChildren(...['COMPRA', 'VENTA'].map(t => el('button', { type: 'button', clase: t.toLowerCase() + (f.tipo === t ? ' activo' : ''), onClick: () => { f.tipo = t; pintarTipo(); sugerir(true); } }, t === 'COMPRA' ? 'COMPRA de USDT' : 'VENTA de USDT')));
  pintarTipo();
  const selCartera = el('div.selector', {});
  const pintarCartera = () => selCartera.replaceChildren(...(cfg.CARTERAS || []).map(c => el('button', { type: 'button', clase: f.cartera === c ? 'activo' : '', onClick: () => { f.cartera = c; pintarCartera(); } }, c)));
  pintarCartera();

  // ---- sugerencia de tasa P2P ----
  const sugerir = (forzarTasa) => {
    const t = estado.tasas;
    if (!t) return;
    sugerencia = sugerirTasa(t, f.tipo, aNumero(f.montoUsdt));
    if (t.bcv && t.bcv.valor && !f.tasaBcv) { f.tasaBcv = String(t.bcv.valor); iBcv.value = num(t.bcv.valor, 4); }
    if (sugerencia.valor && (!p2pTocada || forzarTasa)) { f.tasaP2p = String(sugerencia.valor); iP2p.value = num(sugerencia.valor, 4); p2pTocada = false; }
    if (sugerencia.valor && (!tasaTocada || forzarTasa)) { f.tasa = String(sugerencia.valor); iTasa.value = num(sugerencia.valor, 4); tasaTocada = false; }
    notaSug.textContent = sugerencia.valor ? 'Sugerida: ' + num(sugerencia.valor, 4) + ' — ' + sugerencia.motivo : 'Sin sugerencia P2P disponible';
    const lado = f.tipo === 'COMPRA' ? t.p2p && t.p2p.compra : t.p2p && t.p2p.venta;
    chipsTasa.replaceChildren(
      lado && lado.mejor ? chip('Mejor ' + num(lado.mejor, 2), lado.mejor) : null,
      sugerencia.valor ? chip('Sugerida ' + num(sugerencia.valor, 2), sugerencia.valor) : null,
      lado && lado.mediana ? chip('Mediana ' + num(lado.mediana, 2), lado.mediana) : null,
      lado && lado.anuncios && lado.anuncios.length ? el('button.chip', { type: 'button', onClick: () => verAnuncios(lado) }, 'Ver anuncios') : null,
    );
    previsualizar();
  };
  const chip = (texto, valor) => el('button.chip', { type: 'button', onClick: () => { f.tasa = String(valor); iTasa.value = num(valor, 4); tasaTocada = true; previsualizar(); } }, texto);

  const verAnuncios = (lado) => modal({ titulo: 'Anuncios Binance P2P (' + (f.tipo === 'COMPRA' ? 'vendedores' : 'compradores') + ')', contenido: el('div.lista-anuncios', {}, lado.anuncios.map(a => el('div.op', { onClick: () => { f.tasa = String(a.precio); iTasa.value = num(a.precio, 4); tasaTocada = true; previsualizar(); } },
    el('div.centro', {}, el('div.titulo', {}, a.anunciante, a.tipoUsuario === 'merchant' ? el('span.etiqueta.compra', {}, 'VERIFICADO') : null), el('div.detalle', {}, `${a.ordenesMes} órdenes · ${num(a.finalizacion * 100, 1)} % · límites ${num(a.minVes, 0)}–${num(a.maxVes, 0)} Bs · ${(a.metodos || []).slice(0, 3).join(', ')}`)),
    el('div.derecha', {}, el('div.monto', {}, num(a.precio, 2)), el('div.dif.mini', {}, num(a.disponible, 0) + ' USDT'))))) });

  // ---- vista previa ----
  const previsualizar = () => {
    const c = calcularOperacion({ tipo: f.tipo, montoUsdt: aNumero(f.montoUsdt), tasa: aNumero(f.tasa), comisionUsdt: aNumero(f.comisionUsdt) || 0, comisionVes: aNumero(f.comisionVes) || 0, tasaBcv: aNumero(f.tasaBcv) || 0, tasaP2p: aNumero(f.tasaP2p) || 0 });
    const linea = (etq, val, clase) => el('div.linea', {}, el('span', {}, etq), el('span', { clase: clase || '' }, val));
    const cl = v => v > 0 ? 'positivo' : v < 0 ? 'negativo' : 'neutro';
    previa.replaceChildren(
      linea(f.tipo === 'COMPRA' ? 'Pagas en bolívares' : 'Recibes en bolívares', ves(c.totalVes)),
      linea(f.tipo === 'COMPRA' ? 'USDT que recibes (neto)' : 'USDT que entregas (con comisión)', num(c.usdtNeto, 4) + ' USDT'),
      linea('Tasa efectiva', num(c.tasaEfectiva, 4) + ' Bs/USDT'),
      linea('Equivalente al BCV', '$ ' + num(c.equivUsdBcv, 2)),
      linea('Diferencial vs BCV', signo(c.difBcvVes, 2) + ' Bs (' + signo(c.difBcvPct * 100, 2) + ' %)', cl(c.difBcvVes)),
      linea('Diferencial vs P2P', signo(c.difP2pVes, 2) + ' Bs', cl(c.difP2pVes)),
      el('div.linea.total', {}, el('span', {}, f.tipo === 'COMPRA' ? 'Total pagado (con comisión VES)' : 'Total neto recibido'), el('span', {}, ves(c.vesNeto))),
    );
  };

  // ---- guardar ----
  const btnGuardar = el('button.btn', { type: 'button', onClick: async () => {
    const monto = aNumero(f.montoUsdt), tasa = aNumero(f.tasa);
    let ok = true;
    [[iMonto, monto], [iTasa, tasa]].forEach(([e, v]) => { const mal = !(v > 0); e.classList.toggle('error', mal); if (mal) ok = false; });
    if (!ok) { toast('Revisa el monto y la tasa.', 'error'); return; }
    if (monto > 1000000 && !confirm('El monto supera 1.000.000 USDT. ¿Es correcto?')) return;
    btnGuardar.disabled = true; btnGuardar.textContent = 'Guardando…';
    try {
      const creada = await datos.registrarOperacion({
        tipo: f.tipo, cartera: f.cartera, fecha: f.fecha, hora: f.hora, montoUsdt: monto, tasa,
        tasaP2p: aNumero(f.tasaP2p) || 0, tasaBcv: aNumero(f.tasaBcv) || 0, comisionUsdt: aNumero(f.comisionUsdt) || 0, comisionVes: aNumero(f.comisionVes) || 0,
        contraparte: f.contraparte, metodoPago: f.metodoPago, referencia: f.referencia, observaciones: f.observaciones,
      });
      toast('Operación ' + creada.id + ' registrada', 'ok');
      navegar('inicio');
    } catch (e) {
      btnGuardar.disabled = false; btnGuardar.replaceChildren(icono('ok'), 'Registrar operación');
      manejarError(e);
    }
  } }, icono('ok'), 'Registrar operación');

  const campo = (etq, e, ayuda) => el('div.campo', {}, el('label', {}, etq), e, ayuda ? el('div.ayuda', {}, ayuda) : null);
  const contenido = el('div.pantalla', {},
    cabecera('Registrar', 'Nueva operación en la cartera'),
    selTipo, selCartera,
    el('div.grid-desktop-2', {},
      el('div', {},
        el('div.tarjeta', {}, el('h2', {}, 'Operación'),
          el('div.fila', {}, campo('Fecha', iFecha), campo('Hora', iHora)),
          campo('Monto USDT', el('div.sufijo', {}, iMonto, el('span', {}, 'USDT'))),
          el('div.campo', {}, el('label', {}, 'Tasa de la operación (Bs por USDT)'), el('div.sufijo', {}, iTasa, el('span', {}, 'Bs')), chipsTasa),
          el('div.fila', {},
            campo('Tasa P2P de referencia', iP2p),
            campo('Tasa BCV', iBcv)),
          notaSug,
        ),
        el('div.tarjeta', {}, el('h2', {}, 'Comisiones'),
          el('div.fila', {}, campo('Comisión en USDT', el('div.sufijo', {}, iComUsdt, el('span', {}, 'USDT'))), campo('Comisión en Bs', el('div.sufijo', {}, iComVes, el('span', {}, 'Bs')))),
          el('div.ayuda', {}, 'Binance P2P no cobra al tomador; registra aquí comisiones de retiro, transferencia bancaria o del comercio.'),
        ),
      ),
      el('div', {},
        el('div.tarjeta', {}, el('h2', {}, 'Detalles'),
          campo('Contraparte', iContra),
          el('div.fila', {}, campo('Método de pago', sMetodo), campo('Referencia', iRef)),
          campo('Observaciones', iObs),
        ),
        el('div.tarjeta', {}, el('h2', {}, 'Vista previa'), previa, btnGuardar),
      ),
    ),
  );
  montar(conNavegacion(contenido, 'registro'));
  previsualizar();
  if (estado.tasas) sugerir(true);
  datos.cargarTasas(false).then(() => sugerir(false)).catch(manejarError);
  setTimeout(() => iMonto.focus(), 120);
}
