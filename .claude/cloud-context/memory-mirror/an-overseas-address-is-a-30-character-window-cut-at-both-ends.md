---
name: an-overseas-address-is-a-30-character-window-cut-at-both-ends
description: "An Overseas (PS) customer address can be cut at the START as well as the end — \"اء الدي منقباد…\", \"قوس قرية الروضه\" (فاقوس), \"فرالدوار\" (كفر الدوار) — so an address matcher must accept a first word that is the tail of a place name, or it flags pharmacies that sit in the right place."
metadata:
  node_type: memory
  type: project
  originSessionId: 6075d72b-01d8-4f66-9482-038b547019af
  modified: 2026-10-13T00:19:52.069Z
---

Measured 2026-10-13 while hand-checking a random sample of address-vs-brick "wrong area" flags on production.

The 30-character cap on Overseas addresses (see [[sos-client-address-is-inferred-not-from-distributors]]) is not only a cut at the end. Some rows are a 30-character window out of a longer address, so the FIRST word is also cut: `اء الدي منقباد ش الوحدة المحلي`, `ة المني ديروط أم نخله ـ مركز م`, `قوس قرية الروضه بجوار مسجد الم` (the town is فاقوس), `فرالدوار ابيس المستجده -ملك عص` (the town is كفر الدوار).

**Why:** a matcher that only forgives the last word reads `قوس` and `فرالدوار` as nothing. Then it takes whatever village name is left as the place and calls a correctly mapped pharmacy "wrong area". Two of the false flags in one sample of 60 had exactly this shape.

**How to apply:** when checking a PS (or other capped-feed) address against the mapped area, count it as naming that area when its first word is the tail of an area brick's name (drop one or two leading letters, at least 3 left). Count it the same way when a capped address ends in the first 4–6 letters of one. Use this only to say an address agrees with its mapping, never as evidence for a move. Matcher: `match.mjs` in the 2026-10-13 audit scratchpad, `namesMappedArea`.
