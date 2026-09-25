---
name: phoenix-official-logo-mismatch
description: "MERGED — PR #1298 went in 2026-07-24 (merge 76a0208c) and the four public/brand/ assets have been the owner's official mark ever since. Kept for the design decisions he approved, NOT as open work: the \"merge still needs approval\" line was true for a few hours and is now six weeks stale."
metadata: 
  node_type: memory
  type: project
  originSessionId: b3a17777-0d65-4e66-b363-7722a0e0d3b2
  modified: 2026-07-24T06:02:50.162Z
---

The owner shared their real/official Phoenix logo (2026-07-24, via a Downloads screenshot,
`C:\Users\satoh\Downloads\image-1784818448401.png` at the time) while reviewing the
Employees-page admin-shell restyle. It does **not** match what's actually in the repo.

**Official logo**: a detailed multi-tone red/orange/yellow phoenix bird with spread wings,
rising from flames, inside a circular ring emblem, with a city-skyline/bar-chart silhouette
across the base (fits a "workforce intelligence" / growth theme).

**What's actually in the repo** (`public/brand/phoenix-bird-icon.png`, referenced via
`systemAssets.iconLogo` in `src/config/system-settings.ts`): a simpler, flat orange/yellow
gradient bird with no ring, no city silhouette — visually a different, more generic mark.
This same wrong/placeholder asset is what `PhoenixLogo` (`src/components/brand/phoenix-logo.tsx`)
renders, and it's used in `src/components/layout/sidebar.tsx` and
`src/components/employee-portal/employee-portal-layout.tsx` — meaning the wrong logo is very
likely showing sitewide (sidebar, employee portal), not just something introduced during this
restyle.

**Why:** brand accuracy — owner explicitly corrected this mid-session and said to "note" it,
i.e. remember for future work, not chase it immediately (session was mid-restyle, owner said
"no more premium polish, still lots to do").

**How to apply:** before adding any phoenix-logo image reference in new UI work, verify against
this note rather than assuming `systemAssets.iconLogo` /
`public/brand/phoenix-bird-icon.png` is correct. See [[admin-shell-design-rules]] for the broader
restyle this was flagged during.

**2026-07-24 audit update:** the Downloads file was still readable (`C:\Users\satoh\Downloads\image-1784818448401.png`,
512×512, genuine alpha transparency — 79.4% fully transparent, sampled alpha=0 at all corners,
so it composites cleanly onto white or black with no lossy background removal needed). Compared
against all 4 assets actually wired into `systemAssets`:
- `iconLogo` (`phoenix-bird-icon.png`, 768×768, opaque) — **confirmed mismatch**, bare bird, no ring, no skyline.
- `loginEmblem` (`phoenix-login-emblem.png`, 768×768, has alpha) — **close but not identical**: already has the ring + skyline + same composition, but feather curl / gradient balance differ — looks like a different generation of a similar prompt, not the same source file.
- `adminSidebarLockup` (`phoenix-sidebar-lockup.png`, 640×288, opaque, black bg baked in) — **confirmed mismatch**: has a ring, but the base motif is an org-chart/network-node silhouette instead of the official's city-skyline bars.
- `adminRailMark` (`phoenix-rail-mark.png`, 128×128, opaque, black bg baked in) — **confirmed mismatch**, same bare-bird artwork as the icon, recolored for black.
- A 5th configured key, `adminSidebarBadge` → `phoenix-admin-intelligence-badge.png`, is dead: gitignored since 2026-07-03 as "orphaned, zero references, superseded," file doesn't exist, and grep confirms no component reads `systemAssets.adminSidebarBadge`. No action needed there.
- Two other repo files, `phoenix-logo-reference.png` and `phoenix-required-brand.png`, looked like they might already be the official brand sheet but turned out to be an unrelated older concept ("PHOENIX PPI" wordmark, no ring/skyline) — not usable.

