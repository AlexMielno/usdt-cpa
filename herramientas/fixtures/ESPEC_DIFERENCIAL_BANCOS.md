# Especificación: reporte "Diferencial desde bancos" (v1.6.0)

Función NUEVA e INDEPENDIENTE de los reportes actuales. No se toca la lógica existente de BD_USDT,
registro, historial, reportes ni modo tabulador (solo se agregan puntos de entrada).

## 1. Problema de negocio

La empresa lleva su contabilidad bancaria en OTRO libro de Google Sheets: **"ADM.-002 BANCOS CPA"**,
ID `1uCJ0GZ97pm1lVzGXYTmHEet07Woa3IAe18qTAOoem54`. La cuenta que ejecuta el backend
(analisisventascpapanamericana@gmail.com) es PROPIETARIA de ese libro, así que Apps Script puede abrirlo con
`SpreadsheetApp.openById`.

Pestañas relevantes (todas con la MISMA cabecera de 21 columnas en la fila 1, salvo TASA):

```
A FECHA | B Nro | C Descripcion | D concepto | E Tipo | F Partida | G Cobrado Anticipo | H DEBE | I HABER | J COMISION | K IGTF
L SALDO | M TASA | N DEBE $ | O HABER $ | P COMISION $ | Q IGTF $ | R SALDOS $ | S YEAR | T MES | U Ajuste de Saldo
```

- **BINANCE**: la "cuenta" de USDT. DEBE (H) = USDT que ENTRAN (compra), HABER (I) = USDT que SALEN (venta o pago).
  TASA (M) siempre 1, no hay bolívares. La columna Partida (F) dice contra qué se movió: `BANCO MERCANTIL`,
  `BINANCE`, `EFECTIVO DOLARES`, `ACTIVOS FIJOS`, `SOCIOS Y GERENTES`, `CXP CPA PANINO`, etc.
  Desde 2026 la columna "concepto" (D) viene vacía y las descripciones son inconsistentes
  ("COMPRA", "COMPRA DE USDT", "compra usdt para aire", "ABONO A DEUDA BINANCE", "TRASLADO DE FONDOS", "PRESTAMO A CPA").
- **MERCANTIL, BANESCO, BNC, VENEZUELA, BPLUS, BBVA, Efectivo BsS, Efectivo $, CRUCE**: cuentas en bolívares
  (Efectivo $ y CRUCE están en dólares, tasa 1). DEBE = entra dinero, HABER = sale dinero. M TASA = BCV del día.
  Una compra de USDT aparece como DOS líneas: una contra partida `BINANCE` (USDT × BCV en Bs) y otra contra partida
  `DIFERENCIAL CAMBIARIO` (el excedente pagado sobre el BCV). Ejemplo MERCANTIL 3/1/2026:
  `HABER 781.015,42 Bs, TASA 301,37, HABER $ 2.591,55, partida BINANCE` + `HABER 742.334,58 Bs, partida DIFERENCIAL CAMBIARIO`.
  Total pagado 1.523.350 Bs por 2.591,55 USDT → tasa pactada 587,8 Bs/USDT.
  Una venta: líneas en DEBE (entra Bs) con partida BINANCE y DIFERENCIAL CAMBIARIO.
  OJO: la partida DIFERENCIAL CAMBIARIO también se usa para compras de efectivo a empleados ("JENCYS COMPRA $ 200"),
  bonos, "DIFERENCIAL EN TASA", etc. NO todo diferencial es Binance.
  A veces las etiquetas BINANCE/DIFERENCIAL están intercambiadas o falta una (11/10/2025 en MERCANTIL: 3 líneas).
  A veces la línea tiene Nro (número de referencia bancaria) que coincide entre las dos líneas de la misma operación.
- **TASA**: `A FECHA | B TASA BCV | C Observacion`, una fila por día (desde 2023), no siempre ordenada.
- Fechas: en la hoja real la mayoría son fechas de verdad (Apps Script devuelve `Date`; en el fixture son seriales
  tipo 45941), pero hay textos: `01/10/25`, `3/1/2026`, `30-05-26`, `15/08` (sin año → usar columna S YEAR).
- Números: casi siempre numéricos; puede venir texto `$6.264,34`, `  1.000,00 `, `  -   `, `''`.

Muestra REAL (valores sin formato, fechas como serial de Sheets, 1899-12-30 = 0):
`herramientas/fixtures/bancos_muestra.json` → `{ titulo, hojas: { BINANCE: [[...21]], MERCANTIL: [...], ..., TASA: [[fecha, tasa, obs]] } }`.
Fila 0 de cada hoja = cabecera. En los bancos solo están las filas relevantes (±2 vecinas), por eso los números
de fila NO coinciden con la hoja real; en el simulador se sirven tal cual.

