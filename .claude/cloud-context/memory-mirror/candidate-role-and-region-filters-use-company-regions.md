---
name: candidate-role-and-region-filters-use-company-regions
description: "The recruitment pool's Region filter groups candidates by the company's own au.regions vocabulary, not plain geography — owner decision 2026-08-24 — and the Role filter exists because the search box misses 9 of 27 district managers"
metadata: 
  node_type: memory
  type: project
  originSessionId: 537fc03b-b5ff-42fb-97fb-d85a6ab08c3b
  modified: 2026-09-11T23:34:56.951Z
---

Shipped 2026-08-24 in #2393 (`91ea20b9`) on both the Recruitment pool and the CV Database.
`src/lib/recruitment/candidate-region.ts` and `candidate-role-family.ts`.

**OWNER DECISION, asked directly: Region means the COMPANY's regions, not geography.** The two
answers differ by a lot — geographic Upper Egypt is 56 candidates, the company's Upper Egypt is 40.
So Beni Suef and Fayoum sit in **Giza**, and Aswan and Luxor sit in **Others**, exactly as they do in
the Organogram and on every sales screen. Labels are verbatim from `au.regions.region_name`
(Alex-BHR · Cairo · Delta (1) · Delta (2) · Giza · Others · Upper Egypt). Do NOT "fix" this toward
real geography — see [[owner-office-allocation-rule-value-share]] for the same house rule elsewhere.

🔴 **AREA rulings on candidate-typed place names — the same house rule one level down.** An applicant
types their area by hand in WhatsApp, so the text is rarely one of the 49 canonical areas, and
[[territory-is-not-geography]] applies: the owner's area vocabulary outranks your map of Egypt.

- **Badr City is `Nasr City`.** Owner ruling 2026-09-11, asked directly and answered in five words.
  Geographically Badr City is a separate new-cities settlement well east of Nasr City, so a session
  reasoning from a map reaches Cairo East 1/2 and is wrong. Do not "fix" it toward geography.

**How to apply:** never infer one of these from the address, the governorate or the typed text — ask,
per the standing XLSX-with-dropdowns rule, and file nothing until he answers. A governorate typed
alone (`kafrelsheikh`, `El Minya`, `Qena`) does NOT choose between that governorate's `1` and `2`
areas; treat a suggested `1` as a default awaiting his word, never as a reading of what they wrote.

**Why a Role filter and not the search box.** Searching `district manager` finds 18 of the 27 people
whose title says it: three CVs spell it **"District Manger"** and six read **"District Sales
Manager"**, which does not contain the substring. `normalizeJobTitle` repairs *manger* before
matching. The owner's actual ask — Upper Egypt district managers — returns **16**; the search box
would have returned **11**.

**Both filters are three-way on purpose.** 249 of 426 candidates have no job title and 159 no
governorate. "We were never told" is a different answer from "none of the above", so each dropdown
ends with an explicit *No job title on file* / *No governorate on file*.
`candidateRegionForGovernorate` returns **null**, never `"OT"`, for an unrecognised value — Others is
a real selling territory, not a dumping ground. Related:
[[the-medical-rep-cv-schema-reads-12-fields-universal-reads-38]] for why so many titles are blank.

**Deliberately NOT a family: Sales.** Sales Manager, Key Account Manager and Sales & BD Manager fall
into Other. They are sales roles but not district managers; adding a family is a one-line change if
the owner ever asks. Also deliberate: no bare `\bmr\b` pattern — it is the honorific far more often
than Medical Rep.

**How to apply:** measured live at 375px and 1280px with the static-harness method
([[verify-a-mobile-layout-without-a-dev-server]]) because production redirects to sign-in without a
session — page `scrollWidth` equalled the viewport at both sizes, every option fits its select with
22-23px of headroom, `text-overflow: clip` not ellipsis, and the control case overflowed 628 vs 375
so the zeros meant something.
