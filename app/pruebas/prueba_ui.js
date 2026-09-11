/**
 * Prueba automatizada de la interfaz en Electron: recorre bienvenida -> PIN -> verificación -> inicio ->
 * registro -> historial -> ajustes -> bloqueo, tomando capturas en app/pruebas/capturas/.
 * Requiere el simulador del backend corriendo (node herramientas/simulador_backend.js) y config.js apuntando a él.
 *
 * Uso: cd app && npx electron pruebas/prueba_ui.js
 */
const { app, BrowserWindow, ipcMain, safeStorage, net } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');

const RAIZ_WWW = path.join(__dirname, '..', 'www');
const CAPTURAS = path.join(__dirname, 'capturas');
const PUERTO = 47822;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
fs.mkdirSync(CAPTURAS, { recursive: true });

app.setPath('userData', path.join(__dirname, '.electron-prueba'));   // sesión limpia y separada
const esperar = ms => new Promise(r => setTimeout(r, ms));

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const ruta = path.join(RAIZ_WWW, url === '/' ? 'index.html' : url);
  fs.readFile(ruta, (err, d) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(ruta)] || 'application/octet-stream' }); res.end(d); });
}).listen(PUERTO, '127.0.0.1');

ipcMain.handle('usdt:http', async (_e, { url, metodo, cabeceras, cuerpo }) => { const r = await net.fetch(url, { method: metodo, headers: cabeceras, body: cuerpo }); return { status: r.status, texto: await r.text() }; });
ipcMain.handle('usdt:cifrar', async (_e, t) => safeStorage.encryptString(t).toString('base64'));
ipcMain.handle('usdt:descifrar', async (_e, b) => safeStorage.decryptString(Buffer.from(b, 'base64')));
ipcMain.handle('usdt:abrir', async () => {});
ipcMain.handle('usdt:guardarArchivo', async (_e, { nombre, base64 }) => { const ruta = path.join(CAPTURAS, nombre); fs.writeFileSync(ruta, Buffer.from(base64, 'base64')); return { ok: true, ruta }; });
ipcMain.handle('usdt:actualizador:soportado', async () => false);
ipcMain.handle('usdt:equipo', async () => 'PRUEBA');