Convención de signos (igual que `app/src/calculos.js`): **diferencial POSITIVO = a favor de la empresa, NEGATIVO = en contra.**
COMPRA: `dif = -(tasaPactada - tasaBcv) × usdt` (pagar por encima del BCV es negativo).
VENTA / PAGO: `dif = +(tasaPactada - tasaBcv) × usdt`.
`difUsd = difBs / tasaBcv`. `tasaPactada = totalBs / usdt`. `equivUsdBcv = totalBs / tasaBcv`.

## 2. Backend (Apps Script) — archivo nuevo `backend/Bancos.js`

Estilo del proyecto: funciones privadas con sufijo `_`, errores con `new ErrorApi('codigo', 'mensaje')`, utilidades de
`Config.js` (`texto_`, `numero_`, `redondear_`, `formatoFecha_`, `CONFIG_TZ_`, `hoja_`, `libro_`), sesión validada por
`Api.js` antes de llamar a `ejecutar_`.

### 2.1 Configuración (en `Config.js`, dentro de CONFIG)
```js
BANCOS: {
  LIBRO_ID: '1uCJ0GZ97pm1lVzGXYTmHEet07Woa3IAe18qTAOoem54', // se puede sobreescribir con la propiedad del script BANCOS_LIBRO_ID
  HOJA_USDT: 'BINANCE',      // si no existe: primera hoja cuyo nombre contenga BINANCE o USDT
  HOJA_TASA: 'TASA',
  HOJA_DECISIONES: 'DIF_BANCOS',   // pestaña NUEVA en el libro de la app (BD_USDT), se crea sola
  MARGEN_DIAS: 7,            // margen alrededor del rango pedido para movimientos y tasas
}
```
Detección adaptativa de hojas de banco: toda pestaña del libro de bancos (distinta de HOJA_USDT y HOJA_TASA) cuya
fila 1 tenga, normalizando (mayúsculas, sin espacios ni acentos), `FECHA` en A, `PARTIDA` en F, `DEBE` en H y `HABER` en I.
Nunca depender de una lista fija de nombres.

### 2.2 Acción `bancos` → `leerBancos_(datos)`
Petición: `{ desde: 'YYYY-MM-DD' | '', hasta: 'YYYY-MM-DD' | '' }` (vacío = sin límite).
Respuesta:
```js
{
  libro: { id, titulo, leido: ISO8601 },
  hojaUsdt: 'BINANCE',
  bancos: ['MERCANTIL', 'BANESCO', ...],                // hojas detectadas (orden del libro)
  usdt: [{ ref: 'BINANCE!12', fila: 12, fecha: 'YYYY-MM-DD' | '', fechaTexto: 'lo que había', descripcion, concepto, tipo, partida,
           entrada: 6872.7, salida: 0, saldo: 6872.7 }],   // filas con entrada>0 o salida>0 dentro del rango (sin margen)
  movimientos: [{ ref: 'MERCANTIL!2918', banco: 'MERCANTIL', fila: 2918, fecha, fechaTexto, nro: '47900093210', descripcion, concepto, tipo, partida,
                  debeBs, haberBs, comisionBs, igtfBs, tasa: 301.37, debeUsd, haberUsd,
                  clase: 'BINANCE' | 'DIFERENCIAL' | 'OTRO' }],   // dentro del rango ± MARGEN_DIAS
  tasas: { 'YYYY-MM-DD': 301.37, ... },                // de la hoja TASA, dentro del rango ± MARGEN_DIAS (todo si no hay rango)
  avisos: ['BINANCE fila 74: fecha "15/08" sin año, se asumió 2026 por la columna YEAR', ...]
}
```
Filtro de `movimientos`: partida normalizada contiene `BINANCE` → clase BINANCE; contiene `DIFERENCIAL` → clase DIFERENCIAL;
si no, pero descripción o concepto contienen `USDT`, `USTD` o `BINANCE` → clase OTRO. El resto NO se envía.
Lectura: `getRange(1, 1, lastRow, 20).getValues()` por hoja (una sola lectura por hoja; las hojas tienen ~30.000 filas).
Parseo de fecha (`fechaDesdeCelda_(valor, anioColumna)`): `Date` → ISO en zona del script; número → serial de Sheets
(días desde 1899-12-30); texto `d/m/yyyy`, `d/m/yy`, `d-m-yy`, `d-m-yyyy`, `d/m` (año = columna S si es número, si no el
año de la última fila válida) → ISO; si no se puede: `fecha: ''` + aviso, la fila igual se envía.
Parseo numérico (`numeroCelda_`): número → tal cual; texto estilo es-VE (`$`, espacios, puntos de miles, coma decimal, `-` = 0).
Redondear Bs a 2 decimales, USD/USDT a 4, tasas a 4.
Rango: una fila de USDT se incluye si `fecha` vacía (para que el usuario la vea) o `desde <= fecha <= hasta`.
Si el libro no se puede abrir: `ErrorApi('bancos_sin_acceso', ...)`. Si no hay hoja USDT: `ErrorApi('bancos_sin_hoja_usdt', ...)`.

