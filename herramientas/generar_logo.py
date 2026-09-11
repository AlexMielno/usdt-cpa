# -*- coding: utf-8 -*-
"""
Genera el logo de la app "USDT CPA" (estilo Binance: fondo casi negro + amarillo #F0B90B)
y todos los tamaños que necesitan Windows (.ico) y Android (@capacitor/assets).

Salida:
  app/recursos/icon-only.png        1024x1024  (ícono completo, fondo oscuro con esquinas redondeadas)
  app/recursos/icon-foreground.png  1024x1024  (solo el motivo, fondo transparente; Android adaptativo)
  app/recursos/icon-background.png  1024x1024  (fondo liso)
  app/recursos/splash.png           2732x2732  (pantalla de carga)
  app/recursos/splash-dark.png      2732x2732
  app/recursos/icon.ico             multi-tamaño para el .exe
  app/www/img/logo.png              512x512 para la interfaz
"""
import os
from PIL import Image, ImageDraw, ImageFont

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REC = os.path.join(RAIZ, "app", "recursos")
IMG = os.path.join(RAIZ, "app", "www", "img")
os.makedirs(REC, exist_ok=True)
os.makedirs(IMG, exist_ok=True)

OSCURO = (11, 14, 17, 255)        # #0B0E11
AMARILLO = (240, 185, 11, 255)    # #F0B90B
AMARILLO_SUAVE = (240, 185, 11, 70)
BLANCO = (234, 236, 239, 255)


def fuente(tam):
    for nombre in ["ariblk.ttf", "seguibl.ttf", "segoeuib.ttf", "arialbd.ttf", "Arial.ttf"]:
        ruta = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", nombre)
        if os.path.exists(ruta):
            return ImageFont.truetype(ruta, tam)
    return ImageFont.load_default()


def rombo(draw, cx, cy, r, color, ancho=0):
    pts = [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]
    if ancho:
        draw.line(pts + [pts[0]], fill=color, width=ancho, joint="curve")
    else:
        draw.polygon(pts, fill=color)


def dibujar_motivo(tam=1024, con_texto=True, escala=1.0):
    """Motivo sobre fondo transparente: rombos estilo Binance + letras USDT."""
    im = Image.new("RGBA", (tam, tam), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = tam / 1024 * escala
    cx = tam / 2
    # --- rombos: uno grande en contorno con uno pequeño lleno dentro, y dos satélites
    cy = tam * (0.40 if con_texto else 0.5)
    rombo(d, cx, cy, 250 * s, AMARILLO, ancho=int(44 * s))
    rombo(d, cx, cy, 105 * s, AMARILLO)
    rombo(d, cx - 300 * s, cy, 58 * s, AMARILLO)
    rombo(d, cx + 300 * s, cy, 58 * s, AMARILLO)
    if con_texto:
        f = fuente(int(215 * s))
        texto = "USDT"
        # letra espaciada
        esp = int(14 * s)
        ancho_total = sum(d.textlength(c, font=f) for c in texto) + esp * (len(texto) - 1)
        x = cx - ancho_total / 2
        y = tam * 0.66
        for c in texto:
            d.text((x, y), c, font=f, fill=BLANCO)
            x += d.textlength(c, font=f) + esp
        # subrayado amarillo fino
        d.rounded_rectangle([cx - 250 * s, tam * 0.905, cx + 250 * s, tam * 0.905 + 22 * s], radius=int(11 * s), fill=AMARILLO)
    return im


def fondo_redondeado(tam=1024, radio=None):
    im = Image.new("RGBA", (tam, tam), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, tam - 1, tam - 1], radius=radio or int(tam * 0.22), fill=OSCURO)
    # halo amarillo muy sutil (degradado suave) recortado a la forma redondeada
    from PIL import ImageFilter
    halo = Image.new("RGBA", (tam, tam), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.ellipse([-tam * 0.30, -tam * 0.30, tam * 0.50, tam * 0.50], fill=(240, 185, 11, 40))
    halo = halo.filter(ImageFilter.GaussianBlur(tam * 0.12))
    mascara = Image.new("L", (tam, tam), 0)
    ImageDraw.Draw(mascara).rounded_rectangle([0, 0, tam - 1, tam - 1], radius=radio or int(tam * 0.22), fill=255)
    halo.putalpha(Image.composite(halo.getchannel("A"), Image.new("L", (tam, tam), 0), mascara))
    im.alpha_composite(halo)
    return im


def icono_completo(tam=1024):
    im = fondo_redondeado(tam)
    im.alpha_composite(dibujar_motivo(tam, con_texto=True, escala=0.86))
    return im


def main():
    # 1) Ícono principal
    icono = icono_completo(1024)
    icono.save(os.path.join(REC, "icon-only.png"))
    # 2) Android adaptativo: primer plano (con margen de seguridad) y fondo
    fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    fg.alpha_composite(dibujar_motivo(1024, con_texto=True, escala=0.62))
    fg.save(os.path.join(REC, "icon-foreground.png"))
    bg = Image.new("RGBA", (1024, 1024), OSCURO)
    bg.save(os.path.join(REC, "icon-background.png"))
    # 3) Splash
    for nombre in ("splash.png", "splash-dark.png"):
        sp = Image.new("RGBA", (2732, 2732), OSCURO)
        motivo = dibujar_motivo(1024, con_texto=True, escala=0.9)
        sp.alpha_composite(motivo, (int((2732 - 1024) / 2), int((2732 - 1024) / 2)))
        sp.save(os.path.join(REC, nombre))
    # 4) ICO para Windows
    icono.save(os.path.join(REC, "icon.ico"), sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    # 5) Logo para la interfaz (512) y versión "solo motivo" para la cabecera
    icono.resize((512, 512), Image.LANCZOS).save(os.path.join(IMG, "logo.png"))
    marca = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    marca.alpha_composite(dibujar_motivo(1024, con_texto=False, escala=1.0))
    marca.crop((150, 250, 874, 774)).resize((256, 185), Image.LANCZOS).save(os.path.join(IMG, "marca.png"))
    print("Logo e íconos generados en", REC, "y", IMG)


if __name__ == "__main__":
    main()
