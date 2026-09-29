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

🔴 **THE PURGE DATE APPEARS ON A DELAY, SO A SINGLE READ OF `railway volume list` CANNOT TELL YOU
WHETHER AN ORPHAN IS PERMANENT — READ IT TWICE, HOURS APART.** Settled 2026-09-28 after three readings
disagreed and two sessions each "corrected" the other: `postgres-volume-we4X` showed a date immediately,
`postgres-volume-0WKb` showed NONE for about two hours after its service was deleted, then showed
`Deletes on: Sep 30 2026 2:38 AM`. **An absent date is not "never".** Neither report was wrong; both were
single reads of a value that was still changing, and acting on the "no schedule" reading would have
hand-deleted 931 MB that Railway was already purging. Measured the same night, same project, both detached:
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

### Railway backups: a schedule has to be ASKED FOR, and `kinds` is the whole set

**A new Railway service gets NO backup schedule — nothing inherits one, just as nothing inherits a
region.** `headwind-db-eu` ran for three days with zero schedules and zero backups until the owner
instructed one on 2026-09-28; `volumeInstanceBackupScheduleList` and `volumeInstanceBackupList` both
returned 0 the whole time. **A Postgres service on Railway is not backed up unless someone says so.**

- `volumeInstanceBackupScheduleUpdate(volumeInstanceId, kinds)` — 🔴 **`kinds` is the WHOLE SET, not an
  addition.** Passing `["DAILY"]` where a weekly exists REMOVES the weekly. Enum: `DAILY · WEEKLY ·
  MONTHLY`.
- 🔴 **There is no cron and no retention argument — Railway assigns both.** Daily came back as
  `34 14 * * *` (17:34 Cairo) with 518,400 s = 6 days. Do not promise an hour or a retention to the
  owner; read them back from `volumeInstanceBackupScheduleList` after setting it.
- `volumeInstanceBackupCreate(volumeInstanceId, name)` returns a **`WorkflowId`**, so it needs a subfield
  selection (`{ workflowId }`) or the query is rejected; the backup appears in the list a few seconds
  later. Use it to avoid waiting a day for the first copy.
- Enabling more kinds costs more stored copies, so **which kinds are on is the owner's decision**, not a
  tidy-up.

**Live on `headwind-db-eu` as of 2026-09-28, both at the owner's instruction:** `DAILY` cron
`34 14 * * *` (17:34 Cairo, 6 days) and `WEEKLY` cron `47 3 * * 6` (Saturday 06:47 Cairo, 27 days) —
a ~4-week window rather than 6 days, which is what a fault noticed in week two needs. `MONTHLY` is off.
🔴 **The `kinds`-is-the-whole-set trap bites on the SECOND change, not the first:** adding the weekly
meant sending `["DAILY","WEEKLY"]` built from the existing list, because `["WEEKLY"]` would have deleted
the daily and the mutation would have reported success. Read the list back and confirm the older kind
survived.

Related: [[a-red-main-ci-makes-railway-skip-the-deploy-for-good]]

### The CI runner's labels, and why a runner COUNT is never a fact

**The Railway runner's labels are one variable — `RUNNER_LABELS` on the `ci-runner` service — and changing
it redeploys, which makes every replica RE-REGISTER under a new name.** Set 2026-09-28 at the owner's
instruction ("give the Railway replicas their own runner label"):
`self-hosted,linux,x64,phoenix` → `self-hosted,linux,x64,phoenix,railway-eu`. **Add to the set, never
replace it**, or anything already targeting the old labels stops matching.

🔴 **A RUNNER COUNT IS A STATUS, NOT A FACT, and stale registrations defeat a label distinction.** The
container registers NON-ephemerally, so every redeploy leaves the old registration behind — online → 3,
then 6, then 3 again inside four minutes — and GitHub only prunes an offline self-hosted runner after **14
days**. Those leftovers carry the OLD label set, so leaving them destroys the very distinction a new label
was added for. **Deregister them after any label change or redeploy**
(`gh api -X DELETE repos/<o>/<r>/actions/runners/<id>`, for `status != "online"` and `busy == false`), and
never quote a total in a doc — read `actions/runners` and compare LABEL SETS, because when every runner
carries identical labels no label can select a host at all.