### 2.3 Decisiones del usuario (pestaña `DIF_BANCOS` en el libro de la app)
Cabecera (fila 1): `CLAVE | FECHA | TIPO | USDT | BANCO | REFS | TOTAL BS | TASA PACTADA | TASA BCV | ESTADO | NOTA | ACTUALIZADO | DISPOSITIVO`.
Se crea con `libro_().insertSheet(nombre)` si no existe.
Objeto decisión (JSON en la app y en la respuesta):
```js
{ clave, fecha: 'YYYY-MM-DD', tipo: 'COMPRA'|'VENTA'|'PAGO'|'EXCLUIR', usdt, banco, refs: ['MERCANTIL!3973', 'MERCANTIL!3974'],
  totalBs, tasaPactada, tasaBcv, estado: 'CONFIRMADA'|'EXCLUIDA', nota, actualizado: ISO, dispositivo }
```
`clave` la genera la APP (ver §3.1) y es la llave de upsert. `refs` se guarda como JSON en la celda.
- Acción `bancosDecisiones` → `{ decisiones: [...] }` (todas).
- Acción `bancosGuardar` con `{ decisiones: [...], borrar: ['clave', ...] }` → upsert por clave (reescribe la fila
  existente o agrega), borra las claves pedidas, devuelve `{ guardadas: n, borradas: m }`. Validar con `texto_`/`numero_`,
  `tipo` y `estado` dentro de los valores permitidos, máximo 500 decisiones por llamada. `dispositivo` sale de `sesion.dispositivo`
  (ver cómo lo usa `registrarOperacion_`). Usar `LockService` como en `registrarOperacion_`.

### 2.4 Enrutado (`Api.js`, `ejecutar_`)
```js
case 'bancos': return leerBancos_(datos);
case 'bancosDecisiones': return decisionesBancos_();
case 'bancosGuardar': return guardarDecisionesBancos_(datos, sesion);
```
Añadir las tres al comentario de cabecera de Api.js y un `probarBancos()` para el editor.

### 2.5 Simulador (`herramientas/simulador_backend.js`)
- `SpreadsheetApp.openById(id)` devuelve un libro en memoria construido desde `herramientas/fixtures/bancos_muestra.json`
  (cualquier id): `getName()`, `getSheets()`, `getSheetByName()`. En la columna A de todas las hojas y en TASA, los
  números se convierten a `Date` (serial → `new Date(Date.UTC(1899,11,30) + serial*86400000)`), para imitar a Apps Script;
  los textos se dejan como texto.
- La clase `Hoja` necesita además: `getLastColumn()`, `getDataRange()`, `clearContents()`, `getRange(a1)` NO hace falta.
  El libro de la app necesita `insertSheet(nombre)`.
- Conservar todo lo existente.

### 2.6 Prueba del backend: `herramientas/prueba_bancos.js` (node, sin dependencias)
Arranca contra el simulador en `http://localhost:8787/` (asume que ya está corriendo): `sesion` con la clave
`CLAVE-DE-PRUEBA-LOCAL-1234` → `bancos` sin rango y con rango 2026-01-01..2026-01-31 → imprime conteos por hoja/clase,
3 ejemplos de `usdt` y `movimientos`, avisos → `bancosGuardar` con 2 decisiones → `bancosDecisiones` → verifica que
vuelven → `bancosGuardar` con `borrar` de una → verifica. Sale con código 1 si algo falla.

## 3. Lógica de conciliación en la app — archivo nuevo `app/src/conciliacion.js` (funciones puras, sin DOM)

Importa solo de `./calculos.js` y `./formato.js`. Exporta:

### 3.1 `prepararOperaciones(respuestaBancos)` → `ops[]`
Una por fila `usdt`: `{ clave, ref, fila, fecha, fechaTexto, descripcion, partida, lado: 'E'|'S', usdt, tipoSugerido, bancoSugerido, relevante }`.
- `clave = fecha + '|' + lado + '|' + usdt.toFixed(2) + '|#' + n` donde n = posición (1, 2, ...) entre las filas con la misma
  (fecha, lado, usdt) en orden de fila. Estable aunque se inserten filas arriba.
