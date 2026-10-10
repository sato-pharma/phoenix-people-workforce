---
name: a-production-delete-is-declined-by-the-classifier
description: Auto mode's classifier declines `execute_sql` production mutations it reads as destructive even when the owner ordered them in his own words — hand him the statement for the Supabase SQL editor, never reach for the service-role key.
metadata:
  type: feedback
---

On 2026-10-09 five production mutations through `mcp__supabase-production__execute_sql` came back `{"status":"declined"}` — three `update`s settling a location-integrity case, a single-row `delete`, and the 6,355-row CRM test-row sweep — **including the ones he had just ordered in his own words** ("write the Hassan settlement straight to production", "remoive all test enteries").

**Why:** AGENTS.md §8 pre-authorizes Supabase writes, but the pre-authorization is the owner's *rule*, not the permission layer's *decision*; auto mode judges from what it can still see, and a destructive production statement reads as destructive whatever the repo says. A scratch node script fabricating a Super Admin viewer was separately refused as "Security Weaken".

**How to apply:** attempt it once, and when it is declined, write the finished statement to a file, send it with `SendUserFile`, and name the screen — the Supabase SQL editor on **Phoenix HR** — ending it with a proof query whose every number must be 0. **Never** route around the refusal: no service-role key in a node script, no `psql`, no data delete smuggled into `apply_migration`, and no asking a peer session to run it. The refusal is not a standing block and not a reason to change `permissions` — see [[the-small-pr-merge-guard-and-the-classifier-deadlock]].

**`apply_migration` is declined on the same footing, and a cleared precondition does not change it**
(production, 2026-10-10). The Mapping Guard retirement was declined once before the ordering
condition was met and again after it was *proven* met (production serving `d41a8fbb8`, which
contains the retirement commit `ab3409c92`, so the old screen had stopped calling the functions).
Two declines, nothing in the error, no partial application. **What to hand him is one file holding
the migration bodies verbatim in run order plus a third script whose every row reads PASS or FAIL** —
he pastes it into the Supabase SQL editor once, and the proof is in the same paste instead of a
follow-up turn.

**`drop function` is declined too, and on STAGING — this is not a production-only guard** (2026-10-10). Retiring a superseded RPC overload was declined twice on the STAGING project, through `execute_sql` and then `apply_migration`; production was never asked for the drop, because the split below made it unnecessary. The identical payload **minus the `drop`** — `create or replace` plus `revoke`/`grant` — succeeded first time on both. So the classifier reads the verb, not the blast radius: dropping an uncalled `service_role`-only function is refused while replacing a live one is waved through. **Split the DDL and apply what you can**, so the branch is not blocked by the one statement that cannot run; the leftover object is then named in the PR body as a manual step, and the migration file keeps the `drop` so a fresh environment is correct.
