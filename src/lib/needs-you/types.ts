/**
 * The Needs You board — the one shape every source is reduced to before anything renders.
 *
 * 🔴 THE GOVERNING RULE: A BOARD THAT UNDER-REPORTS IS WORSE THAN NO BOARD. This page exists so the
 * owner stops walking a dozen admin screens himself. If it prints "nothing needs you" while
 * something is waiting — or while a read simply failed — it has cost him the decision more surely
 * than no board would, because he has delegated the looking.
 *
 * That rule is enforced by the SHAPES here rather than by discipline in the callers:
 *
 *  1. {@link NeedsYouSourceState} has no `count` field on any branch. A source that failed cannot
 *     write a number anywhere, because there is nowhere to write one — it produces no item at all.
 *  2. `not-applicable` is a THIRD state, not a flavour of `unavailable`. Nine permission refusals
 *     would otherwise become nine permanent amber warnings, which trains the reader to ignore
 *     amber — the same failure one step removed.
 *  3. {@link NeedsYouBoard.sources} carries one entry per {@link NeedsYouSourceId}, always, and a
 *     test pins that. A source dropped by a lost `await` or a deleted registry line fails CI
 *     instead of rendering as calm.
 *  4. `allClearProvable` is computed ONCE, in `classify.ts`. Nothing else may decide the empty
 *     state, and in particular never `yours.length === 0`.
 *
 * Over-reporting is allowed and deliberately untested. A row he glances at and dismisses costs two
 * seconds; a row that never appeared costs a deploy.
 */

/**
 * Every source this board composes, as a CLOSED union.
 *
 * The list is the registry: `service.ts` fans out over the adapters, `classify.ts` walks THIS array
 * to build the per-source report, and `tests/needs-you-never-under-reports.test.ts` holds the two
 * against each other. So a source can only be added or removed in one place, and removing one is a
 * visible change to this array rather than a quietly shorter board.
 *
 * WHAT IS DELIBERATELY ABSENT. `getVacationPendingApprovalCounts` — the org-wide "pending by stage"
 * figure the CEO board shows — is not here. It re-reads the whole vacation dataset (11.7 s measured
 * 2026-09-21, the slowest read behind /admin) and would exceed this board's own 8-second per-source
 * timeout most of the time, so it would render as permanent amber. `leave-approvals` already answers
 * the question this board asks — what is waiting on the VIEWER — through `getVacationAwaitingBadge`,
 * which reads the responder's own slice. Adding the org-wide figure back would trade a real answer
 * for a source that is nearly always "could not be read".
 */
