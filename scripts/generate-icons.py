#!/usr/bin/env python3
"""Regenerate Pupa's original artwork. Optional tooling: Python 3 + Pillow.

The application and CI use checked-in assets; Pillow is not an app dependency.
"""
from pathlib import Path
from PIL import Image, ImageDraw
import html

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
BUILD = ROOT / 'build'
ASSETS.mkdir(exist_ok=True)
BUILD.mkdir(exist_ok=True)
SCALE = 2

# Original cubic paths: a cocoon becoming a soft, four-wing butterfly.
SHAPES = [
    ('#C3B4E9', [('M',512,482),('C',435,330,294,226,225,327),('C',145,446,306,574,473,564),('Z',)]),
    ('#B9D8C4', [('M',512,482),('C',589,330,730,226,799,327),('C',879,446,718,574,551,564),('Z',)]),
    ('#D7E8DB', [('M',486,536),('C',398,529,299,580,324,673),('C',349,765,469,728,511,609),('Z',)]),
    ('#DDD0EF', [('M',538,536),('C',626,529,725,580,700,673),('C',675,765,555,728,513,609),('Z',)]),
]

def path_points(commands):
    result = []
    current = (0, 0)
    for command in commands:
        if command[0] == 'M':
            current = command[1:3]
            result.append(current)
        elif command[0] == 'C':
            start = current
            p1, p2, end = command[1:3], command[3:5], command[5:7]
            for step in range(1, 61):
                t = step / 60
                a = 1 - t
                result.append(tuple(a*a*a*start[n] + 3*a*a*t*p1[n] + 3*a*t*t*p2[n] + t*t*t*end[n] for n in (0, 1)))
            current = end
    return result

def draw_butterfly(image, mono=False):
    d = ImageDraw.Draw(image)
    scale = image.width / 1024
    def box(bounds): return tuple(round(v*scale) for v in bounds)
    for color, commands in SHAPES:
        d.polygon([(round(x*scale), round(y*scale)) for x,y in path_points(commands)], fill='#000000' if mono else color)
    ink = '#000000' if mono else '#486354'
    d.rounded_rectangle(box((482,400,542,652)), radius=round(30*scale), fill=ink)
    if not mono:
        d.arc(box((489,476,537,530)), 0, 180, fill='#D8E9DC', width=max(1,round(5*scale)))
        d.arc(box((489,529,537,583)), 0, 180, fill='#D8E9DC', width=max(1,round(5*scale)))
    for commands in [[('M',501,426),('C',491,379,471,362,455,363)], [('M',523,426),('C',533,379,553,362,569,363)]]:
        radius = max(1, 6.5*scale)
        for x, y in path_points(commands):
            x, y = x*scale, y*scale
            d.ellipse((round(x-radius),round(y-radius),round(x+radius),round(y+radius)),fill=ink)
    if not mono:
        for cx,cy,size in [(729,247,24),(266,709,19)]:
            pts=[(cx,cy-size),(cx+size*.28,cy-size*.28),(cx+size,cy),(cx+size*.28,cy+size*.28),(cx,cy+size),(cx-size*.28,cy+size*.28),(cx-size,cy),(cx-size*.28,cy-size*.28)]
            d.polygon([(round(x*scale),round(y*scale)) for x,y in pts],fill='#B99E65')

icon = Image.new('RGBA',(1024*SCALE,1024*SCALE))
d = ImageDraw.Draw(icon)
d.rounded_rectangle((68*SCALE,68*SCALE,956*SCALE,956*SCALE),radius=208*SCALE,fill='#F9F6EE',outline='#E4E6DA',width=5*SCALE)
draw_butterfly(icon)
icon = icon.resize((1024,1024),Image.Resampling.LANCZOS)
icon.save(ASSETS / 'icon.png')
icon.save(ASSETS / 'icon.ico',sizes=[(n,n) for n in (16,24,32,48,64,128,256)])
icon.save(ASSETS / 'icon.icns')

svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Pupa butterfly">', '<rect x="68" y="68" width="888" height="888" rx="208" fill="#F9F6EE" stroke="#E4E6DA" stroke-width="5"/>']
for color, commands in SHAPES:
    path = ' '.join(str(c[0])+' '+' '.join(str(v) for v in c[1:]) for c in commands)
    svg.append(f'<path d="{html.escape(path)}" fill="{color}"/>')
svg.extend(['<rect x="482" y="400" width="60" height="252" rx="30" fill="#486354"/>', '<path d="M501 426 C491 379 471 362 455 363 M523 426 C533 379 553 362 569 363" fill="none" stroke="#486354" stroke-width="13" stroke-linecap="round"/>', '<path d="M489 503 Q513 530 537 503 M489 556 Q513 583 537 556" fill="none" stroke="#D8E9DC" stroke-width="5"/>', '<path d="M729 223 736 240 753 247 736 254 729 271 722 254 705 247 722 240Z M266 690 271 704 285 709 271 714 266 728 261 714 247 709 261 704Z" fill="#B99E65"/>','</svg>'])
(ASSETS/'icon.svg').write_text('\n'.join(svg)+'\n')

for mono, name, sizes in [(False,'tray',[32,64]),(True,'trayTemplate',[22,44])]:
    # Crop icon whitespace so the small system-tray mark stays legible.
    large = Image.new('RGBA',(1024,1024))
    draw_butterfly(large,mono=mono)
    crop=large.crop((140,220,884,764))
    square=Image.new('RGBA',(760,760))
    square.alpha_composite(crop,((760-crop.width)//2,(760-crop.height)//2))
    for i,size in enumerate(sizes):
        square.resize((size,size),Image.Resampling.LANCZOS).save(ASSETS/f'{name}{"@2x" if i else ""}.png')

# Quiet cream/mint installer artwork; no third-party illustrations or fonts bundled.
sidebar=Image.new('RGB',(164,314),'#F9F6EE')
mark=icon.resize((128,128),Image.Resampling.LANCZOS)
sidebar.paste(mark,(18,68),mark)
ImageDraw.Draw(sidebar).rounded_rectangle((31,242,133,247),radius=2,fill='#B9D8C4')
sidebar.save(BUILD/'installerSidebar.bmp')
header=Image.new('RGB',(150,57),'#F9F6EE')
mark=icon.resize((54,54),Image.Resampling.LANCZOS)
header.paste(mark,(94,1),mark)
header.save(BUILD/'installerHeader.bmp')

# DMG positions match src-tauri/tauri.conf.json; arrow does not overlap either icon.
for size,suffix in [(1,''),(2,'@2x')]:
    canvas=Image.new('RGB',(540*size,380*size),'#F9F6EE')
    draw=ImageDraw.Draw(canvas)
    draw.rounded_rectangle((32*size,30*size,508*size,350*size),radius=24*size,outline='#E0E4D7',width=2*size)
    draw.line((245*size,220*size,295*size,220*size),fill='#8DA798',width=3*size)
    draw.line((284*size,210*size,295*size,220*size,284*size,230*size),fill='#8DA798',width=3*size)
    canvas.save(BUILD/f'background{suffix}.png')
print('Generated icon, tray, NSIS, and DMG artwork.')
