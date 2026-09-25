---
name: the-sales-geography-has-no-governorate-layer
description: "Sales geography is areas and bricks only - there is NO governorate column anywhere, and the area NAMES are too inconsistent to derive one; the shared place vocabulary lives in src/lib/geo/egypt-locations.ts, not in sales"
metadata:
  node_type: memory
  type: project
  originSessionId: 0ef3c838-df3a-4112-ac74-bca2e15e4f4b
  modified: 2026-08-26T22:53:04.305Z
---

**There is no governorate layer in the sales schema.** `source_of_sales_areas` has `area_code` /
`area_name`, `source_of_sales_bricks` has `brick_name` -> `area_code`, and that is all. Checked
`information_schema` live 2026-08-27: the only `%governorate%` columns in the whole database belong
to ATS, hiring profiles and marketing — **none to sales**. So any rule phrased in governorates (the
owner's weekly split rule, [[weekly-anti-infective-ue-is-95pct-of-all-unmapped-value]]) needs that
grouping constructed, and it has to be stated somewhere explicit.

**Do not derive it from the area names.** Stripping a trailing number works across Upper Egypt and
lies almost everywhere else. Of the 46 live areas:

- `Gharbia 1 (Tanta)` / `Gharbia 2 (Mahalla)` — the number is mid-string, so nothing is stripped
- `Alex East` / `Alex Center` / `Alex West`, `Down town`, `Cairo West` — no number at all
- `Giza - Giza Centers`, `Dokki - Mohandseen - Bolak`, `Haram - Faisal`, `October -Zayed`
- `Port said - Domiat` — **one area covering TWO governorates**
- `Aswan (Legacy)` beside `Aswan`, and `Hurgada` beside `Red Sea` — duplicates within a governorate

The grouping now lives in `src/lib/sales/weekly/governorates.ts`, keyed on area **CODE** (stable)
with the name heuristic kept only as a fallback for a future area that follows the convention.

**The place vocabulary already existed — do not write another one.**
`src/lib/geo/egypt-locations.ts` is, in its own words, the single source of truth for turning
free-text / Arabic / English place strings into one governorate; it consolidated three separate
copies once already. It exports `placeAliases` (27 canonical labels plus Arabic and town aliases)
and `resolveGovernorate`. **I wrote a fourth copy before finding it and had to throw it away.**
Consume `placeAliases`; keep only spellings that exist nowhere but distributor branch names local
(`bhr`, `kafr elza`, `shebien`, `bani suwa`, `menya`, `domiat`), because that table also drives
expense and HR resolution and a two-letter token is not safe in free text.

Its canonical spellings are the join token, and they are not the ones the area names use:
**`minya` not "minia", `assiut` not "Assuit", `kafr el-sheikh` with the hyphen.**

**A district name can BE an area, and that difference is money.** `امبابه` is GZ3, not a hint about
Giza — reading it as a governorate spread EGP 2,235,364 across six areas, five of which the name
never mentioned. Same for `الهرم`/`فيصل` (GZ4), `طنطا` (D14), `المحله` (D15), `وسط البلد` (CA5).
A town that is merely *inside* a governorate must NOT be listed that way: Mansoura and Kafr El
Zayat are not areas, so they correctly resolve to the whole of Dakahlia and Gharbia.

**How to apply:** before adding any place-name matching anywhere in this repo, import from
`src/lib/geo/egypt-locations.ts`. Before writing a governorate rule for sales, remember the layer
does not exist in the data and check `governorates.ts` first. And never trust a `%ملو%`-style
substring search across the two vocabularies — the brick table spells Mallawi `ملاوى` while the
branch spells it `ملوى`.
