"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  expenseApprovalState,
  expenseDecisionChanged,
  planBulkApproval,
} from "@/lib/outstation/approval-state";
import { outstationRequestIdFromTripId } from "@/lib/outstation/expense-approval-decisions";
import {
  type ExpenseApprovalFilters,
  NO_EXPENSE_APPROVAL_FILTERS,
  buildExpenseApprovalFilterOptions,
  countActiveExpenseApprovalFilters,
  matchesExpenseApprovalFilters,
  matchesExpenseApprovalSearchText,
} from "@/lib/outstation/expense-approval-filters";
import { buildExpenseApprovalEmployeeSummary, totalExpenseApprovalSummary } from "@/lib/outstation/expense-approval-summary";
import { type ExpenseApprovalSort, compareExpenseApprovalTrips, withLiveWorkloadStatus } from "@/lib/outstation/expense-approval-triage";
import { flagDuplicateTripRows } from "@/lib/outstation/duplicate-trip-guard";
import { isImportedHistoryTrip } from "@/lib/outstation/imported-history";

import {
  type Decision,
  type LoadedRecord,
  type ReviewTab,
  type SkippedDecision,
  type TripIdleDays,
  type TripTab,
  TRIP_TABS,
  bulkCandidate,
  bulkRejectionComment,
  computeReviewStats,
  countReviewTabs,
  countUnsaved,
  exportTriageForTab,
  nextAwaitingTrip,
  openingTab,
  parseExpenseDecisionDraft,
  restorableDraft,
  savedDecision,
  tabRows,
} from "./review-model";

/**
 * Expense review — the one hook that holds everything that moves money.
 *
 * Rebuilt from scratch on 2026-11-07 with the screen around it (owner: "RETIRE THE CURRENT EXPENSE
 * APPROVAL AND REBUILD FROM SCRATCH SAME PHOENIX CRM IDENTITY"), and what it does is the retired
 * workspace's, carried over rule for rule: the stored and on-screen decisions, the unsaved count,
 * which rows a save posts, the one-POST-per-report save loop, the bulk plan, the owner-scoped draft
 * and the leave guard. The list page and the one-by-one reviewer both read this hook, so a decision
 * taken in either is the same decision, and Save in either commits both.
 *
 * Nothing here is drawn. The rules it applies — which tab a trip sits in, every count, the next trip
 * — live in review-model.ts and are tested there.
 */

/**
 * The browser-wide key from before 2026-10-26. On a shared office PC it restored one reviewer's
 * unsaved decisions into the next reviewer's queue and saved them under their name, so it is removed
 * on sight and never read.
 */
const LEGACY_DECISION_DRAFT_KEY = "phoenix.outstation.expense-approvals.draft.v1";

/**
 * Where an unsaved decision set survives leaving the page.
 *
 * Every decision is held in React state until Save, and a reviewer works a queue of hundreds one trip
 * at a time. On 2026-09-07 a sidebar click cost a full evening's review — the database recorded ONE
 * save and everything decided around it was gone. `localStorage`, not `sessionStorage`: closing the
 * tab and coming back is exactly the case that lost the work. Per viewer is the KEY
 * (`…draft.v2:<HR id>`); with no HR id nothing is stored at all.
 *
 * Never lets a storage failure reach the queue: private mode, a full quota and blocked site data all
 * throw here, and none of them is a reason to stop reviewing expenses.
 */
function readExpenseDecisionDraft(draftKey: string | null): Record<string, Decision> | null {
  try {
    window.localStorage.removeItem(LEGACY_DECISION_DRAFT_KEY);
    if (!draftKey) return null;
    return parseExpenseDecisionDraft(window.localStorage.getItem(draftKey), Date.now());
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
    window.localStorage.setItem(draftKey, JSON.stringify({ decisions, savedAt: Date.now() }));
  } catch {
    // A draft that cannot be written is never a save failure.
  }
}