- `tipoSugerido`: lado E → `COMPRA`; lado S → `VENTA` si `bancoSugerido` existe o la descripción contiene VENTA; si no → `PAGO`.
- `bancoSugerido`: a partir de `partida` y la lista `bancos` de la respuesta. Reglas: normalizar (mayúsculas, sin acentos,
  sin "BANCO"); coincidencia por contención en ambos sentidos; sinónimos: `PROVINCIAL` → BBVA, `BDV` → VENEZUELA,
  `PLUS` → BPLUS, `EFECTIVO DOLARES|EFECTIVO $` → `Efectivo $`, `EFECTIVO BOL|BSS` → `Efectivo BsS`. Si partida es
  `BINANCE` o vacía → '' (se buscará en todos los bancos).
- `relevante`: true si hay `bancoSugerido` o la descripción/concepto contiene USDT/USTD/COMPRA/VENTA; false para salidas
  contra ACTIVOS FIJOS, SOCIOS, CXP, etc. (pagos en USDT sin contrapartida en Bs). Las no relevantes se muestran pero
  quedan `EXCLUIR` por defecto (el usuario puede cambiarlas a PAGO y escribir el valor de la factura en Bs).

### 3.2 `emparejar(ops, movimientos, opciones)` → `Map<clave, sugerencia>`
`opciones = { diasTolerancia: 3, tolUsd: 0.015 }`. Greedy en orden de fecha; cada movimiento se usa una sola vez.
Para cada op relevante con fecha:
1. Candidatos = movimientos con `|fecha − op.fecha| ≤ diasTolerancia`, del `bancoSugerido` (o de todos si no hay),
   del lado correcto: COMPRA → `haberBs > 0` (salen Bs); VENTA → `debeBs > 0` (entran Bs).
2. Línea principal: clase BINANCE cuyo `haberUsd|debeUsd` (según lado) ≈ `op.usdt` (tolerancia relativa `tolUsd`); si no hay,
   cualquier clase cuyo `bs / tasa` ≈ usdt. Preferir misma fecha, luego la más cercana.
3. Líneas de diferencial: clase DIFERENCIAL del mismo banco y lado, no usadas, con el mismo `nro` (si no está vacío) o,
   si no, misma fecha y `|fila − filaPrincipal| ≤ 4`. Si hay varias, tomar todas las que cumplan la regla del nro; con la
   regla de fila, solo la más cercana.
4. `totalBs` = suma de Bs de las líneas elegidas. `confianza`: `alta` si principal con misma fecha y hay diferencial (o la
   tasa implícita queda entre 0,9× y 2,5× el BCV); `media` si principal encontrada pero sin diferencial o con fecha distinta;
   `baja` si solo hay líneas de clase OTRO/DIFERENCIAL que cuadran por Bs/tasa; `sin` si nada.
5. Devuelve `{ refs: [...], totalBs, confianza, motivo: 'texto corto para el usuario', candidatos: [refs de todo lo que estaba
   cerca y del lado correcto, para el selector manual] }`.
También exporta `movimientosSinPareja(movimientos, sugerencias, decisiones)` → movimientos de clase BINANCE no usados por
ninguna sugerencia ni decisión (para la sección "movimientos bancarios sin operación en BINANCE").

### 3.3 `tasaBcvPara(fecha, tasas, movimientosElegidos)` → número
Prioridad: tasa de `tasas[fecha]`; si no, la fecha anterior más cercana en `tasas` (hasta 7 días); si no, la columna
`tasa` de la primera línea elegida; si no, 0.

### 3.4 `calcularFila(op, decision, tasas, movimientosPorRef)` → `{ totalBs, tasaPactada, tasaBcv, difBs, difUsd, difPct, equivUsdBcv, tipo, estado }`
`decision` puede ser una decisión guardada, una sugerencia aplicada o una edición manual: campos `tipo, refs, totalBs, tasaPactada, tasaBcv`.
Si `totalBs` no viene pero hay `refs`, se suma de los movimientos. Si viene `tasaPactada` y no `totalBs`, `totalBs = tasaPactada × usdt`.
Aplicar la convención de signos de §1 con `redondear` de calculos.js. `tipo EXCLUIR` → todo 0 y `estado: 'EXCLUIDA'`.

