---
name: a-wrong-distributor-code-is-a-typo-not-a-rep-gaming-you
description: "A marketing capture whose distributor code sits in another governorate is a transcription error, not a rep attaching a convenient pharmacy — measured across all 127 validated links: median 23 m, max 1,069 m, zero over 2 km"
metadata:
  node_type: memory
  type: project
  originSessionId: f151c304-4f1a-4527-86ae-ce961d80f72e
  modified: 2026-09-29T19:00:29.764Z
---

The owner asked directly on 2026-09-29, after two captures were held on a governorate
mismatch: *"عايز اعرف دلوقتي الغلطات دي في الكود ولا الريب بيشتغلني"* — are these code bugs,
or are the reps exploiting a hole? **It is the code. Measured, not assumed.**

**The distances refute gaming outright.** Across every validated customer↔pharmacy link
carrying GPS on both sides (127 of them): **median 23 m, p90 272 m, maximum 1,069 m, and
NOTHING over 2 km**; 102 of 127 sit within 100 m. A rep attaching a big-selling pharmacy
that is not really his doctor's would show up as distance, and there is none.

**Both real incidents were the right shop and the wrong number:**

- Samaa Shalaby, 2026-09-29: typed Ibn Sina `443359` (احمد عبدالشافى, Haram/Faisal, Giza),
  meant `442359` (اسعد جديدة, ناحية نشوة, الزقازيق) — **one digit**, and her clinic and
  pharmacy were **18 m** apart.
- Taha AboElftouh, 2026-09-23: typed POS `1510270`, a real pharmacy in شربين، الدقهلية,
  while standing at **house 75 of his doctor's own street** in 6th of October City — **59 m**
  apart, doctor at 74. The right code was `0001575484`.

**Nobody is farming one pharmacy either** — the most any shop is attached to is 3 customers,
and those are hospital pharmacies (Tabarak, مستشفى فيكتوريا) that genuinely serve many doctors.

**Why:** a session that finds a cross-governorate code and reports "the rep may be gaming
you" accuses a real person of fraud on evidence that actually says the opposite. The owner's
own standing rule is that a false positive is worse than a missed catch.

**How to apply:**

- Before calling any code mismatch suspicious, **measure the customer↔pharmacy distance**. A
  shop metres from the doctor is a typo on a real visit, whatever the code says.
- The **4 km hard block** (owner ruling 2026-09-29, `src/lib/venues/customer-pharmacy-distance.ts`)
  would have caught **neither** incident and must never be tightened in the belief that it
  fixes the wrong-code class — see [[the-marketing-code-resolver-never-re-runs]] for what does.
- What actually cures it is the GPS-ranked code picker shipped the same night (#4797): the
  right code ranks first instead of being typed from memory.
- The one place a rep genuinely could hide is a code that resolves to nothing, so no sale can
  ever be attributed — check those rather than the geography.
