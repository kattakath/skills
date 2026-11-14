// The long-form document layout: reports, plans, memos. Single column, tagged PDF. Every value
// is a token from base.typ.
#import "base.typ": *
#let T = (
  title: scale.display-small,
  section: scale.headline-small,
  entry: scale.title-medium,
  body: scale.body-medium,
  small: scale.body-small, // table cells
  label: scale.label-medium, // table headers, footer
)

#let setup(title: "", author: "", footer: "", doc) = {
  set document(title: title, author: author)
  set page(
    paper: "us-letter",
    margin: (x: space(1200), top: space(700), bottom: space(800)),
    background: place(top + left, rect(width: 100%, height: space(100), fill: color.primary)),
    footer: context styled(T.label, text(fill: color.meta, grid(
      columns: (1fr, auto),
      footer,
      [Page #counter(page).display() of #counter(page).final().first()],
    ))),
  )
  set text(lang: "en", region: "US", font: font, hyphenate: false, fill: color.text, ..tok(T.body))
  set par(justify: false, leading: 0pt, spacing: space(125))
  set list(spacing: space(75), indent: space(0), body-indent: space(100))
  set enum(spacing: space(75), indent: space(0), body-indent: space(100))
  set strong(delta: 100) // 400 → 500, Emphasized Body Medium; never Bold
  show link: it => underline(text(fill: color.primary, it))
  show heading.where(level: 1): it => block(below: space(200), styled(T.title, text(fill: color.primary, it.body)))
  show heading.where(level: 2): it => context {
    if query(heading.where(level: 2).before(here())).len() > 1 {
      block(above: space(400), below: space(0), sticky: true,
        line(length: 100%, stroke: 1 * k + color.outline-variant))
    }
    block(above: space(300), below: space(150), sticky: true, styled(T.section, text(fill: color.primary, it.body)))
  }
  show heading.where(level: 3): it => block(above: space(300), below: space(100), sticky: true, styled(T.entry, it.body))
  show heading.where(level: 4): it => block(above: space(200), below: space(100), sticky: true, styled(T.label, it.body))
  // Tables: default grid, tinted bold title row, rows never split, whole table kept on one page
  // when it fits on one.
  set table(
    stroke: 1 * k + color.outline-variant,
    inset: (x: space(100), y: space(75)),
    fill: (x, y) => if y == 0 { color.tint },
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
  show raw.where(block: false): it => box(fill: color.tint, inset: (x: 2pt), outset: (y: 2pt), radius: 2pt,
    text(font: mono, size: 8.5pt, tracking: 0pt, it))
  doc
}

// Key-value block under the title: label column tinted and bold.
#let details(..rows) = block(below: space(250), table(
  columns: (auto, 1fr),
  fill: (x, y) => if x == 0 { color.tint },
  ..rows.pos().map(r => (table.cell(styled(T.label, r.at(0))), table.cell(r.at(1)))).flatten(),
))
