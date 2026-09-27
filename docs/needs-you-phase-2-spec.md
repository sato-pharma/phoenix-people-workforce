# Needs You — Phase 2 build spec (composition layer + admin page)

**Written for a cloud session.** A cloud session is an isolated git clone: it never sees the
laptop's `~/.claude/`, so everything needed to build this is in this file, in the repo, or in the
task prompt. Read `.claude/cloud-context/memory-mirror/MEMORY.md` and
`.claude/cloud-context/global-standing-rules.md` first — that is the two-tier recall a local session
wakes up with.

🔴 **Start from `codex/tier1-status`, NOT from `main`.** This phase calls three things that are on
that branch and not yet merged:
`getAwaitingMyActionItemsWithHealth`, `listUnpublishedClosings`, `getPayrollAwaitingPublish`.

```bash
git fetch origin && git checkout codex/tier1-status && git checkout -b codex/needs-you-page
```

---

## What this is

The owner (sole Super Admin, HR id **B-10**) approves every merge, publish and decision this system
will not take on his behalf. At any moment some number of things are waiting on a click only he
makes, and the only way to learn that number is to walk a dozen admin screens.

Three half-overlapping aggregators already exist and **none is a superset**:

| Aggregator | Covers | Blind to |
| --- | --- | --- |
| `getCeoAdminSignals` (`src/lib/ceo/command-center.ts:558`) | 6 HR/lifecycle signals | direct orders, marketing, closings, payroll |
| `getAwaitingMyActionItems` (`src/lib/action-center/service.ts`) | resignation, contract renewal, outstation | everything else |
| `GET /api/approvals/badge-counts` | 9 approval counts | every lifecycle signal, payroll, closings |

Phase 2 builds the one service that composes all three, and the page that renders it.

---

## 🔴 The governing rule — read this before writing any code

**A board that under-reports is worse than no board.** If it prints "nothing needs you" while
something is waiting — or while a read simply failed — it costs him the decision more surely than no
board would, because he has delegated the looking.

This is enforced **structurally, not by discipline**:

```ts
export type NeedsYouSourceState =
  | { status: "ok";             items: readonly NeedsYouItem[] }
  | { status: "not-applicable"; because: string }   // no permission — a TRUE zero
  | { status: "unavailable";    because: string };  // it did not answer — NOT a zero
```

Four structural guarantees:

1. **A failed source produces no item**, so there is no `number` field a failure can write to.
2. **`allClearProvable` is computed once**, in `classify.ts`. The empty-state sentence is gated on
   it — never on `yours.length === 0`.
3. **`sources` carries one entry per `NeedsYouSourceId`, always** — pinned by a test, so a source
   dropped by a lost `await` fails CI instead of rendering as calm.
4. **`not-applicable` is a third state.** Without it, nine permission refusals become nine permanent
   amber warnings, which trains him to ignore amber — the same failure one step removed.

Over-reporting is allowed and deliberately untested. A row he glances at and dismisses costs two
seconds; a row that never appeared costs a deploy.

---

## Files to create

```
src/lib/needs-you/types.ts              NeedsYouItem, NeedsYouSourceId (closed union), NeedsYouBoard
src/lib/needs-you/classify.ts           buildNeedsYouBoard(results, now)  — PURE: no DB, no clock, no access
src/lib/needs-you/sources.ts            one adapter per source, each owning its own permission call
src/lib/needs-you/service.ts            getNeedsYouBoard(access) — the fan-out, 8s per-source timeout
src/lib/needs-you/render/sections.ts    board -> NeedsYouSection[] — PURE; owns SECTION ORDER
app/(admin)/admin/needs-you/page.tsx    + export const dynamic = "force-dynamic"
src/components/admin/needs-you-board.tsx
```

`classify.ts` and `sections.ts` are pure for one reason: the rule whose wrong answer costs something
has to be drivable by a test without a live machine. Same split as `scripts/needs-you.mjs` and
`scripts/branch-pr-state.mjs`.

