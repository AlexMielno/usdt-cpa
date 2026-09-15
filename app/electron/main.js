/**
 * Proceso principal de Electron (versión Windows .exe).
 *
 *  - Sirve la carpeta www en http://localhost:47821 (puerto fijo para que el origen — y con él el
 *    almacenamiento local — sea estable, y para que Cloudflare Turnstile acepte el hostname "localhost").
 *  - Expone al renderer, mediante preload.js, lo mínimo: HTTP sin CORS, cifrado DPAPI, guardar archivos,
 *    abrir enlaces y el actualizador automático (GitHub Releases, solo en la versión instalada).
 *  - Ventana con aislamiento de contexto, sin integración de Node y en sandbox.
 */
const { app, BrowserWindow, ipcMain, safeStorage, shell, net, session, Menu, dialog } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PUERTO = 47821;
const RAIZ_WWW = path.join(__dirname, '..', 'www');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
const ES_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;

const unicaInstancia = app.requestSingleInstanceLock();
if (!unicaInstancia) app.quit();

let ventana = null;
let servidorHttp = null;

function servidorLocal() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      let ruta = path.normalize(path.join(RAIZ_WWW, url === '/' ? 'index.html' : url));
      if (!ruta.startsWith(RAIZ_WWW)) { res.writeHead(403); res.end(); return; }
      fs.readFile(ruta, (err, datos) => {
        if (err) { res.writeHead(404); res.end('No encontrado'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(ruta).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(datos);
      });
    });
    let intentos = 0;
    const escuchar = () => srv.listen(PUERTO, '127.0.0.1', () => { servidorHttp = srv; resolve(srv); });
    srv.on('error', (e) => { if (e.code === 'EADDRINUSE' && intentos++ < 8) setTimeout(escuchar, 500); else reject(e); });
    escuchar();
  });
}

async function crearVentana() {
  const win = new BrowserWindow({
    width: 1080, height: 780, minWidth: 420, minHeight: 640,
    backgroundColor: '#0b0e11', autoHideMenuBar: true, show: false,
    title: 'USDT CPA',
    icon: path.join(__dirname, '..', 'recursos', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      spellcheck: false, devTools: !app.isPackaged,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());
  // Solo se permite navegar dentro del servidor local; todo lo demás se abre en el navegador del sistema
  win.webContents.on('will-navigate', (ev, url) => { if (!url.startsWith('http://localhost:' + PUERTO)) { ev.preventDefault(); shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  await win.loadURL('http://localhost:' + PUERTO + '/');
  ventana = win;
  return win;
}

// ---- IPC: canal HTTP (sin CORS) ----
ipcMain.handle('usdt:http', async (_ev, { url, metodo, cabeceras, cuerpo }) => {
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) throw new Error('Solo se permiten URLs https');
  const r = await net.fetch(url, { method: metodo || 'GET', headers: cabeceras || {}, body: cuerpo, redirect: 'follow' });
  return { status: r.status, texto: await r.text() };
});

// ---- IPC: cifrado ligado al usuario de Windows (DPAPI) ----
ipcMain.handle('usdt:cifrar', async (_ev, texto) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage no disponible');
  return safeStorage.encryptString(String(texto)).toString('base64');
});
ipcMain.handle('usdt:descifrar', async (_ev, b64) => safeStorage.decryptString(Buffer.from(String(b64), 'base64')));
ipcMain.handle('usdt:abrir', async (_ev, url) => { if (/^https?:/.test(url)) await shell.openExternal(url); });
ipcMain.handle('usdt:equipo', async () => os.hostname());

// ---- IPC: guardar archivo (reportes PDF) ----
ipcMain.handle('usdt:guardarArchivo', async (ev, { nombre, base64, mime }) => {
  const seguro = String(nombre || 'archivo').replace(/[\\/:*?"<>|]/g, '_');
  const rutaPorDefecto = path.join(app.getPath('documents'), seguro);
  const filtros = mime === 'application/pdf' ? [{ name: 'PDF', extensions: ['pdf'] }] : [{ name: 'Archivo', extensions: ['*'] }];
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(ev.sender), { title: 'Guardar reporte', defaultPath: rutaPorDefecto, filters: filtros });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, Buffer.from(String(base64), 'base64'));
  shell.openPath(r.filePath).catch(() => {});
  return { ok: true, ruta: r.filePath };
});

// ---- Actualizador automático (solo instalado con NSIS; el portable avisa y abre la descarga) ----
function configurarActualizador() {
  if (!app.isPackaged || ES_PORTABLE) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const avisar = (evento, datos) => { if (ventana && !ventana.isDestroyed()) ventana.webContents.send('usdt:actualizacion', { evento, datos }); };
  autoUpdater.on('update-available', (i) => avisar('disponible', { version: i.version, notas: typeof i.releaseNotes === 'string' ? i.releaseNotes : '' }));
  autoUpdater.on('update-downloaded', (i) => avisar('descargada', { version: i.version }));
  autoUpdater.on('error', (e) => avisar('error', { mensaje: String(e && e.message || e) }));
  ipcMain.handle('usdt:actualizador:comprobar', async () => { try { const r = await autoUpdater.checkForUpdates(); return { ok: true, version: r && r.updateInfo && r.updateInfo.version }; } catch (e) { return { ok: false, mensaje: String(e.message || e) }; } });
  // Instalación silenciosa (isSilent=true) y relanzar al terminar: el instalador por usuario no pide permisos de administrador
  ipcMain.handle('usdt:actualizador:instalar', async () => { setImmediate(() => { cerrarTodo(); autoUpdater.quitAndInstall(true, true); }); return true; });
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000);
}
ipcMain.handle('usdt:actualizador:soportado', async () => app.isPackaged && !ES_PORTABLE);

app.whenReady().then(async () => {
  // Permisos del renderer: nada de cámara, micrófono, notificaciones, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  try { await servidorLocal(); } catch (e) { console.error('No se pudo iniciar el servidor local', e); app.quit(); return; }
  await crearVentana();
  configurarActualizador();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) crearVentana(); });
});
app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
app.on('window-all-closed', () => app.quit());

/** Cierra el servidor local y las ventanas para que el instalador no encuentre la app "abierta". */
function cerrarTodo() {
  try { BrowserWindow.getAllWindows().forEach(w => { try { w.destroy(); } catch (e) { /* nada */ } }); } catch (e) { /* nada */ }
  if (servidorHttp) { try { servidorHttp.close(); } catch (e) { /* nada */ } servidorHttp = null; }
}
app.on('before-quit', cerrarTodo);