export const needsYouSourceIds = [
  "action-inbox",
  "plan-approvals",
  "leave-approvals",
  "excuse-approvals",
  "direct-order-approvals",
  "direct-order-unbooked",
  "direct-order-validations",
  "marketing-approvals",
  "market-awareness-approvals",
  "monthly-closings",
  "payroll-publish",
  "resignations",
  "contract-renewals",
  "probation-decisions",
  "coaching-red-zone",
  "salary-flags",
  // Added 2026-10-03. Phoenix CRM's own decisions — a list request and an off-plan visit at this
  // viewer's own step, and how much of the carried-over lists is still waiting to be validated. Until
  // then the module was the ONLY place a district manager or the SFE Manager could see them, and the
  // off-plan visit is the one whose delay costs a rep his figures: it counts in nothing until it is
  // decided. The counts come from the module's own producer (`server/decision-queues.ts`), which the
  // module page's own badge reads too, so the two can never disagree.
  "phoenix-crm-decisions",
  // Added 2026-10-04. A request in ANY chain (marketing, direct orders, vacation) stranded because
  // the one person who must act next has resigned — a `returned` request whose requester has left and
  // can never resubmit it, or an approval rung named to someone who has left. Nothing else in the
  // product surfaces it: it is not in anyone's "waiting on me" queue and it is not terminal, so it
  // ages out of sight — five direct orders sat 48–52 days this way before a hand sweep found them.
  // Produced by `src/lib/approvals/orphaned-requests.ts`.
  "orphaned-requests",
  // Added 2026-10-07. A leaver who left with an APPROVED deduction that was never collected on-system,
  // while their final settlement is plausibly still open — the preventive window where it can still be
  // netted in. Scoped forward (the owner's 2026-10-07 ruling: once a leaver is gone and paid the money
  // is unrecoverable, "nothing to do", so the closed August-2026 cohort is never surfaced) and bounded
  // to a rolling window so it never becomes a standing ledger of gone money. No EGP ever reaches the
  // board. Produced by `src/lib/deductions/uncollected-leaver-deductions.ts`.
  "uncollected-leaver-deductions",
  // Added 2026-10-07. A Private Calendar review request an employee raised on one of his own days —
  // Super Admin only end to end, so nobody else can clear it for him. It reached him exactly once,
  // on the day it was submitted, and then only in the notification: the Calendar Disputes inbox is a
  // screen he has to remember to open. One sat pending for two days before this row existed, which is the shape
  // this board exists to stop. Produced by `src/lib/private-calendar/disputes.ts`.
  "calendar-review-requests",
  // Added 2026-10-09. A PUBLISHED closing line whose figures have moved since it was announced.
  // `phx_closing_drift_status` already existed and already reported it, but its two headline
  // numbers are SUMS over the drifted cells, so a redistribution BETWEEN areas cancels to zero in
  // both: measured on production 2026-10-09, Anti Infective 2026-09 read 27 drifted cells, net
  // units 0.000000 and net value 0.000000 while 25 areas had moved and Menoufia 2 alone had lost
  // money. So the one surface that could have said something said nothing, and nothing in the
  // product asked the question at all unless a session ran a script. Produced by
  // `src/lib/sales/closing-publication-drift.ts`.
  //
  // 🔴 IT READS THE CHEAP LAYERS ONLY, AND THE ROW SAYS SO. The store-split layer is 17,282 ms on
  // its own (measured, same day) against ~1.5 s for the three layers here, so a live source that
  // included it would be amber more often than not — the exact trade the vacation note above
  // refuses. `loadPublicationDriftWithoutSplitLayer` sets `splitLayerRead: false`, the row names
  // the script that reads both halves, and no item here is ever presented as a whole-month verdict.
  // It reads the LATEST published period only: all of them together took 15,352 ms on the same day,
  // and re-issuing a month announced long ago is not a live choice — the script answers for those.
  "closing-publication-drift",
  // Added 2026-10-09. A month whose COMMITTED Office spread no longer matches where the owner's
  // golden rule would put those units today. The Office channel carries no geography, so each area
  // takes its share of the line's non-Office VALUE — and those shares are computed once, when the
  // Office file is committed, then written into the rows. Nothing re-runs them, so a distributor
  // book that lands or is re-mapped AFTER the commit moves the base underneath a frozen spread.
  // Produced by `src/lib/sales/office-allocation-drift.ts`.
  //
  // 🔴 NOTHING ELSE IN THE PRODUCT CAN SEE IT. Today's side is today's shares applied to the line's
  // OWN stored Office total, so both sides hold the same units per line BY CONSTRUCTION — the
  // publication drift check compares a line's total units, one scalar, and is therefore
  // structurally blind to every difference here. Until this row existed the only way to ask was for
  // a session to remember to run a script: measured on production 2026-10-09, August 2026 CNS has
  // 3,697.58 of its 109,719 Office units (3.37%) sitting in the wrong area across 43 areas, and no
  // screen said so.
  //
  // 🔴 IT READS TWO PERIODS AND NO MORE: the latest with an Office batch, and the latest PUBLISHED
  // one that has an Office batch. They are different questions — the live month can still be
  // re-committed, while a published month's stale spread is already serving and the fix is ruled out
  // by his 2026-09-07 rule, so it is shown as `worth-knowing` rather than hidden. Measured the same
  // day: 656 ms to list the nine periods that have an Office batch, 1,851–2,182 ms per period, and
  // 2,735 ms for this whole adapter against the board's 8-second budget; all nine would be ~18 s.
  // Every other month is the script's question, and the row names it.
  "office-allocation-drift",
  // Added 2026-10-15. An active person whose own `employees` record disagrees with the seat they
  // occupy in the EU organogram — the area, the region or the manager. `au_v_employee_seat_drift`
  // has reported it all along and NOTHING read it as an alarm: its four callers
  // (`weekly-planning/planning-areas.ts`, the two CRM coverage loaders,
  // `employee-360/brick-coverage.ts`) take the seat columns off it and ignore the drift booleans.
  // Produced by `src/lib/org/employee-seat-drift.ts`.
  //
  // 🔴 THE COST OF THE SILENCE, MEASURED ONCE IN A LIVE INCIDENT. A medical rep hired into the
  // Behira 1 rep seat on 2026-10-08 had her `area_id` edited on the 13th to Behira 2 — another
  // rep's area. The weekly and monthly plan has no rep picker: it auto-assigns from the area, and
  // `medicalRepOptionsForEmployee` takes that area from the EMPLOYEE record, so she disappeared
  // from her own area (which then showed no rep at all) and lost the one she had been moved into
  // to the alphabetically earlier rep already there. No amber fired — the "needs an assigned
  // Medical Rep" warning only shows for an area that already has one — and it surfaced two days
  // later because her district manager noticed a name missing.
  //
  // 🔴 NO SEAT AT ALL IS NOT DRIFT. Sixteen Head Office people hold no seat by design, and the
  // view omits them because it starts from the seated and joins outward. Widening this to "has no
  // seat" would put all sixteen on the board on every load, for ever.
  "organogram-seat-drift",
  // Added 2026-11-13 (enterprise audit REC-027). A new employee one of whose hiring follow-up steps —
  // the offer letter linked, the candidate marked hired, the portal login, the CV, the mailbox task,
  // the offer stamped accepted, the joining form's audit row — failed and has not been repaired by
  // the hourly `hire-handoff-reconcile` job, or was given up after five attempts. Each door only
  // LOGGED these before, so a joiner with no login was found by a person noticing. Read from
  // `hire_handoff_steps` (src/lib/employees/hire-handoff.ts); one row per person, linked to the
  // record; the board never retries anything itself.
  "hire-handoff-gaps",
  // Added 2026-11-14 (enterprise audit REC-031). A deduction dispute whose newest line is the
  // employee's (nobody has answered since) on a deduction still active on the payslip — the same count
  // as the Deduction Disputes rail badge (countOpenDeductionsDisputes). The badge was the only place it
  // showed, so a dispute waited unseen by anyone who did not open that tab. Super Admin only: a reply
  // is his alone (isDeductionsDecisionActor).
  "deduction-disputes",
  // Added 2026-11-14 (enterprise audit REC-031). An approval email (a durable direct email) that used
  // every outbox retry and will not be tried again until someone presses "send again" on Email
  // Notifications — the same rows that screen lists (listExhaustedDurableEmails). The drain alarm sees
  // them for a week; this keeps each one on the board until it is sent again.
  "stopped-approval-emails",
  // Added 2026-11-03, after GitHub suspended the account on 2 Nov and no board said so. Three sources rather
  // than one, so one failed read cannot hide another or print a false all-clear (vendor-accounts-rules.ts).
  "vendor-github",
  "vendor-whatsapp",
  "vendor-telegram",
] as const;

