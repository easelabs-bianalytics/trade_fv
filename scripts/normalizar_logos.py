"""Normaliza as logos das redes para uso no app.

Problema que isso resolve: cada arte vem com uma quantidade diferente de margem
embutida, então no tile do app umas ficavam "afastadas" (Raia, Venâncio) e outras
quase encostando na borda (Pague Menos). Aqui a margem original é recortada e
todas passam a ocupar a MESMA proporção do quadrado.

O que faz, por logo:
  1. detecta a cor de fundo pelos cantos (ou transparência);
  2. recorta até o conteúdo real (bounding box do que difere do fundo);
  3. redesenha num quadrado com margem uniforme, mantendo a proporção;
  4. salva em app/public/redes/<rede>.png (256x256);
  5. reporta a cor de marca (fundo, se colorido; senão a cor dominante da marca)
     e se o texto por cima deve ser branco ou escuro.

Uso:  python scripts/normalizar_logos.py
"""
from collections import Counter
import os

from PIL import Image

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORIGEM = os.path.join(RAIZ, "ui-html", "redes_logos")
DESTINO = os.path.join(RAIZ, "app", "public", "redes")

# Casamento por nome NORMALIZADO (minúsculas, só letras/números), para o script
# não quebrar quando o arquivo for trocado por outro formato ou grafia:
# "Clamed.jpg", "clamed.png" e "CLAMED.jpeg" caem todos em "clamed".
ALIASES = {
    "araujo": "araujo",
    "clamed": "clamed",
    "dpsp": "dpsp", "grupodpsp": "dpsp",
    "drogal": "drogal",
    "indiana": "indiana",
    "paguemenos": "paguemenos",
    "panvel": "panvel",
    "raia": "raia", "raiadrogasil": "raia", "drogasil": "raia",
    "saojoao": "saojoao", "farmaciassaojoao": "saojoao",
    "venancio": "venancio", "drogariavenancio": "venancio",
}

EXTENSOES = {".png", ".jpg", ".jpeg", ".webp"}


def normalizar_nome(stem):
    import unicodedata
    s = unicodedata.normalize("NFD", stem)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return "".join(c for c in s.lower() if c.isalnum())


def descobrir_origens():
    """Mapeia código da rede -> caminho do arquivo encontrado em ORIGEM."""
    achados = {}
    for arq in sorted(os.listdir(ORIGEM)):
        stem, ext = os.path.splitext(arq)
        if ext.lower() not in EXTENSOES:
            continue
        rede = ALIASES.get(normalizar_nome(stem))
        if rede:
            achados[rede] = arq
        else:
            print(f"  (ignorado: {arq} — nome não reconhecido)")
    return achados

LADO = 256          # tamanho final do quadrado
OCUPACAO = 0.86     # quanto do quadrado o conteúdo deve ocupar
TOLERANCIA = 26     # o quanto um pixel pode variar do fundo e ainda ser "fundo"


def cor_de_fundo(im):
    """Cor mais comum entre os cantos — o fundo da arte."""
    l, a = im.size
    amostra = []
    for x0, y0 in ((0, 0), (l - 8, 0), (0, a - 8), (l - 8, a - 8)):
        for dx in range(8):
            for dy in range(8):
                amostra.append(im.getpixel((x0 + dx, y0 + dy))[:3])
    return Counter(amostra).most_common(1)[0][0]


