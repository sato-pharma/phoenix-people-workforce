# Cloud context mirror — generated, do not hand-edit

A **cloud** session is an isolated git clone of this repo. It never sees the laptop's
`~/.claude/` — so the two knowledge layers a **local** session wakes up with are missing:
the global standing rules and the entire auto-memory. This directory mirrors both INTO the
repo so a cloud session can read them, giving it the same two-tier recall a local session has.

**A cloud session, before its first substantive answer, should read:**
- `memory-mirror/MEMORY.md` — the memory index (the map of every known fact)
- `global-standing-rules.md` — the owner's global standing rules (the machine/RAM sections are laptop-only; ignore them in cloud)
- then grep `memory-mirror/` for any specific fact, exactly as local recall does on demand.

**Local sessions ignore this mirror** — they have the live originals under `~/.claude/`.

## What is here (generated 24 Oct 2026, 17:40 Cairo)
- Memory files: **1491** (6.03 MB)
- Global standing rules: 18.5 KB
- Pinned laptop hooks: **7** in `laptop-hooks/` (194.9 KB) — scratchpad-guard.mjs, next-step-capture.mjs, risky-allow-guard.mjs, memory-guard.mjs, dev-server-reaper.mjs, weekly-review-readonly.mjs, spawn-probe.mjs

`laptop-hooks/` is **not for a cloud session to read or run.** Those hooks guard every folder on the
laptop, so they cannot live in one repository — which also meant nothing could go red when one
weakened. `tests/delete-guard-stand-down.test.ts` imports the pinned copy and pins its decision
table in the required `validate` job. The copy is only worth its freshness, so the live hook also
runs its own `selftest` hourly on the laptop, where the real file is.

## Refreshing
Run from a **local** checkout (it needs `~/.claude/`):

    node scripts/sync-cloud-context.mjs

then commit the change through the normal PR flow. Cloud sees the mirror as of the last commit
on the branch it clones (usually `main`), so it is only as fresh as its last merged refresh.
Source: `~/.claude/projects/F--Phoenix-Workforce-phoenix-workforce/memory/` and `~/.claude/CLAUDE.md`.
