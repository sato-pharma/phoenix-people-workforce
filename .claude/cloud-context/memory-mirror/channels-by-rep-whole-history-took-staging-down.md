---
name: channels-by-rep-whole-history-took-staging-down
description: "Running phx_sales_channels_by_rep over the whole history with nothing excluded was in flight 7 min 45 s when staging restarted uncleanly on 1 Nov 2026 - never rerun it, compare its pricing step month by month instead"
metadata:
  node_type: memory
  type: project
  originSessionId: 07056c4f-14ab-46ff-a1cb-45171c4ef829
  modified: 2026-11-01T20:49:26.066Z
---

Staging restarted uncleanly three times on 1 Nov 2026 during the period-price audit (PR 6755). Two line up with my own runs:

- 16:00:09 Cairo, 2 min 23 s into a widest `EXPLAIN ANALYZE` of the unfixed `phx_market_awareness_tracking`.
- 19:37:41 Cairo, 7 min 45 s into the unfixed `phx_sales_channels_by_rep` over the whole history with nothing excluded, under a 600 s session limit.

The 17:42:47 restart is unattributed. Memory as the mechanism is unproven, and the timing is the only evidence.

The same Channels call with the confidential three excluded finished in 235 s old and 226 s new, with no restart. Production holds more months than staging (11 against 8). Those runs used a direct connection, so the function's 60 s limit did not apply to them.

Corrected 1 Nov 2026, about 23:20 Cairo: that limit is NOT inert through the app. Through PostgREST 14.5 a function's own limit is applied before the call: the real function at a temporary 1 s stopped at 1,654 ms with 57014 on staging, and a 2 s throwaway stopped a 6 s sleep at 2,180 ms on production. Only a direct connection ignores it, because there the timer is armed when the OUTER statement starts (a 1 s declaration ran a 4 s sleep to 4,095 ms). So a read through the tab stops at 60 s; a script needs its own session limit set first. Rule: `.claude/rules/database.md`.

Migration 20261101195934 (1 Nov 2026) made the function classify each customer once, for speed only: 140,538 classifier calls on one month were 32.9 s of 34.1 s. Applied to both databases at about 20:22 Cairo on production. Real function on production afterwards: 2026-09 with the three excluded 8,037 ms, whole history with the three excluded 30,221 ms. Staging whole history excluded went 222,397 ms to 15,981 ms. Old against new as text through EXCEPT ALL: 23 calls, 0 differences. The whole history with nothing excluded is STILL never run, so its time and its effect on the server are still unknown; the fix does not lift the rule below.

Since PR 6759 (live 1 Nov 2026, 20:54 Cairo) the tab opens on the newest published closing and only `period=all` reads the whole history, and the owner then had `?reveal=1&period=all` refused for every role, with a 400, before the read starts (`assertChannelsByRepReadAllowed`). In the real tab on production: September 2026 in 4.7 s, whole history with the three excluded in 28.3 s.

**Why:** a comparison run should not cost a database restart, and production is on a small box with no PITR.

**How to apply:** never run that call whole-history and unexcluded, on either database. To compare it, the pricing step month by month is enough (317,806 rows, 0 differences). Do not treat the timing as proof of cause. See [[heavy-production-checks-wait-until-after-17-cairo]].
