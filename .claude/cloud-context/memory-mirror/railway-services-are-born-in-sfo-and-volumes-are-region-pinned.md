---
name: railway-services-are-born-in-sfo-and-volumes-are-region-pinned
description: "New Railway services in this account are created in sfo (US), not Europe, and a volume's region is fixed at creation — the CLI cannot place one in the EU but the GraphQL API can, via VolumeCreateInput.region"
metadata:
  node_type: memory
  type: project
  originSessionId: 063f9fef-e147-48aa-9175-72488761b237
  modified: 2026-09-27T21:16:01.676Z
---

**Every new Railway service in `gawish-1997's Projects` is created in `sfo` (San Francisco), not
Europe — and a volume's region is fixed at creation, so `railway add --database postgres` can never
produce a European database.** Measured 2026-09-27: `ci-runner` was born in `sfo`; a throwaway
Postgres created to test this put its volume `postgres-volume-we4X` in `sfo`; and `phoenix-headwind`
+ `headwind-db` have been in `sfo` since 2026-09-25. Only `phoenix-people-workforce` is in EU West,
because someone set it explicitly.

**Why:** `docs/devices/headwind-rustdesk.md` claims a service created inside the existing Phoenix
project has the region "inherited and stays `europe-west4`". That is false — nothing is inherited.
The same default also put the stray `superb-smile` project in `sfo`. AGENTS.md's standing rule is
that everything stays in Europe, so this default silently violates it every time, and the MDM server
holding Egyptian employees' device data has been running in the United States as a result
(measured 426 ms to `mdm.satopharma.com` against 262 ms to `phoenix-hr.satopharma.com`).

**How to apply:**
- A stateless service: create it, then `railway service scale --service <name> europe-west4-drams3a=<n> sfo=0`
  and re-read the region, because the scale response prints the region map and the status line lags.
- A service **with a volume** (any database): **the CLI cannot do it but the GraphQL API can** —
  `VolumeCreateInput` has a `region` field. Corrected 2026-09-28: this said "dashboard only", which
  cost the Headwind move a day of being blocked on a click. `railway add` has no region flag, and
  `serviceInstanceUpdate`'s own `region` does **not** stick (it reads back `null`), so the volume is
  what actually places the service: create the service with **no source**, upsert its variables,
  `volumeCreate` with `region: "europe-west4-drams3a"`, and only then set `source.image` so the first
  boot happens in the right place. Railway co-locates the container with its volume — `railway status`
  then reports `region: EU West` even while the API's `region` field still reads null, so **read the
  VOLUME's region, or `railway status`, never `serviceInstance.region`.**
- `railway ssh` **joins argv**, so a remote command carrying `||`, `&&` or `>` is mangled and returns
  nothing with an EMPTY stderr and a null exit — it looks like an auth failure. A single-quoted whole
  command works; an argv array through `spawnSync` does not. It also resolves the link from the
  **exact cwd string**, so it must be run from the linked directory.
- `tcpProxyCreate` over the API answers `Not Authorized` with the CLI's own session token; use
  `railway tcp-proxy create --port 5432`, and delete it by **id** (`delete --service X --yes <id>`) —
  the id is a positional argument, and without it the command only prints its usage.
- Never assume region from the project. Read it per service — `railway status` reports it only for
  the linked service, so link each one in turn.

Related: [[a-red-main-ci-makes-railway-skip-the-deploy-for-good]] ·
[[railway-ssh-needs-a-registered-key-and-the-cli-can-add-one]]

## The Headwind move — DONE 2026-09-28 01:41 Cairo, and what it actually took

`phoenix-headwind` + `headwind-db-eu` are in **EU West**; the sfo `headwind-db` is frozen with **0
backends** and kept as the rollback. `mdm.satopharma.com` went 426 ms → ~245 ms, matching
`phoenix-hr.satopharma.com`. The recipe, in the order that works:

1. **`railway service scale <region>=1` ADDS a region, it does not move one** — it answered
   `regions: EU West (1) · sfo (1)  2 replicas`, i.e. two live copies of an MDM server. **Always pass
   the old region as `=0` in the same command** (`europe-west4-drams3a=1 sfo=0`), then re-read the
   region from `railway status`.
2. Reuse the OLD database's `POSTGRES_*` values on the new one, so the cutover changes exactly one
   variable — `SQL_HOST` — and no password is ever handled.
3. Set that variable with `skipDeploys: true`, then scale the region: **one redeploy picks up both.**
4. Reach either database with `railway tcp-proxy create --port 5432` (the API's `tcpProxyCreate`
   answers `Not Authorized` with the CLI token) and **delete it by id afterwards** — the id is a
   POSITIONAL argument, and without it the command only prints its usage.
5. **`n_live_tup` LIES right after a restore** — it is an autovacuum estimate and read 456 against a
   true 473, inventing drift that did not exist. Compare with exact `count(*)` per table
   (`query_to_xml(format('select count(*) ...'))`), never `pg_stat_user_tables`.
6. **Do not try to stop the app first.** Scaling a production service to 0 replicas is refused by the
   permission classifier, and it is not needed: dump → reload → repoint takes about a minute, and the
   only tables that move are append-only logs which top up by `id > max(id)` (advance the sequence with
   `setval` afterwards). In the event nothing needed topping up — all 52 tables matched at 1,297 rows,
   and the EU database was one row AHEAD because the live app had already written its own audit row.
