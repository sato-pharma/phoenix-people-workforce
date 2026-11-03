---
name: portal-home-speed-on-small-before-medium-2026-11-03
description: "The portal home's open times on the Small database, Mon 2 and Tue 3 Nov 2026 08:00-10:48 Cairo, with the fix in on Tuesday. The figures to beat after Medium, and how to count an open so they compare."
metadata:
  node_type: memory
  type: project
  originSessionId: c898391b-8a9f-42ea-badf-0e6e8162c8ba
  modified: 2026-11-03T10:55:09.797Z
---

Read from Railway's HTTP rows, 08:00 to 10:48 Cairo, the stretch with no release inside it on either day:
- Monday 2 Nov, before the card fix (#6774): 67 opens, median 3.14 s, slowest tenth 6.41 s, 61% over 3 s, no 5xx.
- Tuesday 3 Nov, with the fix, still on Small: 74 opens, median 2.69 s, slowest tenth 6.75 s, 41% over 3 s, no 5xx. A 95% resample range puts the median's gain at 0.1 to 1.0 s and the over-3-s drop at 4 to 36 points.
- The control did not move, so the day was not easier: `/api/auth/pulse` median 373 then 363 ms, `/api/phoenix-crm/visits` 579 then 585 ms, on more traffic (10,943 then 12,439 rows).

So the ordinary open improved and the slow tail did not.

Tuesday's card timers, typical minute's median: double-visit panel 5.8 s (28 reads, managers), field KPIs 2.0 s (worst 17.6 s), early birds 1.7 s, CV folders 1.3 s, rank 1.0 s, leave balance 1.0 s.

Tuesday 11:23 to 11:30 Cairo: 13 opens at median 8.2 s, worst 22 s, while the database host fell to 254 MB available and swap went from 215 to 512 MB. The cause of the memory drop was not proven.

**Why:** the next comparison needs these figures, and the raw rows are in a scratchpad that gets wiped.

**How to apply:** count a real open as path `/employee-portals` with bytes of 30,000 or more, never by `rsc`, because Railway's path has no query string. Prove Medium first (`memTotalMb` about 4,000, [[db-host-sampler-postgres-started-at-moves-without-a-restart]]), compare the same clock hours on a working morning, and cut the window at the first release inside it.
