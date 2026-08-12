#!/usr/bin/env python3
"""Turn cropped greeting video frames into compact transparent PNGs."""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

from PIL import Image


def remove_connected_white(image: Image.Image) -> Image.Image:
    """Remove only near-white pixels connected to the canvas boundary."""
    rgb = image.convert("RGB")
    width, height = rgb.size
    pixels = rgb.load()
    connected = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def is_background(x: int, y: int) -> bool:
        red, green, blue = pixels[x, y]
        return min(red, green, blue) >= 225 and max(red, green, blue) - min(red, green, blue) <= 24

    def add(x: int, y: int) -> None:
        offset = y * width + x
        if not connected[offset] and is_background(x, y):
            connected[offset] = 1
            queue.append((x, y))

    for x in range(width):
        add(x, 0)
        add(x, height - 1)
    for y in range(height):
        add(0, y)
        add(width - 1, y)

    while queue:
        x, y = queue.popleft()
        for next_x, next_y in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= next_x < width and 0 <= next_y < height:
                add(next_x, next_y)

    rgba = rgb.convert("RGBA")
    output = rgba.load()
    for y in range(height):
        for x in range(width):
            if connected[y * width + x]:
                output[x, y] = (*pixels[x, y], 0)
    return rgba


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path, help="Directory containing cropped 320x320 PNG frames")
    parser.add_argument("output", type=Path, help="Destination for transparent PNG frames")
    args = parser.parse_args()
    sources = sorted(args.input.glob("*.png"))
    if not sources:
        raise SystemExit(f"No PNG frames found in {args.input}")

    args.output.mkdir(parents=True, exist_ok=True)
    for index, source in enumerate(sources):
        image = Image.open(source)
        if image.size != (320, 320):
            raise SystemExit(f"Unexpected frame size for {source}: {image.size}")
        transparent = remove_connected_white(image)
        optimized = transparent.quantize(colors=64, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
        optimized.save(args.output / f"greeting_{index:03d}.png", optimize=True)
    print(f"Wrote {len(sources)} transparent frames to {args.output}")


if __name__ == "__main__":
    main()