def luminancia(rgb):
    def canal(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (canal(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def saturacao(rgb):
    mx, mn = max(rgb), min(rgb)
    return 0 if mx == 0 else (mx - mn) / mx


def cor_da_marca(im, fundo):
    """Se o fundo é colorido, ele É a cor da marca (arte full-bleed).
    Senão, procura a cor saturada mais frequente do desenho."""
    if saturacao(fundo) >= 0.25 and luminancia(fundo) < 0.93:
        return fundo
    cont = Counter()
    peq = im.copy()
    peq.thumbnail((160, 160))
    for px in peq.getdata():
        r, g, b = px[:3]
        if saturacao((r, g, b)) < 0.3 or max(r, g, b) < 40:
            continue
        cont[(r // 24 * 24, g // 24 * 24, b // 24 * 24)] += 1
    return cont.most_common(1)[0][0] if cont else fundo


def recortar_ate_conteudo(im, fundo):
    """Bounding box de tudo que não é fundo (com tolerância p/ ruído de JPEG)."""
    l, a = im.size
    px = im.load()
    fr, fg, fb = fundo
    x0, y0, x1, y1 = l, a, 0, 0
    passo = max(1, min(l, a) // 400)
    for y in range(0, a, passo):
        for x in range(0, l, passo):
            r, g, b = px[x, y][:3]
            if abs(r - fr) + abs(g - fg) + abs(b - fb) > TOLERANCIA:
                x0, y0 = min(x0, x), min(y0, y)
                x1, y1 = max(x1, x), max(y1, y)
    if x1 <= x0 or y1 <= y0:
        return im
    m = max(2, passo)
    return im.crop((max(0, x0 - m), max(0, y0 - m), min(l, x1 + m), min(a, y1 + m)))


def normalizar(caminho_origem, destino):
    original = Image.open(caminho_origem)
    tem_alfa = original.mode in ("RGBA", "LA") or "transparency" in original.info
    im = original.convert("RGBA") if tem_alfa else original.convert("RGB")

    if tem_alfa:
        # fundo transparente: recorta pelo canal alfa e mantém transparência
        bbox = im.split()[-1].getbbox()
        conteudo = im.crop(bbox) if bbox else im
        fundo_rgb = cor_da_marca(im.convert("RGB"), (255, 255, 255))
        tela = Image.new("RGBA", (LADO, LADO), (0, 0, 0, 0))
    else:
        fundo_rgb = cor_de_fundo(im)
        conteudo = recortar_ate_conteudo(im, fundo_rgb)
        tela = Image.new("RGBA", (LADO, LADO), fundo_rgb + (255,))

    # redimensiona mantendo proporção até ocupar OCUPACAO do quadrado
    alvo = int(LADO * OCUPACAO)
    cl, ca = conteudo.size
    escala = min(alvo / cl, alvo / ca)
    novo = conteudo.resize((max(1, int(cl * escala)), max(1, int(ca * escala))), Image.LANCZOS)
    tela.paste(novo, ((LADO - novo.size[0]) // 2, (LADO - novo.size[1]) // 2),
               novo if novo.mode == "RGBA" else None)

    tela.save(destino, "PNG", optimize=True)
    marca = cor_da_marca(im.convert("RGB"), fundo_rgb)
    return marca


def main():
    os.makedirs(DESTINO, exist_ok=True)
    origens = descobrir_origens()
    faltando = set(ALIASES.values()) - set(origens)
    if faltando:
        print(f"  (sem arte para: {', '.join(sorted(faltando))})")
    print(f"\n{'rede':12s} {'arquivo':22s} {'cor de marca':14s} {'texto':7s} contraste")
    print("-" * 72)
    for rede in sorted(origens):
        arquivo = origens[rede]
        origem = os.path.join(ORIGEM, arquivo)
        marca = normalizar(origem, os.path.join(DESTINO, f"{rede}.png"))
        lum = luminancia(marca)
        # texto branco só se der contraste >= 4.5; senão texto escuro
        ct_branco = 1.05 / (lum + 0.05)
        claro = ct_branco < 4.5
        ct = (lum + 0.05) / 0.0663 if claro else ct_branco   # 0.0663 = lum(#1A1D2E)+0.05
        hexa = "#%02X%02X%02X" % marca
        print(f"{rede:12s} {arquivo:22s} {hexa:14s} "
              f"{'escuro' if claro else 'branco':7s} {ct:5.2f}")


if __name__ == "__main__":
    main()
