---
name: logo-construction-geometry
description: This skill should be used when a logo exists only as a raster or as a noisy auto-traced SVG and needs a clean vector built from real geometry — the user says "rebuild this logo as proper SVG", "the trace is lumpy / hundreds of nodes", "convert this PNG logo to real circles and lines", "find the geometry behind this logo", "make the logo parametric", or "write a prompt so Claude Design rebuilds it cleanly". It measures the construction (centres, radii, angles, stroke, nodes), infers the rule that ties them together, regenerates the mark from a handful of named parameters, and scores the result against the source.
version: 0.1.0
---

# Logo construction geometry — measure the rule, don't trace the pixels

Auto-tracers (potrace, vtracer, "AI vectorize") outline the **edges of pixels**, so every
anti-aliasing step becomes a node and a stroked ring becomes two lumpy filled contours.
Most marks were drawn from a few primitives and one or two rules. Recover those, and the
SVG becomes a few dozen commands that one parameter change updates consistently.

```
┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐
│ 1. Measure│-->│ 2. Infer  │-->│ 3. Snap + │-->│ 4. Score  │-->│ 5. Report │
│ evidence  │   │ the rule  │   │ generate  │   │ vs source │   │ + decide  │
└───────────┘   └───────────┘   └───────────┘   └───────────┘   └───────────┘
```

## 1. Measure — numbers, not impressions

Work from the **highest-resolution raster** available. Ignore the traced SVG's paths; they
are what you are replacing.

```bash
pip install numpy scipy scikit-image pillow cairosvg   # once
python3 scripts/measure.py logo.png --color 39C5F3 [--crop x0,y0,x1,y1] > geometry.json
```

Run it once per ink colour and per region (icon vs. wordmark). It skeletonises the ink to
centre-lines and reports:

| Field | Method | Read it as |
|---|---|---|
| `circles` | iterative RANSAC + algebraic least-squares refit on the skeleton | several circles sharing a centre = concentric tracks; `rms` < 0.5 px = a true arc |
| `angle_hist` | probabilistic Hough transform, length per 7.5° bin | a spike at 45°/135°/90° = a design angle; scattered short bins = arc chords (noise) |
| `stroke_width` | ink area ÷ centre-line length | includes about 0.5 px of anti-aliasing: round it **down** |
| `solid_nodes` / `hollow_nodes` | distance-transform peaks / small enclosed holes | terminals and on-track markers |

Check: the circles found match what you see; nothing important is missing from the lists.
For letterforms, sample row and column runs across stems, arches and bars (stem width,
x-height, baseline, counter radii). The same stem width usually drives the dot diameter,
bar lengths and corner radii.

## 2. Infer the rule — the step tracers skip

Look for **relations**, not values. Common ones:

- **Shared centres and equal pitch:** concentric tracks are one middle radius ± k·pitch.
- **Tangency at a fixed angle:** two lobes of radius r joined by a straight line at angle θ
  force the spacing. For a figure-8 or ∞ with 45° diagonals, `d = 2√2·r_mid`, because a
  tangent line at distance r₁ from one centre and r₂ from the other only works when
  r₁ + r₂ = d·sin θ.
- **Parallel offsets swap radius at a crossing:** a track at r_mid + δ on one lobe comes out
  at r_mid − δ on the other. Check it: each line's distances to the two centres add up to
  the same constant.
- **Symmetry:** point symmetry or mirror symmetry. Test it by transforming the measured
  nodes; don't assume it.
- **Type:** stem = dot diameter = bar extension; arches are concentric semicircles
  (outer r − inner r = stem).

Each rule must **predict a number you did not use to derive it**. That prediction is the
evidence. A rule that only restates the measurements is a curve fit, not a construction.

## 3. Snap and generate — from a parameter table

- Write a **small generator** (Python or JS) that turns 4–8 named parameters into SVG. Never
  hand-type coordinates.
- Primitives only: `circle`, `ellipse`, `rect`, `line`, and `path` with `M L H V A Z`.
  **No Béziers** unless the source is organic.
- **Stroked centre-lines** (`fill="none"`, round caps) for tracks, not filled outlines.
- **Hollow nodes** cut the track with a `<mask>`. A background-coloured fill breaks on
  transparent backgrounds.
- Give ids by function (`#track-A`, `#nodes-solid`, `#glyph-n`). Put the parameter table in
  `<desc>`.
- Snap measured values to the rule (equal pitch, exact angles) and **record every snap**:
  measured → chosen, and why.

## 4. Score against the source

```bash
python3 scripts/overlay.py logo.png rebuilt.svg --diff diff.png            # cairosvg
python3 scripts/overlay.py logo.png rebuilt.svg --diff diff.png --chromium # masks/filters exact
```

- `iou` — raw overlap. At about 400 px wide, 0.75–0.8 is typical even when correct: stroke
  edges are mostly anti-aliasing.
- `iou_tolerant` — with a 1 px tolerance. Aim for **≥ 0.9**.
- `off_px` — ink more than 1.5 px from the other mask. This is the real shape error.
- **Look at `diff.png`** (yellow = both, red = source only, green = rebuild only). A
  consistent red/green offset along one ring means a wrong radius or centre. Scattered
  fringes are anti-aliasing.

Check: a stroked-track mark should also rasterise cleanly at 16–32 px.

## 5. Report and decide

Close with a **derived vs. assumed** table:

| Part | Status | Evidence |
|---|---|---|
| e.g. 45° diagonals | Derived | Hough spike; the tangency invariant holds on every line |
| e.g. radii | Fitted → snapped | measured values → chosen values, largest shift in px |
| e.g. node angle | Assumed | a snap with no rule behind it |

Name the **weakest assumption** and what would settle it (a higher-resolution source, or the
master file). Put every place where the source looks inconsistent (a jog, an off-centre
ring) to the user as a decision: **faithful** or **clean**. Never silently "fix" the brand.

## Handing it to another agent (e.g. Claude Design)

If the rebuild is delegated, the prompt carries: the ban on reusing the trace, the
primitive whitelist, strokes not fills, the parameter table **and** the rules from § 2, the
id structure, the § 4 scoring with the numbers to report, and the open decisions as
questions. A prompt that only says "make it clean" gets a smoother trace, not a
construction.

## Pitfalls

- **Scoring against the trace:** the traced SVG is not the reference. Score against the raster.
- **Filled outlines for strokes:** they double the node count and break stroke-width edits.
- **Reading EDT × 2 as stroke width:** on diagonals the distance transform reads low; use
  area ÷ length.
- **Spurious RANSAC circles:** big radius, small angular coverage. The script drops those
  under 45° coverage or over 0.6 px RMS; still check them by eye.
- **cairosvg and masks:** it can render masks differently from browsers. Use `--chromium`
  when the SVG relies on masks.
- **Low resolution:** under about 300 px, a 1 px snap is a 0.3% error. Say so rather than
  claim precision.

## References

- Chat2SVG (CVPR 2025) — language models do better emitting primitive templates and then
  refining: https://chat2svg.github.io/
- scikit-image `measure.ransac` + `CircleModel`, `transform.probabilistic_hough_line`,
  `morphology.skeletonize`: https://scikit-image.org/docs/stable/api/
- SVG arc command semantics: https://www.smashingmagazine.com/2024/12/mastering-svg-arcs/
- Prior art, covering the general tracing workflow (fidelity modes, variants, validator):
  `rudykon/logo-vector-tracing`. It has no license, so it is cited only. This skill adds
  measurement tooling, rule inference and scoring.