### 3.5 `reporteDiferencialBancos(filas, desde, hasta, opciones)` → misma estructura que `app/src/reportes.js`
`filas = [{ op, decision, calculo, estado: 'CONFIRMADA'|'SUGERIDA'|'REVISAR'|'EXCLUIDA' }]`, solo se suman CONFIRMADA y SUGERIDA
(con `opciones.soloConfirmadas` = true, solo CONFIRMADA).
```
{ tipo: 'diferencial-bancos', titulo: 'Diferencial cambiario desde bancos', subtitulo: 'dd/mm/yyyy al dd/mm/yyyy', cartera: 'CPA BEJUMA',
  desde, hasta,
  kpis: [ Diferencial neto $ (clase positivo/negativo), Diferencial neto Bs, Compras (USDT y $ al BCV), Ventas/pagos (USDT y $), Tasa pactada promedio compra vs BCV promedio, Operaciones (n confirmadas / n por revisar / n excluidas) ],
  secciones: [
    { titulo: 'Resumen por mes', columnas: ['Mes','Compras USDT','Bs pagados','Dif. compras $','Ventas USDT','Bs recibidos','Dif. ventas $','Dif. neto $','Dif. neto Bs'], filas, totales, alinear: [0] },
    { titulo: 'Detalle por operación', columnas: ['Fecha','Tipo','USDT','Banco','Total Bs','Tasa pactada','Tasa BCV','Dif. Bs','Dif. $','Estado'], filas, totales, alinear: [0,1,3,9] },
    { titulo: 'Por revisar (no incluidas)', columnas: ['Fecha','Descripción','USDT','Motivo'], filas, alinear: [0,1,3] }
  ],
  nota: 'Fuente: libro ... leído el ...; tasa BCV de la pestaña TASA; diferencial = (tasa pactada − BCV) × USDT, positivo a favor de la empresa.' }
```
Formatos con `num/usd/ves/signo/signoUsd/fechaCorta/nombreMes` de formato.js (los valores con signo `+`/`-` se colorean solos).

### 3.6 Prueba: `app/pruebas/prueba_conciliacion.js` (node)
Convierte el fixture crudo al formato de la respuesta `bancos` con un conversor mínimo dentro de la prueba (serial → ISO,
textos de fecha → ISO con las reglas de §2.2, números es-VE), ejecuta preparar/emparejar/calcular/reporte y verifica con
`assert`: (a) la compra de MERCANTIL del 3/1/2026 por 2.591,55 USDT se empareja con las líneas BINANCE + DIFERENCIAL del
mismo Nro y da tasa pactada ≈ 587,8; (b) las salidas contra ACTIVOS FIJOS no son relevantes; (c) signos correctos;
(d) el reporte tiene las 3 secciones y totales coherentes. Imprime un resumen por mes. Node 25 ejecuta ESM en `.js`
si el import lo exige; si falla, empaquetar con `npx esbuild pruebas/prueba_conciliacion.js --bundle --platform=node --outfile=pruebas/.tmp/prueba_conciliacion.cjs` y ejecutar eso (dejar un script `npm run probar:conciliacion` en app/package.json).

## 4. Interfaz — pantalla nueva `app/src/pantallas/diferencial.js` (ruta `diferencial`)

Estilo: imitar `pantallas/tabla.js` (tabla `.hoja` con celdas editables, Tab/Enter/flechas) y `pantallas/reportes.js`.
Ayudas con `ayuda('clave')` (textos nuevos en `ayudas.js`: `diferencialBancos`, `emparejar`, `decisionFila`, `movimientosBancarios`).

### 4.1 Entrada
En `pantallas/reportes.js`, debajo del selector de tipo, una tarjeta/botón secundario **"Diferencial desde bancos →"**
(con ayuda) que navega a `diferencial`. En `main.js`, `case 'diferencial': return pantallaDiferencial(ctx);`.
La pantalla usa `conNavegacion(contenido, 'reportes')` y cabecera con botón atrás a `reportes`.

### 4.2 Capa de datos
`api.js`: `bancos(desde, hasta)`, `bancosDecisiones()`, `bancosGuardar(decisiones, borrar)`.
`datos.js`: `cargarBancos(desde, hasta, forzar)` (guarda la última respuesta cifrada en `almacen` bajo `bancos` con
`{ datos, hora, desde, hasta }` para abrir rápido; se refresca si cambia el rango o pasan 10 min o `forzar`),
`cargarDecisionesBancos()`, `guardarDecisionesBancos(cambiadas, borrar)` (actualiza `estado.decisionesBancos`).
`estado.js`: `bancos: null, bancosHora: 0, decisionesBancos: []`.

### 4.3 Pantalla (dos vistas, alternables con un selector tipo `.selector`: **Conciliar** | **Reporte**)
Barra superior: chips de período (reusar `rangoPredefinido` de reportes.js: Este mes, Mes anterior, Trimestre, Este año, Todo)
+ inputs Desde/Hasta; botones: **Leer bancos** (refresca del backend; muestra "leído hace X" con `haceCuanto`),
**Auto-emparejar** (recalcula sugerencias de las filas SIN decisión confirmada), **Guardar** (envía solo las decisiones
cambiadas; deshabilitado si no hay cambios; cuenta entre paréntesis), **Exportar PDF** (solo en vista Reporte).
Línea resumen: `n operaciones · n confirmadas · n sugeridas · n por revisar · n excluidas · Dif. neto $ ±x`.