/** The one-by-one reviewer's state: the trips it walks (frozen when it opens), and the one on screen. */
export type DeckState = { ids: string[]; open: string | null; tab: TripTab | "employee" };

export function useExpenseReview({ canDecide, viewerHrId }: { canDecide: boolean; viewerHrId: string | null }) {
  const draftKey = ownerScopedStorageKey(EXPENSE_DECISION_DRAFT_KEY_BASE, viewerHrId);
  const viewKey = ownerScopedStorageKey(EXPENSE_APPROVAL_VIEW_KEY_BASE, viewerHrId);

  const [loadedRecords, setRecords] = useState<LoadedRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<ExpenseApprovalFilters>(NO_EXPENSE_APPROVAL_FILTERS);
  const [chosenTab, setChosenTab] = useState<ReviewTab | null>(null);
  // Each opened trip's idle days, lifted from its field-work read, so the decision box can offer the
  // allowance share for them (owner, 2026-11-07: "LET ME DECIDE" — offered, never applied).
  const [idleByTrip, setIdleByTrip] = useState<Record<string, TripIdleDays>>({});
  // An opened trip's live day-by-day answer replaces its stored workload stamp for its reasons, its
  // Needs a look / Clean split and their counts — the list never disagrees with the trip it opens.
  const records = useMemo(() => withLiveWorkloadStatus(loadedRecords, idleByTrip), [loadedRecords, idleByTrip]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveSkipped, setSaveSkipped] = useState<SkippedDecision[]>([]);
  /**
   * Decisions that were saved but did NOT reach payroll — the run's Part 2 is already confirmed, or
   * the resync failed (audit finding 47). The server names each one and the screen shows every one,
   * because "Approvals saved." over the top of it reads as the money having moved.
   */
  const [savePayrollWarnings, setSavePayrollWarnings] = useState<string[]>([]);
  const [selectedTripIds, setSelectedTripIds] = useState<Set<string>>(() => new Set());
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [expandedEmployees, setExpandedEmployees] = useState<Set<string>>(() => new Set());
  const [restoredDraftCount, setRestoredDraftCount] = useState(0);
  const [deck, setDeck] = useState<DeckState | null>(null);
  // Guards BOTH draft effects: nothing may be persisted before the stored draft has been read, or the
  // empty initial state would erase the very work being recovered.
  const draftRestoredRef = useRef(false);

  // No setState before the first `await`, so this is safe to call straight from an effect.
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/outstation/expenses", { headers: { accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok) {
        // An expired session needs a sign-in, and Retry would just fail again.
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
    void Promise.resolve().then(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const retry = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void load();
  }, [load]);

  // Bring back whatever was left unsaved last time — once, and only once the queue is on screen,
  // because a draft entry means something only against a record still in it. Shaped around a
  // microtask so no setState runs in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (draftRestoredRef.current || records.length === 0) return;
    draftRestoredRef.current = true;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const draft = readExpenseDecisionDraft(draftKey);
      if (!draft) return;
      const restored = restorableDraft(records, draft);
      const count = Object.keys(restored).length;
      if (count === 0) return;
      // `...current` last: anything decided in the moment before this landed outranks the draft.
      setDecisions((current) => ({ ...restored, ...current }));
      setRestoredDraftCount(count);
    });
    return () => {
      cancelled = true;
    };
  }, [records, draftKey]);

  // Persist on every change, so the draft is never more than one decision behind the screen.
  useEffect(() => {
    if (!draftRestoredRef.current) return;
    writeExpenseDecisionDraft(draftKey, decisions);
  }, [decisions, draftKey]);

  // The order is remembered per reviewer. Anything unreadable leaves "Biggest first".
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

  // Imported history (trips before July 2026) is values only — owner ruling 2026-09-12 — so it
  // always shows what is stored, whatever a restored draft holds for it.
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

  // `expenseDecisionChanged`, through countUnsaved — the SAME predicate save() posts with. The two were
  // written separately once and disagreed about an undone rejection, so the bar counted a decision
  // the payload then left out (approval-state.ts).
  const dirtyCount = useMemo(() => countUnsaved(records, decisions), [records, decisions]);

  // A full unload — reload, tab close, the hard navigation Next.js forces after a deploy — is the one
  // exit the draft cannot narrate, so say so before it happens. Registered ONLY while something is
  // unsaved: a permanent `beforeunload` makes the page ineligible for the back/forward cache.
  useEffect(() => {
    if (dirtyCount === 0) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Browsers show their own wording; the assignment is what arms the dialog.
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  // Month and employee choices come from the loaded queue, so every option has a trip behind it.
  const filterOptions = useMemo(() => buildExpenseApprovalFilterOptions(records), [records]);
  // Same employee, same day, same destination, both live: a trip claimed twice. Read over the WHOLE
  // queue so a pending copy of an already-approved trip is flagged. A review signal only.
  const duplicateFlags = useMemo(() => flagDuplicateTripRows(records), [records]);
  const activeFilterCount = countActiveExpenseApprovalFilters(filters);
  const narrowed = activeFilterCount > 0 || search.trim().length > 0;

  /** Every trip the month, the employee and the search leave — the base of every tab and count. */
  const visible = useMemo(
    () => records.filter((record) => matchesExpenseApprovalFilters(record, filters) && matchesExpenseApprovalSearchText(record, search)),
    [records, filters, search],
  );

  const tabCounts = useMemo(() => countReviewTabs(visible), [visible]);
  const tab: ReviewTab = chosenTab ?? openingTab(tabCounts);
  const listTab: TripTab = tab === "employees" ? "all" : tab;
  const rows = useMemo(() => tabRows(visible, listTab, filters.sort), [visible, listTab, filters.sort]);

  const chooseTab = useCallback((next: ReviewTab) => {
    setChosenTab(next);
    setBulkMessage(null);
  }, []);

  // The four live groups — the stat tiles, the bulk bar and the employee roll-up count what is on
  // screen right now, including decisions not yet saved.
  const { pending, approved, rejected, undecidedHistory } = useMemo(() => {
    const byValue = compareExpenseApprovalTrips(filters.sort);
    const inState = (state: ReturnType<typeof expenseApprovalState>) =>
      visible.filter((record) => expenseApprovalState(decisionFor(record)) === state).sort(byValue);
    const undecided = inState("pending");
    return {
      approved: inState("approved"),
      // Imported history never awaits a decision, so it cannot be selected, bulk-approved or counted.
      pending: undecided.filter((record) => !isImportedHistoryTrip(record.date)),
      rejected: inState("rejected"),
      // ...but its values are still shown in the per-employee roll-up.
      undecidedHistory: undecided.filter((record) => isImportedHistoryTrip(record.date)),
    };
  }, [visible, filters.sort, decisionFor]);

  const stats = useMemo(() => computeReviewStats(visible, decisionFor), [visible, decisionFor]);
  // The "of" in "95 of 129": the same six tiles over the WHOLE queue, filters and search ignored.
  const overallStats = useMemo(() => computeReviewStats(records, decisionFor), [records, decisionFor]);

  // Built from the CURRENT decisions, so a trip approved a moment ago counts here as it does above.
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
  const summaryTotals = useMemo(() => totalExpenseApprovalSummary(employeeSummaries), [employeeSummaries]);

  // What the XLSX export will contain: the SAME month, employee and search as the list, the tab's
  // Needs a look / Clean choice, and every decision state at once (a status column tells them apart).
  // The route re-derives the rows with the identical shared filters, so the two never disagree.
  const exportCount = visible.length;
  const exportHref = useMemo(() => {
    const params = new URLSearchParams();
    const triage = exportTriageForTab(tab);
    if (filters.month) params.set("month", filters.month);
    if (filters.employee) params.set("employee", filters.employee);
    if (triage) params.set("triage", triage);
    if (search.trim()) params.set("search", search.trim());
    const query = params.toString();
    return query ? `/api/admin/outstation/expenses/export?${query}` : "/api/admin/outstation/expenses/export";
  }, [filters.month, filters.employee, tab, search]);

  const setMonth = useCallback((month: string) => setFilters((current) => ({ ...current, month })), []);
  const setEmployee = useCallback((employee: string) => setFilters((current) => ({ ...current, employee })), []);
  const clearFilters = useCallback(() => {
    setSearch("");
    // The order is a preference, not a narrowing: Clear keeps it.
    setFilters((current) => ({ ...NO_EXPENSE_APPROVAL_FILTERS, sort: current.sort }));
  }, []);

  const recordIdleDays = useCallback((tripId: string, idle: TripIdleDays) => {
    setIdleByTrip((current) =>
      current[tripId]?.idleDays === idle.idleDays && current[tripId]?.tripDays === idle.tripDays ? current : { ...current, [tripId]: idle },
    );
  }, []);

  // ── Selection and the bulk approval ──────────────────────────────────────────────────────────

  // Scoped to the tab on screen: a trip the filters or the tab hide can never be approved by a tick
  // the reviewer can no longer see. Only a trip still waiting can be ticked at all.
  const selectable = useMemo(
    () => rows.filter((record) => !isImportedHistoryTrip(record.date) && expenseApprovalState(decisionFor(record)) === "pending"),
    [rows, decisionFor],
  );
  const selectedVisible = useMemo(() => selectable.filter((record) => selectedTripIds.has(record.tripId)), [selectable, selectedTripIds]);
  const selectedValue = useMemo(
    () => selectedVisible.reduce((running, record) => running + decisionFor(record).approvedAmount, 0),
    [selectedVisible, decisionFor],
  );
  const bulkPlan = useMemo(
    () =>
      // The allowance and the live field-work reading ride along, so a trip with idle days is held
      // back to be opened: a batch cannot show the pre-cut, and never pays an idle day in full.
      planBulkApproval(selectedVisible.map((record) => bulkCandidate(record, decisionFor(record)))),
    [selectedVisible, decisionFor],
  );
  const allSelectableSelected = selectable.length > 0 && selectable.every((record) => selectedTripIds.has(record.tripId));

  const toggleTrip = useCallback((tripId: string) => {
    setBulkMessage(null);
    setSelectedTripIds((current) => {
      const next = new Set(current);
      if (next.has(tripId)) next.delete(tripId);
      else next.add(tripId);
      return next;
    });
  }, []);

  const toggleAllSelectable = useCallback(() => {
    setBulkMessage(null);
    setSelectedTripIds((current) => {
      const next = new Set(current);
      const everySelected = selectable.length > 0 && selectable.every((record) => next.has(record.tripId));
      for (const record of selectable) {
        if (everySelected) next.delete(record.tripId);
        else next.add(record.tripId);
      }
      return next;
    });
  }, [selectable]);

  const clearSelection = useCallback(() => {
    setSelectedTripIds(new Set());
    setBulkMessage(null);
  }, []);

  // Bulk approve writes the same local decision the single-trip button writes — it does NOT save.
  // The reviewer still presses Save, so a mis-click stays reversible right up to that point.
  const approveSelected = useCallback(() => {
    const approvable = new Set(bulkPlan.approvableTripIds);
    const skipped: string[] = [];
    if (bulkPlan.needsReasonTripIds.length > 0) {
      skipped.push(`${formatNumberValue(bulkPlan.needsReasonTripIds.length)} still need a reason for a changed amount`);
    }
    if (bulkPlan.needsPreCutTripIds.length > 0) {
      skipped.push(`${formatNumberValue(bulkPlan.needsPreCutTripIds.length)} have idle days · open each to apply its pre-cut`);
    }
    if (bulkPlan.notPendingTripIds.length > 0) {
      skipped.push(`${formatNumberValue(bulkPlan.notPendingTripIds.length)} were already decided`);
    }
    if (approvable.size === 0) {
      setBulkMessage(skipped.length > 0 ? `Nothing approved — ${skipped.join(" · ")}.` : "Nothing selected to approve.");
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
    // Only the approved ones leave the selection; whatever was blocked stays ticked and visible.
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
  }, [bulkPlan, records]);

  // Bulk reject (owner, 2026-11-12) — the twin of bulk approve: the same local decision the single
  // Reject writes, and it does NOT save either. Every ticked trip still waiting is rejected with the one
  // reason; one already decided is skipped and named. A trip with a changed amount or idle days is
  // rejectable here, unlike approve, because a rejection pays nothing.
  const rejectSelected = useCallback(
    (reason: string) => {
      const text = reason.trim();
      if (!text) {
        setBulkMessage("Nothing rejected — write the reason first; the employees read it.");
        return;
      }
      const notPending = new Set(bulkPlan.notPendingTripIds);
      const rejectable = new Set(selectedVisible.map((record) => record.tripId).filter((tripId) => !notPending.has(tripId)));
      if (rejectable.size === 0) {
        setBulkMessage(notPending.size > 0 ? `Nothing rejected — ${formatNumberValue(notPending.size)} were already decided.` : "Nothing selected to reject.");
        return;
      }
      setSaveMessage(null);
      setDecisions((current) => {
        const next = { ...current };
        for (const record of records) {
          if (!rejectable.has(record.tripId)) continue;
          const base = next[record.tripId] ?? savedDecision(record);
          next[record.tripId] = { ...base, hrApproved: false, hrComment: bulkRejectionComment(base.hrComment, text), status: REJECTED_STATUS };
        }
        return next;
      });
      setSelectedTripIds((current) => {
        const next = new Set(current);
        for (const tripId of rejectable) next.delete(tripId);
        return next;
      });
      setBulkMessage(
        `${formatNumberValue(rejectable.size)} trip${rejectable.size === 1 ? "" : "s"} rejected — press Save to commit.${
          notPending.size > 0 ? ` Skipped: ${formatNumberValue(notPending.size)} were already decided.` : ""
        }`,
      );
    },
    [bulkPlan, records, selectedVisible],
  );

  // ── One trip's decision ──────────────────────────────────────────────────────────────────────

  const recordById = useMemo(() => new Map(records.map((record) => [record.tripId, record])), [records]);

  /** The trips the reviewer is walking: frozen when it opens, so a decided trip keeps its place. */
  const deckRows = useMemo(
    () => (deck ? deck.ids.flatMap((id) => (recordById.has(id) ? [recordById.get(id) as LoadedRecord] : [])) : []),
    [deck, recordById],
  );
  const selected = deck?.open ? (recordById.get(deck.open) ?? null) : null;

  // The next trip awaiting a decision in the walk — the row under the one just decided, in the
  // reviewer's own order. Null at the end of the walk, which then says it is done.
  const selectNextPending = useCallback(
    (fromTripId: string) => {
      const next = nextAwaitingTrip(deckRows, fromTripId, decisionFor);
      setDeck((current) => (current ? { ...current, open: next } : current));
    },
    [deckRows, decisionFor],
  );

  // Approve also clears a stale "Rejected", so a row can never be approved AND rejected at once.
  // Decisions are held on screen until Save; Save and the two Undos never move to another trip.
  const decisionHandlers = {
    onApprove: () => {
      if (!selected) return;
      setDecision(selected, { hrApproved: true, status: APPROVED_STATUS });
      selectNextPending(selected.tripId);
    },
    onReject: () => {
      if (!selected) return;
      setDecision(selected, { hrApproved: false, status: REJECTED_STATUS });
      selectNextPending(selected.tripId);
    },
    onChangeAmount: (value: number) => selected && setDecision(selected, { approvedAmount: value }),
    onChangeReason: (value: string) => selected && setDecision(selected, { hrComment: value }),
    onSave: () => void save(),
    onUnapprove: () => selected && setDecision(selected, { hrApproved: false, status: "" }),
    onUnreject: () => selected && setDecision(selected, { hrApproved: false, status: "" }),
  };

  /**
   * Approve or reject straight from a row of the list, without opening the reviewer. Approve on a row
   * is offered only where nothing needs writing (planBulkApproval's own rule: an unchanged amount);
   * Reject on a row always opens the reviewer, because a rejection the employee cannot be given a
   * reason for is not defensible.
   */
  const quickApprove = useCallback(
    (record: LoadedRecord) => {
      if (isImportedHistoryTrip(record.date)) return;
      setBulkMessage(null);
      setDecision(record, { hrApproved: true, status: APPROVED_STATUS });
    },
    [setDecision],
  );

  // Reverse a decision from a list row or the employee roll-up: clears BOTH the approval flag and the
  // rejected status, so a reversed trip lands back in waiting rather than a half-state.
  const undoDecision = useCallback(
    (tripId: string) => {
      const record = recordById.get(tripId);
      if (!record) return;
      setBulkMessage(null);
      setDecision(record, { hrApproved: false, status: "" });
    },
    [recordById, setDecision],
  );

  const toggleEmployee = useCallback((employeeKey: string) => {
    setExpandedEmployees((current) => {
      const next = new Set(current);
      if (next.has(employeeKey)) next.delete(employeeKey);
      else next.add(employeeKey);
      return next;
    });
  }, []);

  // ── The one-by-one reviewer ──────────────────────────────────────────────────────────────────

  /** Opens the reviewer on the list as it stands (or on given trips), at one trip or the first. */
  const openDeck = useCallback(
    (options: { ids?: string[]; tab?: TripTab | "employee"; tripId?: string | null } = {}) => {
      const ids = options.ids ?? rows.map((record) => record.tripId);
      const first =
        options.tripId && ids.includes(options.tripId)
          ? options.tripId
          : (ids.find((id) => {
              const record = recordById.get(id);
              return record ? !isImportedHistoryTrip(record.date) && expenseApprovalState(decisionFor(record)) === "pending" : false;
            }) ?? ids[0] ?? null);
      setDeck({ ids, open: first, tab: options.tab ?? listTab });
    },
    [rows, recordById, decisionFor, listTab],
  );

  /** A tab chosen inside the reviewer is the page's tab too, and the walk starts again over it. */
  const chooseDeckTab = useCallback(
    (next: TripTab) => {
      setChosenTab(next);
      const ids = tabRows(visible, next, filters.sort).map((record) => record.tripId);
      const first =
        ids.find((id) => {
          const record = recordById.get(id);
          return record ? !isImportedHistoryTrip(record.date) && expenseApprovalState(decisionFor(record)) === "pending" : false;
        }) ?? ids[0] ?? null;
      setDeck({ ids, open: first, tab: next });
    },
    [visible, filters.sort, recordById, decisionFor],
  );

  const moveDeck = useCallback(
    (step: -1 | 1) => {
      setDeck((current) => {
        if (!current || current.ids.length === 0) return current;
        const index = current.open ? current.ids.indexOf(current.open) : current.ids.length;
        const target = index + step;
        if (target < 0) return current;
        // Past the last trip is the "done" panel (open: null); Back from it returns to the last one.
        return { ...current, open: target >= current.ids.length ? null : current.ids[target] };
      });
    },
    [],
  );

  const openTripInDeck = useCallback((tripId: string) => setDeck((current) => (current ? { ...current, open: tripId } : current)), []);
  const closeDeck = useCallback(() => setDeck(null), []);

  /** Names the trip the way the page does — the reviewer knows the person, not "OUTSTATION-48". */
  const employeeForTrip = useCallback((tripId: string) => recordById.get(tripId)?.specialist || tripId, [recordById]);

  async function save() {
    setSaving(true);
    setSaveMessage(null);
    setSaveSkipped([]);
    setSavePayrollWarnings([]);
    const notWritten: SkippedDecision[] = [];
    // What the payroll resync could NOT apply — a run whose Part 2 is already confirmed, or a resync
    // that failed (audit finding 47).
    const payrollNotApplied: string[] = [];
    try {
      const changedReportIds = new Set<string | null>();
      for (const record of records) {
        const local = decisions[record.tripId];
        if (!local || isImportedHistoryTrip(record.date)) continue;
        // The SAME predicate the unsaved count uses. When this was a narrower copy, a report whose
        // only change was an undone rejection was never posted and the reviewer was told "saved".
        if (expenseDecisionChanged(local, savedDecision(record))) {
          changedReportIds.add(record.reportId ?? null);
        }
      }

      const isPostedOnSave = (record: LoadedRecord) => {
        if (outstationRequestIdFromTripId(record.tripId) === null) return true;
        const local = decisions[record.tripId];
        return Boolean(local) && !isImportedHistoryTrip(record.date) && expenseDecisionChanged(local, savedDecision(record));
      };

      // One report at a time. An imported-sheet row travels with its WHOLE report, because that save
      // recomputes the report's totals from the set it is given; an app-submitted claim
      // (OUTSTATION-<id>) goes only when decided here (owner, 2026-11-06: "the Save button very long
      // to save" — the workflow reads every row it is sent twice before it can skip it).
      for (const reportId of changedReportIds) {
        const reportRecords = records.filter((record) => (record.reportId ?? null) === reportId);
        // Only an imported row may name the batch: an app request's "Outstation Requests" label would
        // otherwise be stamped onto every genuinely imported row saved alongside it.
        const fileName =
          reportRecords.find((record) => record.sourceFileName && outstationRequestIdFromTripId(record.tripId) === null)?.sourceFileName ||
          "outstation-expenses";
        const body = {
          fileName,
          records: reportRecords.filter(isPostedOnSave).map((record) => {
            const decision = decisionFor(record);
            return {
              ...record,
              approvedAmount: decision.approvedAmount,
              hrApproved: decision.hrApproved,
              hrComment: decision.hrComment,
              // Rejection is carried by `status`; without it the server re-writes the ORIGINAL status
              // and the rejection never persists.
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
      // The restored-draft notice speaks for work still only on screen; once written it has to go.
      setRestoredDraftCount(0);
      await load();
      // A partial save must say so: the outstation workflow can refuse a row the queue showed (a trip
      // already in a paid payroll batch, a decided request sent back to pending).
      setSaveSkipped(notWritten);
      // Saved, but never reached payroll — silence would read as the money having moved (finding 47).
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

  return {
    // the queue
    activeFilterCount,
    canDecide,
    decisionFor,
    decisions,
    duplicateFlags,
    filterOptions,
    filters,
    loadError,
    loading,
    narrowed,
    records,
    retry,
    rows,
    search,
    sessionExpired,
    tab,
    tabCounts,
    visible,
    // narrowing
    chooseSort,
    chooseTab,
    clearFilters,
    setEmployee,
    setMonth,
    setSearch,
    // figures
    overallStats,
    stats,
    employeeSummaries,
    summaryTotals,
    expandedEmployees,
    toggleEmployee,
    exportCount,
    exportHref,
    // selection
    allSelectableSelected,
    approveSelected,
    bulkMessage,
    bulkPlan,
    clearSelection,
    rejectSelected,
    selectable,
    selectedTripIds,
    selectedValue,
    selectedVisible,
    toggleAllSelectable,
    toggleTrip,
    // decisions
    decisionHandlers,
    dirtyCount,
    idleByTrip,
    quickApprove,
    recordIdleDays,
    restoredDraftCount,
    save,
    saveMessage,
    savePayrollWarnings,
    saveSkipped,
    saving,
    undoDecision,
    // the reviewer
    chooseDeckTab,
    closeDeck,
    deck,
    deckRows,
    moveDeck,
    openDeck,
    openTripInDeck,
    selected,
  };
}

export type ExpenseReview = ReturnType<typeof useExpenseReview>;

/** Every tab that holds trips, for the reviewer's own tablist. */
export const DECK_TABS = TRIP_TABS;
