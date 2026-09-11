# USDT CPA — Control de compra y venta de USDT

Aplicación para registrar las compras y ventas de USDT (Binance P2P, par USDT/VES) de las carteras
**CPA BEJUMA** y **PANAMERICANA**, con la tasa oficial del BCV y la tasa P2P del momento, calculando
en cada operación el **diferencial a favor / en contra** frente al BCV y frente al mercado P2P, más
comisiones y observaciones.

- **Base de datos:** Google Sheets, libro *Control De Compra Venta USDT Cpa Bejuma*, pestañas `BD_USDT`,
  `TASAS` y `PANEL_USDT` (protegidas: solo el propietario y las cuentas del sistema pueden editar).
- **Backend:** Google Apps Script vinculado al libro, publicado como aplicación web (vive en la nube de Google).
- **Frontend:** una sola interfaz web (HTML/CSS/JS sin framework) empaquetada como **.exe** (Electron) y
  como **.apk** (Capacitor). Ambas leen y escriben en la hoja a través del backend.

```
Compra Venta USDT/
├── backend/            Apps Script (Config, Seguridad, Tasas, Operaciones, Api)  -> clasp push
├── app/
│   ├── src/            código fuente de la interfaz (módulos ES, comentado en español)
│   ├── www/            lo que se empaqueta: index.html, config.js, css/, img/, js/app.js (generado)
│   ├── electron/       proceso principal + preload para el .exe
│   ├── android/        proyecto Android generado por Capacitor
│   ├── recursos/       logo e íconos (generados por herramientas/generar_logo.py)
│   ├── pruebas/        prueba automatizada de interfaz (Electron) y capturas
│   └── dist/           ejecutables compilados (windows/, android/)
├── herramientas/
│   ├── configurar_hoja.py     crea/formatea/protege las pestañas del libro (cuenta de servicio)
│   ├── generar_logo.py        genera logo, .ico y recursos Android
│   └── simulador_backend.js   emula Apps Script en Node para probar sin publicar
└── .github/workflows/compilar.yml   compila .exe y .apk en GitHub Actions (alternativa a la PC)
```

---

## 1. Cómo funciona (visión de negocio)

| Concepto | Cálculo | Signo |
|---|---|---|
| Total VES | monto USDT × tasa de la operación | |
| USDT neto | compra: monto − comisión USDT · venta: monto + comisión USDT | |
| VES neto | compra: total + comisión VES · venta: total − comisión VES | |
| Tasa efectiva | VES neto ÷ USDT neto | |
| Diferencial vs BCV | compra: (BCV − tasa) × monto · venta: (tasa − BCV) × monto | **+ a favor, − en contra** |
| Diferencial vs P2P | compra: (P2P − tasa) × monto · venta: (tasa − P2P) × monto | **+ a favor, − en contra** |
| Equivalente USD BCV | VES neto ÷ BCV (para la contabilidad en dólares oficiales) | |
| Costo promedio | promedio ponderado de las compras vigentes (VES/USDT) | |
| Resultado realizado | (tasa efectiva de venta − costo promedio) × USDT vendidos | |

**Tasa P2P sugerida:** promedio de los 5 mejores anuncios de Binance del lado correcto (vendedores si
compras, compradores si vendes) de anunciantes serios (≥ 50 órdenes al mes y ≥ 95 % de finalización) y
cuyos límites admiten el monto en bolívares. Siempre se puede cambiar a mano; los chips *Mejor*, *Sugerida*,
*Mediana* y *Ver anuncios* muestran las alternativas.

**Tasa BCV:** se lee de www.bcv.org.ve (fecha valor incluida); si la página falla se usa ve.dolarapi.com.

**Histórico:** el backend guarda una fila en `TASAS` cada 30 minutos (BCV, P2P compra/venta mejor y
promedio, brecha). La app muestra la tendencia y `PANEL_USDT` resume la cartera con fórmulas.

**Reportes (pestaña Reportes):** por rango de fechas (este mes, mes anterior, 30 días, trimestre, año, todo
o fechas libres) y por cartera (CPA Bejuma, Panamericana o ambas):

| Reporte | Contenido |
|---|---|
| Utilidades | resultado realizado en ventas (contra costo promedio, neto de comisiones), diferenciales, comisiones, saldo inicial/final, desglose mensual y detalle de cada venta |
| Diferenciales | diferencial vs BCV y vs P2P por mes y por operación, brecha promedio |
| Compras | detalle y totales de compras del período (USDT, Bs, tasa promedio, comisiones, contraparte, método) |
| Ventas | idem para ventas |

Cada uno se exporta a **PDF** con membrete (logo, empresa, período, fecha de generación): en Windows abre
"Guardar como" y luego el archivo; en Android abre el menú *Compartir* (WhatsApp, correo, Drive…).

---

## 2. Seguridad (capas)