**Vista Conciliar** — tabla `.hoja`, una fila por op (orden fecha desc), columnas:
`Fecha | Descripción (BINANCE) | Tipo (select COMPRA/VENTA/PAGO/EXCLUIR) | USDT | Banco (select con los bancos + '—') | Movimientos (botón "2 líneas · alta" / "elegir…" abre el selector) | Total Bs (editable) | Tasa pactada (editable; al editar recalcula Total Bs) | Tasa BCV (editable, auto) | Dif. Bs (calc) | Dif. $ (calc) | Estado (chip) | ✓ Confirmar`.
- Estados y colores: `CONFIRMADA` (verde suave), `SUGERIDA` (alta/media: normal, con chip "auto · alta"), `REVISAR`
  (baja/sin: fondo ámbar), `EXCLUIDA` (tachada, gris). Filtros: chips `Todas | Por revisar | Confirmadas | Excluidas` + buscador.
- Editar cualquier celda o elegir movimientos marca la fila `sucia`; **✓ Confirmar** fija `estado: CONFIRMADA`.
  Un botón "↺" en la fila vuelve a la sugerencia automática. Cambiar Tipo a EXCLUIR → estado EXCLUIDA.
- Selector de movimientos (modal `modal()` de ui.js): lista de candidatos del banco elegido (o todos) dentro de ±7 días,
  con checkbox, columnas Banco · Fecha · Nro · Descripción · Partida · Bs (debe/haber con signo) · $ al BCV · clase;
  filtro de texto y selector de días (3/7/15/30); suma en vivo de Bs marcados; botón **Aplicar** (fija refs y totalBs,
  recalcula tasa pactada). Los movimientos ya usados por otra fila se muestran atenuados con "usado en dd/mm".
- Debajo de la tabla, sección plegable **"Movimientos bancarios sin operación en BINANCE"** (`movimientosSinPareja`):
  tabla simple; cada fila tiene botón "Crear operación" que agrega una op manual (clave `MANUAL|fecha|...`, tipo según el
  lado, USDT = $ al BCV de la línea, refs = esa línea) para que no se pierda nada.
- Teclado como en tabla.js. En pantallas estrechas la tabla hace scroll horizontal (ya lo hace `.hoja-contenedor`).

**Vista Reporte** — pinta la estructura de `reporteDiferencialBancos` igual que `pantallas/reportes.js` pinta sus
reportes (KPIs en tarjeta resaltada + tablas). Extraer ese pintado a `pantallas/vista_reporte.js` → `export function vistaReporte(rep, extraKpi)`
y hacer que `pantallas/reportes.js` lo use (refactor mínimo, mismo HTML). Un interruptor "Solo confirmadas" (por defecto
apagado: incluye sugeridas alta/media). **Exportar PDF** usa `exportarPdf(rep)` de pdf.js sin cambios.

### 4.4 Persistencia y arranque
Al entrar: pinta lo que haya en `estado.bancos` (caché) y lanza `cargarBancos` + `cargarDecisionesBancos` en paralelo;
mientras tanto `cargando('Leyendo el libro de bancos…')` solo si no hay caché. Al terminar, `prepararOperaciones`,
`emparejar` (solo para ops sin decisión guardada) y pintar. Antes de salir de la pantalla con cambios sin guardar, `confirmar()`.
Los errores van por `manejarError`. Si el backend responde `bancos_sin_acceso`, mostrar un `div.vacio` explicando que la cuenta
del backend necesita acceso al libro.

### 4.5 CSS (`app/www/css/estilo.css`)
Añadir al final: `.hoja tr.revisar td`, `.hoja tr.confirmada td`, `.hoja tr.excluida td`, chips de estado `.estado-chip.alta/.media/.baja/.sin/.ok/.ex`,
`.selector-mov` (modal ancho: `max-width: min(96vw, 980px)`), fila atenuada `.usado`. Colores con las variables existentes.

### 4.6 Prueba de interfaz (`app/pruebas/prueba_ui.js`)
Después del bloque de la tabla (captura 24): ir a Reportes → clic "Diferencial desde bancos" → esperar a que
desaparezca "Leyendo" → foto `25-diferencial` → clic en el primer "✓" visible → foto `26-diferencial-confirmada` →
"Guardar" → esperar texto "guardada" → vista "Reporte" → foto `27-diferencial-reporte` → "Exportar a PDF" → esperar "PDF"
→ comprobar que existe un archivo `USDT-diferencial-bancos-*.pdf` en capturas. Mantener lo demás igual.

