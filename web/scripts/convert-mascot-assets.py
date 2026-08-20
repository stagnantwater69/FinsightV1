"""
Port mobile mascot poses to web-ready assets.

Run from the REPO ROOT (paths below are relative to it), with Pillow available:

    python3 web/scripts/convert-mascot-assets.py

Re-run it when a pose is added to mobile/assets/mascot/ and wanted on web; the
outputs it writes are committed, so this is a regeneration step and not part of
the build. The pose -> screen mapping lives in docs/mascot-scenario-library.md.

Mobile ships these as ~1.2MB 1254x1254 RGB PNGs with a baked near-white
background AND a soft grey contact shadow under the character. Both are
invisible on the white surface the art was drawn for, and both are glaring on
FinSight's Dark theme -- the plate as a white block, the shadow as a white
saucer under the mascot's feet. So each pose is:

  1. background-removed via edge flood-fill (NOT a global threshold -- that
     would punch holes in eyes, paper, and belly highlights inside the art).
     The fill treats "achromatic and lighter than SHADOW_FLOOR" as background,
     which takes the contact shadow with the plate.

     SHADOW_FLOOR is what separates the shadow from real art: the ellipse under
     the character measures ~230-245, while emptydashboard's dashed chart frame
     -- a deliberate design element -- sits at ~204. A floor of 216 removes the
     first and keeps the second. Connectivity does the rest: the white belly
     disc and the eye whites are enclosed by a dark outline, so the fill cannot
     reach them however light they are.

  2. trimmed to its content bounding box, so the art fills the 96px box
     instead of floating in dead margin
  3. re-squared on a transparent canvas, so every pose carries the same visual
     weight in the same box
  4. downscaled to 512px (retina-safe for the 96-256px sizes web renders)
  5. saved as WebP with alpha

The greeting frame is handled separately: those frames were already
background-removed upstream, so its plate is transparent but its contact shadow
is baked in as opaque pixels at ~(174,183,184) -- darker than any pose shadow.
It has no chart frame to protect, so it gets its own, more aggressive floor and
floods inward from the existing transparency instead of from the edge.
"""

from PIL import Image
from collections import deque
import os

SRC = "mobile/assets/mascot/01-onboarding"
DST = "web/public/mascot/01-onboarding"
POSES = ["businessprofilesetup", "emptydashboard", "onboardingcomplete", "tutorial"]

GREETING_SRC = "mobile/assets/greeting-frames/greeting_060.png"  # GREETING_REST_FRAME
GREETING_DST = "web/public/mascot/greeting.webp"

# Ask FinSight's own mascot art, already a clean transparent cutout on mobile
# (see mobile/src/components/AskFinSightFab.tsx). It ships as TWO web assets
# because the drawer needs it at two very different sizes:
#
#   ask-fin        the whole scene -- head, question bubble, sparkle marks --
#                  for the drawer's opening moment, where it has room to read.
#   ask-fin-avatar the head alone, for the 24px avatar beside each AI reply.
#                  The full scene at 24px is mud: the bubble and sparkles eat
#                  the width and leave the face about fourteen pixels wide.
#
# Both boxes are measured from the asset, not guessed; FAB_ART_BOUNDS in
# mobile/src/lib/artCrop.ts carries the same numbers for the same reason. If
# FAB.png is ever re-exported, re-measure.
ASK_SRC = "mobile/assets/FAB.png"
ASK_SCENE_BOX = (212, 248, 876, 776)  # full art bounds
# The 24px avatar does NOT come from FAB.png, though it is the obvious source.
#
# FAB.png's question bubble genuinely OVERLAPS the head's top-right: measured
# row by row, the two are separate above y=370 but merge into one opaque run
# from y=390 down, and the bubble still covers head pixels out to x=819 at
# y=470. So no rectangle and no circle centred on the face separates them --
# every crop either slices the head (clipping both ear tufts and the chin,
# which is what shipped first and looked broken at 24px) or drags a white
# wedge of bubble in behind the ear.
#
# The greeting frame has the same character with nothing overlapping him, so
# the avatar is his head instead. Different pose, same owl, and at 24px what
# reads is the glasses and the silhouette, both of which match.
AVATAR_SRC = GREETING_SRC
AVATAR_BOX = (60, 20, 250, 160)

