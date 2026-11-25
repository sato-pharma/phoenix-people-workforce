---
name: when-he-says-do-it-claude-does-it-from-the-code
description: "Validate X / link X / merge the copies / fix that record" means Claude does it ITSELF, from the code on this laptop - never in his Chrome, never through a running app's screens, never as click-by-click unless he asks for steps - and leaves the recipe behind so the next session does not rediscover it.
metadata:
  type: feedback
---

His words, 25 Nov 2026 23:22 Cairo: when he says "validate this" or "do this", he wants it done **from the code**, not "from the system"; every time he asks, the session acts as if it has never done it before.

What went wrong on 25 Nov (session 6c7fe3eb, Dr Othman El Shewehy's pharmacies for Sahar ElGallad): about 5 minutes re-reading `src/lib/marketing-requests/service.ts` to find how a link is made. Then the job ran as an HTTP POST to the SPARE's running dev server with dev-auth headers, which failed when the spare's Wi-Fi dropped. Nothing was written down, so the next request starts from zero. On 23 Nov another session saved a validation in his Chrome under the wrong employee ([[never-save-a-production-form-he-asked-steps-for]]).

**Why:** he is the system administrator and owner; the work is his to order and Claude's to carry out. Going through screens is slow and fragile, it acts under someone's name, and it is the opposite of what he asked for. Re-deriving the method every time is what he experiences as "you forget".

**How to apply:**
- His verb is the order: do it yourself, against production, from this laptop. Run the app's OWN `src/lib` domain function (the same code a screen calls) so its checks still apply. Use a `node --experimental-strip-types --import ./tests/register-alias-loader.mjs` script, or the route's handler logic, never his browser.
- Prefer a COMMITTED script in `scripts/` over a scratch one. On 2026-10-09 the safety check refused a scratch node script that fabricated a Super Admin viewer ("Security Weaken"). A reviewed script that his message orders by name is the durable path. Until one exists for the job, the spare's dev-server route with dev-auth headers is the fallback. It is fragile: the spare's Wi-Fi drops. Say so when you use it.
- Click-by-click steps only when HIS message asks for steps. Then do not also save it yourself.
- **Start from the recipe book, then add to it:** `docs/owner-operations-recipes.md` in the repo holds every operation done for him: the route or function, the input shape, the ids, and the proof read. READ IT FIRST. After doing anything new for him, add its recipe there in the same turn. The marketing desk-entry link, the venue merge and the map pin are already in it (25 Nov).
- A refusal on the way is reported as [[a-refusal-is-named-never-unexplained]] says.
