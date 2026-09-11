/** Formato de números y fechas al estilo venezolano (1.234,56). */
const fmtCache = {};

export function num(n, dec = 2) {
  const k = 'n' + dec;
  if (!fmtCache[k]) fmtCache[k] = new Intl.NumberFormat('es-VE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return fmtCache[k].format(Number(n) || 0);
}

export function ves(n, dec = 2) { return 'Bs ' + num(n, dec); }
export function usdt(n, dec = 2) { return num(n, dec) + ' USDT'; }
export function usd(n, dec = 2) { return '$ ' + num(n, dec); }
export function pct(n, dec = 2) { return num((Number(n) || 0) * 100, dec) + ' %'; }
export function signo(n, dec = 2) { const v = Number(n) || 0; return (v > 0 ? '+' : '') + num(v, dec); }

/** Convierte lo que escribe el usuario ("1.234,56", "1234.56", "1,5") en número. */
export function aNumero(texto) {
  if (typeof texto === 'number') return texto;
  let s = String(texto || '').trim().replace(/\s/g, '');
  if (!s) return NaN;
  const coma = s.lastIndexOf(','), punto = s.lastIndexOf('.');
  if (coma > -1 && punto > -1) {
    // el último separador es el decimal
    s = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (coma > -1) {
    s = s.replace(',', '.');
  }
  return parseFloat(s);
}

export function hoyISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function horaActual() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** "2026-09-11" -> "11/09/2026" */
export function fechaCorta(iso) {
  if (!iso) return '';
  const p = String(iso).slice(0, 10).split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(iso);
}

export function fechaLarga(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  return d.toLocaleDateString('es-VE', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

export function haceCuanto(isoFechaHora) {
  if (!isoFechaHora) return '';
  const ms = Date.now() - new Date(isoFechaHora).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return 'hace ' + min + ' min';
  const h = Math.round(min / 60);
  if (h < 24) return 'hace ' + h + ' h';
  return 'hace ' + Math.round(h / 24) + ' d';
}

export function mesDe(iso) { return String(iso || '').slice(0, 7); }

export function nombreMes(yyyymm) {
  const [a, m] = String(yyyymm).split('-');
  const d = new Date(Number(a), Number(m) - 1, 1);
  const s = d.toLocaleDateString('es-VE', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