### The item model

```ts
export type NeedsYouItem = {
  key: string;                 // "leave-approvals:pending", "monthly-closings:2026-08"
  sourceId: NeedsYouSourceId;
  kind: "approval" | "publish" | "expiry" | "flag" | "merge";
  lane: "yours" | "someone-else" | "worth-knowing";
  label: string;               // a sentence, NAMES not codes
  count: number | null;        // null = NOT A COUNT. never "unknown".
  people: readonly string[];   // live names — there is NO hrId field, on purpose
  href: `/${string}` | null;   // an app screen that ALREADY acts
  externalUrl: string | null;  // a GitHub PR — separate slot, separate affordance
  oldestAt: string | null;     // Cairo ISO — the sort key
  ageDays: number | null;
  overdue: boolean;            // upstream's own SLA verdict, never recomputed here
  note: string | null;
};
```

`href` is templated `` `/${string}` `` so an off-app or `javascript:` URL cannot land in the app's
own link slot. `NeedsYouItem` has **no `hrId` field** so "names, never codes" is structural rather
than remembered.

---

## Composition — call these, and NOT these

### Do NOT call `getCeoAdminSignals`
Not exported, welded to `getPlatformMetrics` via `Promise.all` (so a metrics rejection rejects the
whole thing), and it returns `health`/`trends`/`payroll` alongside `attention`. Call the services
underneath instead:

- `getResignationsDashboardData(access)` — `src/lib/resignations/service.ts`
- `getVacationPendingApprovalCounts(access)` — `src/lib/vacation/service.ts:5880`
- `getContractRenewalDashboardData(access)` — `src/lib/contracts/service.ts`
- `getCoachingReports({}, access)` → `buildCoachingReportAnalytics` → **`redZoneRepCount`**
  🔴 **not** the two red `zoneCounts` buckets — `command-center.ts:551` records that misreading as
  35 instead of 7, and the same mistake is one line away here.
- `getSalaryFlags()` → `unresolvedCount` — `src/lib/admin/service.ts`
- probation via `getProbationRows` / `isProbationDecisionOutstanding` — `src/lib/probation/service.ts`

### Do NOT call `GET /api/approvals/badge-counts`
An HTTP hop from a server component to its own app needs the session cookie, doubles latency, and —
fatally — inherits the route's deliberate `{count: 0}` fallback, which is correct for a badge and is
the one shape this page must never have. Call the nine functions it calls:

`getPlanAwaitingBadge`, `getVacationAwaitingBadge`, `getExcuseAwaitingBadge`
(`src/lib/approvals-hub/service.ts` — all three now carry `available: boolean`),
`getAwaitingMyActionItemsWithHealth` (`src/lib/action-center/service.ts` — returns
`{items, unavailable}`), `countDirectOrderAwaitingFast` + `getDirectOrderUnbookedBadge`
(`src/lib/direct-orders/service.ts:5405`), `countDirectOrderPendingValidations`
(`src/lib/direct-orders/pharmacy-validation.ts:1080`), `getMarketingApproverBadge`
(`src/lib/marketing-requests/service.ts:8829`), `getMarketAwarenessDecisionBadge`
(`src/lib/market-awareness/service.ts:646`).

**Marketing:** use `getMarketingApproverBadge`, which already drops the `assigned_hr_id` filter for a
`canViewMarketingOversightQueue` viewer (Super Admin) and **throws** rather than returning 0. Do
**not** call `getApproverPendingRequests`.

### New this branch
- `listUnpublishedClosings()` — `src/lib/sales/monthly-closing-publication.ts`. **Throws** on error
  by design; catch it into `unavailable`.
- `getPayrollAwaitingPublish(access)` — `src/lib/automated-payroll/awaiting-publish.ts`. **Throws**
  on a missing table by design; same treatment.