7. **Verify the cutover by asking the DATABASES who is connected**, not the app: `pg_stat_activity`
   read 0 backends on sfo and 5 on EU. A 200 from the domain proves only that something is serving.

## 🔴 An orphaned Railway volume cannot be deleted NOW, and both tools say it is deleted anyway

🔴 **AN ORPHANED VOLUME MAY CARRY A 48-HOUR DELETE SCHEDULE OR NONE AT ALL, AND YOU CANNOT TELL WHICH
WITHOUT READING `railway volume list` — corrected 2026-09-28, after I told the owner twice that one
would "go on its own" when it never will.** Measured the same night, same project, both detached:
`postgres-volume-we4X` reads `Deletes on: Sep 30 2026 12:09 AM +03:00`; `postgres-volume-0WKb`, orphaned
by DELETING ITS SERVICE, has **no `Deletes on:` line at all** and sits on 931 MB indefinitely. The
difference appears to be how it was orphaned — a volume detached from a surviving service got the clock,
a volume whose service was deleted did not — so **never generalise from one orphan to another.** Where a
schedule DOES exist, nothing shortens it: `volumeDelete` over the API returns clean and `railway volume delete --yes` prints
`Volume "<name>" deleted` — and the volume is still listed, still sized, still there. Measured
2026-09-28: `postgres-volume-we4X` was orphaned at 21:09Z on 09-27 and reads `Deletes on: Sep 30 2026
12:09 AM +03:00` — **exactly 48 h later, a date already set BEFORE either delete call**, so neither call
changed anything. The two older orphans (`postgres-volume`, `postgres-volume-4L35`) simply vanished on
their own when their own 48 h elapsed.

**So a delete confirmation is not evidence.** The only readout that tells the truth is
`railway volume list`, which prints `Attached to:` and `Deletes on:` per volume — the GraphQL `Volume`
type has **no `deletedAt` field at all** (`createdAt, id, name, project, projectId`), so the API cannot
show you the schedule and a query will keep returning the volume as if the delete never happened.

**How to apply:** when asked to delete an orphaned volume, read `railway volume list` first, and if it
already carries a `Deletes on:` date, say that date instead of deleting — the action is a no-op and
reporting "deleted" would be false. Detaching a volume from a service is what starts the clock.

## The sfo database is DELETED — 2026-09-28 02:0x Cairo, at the owner's instruction

`headwind-db` (the sfo Postgres) is gone; `headwind-db-eu` is the only Headwind database. Verified
before deleting: **no service in production OR staging referenced `postgres.railway.internal`**, the
volume was attached to nothing else, the old database had **0 non-self backends**, and three independent
dumps verified at 52/52 TABLE DATA. Verified after: 5 backends on EU, 191 audit rows,
`mdm.satopharma.com` 200 at ~230 ms.

**Recovery, in order:** `headwind-db-eu` is live; then
`F:\PHX backup\headwind-db\headwind-db-2026092722361-CUTOVER.dump` (242,474 bytes, 52 TABLE DATA,
444 TOC lines, md5 `58bb23c2a8113351212684fc22cb9eb0`), plus two earlier dumps from the same night;
and the orphaned `postgres-volume-0WKb` still holds the sfo cluster — **with NO delete scheduled, so it
persists until someone removes it deliberately.** That is a better rollback than a deadline (there is no
expiry to race) and a standing 931 MB of storage, so it is the owner's decision, not a tidy-up.

🔴 **A dump filename from a session's own earlier message is not evidence the file exists.** I quoted
`...22160-CUTOVER.dump` three times; the real name is `...22361-CUTOVER.dump`, and `pg_restore -l` on
the wrong name printed **0 TABLE DATA** — which reads exactly like a CORRUPT BACKUP, and was one step
from being cited as the safety net for deleting the last live copy. **`ls` the backup directory and
hash the file you are actually about to rely on, immediately before the destructive step.**

### What the two orphans finally settled (2026-09-28 02:38 Cairo)

**A DELETE on a volume is what starts the 48-hour clock — being orphaned does not.** Proved by watching
one volume do both: `postgres-volume-0WKb` sat detached for half an hour with **no `Deletes on:` line at
all**, and the moment `railway volume delete --volume postgres-volume-0WKb --yes` ran it read
`Deletes on: Sep 30 2026 2:38 AM +03:00` — 48 hours out, to the minute. So an earlier note here that the
schedule was "already set BEFORE either delete call" had the causation backwards: the volume that
appeared pre-scheduled had simply already been asked to delete.

**The operational rule is unchanged and now better founded:** the CLI prints `Volume "<name>" deleted`
and the volume is STILL LISTED, holding its full size, for 48 hours. `railway volume list` and its
`Deletes on:` line is the only truthful readout — the GraphQL `Volume` type has no `deletedAt` at all.
Report the DATE, never "deleted".

🔴 **Before deleting the last live copy of anything, restore a dump rather than listing one.**
`pg_restore -l` proves a TOC, not a database. Measured: `createdb headwind_restore_test` inside the LIVE
EU Postgres, `pg_restore` the cut-over dump into it → **52 tables, 1,297 rows, 456 device-log rows, 2
users**, then `dropdb`. That is what made "the dumps are enough" a verified statement instead of a hope,
and a scratch database beside the live one costs nothing and touches no production table.
