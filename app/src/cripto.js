/**
 * Criptografía local (WebCrypto, disponible en Chromium/Electron/Android WebView).
 *
 * - La llave maestra se deriva del PIN con PBKDF2 (300.000 iteraciones, SHA-256) y una sal aleatoria.
 * - Todo lo sensible (clave de enlace, sesión, caché de operaciones) se guarda cifrado con AES-256-GCM.
 * - Sin el PIN (o la huella, que libera la misma llave) los datos locales son ilegibles.
 */
const ITERACIONES = 300000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function aleatorioBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function aBase64(bytes) {
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s);
}

export function deBase64(texto) {
  const s = atob(texto);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

/** Deriva la llave AES a partir del PIN y la sal (base64). */
export async function derivarLlave(pin, salBase64) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: deBase64(salBase64), iterations: ITERACIONES, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );
}

export async function exportarLlave(llave) {
  return aBase64(new Uint8Array(await crypto.subtle.exportKey('raw', llave)));
}

export async function importarLlave(base64) {
  return crypto.subtle.importKey('raw', deBase64(base64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

/** Cifra un texto -> base64(iv + datos cifrados). */
export async function cifrar(llave, texto) {
  const iv = aleatorioBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, llave, enc.encode(texto)));
  const todo = new Uint8Array(iv.length + ct.length);
  todo.set(iv); todo.set(ct, iv.length);
  return aBase64(todo);
}

/** Descifra base64(iv + datos) -> texto. Lanza error si la llave no es la correcta. */
export async function descifrar(llave, base64) {
  const todo = deBase64(base64);
  const iv = todo.slice(0, 12);
  const ct = todo.slice(12);
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, llave, ct));
}

export async function sha256(texto) {
  return aBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(texto))));
}