Built a side-by-side comparison artifact (official vs. live, in real white/black usage context per
touchpoint, plus a rough mocked sidebar-lockup with the official mark + placeholder wordmark) and
asked the owner to confirm 3 open judgment calls before touching `public/brand/`: (1) replace
icon/login-emblem/rail-mark with the official mark as-is, resized only — no redraw capability
exists in this session; (2) whether the full ring+skyline mark stays legible enough at the rail
mark's 44px render size, or whether that slot should wait for a purpose-drawn simplified variant;
(3) whether the mock's generic bold-sans "PHOENIX / WORKFORCE" wordmark styling for the sidebar
lockup is acceptable or the owner has an exact spec. 512×512 source resolution comfortably covers
every current render size (icon ≤44px, rail 44px, lockup mark ~240px, login hero ~340px).
**2026-07-24 replacement update:** owner confirmed all 3 open questions with the recommended
option (replace icon/login-emblem/rail-mark with the official mark as-is; use the full ring+skyline
mark at the rail mark's 44px size rather than waiting for a simplified variant; the mocked bold-sans
"PHOENIX / WORKFORCE" wordmark styling is fine for the lockup). Rebuilt all 4 files from the
official mark via `sharp` (trim transparent padding, resize without upscaling past the 512px
source, composite onto white/transparent/black per slot, SVG-overlay the lockup wordmark) and
overwrote them in place under `public/brand/` — **local worktree only, nothing committed/pushed**.
Live-verified via a local `pnpm run dev` + dev-auth session (browser screenshots don't composite in
this environment — see [[local-browser-verify-gotchas]] — so verification used DOM/network
inspection instead): `phoenix-bird-icon.png` (iconLogo) confirmed rendering 32×32 in the employee
portal header; `phoenix-sidebar-lockup.png` confirmed rendering in the expanded admin sidebar
(desktop + mobile-drawer variants); `phoenix-rail-mark.png` confirmed rendering 44×44 in the admin
topbar. `phoenix-login-emblem.png` (loginEmblem) is file-verified correct (opened and inspected
directly, valid 384×384 transparent PNG) but its **live render was not confirmed** — `/login` renders
through a client-only dynamic component (`PremiumLoginPageDynamic`, zero server-rendered markup by
design) and the headless preview never finished client hydration on that route across several retry
strategies (fresh tab, logout+relogin, `window.location.href` reload) — consistent with the known
non-deterministic Suspense-reveal issue in [[local-browser-verify-gotchas]], not something this PNG
swap caused. Built an updated comparison artifact (before/after per touchpoint + live-verification
status); owner reviewed and said "go ahead." Unrelated pre-existing dirty file in this worktree,
`next-env.d.ts` (Next auto-regenerated a route-types import path when the dev server ran) —
deliberately excluded from the commit.

**2026-07-24 shipped to PR:** staged exactly the 4 changed PNGs (not `next-env.d.ts`), committed
(`b9feefc8`, branch `claude/gifted-neumann-e9a137`), pushed — pre-push gate (routes, migrations,
lint, typecheck) passed — and opened
[PR #1298](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1298). **Still open:** CI on
the PR, owner's own manual check of `/login` (the one surface not live-verified locally), and a
separate explicit approval to merge — merging is not implied by the push/PR approval already given.

## 2026-09-04 — CLOSED, this is no longer open work

The description said **"Merge still needs separate explicit approval."** That was true when it
was written and stopped being true the same day.

`gh pr view 1298` — **MERGED 2026-07-24T06:09:30Z**, merge commit
`76a0208cbd729321b6e369ca69cd9861ce3a054e`, branch `claude/gifted-neumann-e9a137`,
title *fix(brand): replace phoenix logo assets with official mark*.

Nothing here needs doing. What is worth keeping is the design reasoning above — the owner
approved those specific choices, so a future session changing a brand asset should read them
rather than re-deciding from scratch.