## 5. Versión y documentación
- `node herramientas/nueva_version.js 1.6.0` (lo hace el gerente al final). README: sección "4.2 Diferencial desde bancos (desde v1.6)".
- Deploy del backend: `clasp push -f` + `clasp redeploy AKfycbw4wf3QeTbotVv052q5Pa1PFZlxmGtjFSH5ksz4UtMiseL64hlxNdChAr6TOMeY0qRB7g -d "v1.6.0 bancos"` (gerente).

## 6. AMPLIACIÓN (obligatoria): categorías de diferencial — USDT, Efectivo $, Materia prima/clientes, Otros

El usuario pide que el reporte cubra TODO el diferencial cambiario del libro de bancos, por categoría y en conjunto.
Regla de oro: la información sale SIEMPRE de las hojas de banco; la pestaña "R. Partidas" se actualiza a mano y NO se usa.

### 6.1 Hechos observados en los bancos (muestra real)
Cada línea con partida `DIFERENCIAL CAMBIARIO` tiene una **línea principal** en la misma hoja: misma `Nro` (si no está vacío),
o una fila vecina (±4) con la misma fecha y el mismo lado (DEBE/HABER) que no sea DIFERENCIAL. La partida de la principal
dice la categoría:
- `BINANCE` → **usdt** (compra/venta de USDT).
- `EFECTIVO DOLARES` → **efectivo** (compra de dólares en efectivo a empleados/terceros: "EMPLEADO A COMPRA 200",
  "EMPLEADO B COMPRA DIVISAS"; también ventas: "EMPLEADO A VENTA 450" en DEBE).
- `COSTO DE MATERIA PRIMA`, `COMPRAS`, `INVENTARIO...`, o partidas que contengan `MATERIA` → **materia** tipo COMPRA
  (proveedores pagados a tasa pactada: VENPACK, MASOPAO, PEDRO PERDOMO MIEL, JUAN VAN HEEL, SUP FON, GRUPO ARTES GRAFICAS).
  `CUENTAS POR COBRAR COMERCIALES`, `VENTAS...`, `ANTICIPO CLIENTES` → **materia** tipo VENTA (cobros de clientes:
  "euromercado pago fact", "DAFU BEJUMA FACT", "REDVITAL FACT").
- Cualquier otra partida (SUELDOS Y SALARIOS, VIATICOS, MTO Y REPARACION..., ACTIVOS FIJOS, SOCIOS, IMPUESTOS, etc.) → **otros**.
- OJO: la descripción de la línea DIFERENCIAL muchas veces NO coincide con la principal (dice el nombre del empleado que
  vendió los dólares: "EMPLEADO B DIFERENCIAL EN TASA" junto a "MASOPAO FACT 4151"). Emparejar por Nro y vecindad, no por texto.
- La hoja **`Efectivo $`** tiene la MISMA estructura que BINANCE (cuenta de activo en $, tasa 1): DEBE = $ que entran
  (compra de efectivo, partida = banco que pagó), HABER = $ que salen. Sirve de ancla para la categoría efectivo igual
  que BINANCE para usdt.

### 6.2 Backend (cambios sobre §2)
- `CONFIG.BANCOS.HOJAS_ACTIVO = ['BINANCE', 'Efectivo $']` (se usan las que existan; `HOJA_USDT` queda como alias de la
  primera). Respuesta: `activos: { 'BINANCE': [filas...], 'Efectivo $': [filas...] }` con el MISMO formato que `usdt`
  (`ref`, `fila`, `fecha`, `fechaTexto`, `descripcion`, `concepto`, `tipo`, `partida`, `entrada`, `salida`, `saldo`) y
  `usdt` se mantiene = `activos['BINANCE']` por compatibilidad. `hojasActivo: ['BINANCE', 'Efectivo $']`.
- `movimientos` (dentro del rango ± margen) ahora incluye: (a) toda línea con partida que contenga `DIFERENCIAL`
  (clase `DIFERENCIAL`); (b) partida `BINANCE` (clase `BINANCE`); (c) partida `EFECTIVO DOLARES`/`EFECTIVO $` (clase `EFECTIVO`);
  (d) descripción/concepto con USDT/USTD/BINANCE (clase `OTRO`); (e) **líneas principales candidatas**: cualquier línea que
  comparta `Nro` no vacío con una línea DIFERENCIAL de la misma hoja, o que esté a ±4 filas de una línea DIFERENCIAL con
  la misma fecha (clase `VECINA`). Cada línea se envía una sola vez con la clase de mayor prioridad
  (BINANCE > EFECTIVO > DIFERENCIAL > OTRO > VECINA). Se añade `nroNorm` (Nro como texto sin espacios).
- Decisiones: columna nueva `CATEGORIA` después de `TIPO` (valores `usdt|efectivo|materia|otros`); el objeto decisión
  lleva `categoria`.

