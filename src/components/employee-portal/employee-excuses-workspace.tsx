"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Printer,
  Search,
  Send,
  WifiOff,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { Input } from "@/components/ui/input";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import type {
  EmployeeExcuseRequest,
  EmployeeExcuseStatus,
  EmployeeExcuseWorkspaceData,
} from "@/lib/excuses/service";
import {
  phxButtonAccentClassName,
  phxFieldClassName,
  phxLabelTextClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Types ────────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

type EmployeeExcusesWorkspaceProps = {
  initialData: EmployeeExcuseWorkspaceData;
};

type ExcuseTab = "request" | "history";

type QueuedExcuseSubmission = {
  excuseDate: string;
  excuseType: "morning" | "afternoon";
  id: string;
  timestamp: number;
};

type DateWarning = {
  kind: "error" | "warning";
  text: string;
};

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Helpers ──────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function statusBadgeVariant(status: EmployeeExcuseStatus): "danger" | "success" | "warning" {
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  return "warning";
}

function statusLabel(status: EmployeeExcuseStatus): string {
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  if (status === "returned_to_employee") return "Returned to employee";
  return "Pending";
}

function typeLabel(type: "morning" | "afternoon") {
  return type === "morning" ? "Morning excuse" : "Afternoon excuse";
}

// Africa/Cairo, not the clock. Inside a client component `toISOString()` is still UTC, so this
// used to pre-fill YESTERDAY for the first 2-3 hours of a Cairo day — on a correctly-set Cairo
// machine, not just a traveller's. validateExcuseDate then compared it against the browser's own
// today and rejected it as a past date, so the form opened with Submit already disabled.
function todayDate() {
  return currentCairoDateOnlyIso();
}

// DATE-ONLY (`excuse_date`, a `date` column — formatDateTime below is the true INSTANT and correctly
// uses Cairo), which `new Date` parses as UTC midnight. UTC here is CORRECT and must stay: it is what
// stops the calendar day being shifted by a zone offset. Not an instant — do not "fix" this one to
// Cairo.
function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    hour: "2-digit",
    hour12: true,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date(value));
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Date Validation (#3) ─────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function validateExcuseDate(dateString: string): DateWarning | null {
  if (!dateString) return { kind: "error", text: "Please select a date." };

  const parts = dateString.split("-").map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2]);

  // Past date check. Compared against Cairo's calendar day, not the viewer's browser clock —
  // both sides of this comparison must resolve "today" the same way as the field's default
  // (todayDate above), or the form contradicts itself and blocks a valid same-day excuse.
  // YYYY-MM-DD strings compare correctly lexicographically, so no Date round-trip is needed.
  if (dateString < currentCairoDateOnlyIso()) {
    return { kind: "error", text: "Cannot submit excuses for past dates." };
  }

  // Weekend check (Friday = 5, Saturday = 6 for Egypt work week)
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 5 || dayOfWeek === 6) {
    return { kind: "warning", text: "This date falls on a weekend (Fri/Sat)." };
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Offline Queue Hook (#2) + SSR Hydration Guard ────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function useOfflineQueue(onReplay: (payload: QueuedExcuseSubmission) => Promise<void>) {
  const [queue, setQueue] = useState<QueuedExcuseSubmission[]>([]);
  // SSR hydration guard: always start `true` to match server output,
  // then sync the real browser value inside useEffect.
  const [isOnline, setIsOnline] = useState(true);
  const replayingRef = useRef(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsOnline(navigator.onLine);

    function handleOnline() {
      setIsOnline(true);
    }
    function handleOffline() {
      setIsOnline(false);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Replay queue when back online
  useEffect(() => {
    if (!isOnline || queue.length === 0 || replayingRef.current) return;
    replayingRef.current = true;

    (async () => {
      const pending = [...queue];
      for (const item of pending) {
        try {
          await onReplay(item);
          setQueue((current) => current.filter((q) => q.id !== item.id));
        } catch {
          break;
        }
      }
      replayingRef.current = false;
    })();
  }, [isOnline, queue, onReplay]);

  function enqueue(excuseDate: string, excuseType: "morning" | "afternoon") {
    const submission: QueuedExcuseSubmission = {
      excuseDate,
      excuseType,
      id: `q-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      timestamp: Date.now(),
    };
    setQueue((current) => [...current, submission]);
  }

  return { enqueue, isOnline, queueLength: queue.length };
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Style Tokens ─────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

const inputClass  = phxFieldClassName;

const labelClass = phxLabelTextClassName;

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Metric Card ──────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function MetricCard({
  description,
  label,
  tone,
  value,
}: {
  description: string;
  label: string;
  tone: "blue" | "emerald" | "orange" | "rose" | "violet";
  value: number | string;
}) {
  const toneMap = {
    blue: {
      bg: "bg-sky-50",
      border: "border-sky-100",
      label: "text-sky-600",
      value: "text-sky-900",
    },
    emerald: {
      bg: "bg-emerald-50",
      border: "border-emerald-100",
      label: "text-emerald-600",
      value: "text-emerald-900",
    },
    orange: {
      bg: "bg-orange-50",
      border: "border-orange-100",
      label: "text-orange-600",
      value: "text-orange-900",
    },
    rose: {
      bg: "bg-rose-50",
      border: "border-rose-100",
      label: "text-rose-600",
      value: "text-rose-900",
    },
    violet: {
      bg: "bg-violet-50",
      border: "border-violet-100",
      label: "text-violet-600",
      value: "text-violet-900",
    },
  };

  const t = toneMap[tone];

  return (
    <div className={`border p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)] ${t.border} ${t.bg}`}>
      <p className={`text-phx-2xs font-bold uppercase tracking-[0.12em] ${t.label}`}>
        {label}
      </p>
      <p className={`mt-1.5 text-[1.75rem] font-extrabold leading-none tracking-[-0.04em] ${t.value}`}>
        {value}
      </p>
      <p className="mt-2 text-phx-xs font-medium leading-4 text-slate-500">{description}</p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Usage Distribution Bar ──────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function UsageDistributionBar({
  allowance,
  approved,
  pending,
  remaining,
}: {
  allowance: number;
  approved: number;
  pending: number;
  remaining: number;
}) {
  if (allowance === 0) return null;

  const approvedPct = (approved / allowance) * 100;
  const pendingPct = (pending / allowance) * 100;
  const remainingPct = (remaining / allowance) * 100;

  return (
    <div className="border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-center justify-between">
        <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">Monthly usage</p>
        <p className="text-phx-xs font-bold text-slate-400">{allowance} {allowance === 1 ? "excuse" : "excuses"} allowed this month</p>
      </div>
      <div className="mt-2.5 flex h-3 w-full overflow-hidden bg-slate-100">
        {approvedPct > 0 ? (
          <div
            className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-500"
            style={{ width: `${approvedPct}%` }}
            title={`Approved: ${approved}`}
          />
        ) : null}
        {pendingPct > 0 ? (
          <div
            className="h-full bg-gradient-to-r from-amber-500 to-amber-300 transition-all duration-500"
            style={{ width: `${pendingPct}%` }}
            title={`Pending: ${pending}`}
          />
        ) : null}
        {remainingPct > 0 ? (
          <div
            className="h-full bg-gradient-to-r from-slate-200 to-slate-100 transition-all duration-500"
            style={{ width: `${remainingPct}%` }}
            title={`Remaining: ${remaining}`}
          />
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-phx-2xs font-bold uppercase tracking-[0.08em]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 bg-emerald-500" />
          <span className="text-emerald-700">Approved {approved}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 bg-amber-500" />
          <span className="text-amber-700">Pending {pending}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 bg-slate-300" />
          <span className="text-slate-600">Remaining {remaining}</span>
        </span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Monthly Trend Sparkline (#5) ─────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function MonthlyTrendSparkline({ requests }: { requests: EmployeeExcuseRequest[] }) {
  // Build a 6-month buckets from current month back
  const buckets = useMemo(() => {
    const now = new Date();
    const months: { count: number; key: string; label: string }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleDateString("en-US", { month: "short" });
      months.push({ count: 0, key, label });
    }
    for (const r of requests) {
      const rKey = r.excuseDate?.slice(0, 7);
      const bucket = months.find((m) => m.key === rKey);
      if (bucket) bucket.count++;
    }
    return months;
  }, [requests]);

  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const barMaxHeight = 48;

  if (requests.length === 0) return null;

  return (
    <div className="border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">Monthly trend</p>
      <div className="mt-3 flex items-end justify-between gap-1">
        {buckets.map((b) => {
          const h = Math.max(4, (b.count / maxCount) * barMaxHeight);
          return (
            <div key={b.key} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-phx-2xs font-bold text-slate-700">{b.count}</span>
              <div
                className="w-full bg-gradient-to-t from-orange-500 to-orange-300 transition-all duration-500"
                style={{ height: `${h}px` }}
                title={`${b.label}: ${b.count} excuses`}
              />
              <span className="text-phx-3xs font-bold uppercase tracking-[0.06em] text-slate-400">{b.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── History Request Card (Mobile) ───────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function ExcuseHistoryCard({
  onEditReturned,
  request,
}: {
  onEditReturned: (request: EmployeeExcuseRequest) => void;
  request: EmployeeExcuseRequest;
}) {
  return (
    <div className="border border-slate-200 bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-phx-md font-bold text-slate-900">{typeLabel(request.excuseType)}</p>
          <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
            {formatDate(request.excuseDate)} · {request.durationHours}h
          </p>
          <p className="mt-0.5 font-mono text-phx-2xs font-bold text-slate-400">{request.requestCode}</p>
        </div>
        <Badge variant={statusBadgeVariant(request.status)}>
          {statusLabel(request.status)}
        </Badge>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Manager</p>
          <p className="mt-0.5 text-phx-sm font-semibold text-slate-700">{request.managerName ?? "Not assigned"}</p>
        </div>
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Submitted</p>
          <p className="mt-0.5 text-phx-sm font-semibold text-slate-700">{formatDateTime(request.createdAt)}</p>
        </div>
      </div>

      {request.managerDecisionAt ? (
        <div className="mt-2 border-t border-slate-100 pt-2">
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Decision</p>
          <p className="mt-0.5 text-phx-xs font-semibold text-slate-600">{formatDateTime(request.managerDecisionAt)}</p>
          {request.managerDecisionComment ? (
            <p className="mt-0.5 text-phx-xs font-medium leading-4 text-slate-500">{request.managerDecisionComment}</p>
          ) : null}
        </div>
      ) : null}
      {request.status === "returned_to_employee" ? (
        <button
          className="mt-3 inline-flex h-8 items-center justify-center border border-orange-200 bg-orange-50 px-3 text-phx-xs font-bold text-orange-700 transition hover:bg-orange-100"
          onClick={() => onEditReturned(request)}
          type="button"
        >
          Edit and resubmit
        </button>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Exported Component (Error Boundary Wrapper) ──────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

export function EmployeeExcusesWorkspace(props: EmployeeExcusesWorkspaceProps) {
  return (
    <WorkspaceErrorBoundary fallbackTitle="Excuses workspace failed to load">
      <EmployeeExcusesWorkspaceInner {...props} />
    </WorkspaceErrorBoundary>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Main Workspace ──────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function EmployeeExcusesWorkspaceInner({ initialData }: EmployeeExcusesWorkspaceProps) {
  const [workspace, setWorkspace] = useState(initialData);
  const [activeTab, setActiveTab] = useState<ExcuseTab>("request");
  const [excuseDate, setExcuseDate] = useState(todayDate());
  const [excuseType, setExcuseType] = useState<"morning" | "afternoon">("morning");
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [resubmitRequestId, setResubmitRequestId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  /* ── History search filter (#4) ─────────────────── */
  const [historySearch, setHistorySearch] = useState("");

  /* ── Focus trap ref for history panel ────────────── */
  const historyPanelRef = useRef<HTMLDivElement>(null);

  const currentMonthLabel = useMemo(() => {
    const [year, month] = workspace.monthly.yearMonth.split("-");
    return new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
  }, [workspace.monthly.yearMonth]);

  /* ── Date validation (#3) ────────────────────────── */
  const dateWarning = useMemo(() => validateExcuseDate(excuseDate), [excuseDate]);
  const hasDateError = dateWarning?.kind === "error";

  /* ── Offline queue (#2) ──────────────────────────── */
  const replayExcuseRequest = useCallback(async (item: QueuedExcuseSubmission) => {
    const response = await fetch("/api/excuses", {
      body: JSON.stringify({ excuseDate: item.excuseDate, excuseType: item.excuseType }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error("Replay failed");
    const payload = await response.json().catch(() => null) as {
      workspace?: EmployeeExcuseWorkspaceData;
    } | null;
    if (payload?.workspace) setWorkspace(payload.workspace);
  }, []);

  const { enqueue, isOnline, queueLength } = useOfflineQueue(replayExcuseRequest);

  const submitDisabled = submitting || submitSuccess || (!resubmitRequestId && workspace.monthly.remaining <= 0) || hasDateError;

  /* ── Stats by status ─────────────────────────────── */
  const statusCounts = useMemo(() => {
    const counts = { approved: 0, pending: 0, rejected: 0, returned: 0 };
    for (const r of workspace.requests) {
      if (r.status === "approved") counts.approved++;
      else if (r.status === "rejected") counts.rejected++;
      else if (r.status === "returned_to_employee") counts.returned++;
      else counts.pending++;
    }
    return counts;
  }, [workspace.requests]);

  /* ── Filtered history (#4) ───────────────────────── */
  const filteredRequests = useMemo(() => {
    if (!historySearch.trim()) return workspace.requests;
    const q = historySearch.toLowerCase().trim();
    return workspace.requests.filter((r) => {
      const searchable = [
        r.requestCode,
        r.excuseDate,
        typeLabel(r.excuseType),
        statusLabel(r.status),
        r.managerName,
        formatDate(r.excuseDate),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchable.includes(q);
    });
  }, [workspace.requests, historySearch]);

  const historyTotal = workspace.requests.length;

  /* ── Focus trap on history tab ──────────────────── */
  useEffect(() => {
    if (activeTab !== "history") return;
    const container = historyPanelRef.current;
    if (!container) return;

    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]';

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusable = container!.querySelectorAll<HTMLElement>(focusableSelector);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeTab]);

  /* ── Submit handler with optimistic animation (#1) ── */
  const handleSubmit = useCallback(() => {
    setMessage(null);

    if (resubmitRequestId && !isOnline) {
      setMessage({ kind: "error", text: "Reconnect before resubmitting a returned request." });
      return;
    }

    // Offline: enqueue instead of fetching (#2)
    if (!isOnline) {
      enqueue(excuseDate, excuseType);
      setMessage({ kind: "success", text: "Request queued. It will be sent when you reconnect." });
      return;
    }

    setSubmitting(true);
    (async () => {
      try {
        const response = await fetch(resubmitRequestId ? `/api/excuses/${resubmitRequestId}/resubmit` : "/api/excuses", {
          body: JSON.stringify({ excuseDate, excuseType }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const payload = await response.json().catch(() => null) as {
          message?: string;
          success?: boolean;
          workspace?: EmployeeExcuseWorkspaceData;
        } | null;

        if (!response.ok || !payload?.success || !payload.workspace) {
          throw new Error(payload?.message || "Unable to submit excuse request.");
        }

        setWorkspace(payload.workspace);
        setResubmitRequestId(null);

        // Optimistic success animation (#1)
        setSubmitSuccess(true);
        setTimeout(() => {
          setSubmitSuccess(false);
          setActiveTab("history");
          setMessage({ kind: "success", text: resubmitRequestId ? "Excuse request resubmitted to your direct manager." : "Excuse request sent to your direct manager." });
        }, 1200);
      } catch (error) {
        setMessage({
          kind: "error",
          text: error instanceof Error ? error.message : "Unable to submit excuse request.",
        });
      } finally {
        setSubmitting(false);
      }
    })();
  }, [excuseDate, excuseType, isOnline, enqueue, resubmitRequestId]);

  const editReturnedRequest = useCallback((request: EmployeeExcuseRequest) => {
    setResubmitRequestId(request.id);
    setExcuseDate(request.excuseDate);
    setExcuseType(request.excuseType);
    setMessage({
      kind: "success",
      text: "Returned request loaded. Edit the date/type if needed, then resubmit.",
    });
    setActiveTab("request");
  }, []);

  /* ═══════════════════════════════════════════════════════════════ */
  /* ─── Tab Items ─────────────────────────────────────────────────── */
  /* ═══════════════════════════════════════════════════════════════ */

  const tabItems: { count: number; label: string; value: ExcuseTab }[] = [
    { count: 0, label: "New Excuse", value: "request" },
    { count: workspace.requests.length, label: "History", value: "history" },
  ];

  /* ═══════════════════════════════════════════════════════════════ */
  /* ─── Render ───────────────────────────────────────────────────── */
  /* ═══════════════════════════════════════════════════════════════ */

  return (
    <div className="excuse-workspace-premium space-y-3" dir="auto">
      {/* Print-friendly stylesheet (#6) */}
      <style>{`
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .excuse-workspace-premium { padding: 0; }
          .excuse-workspace-premium [role="tablist"],
          .excuse-workspace-premium .print\\:hidden { display: none !important; }
          .excuse-workspace-premium table { font-size: 10px; }
          .excuse-workspace-premium td, .excuse-workspace-premium th { padding: 4px 6px; }
          nav, header, footer, aside { display: none !important; }
        }
      `}</style>

      {/* ── Offline banner (#2) ───────────────────────────────── */}
      {!isOnline ? (
        <div className="flex items-center gap-2 border border-amber-200 bg-amber-50 px-3 py-2.5 text-phx-md font-bold text-amber-800">
          <WifiOff className="h-4 w-4 shrink-0 text-amber-600" />
          <span>
            You are offline. Requests will be queued and sent automatically when you reconnect.
            {queueLength > 0 ? ` (${queueLength} queued)` : ""}
          </span>
        </div>
      ) : null}

      {/* ── Optimistic success animation (#1) ─────────────────── */}
      {submitSuccess ? (
        <div className="flex items-center gap-2.5 border border-emerald-200 bg-emerald-50 px-4 py-3 text-phx-md font-bold text-emerald-800 animate-in fade-in duration-300">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
          <span>Excuse request submitted successfully. Switching to history...</span>
        </div>
      ) : null}

      {/* ── Metric Cards ──────────────────────────────────────── */}
      <div className="grid gap-2 grid-cols-2 xs:grid-cols-4">
        <MetricCard
          description={`Allowance for ${currentMonthLabel}`}
          label="Monthly limit"
          tone="blue"
          value={workspace.monthly.allowance}
        />
        <MetricCard
          description="Approved excuses this month"
          label="Used"
          tone="emerald"
          value={workspace.monthly.used}
        />
        <MetricCard
          description="Awaiting manager decision"
          label="Pending"
          tone="orange"
          value={workspace.monthly.pending}
        />
        <MetricCard
          description="Available excuses left"
          label="Remaining"
          tone={workspace.monthly.remaining <= 0 ? "rose" : "violet"}
          value={workspace.monthly.remaining}
        />
      </div>

      {/* ── Usage Distribution Bar ────────────────────────────── */}
      <UsageDistributionBar
        allowance={workspace.monthly.allowance}
        approved={workspace.monthly.approved}
        pending={workspace.monthly.pending}
        remaining={workspace.monthly.remaining}
      />

      {/* ── Tab Bar ────────────────────────────────────────────── */}
      <div
        className={`flex w-full gap-0.5 overflow-x-auto border border-slate-200 bg-slate-50 p-0.5 ${adminSoftDepthClassName}`}
        role="tablist"
        aria-label="Excuse workspace tabs"
      >
        {tabItems.map((tab) => {
          const active = activeTab === tab.value;
          return (
            <button
              aria-selected={active}
              className={`flex h-9 shrink-0 items-center gap-2 whitespace-nowrap px-3 text-phx-md font-bold transition ${
                active ? "bg-white text-orange-600 shadow-sm" : "text-slate-500 hover:bg-white/70 hover:text-slate-700"
              }`}
              key={tab.value}
              role="tab"
              type="button"
              onClick={() => setActiveTab(tab.value)}
            >
              {tab.label}
              {tab.count > 0 ? (
                <span className={`inline-flex h-5 min-w-5 items-center justify-center px-1 text-phx-2xs font-bold ${
                  active ? "bg-orange-100 text-orange-700" : "bg-slate-200 text-slate-600"
                }`}>
                  {tab.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* ── Main Content Grid ─────────────────────────────────── */}
      <div className="grid gap-3 xl:grid-cols-[1fr_320px]">
        {/* ── Left Panel ────────────────────────────────────────── */}
        <div>
          {/* ═════ Request Tab ═════ */}
          {activeTab === "request" ? (
            <div className="border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
              <div className="border-b border-slate-100 px-4 py-3">
                <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-orange-600">Simple workflow</p>
                <h2 className="mt-1 text-base font-extrabold text-slate-900">Request a 2-hour excuse</h2>
                <p className="mt-0.5 text-phx-sm font-medium leading-5 text-slate-500">
                  Choose the date and type. Your manager and HR receive the request for visibility.
                </p>
              </div>

              <div className="space-y-4 p-4">
                <div className="grid gap-3 xs:grid-cols-2">
                  <label className="space-y-1.5">
                    <span className={labelClass}>Date</span>
                    <input
                      className={inputClass}
                      onChange={(event) => setExcuseDate(event.target.value)}
                      type="date"
                      value={excuseDate}
                    />
                    {/* Date validation warning (#3) */}
                    {dateWarning ? (
                      <p className={`mt-1 text-phx-xs font-bold ${dateWarning.kind === "error" ? "text-rose-600" : "text-amber-600"}`}>
                        {dateWarning.text}
                      </p>
                    ) : null}
                  </label>
                  <div className="space-y-1.5">
                    <span className={labelClass}>Excuse type</span>
                    <ChoiceGroup
                      aria-label="Excuse type"
                      className="grid-cols-2"
                      onChange={(value) => setExcuseType(value)}
                      options={[
                        { label: "Morning excuse", value: "morning" },
                        { label: "Afternoon excuse", value: "afternoon" },
                      ]}
                      value={excuseType}
                    />
                  </div>
                </div>

                {/* Message */}
                {message ? (
                  <div className={`flex items-start gap-2 border px-3 py-2.5 text-phx-sm font-bold ${
                    message.kind === "success"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-rose-200 bg-rose-50 text-rose-700"
                  }`}>
                    {message.kind === "success"
                      ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      : <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                    <span>{message.text}</span>
                  </div>
                ) : null}

                {/* Submit button with optimistic states (#1) */}
                <div className="flex items-center gap-3">
                  <button
                    className={cn(
                      phxButtonAccentClassName,
                      // Sent turns the same button green — the one state the accent token does not
                      // carry, and the one thing a rep looks for after pressing it.
                      submitSuccess && "border-emerald-600 bg-emerald-600 hover:bg-emerald-700",
                    )}
                    disabled={submitDisabled}
                    onClick={handleSubmit}
                    type="button"
                  >
                    {submitSuccess ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Submitted
                      </>
                    ) : submitting ? (
                      "Sending..."
                    ) : !isOnline ? (
                      <>
                        <WifiOff className="h-3.5 w-3.5" />
                        Queue Request
                      </>
                    ) : (
                      <>
                        <Send className="h-3.5 w-3.5" />
                        {resubmitRequestId ? "Resubmit request" : "Submit request"}
                      </>
                    )}
                  </button>

                  {workspace.monthly.remaining <= 0 && !resubmitRequestId ? (
                    <p className="text-phx-xs font-bold text-rose-600">
                      Monthly limit reached for {currentMonthLabel}.
                    </p>
                  ) : null}
                  {resubmitRequestId ? (
                    <button
                      className="text-phx-xs font-bold text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline"
                      onClick={() => {
                        setResubmitRequestId(null);
                        setMessage(null);
                      }}
                      type="button"
                    >
                      Cancel resubmit
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {/* ═════ History Tab ═════ */}
          {activeTab === "history" ? (
            <div ref={historyPanelRef} className="border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
              <div className="border-b border-slate-100 px-4 py-3">
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-orange-600">Request history</p>
                    <h2 className="mt-1 text-base font-extrabold text-slate-900">Excuse requests</h2>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className={`w-fit border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-600 ${adminSoftDepthClassName}`}>
                      {filteredRequests.length === historyTotal
                        ? `${historyTotal} requests`
                        : `${filteredRequests.length} of ${historyTotal}`}
                    </Badge>
                    <button
                      className="inline-flex h-7 items-center gap-1.5 border border-slate-200 bg-white px-2.5 text-phx-2xs font-bold text-slate-600 transition hover:bg-slate-50 print:hidden"
                      onClick={() => window.print()}
                      title="Print history"
                      type="button"
                    >
                      <Printer className="h-3 w-3" /> Print
                    </button>
                  </div>
                </div>
              </div>

              {/* Search filter (#4) */}
              {historyTotal > 0 ? (
                <div className="border-b border-slate-100 px-4 py-2.5 print:hidden">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <Input
                      className="pl-9 text-phx-sm"
                      placeholder="Search by date, type, status, manager..."
                      value={historySearch}
                      onChange={(event) => setHistorySearch(event.target.value)}
                    />
                  </div>
                </div>
              ) : null}

              {/* Status distribution mini-bar */}
              {historyTotal > 0 ? (
                <div className="border-b border-slate-100 px-4 py-2.5">
                  <div className="flex h-2 w-full overflow-hidden bg-slate-100">
                    {statusCounts.approved > 0 ? (
                      <div
                        className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-500"
                        style={{ width: `${(statusCounts.approved / historyTotal) * 100}%` }}
                        title={`Approved: ${statusCounts.approved}`}
                      />
                    ) : null}
                    {statusCounts.pending > 0 ? (
                      <div
                        className="h-full bg-gradient-to-r from-amber-500 to-amber-300 transition-all duration-500"
                        style={{ width: `${(statusCounts.pending / historyTotal) * 100}%` }}
                        title={`Pending: ${statusCounts.pending}`}
                      />
                    ) : null}
                    {statusCounts.rejected > 0 ? (
                      <div
                        className="h-full bg-gradient-to-r from-rose-600 to-rose-400 transition-all duration-500"
                        style={{ width: `${(statusCounts.rejected / historyTotal) * 100}%` }}
                        title={`Rejected: ${statusCounts.rejected}`}
                      />
                    ) : null}
                    {statusCounts.returned > 0 ? (
                      <div
                        className="h-full bg-gradient-to-r from-orange-600 to-orange-400 transition-all duration-500"
                        style={{ width: `${(statusCounts.returned / historyTotal) * 100}%` }}
                        title={`Returned: ${statusCounts.returned}`}
                      />
                    ) : null}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-phx-2xs font-bold uppercase tracking-[0.08em]">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 bg-emerald-500" />
                      <span className="text-emerald-700">Approved {statusCounts.approved}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 bg-amber-500" />
                      <span className="text-amber-700">Pending {statusCounts.pending}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 bg-rose-500" />
                      <span className="text-rose-700">Rejected {statusCounts.rejected}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 bg-orange-500" />
                      <span className="text-orange-700">Returned {statusCounts.returned}</span>
                    </span>
                  </div>
                </div>
              ) : null}

              {/* Desktop table (md+) */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full border-collapse text-left text-phx-sm">
                  <thead className="bg-slate-50 text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500">
                    <tr>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Date</th>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Type</th>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Duration</th>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Manager</th>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Status</th>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Submitted</th>
                      <th className="border-b border-slate-100 px-3 py-2.5">Decision</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredRequests.map((request) => (
                      <tr key={request.id} className="bg-white transition hover:bg-orange-50/30">
                        <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-700 whitespace-nowrap">
                          {formatDate(request.excuseDate)}
                          <span className="mt-0.5 block font-mono text-phx-2xs font-bold text-slate-400">{request.requestCode}</span>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-800">{typeLabel(request.excuseType)}</td>
                        <td className="border-r border-slate-100 px-3 py-2.5 text-center font-bold text-slate-900">{request.durationHours}h</td>
                        <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-700">{request.managerName ?? "-"}</td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <Badge variant={statusBadgeVariant(request.status)}>
                            {statusLabel(request.status)}
                          </Badge>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5 font-medium text-slate-600 whitespace-nowrap">{formatDateTime(request.createdAt)}</td>
                        <td className="px-3 py-2.5 text-phx-xs">
                          {request.managerDecisionAt ? (
                            <div>
                              <p className="font-medium text-slate-600">{formatDateTime(request.managerDecisionAt)}</p>
                              {request.managerDecisionComment ? (
                                <p className="mt-0.5 leading-4 text-slate-500">{request.managerDecisionComment}</p>
                              ) : null}
                              {request.status === "returned_to_employee" ? (
                                <button
                                  className="mt-2 inline-flex h-7 items-center justify-center border border-orange-200 bg-orange-50 px-2.5 text-phx-2xs font-bold text-orange-700 transition hover:bg-orange-100"
                                  onClick={() => editReturnedRequest(request)}
                                  type="button"
                                >
                                  Edit and resubmit
                                </button>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {filteredRequests.length === 0 ? (
                      <tr>
                        <td className="px-4 py-8 text-center text-phx-md font-medium text-slate-500" colSpan={7}>
                          {historySearch ? "No matching requests found." : "No excuse requests yet."}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              {/* Mobile card view (< xs / 480px) */}
              <div className="block md:hidden space-y-2 p-3">
                {filteredRequests.length === 0 ? (
                  <div className="border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
                    <CalendarClock className="mx-auto h-6 w-6 text-slate-400" />
                    <p className="mt-2 text-phx-md font-bold text-slate-600">
                      {historySearch ? "No matching requests found." : "No excuse requests yet."}
                    </p>
                  </div>
                ) : (
                  filteredRequests.map((request) => (
                    <ExcuseHistoryCard key={request.id} request={request} onEditReturned={editReturnedRequest} />
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>

        {/* ── Right Sidebar ─────────────────────────────────────── */}
        <div className="space-y-3">
          {/* Monthly trend sparkline (#5) */}
          <MonthlyTrendSparkline requests={workspace.requests} />

          {/* Profile card */}
          <div className="border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
            <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-orange-600">Employee profile</p>
            <h3 className="mt-1.5 text-base font-extrabold text-slate-900">{workspace.employee.fullName}</h3>
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <span className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-400">Role</span>
                <span className="text-phx-sm font-semibold text-slate-700">{workspace.employee.roleLabel}</span>
              </div>
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <span className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-400">Line</span>
                <span className="text-phx-sm font-semibold text-slate-700">{workspace.employee.lineName ?? "Head Office"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-400">Manager</span>
                <span className="text-phx-sm font-semibold text-slate-700">{workspace.employee.managerName ?? "Not assigned"}</span>
              </div>
            </div>
          </div>

          {/* Policy info card */}
          <div className="border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
            <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">Excuse policy</p>
            <div className="mt-2.5 space-y-2 text-phx-sm leading-5 text-slate-600">
              <div className="flex items-start gap-2">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 bg-orange-400" />
                <span>Each excuse covers a 2-hour window (morning or afternoon).</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 bg-orange-400" />
                <span>{workspace.monthly.allowance} excuses allowed per calendar month.</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 bg-orange-400" />
                <span>Rejected requests do not count against the monthly limit.</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 bg-orange-400" />
                <span>Your direct manager receives an email with approve/reject links.</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
