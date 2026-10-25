"""Encode the synthetic browser recording (requires Pillow)."""
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "artifacts/readme-demo-frames"
DESTINATION = ROOT / "docs/media/pupa-demo.gif"
times = json.loads((SOURCE / "timings.json").read_text())
frames = [Image.open(SOURCE / f"{i:04}.png").convert("RGB").resize((880, 624), Image.Resampling.LANCZOS)
          for i in range(len(times))]
# One palette for the complete recording avoids color flicker between frames.
samples = frames[::max(1, len(frames) // 24)][:24]
atlas = Image.new("RGB", (220 * 6, 156 * 4))
for index, frame in enumerate(samples):
    atlas.paste(frame.resize((220, 156)), ((index % 6) * 220, (index // 6) * 156))
palette = atlas.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
durations = [max(20, round((times[i+1]-times[i])/10)*10) if i+1 < len(times) else 100
             for i in range(len(times))]
DESTINATION.parent.mkdir(parents=True, exist_ok=True)
indexed[0].save(DESTINATION, save_all=True, append_images=indexed[1:], duration=durations,
                loop=0, optimize=True, disposal=1)
# A review sheet lets the whole sequence be inspected without a desktop capture.
sheet = Image.new("RGB", (440 * 3, 342 * 2), "#10171b")
draw = ImageDraw.Draw(sheet)
for slot, fraction in enumerate([.12, .26, .40, .56, .72, .88]):
    index = min(len(frames)-1, int(len(frames)*fraction))
    x, y = slot % 3 * 440, slot // 3 * 342
    sheet.paste(frames[index].resize((440, 312)), (x, y))
    draw.text((x+10, y+318), f"{times[index]/1000:.1f}s", fill="#dce4d9")
sheet.save(ROOT / "artifacts/readme-demo-review.png")
with Image.open(DESTINATION) as gif:
    assert gif.size == (880, 624) and gif.n_frames > 40
    assert gif.info["loop"] == 0
print(f"{DESTINATION.relative_to(ROOT)}: {len(frames)} frames, {sum(durations)/1000:.1f}s, {DESTINATION.stat().st_size/1024:.0f} KiB")
