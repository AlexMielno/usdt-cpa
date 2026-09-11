# -*- coding: utf-8 -*-
"""
Configura la estructura del libro de Google Sheets que sirve de base de datos.

- Pestaña BD_USDT    : una fila por operación (compra o venta de USDT).
- Pestaña TASAS      : histórico de tasas (BCV y Binance P2P) capturado por el backend cada 30 min.
- Pestaña PANEL_USDT : resumen con fórmulas para ver la cartera desde el propio Google Sheets.

Se ejecuta UNA sola vez con la cuenta de servicio (claude-bot). Es idempotente: si ya existe
la estructura no la duplica, solo vuelve a aplicar formatos y protecciones.
"""
import gspread
from gspread.utils import rowcol_to_a1

CREDENCIALES = r"C:\repositorios\flujo-caja\credenciales-google.json"
LIBRO_ID = "1HR_0qXnZN-i7tw4fSAOqjUc_ZQornHsNG3eM6PasVBc"

# Cuentas que SÍ pueden editar las pestañas protegidas (el resto solo lectura)
EDITORES = [
    "mileno2533@gmail.com",                                        # propietario del libro
    "analisisventascpapanamericana@gmail.com",                    # cuenta que ejecuta el backend (Apps Script)
    "claude-bot@abiding-ion-462518-s5.iam.gserviceaccount.com",   # bot de mantenimiento
]

# ---- Definición de columnas de BD_USDT --------------------------------------------------
# (nombre, ancho px, formato numérico o None)
COLUMNAS_BD = [
    ("ID", 110, None),
    ("FECHA", 95, "dd/mm/yyyy"),
    ("HORA", 70, "hh:mm"),
    ("CARTERA", 120, None),
    ("TIPO", 80, None),
    ("MONTO USDT", 105, "#,##0.00"),
    ("TASA (VES/USDT)", 115, "#,##0.0000"),
    ("TOTAL VES", 120, "#,##0.00"),
    ("COMISION USDT", 105, "#,##0.0000"),
    ("COMISION VES", 105, "#,##0.00"),
    ("USDT NETO", 100, "#,##0.0000"),
    ("VES NETO", 120, "#,##0.00"),
    ("TASA EFECTIVA", 110, "#,##0.0000"),
    ("TASA BCV", 100, "#,##0.0000"),
    ("TASA P2P REF", 105, "#,##0.0000"),
    ("DIF BCV VES (+ A FAVOR)", 140, "#,##0.00"),
    ("DIF BCV %", 85, "0.00%"),
    ("DIF P2P VES (+ A FAVOR)", 140, "#,##0.00"),
    ("EQUIV USD BCV", 105, "#,##0.00"),
    ("CONTRAPARTE", 150, None),
    ("METODO PAGO", 120, None),
    ("REFERENCIA", 120, None),
    ("OBSERVACIONES", 260, None),
    ("ESTADO", 90, None),
    ("DISPOSITIVO", 120, None),
    ("REGISTRADO", 140, "dd/mm/yyyy hh:mm:ss"),
    ("MOTIVO ANULACION", 200, None),
]

COLUMNAS_TASAS = [
    ("FECHA HORA", 140, "dd/mm/yyyy hh:mm"),
    ("BCV", 100, "#,##0.0000"),
    ("BCV FECHA VALOR", 110, "dd/mm/yyyy"),
    ("P2P COMPRA MEJOR", 120, "#,##0.0000"),
    ("P2P COMPRA PROM5", 120, "#,##0.0000"),
    ("P2P VENTA MEJOR", 120, "#,##0.0000"),
    ("P2P VENTA PROM5", 120, "#,##0.0000"),
    ("BRECHA P2P/BCV %", 120, "0.00%"),
    ("FUENTE BCV", 110, None),
]

COLOR_CABECERA = {"red": 0.07, "green": 0.08, "blue": 0.11}      # gris casi negro (estilo Binance)
COLOR_TEXTO_CAB = {"red": 0.94, "green": 0.73, "blue": 0.04}     # amarillo Binance


def obtener_o_crear(libro, titulo, filas=1000, cols=26):
    try:
        return libro.worksheet(titulo)
    except gspread.WorksheetNotFound:
        return libro.add_worksheet(title=titulo, rows=filas, cols=cols)


def peticion_formato_cabecera(sheet_id, ncols):
    return {
        "repeatCell": {
            "range": {"sheetId": sheet_id, "startRowIndex": 0, "endRowIndex": 1, "startColumnIndex": 0, "endColumnIndex": ncols},
            "cell": {"userEnteredFormat": {
                "backgroundColor": COLOR_CABECERA,
                "horizontalAlignment": "CENTER", "verticalAlignment": "MIDDLE", "wrapStrategy": "WRAP",
                "textFormat": {"bold": True, "foregroundColor": COLOR_TEXTO_CAB, "fontSize": 9},
            }},
            "fields": "userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)",
        }
    }