### Never build on
`src/lib/overview/service.ts:126 getOverviewDashboard` — dead, zero consumers, and its name will
convince you it is the aggregator.

### Latency
Fourteen adapters, several of them seconds. **One call with a per-source timeout (~8 s)**, whose
loser becomes `{status:"unavailable", because:"did not answer within 8 seconds"}`. Do **not** split
into a deferred/streaming phase: a deferred band that fails renders nothing, and a missing source
becomes invisible again. No polling — the page is `force-dynamic`; a reload is the refresh.

---

## The page

**Gate** (follow `/admin/ceo-command-center`):

```ts
const access = await resolveAccessContextFromPage();              // src/lib/auth/server.ts:574
if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
if (!canAccessSystemAdministratorWorkspace(access)) redirect("/admin");  // permissions.ts:456
```

Server-side access control is the security boundary; hiding a nav link is UX only.
**Do not add a new `PermissionResource`** — it would need 17 `permissionMatrix` rows, a
`MODULE_LABELS` entry, and it would make this board *lockable*.

**Five bands, in this order — "could not be read" FIRST:**

```
AdminPageHero        "Needs You" · "<n> things are waiting on a decision only you can make."
1  NOT PROVEN        amber, one row per unavailable source: label + because
2  NEEDS YOU         desktop table / mobile cards
3  WITH SOMEONE ELSE same shape
4  WORTH KNOWING     prose rows, wrapped
5  EVERY SOURCE      one row per NeedsYouSourceId: ok / not applicable / could not be read
```

Band 1 is first because on a page the reader leaves after the first fold. Band 5 is what makes a
silently-dropped source visible on screen, and it is what the test asserts against.

### 🔒 Golden rules — these are measured, not reviewed

**FITS THE SCREEN — never a horizontal scroll, mobile AND desktop.** Fit by **merging columns**,
never by shrinking type. `overflow-x-auto` over a `min-width` **is** the bug.

```tsx
<table className="w-full table-fixed border-collapse">
  <colgroup>
    <col className="w-[34%]" />  {/* What needs you — label + note, break-words        */}
    <col className="w-[14%]" />  {/* How many — the number with OVERDUE beneath it      */}
    <col className="w-[22%]" />  {/* Who / since — names, then "oldest 6 Sep · 12 days" */}
    <col className="w-[30%]" />  {/* Where to do it — the link                          */}
  </colgroup>
```

Four columns, not five: count+overdue share a cell and who+oldest share a cell. That is the merge.
Mobile gets `<ul className="md:hidden …">`, one square card per item, same four facts stacked.

**SQUARE EDGES — no rounded corners anywhere.** `@/components/ui/card` carries a radius, so prefer
`SectionShell` (`src/components/admin/ceo-command-center.tsx:274`), which is already square.

**NO ELLIPSIS** — no `truncate`, no `line-clamp`, no `text-ellipsis`. `break-words` throughout;
wrapping wins.

**Names, never codes. Times in Africa/Cairo.**

### It links, it never acts
Every row's only control is a `<Link>` to the screen that already owns the decision. **No form, no
button, no server action, no non-GET fetch anywhere** under the route. Pinned by a test — that is
what turns "the module reports, it never decides" into a property of the code.

---

## Navigation

First item of the existing `command-center` section in `adminNavigationSectionSeeds`
(`src/config/system-navigation.ts:255`):

```ts
{ href: "/admin/needs-you", icon: BellRing, label: "Needs You", roles: ["Super Admin"] },
```

`roles` only, **never `permissions`** — that list is OR-ed and would widen the gate.
**No `hubPageItemGroups` entry** and **no sidebar badge in v1**: `NavBadge` does
`if (!count) return null;` and the badge route degrades to `{count: 0}`, so a badge would be the
under-report rule broken in the most-seen pixel in the product.

---

## Tests (each registered in `tests/run-tests.ts` — an unregistered test never runs)

