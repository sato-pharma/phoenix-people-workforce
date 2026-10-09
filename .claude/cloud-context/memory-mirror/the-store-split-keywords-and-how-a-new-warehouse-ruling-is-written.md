---
name: the-store-split-keywords-and-how-a-new-warehouse-ruling-is-written
description: "The complete keyword inventory the store/pharmacy split is decided by — six store words, two start-only prefixes, the two-half trade phrase, eleven never-store words, five override lists — and the rule that a NEW ruling is written as a NAME in STORE_OVERRIDE_NAMES, counted on production both ways first, never as a code — while a GOVERNMENT ruling is a NEVER_STORE word instead, as the تامين الصحي depots were on 2026-10-09 — nine of the 26 تامين accounts split, not the seven first reported, because تأمين with a hamza does not match a raw like '%تامين%' and the classifier folds it while SQL does not."
metadata:
  node_type: memory
  type: project
  originSessionId: d5764c39-c02c-4dd4-a40d-70ad08cc490c
  modified: 2026-10-09T19:11:01.753Z
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
into the list** — the 167 answers of that sheet are pinned in the required `validate` job, and when
he overrides one the later answer stands, the fixture carries it and the sheet itself is left
untouched. **طاى جروب is the sixth such reversal and it is SETTLED: "split طاى جروب too, it
overrides the Sep 6 sheet" (2026-10-09), so its four sheet accounts flip to warehouse and the pin
reads 79 warehouse / 72 pharmacy** (PR 5687). Twelve stems went in on 2026-10-09 off column C — 20
names, 374 rows, 435,133.42 EGP all-time, of which 51,022.72 changes hands — and the thirteenth is
طاى جروب, out of Alex Center into Alexandria's thirds (AB1 Alex East, AB2 Alex Center, AB3 Alex
West — evenly, because the banded El Qema rule is Pedia-only). 🔴 **RE-MEASURED LATE ON 2026-10-09
AFTER THE LAST BOOKS LANDED, AND THE 16:40 READING OF "11 rows / 20,025.30 EGP" IS STALE: September
CNS is 20 rows / 460 units / 31,027.80 EGP on four accounts, of which two thirds — 20,685.20 EGP —
deals out to Alex East and Alex West.** 🔴 **AND A HEAD OFFICE SLICE APPEARED THAT IS 72% OF
EVERYTHING THE STEM REACHES** — «طاى جروب - الاسكندرية» (22197684, EP-PHS) filed 4 rows / 380 units /
79,515.00 EGP on Head Office. It classifies as a store and moves nothing, because
`isSplitEligibleLine("Head Office")` is false; the exposure is in the REPORTING — quote the stem
without filtering the line and the ruling's reach reads three times its real size. 🔴 **ITS STEM IS
TWO WORDS BECAUSE A ONE-WORD ARABIC STEM CAN BE A SUBSTRING OF A TOWN
NAME** — `طاى` sits inside `مطاى` (Matay) in 60+ Minia pharmacy names, and inside `مصطاى` and
`نهطاى`; the test proves it by widening the stem to bare `طاي` and watching `هيثم اسامة مطاى` fail.
Check a candidate stem against the town and village names in the customer list, not only against
other companies.

🔴 **A GOVERNMENT RULING IS A `NEVER_STORE_KEYWORDS` WORD, NEVER `STORE_OVERRIDE_NAMES`** — one
REFUSES a split, the other CREATES one. **"the three تامين الصحي depots are government, never split
them"** (owner, 2026-10-09) is the word `تامين`, shipped in PR 5689: `ت.ص` could not reach a name
that spells تامين الصحي out in full while carrying `مخزن`. Counted both ways on production first —
it reaches **26 accounts, every one a health-insurance body, branch, depot or clinic, NOT ONE a
wholesaler**, of which **nine split** — his three (23495 العاشر من رمضان, 64845 القليوبية — its dash
runs onto the word with no space, 27863 شبرا الخيمة) plus 139383 منوف, 66085 بنى سويف, 139359 جديلة
and 139062 سوهاج, the same kind of depot, so his ruling reaches them too; the bare `امين` would add
**257 PEOPLE called أمين**, none carrying a store word. 🔴 **IT IS NINE, NOT THE SEVEN FIRST
REPORTED, AND THE TWO MISSED ONES ARE A SPELLING — `تأمين` WITH A HAMZA DOES NOT MATCH A RAW
`like '%تامين%'`.** The classifier folds أ/إ/آ/ى/ة before it matches and a SQL sweep does not, so the
audit's own query could not see 781 «للتأمين الصحي … المخزن الاقليمى» — 1,827 units / 65,596.65 EGP,
the LARGEST of the nine, July and August only out of Helwan-Maadi on RM-T — or 3430120 كفر الشيخ,
which landed 10:44 Cairo the same day. Both were refused correctly all along; only the count was
wrong. **Normalize in SQL (`translate(name, 'ىأإآة', 'ياااه')`) or the sweep under-reports.** Both are
pinned now. 🔴 **A never-store word needs NO cutover gate — `legacyIsStoreCustomer` never reads
one**, so no published month restates: the live movement is **207 units / 7,284.71 EGP of September
CNS held in the rep's own area** — 124.5 units / 4,444.65 EGP that would have gone to Sharkia 2 from
23495 (**D24 Sharkia 1**, never Dakahlia 4 as the doc said) and 82.5 units / 2,840.06 EGP that would
have gone to Kafr El-Sheikh 2 from 3430120. Qalubeya is a one-area city so its depot moved nothing;
781 sold only in published months; the rest hold no row at or after the cutover. Two further
September rows reach the word and never split anyway (21000166 سوهاج, 512 بنى سويف carry no store
word), so the credit is the 207 units, never the 706 the word touches. All nine are CNS-only — never
one Anti Infective row.

Account: `docs/agents-owner-rules.md`, "The store-split rulings of 2026-10-09". Pinned by
`tests/store-split-owner-rulings-2026-10-09.test.ts`, proven by breaking it three ways. Related:
[[sos-monthly-closing-is-the-only-sales-truth]],
[[publishing-one-line-freezes-the-whole-periods-store-split-net]].