def peticiones_columnas(sheet_id, columnas, filas):
    reqs = []
    for i, (_, ancho, formato) in enumerate(columnas):
        reqs.append({"updateDimensionProperties": {
            "range": {"sheetId": sheet_id, "dimension": "COLUMNS", "startIndex": i, "endIndex": i + 1},
            "properties": {"pixelSize": ancho}, "fields": "pixelSize"}})
        if formato:
            if "%" in formato:
                tipo = "PERCENT"
            elif "hh" in formato:
                tipo = "DATE_TIME" if "yyyy" in formato else "TIME"
            elif "yyyy" in formato:
                tipo = "DATE"
            else:
                tipo = "NUMBER"
            reqs.append({"repeatCell": {
                "range": {"sheetId": sheet_id, "startRowIndex": 1, "endRowIndex": filas, "startColumnIndex": i, "endColumnIndex": i + 1},
                "cell": {"userEnteredFormat": {"numberFormat": {"type": tipo, "pattern": formato}}},
                "fields": "userEnteredFormat.numberFormat"}})
    return reqs


def peticion_validacion(sheet_id, col_idx, valores, fila_ini, fila_fin):
    return {"setDataValidation": {
        "range": {"sheetId": sheet_id, "startRowIndex": fila_ini, "endRowIndex": fila_fin, "startColumnIndex": col_idx, "endColumnIndex": col_idx + 1},
        "rule": {"condition": {"type": "ONE_OF_LIST", "values": [{"userEnteredValue": v} for v in valores]},
                 "strict": True, "showCustomUi": True}}}


def peticion_proteccion(sheet_id, descripcion, existentes):
    """Protege TODA la pestaña: solo EDITORES pueden escribir. Si ya existe la protección la actualiza."""
    for p in existentes:
        if p.get("description") == descripcion:
            return {"updateProtectedRange": {
                "protectedRange": {"protectedRangeId": p["protectedRangeId"], "editors": {"users": EDITORES}},
                "fields": "editors"}}
    return {"addProtectedRange": {"protectedRange": {
        "range": {"sheetId": sheet_id}, "description": descripcion, "warningOnly": False,
        "editors": {"users": EDITORES}}}}


def celda_formato(sheet_id, r0, r1, c0, c1, formato, fields):
    return {"repeatCell": {"range": {"sheetId": sheet_id, "startRowIndex": r0, "endRowIndex": r1, "startColumnIndex": c0, "endColumnIndex": c1},
                           "cell": {"userEnteredFormat": formato}, "fields": fields}}


