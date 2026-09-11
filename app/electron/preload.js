/** Puente mínimo y explícito entre la página y el proceso principal de Electron. */
const { contextBridge, ipcRenderer } = require('electron');

let nombreEquipo = '';
let soportado = false;
ipcRenderer.invoke('usdt:equipo').then(n => { nombreEquipo = n; }).catch(() => {});
ipcRenderer.invoke('usdt:actualizador:soportado').then(s => { soportado = !!s; }).catch(() => {});

const oyentes = [];
ipcRenderer.on('usdt:actualizacion', (_ev, datos) => oyentes.forEach(f => { try { f(datos); } catch (e) { /* ignorar */ } }));

contextBridge.exposeInMainWorld('electronUSDT', {
  http: (peticion) => ipcRenderer.invoke('usdt:http', peticion),
  cifrar: (texto) => ipcRenderer.invoke('usdt:cifrar', texto),
  descifrar: (b64) => ipcRenderer.invoke('usdt:descifrar', b64),
  abrirExterno: (url) => ipcRenderer.invoke('usdt:abrir', url),
  guardarArchivo: (datos) => ipcRenderer.invoke('usdt:guardarArchivo', datos),
  get nombreEquipo() { return nombreEquipo; },
  actualizador: {
    get soportado() { return soportado; },
    comprobar: () => ipcRenderer.invoke('usdt:actualizador:comprobar'),
    instalar: () => ipcRenderer.invoke('usdt:actualizador:instalar'),
    alCambiar: (fn) => { oyentes.push(fn); },
  },
});
