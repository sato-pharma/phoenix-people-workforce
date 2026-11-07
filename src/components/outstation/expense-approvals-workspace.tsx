"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardList,
  Download,
  Inbox,
  Search,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { DecisionBar } from "@/components/outstation/expense-approvals/decision-bar";
import { EmployeeSummaryPanel } from "@/components/outstation/expense-approvals/employee-summary";
import { type Decision, type LoadedRecord, PANEL_CLASS, type TripIdleDays, egp } from "@/components/outstation/expense-approvals/shared";
import { StatLine } from "@/components/outstation/expense-approvals/stat-line";
import { TripList } from "@/components/outstation/expense-approvals/trip-list";
import { TripReview } from "@/components/outstation/expense-approvals/trip-review";
import {
  EXPENSE_APPROVAL_VIEW_KEY_BASE,
  EXPENSE_DECISION_DRAFT_KEY_BASE,
  browserLocalStorage,
  ownerScopedStorageKey,
} from "@/lib/browser-storage/owner-scoped";
import { formatNumberValue } from "@/lib/i18n/format";
import {
  APPROVED_STATUS,
  REJECTED_STATUS,
  expenseApprovalQueueRank,
  expenseApprovalState,
  expenseDecisionChanged,
  isAdjustedAmount,
  planBulkApproval,
} from "@/lib/outstation/approval-state";
import { outstationRequestIdFromTripId } from "@/lib/outstation/expense-approval-decisions";
import { isImportedHistoryTrip } from "@/lib/outstation/imported-history";
import { flagDuplicateTripRows } from "@/lib/outstation/duplicate-trip-guard";
import {
  buildExpenseApprovalFilterOptions,
  countActiveExpenseApprovalFilters,
  matchesExpenseApprovalFilters,
  matchesExpenseApprovalSearchText,
  NO_EXPENSE_APPROVAL_FILTERS,
} from "@/lib/outstation/expense-approval-filters";
import {
  type ExpenseApprovalSort,
  compareExpenseApprovalTrips,
  expenseTripTriage,
  withLiveWorkloadStatus,
} from "@/lib/outstation/expense-approval-triage";
import type { ExpenseApprovalFilters } from "@/lib/outstation/expense-approval-filters";
import {
  buildExpenseApprovalEmployeeSummary,
  totalExpenseApprovalSummary,
} from "@/lib/outstation/expense-approval-summary";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";
import { phxButtonApproveDenseClassName, phxFieldClassName } from "@/components/ui/form-tokens";

/**
 * Expense Approvals — the state and money container.
 *
 * Rebuilt from scratch on 2026-11-07 (owner: "fully from scratch rebuild the expense approvals,
 * more premium, polished, more obvious, clear, more easy for design and human review"). Everything
 * that moves money stays HERE, unchanged: the stored and on-screen decisions, the unsaved count,
 * which rows a save posts, the one-POST-per-report save loop, the ranked list, the bulk plan, the
 * owner-scoped draft and the leave guard. The page itself is composed from the parts in
 * `./expense-approvals/`: one stat line, the trip rail with the decision block under it, the trip
 * as the whole right side, the By employee table, and the slim decision row at the foot of a phone.
 */

/** A row the server declined to write, and why (see the POST route's `requestDecisions`). */
type SkippedDecision = { reason: string; tripId: string };

function savedDecision(record: LoadedRecord): Decision {
  return {
    approvedAmount: typeof record.approvedAmount === "number" ? record.approvedAmount : record.total,
    hrApproved: Boolean(record.hrApproved),
    hrComment: record.hrComment ?? "",
    status: record.status ?? "",
  };
}

/**
 * Where an unsaved decision set survives leaving the page.
 *
 * Every decision on this screen is held in React state until Save is pressed, and a reviewer works
 * a ~400-row queue one trip at a time. Any exit discarded the lot with no message: a sidebar click,
 * the browser back button, a reload, the hard navigation Next.js performs after a deploy. On
 * 2026-09-07 that cost a full evening's review — the database recorded ONE save, and everything
 * decided around it was gone.
 *
 * `localStorage`, not `sessionStorage`: closing the tab and coming back is exactly the case that
 * lost the work. Per browser and per viewer, which is what it should be — a draft is one person's
 * unsaved thinking, not shared state.
 *
 * Per viewer is now the KEY (`…draft.v2:<HR id>`, 2026-10-26): the v1 key was one per browser, so on
 * a shared office PC one reviewer's unsaved decisions were restored into the next reviewer's queue
 * and saved under their name. With no HR id nothing is stored at all.
 */
const LEGACY_DECISION_DRAFT_KEY = "phoenix.outstation.expense-approvals.draft.v1";

/** A draft older than this belongs to a different sitting — drop it rather than silently re-open
 * decisions taken against a queue that has moved on. */
const DECISION_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Never let a storage failure reach the queue. Private mode, a full quota and a browser with site
 * data blocked all throw here, and none of them is a reason to stop reviewing expenses. */
function readExpenseDecisionDraft(draftKey: string | null): Record<string, Decision> | null {
  try {
    window.localStorage.removeItem(LEGACY_DECISION_DRAFT_KEY);
    if (!draftKey) return null;
    const raw = window.localStorage.getItem(draftKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { decisions?: unknown; savedAt?: unknown };
    const savedAt = Number(parsed?.savedAt);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > DECISION_DRAFT_MAX_AGE_MS) return null;
    const entries = parsed?.decisions;
    if (!entries || typeof entries !== "object") return null;

    // Validated field by field rather than cast: this is the one input to the page that is not
    // the API, and a half-shaped entry would flow straight into a Save payload.
    const draft: Record<string, Decision> = {};
    for (const [tripId, value] of Object.entries(entries as Record<string, unknown>)) {
      const entry = value as Partial<Decision> | null;
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.approvedAmount !== "number" || !Number.isFinite(entry.approvedAmount)) continue;
      if (typeof entry.hrApproved !== "boolean") continue;
      if (typeof entry.hrComment !== "string" || typeof entry.status !== "string") continue;
      draft[tripId] = {
        approvedAmount: entry.approvedAmount,
        hrApproved: entry.hrApproved,
        hrComment: entry.hrComment,
        status: entry.status,
      };
    }
    return Object.keys(draft).length > 0 ? draft : null;
  } catch {
    return null;
  }
}

