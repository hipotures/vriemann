#!/usr/bin/env python3
"""Screenshot gallery for the README.

The gallery is described by docs/gallery/gallery.json: a list of groups, each with a title, a caption and
one or more images (shown side by side). This tool converts screenshots to small WebP files and writes
docs/GALLERY.md from the JSON.

    python3 tools/gallery.py add "Title" "Caption" shot1.png [shot2.png ...] [--slug name] [--hero]
    python3 tools/gallery.py build          # regenerate docs/GALLERY.md after editing gallery.json by hand

Needs Pillow (pip install pillow) for `add`; `build` uses only the standard library.
"""
import argparse, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAL = ROOT / "docs/gallery"
MANIFEST = GAL / "gallery.json"
OUT_MD = ROOT / "docs/GALLERY.md"
MAX_SIDE = 1800        # longest side of a published image, px
QUALITY = 82           # WebP quality


def load():
    return json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"hero": None, "groups": []}


def save(m):
    GAL.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(m, indent=2, ensure_ascii=False) + "\n")


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "shot"


def convert(src, dst):
    from PIL import Image
    im = Image.open(src)
    im = im.convert("RGB")                       # screenshots come as RGBA; the alpha is always opaque
    im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    im.save(dst, "WEBP", quality=QUALITY, method=6)
    return im.size


def render(m):
    lines = ["# Gallery", "",
             "Screenshots from the desktop browser (VR captures will follow). "
             "Images in one row show the same scene from different moments or angles.", ""]
    for g in m["groups"]:
        lines += [f"## {g['title']}", "", g["caption"], ""]
        imgs = g["images"]
        wide = any(i["size"][0] >= 1.9 * i["size"][1] for i in imgs)   # panoramas would be tiny side by side: stack them
        rows = [[i] for i in imgs] if wide else [imgs]
        for r in rows:
            w = 100 if len(r) == 1 else 100 // len(r) - 1
            cells = " ".join(f'<a href="gallery/{i["file"]}"><img src="gallery/{i["file"]}" width="{w}%" alt="{g["title"]}"></a>' for i in r)
            lines += [f"<p>{cells}</p>", ""]
    OUT_MD.write_text("\n".join(lines))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("title"); a.add_argument("caption"); a.add_argument("files", nargs="+")
    a.add_argument("--slug"); a.add_argument("--hero", action="store_true", help="also use the first image at the top of the README")
    sub.add_parser("build")
    args = ap.parse_args()
    m = load()
    if args.cmd == "add":
        slug = args.slug or slugify(args.title)
        if any(g["slug"] == slug for g in m["groups"]):
            sys.exit(f"group '{slug}' exists; pick another --slug or edit {MANIFEST}")
        GAL.mkdir(parents=True, exist_ok=True)
        imgs = []
        for n, f in enumerate(args.files, 1):
            name = f"{slug}-{n}.webp" if len(args.files) > 1 else f"{slug}.webp"
            size = convert(f, GAL / name)
            imgs.append({"file": name, "size": list(size)})
            print(f"{f} -> docs/gallery/{name} {size[0]}x{size[1]} {(GAL / name).stat().st_size // 1024} kB")
        m["groups"].append({"slug": slug, "title": args.title, "caption": args.caption, "images": imgs})
        if args.hero:
            m["hero"] = imgs[0]["file"]
        save(m)
    render(m)
    print(f"wrote {OUT_MD.relative_to(ROOT)} ({len(m['groups'])} groups)")


if __name__ == "__main__":
    main()
