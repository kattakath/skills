#!/usr/bin/env python3
"""Measure the construction geometry hiding in a raster logo.

Emits JSON (stdout) with evidence you can reason about, instead of traced outlines:
  stroke_width   median stroke width of line-like parts (px)
  lines          straight segments with angle (deg) and length (px)
  angle_hist     segment length per 7.5-degree bin: a spike means a design rule
  circles        arcs found by iterative RANSAC on the centre-line skeleton:
                 centre, radius, inlier count, residual RMS, angular coverage
  solid_nodes    filled dots (distance-transform peaks wider than the stroke)
  hollow_nodes   small ring nodes (enclosed holes below --max-hole px^2)
  graph          skeleton topology: endpoints (degree 1) and junctions (degree >= 3),
                 clustered. Read it BEFORE fitting: where tracks end, T-join, cusp or merge.

Usage:
  measure.py logo.png --color 39C5F3 [--tol 60] [--crop x0,y0,x1,y1] [--min-radius 8]

Needs: numpy, scipy, scikit-image, pillow.
"""
import argparse, json, math, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from skimage.morphology import skeletonize
from skimage.measure import CircleModel, ransac
from skimage.transform import probabilistic_hough_line


def mask_for(img, hexcolor, tol):
    rgb = np.array([int(hexcolor[i:i + 2], 16) for i in (0, 2, 4)])
    a = img[..., 3] > 100
    d = np.sqrt(((img[..., :3].astype(float) - rgb) ** 2).sum(-1))
    return a & (d < tol)


