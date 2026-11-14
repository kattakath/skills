// The house style as tokens. Fonts and colours are read from style.json in this folder, the
// same file the Google Docs build reads; everything else here is the Material 3 system printed
// on paper. Layouts (document.typ, and résumé themes elsewhere) import these and add no values
// of their own.
#let style = json("style.json")
#let hex(key) = rgb("#" + style.at(key))
#let color = (
  text: hex("text"), // on-surface
  meta: hex("meta"), // on-surface-variant
  primary: hex("primary"), // links, the page strip, document titles
  outline-variant: hex("border"), // dividers, table grid
  tint: hex("tint"), // table title row / column
)
// Optical size: the 17pt cut for text sizes, the default cut for 18pt and larger. A family with
// no 17pt cut falls through to its default.
#let font = (style.font + " 17pt", style.font)
#let display-font = style.font
#let mono = style.mono

// Type: M3 tokens (m3.material.io/styles/typography/type-scale-tokens) as size, line height and
// tracking in spec px, plus weight. Print scale: CSS Values 4 fixes 1px = 0.75pt.
#let scale = (
  display-small: (size: 36, lh: 44, track: 0, weight: 400, font: display-font),
  headline-small: (size: 24, lh: 32, track: 0, weight: 400, font: display-font),
  title-medium: (size: 16, lh: 24, track: 0.15, weight: 500),
  body-medium: (size: 14, lh: 20, track: 0.25, weight: 400),
  body-small: (size: 12, lh: 16, track: 0.4, weight: 400),
  label-medium: (size: 12, lh: 16, track: 0.5, weight: 500),
)
#let k = 0.75pt // per spec px

// Spacing: M3 system spacing tokens, an 8dp scale (space100 = 8dp). space1200 = 96dp is custom
// (the multiplier pattern): exactly 1in at 1px = 0.75pt.
#let sp = (
  "0": 0, "25": 2, "50": 4, "75": 6, "100": 8, "125": 10, "150": 12, "175": 14, "200": 16,
  "250": 20, "300": 24, "400": 32, "450": 36, "500": 40, "600": 48, "700": 56, "800": 64,
  "900": 72, "1200": 96,
)
#let space(n) = sp.at(str(n)) * k

// Apply a token: size, tracking, weight, optical cut, and an exact line pitch. With par leading
// 0 a line's pitch is top-edge − bottom-edge, so splitting the half-leading around a 0.8/0.2 em
// box makes every line exactly `lh` tall.
#let tok(t) = (
  size: t.size * k,
  tracking: t.track * k,
  weight: t.weight,
  ..if "font" in t { (font: t.font) } else { (:) },
  top-edge: 0.8 * t.size * k + (t.lh - t.size) * k / 2,
  bottom-edge: -(0.2 * t.size * k + (t.lh - t.size) * k / 2),
)
#let styled(t, body) = text(..tok(t), body)
