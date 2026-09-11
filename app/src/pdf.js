/**
 * Exportación de reportes a PDF (jsPDF + autotable), con cabecera de la empresa, KPIs y tablas.
 * Funciona igual en Windows, Android y navegador; guardar/compartir lo resuelve nativo.guardarArchivo().
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { guardarArchivo } from './nativo.js';

let logoCache = null;
async function logoDataUrl() {
  if (logoCache) return logoCache;
  try {
    const blob = await (await fetch('img/logo.png')).blob();
    logoCache = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  } catch (e) { logoCache = null; }
  return logoCache;
}

/** Las fuentes estándar del PDF solo cubren Latin-1: se sustituyen los símbolos que no existen en ese juego. */
const SUSTITUCIONES = [[/≈/g, 'aprox. '], [/→/g, '->'], [/−/g, '-'], [/≥/g, '>='], [/≤/g, '<='], [/[‘’]/g, "'"], [/[“”]/g, '"'], [/—/g, '-'], [/–/g, '-'], [/…/g, '...'], [/[^\x00-\xFF]/g, '']];
function limpiar(t) {
  let s = String(t === undefined || t === null ? '' : t);
  SUSTITUCIONES.forEach(([re, rep]) => { s = s.replace(re, rep); });
  return s;
}

const EMPRESA = { 'CPA BEJUMA': 'C.P.A. BEJUMA C.A.', 'PANAMERICANA': 'PANAMERICANA', 'AMBAS': 'C.P.A. BEJUMA C.A. y PANAMERICANA' };
const OSCURO = [11, 14, 17], AMARILLO = [240, 185, 11], GRIS = [110, 116, 128], VERDE = [10, 150, 95], ROJO = [200, 40, 60];

/** Construye el PDF y devuelve { nombre, base64 }. */
export async function construirPdf(rep) {
  const apaisado = rep.secciones.some(s => s.columnas.length > 7);
  const doc = new jsPDF({ orientation: apaisado ? 'landscape' : 'portrait', unit: 'mm', format: 'a4', compress: true });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const M = 14;
  const logo = await logoDataUrl();

  // ---- cabecera
  doc.setFillColor(...OSCURO); doc.rect(0, 0, W, 26, 'F');
  if (logo) doc.addImage(logo, 'PNG', M, 4, 18, 18);
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text(limpiar(rep.titulo), M + 23, 11);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...AMARILLO);
  doc.text(limpiar(EMPRESA[rep.cartera] || rep.cartera), M + 23, 17);
  doc.setTextColor(200, 205, 212);
  doc.text(limpiar(rep.subtitulo + '  ·  Cartera: ' + rep.cartera), M + 23, 22);
  doc.setFontSize(8); doc.text('Generado: ' + new Date().toLocaleString('es-VE'), W - M, 22, { align: 'right' });

  // ---- KPIs en tarjetas
  let y = 32;
  const cols = Math.min(3, rep.kpis.length);
  const anchoK = (W - 2 * M - (cols - 1) * 4) / cols;
  rep.kpis.forEach((k, i) => {
    const cx = M + (i % cols) * (anchoK + 4), cy = y + Math.floor(i / cols) * 17;
    doc.setFillColor(243, 244, 246); doc.roundedRect(cx, cy, anchoK, 15, 2, 2, 'F');
    doc.setFontSize(7.5); doc.setTextColor(...GRIS); doc.setFont('helvetica', 'normal'); doc.text(limpiar(k.etq).toUpperCase(), cx + 3, cy + 5);
    const val = limpiar(k.val);
    doc.setFontSize(val.length > 26 ? 9 : 11.5); doc.setFont('helvetica', 'bold');
    doc.setTextColor(...(k.clase === 'positivo' ? VERDE : k.clase === 'negativo' ? ROJO : OSCURO));
    doc.text(val, cx + 3, cy + 10.5);
    if (k.sub) { doc.setFontSize(6.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...GRIS); doc.text(doc.splitTextToSize(limpiar(k.sub), anchoK - 6)[0], cx + 3, cy + 13.8); }
  });
  y += Math.ceil(rep.kpis.length / cols) * 17 + 4;

  // ---- secciones (tablas)
  rep.secciones.forEach(sec => {
    if (!sec.filas.length) return;
    if (y > H - 40) { doc.addPage(); y = 16; }
    doc.setFontSize(10.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...OSCURO); doc.text(limpiar(sec.titulo), M, y + 4);
    const alinear = new Set(sec.alinear || []);
    const cuerpo = sec.filas.map(f => f.map(limpiar));
    if (sec.totales) cuerpo.push(sec.totales.map(limpiar));
    autoTable(doc, {
      startY: y + 7, margin: { left: M, right: M },
      head: [sec.columnas.map(limpiar)], body: cuerpo,
      theme: 'grid',
      styles: { fontSize: sec.columnas.length > 8 ? 6.8 : 8, cellPadding: 1.6, textColor: [30, 34, 40], lineColor: [225, 228, 233], lineWidth: 0.2, overflow: 'linebreak' },
      headStyles: { fillColor: OSCURO, textColor: AMARILLO, fontStyle: 'bold', halign: 'center' },
      alternateRowStyles: { fillColor: [249, 250, 251] },
      columnStyles: Object.fromEntries(sec.columnas.map((_, i) => [i, { halign: alinear.has(i) ? 'left' : 'right' }])),
      didParseCell: (d) => {
        if (sec.totales && d.section === 'body' && d.row.index === cuerpo.length - 1) { d.cell.styles.fontStyle = 'bold'; d.cell.styles.fillColor = [255, 247, 220]; }
        const t = String(d.cell.raw || '');
        if (d.section === 'body' && /^[+-][\d.,]+/.test(t)) d.cell.styles.textColor = t.startsWith('-') ? ROJO : VERDE;
      },
    });
    y = doc.lastAutoTable.finalY + 8;
  });

  // ---- nota y pie de página
  if (rep.nota) {
    if (y > H - 24) { doc.addPage(); y = 16; }
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...GRIS);
    doc.text(doc.splitTextToSize(limpiar(rep.nota), W - 2 * M), M, y + 2);
  }
  const paginas = doc.getNumberOfPages();
  for (let p = 1; p <= paginas; p++) {
    doc.setPage(p); doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(...GRIS);
    doc.text(limpiar('USDT CPA · ' + rep.titulo + ' · ' + rep.subtitulo), M, H - 6);
    doc.text('Página ' + p + ' de ' + paginas, W - M, H - 6, { align: 'right' });
  }

  const nombre = ('USDT-' + rep.tipo + '-' + (rep.cartera || 'AMBAS').replace(/\s+/g, '') + '-' + (rep.desde || 'inicio') + '_a_' + (rep.hasta || 'hoy') + '.pdf').replace(/[^\w.\-]/g, '_');
  const base64 = doc.output('datauristring').split(',')[1];
  return { nombre, base64 };
}

/** Genera el PDF y lo guarda/comparte según la plataforma. Devuelve el resultado de guardarArchivo. */
export async function exportarPdf(rep) {
  const { nombre, base64 } = await construirPdf(rep);
  return guardarArchivo(nombre, base64, 'application/pdf');
}