1. **Clave de enlace** (`API_KEY`): secreto largo generado por el backend; se escribe una vez por dispositivo.
2. **PIN de 6 dígitos**: deriva con PBKDF2 (300.000 iteraciones) la llave AES-256-GCM con la que se cifra
   *todo* lo local (clave de enlace, sesión, copia de operaciones). Sin PIN los datos del dispositivo son ilegibles.
   Tras 3 fallos impone esperas crecientes; "Olvidé mi PIN" solo permite desvincular.
3. **Huella dactilar (Android)**: la llave se guarda en el Keystore del teléfono y se libera al validar la biometría.
4. **Cloudflare Turnstile**: desafío anti-bot al abrir sesión; el backend lo verifica contra Cloudflare.
5. **Token de sesión** firmado (HMAC-SHA256) con vencimiento de 12 h; todas las acciones de datos lo exigen.
6. **Anti fuerza bruta** en el backend (10 fallos → 15 min de bloqueo) y **bloqueo por inactividad** en la app (5 min).
7. Electron: aislamiento de contexto, sandbox, sin Node en la página, CSP estricta, solo HTTPS al backend.
8. Las filas **nunca se borran**: anular marca `ESTADO = ANULADA` con motivo, dispositivo y fecha.

---

## 3. Pasos manuales que faltan (solo tú puedes hacerlos)

### 3.1 Autorizar el backend en Google (obligatorio, una sola vez)
El código ya está subido y publicado, pero Google exige que la cuenta que lo publica
(**analisisventascpapanamericana@gmail.com**, la que tiene clasp iniciado) apruebe los permisos:

1. Abre el editor: <https://script.google.com/d/120kvS0ePZAOCLrx-UN9MRwVDBYqE_VNsHPQsH9EobGod1Uec7naSH6cH/edit>
   (también desde el libro: *Extensiones ▸ Apps Script*).
2. En el desplegable de funciones elige **`configuracionInicial`** y pulsa ▶ **Ejecutar**.
3. Acepta los permisos (*Avanzado ▸ Ir a USDT CPA Backend*). Se piden: hojas de cálculo, conexiones externas
   (BCV, Binance, Cloudflare) y disparadores.
4. En *Registro de ejecución* aparece la **CLAVE DE ENLACE**. Guárdala: es la que se escribe en cada dispositivo.
5. Opcional: ejecuta `probarTasas` para ver en el registro la tasa BCV y los anuncios P2P leídos.

URL del backend (ya está en `app/www/config.js`):
`https://script.google.com/macros/s/AKfycbw4wf3QeTbotVv052q5Pa1PFZlxmGtjFSH5ksz4UtMiseL64hlxNdChAr6TOMeY0qRB7g/exec`

### 3.2 Cloudflare Turnstile (anti-bot)
La app no vive en una página web, pero el desafío se muestra dentro de la propia app (Electron y el WebView
de Android), y ambas cargan la interfaz desde el origen **`localhost`**. Por eso:

1. En el panel de Cloudflare ▸ Turnstile ▸ *Add widget*: nombre "USDT CPA", **hostname: `localhost`**
   (Cloudflare lo acepta expresamente para apps locales/de desarrollo). Modo *Managed*.
2. Copia la **Site Key** en `app/www/config.js` → `TURNSTILE_SITEKEY` y vuelve a compilar (.exe y .apk).
3. Copia la **Secret Key** al backend (la Site Key ya está en `config.js`): en el editor de Apps Script,
   *Configuración del proyecto ▸ Propiedades del script ▸ Añadir propiedad*:
   `TURNSTILE_SECRET` = la secret key, `TURNSTILE_HOSTNAMES` = `localhost`. (Equivale a ejecutar
   `establecerTurnstile('SECRET', 'localhost')` desde una función temporal.)
4. Mientras la sitekey esté vacía y el secreto no exista, la app y el backend funcionan sin el desafío
   (útil para probar primero la conexión).

### 3.3 Instalar en los dispositivos
- **Windows:** `app/dist/windows/USDT-CPA-portable.exe` (no requiere instalación) o el instalador
  `USDT-CPA-1.1.0-x64.exe`. Windows SmartScreen puede avisar porque el ejecutable no está firmado con
  certificado: *Más información ▸ Ejecutar de todas formas*.
- **Android:** `app/dist/android/USDT-CPA-1.1.0.apk`. Copia el archivo al teléfono, ábrelo y permite
  "instalar apps de origen desconocido". Está firmado con la clave `C:\devtools\claves\usdt-cpa-release.jks`
  (contraseña en `app/android/keystore.properties`): **guarda copia de ambos**; sin esa clave no se podrán
  instalar actualizaciones sobre la app ya instalada.
- Primer arranque: pegar la clave de enlace, nombrar el dispositivo, crear el PIN y (en el teléfono) activar la huella.

---

## 4. Compilar de nuevo (tras cambiar algo)

Requisitos ya instalados en esta PC: Node 25, JDK 21 (`C:\devtools\jdk`), SDK Android (`C:\devtools\android-sdk`).

