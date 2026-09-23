"""Rebuild the PNG app icons from icon.svg.

The manifest points at icon.svg and every browser that reads the manifest uses
it, so these PNGs are only needed by the two places that can't take an SVG:
Apple's touch icon, and the icon on a push notification. That is exactly why
they went stale — nothing on screen looked wrong while they were a redesign
behind. Run this whenever the crest changes:

    pip install cairosvg
    python engine/make_icons.py

Written deliberately as a script in the repo, not a one-off, so the next change
to the crest is one command rather than an afternoon.
"""

import sys
from pathlib import Path

try:
    import cairosvg
except (ImportError, OSError) as e:
    # cairosvg needs cairo itself, which pip cannot install on Windows.
    sys.exit(f"cairosvg unavailable ({e}).\n\n"
             "On Windows the PNGs were last rendered in the browser instead, which is the\n"
             "same renderer the app uses. Serve the repo (python -m http.server 8795), open\n"
             "it, and in the console draw icon.svg onto a canvas at 180, 192 and 512 px,\n"
             "then save each canvas.toDataURL('image/png') over the files listed below.")

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "icon.svg"
# name -> pixel size. Both copies (root and builder/) are written, because the
# builder page asks for its own ../icon-192.png for notifications.
TARGETS = {"apple-touch-icon.png": 180, "icon-192.png": 192, "icon-512.png": 512}
DIRS = [ROOT, ROOT / "builder"]


def main():
    if not SOURCE.exists():
        print(f"no {SOURCE}")
        return 1
    svg = SOURCE.read_bytes()
    for name, size in TARGETS.items():
        png = cairosvg.svg2png(bytestring=svg, output_width=size, output_height=size)
        for d in DIRS:
            if not d.is_dir():
                continue
            out = d / name
            was = out.stat().st_size if out.exists() else 0
            out.write_bytes(png)
            rel = out.relative_to(ROOT).as_posix()
            print(f"{rel:<32} {size:>4}px  {was:>7} -> {len(png):>7} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
