# Memory Index

**Module memory holds everything module-specific** — `.claude/rules/<module>.md` in the repo, loaded when a session works in that module (AGENTS.md §2.2, docs/module-memory.md). This index holds what is true everywhere, plus the inbox. Nothing is trimmed from it any more.

**Hooks only - the FILE is the fact. Rules: `AGENTS.md` §2.2.**
- [ARCHIVE](MEMORY-ARCHIVE.md) - the pre-2026-10-02 archive; every note in it is now filed in a module.

## 🥇 RULE #1 - never trim, never forget
- 🔴 [**`B-10` is the OWNER himself**](b-10-is-the-owner-himself.md) - sole Super Admin, so EVERY `decided_by` is his. Never advise him to "tell B-10" or notify him of his own decisions.
- 🔴 [**Monthly Closing** = the ONLY sales+target truth](sos-monthly-closing-is-the-only-sales-truth.md) - every surface reads ITS sales AND target (targets confirmed 2026-09-27); Weekly excluded; Marketing ROI the ONE exception.
- 🔒 [Head Office is in NEITHER weekly NOR monthly - unmapped is CORRECT](head-office-products-are-not-tracked-weekly-golden-rule.md) - tracked = **CNS · Anti Infective · Pedia** ONLY; HO is **90% of weekly VALUE**. NEVER flag or map it; ALWAYS filter before quoting a number.
- 🔒 [Lacto: family NAMES split; family_code still shared](lacto-advanced-and-basic-share-family-and-family-code.md) - `Lacto Advanced` (Pedia) + `Lacto Basic` (HO); no bare `Lacto`. **Both keep family_code=`LA` DELIBERATELY** - the direct-order basket allow-list; tidying it un-combines the order.
- 🔴 [NEVER add units of different products/concentrations](units-of-different-products-are-never-added.md) - a unit total is valid for ONE product_code only; above that aggregate by **VALUE**. Same for TARGET units.
- 🔴 [Head Office is ABSENT from `phx_monthly_achievement`](head-office-sales-are-absent-from-phx-monthly-achievement.md) - no rows ≠ zero: it rendered real July units as 0. Royanoxicam DOES return (line NULL), Lacto Basic and Satoslim do not. `direct_value` is NOT the sales value; HO has NO price, units only.
- 🔴 Pre-July: [reconcile per customer×product](closing-reconcile-per-customer-product-not-area-pre-july.md)·[CURRENT price + backfill targets](closing-pre-july-revalue-and-backfill-targets-at-phoenix-price.md)
- 🔴 [a price fix RESTATES every published month](a-price-fix-silently-restates-every-published-closing.md) - INTENDED; drift sees VALUE now, price outside the lock. **July AI stays as published (owner).**·🔒 [the matrix can NEVER fit; summary ships BESIDE it](monthly-closing-matrix-cannot-fit.md) - leave the scroll.

## In flight
- 🔴 Email: [NEVER bulk/test sends](never-fire-bulk-emails-ever.md)·[both cuts LIVE](email-inventory-audit-2026-08-13.md) - probation email OFF **except Day 30/60/75 → Yasmeena, cc B-10**·[every automated email ALSO pings his Telegram](every-automated-email-also-mirrors-to-the-admin-telegram.md) - a test send reaches him.

## Owner's rules (don't "fix" back)
- 🔴 [the Next step box is NOT a notepad](the-next-step-box-must-not-manufacture-the-next-task.md) - he SENDS what is in it. Never a task Claude invented; a shipped feature is DONE.
- 🔴 [hand HIM PowerShell, never bash](commands-handed-to-the-owner-must-be-powershell.md) - his Terminal rejects `&&` before anything runs.
- 🔴 [fix means fix - no unrequested work](fix-means-fix-no-unrequested-work.md)
- 🔴 [NEVER approve for the CEO](never-approve-for-the-ceo.md) - he INTERRUPTED his own "approve them both". The work up to the decision is mine; the decision is his.

## Traps that bite any session
- 🔴 **Never re-add a module fact here or to `AGENTS.md`** - it goes in that module's `.claude/rules/<module>.md`; session traps live in §2.1's clusters.


## Inbox — new notes land here

















Put each new memory note's pointer here, one line. The fold (`node scripts/module-memory/fold.mjs --apply`, three times a day — 09:00, 15:00 and 21:00 Cairo) files it under its module in ONE PR; once that merges, the next fold removes the line.




