**`runs-on: self-hosted` matches EVERY self-hosted runner**, so a switch must select a distinct label.
`railway-eu` is carried only by these three replicas. Setting `CI_RUNNER_LABEL` is what ARMS a
per-branch switch, and that is the owner's call — labelling the runner does not route a single job.

### 🔴 A `.slice(0, N)` IN YOUR OWN PROBE BECOMES A FALSE "COMPLETE LIST" ONE MESSAGE LATER

**2026-09-28, the worst of the night's eight false reads, because the truncation was mine.** Probing
Hetzner's CPX page I matched every `CPX\d+`, printed `.slice(0, 6)`, and then reported "the current
lineup reads CPX12 · CPX22 · CPX32 · CPX42 · CPX52 · CPX62" and "no CPX31 appears any more". The match
had returned **11**. Both generations are on that page — `CPX11 CPX12 CPX21 CPX22 CPX31 CPX32 CPX41
CPX42 CPX51 CPX52 CPX62` — so `CPX31` is live, and the runner doc's "**NOT CPX31**" warning is
load-bearing: it is one character from `CPX32` and picking it spends real money on the wrong box. A peer
refused to delete the warning on my word and checked; had it trusted me the guard would have gone.

**The rule: when a probe's output is capped, say the CAP and the TOTAL, or do not draw a set-membership
conclusion from it at all.** "I printed the first 6 of 11" is a different sentence from "the lineup is
these 6", and only the first one is true. This is the self-inflicted form of the night's pattern — a
single read presented as a fact — and it is harder to catch because nothing external changed underneath
it; the evidence was complete and the *report* of it was not.

**Also settled, two independent probes:** Hetzner's public `/cloud/regular-performance/` page yields **no
price at all** — `.ho-price-container` and `.main_price` (the selectors its own `cloudMatrixTableDO.js`
names) match **0** elements, and `/€\s?\d+[.,]\d{2}/` matches nothing anywhere in the body. The
authenticated console is the only place a Hetzner price exists; do not quote one from the public site.

### 🔴 A DATED MEASUREMENT IS SAFE TO WRITE IN A DOC; A CURRENT VALUE IS NOT

The sharper form of the capped-output rule above, settled 2026-09-28 in `docs/ci-self-hosted-runner.md`
after that one file was wrong about a live value **twice in one night** — the CPX32 cost (#4607) and the
switch state (#4618/#4619).

**"On 2026-09-28, dispatch `36362005374` ran hosted with the label armed" is true for ever, because it
carries its date. "The label is set today" cannot be.** Both look like facts on the page; only one can
rot. A repository variable changes without a commit, so any value written into prose is a snapshot that
begins rotting as it is written — and a TIMESTAMP does not save it, which is the part I got wrong. I
"fixed" a false state line by writing the true value plus `2026-09-28T00:22:00Z`, which is auditable but
still reads as current to anyone who does not do the subtraction: the same failure one layer along. The
durable shape is **a table of what each STATE MEANS plus `gh variable list` as the only source**, with
dated measurements as the evidence.

**So: never write a live value into a doc — write what each value would mean, and cite dated
measurements.** Applies to repo/environment variables, runner counts, volume states, deploy revisions
and anything else read from an API rather than from the commit.

🔴 **Two sessions were given the same merge instruction for one line, twice in one hour, and neither could
see the other's window.** #4619 (mine) merged before #4618's author's "please hold" arrived, leaving their
PR DIRTY. The only defence that worked was saying what had been done IMMEDIATELY and conceding the design
point unasked — cost was one hand-resolved merge, not a silent overwrite. **Resolve a conflict on the
branch whose WORKTREE holds it**, and by hand: `git checkout --ours` takes the whole file and would have
dropped an unrelated comment in a second file.
