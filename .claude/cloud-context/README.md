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

## What is here (generated 3 Oct 2026, 23:29 Cairo)
- Memory files: **1105** (4.75 MB)
- Global standing rules: 22.2 KB

## Refreshing
Run from a **local** checkout (it needs `~/.claude/`):

    node scripts/sync-cloud-context.mjs

then commit the change through the normal PR flow. Cloud sees the mirror as of the last commit
on the branch it clones (usually `main`), so it is only as fresh as its last merged refresh.
Source: `~/.claude/projects/F--Phoenix-Workforce-phoenix-workforce/memory/` and `~/.claude/CLAUDE.md`.