🔴 **One `await runTest(name, fn)` per test.** A name appended beside an existing call becomes a
fourth argument: it compiles, goes green, and silently retires the other test.

**`tests/needs-you-never-under-reports.test.ts`** — drives pure `buildNeedsYouBoard`:
- one `unavailable` among ten `ok` ⇒ `allClearProvable === false`, `notProven.length === 1`, and the
  empty-state string is **absent** from the render. *Catches a dead source rendering as "nothing needs you".*
- a permission refusal ⇒ `allClearProvable === true`. *Catches `not-applicable` collapsing into `unavailable`.*
- `sources.map(s => s.id).sort()` equals the full union — for all-ok, all-failed and mixed.
  *Catches a source dropped by a lost `await` or a deleted registry line.*
- every `lane:"yours"` item has an `href` or an `externalUrl`. *Catches a row he is told is his with nowhere to go.*
- no rendered line carries `…` or `...`.

**`tests/needs-you-page-never-decides.test.ts`** — source scan of the route + component, comments
stripped: no `"use server"`, no `<form`, no `method:`/`method=`, no `onClick`, no `useFormState`, no
non-GET `fetch`. *Catches someone adding an Approve button — the change that turns a report into a decider.*

**`tests/needs-you-fits-the-screen.test.ts`** — in the idiom of
`tests/territory-tree-desktop-fits-the-screen.test.ts`: contains `table-fixed`; a `<colgroup>` whose
`w-[…%]` values sum to 100; no `min-w-[`; none of the four overflow spellings; no `rounded-`; no
`truncate`; a `md:hidden` card list beside every `hidden md:block` table.

---

## Verification — required before opening the PR

🔴 **Do NOT run a local typecheck.** `.claude/hooks/bash-guard.mjs` clause C8 denies it in every
spelling. Push and let the PR's `checks` job answer.

**Run each new test standalone** — the suite is import-registered, so `node --test` passes
*vacuously* (a file with no `test()` call reports `pass 1` for merely importing). Call the exported
function:

```bash
node --experimental-strip-types --experimental-specifier-resolution=node \
  --experimental-loader ./tests/alias-loader.mjs --input-type=module \
  -e "const m=await import('./tests/needs-you-never-under-reports.test.ts'); m.runNeedsYouNeverUnderReportsTests(); console.log('PASS')"
```

🔴 **Break each guard and watch its own assertion fire**, then restore **from a copy** — never
`git checkout --`, which deletes an uncommitted new file along with your break. Specifically: force
a source's `unavailable` to render as `ok` and confirm the under-report assertion fires.

**Measure the golden rules in a real browser — do not source-scan them.** The house rule is *verify
the emitted artifact, never the source*. The repo already drives headless Chromium
(`pnpm run ui:measure-sidebar-labels`); use the same approach:

- `scrollWidth > clientWidth` over `main` must be **false** at desktop width **and at 375px**
- computed `border-radius` on the table and the cards must be **0px**
- a non-Super-Admin must be **redirected server-side**, not merely missing the nav link — sweep with
  dev-auth headers (`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true`, `x-phoenix-role`), never the cookie flow

**Required checks** (read live from `branches/main/protection/required_status_checks`, never from a
doc — the list has rotted four times): `validate`, `checks`, `mobile`, `secret-scan`.

---

## Scope boundaries

**Do not build:** worktree retirement (`repo-doctor` owns it), any Supabase migration, a sidebar
badge, a cron job, email, Telegram, WhatsApp, or the tier-2 model summary. Those are later phases.

**Do not modify:** `src/lib/incentives/scheme-2026.ts`, `src/lib/payroll/policy.ts`,
`src/components/employee-portal/identity-card.tsx`, or the locked region of
`src/lib/sales/office-allocation.ts`. They are owner-locked.

**Open a PR against `codex/tier1-status`**, not `main` — Phase 1 has not merged yet. Say plainly in
the PR body which browser measurements you ran and what they returned.
