// The PDF house style for long-form documents. Tokens follow the résumé theme it was taken from:
// Typst, single column, Material 3 type scale and colour roles, static Google Sans cuts, exact
// line pitch, tagged PDF. Change the look HERE, and bump the plugin version.
// Fonts and colours are NOT set here: they arrive from ../style.json through `--input style=…`
// (scripts/pdf.py), so the PDF and the Google Doc share one definition. This file owns layout.
#let S = json(bytes(sys.inputs.at("style")))
#let hex(key) = rgb("#" + S.at(key))
// The body uses the family's 17pt optical cut when it has one; Typst falls through the list.
#let body-font = (S.font + " 17pt", S.font)
#let T = (
  font: body-font,
  title: (size: 36, lh: 44, track: 0, weight: 400, font: S.font), // Display Small
  section: (size: 24, lh: 32, track: 0, weight: 400, font: S.font), // Headline Small
  entry: (size: 16, lh: 24, track: 0.15, weight: 500), // Title Medium
  body: (size: 14, lh: 20, track: 0.25, weight: 400), // Body Medium
  small: (size: 12, lh: 16, track: 0.4, weight: 400), // Body Small: table cells
  label: (size: 12, lh: 16, track: 0.5, weight: 500), // Label Medium: table headers, footer
  color: (
    text: hex("text"),
    meta: hex("meta"),
    link: hex("primary"),
    primary: hex("primary"),
    outline-variant: hex("border"),
    tint: hex("tint"), // table title row / column
  ),
)
#let k = 0.75pt // per spec px (CSS Values 4: 1px = 0.75pt)
#let sp = (
  "0": 0, "25": 2, "50": 4, "75": 6, "100": 8, "125": 10, "150": 12, "175": 14, "200": 16,
  "250": 20, "300": 24, "400": 32, "450": 36, "500": 40, "600": 48, "700": 56, "800": 64,
  "900": 72, "1200": 96,
)
#let space(n) = sp.at(str(n)) * k
#let tok(t) = (
  size: t.size * k,
  tracking: t.track * k,
  weight: t.weight,
  ..if "font" in t { (font: t.font) } else { (:) },
  top-edge: 0.8 * t.size * k + (t.lh - t.size) * k / 2,
  bottom-edge: -(0.2 * t.size * k + (t.lh - t.size) * k / 2),
)
#let styled(t, body) = text(..tok(t), body)
#let mono = S.mono

#let setup(title: "", author: "", footer: "", doc) = {
  set document(title: title, author: author)
  set page(
    paper: "us-letter",
    margin: (x: space(1200), top: space(700), bottom: space(800)),
    background: place(top + left, rect(width: 100%, height: space(100), fill: T.color.primary)),
    footer: context styled(T.label, text(fill: T.color.meta, grid(
      columns: (1fr, auto),
      footer,
      [Page #counter(page).display() of #counter(page).final().first()],
    ))),
  )
  set text(lang: "en", region: "US", font: T.font, hyphenate: false, fill: T.color.text, ..tok(T.body))
  set par(justify: false, leading: 0pt, spacing: space(125))
  set list(spacing: space(75), indent: space(0), body-indent: space(100))
  set enum(spacing: space(75), indent: space(0), body-indent: space(100))
  set strong(delta: 100) // 400 → 500, Emphasized Body Medium; never Bold
  show link: it => underline(text(fill: T.color.link, it))
  show heading.where(level: 1): it => block(below: space(200), styled(T.title, text(fill: T.color.primary, it.body)))
  show heading.where(level: 2): it => context {
    if query(heading.where(level: 2).before(here())).len() > 1 {
      block(above: space(400), below: space(0), sticky: true,
        line(length: 100%, stroke: 1 * k + T.color.outline-variant))
    }
    block(above: space(300), below: space(150), sticky: true, styled(T.section, text(fill: T.color.primary, it.body)))
  }
  show heading.where(level: 3): it => block(above: space(300), below: space(100), sticky: true, styled(T.entry, it.body))
  show heading.where(level: 4): it => block(above: space(200), below: space(100), sticky: true, styled(T.label, it.body))
  // Tables: default grid, tinted bold title row, rows never split, whole table kept on one page
  // when it fits on one.
  set table(
    stroke: 1 * k + T.color.outline-variant,
    inset: (x: space(100), y: space(75)),
    fill: (x, y) => if y == 0 { T.color.tint },
    align: left + top,
  )
  set table.cell(breakable: false)
  show table.cell: it => { set text(..tok(T.small)); set par(spacing: space(50)); it }
  show table.cell.where(y: 0): it => { set text(..tok(T.label)); it }
  show table: it => layout(size => {
    let h = measure(block(width: size.width, it)).height
    if h < 8in { block(breakable: false, width: 100%, it) } else { it }
  })
  // Diagrams: monospace, bold, no background, centred, never split.
  show raw.where(block: true): it => block(breakable: false, width: 100%, above: space(200), below: space(200),
    align(center, block(align(left, text(font: mono, size: 8pt, weight: 700, top-edge: 0.8em, bottom-edge: -0.2em, tracking: 0pt, it)))))
  show raw.where(block: false): it => box(fill: T.color.tint, inset: (x: 2pt), outset: (y: 2pt), radius: 2pt,
    text(font: mono, size: 8.5pt, tracking: 0pt, it))
  doc
}

// Key-value block under the title: label column tinted and bold.
#let details(..rows) = block(below: space(250), table(
  columns: (auto, 1fr),
  fill: (x, y) => if x == 0 { T.color.tint },
  ..rows.pos().map(r => (table.cell(styled(T.label, r.at(0))), table.cell(r.at(1)))).flatten(),
))
