---
name: ep-phs-reuses-one-client-code-for-different-pharmacies
description: "Distributor EP-PHS sends one client_code for several unrelated pharmacies, so its sales land on whatever brick the map row happens to hold"
metadata: 
  node_type: memory
  type: project
  originSessionId: faedc714-ba73-4daa-a9e9-810ee2b0f383
  modified: 2026-08-23T12:52:48.555Z
---

Found 2026-08-23 while backfilling `source_of_sales_customer_map.customer_name`. **232 EP-PHS
client codes each carry two or three completely different pharmacy names** across months — not
spelling variants, different businesses in different towns. EGP 1,890,302.76 across 2,066 invoice
rows sits on them. Only **26** of the 232 surfaced during the backfill (those were the ones whose
map row was still unnamed); the other 206 already carried a name and were never flagged.

**EP-PHS is the ONLY distributor with this defect — checked all 8 on 2026-08-23.** 603 codes
company-wide carry more than one name, but the test that matters is whether the two names' invoice
windows **overlap**:

| | codes with 2+ names | unrelated names | **concurrent (the defect)** |
| --- | --- | --- | --- |
| EP-PHS | 232 | 228 | **168 — EGP 1,579,962 over 1,767 rows** |
| PS | 224 | 5 | **0** (all 5 sequential renames) |
| IS | 108 | 9 | 0 |
| EG / IS-S / EP-BK / SF | 38 | 2 | 0 |

**Do not repeat the "EGP 8.9M at risk" figure** — that was the raw multi-name total and it was
wrong. A name that *succeeds* another on the same code is a rename or ownership change and is
benign; only an overlap means two pharmacies invoicing under one code at once.

Method that produced this (pg_trgm is installed on prod): bucket by `similarity(a,b) < 0.30` AND
neither name containing the other, then test `a.p_min <= b.p_max AND b.p_min <= a.p_max` on the
invoice periods. Validated against 34 hand-inspected codes — it agreed on every one.

Examples: `22198335` is both
`سهيله جبالى الجديده - الوراق` and `الجمعية الشرعية - 6 اكتوبر` (EGP 81,270); `22199483` is both
`عمرو جلال - بريم` and `الوليد فارما لتجاره الادويه` (EGP 146,475); `22198892` is
`مروه محمد - سنديون` and `الامانة - اشمون`, 16 rows each.

The mapped brick frequently matches **neither** name — code `22198366` sits on brick `طنطا` while
its three names say امبابه, التحرير and فيصل.

**Why:** every one of those invoices is attributed to the single brick/area on that map row, so a
reused code silently credits one pharmacy's sales to another's territory. This is an attribution
defect, not a cosmetic naming one, and it is invisible to any check that only looks at whether a
name exists.

**How to apply:** never resolve one of these by "picking the most recent name" — that mis-credits
the other pharmacy. The code needs splitting per real customer. Contrast with the 8 `EG`/`IS-S`
conflicts found the same day, which ARE cosmetic (distributor appends notes like `محظور سموم` or a
trailing `/`) and are safe to normalise. The decision workbook is `xlsx/ep-phs-shared-codes-2026-08-23.xlsx` - **all 168 concurrent codes,
349 pharmacy rows**, one row per name with its active window, its value, and the exact months two
names overlapped (155 codes carry 2 names, 13 carry 3). It is gitignored, so it is not committed.

An earlier 34-row cut, `customer-name-conflicts-2026-08-23.xlsx`, was superseded by it and **the
owner had it deleted on 2026-08-23** - confirmed gone from disk. That was his explicit call, made
twice; the standing "never delete an .xlsx" rule is about agents deleting files on their own
initiative, not about the owner disposing of his own superseded file. Nothing was lost: its 26
EP-PHS codes are all in the 168-code workbook, and the 8 cosmetic `EG`/`IS-S` conflicts it also
listed are re-derivable from the database by query. Related: [[a-narrowed-select-disarms-every-gate-downstream-of-it]],
[[sos-bricks-are-the-authority-for-branch-to-area]].

## CORRECTION 2026-08-23 — "different pharmacies" is NOT proven

The owner challenged the workbook's premise and was right. A full column audit of the EP-PHS import
file found **`cust_address` holds exactly the same 740 distinct values as `cust_name`, and all
1,069 rows have the two byte-identical** — the "address" column is a copy of the name. So the claim
"every pair has a different address, therefore two different shops" was true *by construction* and
proved nothing, yet it was presented as independent corroboration. `who_me` has **1 distinct value**
("2"), so it is not a composite key either. The 7 rows that looked mismatched were manual
reconciliation rows (`kind: ped-ep-recon`, `source: manual-closing-2026-02`), not file rows.

**What IS still established:** the file has 11 columns, only `cust_name` carries identifying
information, the importer maps every column correctly (1,069/1,069), and **43 of 699 file-verified
codes carry two concurrent names** — all inside the 168. What is **NOT** established is whether
those are two real pharmacies, one pharmacy written two ways, or a bad lookup in the sheet the
importer reads (named `Coded`, implying codes are assigned in a preparation step upstream).

**How to apply:** do not repeat "two different pharmacies on one code" as fact, and do not use the
address column as evidence of anything. The only untried independent source is
`marketing_pharmacy_reference` — test the 168 against it before asserting the split is real.
