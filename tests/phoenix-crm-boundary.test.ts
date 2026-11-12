import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { permissionMatrix, permissionResources, phoenixRoles, type PermissionAction, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { MODULE_LABELS } from "../src/lib/navigation/module-catalog.ts";
import { accessRegistry, findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM's edges (the owner, 2026-09-16: a clean new module, built from scratch, "we will not throw
 * it onto the old CRM and wire it in").
 *
 * Nothing about an edge fails loudly when it moves, so each one is pinned here:
 *
 *   1. who holds `phoenix_crm`, and with which actions. The matrix is gate one of two (the organogram,
 *      in src/lib/phoenix-crm/server, is gate two), so a role that gains a grant gains a module;
 *   2. every route asserts exactly the action this file lists, on the caller's own access context,
 *      BEFORE it reads a body, a query or the organogram, and every POST refuses a cross-site request
 *      first; the access registry says the same thing, and the screens call only those routes;
 *   3. nothing in the module reaches the 2026-09-13 pilot (crm_native_*, its cutover date, its contact
 *      list changes, its pages) or iReports360's own tables;
 *   4. the rules the phone runs, and the screens, import no server code, so a service-role client can
 *      never be bundled for a phone;
 *   5. the migration: service-role-only tables and functions, writes to its own tables only, a private
 *      JPEG bucket, and the Cairo day always stated (never the database's `current_date`);
 *   6. the risk review's fixes (2026-09-17), in the database and in the services: plan against actual
 *      keeps a finished day when a plan is reopened or returned, a readiness gap never reads as ready, an
 *      empty reference list is never stamped ready, a week that is over keeps its plan, a photo slot
 *      lasts 2 hours, the migration never queues uploads behind a lock, the product list is paged, and
 *      the paid street-address lookup is limited per person.
 */

// ── 1. The permission grants ─────────────────────────────────────────────────────────────────────────

const GRANTS: ReadonlyArray<readonly [PhoenixRole, readonly PermissionAction[]]> = [
  // Tries the module in test mode on any territory; `update` is the Settings tab.
  ["Super Admin", ["read", "create", "update", "approve"]],
  ["CEO", ["read"]],
  // Validates the territory's customers, plans the week and enters visits: its own territory only.
  ["Medical Rep", ["read", "create"]],
  // Decides grades, drops and plans beneath them; enters a visit when the rep does not.
  ["District Manager", ["read", "create", "approve"]],
  // Decides plans where the district seat is vacant; the rep enters a chain visit.
  ["Regional Manager", ["read", "approve"]],
  ["National Sales Manager", ["read", "approve"]],
  // Sees every plan and may return one (narrowed to returning in the service).
  ["SFE Manager", ["read", "approve"]],
  // The Doctors directory and NOTHING else. Owner, 2026-09-22: "give SFE and Training Manager the
  // full company list too", then, asked whether he should also reach a customer's page: "The list is
  // enough for him." He holds no sales seat, so `territoryForRead` refuses him every territory and
  // the list is where he stops — measured 403 on list and visits. READ alone is the whole grant:
  // `create`, `update` and `approve` are what resolvePhoenixCrmViewer turns into entering visits,
  // requesting list changes and deciding them, and he does none of those.
  ["Training Manager", ["read"]],
  // ONE report and nothing else (owner, 2026-10-02: "product managers and marketing see it too — for
  // their own products, company-wide, never per rep and never any honesty figure"): what the field
  // heard about their own products. Like the Training Manager they hold no sales seat, so every other
  // read answers them with nothing or a refusal; READ alone, because the other three actions are what
  // resolvePhoenixCrmViewer turns into entering and deciding. tests/phoenix-crm-insight-reports.test.ts
  // pins what the one report shows them.
  ["Product Manager", ["read"]],
  ["Group Product Manager", ["read"]],
  ["Marketing Manager", ["read"]],
];

function runPermissionTests() {
  assert.ok(permissionResources.includes("phoenix_crm"), "phoenix_crm is a runtime resource — a key missing from the lookup reads as ALLOWED in navigation");
  assert.equal(MODULE_LABELS.phoenix_crm, "Phoenix CRM");

  const designed = new Map<PhoenixRole, readonly PermissionAction[]>(GRANTS);
  for (const role of phoenixRoles) {
    const held = [...(permissionMatrix[role].phoenix_crm ?? [])].sort();
    const wanted = [...(designed.get(role) ?? [])].sort();
    // Exact, so nobody gains delete, export or import either: nothing in the module is deleted or exported.
    assert.deepEqual(
      held,
      wanted,
      `${role} holds phoenix_crm [${held.join(", ")}] but the module was designed for [${wanted.join(", ")}] — a new holder opens the module to a whole role`,
    );
  }
}

// ── 2. The routes, the registry and the screens' calls ──────────────────────────────────────────────

type RouteGate = {
  route: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  action: PermissionAction;
  audit: "mutation" | "access-read" | "export" | null;
  auditRequired: boolean;
};

function get(route: string, action: PermissionAction = "read"): RouteGate {
  return { route, method: "GET", action, audit: null, auditRequired: false };
}

/**
 * A GET that hands back a FILE.
 *
 * Its own helper rather than an option on `get`, because the difference is not a flag: an ordinary
 * read is answered on a screen and gone, while a workbook naming individual employees and their work
 * leaves the building and is kept. That is why it audits and an ordinary read does not.
 */
function exportGet(route: string, action: PermissionAction = "read"): RouteGate {
  return { route, method: "GET", action, audit: "export", auditRequired: true };
}

function post(route: string, action: PermissionAction): RouteGate {
  return { route, method: "POST", action, audit: "mutation", auditRequired: true };
}

/**
 * A PATCH: an edit of something already saved, audited like any other write.
 *
 * Its own helper rather than an option on `post`, because the two are not interchangeable at the door:
 * a POST creates, while a PATCH may only touch a row that exists, so the service behind it is asked
 * whose row it is. Same read grant, same CSRF, same audit row.
 */
function patch(route: string, action: PermissionAction): RouteGate {
  return { route, method: "PATCH", action, audit: "mutation", auditRequired: true };
}

const API_ROOT = "app/api/phoenix-crm";

const ROUTE_GATES: RouteGate[] = [
  get("overview"),
  get("visits"),
  post("visits", "create"),
  // Only someone who may enter a visit opens its form.
  get("visits/form", "create"),
  // The rep's own open commitments — what he told a customer he would do and has not been back for
  // (2026-10-03). A plain `read`, and there is NO POST on purpose: a commitment closes by going back
  // to the customer, never by a tick, because a completion input would be a step added to his day
  // (golden rule #1, the EASY half). Narrowed in the service to the territory's OWN rep
  // (`territoryForRepWrite`) — these are the sentences HE wrote, and a manager-readable list of them
  // is a judgement of him.
  get("commitments"),
  // His prep for the next day a plan can hold: last seen, the last objection, his own open next step,
  // the last products (2026-10-03). A plain `read`, no POST at all — the plan is weekly and a SENT
  // week changes only through "Ask to edit this week", so nothing on this path may write. Narrowed in
  // the service to the territory's own rep, like the commitments above.
  get("call-prep"),
  get("list"),
  // The same territory's list as the Reps List board holds it — by brick, with the month's activity.
  // It reads a SECOND source beside the CRM's own, so it is authorised through the CRM's own seat
  // gate (`territoryForRead`, the first line of `loadTerritoryList`) before the board is ever loaded,
  // and is scoped to that seat's rep. The gate alone — never the whole List load a second time.
  get("list/board"),
  // The SFE's customer-list template (owner's ask, 2026-10-02): the sheet for one territory out, the
  // filled sheet back. `update` — the same gate as Settings — because it writes a whole list at once
  // WITH the grades, which on the ordinary path is the district manager's decision and SFE's approval
  // taken one customer at a time. Narrowed again in the service to the SFE Manager and the Super Admin,
  // through the integrity board's own two-reader predicate.
  exportGet("list/template", "approve"),
  post("list/template/import", "approve"),
  post("list/validate", "create"),
  // The name and speciality, corrected after validating (owner, 2026-09-22): the rep's own write.
  post("list/rename", "create"),
  // The pharmacy the rep pins as this doctor's primary (owner, 2026-09-24): his own write.
  post("list/primary-pharmacy", "create"),
  // A pharmacy he adds to his own list by its name (owner, 2026-10-03): his own write, no approval.
  post("list/pharmacy", "create"),
  // A pharmacy's own location and its responsible person's phone (owner, 2026-10-09), both optional
  // and both corrected here. `create` on his own pharmacy and nothing more: a pharmacy's pin is a
  // RECORD, so there is no approval to ask for and nothing is measured against it.
  post("list/pharmacy-details", "create"),
  // One customer's past Phoenix visits, newest first, on his page (owner, 2026-10-02). Read through the
  // same seat gate as the list (`territoryForRead`), and carrying no location, distance or flag.
  get("list/timeline"),
  post("list/places", "create"),
  post("list/places/update", "create"),
  // A new signboard photo for a place the system sent back to its rep (2026-10-18): his own write on
  // his own seat, and only a place waiting on one (`retakePlaceSignboard`) — never a free swap.
  post("list/places/signboard", "create"),
  // Moving or removing a validated place (owner, 2026-09-29): the Super Admin and the SFE Manager only.
  post("list/places/move", "approve"),
  // Seating customers in a validated polyclinic (owner, 2026-10-10): the Super Admin alone — `update` at the route, `canDecideSharedPlaces` in the service.
  post("list/places/seat", "update"),
  // Validating a customer on the trusted point his reps' own readings agree on (owner, 2026-11-10): the Super
  // Admin alone — `update` at the route, `canPlaceOnTrustedPoint` (= canDecideSharedPlaces) in the service.
  get("list/places/trusted-point", "update"),
  post("list/places/trusted-point", "update"),
  // The Master List's confirm / not confirmed / clear and its chosen photo (owner, 2026-10-26: "my click
  // and automatic"): the Super Admin alone — `update` at the route, `saveMasterDecision` refuses everyone
  // else in the service. It writes only the decisions table; no rep's place moves.
  post("master-list/decision", "update"),
  // A comment on one place check, and a recommendation about it (owner, 2026-10-13): the Super Admin,
  // or a district manager on his OWN team's seats. `approve` and NOT `update` — a District Manager
  // holds phoenix_crm ["read", "create", "approve"] and no `update` at all, so `update` would 403 the
  // one person these two routes exist for. The real boundary is the service: it re-reads the place's
  // own seat and compares it against `teamPlaceChecksSeats`, so the RSM, the NSM and the SFE Manager,
  // who also hold `approve`, are refused there. Neither route decides anything.
  post("place-notes", "approve"),
  post("place-notes/recommendation", "approve"),
  // Approving or rejecting a place the Google Maps check could not confirm (owner, 2026-10-03): the
  // Super Admin and the SFE Manager (2026-10-19) — `approve` at the route (the SFE Manager holds no `update`), `canDecideValidationReviews` in the service.
  post("validation-reviews", "approve"),
  // Refusing a validation the check never held — every PM customer, and the AM ones that matched
  // (2026-10-03). The same gate, the same decider, and the same reject underneath it.
  post("validation-reviews/refuse", "approve"),
  // Confirming a validation the system could not read (owner, 2026-10-17): the same gate and decider.
  post("validation-reviews/approve", "approve"),
  // Approving a place AFTER it was rejected (owner, 2026-10-03): the same gate and the same decider.
  post("validation-reviews/restore", "approve"),
  // Deciding a POLYCLINIC or centre (owner, 2026-10-09: the administrator has the right to review the
  // schedule and look). The same gate and the same decider as a place's review — `approve` at the route
  // and `canDecideValidationReviews` in the service (`canDecideSharedPlaces` now gates seating only) — and a rejection
  // retires every place seated in the venue.
  post("validation-reviews/shared-place", "approve"),
  // Approving a venue AFTER rejecting it (owner, 2026-10-15) — its own route, its own rules.
  post("validation-reviews/shared-place/restore", "approve"),
  // A PM customer's full name that matched the signboard under 60% (owner, 2026-11-07, pm-name-rules.ts):
  // `approve` at the route, and `decideHeldFullName` narrows it to the Super Admin and the SFE Manager
  // before a row is read.
  post("full-names", "approve"),
  // The Polyclinic Caps page (owner, 2026-11-02): one switch or one number on one rep's venue. `approve` at the route,
  // and `setVenueCap` narrows it to the Super Admin and the SFE Manager before a row is read.
  post("venue-caps", "approve"),
  // The Rep Exceptions page (owner, 2026-11-03): one switch or one change of dates for one rep. `approve` at the route,
  // and `setRepException` narrows it to the Super Admin and the SFE Manager before a row is read.
  post("rep-exceptions", "approve"),
  // The third tab of Place checks (owner, 2026-10-17): places several reps validated, side by side, and
  // his answer to "are these the same place?". `read` to open it and `approve` to answer, the Super Admin and the SFE Manager
  // only — the loader and the service refuse everyone else before a row is read.
  get("validation-reviews/same-place"),
  post("validation-reviews/same-place", "approve"),
  // The fourth tab (owner, 2026-10-26): one customer several reps validated at places that do not agree.
  // A read only, the deciders alone — the loader refuses everyone else before a row is read.
  get("validation-reviews/same-customer"),
  // The venues themselves: the list a rep standing in one picks from, and the capture at its door.
  // `read` and `create`, the same pair a place has, and `territoryForValidation` narrows the capture
  // in the service exactly as it narrows `list/places`.
  get("shared-places"),
  post("shared-places", "create"),
  // The rep drops a customer met outside his list; the SFE Manager brings one back from the Archive.
  post("list/outside/drop", "create"),
  post("list/archive/bring-back", "approve"),
  // The SFE Manager curates a rep's list from OUTSIDE it (owner, 2026-10-06): he drops an irrelevant
  // customer himself, and hands one to a rep he chooses. `approve`, because both are the SFE step's own
  // authority rather than a rep's ask — then narrowed again in the service to `canCurateList`, which is
  // the place-movers' set of people: the SFE Manager in scope and the Super Admin, never a test
  // persona. The drop is still FILED and decided as a `drop` request, so the Archive's history reads
  // the same whoever took the customer off; a rep's own ask keeps its two steps at `list/requests`.
  post("list/curate/drop", "approve"),
  post("list/curate/move", "approve"),
  post("list/requests", "create"),
  post("list/requests/withdraw", "create"),
  post("list/requests/decide", "approve"),
  post("list/requests/return", "approve"),
  post("list/requests/answer", "create"),
  get("plans"),
  post("plans", "create"),
  post("plans/submit", "create"),
  post("plans/decide", "approve"),
  // A sent week is changed through a request (owner, 2026-10-01): the rep asks (`create`); the district
  // manager, SFE and HR take their steps (`approve`, narrowed again in the service to the one person
  // whose STEP it is — read from the row, never the body).
  post("plans/edit-requests", "create"),
  post("plans/edit-requests/decide", "approve"),
  // The Administrator takes back a decision already taken (owner, 2026-10-08).
  post("administrator/reverse", "approve"),
  get("plans/reviews"),
  // Last month's iReports360 plan, read-only, as the "Copy last month" reference (server/plan-history).
  get("plans/history"),
  // The territory's own Phoenix plans between two days — what the three copies replay.
  get("plans/copy-source"),
  // The monthly umbrella above the weekly plans: the whole month in the planner, and the rep's own
  // submit/reopen of the month. The days are still saved a week at a time through /plans; this never
  // writes a placement. A manager's decision on a sent month is /monthly-plans/reviews.
  get("monthly-plans"),
  post("monthly-plans", "create"),
  get("monthly-plans/reviews"),
  post("monthly-plans/reviews", "approve"),
  // An off-plan visit's decision. `approve`, the same split as a grade or drop request, and narrowed
  // AGAIN in the service to the one person whose STEP it is (the territory's reviewer, then the SFE
  // Manager) — a district manager holding `approve` is not entitled to another district's visits.
  // There is no GET: the queue rides in /team, so one decision refreshes the whole tab.
  post("visits/unplanned", "approve"),
  // A record a rep MISSED, entered for him by the Super Admin (owner, 2026-10-01): what can be entered
  // on a day, and the entry itself. `update` — the Super Admin's own gate, as Settings is — and narrowed
  // again in the service to the Super Admin alone (`territoryForMissedRecord`).
  get("missed-records", "update"),
  post("missed-records", "update"),
  // A visit a rep SUBMITTED, corrected by the Super Admin (owner, 2026-10-06): who was on it, its
  // products and its comment. `update`, and narrowed again in the service to the Super Admin alone
  // (`territoryForVisitEdit`).
  get("visit-edit", "update"),
  post("visit-edit", "update"),
  // A plan, visit or day record DELETED by the Super Admin as if it never happened (owner, 2026-10-23).
  // POST only. `update`, narrowed again in the service to the Super Admin alone (`canEnterMissedRecords`).
  post("admin-delete", "update"),
  // The detail of HIS OWN visit, filled in afterwards by the REP (owner, 2026-10-15): the detailed
  // comment, the objection, the next step, what he left, the pharmacy stock, and a pharmacy name the
  // visit does not yet carry. `read`/`create` — the rep's own permissions, he holds no `update` — and
  // narrowed again in the service to the territory's own rep (`territoryForRepWrite`, which refuses the
  // Super Admin by name) and in SQL to `rep_hr_id = actor`. A SECOND door beside visit-edit above, never
  // a widening of it.
  get("visit-detail", "read"),
  post("visit-detail", "create"),
  get("team"),
  // The Super Admin's own "Test accounts" tab (owner, 2026-10-22): every test entry waiting, and his
  // decision on one. `read` and `approve` — the gates of the real screens these decisions come from —
  // narrowed in the service to the Super Admin signed in as himself with a deciding grant
  // (`assertTestWorldDecider`), and the decision to a row whose own `is_test` is true.
  get("test-approvals"),
  post("test-approvals/decide", "approve"),
  // The district manager's double-visit plan (owner, 2026-10-02): which of his reps he joins on which
  // day, AM or PM. The rep never sees it. `read`, narrowed in the service to that district manager, the
  // SFE Manager and the Super Admin; `create` for a half-day, narrowed to the district manager's OWN plan
  // (and the Super Admin's test mode). SFE holds no `create`, so it reads and never writes.
  get("double-visit-plans"),
  post("double-visit-plans", "create"),
  // The manager's weekly plan (owner, 2026-10-16; the regional, national and product managers since
  // 2026-10-17). Every route is `read` at the door — those planners, the CEO and the Marketing Manager hold
  // `read` alone — and the service narrows a write to the manager who plans the week
  // (`assertManagerPlanWriter`, which still asks a district manager for `create`) and a decision to the
  // approver stored on the row, or the Administrator in his place. The name match is a read sent as a POST.
  get("manager-plans"),
  post("manager-plans", "read"),
  post("manager-plans/submit", "read"),
  post("manager-plans/decide", "read"),
  post("manager-plans/edit-requests", "read"),
  post("manager-plans/edit-requests/decide", "read"),
  get("manager-plans/customers"),
  post("manager-plans/customers", "read"),
  get("manager-plans/customers/area"),
  get("manager-plans/customers/bricks"),
  // The marks on each doctor of the rep or area he plans with (owner, 2026-10-23).
  get("manager-plans/customers/insight"),
  // "Show visit times" on each customer he plans with (owner, 2026-11-05) — the marks' own gate in the service.
  get("manager-plans/customers/visit-times"),
  // The week's Excel file (2026-11-09) — "read", then the board's reader rule or the hub's; an export, audited.
  exportGet("manager-plans/export"),
  { route: "manager-plans/customers/match", method: "POST", action: "read", audit: "access-read", auditRequired: true },
  { route: "manager-plans/customers/locate", method: "POST", action: "read", audit: "access-read", auditRequired: true },
  post("manager-plans/customers/removal", "read"),
  post("manager-plans/customers/removal/decide", "read"),
  // His ask for a second or third day of single visits (owner, 2026-10-20).
  // The week's conversation (owner, 2026-11-01): read at the door, narrowed in the service to whoever opens that week.
  get("manager-plans/conversation"),
  post("manager-plans/conversation", "read"),
  get("manager-plans/single-visit-days"),
  post("manager-plans/single-visit-days", "read"),
  post("manager-plans/single-visit-days/decide", "read"),
  get("manager-plans/visits"),
  post("manager-plans/visits", "read"),
  // A manager writes up a single visit he already logged (owner, 2026-10-23).
  patch("manager-plans/visits", "read"),
  get("manager-plans/report"),
  // A rep's ask for a visit with somebody (owner, 2026-10-02) — his manager, a product manager of his
  // line, or a chain visit with his district manager and the manager above. A SEPARATE workflow from
  // the double-visit plan above, which the rep never sees. The customer's page reads its asks through
  // the list's seat gate; the rep raises and cancels his own (`create`, narrowed to the territory's own
  // rep); the inbox is a `read` narrowed in the service to the people an ask reaches.
  get("visit-asks"),
  post("visit-asks", "create"),
  post("visit-asks/cancel", "create"),
  // 🔴 Answering is `read` on purpose: a product manager holds phoenix_crm `read` and nothing else, so
  // it is the narrowest gate that serves every person asked. Gate two is IDENTITY, read from the ask's
  // own row (`assertVisitAskAnswerer`), never a name in the body — and it is audited as a mutation.
  post("visit-asks/answer", "read"),
  get("visit-asks/inbox"),
  // A rep's REQUEST for a double visit (owner, 2026-10-16) — the last question of his visit, any number of
  // the people offered, up to three days. A SEPARATE workflow from the ask above, and it has NO cancel
  // route: he edits the days and never takes the request back. The customer's page reads through the
  // list's seat gate; the edit is `create` narrowed to the territory's own rep; answering is `read` for
  // the same reason as above (a product manager holds `read` alone) with the identity gate read from the
  // request's own row; the report is `read`, narrowed in the service by `doubleVisitReportAudience`.
  get("double-visit-requests"),
  post("double-visit-requests/edit", "create"),
  post("double-visit-requests/answer", "read"),
  get("double-visit-requests/report"),
  // The Doctors directory: validated customers across territories, scoped downward on the server.
  get("doctors"),
  // There is no "integrity" gate here because there is no integrity ROUTE (2026-09-26). It had no
  // caller — the board is a server component reading the service directly — so it was an address and
  // nothing else. The list below is asserted against the handlers on disk, so this absence is itself
  // checked: re-adding the route without a gate fails, and adding a gate without the route fails.
  get("today"),
  get("day-activities"),
  post("day-activities", "create"),
  // The interviews on an Interviews day (owner, 2026-10-29): the read, an add (multipart, with the CV)
  // and a remove are the day's own; opening an added CV hands back a candidate's file, so it audits.
  get("day-interviews"),
  post("day-interviews", "create"),
  post("day-interviews/remove", "create"),
  exportGet("day-interviews/cv"),
  // "Show your manager you started working" (owner, 2026-10-03): the read is any reader of the
  // territory — a manager looking at whether his rep started, and on which day — while the press is
  // narrowed in the service to the territory's OWN rep, the same boundary the day activity keeps.
  get("day-start"),
  post("day-start", "create"),
  // The CNS daily forecast (owner, 2026-10-01). The form and its send are the territory's own rep's
  // (narrowed again in the service); the board is a read, narrowed there to readers of team reports.
  get("forecast"),
  post("forecast", "create"),
  get("forecast/board"),
  get("reports"),
  // The whole reports pack as one workbook (C1). Same "read" gate as the screen it exports: which
  // SHEETS the file holds is the access control, and a section the viewer may not read is never
  // loaded and writes none — so the export can never be a way round a refusal on the tab.
  exportGet("reports/export"),
  // The Visit report generator (owner, 2026-10-15). A READ sent as a POST — the chosen fields do not belong
  // in a URL — audited as a read, and narrowed in the service to the Super Admin and the SFE Manager. Its
  // workbook is an export for the reason the pack's is: a file naming employees leaves the building.
  { route: "visit-report", method: "POST", action: "read", audit: "access-read", auditRequired: true },
  exportGet("visit-report/export"),
  // The Visit report's saved views (owner, 2026-10-16): each reader's own named choices of fields. The
  // report's own `read` gate and 404 (`canReadVisitReport`); the service keys every call on the viewer's
  // HR id and takes no owner argument. A save and a delete write to the database, so both are audited as
  // mutations and both refuse a cross-site request first; the list is a plain read.
  // A beacon for the visit retry: it always answers 204, and its row in the resend log is the record. The GET is the
  // switch and the ids on file, called only while the phone holds something.
  get("visit-resend-report", "create"),
  { route: "visit-resend-report", method: "POST", action: "create", audit: "mutation", auditRequired: false },
  get("visit-report/views"),
  // The Visit report's customer picker (owner, 2026-11-04) — names only, behind canReadVisitReport.
  get("visit-report/customers"),
  post("visit-report/views", "read"),
  { route: "visit-report/views", method: "DELETE", action: "read", audit: "mutation", auditRequired: true },
  // The one-page start guide, English or Arabic. A plain `read` and no audit: it is a help page whose
  // content is identical for everyone who can open the module, holding no rep, no customer and no
  // figure — there is nothing here for an organogram scope to narrow or for an export log to record.
  get("start-guide"),
  // The time anchor (A1 phase 2): a server-minted starting point the phone measures elapsed
  // MONOTONIC time against, so an offline visit never needs a timestamp from a clock a rep can move.
  // Same permission and audience as entering a visit, because that is what it dates.
  post("time-anchor", "create"),
  post("photos/upload-slot", "create"),
  // The native app's live photo: the phone sends the stamped JPEG as a base64 data URL and the server
  // does the PUT to the slot itself. Same create gate as upload-slot, which it calls to issue the slot.
  post("photos/upload", "create"),
  // A read sent as a POST (a batch of photo paths does not belong in a URL), audited as a read.
  { route: "photos/sign", method: "POST", action: "read", audit: "access-read", auditRequired: true },
  // The voice note's slot: the same create gate as the photo's, because whoever may enter this
  // territory's visits is exactly who may attach a recording to one. It is a SEPARATE route rather
  // than a purpose argument on photos/upload-slot for the reason the table is separate — a recording
  // is not evidence of presence and must never be reachable through the path that issues one.
  post("voice/upload-slot", "create"),
  // Playback, on the photo's own pattern: a read sent as a POST, audited because hearing what a rep
  // said on a call discloses as much as seeing where they stood.
  { route: "voice/sign", method: "POST", action: "read", audit: "access-read", auditRequired: true },
  // Whether this browser can be offered written words at all: it answers one boolean — is a speech
  // service configured — and names neither the vendor nor the key, so it is a plain read.
  get("voice/transcribe"),
  // Writing out a recording the rep just made, on the browsers that have no speech engine of their
  // own (Firefox). `create` because it writes into the visit the rep is entering, and audited as a
  // read because what it discloses is the recording's contents — the same disclosure as voice/sign.
  { route: "voice/transcribe", method: "POST", action: "create", audit: "access-read", auditRequired: true },
  // The visit recording the Super Admin requires of the reps chosen on one page (owner, 2026-10-16).
  // The slot is the voice note's gate; the service narrows it to the territory's own rep.
  post("recording/upload-slot", "create"),
  // Playback, audited as the voice note's is: hearing a visit's conversation is a disclosure. The
  // service narrows it to the Super Admin, the SFE managers and the managers above the territory.
  { route: "recording/play", method: "POST", action: "read", audit: "access-read", auditRequired: true },
  // The Super Admin's own page — the switch, a download, a delete. `update` at the route; every service
  // behind them refuses anybody but the Super Admin (`canManageVisitRecording`).
  post("recording/admin", "update"),
  { route: "recording/admin/download", method: "POST", action: "update", audit: "access-read", auditRequired: true },
  post("recording/admin/delete", "update"),
  // The Administrator approves or refuses a recorded visit (owner, 2026-10-16); the service asks canAdminister again.
  post("recording/admin/review", "approve"),
  // The place stamp burned into a live photo: same gate as taking the photo; it persists nothing.
  { route: "location", method: "POST", action: "create", audit: "access-read", auditRequired: false },
  // A permission the BROWSER blocked, reported by the browser itself (owner, 2026-10-13: "record a
  // browser-blocked permission so it reaches the refused-readings board"). `read`, because a rep who
  // may OPEN the module is a rep whose blocked camera belongs on the board that exists to help him,
  // and a `create` gate would miss every manager entering for one.
  // A mutation, since it writes a row, but never REQUIRED in the audit — the row IS the record, and
  // an audit entry beside it would be a second copy of the same fact.
  { route: "refused-readings", method: "POST", action: "read", audit: "mutation", auditRequired: false },
  // The SFE's answer on a visit held for him after five far refusals from one spot (owner, 2026-11-10);
  // the service asks canDecideFarVisitHolds again — the Super Admin and the SFE Manager only.
  post("far-visit-holds/decide", "approve"),
  // The pulsing "new" badge clearing (owner, 2026-10-08): the viewer has a module on screen, so his OWN
  // unread notices that open it are marked read. `read` — a manager who only reads the module has
  // notices too — and a mutation that is not REQUIRED in the audit, since it is one flag on rows that
  // are already his and fires on every module visit.
  { route: "notices/seen", method: "POST", action: "read", audit: "mutation", auditRequired: false },
  get("settings", "update"),
  post("settings", "update"),
];

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files.sort();
}

function methodBlocks(source: string): Map<string, string> {
  const starts = [...source.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)];
  const blocks = new Map<string, string>();
  starts.forEach((match, index) => {
    const from = Number(match.index);
    const to = index + 1 < starts.length ? Number(starts[index + 1].index) : source.length;
    blocks.set(match[1], source.slice(from, to));
  });
  return blocks;
}

function runRouteTests() {
  const gateKeys = ROUTE_GATES.map((gate) => `${gate.method} ${gate.route}`).sort();
  assert.equal(new Set(gateKeys).size, gateKeys.length, "each route and method is listed once");

  // The handlers on disk are exactly the routes listed above.
  const files = walk(API_ROOT);
  assert.ok(files.length >= 20, `the route scan found only ${files.length} files — it has stopped seeing the module`);
  const onDisk: string[] = [];
  for (const file of files) {
    assert.match(file, /\/route\.ts$/, `${file}: only route handlers live under ${API_ROOT}`);
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /from "@\/lib\/supabase/, `${file} reaches the database only through the module's services`);
    const route = file.slice(API_ROOT.length + 1, file.length - "/route.ts".length);
    for (const method of methodBlocks(source).keys()) onDisk.push(`${method} ${route}`);
  }
  assert.deepEqual(onDisk.sort(), gateKeys, "a Phoenix CRM route was added, removed or given a method without its gate being decided in this file");

  // Each handler asserts its action once, first thing after resolving the caller.
  for (const gate of ROUTE_GATES) {
    const label = `${gate.method} /api/phoenix-crm/${gate.route}`;
    const block = methodBlocks(readFileSync(`${API_ROOT}/${gate.route}/route.ts`, "utf8")).get(gate.method);
    assert.ok(block, `${label} has no handler`);

    const asserted = [...block.matchAll(/assertPermission\(\s*(\w+)\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)].map(
      (match) => `${match[1]} ${match[2]}:${match[3]}`,
    );
    assert.deepEqual(asserted, [`access phoenix_crm:${gate.action}`], `${label} asserts phoenix_crm:${gate.action}, once, on the caller's own access`);
    assert.doesNotMatch(block, /\bcanAccess\(/, `${label}: the gate is assertPermission, never a softer canAccess branch`);

    const contextAt = block.indexOf("const access = await resolveAccessContext(request);");
    const gateAt = block.indexOf("await assertPermission(access,");
    assert.ok(contextAt >= 0 && gateAt > contextAt, `${label} resolves the caller, then asserts the permission`);
    for (const early of ["request.json(", "searchOf(", "resolvePhoenixCrmViewer(", "getSupabaseAdmin("]) {
      const at = block.indexOf(early);
      assert.ok(at === -1 || at > gateAt, `${label} calls ${early} before its permission check`);
    }

    if (gate.method !== "GET") {
      const csrfAt = block.search(/const csrf = assertSameOriginMutation\(request\);\s+if \(csrf\) return csrf;/);
      assert.ok(csrfAt >= 0 && csrfAt < contextAt, `${label} refuses a cross-site request before anything else`);
    } else {
      assert.equal(block.includes("request.json("), false, `${label} reads no body`);
    }
  }

  // The access registry says the same thing, one entry per method.
  const registered: string[] = [];
  for (const entry of accessRegistry) {
    if (!entry.pattern.startsWith("/api/phoenix-crm/")) continue;
    assert.equal(entry.methods.length, 1, `${entry.pattern}: one registry entry per method, so each method's action is stated on its own`);
    const method = entry.methods[0];
    const route = entry.pattern.slice("/api/phoenix-crm/".length);
    const label = `${method} ${entry.pattern}`;
    registered.push(`${method} ${route}`);
    const gate = ROUTE_GATES.find((candidate) => candidate.route === route && candidate.method === method);
    if (!gate) continue; // named by the set comparison below
    assert.deepEqual(entry.permission, { resource: "phoenix_crm", action: gate.action }, `${label}: the registry declares the action the handler asserts`);
    assert.equal(entry.authMode, "session", `${label} is a session route`);
    assert.equal(entry.guard, "assert-permission", `${label} is gated by assertPermission`);
    assert.equal(entry.csrf.required, method !== "GET", `${label}: every write checks the origin, and no GET claims to`);
    assert.equal(entry.audit.classification, gate.audit ?? undefined, `${label}: audit classification`);
    assert.equal(entry.audit.required, gate.auditRequired, `${label}: audit required`);
    assert.equal(findAccessRegistryEntry(entry.pattern, method)?.pattern, entry.pattern, `${label} resolves to its own entry, never a blanket`);
  }
  assert.deepEqual(registered.sort(), gateKeys, "the access registry lists exactly the Phoenix CRM routes");

  // The screens call only those routes, each with a method it takes.
  const methodsByPath = new Map<string, Set<string>>();
  for (const gate of ROUTE_GATES) {
    const path = `/api/phoenix-crm/${gate.route}`;
    methodsByPath.set(path, new Set([...(methodsByPath.get(path) ?? []), gate.method]));
  }
  let calls = 0;
  let patchCalls = 0;
  for (const file of walk("src/components/phoenix-crm")) {
    const source = readFileSync(file, "utf8");
    // A screen may hold its route in a file-local constant (`const VISITS = "/api/..."`), so the sweep
    // resolves those before reading a call's first argument; without that it silently matches nothing.
    const pathConstants = new Map(
      [...source.matchAll(/\bconst ([A-Z][A-Z0-9_]*) = "(\/api\/[^"]+)";/g)].map((match) => [match[1], match[2]]),
    );
    const pathOf = (argument: string): string | null => pathConstants.get(argument) ?? (argument.startsWith("/api/") ? argument : null);
    for (const match of source.matchAll(/["'`](\/api\/[^"'`?$]*)/g)) {
      assert.ok(methodsByPath.has(match[1]), `${file} calls ${match[1]}, which is not a Phoenix CRM route`);
    }
    for (const match of source.matchAll(/\bcrmPost(?:<[^();{}\n]*>)?\(\s*"([^"]+)"/g)) {
      calls += 1;
      assert.ok(methodsByPath.get(match[1])?.has("POST"), `${file} posts to ${match[1]}, which takes no POST`);
    }
    for (const match of source.matchAll(/\b(?:crmGet|crmUrl)(?:<[^();{}\n]*>)?\(\s*"([^"]+)"/g)) {
      calls += 1;
      assert.ok(methodsByPath.get(match[1])?.has("GET"), `${file} reads ${match[1]}, which takes no GET`);
    }
    // api.ts DECLARES crmPatch, so its own `crmPatch<T>(path` is not a call to a route.
    for (const match of file.endsWith("/api.ts") ? [] : source.matchAll(/\bcrmPatch(?:<[^();{}\n]*>)?\(\s*([A-Za-z0-9_]+|"[^"]+")/g)) {
      const route = pathOf(match[1].replace(/"/g, ""));
      assert.ok(route, `${file} patches ${match[1]}, which is not a path it declares`);
      calls += 1;
      patchCalls += 1;
      assert.ok(methodsByPath.get(route)?.has("PATCH"), `${file} patches ${route}, which takes no PATCH`);
    }
  }
  assert.ok(calls >= 15, `the screens' calls were found only ${calls} times — the scan has stopped seeing them`);
  assert.ok(patchCalls >= 1, "the crmPatch sweep found no call at all - it has stopped seeing the write-up box");
}

// ── 3. Isolation from the pilot and from iReports360 ────────────────────────────────────────────────

const MODULE_DIRECTORIES = [
  "src/lib/phoenix-crm",
  "src/components/phoenix-crm",
  API_ROOT,
  "app/employee-portals/field-crm",
  "app/(admin)/admin/field-crm",
];

const NOT_THIS_MODULE: ReadonlyArray<readonly [RegExp, string]> = [
  [/crm_native_/, "the 2026-09-13 pilot's crm_native_* tables"],
  [/crm_cutover/, "the pilot's cutover date"],
  [/crm_contact_list_changes/, "the pilot's contact-list changes"],
  [/@\/lib\/crm\/native-visits/, "the pilot's code"],
  [/@\/lib\/weekly-planning/, "the district managers' weekly plans, a different workflow that emails"],
  [/ireports360_/i, "iReports360's own tables"],
  [/["'`]\/api\/crm\//, "the old CRM's and the pilot's API routes"],
  // 🔴 `/admin/phoenix-crm` and `/employee-portals/phoenix-crm` are the retired 2026-09-14 pilot's
  // own pages — the first only forwards to `/admin/field-crm` (see src/lib/needs-you/types.ts), and a
  // module file linking to either is the defect this catches. Six sub-paths beneath it are NOT the
  // pilot's: the integrity board, the duplicate sweep, the refused readings, the visits held for SFE
  // (owner, 2026-11-10), the list template and the visits archive (owner, 2026-11-07) are this module's
  // own admin screens, linked from
  // system-navigation.ts, and the board page is pinned as
  // a blind reader in tests/phoenix-crm-blind-half.test.ts. They are named one at a time on purpose —
  // anything else under the retired path still fails, so a real pilot link cannot ride in behind them.
  [
    /["'`]\/(?:admin|employee-portals)\/phoenix-crm(?!\/(?:integrity|duplicates|refused-readings|far-visit-holds|list-template|visits-archive)\b)\b/,
    "the pilot's pages",
  ],
];

function runIsolationTests() {
  const files = [...MODULE_DIRECTORIES.flatMap((directory) => walk(directory)), "src/lib/notifications/phoenix-crm-channel-guard.ts"];
  assert.ok(files.length >= 60, `the module scan found only ${files.length} files — it has stopped seeing the module`);
  for (const file of files) {
    // `imported_from_ireports360_at` is Phoenix CRM's OWN column — the mark on a visit copied from the old
    // history (20261029212200), which the readers that judge filter on. It names no iReports360 table, so
    // it alone is taken out before the scan; any other `ireports360_` still fails. `ireports360_kpi_counted`
    // (owner, 2026-11-07) is the same kind: a column of phoenix_crm_visits, the trigger's "this converted old
    // visit counts", naming no iReports360 table. `ireports360_checkin_id` too (owner, 2026-11-10): the column of
    // phoenix_crm_visits naming the old check-in a copied visit came from, which the trusted point counts once.
    const source = readFileSync(file, "utf8")
      .replaceAll("imported_from_ireports360_at", "")
      .replaceAll("ireports360_kpi_counted", "")
      .replaceAll("ireports360_checkin_id", "");
    for (const [pattern, what] of NOT_THIS_MODULE) {
      assert.doesNotMatch(source, pattern, `${file} reaches ${what} — Phoenix CRM is built clean, never wired into the old CRM`);
    }
  }
}

// ── 4. What the phone's code imports ────────────────────────────────────────────────────────────────

function importsOf(source: string): string[] {
  return [
    ...[...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((match) => match[1]),
    ...[...source.matchAll(/^\s*import\s+"([^"]+)"/gm)].map((match) => match[1]),
    ...[...source.matchAll(/\b(?:import|require)\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]),
  ];
}

const SERVER_SIDE: RegExp[] = [
  /^@\/lib\/phoenix-crm\/server(?:\/|$)/,
  /^@\/lib\/supabase(?:\/|$)/,
  /^server-only$/,
  /^@\/lib\/notifications(?:\/|$)/,
  /^@\/lib\/observability(?:\/|$)/,
  /^@\/lib\/auth\/server$/,
  /^next\/headers$/,
  /^node:/,
];

function runImportTests() {
  // The pure rules run on the phone AND on the server: no framework, no React, no permissions, no I/O.
  const rules = walk("src/lib/phoenix-crm").filter((file) => !file.includes("/server/") && !file.endsWith("/view-types.ts"));
  assert.ok(rules.length >= 10, `found only ${rules.length} rule modules`);
  for (const file of rules) {
    for (const specifier of importsOf(readFileSync(file, "utf8"))) {
      for (const pattern of [...SERVER_SIDE, /^next(?:\/|$)/, /^react(?:\/|$|-)/, /^@\/lib\/auth(?:\/|$)/]) {
        assert.doesNotMatch(specifier, pattern, `${file} imports ${specifier} — the module's rules stay pure, for the phone and the tests`);
      }
    }
  }

  // The screens borrow the server's shapes through view-types.ts, and nothing else of the server's.
  for (const file of walk("src/components/phoenix-crm")) {
    for (const specifier of importsOf(readFileSync(file, "utf8"))) {
      for (const pattern of SERVER_SIDE) {
        assert.doesNotMatch(specifier, pattern, `${file} imports ${specifier} — server code must never be bundled for a phone`);
      }
    }
  }

  const viewTypes = stripComments(readFileSync("src/lib/phoenix-crm/view-types.ts", "utf8"));
  assert.doesNotMatch(viewTypes, /^\s*import\b/m, "view-types.ts imports nothing");
  const exported = viewTypes.match(/^\s*export\b.*$/gm) ?? [];
  assert.ok(exported.length >= 5, "view-types.ts still carries the screens' shapes");
  for (const line of exported) {
    assert.match(line, /^\s*export type \{/, `view-types.ts re-exports types only — a value would pull server code into the phone's bundle: ${line.trim()}`);
  }
}

// ── 5. The server's data access, and the migration ──────────────────────────────────────────────────

const MIGRATION = "supabase/migrations/20260916150000_phoenix_crm.sql";

/**
 * The migrations that follow the first one, in order. Each is held to the same hygiene — one
 * transaction, SECURITY DEFINER with a fixed search path, service-role-only execute, its own tables
 * only — and the functions it adds join the set the services may call.
 */
const LATER_MIGRATIONS = [
  "supabase/migrations/20260922180258_phoenix_crm_pending_customers.sql",
  "supabase/migrations/20260924234547_add_doctor_primary_pharmacy.sql",
  // The voice note. It must stay after every migration that REPLACES phoenix_crm_save_visit, because
  // liveMigrationSql applies each entry's replacement in order and the last one wins — and this is the
  // most recent migration to replace save_visit. Listed before such a migration, it would leave the
  // checks below reading a body the database has already stopped running. Migrations that follow it add
  // only a new table (location integrity) or brand-new functions (the monthly plan) and replace nothing,
  // so they cannot disturb that.
  "supabase/migrations/20260925030047_phoenix_crm_visit_voice_note.sql",
  // Location integrity evidence — adds a TABLE and no function.
  "supabase/migrations/20260925033551_phoenix_crm_location_integrity.sql",
  // The monthly plan — two new tables and two brand-new functions (open, transition); replaces nothing.
  "supabase/migrations/20260925165851_phoenix_crm_monthly_plans.sql",
  // The off-plan visit. It REPLACES phoenix_crm_save_visit, so it must stay last among the migrations
  // that do — liveMigrationSql applies each entry in order and the last one wins. It also replaces the
  // four report functions and both monthly-plan functions, adds two tables and one view, and adds
  // phoenix_crm_decide_unplanned_visit.
  "supabase/migrations/20260926163000_phoenix_crm_unplanned_visits.sql",
  // Day activities: one table and one function of its own, touching nothing that exists. It sits
  // after the unplanned-visit migration because that one is the last save_visit replacer, and the
  // list is applied in order.
  "supabase/migrations/20260926193000_phoenix_crm_day_activities.sql",
  // The visit's outcome — the objection and the next step. It REPLACES phoenix_crm_save_visit, so it
  // takes over as the last entry that does: liveMigrationSql applies each in order and the last wins.
  // It adds four columns and no table, and RESTATES save_visit's own revoke/grant pair — a no-op that
  // `check:migrations` requires of any file whose only function is SECURITY DEFINER; see
  // assertFunctionGrants.
  "supabase/migrations/20260926210000_phoenix_crm_visit_outcome.sql",
  // What the rep LEFT — one jsonb column, and save_visit again. It takes over as the last entry that
  // replaces save_visit, and restates its revoke/grant pair for the same reason the one above does.
  "supabase/migrations/20260926230000_phoenix_crm_visit_samples.sql",
  // The visit's own stopwatch — two silent columns, and save_visit again. Last among the save_visit
  // replacers, and it restates the revoke/grant pair for the same reason the two above it do.
  "supabase/migrations/20260926234500_phoenix_crm_visit_dwell.sql",
  // Coverage against sales, per brick (C2). ONE brand-new function and nothing else — no table, no
  // column, no view, and it replaces nothing, so where it sits in this list cannot disturb the
  // save_visit ordering above it.
  "supabase/migrations/20260927003000_phoenix_crm_report_brick_coverage.sql",
  // The photo fingerprints (D5). One brand-new table, one brand-new function, and one ALTER of the
  // evidence table's unique key — it replaces no save_visit, so it appends safely at the end. The
  // ALTER is the load-bearing part: judgeCapture conflicted on (subject_kind, subject_id) alone, so
  // the photo sweep's verdict would have OVERWRITTEN the GPS verdict on the same visit rather than
  // sitting beside it, with nothing anywhere going red.
  "supabase/migrations/20260927120000_phoenix_crm_photo_fingerprints.sql",
  // The behaviour verdicts (D4). ONE brand-new table and nothing else — no function, no column on
  // anything that exists, and it replaces no save_visit, so it appends safely at the end. It is a
  // table of its own rather than a source on the evidence table because a behaviour verdict is
  // about a rep and a MONTH, not about a capture, and it is recomputed whole every sweep.
  "supabase/migrations/20260927160000_phoenix_crm_behaviour_integrity.sql",
  // The time anchors (A1 phase 2). ONE new table, no function, no column on anything that exists,
  // and it replaces no save_visit — so it appends safely at the end. `issued_at` defaults to now()
  // in the database on purpose: that is the one value in the offline design a phone must never be
  // able to set.
  "supabase/migrations/20260927190000_phoenix_crm_time_anchors.sql",
  // The offline capture (A1 phase 3). It REPLACES phoenix_crm_save_visit, so it must stay LAST among
  // the migrations that do — liveMigrationSql applies each replacement in order and the last one
  // wins. Four columns on phoenix_crm_visits and no new table.
  "supabase/migrations/20260927200000_phoenix_crm_offline_capture.sql",
  // The rep's flow rebuilt (owner, 2026-09-29), part one: a customer met outside the list, the
  // two-step add / drop / bring-back, both readings of a place, and the audited move. It replaces the
  // list's own functions and adds three; it replaces no save_visit, so it sits before the one that does.
  "supabase/migrations/20260929235106_phoenix_crm_list_admission.sql",
  // Part two: the one-tap visit (no photo, the server's clock, the 02:00 day), the out-of-list visit
  // and Sales day. It REPLACES phoenix_crm_save_visit, so it is now the LAST entry that does —
  // liveMigrationSql applies each replacement in order and the last one wins. It also recreates the
  // countable view, still security_invoker and still `select v.*`.
  "supabase/migrations/20260929235553_phoenix_crm_one_tap_visit.sql",
  // Part three: the weekly due date and late stamp, and the other activities planned on a day. One
  // new table, one new function, and the two plan transitions — still one plan-event insert each.
  // It replaces no save_visit, so it appends safely after part two.
  "supabase/migrations/20260929235555_phoenix_crm_plan_weeks.sql",
  // The plan day's details (2026-09-30): one of each kind of other activity a day where part three
  // allowed one, and the day's Start AM / Start PM. One new table, one new function, and part three's
  // save_plan_activities replaced — so it appends after part three.
  "supabase/migrations/20260930213537_phoenix_crm_plan_day_details.sql",
  // The customer's phone (owner, 2026-09-30): one nullable column, and validate_customer and
  // rename_customer replaced with their live bodies plus the phone — so it appends after the list
  // admission that last replaced validate_customer.
  "supabase/migrations/20260930235705_phoenix_crm_customer_phone.sql",
  // The CNS daily forecast (owner, 2026-10-01): one table and its save function, CNS only by CHECK.
  "supabase/migrations/20261001015949_phoenix_crm_daily_forecasts.sql",
  // The Super Admin enters a visit a rep missed logging (owner, 2026-10-01): one brand-new function,
  // capture_source 'admin', and lat/lon nullable on that one source only. It replaces no save_visit,
  // so it appends safely at the end.
  "supabase/migrations/20261001044221_phoenix_crm_admin_entry.sql",
  // ...and removes one he entered by mistake (owner, 2026-10-01): one new table, the copy of what was
  // removed, and one brand-new function. It replaces nothing, so it appends safely at the end.
  "supabase/migrations/20261001055833_phoenix_crm_admin_remove_visit.sql",
  // Weekly only, and asking to edit a sent week (owner, 2026-10-01): two new tables, three brand-new
  // functions (the due date, the raise, the decision — whose HR step reopens the week and writes the
  // plan's fifth event insert), and phoenix_crm_plan_transition replaced with its live body, its due
  // date read from phoenix_crm_week_due_on. It replaces no save_visit, so it appends safely at the end.
  "supabase/migrations/20261002002251_phoenix_crm_plan_edit_requests.sql",
  // The district manager's double-visit plan (owner, 2026-10-02): one new table and one brand-new
  // function (one half-day set, changed or cleared). It replaces nothing, so it appends safely at the end.
  "supabase/migrations/20261002120003_phoenix_crm_double_visit_plans.sql",
  // The manager's review (owner, 2026-10-02): one nullable column on the plan with its CHECK (the ONE day
  // a reviewer returned), and phoenix_crm_plan_transition replaced with its live body plus the one-day
  // return and the snapshot each send keeps on its own event — still ONE plan-event insert. No table, no
  // new function, no save_visit, so it appends safely at the end.
  "supabase/migrations/20261002120049_phoenix_crm_plan_review.sql",
  // Still planned after a one-day return (owner, 2026-10-02). It REPLACES phoenix_crm_save_visit, so it
  // is now the LAST entry that does — liveMigrationSql applies each replacement in order and the last
  // wins — and it restates phoenix_crm_plan_transition with both the one-day return above and the 23:55
  // deadline (20261002122000) made from one base, still ONE plan-event insert. No table, no new function.
  "supabase/migrations/20261002125244_phoenix_crm_still_planned_after_one_day_return.sql",
  // The rep's pharmacies come across with his AM and PM contacts — replaces phoenix_crm_seat_reference.
  "supabase/migrations/20261002150353_phoenix_crm_pharmacy_reference.sql",
  // A product manager on a visit — replaces phoenix_crm_save_visit, so it belongs AFTER every earlier
  // replacer of it (see the voice-note note above): liveMigrationSql applies these in order and the last
  // one wins.
  "supabase/migrations/20261002205436_phoenix_crm_visit_product_manager.sql",
  // 🔴 20261002205435_phoenix_crm_pharmacy_list_type.sql is DELIBERATELY ABSENT and must stay absent.
  // It only widens two CHECK constraints — it defines no function and creates no table — so the guard
  // below ("adds no function and no table") would refuse it, and it has nothing for this scan to review.
  // A rep's ask for a visit with somebody (owner, 2026-10-02): one new table and three brand-new
  // functions (raise, answer, cancel). It replaces nothing — no save_visit — so it appends safely at the
  // end, and it never touches the district manager's own double-visit plan.
  "supabase/migrations/20261002135638_phoenix_crm_visit_asks.sql",
  // A save on a week returned for ONE day keeps naming that day (2026-10-02). It REPLACES
  // phoenix_crm_save_plan with its live body and one changed expression — the 'saved' event's details —
  // so its two plan-event inserts stay two. No table, no new function, no save_visit.
  "supabase/migrations/20261002142625_phoenix_crm_saved_event_keeps_the_returned_day.sql",
  // Two brand-new functions and nothing else (2026-10-02): the per-seat "has this territory ever
  // carried real work" read that the 06:55 digest and the week reminder gate on — an `exists` per
  // seat per table, where the old six-table SELECT stopped silently at PostgREST's 1,000 rows — and
  // the daily pass that closes a request to edit a week that has passed, which calls
  // phoenix_crm_decide_plan_edit_request and so leaves that function the only writer of `expired`.
  // It replaces nothing, no save_visit, no table.
  "supabase/migrations/20261002220047_phoenix_crm_activity_and_plan_edit_expiry.sql",
  // Plan against actual asks the day-by-day sent rule, and takes a DROPPED customer out of the
  // denominator (2026-10-02). It REPLACES phoenix_crm_report_plan_vs_actual with its live body and
  // those two changes; nothing else in the module replaces that function, so it appends safely at the
  // end. No table, no new function, no save_visit. `runMigrationReviewFixTests` reads the spliced
  // result — so without this entry that check would go on reading SQL the database has stopped
  // running, which is the exact failure `liveMigrationSql` exists to prevent.
  "supabase/migrations/20261002221947_phoenix_crm_plan_vs_actual_sent_days.sql",
  // A visit is never dated onto an EARLIER visit day than the one it arrived on (the 2026-10-02
  // audit). It REPLACES phoenix_crm_save_visit, so it is now the LAST entry that does and must stay
  // last among them — liveMigrationSql applies each replacement in order and the last one wins. One
  // block inserted into 20261002205436's body and nothing else: no table, no column, no constraint.
  "supabase/migrations/20261002222403_phoenix_crm_visit_day_never_before_arrival.sql",
  // The SFE's list template (owner's ask, 2026-10-02): the bulk loader, and `phoenix_crm_validate_customer`
  // gaining the `listed` mode so a customer loaded from a sheet — who has no iReports360 contact at all —
  // can still be validated at the door. It replaces no save_visit, so it appends safely after the entry
  // that does, and it creates no table: two columns on `phoenix_crm_customers` and nothing else.
  //
  // 🔴 20261002224250_phoenix_crm_seat_reference_and_place_removal.sql is DELIBERATELY ABSENT, and the
  // reason is the table rule just below: it creates `phoenix_crm_backup_20261002.misminted_reference_customers`,
  // a pre-image in its own dated schema, which is not a `public.phoenix_crm_*` table and cannot be locked
  // like one. Its functions are all REPLACEMENTS already in `callable`, so nothing it adds is missed here —
  // and `liveMigrationSql` reads the bodies this entry replaces anyway.
  "supabase/migrations/20261003000753_phoenix_crm_list_template_bulk_add.sql",
  // "Show your manager you started working" (owner, 2026-10-03). ONE brand-new table and ONE
  // brand-new function; it replaces no save_visit and alters nothing that exists, so it appends
  // safely at the end and cannot disturb the replacement ordering above.
  "supabase/migrations/20261003075803_phoenix_crm_day_starts.sql",
  // The Google Maps check on a validated place (owner, 2026-10-03). ONE brand-new table (the Super
  // Admin's holds) and ONE brand-new function (his decision); it REPLACES phoenix_crm_validate_customer
  // and phoenix_crm_add_place with their live bodies plus the hold, and touches no save_visit — so it
  // must stay after 20261003000753, the last entry that replaced validate_customer.
  "supabase/migrations/20261003130536_phoenix_crm_google_place_check.sql",
  // A pharmacy visit is logged normally (owner, 2026-10-03: "Pharmacy don't need a validation"). It
  // REPLACES phoenix_crm_save_visit — a pharmacy is never refused as unvalidated, and the pharmacy a
  // doctor's visit names is logged as that pharmacy's own visit — so it is now the LAST entry that
  // replaces save_visit and must stay last among them. It adds one column to `phoenix_crm_visits`
  // (`linked_from_visit_id`) and one BEFORE INSERT trigger function that names a pharmacy visit after its
  // pharmacy; no table. 20261003174346_phoenix_crm_pharmacy_needs_no_validation.sql is DELIBERATELY
  // ABSENT: it recreates the countable-visits VIEW and adds no function and no table, so this scan could
  // see nothing in it.
  "supabase/migrations/20261003175653_phoenix_crm_pharmacy_visit_logged_normally.sql",
  // Approving a place AFTER it was rejected (owner, 2026-10-03: "add the option to approve after
  // reject"). ONE brand-new function and nothing else — no table, no column, and it replaces nothing,
  // so it appends safely at the end and cannot disturb the replacement ordering above.
  "supabase/migrations/20261003184147_phoenix_crm_restore_validation.sql",
  // A doctor's visit that names two pharmacies in one box (owner, 2026-10-03). It REPLACES
  // phoenix_crm_save_visit with 20261003175653's body and the link turned into one visit per name, so it
  // is now the LAST entry that replaces save_visit and must stay last among them. No table, no column,
  // no new function.
  "supabase/migrations/20261003202903_phoenix_crm_visit_names_two_pharmacies.sql",
  // The reading a REFUSED capture was carrying (owner, 2026-10-03: "record the refused readings so
  // the next refusal is traceable"). ONE brand-new table and NOTHING else — no function, no column,
  // no view, and it replaces nothing — so it appends safely at the end and cannot disturb the
  // replacement ordering above. It is the module's only table deliberately left UNKEYED: a rep
  // refused eighteen times leaves eighteen rows, and a unique constraint on any of its columns would
  // collapse exactly the retry history that IS the evidence.
  "supabase/migrations/20261003211500_phoenix_crm_refused_readings.sql",
  // A pharmacy he adds to his own list by its name (owner, 2026-10-03: "he can also add a pharmacy
  // without any validation or without any approval"). ONE brand-new function and nothing else — no
  // table, no column, and it replaces nothing — so it appends safely at the end.
  "supabase/migrations/20261003211501_phoenix_crm_add_pharmacy.sql",
  // THE TOUCH TRAIL (owner, 2026-10-03: "anything touches him, automatically saved"). ONE brand-new
  // table and NOTHING else — no function, no column, no view, and it replaces nothing — so it appends
  // safely at the end and cannot disturb the replacement ordering above. It is the module's SECOND
  // deliberately UNKEYED table, for the same reason as the refused readings two entries up: nine
  // identical presses are nine rows, and the repetition is the evidence. THE TRAIL WAS RETIRED on
  // 2026-11-01 (owner: "retire and delete all its traces"): 20261101203000_retire_phoenix_crm_touch_trail.sql drops the table and
  // adds nothing this scan can see, so it is deliberately NOT listed; this entry stays as history.
  "supabase/migrations/20261003221224_phoenix_crm_touch_trail.sql",
  // One lock for a new pharmacy (review of #5263, 2026-10-04). It REPLACES phoenix_crm_save_visit
  // (20261003202903's body, the new-pharmacy branch re-checked under phoenix_crm_add_pharmacy's lock) and
  // phoenix_crm_add_pharmacy (plus its list event), so it is now the LAST entry that replaces either and
  // must stay last among them. No table, no column, no new function.
  "supabase/migrations/20261004005543_phoenix_crm_one_lock_for_a_new_pharmacy.sql",
  // The SFE Manager hands a customer to another rep (owner, 2026-10-06). ONE brand-new table (the
  // record of every move) and ONE brand-new function; it REPLACES phoenix_crm_report_plan_vs_actual
  // with 20261002221947's body plus the `held_by` lateral, so it is now the LAST entry that replaces
  // that function and must stay last among them — liveMigrationSql applies each replacement in order
  // and the last one wins. It touches no save_visit and alters nothing that exists, so it cannot
  // disturb the replacement ordering above.
  "supabase/migrations/20261006121846_phoenix_crm_move_customer.sql",
  // A chain visit may take a product manager as its second person, and the Super Admin corrects a
  // visit a rep submitted (owner, 2026-10-06). It REPLACES phoenix_crm_save_visit (20261004005543's
  // body plus the chain-with-a-product-manager shape), so it is now the LAST entry that does and must
  // stay last among them — liveMigrationSql applies each replacement in order and the last one wins.
  // It also widens one CHECK of its own, adds ONE table (the copy of what each correction replaced)
  // and ONE brand-new function.
  "supabase/migrations/20261006234611_phoenix_crm_visit_company_and_admin_edit.sql",
  // The Administrator takes back a decision already taken (owner, 2026-10-08): three brand-new
  // functions and three columns on each of two existing tables; it replaces no save_visit and
  // creates no table, so it appends safely at the end.
  "supabase/migrations/20261008190000_phoenix_crm_administrator_reverses.sql",
  // A pharmacy's own location and its responsible person's phone (owner, 2026-10-09), both optional.
  // THIRTEEN nullable columns on `phoenix_crm_customers`, three CHECKs of its own, ONE brand-new
  // function (`phoenix_crm_set_pharmacy_details`) and a REPLACEMENT of `phoenix_crm_add_pharmacy` at
  // the same jsonb signature; it replaces no save_visit and creates no table, so it appends safely at
  // the end and cannot disturb the replacement ordering above.
  "supabase/migrations/20261010010000_phoenix_crm_pharmacy_pin_and_phone.sql",
  // The shared place — a polyclinic, centre, tower or hospital outpatient suite captured once at its
  // door, with customers seated in it (owner, 2026-10-09). ONE new table, TWO brand-new functions
  // (create, decide), a trigger function of its own, and phoenix_crm_insert_place replaced with its
  // live body plus two columns. It replaces no save_visit — the three-a-day cap is a BEFORE INSERT
  // trigger on phoenix_crm_visits rather than a line in that 27,663-character function, so every door
  // that writes a visit is held to it — and so it appends safely at the end.
  "supabase/migrations/20261010013001_phoenix_crm_shared_places.sql",
  // Seating standalone customers in a validated polyclinic (owner, 2026-10-10): three brand-new functions
  // (seat, set the building's timetable, settle it), replacing nothing, so it appends at the end.
  "supabase/migrations/20261010210000_phoenix_crm_seat_places_in_venue.sql",
  // SFE returns a request to the rep for a comment (owner, 2026-10-12). Three brand-new functions (the return,
  // the answer, and the BEFORE UPDATE guard that keeps a returned request from being approved), five columns
  // and two widened CHECKs on phoenix_crm_list_requests; it replaces nothing, so it appends safely at the end.
  "supabase/migrations/20261012180000_phoenix_crm_return_request_for_comment.sql",
  // Capture provenance (gaps 1 and 3): ONE brand-new table and NOTHING else — no function, no column
  // on anything that exists, and deliberately no replacement of phoenix_crm_save_visit, which four
  // entries above have already replaced in turn. A table-only entry satisfies the "contribute
  // something this scan can see" rule below, and the four lock statements are checked there.
  "supabase/migrations/20261012233000_phoenix_crm_visit_capture_provenance.sql",
  // A district manager's comment and recommendation on one place check (owner, 2026-10-13). TWO
  // brand-new tables and NOTHING else — no function, no column on anything that exists, and it
  // replaces nothing, so it appends safely at the end. Both are RLS-enabled and service-role only,
  // like every other table here, and each has a real FK to the place or the polyclinic it is about.
  "supabase/migrations/20261013163000_phoenix_crm_place_notes.sql",
  // The rep writes up his own saved visit afterwards (owner, 2026-10-15). ONE brand-new function and
  // three columns on `phoenix_crm_visits`; no table, and deliberately no replacement of
  // phoenix_crm_save_visit — the door form does not change at all, so it appends safely at the end and
  // cannot disturb the replacement ordering above.
  "supabase/migrations/20261015110300_phoenix_crm_visit_detail_edit.sql",
  // The undo of a venue rejection (owner, 2026-10-15). ONE brand-new function and NOTHING else — no
  // table, no column, and it replaces nothing, so its position cannot disturb the replacement
  // ordering above and it appends safely at the end.
  "supabase/migrations/20261015220318_phoenix_crm_restore_shared_place.sql",
  // Visit recording for the reps the Super Admin chooses (owner, 2026-10-16). Two brand-new tables, a
  // private bucket and ONE brand-new function; it replaces nothing, so it appends safely at the end.
  "supabase/migrations/20261016103900_phoenix_crm_visit_recording.sql",
  // A rep's request for a double visit (owner, 2026-10-16). Two brand-new tables and three brand-new
  // functions — raise, edit the days, answer — and deliberately no fourth: there is no cancel.
  "supabase/migrations/20261016133000_phoenix_crm_double_visit_requests.sql",
  // A recorded visit of any type waits for the Administrator first (owner, 2026-10-16). One brand-new
  // review function, one brand-new trigger function, and the two report functions REPLACED — so it must
  // come after every earlier definer of those two, which is why it is last.
  "supabase/migrations/20261016161248_phoenix_crm_recorded_visit_waits_for_the_administrator.sql",
  // Two counts the reports used to make by carrying every row across (2026-10-16 performance audit):
  // items per plan for the exceptions board, and each territory's first countable visit and visit count
  // for the adoption report. TWO brand-new read functions and nothing else — no table, no column, and it
  // replaces nothing, so it appends safely at the end and cannot disturb the replacement ordering above.
  "supabase/migrations/20261016180300_phoenix_crm_report_count_reads.sql",
  // The list-template picker's per-territory customer counts, counted in the database (Phoenix CRM
  // performance audit, 2026-10-16). One brand-new read function; it replaces nothing.
  "supabase/migrations/20261016180400_phoenix_crm_customer_counts_by_seat.sql",
  // The duplicates page's three keep-rule counts, counted in the database (same audit). One brand-new
  // read function; it replaces nothing.
  "supabase/migrations/20261016180401_phoenix_crm_customer_merge_counts.sql",
  // The List's doctor-pharmacy cards read only the visits that can change them (same audit). One
  // brand-new read function over phoenix_crm_visits; it replaces nothing.
  "supabase/migrations/20261016180201_phoenix_crm_customer_pharmacy_feedback.sql",
  // The district manager's weekly plan (owner, 2026-10-16). Seven brand-new tables and seven brand-new
  // functions, and ONE replacement: phoenix_crm_merge_duplicate_customer, re-pointing the two new tables
  // that name a customer. That function's earlier definer (20261008120000) is not on this list, so no
  // ordering above can be disturbed; it appends at the end.
  "supabase/migrations/20261017000000_phoenix_crm_manager_plan.sql",
  // The Visit report's saved views (owner, 2026-10-16). ONE brand-new table and NOTHING else — no
  // function, no column on anything that exists, and it replaces nothing, so it appends safely at the end.
  "supabase/migrations/20261017001000_phoenix_crm_visit_report_views.sql",
  // The NSM's step on a district manager's asks (owner, 2026-10-17). It REPLACES five functions whose
  // earlier definer is 20261017000000, above it, and adds columns and widens CHECKs on that migration's
  // own tables — no new table and no new function, so it appends safely at the end.
  "supabase/migrations/20261017120000_phoenix_crm_manager_asks_second_approval.sql",
  // The out-of-plan exception for one seat at one venue (owner, 2026-10-17). ONE new table, two new
  // functions, and it REPLACES two caps whose earlier definers sit above it, so it appends at the end.
  "supabase/migrations/20261017150000_phoenix_crm_offplan_exemptions.sql",
  // The Super Admin's answer to "are these two validations the same place?" (owner, 2026-10-17, the third
  // tab of Place checks). ONE brand-new table and NOTHING else — no function, no column on anything that
  // exists, and it replaces nothing, so it appends safely at the end. Its keys are text on purpose: a
  // validation is a place OR a polyclinic, and an answer about one that is gone is inert.
  "supabase/migrations/20261017160000_phoenix_crm_place_match_answers.sql",
  // The manager weekly plan widened to the regional, national and product managers (owner, 2026-10-17).
  // It REPLACES two functions whose earlier definer is 20261017000000, above it, and adds columns and
  // CHECKs on that migration's own tables — no new table and no new function, so it appends at the end.
  "supabase/migrations/20261017213000_phoenix_crm_manager_plan_wider_writers.sql",
  // The signboard scanner (2026-10-18): a new photo for a place sent back to its rep. One new function,
  // replacing nothing, plus a widened CHECK and a column on the refusals table — it appends at the end.
  "supabase/migrations/20261018230000_phoenix_crm_signboard_scanner.sql",
  // An ask to edit closes with its week, and a reopen clears HR's acknowledgement (owner audit, 2026-10-18).
  // It REPLACES two functions — the week's transition (earlier definer 20261017213000, above it) and the
  // ask's decision (earlier definer 20261017120000, above it) — and changes no table, column or row, so it
  // appends at the end.
  "supabase/migrations/20261018234000_phoenix_crm_manager_plan_ask_closes_with_its_week.sql",
  // A district manager's ask for a second or third day of single visits (owner, 2026-10-20). One new table,
  // locked by the same four statements, and three new functions replacing nothing — it appends at the end.
  "supabase/migrations/20261020210546_phoenix_crm_manager_single_visit_day_asks.sql",
  // Writing why is optional on that ask (owner, 2026-10-20). It REPLACES the raise function just above and
  // widens the reason column and its CHECK, so it appends at the end.
  "supabase/migrations/20261020213000_phoenix_crm_manager_single_visit_day_reason_optional.sql",
  // The Super Admin's delete (owner, 2026-10-23): one new table that keeps a copy of everything it deletes,
  // locked by the same four statements, and one brand-new function replacing nothing — it appends at the end.
  "supabase/migrations/20261023223001_phoenix_crm_admin_delete_anything.sql",
  // The same tool taught a month's plan and a district manager's own visit: it REPLACES that function and widens
  // one CHECK on its log table, so it appends after the migration that made them.
  "supabase/migrations/20261023232001_phoenix_crm_admin_delete_month_and_manager_visit.sql",
  // The Master List's decisions (owner, 2026-10-26): one new table, locked by the same four statements, and no
  // function — it replaces nothing and moves no rep's place, so it appends at the end.
  "supabase/migrations/20261026165500_phoenix_crm_master_decisions.sql",
  // A visit carries any mix of companions (owner, 2026-10-27): one new table locked by the same four statements,
  // two brand-new helpers, and the newest save_visit, admin edit and admin entry — it is the latest to replace
  // them, so it appends at the end.
  "supabase/migrations/20261027185332_phoenix_crm_visit_any_companions.sql",
  // The interviews on an Interviews day (owner, 2026-10-29): one new table locked by the same four statements
  // and a private bucket for the CVs added by hand — no function, it replaces nothing, so it appends at the end.
  "supabase/migrations/20261029235000_phoenix_crm_day_interviews.sql",
  // The countable view skips copied iReports360 history at its root (2026-10-31): one new view, the history
  // view, locked like every view here; the countable view re-created with the filter; and the four report
  // functions that show history REPLACED with their live bodies reading the history view. It is the latest
  // to replace those four, so it appends at the end.
  "supabase/migrations/20261031160000_phoenix_crm_countable_visits_skip_imported_history.sql",
  // Four Alex hospitals with no cap at all (owner, 2026-10-31): one column on the exemptions table, one new
  // function (the venues a seat's rows lift) and the shared-place day cap REPLACED — its earlier definer,
  // 20261017150000, sits above — so it appends at the end.
  "supabase/migrations/20261031170001_phoenix_crm_alex_hospitals_no_cap.sql",
  // The territory bundle (2 Nov 2026, the speed root cause, Stage 2): two NEW functions that read a seat's customers,
  // places and venues, and a day's plan with its stops, in one statement each; nothing replaced, so it appends.
  "supabase/migrations/20261102040000_phoenix_crm_territory_bundle.sql",
  // The Super Admin's Polyclinic Caps page (owner, 2026-11-02): columns on two of its own tables, two widened CHECKs,
  // two NEW functions (the page's read and write), and four functions REPLACED with their live bodies, whose earlier
  // definers sit above (20261017150000 and 20261031170001). It is the latest to replace them, so it appends at the end.
  "supabase/migrations/20261102130045_phoenix_crm_venue_cap_admin.sql",
  // The same page's door and write, replaced again the same day: a number stays on its own seat, and a switch is a round trip.
  "supabase/migrations/20261102133258_phoenix_crm_venue_cap_round_trip.sql",
  // The Super Admin's Rep Exceptions page (owner, 2026-11-03): one NEW function and one unique index; nothing replaced.
  "supabase/migrations/20261103132005_phoenix_crm_rep_offplan_exception_admin.sql",
  // Reading visit comments (owner, 3 Nov 2026): one table, its queue and a trigger that clears a reading when the words
  // change. It replaces no function and writes to no visit.
  "supabase/migrations/20261103091500_phoenix_crm_visit_comment_readings.sql",
  // The visit retry (owner, 3 Nov 2026): one column, one log table and a switch. It creates and replaces no function.
  "supabase/migrations/20261103120000_phoenix_crm_visit_resend.sql",
  // "Show visit times" on a manager's plan board (owner, 5 Nov 2026): one NEW read-only function; nothing replaced.
  "supabase/migrations/20261105210430_phoenix_crm_customer_last_visits.sql",
  // A PM customer's full name (owner, 7 Nov 2026): seven columns on the customer and two NEW functions, one that
  // holds a name for a decision and one that decides it; nothing replaced.
  "supabase/migrations/20261107045402_phoenix_crm_doctor_full_name.sql",
  // Place checks in few requests (owner, 8 Nov 2026: "hilarious slow"): one NEW read-only function that answers the
  // validated places' four lookups in one call; nothing replaced.
  "supabase/migrations/20261108200549_phoenix_crm_validated_place_facts.sql",
  // The Super Admin's corrected full name (owner, 8 Nov 2026): REPLACES phoenix_crm_decide_full_name with the same
  // body plus an optional name honoured on approve only. It replaces nothing save_visit depends on.
  "supabase/migrations/20261108204731_phoenix_crm_full_name_corrected.sql",
  // The four far-visit safeguards (owner, 10 Nov 2026): one NEW table (a visit held for the SFE), a tenth refusal
  // reason, and the two countable views REPLACED with the same body plus the held clause. No function.
  "supabase/migrations/20261110170000_phoenix_crm_far_visit_safeguards.sql",
  // The Super Admin's trusted point (owner, 10 Nov 2026): one NEW function, phoenix_crm_place_on_trusted_point; places
  // gain trusted_basis and a nullable photo_path for that place alone. It replaces nothing save_visit depends on.
  "supabase/migrations/20261110213959_phoenix_crm_trusted_point_places.sql",
  // The sweep of 11 Nov 2026: phoenix_crm_validate_customer REPLACED with 20261107195700's body plus one line (an
  // outside customer with a grade is filed for approval), and two NEW functions — phoenix_crm_customer_merged_away
  // and the trigger function phoenix_crm_customers_no_merged_return. It replaces nothing save_visit depends on.
  "supabase/migrations/20261111030456_phoenix_crm_sweep_fixes.sql",
  // Validated on one line is validated on all three (owner, 12 Nov 2026): two NEW functions —
  // phoenix_crm_share_line_validation and the trigger function phoenix_crm_places_line_twin_follow — a 'line_twin'
  // point source and an index. It replaces nothing save_visit depends on.
  "supabase/migrations/20261112221819_phoenix_crm_line_twin_validation.sql",
];

/**
 * A migration without its comments (the rollback lives in comments and drops everything) — and without the
 * shared visits door. crm_visits_unified is not Phoenix CRM's: it is the read every system shares, held to its
 * own rules by the door's tests, and its vendor branch READS the pilot's cutover date to end where Phoenix
 * begins. 20261027185332 restates it to add one column beside its Phoenix CRM functions; a view writes
 * nothing, so taking it out hides no write from the rules below.
 */
function migrationSql(path = MIGRATION): string {
  return readFileSync(path, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/--.*$/gm, "")
    .replace(/\bcreate or replace view public\.crm_visits_unified\b[^;]*;/, "");
}

/** The functions a migration creates or replaces, each held to the same header and grants. */
function functionsIn(sql: string, path: string): string[] {
  const functions = [...sql.matchAll(/\bcreate or replace function public\.(phoenix_crm_[a-z_]+)\(/g)].map((match) => match[1]);
  assert.equal(functions.length, (sql.match(/\bcreate\s+(?:or\s+replace\s+)?function\b/gi) ?? []).length, `${path}: every function is a public.phoenix_crm_* function`);
  assert.equal(new Set(functions).size, functions.length, `${path}: no function is defined twice — an overload would escape its revoke`);
  for (const name of functions) {
    const header = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\nas \\$\\$`).exec(sql);
    assert.ok(header, `${path}: ${name}'s header ends in "as $$"`);
    assert.match(header[1], /\n\s*security definer\n/, `${path}: ${name} is SECURITY DEFINER`);
    assert.match(header[1], /\n\s*set search_path to 'public'\s*$/, `${path}: ${name} fixes its search path`);
  }
  return functions;
}

/**
 * The module's SQL as the database actually holds it: the first migration, with every function a later
 * one replaced swapped for its live text, and every function a later one added appended.
 *
 * Pinning a rule against the first migration alone is how a check quietly starts reading dead SQL — the
 * text is still in the file, and the database stopped running it the day a later migration replaced it.
 */
function liveMigrationSql(): string {
  let sql = migrationSql();
  for (const path of LATER_MIGRATIONS) {
    const later = migrationSql(path);
    for (const name of [...later.matchAll(/\bcreate or replace function public\.(phoenix_crm_[a-z_]+)\(/g)].map((match) => match[1])) {
      const live = functionSql(later, name);
      // A FUNCTION replacer, never the text itself: in a replacement string `$'` means "everything after
      // the match", and a body checking a regex anchor — `phone ~ '^\+?[0-9]{7,15}$'` — contains exactly
      // that, which spliced the rest of the file in and counted 13 plan-event writes where there are 4.
      if (sql.includes(`create or replace function public.${name}(`)) sql = sql.replace(functionSql(sql, name), () => live);
      else sql += `\n${live}\n$$;\n`;
    }
  }
  return sql;
}

/**
 * Every function a migration INTRODUCES is taken from everyone and given to the service role alone.
 *
 * `required` is what the file must carry a pair for; `owned` is every function it creates or replaces,
 * which is the most it may name. A function it merely REPLACES can restate its pair or leave it out —
 * `create or replace function` preserves the ACL, so restating says the same thing twice.
 *
 * 🔴 It HAS to be allowed, and this used to be an exact match that forbade it (widened 2026-09-26).
 * The fast `pnpm run check:migrations`, a required check, fails any migration that creates a SECURITY
 * DEFINER function and carries no `revoke execute … from … public` anywhere in it: a function in
 * `public` inherits EXECUTE from PUBLIC, and revoking only anon and authenticated is a no-op. A
 * migration whose one function is a REPLACEMENT has nothing else to hang that revoke on, so the two
 * guards deadlocked — one demanded the line, the other refused it. Two earlier migrations in this
 * module (20260924231210 and 20260925021140) already restate it and predate this list.
 *
 * What stays exact: nothing may revoke or grant a function the file does not create or replace, and
 * the revoked and granted sets must match — revoking PUBLIC without re-granting strips the service
 * role with it, which is the failure this whole check exists to catch.
 */
function assertFunctionGrants(sql: string, path: string, required: readonly string[], owned: readonly string[] = required) {
  const revoked = [...sql.matchAll(/^revoke execute on function public\.(phoenix_crm_[a-z_]+)\([^)]*\) from public, anon, authenticated;$/gm)].map((match) => match[1]);
  const granted = [...sql.matchAll(/^grant execute on function public\.(phoenix_crm_[a-z_]+)\([^)]*\) to service_role;$/gm)].map((match) => match[1]);
  for (const name of required) {
    assert.ok(revoked.includes(name), `${path}: ${name} is introduced here, so it must be taken away from public, anon and authenticated`);
  }
  assert.deepEqual(
    revoked.filter((name) => !owned.includes(name)).sort(),
    [],
    `${path}: it revokes a function it neither creates nor replaces`,
  );
  assert.deepEqual([...granted].sort(), [...revoked].sort(), `${path}: every function it revokes is given back to the service role, and nothing else is`);
}

/** What every migration in the module must do, whichever one it is. */
function assertMigrationHygiene(sql: string, path: string) {
  assert.match(sql.trim(), /^begin;/, `${path} runs in one transaction`);
  assert.match(sql.trim(), /commit;$/, `${path} commits at the very end`);
  assert.match(sql, /\nnotify pgrst, 'reload schema';\n/, `${path}: the API sees the new functions without a restart`);
  const opening = sql.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(opening.slice(0, 2), ["begin;", "set local lock_timeout = '5s';"], `${path} waits at most 5 seconds for any lock`);
  assert.doesNotMatch(sql, /\bgrant\b[^;]*\bto\s+[^;]*\b(?:anon|authenticated|public)\b/i, `${path}: nothing is granted to anon, authenticated or public`);
  assert.doesNotMatch(sql, /\bsecurity\s+invoker\b/i, `${path}: no function runs as its caller`);
  assert.doesNotMatch(sql, /\btruncate\b/i, `${path}: nothing is truncated`);
  assert.doesNotMatch(sql, /crm_native_|crm_cutover|crm_contact_list_changes/, `${path} touches nothing of the pilot's`);
  assert.doesNotMatch(sql, /\bcurrent_date\b/i, `${path}: a day is always the Cairo day, stated — current_date is the database's UTC day`);
  const writes = [...sql.matchAll(/\b(insert\s+into|delete\s+from|update)\s+([a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?)/gi)]
    // `update set` is an UPDATE statement's clause, and `before update on <table>` / `update of <column>` is a trigger's
    // own syntax — neither is a table being written.
    .filter((match) => !(match[1].toLowerCase() === "update" && ["set", "on", "of"].includes(match[2].toLowerCase())))
    .map((match) => match[2].toLowerCase());
  for (const target of writes) {
    assert.ok(
      /^public\.phoenix_crm_[a-z_]+$/.test(target) || target === "storage.buckets",
      `${path} writes ${target} — Phoenix CRM writes its own tables only`,
    );
  }
  for (const match of sql.matchAll(/\bdrop\s+(\w+)((?:\s+if\s+exists)?\s+[a-z_][a-z_0-9]*)?/gi)) {
    const what = match[1].toLowerCase();
    // "drop not null" widens a column of its own; "drop constraint" replaces one of its own CHECKs.
    if (what === "not") continue;
    if (what === "constraint") {
      const named = (match[2] ?? "").trim().replace(/^if\s+exists\s+/i, "");
      assert.match(named, /^phoenix_crm_[a-z_0-9]+$/, `${path} drops the constraint ${named} — it only ever replaces its own`);
      continue;
    }
    // "drop index" rebuilds one of its own indexes on a new predicate — 20261017120000 widens the
    // one-open-ask index to cover an ask at either step. It must name a phoenix_crm_ index AND create
    // that same index again in the same file, or it is a drop, not a replacement.
    if (what === "index") {
      const named = (sql.slice(match.index).match(/^drop\s+index\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_][a-z_0-9]*)/i) ?? [])[1] ?? "";
      assert.match(named, /^phoenix_crm_[a-z_0-9]+$/, `${path} drops the index ${named} — it only ever replaces its own`);
      assert.ok(
        new RegExp(`\\bcreate\\s+(?:unique\\s+)?index\\s+(?:if\\s+not\\s+exists\\s+)?${named}\\b`, "i").test(sql),
        `${path} drops the index ${named} and never creates it again — it only ever replaces its own`,
      );
      continue;
    }
    assert.equal(what, "policy", `${path} drops a ${match[1]} — it only ever replaces its own policies, constraints and indexes`);
  }
}

function runMigrationTests() {
  const sql = migrationSql();
  assertMigrationHygiene(sql, MIGRATION);

  // Tables: its own thirteen, every one locked to the service role.
  const tables = [...sql.matchAll(/\bcreate table if not exists public\.(phoenix_crm_[a-z_]+) \(/g)].map((match) => match[1]);
  assert.equal(tables.length, (sql.match(/\bcreate\s+table\b/gi) ?? []).length, "every table the migration creates is a public.phoenix_crm_* table");
  assert.equal(tables.length, 13, "Phoenix CRM's thirteen tables");
  const loop = /foreach v_table in array array\[([\s\S]*?)\] loop([\s\S]*?)end loop;/.exec(sql);
  assert.ok(loop, "the loop that locks every table to the service role is still there");
  assert.deepEqual(
    [...loop[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort(),
    [...tables].sort(),
    "every table goes through the lock loop — a table left out is open to the anon and authenticated roles",
  );
  for (const statement of [
    "execute format('alter table public.%I enable row level security', v_table);",
    "'create policy %I on public.%I for all to service_role using (true) with check (true)'",
    "execute format('revoke all on table public.%I from public, anon, authenticated', v_table);",
    "execute format('grant all on table public.%I to service_role', v_table);",
  ]) {
    assert.ok(loop[2].includes(statement), `the lock loop still runs: ${statement}`);
  }

  // Functions: seventeen, SECURITY DEFINER with a fixed search path, executable by the service role only.
  const functions = functionsIn(sql, MIGRATION);
  assert.equal(functions.length, 17, "Phoenix CRM's seventeen functions");
  assertFunctionGrants(sql, MIGRATION, functions);

  // Writes: its own tables, and the bucket row. Reads of the organogram and the reference list are by design.
  const writes = [...sql.matchAll(/\b(insert\s+into|delete\s+from|update)\s+([a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?)/gi)]
    .filter((match) => !(match[1].toLowerCase() === "update" && match[2].toLowerCase() === "set"))
    .map((match) => match[2].toLowerCase());
  assert.ok(writes.length >= 40, `found only ${writes.length} writes — the scan has stopped seeing the functions`);
  // Against the SQL the database runs today, never a function a later migration has replaced.
  runMigrationReviewFixTests(liveMigrationSql());

  // The migrations that follow it are held to the same hygiene, and their functions join the set the
  // services may call. A function replaced by a later migration is not counted twice.
  const callable = new Set(functions);
  const allTables = [...tables];
  for (const path of LATER_MIGRATIONS) {
    const later = migrationSql(path);
    assertMigrationHygiene(later, path);
    const added = functionsIn(later, path);

    // A table a LATER migration adds. It cannot join the first migration's lock loop, so it states the
    // same four statements itself — and the check has to be made here, because until this loop existed
    // a table added after the first migration was invisible to every rule below: the services could
    // read it, and nothing said whether anon and authenticated could too.
    const laterTables = [...later.matchAll(/\bcreate table if not exists public\.(phoenix_crm_[a-z_]+) \(/g)].map((match) => match[1]);

    // A migration must contribute something this scan can SEE. The guard is against a rename quietly
    // matching nothing — an entry that parses to no functions and no tables proves only that the
    // regexes have stopped working. A table-only migration is legitimate and satisfies it.
    assert.ok(
      added.length > 0 || laterTables.length > 0,
      `${path} adds no function and no table — have they been renamed, or the regexes outgrown?`,
    );
    assertFunctionGrants(later, path, added.filter((name) => !callable.has(name)), added);
    for (const name of added) callable.add(name);
    assert.equal(
      laterTables.length,
      (later.match(/\bcreate\s+table\b/gi) ?? []).length,
      `${path}: every table it creates is a public.phoenix_crm_* table`,
    );
    for (const table of laterTables) {
      for (const statement of [
        `alter table public.${table} enable row level security;`,
        `create policy ${table}_service_role\n  on public.${table} for all to service_role using (true) with check (true);`,
        `revoke all on table public.${table} from public, anon, authenticated;`,
        `grant all on table public.${table} to service_role;`,
      ]) {
        assert.ok(later.includes(statement), `${path}: ${table} is locked to the service role — missing: ${statement.split("\n")[0]}`);
      }
      allTables.push(table);
    }

    // A VIEW a later migration adds. It is read through PostgREST exactly as a table is, so it is held
    // to the same lock — and to one rule of its own: WITHOUT `security_invoker` a view runs as its
    // OWNER, which walks it straight through the row-level security every table above enables. That is
    // the one way to add an object to this module that looks locked and is not.
    const laterViews = [...later.matchAll(/\bcreate or replace view public\.(phoenix_crm_[a-z_]+)\b/g)].map((match) => match[1]);
    assert.equal(
      laterViews.length,
      (later.match(/\bcreate\s+(?:or\s+replace\s+)?view\b/gi) ?? []).length,
      `${path}: every view it creates is a public.phoenix_crm_* view`,
    );
    for (const view of laterViews) {
      assert.match(
        later,
        new RegExp(String.raw`create or replace view public\.${view}\s*\nwith \(security_invoker = true\)`),
        `${path}: ${view} must be security_invoker, or it bypasses the RLS on the tables under it`,
      );
      for (const statement of [
        `revoke all on table public.${view} from public, anon, authenticated;`,
        `grant select on table public.${view} to service_role;`,
      ]) {
        assert.ok(later.includes(statement), `${path}: ${view} is locked to the service role — missing: ${statement}`);
      }
      allTables.push(view);
    }
  }

  // The photo bucket: private, JPEG only, 2 MB; a re-run makes it private again.
  assert.match(
    sql,
    /insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)\s+values \('phoenix-crm-photos', 'phoenix-crm-photos', false, 2097152, array\['image\/jpeg'\]\)\s+on conflict \(id\) do update\s+set public = false,/,
  );
  assert.match(
    sql,
    /create policy phoenix_crm_photos_service_role\s+on storage\.objects\s+for all\s+to service_role\s+using \(bucket_id = 'phoenix-crm-photos'\)\s+with check \(bucket_id = 'phoenix-crm-photos'\)/,
    "only the service role reaches the photos",
  );

  // The services read and call only what the migration creates, and read nothing else but three sources.
  const READ_ONLY_SOURCES = ["au_v_org_tree", "employees", "source_of_sales_products"];
  let tableUses = 0;
  let rpcUses = 0;
  for (const file of walk("src/lib/phoenix-crm/server")) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\.from\(\s*"([^"]+)"\s*\)/g)) {
      tableUses += 1;
      const table = match[1];
      if (table.startsWith("phoenix_crm_")) {
        assert.ok(allTables.includes(table), `${file} uses ${table}, which no migration in this module creates`);
        continue;
      }
      assert.ok(READ_ONLY_SOURCES.includes(table), `${file} uses ${table} — outside its own tables Phoenix CRM reads only the organogram, people's names and the product list`);
      const chain = source.slice(Number(match.index) + match[0].length).split(";")[0];
      assert.match(chain, /^\s*\.select\(/, `${file} only ever reads ${table}`);
      assert.doesNotMatch(chain, /\.(?:insert|update|upsert|delete)\(/, `${file} writes ${table}`);
    }
    for (const match of source.matchAll(/(?:\.rpc|\bcallPhoenixCrm(?:<[^();{}\n]*>)?|\brpcAll(?:<[^();{}\n]*>)?\([^,()]*(?:\(\))?,)\(?\s*"([a-z_]+)"/g)) {
      rpcUses += 1;
      assert.ok(callable.has(match[1]), `${file} calls ${match[1]}, which no Phoenix CRM migration creates`);
    }
    // The module has two buckets, and each file reaches exactly one of them. Stated per file rather
    // than as "either of ours": the two hold different kinds of evidence — a photo says somebody was
    // there, a recording says nothing about where it was made — and a file that could open both is a
    // file that could quietly file a recording where the photos are read from.
    // The visit recording (2026-10-16) is a third kind again — the whole conversation, kept for the
    // Super Admin — so it has a bucket of its own and one file that opens it.
    // An Interviews day's CVs (2026-10-29) are a candidate's own papers — a fourth kind, a bucket of its
    // own, and one file that opens it.
    const bucketFor = file.endsWith("/voice-notes.ts")
      ? "PHOENIX_CRM_VOICE_BUCKET"
      : file.endsWith("/visit-recordings.ts")
        ? "PHOENIX_CRM_RECORDING_BUCKET"
        : file.endsWith("/interview-cvs.ts")
          ? "PHOENIX_CRM_INTERVIEW_CV_BUCKET"
          : "PHOENIX_CRM_PHOTO_BUCKET";
    for (const match of source.matchAll(/\.storage\.from\(\s*([^)]*)\)/g)) {
      assert.equal(match[1].trim(), bucketFor, `${file} opens a bucket other than the one it owns`);
    }
  }
  assert.ok(tableUses >= 20, `found only ${tableUses} table reads in the services`);
  assert.ok(rpcUses >= 12, `found only ${rpcUses} function calls in the services`);
  assert.match(readFileSync("src/lib/phoenix-crm/server/photos.ts", "utf8"), /export const PHOENIX_CRM_PHOTO_BUCKET = "phoenix-crm-photos";/);
  assert.match(readFileSync("src/lib/phoenix-crm/server/voice-notes.ts", "utf8"), /export const PHOENIX_CRM_VOICE_BUCKET = "phoenix-crm-voice";/);
  assert.match(
    readFileSync("src/lib/phoenix-crm/server/visit-recordings.ts", "utf8"),
    /export const PHOENIX_CRM_RECORDING_BUCKET = "phoenix-crm-recordings";/,
  );
  assert.match(
    readFileSync("src/lib/phoenix-crm/server/interview-cvs.ts", "utf8"),
    /export const PHOENIX_CRM_INTERVIEW_CV_BUCKET = "phoenix-crm-interview-cvs";/,
  );

  // The voice note's own rule, and the reason it is asserted rather than written down: a recording
  // carries no authority over when a visit happened, so phoenix_crm_take_voice returns void where its
  // photo sibling returns the issue time that becomes captured_at. Returning nothing is what makes the
  // rule unbreakable by a later edit — and voice-notes.ts exports no issuedAt for one to reach for.
  const voiceSql = migrationSql("supabase/migrations/20260925030047_phoenix_crm_visit_voice_note.sql");
  assert.match(
    voiceSql,
    /create or replace function public\.phoenix_crm_take_voice\([\s\S]*?\)\s*\nreturns void\n/,
    "phoenix_crm_take_voice returns void — a recording may not date a visit",
  );
  assert.doesNotMatch(
    // Stripped, because the comment explaining the absence necessarily names the thing that is absent.
    stripComments(readFileSync("src/lib/phoenix-crm/server/voice-notes.ts", "utf8")),
    /\bissuedAt\b/,
    "voice-notes.ts hands back no issue time — there must be nothing here for a later change to date a visit with",
  );
}

// ── 6. The risk review's fixes (2026-09-17) ─────────────────────────────────────────────────────────

/** One function's text in the comment-free migration, from its header to its closing `$$;`. */
function functionSql(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is still in the migration`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `${name} ends in "$$;"`);
  return sql.slice(start, end);
}

function runMigrationReviewFixTests(sql: string) {
  // Replacing the photo policy locks storage.objects until COMMIT, and every upload in the app waits
  // behind it: the migration gives up after 5 seconds instead of queueing them.
  const opening = sql.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(opening.slice(0, 2), ["begin;", "set local lock_timeout = '5s';"], "the migration waits at most 5 seconds for any lock");

  // An empty reference list is ready but never stamped, so a list that reaches the territory later
  // (a new rep's first iReports360 list) is finished before planning.
  assert.match(
    functionSql(sql, "phoenix_crm_seat_readiness"),
    /where p_mark_ready\s+and c\.reference_total > 0\s+and c\.open_count = 0\s+and c\.drop_pending_count = 0\s+on conflict \(seat_id\) do nothing/,
    "a territory is stamped ready only when it has a reference list and all of it is done",
  );

  // A slot is asked for right after the photo is taken: 2 hours covers the wait for the doctor, never
  // the next morning's visits dated to the night before.
  assert.match(
    functionSql(sql, "phoenix_crm_take_photo"),
    /if v_slot\.issued_at < now\(\) - interval '2 hours' then\s+raise exception 'phoenix_crm:photo_expired';/,
    "a photo slot lasts 2 hours",
  );
  assert.equal((sql.match(/phoenix_crm:photo_expired/g) ?? []).length, 1, "one photo window");

  // Once the week's Thursday has passed (Cairo), its plan stays as it stood; a late approval still records.
  const transition = functionSql(sql, "phoenix_crm_plan_transition");
  assert.match(transition, /\n\s*v_today date := \(now\(\) at time zone 'Africa\/Cairo'\)::date;\n/, "the transition reads the Cairo day");
  const weekCheck = transition.search(
    /if v_action <> 'approve' and v_plan\.week_start \+ 5 < v_today then\s+raise exception 'phoenix_crm:week_passed';/,
  );
  assert.ok(weekCheck >= 0, "a plan whose week is over cannot be sent, reopened or returned");
  assert.ok(weekCheck < transition.indexOf("if v_action = 'submit' then"), "the week is checked before any action runs");

  // Plan against actual counts a day when the plan stood sent at the END of that Cairo day, read from
  // the plan's own events — never from the plan's status today, which a reopen or a return changes.
  //
  // 🔴 AND "SENT" IS SUBMITTED OR APPROVED, NOT 'returned'. It used to accept 'returned' too, which
  // made a WHOLE-week return — and the returned day of a one-day return — count as PLANNED here while
  // `phoenix_crm_save_visit` stamped the rep's visit on it `is_unplanned`. The rule is day-by-day
  // since 20261002221947; tests/phoenix-crm-plan-review.test.ts section 5e holds the whole of it.
  const planVsActual = functionSql(sql, "phoenix_crm_report_plan_vs_actual");
  assert.match(
    planVsActual,
    /select e\.to_status, e\.details, e\.created_at\s+from public\.phoenix_crm_plan_events e\s+where e\.plan_id = d\.plan_id\s+and e\.to_status is not null\s+and e\.created_at < \(\(d\.plan_date \+ 1\)::timestamp at time zone 'Africa\/Cairo'\)\s+order by e\.created_at desc, e\.id desc\s+limit 1\s+\) latest/,
    "the plan's last status before that Cairo day ended is what decides the day",
  );
  assert.match(planVsActual, /where latest\.to_status in \('submitted', 'approved'\)/, "and sent means submitted or approved");
  assert.doesNotMatch(planVsActual, /in \('submitted', 'approved', 'returned'\)/, "a returned week is not authority by its status alone");
  assert.match(
    planVsActual,
    /from sent_days s\s+join public\.phoenix_crm_plans pl on pl\.id = s\.plan_id\s+join public\.phoenix_crm_plan_items i on i\.plan_id = s\.plan_id and i\.plan_date = s\.plan_date/,
    "the planned customers are the items of those sent days only",
  );
  assert.doesNotMatch(planVsActual, /\bpl\.status\b/, "plan against actual never reads a plan's status today — a reopened or returned plan would take finished days out");
  // The report trusts every plan event to carry the status it left the plan in. Five inserts write a
  // weekly plan event: the save's own two ('created', 'saved'), the weekly transition's one (submit,
  // reopen and decide), the monthly plan's transition, which cascades the month's field weeks and
  // records each week's own event, and HR's acknowledgement of a request to edit a sent week, which
  // reopens it (owner, 2026-10-01). Each carries its to_status — a reopened week reads 'draft'. Two more
  // since 2026-10-08: the Administrator closing a reopened week back to how it was sent writes the
  // status it went back to - 'approved' (with the original approver) or 'submitted'.
  const eventInserts = [...sql.matchAll(/insert into public\.phoenix_crm_plan_events \(([^)]*)\)/g)];
  assert.equal(eventInserts.length, 7, "plans write their events in seven places");
  for (const insert of eventInserts) {
    assert.ok(insert[1].split(",").map((column) => column.trim()).includes("to_status"), `a plan event is written without its status: (${insert[1]})`);
  }
}

function runServiceReviewFixTests() {
  const source = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

  // A readiness answer missing for a territory is a fault: it throws, and never reads as ready.
  const list = source("src/lib/phoenix-crm/server/list.ts");
  assert.match(
    list,
    /const unanswered = asked\.filter\(\(seatId\) => !readiness\.has\(seatId\)\);\n\s*if \(unanswered\.length > 0\) \{\n\s*throw new Error\(/,
    "loadReadiness throws when the database leaves a territory out",
  );
  const plans = source("src/lib/phoenix-crm/server/plans.ts");
  assert.match(plans, /if \(!entry\) return \{ ready: false,/, "the planner stays closed for a territory with no readiness answer");
  const team = source("src/lib/phoenix-crm/server/team.ts");
  assert.doesNotMatch(team, /ready: true/, "the Team view never makes up a ready territory");
  assert.doesNotMatch(`${plans}\n${team}`, /noReferenceList|if \(!entry\) return \{ ready: true/);

  // A week that is over keeps its plan: no return is offered or accepted.
  assert.match(plans, /canReturn: weekOpen && canReturnTerritoryPlan\(viewer, seat, isTest\)/, "the planner offers no return once the week is over");
  assert.match(plans, /const weekOpen = editablePlanDays\(weekStart, viewer\.cairoToday\)\.length > 0;/, "the review list knows whether the week is over");
  assert.match(plans, /canReturn: weekOpen && \(plan\?\.status === "submitted"/, "the review list offers no return once the week is over");
  assert.match(
    plans,
    /decidedAs = assertCanReturnPlan\(viewer, seat, isTest\);[\s\S]{0,300}if \(editablePlanDays\(String\(planRow\.week_start\), today\)\.length === 0\) \{\n\s*throw conflictError\(/,
    "returning a plan whose week is over is refused before the database is asked",
  );
  const db = source("src/lib/phoenix-crm/server/db.ts");
  assert.match(db, /\n\s*week_passed: \{ status: 409, message: "[^"]+" \},\n/, "the database's week_passed refusal reads as a sentence");
  assert.match(db, /photo_expired: \{ status: 409, message: "This photo was taken more than 2 hours ago\. Take a new photo\." \}/);

  // The product list is paged on its key, never cut at the database's per-answer row cap. product_name
  // rides along so the pharmacy-stock check can group the products under their family.
  const products = source("src/lib/phoenix-crm/server/products.ts");
  assert.match(
    products,
    /fetchAllRowsKeyset<Record<string, unknown>>\(\s*\(\) => getSupabaseAdmin\(\)\.from\("source_of_sales_products"\)\.select\("product_code, product_name, family, line"\)\.eq\("active", true\),\s*\{ cursorColumn: "product_code",/,
    "the product families come from every active product",
  );
  assert.doesNotMatch(products, /\.limit\(/, "no fixed cap on the product list");

  // The street-address lookup (a paid call per photo) is limited per person, after the permission
  // check and before the body is read; a refusal answers 429, not a server error.
  const location = methodBlocks(source(`${API_ROOT}/location/route.ts`)).get("POST") ?? "";
  const gateAt = location.indexOf('await assertPermission(access, "phoenix_crm", "create");');
  const limitAt = location.search(/await assertApiRateLimit\(\{\n\s*identifier: rateLimitIdentity\(\{ actor: access\.testPersona \? access\.loginId : access\.hrId \|\| access\.loginId, request \}\),\n\s*limit: LOOKUPS_PER_HOUR,\n\s*scope: "phoenix_crm_location",\n\s*windowMs: 60 \* 60 \* 1000,\n\s*\}\);/);
  assert.ok(gateAt >= 0 && limitAt > gateAt, "the location lookup is limited per person, after its permission check");
  assert.ok(limitAt < location.indexOf("request.json("), "the limit is checked before the body is read");
  assert.match(source(`${API_ROOT}/location/route.ts`), /const LOOKUPS_PER_HOUR = \d+;/);
  const http = source("src/lib/phoenix-crm/server/http.ts");
  const limited = http.search(/if \(isApiRateLimitError\(error\)\) \{\n\s*return NextResponse\.json\([\s\S]{0,400}\{ headers: \{ "Retry-After": String\(error\.retryAfterSeconds\) \}, status: 429 \}/);
  assert.ok(limited >= 0 && limited < http.indexOf("toApiError(error, fallback)"), "a rate-limit refusal answers 429 with Retry-After, before the generic mapping turns it into a 500");
}

export function runPhoenixCrmBoundaryTests() {
  runPermissionTests();
  runRouteTests();
  runIsolationTests();
  runImportTests();
  runMigrationTests();
  runServiceReviewFixTests();
}
