---
name: portal-home-speed-on-small-before-medium-2026-11-03
description: "The portal home's open times on the Small database, Mon 2 and Tue 3 Nov 2026 08:00-10:48 Cairo, with the fix in on Tuesday. The figures to beat after Medium, and how to count an open so they compare."
metadata:
  node_type: memory
  type: project
  originSessionId: c898391b-8a9f-42ea-badf-0e6e8162c8ba
  modified: 2026-11-06T01:51:53.080Z
---

Read from Railway's HTTP rows, 08:00 to 10:48 Cairo, the stretch with no release inside it on either day:
- Monday 2 Nov, before the card fix (#6774): 67 opens, median 3.14 s, slowest tenth 6.41 s, 61% over 3 s, no 5xx.
- Tuesday 3 Nov, with the fix, still on Small: 74 opens, median 2.69 s, slowest tenth 6.75 s, 41% over 3 s, no 5xx. A 95% resample range puts the median's gain at 0.1 to 1.0 s and the over-3-s drop at 4 to 36 points.
- The control did not move, so the day was not easier: `/api/auth/pulse` median 373 then 363 ms, `/api/phoenix-crm/visits` 579 then 585 ms, on more traffic (10,943 then 12,439 rows).

So the ordinary open improved and the slow tail did not.

🔴 The double-visit panel's shared read merged 3 Nov 13:55 Cairo (pull request 54), after these figures and still on Small. Any later morning carries it, and only managers see that panel, so split managers' opens from the rest before crediting Medium with a gain.

Tuesday's card timers, typical minute's median: double-visit panel 5.8 s (28 reads, managers), field KPIs 2.0 s (worst 17.6 s), early birds 1.7 s, CV folders 1.3 s, rank 1.0 s, leave balance 1.0 s.

Tuesday 11:23 to 11:30 Cairo: 13 opens at median 8.2 s, worst 22 s, while the database host fell to 254 MB available and swap went from 215 to 512 MB. The cause of the memory drop was not proven.

**Why:** the next comparison needs these figures, and the raw rows are in a scratchpad that gets wiped.

**How to apply:** count a real open as path `/employee-portals` with bytes of 30,000 or more, never by `rsc`, because Railway's path has no query string. Prove Medium first (`memTotalMb` about 4,000, [[db-host-sampler-postgres-started-at-moves-without-a-restart]]), compare the same clock hours on a working morning, and cut the window at the first release inside it.

**Medium proven live, 6 Nov 2026 03:32 Cairo:** `memTotalMb` 3,864 (was 1,932), 2 cores, `pg_postmaster_start_time()` 03:27:24 Cairo, `shared_buffers` 1GB, `effective_cache_size` 3GB. The first working morning on Medium is **Saturday 7 Nov**, not Sunday: field work runs Saturday to Wednesday (visits by Cairo day: Sat 24 Oct 561, Sat 31 Oct 557; Thursdays 50 to 71; Fridays none but the 30 Oct import). Compare 08:00-10:48 against the figures above.

**The script, re-measured 6 Nov:** `node "C:/Users/satoh/.claude/scripts/portal-home-speed/measure.mjs" 2026-11-07 2026-11-07@08:30` from the primary, backgrounded (it picks the serving release, cuts at the first release inside the window, 20-minute slices). It reproduced Monday exactly and Tuesday at median 2.67 s (2.69 above). Window 08:30-10:48, all Small: Mon 62 opens 3.14 s / tenth 6.34 s / 61% over 3 s; Tue 67, 2.61 s, 6.25 s, 36%; **Wed 4 Nov 70, 2.62 s, 5.48 s, 37%: the FAIREST baseline**, Small with the panel speedup already live, so Saturday against Wednesday is Medium's own effect (Wednesday 08:00-08:30 is lost to a docs-only release at 08:02). Controls Wed: pulse 366 ms, visits read 486 ms. The scheduled one-time run for Saturday 11:07 was REFUSED by the auto-mode classifier on 6 Nov; it runs when he sends the words.

The restart itself, 6 Nov 03:27:20-03:27:24 Cairo: 3 server errors (a recruitment scheduled job, one sign-in check, one Monthly Closing open), 5 "Session verification is temporarily unavailable" rows in `app_error_events`, the app's own "production database restarted" alarm at 03:30, nothing after. Host 15 minutes later: 3,158 of 3,864 MB available, swap 0, CPU about 5%.
