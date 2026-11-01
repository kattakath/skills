# Layout traps already met, and where each is handled

Read before writing a new adapter. Most new banks repeat one of these.

| Trap | Seen at | Handled by |
|---|---|---|
| Empty `<ACCTTYPE>`; LOC wrapped `<STMTTRNRS>` but closed `</CCSTMTTRNRS>` | TD QFX | repairs `empty-accttype`, `cc-stmttrnrs-wrapper` |
| `CHARSET:1252` over a UTF-8 body; `<ACCTTYPE>` inside CCACCTFROM | CIBC QFX | repairs `charset-1252-utf8-body`, `ccacctfrom-accttype` |
| Per-export counter FITIDs (`undefined`, `undefined-1`) | Scotiabank QFX | `keys.fallback` → content key |
| `<ACCTID>` is an internal reference, not the card | Scotiabank QFX, Desjardins PDF header | `account.require_override` |
| $0.00 "Posted :" fragment rows | Tangerine QFX | `skip` |
| Star masks leaking 6–11 digits; `CC#dddd****dddd`; `****ddd` | Scotiabank, CIBC, TD, Wise | `mask.py` rules |
| A balance printed only on a day's last row | TD chequing | `pdfkit.running_chain` |
| No direction column: sign is whatever carries the balance | Scotiabank closed chequing, Tangerine | hook, proven by the running chain |
| Column headings move between pages | BMO, CIBC chequing | re-read headings at each page |
| A January statement carries December rows | every card, every chequing | `pdfkit.infer_year` |
| FX detail line under a purchase | Desjardins | folded into the description with ` — ` |
| Marketing sidebar text on transaction lines | Scotiabank closed chequing, BMO | sidebar cut after a wide gap |
| Wrapped descriptions straddle the date line | Tangerine PDF | hook splits by symmetry, refuses otherwise |
| Words split in the text layer ("St at ement"); a frame row's month too ("M ar", "M ay") | TD LOC | hook re-joins before parsing; identify accepts the split month |
| A credit balance prints "- $" (minus apart from the dollar sign) | TD card 2025 | `amt` allows one space |
| Summary labels print bare, their amounts alone on later lines | TD card 2020, 2024 | hook pairs them in order by the block's amount column, refuses leftovers |
| A wrapped row prints its amount alone below the wrap | TD card 2021 | hook holds the row open until an amount under AMOUNT($); refuses otherwise |
| An additional cardholder's section with its own net activity | TD card 2022 | `net_activity` tied per section |
| A bank-masked reference "***4ab" (stars, then a digit) | TD chequing 2026 | frozen key text would trip the leak gate: `engine._key_text` reduces it to "••4ab" first |
| A month with no activity prints no table | Desjardins, Scotiabank card | a proven statement with zero rows |
| Two prints of one product across years | Desjardins 2021, TD 2018/2021, Scotiabank 2020 | grammar alternatives, or a sibling adapter sharing the hook |
| Statement periods 1–3 days apart (weekend cycles) | Scotiabank chequing | `chain_across_statements` judges gaps of 1–3 days |
| A one-day overlap (start = previous end) | TD chequing | not judged yet |
| Scans with no text layer | 4 mortgage documents | refused as "a scan"; there is no OCR |
| A column of other people's full account numbers | Wise CSV "Payee Account Number" | dropped by name, never read |