function writeExpenseDecisionDraft(draftKey: string | null, decisions: Record<string, Decision>) {
  if (!draftKey) return;
  try {
    if (Object.keys(decisions).length === 0) {
      window.localStorage.removeItem(draftKey);
      return;
    }
    window.localStorage.setItem(
      draftKey,
      JSON.stringify({ decisions, savedAt: Date.now() }),
    );
  } catch {
    // A draft that cannot be written is the behaviour this page had before — never a save failure.
  }
}

// The admin shell zeroes every border-radius (globals.css RULE 1 — the deliberately "shredded"
// look), so these are written square at source: what you read here is what renders.
const FIELD_CLASS = cn(phxFieldClassName, "w-full px-3");
// `pr-9` keeps the selected value clear of SearchableSelect's own search icon.
const FILTER_CONTROL_CLASS = `${FIELD_CLASS} pr-9`;
export function ExpenseApprovalsWorkspace({
  /**
   * Whether this viewer may DECIDE, as opposed to merely read. Resolved on the server and passed
   * down (2026-08-08) — the CEO can now open this workspace to read the claim validation, and
   * must not be shown controls he cannot use.
   *
   * Presentation only. The decision route asserts system-administrator access independently, so a
   * viewer who somehow reached the buttons is still refused server-side. Defaults to true so every
   * existing caller keeps its current behaviour.
   */
  canDecide = true,
  /** The signed-in reviewer's HR id — the decision draft is kept under it, and nowhere without it. */
  viewerHrId = null,
}: { canDecide?: boolean; viewerHrId?: string | null } = {}) {
  const draftKey = ownerScopedStorageKey(EXPENSE_DECISION_DRAFT_KEY_BASE, viewerHrId);
  const viewKey = ownerScopedStorageKey(EXPENSE_APPROVAL_VIEW_KEY_BASE, viewerHrId);
  const [loadedRecords, setRecords] = useState<LoadedRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<ExpenseApprovalFilters>(NO_EXPENSE_APPROVAL_FILTERS);
  // Each opened trip's idle days, lifted from its field-work read so the decision box can offer
  // the allowance share for them (owner, 2026-11-07: "LET ME DECIDE" — offered, never applied).
  const [idleByTrip, setIdleByTrip] = useState<Record<string, TripIdleDays>>({});
  // An opened trip's live day-by-day answer replaces its stored workload stamp for the rail's
  // reasons, its Needs a look / Clean split and their counts — the rail never disagrees with the
  // page it opens (owner's review, 2026-11-07). Rows not yet opened keep the stored stamp.
  const records = useMemo(() => withLiveWorkloadStatus(loadedRecords, idleByTrip), [loadedRecords, idleByTrip]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveSkipped, setSaveSkipped] = useState<SkippedDecision[]>([]);
  /**
   * Decisions that were saved but did NOT reach payroll — the run's Part 2 is already confirmed,
   * or the resync failed (audit finding 47). The server names each one; this screen has to show it,
   * because "Approvals saved." over the top of it reads as the money having moved.
   */
  const [savePayrollWarnings, setSavePayrollWarnings] = useState<string[]>([]);
  const [selectedTripIds, setSelectedTripIds] = useState<Set<string>>(() => new Set());
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [view, setView] = useState<"queue" | "employees">("queue");
  const [expandedEmployees, setExpandedEmployees] = useState<Set<string>>(() => new Set());
  const [restoredDraftCount, setRestoredDraftCount] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  // Guards BOTH draft effects below: nothing may be persisted before the stored draft has been
  // read, or the empty initial state would erase the very work being recovered.
  const draftRestoredRef = useRef(false);

  // No setState before the first `await`, so this stays safe to call straight from an effect
  // (loading starts true on mount; the retry handler re-arms it).
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/outstation/expenses", { headers: { accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok) {
        // Tracked separately from a generic failure: an expired session needs a sign-in, and
        // Retry would just fail again.
        setSessionExpired(response.status === 401 || payload?.error === "session_expired");
        throw new Error(payload?.message || "Unable to load expenses.");
      }
      setRecords(Array.isArray(payload.expenses) ? (payload.expenses as LoadedRecord[]) : []);
      setLoadError(null);
      setSessionExpired(false);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load expenses.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      await Promise.resolve();
      if (!cancelled) await load();
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Bring back whatever was left unsaved last time. Runs once, and only once the queue itself is
  // on screen, because a draft entry is only meaningful against a record: a trip that has since
  // left the queue, or one somebody else has already decided the same way, must not be re-opened.
  //
  // Shaped around the `await Promise.resolve()` for the same reason the loader above is: a
  // synchronous setState in an effect body is a lint ERROR here (react-hooks/set-state-in-effect),
  // and this genuinely is the case that rule allows — reconciling with a store outside React that
  // cannot be read during render.
  useEffect(() => {
    if (draftRestoredRef.current || records.length === 0) return;
    draftRestoredRef.current = true;

    let cancelled = false;
    async function restoreDraft() {
      await Promise.resolve();
      if (cancelled) return;

      const draft = readExpenseDecisionDraft(draftKey);
      if (!draft) return;

      const restored: Record<string, Decision> = {};
      for (const record of records) {
        const entry = draft[record.tripId];
        // Dropped rather than restored when it now MATCHES the stored row — that draft entry is
        // already committed, and carrying it would show a permanent phantom "1 decision not saved".
        if (entry && expenseDecisionChanged(entry, savedDecision(record))) {
          restored[record.tripId] = entry;
        }
      }

      const count = Object.keys(restored).length;
      if (count === 0) return;
      // `...current` last: anything decided in the moment before this landed outranks the draft.
      setDecisions((current) => ({ ...restored, ...current }));
      setRestoredDraftCount(count);
    }

    void restoreDraft();
    return () => {
      cancelled = true;
    };
  }, [records, draftKey]);

  // The rail's order is remembered per reviewer (owner's review, 2026-11-07). Read once the viewer
  // is known — after a microtask, as the draft restore above, so no setState runs in the effect
  // body. Anything unreadable leaves "Biggest first".
  useEffect(() => {
    if (!viewKey) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      let stored: string | null = null;
      try {
        stored = browserLocalStorage()?.getItem(viewKey) ?? null;
      } catch {
        stored = null;
      }
      if (stored === "oldest" || stored === "value") setFilters((current) => (current.sort === stored ? current : { ...current, sort: stored }));
    });
    return () => {
      cancelled = true;
    };
  }, [viewKey]);
  const chooseSort = useCallback(
    (sort: ExpenseApprovalSort) => {
      setFilters((current) => ({ ...current, sort }));
      if (!viewKey) return;
      try {
        browserLocalStorage()?.setItem(viewKey, sort);
      } catch {
        // Storage blocked or full: the order still changes, it is just not remembered.
      }
    },
    [viewKey],
  );

  // Persist on every change, so the draft is never more than one decision behind the screen.
  useEffect(() => {
    if (!draftRestoredRef.current) return;
    writeExpenseDecisionDraft(draftKey, decisions);
  }, [decisions, draftKey]);

  // Imported history (trips before July 2026) is values only — owner ruling 2026-09-12, see
  // imported-history.ts — so it always shows what is stored, whatever a restored draft holds for it.
  const decisionFor = useCallback(
    (record: LoadedRecord): Decision =>
      isImportedHistoryTrip(record.date) ? savedDecision(record) : (decisions[record.tripId] ?? savedDecision(record)),
    [decisions],
  );

  const setDecision = useCallback((record: LoadedRecord, patch: Partial<Decision>) => {
    setSaveMessage(null);
    setDecisions((current) => {
      const base = current[record.tripId] ?? savedDecision(record);
      return { ...current, [record.tripId]: { ...base, ...patch } };
    });
  }, []);

  // `expenseDecisionChanged` rather than an inline compare, and the SAME call `save()` makes below
  // — the two were written separately once and disagreed about a rejection being undone, so this
  // bar counted a decision the payload then left out (see approval-state.ts).
  const dirtyCount = useMemo(() => {
    return records.reduce(
      (count, record) => {
        const local = decisions[record.tripId];
        if (!local || isImportedHistoryTrip(record.date)) return count;
        return expenseDecisionChanged(local, savedDecision(record)) ? count + 1 : count;
      },
      0,
    );
  }, [records, decisions]);

  // A full page unload — reload, tab close, the hard navigation Next.js forces after a deploy — is
  // the one exit the draft above cannot narrate on the way out, so say so before it happens.
  // Registered ONLY while something is unsaved: a permanently attached `beforeunload` makes the
  // page ineligible for the back/forward cache (the same reason report-client-error.ts avoids it),
  // and this page is otherwise perfectly safe to leave.
  //
  // It does NOT catch an in-app link — Next.js client navigation never fires it — which is exactly
  // why the draft is the load-bearing half of this fix and the warning only the polite half.
  useEffect(() => {
    if (dirtyCount === 0) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Browsers show their own wording and ignore ours; the assignment is what arms the dialog.
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  // Month/employee choices come from the loaded queue itself, so every option has at least one
  // trip behind it — a fixed calendar or the full directory would offer dead ends.
  const filterOptions = useMemo(() => buildExpenseApprovalFilterOptions(records), [records]);
  // Same employee, same day, same destination, both still live: a trip claimed twice. Read over the
  // WHOLE loaded queue (not the open tab), so a pending copy of an already-approved trip is flagged.
  // A flag is a review signal only — nothing is refused or held by it (duplicate-trip-guard.ts).
  const duplicateFlags = useMemo(() => flagDuplicateTripRows(records), [records]);
  const activeFilterCount = countActiveExpenseApprovalFilters(filters);
  const narrowed = activeFilterCount > 0 || search.trim().length > 0;

  // What the XLSX export will contain: the SAME month/employee/search narrowing as the queue
  // above, but spanning all three decision states at once (a status column tells them apart) —
  // "for the filtered period and person" means everything for that scope, not just whichever tab
  // happens to be open. Computed here, client-side, purely so the button can show a real count and
  // disable itself on zero; the export route re-derives the same rows from the database using the
  // identical shared filter functions, so the two can never disagree.
  const exportCount = useMemo(
    () =>
      records.filter(
        (record) => matchesExpenseApprovalFilters(record, filters) && matchesExpenseApprovalSearchText(record, search),
      ).length,
    [records, filters, search],
  );
  const exportHref = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.month) params.set("month", filters.month);
    if (filters.employee) params.set("employee", filters.employee);
    if (filters.triage) params.set("triage", filters.triage);
    if (search.trim()) params.set("search", search.trim());
    const query = params.toString();
    return query ? `/api/admin/outstation/expenses/export?${query}` : "/api/admin/outstation/expenses/export";
  }, [filters, search]);

  const { pending, approved, rejected, undecidedHistory } = useMemo(() => {
    const matches = (record: LoadedRecord) => matchesExpenseApprovalSearchText(record, search);
    const visible = records.filter(
      (record) => matchesExpenseApprovalFilters(record, filters) && matches(record),
    );
    // The rail's own order (biggest first, or oldest first), so "approve, then the next one" opens
    // the row directly under the trip just decided.
    const byValue = compareExpenseApprovalTrips(filters.sort);
    // One shared rule decides the queue (see approval-state.ts), so a trip lands in exactly one.
    // Pending excludes rejections — otherwise rejecting a trip would leave it sitting in the
    // inbox forever and the button would look like it did nothing.
    const inState = (state: ReturnType<typeof expenseApprovalState>) =>
      visible.filter((record) => expenseApprovalState(decisionFor(record)) === state).sort(byValue);
    const undecided = inState("pending");
    return {
      approved: inState("approved"),
      // Imported history never awaits a decision (imported-history.ts), so it cannot be selected,
      // bulk-approved or counted as waiting.
      pending: undecided.filter((record) => !isImportedHistoryTrip(record.date)),
      rejected: inState("rejected"),
      // ...but its values are still shown: it stays in the per-employee summary below.
      undecidedHistory: undecided.filter((record) => isImportedHistoryTrip(record.date)),
    };
  }, [records, search, filters, decisionFor]);

  // The stat line's "of": the same three states over the WHOLE queue, filters and search ignored.
  const overallCounts = useMemo(() => {
    const counts = { approved: 0, pending: 0, rejected: 0 };
    for (const record of records) {
      const state = expenseApprovalState(decisionFor(record));
      if (state === "pending" && isImportedHistoryTrip(record.date)) continue;
      counts[state] += 1;
    }
    return counts;
  }, [records, decisionFor]);

  // How many trips AWAIT a decision under each rail choice — within the month, the employee and
  // the search, but across both triage choices, so each button says what clicking it would show.
  const triageCounts = useMemo(() => {
    const counts = { all: 0, clean: 0, look: 0 };
    const scope = { ...filters, triage: "" as const };
    for (const record of records) {
      if (!matchesExpenseApprovalFilters(record, scope) || !matchesExpenseApprovalSearchText(record, search)) continue;
      if (isImportedHistoryTrip(record.date) || expenseApprovalState(decisionFor(record)) !== "pending") continue;
      counts.all += 1;
      const triage = expenseTripTriage(record)?.triage;
      if (triage) counts[triage] += 1;
    }
    return counts;
  }, [records, search, filters, decisionFor]);

  /**
   * ONE LIST, not three tabs — owner, 2026-09-08: "i want them in one list not tabs".
   *
   * Ordered by the STORED state, deliberately not the live one. A row therefore does NOT jump out
   * from under the cursor the moment it is decided: it stays exactly where it is and changes its
   * own chip, and the list re-orders on the next load — which is after Save, which is the only
   * point a reviewer expects things to move. Sorting on the live decision would make every single
   * approval shuffle the list the reviewer is working down.
   *
   * `pending` / `approved` / `rejected` above are still computed, from the LIVE decision, because
   * the header chips, the stat cards and the bulk bar all count what is on screen right now. So
   * nothing the tabs carried is lost: the split moved to the stat cards, and an individual trip's
   * state was always on its own row — the coloured spine and the Approved / Rejected chip.
   */
  const activeList = useMemo(() => {
    const rank = (record: LoadedRecord) =>
      expenseApprovalQueueRank(expenseApprovalState(savedDecision(record)));
    return records
      .filter(
        (record) =>
          matchesExpenseApprovalFilters(record, filters) &&
          matchesExpenseApprovalSearchText(record, search),
      )
      .sort((left, right) => rank(left) - rank(right) || compareExpenseApprovalTrips(filters.sort)(left, right));
  }, [records, filters, search]);
  // Derive (don't store) the effective selection so it stays valid as tabs/filters change,
  // without a setState-in-effect. An explicit click still wins via `selectedId`.
  const effectiveSelectedId =
    selectedId && activeList.some((record) => record.tripId === selectedId)
      ? selectedId
      : (activeList[0]?.tripId ?? null);
  const selected = useMemo(
    () => records.find((record) => record.tripId === effectiveSelectedId) ?? null,
    [records, effectiveSelectedId],
  );
  // Where the open trip sits in the list, for the panel's "Trip 4 of 37" and its Previous / Next.
  const selectedIndex = activeList.findIndex((record) => record.tripId === effectiveSelectedId);
  // On a phone the panel sits UNDER a 70vh list, so a tapped trip opened out of sight and the
  // reviewer had to scroll down to find it. Bring the panel into view there; a desktop already
  // shows the two side by side.


  const openTrip = useCallback((tripId: string) => setSelectedId(tripId), []);
  const recordIdleDays = useCallback((tripId: string, idle: TripIdleDays) => {
    setIdleByTrip((current) =>
      current[tripId]?.idleDays === idle.idleDays && current[tripId]?.tripDays === idle.tripDays
        ? current
        : { ...current, [tripId]: idle },
    );
  }, []);

  // Counts alone don't answer the question this queue exists to answer — "how much money is
  // waiting on me". These follow the filters, so the strip always describes what is on screen.
  const totals = useMemo(() => {
    const sum = (list: LoadedRecord[]) =>
      list.reduce((running, record) => running + decisionFor(record).approvedAmount, 0);
    const adjusted = [...pending, ...approved].filter(
      (record) => isAdjustedAmount(decisionFor(record).approvedAmount, record.total),
    );
    return {
      adjustedCount: adjusted.length,
      adjustedDelta: adjusted.reduce(
        (running, record) => running + (record.total - decisionFor(record).approvedAmount),
        0,
      ),
      approvedValue: sum(approved),
      pendingValue: sum(pending),
    };
  }, [pending, approved, decisionFor]);

  // Built from the CURRENT decisions (the three filtered queues), not from what is stored, so a
  // trip approved a moment ago and not yet saved counts here exactly as it does in the stat cards.
  const employeeSummaries = useMemo(
    () =>
      buildExpenseApprovalEmployeeSummary(
        [...pending, ...undecidedHistory, ...approved, ...rejected].map((record) => {
          const decision = decisionFor(record);
          return {
            amWorkload: record.amWorkload,
            approvedAmount: decision.approvedAmount,
            claimedTotal: record.total,
            date: record.date,
            destination: record.location || record.to || "",
            km: record.km,
            pharmacyWorkload: record.pharmacyWorkload ?? null,
            pmWorkload: record.pmWorkload,
            specialist: record.specialist,
            state: expenseApprovalState(decision),
            toDate: record.toDate,
            tripId: record.tripId,
          };
        }),
      ),
    [pending, undecidedHistory, approved, rejected, decisionFor],
  );
  const summaryTotals = useMemo(
    () => totalExpenseApprovalSummary(employeeSummaries),
    [employeeSummaries],
  );

  // Reverse a decision straight from the summary, without going back to the queue and re-finding
  // the trip. Writes exactly what the panel's Unapprove / Undo rejection buttons write — clearing
  // BOTH the approval flag and the rejected status, so a reversed trip lands back in Pending
  // rather than in a half-state. Local only: Save still commits.
  const undoDecision = useCallback(
    (tripId: string) => {
      setSaveMessage(null);
      setBulkMessage(null);
      setDecisions((current) => {
        const record = records.find((candidate) => candidate.tripId === tripId);
        if (!record) return current;
        const base = current[tripId] ?? savedDecision(record);
        return { ...current, [tripId]: { ...base, hrApproved: false, status: "" } };
      });
    },
    [records],
  );

  const toggleEmployee = useCallback((employeeKey: string) => {
    setExpandedEmployees((current) => {
      const next = new Set(current);
      if (next.has(employeeKey)) next.delete(employeeKey);
      else next.add(employeeKey);
      return next;
    });
  }, []);

  // A 300-trip queue is worked with hands on the keyboard. Navigation ONLY — approve and reject
  // stay deliberately mouse-driven, because a mistyped key must never be able to move money.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable),
      );
      if (event.key === "Escape" && typing) {
        target?.blur();
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      const step =
        event.key === "ArrowDown" || event.key === "j"
          ? 1
          : event.key === "ArrowUp" || event.key === "k"
            ? -1
            : 0;
      if (step === 0 || activeList.length === 0) return;
      event.preventDefault();
      const current = activeList.findIndex((record) => record.tripId === effectiveSelectedId);
      const next = activeList[Math.min(activeList.length - 1, Math.max(0, current + step))];
      if (next) setSelectedId(next.tripId);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeList, effectiveSelectedId]);

  // Keyboard paging is useless if the row it lands on is below the fold.
  useEffect(() => {
    if (!effectiveSelectedId) return;
    document
      .querySelector(`[data-trip-id="${CSS.escape(effectiveSelectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [effectiveSelectedId]);

  const selectNextPending = useCallback(
    (fromTripId: string) => {
      const index = pending.findIndex((record) => record.tripId === fromTripId);
      const next = pending[index + 1] ?? pending.find((record) => record.tripId !== fromTripId) ?? null;
      setSelectedId(next?.tripId ?? null);
    },
    [pending],
  );

  // Selection is scoped to what is on screen: a trip the filters have hidden can never be approved
  // by a checkbox the reviewer can no longer see.
  const selectedVisible = useMemo(
    () => activeList.filter((record) => selectedTripIds.has(record.tripId)),
    [activeList, selectedTripIds],
  );
  const selectedValue = useMemo(
    () => selectedVisible.reduce((running, record) => running + decisionFor(record).approvedAmount, 0),
    [selectedVisible, decisionFor],
  );
  const bulkPlan = useMemo(
    () =>
      planBulkApproval(
        selectedVisible.map((record) => {
          const decision = decisionFor(record);
          return {
            approvedAmount: decision.approvedAmount,
            claimedTotal: record.total,
            hrApproved: decision.hrApproved,
            hrComment: decision.hrComment,
            status: decision.status,
            tripId: record.tripId,
          };
        }),
      ),
    [selectedVisible, decisionFor],
  );

  // Both of these track the PENDING rows, not the whole list. Only an undecided trip can be
  // bulk-approved, so a "select all" that ticked decided rows would report a header checkbox as
  // unchecked for ever — every decided row is one it can never tick.
  const allVisibleSelected =
    pending.length > 0 && pending.every((record) => selectedTripIds.has(record.tripId));

  const toggleTrip = useCallback((tripId: string) => {
    setBulkMessage(null);
    setSelectedTripIds((current) => {
      const next = new Set(current);
      if (next.has(tripId)) next.delete(tripId);
      else next.add(tripId);
      return next;
    });
  }, []);

  const toggleAllVisible = useCallback(() => {
    setBulkMessage(null);
    setSelectedTripIds((current) => {
      const next = new Set(current);
      const everySelected = pending.length > 0 && pending.every((record) => next.has(record.tripId));
      for (const record of pending) {
        if (everySelected) next.delete(record.tripId);
        else next.add(record.tripId);
      }
      return next;
    });
  }, [pending]);

  // Bulk approve writes the same local decision the single-trip button writes — it does NOT save.
  // The reviewer still presses Save, so a mis-click stays reversible right up to that point.
  function approveSelected() {
    const approvable = new Set(bulkPlan.approvableTripIds);
    const skipped: string[] = [];
    if (bulkPlan.needsReasonTripIds.length > 0) {
      skipped.push(
        `${formatNumberValue(bulkPlan.needsReasonTripIds.length)} still need a reason for a changed amount`,
      );
    }
    if (bulkPlan.notPendingTripIds.length > 0) {
      skipped.push(`${formatNumberValue(bulkPlan.notPendingTripIds.length)} were already decided`);
    }

    if (approvable.size === 0) {
      setBulkMessage(
        skipped.length > 0 ? `Nothing approved — ${skipped.join(" · ")}.` : "Nothing selected to approve.",
      );
      return;
    }

    setSaveMessage(null);
    setDecisions((current) => {
      const next = { ...current };
      for (const record of records) {
        if (!approvable.has(record.tripId)) continue;
        const base = next[record.tripId] ?? savedDecision(record);
        next[record.tripId] = { ...base, hrApproved: true, status: APPROVED_STATUS };
      }
      return next;
    });
    // Only the approved ones leave the selection, so whatever was blocked stays ticked and visible
    // instead of quietly disappearing.
    setSelectedTripIds((current) => {
      const next = new Set(current);
      for (const tripId of approvable) next.delete(tripId);
      return next;
    });
    setBulkMessage(
      `${formatNumberValue(approvable.size)} trip${approvable.size === 1 ? "" : "s"} approved — press Save to commit.${
        skipped.length > 0 ? ` Skipped: ${skipped.join(" · ")}.` : ""
      }`,
    );
  }

  // Names the trip the way the rest of the page does — the reviewer knows "Ahmed Salah", not
  // "OUTSTATION-48".
  function employeeForTrip(tripId: string) {
    return records.find((record) => record.tripId === tripId)?.specialist || tripId;
  }

  async function save() {
    setSaving(true);
    setSaveMessage(null);
    setSaveSkipped([]);
    setSavePayrollWarnings([]);
    const notWritten: SkippedDecision[] = [];
    // What the payroll resync could NOT apply — a run whose Part 2 is already confirmed, or a
    // resync that failed. The server has said this since audit finding 47's server half; this
    // screen used to drop it on the floor and still print "Approvals saved."
    const payrollNotApplied: string[] = [];
    try {
      const changedReportIds = new Set<string | null>();
      for (const record of records) {
        const local = decisions[record.tripId];
        if (!local || isImportedHistoryTrip(record.date)) continue;
        // The SAME predicate the unsaved count uses. When this was a narrower copy of it, a report
        // whose only change was an undone rejection never entered this set — so nothing was posted
        // for it, `setDecisions({})` below threw the decision away, and the reviewer was told
        // "Approvals saved."
        if (expenseDecisionChanged(local, savedDecision(record))) {
          changedReportIds.add(record.reportId ?? null);
        }
      }

      const isPostedOnSave = (record: LoadedRecord) => {
        if (outstationRequestIdFromTripId(record.tripId) === null) return true;
        const local = decisions[record.tripId];
        return Boolean(local) && !isImportedHistoryTrip(record.date) && expenseDecisionChanged(local, savedDecision(record));
      };

      // Save one report at a time with its FULL record set so the report's row/approval totals
      // recompute correctly (the API upserts by trip_id and re-stamps report_id/source_file_name).
      for (const reportId of changedReportIds) {
        const reportRecords = records.filter((record) => (record.reportId ?? null) === reportId);
        // Only an imported row may name the batch. App-submitted requests sit in the no-report
        // group too, and their "Outstation Requests" label would otherwise be stamped onto the
        // `source_file_name` of every genuinely imported row saved alongside them.
        const fileName =
          reportRecords.find(
            (record) => record.sourceFileName && outstationRequestIdFromTripId(record.tripId) === null,
          )?.sourceFileName || "outstation-expenses";
        const body = {
          fileName,
          // SAVE SENDS ONLY THE CLAIMS HE CHANGED (owner, 2026-11-06: "the Save button very long to
          // save"). An app-submitted claim (OUTSTATION-<id>) is decided row by row by the outstation
          // workflow, which reads every row it is sent from the database twice, one after another,
          // before it can tell the row is unchanged and skip it — so posting the whole queue of
          // several hundred claims made one Approve wait on hundreds of round trips. Those rows
          // now go only when decided here. An imported-sheet row still travels with its whole
          // report, because that save recomputes the report's totals from the set it is given.
          records: reportRecords.filter(isPostedOnSave).map((record) => {
            const decision = decisionFor(record);
            return {
              ...record,
              approvedAmount: decision.approvedAmount,
              hrApproved: decision.hrApproved,
              hrComment: decision.hrComment,
              // Rejection is carried by `status`; without this the server re-writes the row's
              // ORIGINAL status and the rejection never persists.
              status: decision.status,
            };
          }),
          reportId,
        };
        const response = await fetch("/api/admin/outstation/expenses", {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.message || "Unable to save approvals.");
        const skipped = payload?.requestDecisions?.skipped;
        if (Array.isArray(skipped)) notWritten.push(...(skipped as SkippedDecision[]));
        const warnings = payload?.payrollWarnings;
        if (Array.isArray(warnings)) {
          payrollNotApplied.push(...warnings.filter((line: unknown): line is string => typeof line === "string"));
        }
      }

      setDecisions({});
      // The banner speaks for work that is still only on screen. Once it is written the notice has
      // to go, or a reviewer who saved is still being told they have something outstanding.
      setRestoredDraftCount(0);
      await load();
      // A partial save must say so. App-submitted requests go down a different write path (the
      // outstation workflow), and it can refuse a row the queue was willing to show — a trip
      // already in a paid payroll batch, or a decided request being sent back to pending. Reporting
      // "Approvals saved." over that is how a reviewer walks away believing money moved.
      setSaveSkipped(notWritten);
      // The decision IS saved here — it simply never reached payroll. Silence would leave a
      // reviewer believing the money moved this month when it did not (audit finding 47).
      setSavePayrollWarnings([...new Set(payrollNotApplied)]);
      setSaveMessage(
        notWritten.length === 0
          ? "Approvals saved."
          : `Approvals saved, except ${formatNumberValue(notWritten.length)}: ${notWritten
              .map((entry) => `${employeeForTrip(entry.tripId)} — ${entry.reason}`)
              .join(" · ")}`,
      );
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "Unable to save approvals.");
    } finally {
      setSaving(false);
    }
  }

  // One set of decision handlers for both placements of the decision block (rail and phone row).
  // Decisions are held locally until Save is pressed; Approve also clears a stale "Rejected"
  // status, so a row can never be approved AND rejected at once.
  const decisionBarProps = {
    canDecide,
    decision: view === "queue" && selected ? decisionFor(selected) : null,
    dirtyCount,
    onApprove: () => {
      if (!selected) return;
      setDecision(selected, { hrApproved: true, status: APPROVED_STATUS });
      selectNextPending(selected.tripId);
    },
    onChangeAmount: (value: number) => selected && setDecision(selected, { approvedAmount: value }),
    onChangeReason: (value: string) => selected && setDecision(selected, { hrComment: value }),
    onReject: () => {
      if (!selected) return;
      setDecision(selected, { hrApproved: false, status: REJECTED_STATUS });
      selectNextPending(selected.tripId);
    },
    onSave: () => void save(),
    onUnapprove: () => selected && setDecision(selected, { hrApproved: false, status: "" }),
    onUnreject: () => selected && setDecision(selected, { hrApproved: false, status: "" }),
    idle: selected ? (idleByTrip[selected.tripId] ?? null) : null,
    record: view === "queue" ? selected : null,
    saving,
    valuesOnly: selected ? isImportedHistoryTrip(selected.date) : false,
  };

  return (
    <div className="space-y-4">
      {/* ONE compact header (owner, 2026-11-07: "about half of the screen is wasted in the irrelevant
          place"). Line 1: the title, the queue in figures, a chip when unsaved decisions were brought
          back, and Export. Line 2: the two views and the narrowing. The trips start right under it. */}
      <div className={cn(PANEL_CLASS, "divide-y divide-slate-200")} data-approvals-header>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
          <h1 className="inline-flex shrink-0 items-center gap-2 text-sm font-black uppercase tracking-[0.12em] text-slate-900">
            <Wallet className="h-4 w-4 text-orange-600" />
            Expense Approvals
          </h1>
          {/* The ONLY place these four figures render. They follow the filters, so the line always
              describes the trips on screen. */}
          <StatLine
            adjustedCount={totals.adjustedCount}
            adjustedDelta={totals.adjustedDelta}
            approvedCount={approved.length}
            approvedValue={totals.approvedValue}
            narrowed={narrowed}
            overall={overallCounts}
            pendingCount={pending.length}
            pendingValue={totals.pendingValue}
            rejectedCount={rejected.length}
          />
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* Work was recovered and is still NOT saved — the failure this guards is a reviewer
                believing decisions were committed when they were not. Tied to `dirtyCount`, so it
                goes the moment nothing is outstanding. */}
            {restoredDraftCount > 0 && dirtyCount > 0 ? (
              <span
                className="inline-flex items-center gap-1.5 border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-bold text-amber-800"
                role="status"
                title={`Brought back ${formatNumberValue(restoredDraftCount)} decision${restoredDraftCount === 1 ? "" : "s"} you had not saved. They are on screen again and still unsaved — press Save to commit them.`}
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {formatNumberValue(restoredDraftCount)} restored · unsaved
              </span>
            ) : null}
            {loading || exportCount === 0 ? (
              <span className="inline-flex cursor-not-allowed items-center gap-1.5 border border-slate-200 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.12em] text-slate-400">
                <Download className="h-3.5 w-3.5" /> Export
              </span>
            ) : (
              <a
                className="inline-flex items-center gap-1.5 bg-phx-accent px-3 py-1.5 text-xs font-bold uppercase tracking-[0.12em] text-white transition-colors hover:bg-phx-accent-hover"
                href={exportHref}
              >
                <Download className="h-3.5 w-3.5" /> Export XLSX
              </a>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <div className="inline-flex shrink-0 border border-slate-300" role="tablist">
            {([
              { key: "queue", label: "Review queue", icon: ClipboardList },
              { key: "employees", label: "By employee", icon: Users },
            ] as const).map(({ key, label, icon: Icon }) => (
              <button
                aria-selected={view === key}
                className={cn(
                  "inline-flex h-10 items-center gap-2 whitespace-nowrap px-3 text-sm font-black transition-colors",
                  view === key ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                )}
                key={key}
                onClick={() => setView(key)}
                role="tab"
                type="button"
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
          <label className="block min-w-[14rem] flex-1">
            <span className="sr-only">Search</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className={cn(FIELD_CLASS, "pl-9")}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search employee, HR ID, trip, destination"
                ref={searchRef}
                title="Press / to search · ↑ ↓ to move through the queue"
                value={search}
              />
            </span>
          </label>
          <label className="block w-full min-w-0 sm:w-44">
            <span className="sr-only">Trip month</span>
            <SearchableSelect
              aria-label="Filter by trip month"
              className={FILTER_CONTROL_CLASS}
              noResultsText="No months in this queue"
              onValueChange={(value) => setFilters((current) => ({ ...current, month: value }))}
              value={filters.month}
            >
              <option value="">All months</option>
              {filterOptions.months.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <label className="block w-full min-w-0 sm:w-60">
            <span className="sr-only">Employee</span>
            <SearchableSelect
              aria-label="Filter by employee"
              className={FILTER_CONTROL_CLASS}
              noResultsText="No employees in this queue"
              onValueChange={(value) => setFilters((current) => ({ ...current, employee: value }))}
              value={filters.employee}
            >
              <option value="">All employees</option>
              {filterOptions.employees.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold tabular-nums text-slate-500">
              {formatNumberValue(activeList.length)} of {formatNumberValue(records.length)} trips
              {activeFilterCount > 0
                ? ` · ${formatNumberValue(activeFilterCount)} filter${activeFilterCount === 1 ? "" : "s"}`
                : ""}
            </span>
            {narrowed ? (
              <button
                className="inline-flex shrink-0 items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-100"
                onClick={() => {
                  setSearch("");
                  // The order is a preference, not a narrowing: Clear all keeps it.
                  setFilters((current) => ({ ...NO_EXPENSE_APPROVAL_FILTERS, sort: current.sort }));
                }}
                type="button"
              >
                <X className="h-3 w-3" /> Clear all
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {saveMessage ? (
        // A partial save is neither a success nor a failure, and must not wear a green tick: some
        // decisions landed and some did not, and the reviewer has to see which. `saveSkipped` is
        // the fact, so the tone is read from that rather than sniffed back out of the message text.
        <AdminCallout
          tone={
            /unable|failed/i.test(saveMessage)
              ? "danger"
              : saveSkipped.length > 0 || savePayrollWarnings.length > 0
                ? "warning"
                : "success"
          }
        >
          {/unable|failed/i.test(saveMessage) ||
          saveSkipped.length > 0 ||
          savePayrollWarnings.length > 0 ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold">{saveMessage}</p>
            {/* Saved, but not carried into payroll. It never wears a green tick, and it names the
                month and the way back — reopening Part 2 — rather than just failing quietly. */}
            {savePayrollWarnings.length > 0 ? (
              <ul className="mt-1.5 flex flex-col gap-1 text-xs font-medium">
                {savePayrollWarnings.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </AdminCallout>
      ) : null}

      {bulkMessage ? (
        <AdminCallout tone={/^Nothing/.test(bulkMessage) ? "warning" : "success"}>
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-sm font-semibold">{bulkMessage}</p>
        </AdminCallout>
      ) : null}

      {/* Bulk bar. It states the exact count, the money behind it, and anything the selection
          contains that CANNOT be approved — so the reviewer reads the consequence before pressing,
          not after. Approving here only writes local decisions; Save still commits them. */}
      {view === "queue" && selectedVisible.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-orange-300 bg-orange-50 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-black text-slate-900">
              {formatNumberValue(selectedVisible.length)} selected · {egp(selectedValue)}
            </p>
            {bulkPlan.needsReasonTripIds.length > 0 ? (
              <p className="mt-0.5 text-xs font-bold text-rose-600">
                {formatNumberValue(bulkPlan.needsReasonTripIds.length)} cannot be approved yet — a changed
                amount needs a written reason
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-100"
              onClick={() => {
                setSelectedTripIds(new Set());
                setBulkMessage(null);
              }}
              type="button"
            >
              <X className="h-3 w-3" /> Clear selection
            </button>
            <Button
              className={cn(phxButtonApproveDenseClassName, "disabled:opacity-60")}
              disabled={bulkPlan.approvableTripIds.length === 0}
              onClick={approveSelected}
            >
              <Check className="mr-2 h-4 w-4" />
              Approve {formatNumberValue(bulkPlan.approvableTripIds.length)}
            </Button>
          </div>
        </div>
      ) : null}

      {view === "employees" ? (
        <EmployeeSummaryPanel
          expanded={expandedEmployees}
          narrowed={narrowed}
          onToggle={toggleEmployee}
          onUndo={undoDecision}
          summaries={employeeSummaries}
          totals={summaryTotals}
        />
      ) : (
        // The rail on the left, the trip as the page on the right (owner, 2026-11-07: "one trip
        // fills the screen"). `[&>*]:min-w-0` is load-bearing: a flex item defaults to
        // `min-width: auto`, so one long unbreakable address would push the page sideways.
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start [&>*]:min-w-0">
          <TripList
            activeList={activeList}
            allVisibleSelected={allVisibleSelected}
            decisionFor={decisionFor}
            duplicateFlags={duplicateFlags}
            effectiveSelectedId={effectiveSelectedId}
            footer={<DecisionBar placement="rail" {...decisionBarProps} />}
            loadError={loadError}
            loading={loading}
            narrowed={narrowed}
            onOpen={openTrip}
            onRetry={() => {
              setLoading(true);
              setLoadError(null);
              void load();
            }}
            onSort={chooseSort}
            onTriage={(triage) => setFilters((current) => ({ ...current, triage }))}
            pendingCount={pending.length}
            selectedTripIds={selectedTripIds}
            sessionExpired={sessionExpired}
            sort={filters.sort ?? "value"}
            toggleAllVisible={toggleAllVisible}
            toggleTrip={toggleTrip}
            totalCount={records.length}
            triage={filters.triage ?? ""}
            triageCounts={triageCounts}
          />
          <div className="min-w-0 flex-1">
            {!selected ? (
              <div className={cn(PANEL_CLASS, "flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-slate-400")}>
                <Inbox className="h-8 w-8" />
                <p className="text-sm font-medium">Select a trip to review and approve.</p>
              </div>
            ) : (
              <TripReview
                key={selected.tripId}
                decision={decisionFor(selected)}
                duplicateOf={duplicateFlags.get(selected.tripId)}
                onIdleDays={recordIdleDays}
                onNext={
                  selectedIndex >= 0 && selectedIndex < activeList.length - 1
                    ? () => setSelectedId(activeList[selectedIndex + 1].tripId)
                    : undefined
                }
                onPrevious={selectedIndex > 0 ? () => setSelectedId(activeList[selectedIndex - 1].tripId) : undefined}
                position={selectedIndex >= 0 ? { index: selectedIndex + 1, total: activeList.length } : null}
                record={selected}
                valuesOnly={isImportedHistoryTrip(selected.date)}
              />
            )}
          </div>
        </div>
      )}

      {/* The slim decision row at the foot of a PHONE only (`lg:hidden` inside). On a desktop the
          same decision sits in the left column under the trip list (owner, 2026-11-07: "put it in
          the left side, make the full right side for reviewing"). */}
      <DecisionBar placement="bar" {...decisionBarProps} />
    </div>
  );
}