```powershell
cd "C:\repositorios\Compra Venta USDT\app"
$env:JAVA_HOME = "C:\devtools\jdk\jdk-21.0.12.1+1"; $env:ANDROID_HOME = "C:\devtools\android-sdk"
$env:ELECTRON_RUN_AS_NODE = ""            # necesario si se ejecuta desde VS Code

npm run construir:web        # empaqueta src/ -> www/js/app.js
npm run escritorio           # prueba el .exe sin empaquetar
npm run compilar:exe         # -> app/dist/windows/
npm run compilar:apk         # -> app/android/app/build/outputs/apk/release/app-release.apk
```

Backend: edita `backend/*.js` y luego `clasp push -f` seguido de
`clasp redeploy AKfycbw4wf3QeTbotVv052q5Pa1PFZlxmGtjFSH5ksz4UtMiseL64hlxNdChAr6TOMeY0qRB7g -d "vX"`
(la URL no cambia).

Pruebas locales sin tocar Google: `node herramientas/simulador_backend.js` (clave `CLAVE-DE-PRUEBA-LOCAL-1234`)
y `cd app; npx electron pruebas/prueba_ui.js` (recorre toda la app y deja capturas en `app/pruebas/capturas`).
También `cd app; npx electron pruebas/lanzar_real.js 1` y luego `... 2` arranca la app **real** de Electron (electron/main.js)
con un perfil temporal contra el simulador: la fase 1 enlaza y crea el PIN, la fase 2 reabre y desbloquea con PIN, provoca
un error simulado y comprueba que aparece en Ajustes ▸ Diagnóstico.

**Si una pantalla queda vacía o falla algo:** la app muestra un aviso rojo y guarda el error; en Ajustes ▸ Diagnóstico está
la lista con botón *Copiar diagnóstico* (versión, plataforma y errores, sin PIN ni clave) para pegarla en el chat de soporte.

Alternativa sin instalar nada: subir el repositorio a GitHub; el workflow `compilar.yml` genera el .exe y el
.apk como *artifacts* (para firmar el APK en la nube hay que cargar el keystore como secreto, ver el archivo).

---

## 5. Flujo de versiones (actualizaciones automáticas)

Las versiones se publican en **GitHub Releases** del repositorio configurado en `app/www/config.js`
(`ACTUALIZACIONES: { propietario: 'AlexMielno', repositorio: 'usdt-cpa' }`) y en `app/package.json` (`build.publish`).

- **Windows instalado (instalador NSIS):** `electron-updater` comprueba al arrancar, descarga la nueva
  versión en segundo plano y la instala al cerrar/reiniciar la app (muestra aviso en Inicio y Ajustes).
- **Windows portable y Android:** la app consulta la última release; si es más nueva muestra el aviso
  "Nueva versión disponible" con botón **Descargar** (abre el .exe/.apk). En Android se instala encima de la
  actual (misma firma → conserva PIN y datos). Además hay un botón *Buscar actualizaciones* en Ajustes.

Cómo publicar una versión (una vez creado el repositorio en GitHub, público para que las apps puedan
descargar las releases sin token):

```powershell
cd "C:
epositorios\Compra Venta USDT"
git init; git add .; git commit -m "USDT CPA"          # solo la primera vez
gh repo create usdt-cpa --public --source . --push     # solo la primera vez (crea AlexMielno/usdt-cpa)
# secretos para firmar el APK en la nube (una vez): ANDROID_KEYSTORE_B64, ANDROID_KEYSTORE_PASS, ANDROID_KEY_ALIAS, ANDROID_KEY_PASS
node herramientas/nueva_version.js 1.2.0               # sube la versión en package.json, config.js y Android
git commit -am "v1.2.0"; git tag v1.2.0; git push; git push --tags
```

El workflow `.github/workflows/publicar.yml` compila el .exe (portable + instalador + `latest.yml`) y el
.apk y los adjunta a la release `v1.2.0`. Los dispositivos la detectan en el siguiente arranque.
Si prefieres no usar GitHub, basta con pasar el nuevo .exe/.apk a mano: la instalación conserva los datos.

## 6. Estructura de `BD_USDT`

`ID · FECHA · HORA · CARTERA · TIPO · MONTO USDT · TASA (VES/USDT) · TOTAL VES · COMISION USDT · COMISION VES ·
USDT NETO · VES NETO · TASA EFECTIVA · TASA BCV · TASA P2P REF · DIF BCV VES (+ A FAVOR) · DIF BCV % ·
DIF P2P VES (+ A FAVOR) · EQUIV USD BCV · CONTRAPARTE · METODO PAGO · REFERENCIA · OBSERVACIONES · ESTADO ·
DISPOSITIVO · REGISTRADO · MOTIVO ANULACION`

Compras en verde, ventas en rojo, anuladas tachadas. `herramientas/configurar_hoja.py` vuelve a aplicar
formatos y protecciones si alguien los cambia (no borra datos).
