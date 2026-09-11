/**
 * Textos de ayuda de la app. Cada clave tiene título, explicación y ejemplos.
 * Se muestran con el botón "?" (tooltip al pasar el mouse en PC, ventana al tocar en el teléfono).
 */
export const AYUDAS = {
  // ---------- inicio ----------
  cartera: {
    titulo: 'Cartera',
    texto: 'Cada cartera es una empresa con su propio saldo de USDT, su costo promedio y sus reportes. Lo que registres queda marcado con la cartera elegida.',
    ejemplos: ['CPA BEJUMA: la cuenta de Binance de la panadería.', 'PANAMERICANA: la cuenta de la distribuidora.'],
  },
  tasas: {
    titulo: 'Tasas del momento',
    texto: 'BCV oficial es la tasa publicada por el Banco Central (con su fecha valor). P2P compra es lo que cuesta comprar USDT ahora en Binance (promedio de los 5 mejores vendedores); P2P venta es lo que pagan por tus USDT (promedio de los 5 mejores compradores). Se actualiza cada 5 minutos y el backend guarda un histórico cada 30 minutos.',
    ejemplos: ['BCV 832,49 · P2P venta 956,28 → la brecha es +14,87 %: por cada USDT vendido en P2P recibes 123,79 Bs más que al cambio oficial.'],
  },
  brecha: {
    titulo: 'Brecha P2P vs BCV',
    texto: 'Cuánto está el mercado P2P por encima (o por debajo) de la tasa oficial. Es la referencia para saber si conviene vender USDT o pagar en bolívares.',
    ejemplos: ['+15 % significa que 100 USDT en P2P valen 15 % más bolívares que 100 dólares al BCV.'],
  },
  resumen: {
    titulo: 'Estado de la cartera',
    texto: 'Saldo = USDT comprados netos menos USDT vendidos. Costo promedio = precio promedio ponderado en Bs de los USDT que aún tienes. Resultado realizado = ganancia o pérdida de las ventas frente a ese costo. No realizado = lo que ganarías si vendieras hoy el saldo al P2P.',
    ejemplos: ['Compras 100 USDT a 950 y 100 a 960 → costo promedio 955.', 'Vendes 50 a 965 → resultado realizado (965 − 955) × 50 = +500 Bs.'],
  },
  ultimas: {
    titulo: 'Últimas operaciones',
    texto: 'Las 5 más recientes de la cartera. Toca una para ver el detalle completo, anularla o corregir sus notas. En "Ver todas" está el historial con filtros.',
    ejemplos: ['C = compra (verde), V = venta (rojo), tachada = anulada.'],
  },
  actualizar: {
    titulo: 'Actualizar',
    texto: 'Vuelve a consultar el BCV, Binance y Google Sheets ahora mismo, sin esperar el refresco automático.',
    ejemplos: ['Úsalo si registraste algo desde el otro dispositivo y quieres verlo aquí.'],
  },
  // ---------- registro ----------
  tipo: {
    titulo: 'Compra o venta',
    texto: 'COMPRA: entregas bolívares y recibes USDT. VENTA: entregas USDT y recibes bolívares. Cambia el color, la tasa sugerida (vendedores o compradores) y el signo de los diferenciales.',
    ejemplos: ['Pagas 95.000 Bs por 100 USDT → COMPRA.', 'Un cliente te transfiere 48.000 Bs por 50 USDT → VENTA.'],
  },
  fechaHora: {
    titulo: 'Fecha y hora',
    texto: 'Cuándo ocurrió la operación (por defecto ahora). Puedes registrar operaciones de días anteriores; el orden cronológico se usa para calcular el costo promedio.',
    ejemplos: ['Compra hecha ayer que olvidaste anotar: cambia la fecha a ayer.'],
  },
  monto: {
    titulo: 'Monto USDT',
    texto: 'Cantidad de USDT de la operación, antes de comisiones. Acepta coma o punto como decimal.',
    ejemplos: ['100', '250,5', '1.000,25'],
  },
  tasa: {
    titulo: 'Tasa de la operación',
    texto: 'Bolívares por cada USDT que realmente se pactaron con la contraparte. Se rellena con la sugerencia P2P, pero escribe la tuya. Los chips te dan el mejor precio publicado, la sugerida, la mediana y la lista de anuncios.',
    ejemplos: ['El vendedor te cobró 958,50 por USDT → escribe 958,50.', 'Toca "Ver anuncios" y elige el anunciante con quien operaste para copiar su precio.'],
  },
  tasaP2p: {
    titulo: 'Tasa P2P de referencia',
    texto: 'Precio "justo" del mercado en ese momento: promedio de los 5 mejores anuncios de comerciantes serios (≥ 50 órdenes al mes y ≥ 95 % de finalización) cuyos límites admiten tu monto. Sirve para medir si compraste barato o vendiste caro. Puedes cambiarla.',
    ejemplos: ['Compraste a 958 con referencia 960 → diferencial P2P +2 Bs por USDT a tu favor.'],
  },
  tasaBcv: {
    titulo: 'Tasa BCV',
    texto: 'Tasa oficial del día, tomada del Banco Central. Se usa para el diferencial vs BCV y para el equivalente en dólares de la contabilidad.',
    ejemplos: ['Si registras una operación de un día anterior, escribe el BCV de ese día (está en la pestaña TASAS de la hoja).'],
  },
  comisiones: {
    titulo: 'Comisiones',
    texto: 'Se calculan solas con las reglas de Ajustes (porcentaje del monto en USDT y del total en Bs). Si la comisión real fue distinta, escribe el valor; "recalcular" vuelve al automático. En una compra encarecen el costo; en una venta reducen lo recibido. Entran en la tasa efectiva y en el resultado.',
    ejemplos: ['Retiro con 1 USDT de comisión → Comisión USDT = 1.', 'Transferencia con 150 Bs de comisión bancaria → Comisión Bs = 150.'],
  },
  operacion: {
    titulo: 'Datos de la operación',
    texto: 'Lo mínimo para registrar: fecha, monto en USDT y tasa pactada. Todo lo demás (tasas de referencia, comisiones) se rellena solo y puedes corregirlo.',
    ejemplos: ['Compra de 100 USDT a 958,50 → escribe 100 y 958,50; el resto se calcula.'],
  },
  referencias: {
    titulo: 'Referencias del mercado',
    texto: 'Tasa P2P de referencia (promedio del mercado en Binance en este momento) y tasa BCV del día. Se guardan con la operación para calcular los diferenciales y mantener la "foto" del mercado de ese día. Solo cámbialas si registras una operación de otra fecha.',
    ejemplos: ['Operación de la semana pasada: pon el BCV y el P2P de ese día (están en la pestaña TASAS de la hoja).'],
  },
  observaciones: {
    titulo: 'Observaciones',
    texto: 'Nota libre: para qué fue la operación, con quién, número de orden… Se puede editar después desde el historial y aparece en los reportes.',
    ejemplos: ['Compra para pagar proveedor de harina.', 'Orden P2P 2025091144710 · Banesco.'],
  },
  comisionesConfig: {
    titulo: 'Comisiones por defecto',
    texto: 'Reglas con las que la app calcula las comisiones al registrar: un porcentaje del monto en USDT (comisión de Binance o del comercio), un porcentaje del total en bolívares (comisión bancaria o de pago móvil) y montos fijos. Guárdalas y se aplicarán a las próximas operaciones.',
    ejemplos: ['Compra: 0 % USDT + 0,30 % Bs (pago móvil interbancario).', 'Venta: 0,20 % USDT (comisión del comercio) + 0 Bs.'],
  },
  previa: {
    titulo: 'Vista previa',
    texto: 'Se recalcula mientras escribes: total en bolívares, USDT netos, tasa efectiva (incluye comisiones), equivalente al BCV y los dos diferenciales. Verde = a tu favor, rojo = en contra.',
    ejemplos: ['Compra 100 USDT a 960 con BCV 832,49 → diferencial vs BCV −12.751 Bs (pagaste eso más que al cambio oficial).'],
  },
  // ---------- historial ----------
  filtros: {
    titulo: 'Filtros del historial',
    texto: 'Busca por nota, ID, monto o tasa; elige un mes; y filtra por compras, ventas o anuladas. Los totales de cada mes (USDT y diferenciales) se muestran en la cabecera del grupo.',
    ejemplos: ['Escribe "harina" para ver las compras anotadas para ese proveedor.'],
  },
  detalleOperacion: {
    titulo: 'Detalle de una operación',
    texto: 'Toca cualquier fila para ver todos los campos. "Anular" la marca como ANULADA en la hoja (no se borra, queda el motivo) y deja de contar. "Editar notas" solo cambia las observaciones; para corregir montos, anula y registra de nuevo.',
    ejemplos: ['Registraste dos veces la misma compra → anula la duplicada con motivo "duplicada".'],
  },
  // ---------- reportes ----------
  tiposReporte: {
    titulo: 'Tipos de reporte',
    texto: 'Utilidades: resultado de las ventas contra el costo promedio, diferenciales, comisiones y saldos. Diferenciales: cuánto ganaste o perdiste frente al BCV y frente al P2P, por mes y por operación. Compras y Ventas: detalle y totales del período.',
    ejemplos: ['Para la reunión mensual de gerencia: Utilidades + Mes anterior + Exportar a PDF.'],
  },
  rango: {
    titulo: 'Rango de fechas',
    texto: 'Botones rápidos (este mes, mes anterior, 30 días, trimestre, año, todo) o fechas libres en Desde/Hasta. El saldo inicial es el que había antes del primer día del rango.',
    ejemplos: ['Desde 01/07/2026 hasta 30/09/2026 → tercer trimestre.'],
  },
  carteraReporte: {
    titulo: 'Cartera del reporte',
    texto: 'Una empresa o AMBAS consolidadas. En AMBAS el detalle indica la cartera de cada operación.',
    ejemplos: [],
  },
  exportar: {
    titulo: 'Exportar a PDF',
    texto: 'Genera un PDF con membrete (logo, empresa, período, fecha), los indicadores y las tablas del reporte que estás viendo. En Windows abre "Guardar como" y luego el archivo; en Android abre Compartir (WhatsApp, correo, Drive…).',
    ejemplos: ['Nombre del archivo: USDT-utilidades-CPABEJUMA-2026-09-01_a_2026-09-30.pdf'],
  },
  // ---------- ajustes ----------
  seguridad: {
    titulo: 'Seguridad',
    texto: 'El PIN cifra todo lo guardado en este dispositivo. La huella (solo teléfono) libera la misma llave sin escribir el PIN. "Bloquear ahora" vuelve a pedir PIN; también se bloquea sola tras 5 minutos sin uso. "Cerrar sesión con el servidor" obliga a repetir la verificación anti-bot.',
    ejemplos: ['Prestas el teléfono un momento → Bloquear ahora.'],
  },
  dispositivo: {
    titulo: 'Este dispositivo',
    texto: 'El nombre queda escrito en cada operación que registres desde aquí (columna DISPOSITIVO de la hoja). Desvincular borra la clave de enlace, el PIN y la copia local; los datos en Google Sheets no se tocan.',
    ejemplos: ['Vas a regalar el teléfono → Desvincular antes de entregarlo.'],
  },
  baseDatos: {
    titulo: 'Base de datos',
    texto: 'Todo vive en tu Google Sheets: BD_USDT (una fila por operación), TASAS (histórico de tasas cada 30 min) y PANEL_USDT (resumen con fórmulas). Solo la app y el propietario pueden editarlas.',
    ejemplos: [],
  },
  acercaDe: {
    titulo: 'Acerca de y actualizaciones',
    texto: 'Versión instalada, plataforma y estado del anti-bot. "Buscar actualizaciones" consulta las versiones publicadas: en Windows instalado se descargan e instalan solas; en portable y Android se descarga el archivo y se instala encima (conserva tus datos).',
    ejemplos: [],
  },
  // ---------- bienvenida ----------
  claveEnlace: {
    titulo: 'Clave de enlace',
    texto: 'Contraseña larga que genera el backend (API_KEY en las propiedades del script). Es la misma para todos los dispositivos y se guarda aquí cifrada con tu PIN. Sin ella la app no puede hablar con Google Sheets.',
    ejemplos: ['La ves en Apps Script → Configuración del proyecto → Propiedades del script → API_KEY.'],
  },
  nombreDispositivo: {
    titulo: 'Nombre del dispositivo',
    texto: 'Identifica desde dónde se registró cada operación.',
    ejemplos: ['PC Oficina', 'Teléfono Juan'],
  },
  pin: {
    titulo: 'PIN',
    texto: '6 dígitos que protegen la app y cifran los datos locales. Si lo olvidas, la única salida es desvincular el dispositivo y enlazarlo otra vez con la clave de enlace.',
    ejemplos: ['Evita fechas de nacimiento o 123456.'],
  },
  verificacion: {
    titulo: 'Verificación anti-bot',
    texto: 'Desafío de Cloudflare Turnstile que impide que un programa automatizado use la clave de enlace. Se pide al abrir sesión y la sesión dura 12 horas.',
    ejemplos: [],
  },
};