ACHROMATIC = 22  # max-min channel spread still counted as grey
POSE_FLOOR = 216  # keeps the ~204 chart frame, drops the ~230+ shadow
GREETING_FLOOR = 140  # the greeting's shadow is a darker ~174 grey
TARGET = 512


def flood_clear(im, seeds, floor):
    """Clear every pixel reachable from `seeds` that reads as grey background."""
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    q = deque(seeds)

    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1

        r, g, b, a = px[x, y]
        if a != 0:
            if max(r, g, b) - min(r, g, b) > ACHROMATIC or min(r, g, b) < floor:
                continue  # real art -- stop, do not cross
            px[x, y] = (255, 255, 255, 0)

        q.append((x + 1, y))
        q.append((x - 1, y))
        q.append((x, y + 1))
        q.append((x, y - 1))

    return im


def edge_seeds(w, h):
    for x in range(w):
        yield (x, 0)
        yield (x, h - 1)
    for y in range(h):
        yield (0, y)
        yield (w - 1, y)


def finish(im, out, square=True):
    """Trim to the art, optionally re-square, downscale, write WebP.

    `square` pads to a square canvas so a set of poses share one aspect and
    carry equal visual weight in the same box. The Ask FinSight art opts out:
    it is a wide composition, and padding it to a square would render it
    smaller inside its box for no gain, since it is the only thing in it.
    """
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    if square:
        side = max(im.size)
        canvas = Image.new("RGBA", (side, side), (255, 255, 255, 0))
        canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
        im = canvas
    im.thumbnail((TARGET, TARGET), Image.LANCZOS)
    im.save(out, "WEBP", quality=88, method=6)
    return os.path.getsize(out)


def main():
    os.makedirs(DST, exist_ok=True)

    for name in POSES:
        src = f"{SRC}/{name}.png"
        im = Image.open(src).convert("RGBA")
        before = os.path.getsize(src)
        im = flood_clear(im, list(edge_seeds(*im.size)), POSE_FLOOR)
        after = finish(im, f"{DST}/{name}.webp")
        print(f"{name}: {before//1024}KB PNG -> {after//1024}KB WebP ({100 - after*100//before}% smaller)")

    # The greeting frame already has a transparent plate; seed the fill from
    # the pixels that are already clear so it eats inward into the shadow.
    im = Image.open(GREETING_SRC).convert("RGBA")
    w, h = im.size
    px = im.load()
    seeds = [(x, y) for y in range(h) for x in range(w) if px[x, y][3] == 0]
    im = flood_clear(im, seeds, GREETING_FLOOR)
    after = finish(im, GREETING_DST)
    print(f"greeting: -> {after//1024}KB WebP")

    # FAB.png needs no background removal -- it is already a cutout -- so these
    # are a crop and a downscale only. The face keeps its own aspect rather
    # than being re-squared: padding it to a square would render the head
    # smaller inside the same 24px avatar box, which is the opposite of why it
    # was cropped.
    ask = Image.open(ASK_SRC).convert("RGBA")
    scene_px = finish(ask.crop(ASK_SCENE_BOX), "web/public/mascot/ask-fin.webp", square=False)
    print(f"ask-fin: -> {scene_px//1024}KB WebP")

    # Squared, so the head sits centred in a square avatar box instead of
    # being stretched to fill one.
    avatar = Image.open(AVATAR_SRC).convert("RGBA").crop(AVATAR_BOX)
    size = finish(avatar, "web/public/mascot/ask-fin-avatar.webp")
    print(f"ask-fin-avatar: -> {size//1024}KB WebP")


if __name__ == "__main__":
    main()
