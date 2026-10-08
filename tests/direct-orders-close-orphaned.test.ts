import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";
import { isActiveLifecycleStatus } from "../src/lib/employees/employee-directory.ts";
import {
  orphanedRequestModuleScreens,
  type OrphanedRequestModule,
} from "../src/lib/approvals/orphaned-requests.ts";
import { marketingCancellableStatuses } from "../src/lib/marketing-requests/cancel.ts";
import { needsYouDestinations } from "../src/lib/needs-you/types.ts";

/**
 * CLOSING A RETURNED DIRECT ORDER WHOSE REQUESTER HAS LEFT.
 *
 * WHAT WENT WRONG. `returned` is answerable by exactly one person: `reviseDirectOrder` refuses
 * anyone whose canonical HR_ID is not the requester's, because a return is a question addressed to
 * the person who raised the order. When that person resigns their login is disabled, nothing expires
 * a `returned` order, and it is in nobody's queue — so it ages out of sight for ever.
 *
 * `src/lib/approvals/orphaned-requests.ts` FOUND these correctly and the Needs You board SHOWED
 * them correctly. What did not exist was any way to clear one: `cancelHeldDirectOrder` takes `held`
 * only, and Stuck Approvals reassigned weekly plans and excuses and nothing else. The board's own
 * note said "reassign or close them on the Direct Orders screen" and NEITHER CONTROL EXISTED
 * ANYWHERE IN PHOENIX. On 2026-10-08 five stranded orders (66,475.20 EGP, 52-56 days old,
 * requesters B-23 and PD-0010, both resigned District Sales Managers) were closed by hand-written
 * SQL against production, with a pre-image table, because the remedy the product promised could not
 * be clicked.
 *
 * THE TWO THINGS THIS FILE PINS, and the second is the one that stops the defect recurring:
 *
 *   1. The control is narrow. `cancelled` and never `rejected`; Super Admin only; a reason is
 *      mandatory; it REFUSES while the requester can still log in, and refuses an id the employee
 *      master does not hold at all rather than reading a missing record as a departure. That last
 *      guard is the whole difference between clearing a dead end and a delete button.
 *   2. The board's remedy VERB resolves to a control that exists. `orphanedRequestModuleScreens`
 *      now carries `requesterRemedy` as a field, and every verb it offers is checked here against a
 *      real exported function on the screen it names. Naming a verb without building the control is
 *      the original bug, and prose cannot satisfy this test.
 *
 * Everything source-pinned is read through `stripComments`/`stripSqlComments` first: these files
 * explain at length what they must not do, and a negative assertion against raw text matches the
 * sentence saying so.
 */

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/**
 * One function's body, from its signature to the next top-level `export`.
 *
 * Comments are stripped BEFORE the slice, so the offsets are the stripped text's own and every
 * "must not appear" assertion below is about code rather than about the paragraph explaining it.
 */
function bodyOf(source: string, signature: string): string {
  const code = stripComments(source);
  const start = code.indexOf(signature);
  assert.ok(start > 0, `${signature} must exist`);
  const next = code.indexOf("\nexport ", start + signature.length);
  return code.slice(start, next > 0 ? next : undefined);
}

const SERVICE = "src/lib/direct-orders/service.ts";
const WORKFLOW = "src/lib/direct-orders/workflow.ts";
const MIGRATION = "supabase/migrations/20261008040000_direct_orders_close_orphaned.sql";
const ROUTE = "app/api/direct-orders/[id]/close-orphaned/route.ts";
const HUB = "src/lib/approvals-hub/service.ts";
const PANEL = "src/components/approvals-hub/stuck-approvals-panel.tsx";
const PAGE = "app/(admin)/admin/approvals/stuck/page.tsx";
const SOURCES = "src/lib/needs-you/sources.ts";
const ORPHANS = "src/lib/approvals/orphaned-requests.ts";
const MARKETING_CANCEL = "src/lib/marketing-requests/cancel.ts";

