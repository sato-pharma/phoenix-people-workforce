---
name: outstation-chained-governorate-journey-fuel-rule
description: "OWNER RULE 2026-10-18 (SHIPPED: PR 6094 merged 2026-10-19 00:20 Cairo, live 00:31 as 5b32023d; SUPERSEDED 2026-11-03 on two points: NSMs now take a location-only stop paid by drive, and the stop is captured at the top of Submit Expense; columns live on staging+production) — a car journey that moves governorate to governorate (home → Fayoum overnight → Beni Suef → home) pays each drive ONCE, one way, km × 1.8; a drive between governorates counts only over 40 km; when every stop after home is in ONE governorate (Assiut → Dairut) today's home × 2 rule stays. Allowance and the 60 km minimum unchanged."
metadata:
  node_type: memory
  type: project
  originSessionId: 62c465b6-61d2-4d90-9bfa-cddd1afecbe3
  modified: 2026-10-18T21:10:00.000Z
---

Decided by the owner on 2026-10-18 (Cairo evening), in his words: "من المنيا للفيوم هتضربها في 1.8 … من الفيوم لبني سويف … في 1.8 … من بني سويف او من النقطة اللي هو بيعمل فيها للمنيا … في 1.8 … بس الكلام ده لو من محافظة لمحافظة" and "this will apply if between the governorate and the governorate is more than 40 km". On the Assiut → Dairut example: "Dairut is in Assiut, so it is not okay … example two, keep as today rule … example one, correct, totally correct."

**The rule (built 2026-10-18 — src/lib/outstation/chained-journey.ts, pinned by tests/outstation-chained-journey.test.ts):**
- Journey moves from one governorate to ANOTHER (Example 1): each drive pays once, one way, road km × 1.8 — home → stop 1 → stop 2 → … → last place he worked → home. A governorate-to-governorate drive counts only when it is over 40 km. A drive inside one governorate (Sinnuris → Fayoum city) pays nothing.
- Every stop after home is in ONE governorate (Example 2: Mallawi → Assiut → Dairut → Mallawi): NO change — today's rule, residence → captured place × 2.
- Allowance unchanged (by nights; one allowance per calendar day, already guarded). The 60 km trip minimum unchanged (I said so; he did not object). Car fuel only; bus/train stay on tickets.

**Why:** today every trip is priced residence → captured place × 2, so a chained journey is paid by luck — filed as two trips it pays a drive that never happened.

**The worked example he approved (Osama Mohamed, District Manager, Upper Egypt 1, trip 17–18 Oct 2026; road km = Google fastest route, as the system measures):**
- Today's rule (owner correction, same evening: "today rule doesn't count Bani Suif … from home to Sinuris, and from Sinuris to home"): 237.16 × 2 → fuel 853.78 + allowance 325 = 1,178.78 (request 276, as filed). Beni Suef is not counted at all. Do NOT present a "two separate trips" total as today's rule.
- New rule: 237.16 + 44.5 (Fayoum → Beni Suef) + 194.0 (Beni Suef → home) = 475.66 km → 856.19 + 325 = 1,181.19 — 2.41 more than today, and the Beni Suef stop is on record with its own photo.
- He then said "start building the new rule, but take all your requirements to make sure that no one abuses it" (2026-10-18).

**How it was built:** the employee adds a STOP (live photo + GPS) to his own undecided car trip from the expense submissions page; the server prices the legs with Google road km between photo positions and moves the claim by exactly the fuel change, before any decision. A trip with no stop prices exactly as today; old claims are never re-priced. Every abuse shape is a flag on the approval reason; a new car trip on a day a journey reached through a stop is held. Flag, never reject ([[system-flags-expenses-never-rejects]]). Kept separate from [[leave-the-outstation-module-out-of-the-photo-first-rule]] — this is a pricing rule he raised himself, not the photo-first rule.

**SUPERSEDED by the owner 2026-11-03 ("Location-only stop, paid by drive"; `journey-stop-rules.ts`). Until then: National Sales Managers keep today's price (owner decision, 2026-10-19 ~00:30 Cairo).** An NSM's claim is accepted on submit (never held), so he can never add a stop and is always priced home to destination and back. Asked as a choice, he picked "Keep today's price": nobody reviews an NSM claim, so stop flags would reach no approver, and an accepted payroll row must never move. Two NSMs filed 18 car trips 7 Jul–14 Oct 2026. Do NOT build NSM stops or re-pricing of an accepted claim, and do not re-raise it.

**Live:** production revision 5b32023d from 2026-10-19 00:31 Cairo. The employee journey summary was browser-verified with an in-memory sample (619 px, 375 px, 1280 px; no overflow; square corners).