def circles_ransac(pts, min_r, max_r, min_inliers, resid, max_circles=24, seed=0):
    rng = np.random.default_rng(seed)
    out, pts = [], pts.astype(float)
    for _ in range(max_circles):
        if len(pts) < min_inliers:
            break
        best = None
        for _try in range(3):
            model, inl = ransac(pts, CircleModel, min_samples=3, residual_threshold=resid,
                                max_trials=4000, rng=rng)
            if model is None or inl is None:
                continue
            try:
                (xc, yc), r = model.center, model.radius
            except AttributeError:  # scikit-image < 0.26
                xc, yc, r = model.params
            if not (min_r <= r <= max_r):
                continue
            if best is None or inl.sum() > best[1].sum():
                best = (model, inl)
        if best is None or best[1].sum() < min_inliers:
            break
        model, inl = best
        ip = pts[inl]
        # refit on inliers (algebraic least squares), report residual + angular coverage
        A = np.c_[ip[:, 0], ip[:, 1], np.ones(len(ip))]
        c = np.linalg.lstsq(A, (ip ** 2).sum(1), rcond=None)[0]
        xc, yc = c[0] / 2, c[1] / 2
        r = math.sqrt(c[2] + xc ** 2 + yc ** 2)
        res = np.hypot(ip[:, 0] - xc, ip[:, 1] - yc) - r
        ang = np.degrees(np.arctan2(ip[:, 1] - yc, ip[:, 0] - xc)) % 360
        cover = 7.5 * len(np.unique((ang // 7.5).astype(int)))
        out.append(dict(cx=round(xc, 2), cy=round(yc, 2), r=round(r, 2), inliers=int(len(ip)),
                        rms=round(float(np.sqrt((res ** 2).mean())), 3), coverage_deg=cover))
        pts = pts[~inl]
    return sorted(out, key=lambda c: (c['cx'], c['r']))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('png')
    ap.add_argument('--color', required=True, help='hex without #, the ink to measure')
    ap.add_argument('--tol', type=float, default=60)
    ap.add_argument('--crop', help='x0,y0,x1,y1 region to analyse')
    ap.add_argument('--min-radius', type=float, default=8)
    ap.add_argument('--max-hole', type=float, default=200)
    ap.add_argument('--min-line', type=int, default=20)
    ap.add_argument('--index-coords', action='store_true',
                    help='report raw pixel indices instead of SVG coordinates (pixel i spans [i, i+1], so SVG = index + 0.5)')
    a = ap.parse_args()

    img = np.array(Image.open(a.png).convert('RGBA')).astype(int)
    m = mask_for(img, a.color.lstrip('#'), a.tol)
    if a.crop:
        x0, y0, x1, y1 = map(int, a.crop.split(','))
        keep = np.zeros_like(m); keep[y0:y1, x0:x1] = True; m &= keep
    if m.sum() == 0:
        sys.exit('no pixels match --color/--tol')

    dt = ndi.distance_transform_edt(m)
    sk = skeletonize(m)
    # mean width = ink area / centre-line length; robust on diagonals, unlike 2*EDT
    thin = dt <= np.percentile(dt[sk], 75) + 1  # ignore dots/blobs
    stroke = float(m[thin].sum() / max(sk[thin].sum(), 1))

    # straight segments
    lines = []
    for (x0, y0), (x1, y1) in probabilistic_hough_line(sk, threshold=10, line_length=a.min_line, line_gap=3, rng=0):
        ang = math.degrees(math.atan2(-(y1 - y0), x1 - x0)) % 180
        lines.append(dict(p0=[int(x0), int(y0)], p1=[int(x1), int(y1)], angle=round(ang, 1),
                          length=round(math.hypot(x1 - x0, y1 - y0), 1)))
    hist = {}
    for l in lines:
        b = round(round(l['angle'] / 7.5) * 7.5 % 180, 1)
        hist[b] = round(hist.get(b, 0) + l['length'], 1)

    # arcs: RANSAC on skeleton points that are NOT on straight segments
    ys, xs = np.where(sk)
    pts = np.c_[xs, ys]
    onl = np.zeros(len(pts), bool)
    for l in lines:
        p0, p1 = np.array(l['p0'], float), np.array(l['p1'], float)
        u = (p1 - p0) / max(np.linalg.norm(p1 - p0), 1e-9)
        v = pts - p0
        t = v @ u
        dperp = np.abs(v[:, 0] * u[1] - v[:, 1] * u[0])
        onl |= (dperp < 1.5) & (t > -1) & (t < np.linalg.norm(p1 - p0) + 1)
    h, w = m.shape
    circles = [c for c in circles_ransac(pts[~onl], a.min_radius, max(h, w), min_inliers=25, resid=1.2)
               if c['coverage_deg'] >= 45 and c['rms'] < 0.6]  # drop chance fits on short chords

    # nodes
    solid = []
    lab, n = ndi.label(dt >= max(stroke / 2 + 1.2, 2))
    for i in range(1, n + 1):
        yy, xx = np.where(lab == i)
        solid.append(dict(x=round(xx.mean(), 1), y=round(yy.mean(), 1), r=round(float(dt[lab == i].max()), 1)))
    holes = ndi.binary_fill_holes(m) & ~m
    lab, n = ndi.label(holes)
    hollow = []
    for i in range(1, n + 1):
        yy, xx = np.where(lab == i)
        if len(yy) <= a.max_hole:
            hollow.append(dict(x=round(xx.mean(), 1), y=round(yy.mean(), 1),
                               hole_r=round(math.sqrt(len(yy) / math.pi), 1)))

    # topology: degree of each skeleton pixel (8-neighbourhood), clustered into points
    deg = ndi.convolve(sk.astype(int), np.ones((3, 3), int), mode='constant') - 1
    def pts_of(mask):
        lab, n = ndi.label(ndi.binary_dilation(mask, iterations=1))
        return [dict(x=round(float(xx.mean()), 1), y=round(float(yy.mean()), 1))
                for yy, xx in (np.where(lab == i) for i in range(1, n + 1))]
    graph = dict(endpoints=pts_of(sk & (deg == 1)), junctions=pts_of(sk & (deg >= 3)))

    out = dict(size=[w, h], ink=a.color, coords='index' if a.index_coords else 'svg',
               stroke_width=round(stroke, 2), graph=graph,
               angle_hist=dict(sorted(hist.items(), key=lambda kv: -kv[1])),
               lines=lines, circles=circles, solid_nodes=solid, hollow_nodes=hollow)
    if not a.index_coords:
        # Everything above is computed on pixel INDICES; SVG/cairo pixel i spans [i, i+1].
        # Found by the synthetic benchmark (2026-09-24): a constant (-0.60, -0.63) px centre bias.
        def shift(o):
            if isinstance(o, dict):
                return {k: (round(v + 0.5, 2) if k in ('cx', 'cy', 'x', 'y') and isinstance(v, (int, float))
                            else [round(c + 0.5, 2) for c in v] if k in ('p0', 'p1') else shift(v))
                        for k, v in o.items()}
            if isinstance(o, list):
                return [shift(v) for v in o]
            return o
        out = {k: (shift(v) if k in ('lines', 'circles', 'solid_nodes', 'hollow_nodes', 'graph') else v)
               for k, v in out.items()}
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()
