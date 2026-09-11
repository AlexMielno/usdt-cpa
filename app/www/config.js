// =====================================================================================
//  CONFIGURACIÓN DE LA APP (único archivo que hay que tocar para conectar con el backend)
// =====================================================================================
window.CONFIG_USDT = {
  // URL de la aplicación web de Google Apps Script (Implementar > Aplicación web > URL)
  API_URL: 'https://script.google.com/macros/s/AKfycbw4wf3QeTbotVv052q5Pa1PFZlxmGtjFSH5ksz4UtMiseL64hlxNdChAr6TOMeY0qRB7g/exec',

  // Clave de sitio (pública) de Cloudflare Turnstile. Déjala vacía ('') para desactivar el desafío anti-bot.
  // El backend solo lo exige si en Apps Script se guardó el secreto con establecerTurnstile('...').
  TURNSTILE_SITEKEY: '0x4AAAAAAEwX3XBX5DNQ7Ncc',

  // Minutos de inactividad antes de bloquear la app y pedir PIN/huella otra vez
  MINUTOS_BLOQUEO: 5,

  // Cada cuántos minutos se refrescan las tasas automáticamente en la pantalla de inicio
  MINUTOS_REFRESCO_TASAS: 5,

  // Carteras disponibles (deben coincidir con las del backend y la hoja)
  CARTERAS: ['CPA BEJUMA', 'PANAMERICANA'],

  // Actualizaciones: repositorio de GitHub donde se publican las versiones (Releases).
  // Windows instalado: se descarga e instala sola. Windows portable y Android: avisa y abre la descarga.
  ACTUALIZACIONES: { propietario: 'AlexMielno', repositorio: 'usdt-cpa' },

  // Versión de esta compilación (la actualiza herramientas/nueva_version.js)
  VERSION: '1.1.0',
};
