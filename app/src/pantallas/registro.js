/** Registrar una compra o venta con vista previa en vivo de totales y diferenciales. */
import { el, montar, toast, icono, modal, ayuda } from '../ui.js';
import { cabecera, conNavegacion } from './cascaron.js';
import { estado, navegar } from '../estado.js';
import * as datos from '../datos.js';
import { num, ves, aNumero, hoyISO, horaActual, signo } from '../formato.js';
import { calcularOperacion, sugerirTasa, redondear } from '../calculos.js';
import { comisionesConfiguradas } from '../comisiones.js';

export function pantallaRegistro({ manejarError }) {
  const cfg = window.CONFIG_USDT || {};
  const carteras = cfg.CARTERAS || ['CPA BEJUMA'];
  const f = {
    tipo: 'COMPRA', cartera: carteras.includes(estado.cartera) ? estado.cartera : carteras[0], fecha: hoyISO(), hora: horaActual(),
    montoUsdt: '', tasa: '', tasaP2p: '', tasaBcv: '', comisionUsdt: '', comisionVes: '', observaciones: '',
  };
  let sugerencia = { valor: 0, motivo: '' };
  let tasaTocada = false, p2pTocada = false, comUsdtTocada = false, comVesTocada = false;
  let reglas = null;   // comisiones por defecto (se cargan del almacén)

  // ---- campos ----
  const inp = (nombre, opts = {}) => {
    const e = el('input', Object.assign({ type: opts.tipo || 'text', name: nombre, inputmode: opts.numerico ? 'decimal' : undefined, placeholder: opts.placeholder || '', value: f[nombre], maxlength: opts.max || 80, autocomplete: 'off' }, opts.attrs || {}));
    e.addEventListener('input', () => { f[nombre] = e.value; if (opts.alCambiar) opts.alCambiar(e.value); previsualizar(); });
    return e;
  };
  const iMonto = inp('montoUsdt', { numerico: true, placeholder: '0,00', alCambiar: () => { sugerir(false); } });
  const iTasa = inp('tasa', { numerico: true, placeholder: '0,0000', alCambiar: () => { tasaTocada = true; comisionesAuto(); } });
  const iP2p = inp('tasaP2p', { numerico: true, placeholder: '0,0000', alCambiar: () => { p2pTocada = true; } });
  const iBcv = inp('tasaBcv', { numerico: true, placeholder: '0,0000' });
  const iComUsdt = inp('comisionUsdt', { numerico: true, placeholder: '0', alCambiar: () => { comUsdtTocada = true; pintarNotaComisiones(); } });
  const iComVes = inp('comisionVes', { numerico: true, placeholder: '0', alCambiar: () => { comVesTocada = true; pintarNotaComisiones(); } });
  const iFecha = inp('fecha', { tipo: 'date' });
  const iHora = inp('hora', { tipo: 'time' });
  const iObs = el('textarea', { name: 'observaciones', placeholder: 'Ej. compra para pagar proveedor de harina', maxlength: 1000 });
  iObs.addEventListener('input', () => { f.observaciones = iObs.value; });

  const chipsTasa = el('div.chips', { estilo: { marginTop: '6px' } });
  const notaSug = el('div.ayuda');
  const notaCom = el('div.ayuda');
  const previa = el('div.previa');

  // ---- selectores de tipo y cartera ----
  const selTipo = el('div.selector', {});
  const pintarTipo = () => selTipo.replaceChildren(...['COMPRA', 'VENTA'].map(t => el('button', { type: 'button', clase: t.toLowerCase() + (f.tipo === t ? ' activo' : ''), onClick: () => { f.tipo = t; pintarTipo(); sugerir(true); comisionesAuto(true); } }, t === 'COMPRA' ? 'COMPRA de USDT' : 'VENTA de USDT')));
  pintarTipo();
  const selCartera = el('div.selector', {});
  const pintarCartera = () => selCartera.replaceChildren(...carteras.map(c => el('button', { type: 'button', clase: f.cartera === c ? 'activo' : '', onClick: () => { f.cartera = c; pintarCartera(); } }, c)));
  pintarCartera();

  // ---- comisiones automáticas (según reglas de Ajustes) ----
  const comisionesAuto = (forzar) => {
    if (!reglas) return;
    const r = reglas[f.tipo === 'COMPRA' ? 'compra' : 'venta'] || {};
    const monto = aNumero(f.montoUsdt) || 0, tasa = aNumero(f.tasa) || 0;
    if (forzar) { comUsdtTocada = false; comVesTocada = false; }
    if (!comUsdtTocada) {
      const v = monto > 0 ? redondear(monto * (Number(r.usdtPct) || 0) / 100 + (Number(r.usdtFijo) || 0), 4) : 0;
      f.comisionUsdt = v ? String(v) : ''; iComUsdt.value = v ? num(v, 4) : '';
    }
    if (!comVesTocada) {
      const v = monto > 0 && tasa > 0 ? redondear(monto * tasa * (Number(r.vesPct) || 0) / 100 + (Number(r.vesFijo) || 0), 2) : 0;
      f.comisionVes = v ? String(v) : ''; iComVes.value = v ? num(v, 2) : '';
    }
    pintarNotaComisiones();
    previsualizar();
  };
  const pintarNotaComisiones = () => {
    if (!reglas) { notaCom.textContent = ''; return; }
    const r = reglas[f.tipo === 'COMPRA' ? 'compra' : 'venta'] || {};
    const partes = [];
    partes.push('USDT: ' + (comUsdtTocada ? 'manual' : 'auto ' + num(r.usdtPct || 0, 2) + ' %' + (r.usdtFijo ? ' + ' + num(r.usdtFijo, 2) : '')));
    partes.push('Bs: ' + (comVesTocada ? 'manual' : 'auto ' + num(r.vesPct || 0, 2) + ' %' + (r.vesFijo ? ' + ' + num(r.vesFijo, 2) + ' Bs' : '')));
    notaCom.replaceChildren(partes.join(' · ') + ' — ', el('button.enlace', { type: 'button', onClick: () => comisionesAuto(true) }, 'recalcular'), ' · ', el('button.enlace', { type: 'button', onClick: () => navegar('ajustes') }, 'cambiar reglas'));
  };

  // ---- sugerencia de tasa P2P ----
  const sugerir = (forzarTasa) => {
    const t = estado.tasas;
    if (!t) { comisionesAuto(); return; }
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
    comisionesAuto();
  };
  const usarTasa = (valor) => { f.tasa = String(valor); iTasa.value = num(valor, 4); tasaTocada = true; comisionesAuto(); };
  const chip = (texto, valor) => el('button.chip', { type: 'button', onClick: () => usarTasa(valor) }, texto);

  const verAnuncios = (lado) => modal({ titulo: 'Anuncios Binance P2P (' + (f.tipo === 'COMPRA' ? 'vendedores' : 'compradores') + ')', contenido: el('div.lista-anuncios', {}, lado.anuncios.map(a => el('div.op', { onClick: () => usarTasa(a.precio) },
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
      el('div.linea.total', {}, el('span', {}, f.tipo === 'COMPRA' ? 'Total pagado (con comisión Bs)' : 'Total neto recibido'), el('span', {}, ves(c.vesNeto))),
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
        contraparte: '', metodoPago: '', referencia: '', observaciones: f.observaciones,
      });
      toast('Operación ' + creada.id + ' registrada', 'ok');
      navegar('inicio');
    } catch (e) {
      btnGuardar.disabled = false; btnGuardar.replaceChildren(icono('ok'), 'Registrar operación');
      manejarError(e);
    }
  } }, icono('ok'), 'Registrar operación');

  // ---- bloque plegable de referencias del mercado ----
  let abierto = false;
  const cuerpoRef = el('div', { estilo: { display: 'none' } },
    el('div.fila', {}, campo('Tasa P2P de referencia', iP2p, 'tasaP2p'), campo('Tasa BCV del día', iBcv, 'tasaBcv')),
    notaSug);
  const btnRef = el('button.enlace', { type: 'button', onClick: () => { abierto = !abierto; cuerpoRef.style.display = abierto ? '' : 'none'; btnRef.textContent = (abierto ? '▾ Ocultar' : '▸ Ver') + ' referencias del mercado (automáticas)'; } }, '▸ Ver referencias del mercado (automáticas)');

  function campo(etq, e, claveAyuda) { return el('div.campo', {}, el('label', {}, etq, claveAyuda ? ayuda(claveAyuda) : null), e); }

  const contenido = el('div.pantalla', {},
    cabecera('Registrar', 'Nueva operación en la cartera'),
    el('div.selector-titulo', {}, 'Tipo de operación', ayuda('tipo')), selTipo,
    carteras.length > 1 ? el('div.selector-titulo', {}, 'Cartera', ayuda('cartera')) : null, carteras.length > 1 ? selCartera : null,
    el('div.grid-desktop-2', {},
      el('div', {},
        el('div.tarjeta', {}, el('h2', {}, el('span', {}, 'Operación', ayuda('operacion'))),
          el('div.fila', {}, campo('Fecha', iFecha, 'fechaHora'), campo('Hora', iHora)),
          campo('Monto USDT', el('div.sufijo', {}, iMonto, el('span', {}, 'USDT')), 'monto'),
          el('div.campo', {}, el('label', {}, 'Tasa de la operación (Bs por USDT)', ayuda('tasa')), el('div.sufijo', {}, iTasa, el('span', {}, 'Bs')), chipsTasa),
          el('div', { estilo: { margin: '4px 0 10px' } }, btnRef, ayuda('referencias')),
          cuerpoRef,
        ),
        el('div.tarjeta', {}, el('h2', {}, el('span', {}, 'Comisiones', ayuda('comisiones'))),
          el('div.fila', {}, campo('Comisión en USDT', el('div.sufijo', {}, iComUsdt, el('span', {}, 'USDT'))), campo('Comisión en Bs', el('div.sufijo', {}, iComVes, el('span', {}, 'Bs')))),
          notaCom,
        ),
      ),
      el('div', {},
        el('div.tarjeta', {}, el('h2', {}, el('span', {}, 'Observaciones', ayuda('observaciones'))), el('div.campo', {}, iObs)),
        el('div.tarjeta', {}, el('h2', {}, el('span', {}, 'Vista previa', ayuda('previa'))), previa, btnGuardar),
      ),
    ),
  );
  montar(conNavegacion(contenido, 'registro'));
  previsualizar();
  comisionesConfiguradas().then(r => { reglas = r; comisionesAuto(); });
  if (estado.tasas) sugerir(true);
  datos.cargarTasas(false).then(() => sugerir(false)).catch(manejarError);
  setTimeout(() => iMonto.focus(), 120);
}
