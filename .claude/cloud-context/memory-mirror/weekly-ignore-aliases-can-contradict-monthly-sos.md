---
name: weekly-ignore-aliases-can-contradict-monthly-sos
description: "Weekly and monthly keep SEPARATE product alias tables, so a weekly IGNORE can delete a product monthly maps to a real code — always diff the two before trusting a weekly number"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6b612b65-4e36-471e-997c-1c2d24313b24
  modified: 2026-08-15T12:10:16.200Z
---

**The parser side is LIVE on prod since 2026-08-15 (#2153, merge `0467e289`, confirmed by
`/api/healthz` revision) — do NOT undo:** a weekly alias resolving to `IGNORE` is dropped from the
facts and listed in `excludedItems` with rows/net/stock, and raises no failure. A genuinely unpriced
REAL master still blocks — only the sentinel is exempt.

`weekly_sales_product_aliases` and `source_of_sales_product_aliases` are **two independent tables**.
Nothing reconciles them, so the same distributor item code can be a real product monthly and
`IGNORE` weekly — and the weekly side then deletes it with no error anywhere.

**Why:** on 2026-08-15 the owner mapped 6 weekly aliases to `IGNORE` to get past a blocked Overseas
upload (the weekly parser had no `IGNORE` handling and failed with *"Master product IGNORE has no
factory price"* — fixed in #2153). Three of the six contradicted his own monthly mapping, set back in
June/July:

| Distributor | Code | Product | Monthly says |
| --- | --- | --- | --- |
| Overseas (PS) | 14561 | **Rispadex 3 mg** | `RI002` · CNS · 34.425 — 10,653 units via PS Jan–Jul |
| Overseas (PS) | 35204 | **Royanoxicam 8 mg** | `RY001` · Head Office · 42.00 |
| Ibn Sina Sato (IS-S) | 638105 | **Royanoxicam 8 mg** | `RY001` |

The other three are genuinely other manufacturers': Trencedia (13512), Vonopep (35098 — Ramco's file
labels it *فارما كيم*/Pharma Kim), Lacto LF (47057 — the Phoenix Lacto range is Advanced 1/2 and
Basic 1/2, there is no LF).

**How to apply:** before trusting any weekly figure, diff the two alias tables for the same
`(distributor, code)` and treat every disagreement as a defect — monthly is the sales truth
([[sos-monthly-closing-is-the-only-sales-truth]]). Watch the near-miss brands especially:
**Anoxicam** 20 mg is Pharma Kim's and correctly ignored, **Royanoxicam** 8 mg is ours
([[never-silent-drop-count-and-flag-instead]], [[ignore-alias-deletes-and-the-manual-closing-decides]]).

**Status 2026-08-15 — all three corrected in prod, owner-approved, do NOT undo:** PS `14561` →
`RI002`, PS `35204` → `RY001`, IS-S `638105` → `RY001`. The three surviving weekly `IGNORE`s (13512,
35098, 47057) all agree with monthly.

**"Zero conflicts" was WRONG — a narrow diff of the IGNORE rows only.** A full join of all 34 codes
aliased in BOTH tables found **2 conflicts**. Never diff only the `IGNORE` side; join the whole
overlap. Sent as an XLSX with dropdowns and **ruled by the owner the same day, applied to prod, do
NOT undo**:

| Distributor · code | Was (weekly) | Monthly says | Owner ruled | Applied |
| --- | --- | --- | --- | --- |
| PS `32328` | `DO002` Dopaminect 1mg 36.45 | `IGNORE` | **`DO001` Dopaminict 1mg UPA · 35.70** | 8 rows re-priced, 7 headers moved −1,704.00 total |
| RM `64774` | `TE004` Tebofortin 240 max | `TE005` | **`TE005` Tebofortin 120 Intens** | 2 rows, zero value, headers unmoved |

**He answered with a THIRD product neither table held** — write the answer column so a free-text Note
can override the dropdown, and read the Note. `DO001` is the **UPA/tender** pack: every `32328` row
sits on a tender branch (`مناقصات شراء موحد`, `مناقصات العبور`), and the distributor's own name is
*دوبامينكت 1مجم 20قرص هـ ش 28*. Cross-check that held: 2,272 units × (36.45 − 35.70) = 1,704.00
exactly, and 2,272 × 35.70 = 81,110.40.

