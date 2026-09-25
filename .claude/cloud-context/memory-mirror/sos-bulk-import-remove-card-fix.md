---
name: sos-bulk-import-remove-card-fix
description: "Bulk Import on /sales/upload permanently required every opened distributor card before importing any — #1427 added a manual remove button, #1468 fixed it properly (idle never blocks)"
metadata: 
  node_type: memory
  type: project
  originSessionId: cdf55e77-41c3-456b-a4dc-6ee497ea83a3
  modified: 2026-08-22T22:17:04.138Z
---

[[sos-bulk-import-module-build]]'s Bulk Import mode on `/sales/upload` had a real bug the
owner hit live, mid monthly-upload, with real data: `bulk-import-workspace.tsx`'s
`touchedCodes` state only ever grew (`openCard` pushes, nothing ever removed a single
code) — the only reset was `resetSession()`, wiping the whole session, triggered
solely by changing the month. `canConfirmAll` requires `blockingCodes.length === 0`
where blocking = any touched code whose stage is idle/working/**rejected** (not just
untouched-and-empty — a distributor whose file genuinely failed validation ALSO
permanently blocked every other distributor's import, with zero recourse). So opening
a card to peek, or picking a file for a distributor that turns out to have no real
data that month, silently locked the owner out of importing distributors they'd
already finished — exactly the "must upload all distributor sheets" complaint, even
though the code never literally required all 19 monthly distributors (only touched
ones counted) — the trap was that ANY touch was permanent for the session.

**Fix (PR #1427, branch `codex/sos-bulk-import-remove-card`, off origin/main 2026-07-28,
not yet merged):** added `removeCard(code)` to `bulk-import-workspace.tsx` — drops one
code from `touchedCodes`/`statuses`/`refsMap` (confirms via `window.confirm` only if
`statuses[code]?.fileName` is truthy, i.e. a file was actually picked), wired to a new
"Remove from this import" button next to each opened card's "Collapse" button.
Blocking-list hint text updated to "Open and resolve, or remove: …". No change to
Single-distributor mode (unaffected — it never had this coupling) or to any
analyze/validate/commit logic.

**Why:** owner's real workflow is "check whichever distributors I have files for this
month, skip the rest" — some distributors legitimately have zero sales some months, so
"finish everything you opened" is fundamentally incompatible with that. Immediate
workaround given to the owner while the fix was in flight: Single-distributor mode has
no cross-distributor coupling at all, so importing there one at a time was never
blocked by this bug.

**How to apply:** *(this heading records what was run at the time, it is not an instruction —
the `check:harden` gate and the pre-push gate were both retired 2026-08-18; today you push and
let the PR's required checks answer.)* typecheck/lint/full check:harden (routes+migrations+lint+typegen+
typecheck+test+build) all passed, pre-push gate passed too. Browser-verified live (see
[[local-browser-verify-gotchas]] — this session hit two more tooling gotchas worth
adding there: `preview_start({name})` failed with "cwd must be a relative path within
the project root" for no discoverable reason — adding an explicit `"cwd": "."` to
`.claude/launch.json` did NOT fix it either; worked around by starting `pnpm run dev`
directly via backgrounded Bash + `preview_start({url: "http://localhost:3000/..."})`
instead. Separately, `computer{action:"left_click", ref}` on the "Bulk import" mode-
toggle button silently no-op'd twice in a row (coordinates matched the visible
button's bounding rect per a JS `getBoundingClientRect()` check, so it wasn't the
known duplicate-DOM-node hazard) — switched to `javascript_tool` dispatching a native
`.click()` on the button, which worked immediately every time for the rest of the
session (mode toggle, distributor cards, remove buttons). Root cause of the ref-click
no-op was never identified.

Opened as PR, NOT merged — merging still needs separate explicit approval per
[[parallel-session-swarm-hazard]]-adjacent policy (merge = production deploy). The
primary checkout was mid-session on unrelated branch `codex/inbound-intake-dashboard`
(clean tree) when this started; owner confirmed the other flagged parallel session
(PID 17992) was stale, so this was built directly in the primary checkout on a fresh
branch off origin/main rather than a new worktree.

**UPDATE 2026-07-30 — #1427 confirmed MERGED** (squash `f9634b06`, 2026-07-28T19:17:53+03:00)
and deployed to production (multiple successful deploy-cloud-run runs since). BUT #1427's
`blockingCodes` filter was never actually changed — it still counted `idle` (opened, no
file ever picked) as blocking, same as before the PR. The only fix #1427 shipped was the
manual "Remove from this import" escape hatch; a card you merely opened to peek at still
permanently blocked "Confirm & Import All" until you explicitly clicked Remove on it — the
owner hit this again live and reported it as the same "must upload all sheets" complaint.
Follow-up **PR #1468 — MERGED to main 2026-07-29 as `b1e055a3`** (`codex/sales-bulk-idle-gate`,
off origin/main, worktree `.claude/worktrees/sales-bulk-idle-gate`) actually fixes the
filter: blocking is now only
`stage === "working" || "rejected"` (real in-flight state) — `idle`/no-status is silently
skipped, no Remove click needed. Extracted as `isBulkSlotBlocking` in the new
`src/lib/sales/bulk-import-gating.ts` (domain logic, unit-tested — the component file is
JSX the plain-Node test runner can't import directly). Verified live against real
production data (opened 2 idle cards → green "Every distributor here is validated"
instead of the old amber block), from an isolated worktree's own `next dev` on an
explicit alternate port — `preview_start` was confirmed once again to root on the primary
checkout regardless of cwd (see [[preview-start-ignores-worktree-cwd]]).
