#!/usr/bin/env python3
"""Score a rebuilt SVG against the reference raster.

Rasterises the SVG at the reference's pixel size, then reports:
  iou            intersection-over-union of the two alpha masks
  iou_tolerant   IoU after a 1 px dilation of each mask (forgives anti-aliasing)
  off_px         pixels more than --tol px from the other mask (true shape error)
and writes a diff PNG: yellow = both, red = reference only, green = SVG only.

Usage: overlay.py reference.png rebuilt.svg [--diff diff.png] [--scale 3] [--tol 1.5] [--crop x0,y0,x1,y1]
Score EACH component with --crop too: a whole-logo IoU hides a wrong small part.
Needs: numpy, scipy, pillow, cairosvg (masks/filters: prefer --chromium for exact browser rendering).
"""
import argparse, io, json
import numpy as np
from PIL import Image
from scipy import ndimage as ndi


def render(svg, w, h, chromium):
    if chromium:
        from playwright.sync_api import sync_playwright
        html = f'<body style="margin:0;background:transparent">{open(svg).read()}</body>'
        with sync_playwright() as p:
            b = p.chromium.launch(); pg = b.new_page(viewport={'width': w, 'height': h})
            pg.set_content(html)
            pg.eval_on_selector('svg', f'e=>{{e.setAttribute("width",{w});e.setAttribute("height",{h})}}')
            png = pg.screenshot(omit_background=True); b.close()
        return Image.open(io.BytesIO(png)).convert('RGBA')
    import cairosvg
    return Image.open(io.BytesIO(cairosvg.svg2png(url=svg, output_width=w, output_height=h))).convert('RGBA')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ref'); ap.add_argument('svg')
    ap.add_argument('--diff', default='overlay-diff.png')
    ap.add_argument('--scale', type=int, default=3)
    ap.add_argument('--tol', type=float, default=1.5)
    ap.add_argument('--chromium', action='store_true')
    ap.add_argument('--crop', help='x0,y0,x1,y1: score one component only')
    a = ap.parse_args()
    ref = Image.open(a.ref).convert('RGBA'); w, h = ref.size
    new = render(a.svg, w, h, a.chromium)
    ra = np.array(ref)[..., 3] > 100; na = np.array(new)[..., 3] > 100
    if a.crop:
        x0, y0, x1, y1 = map(int, a.crop.split(','))
        ra, na = ra[y0:y1, x0:x1], na[y0:y1, x0:x1]; h, w = ra.shape
    iou = (ra & na).sum() / max((ra | na).sum(), 1)
    k = ndi.generate_binary_structure(2, 1)
    rd, nd = ndi.binary_dilation(ra, k), ndi.binary_dilation(na, k)
    iou_t = ((ra & nd) | (na & rd)).sum() / max((ra | na).sum(), 1)
    dist_to_new = ndi.distance_transform_edt(~na); dist_to_ref = ndi.distance_transform_edt(~ra)
    off = int(((ra & (dist_to_new > a.tol)) | (na & (dist_to_ref > a.tol))).sum())
    img = np.zeros((h, w, 3), np.uint8); img[..., 0] = ra * 255; img[..., 1] = na * 255
    Image.fromarray(img).resize((w * a.scale, h * a.scale), Image.NEAREST).save(a.diff)
    print(json.dumps(dict(iou=round(float(iou), 4), iou_tolerant=round(float(iou_t), 4),
                          off_px=off, ink_px=int(ra.sum()), diff=a.diff)))


if __name__ == '__main__':
    main()
