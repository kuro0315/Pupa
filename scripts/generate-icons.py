#!/usr/bin/env python3
"""Generate Pupa's vector-based cyberpunk identity; requires Pillow only."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS, BUILD = ROOT / 'assets', ROOT / 'build'
ASSETS.mkdir(exist_ok=True)
BUILD.mkdir(exist_ok=True)
BG, CYAN, PINK, EDGE = '#090D19', '#53F5FF', '#FF3B9D', '#273650'
# Angular overlapping data cards form a P-shaped memory cartridge.
FRAME = [(100,52),(832,52),(972,192),(972,872),(872,972),(192,972),(52,832),(52,100)]
BACK = [(284,228),(698,228),(780,310),(780,664),(690,754),(284,754)]
FRONT = [(222,308),(584,308),(670,394),(670,618),(584,704),(362,704),(362,828),(222,828)]
SLOT = [(362,436),(538,436),(538,566),(362,566)]

def polygon(draw, points, fill, scale):
    draw.polygon([(round(x*scale),round(y*scale)) for x,y in points],fill=fill)

def line(draw, points, fill, width, scale):
    draw.line([(round(x*scale),round(y*scale)) for x,y in points],fill=fill,width=max(1,round(width*scale)),joint='curve')

def mark(size, mono=False, framed=True):
    image=Image.new('RGBA',(size,size))
    draw=ImageDraw.Draw(image)
    s=size/1024
    ink='#000000' if mono else CYAN
    if framed:
        polygon(draw,FRAME,BG,s)
        line(draw,FRAME+[FRAME[0]],EDGE,12,s)
        line(draw,[(100,240),(100,108),(236,108)],CYAN,14,s)
        line(draw,[(788,916),(916,916),(916,784)],PINK,14,s)
    if not mono:
        line(draw,BACK+[BACK[0]],PINK,28,s)
        polygon(draw,FRONT,BG,s)
    polygon(draw,FRONT,ink,s)
    polygon(draw,SLOT,(0,0,0,0) if mono else BG,s)
    if not mono:
        line(draw,[(726,460),(836,460),(836,352)],PINK,20,s)
        polygon(draw,[(814,302),(858,302),(858,346),(814,346)],PINK,s)
        line(draw,[(444,800),(572,800)],CYAN,18,s)
        line(draw,[(608,800),(652,800)],PINK,18,s)
    return image

icon=mark(2048).resize((1024,1024),Image.Resampling.LANCZOS)
icon.save(ASSETS/'icon.png')
icon.save(ASSETS/'icon.ico',sizes=[(n,n) for n in (16,24,32,48,64,128,256)])
icon.save(ASSETS/'icon.icns')
def pts(points): return ' '.join(f'{x},{y}' for x,y in points)
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Pupa cyberpunk memory cartridge">
<polygon points="{pts(FRAME)}" fill="{BG}" stroke="{EDGE}" stroke-width="12"/>
<path d="M100 240V108H236" fill="none" stroke="{CYAN}" stroke-width="14"/>
<path d="M788 916H916V784" fill="none" stroke="{PINK}" stroke-width="14"/>
<polygon points="{pts(BACK)}" fill="none" stroke="{PINK}" stroke-width="28"/>
<polygon points="{pts(FRONT)}" fill="{BG}"/>
<polygon points="{pts(FRONT)}" fill="{CYAN}"/>
<polygon points="{pts(SLOT)}" fill="{BG}"/>
<path d="M726 460H836V352" fill="none" stroke="{PINK}" stroke-width="20"/>
<path d="M444 800H572" stroke="{CYAN}" stroke-width="18"/>
<path d="M608 800H652" stroke="{PINK}" stroke-width="18"/>
<path d="M814 302H858V346H814Z" fill="{PINK}"/>
</svg>
'''
(ASSETS/'icon.svg').write_text(svg)
for mono,name,sizes in [(False,'tray',[32,64]),(True,'trayTemplate',[22,44])]:
    large=mark(1024,mono=mono,framed=False).crop((180,200,880,860))
    square=Image.new('RGBA',(720,720))
    square.alpha_composite(large,((720-large.width)//2,(720-large.height)//2))
    for i,size in enumerate(sizes):
        square.resize((size,size),Image.Resampling.LANCZOS).save(ASSETS/f'{name}{"@2x" if i else ""}.png')
sidebar=Image.new('RGB',(164,314),BG)
small=icon.resize((140,140),Image.Resampling.LANCZOS)
sidebar.paste(small,(12,64),small)
ImageDraw.Draw(sidebar).line((30,246,134,246),fill=CYAN,width=3)
sidebar.save(BUILD/'installerSidebar.bmp')
header=Image.new('RGB',(150,57),BG)
small=icon.resize((54,54),Image.Resampling.LANCZOS)
header.paste(small,(94,1),small)
header.save(BUILD/'installerHeader.bmp')
for scale,suffix in [(1,''),(2,'@2x')]:
    canvas=Image.new('RGB',(540*scale,380*scale),BG)
    draw=ImageDraw.Draw(canvas)
    line(draw,[(32,90),(32,30),(440,30),(508,98),(508,350),(100,350),(32,282)],EDGE,2,scale)
    line(draw,[(32,90),(32,30),(128,30)],CYAN,3,scale)
    line(draw,[(410,350),(508,350),(508,290)],PINK,3,scale)
    line(draw,[(245,220),(295,220),(284,210)],CYAN,3,scale)
    line(draw,[(295,220),(284,230)],CYAN,3,scale)
    canvas.save(BUILD/f'background{suffix}.png')
print('Generated cyberpunk icon, tray, NSIS, and DMG artwork.')