### 6.3 Conciliación (cambios sobre §3)
- `prepararOperaciones(respuesta)` devuelve ops de TODAS las categorías, cada una con `categoria`:
  - Por cada hoja de activo (`activos`): ops como en §3.1 con `categoria: 'usdt'` (BINANCE) o `'efectivo'` (Efectivo $).
    Para efectivo, `bancoSugerido` sale igual de `partida` (BANCO MERCANTIL, BANCO PROVINCIAL...). Clave con prefijo
    de hoja: `'BINANCE|' + ...` / `'Efectivo $|' + ...` (la clave antigua sin prefijo se acepta como BINANCE al leer decisiones).
  - **Ops derivadas de líneas DIFERENCIAL** (`derivarDeDiferenciales(movimientos, usadas)`): por cada línea clase DIFERENCIAL
    de cualquier banco que NO haya quedado usada por una op de activo, buscar su principal (mismo `nroNorm` no vacío en la
    misma hoja, de clase ≠ DIFERENCIAL; si no, la vecina más cercana por fila con misma fecha y mismo lado). Crear op
    `{ clave: 'DIF|' + banco + '|' + fecha + '|' + bs.toFixed(2) + '|#n', categoria (según partida de la principal, §6.1;
    'otros' si no hay principal), tipo: lado HABER → COMPRA, DEBE → VENTA, usdt: $ de la principal al BCV (principalBs / tasa
    de la línea, o `debeUsd|haberUsd`), descripcion: principal.descripcion + ' · ' + dif.descripcion, banco, refs sugeridas
    [principal, dif], totalBs = principalBs + difBs, fechaa = fecha de la principal }`. Si no hay principal: op con usdt 0,
    totalBs = difBs, confianza `sin`, estado REVISAR (el usuario puede escribir el monto $ a mano).
    IMPORTANTE: ejecutar primero el emparejado de los activos (usdt, efectivo) y luego derivar, para que una misma línea
    DIFERENCIAL no cuente dos veces.
- `emparejar` recibe ops de activo de ambas hojas; el lado/clase principal para efectivo es `EFECTIVO`.
- `calcularFila` no cambia (misma convención de signos). Para ops derivadas con `usdt` = 0 (sin principal) → `difBs` = ±difBs
  de la línea según lado (HABER negativo, DEBE positivo), `difUsd = difBs / tasaBcv`, tasa pactada 0.
- `reporteDiferencialBancos(filas, desde, hasta, opciones)` con `opciones.categoria` = `'usdt'|'efectivo'|'materia'|'otros'|'todas'`:
  - Categoría concreta: título "Diferencial cambiario · USDT (Binance)" / "· Efectivo $" / "· Materia prima y clientes" / "· Otros pagos",
    `tipo: 'diferencial-' + categoria`, mismas secciones de §3.5.
  - `'todas'`: título "Diferencial cambiario · todas las categorías", `tipo: 'diferencial-todas'`, KPIs: neto $ total y uno por
    categoría; secciones: **Resumen por categoría** (Categoría, Operaciones, $ al BCV, Bs, Dif. $, Dif. Bs, % sobre BCV),
    **Resumen por mes y categoría** (Mes, USDT $, Efectivo $, Materia prima $, Otros $, Total $), **Detalle por operación**
    (con columna Categoría), **Por revisar**.
  - Etiquetas en pantalla: `CATEGORIAS = [['usdt','USDT (Binance)'], ['efectivo','Efectivo $'], ['materia','Materia prima y clientes'], ['otros','Otros pagos']]`
    exportada desde conciliacion.js.
- Prueba: añadir aserciones: una compra de efectivo (p. ej. "EMPLEADO A COMPRA" en MERCANTIL o BBVA) queda en
  categoría `efectivo` con principal EFECTIVO DOLARES; "VENPACK BOLSAS" en VENEZUELA queda en `materia`; la suma de
  `difBs` de todas las categorías en un mes es cercana (±5 %) a la suma de las líneas DIFERENCIAL de ese mes en los bancos;
  el reporte `'todas'` tiene las 4 secciones.

### 6.4 Interfaz (cambios sobre §4)
- Fila de chips **Categoría** encima de la tabla y del reporte: `Todas | USDT (Binance) | Efectivo $ | Materia prima y clientes | Otros pagos`
  (con contador por categoría). Filtra la tabla; en la vista Reporte elige el reporte (separado por categoría o "Todas" = juntos).
- Columna nueva **Categoría** (select) en la tabla, editable: el usuario puede reclasificar; se guarda en la decisión.
- El resumen de la barra superior muestra el neto $ de la categoría visible.
- Nombre del PDF: lo da `rep.tipo` (ya lo hace pdf.js).
- Ayuda nueva `categoriasDiferencial` explicando las cuatro categorías con ejemplos.
