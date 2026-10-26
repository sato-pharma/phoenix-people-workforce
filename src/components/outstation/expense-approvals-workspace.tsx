"use client";

import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Filter,
  Inbox,
  Loader2,
  MapPin,
  PencilLine,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Search,
  Sparkles,
  Undo2,
  Users,
  Wallet,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Fact, PanelSection } from "@/components/outstation/approval-detail-primitives";
import { TripAttachments } from "@/components/outstation/trip-attachments";
import { ExpenseClaimValidationPanel } from "@/components/outstation/expense-claim-validation-panel";
import { TripWorkloadEvidencePanel } from "@/components/outstation/trip-workload-evidence";
import { EXPENSE_DECISION_DRAFT_KEY_BASE, ownerScopedStorageKey } from "@/lib/browser-storage/owner-scoped";
import { formatCurrencyValue, formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import {
  APPROVED_STATUS,
  REJECTED_STATUS,
  expenseApprovalQueueRank,
  expenseApprovalState,
  expenseDecisionChanged,
  isAdjustedAmount,
  isRejectedStatus,
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
} from "@/lib/outstation/expense-approval-filters";
import type { ExpenseApprovalFilters } from "@/lib/outstation/expense-approval-filters";
import { ExpenseExportButton } from "@/components/outstation/expense-shared/expense-export-button";
import {
  OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM,
  TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM,
  classifyOutstationExpenseEligibility,
} from "@/lib/outstation/classification";
import {
  buildExpenseApprovalEmployeeSummary,
  totalExpenseApprovalSummary,
} from "@/lib/outstation/expense-approval-summary";
import type { ExpenseApprovalEmployeeSummary } from "@/lib/outstation/expense-approval-summary";
import {
  approvedAmountFromDeduction,
  deductionFromApprovedAmount,
} from "@/lib/outstation/payable";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { ExpenseTripRecord } from "@/lib/payroll/types";
import { cn } from "@/lib/utils";
import {
  phxButtonApproveDenseClassName,
  phxButtonDangerDenseClassName,
  phxFieldClassName,
} from "@/components/ui/form-tokens";

type LoadedRecord = ExpenseTripRecord & {
  approvedAmount?: number | null;
  hrApproved?: boolean;
  hrComment?: string;
  reportId?: string | null;
  sourceFileName?: string;
};

type Decision = { approvedAmount: number; hrApproved: boolean; hrComment: string; status: string };

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

function egp(value: number) {
  return formatCurrencyValue(Number.isFinite(value) ? value : 0);
}

// The admin shell zeroes every border-radius (globals.css RULE 1 — the deliberately "shredded"
// look), so these are written square at source: what you read here is what renders.
const FIELD_CLASS = cn(phxFieldClassName, "w-full px-3");
// `pr-9` keeps the selected value clear of SearchableSelect's own search icon.
const FILTER_CONTROL_CLASS = `${FIELD_CLASS} pr-9`;
const MICRO_LABEL_CLASS = "mb-1.5 block text-phx-xs font-black uppercase tracking-wide text-slate-500";
const PANEL_CLASS = "border border-slate-200 bg-white shadow-sm";
const KBD_CLASS = "border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-phx-2xs font-bold text-slate-600";

/**
 * How a trip's distance reads against the outstation distance floor.
 *
 * Driven by the shared classifier rather than a literal `< 58`, so the highlight always tracks the
 * SAME rule the rest of the module enforces (60 km official, 58 km tolerance) — move the policy
 * constants and this moves with them instead of quietly disagreeing.
 *
 * It reads the built-in policy defaults, not a per-rule row from `outstation_policy`, because this
 * page never loads the policy table. If a custom rule ever moves the floor, that policy has to be
 * threaded in here or the highlight would flag against the wrong number.
 */
function distanceFlag(km: number): { label: string; tone: "fail" | "none" | "warn" } {
  if (!Number.isFinite(km) || km <= 0) return { label: "", tone: "none" };

  const { classification } = classifyOutstationExpenseEligibility({
    actualDistanceKm: km,
    policy: {
      officialMinimumDistanceKm: OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM,
      toleranceMinimumDistanceKm: TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM,
    },
  });

  if (classification === "not_eligible") {
    return {
      label: `Under the ${TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM} km outstation floor`,
      tone: "fail",
    };
  }
  if (classification === "tolerance_eligible") {
    return {
      label: `Within tolerance but under the official ${OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM} km`,
      tone: "warn",
    };
  }
  return { label: "", tone: "none" };
}

const DISTANCE_TONE_CLASS: Record<"fail" | "none" | "warn", string> = {
  fail: "bg-rose-100 font-black text-rose-700 ring-1 ring-inset ring-rose-300",
  none: "text-slate-700",
  warn: "bg-amber-100 font-bold text-amber-800",
};

/** Tone for the nearest-brick match badge — mirrors the "High/Good/Review/Weak" prefixes
 * brickMatchConfidence() actually returns (see @/lib/crm/brick-geo), so a wording change
 * there degrades to the neutral tone instead of silently going stale here. */
function capturedLocationConfidenceTone(confidence: string): "success" | "warning" | "danger" | "neutral" {
  if (confidence.startsWith("High") || confidence.startsWith("Good")) return "success";
  if (confidence.startsWith("Review")) return "warning";
  if (confidence.startsWith("Weak")) return "danger";
  return "neutral";
}

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
  const [records, setRecords] = useState<LoadedRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<ExpenseApprovalFilters>({ employee: "", month: "" });
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
    if (search.trim()) params.set("search", search.trim());
    const query = params.toString();
    return query ? `/api/admin/outstation/expenses/export?${query}` : "/api/admin/outstation/expenses/export";
  }, [filters, search]);

  const { pending, approved, rejected, undecidedHistory } = useMemo(() => {
    const matches = (record: LoadedRecord) => matchesExpenseApprovalSearchText(record, search);
    const visible = records.filter(
      (record) => matchesExpenseApprovalFilters(record, filters) && matches(record),
    );
    const byValue = (a: LoadedRecord, b: LoadedRecord) => b.total - a.total;
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
      .sort((left, right) => rank(left) - rank(right) || right.total - left.total);
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
          records: reportRecords.map((record) => {
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

  return (
    <div className="space-y-5">
      <AdminPageHero
        actions={
          <ExpenseExportButton disabled={loading || exportCount === 0} href={exportHref} />
        }
        badges={
          <>
            <AdminInsightChip tone="orange">
              {formatNumberValue(pending.length)} awaiting decision
            </AdminInsightChip>
            <AdminInsightChip tone="neutral">{egp(totals.pendingValue)} at stake</AdminInsightChip>
            {dirtyCount > 0 ? (
              <AdminInsightChip tone="emerald">{formatNumberValue(dirtyCount)} unsaved</AdminInsightChip>
            ) : null}
            {/* The export reflects the SAVED database state — an unsaved decision would make the
                exported file disagree with payroll, so this count is a reminder to Save first. */}
            <AdminInsightChip tone="slate">
              {formatNumberValue(exportCount)} export{narrowed ? " (filtered)" : ""}
            </AdminInsightChip>
          </>
        }
        description="Review each trip against its real CRM field activity, adjust the payable amount if needed, and approve."
        eyebrow="Outstation expenses"
        icon={<Wallet className="h-3.5 w-3.5" />}
        title="Expense Approvals"
      />

      {/* What the queue is worth, not just how long it is — and it tracks the filters, so these
          always describe the trips currently on screen rather than the whole table. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          description={`${egp(totals.pendingValue)} still to decide`}
          icon={<Inbox className="h-4 w-4" />}
          label="Awaiting decision"
          size="compact"
          tone="orange"
          value={formatNumberValue(pending.length)}
        />
        <AdminStatCard
          description={`${egp(totals.approvedValue)} cleared to pay`}
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Approved"
          size="compact"
          tone="emerald"
          value={formatNumberValue(approved.length)}
        />
        <AdminStatCard
          description={
            totals.adjustedCount > 0 ? `${egp(totals.adjustedDelta)} below the claim` : "No amounts changed"
          }
          icon={<PencilLine className="h-4 w-4" />}
          label="Amount adjusted"
          size="compact"
          tone="blue"
          value={formatNumberValue(totals.adjustedCount)}
        />
        <AdminStatCard
          description="Returned with a written reason"
          icon={<XCircle className="h-4 w-4" />}
          label="Rejected"
          size="compact"
          tone="rose"
          value={formatNumberValue(rejected.length)}
        />
      </div>

      {/* Says plainly that work was recovered, and that it is still NOT saved — the whole failure
          this replaces is a reviewer believing decisions were committed when they were not. Tied to
          `dirtyCount` so it disappears the moment nothing is outstanding, whether that came from a
          Save or from undoing the restored decisions by hand. */}
      {restoredDraftCount > 0 && dirtyCount > 0 ? (
        <AdminCallout tone="warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Brought back {formatNumberValue(restoredDraftCount)} decision
            {restoredDraftCount === 1 ? "" : "s"} you had not saved. They are on screen again and
            still unsaved — press Save to commit them.
          </span>
        </AdminCallout>
      ) : null}

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

      {/* Two ways to read the same filtered data: trip-by-trip to decide, or person-by-person to
          see where everyone stands. Both obey the filter panel below. */}
      <div className="-mx-1 overflow-x-auto px-1">
        <div className="inline-flex min-w-max border border-slate-300 bg-white p-1 shadow-sm" role="tablist">
          {([
            { key: "queue", label: "Review queue", icon: ClipboardList, hint: "Decide trip by trip" },
            { key: "employees", label: "By employee", icon: Users, hint: "Who stands where" },
          ] as const).map(({ key, label, icon: Icon, hint }) => (
            <button
              aria-selected={view === key}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2.5 text-sm font-black transition-colors",
                view === key
                  ? "bg-orange-500 text-white shadow-[0_4px_12px_rgba(249,115,22,0.28)]"
                  : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
              )}
              key={key}
              onClick={() => setView(key)}
              role="tab"
              type="button"
            >
              <Icon className="h-4 w-4" />
              {label}
              <span
                className={cn(
                  "hidden text-phx-xs font-semibold sm:inline",
                  view === key ? "text-orange-100" : "text-slate-400",
                )}
              >
                {hint}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* One panel narrows the whole queue — free text, trip month, employee. It sits above the
          grid rather than inside the list column so a long employee name has room to render in
          full, and because the stat cards above are computed from this same filtered set: a count
          is therefore never larger than the list underneath it. */}
      <div className={cn(PANEL_CLASS, "p-4")}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Filter className="h-4 w-4 text-orange-500" />
            <span className="text-sm font-black tracking-tight text-slate-900">Filters</span>
            {activeFilterCount > 0 ? (
              <span className="bg-orange-100 px-2 py-0.5 text-phx-xs font-black text-orange-700">
                {formatNumberValue(activeFilterCount)} active
              </span>
            ) : null}
            <span className="text-xs font-bold text-slate-400">
              Showing {formatNumberValue(activeList.length)} of {formatNumberValue(records.length)} trips
            </span>
          </div>
          {narrowed ? (
            <button
              className="inline-flex shrink-0 items-center gap-1.5 border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-100"
              onClick={() => {
                setSearch("");
                setFilters({ employee: "", month: "" });
              }}
              type="button"
            >
              <X className="h-3 w-3" /> Clear all
            </button>
          ) : null}
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_200px_280px]">
          <label className="block min-w-0">
            <span className={MICRO_LABEL_CLASS}>Search</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className={cn(FIELD_CLASS, "pl-9")}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Employee, HR ID, trip, destination…"
                ref={searchRef}
                value={search}
              />
            </span>
          </label>
          <label className="block min-w-0">
            <span className={MICRO_LABEL_CLASS}>Trip month</span>
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
          <label className="block min-w-0">
            <span className={MICRO_LABEL_CLASS}>Employee</span>
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
        </div>

        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-phx-xs font-semibold text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <kbd className={KBD_CLASS}>/</kbd> search
          </span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className={KBD_CLASS}>↑</kbd>
            <kbd className={KBD_CLASS}>↓</kbd> move through the queue
          </span>
        </p>
      </div>

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

      {/* `[&>*]:min-w-0` is load-bearing on mobile: below `lg` this is a SINGLE-column grid, and a
          grid item defaults to `min-width: auto`, so the column is sized by its widest item's
          min-content — not by the viewport. One long unbreakable destination in the decision panel
          therefore stretched the whole column to 729px in a 375px viewport and scrolled the page
          sideways. Letting the items shrink is only safe because each piece of wide content now
          scrolls inside its own box (see the route line below and the workload table). */}
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
      <div className="grid gap-4 lg:grid-cols-[minmax(300px,360px)_1fr] lg:items-start [&>*]:min-w-0">
        {/* Left: scannable list */}
        <div className="space-y-2">
          {loading ? (
            <p className="flex items-center gap-2 border border-phx-line bg-white px-4 py-8 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading trips…
            </p>
          ) : loadError ? (
            // An expired session gets a sign-in, not a Retry — retrying just fails again, and
            // calling it a permissions problem sends the reviewer hunting through roles.
            sessionExpired ? (
              <div className="flex flex-wrap items-center gap-2 border border-amber-300 bg-amber-50 px-4 py-6 text-sm font-semibold text-amber-800">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Your session has expired.
                <a className="font-bold underline hover:text-amber-950" href="/login">
                  Sign in again
                </a>
              </div>
            ) : (
              <div className="border border-rose-200 bg-rose-50 px-4 py-6 text-sm text-rose-700">
                {loadError}
                <button
                  className="ml-2 font-bold underline"
                  onClick={() => {
                    setLoading(true);
                    setLoadError(null);
                    void load();
                  }}
                  type="button"
                >
                  Retry
                </button>
              </div>
            )
          ) : activeList.length === 0 ? (
            <p className={cn(PANEL_CLASS, "px-4 py-8 text-center text-sm text-slate-500")}>
              {/* An empty list because of a filter is a different fact from an empty queue —
                  saying "nothing waiting for approval" while a month is selected reads as
                  "this month is done" when the work is simply filtered out of view. */}
              {narrowed ? "No trips match these filters." : "No trips in the queue yet."}
            </p>
          ) : (
            <>
              {/* Scoped to the PENDING rows, not to everything on screen. With one list, "select
                  all" over 400 trips would tick hundreds already decided; planBulkApproval refuses
                  those and reports "N were already decided" — a wall of noise standing in for a
                  button that did nothing. */}
              {pending.length > 0 ? (
                <label className="flex cursor-pointer items-center gap-2.5 border border-slate-200 bg-white px-4 py-2.5 text-xs font-black uppercase tracking-wide text-slate-600 transition-colors hover:bg-slate-50">
                  <input
                    checked={allVisibleSelected}
                    className="h-4 w-4 shrink-0 accent-orange-500"
                    onChange={toggleAllVisible}
                    type="checkbox"
                  />
                  Select all {formatNumberValue(pending.length)} awaiting decision
                </label>
              ) : null}
              <div className="max-h-[70vh] space-y-2 overflow-y-auto pr-1">
                {activeList.map((record) => {
                  const decision = decisionFor(record);
                  const adjusted = isAdjustedAmount(decision.approvedAmount, record.total);
                  // Compare against the EFFECTIVE selection, not the raw click state — otherwise the
                  // trip already open in the decision panel on first load is highlighted nowhere.
                  const isSelected = record.tripId === effectiveSelectedId;
                  const isTicked = selectedTripIds.has(record.tripId);
                  const state = expenseApprovalState(decision);
                  return (
                    // A row is a div, not a button: a checkbox nested inside a button is invalid
                    // HTML and the browser swallows one of the two clicks.
                    <div
                      className={cn(
                        "group flex w-full items-stretch border bg-white transition-all",
                        isSelected
                          ? "border-orange-400 bg-orange-50/60 shadow-[0_10px_26px_rgba(249,115,22,0.14)]"
                          : isTicked
                            ? "border-orange-300 bg-orange-50/30"
                            : "border-slate-200 hover:border-orange-300 hover:bg-orange-50/30 hover:shadow-[0_8px_20px_rgba(15,23,42,0.06)]",
                      )}
                      data-trip-id={record.tripId}
                      key={record.tripId}
                    >
                      {/* Decision state, readable in one glance without reading a word. */}
                      <span
                        aria-hidden
                        className={cn(
                          "w-1 shrink-0",
                          state === "approved"
                            ? "bg-emerald-500"
                            : state === "rejected"
                              ? "bg-rose-500"
                              : isSelected
                                ? "bg-orange-500"
                                : "bg-slate-200 group-hover:bg-orange-400",
                        )}
                      />
                      {/* Only an undecided trip carries a tick box — the bulk action can approve
                          nothing else, and offering one on a decided row invites a click that
                          silently does nothing. Reversing a decision brings the box back. */}
                      {state === "pending" && !isImportedHistoryTrip(record.date) ? (
                        <label className="flex shrink-0 cursor-pointer items-center pl-3">
                          <input
                            aria-label={`Select ${record.specialist || "Unassigned"} ${record.tripId}`}
                            checked={isTicked}
                            className="h-4 w-4 accent-orange-500"
                            onChange={() => toggleTrip(record.tripId)}
                            type="checkbox"
                          />
                        </label>
                      ) : null}
                      <button
                        className="flex min-w-0 flex-1 items-center justify-between gap-3 py-3 pl-3 pr-4 text-left"
                        onClick={() => setSelectedId(record.tripId)}
                        type="button"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-slate-900">{record.specialist || "Unassigned"}</p>
                          <p className="truncate text-xs text-slate-500">
                            {record.tripId} · {record.location || record.to || "—"}
                          </p>
                          <p className="mt-0.5 text-phx-xs text-slate-400">{formatDateValue(record.date)}</p>
                          <DuplicateTripFlag copies={duplicateFlags.get(record.tripId)} />
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-mono text-sm font-bold text-slate-900">{egp(decision.approvedAmount)}</p>
                          {adjusted ? (
                            <p className="font-mono text-phx-2xs text-orange-600 line-through">{egp(record.total)}</p>
                          ) : null}
                          {state === "approved" ? (
                            <span className="mt-0.5 inline-flex items-center gap-1 text-phx-2xs font-black uppercase tracking-wide text-emerald-600">
                              <CheckCircle2 className="h-3 w-3" /> Approved
                            </span>
                          ) : state === "rejected" ? (
                            <span className="mt-0.5 inline-flex items-center gap-1 text-phx-2xs font-black uppercase tracking-wide text-rose-600">
                              <XCircle className="h-3 w-3" /> Rejected
                            </span>
                          ) : null}
                          {isImportedHistoryTrip(record.date) ? (
                            <span className="mt-0.5 block text-phx-2xs font-black uppercase tracking-wide text-slate-400">
                              Imported · values only
                            </span>
                          ) : null}
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Right: focused decision panel. Sticky on desktop so it stays put while a 300-row queue
            scrolls past it — the review never loses its subject. */}
        <div className={cn(PANEL_CLASS, "min-h-[300px] lg:sticky lg:top-4")}>
          {!selected ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center text-slate-400">
              <Inbox className="h-8 w-8" />
              <p className="text-sm font-medium">Select a trip to review and approve.</p>
            </div>
          ) : (
            <ExpenseDecisionPanel
              key={selected.tripId}
              duplicateOf={duplicateFlags.get(selected.tripId)}
              decision={decisionFor(selected)}
              onApprove={() => {
                // Also clears a stale "Rejected" status, so a row can never be approved AND
                // rejected at once.
                setDecision(selected, { hrApproved: true, status: APPROVED_STATUS });
                selectNextPending(selected.tripId);
              }}
              onChangeAmount={(value) => setDecision(selected, { approvedAmount: value })}
              onChangeReason={(value) => setDecision(selected, { hrComment: value })}
              onReject={() => {
                setDecision(selected, { hrApproved: false, status: REJECTED_STATUS });
                selectNextPending(selected.tripId);
              }}
              onUnapprove={() => setDecision(selected, { hrApproved: false, status: "" })}
              onUnreject={() => setDecision(selected, { hrApproved: false, status: "" })}
              canDecide={canDecide}
              record={selected}
              valuesOnly={isImportedHistoryTrip(selected.date)}
            />
          )}
        </div>
      </div>
      )}

      {/* Save follows you down the queue. Decisions are held locally until this is pressed, so a
          reviewer who approves twenty trips and scrolls away must never have to hunt for it. */}
      {dirtyCount > 0 ? (
        <div className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 border border-slate-800 bg-slate-900 px-4 py-3 shadow-[0_18px_46px_rgba(15,23,42,0.35)]">
          <p className="text-sm font-bold text-white">
            {formatNumberValue(dirtyCount)} decision{dirtyCount === 1 ? "" : "s"} not saved yet
          </p>
          <Button
            className="bg-orange-500 text-white hover:bg-orange-600"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
            Save {formatNumberValue(dirtyCount)}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Per-employee roll-up. Desktop lays the numbers out in columns; below `sm` the same row stacks
 * into a card, because the admin shell never shows a table on a phone. Pressing a row expands that
 * person's trips in place — the detail is right under the number it explains, instead of sending
 * the reviewer back to the queue with a filter to re-apply.
 */
function EmployeeSummaryPanel({
  summaries,
  totals,
  expanded,
  onToggle,
  onUndo,
  narrowed,
}: {
  expanded: Set<string>;
  narrowed: boolean;
  onToggle: (employeeKey: string) => void;
  onUndo: (tripId: string) => void;
  summaries: ExpenseApprovalEmployeeSummary[];
  totals: ReturnType<typeof totalExpenseApprovalSummary>;
}) {
  if (summaries.length === 0) {
    return (
      <p className={cn(PANEL_CLASS, "px-4 py-8 text-center text-sm text-slate-500")}>
        {narrowed ? "No trips match these filters." : "No outstation trips to summarise yet."}
      </p>
    );
  }

  return (
    <div className={PANEL_CLASS}>
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900 px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-4 w-1 bg-orange-500" />
          <span className="text-phx-xs font-black uppercase tracking-wide text-white">
            {formatNumberValue(totals.employeeCount)} employees
          </span>
        </div>
        {/* Both money figures, never one. `claimed` spans every trip on screen; `approved` spans
            only the approved ones — so a single total here reads as whichever the viewer assumed,
            and the two are not comparable (their difference is not the trim). Each chip is
            whitespace-nowrap so a label never breaks mid-phrase; the row itself may wrap. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-phx-xs font-bold">
          <span className="whitespace-nowrap text-slate-300">{egp(totals.claimedTotal)} claimed</span>
          <span className="whitespace-nowrap text-amber-300">
            {formatNumberValue(totals.pendingCount)} pending
          </span>
          <span className="whitespace-nowrap text-emerald-300">
            {formatNumberValue(totals.approvedCount)} approved · {egp(totals.approvedValue)}
          </span>
          <span className="whitespace-nowrap text-rose-300">
            {formatNumberValue(totals.rejectedCount)} rejected
          </span>
        </div>
      </div>

      {/* Column captions belong to the desktop layout only — on a phone each figure carries its own
          inline label instead, so a stacked card never leaves a bare number unexplained. */}
      <div className="hidden items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400 sm:flex">
        <span className="w-4 shrink-0" />
        <span className="min-w-0 flex-1">Employee</span>
        <span className="w-20 shrink-0 text-right">Pending</span>
        <span className="w-24 shrink-0 text-right">Approved</span>
        <span className="w-28 shrink-0 text-right">Approved EGP</span>
        <span className="w-20 shrink-0 text-right">Rejected</span>
      </div>

      <div className="divide-y divide-slate-200">
        {summaries.map((summary) => {
          const isOpen = expanded.has(summary.employeeKey);
          return (
            <div key={summary.employeeKey}>
              <button
                aria-expanded={isOpen}
                className={cn(
                  "flex w-full flex-col gap-2 px-4 py-3 text-left transition-colors sm:flex-row sm:items-center sm:gap-3",
                  isOpen ? "bg-orange-50/60" : "hover:bg-orange-50/30",
                )}
                onClick={() => onToggle(summary.employeeKey)}
                type="button"
              >
                <span className="flex items-center gap-2 sm:contents">
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-orange-500" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block whitespace-nowrap text-sm font-bold text-slate-900">
                      {summary.employeeLabel}
                    </span>
                    <span className="block text-phx-xs text-slate-400">
                      {formatNumberValue(summary.totalCount)} trips · {egp(summary.claimedTotal)} claimed
                    </span>
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-6 sm:contents sm:pl-0">
                  <span className="w-20 shrink-0 font-mono text-sm font-bold text-amber-600 sm:text-right">
                    <span className="text-phx-2xs font-black uppercase text-slate-400 sm:hidden">Pending </span>
                    {formatNumberValue(summary.pendingCount)}
                  </span>
                  <span className="w-24 shrink-0 font-mono text-sm font-bold text-emerald-600 sm:text-right">
                    <span className="text-phx-2xs font-black uppercase text-slate-400 sm:hidden">Approved </span>
                    {formatNumberValue(summary.approvedCount)}
                  </span>
                  <span className="w-28 shrink-0 font-mono text-sm font-bold text-slate-900 sm:text-right">
                    {egp(summary.approvedValue)}
                  </span>
                  <span className="w-20 shrink-0 font-mono text-sm font-bold text-rose-600 sm:text-right">
                    <span className="text-phx-2xs font-black uppercase text-slate-400 sm:hidden">Rejected </span>
                    {formatNumberValue(summary.rejectedCount)}
                  </span>
                </span>
              </button>

              {isOpen ? (
                <div className="border-t border-slate-200 bg-slate-50/70 px-4 py-3">
                  <p className="mb-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
                    Trips · distance and declared workload, AM · PM · Pharmacies
                  </p>
                  {/* Wide content scrolls inside its own box — a long destination must never move
                      the page (see the route line in the decision panel). */}
                  <div className="-mx-1 overflow-x-auto px-1">
                    <div className="w-max min-w-full space-y-1.5">
                      {summary.trips.map((row) => (
                        <div
                          className="flex items-stretch border border-slate-200 bg-white"
                          key={row.tripId}
                        >
                          <span
                            aria-hidden
                            className={cn(
                              "w-1 shrink-0",
                              row.state === "approved"
                                ? "bg-emerald-500"
                                : row.state === "rejected"
                                  ? "bg-rose-500"
                                  : "bg-amber-400",
                            )}
                          />
                          {/* Stacks into a card below `sm` and lays out as columns above it, so the
                              action button is never stranded off the side of a scrolling row. */}
                          <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-2 sm:flex-row sm:items-center sm:gap-4">
                            <span className="w-24 shrink-0 whitespace-nowrap text-phx-xs text-slate-500">
                              {formatDateValue(row.date)}
                            </span>
                            <span className="w-28 shrink-0 whitespace-nowrap font-mono text-xs text-slate-600">
                              {row.tripId}
                            </span>
                            <span className="min-w-[9rem] flex-1 whitespace-nowrap text-xs text-slate-700">
                              {row.destination || "—"}
                            </span>
                            <span className="w-32 shrink-0 whitespace-nowrap font-mono text-xs sm:text-right">
                              <span className="text-phx-2xs font-black uppercase text-slate-400 sm:hidden">
                                Distance{" "}
                              </span>
                              {row.km ? (
                                (() => {
                                  const flag = distanceFlag(row.km);
                                  return (
                                    <span
                                      className={cn(
                                        "inline-flex items-center gap-1 px-1.5 py-0.5",
                                        DISTANCE_TONE_CLASS[flag.tone],
                                      )}
                                      title={flag.label || undefined}
                                    >
                                      {flag.tone === "fail" ? <AlertTriangle className="h-3 w-3" /> : null}
                                      {formatNumberValue(row.km)} km
                                    </span>
                                  );
                                })()
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </span>
                            {/* Declared on the expense sheet — NOT the CRM evidence figure, which is
                                a per-trip lookup and would be one request per row here. */}
                            <span className="w-32 shrink-0 whitespace-nowrap font-mono text-xs text-slate-700 sm:text-right">
                              <span className="text-phx-2xs font-black uppercase text-slate-400 sm:hidden">
                                Declared{" "}
                              </span>
                              AM {formatNumberValue(row.amWorkload)} · PM {formatNumberValue(row.pmWorkload)}
                              {/* The third figure on its own line, so the fixed-width cell never
                                  widens. Absent on a pre-split trip, whose pharmacies sit in AM/PM. */}
                              {row.pharmacyWorkload === null || row.pharmacyWorkload === undefined ? null : (
                                <span className="block">Pharmacies {formatNumberValue(row.pharmacyWorkload)}</span>
                              )}
                            </span>
                            <span className="w-28 shrink-0 whitespace-nowrap font-mono text-xs font-bold text-slate-900 sm:text-right">
                              {egp(row.approvedAmount)}
                            </span>
                            <span className="w-24 shrink-0 whitespace-nowrap font-mono text-phx-xs text-slate-400 sm:text-right">
                              {isAdjustedAmount(row.approvedAmount, row.claimedTotal)
                                ? `of ${egp(row.claimedTotal)}`
                                : ""}
                            </span>
                            <span
                              className={cn(
                                "w-20 shrink-0 whitespace-nowrap text-phx-2xs font-black uppercase tracking-wide sm:text-right",
                                row.state === "approved"
                                  ? "text-emerald-600"
                                  : row.state === "rejected"
                                    ? "text-rose-600"
                                    : "text-amber-600",
                              )}
                            >
                              {row.state}
                            </span>
                            <span className="w-32 shrink-0 sm:text-right">
                              {row.state === "pending" ? null : (
                                <button
                                  className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1.5 text-phx-xs font-bold text-slate-700 transition-colors hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
                                  onClick={() => onUndo(row.tripId)}
                                  type="button"
                                >
                                  <Undo2 className="h-3 w-3" />
                                  {row.state === "approved" ? "Unapprove" : "Undo rejection"}
                                </button>
                              )}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Rewrites the approver's rough comment into the sentence the employee reads.
 *
 * Owner request 2026-08-08: the note must land "as if the system auto replied" — now that HR sits
 * behind the workflow rather than in front of it, a decision should not read as one named person's
 * verdict. The approver writes what he means, in Arabic or English, however roughly; this puts it
 * into the system's own voice.
 *
 * Deliberately not automatic and not hidden: it replaces the field's text in place, the previous
 * wording stays one click away, and nothing is saved until he presses Save as usual. Per the
 * owner's standing rule, no user-facing surface names a model — this is presented as something
 * Phoenix does.
 */
function SystemNoteRewriteControl({
  disabled,
  facts,
  onChangeReason,
  outcome,
  value,
}: {
  disabled: boolean;
  facts: Array<{ label: string; value: string }>;
  onChangeReason: (value: string) => void;
  outcome: "adjusted" | "approved" | "pending" | "rejected";
  value: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The approver's own wording, kept so a rewrite he dislikes costs one click to undo.
  const [previous, setPrevious] = useState<string | null>(null);

  async function rewrite() {
    const draft = value.trim();
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/outstation/expenses/note-assist", {
        body: JSON.stringify({ draft, facts, outcome }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string; note?: string } | null;
      if (!response.ok || typeof payload?.note !== "string" || !payload.note.trim()) {
        setError(payload?.message || "The note could not be rewritten. Try again.");
        return;
      }
      setPrevious(draft);
      onChangeReason(payload.note.trim());
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          className="inline-flex items-center gap-1.5 whitespace-nowrap border border-slate-300 bg-white px-2.5 py-1 text-phx-xs font-bold text-slate-700 transition hover:border-orange-400 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || busy || !value.trim()}
          onClick={() => void rewrite()}
          title="Rewrite this comment as a formal system note for the employee"
          type="button"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {busy ? "Rewriting" : "Rewrite formally"}
        </button>
        {previous ? (
          <button
            className="inline-flex items-center gap-1.5 whitespace-nowrap border border-slate-200 bg-white px-2.5 py-1 text-phx-xs font-bold text-slate-500 transition hover:text-slate-900"
            onClick={() => {
              onChangeReason(previous);
              setPrevious(null);
            }}
            type="button"
          >
            <Undo2 className="h-3.5 w-3.5" /> Restore my wording
          </button>
        ) : null}
      </div>
      {error ? <p className="mt-1 text-phx-xs font-semibold text-rose-600">{error}</p> : null}
    </>
  );
}

/** "Same trip as OUTSTATION-292" — flat, square, amber; never a decision. */
function DuplicateTripFlag({ copies, wide = false }: { copies?: string[]; wide?: boolean }) {
  if (!copies || copies.length === 0) return null;
  return (
    <p
      className={`mt-1 inline-flex items-start gap-1 border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-bold text-amber-800 ${
        wide ? "text-phx-xs" : "text-phx-2xs"
      }`}
    >
      <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
      <span className="break-words">
        Same trip as {copies.join(", ")}
        {wide ? " — same employee, same day, same destination" : ""}
      </span>
    </p>
  );
}

function ExpenseDecisionPanel({
  record,
  decision,
  duplicateOf,
  canDecide,
  onApprove,
  onReject,
  onUnapprove,
  onUnreject,
  onChangeAmount,
  onChangeReason,
  valuesOnly,
}: {
  canDecide: boolean;
  decision: Decision;
  /** Other live claims for the same employee, day and destination (duplicate-trip-guard.ts). */
  duplicateOf?: string[];
  onApprove: () => void;
  onChangeAmount: (value: number) => void;
  onChangeReason: (value: string) => void;
  onReject: () => void;
  onUnapprove: () => void;
  onUnreject: () => void;
  record: LoadedRecord;
  /** Imported history (trips before July 2026): shown, never decided. See imported-history.ts. */
  valuesOnly: boolean;
}) {
  const adjusted = isAdjustedAmount(decision.approvedAmount, record.total);
  // Only a Phoenix-submitted trip has an outstation request behind it (and therefore a captured
  // GPS point). An imported expense returns null here and the validation panel is skipped.
  const validationRequestId = outstationRequestIdFromTripId(record.tripId);
  // Derived, never stored: `approvedAmount` stays the single value that gets saved, so the new
  // Deduction field cannot introduce a second source of truth for what a trip pays.
  const deduction = deductionFromApprovedAmount(record.total, decision.approvedAmount);
  const reasonMissing = adjusted && !decision.hrComment.trim();
  const isRejected = isRejectedStatus(decision.status);
  // A rejection the employee cannot be given a reason for is not defensible, so it is gated the
  // same way a changed amount is.
  const rejectReasonMissing = !decision.hrComment.trim();

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200">
        <div className="h-[3px] bg-gradient-to-r from-orange-400 via-orange-500 to-amber-200" />
        <div className="flex flex-wrap items-start justify-between gap-3 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 px-5 py-4">
          <div className="min-w-0">
            <p className="text-phx-2xs font-black uppercase tracking-[0.22em] text-orange-400">
              {valuesOnly ? "Imported trip · values only" : "Trip under review"}
            </p>
            <h2 className="mt-1 text-lg font-black tracking-tight text-white">{record.specialist || "Unassigned"}</h2>
            <p className="mt-0.5 font-mono text-xs text-slate-400">{record.tripId}</p>
            <DuplicateTripFlag copies={duplicateOf} wide />
          </div>
          {/* A rejected trip used to read "Pending" here — the badge only knew about approval. */}
          {decision.hrApproved ? (
            <Badge variant="success">Approved</Badge>
          ) : isRejected ? (
            <Badge variant="danger">Rejected</Badge>
          ) : (
            <Badge variant="warning">Pending</Badge>
          )}
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 py-4 sm:grid-cols-4">
          <Fact label="Expense type" value={record.requestType} />
          <Fact label="Trip" value={record.tripType} />
          <Fact label="Start" value={formatDateValue(record.date)} />
          <Fact label="End" value={formatDateValue(record.toDate)} />
          <Fact label="Transport" value={record.transportationType} />
          {/* Same distance floor flagged on the screen where the money is actually approved — a
              warning that only appears in the summary would be a gap exactly where it matters. */}
          <div>
            <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Distance</p>
            {record.km ? (
              (() => {
                const flag = distanceFlag(record.km);
                return (
                  <>
                    <p
                      className={cn(
                        "mt-0.5 inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-sm font-semibold",
                        DISTANCE_TONE_CLASS[flag.tone],
                      )}
                    >
                      {flag.tone === "fail" ? <AlertTriangle className="h-3.5 w-3.5" /> : null}
                      {formatNumberValue(record.km)} km
                    </p>
                    {flag.label ? (
                      <p
                        className={cn(
                          "mt-0.5 whitespace-nowrap text-phx-2xs font-bold",
                          flag.tone === "fail" ? "text-rose-600" : "text-amber-700",
                        )}
                      >
                        {flag.label}
                      </p>
                    ) : null}
                  </>
                );
              })()
            ) : (
              <p className="mt-0.5 whitespace-nowrap text-sm font-semibold text-slate-900">—</p>
            )}
          </div>
          <div className="col-span-2 sm:col-span-2">
            <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Route</p>
            {/* Phoenix-submitted trips carry a full postal address here, not a city — one live row
                is 95 characters. It must not wrap and must not be truncated, so the line scrolls
                horizontally WITHIN this box; the page itself no longer moves. */}
            <div className="mt-0.5 -mx-1 overflow-x-auto px-1">
              <p className="flex w-max items-center gap-1.5 text-sm font-semibold text-slate-900">
                <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="whitespace-nowrap">{record.from || "—"}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="whitespace-nowrap">{record.location || record.to || "—"}</span>
              </p>
            </div>
          </div>
          {/* Brick / area / region derived from the trip's captured GPS point (see
              captured-location.ts) — absent, not "Not resolved", for a historical
              Excel-imported trip that never captured coordinates at all. */}
          {record.capturedLocation ? (
            <div className="col-span-2 border-t border-slate-200 pt-3 sm:col-span-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Captured geography</p>
                {record.capturedLocation.confidence ? (
                  <Badge variant={capturedLocationConfidenceTone(record.capturedLocation.confidence)}>
                    {record.capturedLocation.confidence}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 flex w-max items-center gap-1.5 text-sm font-semibold text-slate-900">
                <MapPin className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                {record.capturedLocation.label}
              </p>
              <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1">
                <Fact label="Brick" value={record.capturedLocation.brickLabel} />
                <Fact label="Area" value={record.capturedLocation.areaLabel} />
                <Fact label="Region" value={record.capturedLocation.regionLabel} />
              </div>
            </div>
          ) : null}
          <div className="col-span-2 border-t border-slate-200 pt-3 sm:col-span-4">
            <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Cost breakdown</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-sm text-slate-700">
              <span>Travel <b className="text-slate-900">{egp(record.travelCost)}</b></span>
              <span>Meeting <b className="text-slate-900">{egp(record.meetingAmount)}</b></span>
              <span>Allowance <b className="text-slate-900">{egp(record.allowance)}</b></span>
              {record.other ? (
                <span>Other <b className="text-slate-900">{egp(record.other)}</b></span>
              ) : null}
              <span className="text-slate-400">=</span>
              <span>Total <b className="text-slate-900">{egp(record.total)}</b></span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        {/* Verified workload */}
        <TripWorkloadEvidencePanel
          declaredAm={record.amWorkload}
          declaredPharmacies={record.pharmacyWorkload ?? null}
          declaredPm={record.pmWorkload}
          hrId={record.hrId ?? null}
          tripEndDate={record.toDate || record.date}
          tripStartDate={record.date}
        />

        {/* Claim validation — only for Phoenix-submitted trips. An imported expense carries no
            captured GPS, so the panel would have nothing to check and would render four
            "could not verify" rows that mean nothing. Rendering nothing is the honest answer. */}
        {validationRequestId !== null ? (
          <ExpenseClaimValidationPanel requestId={validationRequestId} />
        ) : null}

        {/* The arrival and departure photos, then the ticket/receipt pictures or PDFs. This is
            where the Super Admin approves, so both photos must be here in full, not a thumbnail. */}
        <PanelSection title="Photos and attachments">
          <TripAttachments tripId={record.tripId} />
        </PanelSection>

        {/* Amount + reason */}
        <PanelSection title="Payable amount">
          {/* Claimed − Deduction = Approved, written out as the equation it is. HR thinks in
              "cut 200 off this", so Deduction is the field to type in and Approved follows;
              typing Approved directly still works and back-fills the deduction. The pair is
              computed by one function in payable.ts so the two can never disagree. */}
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Claimed</p>
              <p className="mt-1 font-mono text-lg font-bold text-slate-900">{egp(record.total)}</p>
            </div>
            <span aria-hidden className="mb-2 font-mono text-lg font-black text-slate-300">−</span>
            <div>
              <label
                className="text-phx-2xs font-black uppercase tracking-[0.12em] text-orange-600"
                htmlFor={`deduct-${record.tripId}`}
              >
                Deduction
              </label>
              <input
                className={cn(
                  phxFieldClassName, "mt-1 w-32 text-right font-mono",
                  deduction > 0
                    ? "border-orange-400 text-orange-700"
                    : "",
                )}
                disabled={valuesOnly}
                id={`deduct-${record.tripId}`}
                inputMode="decimal"
                max={record.total}
                min={0}
                onChange={(event) =>
                  onChangeAmount(approvedAmountFromDeduction(record.total, Number(event.target.value)))
                }
                type="number"
                value={String(deduction)}
              />
            </div>
            <span aria-hidden className="mb-2 font-mono text-lg font-black text-slate-300">=</span>
            <div>
              <label className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400" htmlFor={`amt-${record.tripId}`}>
                Approved amount
              </label>
              <input
                className={cn(
                  phxFieldClassName, "mt-1 w-36 text-right font-mono",
                  adjusted ? "border-orange-400" : "",
                )}
                disabled={valuesOnly}
                id={`amt-${record.tripId}`}
                inputMode="decimal"
                max={record.total}
                min={0}
                onChange={(event) =>
                  onChangeAmount(
                    approvedAmountFromDeduction(
                      record.total,
                      deductionFromApprovedAmount(record.total, Number(event.target.value)),
                    ),
                  )
                }
                type="number"
                value={String(decision.approvedAmount)}
              />
            </div>
            {adjusted ? (
              <Badge variant="warning">{egp(deduction)} deducted from {egp(record.total)}</Badge>
            ) : null}
          </div>
          <div className="mt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400" htmlFor={`reason-${record.tripId}`}>
                Reason / comment{" "}
                {adjusted ? (
                  <span className="text-rose-500">(required for a changed amount)</span>
                ) : (
                  <span className="text-slate-400">(required to reject)</span>
                )}
              </label>
              {/* Only the figures already on this screen are offered, so the note can cite the
                  deduction without anything being able to invent one. */}
              <SystemNoteRewriteControl
                disabled={!canDecide || valuesOnly}
                facts={[
                  { label: "Claimed total", value: egp(record.total) },
                  { label: "Approved amount", value: egp(decision.approvedAmount) },
                  ...(adjusted ? [{ label: "Deduction", value: egp(deduction) }] : []),
                  { label: "Trip start", value: formatDateValue(record.date) },
                  { label: "Trip end", value: formatDateValue(record.toDate) },
                  ...(record.km ? [{ label: "Distance", value: `${formatNumberValue(record.km)} km` }] : []),
                  { label: "Expense type", value: record.requestType || "—" },
                ]}
                onChangeReason={onChangeReason}
                outcome={
                  decision.hrApproved ? (adjusted ? "adjusted" : "approved") : isRejected ? "rejected" : "pending"
                }
                value={decision.hrComment}
              />
            </div>
            <input
              className={cn(
                phxFieldClassName, "mt-1 w-full",
                reasonMissing ? "border-rose-400" : "",
              )}
              disabled={valuesOnly}
              id={`reason-${record.tripId}`}
              onChange={(event) => onChangeReason(event.target.value)}
              placeholder={
                adjusted ? "Why is the approved amount different?" : "Optional to approve · required to reject"
              }
              value={decision.hrComment}
            />
          </div>
        </PanelSection>

        {/* Decision bar — the page's one destructive/committing surface, so it is given its own
            weight instead of sitting loose under the form.

            Hidden entirely for a read-only viewer (the CEO, 2026-08-08) rather than disabled:
            a row of greyed-out Approve/Reject buttons invites someone to keep clicking and
            wondering what is wrong. This is presentation only — the decision route asserts
            system-administrator access on its own, so hiding it grants nothing and revealing it
            would grant nothing either. */}
        {valuesOnly ? (
          <p className="border border-slate-200 bg-slate-50 p-4 text-xs font-semibold text-slate-500">
            Imported from the outside source before Phoenix approvals began on 1 July 2026. It is shown
            for its values only: there is nothing to approve, and its decision cannot be changed here.
          </p>
        ) : !canDecide ? (
          <p className="border border-slate-200 bg-slate-50 p-4 text-xs font-semibold text-slate-500">
            You have read-only access to this workspace. Approving, rejecting and adjusting the
            payable amount are reserved for a system administrator.
          </p>
        ) : (
        <div className="flex flex-wrap items-center gap-2 border border-slate-200 bg-slate-50 p-4">
          {decision.hrApproved ? (
            <Button onClick={onUnapprove} variant="secondary">
              <Undo2 className="mr-2 h-4 w-4" /> Unapprove
            </Button>
          ) : isRejected ? (
            <>
              <Badge variant="danger">Rejected</Badge>
              <Button onClick={onUnreject} variant="secondary">
                <Undo2 className="mr-2 h-4 w-4" /> Undo rejection
              </Button>
            </>
          ) : (
            <>
              <Button
                className={cn(phxButtonApproveDenseClassName, "disabled:opacity-60")}
                disabled={reasonMissing}
                onClick={onApprove}
              >
                <Check className="mr-2 h-4 w-4" /> Approve
              </Button>
              <Button
                className={cn(phxButtonDangerDenseClassName, "disabled:opacity-60")}
                disabled={rejectReasonMissing}
                onClick={onReject}
              >
                <XCircle className="mr-2 h-4 w-4" /> Reject
              </Button>
            </>
          )}
          {adjusted ? (
            <Button onClick={() => onChangeAmount(record.total)} variant="secondary">
              <RotateCcw className="mr-2 h-4 w-4" /> Clear deduction
            </Button>
          ) : null}
          {reasonMissing ? (
            <span className="text-xs font-semibold text-rose-600">Add a reason to approve a changed amount.</span>
          ) : !decision.hrApproved && !isRejected && rejectReasonMissing ? (
            <span className="text-xs font-semibold text-slate-500">Add a reason to reject this trip.</span>
          ) : null}
        </div>
        )}
      </div>
    </div>
  );
}