def main():
    gc = gspread.service_account(filename=CREDENCIALES)
    libro = gc.open_by_key(LIBRO_ID)
    meta = libro.fetch_sheet_metadata()
    protecciones = {s["properties"]["sheetId"]: s.get("protectedRanges", []) for s in meta["sheets"]}

    reqs = []

    # ---------------- BD_USDT ----------------
    bd = obtener_o_crear(libro, "BD_USDT", 2000, len(COLUMNAS_BD))
    if bd.col_count < len(COLUMNAS_BD):
        bd.resize(cols=len(COLUMNAS_BD))
    if bd.row_count < 2000:
        bd.resize(rows=2000)
    bd.update(range_name="A1", values=[[c[0] for c in COLUMNAS_BD]])
    reqs.append(peticion_formato_cabecera(bd.id, len(COLUMNAS_BD)))
    reqs += peticiones_columnas(bd.id, COLUMNAS_BD, 2000)
    reqs.append({"updateSheetProperties": {"properties": {"sheetId": bd.id, "gridProperties": {"frozenRowCount": 1, "frozenColumnCount": 2}},
                                           "fields": "gridProperties.frozenRowCount,gridProperties.frozenColumnCount"}})
    reqs.append({"updateDimensionProperties": {"range": {"sheetId": bd.id, "dimension": "ROWS", "startIndex": 0, "endIndex": 1},
                                               "properties": {"pixelSize": 40}, "fields": "pixelSize"}})
    nombres = [c[0] for c in COLUMNAS_BD]
    reqs.append(peticion_validacion(bd.id, nombres.index("CARTERA"), ["CPA BEJUMA", "PANAMERICANA"], 1, 2000))
    reqs.append(peticion_validacion(bd.id, nombres.index("TIPO"), ["COMPRA", "VENTA"], 1, 2000))
    reqs.append(peticion_validacion(bd.id, nombres.index("ESTADO"), ["ACTIVA", "ANULADA"], 1, 2000))

    # Formato condicional: anuladas tachadas en gris; compras verde suave; ventas rojo suave
    col_tipo = rowcol_to_a1(1, nombres.index("TIPO") + 1).rstrip("1")
    col_estado = rowcol_to_a1(1, nombres.index("ESTADO") + 1).rstrip("1")
    rango_datos = {"sheetId": bd.id, "startRowIndex": 1, "endRowIndex": 2000, "startColumnIndex": 0, "endColumnIndex": len(COLUMNAS_BD)}
    reglas = [
        ('=$' + col_estado + '2="ANULADA"', {"textFormat": {"strikethrough": True, "foregroundColor": {"red": 0.6, "green": 0.6, "blue": 0.6}}}),
        ('=$' + col_tipo + '2="COMPRA"', {"backgroundColor": {"red": 0.90, "green": 0.98, "blue": 0.93}}),
        ('=$' + col_tipo + '2="VENTA"', {"backgroundColor": {"red": 1.0, "green": 0.93, "blue": 0.92}}),
    ]
    # Borrar reglas previas de la pestaña para no acumularlas al re-ejecutar
    n_reglas = len(next(s for s in meta["sheets"] if s["properties"]["sheetId"] == bd.id).get("conditionalFormats", []))
    for _ in range(n_reglas):
        reqs.append({"deleteConditionalFormatRule": {"sheetId": bd.id, "index": 0}})
    for idx, (formula, formato) in enumerate(reglas):
        reqs.append({"addConditionalFormatRule": {"index": idx, "rule": {"ranges": [rango_datos],
                     "booleanRule": {"condition": {"type": "CUSTOM_FORMULA", "values": [{"userEnteredValue": formula}]}, "format": formato}}}})
    reqs.append(peticion_proteccion(bd.id, "Solo la app registra operaciones (BD_USDT)", protecciones.get(bd.id, [])))

    # ---------------- TASAS ----------------
    tasas = obtener_o_crear(libro, "TASAS", 20000, len(COLUMNAS_TASAS))
    tasas.update(range_name="A1", values=[[c[0] for c in COLUMNAS_TASAS]])
    reqs.append(peticion_formato_cabecera(tasas.id, len(COLUMNAS_TASAS)))
    reqs += peticiones_columnas(tasas.id, COLUMNAS_TASAS, 20000)
    reqs.append({"updateSheetProperties": {"properties": {"sheetId": tasas.id, "gridProperties": {"frozenRowCount": 1}}, "fields": "gridProperties.frozenRowCount"}})
    reqs.append(peticion_proteccion(tasas.id, "Solo el backend captura tasas (TASAS)", protecciones.get(tasas.id, [])))

    # ---------------- PANEL_USDT (fórmulas) ----------------
    panel = obtener_o_crear(libro, "PANEL_USDT", 60, 8)
    L = {n: rowcol_to_a1(1, i + 1).rstrip("1") for i, n in enumerate(nombres)}   # nombre de columna -> letra

    def sumar(col, tipo):
        return ("=SUMIFS(BD_USDT!{c}:{c},BD_USDT!{e}:{e},\"ACTIVA\",BD_USDT!{t}:{t},\"{tipo}\",BD_USDT!{k}:{k},$B$3)"
                .format(c=L[col], e=L["ESTADO"], t=L["TIPO"], k=L["CARTERA"], tipo=tipo))

    def contar(tipo):
        return ("=COUNTIFS(BD_USDT!{e}:{e},\"ACTIVA\",BD_USDT!{t}:{t},\"{tipo}\",BD_USDT!{k}:{k},$B$3)"
                .format(e=L["ESTADO"], t=L["TIPO"], k=L["CARTERA"], tipo=tipo))

    filas = [
        ["PANEL CARTERA USDT", "", "", ""],
        ["Se alimenta de BD_USDT (solo operaciones ACTIVAS). Cambia la cartera en B3.", "", "", ""],
        ["Cartera:", "CPA BEJUMA", "", ""],
        ["", "", "", ""],
        ["CONCEPTO", "COMPRAS", "VENTAS", "NETO / SALDO"],
        ["USDT (bruto)", sumar("MONTO USDT", "COMPRA"), sumar("MONTO USDT", "VENTA"), "=B6-C6"],
        ["USDT neto (con comisiones)", sumar("USDT NETO", "COMPRA"), sumar("USDT NETO", "VENTA"), "=B7-C7"],
        ["VES neto movido", sumar("VES NETO", "COMPRA"), sumar("VES NETO", "VENTA"), "=C8-B8"],
        ["Comisiones USDT", sumar("COMISION USDT", "COMPRA"), sumar("COMISION USDT", "VENTA"), "=B9+C9"],
        ["Comisiones VES", sumar("COMISION VES", "COMPRA"), sumar("COMISION VES", "VENTA"), "=B10+C10"],
        ["Diferencial vs BCV (VES, + a favor)", sumar("DIF BCV VES (+ A FAVOR)", "COMPRA"), sumar("DIF BCV VES (+ A FAVOR)", "VENTA"), "=B11+C11"],
        ["Diferencial vs P2P (VES, + a favor)", sumar("DIF P2P VES (+ A FAVOR)", "COMPRA"), sumar("DIF P2P VES (+ A FAVOR)", "VENTA"), "=B12+C12"],
        ["Equivalente USD al BCV", sumar("EQUIV USD BCV", "COMPRA"), sumar("EQUIV USD BCV", "VENTA"), "=C13-B13"],
        ["Tasa promedio ponderada", "=IFERROR(B8/B7,0)", "=IFERROR(C8/C7,0)", ""],
        ["Operaciones activas", contar("COMPRA"), contar("VENTA"), "=B15+C15"],
        ["", "", "", ""],
        ["ULTIMA TASA CAPTURADA", "", "", ""],
        ["Fecha/hora", "=IFERROR(INDEX(TASAS!A:A,COUNTA(TASAS!A:A)),\"\")", "", ""],
        ["BCV", "=IFERROR(INDEX(TASAS!B:B,COUNTA(TASAS!A:A)),\"\")", "", ""],
        ["P2P compra (prom. 5 mejores)", "=IFERROR(INDEX(TASAS!E:E,COUNTA(TASAS!A:A)),\"\")", "", ""],
        ["P2P venta (prom. 5 mejores)", "=IFERROR(INDEX(TASAS!G:G,COUNTA(TASAS!A:A)),\"\")", "", ""],
        ["Brecha P2P/BCV", "=IFERROR(INDEX(TASAS!H:H,COUNTA(TASAS!A:A)),\"\")", "", ""],
    ]
    panel.update(range_name="A1", values=filas, value_input_option="USER_ENTERED")
    reqs.append(peticion_validacion(panel.id, 1, ["CPA BEJUMA", "PANAMERICANA"], 2, 3))   # celda B3
    cab = {"textFormat": {"bold": True, "fontSize": 14, "foregroundColor": COLOR_TEXTO_CAB}, "backgroundColor": COLOR_CABECERA}
    reqs.append(celda_formato(panel.id, 0, 1, 0, 4, cab, "userEnteredFormat(textFormat,backgroundColor)"))
    sub = {"textFormat": {"bold": True, "foregroundColor": COLOR_TEXTO_CAB}, "backgroundColor": COLOR_CABECERA}
    for r in (4, 16):
        reqs.append(celda_formato(panel.id, r, r + 1, 0, 4, sub, "userEnteredFormat(textFormat,backgroundColor)"))
    reqs.append(celda_formato(panel.id, 5, 15, 1, 4, {"numberFormat": {"type": "NUMBER", "pattern": "#,##0.00"}}, "userEnteredFormat.numberFormat"))
    reqs.append(celda_formato(panel.id, 17, 18, 1, 2, {"numberFormat": {"type": "DATE_TIME", "pattern": "dd/mm/yyyy hh:mm"}}, "userEnteredFormat.numberFormat"))
    reqs.append(celda_formato(panel.id, 18, 21, 1, 2, {"numberFormat": {"type": "NUMBER", "pattern": "#,##0.0000"}}, "userEnteredFormat.numberFormat"))
    reqs.append(celda_formato(panel.id, 21, 22, 1, 2, {"numberFormat": {"type": "PERCENT", "pattern": "0.00%"}}, "userEnteredFormat.numberFormat"))
    for i, ancho in enumerate([260, 150, 150, 150]):
        reqs.append({"updateDimensionProperties": {"range": {"sheetId": panel.id, "dimension": "COLUMNS", "startIndex": i, "endIndex": i + 1},
                                                   "properties": {"pixelSize": ancho}, "fields": "pixelSize"}})
    reqs.append(peticion_proteccion(panel.id, "Panel de fórmulas (PANEL_USDT)", protecciones.get(panel.id, [])))

    libro.batch_update({"requests": reqs})
    print("Estructura aplicada. Pestañas:", [w.title for w in libro.worksheets()])
    print("Fórmula PANEL_USDT!B6 =", panel.acell("B6", value_render_option="FORMULA").value)
    print("Valor   PANEL_USDT!B6 =", panel.acell("B6").value)


if __name__ == "__main__":
    main()