**RESOLVED the same day — monthly PS `32328` `IGNORE` → `DO001`, applied to prod, do NOT undo.** It
was a FOSSIL that contradicted the owner's own recorded ruling. The monthly `import_rows.raw_row`
for those 6 July rows literally stores it:

```
flag: "SUSPECTED DUPLICATE of the same PS-T tender line"
ruling: "owner-2026-08-10 count-dont-drop"   source: "reinstated-from-ignore"
```

Timeline: Jun 25 code alias created · Aug 9 00:15 **name** alias `دوبامينكت 1مجم 20قرص هـ ش 28` →
DO001 · Aug 9 21:35 a cleanup set the **code** → IGNORE · **Aug 10 20:17 the owner reversed it**
("count-dont-drop") and the rows were reinstated as DO001. The code alias was never re-pointed. It
was inert only because the monthly PS file resolves by NAME — but **no `import_rows` row anywhere
carries `product_code='IGNORE'`, proving IGNORE deletes rather than marks**, so a PS file arriving
with the code would have silently dropped exactly what he ruled must count. Changing the alias moved
**zero** stored facts (July PS DO001 stayed 212 units / 6 rows); it only guards future imports.

**When an alias looks wrong, read `import_rows.raw_row` first — the owner's past rulings are recorded
in it** (`ruling`, `source`, `flag` keys). Search `raw_row->>'source' = 'reinstated-from-ignore'`.

## RM had a systematic Tebofortin Max/Intens SWAP — 4 aliases, all fixed on prod 2026-08-15

Only found once the diff joined **name** aliases too, not just codes. RM weekly mapped the Arabic
text backwards, while monthly maps the identical strings correctly, and PS and IS both agree with
monthly:

| RM weekly alias | Was | Now |
| --- | --- | --- |
| code `64774` | TE004 | **TE005** (the owner's ruling) |
| code `64773` | TE005 | **TE004** |
| name `تيبوفورتين انتينس 120 مجم 30 قرص` | TE004 | **TE005** |
| name `تيبوفورتين ماكس 240 مجم 30 قرص` | TE005 | **TE004** |

Zero value moved (all 4 stored RM rows are stock-only), but the aliases were live: the next RM upload
would have priced Intens at 150.90 and Max at 124.34, a ~21% error each way. The consecutive-code
pattern is the tell — PS `55927`/`55928` and IS `679749`/`679750` are both Max/Intens in that order,
so RM having `64773` and `64774` on the SAME product was impossible.

**The full weekly↔monthly alias diff is now empty** (all distributors, codes AND names).

**An alias fix does NOT reach stored rows** — `healUnresolvedWeeklyRows` only heals rows in state
`warning`, and a re-labelled row is `valid`. Stored rows must be re-pointed by hand.

**Done 2026-08-15, owner-approved, do NOT undo:** the 48 stored June rows (weeks 3–4) for PS `35204`
re-pointed `IGNORE` → `RY001` / `ROYANOXICAM 8MG 20 TAB` / Head Office, `sales_value = net_qty * 42`
(24+24 rows, 14 net units, +588.00 EGP). The two `weekly_sales_batches` headers were bumped by the
same +168 / +420, because **`total_sales_value` is a stored header, not a view** — re-point rows
without it and the batch list disagrees with its own rows.

Of the 518 June Overseas rows re-labelled `IGNORE` that day, exactly those 48 were wrong. The
remaining **470 are correctly ignored** (Vonopep 35098 · 174 rows, Trencedia 13512 · 156, Lacto LF
47057 · 140) and are the ONLY `IGNORE` rows left in `weekly_sales_rows`. They still carry 1,390 net
and 4,174 stock units at zero value in the June weekly dashboard — future uploads exclude such rows
outright, so June counts units August will not. Owner has not ruled on that gap.

**Proof the fix works end to end:** he re-uploaded the blocked Overseas file at 11:13 UTC and it
validated — batch `3df84b58`, 2,315 rows, RY001 priced at 42.00.

**The two June batch headers sit ~4,738.50 BELOW their own row sums** (4738.496575 and 4738.498910),
a gap that predates all of this and was unchanged bit-for-bit by the re-point. Cause unknown, ~0.02%.
Do not "fix" it blind — nearly the same figure in two independent batches means one systematic cause.
