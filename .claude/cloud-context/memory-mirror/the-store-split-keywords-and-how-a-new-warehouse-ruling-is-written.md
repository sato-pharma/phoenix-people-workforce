---
name: the-store-split-keywords-and-how-a-new-warehouse-ruling-is-written
description: "The complete keyword inventory the store/pharmacy split is decided by — six store words, two start-only prefixes, the two-half trade phrase, eleven never-store words, five override lists — and the rule that a NEW ruling is written as a NAME in STORE_OVERRIDE_NAMES, counted on production both ways first, never as a code."
metadata:
  node_type: memory
  type: project
  originSessionId: d5764c39-c02c-4dd4-a40d-70ad08cc490c
  modified: 2026-10-09T15:36:08.895Z
---

Owner instruction, 2026-10-09: **"do a deeper audit and remember the keywords that we split based on
them and use your mind don't be as a fool of course more than this should be split of course"** —
after **"split the 11 in column C"** on the three-column workbook of all 10,420 customer names.

**Every keyword is in `src/lib/sales/customer-channel.ts`. Nothing outside that file decides it.**

- **Store words** (substring, anywhere in the name): `مخزن` · `فارم` (covers فارما / فارماسي /
  فارمسي) · `تريد` · `الشركة` · `الجمعيه` · `للتجارة`.
- **Store prefixes** (START of the name only): `م - ` and `م- `, EPDA's notation for مخزن. It can
  never be a keyword — it starts 29 names and appears inside 623.
- **The trade phrase**: a business word (`تجار` · `توزيع` · `توريد`) **plus** a goods word (`ادوي` ·
  `دواء` · `دوائ` · `الادي`), or `تجار` and `توزيع` together. Tested on the name with ALL whitespace
  removed, because distributors split words mid-token.
- **Hospital words** win the overlap (`مستشف` …) — a hospital is never a warehouse.
- **Never-store words**: `صيدلي` · `مستشف` · `سجل تجار` · `مخازن` · `مستودع` · `هيئه` · `ت.ص` ·
  `قوي عامله` · `سكك حديد` · `كهرباء`. His 17-of-17 "government depot, do NOT split" ruling lives here.
- **Five override lists**: `PHARMACY_OVERRIDE_CLIENT_CODES` (code) · `STORE_OVERRIDE_CUSTOMER_KEYS`
  (`distributor|code` — **the only one `legacyIsStoreCustomer` reads**) · `PHARMACY_OVERRIDE_CHAINS`
  and `PHARMACY_OVERRIDE_NAMES` (name; can only ever REFUSE a split) · `STORE_OVERRIDE_NAMES` (name;
  **the only one that can CREATE one**).

**Why:** `STORE_OVERRIDE_NAMES` is the one list that can turn a pharmacy into a warehouse, and a
warehouse's sales are spread across its city's areas. An over-wide stem therefore moves money
between reps with nothing downstream reporting it — the split preserves each line's unit total, and
the publication drift check compares units. Bare `صيادله` would have taken 3,117,937.50 EGP of
pharmacy sales on two names alone; bare `الشرق` 184,707.00; bare `اورينت` 50,220.00.

**How to apply:** a new ruling is a NAME in `STORE_OVERRIDE_NAMES`, written long enough to reach only
the business he named, and counted on production BOTH ways first (what it catches, what it would
catch if broadened). The name list is read from the cutover forward
(`WAREHOUSE_RULE_FROM_PERIOD_BY_LINE` — 2026-09, Pedia 2026-08), so no published month restates; a
code in `STORE_OVERRIDE_CUSTOMER_KEYS` would rewrite all of 2026 silently. Pin the neighbours in the
same PR. 🔴 **A name he rules that contradicts his 2026-09-06 decision sheet goes BACK to him, never
into the list** — طاى جروب (1,060,947.52 EGP over six accounts) is waiting on one word, and the 167
answers of that sheet are pinned in the required `validate` job. Twelve stems went in on 2026-10-09:
20 names, 374 rows, 435,133.42 EGP all-time, of which 51,022.72 actually changes hands.

Account, with the measurements and the government health-insurance depots that still split
wrongly: `docs/agents-owner-rules.md`, "The store-split rulings of 2026-10-09". 🔴 **That doc says
TWO depots and the real count is THREE, with one spelling wrong** — read live 2026-10-09 from
`source_of_sales_import_rows`: `فرع شرق الدلتا - المخزن الاقليمى العاشر من رمضان - تامين الصحي`
(23495), `فرع شرق الدلتا - المخزن الاقليمي القليوبية- تامين الصحي` (64845 — no space before the
dash, which the doc adds) and `فرع شرق الدلتا - المخزن الاقليمي شبرا الخيمة - تامين الصحي` (27863).
**All three are CNS-only — not one Anti Infective row ever** — so they cannot touch an Anti Infective
answer: 2026-09 holds 23495 in Dakahlia 4 (249 units, 8,889.30 EGP) and 64845 in Qalubeya (200 units,
7,140.00 EGP); 27863 last sold in July. Carry this correction into the next PR that opens on this
thread. Pinned by
`tests/store-split-owner-rulings-2026-10-09.test.ts`. Related: [[sos-monthly-closing-is-the-only-sales-truth]],
[[publishing-one-line-freezes-the-whole-periods-store-split-net]].