const errores = [];
async function main() {
  const win = new BrowserWindow({ width: 1000, height: 760, show: false, backgroundColor: '#0b0e11', webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.js'), contextIsolation: true, sandbox: true } });
  win.webContents.on('console-message', (ev) => { const nivel = ev.level !== undefined ? ev.level : ev; const msg = ev.message || arguments[2]; if (nivel === 'error' || nivel === 3) errores.push(String(msg)); });
  await win.webContents.session.clearStorageData();
  await win.loadURL('http://localhost:' + PUERTO + '/');
  await win.webContents.insertCSS('*, *::before, *::after { animation: none !important; transition: none !important; }');
  await win.webContents.executeJavaScript("window.CONFIG_USDT.API_URL = 'http://localhost:8787/'; true", true);
  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);
  const foto = async (nombre) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(CAPTURAS, nombre + '.png'), img.toPNG()); console.log('captura', nombre); };
  const texto = () => js('document.body.innerText');
  const clic = (sel) => js(`(function(){const e=[...document.querySelectorAll('${sel}')].find(x=>x.offsetParent!==null); if(!e) throw new Error('no existe ${sel}'); e.click(); return true;})()`);
  const clicTexto = (t) => js(`(function(){const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().includes(${JSON.stringify(t)})&&b.offsetParent!==null); if(!e) throw new Error('no hay botón ${t}'); e.click(); return true;})()`);
  const escribir = (sel, v) => js(`(function(){const e=document.querySelector('${sel}'); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
  const pin = async (p) => { for (const d of p) { await clicTexto(d); await esperar(60); } await esperar(1500); };
  const esperarHasta = async (fn, ms = 40000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (await fn()) return true; await esperar(400); } return false; };
  const sinCargar = () => js(`!document.body.innerText.includes('Consultando') && !document.body.innerText.includes('Cargando')`);

  await esperar(800);
  await foto('01-bienvenida');
  await escribir('input[type=password]', 'CLAVE-DE-PRUEBA-LOCAL-1234');
  await escribir('input[type=text]', 'PC de prueba');
  await clicTexto('Continuar');
  await esperar(400); await foto('02-crear-pin');
  await pin('123456'); await pin('123456');
  await esperarHasta(sinCargar); await esperar(500); await foto('03-inicio');
  let t = await texto();
  if (!/Tasas del momento/i.test(t)) throw new Error('No llegó a inicio: ' + t.slice(0, 300));
  if (/Consultando/.test(t)) errores.push('Las tasas no cargaron en inicio');

  // Registrar una compra
  await clicTexto('Registrar operación'); await esperarHasta(() => js(`document.body.innerText.includes('Sugerida')`), 30000); await esperar(300);
  await escribir('input[inputmode=decimal]', '100');
  await esperar(300); await foto('04-registro');
  await clicTexto('Registrar operación'); await esperar(3000);
  await foto('05-inicio-con-operacion');
  t = await texto();
  if (!/USDT @/.test(t)) errores.push('No se ve la operación registrada en inicio');

  // Registrar una venta
  await clic('nav .principal'); await esperar(1200);
  await clicTexto('VENTA de USDT'); await esperar(200);
  await escribir('input[inputmode=decimal]', '40');
  await js(`(function(){const i=[...document.querySelectorAll('input[inputmode=decimal]')]; i[4].value='5'; i[4].dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await escribir('textarea', 'Venta de prueba con comisión');
  await esperar(200); await foto('06-registro-venta');
  await clicTexto('Registrar operación'); await esperar(3000);

  // Historial y detalle
  await clicTexto('Historial'); await esperar(1200); await foto('07-historial');
  await clic('.op'); await esperar(500); await foto('08-detalle');
  await js(`document.querySelector('.modal .cerrar').click()`);
  // Reportes + PDF
  await clicTexto('Reportes'); await esperar(1000); await foto('14-reportes');
  await clicTexto('Todo'); await esperar(400);
  await clicTexto('Exportar a PDF'); await esperarHasta(() => js(`document.body.innerText.includes('Guardado en')`), 20000); await esperar(300);
  const pdfs = fs.readdirSync(CAPTURAS).filter(f => f.endsWith('.pdf'));
  if (!pdfs.length || fs.statSync(path.join(CAPTURAS, pdfs[0])).size < 5000) errores.push('No se generó el PDF del reporte'); else console.log('PDF generado:', pdfs[0], fs.statSync(path.join(CAPTURAS, pdfs[0])).size, 'bytes');
  await clicTexto('Diferenciales'); await esperar(400); await foto('15-reportes-diferenciales');
  await clicTexto('Ventas'); await esperar(400);
  await clicTexto('Exportar a PDF'); await esperarHasta(() => js(`document.querySelectorAll('.toast').length > 0`), 20000); await esperar(300);
  // Ajustes
  await clicTexto('Ajustes'); await esperar(800); await foto('09-ajustes');
  // Bloqueo
  await clicTexto('Bloquear ahora'); await esperar(600); await foto('10-bloqueo');
  await pin('999999'); await esperar(300);
  t = await texto(); if (!/incorrecto/.test(t)) errores.push('No avisó PIN incorrecto');
  await pin('123456'); await esperar(2000);
  t = await texto(); if (!/Tasas del momento/i.test(t)) errores.push('No desbloqueó con el PIN correcto');
  await foto('11-desbloqueado');

  // Ventana angosta (teléfono)
  win.setSize(400, 820); await esperar(600); await foto('12-movil-inicio');
  await clic('nav .principal'); await esperar(1000); await foto('13-movil-registro');

  console.log(errores.length ? 'ERRORES:\n - ' + errores.join('\n - ') : 'PRUEBA UI OK sin errores de consola');
  app.exit(errores.length ? 1 : 0);
}

app.whenReady().then(() => main().catch(e => { console.error('FALLO:', e); app.exit(2); }));
