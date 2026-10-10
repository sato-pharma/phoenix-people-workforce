---
name: epda-pharmacies-22199672-was-split-into-two-pharmacies
description: "His 2026-10-10 ruling split EPDA-Pharmacies 22199672 — El Amreya keeps it, Tanta became 22199672-2 — and 22198955 is the one code still shared, blocked because its second shop carries Anti Infective in a locked July"
metadata:
  node_type: memory
  type: project
  originSessionId: abf9f7ad-6d41-471f-84f7-43a58d29f3a1
---

EPDA-Pharmacies (`EP-PHS`) code **22199672** was two pharmacies: **يحيى - العامريه** (El Amreya,
Alex West, brick B152-2) and **احمد فتحى احمد - طنطا** (Tanta, Gharbia 1, brick B193-1). Because the
map key is the PAIR (distributor_code, customer_code) with a UNIQUE index, one code could hold only
one brick, so Tanta's units were credited to Alex West whenever the book carried no address — and
the directory rollup, keyed per product, MERGED both shops into one row with one name (July read 4
units of Lacto Basic 2 under the Tanta name, 3 of them El Amreya's).

**His ruling, asked as multiple choice and answered 2026-10-10:** El Amreya keeps `22199672`; Tanta
becomes **`22199672-2`** — he chose the numeric suffix over keying it by name (how QM and PS
customers are keyed) and over a minted `EP-PHS-TANTA-01`. It is the first customer code in the map
containing a dash.

Done on production: the map row for `22199672-2` inserted (B193-1 / D14 / D1, source
`owner-code-split-2026-10-09`), `22199672`'s empty name and address filled with El Amreya's, the three
Tanta import rows re-coded and their July/August brick, area and region corrected, and **holds 3573
and 3574 REJECTED** — both had tried to move the whole code from Alex West to Tanta — with the lock
stamping `22199672` as `owner-ruling-2026-10-10-hold3574`, confidence 100.

🔴 **Only September is derived-correct.** July and August's rollups still show the merged shape,
refused by their own closing locks — see
[[a-locked-closing-blocks-a-rollup-rebuild-on-an-unlocked-line]]. No closing figure moved: all six
rows are Head Office.

**Why:** the next shared code must not be split the same way blindly.

**How to apply:** the sweep that finds them is two areas AND two distinct `phx_normalize_arabic`
names on one (distributor, code) — two areas alone is mapping drift, and is 442 codes across Jul–Sep
2026 with ZERO of them two-named. Exactly one other is genuinely shared: **EP-PHS 22198955** —
رضا البسيونى - زفتى (Gharbia 2) and ثابت محمد لافى - المرج (Cairo East 2), whose El Marg row is
**Anti Infective, July 2026, 222.30 EGP in a LOCKED and published closing**, so splitting it moves
reported money and waits for him on the Monthly Closing screen.
