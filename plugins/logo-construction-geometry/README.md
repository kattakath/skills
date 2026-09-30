# logo-construction-geometry

Rebuild a raster or noisy auto-traced logo as a **clean parametric SVG** — by measuring the
construction and recovering the rule behind it, not by tracing pixels.

Auto-tracers outline the **edges of pixels**, so every anti-aliasing step becomes a node and a
stroked ring becomes two lumpy filled contours. Most marks were drawn from a few primitives and
one or two rules. Recover those and the SVG becomes a few dozen commands that one parameter change
updates consistently.

```
measure --> infer the rule --> snap + generate --> score vs source --> report
```

## What it ships

| Script | What it reports |
|---|---|
| `scripts/measure.py` | Circles (RANSAC + least-squares refit), an angle histogram (probabilistic Hough), stroke width, solid/hollow nodes, and the skeleton **graph** — deterministic seeds, SVG coordinates |
| `scripts/overlay.py` | `iou`, `iou_tolerant`, `off_px` and a colour-coded `diff.png`; `--chromium` when the SVG relies on masks |

## The idea that separates this from tracing

**A rule must predict a number you did not use to derive it.** That prediction is the evidence; a
rule that only restates the measurements is a curve fit, not a construction. Example: two lobes of
radius r joined by a straight line at 45° force the spacing `d = 2√2·r_mid`, because a tangent at
distance r₁ from one centre and r₂ from the other only works when r₁ + r₂ = d·sin θ.

**Topology before geometry.** Circle fits say *which* curves exist. They never say where each one
stops or what it joins, and a clean-looking model with the wrong topology fails exactly there.

## Score every component, never just the whole logo

Measured 2026-09-24: a wrong topology for one glyph moved the **whole-logo** tolerant IoU by 0.003
(0.905 → 0.908). The **glyph's own crop** showed it plainly — off-px 73 → 3, IoU 0.68 → 0.83. A
small part's error disappears in the average, so use `--crop` per component and aim for
`iou_tolerant` ≥ 0.9.

## Pitfalls that cost real accuracy

- **A tracer will beat you on raw IoU.** potrace scored 0.94 on the same raster, because it copies
  the raster's own drift. Report both numbers plus compactness (110 stored numbers vs 1,040) and
  say why the construction wins anyway.
- **The half-pixel convention.** SVG coordinates sit +0.5 px from pixel indices. Before v0.3 every
  fitted centre came out (−0.5, −0.5) off, costing a real case study 0.06 IoU.
- **Ellipses are not circles.** `measure.py` fits circles only, so a stretched ring breaks into
  partial arcs — recall fell to 0.25–0.30 once sx > 1. Measure the stretch first and divide it out.
- **A plausible rule borrowed from a sibling part.** "The 8 is the ∞ turned upright" looked right
  and scored fine overall. It was wrong. Every component earns its own rule from its own
  measurements.
- **Unequal pitch can be real.** One mark lost 1.7 IoU points when snapped to equal spacing, so
  the unequal pitch stayed. Snap only if the component score survives it.

## Never silently "fix" the brand

Close with a **derived vs. fitted-and-snapped vs. assumed** table, name the weakest assumption and
what would settle it, and put every place the source looks inconsistent to the user as a decision:
faithful, or clean.

## Requires

`numpy`, `scipy`, `scikit-image`, `pillow` and `cairosvg`.
