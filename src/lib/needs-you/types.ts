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
  "market-awareness-approvals": { href: "/admin/market-awareness", screen: "Market Awareness" },
  "monthly-closings": { href: "/sales/monthly-closing", screen: "Monthly Closing" },
  "payroll-publish": { href: "/admin/automated-payroll", screen: "Automated Payroll" },
  resignations: { href: "/resignations", screen: "Resignations" },
  "contract-renewals": { href: "/contracts", screen: "Contracts" },
  "probation-decisions": { href: "/probation", screen: "Probation" },
  "coaching-red-zone": { href: "/coaching", screen: "Coaching" },
  "salary-flags": { href: "/admin/m-payroll", screen: "Payroll Management" },
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
