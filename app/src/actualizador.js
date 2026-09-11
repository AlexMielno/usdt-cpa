/**
 * Comprobación de versiones publicadas en GitHub Releases.
 *
 *  - Windows (instalado con el instalador): electron-updater descarga la nueva versión en segundo plano
 *    y la instala al reiniciar la app (lo maneja electron/main.js; aquí solo se muestra el aviso).
 *  - Windows portable y Android: se consulta la última "release" y se ofrece descargar el archivo
 *    (.exe o .apk). En Android el sistema pide confirmar la instalación sobre la app existente
 *    (misma firma → conserva los datos).
 */
import { http, plataforma, esEscritorio, abrirEnlaceExterno } from './nativo.js';

const cfg = () => (window.CONFIG_USDT || {});

function compararVersiones(a, b) {   // > 0 si a es mayor que b
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

/** Devuelve { hay, actual, nueva, notas, url, fecha } o { hay:false } si no hay repositorio configurado. */
export async function comprobarActualizacion() {
  const c = cfg().ACTUALIZACIONES || {};
  if (!c.propietario || !c.repositorio) return { hay: false, motivo: 'sin_repositorio' };
  const r = await http(`https://api.github.com/repos/${c.propietario}/${c.repositorio}/releases/latest`, { cabeceras: { Accept: 'application/vnd.github+json' } });
  if (r.status === 404) return { hay: false, motivo: 'sin_versiones' };
  if (r.status !== 200) throw new Error('GitHub respondió ' + r.status);
  const rel = JSON.parse(r.texto);
  const nueva = String(rel.tag_name || rel.name || '').replace(/^v/, '');
  const actual = cfg().VERSION || '0.0.0';
  const activos = rel.assets || [];
  const buscar = (re) => (activos.find(a => re.test(a.name)) || {}).browser_download_url;
  const url = plataforma === 'android' ? buscar(/\.apk$/i) : (buscar(/portable\.exe$/i) || buscar(/\.exe$/i));
  return { hay: compararVersiones(nueva, actual) > 0, actual, nueva, notas: rel.body || '', url: url || rel.html_url, fecha: rel.published_at, pagina: rel.html_url };
}

export function esInstaladorWindows() {
  return esEscritorio && window.electronUSDT && window.electronUSDT.actualizador && window.electronUSDT.actualizador.soportado;
}

export function descargar(info) { if (info && info.url) abrirEnlaceExterno(info.url); }