- [an Anthropic key with no workspace answers 400 on every call](an-anthropic-key-with-no-workspace-answers-400-on-every-call.md) - 2026-10-18: the key he first pasted authenticated but every Messages call returned 400 "must include the anthropic-workspace-id header", so the OpenAI failover would have failed silently; pick a workspace when creating the key, set it on BOTH Railway services that hold OPENAI_API_KEY (web + worker), prove it with a live railway-run call.
- [a "cannot load" report can be the login check, not the module](a-cannot-load-report-can-be-the-login-check-not-the-module.md) - 2026-10-18: the Talent Acquisition seat's recruitment page read fine afterwards; the real failure was "Session verification is temporarily unavailable" at 10:57 while production timed out (4th hard restart in 6 days). Run the seat's reads, then the login-check errors at that minute, then `database_restarts`. Restart alert records BEFORE it alerts: the 17 Oct restart has no alert row.
- [a pharmacy is findable through two rows; marketing also needs field capture](a-pharmacy-is-findable-through-two-rows-and-marketing-also-needs-field-capture.md) - 2026-10-18: Direct Orders reads the customer map; the marketing code flag and picker read marketing_pharmacy_code_references (use town names, not area codes); a marketing request can still only pick a rep-captured venue (GPS + live photo) — never fake it. Overseas files pad codes to 10 digits, the receipt prints 7.
- [Omar's live signature is v10; a colleague's is v10 with their data swapped in](omars-live-signature-is-v10-and-a-colleagues-is-v10-with-their-data-swapped-in.md) - 2026-10-18: v10 files live in Downloads, not the repo; the Email Signature page is the simple one-picture design; build a colleague's by exact substitution from the register (no WhatsApp/LinkedIn there, so drop those two lines). Khaled Bedair's made this way.
- [the evidence photo is the primary source of trust](the-evidence-photo-is-the-primary-source-of-trust.md) - owner 2026-10-18: in ANY module with a live evidence photo, the photo's GPS outranks declared/derived territory; shipped for the Direct Order approval panel (request 299304bf: filed Menoufia 1, photo 0.7 km from منوف / Menoufia 2). Open tension: marketing's "registered code beats live GPS" (2026-08-21).
- [leave the outstation module out of the photo-first rule](leave-the-outstation-module-out-of-the-photo-first-rule.md) - owner 2026-10-18: "leave the outstation, do not touch"; never edit, plan or propose outstation work under the evidence-photo rule.
- [outstation chained-governorate journey fuel rule](outstation-chained-governorate-journey-fuel-rule.md) - owner 2026-10-18, SHIPPED in PR 6094 (live 2026-10-19 00:31 Cairo; NSMs keep today's price, his choice): a car journey moving governorate to governorate pays each drive once, one way, km × 1.8 (inter-governorate drive must be > 40 km); all stops in one governorate keeps today's residence × 2; allowance and 60 km minimum unchanged. Osama's 17–18 Oct: today 1,892.66 if filed as two trips vs new 1,181.19.
- [a Supabase prompt in plan mode survives an allow rule and a PermissionRequest hook](a-supabase-prompt-in-plan-mode-survives-an-allow-rule-and-a-permissionrequest-hook.md) - 2026-10-18: execute_sql prompts in plan mode even with the allow rules and a hook that fired and said allow (log: mode=plan ALLOW); hook removed, do not rebuild it; run Supabase work outside plan mode.
- [the one-by-one review's phone fix is parked on its own branch](the-one-by-one-review-phone-fix-is-parked-on-its-own-branch.md) - owner 2026-10-19: HOLD; commits 448ae8589 (phone layout) + 1c49683fa (zoom close returns focus, shared dialog hook) + 35d7782cb (polyclinic photos side by side on a phone, his choice) + 8ab14cadf (a waiting seated customer reads "Waiting for you" to him) + 8235a315c (the review's Not readable tab, moved out of Waiting and Not confirmed) on codex/place-review-deck-phone ride with the next Place checks / field-CRM PR (cherry-pick all five), never a PR of their own.
- [recruitment CVs before 11 Oct 2026 were backed up and deleted](recruitment-cvs-before-11-oct-2026-were-backed-up-and-deleted.md) - owner 2026-10-18: every CV zipped to F:\Phoenix Workforce\Recruitment CV Backup 2026-10-18 (with restore JSON); 1,338 pre-11-Oct candidates deleted, the 56 in play kept; Drive copies moved to "CV Backup before 11 Oct 2026"; WhatsApp inbox left alone. A missing old CV is answered from the zip's index.
