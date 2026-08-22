#!/usr/bin/env python3
"""Regenerates media/screenshots/flow.png. Run after changing how work moves."""
import math
from PIL import Image, ImageDraw, ImageFont

W, H, SC = 1200, 660, 2
BG, INK, DIM, FAINT = (24, 24, 32), (222, 222, 230), (145, 145, 158), (58, 58, 70)
LEAD, RES, ENG, YOU = (167, 139, 250), (34, 211, 238), (251, 191, 36), (200, 200, 210)
F  = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
FB = "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"
M  = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
font = lambda p, s: ImageFont.truetype(p, s * SC)
S = lambda v: int(v * SC)

img = Image.new("RGB", (W * SC, H * SC), BG)
d = ImageDraw.Draw(img)
text = lambda xy, s, ft, fill=INK, anchor="la": d.text((S(xy[0]), S(xy[1])), s, font=ft, fill=fill, anchor=anchor)

def box(x, y, w, h, accent, title, sub, lines):
    d.rounded_rectangle([S(x), S(y), S(x+w), S(y+h)], radius=S(10), fill=(31,31,40), outline=FAINT, width=S(1))
    d.rounded_rectangle([S(x), S(y), S(x+3), S(y+h)], radius=S(2), fill=accent)
    text((x+16, y+13), title, font(FB, 15), accent)
    text((x+16, y+34), sub, font(F, 11), DIM)
    for i, line in enumerate(lines):
        text((x+16, y+58 + i*18), "· " + line, font(F, 11), DIM if line.startswith("no ") else INK)

def arrow(x1, y1, x2, y2, colour, label=None, dashed=False, above=True):
    if dashed:
        dx, dy = (x2-x1)/26, (y2-y1)/26
        for i in range(0, 26, 2):
            d.line([S(x1+dx*i), S(y1+dy*i), S(x1+dx*(i+1)), S(y1+dy*(i+1))], fill=colour, width=S(2))
    else:
        d.line([S(x1), S(y1), S(x2), S(y2)], fill=colour, width=S(2))
    a = math.atan2(y2-y1, x2-x1)
    for s in (2.6, -2.6):
        d.line([S(x2), S(y2), S(x2 + 11*math.cos(a+s)), S(y2 + 11*math.sin(a+s))], fill=colour, width=S(2))
    if label:
        text(((x1+x2)/2, (y1+y2)/2 - (14 if above else -6)), label, font(M, 10), colour, anchor="ma")

text((40, 34), "How work moves", font(FB, 20), INK)
text((40, 62), "You talk to the Lead. It writes briefs. Teammates return reports. Nothing else crosses.", font(F, 12), DIM)

d.rounded_rectangle([S(40), S(250), S(150), S(310)], radius=S(10), fill=(31,31,40), outline=FAINT, width=S(1))
text((95, 268), "You", font(FB, 15), YOU, anchor="ma")
text((95, 288), "the only human", font(F, 10), DIM, anchor="ma")
arrow(155, 280, 235, 280, YOU)

box(240, 190, 250, 180, LEAD, "Lead", "interrogates · decides · delegates",
    ["Read, Grep, Glob", "git_view (read-only)", "no shell", "no editor outside .cadre/"])
text((365, 384), "judgement is the product", font(F, 10), DIM, anchor="ma")

box(700, 120, 250, 120, RES, "Researcher", "finds out what is true",
    ["web search + fetch", "read-only repo", "no production code"])
box(700, 330, 250, 120, ENG, "Engineer", "makes it work, proves it",
    ["edit + shell", "tests what it changed", "no DONE without a real run"])

arrow(495, 235, 695, 175, LEAD, "brief")
arrow(695, 205, 495, 255, RES, "report", above=False)
arrow(495, 320, 695, 380, LEAD, "brief", above=False)
arrow(695, 350, 495, 300, ENG, "report")
arrow(825, 245, 825, 325, DIM, None, dashed=True)
text((838, 274), "one question", font(M, 10), DIM)
text((838, 290), "cannot consult back", font(M, 9), FAINT)

d.rounded_rectangle([S(40), S(478), S(660), S(576)], radius=S(10), fill=(28,28,36), outline=FAINT, width=S(1))
text((56, 492), "You watch all of it, live", font(FB, 12), INK)
text((56, 514), "Three lanes, one per teammate. Every tool call, every hand-off,", font(F, 11), DIM)
text((56, 534), "the reasoning if you want it, and the running cost.", font(F, 11), DIM)
for i, (c, name) in enumerate(((LEAD, "Lead"), (RES, "Researcher"), (ENG, "Engineer"))):
    x = 56 + i*190
    d.ellipse([S(x), S(556), S(x+8), S(564)], fill=c)
    text((x+14, 553), name, font(M, 10), DIM)

d.rounded_rectangle([S(700), S(478), S(1160), S(576)], radius=S(10), fill=(28,28,36), outline=FAINT, width=S(1))
text((716, 492), "Each teammate starts empty and ends when it reports", font(FB, 12), INK)
text((716, 514), "It sees only the brief. Everything it read is destroyed.", font(F, 11), DIM)
text((716, 534), "So the report is fixed:  VERDICT · HEADLINE · EVIDENCE", font(M, 10), DIM)
text((716, 552), "ASSUMPTIONS and NOT COVERED are never omitted.", font(M, 10), DIM)

img.resize((W, H), Image.LANCZOS).save("media/screenshots/flow.png")
print("wrote media/screenshots/flow.png")
