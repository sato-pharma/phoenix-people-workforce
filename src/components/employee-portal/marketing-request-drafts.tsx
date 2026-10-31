"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileCheck2,
  ListChecks,
  Megaphone,
  MessageCircle,
  PackagePlus,
  Pencil,
  RefreshCcw,
  Save,
  Search,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Upload,
  WifiOff,
  X,
} from "lucide-react";

import { MarketingAdvisoryCommentBox } from "@/components/employee-portal/marketing-advisory-comment-box";
import {
  MarketingApprovalTimeline,
  MarketingProgressStrip,
} from "@/components/employee-portal/marketing-approval-timeline";
import { RecordConversationThread } from "@/components/conversations/record-conversation-thread";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { roiMonthsWarning } from "@/lib/marketing-requests/roi-duration";
import { marketingDraftBlockers } from "@/lib/marketing-requests/draft-blockers";
import { calculateMarketingRoiPreview } from "@/lib/marketing-requests/roi";
import { draftCaptureConfidence, type RoiConfidenceBand } from "@/lib/marketing-requests/roi-confidence";
import {
  ROI_ACTUAL_IN_TRACKING_NOTE,
  ROI_FORECAST_COVERAGE_LABEL,
  forecastRoiStatusLabel,
} from "@/lib/marketing-requests/roi-labels";
import type {
  MarketingRequestDetail,
  MarketingRequestRejection,
  MarketingRequestStepProgress,
} from "@/lib/marketing-requests/service";
import { UNVERIFIED_CODE_REASON_MIN_LENGTH } from "@/lib/marketing-requests/types";
import { venueTypeLabel } from "@/lib/venues/venue-type";
import type {
  MarketingApprovedRequestRow,
  MarketingRequestContactOption,
  MarketingRequestPharmacyOption,
  MarketingCustomer,
  MarketingProduct,
  MarketingRequest,
  MarketingRequestType,
} from "@/lib/marketing-requests/types";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import {
  phxButtonAccentClassName,
  phxFieldClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { adminControlDepthClassName, adminPanelDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";


/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Types ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

type DraftWorkspacePayload = {
  approvedRequests: MarketingApprovedRequestRow[];
  canCreateDraft: boolean;
  canSettleAgainstDirectOrder: boolean;
  canUploadMoneyTransferProof: boolean;
  customers: MarketingCustomer[];
  drafts: MarketingRequest[];
  contactsByCustomer: Record<string, MarketingRequestContactOption[]>;
  pharmaciesByCustomer: Record<string, MarketingRequestPharmacyOption[]>;
  inApproval: MarketingRequest[];
  products: MarketingProduct[];
  rejected: MarketingRequest[];
  rejectionByRequestId: Record<string, MarketingRequestRejection>;
  requestTypes: MarketingRequestType[];
  requesterLineId: number | null;
  requesterLineName: string | null;
  returned: MarketingRequest[];
  returnedToMe: MarketingRequest[];
  stepProgressByRequestId: Record<string, MarketingRequestStepProgress>;
};

/**
 * Ties the disabled Save button to the line explaining why it is disabled. A disabled button is
 * skipped by the accessibility tree's own description lookup and shows no tooltip, so a screen
 * reader would otherwise announce "Save Draft, dimmed" and nothing more.
 */
const SAVE_BLOCKED_HINT_ID = "marketing-draft-save-blocked";

type ProductLine = {
  key: string;
  productId: string;
  quantity: string;
};

type QueuedSubmission = {
  id: string;
  payload: unknown;
  timestamp: number;
};

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Focus Trap Hook (#1) --------------------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function useFocusTrap(active: boolean) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const focusableSelector =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const focusableElements =
        container!.querySelectorAll<HTMLElement>(focusableSelector);
      if (focusableElements.length === 0) return;

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];

      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [active]);

  return containerRef;
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Offline Queue Hook (#3 + #4) --------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function useOfflineQueue(onReplay: (payload: unknown) => Promise<void>) {
  const [queue, setQueue] = useState<QueuedSubmission[]>([]);
  // SSR hydration guard (#4): Always start `true` to match server output,
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
          await onReplay(item.payload);
          setQueue((current) => current.filter((q) => q.id !== item.id));
        } catch {
          break; // Stop on first failure --- will retry next online event
        }
      }
      replayingRef.current = false;
    })();
  }, [isOnline, queue, onReplay]);

  function enqueue(payload: unknown) {
    const submission: QueuedSubmission = {
      id: `q-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      payload,
      timestamp: Date.now(),
    };
    setQueue((current) => [...current, submission]);
  }

  return { enqueue, isOnline, queueLength: queue.length };
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Helpers ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

const todayDate = new Date().toISOString().slice(0, 10);

// A fixed table, not Intl: en-GB ICU spells September "Sept" on some runtimes, and the transfer
// date must read the same on this laptop, CI and Railway (same choice as invoice-obligation.ts).
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-08-25` → `25 Aug 2026`. The transfer date is a calendar day, so no timezone shift applies. */
function transferDateLabel(value: string | null | undefined) {
  const match = /^(d{4})-(d{2})-(d{2})/.exec(String(value ?? ""));
  const month = match ? MONTHS_SHORT[Number(match[2]) - 1] : undefined;
  return match && month ? `${Number(match[3])} ${month} ${match[1]}` : "-";
}

function egp(value: number) {
  return stableCurrencyFormatter("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

const CAPTURE_BAND_STYLE: Record<RoiConfidenceBand, string> = {
  high: "border-emerald-200 bg-emerald-50 text-emerald-700",
  medium: "border-amber-200 bg-amber-50 text-amber-800",
  low: "border-rose-200 bg-rose-50 text-rose-700",
};

function fieldNumber(value: string) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roiBadgeVariant(status: string): "success" | "warning" | "neutral" {
  if (status === "covers_required") return "success";
  if (status === "under_target") return "warning";
  return "neutral";
}

/** Coverage bar color: green >= 100%, amber 50-99%, red < 50% */
function coverageGradient(pct: number): string {
  if (pct >= 100) return "from-emerald-600 to-emerald-300";
  if (pct >= 50) return "from-amber-500 to-amber-300";
  return "from-rose-600 to-rose-300";
}

/** #6 - Shorten product name for <select> on narrow screens */
function shortProductName(name: string, maxLen = 28): string {
  if (name.length <= maxLen) return name;
  return `${name.slice(0, Math.max(0, maxLen - 3))}...`;
}

function emptyPayload(): DraftWorkspacePayload {
  return {
    approvedRequests: [],
    // Default to true so the create form stays visible during the initial load; the
    // server's explicit value applies once the workspace is fetched.
    canCreateDraft: true,
    canSettleAgainstDirectOrder: false,
    canUploadMoneyTransferProof: false,
    customers: [],
    contactsByCustomer: {},
    pharmaciesByCustomer: {},
    drafts: [],
    inApproval: [],
    products: [],
    rejected: [],
    rejectionByRequestId: {},
    requestTypes: [],
    requesterLineId: null,
    requesterLineName: null,
    returned: [],
    returnedToMe: [],
    stepProgressByRequestId: {},
  };
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Skeleton Loaders --------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function MetricSkeleton() {
  return (
    <div className="animate-pulse border border-slate-100 bg-slate-50 px-4 py-3">
      <div className="h-2.5 w-16 bg-slate-200" />
      <div className="mt-2.5 h-5 w-12 bg-slate-200" />
    </div>
  );
}

function FormSkeleton() {
  return (
    <div className="animate-pulse space-y-4 p-5">
      <div className="h-4 w-28 bg-slate-200" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-10 bg-slate-100" />
        <div className="h-10 bg-slate-100" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="h-10 bg-slate-100" />
        <div className="h-10 bg-slate-100" />
        <div className="h-10 bg-slate-100" />
      </div>
      <div className="h-10 bg-slate-100" />
      <div className="h-20 bg-slate-100" />
    </div>
  );
}

function TableSkeleton({ cols, rows }: { cols: number; rows: number }) {
  return (
    <div className="animate-pulse">
      <div className="flex gap-2 border-b border-slate-100 bg-slate-50 px-4 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className="h-2.5 flex-1 bg-slate-200" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex gap-2 border-b border-slate-50 px-4 py-3"
        >
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className="h-3.5 flex-1 bg-slate-100" />
          ))}
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Pure SVG Sparkline (#5) ------------------------------------------------------------------------------------------------------------------------ */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function CostSparkline({ drafts }: { drafts: MarketingRequest[] }) {
  // Take latest 12 drafts sorted oldest---newest for a chronological sparkline
  const points = useMemo(() => {
    const sorted = [...drafts]
      .sort(
        (a, b) =>
          new Date(a.requestDate).getTime() -
          new Date(b.requestDate).getTime(),
      )
      .slice(-12);

    if (sorted.length < 2) return null;

    const values = sorted.map((d) => d.estimatedCost);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const range = max - min || 1;

    const w = 200;
    const h = 36;
    const padY = 4;

    const coords = values.map((v, i) => ({
      x: (i / (values.length - 1)) * w,
      y: padY + ((max - v) / range) * (h - padY * 2),
    }));

    const pathD = coords
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(" ");

    // Gradient fill area path
    const areaD = `${pathD} L ${w} ${h} L 0 ${h} Z`;

    return { areaD, coords, h, pathD, w };
  }, [drafts]);

  if (!points) return null;

  return (
    <div className="mt-2 border border-slate-100 bg-slate-50 p-2">
      <p className="mb-1 text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-400">
        Cost Trend (last {Math.min(drafts.length, 12)} drafts)
      </p>
      <svg
        viewBox={`0 0 ${points.w} ${points.h}`}
        className="h-9 w-full"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="spark-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f97316" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#f97316" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={points.areaD} fill="url(#spark-grad)" />
        <path
          d={points.pathD}
          fill="none"
          stroke="#f97316"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Latest point dot */}
        <circle
          cx={points.coords[points.coords.length - 1].x}
          cy={points.coords[points.coords.length - 1].y}
          r="2.5"
          fill="#f97316"
        />
      </svg>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Sub-components --------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function MetricCard({
  accent,
  icon: Icon,
  label,
  value,
}: {
  accent: "orange" | "slate" | "emerald" | "blue";
  icon: React.ElementType;
  label: string;
  value: number | string;
}) {
  const borderColors: Record<string, string> = {
    blue: "border-l-blue-500",
    emerald: "border-l-emerald-500",
    orange: "border-l-orange-500",
    slate: "border-l-slate-400",
  };
  const iconColors: Record<string, string> = {
    blue: "text-blue-500",
    emerald: "text-emerald-500",
    orange: "text-orange-500",
    slate: "text-slate-400",
  };
  return (
    <div
      className={`border border-slate-200 border-l-[3px] bg-white px-3 py-2.5 ${borderColors[accent]}`}
    >
      <div className="flex items-center gap-1.5">
        <Icon className={`h-3 w-3 ${iconColors[accent]}`} />
        <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">
          {label}
        </p>
      </div>
      <p className="mt-1 text-lg font-black text-slate-950">{value}</p>
    </div>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function SelectField({
  children,
  disabled,
  onChange,
  value,
}: {
  children: ReactNode;
  disabled?: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <SearchableSelect
      className="w-full px-3 text-phx-md"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {children}
    </SearchableSelect>
  );
}

function RoiMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border border-slate-100 bg-slate-50 px-3 py-2">
      <span className="text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500">
        {label}
      </span>
      <span className="text-phx-md font-black text-slate-950">{value}</span>
    </div>
  );
}

function ReadOnlyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className={`flex h-10 min-w-0 flex-col justify-center border border-slate-200 bg-white px-3 ${adminSoftDepthClassName}`}>
      <span className="text-phx-3xs font-bold uppercase tracking-[0.10em] text-slate-400">
        {label}
      </span>
      <span className="text-phx-md font-black text-slate-800">{value}</span>
    </div>
  );
}

type DirectOrderOffsetOption = {
  id: string;
  label: string;
  outstanding: number;
  salesMonth: string | null;
};

/**
 * Settle an approved request against a direct order's debt instead of paying it out — for the case
 * where a hospital paid its order net of a sum it owes someone on the company's behalf. No cash
 * moves: the order's outstanding amount falls by the sum and the request needs no transfer proof.
 * Only Finance sees the button (the server enforces it again); everyone else sees the result.
 */
function DirectOrderSettleControl({
  canSettle,
  onChanged,
  onMessage,
  row,
}: {
  canSettle: boolean;
  onChanged: (requestId: string, offset: MarketingApprovedRequestRow["directOrderOffset"]) => void;
  onMessage: (text: string, tone: "success" | "error") => void;
  row: MarketingApprovedRequestRow;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<DirectOrderOffsetOption[] | null>(null);
  const [orderId, setOrderId] = useState("");
  const [amount, setAmount] = useState(String(row.sumOfAmount));
  const [note, setNote] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  async function open() {
    setIsOpen(true);
    if (options) return;
    try {
      const response = await fetch("/api/marketing-requests/direct-order-offset");
      const payload = await response.json();
      if (!response.ok) {
        onMessage(payload.message ?? "Unable to load the direct orders.", "error");
        setIsOpen(false);
        return;
      }
      setOptions(payload.orders as DirectOrderOffsetOption[]);
    } catch {
      onMessage("Unable to load the direct orders.", "error");
      setIsOpen(false);
    }
  }

  async function settle() {
    const chosen = options?.find((option) => option.id === orderId);
    if (!chosen) {
      onMessage("Pick the direct order first.", "error");
      return;
    }
    setIsBusy(true);
    try {
      const response = await fetch("/api/marketing-requests/direct-order-offset", {
        body: JSON.stringify({ amount: Number(amount), directOrderId: chosen.id, note, requestId: row.id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        onMessage(payload.message ?? "Unable to settle against the direct order.", "error");
        return;
      }
      onChanged(row.id, { amount: Number(payload.amount), note: note.trim() || null, orderLabel: chosen.label });
      setIsOpen(false);
      setOptions(null);
      onMessage("Settled against the direct order — no cash moved.", "success");
    } catch {
      onMessage("Unable to settle against the direct order.", "error");
    } finally {
      setIsBusy(false);
    }
  }

  async function remove() {
    setIsBusy(true);
    try {
      const response = await fetch("/api/marketing-requests/direct-order-offset", {
        body: JSON.stringify({ requestId: row.id }),
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });
      const payload = await response.json();
      if (!response.ok) {
        onMessage(payload.message ?? "Unable to remove the settlement.", "error");
        return;
      }
      onChanged(row.id, null);
      onMessage("Settlement removed — the amount is owed on the order again.", "success");
    } catch {
      onMessage("Unable to remove the settlement.", "error");
    } finally {
      setIsBusy(false);
    }
  }

  if (row.directOrderOffset) {
    return (
      <div className="mt-1.5 min-w-0 border border-emerald-200 bg-emerald-50 px-2.5 py-2">
        <p className="text-phx-xs font-bold text-emerald-800">
          Settled against a direct order — no transfer
        </p>
        <p className="mt-0.5 break-words text-phx-2xs font-medium text-emerald-900">
          {row.directOrderOffset.orderLabel} · {egp(row.directOrderOffset.amount)}
        </p>
        {row.directOrderOffset.note ? (
          <p className="mt-0.5 break-words text-phx-2xs font-medium text-slate-600">{row.directOrderOffset.note}</p>
        ) : null}
        {canSettle ? (
          <button
            className="mt-1 text-phx-2xs font-bold text-rose-700 underline disabled:opacity-50"
            disabled={isBusy}
            onClick={() => void remove()}
            type="button"
          >
            {isBusy ? "Removing..." : "Remove settlement"}
          </button>
        ) : null}
      </div>
    );
  }

  if (!canSettle) return null;

  if (!isOpen) {
    return (
      <button
        className={`mt-1.5 w-full border border-slate-200 bg-white px-2.5 py-2 text-left text-phx-xs font-bold text-slate-700 transition hover:border-orange-200 hover:bg-orange-50 ${adminControlDepthClassName}`}
        onClick={() => void open()}
        type="button"
      >
        Settle against a direct order
      </button>
    );
  }

  return (
    <div className={`mt-1.5 min-w-0 space-y-1.5 border border-slate-200 bg-white p-2.5 ${adminSoftDepthClassName}`}>
      <p className="text-phx-2xs font-medium text-slate-500">
        No cash moves. The order&apos;s outstanding amount falls by this sum and no transfer proof is needed.
      </p>
      {options === null ? (
        <p className="text-phx-xs font-medium text-slate-500">Loading direct orders...</p>
      ) : (
        <>
          <SearchableSelect
            className="w-full px-3 text-phx-md"
            onChange={(event) => setOrderId(event.target.value)}
            placeholder="Search the direct order"
            value={orderId}
          >
            <option value="">Select a direct order</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {`${option.label} · ${option.salesMonth ?? "month not booked"} · ${egp(option.outstanding)} outstanding`}
              </option>
            ))}
          </SearchableSelect>
          <input
            aria-label="Amount settled"
            className={phxFieldClassName}
            inputMode="decimal"
            onChange={(event) => setAmount(event.target.value)}
            value={amount}
          />
          <input
            aria-label="Note"
            className={phxFieldClassName}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Note (optional)"
            value={note}
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              className={cn(phxButtonAccentClassName, "shrink-0")}
              disabled={isBusy || !orderId}
              onClick={() => void settle()}
              type="button"
            >
              {isBusy ? "Settling..." : "Settle"}
            </button>
            <button
              className={`border border-slate-200 bg-white px-2.5 py-1.5 text-phx-xs font-bold text-slate-600 ${adminControlDepthClassName}`}
              disabled={isBusy}
              onClick={() => setIsOpen(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function EvidenceUpload({
  accept,
  fileName,
  isUploading,
  label,
  onUpload,
}: {
  accept: string;
  fileName: string | null;
  isUploading: boolean;
  label: string;
  onUpload: (file: File | null | undefined) => void;
}) {
  return (
    <label className={`flex min-w-0 cursor-pointer flex-col gap-1 border border-slate-200 bg-slate-50 px-2.5 py-2 transition hover:border-orange-200 hover:bg-orange-50 ${adminControlDepthClassName}`}>
      <span className="flex items-center gap-1.5 text-phx-xs font-bold text-slate-700">
        {isUploading ? (
          <LoadingSpinner />
        ) : (
          <Upload className="h-3 w-3 text-orange-600" />
        )}
        {isUploading ? "Uploading..." : label}
      </span>
      <span className="break-all text-phx-2xs font-medium text-slate-500">
        {fileName ?? "No file yet"}
      </span>
      <input
        accept={accept}
        className="sr-only"
        disabled={isUploading}
        onChange={(event) => {
          onUpload(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
        type="file"
      />
    </label>
  );
}

/**
 * The money transfer proof for a viewer who may not attach it — Finance does that. Same frame as
 * EvidenceUpload so the row keeps its shape, but no file input: offering one meant a guaranteed
 * "Forbidden" from the server (System Audit, 31 Oct 2026).
 */
function EvidenceOnFile({ fileName, label }: { fileName: string | null; label: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 border border-slate-200 bg-slate-50 px-2.5 py-2 ${adminControlDepthClassName}`}>
      <span className="text-phx-xs font-bold text-slate-700">{label}</span>
      <span className="break-all text-phx-2xs font-medium text-slate-500">
        {fileName ?? "Finance attaches it"}
      </span>
    </div>
  );
}

/** Inline share bar in ROI table --- gradient proportional to share % */
function ShareBar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="hidden sm:flex h-1.5 flex-1 overflow-hidden bg-slate-100">
        <div
          className="h-full bg-gradient-to-r from-orange-500 to-orange-200 transition-all duration-300"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="shrink-0 text-right font-bold text-orange-700">
        {pct}%
      </span>
    </div>
  );
}

/** Draft ROI status distribution bar */
function DraftStatusBar({ drafts }: { drafts: MarketingRequest[] }) {
  if (drafts.length === 0) return null;

  const covers = drafts.filter(
    (d) => d.roiStatus === "covers_required",
  ).length;
  const under = drafts.filter(
    (d) => d.roiStatus === "under_target",
  ).length;
  const other = drafts.length - covers - under;

  const total = drafts.length;
  const pctCovers = Math.round((covers / total) * 100);
  const pctUnder = Math.round((under / total) * 100);
  const pctOther = 100 - pctCovers - pctUnder;

  return (
    <div className="space-y-1.5">
      <div className="flex h-2 w-full overflow-hidden bg-slate-100">
        {pctCovers > 0 && (
          <div
            className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-500"
            style={{ width: `${pctCovers}%` }}
          />
        )}
        {pctUnder > 0 && (
          <div
            className="h-full bg-gradient-to-r from-amber-500 to-amber-300 transition-all duration-500"
            style={{ width: `${pctUnder}%` }}
          />
        )}
        {pctOther > 0 && (
          <div
            className="h-full bg-gradient-to-r from-slate-300 to-slate-200 transition-all duration-500"
            style={{ width: `${pctOther}%` }}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-phx-2xs font-medium text-slate-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 bg-emerald-500" />
          Covers ROI {covers}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 bg-amber-500" />
          Under Target {under}
        </span>
        {other > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 bg-slate-300" />
            Not Calculated {other}
          </span>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Main Workspace --------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function MarketingRequestDraftWorkspaceInner() {
  const [workspace, setWorkspace] =
    useState<DraftWorkspacePayload>(emptyPayload);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    type: "success" | "error";
  } | null>(null);
  const [activeView, setActiveView] = useState<
    "approved" | "create" | "tracking"
  >("create");
  const [uploadingEvidenceKey, setUploadingEvidenceKey] = useState<
    string | null
  >(null);
  const [customerId, setCustomerId] = useState("");
  // True once the requester picks a customer themselves (or reopens a returned request). The
  // pre-picked first customer is not input — Capture Quality must not score it.
  const [customerChosen, setCustomerChosen] = useState(false);
  // The raw choice. Read `customerContactId` below instead — it is the one that is safe to send.
  const [customerContactChoice, setCustomerContactChoice] = useState("");
  const [requestTypeId, setRequestTypeId] = useState("");
  const [requestDate, setRequestDate] = useState(todayDate);
  const [payDate, setPayDate] = useState("");
  // Target pharmacies for this request. Tracked as DESELECTIONS rather than selections so the
  // list is derived, not synced: switching customer then yields "all of the new customer's
  // pharmacies" automatically, with no effect to keep in step and no window where a stale
  // selection still points at the previous customer's pharmacies.
  //
  // Defaulting to all-selected is deliberate — the common case is "the whole customer", and an
  // empty default would quietly reproduce the old behaviour where every request was saved with
  // no targets at all and could never be credited a sale.
  const [deselectedPharmacyIds, setDeselectedPharmacyIds] = useState<string[]>([]);
  // Written justification per pharmacy whose distributor code the reference database cannot find.
  //
  // The API has accepted `unverifiedCodeReason` since the capture gate was added, but no screen
  // ever sent one — so a rep who genuinely stood in front of a real shop was refused at submit
  // with "record why it must be used as-is" and given nowhere to record it. Keyed by the option's
  // `targetId`, so switching customer leaves stale keys that are simply never read, exactly like
  // `deselectedPharmacyIds` above.
  const [unverifiedCodeReasons, setUnverifiedCodeReasons] = useState<Record<string, string>>({});
  const [estimatedCost, setEstimatedCost] = useState("");
  const [roiDurationMonths, setRoiDurationMonths] = useState("3");
  const [otherRequestType, setOtherRequestType] = useState("");
  const [notes, setNotes] = useState("");
  const [productLines, setProductLines] = useState<ProductLine[]>([
    { key: "line-1", productId: "", quantity: "" },
  ]);
  // #2 --- Optimistic UI: track newly saved draft id for highlight
  const [highlightDraftId, setHighlightDraftId] = useState<string | null>(
    null,
  );
  // #7 --- Approved requests search
  const [approvedSearch, setApprovedSearch] = useState("");
  // Tracking view: resubmit mode + cached request details + expanded rows
  const [resubmitRequestId, setResubmitRequestId] = useState<string | null>(
    null,
  );
  const [resubmitRequestCode, setResubmitRequestCode] = useState<string>("");
  const [resubmitReturnReason, setResubmitReturnReason] = useState<string | null>(null);
  const [resubmitReturnedBy, setResubmitReturnedBy] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<
    Record<string, MarketingRequestDetail>
  >({});
  const [expandedTrackingId, setExpandedTrackingId] = useState<string | null>(
    null,
  );
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  // A rejected request stays OPEN for conversation (owner rule, 2026-09-22): the requester can ask
  // why it was refused and the approver can answer, right here on the card, at any status. One card
  // open at a time.
  const [openRejectedConversationId, setOpenRejectedConversationId] = useState<
    string | null
  >(null);

  /* ------ Focus trap for active tab panel (#1) ------------------------------------------------------------------------------ */
  const createPanelRef = useFocusTrap(activeView === "create");
  const approvedPanelRef = useFocusTrap(activeView === "approved");
  const trackingPanelRef = useFocusTrap(activeView === "tracking");

  /* ------ Auto-dismiss timer ref ------------------------------------------------------------------------------------------------------------------------ */
  const dismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showMessage = useCallback(
    (text: string, type: "success" | "error") => {
      if (dismissRef.current) clearTimeout(dismissRef.current);
      setMessage({ text, type });
      if (type === "success") {
        dismissRef.current = setTimeout(() => setMessage(null), 4000);
      }
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (dismissRef.current) clearTimeout(dismissRef.current);
    };
  }, []);

  /* ------ Offline queue (#3) ------------------------------------------------------------------------------------------------------------------------------------ */

  const replayDraft = useCallback(
    async (payload: unknown) => {
      const response = await fetch("/api/marketing-requests/drafts", {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Replay failed");

      setWorkspace((current) => ({
        ...current,
        drafts: [result.draft as MarketingRequest, ...current.drafts],
      }));
      showMessage("Queued draft saved successfully.", "success");
    },
    [showMessage],
  );

  const { enqueue, isOnline, queueLength } = useOfflineQueue(replayDraft);

  /* ------ Data loading ------------------------------------------------------------------------------------------------------------------------------------------------------ */

  const loadWorkspace = useCallback(async () => {
    try {
      const response = await fetch("/api/marketing-requests/drafts", {
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) {
        setWorkspace(emptyPayload());
        showMessage(
          payload.message ?? "Unable to load marketing request workspace.",
          "error",
        );
        return;
      }

      setWorkspace({
        approvedRequests: payload.approvedRequests ?? [],
        canCreateDraft: payload.canCreateDraft ?? true,
        canSettleAgainstDirectOrder: payload.canSettleAgainstDirectOrder ?? false,
        canUploadMoneyTransferProof: payload.canUploadMoneyTransferProof ?? false,
        customers: payload.customers ?? [],
        contactsByCustomer: payload.contactsByCustomer ?? {},
        pharmaciesByCustomer: payload.pharmaciesByCustomer ?? {},
        drafts: payload.drafts ?? [],
        inApproval: payload.inApproval ?? [],
        products: payload.products ?? [],
        rejected: payload.rejected ?? [],
        rejectionByRequestId: payload.rejectionByRequestId ?? {},
        requestTypes: payload.requestTypes ?? [],
        requesterLineId: payload.requesterLineId ?? null,
        requesterLineName: payload.requesterLineName ?? null,
        returned: payload.returned ?? [],
        returnedToMe: payload.returnedToMe ?? [],
        stepProgressByRequestId: payload.stepProgressByRequestId ?? {},
      });
      setCustomerId(
        (current) => current || payload.customers?.[0]?.id || "",
      );
      setRequestTypeId(
        (current) =>
          current || String(payload.requestTypes?.[0]?.id ?? ""),
      );
    } catch {
      setWorkspace(emptyPayload());
      showMessage("Unable to load marketing request workspace.", "error");
    } finally {
      setIsLoading(false);
    }
  }, [showMessage]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadWorkspace]);

  /* ------ Memoised derived state ------------------------------------------------------------------------------------------------------------------------ */

  const selectedRequestType = useMemo(
    () =>
      workspace.requestTypes.find(
        (type) => String(type.id) === requestTypeId,
      ),
    [requestTypeId, workspace.requestTypes],
  );

  const productMap = useMemo(
    () =>
      new Map(
        workspace.products.map((product) => [String(product.id), product]),
      ),
    [workspace.products],
  );

  const pharmacyOptions = useMemo(
    () => (customerId ? workspace.pharmaciesByCustomer[customerId] ?? [] : []),
    [customerId, workspace.pharmaciesByCustomer],
  );

  const contactOptions = useMemo(
    () => (customerId ? workspace.contactsByCustomer[customerId] ?? [] : []),
    [customerId, workspace.contactsByCustomer],
  );

  // Derived, not synced — the same reason the pharmacy list is. A contact chosen before the
  // customer was switched is simply not among the new customer's options, so it resolves to "" on
  // its own. Sending it instead would be refused by the server, which checks the contact belongs
  // to the customer, and the requester would see a save fail for a field they never touched.
  const customerContactId = useMemo(
    () =>
      contactOptions.some((option) => option.id === customerContactChoice)
        ? customerContactChoice
        : "",
    [contactOptions, customerContactChoice],
  );

  const selectedPharmacyIds = useMemo(
    () =>
      pharmacyOptions
        .map((option) => option.targetId)
        .filter((id) => !deselectedPharmacyIds.includes(id)),
    [pharmacyOptions, deselectedPharmacyIds],
  );

  // The selected pharmacies the server will refuse without a written reason. Only `not_found`
  // counts: `ambiguous` and `pending` still attribute and were deliberately left un-gated, so
  // asking for a justification on those would be theatre.
  const unverifiedSelections = useMemo(
    () =>
      pharmacyOptions.filter(
        (option) =>
          option.referenceStatus === "not_found" &&
          selectedPharmacyIds.includes(option.targetId),
      ),
    [pharmacyOptions, selectedPharmacyIds],
  );

  // Save stays disabled until every one of them carries a reason long enough for the server to
  // accept it. Mirrors the API rule with the SAME constant rather than a second copy of 10, so the
  // form can never permit a submission the API then throws back.
  const unverifiedSelectionsMissingReason = useMemo(
    () =>
      unverifiedSelections.filter(
        (option) =>
          (unverifiedCodeReasons[option.targetId] ?? "").trim().length <
          UNVERIFIED_CODE_REASON_MIN_LENGTH,
      ),
    [unverifiedSelections, unverifiedCodeReasons],
  );

  // Capture quality — the same trust score the ROI tracker shows after submission, computed live
  // from only what the requester can still change (verified codes, a forecast, a pay date). Shown
  // on the preview so "is this request even measurable?" is answerable before Save, not months later.
  const captureConfidence = useMemo(() => {
    const suspectByCode = new Map(
      pharmacyOptions.map((option) => [
        option.targetId,
        // A venue with no distributor account is not a SUSPECT code — it is no code at all. Scoring
        // it as suspect would mark every nursery request low-confidence for a fault it cannot have.
        option.venueType === "pharmacy"
        && (option.referenceStatus === "not_found" || option.referenceStatus === "ambiguous"),
      ]),
    );
    return draftCaptureConfidence({
      pharmacySuspect: selectedPharmacyIds.map((id) => suspectByCode.get(id) ?? false),
      forecastUnits: productLines.reduce(
        (sum, line) => sum + (line.productId ? fieldNumber(line.quantity) : 0),
        0,
      ),
      productCount: productLines.filter((line) => line.productId).length,
      hasPayDate: Boolean(payDate),
    });
  }, [pharmacyOptions, selectedPharmacyIds, productLines, payDate]);

  const captureHasInput =
    customerChosen ||
    Boolean(payDate) ||
    Boolean(estimatedCost.trim()) ||
    deselectedPharmacyIds.length > 0 ||
    productLines.some((line) => line.productId);

  const customerNameMap = useMemo(
    () =>
      new Map(
        workspace.customers.map((customer) => [
          customer.id,
          customer.displayName,
        ]),
      ),
    [workspace.customers],
  );

  const requestTypeNameMap = useMemo(
    () =>
      new Map(
        workspace.requestTypes.map((type) => [type.id, type.name]),
      ),
    [workspace.requestTypes],
  );

  const visibleProducts = workspace.products;

  const lineScopedProductIdKey = useMemo(
    () =>
      visibleProducts
        .map((product) => product.id)
        .sort((left, right) => left - right)
        .join("|"),
    [visibleProducts],
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const productIds = new Set(
        lineScopedProductIdKey.split("|").filter(Boolean),
      );
      setProductLines((current) =>
        current.map((line) =>
          line.productId && !productIds.has(line.productId)
            ? { ...line, productId: "" }
            : line,
        ),
      );
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [lineScopedProductIdKey]);

  const roiPreview = useMemo(() => {
    const products = productLines
      .map((line) => {
        const product = productMap.get(line.productId);
        if (!product) return null;
        return {
          factoryPrice: product.factoryPrice,
          productId: product.id,
          productName: product.productName,
          quantity: fieldNumber(line.quantity),
        };
      })
      .filter(
        (line): line is NonNullable<typeof line> => Boolean(line),
      );

    return calculateMarketingRoiPreview({
      durationMonths: fieldNumber(roiDurationMonths),
      estimatedCost: fieldNumber(estimatedCost),
      products,
    });
  }, [estimatedCost, productLines, productMap, roiDurationMonths]);

  const productLineMetrics = useMemo(() => {
    return productLines
      .map((line) => {
        const product = productMap.get(line.productId);
        if (!product) return null;
        const quantity = fieldNumber(line.quantity);
        const expectedValue = quantity * product.factoryPrice;
        return {
          expectedValue,
          factoryPrice: product.factoryPrice,
          key: line.key,
          productId: product.id,
          productName: product.productName,
          quantity,
          valueShare:
            roiPreview.expectedRoiValue > 0
              ? expectedValue / roiPreview.expectedRoiValue
              : 0,
        };
      })
      .filter(
        (line): line is NonNullable<typeof line> => Boolean(line),
      );
  }, [productLines, productMap, roiPreview.expectedRoiValue]);

  // What is still missing, in form order. The Save button and the hint beside it both read this
  // one list — see marketingDraftBlockers for why they must never be two.
  const saveBlockers = useMemo(
    () =>
      marketingDraftBlockers({
        customerId,
        estimatedCost: fieldNumber(estimatedCost),
        hasProductWithQuantity: roiPreview.products.some(
          (product) => product.quantity > 0,
        ),
        otherRequestType,
        requestDate,
        requestTypeId,
        requiresDescription: Boolean(selectedRequestType?.requiresDescription),
        roiDurationMonths,
        selectedPharmacyCount: selectedPharmacyIds.length,
        unverifiedCodesMissingReason: unverifiedSelectionsMissingReason.length,
      }),
    [
      customerId,
      estimatedCost,
      otherRequestType,
      requestDate,
      requestTypeId,
      roiDurationMonths,
      roiPreview.products,
      selectedPharmacyIds,
      selectedRequestType,
      unverifiedSelectionsMissingReason,
    ],
  );

  const canSave = !isSaving && saveBlockers.length === 0;

  /* #7 --- Filtered approved requests */
  const filteredApproved = useMemo(() => {
    if (!approvedSearch.trim()) return workspace.approvedRequests;
    const q = approvedSearch.toLowerCase();
    return workspace.approvedRequests.filter(
      (row) =>
        row.customerName.toLowerCase().includes(q) ||
        row.contactForMoneyTransfer.toLowerCase().includes(q) ||
        row.requestCode.toLowerCase().includes(q) ||
        (row.moneyTransferDate ?? "").toLowerCase().includes(q) ||
        (row.line ?? "").toLowerCase().includes(q),
    );
  }, [workspace.approvedRequests, approvedSearch]);

  /* ------ Actions --------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

  function updateProductLine(key: string, patch: Partial<ProductLine>) {
    setProductLines((current) =>
      current.map((line) =>
        line.key === key ? { ...line, ...patch } : line,
      ),
    );
  }

  function addProductLine() {
    setProductLines((current) => [
      ...current,
      { key: `line-${Date.now()}`, productId: "", quantity: "" },
    ]);
  }

  function removeProductLine(key: string) {
    setProductLines((current) =>
      current.length === 1
        ? current
        : current.filter((line) => line.key !== key),
    );
  }

  /* ------ Tracking + resubmit helpers ------------------------------------------------------------------------------------------------------------- */

  function resetForm() {
    setCustomerId(workspace.customers[0]?.id ?? "");
    setCustomerChosen(false);
    setCustomerContactChoice("");
    setRequestTypeId(String(workspace.requestTypes[0]?.id ?? ""));
    setRequestDate(todayDate);
    setPayDate("");
    setEstimatedCost("");
    setRoiDurationMonths("3");
    setOtherRequestType("");
    setNotes("");
    setProductLines([{ key: "line-1", productId: "", quantity: "" }]);
    setUnverifiedCodeReasons({});
  }

  async function fetchRequestDetail(
    requestId: string,
  ): Promise<MarketingRequestDetail | null> {
    if (detailCache[requestId]) return detailCache[requestId];
    setLoadingDetailId(requestId);
    try {
      const response = await fetch(
        `/api/marketing-requests/${requestId}`,
        { cache: "no-store" },
      );
      const payload = await response.json();
      if (!response.ok || !payload.detail) {
        showMessage(
          payload.message ?? "Unable to load request details.",
          "error",
        );
        return null;
      }
      const detail = payload.detail as MarketingRequestDetail;
      setDetailCache((current) => ({ ...current, [requestId]: detail }));
      return detail;
    } catch {
      showMessage("Unable to load request details.", "error");
      return null;
    } finally {
      setLoadingDetailId(null);
    }
  }

  async function toggleTrackingExpand(requestId: string) {
    if (expandedTrackingId === requestId) {
      setExpandedTrackingId(null);
      return;
    }
    setExpandedTrackingId(requestId);
    if (!detailCache[requestId]) {
      await fetchRequestDetail(requestId);
    }
  }

  async function startResubmit(request: MarketingRequest) {
    setMessage(null);
    const detail = await fetchRequestDetail(request.id);
    if (!detail) return;

    setCustomerId(detail.request.customerId);
    setCustomerChosen(true);
    setCustomerContactChoice(detail.request.customerContactId ?? "");
    setRequestTypeId(String(detail.request.requestTypeId));
    setRequestDate(detail.request.requestDate || todayDate);
    setPayDate(detail.request.payDate ?? "");
    setEstimatedCost(String(detail.request.estimatedCost ?? ""));
    setRoiDurationMonths(String(detail.request.roiDurationMonths ?? "3"));
    setOtherRequestType(detail.request.otherRequestType ?? "");
    setNotes(detail.request.notes ?? "");
    setProductLines(
      detail.products.length > 0
        ? detail.products.map((product, index) => ({
            key: `line-${index + 1}`,
            productId: String(product.productId),
            quantity: String(product.forecastQuantity),
          }))
        : [{ key: "line-1", productId: "", quantity: "" }],
    );

    const returnedStep = [...detail.steps]
      .reverse()
      .find((step) => step.status === "returned" && Boolean(step.decisionNote));
    setResubmitReturnReason(detail.progress?.returnReason ?? returnedStep?.decisionNote ?? null);
    setResubmitReturnedBy(returnedStep?.decisionByName ?? null);

    setResubmitRequestId(request.id);
    setResubmitRequestCode(detail.request.requestCode);
    setActiveView("create");
  }

  function cancelResubmit() {
    setResubmitRequestId(null);
    setResubmitRequestCode("");
    setResubmitReturnReason(null);
    setResubmitReturnedBy(null);
    resetForm();
  }

  async function submitDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    if (!canSave) {
      showMessage(
        saveBlockers[0] ?? "Complete the draft fields before saving.",
        "error",
      );
      return;
    }

    const draftPayload = {
      customerContactId: customerContactId || null,
      customerId,
      estimatedCost: fieldNumber(estimatedCost),
      lineId: workspace.requesterLineId,
      notes,
      otherRequestType,
      payDate: payDate || null,
      // The reason rides per pharmacy, not per request: a request can target several pharmacies
      // where only one code is unverified, and a request-level note would not say which. Sent only
      // where one was actually typed, so a verified code carries nothing extra.
      pharmacies: selectedPharmacyIds.map((targetId) => {
        const reason = (unverifiedCodeReasons[targetId] ?? "").trim();
        return reason ? { targetId, unverifiedCodeReason: reason } : { targetId };
      }),
      products: productLines
        .filter((line) => line.productId && fieldNumber(line.quantity) > 0)
        .map((line) => ({
          productId: Number(line.productId),
          quantity: fieldNumber(line.quantity),
        })),
      requestDate,
      requestTypeId: Number(requestTypeId),
      roiDurationMonths: Number(roiDurationMonths),
    };

    // #3 --- Offline: enqueue and show optimistic feedback (drafts only).
    // Resubmit cannot be queued because it targets a specific request route.
    if (!isOnline) {
      if (resubmitRequestId) {
        showMessage(
          "You are offline. Reconnect to resubmit this returned request.",
          "error",
        );
        return;
      }
      enqueue(draftPayload);
      showMessage(
        "You are offline. Draft queued and will save when reconnected.",
        "success",
      );
      setEstimatedCost("");
      setNotes("");
      setOtherRequestType("");
      setPayDate("");
      setProductLines([{ key: "line-1", productId: "", quantity: "" }]);
      // Cleared with the rest of the form. A justification is written about one request; leaving it
      // pre-filled would let the next request reuse it silently, and it is stored as an audit note.
      setUnverifiedCodeReasons({});
      return;
    }

    setIsSaving(true);
    try {
      const targetUrl = resubmitRequestId
        ? `/api/marketing-requests/${resubmitRequestId}/resubmit`
        : "/api/marketing-requests/drafts";
      const response = await fetch(targetUrl, {
        body: JSON.stringify(draftPayload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        showMessage(
          payload.message ??
            (resubmitRequestId
              ? "Unable to resubmit request."
              : "Unable to save draft."),
          "error",
        );
        return;
      }

      if (resubmitRequestId) {
        const resubmittedId = resubmitRequestId;
        setResubmitRequestId(null);
        setResubmitRequestCode("");
        setDetailCache((current) => {
          const next = { ...current };
          delete next[resubmittedId];
          return next;
        });
        resetForm();
        showMessage("Request resubmitted successfully.", "success");
        await loadWorkspace();
        return;
      }

      const newDraft = payload.draft as MarketingRequest;
      setWorkspace((current) => ({
        ...current,
        drafts: [newDraft, ...current.drafts],
      }));

      // #2 --- Optimistic UI: highlight the new draft row
      setHighlightDraftId(newDraft.id);
      setTimeout(() => setHighlightDraftId(null), 3000);

      showMessage("Draft saved successfully.", "success");
      setEstimatedCost("");
      setNotes("");
      setOtherRequestType("");
      setPayDate("");
      setProductLines([{ key: "line-1", productId: "", quantity: "" }]);
      // Cleared with the rest of the form. A justification is written about one request; leaving it
      // pre-filled would let the next request reuse it silently, and it is stored as an audit note.
      setUnverifiedCodeReasons({});
    } catch {
      showMessage(
        resubmitRequestId
          ? "Unable to resubmit request."
          : "Unable to save draft.",
        "error",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function uploadFinanceEvidence(
    requestId: string,
    evidenceType: "money_transfer_proof" | "invoice",
    file: File | null | undefined,
  ) {
    if (!file) return;
    const uploadKey = `${requestId}:${evidenceType}`;
    setUploadingEvidenceKey(uploadKey);
    setMessage(null);

    const formData = new FormData();
    formData.append("requestId", requestId);
    formData.append("evidenceType", evidenceType);
    formData.append("file", file);

    try {
      const response = await fetch(
        "/api/marketing-requests/finance-evidence",
        { body: formData, method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) {
        showMessage(
          payload.message ?? "Unable to upload finance evidence.",
          "error",
        );
        return;
      }

      setWorkspace((current) => ({
        ...current,
        approvedRequests: current.approvedRequests.map((row) =>
          row.id === requestId
            ? (payload.row as MarketingApprovedRequestRow)
            : row,
        ),
      }));
      showMessage(
        evidenceType === "money_transfer_proof"
          ? "Money transfer proof uploaded."
          : "Invoice uploaded.",
        "success",
      );
    } catch {
      showMessage("Unable to upload finance evidence.", "error");
    } finally {
      setUploadingEvidenceKey(null);
    }
  }

  function applyDirectOrderOffset(
    requestId: string,
    offset: MarketingApprovedRequestRow["directOrderOffset"],
  ) {
    setWorkspace((current) => ({
      ...current,
      approvedRequests: current.approvedRequests.map((row) =>
        row.id === requestId ? { ...row, directOrderOffset: offset } : row,
      ),
    }));
  }

  /* ------ Derived metrics --------------------------------------------------------------------------------------------------------------------------------------------- */

  const coveragePct = Math.min(
    Math.round(roiPreview.roiCoverageRatio * 100),
    100,
  );

  const totalDraftValue = useMemo(
    () => workspace.drafts.reduce((sum, d) => sum + d.estimatedCost, 0),
    [workspace.drafts],
  );

  /* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
  /* --------- Render --------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
  /* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

  return (
    <div className="space-y-3" dir="auto">
      {/* ------ Offline Banner (#3) ------------------------------------------------------------------------------------------------------------------ */}
      {!isOnline && (
        <div className="flex items-center gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-phx-md font-semibold text-amber-900">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          <span>
            You are offline.
            {queueLength > 0
              ? ` ${queueLength} draft${queueLength > 1 ? "s" : ""} queued.`
              : " Drafts will be queued until reconnected."}
          </span>
        </div>
      )}

      {/* ------ Metric Cards + Refresh --------------------------------------------------------------------------------------------------------- */}
      <div className="flex items-start gap-2">
        <div className="grid flex-1 gap-2 grid-cols-2 xs:grid-cols-4">
          {isLoading ? (
            <>
              <MetricSkeleton />
              <MetricSkeleton />
              <MetricSkeleton />
              <MetricSkeleton />
            </>
          ) : (
            <>
              <MetricCard
                accent="orange"
                icon={ClipboardList}
                label="Drafts"
                value={workspace.drafts.length}
              />
              <MetricCard
                accent="emerald"
                icon={CheckCircle2}
                label="Approved"
                value={workspace.approvedRequests.length}
              />
              <MetricCard
                accent="slate"
                icon={Megaphone}
                label="Customers"
                value={workspace.customers.length}
              />
              <MetricCard
                accent="blue"
                icon={PackagePlus}
                label="Products"
                value={workspace.products.length}
              />
            </>
          )}
        </div>
        <button
          aria-label="Refresh data"
          className="flex h-10 w-10 shrink-0 items-center justify-center border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600"
          onClick={() => {
            setIsLoading(true);
            setMessage(null);
            void loadWorkspace();
          }}
          title="Refresh data"
          type="button"
        >
          {isLoading ? (
            <LoadingSpinner />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* ------ Draft ROI Health + Sparkline ------------------------------------------------------------------------------------------ */}
      {!isLoading && workspace.drafts.length > 0 && (
        <div className={`border border-slate-200 bg-white px-4 py-3 ${adminSoftDepthClassName}`}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">
              Draft ROI Health
            </span>
            <span className="text-phx-xs font-bold text-slate-600">
              Total: {egp(totalDraftValue)}
            </span>
          </div>
          <DraftStatusBar drafts={workspace.drafts} />
          {/* #5 --- Time-series sparkline */}
          {workspace.drafts.length >= 2 && (
            <CostSparkline drafts={workspace.drafts} />
          )}
        </div>
      )}

      {/* ------ Alert Messages --------------------------------------------------------------------------------------------------------------------------------- */}
      {message ? (
        <div
          className={`flex items-center gap-2 border px-3 py-2 text-phx-md font-semibold transition-all ${
            message.type === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
        >
          {message.type === "success" && (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          )}
          <span className="min-w-0 break-words">{message.text}</span>
        </div>
      ) : null}

      {/* ------ Tab Switcher --------------------------------------------------------------------------------------------------------------------------------------- */}
      <div className={`grid grid-cols-3 gap-1 border border-slate-200 bg-slate-50 p-1 ${adminSoftDepthClassName}`}>
        <button
          className={`flex min-w-0 flex-wrap items-center justify-center gap-1 px-1 py-2 text-phx-md font-bold transition sm:gap-1.5 sm:px-3 ${
            activeView === "create"
              ? "bg-orange-500 text-white shadow-sm"
              : "bg-transparent text-slate-600 hover:bg-white"
          }`}
          onClick={() => setActiveView("create")}
          type="button"
        >
          <Megaphone className="h-3.5 w-3.5" />
          <span>Create</span>
          {!isLoading && (
            <span
              className={`ml-0.5 px-1.5 py-0.5 text-phx-2xs font-black ${
                activeView === "create"
                  ? "bg-white/20 text-white"
                  : "bg-slate-200/60 text-slate-500"
              }`}
            >
              {workspace.drafts.length}
            </span>
          )}
        </button>
        <button
          className={`flex min-w-0 flex-wrap items-center justify-center gap-1 px-1 py-2 text-phx-md font-bold transition sm:gap-1.5 sm:px-3 ${
            activeView === "approved"
              ? "bg-orange-500 text-white shadow-sm"
              : "bg-transparent text-slate-600 hover:bg-white"
          }`}
          onClick={() => setActiveView("approved")}
          type="button"
        >
          <FileCheck2 className="h-3.5 w-3.5" />
          <span>Approved</span>
          {!isLoading && (
            <span
              className={`ml-0.5 px-1.5 py-0.5 text-phx-2xs font-black ${
                activeView === "approved"
                  ? "bg-white/20 text-white"
                  : "bg-slate-200/60 text-slate-500"
              }`}
            >
              {workspace.approvedRequests.length}
            </span>
          )}
        </button>
        <button
          className={`flex min-w-0 flex-wrap items-center justify-center gap-1 px-1 py-2 text-phx-md font-bold transition sm:gap-1.5 sm:px-3 ${
            activeView === "tracking"
              ? "bg-orange-500 text-white shadow-sm"
              : "bg-transparent text-slate-600 hover:bg-white"
          }`}
          onClick={() => setActiveView("tracking")}
          type="button"
        >
          <ClipboardList className="h-3.5 w-3.5" />
          <span>Tracking</span>
          {!isLoading && (
            <span
              className={`ml-0.5 px-1.5 py-0.5 text-phx-2xs font-black ${
                activeView === "tracking"
                  ? "bg-white/20 text-white"
                  : "bg-slate-200/60 text-slate-500"
              }`}
            >
              {workspace.returnedToMe.length + workspace.inApproval.length}
            </span>
          )}
        </button>
      </div>

      {/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */}
      {/* ------ CREATE REQUEST TAB  (#1 focus trap) ------------------------------------------------------------------ */}
      {/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */}
      <div
        ref={createPanelRef}
        className={activeView === "create" ? "space-y-3" : "hidden"}
      >
        {/* ------ Resubmit banner --------------------------------------------------------------------------------------------------------------------------- */}
        {resubmitRequestId ? (
          <div className="border border-amber-200 bg-amber-50 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-phx-md font-semibold text-amber-900">
              <span className="flex min-w-0 items-center gap-2">
                <Pencil className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 break-words">
                  Editing returned request{" "}
                  <span className="font-mono font-black">
                    {resubmitRequestCode}
                  </span>{" "}
                  — resubmitting will resume at the step that returned it.
                </span>
              </span>
              <button
                className="flex shrink-0 items-center gap-1 border border-amber-300 bg-white px-2.5 py-1.5 text-phx-xs font-bold text-amber-800 transition hover:bg-amber-100"
                onClick={cancelResubmit}
                type="button"
              >
                <X className="h-3 w-3" />
                Cancel resubmit
              </button>
            </div>
            {resubmitReturnReason ? (
              <div className="mt-2 border-l-4 border-amber-500 bg-white/70 px-3 py-2 text-phx-sm text-amber-900">
                <span className="font-bold">
                  Returned{resubmitReturnedBy ? ` by ${resubmitReturnedBy}` : ""} — reason:
                </span>{" "}
                <span className="break-words">{resubmitReturnReason}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ------ Draft Form Card ------------------------------------------------------------------------------------------------------------------------ */}
        <Card className="overflow-hidden border border-slate-200 bg-white p-0 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          {isLoading ? (
            <FormSkeleton />
          ) : (
            <form aria-busy={isSaving} onSubmit={submitDraft}>
              {/* Form header */}
              <div className="border-b border-slate-100 bg-gradient-to-r from-white via-orange-50/30 to-white px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-phx-2xs font-bold uppercase tracking-[0.14em] text-orange-600">
                      {resubmitRequestId ? "Edit & Resubmit" : "Create Draft"}
                    </p>
                    <h2 className="mt-0.5 text-phx-lg font-black tracking-tight text-slate-950">
                      {resubmitRequestId
                        ? "Returned request"
                        : "Activity request"}
                    </h2>
                  </div>
                  <Badge variant={roiBadgeVariant(roiPreview.roiStatus)}>
                    {forecastRoiStatusLabel(roiPreview.roiStatus)}
                  </Badge>
                </div>
              </div>

              {/* Form fields */}
              <div className="grid gap-3 p-4 sm:grid-cols-6">
                <div className="sm:col-span-3">
                  <Field label="Customer">
                    <SelectField
                      disabled={
                        isLoading || workspace.customers.length === 0
                      }
                      onChange={(value) => {
                        setCustomerChosen(true);
                        setCustomerId(value);
                      }}
                      value={customerId}
                    >
                      <option value="">Select customer</option>
                      {workspace.customers.map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          {customer.displayName} -{" "}
                          {customer.customerType}
                        </option>
                      ))}
                    </SelectField>
                  </Field>
                </div>

                {/*
                  Which contact this request concerns. Optional on purpose: a campaign aimed at a
                  customer as a whole genuinely has no single contact, and forcing a choice would
                  put a confident wrong name on every one of those. Naming one links the request to
                  that person's CRM record; leaving it blank keeps the old customer-level behaviour,
                  where the request counts for every linked contact the customer has.
                */}
                <div className="sm:col-span-3">
                  <Field label="Customer Contact (optional)">
                    <SelectField
                      disabled={isLoading || !customerId || contactOptions.length === 0}
                      onChange={setCustomerContactChoice}
                      value={customerContactId}
                    >
                      <option value="">
                        {customerId && contactOptions.length === 0
                          ? "This customer has no contacts yet"
                          : "No specific contact"}
                      </option>
                      {contactOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.contactName}
                          {option.crmContactId ? " - CRM linked" : ""}
                        </option>
                      ))}
                    </SelectField>
                  </Field>
                </div>

                {/*
                  Target pharmacies. This is what attribution matches sales against — a request
                  with none can never be credited a single sale, so its ROI reads zero forever.
                  Shown as a short explicit list because a customer has at most 8 pharmacies in
                  production; a search box over the 45k-row master would be slower AND less
                  accurate than picking from the customer's own.
                */}
                {customerId ? (
                  <div className="sm:col-span-6">
                    <Field label={`Target Pharmacies (${selectedPharmacyIds.length} of ${pharmacyOptions.length})`}>
                      {pharmacyOptions.length === 0 ? (
                        <p className="text-xs text-amber-700">
                          This customer has no validated pharmacies yet, so nothing can be measured for it. Add one in
                          Customer Validation before submitting.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-1 border border-slate-200 p-2">
                          {pharmacyOptions.map((option) => {
                            const checked = selectedPharmacyIds.includes(option.targetId);
                            // Never true for a codeless venue: there is no code to be unrecognised,
                            // and the server does not ask for a reason it would have nothing to say.
                            const unverified =
                              option.venueType === "pharmacy" && option.referenceStatus === "not_found";
                            const reason = unverifiedCodeReasons[option.targetId] ?? "";
                            const reasonTooShort =
                              reason.trim().length < UNVERIFIED_CODE_REASON_MIN_LENGTH;
                            return (
                              <div key={option.targetId}>
                                <label
                                  className="flex cursor-pointer items-center gap-2 text-xs"
                                >
                                  <input
                                    checked={checked}
                                    onChange={() =>
                                      setDeselectedPharmacyIds((current) =>
                                        current.includes(option.targetId)
                                          ? current.filter((id) => id !== option.targetId)
                                          : [...current, option.targetId],
                                      )
                                    }
                                    type="checkbox"
                                  />
                                  <span className="text-slate-800">{option.pharmacyName}</span>
                                  <span className="text-slate-500">
                                    {option.distributorName
                                      ? `${option.pharmacyCode} · ${option.distributorName}`
                                      : venueTypeLabel(option.venueType)}
                                  </span>
                                  {/*
                                    Stated on the row, not left to be noticed: spend here is allowed
                                    and its return can never be read off a sales figure. The ROI
                                    panel would otherwise show a zero, which says something much
                                    worse and much less true than "this cannot be measured that way".
                                  */}
                                  {option.distributorName ? null : (
                                    <span className="text-slate-500">
                                      {option.venueType === "pharmacy"
                                        // A pharmacy a person released on its licence: it HAS an account
                                        // somewhere, it just has no code on file yet.
                                        ? "— released on its licence, no distributor code yet, so sales cannot be matched until one is added"
                                        : "— no distributor account, so sales cannot be attributed"}
                                    </span>
                                  )}
                                  {unverified ? (
                                    <span className="text-amber-700">
                                      — code not recognised, sales here will not be counted
                                    </span>
                                  ) : null}
                                </label>
                                {/*
                                  The way past the capture gate, and the only one. The server refuses
                                  a `not_found` code unless a justification of at least
                                  UNVERIFIED_CODE_REASON_MIN_LENGTH characters comes with it and
                                  stores that text on the request as an audit note. Shown only while
                                  the pharmacy is actually selected — unticking it is the other valid
                                  answer, and asking for a reason then would be asking about nothing.
                                */}
                                {unverified && checked ? (
                                  <div className="mt-1 mb-2 ml-5 flex flex-col gap-1">
                                    <textarea
                                      className={cn(phxTextareaClassName, "min-h-16")}
                                      onChange={(event) => {
                                        const value = event.target.value;
                                        setUnverifiedCodeReasons((current) => ({
                                          ...current,
                                          [option.targetId]: value,
                                        }));
                                      }}
                                      placeholder={`Why must code ${option.pharmacyCode} be used as-is?`}
                                      value={reason}
                                    />
                                    {reasonTooShort ? (
                                      <span className="text-xs text-amber-700">
                                        Needed to save — at least {UNVERIFIED_CODE_REASON_MIN_LENGTH} characters.
                                      </span>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {pharmacyOptions.length > 0 && selectedPharmacyIds.length === 0 ? (
                        <p className="mt-1 text-xs text-amber-700">
                          No pharmacies selected — a request with no target can never be credited
                          any sales, so it cannot be saved. Tick the pharmacy this request is for.
                        </p>
                      ) : null}
                    </Field>
                  </div>
                ) : null}

                <div className="sm:col-span-3">
                  <Field label="Request Type">
                    <SelectField
                      disabled={
                        isLoading ||
                        workspace.requestTypes.length === 0
                      }
                      onChange={setRequestTypeId}
                      value={requestTypeId}
                    >
                      <option value="">Select type</option>
                      {workspace.requestTypes.map((type) => (
                        <option key={type.id} value={type.id}>
                          {type.name}
                        </option>
                      ))}
                    </SelectField>
                  </Field>
                </div>

                {selectedRequestType?.requiresDescription ? (
                  <div className="sm:col-span-6">
                    <Field label="Other Type Description">
                      <Input
                        className="text-phx-md"
                        onChange={(event) =>
                          setOtherRequestType(event.target.value)
                        }
                        placeholder="Describe the request type"
                        value={otherRequestType}
                      />
                    </Field>
                  </div>
                ) : null}

                <div className="sm:col-span-2">
                  <Field label="Request Date">
                    <Input
                      className="text-phx-md"
                      onChange={(event) =>
                        setRequestDate(event.target.value)
                      }
                      type="date"
                      value={requestDate}
                    />
                  </Field>
                </div>

                <div className="sm:col-span-2">
                  <Field label="Pay Date">
                    <Input
                      className="text-phx-md"
                      onChange={(event) =>
                        setPayDate(event.target.value)
                      }
                      type="date"
                      value={payDate}
                    />
                  </Field>
                </div>

                <div className="sm:col-span-2">
                  <Field label="ROI Duration (months)">
                    <Input
                      className="text-phx-md"
                      min="1"
                      onChange={(event) =>
                        setRoiDurationMonths(event.target.value)
                      }
                      type="number"
                      value={roiDurationMonths}
                    />
                    {/* 🔴 IT WARNS, IT DOES NOT CAP (owner, 2026-10-02: "don't cap the ROI
                        duration, make it at the entry"). A long campaign is his to run, so
                        nothing here refuses a number and nothing downstream trims one — the
                        window stays whatever was typed. What this catches is the TYPO, at the
                        only moment it is cheap: MKT-REQ-20260822-7A234FB1 carries 312 months, a
                        window running to 2052, and a campaign that can never be judged reads
                        "waiting for the data" for twenty-six years without ever looking wrong. */}
                    {roiMonthsWarning(roiDurationMonths) ? (
                      <p className="mt-1 border border-amber-200 bg-amber-50 px-2 py-1 text-phx-xs font-semibold text-amber-800">
                        {roiMonthsWarning(roiDurationMonths)}
                      </p>
                    ) : null}
                  </Field>
                </div>

                <div className="sm:col-span-3">
                  <Field label="Estimated Cost (EGP)">
                    <Input
                      className="text-phx-md"
                      min="0"
                      onChange={(event) =>
                        setEstimatedCost(event.target.value)
                      }
                      placeholder="0"
                      type="number"
                      value={estimatedCost}
                    />
                  </Field>
                </div>

                {/* ------ Product Lines --------------------------------------------------------------------------------------------------------- */}
                <div className="sm:col-span-6">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">
                          Products
                        </p>
                        {/* A null requesterLineId means BOTH "oversight role, every line" and
                            "requester has no line assigned" — the second case gets an empty
                            product list, so labelling it "All available products" told the
                            requester the exact opposite of the truth. requesterLineName is the
                            honest discriminator: the server sets it to "All product lines" for
                            an unrestricted role and to null only when no line is assigned. */}
                        {workspace.requesterLineName === null ? (
                          <p className="mt-0.5 text-phx-xs font-semibold text-amber-600">
                            No product line assigned — contact HR
                          </p>
                        ) : (
                          <p className="mt-0.5 text-phx-xs font-medium text-slate-400">
                            {workspace.requesterLineId === null
                              ? "All available products"
                              : `Line: ${workspace.requesterLineName}`}
                          </p>
                        )}
                      </div>
                      <button
                        className={`flex items-center gap-1 border border-slate-200 bg-white px-2.5 py-1.5 text-phx-xs font-bold text-slate-700 transition hover:bg-slate-50 ${adminControlDepthClassName}`}
                        onClick={addProductLine}
                        type="button"
                      >
                        <PackagePlus className="h-3 w-3" />
                        Add
                      </button>
                    </div>

                    {productLines.map((line) => {
                      const product = productMap.get(line.productId);
                      return (
                        <div
                          className={`border border-slate-200 bg-slate-50/50 p-2.5 ${adminSoftDepthClassName}`}
                          key={line.key}
                        >
                          {/* Desktop layout */}
                          <div className="hidden sm:grid gap-2 sm:grid-cols-[minmax(0,1fr)_100px_100px_120px_80px_36px]">
                            <SelectField
                              disabled={visibleProducts.length === 0}
                              onChange={(value) =>
                                updateProductLine(line.key, {
                                  productId: value,
                                })
                              }
                              value={line.productId}
                            >
                              <option value="">
                                {visibleProducts.length === 0
                                  ? "No products"
                                  : "Select product"}
                              </option>
                              {visibleProducts.map((item) => (
                                <option
                                  key={item.id}
                                  value={item.id}
                                >
                                  {item.productName} -{" "}
                                  {egp(item.factoryPrice)}
                                </option>
                              ))}
                            </SelectField>
                            <Input
                              className="text-phx-md"
                              min="0"
                              onChange={(event) =>
                                updateProductLine(line.key, {
                                  quantity: event.target.value,
                                })
                              }
                              placeholder="Qty"
                              type="number"
                              value={line.quantity}
                            />
                            <ReadOnlyValue
                              label="Unit"
                              value={
                                product
                                  ? egp(product.factoryPrice)
                                  : "-"
                              }
                            />
                            <ReadOnlyValue
                              label="Value"
                              value={
                                product
                                  ? egp(
                                      fieldNumber(line.quantity) *
                                        product.factoryPrice,
                                    )
                                  : "-"
                              }
                            />
                            <ReadOnlyValue
                              label="Share"
                              value={
                                product &&
                                roiPreview.expectedRoiValue > 0
                                  ? `${Math.round(
                                      ((fieldNumber(line.quantity) *
                                        product.factoryPrice) /
                                        roiPreview.expectedRoiValue) *
                                        100,
                                    )}%`
                                  : "0%"
                              }
                            />
                            <button
                              aria-label="Remove product"
                              className={`flex h-10 w-full items-center justify-center border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 ${adminControlDepthClassName}`}
                              onClick={() =>
                                removeProductLine(line.key)
                              }
                              type="button"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          {/* Mobile layout (#6 --- short product names) */}
                          <div className="block md:hidden space-y-2">
                            <SelectField
                              disabled={visibleProducts.length === 0}
                              onChange={(value) =>
                                updateProductLine(line.key, {
                                  productId: value,
                                })
                              }
                              value={line.productId}
                            >
                              <option value="">
                                {visibleProducts.length === 0
                                  ? "No products"
                                  : "Select product"}
                              </option>
                              {visibleProducts.map((item) => (
                                <option
                                  key={item.id}
                                  value={item.id}
                                >
                                  {shortProductName(item.productName)}{" "}
                                  - {egp(item.factoryPrice)}
                                </option>
                              ))}
                            </SelectField>
                            <div className="grid grid-cols-[1fr_auto] gap-2">
                              <Input
                                className="text-phx-md"
                                min="0"
                                onChange={(event) =>
                                  updateProductLine(line.key, {
                                    quantity: event.target.value,
                                  })
                                }
                                placeholder="Quantity"
                                type="number"
                                value={line.quantity}
                              />
                              <button
                                aria-label="Remove product"
                                className={`flex h-10 w-10 items-center justify-center border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 ${adminControlDepthClassName}`}
                                onClick={() =>
                                  removeProductLine(line.key)
                                }
                                type="button"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            {product && (
                              <div className="grid grid-cols-3 gap-1.5">
                                <ReadOnlyValue
                                  label="Unit"
                                  value={egp(product.factoryPrice)}
                                />
                                <ReadOnlyValue
                                  label="Value"
                                  value={egp(
                                    fieldNumber(line.quantity) *
                                      product.factoryPrice,
                                  )}
                                />
                                <ReadOnlyValue
                                  label="Share"
                                  value={
                                    roiPreview.expectedRoiValue > 0
                                      ? `${Math.round(
                                          ((fieldNumber(line.quantity) *
                                            product.factoryPrice) /
                                            roiPreview.expectedRoiValue) *
                                            100,
                                        )}%`
                                      : "0%"
                                  }
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ------ Notes --------------------------------------------------------------------------------------------------------------------------------- */}
                <div className="sm:col-span-6">
                  <Field label="Note">
                    <textarea
                      className={cn(phxTextareaClassName, "min-h-20")}
                      onChange={(event) => setNotes(event.target.value)}
                      placeholder="Optional request note"
                      value={notes}
                    />
                  </Field>
                </div>
              </div>

              {/* Form footer */}
              <div className="border-t border-slate-100 bg-slate-50/50 px-4 py-3">
                {/*
                  Why Save is refusing. A disabled button carries no tooltip — its pointer events
                  are off — so without this line the requester is told nothing at all, and the two
                  gates that actually fire in production both sit far above the fold: the customer
                  select at the very top, and the unrecognised-code justification inside Target
                  Pharmacies. Named beside the button rather than at the offending field, because
                  the button is where she is looking when the tap does nothing.

                  Only the first blocker is spelled out, with a count of the rest, so the line
                  stays on one row on a phone. It disappears while saving on its own: canSave is
                  false for the whole request then, but saveBlockers is empty, which is the right
                  answer — nothing is missing, it is in flight.
                */}
                {saveBlockers.length > 0 ? (
                  <p
                    className="mb-2 flex items-center gap-1.5 text-phx-sm font-bold text-amber-700"
                    id={SAVE_BLOCKED_HINT_ID}
                  >
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0">{saveBlockers[0]}</span>
                    {saveBlockers.length > 1 ? (
                      <span className="shrink-0 font-semibold text-amber-600">
                        +{saveBlockers.length - 1} more
                      </span>
                    ) : null}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2 text-phx-md font-bold text-slate-700">
                    <TrendingUp className="h-4 w-4 shrink-0 text-orange-500" />
                    <span>
                      Required ROI: {egp(roiPreview.requiredRoiValue)}
                    </span>
                  </div>
                  <Button
                    aria-describedby={
                      saveBlockers.length > 0 ? SAVE_BLOCKED_HINT_ID : undefined
                    }
                    className="min-h-10 gap-1.5 bg-orange-500 px-5 text-phx-md font-bold text-white shadow-sm hover:bg-orange-600"
                    disabled={!canSave}
                    type="submit"
                  >
                    {isSaving ? (
                      <LoadingSpinner className="text-white" />
                    ) : resubmitRequestId ? (
                      <RefreshCcw className="h-3.5 w-3.5" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    {resubmitRequestId ? "Resubmit Request" : "Save Draft"}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </Card>

        {/* ------ ROI Preview Card --------------------------------------------------------------------------------------------------------------------- */}
        <Card className="border border-slate-200 bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center bg-orange-50 text-orange-600 ring-1 ring-orange-100">
              <BarChart3 className="h-3.5 w-3.5" />
            </div>
            <div>
              <p className="text-phx-md font-black text-slate-950">
                ROI Preview
              </p>
              <p className="text-phx-2xs font-medium text-slate-400">
                Recalculates on save
              </p>
            </div>
          </div>

          {/* ROI metrics row */}
          <div className="mt-3 grid gap-2 grid-cols-2 xs:grid-cols-4">
            <RoiMetric
              label="Est. Cost"
              value={egp(fieldNumber(estimatedCost))}
            />
            <RoiMetric
              label="Required"
              value={egp(roiPreview.requiredRoiValue)}
            />
            <RoiMetric
              label="Expected"
              value={egp(roiPreview.expectedRoiValue)}
            />
            <RoiMetric label={ROI_FORECAST_COVERAGE_LABEL} value={`${coveragePct}%`} />
          </div>

          {/* Smart coverage bar --- green/amber/red */}
          <div className="mt-2 overflow-hidden bg-slate-100">
            <div className="flex h-2 w-full overflow-hidden">
              <div
                className={`h-full bg-gradient-to-r ${coverageGradient(coveragePct)} transition-all duration-500`}
                style={{ width: `${coveragePct}%` }}
              />
            </div>
          </div>

          {/* Capture quality — trust in the FUTURE ROI, scored from what the requester can still fix. */}
          <div
            className={`mt-3 border px-3 py-2 ${
              captureHasInput
                ? CAPTURE_BAND_STYLE[captureConfidence.band]
                : "border-slate-200 bg-slate-50 text-slate-500"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-phx-2xs font-bold uppercase tracking-[0.10em]">
                Capture Quality
              </span>
              {captureHasInput ? (
                <span className="text-phx-md font-black">
                  {captureConfidence.score}
                  <span className="text-phx-2xs font-bold">/100</span>
                </span>
              ) : (
                <span className="text-phx-xs font-bold">Not scored yet</span>
              )}
            </div>
            <p className="mt-1 text-phx-xs font-medium leading-snug">
              {!captureHasInput
                ? "Pick the customer, products and pay date — the score shows how measurable this request will be."
                : captureConfidence.weakest
                  ? captureConfidence.weakest.detail
                  : "Everything needed to measure this request is captured."}
            </p>
          </div>

          {/* Product ROI table --- Desktop */}
          <div className="mt-3 hidden md:block overflow-hidden border border-slate-200">
            {isLoading ? (
              <TableSkeleton cols={5} rows={3} />
            ) : (
              <table className="w-full table-fixed border-collapse text-left text-phx-md">
                <colgroup>
                  <col className="w-[34%]" />
                  <col className="w-[12%]" />
                  <col className="w-[18%]" />
                  <col className="w-[20%]" />
                  <col className="w-[16%]" />
                </colgroup>
                <thead className="bg-slate-50 text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500">
                  <tr>
                    <th className="border-b border-r border-slate-100 px-3 py-2">
                      Product
                    </th>
                    <th className="border-b border-r border-slate-100 px-3 py-2 text-right">
                      Qty
                    </th>
                    <th className="border-b border-r border-slate-100 px-3 py-2 text-right">
                      Unit Price
                    </th>
                    <th className="border-b border-r border-slate-100 px-3 py-2 text-right">
                      ROI Value
                    </th>
                    <th className="border-b border-slate-100 px-3 py-2 text-right">
                      Share
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {productLineMetrics.map((product) => (
                    <tr key={product.key}>
                      <td className="min-w-0 break-words border-r border-slate-100 px-3 py-2 font-bold text-slate-950">
                        {product.productName}
                      </td>
                      <td className="border-r border-slate-100 px-3 py-2 text-right font-medium text-slate-600">
                        {product.quantity}
                      </td>
                      <td className="border-r border-slate-100 px-3 py-2 text-right font-medium text-slate-600">
                        {egp(product.factoryPrice)}
                      </td>
                      <td className="border-r border-slate-100 px-3 py-2 text-right font-bold text-slate-950">
                        {egp(product.expectedValue)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <ShareBar
                          pct={Math.round(product.valueShare * 100)}
                        />
                      </td>
                    </tr>
                  ))}
                  {productLineMetrics.length === 0 ? (
                    <tr>
                      <td
                        className="px-3 py-5 text-center text-phx-sm font-medium text-slate-400"
                        colSpan={5}
                      >
                        Add product quantities to preview ROI.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            )}
          </div>

          {/* Product ROI --- Mobile cards */}
          <div className="mt-3 block md:hidden space-y-2">
            {productLineMetrics.length === 0 ? (
              <p className="border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-phx-xs font-medium text-slate-400">
                Add product quantities to preview ROI.
              </p>
            ) : (
              productLineMetrics.map((product) => (
                <div
                  key={product.key}
                  className={`border border-slate-200 bg-slate-50 p-3 space-y-1.5 ${adminPanelDepthClassName}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-phx-md font-bold text-slate-950">
                      {product.productName}
                    </p>
                    <span className="text-phx-sm font-black text-orange-600">
                      {Math.round(product.valueShare * 100)}%
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden bg-slate-200">
                    <div
                      className="h-full bg-gradient-to-r from-orange-500 to-orange-200"
                      style={{
                        width: `${Math.min(Math.round(product.valueShare * 100), 100)}%`,
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-phx-2xs">
                    <div>
                      <span className="font-medium text-slate-400">
                        Qty
                      </span>
                      <p className="font-bold text-slate-700">
                        {product.quantity}
                      </p>
                    </div>
                    <div>
                      <span className="font-medium text-slate-400">
                        Unit
                      </span>
                      <p className="font-bold text-slate-700">
                        {egp(product.factoryPrice)}
                      </p>
                    </div>
                    <div>
                      <span className="font-medium text-slate-400">
                        Value
                      </span>
                      <p className="font-bold text-slate-950">
                        {egp(product.expectedValue)}
                      </p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* ------ Draft Rows Card ------------------------------------------------------------------------------------------------------------------------ */}
        <Card className="border border-slate-200 bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center bg-slate-100 text-slate-600 ring-1 ring-slate-200">
              <ListChecks className="h-3.5 w-3.5" />
            </div>
            <div>
              <p className="text-phx-md font-black text-slate-950">
                Draft Rows
              </p>
              {workspace.drafts.length > 0 ? (
                <p className="text-phx-2xs font-medium text-slate-400">
                  {`${Math.min(workspace.drafts.length, 6)} of ${workspace.drafts.length} shown`}
                </p>
              ) : null}
            </div>
          </div>
          <div className="mt-3 space-y-1.5">
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="animate-pulse border border-slate-100 bg-slate-50 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-2">
                      <div className="h-2.5 w-20 bg-slate-200" />
                      <div className="h-4 w-16 bg-slate-200" />
                    </div>
                    <div className="h-5 w-20 bg-slate-200" />
                  </div>
                  <div className="mt-2 h-2.5 w-24 bg-slate-200" />
                </div>
              ))
            ) : (
              <>
                {workspace.drafts.slice(0, 6).map((draft) => (
                  <div
                    className={`border p-2.5 transition-colors duration-700 ${
                      highlightDraftId === draft.id
                        ? "border-orange-300 bg-orange-50/60"
                        : "border-slate-100 bg-slate-50/60"
                    }`}
                    key={draft.id}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-mono text-phx-2xs font-bold text-slate-500">
                          {draft.requestCode}
                        </p>
                        <p className="mt-0.5 text-phx-md font-black text-slate-950">
                          {egp(draft.estimatedCost)}
                        </p>
                      </div>
                      <Badge
                        variant={roiBadgeVariant(draft.roiStatus)}
                      >
                        {forecastRoiStatusLabel(draft.roiStatus)}
                      </Badge>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1 text-phx-2xs font-medium text-slate-400">
                        <CalendarDays className="h-2.5 w-2.5" />
                        {draft.requestDate}
                      </span>
                      <span className="text-phx-2xs font-bold text-slate-500">
                        {Math.round(draft.roiCoverageRatio * 100)}%
                        {" "}forecast coverage
                      </span>
                    </div>
                  </div>
                ))}
                {workspace.drafts.length === 0 ? (
                  <p className="border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-phx-sm font-medium text-slate-400">
                    No draft rows yet.
                  </p>
                ) : (
                  <p className="mt-1 text-center text-phx-2xs font-semibold text-slate-400">
                    Forecast only — {ROI_ACTUAL_IN_TRACKING_NOTE}.
                  </p>
                )}
              </>
            )}
          </div>
        </Card>
      </div>

      {/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */}
      {/* ------ APPROVED REQUESTS TAB  (#1 focus trap) --------------------------------------------------------- */}
      {/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */}
      <div
        ref={approvedPanelRef}
        className={activeView === "approved" ? "space-y-3" : "hidden"}
      >
        <Card className="overflow-hidden border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-phx-2xs font-bold uppercase tracking-[0.14em] text-orange-600">
                  Finance Evidence
                </p>
                <h2 className="mt-0.5 text-phx-lg font-black tracking-tight text-slate-950">
                  Approved Requests
                </h2>
              </div>
              <Badge variant="neutral">
                {filteredApproved.length === workspace.approvedRequests.length
                  ? `${workspace.approvedRequests.length} rows`
                  : `${filteredApproved.length} / ${workspace.approvedRequests.length}`}
              </Badge>
            </div>

            {/* #7 --- Search input */}
            {workspace.approvedRequests.length > 0 && (
              <div className="relative mt-2">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  className={cn(phxFieldClassName, "pl-8")}
                  onChange={(e) => setApprovedSearch(e.target.value)}
                  placeholder="Search customer, contact, code, date..."
                  type="text"
                  value={approvedSearch}
                />
              </div>
            )}
          </div>

          {isLoading ? (
            <TableSkeleton cols={6} rows={4} />
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block">
                <table className="w-full table-fixed border-collapse text-left text-phx-sm">
                  <colgroup>
                    <col className="w-[18%]" />
                    <col className="w-[11%]" />
                    <col className="w-[16%]" />
                    <col className="w-[10%]" />
                    <col className="w-[11%]" />
                    <col className="w-[17%]" />
                    <col className="w-[17%]" />
                  </colgroup>
                  <thead className="bg-slate-50 text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500">
                    <tr>
                      <th className="border-b border-r border-slate-100 px-3 py-2">
                        Customer &amp; Contact
                      </th>
                      <th className="border-b border-r border-slate-100 px-3 py-2">
                        Transfer Date &amp; Line
                      </th>
                      <th className="border-b border-r border-slate-100 px-3 py-2">
                        Notes
                      </th>
                      <th className="border-b border-r border-slate-100 px-3 py-2 text-right">
                        Amount
                      </th>
                      <th className="border-b border-r border-slate-100 px-3 py-2">
                        Invoice due
                      </th>
                      <th className="border-b border-r border-slate-100 px-3 py-2">
                        Proof
                      </th>
                      <th className="border-b border-slate-100 px-3 py-2">
                        Invoice
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {filteredApproved.map((row) => (
                      <tr key={row.id} className="align-top">
                        <td className="min-w-0 break-words border-r border-slate-100 px-3 py-2" dir="auto">
                          <p className="font-bold text-slate-900">{row.customerName}</p>
                          <p className="mt-0.5 font-medium text-slate-600">{row.contactForMoneyTransfer}</p>
                        </td>
                        <td className="min-w-0 break-words border-r border-slate-100 px-3 py-2 font-medium text-slate-600">
                          {transferDateLabel(row.moneyTransferDate)}
                          <span className="mt-0.5 block">{row.line ?? "—"}</span>
                        </td>
                        <td className="min-w-0 break-words border-r border-slate-100 px-3 py-2 text-slate-500">
                          <p className="text-phx-xs font-medium break-words" dir="auto">
                            {row.notes || "—"}
                          </p>
                        </td>
                        <td className="border-r border-slate-100 min-w-0 break-words px-3 py-2 text-right font-bold text-slate-900">
                          {egp(row.sumOfAmount)}
                        </td>
                        {/* The invoice this approval obliges, and whether it is late. The status
                            is derived from the deadline at read time, never read raw — see
                            src/lib/marketing-requests/invoice-obligation.ts. */}
                        <td className="min-w-0 break-words border-r border-slate-100 px-3 py-2">
                          {row.invoiceDaysOverdue > 0 ? (
                            <span className="inline-block border border-rose-200 bg-rose-50 px-2 py-0.5 text-phx-2xs font-bold text-rose-700">
                              {row.invoiceDueLabel}
                            </span>
                          ) : (
                            <span className="font-medium text-slate-600">
                              {row.invoiceDueLabel}
                            </span>
                          )}
                        </td>
                        <td className="min-w-0 break-words border-r border-slate-100 px-3 py-2">
                          {workspace.canUploadMoneyTransferProof ? (
                            <EvidenceUpload
                              accept="image/jpeg,image/png,image/webp"
                              fileName={row.financeProofFileName}
                              isUploading={
                                uploadingEvidenceKey ===
                                `${row.id}:money_transfer_proof`
                              }
                              label="Upload proof"
                              onUpload={(file) =>
                                void uploadFinanceEvidence(
                                  row.id,
                                  "money_transfer_proof",
                                  file,
                                )
                              }
                            />
                          ) : (
                            <EvidenceOnFile
                              fileName={row.financeProofFileName}
                              label="Transfer proof"
                            />
                          )}
                          <DirectOrderSettleControl
                            canSettle={workspace.canSettleAgainstDirectOrder}
                            onChanged={applyDirectOrderOffset}
                            onMessage={showMessage}
                            row={row}
                          />
                        </td>
                        <td className="min-w-0 break-words px-3 py-2">
                          <EvidenceUpload
                            accept="image/jpeg,image/png,image/webp,application/pdf"
                            fileName={row.invoiceFileName}
                            isUploading={
                              uploadingEvidenceKey ===
                              `${row.id}:invoice`
                            }
                            label="Upload invoice"
                            onUpload={(file) =>
                              void uploadFinanceEvidence(
                                row.id,
                                "invoice",
                                file,
                              )
                            }
                          />
                        </td>
                      </tr>
                    ))}
                    {filteredApproved.length === 0 ? (
                      <tr>
                        <td
                          className="px-3 py-6 text-center text-phx-sm font-medium text-slate-400"
                          colSpan={7}
                        >
                          {approvedSearch
                            ? "No matching approved requests."
                            : "No approved requests are available yet."}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="block md:hidden divide-y divide-slate-100">
                {filteredApproved.length === 0 ? (
                  <p className="px-4 py-5 text-center text-phx-xs font-medium text-slate-400">
                    {approvedSearch
                      ? "No matching results."
                      : "No approved requests yet."}
                  </p>
                ) : (
                  filteredApproved.map((row) => (
                    <div key={row.id} className="space-y-2 px-3 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-phx-md font-bold text-slate-950" dir="auto">
                            {row.customerName}
                          </p>
                          <p className="mt-0.5 text-phx-2xs font-medium text-slate-400" dir="auto">
                            {row.contactForMoneyTransfer}
                          </p>
                        </div>
                        <span className="shrink-0 bg-slate-100 px-2 py-0.5 text-phx-sm font-black text-slate-900">
                          {egp(row.sumOfAmount)}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-phx-2xs">
                        <span className="font-medium text-slate-400">
                          Transfer
                        </span>
                        <span className="text-right font-bold text-slate-600">
                          {transferDateLabel(row.moneyTransferDate)}
                        </span>
                        <span className="font-medium text-slate-400">
                          Line
                        </span>
                        <span className="text-right font-bold text-slate-600">
                          {row.line ?? "-"}
                        </span>
                        <span className="font-medium text-slate-400">
                          Invoice due
                        </span>
                        <span
                          className={
                            row.invoiceDaysOverdue > 0
                              ? "whitespace-nowrap text-right font-black text-rose-700"
                              : "whitespace-nowrap text-right font-bold text-slate-600"
                          }
                        >
                          {row.invoiceDueLabel}
                        </span>
                      </div>

                      {row.notes ? (
                        <p className="text-phx-2xs font-medium text-slate-500 break-words" dir="auto">
                          {row.notes}
                        </p>
                      ) : null}

                      <div className="grid grid-cols-2 gap-1.5 pt-0.5">
                        {workspace.canUploadMoneyTransferProof ? (
                          <EvidenceUpload
                            accept="image/jpeg,image/png,image/webp"
                            fileName={row.financeProofFileName}
                            isUploading={
                              uploadingEvidenceKey ===
                              `${row.id}:money_transfer_proof`
                            }
                            label="Proof"
                            onUpload={(file) =>
                              void uploadFinanceEvidence(
                                row.id,
                                "money_transfer_proof",
                                file,
                              )
                            }
                          />
                        ) : (
                          <EvidenceOnFile
                            fileName={row.financeProofFileName}
                            label="Proof"
                          />
                        )}
                        <EvidenceUpload
                          accept="image/jpeg,image/png,image/webp,application/pdf"
                          fileName={row.invoiceFileName}
                          isUploading={
                            uploadingEvidenceKey ===
                            `${row.id}:invoice`
                          }
                          label="Invoice"
                          onUpload={(file) =>
                            void uploadFinanceEvidence(
                              row.id,
                              "invoice",
                              file,
                            )
                          }
                        />
                      </div>
                      <DirectOrderSettleControl
                        canSettle={workspace.canSettleAgainstDirectOrder}
                        onChanged={applyDirectOrderOffset}
                        onMessage={showMessage}
                        row={row}
                      />
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */}
      {/* ------ TRACKING TAB  (#1 focus trap) ----------------------------------------------------------------------- */}
      {/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */}
      <div
        ref={trackingPanelRef}
        className={activeView === "tracking" ? "space-y-3" : "hidden"}
      >
        {/* ------ Returned to me ----------------------------------------------------------------------------------------------------------------------------- */}
        <Card className="overflow-hidden border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-phx-2xs font-bold uppercase tracking-[0.14em] text-amber-600">
                  Action Needed
                </p>
                <h2 className="mt-0.5 text-phx-lg font-black tracking-tight text-slate-950">
                  Returned to me
                </h2>
              </div>
              <Badge variant="warning">
                {workspace.returnedToMe.length} returned
              </Badge>
            </div>
          </div>
          <div className="space-y-1.5 p-4">
            {isLoading ? (
              <TableSkeleton cols={3} rows={2} />
            ) : workspace.returnedToMe.length === 0 ? (
              <p className="border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-phx-sm font-medium text-slate-400">
                Nothing returned to you right now.
              </p>
            ) : (
              workspace.returnedToMe.map((request) => {
                const progress =
                  workspace.stepProgressByRequestId[request.id] ?? null;
                return (
                  <div
                    className="border border-amber-200 bg-amber-50/40 p-3"
                    key={request.id}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-phx-md font-black text-slate-950" dir="auto">
                          {customerNameMap.get(request.customerId) ??
                            "Customer"}
                        </p>
                        <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
                          {requestTypeNameMap.get(request.requestTypeId) ??
                            "Request"}{" "}
                          · {egp(request.estimatedCost)}
                        </p>
                        <p className="mt-0.5 font-mono text-phx-3xs font-medium text-slate-400">
                          Ref {request.requestCode}
                        </p>
                      </div>
                      <button
                        className={cn(phxButtonAccentClassName, "shrink-0")}
                        onClick={() => void startResubmit(request)}
                        type="button"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit &amp; Resubmit
                      </button>
                    </div>
                    {progress?.returnReason ? (
                      <p className="mt-2 border border-amber-200 bg-white px-2.5 py-1.5 text-phx-xs font-medium text-amber-800">
                        <span className="font-bold">Return reason: </span>
                        {progress.returnReason}
                      </p>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </Card>

        {/* ------ In approval -------------------------------------------------------------------------------------------------------------------------------- */}
        <Card className="overflow-hidden border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-phx-2xs font-bold uppercase tracking-[0.14em] text-orange-600">
                  In Flight
                </p>
                <h2 className="mt-0.5 text-phx-lg font-black tracking-tight text-slate-950">
                  In approval
                </h2>
              </div>
              <Badge variant="neutral">
                {workspace.inApproval.length} pending
              </Badge>
            </div>
          </div>
          <div className="space-y-1.5 p-4">
            {isLoading ? (
              <TableSkeleton cols={3} rows={3} />
            ) : workspace.inApproval.length === 0 ? (
              <p className="border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-phx-sm font-medium text-slate-400">
                No requests are currently in approval.
              </p>
            ) : (
              workspace.inApproval.map((request) => {
                const progress =
                  workspace.stepProgressByRequestId[request.id] ?? null;
                const expanded = expandedTrackingId === request.id;
                const detail = detailCache[request.id];
                return (
                  <div
                    className={`border border-slate-200 bg-slate-50/50 p-3 ${adminSoftDepthClassName}`}
                    key={request.id}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-phx-md font-black text-slate-950" dir="auto">
                          {customerNameMap.get(request.customerId) ??
                            "Customer"}
                        </p>
                        <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
                          {requestTypeNameMap.get(request.requestTypeId) ??
                            "Request"}{" "}
                          · {egp(request.estimatedCost)}
                        </p>
                        <p className="mt-0.5 font-mono text-phx-3xs font-medium text-slate-400">
                          Ref {request.requestCode}
                        </p>
                      </div>
                      <button
                        aria-expanded={expanded}
                        className={`flex shrink-0 items-center gap-1 border border-slate-200 bg-white px-2.5 py-1.5 text-phx-xs font-bold text-slate-700 transition hover:bg-slate-50 ${adminControlDepthClassName}`}
                        onClick={() =>
                          void toggleTrackingExpand(request.id)
                        }
                        type="button"
                      >
                        {expanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        {expanded ? "Hide timeline" : "View timeline"}
                      </button>
                    </div>

                    <div className="mt-2">
                      <MarketingProgressStrip
                        progress={progress}
                        requestId={request.id}
                        status={request.status}
                      />
                    </div>

                    {expanded ? (
                      <div className="mt-2 border-t border-slate-200 pt-2">
                        {loadingDetailId === request.id && !detail ? (
                          <div className="flex items-center gap-2 px-1 py-2 text-phx-xs font-medium text-slate-400">
                            <LoadingSpinner />
                            Loading timeline...
                          </div>
                        ) : detail ? (
                          <>
                            <MarketingApprovalTimeline requestCode={request.requestCode} steps={detail.steps} />
                            {detail.viewerCanComment ? (
                              <div className="mt-3 border border-sky-200 bg-sky-50/40 px-3 py-3">
                                <p className="mb-1.5 text-phx-xs font-bold uppercase tracking-[0.12em] text-sky-700">
                                  Add your comment
                                </p>
                                <MarketingAdvisoryCommentBox
                                  onPosted={() =>
                                    setDetailCache((current) => {
                                      const next = { ...current };
                                      delete next[detail.request.id];
                                      return next;
                                    })
                                  }
                                  requestId={detail.request.id}
                                />
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <p className="px-1 py-2 text-phx-xs font-medium text-slate-400">
                            Timeline unavailable.
                          </p>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </Card>

        {/* ------ Rejected ----------------------------------------------------------------------------------------------------------------------------------- */}
        {/*
          Refused requests. This card is the whole point of the change that added it: `rejected` was
          the one requester-reachable status the workspace never queried, so a refused request —
          and the rejection reason, the only place the "why" is written down at all — appeared on no
          screen, not even to the person who raised it.

          The reason is shown INLINE rather than behind the "View timeline" disclosure the other
          cards use. A requester opening this card has exactly one question, and making them click
          to reach the answer is the failure this card exists to end.
        */}
        <Card className="overflow-hidden border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="border-b border-slate-100 bg-rose-50/60 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-phx-2xs font-bold uppercase tracking-[0.14em] text-rose-600">
                  Not Proceeding
                </p>
                <h2 className="mt-0.5 text-phx-lg font-black tracking-tight text-slate-950">
                  Rejected
                </h2>
              </div>
              <Badge variant="neutral">
                {workspace.rejected.length} rejected
              </Badge>
            </div>
          </div>
          <div className="space-y-1.5 p-4">
            {isLoading ? (
              <TableSkeleton cols={3} rows={2} />
            ) : workspace.rejected.length === 0 ? (
              <p className="border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-phx-sm font-medium text-slate-400">
                No requests have been rejected.
              </p>
            ) : (
              workspace.rejected.map((request) => {
                const rejection =
                  workspace.rejectionByRequestId[request.id] ?? null;
                return (
                  <div
                    className="border border-rose-200 bg-rose-50/30 p-3"
                    key={request.id}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-phx-md font-black text-slate-950" dir="auto">
                          {customerNameMap.get(request.customerId) ??
                            "Customer"}
                        </p>
                        <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
                          {requestTypeNameMap.get(request.requestTypeId) ??
                            "Request"}{" "}
                          · {egp(request.estimatedCost)}
                        </p>
                        <p className="mt-0.5 font-mono text-phx-3xs font-medium text-slate-400">
                          Ref {request.requestCode}
                        </p>
                      </div>
                      <span className="shrink-0 border border-rose-200 bg-white px-1.5 py-0.5 text-phx-2xs font-bold uppercase tracking-[0.06em] text-rose-700">
                        Rejected
                      </span>
                    </div>

                    <div className="mt-2 border-t border-rose-200/70 pt-2">
                      {rejection ? (
                        <>
                          {/*
                            Labelled fields, NOT one prose sentence. Measured in a real browser at
                            375px: "Rejected by <name> at <step> · <date>" wraps to 2 lines in a
                            253px content box at 11px, and the standing rule forbids wrapping AND
                            ellipsis — so the fix has to be structural, not a restyle. Each value
                            gets its own row, which fits at both 375px and desktop.
                          */}
                          <dl className="space-y-1">
                            {([
                              ["Rejected by", rejection.decidedByName || "An approver"],
                              ["At step", rejection.stepName],
                              ["When", rejection.decidedAtLabel],
                            ] as Array<[string, string | null]>)
                              .filter(([, value]) => Boolean(value))
                              .map(([label, value]) => (
                                <div className="flex items-baseline gap-2" key={label}>
                                  <dt className="w-[66px] shrink-0 text-phx-3xs font-bold uppercase tracking-[0.08em] text-rose-700/70">
                                    {label}
                                  </dt>
                                  <dd className="min-w-0 text-phx-xs font-bold text-slate-700">
                                    {value}
                                  </dd>
                                </div>
                              ))}
                          </dl>
                          {rejection.reason ? (
                            <p className="mt-1.5 border border-rose-200 bg-white px-2.5 py-1.5 text-phx-xs font-medium text-rose-900">
                              <span className="font-bold">Reason: </span>
                              {rejection.reason}
                            </p>
                          ) : (
                            <p className="mt-1.5 text-phx-xs font-medium text-slate-400">
                              No reason was recorded.
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="text-phx-xs font-medium text-slate-400">
                          Rejection details unavailable — the approval chain for
                          this request could not be read.
                        </p>
                      )}
                    </div>

                    {/* A rejected request is never closed to conversation (owner rule, 2026-09-22):
                        the requester can ask why it was refused and the approver can answer, right
                        here. Every message emails the requester, cc's everyone on the request, and
                        pings them in-app / Telegram. */}
                    <div className="mt-2 border-t border-rose-200/70 pt-2">
                      <button
                        aria-expanded={
                          openRejectedConversationId === request.id
                        }
                        className="flex w-full items-center justify-center gap-1.5 border border-rose-200 bg-white px-2.5 py-2 text-phx-xs font-bold text-rose-700 transition hover:bg-rose-50"
                        onClick={() =>
                          setOpenRejectedConversationId((current) =>
                            current === request.id ? null : request.id,
                          )
                        }
                        type="button"
                      >
                        <MessageCircle className="h-3.5 w-3.5" />
                        {openRejectedConversationId === request.id
                          ? "Hide conversation"
                          : "Open conversation & reply"}
                      </button>
                      {openRejectedConversationId === request.id ? (
                        <div className="mt-2">
                          <RecordConversationThread
                            base={`/api/marketing-requests/${request.id}/conversation`}
                            key={request.id}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Card>

        {/* ------ Drafts ------------------------------------------------------------------------------------------------------------------------------------- */}
        <Card className="overflow-hidden border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-phx-2xs font-bold uppercase tracking-[0.14em] text-slate-500">
                  Not Submitted
                </p>
                <h2 className="mt-0.5 text-phx-lg font-black tracking-tight text-slate-950">
                  Drafts
                </h2>
              </div>
              <Badge variant="neutral">{workspace.drafts.length} drafts</Badge>
            </div>
          </div>
          <div className="space-y-1.5 p-4">
            {isLoading ? (
              <TableSkeleton cols={3} rows={2} />
            ) : workspace.drafts.length === 0 ? (
              <p className="border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-phx-sm font-medium text-slate-400">
                No drafts yet.
              </p>
            ) : (
              workspace.drafts.map((draft) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 border border-slate-100 bg-slate-50/60 p-3"
                  key={draft.id}
                >
                  <div className="min-w-0">
                    <p className="font-mono text-phx-2xs font-bold text-slate-500">
                      {draft.requestCode}
                    </p>
                    <p className="mt-0.5 text-phx-md font-black text-slate-950">
                      {customerNameMap.get(draft.customerId) ?? "Customer"}
                    </p>
                    <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
                      {requestTypeNameMap.get(draft.requestTypeId) ??
                        "Request"}{" "}
                      · {egp(draft.estimatedCost)}
                    </p>
                  </div>
                  <button
                    className={`flex shrink-0 items-center gap-1 border border-slate-200 bg-white px-2.5 py-1.5 text-phx-xs font-bold text-slate-700 transition hover:bg-slate-50 ${adminControlDepthClassName}`}
                    onClick={() => setActiveView("create")}
                    type="button"
                  >
                    <Pencil className="h-3 w-3" />
                    Continue editing
                  </button>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* ------ Empty-data hint ------------------------------------------------------------------------------------------------------------------------------ */}
      {!isLoading && !workspace.canCreateDraft ? (
        <div className={`border border-slate-200 bg-white px-3 py-2 text-phx-sm font-medium text-slate-500 ${adminSoftDepthClassName}`}>
          You have review access to marketing requests. Draft creation is limited to assigned requesters in the employee directory.
        </div>
      ) : !isLoading &&
        (workspace.customers.length === 0 ||
          workspace.products.length === 0) ? (
        <div className={`border border-slate-200 bg-white px-3 py-2 text-phx-sm font-medium text-slate-500 ${adminSoftDepthClassName}`}>
          {workspace.customers.length === 0
            ? "No active marketing customers available. Customer creation is coming next."
            : "No active marketing products available. Run the reference-data seed."}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Exported wrapper with error boundary --------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

export function MarketingRequestDraftWorkspace() {
  return (
    <WorkspaceErrorBoundary fallbackTitle="Marketing requests workspace error">
      <MarketingRequestDraftWorkspaceInner />
    </WorkspaceErrorBoundary>
  );
}
