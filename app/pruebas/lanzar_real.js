/**
 * Arranca la app REAL de Electron (electron/main.js) con un perfil temporal y el simulador del backend,
 * simulando el uso de un usuario: 1) registro + PIN → inicio, 2) segundo arranque → desbloqueo con PIN → inicio.
 * Toma capturas en pruebas/capturas/real-*.png y muestra los errores de consola.
 *
 * Uso: cd app && npx electron pruebas/lanzar_real.js [fase]   (fase: 1 = registro, 2 = reapertura)
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const FASE = process.argv[2] || '1';
const CAPTURAS = path.join(__dirname, 'capturas');
app.setPath('userData', path.join(__dirname, '.electron-real'));
if (FASE === '1') fs.rmSync(path.join(__dirname, '.electron-real'), { recursive: true, force: true });

const esperar = ms => new Promise(r => setTimeout(r, ms));
const errores = [];

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (ev) => { const nivel = ev.level; if (nivel === 'error' || nivel === 3) errores.push(String(ev.message)); });
  win.webContents.once('did-finish-load', async () => {
    const js = (c) => win.webContents.executeJavaScript(c, true);
    await js("window.CONFIG_USDT.API_URL = 'http://localhost:8787/'; window.CONFIG_USDT.TURNSTILE_SITEKEY = ''; true");
    const foto = async (n) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(CAPTURAS, 'real-' + n + '.png'), img.toPNG()); console.log('captura', n); };
    const clicTexto = (t) => js(`(function(){const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().includes(${JSON.stringify(t)})&&b.offsetParent!==null); if(!e) throw new Error('no hay botón ${t}'); e.click(); return true;})()`);
    const escribir = (sel, v) => js(`(function(){const e=document.querySelector('${sel}'); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
    const pin = async (p) => { for (const d of p) { await clicTexto(d); await esperar(60); } await esperar(1500); };
    try {
      await esperar(1500);
      if (FASE === '1') {
        await escribir('input[type=password]', 'CLAVE-DE-PRUEBA-LOCAL-1234');
        await escribir('input[type=text]', 'PC real');
        await clicTexto('Continuar'); await esperar(500);
        await pin('123456'); await pin('123456');
      } else {
        await foto(FASE + '-bloqueo');
        await pin('123456');
      }
      await esperar(4000);
      await foto(FASE + '-inicio');
      const t = await js('document.body.innerText');
      console.log('TEXTO INICIO >>>', t.replace(/\n+/g, ' | ').slice(0, 600));
      const visibles = await js(`[...document.querySelectorAll('.tarjeta')].map(e=>{const r=e.getBoundingClientRect();return e.querySelector('h2')?.innerText+' h='+Math.round(r.height)+' op='+getComputedStyle(e).opacity}).join(' || ')`);
      console.log('TARJETAS >>>', visibles);
      if (FASE === '2') {
        // Simula un error de pantalla y comprueba que se ve en Ajustes ▸ Diagnóstico
        await js("setTimeout(() => { throw new Error('Error simulado para el diagnóstico'); }, 0); true");
        await esperar(600); await foto('2-error-toast');
        await clicTexto('Ajustes'); await esperar(1200);
        await js('window.scrollTo(0, document.body.scrollHeight); document.querySelector(".pantalla")?.scrollTo(0, 99999); true'); await esperar(300);
        await foto('2-ajustes-diagnostico');
        const diag = await js('document.body.innerText.includes("Error simulado para el diagnóstico")');
        console.log('DIAGNOSTICO VISIBLE >>>', diag);
      }
    } catch (e) { console.log('FALLO', e.message); }
    console.log('ERRORES DE CONSOLA:', errores.length ? errores : 'ninguno');
    app.exit(0);
  });
});
require('../electron/main.js');