export type NeedsYouSourceId = (typeof needsYouSourceIds)[number];

/**
 * What a person would call each source, for the amber "could not be read" rows and the every-source
 * band. Names, never codes — the owner's standing rule, and the only labels this module prints.
 *
 * A `Record` over the closed union rather than a lookup with a fallback: a new source id that nobody
 * labelled is a compile error here, instead of a row on his screen reading `payroll-publish`.
 */
export const needsYouSourceLabels: Record<NeedsYouSourceId, string> = {
  "action-inbox": "Other approvals inbox",
  "plan-approvals": "Weekly and monthly plan approvals",
  "leave-approvals": "Leave approvals",
  "excuse-approvals": "Excuse approvals",
  "direct-order-approvals": "Direct order approvals",
  "direct-order-unbooked": "Direct orders waiting on a sales month",
  "direct-order-validations": "Pharmacy validation desk",
  "marketing-approvals": "Marketing approval inbox",
  "market-awareness-approvals": "Awareness approvals",
  "monthly-closings": "Monthly closings not published",
  "payroll-publish": "Payroll months waiting to publish",
  resignations: "Resignations",
  "contract-renewals": "Contract renewals and expiries",
  "probation-decisions": "Probation decisions",
  "coaching-red-zone": "Coaching red-zone reps",
  "salary-flags": "Unresolved salary flags",
  "phoenix-crm-decisions": "Phoenix CRM decisions",
  "orphaned-requests": "Requests stranded on someone who left",
  "uncollected-leaver-deductions": "Leavers with an uncollected deduction",
  "calendar-review-requests": "Calendar review requests",
  "closing-publication-drift": "Published closings that have moved",
  "office-allocation-drift": "Office allocation that no longer matches the rule",
  "organogram-seat-drift": "Employee records that disagree with the organogram",
  "hire-handoff-gaps": "New hires whose hand-off did not finish",
  "deduction-disputes": "Deduction disputes waiting for a reply",
  "stopped-approval-emails": "Approval emails that stopped retrying",
  "vendor-github": "The GitHub account",
  "vendor-whatsapp": "The WhatsApp account",
  "vendor-telegram": "The Telegram bot",
};

