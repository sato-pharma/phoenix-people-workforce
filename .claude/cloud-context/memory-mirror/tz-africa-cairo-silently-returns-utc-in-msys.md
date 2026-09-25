---
name: tz-africa-cairo-silently-returns-utc-in-msys
description: "TZ=Africa/Cairo date in the Bash/MSYS shell here silently returns UTC, three hours early, with no error — use node's toLocaleString or the machine clock instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b22c9c45-d687-4092-8f69-319394c83d5e
  modified: 2026-09-01T04:09:22.641Z
---

**`TZ=Africa/Cairo date` in this repo's Bash (MSYS) shell returns UTC, not Cairo.** MSYS ships no
tzdata, so an unknown zone name is not an error — it silently falls back to UTC and prints a
perfectly plausible timestamp with a `+0000` offset.

Measured 2026-09-01 in the `_wt-hr-ops-sidebar` worktree, all in the same second:

```
UTC        : 2026-09-01 04:01:43
MSYS Cairo : 2026-09-01 04:01:43 +0000   <- wrong, and looks fine
machine    : 2026-09-01 07:01:43 +0300   <- correct
node Cairo : 01/09/2026, 07:01:43        <- correct
```

**Why this matters here specifically:** the owner's standing rule is *report every time in
Africa/Cairo, never raw UTC*. So the one command a session naturally reaches for to obey that rule
is the command that breaks it — and it breaks it by exactly three hours, in the direction that makes
recent events look older than they are. A file written 18 minutes ago reads as written 3h18m ago,
which is the difference between "another session is working in this file right now" and "someone
touched this before dawn". That is not a cosmetic error; it inverts a live/stale judgement, the same
failure class as [[a-utc-timestamp-compared-against-cairo-manufactures-a-false-signal]].

**What to use instead**

- `node -e "console.log(new Date().toLocaleString('en-GB',{timeZone:'Africa/Cairo',hour12:false}))"`
  — node carries full ICU tzdata and is always available in this repo.
- Or plain `date` / a Windows file mtime: **the machine clock is already Cairo (`+0300`)**, so
  unqualified local time is correct as-is. It is only the explicit `TZ=` override that lies.

**The tell**, if you have already run it: a Cairo reading with a `+0000` offset. Cairo is never
UTC+0 — it is +02:00 in winter and +03:00 under DST. Any `date` output claiming `+0000` for Cairo is
the fallback, not the zone.

Do not "fix" this by exporting `TZ` differently or installing tzdata into MSYS; the shell is not the
place this belongs. Read the clock with node, or read the machine clock.
