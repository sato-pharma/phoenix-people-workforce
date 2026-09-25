---
name: sales-sheet-rep-mapping-join-paths
description: "How to map a manual sales/collections sheet row to the medical rep who covers it — the proven join paths, and which ones actually work"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8021afd9-3043-4e4b-89ea-65e9119ba57d
  modified: 2026-08-03T19:18:17.602Z
---

Mapping a hand-kept sales sheet (pharmacy name / customer code) to a **medical rep** works via
four independent routes. Proven live on production `ozucdzovmcqvepbozvqf` on 2026-08-03 against
the July-2026 collections sheet.

**The vocabulary the sheets speak.** A short DSM territory code column maps 1:1 onto Source-of-Sales
region codes: `ue`→UE Upper Egypt, `ue1`→UE-1, `ue2`→UE-2, `d1`→D1 Delta(1), `d2`→D2 Delta(2),
`ca`→CA Cairo, `gz`→GZ Giza, `ot`→OT Others. Verified for all 9.

**Route A — customer code. ⚠ ZERO-PAD OR IT SILENTLY RETURNS NOTHING.**
`source_of_sales_customer_map` / `source_of_sales_customer_directory_rollup` on
(`distributor_code`, `client_code`) → `brick_id`/`area_code`/`region_code`. Join on the PAIR —
see [[sos-client-code-is-not-unique-across-distributors]].

**The trap that cost a wrong answer on 2026-08-03:** PS (Overseas) customer codes are stored
**left-padded to 10 digits** — a sheet's `1507580` is `0001507580` in the table. An equality join on
the raw sheet value returns ZERO rows and reads exactly like "this pharmacy isn't mapped". It made
12 of 13 codes look unresolvable when in fact all 12 resolve. Always match with
`regexp_replace(customer_code,'^0+','') = <sheet code>` (or pad the probe). Only genuinely-missing
codes should survive that.

Sheet operators write "pos" for these; the distributor_code is **`PS`**. There is no `POS`
distributor_code — the real set is EG/EP/IS/IS-S/MC/PS/RM/SF plus `-T`/`-BR`/`-HOS`/`-BK`/`-PHS`
variants.

**Route B — a rep-name column, if the sheet has one.** Often the highest-yield route. Sheet names are
2 tokens; `v_active_organogram.name_ar` is a 4–5 token legal name, so `ILIKE '%name%'` FAILS. Match by
**token subset** instead. Corroborate: a candidate whose `manager_name` is the row's own DSM is a
near-certain hit.

**Route C — town name → brick.** `source_of_sales_bricks.brick_name` ILIKE. The single most useful
route for rows with no code. Arabic spelling varies — search `جهين`/`جهينه` not `جهينة`, `محل` not
`المحلة`, and always try both Arabic and Latin. Confirmed: طهطا→UE5 Sohag1, جهينه→UE5 Sohag1,
أشمون→D13 Menoufia 2, مدينة قنا→UE7 Qena 1, طنطا→D14 Gharbia 1, المحله الكبرى→D15 Gharbia 2,
عزبة النخل→CA4 Cairo East 2, مدينة الفيوم→GZ6 Fayoum, المنوات→GZ1 Giza Centers.

**Route D — rep seat.** Resolved area + row's line → the `Medical Representative` in
`v_active_organogram` with that `line_name` + `area_name`. The Organogram/seat model is the
owner-declared source of truth. Note **not every (line, area) is staffed** — Pedia has no rep in any
Cairo area, so a Cairo Pedia row is a genuine vacancy, not a lookup failure. Keep "unresolved"
(cannot tell) distinct from "vacant" (seat exists, nobody in it).

**Known drift to expect:** SoS split GZ6 into `GZ6 Fayoum` + `UE9 Beni Suef`, but the organogram still
carries one combined seat `Fayoum-Beni Suef` (Fiby Wagdy Luka, B-52). Area-name equality alone will
miss it.

Related: [[sos-always-todays-geography-rule]] · [[sos-ambiguous-place-name-rule]] ·
[[sos-territory-aliases-is-the-brick-alias-table]] · [[organogram-vacancy-occupancy-truth]]