/**
 * Where each source's decision is actually taken, and what that screen is CALLED.
 *
 * One record rather than an href in the adapter and a screen name in the renderer: those two drift,
 * and the failure is a row that says "open the closing screen" and links somewhere else. The adapters
 * read `href`, `render/sections.ts` reads `screen`, and both are pure data so the pure test can walk
 * them.
 *
 * Every href is an app screen that ALREADY owns the decision. This board links, it never acts.
 */
export const needsYouDestinations: Record<NeedsYouSourceId, { href: `/${string}`; screen: string }> = {
  "action-inbox": { href: "/admin/action-center", screen: "Action Center" },
  "plan-approvals": { href: "/admin/approvals/plan", screen: "Plan Approvals" },
  "leave-approvals": { href: "/admin/approvals/vacation", screen: "Leave Approvals" },
  "excuse-approvals": { href: "/admin/approvals/excuse", screen: "Excuse Approvals" },
  "direct-order-approvals": { href: "/admin/direct-orders", screen: "Direct Orders" },
  "direct-order-unbooked": { href: "/admin/direct-orders", screen: "Direct Orders" },
  "direct-order-validations": { href: "/admin/direct-orders/validations", screen: "Validation Desk" },
  "marketing-approvals": { href: "/admin/marketing-requests/inbox", screen: "Marketing Inbox" },
  // The INBOX, not the workspace: the workspace has no decision buttons, so a card that said "awaiting
  // your decision" and opened it left the CEO looking at a request he could not answer.
  "market-awareness-approvals": { href: "/admin/market-awareness/inbox", screen: "Awareness Approvals" },
  "monthly-closings": { href: "/sales/monthly-closing", screen: "Monthly Closing" },
  "payroll-publish": { href: "/admin/automated-payroll", screen: "Automated Payroll" },
  resignations: { href: "/resignations", screen: "Resignations" },
  "contract-renewals": { href: "/contracts", screen: "Contracts" },
  "probation-decisions": { href: "/probation", screen: "Probation" },
  "coaching-red-zone": { href: "/coaching", screen: "Coaching" },
  "salary-flags": { href: "/admin/m-payroll", screen: "Payroll Management" },
  // The live Phoenix CRM app is `/admin/field-crm`; `/admin/phoenix-crm` is the retired 2026-09-14
  // pilot and only forwards here. The Team tab is where every one of these decisions is actually
  // taken — the list requests, the off-plan visits and each territory's list readiness are all on it.
  "phoenix-crm-decisions": { href: "/admin/field-crm?tab=team", screen: "Phoenix CRM Team" },
  // Spans three modules, so each ITEM carries its own href to the screen that owns it (see the
  // adapter). This source-level default is only the fallback for the amber "could not be read" row
  // and the every-source band label; Stuck Approvals is the cross-module screen that can actually
  // act on these, and since 2026-10-08 it is where a stranded direct order is closed.
  "orphaned-requests": { href: "/admin/approvals/stuck", screen: "Stuck Approvals" },
  // The final-settlement flow for one leaver inside an unfinished month lives on /admin/deductions —
  // the only screen where a human can still net an uncollected leaver deduction in. The board links;
  // it never acts, and it never states the EGP, which lives on that screen.
  "uncollected-leaver-deductions": { href: "/admin/deductions", screen: "Deductions" },
  // The Calendar Disputes inbox — its own page since 2026-10-08, and the same destination the
  // submitted-and-replied notifications carry, so the board and the notice land on one screen.
  "calendar-review-requests": { href: "/admin/private-calendar-disputes", screen: "Calendar Disputes" },
  // The publication screen: unpublishing and re-issuing a closing is the only place this is
  // decided, and it is his decision alone. The board links there and never offers to rebuild.
  "closing-publication-drift": { href: "/sales/monthly-closing", screen: "Monthly Closing" },
  // The Sales Import wizard, NOT the closing screen: re-committing the Office book is the only
  // action anywhere that recomputes those shares (`app/api/sales/monthly-sales/office/commit`), and
  // the closing screen cannot do it. The board links there and never re-commits anything itself.
  "office-allocation-drift": { href: "/sales/import", screen: "Sales Import" },
  // Employee Master, where the record half of the disagreement is corrected. Each ITEM appends
  // `?edit=<hr id>` and opens that one person's form (`employees/employee-master-link.ts`); this
  // bare path is the fallback for the amber row and the every-source band. The other half — moving
  // the SEAT — is an organogram change, which is the owner's alone to initiate, so the board never
  // offers it: which side is wrong is a human judgement, and on 2026-10-15 it was the record.
  "organogram-seat-drift": { href: "/employees", screen: "Employee Master" },
  // Employee Master: each item appends `?edit=<hr id>` and opens that new hire's record, where a
  // missing login, CV or work email is finished by hand. The board links; it never retries.
  "hire-handoff-gaps": { href: "/employees", screen: "Employee Master" },
  // The Disputes tab of Deductions — where the reply is written. The board links; it never replies.
  "deduction-disputes": { href: "/admin/deductions?tab=disputes", screen: "Deduction Disputes" },
  // Email Notifications, whose "Approval emails that did not send" list carries the "send again"
  // button for each one. The board links; it never re-queues anything itself.
  "stopped-approval-emails": { href: "/admin/email-notifications", screen: "Email Notifications" },
  // An account is settled on the vendor's own site, and no Phoenix screen can do it. System Audit is where the
  // failed runs behind these rows are recorded, so that is where the board sends him to read more.
  "vendor-github": { href: "/admin/system-audit", screen: "System Audit" },
  "vendor-whatsapp": { href: "/admin/system-audit", screen: "System Audit" },
  "vendor-telegram": { href: "/admin/system-audit", screen: "System Audit" },
};

