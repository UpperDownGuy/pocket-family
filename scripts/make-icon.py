"""Render Pocket's wallet geometry for iOS light, dark, and tinted appearances.

These assets share the original code-defined shapes; no image generation is used.
Requires Pillow only to regenerate.
"""
from pathlib import Path
import json
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
folder = root / "PocketFamily/Assets.xcassets/AppIcon.appiconset"
folder.mkdir(parents=True, exist_ok=True)
mobile = root / "mobile/assets/images"
mobile.mkdir(parents=True, exist_ok=True)
palettes = {
    "light": ("#d1ecdf", "#4f9f82", "#126c55", "#83c3a6", "#e7f6ee", "#126c55"),
    "dark": ("#101b18", "#2c6c54", "#79cfac", "#cff2df", "#e0f8eb", "#164e3c"),
    # Neutral luminance values let iOS apply the user's chosen Home Screen tint.
    "tinted": ("#000000", "#828282", "#d8d8d8", "#737373", "#ffffff", "#666666"),
}
images = []
for appearance, (background, back, body, seam, clasp, dot) in palettes.items():
    scale = 3
    image = Image.new("RGB", (1024 * scale, 1024 * scale), background)
    draw = ImageDraw.Draw(image)
    def rectangle(bounds, radius, fill):
        draw.rounded_rectangle(tuple(value * scale for value in bounds), radius=radius * scale, fill=fill)
    rectangle((214, 240, 806, 670), 88, back)
    rectangle((188, 338, 836, 788), 104, body)
    rectangle((224, 442, 794, 462), 10, seam)
    rectangle((614, 508, 836, 662), 50, clasp)
    draw.ellipse(tuple(value * scale for value in (666, 562, 710, 606)), fill=dot)
    image = image.resize((1024, 1024), Image.Resampling.LANCZOS)
    suffix = "" if appearance == "light" else "-" + appearance
    filename = "AppIcon" + suffix + ".png"
    image.save(folder / filename)
    image.save(mobile / ("pocket" + suffix + ".png"))
    entry = {"filename": filename, "idiom": "universal", "platform": "ios", "size": "1024x1024"}
    if appearance != "light":
        entry["appearances"] = [{"appearance": "luminosity", "value": appearance}]
    images.append(entry)
(folder / "Contents.json").write_text(json.dumps({"images": images, "info": {"author": "xcode", "version": 1}}, indent=2) + "\n")
(folder.parent / "Contents.json").write_text('{"info":{"author":"xcode","version":1}}\n')
print("Created light, dark, and tinted wallet icons for Expo and iOS.")
