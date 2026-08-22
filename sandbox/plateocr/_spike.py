import numpy as np, pytesseract
from PIL import Image, ImageDraw, ImageFont
from pytesseract import Output

F = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

def plate(text, prov="PUNJAB", w=440, h=200):
    img = Image.new("RGB", (w, h), (250, 250, 240))
    d = ImageDraw.Draw(img)
    d.rectangle([4, 4, w-5, h-5], outline=(20, 20, 20), width=4)
    fp = ImageFont.truetype(F, 34)
    d.text((w//2, 34), prov, font=fp, fill=(10, 10, 90), anchor="mm")
    fm = ImageFont.truetype(F, 88)
    d.text((w//2, 118), text, font=fm, fill=(15, 15, 15), anchor="mm")
    return img

im = plate("LEA-1234")
for psm in (6, 7, 8, 11, 13):
    cfg = f"--oem 3 --psm {psm} -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"
    d = pytesseract.image_to_data(im, config=cfg, output_type=Output.DICT)
    toks = [(t, c) for t, c in zip(d["text"], d["conf"]) if t.strip()]
    print(f"psm {psm:2d} -> {toks}")