/**
 * WHOSE work the row is.
 *
 * `yours` is the only lane the empty-state sentence is gated on, because the sentence says "nothing
 * is waiting on a decision only you can make" and that is exactly what this lane means.
 */
export type NeedsYouLane = "yours" | "someone-else" | "worth-knowing";

/**
 * `merge` exists and is never produced in v1. This board reads no GitHub: `scripts/needs-you.mjs` is
 * the tier-1 board that owns open pull requests, and duplicating its `mergeStateStatus` reading here
 * would be a second copy of a rule whose wrong answer walks the owner into a merge. The slot stays
 * so a later phase adds a row rather than a column.
 */
export type NeedsYouKind = "approval" | "publish" | "expiry" | "flag" | "merge";

export type NeedsYouItem = {
  /** Stable within a board — `"leave-approvals:pending"`, `"monthly-closings:2026-08"`. */
  key: string;
  sourceId: NeedsYouSourceId;
  kind: NeedsYouKind;
  lane: NeedsYouLane;
  /** A sentence, with NAMES and never codes. */
  label: string;
  /**
   * `null` means THIS IS NOT A COUNT — a month waiting to publish, say. It never means "unknown":
   * a source that could not be counted produces no item, so there is no unknown to encode.
   */
  count: number | null;
  /**
   * Live names. There is NO `hrId` field on this type, on purpose — "names, never codes" is then a
   * property of the shape rather than something each adapter has to remember.
   */
  people: readonly string[];
  /**
   * An app screen that ALREADY owns the decision. Templated so an off-app address or a
   * `javascript:` URL cannot land in the app's own link slot.
   */
  href: `/${string}` | null;
  /** A GitHub pull request. Its own slot and its own affordance — never mixed with `href`. */
  externalUrl: string | null;
  /** Cairo ISO — the sort key. */
  oldestAt: string | null;
  ageDays: number | null;
  /** UPSTREAM's own SLA verdict. Never recomputed here, so two screens cannot disagree. */
  overdue: boolean;
  note: string | null;
};