export function runDirectOrderCloseOrphanedTests() {
  const service = read(SERVICE);
  const reader = bodyOf(service, "export async function listStrandedDirectOrders");
  const closer = bodyOf(service, "export async function closeOrphanedDirectOrder");

  // ── "Left" is the shared rule, executed ──────────────────────────────────────────────────
  //
  // Both halves of this feature — the list and the guard — turn on one predicate, and a LOOSER one
  // is the trap this very investigation fell into: the first "is the board clear now?" query
  // treated probation and notice_period as active, which returns an empty list for the wrong reason
  // and reads exactly like a real all-clear. `isActiveLifecycleStatus` counts only `active` and
  // `on_leave`, and a blank normalises to `active` so an unfilled record is never read as a leaver.
  for (const active of ["active", "on_leave", "ACTIVE", null, undefined, ""]) {
    assert.equal(
      isActiveLifecycleStatus(active),
      true,
      `"${String(active)}" must count as EMPLOYED — closing a live person's returned order destroys their own work`,
    );
  }
  for (const gone of ["resigned", "terminated", "inactive", "declined_offer", "probation", "notice_period"]) {
    assert.equal(
      isActiveLifecycleStatus(gone),
      false,
      `"${gone}" must NOT count as employed — a looser test hides a stranded order behind an empty list that reads exactly like a real all-clear`,
    );
  }

  // ── The reader ───────────────────────────────────────────────────────────────────────────
  assert.match(
    reader,
    /await listReturnedDirectOrdersAgeing\(access\)/,
    "the stranded list must be built ON TOP of the returned desk, not from a second query — a private read would drift from the desk's own scope gate and from its reason-comes-from-the-event rule",
  );
  assert.match(
    reader,
    /getEmployeeDirectoryRows\(\{ includeInactive: true \}\)/,
    "INCLUDEINACTIVE IS THE WHOLE POINT: the people this list is ABOUT are the ones the default directory drops, so the default read returns an empty list for every genuinely stranded order",
  );
  assert.match(
    reader,
    /isActiveLifecycleStatus\(employee\.employmentStatus\)/,
    "the reader must use the shared lifecycle rule, never a hand-rolled status list",
  );
  assert.doesNotMatch(
    reader,
    /new Set\(\[|=== "resigned"|=== "terminated"/,
    'A SECOND DEFINITION OF "LEFT" has been written here: it will drift from isActiveLifecycleStatus, and the direction it drifts in HIDES stranded orders rather than showing phantom ones',
  );
  assert.match(
    reader,
    /if \(!employee\) continue;/,
    'an HR_ID the employee master does not hold AT ALL must be skipped, matching selectOrphanedRequests: this surfaces a KNOWN departure, never every odd id, because a false "stranded" invites a cleanup that is not needed',
  );
  assert.match(
    reader,
    /canonicalHrIdKey\(order\.requesterHrId\)/,
    "requester_hr_id holds whichever case the submitting session had, so the join must be canonical — an exact match once hid 28% of reps' own orders",
  );
  // The CANONICAL KEY MUST BE WHAT KEYS THE MAP, not merely a call that appears nearby. Written as
  // one assertion over the pair because the loose version — "canonicalHrIdKey(employee.hrId) appears
  // somewhere in the reader" — stayed green while the map was re-keyed to the raw `employee.hrId`
  // beside it, which is the casing trap put back on the directory side. Caught by breaking the fix
  // on 2026-10-08; a pin that cannot fail is worse than no pin, because it is read as cover.
  assert.match(
    reader,
    /const key = canonicalHrIdKey\(employee\.hrId\);[\s\S]{0,120}?byKey\.set\(key, employee\)/,
    "both sides of the join must be canonicalised AND the canonical key must be what the map is keyed by, or the casing trap simply moves to the directory side",
  );

  // ── The closer: every gate ───────────────────────────────────────────────────────────────
  assert.match(
    closer,
    /assertHeldDeskAccess\(access\)/,
    "SUPER ADMIN / SYSTEM SCOPE ONLY. repair_approval_rung set the precedent that repair work must never widen access, and a TERMINAL decision on somebody else's sales request is further from a repair than a rung rebind was",
  );
  assert.match(
    closer,
    /const detail = await getDirectOrderRequest\(access, input\.requestId\);/,
    "the read must go through getDirectOrderRequest, which applies the scope guard and returns null for out-of-scope as well as for missing — so an id cannot be used to probe which requests exist",
  );
  assert.match(
    closer,
    /if \(!reason\) \{[\s\S]{0,400}?badRequest\(/,
    "a written reason is mandatory — the order dies here and that sentence is the only account of why that was right. The registry marks close_orphaned requiresReason",
  );
  assert.match(
    closer,
    /if \(detail\.request\.status !== "returned"\) \{/,
    "RETURNED ONLY: a held order is withdrawn from the Held Desk and one in the chain is decided by its approver. Widening this door is how a pending order gets cancelled out from under the approver holding it",
  );
  assert.match(
    closer,
    /if \(!requester\) \{[\s\S]{0,600}?badRequest\(/,
    "an HR_ID the master does not hold is a DIRECTORY problem, not a departure — closing a real order over a missing HR record destroys work to paper over a data gap",
  );
  assert.match(
    closer,
    /if \(isActiveLifecycleStatus\(requester\.employmentStatus\)\) \{[\s\S]{0,600}?badRequest\(/,
    "THE GATE, and the only thing separating this from a delete button: while the requester can still log in, the return is theirs to answer and nobody else's",
  );
  assert.match(
    closer,
    /actionKey: "close_orphaned"/,
    "the close must pass through the workflow registry gate like every other declared action",
  );
  assert.match(
    closer,
    /status: detail\.request\.status,/,
    "THE GATE IS BEING TOLD A CONSTANT: it must receive the row's REAL status, or the registry check only validates what this code already assumed and can never catch an anomaly (audit F6)",
  );
  assert.match(
    closer,
    /\.update\(decidedStatusPatch\("cancelled"\)\)/,
    "the write must go through decidedStatusPatch, which stamps decided_at: four earlier write paths set a deciding status by hand and left 8 rows terminal-but-undated, and direct_order_requests has no touch trigger to cover for them",
  );
  assert.match(
    closer,
    /\.eq\("status", "returned"\)/,
    "the update must be guarded on `returned` — a Super Admin may correct and resubmit on the departed requester's behalf at this very moment, which moves the order to pending_approval",
  );
  assert.match(
    closer,
    /if \(!updated \|\| updated\.length === 0\) \{[\s\S]{0,300}?badRequest\(/,
    "A LOST RACE REPORTS SUCCESS: an update that matched no row means the order stopped being returned mid-call, and reporting success there would say an order was closed while it actually sat in an approver's queue",
  );

  // ── cancelled, never rejected ────────────────────────────────────────────────────────────
  assert.match(closer, /eventType: "cancelled"/, "the event must be recorded as cancelled");
  assert.doesNotMatch(
    closer,
    /"rejected"/,
    "NOBODY TURNED THESE DOWN — four of the five were APPROVED by the SFE Manager and the National Sales Manager, and only the requester's own step was dead. Writing `rejected` would inflate every rejection rate and per-status counter that groups by status, which is exactly why cancel_held and cancel_duplicate are separate from reject",
  );

  // ── Finance owns the month, and the approval record stays readable ───────────────────────
  assert.doesNotMatch(
    closer,
    /sales_month/,
    "AN AGENT NEVER BOOKS OR UNBOOKS A SALES MONTH (standing owner rule — Finance alone, on cash collection). A stranded order was never approved, so it has no month to clear, and writing the column here would also wake trg_direct_order_weekly_sync_upd",
  );
  assert.doesNotMatch(
    closer,
    /direct_order_approval_steps/,
    "THE APPROVAL STEPS MUST BE LEFT ALONE: an approver can only act on a `pending_approval` request, so the untouched pending rungs reach nobody, and deleting or deciding them would erase who approved what — and who returned it, in whose words",
  );

  // ── Who is told ──────────────────────────────────────────────────────────────────────────
  assert.match(
    closer,
    /channels: \["in_app", "telegram"\]/,
    "in-app and Telegram only: this is a queue being tidied, not news for an inbox",
  );
  assert.doesNotMatch(
    closer,
    /"email"/,
    "NEVER EMAIL. The requester's login is disabled so an addressed email reaches nobody, every automated email also mirrors to the owner's Telegram, and no outbound send is ever fired from a tidy-up path",
  );
  assert.match(
    closer,
    /metadata: \{[\s\S]{0,400}?strandedRequesterHrId: detail\.request\.requesterHrId/,
    "the event must record WHOSE dead return this was — after the close, the status alone cannot tell this apart from an ordinary withdrawal",
  );
  assert.match(
    closer,
    /salesValueAtClose: detail\.request\.salesValue/,
    "the value at close belongs in the event: the request row stays readable, but the event is the only place that says what was given up, and when",
  );
  assert.match(
    closer,
    /writeRequiredAuditLog\(\{/,
    "a terminal decision on somebody else's request must leave an audit line naming who made it",
  );

  // ── The registry triple: the TS union, the DB row, the call site ─────────────────────────
  //
  // Stated three times in workflow.ts and still the F2 drift class: a key in only two of the three
  // is how `assertDirectOrderWorkflowTransition` ends up uncallable for an action that exists, and
  // an action naming an UNDECLARED status is the 2026-08-05 outage — normalizeActions() throws, the
  // loader catches it, and the WHOLE direct_orders module is skipped, so nobody can raise an order.
  const workflow = stripComments(read(WORKFLOW));
  const unionStart = workflow.indexOf("export type DirectOrderWorkflowActionKey");
  assert.ok(unionStart > 0, "DirectOrderWorkflowActionKey must exist");
  const union = workflow.slice(unionStart, workflow.indexOf(";", unionStart) + 1);
  assert.match(
    union,
    /\| "close_orphaned"/,
    "DirectOrderWorkflowActionKey must list close_orphaned — a key in the migration and the call site but NOT in the union is the exact mechanism by which the gate can never be called for it (audit F2)",
  );

  const migration = stripSqlComments(read(MIGRATION));
  assert.match(migration, /'key', 'close_orphaned'/, "the registry migration must declare the action key");
  assert.match(migration, /'from', jsonb_build_array\('returned'\)/, "the action's only source status is `returned`");
  assert.match(migration, /'to', 'cancelled'/, "the action's target status is `cancelled`, never `rejected`");
  assert.match(migration, /'requiresReason', true/, "the registry must mark the action as requiring a reason, matching the service");
  assert.match(
    migration,
    /'allowedRoles', jsonb_build_array\('Super Admin'\)/,
    "SUPER ADMIN ONLY in the registry too — the gate and the declaration must say the same thing, or the governance layer documents an access level the code does not enforce",
  );
  for (const field of ["'key'", "'label'", "'to'", "'from'", "'auditLog'", "'allowedRoles'"]) {
    assert.ok(
      migration.includes(`${field},`),
      `the action is missing ${field}: normalizeActions() calls normalizeRequiredText/parseRoleStrict on each of these, and any one missing throws in the LOADER, which skips the whole direct_orders module — that is the 2026-08-05 outage, where plain submit died too`,
    );
  }
  assert.doesNotMatch(
    migration,
    /statuses\s*=\s*statuses\s*\|\|/,
    "NO NEW STATUS: `returned` and `cancelled` are both already declared, and this action must not quietly extend the vocabulary",
  );
  assert.doesNotMatch(
    migration,
    /\bversion\s*=/,
    "`version` must NOT be set by hand — workflow_registry_modules_touch is a BEFORE UPDATE trigger that already bumps it, and setting it explicitly is what moved the row 5 -> 7 instead of 5 -> 6 on 2026-08-05",
  );
  assert.match(
    migration,
    /raise exception 'direct_orders registry would be SKIPPED by the loader/,
    "the migration must simulate the loader before committing — the check whose absence cost the outage, and the only thing that turns a silent runtime skip into a failed apply",
  );
  assert.match(
    migration,
    /raise exception 'close_orphaned was not added/,
    "an `update … where not exists` that matched NOTHING is silent, and a silently-absent action is exactly the shape of the bug this module keeps re-learning",
  );

  // ── The route ────────────────────────────────────────────────────────────────────────────
  const route = stripComments(read(ROUTE));
  assert.match(route, /export async function POST\(/, "the close must be a POST — a destructive action must not be reachable by navigation");
  assert.doesNotMatch(route, /export async function GET\(/, "no GET: a link, a prefetch or a crawler must never be able to close an order");
  assert.match(route, /assertSameOriginMutation\(request\)/, "every mutation route asserts same-origin before it reads the body");
  assert.match(
    route,
    /closeOrphanedDirectOrder\(access, \{/,
    "the route must delegate to the service — every gate lives there, and a second copy of a rule is how one of them gets missed",
  );
  assert.match(
    route,
    /isForbiddenError\(error\) \? 403 :/,
    "a viewer who is not a Super Admin must get 403 rather than a 500 that reads as a bug in the page",
  );

  // ── The board's remedy verb must resolve to a control that EXISTS ────────────────────────
  //
  // THE HEADLINE PIN OF THIS FILE. Until 2026-10-08 the board's note read "reassign or close them on
  // the Direct Orders screen" and neither verb had a control behind it anywhere in Phoenix, so the
  // five stranded orders it had correctly found were cleared with hand-written SQL. The verb is now
  // a FIELD on orphanedRequestModuleScreens, and each one is checked against a real exported
  // function below — a module whose verb has no control, or whose control cannot take `returned`,
  // fails here rather than on the owner's screen.
  const marketingCancel = stripComments(read(MARKETING_CANCEL));
  const requesterRemedyControls: Partial<
    Record<OrphanedRequestModule, { acceptsReturned: () => boolean; file: string; fn: string; source: string; verb: string }>
  > = {
    "direct-order": {
      acceptsReturned: () => closer.includes('detail.request.status !== "returned"'),
      file: SERVICE,
      fn: "export async function closeOrphanedDirectOrder",
      source: stripComments(service),
      verb: "close",
    },
    marketing: {
      acceptsReturned: () => marketingCancellableStatuses.has("returned"),
      file: MARKETING_CANCEL,
      fn: "export async function cancelMarketingRequest",
      source: marketingCancel,
      verb: "cancel",
    },
  };

  // Which modules hand a request BACK to its requester at all. Source-pinned because
  // BACK_WITH_REQUESTER is private, and it is the thing that decides whether a verb is ever shown.
  const orphans = stripComments(read(ORPHANS));
  const laneStart = orphans.indexOf("const BACK_WITH_REQUESTER");
  assert.ok(laneStart > 0, "BACK_WITH_REQUESTER must exist — it is what makes a request the REQUESTER's to answer");
  const lanes = orphans.slice(laneStart, orphans.indexOf("};", laneStart) + 2);

  // `moduleKey`, not `module` — `@next/next/no-assign-module-variable` refuses the latter even as a
  // loop binding, and it is a lint ERROR rather than a warning.
  for (const moduleKey of Object.keys(orphanedRequestModuleScreens) as OrphanedRequestModule[]) {
    const screen = orphanedRequestModuleScreens[moduleKey];
    const laneEmpty = new RegExp(`(?:"${moduleKey}"|${moduleKey}):\\s*\\[\\s*\\]`).test(lanes);
    const control = requesterRemedyControls[moduleKey];

    if (laneEmpty) {
      assert.ok(
        !control,
        `${moduleKey} hands nothing back to its requester, so it must not claim a requester-remedy control here`,
      );
      continue;
    }

    assert.ok(
      control,
      `"${moduleKey}" HANDS REQUESTS BACK TO THE REQUESTER AND HAS NO REMEDY CONTROL IN THIS TEST. The board prints its requesterRemedy verb to the owner, so either name the function that performs it here, or do not offer a verb — printing one with nothing behind it is the 2026-10-08 defect exactly.`,
    );
    assert.equal(
      screen.requesterRemedy,
      control.verb,
      `${moduleKey}'s board verb must be "${control.verb}", the one the ${screen.screen} screen can actually perform`,
    );
    assert.ok(
      control.source.includes(control.fn),
      `${control.fn} IS GONE FROM ${control.file}, but the board still tells the owner to ${screen.requesterRemedy} a stranded ${moduleKey} request on the ${screen.screen} screen. That promise with nothing behind it is the original bug.`,
    );
    assert.ok(
      control.acceptsReturned(),
      `${control.fn} no longer accepts a \`returned\` request, so the board's "${screen.requesterRemedy}" verb cannot be performed on exactly the requests the board is about`,
    );
  }

  assert.equal(
    orphanedRequestModuleScreens["direct-order"].requesterRemedy,
    "close",
    "CLOSE, NOT REASSIGN. A resubmit reprices the basket on today's basis and resumes at the lowest still-pending rung — the CEO's own rung, on four of the five found — so re-addressing one hands a live manager a money edit rather than an administrative tidy",
  );
  assert.equal(
    orphanedRequestModuleScreens["direct-order"].href,
    "/admin/approvals/stuck",
    "the board must link to the screen that holds the control, not to the Direct Orders list where no such button exists",
  );
  assert.equal(
    needsYouDestinations["orphaned-requests"].href,
    orphanedRequestModuleScreens["direct-order"].href,
    "the source-level fallback and the direct-order item must point at the same screen, or the band label sends the owner somewhere the item does not",
  );

  const sources = stripComments(read(SOURCES));
  assert.doesNotMatch(
    sources,
    /reassign or close/,
    'THE OLD PROMISE IS BACK: "reassign or close them" named two controls that did not exist, and a returned order cannot be reassigned at all because only the person who raised it may answer a return',
  );
  assert.match(
    sources,
    /\$\{screen\.requesterRemedy\}/,
    "the remedy verb must be interpolated from the module's own screen mapping, never typed into the copy by hand — a hand-typed verb is how one got written for a control nobody built",
  );
  assert.doesNotMatch(
    sources,
    /the rep who raised/,
    'A MEDICAL REP CANNOT RAISE A DIRECT ORDER AT ALL (DIRECT_ORDER_REQUESTER_ROLES starts at District Manager) — the five found were raised by two District Sales Managers, so the copy says "the person who raised"',
  );

  // ── The screen ───────────────────────────────────────────────────────────────────────────
  const hub = stripComments(read(HUB));
  assert.match(
    hub,
    /strandedDirectOrders: StrandedDirectOrderRow\[\];/,
    "the stuck-approvals payload must carry the stranded orders",
  );
  assert.match(
    hub,
    /canCloseStrandedDirectOrders: boolean;/,
    'HR can SEE this screen but closing is Super Admin only, so the payload must let the panel tell "none stranded" from "not yours to close" instead of rendering a button that is certain to be refused',
  );
  assert.match(
    hub,
    /const canCloseStrandedDirectOrders = access\.scope === "system" \|\| access\.role === "Super Admin";/,
    'the direct-order reader\'s own gate must be RESTATED here rather than discovered by catching its throw — a swallowed Forbidden is indistinguishable from "nothing is stranded", and this surface exists precisely because a stranded request that shows as nothing ages for ever',
  );
  assert.match(
    hub,
    /canCloseStrandedDirectOrders\s*\n?\s*\? listStrandedDirectOrders\(access\)/,
    "the reader must only be called for a viewer who may act on what it returns",
  );

  const panel = stripComments(read(PANEL));
  assert.match(
    panel,
    /\/api\/direct-orders\/\$\{encodeURIComponent\(order\.id\)\}\/close-orphaned/,
    "the panel must post to the close route — this is the control the board's verb promises",
  );
  assert.match(
    panel,
    /if \(!reason\.trim\(\)\) \{/,
    "the panel must refuse an empty reason before posting, so the mandatory reason is not first discovered as a 400",
  );
  assert.match(
    panel,
    /canCloseStrandedDirectOrders \? \(/,
    "the stranded section is Super Admin only, so HR never sees a list it cannot act on",
  );
  assert.match(
    panel,
    /order\.returnReason \?/,
    "the approver's own words are rendered — they ARE the question that went unanswered, and the owner is deciding whether to retire it",
  );
  assert.doesNotMatch(
    panel,
    /truncate|line-clamp/,
    "NEVER TRUNCATE: the return reason is the evidence for this decision, and the standing rule is that wrapping wins over shortening",
  );
  assert.doesNotMatch(panel, /rounded/, "the square-edge golden rule — no round or semi-round corners anywhere");
  // Cairo local, through the SHARED formatter and nothing else. A bespoke
  // `toLocaleDateString("en-GB", { month: "short", timeZone: "Africa/Cairo" })` right here would
  // satisfy "Cairo" and still be React error #418 every September, because the month abbreviation
  // comes from the READER's ICU build and CLDR 42 renamed en-GB "Sep" to "Sept". That is exactly
  // how this panel first went red. cairoDate() carries its own month table, so the zone is not the
  // thing to pin — the import is.
  assert.match(
    panel,
    /import \{ cairoDate \} from "@\/lib\/format\/cairo-datetime"/,
    "dates come from the shared Cairo formatter — it pins the zone AND its own month abbreviations, which a bespoke en-GB formatter cannot",
  );
  assert.doesNotMatch(
    panel,
    /["']en-GB["']/,
    "no en-GB formatter may come back into this client component — tests/react-418-hydration-safe-text.test.ts sweeps for that pairing repo-wide, and this file is what tripped it",
  );
  assert.match(panel, /order\.requesterName/, "names, never HR codes — the owner reads the person, not the id");

  const page = read(PAGE);
  assert.match(page, /strandedDirectOrders=\{data\.strandedDirectOrders\}/, "the page must pass the stranded orders to the panel");
  assert.match(
    page,
    /canCloseStrandedDirectOrders=\{data\.canCloseStrandedDirectOrders\}/,
    "the page must pass the close permission, or the panel cannot tell an empty list from an ungated one",
  );
  assert.doesNotMatch(
    stripComments(page),
    /Needs Reassignment/,
    "the page title must not promise reassignment for everything on it — a returned direct order cannot be reassigned at all, which is the distinction this whole screen now turns on",
  );
}
