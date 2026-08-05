from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageStat


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    images = sorted(args.input.glob("*/*.png"))
    font = ImageFont.load_default()
    records = []
    chunk_size = 30
    for sheet_index in range(0, len(images), chunk_size):
        chunk = images[sheet_index : sheet_index + chunk_size]
        canvas = Image.new("RGB", (5 * 260, 6 * 370), "white")
        draw = ImageDraw.Draw(canvas)
        for index, path in enumerate(chunk):
            image = Image.open(path).convert("RGB")
            stat = ImageStat.Stat(image.convert("L"))
            mean = stat.mean[0]
            extrema = image.convert("L").getextrema()
            image.thumbnail((245, 335))
            x = (index % 5) * 260 + 7
            y = (index // 5) * 370 + 22
            canvas.paste(image, (x, y))
            label = f"{path.parent.name} {path.stem}"
            draw.text((x, y - 16), label, fill="black", font=font)
            records.append(
                {
                    "path": str(path),
                    "meanLuminance": round(mean, 2),
                    "extrema": extrema,
                    "blankSuspected": mean > 252.5 or extrema[0] > 240,
                }
            )
        canvas.save(args.output / f"contact-{sheet_index // chunk_size + 1:02d}.png")
    (args.output / "page-image-qa.json").write_text(
        json.dumps(records, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "pages": len(records),
                "contactSheets": (len(images) + chunk_size - 1) // chunk_size,
                "blankSuspected": sum(1 for record in records if record["blankSuspected"]),
            }
        )
    )


if __name__ == "__main__":
    main()
