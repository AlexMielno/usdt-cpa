/**
 * Puente con la plataforma nativa.
 *  - Android (Capacitor): huella dactilar, almacenamiento seguro (Keystore), HTTP nativo (sin CORS) y compartir archivos.
 *  - Windows (Electron):  HTTP desde el proceso principal, cifrado con DPAPI (safeStorage), guardar archivos y actualizador.
 *  - Navegador (desarrollo): fetch, localStorage sin protección extra y descarga de archivos.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { BiometricAuth, BiometryType } from '@aparajita/capacitor-biometric-auth';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const esCapacitor = Capacitor.isNativePlatform();
const electron = typeof window !== 'undefined' ? window.electronUSDT : undefined;

export const plataforma = esCapacitor ? Capacitor.getPlatform() : (electron ? 'windows' : 'web');
export const esMovil = esCapacitor;
export const esEscritorio = !!electron;

/** Petición HTTP que evita las restricciones CORS del WebView/Electron. Devuelve { status, texto }. */
export async function http(url, opciones = {}) {
  const metodo = opciones.metodo || 'GET';
  const cabeceras = Object.assign({}, opciones.cabeceras || {});
  const cuerpo = opciones.cuerpo;
  if (esCapacitor) {
    const r = await CapacitorHttp.request({ url, method: metodo, headers: cabeceras, data: cuerpo, responseType: 'text', connectTimeout: 30000, readTimeout: 45000 });
    return { status: r.status, texto: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) };
  }
  if (electron && electron.http) {
    return electron.http({ url, metodo, cabeceras, cuerpo });
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(url, { method: metodo, headers: cabeceras, body: cuerpo, redirect: 'follow', signal: ctrl.signal });
    return { status: r.status, texto: await r.text() };
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------------------------------
// Biometría (solo Android/iOS)
// ---------------------------------------------------------------------------------------
export const biometria = {
  async disponible() {
    if (!esCapacitor) return { ok: false, tipo: '' };
    try {
      const r = await BiometricAuth.checkBiometry();
      const nombres = { [BiometryType.fingerprintAuthentication]: 'Huella dactilar', [BiometryType.faceAuthentication]: 'Rostro', [BiometryType.irisAuthentication]: 'Iris', [BiometryType.touchId]: 'Touch ID', [BiometryType.faceId]: 'Face ID' };
      return { ok: r.isAvailable, tipo: nombres[r.biometryType] || 'Biometría', motivo: r.reason };
    } catch (e) { return { ok: false, tipo: '', motivo: e.message }; }
  },
  /** Muestra el diálogo del sistema. Devuelve true si el usuario se autenticó. */
  async autenticar(motivo) {
    if (!esCapacitor) return false;
    try {
      await BiometricAuth.authenticate({
        reason: motivo || 'Desbloquear USDT CPA',
        cancelTitle: 'Usar PIN',
        allowDeviceCredential: false,
        androidTitle: 'USDT CPA',
        androidSubtitle: motivo || 'Confirma tu identidad',
        androidConfirmationRequired: false,
      });
      return true;
    } catch (e) { return false; }
  },
};

// ---------------------------------------------------------------------------------------
// Secretos pequeños (la llave para desbloqueo con huella). Se guardan en el Keystore de Android.
// En Windows se cifran con DPAPI (ligado al usuario de Windows) y se guardan en localStorage.
// ---------------------------------------------------------------------------------------
export const secreto = {
  async guardar(nombre, valor) {
    if (esCapacitor) { await SecureStorage.setItem(nombre, valor); return true; }
    if (electron && electron.cifrar) { localStorage.setItem('sec.' + nombre, await electron.cifrar(valor)); return true; }
    return false;   // navegador: no se ofrece
  },
  async leer(nombre) {
    try {
      if (esCapacitor) return await SecureStorage.getItem(nombre);
      if (electron && electron.descifrar) { const c = localStorage.getItem('sec.' + nombre); return c ? await electron.descifrar(c) : null; }
    } catch (e) { /* sin secreto */ }
    return null;
  },
  async borrar(nombre) {
    try {
      if (esCapacitor) await SecureStorage.removeItem(nombre);
      else localStorage.removeItem('sec.' + nombre);
    } catch (e) { /* ignorar */ }
  },
};

// ---------------------------------------------------------------------------------------
// Guardar / compartir archivos (PDF de reportes)
// ---------------------------------------------------------------------------------------
/** base64 -> archivo. Android: se guarda en caché y se abre el diálogo "Compartir" (WhatsApp, correo, Drive…).
 *  Windows: diálogo "Guardar como" y se abre el archivo. Navegador: descarga. Devuelve { ok, mensaje, ruta? }. */
export async function guardarArchivo(nombre, base64, mime) {
  if (esCapacitor) {
    const r = await Filesystem.writeFile({ path: nombre, data: base64, directory: Directory.Cache });
    try {
      await Share.share({ title: nombre, dialogTitle: 'Enviar reporte', files: [r.uri] });
      return { ok: true, mensaje: 'Reporte listo para compartir', ruta: r.uri };
    } catch (e) {
      // El usuario cerró el diálogo: el archivo queda en caché igualmente
      return { ok: true, mensaje: 'Reporte generado (' + nombre + ')', ruta: r.uri };
    }
  }
  if (electron && electron.guardarArchivo) {
    const r = await electron.guardarArchivo({ nombre, base64, mime });
    return r.ok ? { ok: true, mensaje: 'Guardado en ' + r.ruta, ruta: r.ruta } : { ok: false, mensaje: 'Exportación cancelada' };
  }
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
  const a = document.createElement('a'); a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { ok: true, mensaje: 'Descargando ' + nombre };
}

export function nombreDispositivoSugerido() {
  if (esCapacitor) return 'Android';
  if (electron) return 'PC ' + (electron.nombreEquipo || 'Windows');
  return 'Navegador';
}

export function abrirEnlaceExterno(url) {
  if (electron && electron.abrirExterno) electron.abrirExterno(url);
  else window.open(url, '_blank', 'noopener');
}