/**
 * One source's answer.
 *
 * `ok` with an empty `items` is a TRUE zero: the source answered and there is nothing in it.
 * `not-applicable` is also a true zero — the viewer holds no rung, so there is nothing to report.
 * `unavailable` is NOT a zero, and it is the only branch the board must never swallow.
 */
export type NeedsYouSourceState =
  | { status: "ok"; items: readonly NeedsYouItem[] }
  | { status: "not-applicable"; because: string }
  | { status: "unavailable"; because: string };

export type NeedsYouSourceResult = { id: NeedsYouSourceId; state: NeedsYouSourceState };

export type NeedsYouSourceReport = {
  id: NeedsYouSourceId;
  label: string;
  status: NeedsYouSourceState["status"];
  /** The reason, in words, for the two non-`ok` statuses. `null` when the source answered. */
  because: string | null;
  /** How many items it produced, or `null` when it did not answer. Never 0 for a failure. */
  itemCount: number | null;
};

/** One amber row: a source that did not answer, named the way a person would say it. */
export type NeedsYouNotProven = { id: NeedsYouSourceId; label: string; because: string };

export type NeedsYouBoard = {
  /** When the fan-out ran, as an instant. Rendered in Africa/Cairo, never raw UTC. */
  generatedAt: string;
  /**
   * TRUE only when every source answered (`ok` or `not-applicable`) AND nothing landed in `yours`.
   * The empty-state sentence is gated on this and on nothing else.
   */
  allClearProvable: boolean;
  yours: readonly NeedsYouItem[];
  someoneElse: readonly NeedsYouItem[];
  worthKnowing: readonly NeedsYouItem[];
  notProven: readonly NeedsYouNotProven[];
  /** One entry per `NeedsYouSourceId`, always. Pinned by a test. */
  sources: readonly NeedsYouSourceReport[];
};
