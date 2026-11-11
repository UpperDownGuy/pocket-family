"""Draw Pocket's simple wallet app icon. Requires Pillow only to regenerate."""
from pathlib import Path
import json
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
folder = root / "PocketFamily/Assets.xcassets/AppIcon.appiconset"
folder.mkdir(parents=True, exist_ok=True)
image = Image.new("RGB", (1024, 1024), "#d1ecdf")
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((214, 240, 806, 670), radius=88, fill="#4f9f82")
draw.rounded_rectangle((188, 338, 836, 788), radius=104, fill="#126c55")
draw.rounded_rectangle((224, 442, 794, 462), radius=10, fill="#83c3a6")
draw.rounded_rectangle((614, 508, 836, 662), radius=50, fill="#e7f6ee")
draw.ellipse((666, 562, 710, 606), fill="#126c55")
image.save(folder / "AppIcon.png")
(folder / "Contents.json").write_text(json.dumps({"images": [{"filename": "AppIcon.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}], "info": {"author": "xcode", "version": 1}}, indent=2) + "\n")
(folder.parent / "Contents.json").write_text('{"info":{"author":"xcode","version":1}}\n')
print("Created wallet app icon.")
