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
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileCheck2,
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
import {
  LANDING_FOCUS,
  LANDING_INK,
  LandingBar,
  LandingEmpty,
  LandingMeta,
  LandingTitle,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
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
  phxButtonGhostClassName,
  phxFieldClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { adminControlDepthClassName, adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";


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

/** Capture quality's tone: a rail at the left and a coloured score, never a tinted box. */
const CAPTURE_BAND_TONE: Record<RoiConfidenceBand, { rail: string; text: string }> = {
  high: { rail: "bg-emerald-500", text: "text-emerald-700" },
  medium: { rail: "bg-amber-400", text: "text-amber-700" },
  low: { rail: "bg-rose-500", text: "text-rose-700" },
};

/** The small capitals every label in this workspace is set in. */
const MICRO_LABEL = "text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500";

function fieldNumber(value: string) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A forecast ROI status as coloured small text — the state is the colour, never a filled pill. */
function roiStatusTone(status: string): string {
  if (status === "covers_required") return "text-emerald-700";
  if (status === "under_target") return "text-amber-700";
  return "text-slate-500";
}

function StatusText({ children, tone }: { children: ReactNode; tone: string }) {
  return (
    <span className={cn("min-w-0 break-words text-right text-phx-xs font-bold uppercase tracking-[0.08em]", tone)}>
      {children}
    </span>
  );
}

/** Coverage bar fill, flat: green >= 100%, amber 50-99%, red < 50% */
function coverageFill(pct: number): string {
  if (pct >= 100) return "bg-emerald-500";
  if (pct >= 50) return "bg-amber-400";
  return "bg-rose-500";
}

/**
 * A panel's header row: the kit's tick-and-capitals title, and an optional right slot for a count.
 * The frames around it stay written out at each panel, so each keeps the ground it already drew.
 */
function PanelHeader({ right, title }: { right?: ReactNode; title: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 px-3 py-2.5 sm:px-4">
      <LandingTitle>{title}</LandingTitle>
      {right ? (
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 text-slate-500">{right}</div>
      ) : null}
    </header>
  );
}

/** One request in a list: a 4px rail carrying its state, then the words. Hairline between rows. */
function RailRow({ children, rail }: { children: ReactNode; rail: string }) {
  return (
    <div className="flex min-w-0 gap-3 border-b border-slate-200 px-3 py-3 last:border-b-0 sm:px-4">
      <span aria-hidden="true" className={cn("w-1 shrink-0 self-stretch", rail)} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
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
    <div aria-busy="true" className="min-w-0 bg-white px-3 py-2.5">
      <span className="sr-only">Loading</span>
      <div aria-hidden="true" className="employee-portal-skeleton h-3 w-16" />
      <div aria-hidden="true" className="employee-portal-skeleton mt-2 h-[22px] w-10" />
    </div>
  );
}

function FormSkeleton() {
  return (
    <div aria-busy="true" className="space-y-4 px-3 py-4 sm:px-4">
      <span className="sr-only">Loading</span>
      <div aria-hidden="true" className="employee-portal-skeleton h-4 w-28" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div aria-hidden="true" className="employee-portal-skeleton h-10" />
        <div aria-hidden="true" className="employee-portal-skeleton h-10" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div aria-hidden="true" className="employee-portal-skeleton h-10" />
        <div aria-hidden="true" className="employee-portal-skeleton h-10" />
        <div aria-hidden="true" className="employee-portal-skeleton h-10" />
      </div>
      <div aria-hidden="true" className="employee-portal-skeleton h-10" />
      <div aria-hidden="true" className="employee-portal-skeleton h-20" />
    </div>
  );
}

function TableSkeleton({ cols, rows }: { cols: number; rows: number }) {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className="flex gap-2 border-b border-slate-200 px-3 py-2.5 sm:px-4">
        {Array.from({ length: cols }).map((_, i) => (
          <div aria-hidden="true" key={i} className="employee-portal-skeleton h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex gap-2 border-b border-slate-200 px-3 py-3 last:border-b-0 sm:px-4"
        >
          {Array.from({ length: cols }).map((_, c) => (
            <div aria-hidden="true" key={c} className="employee-portal-skeleton h-3.5 flex-1" />
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

    // Flat fill under the line (no gradient — the kit's flat-colour rule)
    const areaD = `${pathD} L ${w} ${h} L 0 ${h} Z`;

    return { areaD, coords, h, pathD, w };
  }, [drafts]);

  if (!points) return null;

  return (
    <div className="mt-3 border-t border-slate-200 pt-2.5">
      <p className={cn("mb-1.5", MICRO_LABEL)}>
        Cost Trend (last {Math.min(drafts.length, 12)} drafts)
      </p>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${points.w} ${points.h}`}
        className="h-9 w-full"
        preserveAspectRatio="none"
      >
        <path d={points.areaD} fill="#08111f" fillOpacity="0.06" />
        <path
          d={points.pathD}
          fill="none"
          stroke="#08111f"
          strokeWidth="1.5"
          strokeLinecap="square"
          strokeLinejoin="miter"
          vectorEffect="non-scaling-stroke"
        />
        {/* Latest point: a square mark, the kit's 90° corners */}
        <rect
          x={points.coords[points.coords.length - 1].x - 2.5}
          y={points.coords[points.coords.length - 1].y - 2.5}
          width="5"
          height="5"
          fill="#08111f"
        />
      </svg>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Sub-components --------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

/** One count in the workspace's figure strip: a small-capital label over a navy tabular figure. */
function MetricCell({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="min-w-0 bg-white px-3 py-2.5">
      <p className={cn("break-words", MICRO_LABEL)}>{label}</p>
      <p className={cn("mt-1 break-words text-[22px] font-bold leading-none tracking-[-0.02em] tabular-nums", LANDING_INK)}>
        {value}
      </p>
    </div>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-500">
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
    <div className="min-w-0 bg-white px-3 py-2.5 sm:px-4">
      <p className={cn("break-words", MICRO_LABEL)}>{label}</p>
      <p className={cn("mt-1 break-words text-phx-md font-bold tabular-nums", LANDING_INK)}>{value}</p>
    </div>
  );
}

function ReadOnlyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className={`flex h-10 min-w-0 flex-col justify-center border border-slate-200 bg-white px-3 ${adminSoftDepthClassName}`}>
      <span className="text-phx-xs font-bold uppercase tracking-[0.10em] text-slate-500">
        {label}
      </span>
      <span className={cn("text-phx-md font-bold tabular-nums", LANDING_INK)}>{value}</span>
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
      <div className="mt-1.5 flex min-w-0 gap-2.5">
        <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-emerald-500" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-phx-xs font-bold text-emerald-700">
            Settled against a direct order — no transfer
          </p>
          <p className={cn("mt-0.5 break-words text-phx-sm font-medium tabular-nums", LANDING_INK)}>
            {row.directOrderOffset.orderLabel} · {egp(row.directOrderOffset.amount)}
          </p>
          {row.directOrderOffset.note ? (
            <p className="mt-0.5 break-words text-phx-sm font-medium text-slate-600">{row.directOrderOffset.note}</p>
          ) : null}
          {canSettle ? (
            <button
              className={cn(
                "mt-1 text-phx-sm font-bold text-rose-700 underline underline-offset-2 disabled:opacity-50",
                LANDING_FOCUS,
              )}
              disabled={isBusy}
              onClick={() => void remove()}
              type="button"
            >
              {isBusy ? "Removing..." : "Remove settlement"}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!canSettle) return null;

  if (!isOpen) {
    return (
      <button
        className={landingActionClassName("outline", "mt-1.5 w-full")}
        onClick={() => void open()}
        type="button"
      >
        Settle against a direct order
      </button>
    );
  }

  return (
    <div className={`mt-1.5 min-w-0 space-y-1.5 border border-slate-200 bg-white p-2.5 ${adminSoftDepthClassName}`}>
      <p className="break-words text-phx-sm font-medium text-slate-600">
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
              className={cn(phxButtonAccentClassName, "shrink-0 motion-reduce:transition-none", LANDING_FOCUS)}
              disabled={isBusy || !orderId}
              onClick={() => void settle()}
              type="button"
            >
              {isBusy ? "Settling..." : "Settle"}
            </button>
            <button
              className={cn(phxButtonGhostClassName, "shrink-0 motion-reduce:transition-none", LANDING_FOCUS)}
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
    <label className={`flex min-w-0 cursor-pointer flex-col gap-1 border border-slate-200 bg-white px-2.5 py-2 transition-colors hover:border-[#08111f] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#F05A1A] motion-reduce:transition-none ${adminControlDepthClassName}`}>
      <span className={cn("flex items-center gap-1.5 text-phx-xs font-bold uppercase tracking-[0.08em]", LANDING_INK)}>
        {isUploading ? (
          <LoadingSpinner className="h-3 w-3 text-slate-500" />
        ) : (
          <Upload aria-hidden="true" className="h-3 w-3 shrink-0 text-slate-500" />
        )}
        {isUploading ? "Uploading..." : label}
      </span>
      <span className="break-all text-phx-sm font-medium text-slate-500">
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
    <div className={`flex min-w-0 flex-col gap-1 border border-slate-200 bg-slate-50 px-2.5 py-2 ${adminRecessedDepthClassName}`}>
      <span className={MICRO_LABEL}>{label}</span>
      <span className="break-all text-phx-sm font-medium text-slate-500">
        {fileName ?? "Finance attaches it"}
      </span>
    </div>
  );
}

/** Inline share bar in ROI table --- a flat navy fill proportional to share % */
function ShareBar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="hidden h-1 flex-1 bg-slate-100 @2xl:flex">
        <div
          className="h-full bg-[#08111f] transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className={cn("shrink-0 text-right font-bold tabular-nums", LANDING_INK)}>
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
    <div className="space-y-2">
      <div className="flex h-1 w-full gap-px bg-slate-100">
        {pctCovers > 0 && (
          <div
            className="h-full bg-emerald-500 transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${pctCovers}%` }}
          />
        )}
        {pctUnder > 0 && (
          <div
            className="h-full bg-amber-400 transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${pctUnder}%` }}
          />
        )}
        {pctOther > 0 && (
          <div
            className="h-full bg-slate-300 transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${pctOther}%` }}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 bg-emerald-500" />
          Covers ROI <span className={cn("tabular-nums", LANDING_INK)}>{covers}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 bg-amber-400" />
          Under Target <span className={cn("tabular-nums", LANDING_INK)}>{under}</span>
        </span>
        {other > 0 && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-2 w-2 bg-slate-300" />
            Not Calculated <span className={cn("tabular-nums", LANDING_INK)}>{other}</span>
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
        <div className={`flex min-w-0 gap-3 border border-slate-200 bg-white px-3 py-2.5 sm:px-4 ${adminSoftDepthClassName}`}>
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-amber-400" />
          <WifiOff aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
          <span className="min-w-0 break-words text-phx-sm font-semibold text-slate-700">
            You are offline.
            {queueLength > 0
              ? ` ${queueLength} draft${queueLength > 1 ? "s" : ""} queued.`
              : " Drafts will be queued until reconnected."}
          </span>
        </div>
      )}

      {/* ------ Figure strip + Refresh: four counts on one sheet, one hairline between them ------------------------------ */}
      <div className="flex min-w-0 items-stretch gap-2">
        <div className={`grid min-w-0 flex-1 grid-cols-2 gap-px border border-slate-200 bg-slate-200 xs:grid-cols-4 ${adminSoftDepthClassName}`}>
          {isLoading ? (
            <>
              <MetricSkeleton />
              <MetricSkeleton />
              <MetricSkeleton />
              <MetricSkeleton />
            </>
          ) : (
            <>
              <MetricCell label="Drafts" value={workspace.drafts.length} />
              <MetricCell label="Approved" value={workspace.approvedRequests.length} />
              <MetricCell label="Customers" value={workspace.customers.length} />
              <MetricCell label="Products" value={workspace.products.length} />
            </>
          )}
        </div>
        <button
          aria-label="Refresh data"
          className={landingActionClassName("outline", "h-auto min-h-10 w-10 bg-white px-0 sm:min-h-10")}
          onClick={() => {
            setIsLoading(true);
            setMessage(null);
            void loadWorkspace();
          }}
          title="Refresh data"
          type="button"
        >
          {isLoading ? (
            <LoadingSpinner className="h-3.5 w-3.5 text-current" />
          ) : (
            <RefreshCcw aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* ------ Draft ROI Health + Sparkline ------------------------------------------------------------------------------------------ */}
      {!isLoading && workspace.drafts.length > 0 && (
        <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <PanelHeader
            right={
              <span className={MICRO_LABEL}>
                Total: <span className={cn("tabular-nums", LANDING_INK)}>{egp(totalDraftValue)}</span>
              </span>
            }
            title="Draft ROI Health"
          />
          <div className="px-3 py-3 sm:px-4">
            <DraftStatusBar drafts={workspace.drafts} />
            {/* #5 --- Time-series sparkline */}
            {workspace.drafts.length >= 2 && (
              <CostSparkline drafts={workspace.drafts} />
            )}
          </div>
        </section>
      )}

      {/* ------ Alert Messages: the tone is the rail, the words stay slate ------------------------------------------------------- */}
      {message ? (
        <div
          className={`flex min-w-0 gap-3 border border-slate-200 bg-white px-3 py-2.5 sm:px-4 ${adminSoftDepthClassName}`}
          role={message.type === "error" ? "alert" : "status"}
        >
          <span
            aria-hidden="true"
            className={`w-1 shrink-0 self-stretch ${message.type === "success" ? "bg-emerald-500" : "bg-amber-400"}`}
          />
          {message.type === "success" && (
            <CheckCircle2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
          )}
          <span className="min-w-0 break-words text-phx-sm font-semibold text-slate-700">{message.text}</span>
        </div>
      ) : null}

      {/* ------ Tab Switcher: the active tab is navy on a navy rule, never an orange fill ------------------------------------- */}
      <div className={`grid grid-cols-3 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        {(
          [
            ["create", Megaphone, "Create", workspace.drafts.length],
            ["approved", FileCheck2, "Approved", workspace.approvedRequests.length],
            ["tracking", ClipboardList, "Tracking", workspace.returnedToMe.length + workspace.inApproval.length],
          ] as const
        ).map(([view, Icon, label, count]) => {
          const active = activeView === view;
          return (
            <button
              aria-pressed={active}
              className={cn(
                "flex min-h-11 min-w-0 flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 border-b-2 px-1 py-2 text-phx-xs font-bold uppercase tracking-[0.08em] transition-colors motion-reduce:transition-none sm:px-3",
                LANDING_FOCUS,
                active
                  ? "border-[#08111f] text-[#08111f]"
                  : "border-transparent text-slate-500 hover:bg-slate-50 hover:text-[#08111f]",
              )}
              key={view}
              onClick={() => setActiveView(view)}
              type="button"
            >
              <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span>{label}</span>
              {!isLoading && (
                <span className={cn("tabular-nums", active ? "text-[#08111f]" : "text-slate-400")}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
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
          <div className={`flex min-w-0 gap-3 border border-slate-200 bg-white px-3 py-2.5 sm:px-4 ${adminSoftDepthClassName}`}>
            <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-amber-400" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2 text-phx-sm font-semibold text-slate-700">
                <span className="flex min-w-0 items-center gap-2">
                  <Pencil aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                  <span className="min-w-0 break-words">
                    Editing returned request{" "}
                    <span className={cn("font-mono font-black", LANDING_INK)}>
                      {resubmitRequestCode}
                    </span>{" "}
                    — resubmitting will resume at the step that returned it.
                  </span>
                </span>
                <button
                  className={landingActionClassName("outline")}
                  onClick={cancelResubmit}
                  type="button"
                >
                  <X aria-hidden="true" className="h-3 w-3" />
                  Cancel resubmit
                </button>
              </div>
              {resubmitReturnReason ? (
                <div className="mt-2.5 border-t border-slate-200 pt-2.5 text-phx-sm text-slate-700">
                  <span className="font-bold text-amber-700">
                    Returned{resubmitReturnedBy ? ` by ${resubmitReturnedBy}` : ""} — reason:
                  </span>{" "}
                  <span className="break-words" dir="auto">{resubmitReturnReason}</span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ------ Draft Form: a kit sheet around the ADR-skinned form (the fields keep their form tokens) ------------------ */}
        <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          {isLoading ? (
            <FormSkeleton />
          ) : (
            <form aria-busy={isSaving} onSubmit={submitDraft}>
              {/* Form header */}
              <PanelHeader
                right={
                  <>
                    <LandingMeta items={[resubmitRequestId ? "Edit & Resubmit" : "Create Draft"]} />
                    <StatusText tone={roiStatusTone(roiPreview.roiStatus)}>
                      {forecastRoiStatusLabel(roiPreview.roiStatus)}
                    </StatusText>
                  </>
                }
                title={resubmitRequestId ? "Returned request" : "Activity request"}
              />

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
                      <p className="mt-1 flex min-w-0 gap-2 text-phx-xs font-semibold text-slate-700">
                        <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-amber-400" />
                        <span className="min-w-0 break-words">{roiMonthsWarning(roiDurationMonths)}</span>
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

                {/* ------ Product Lines: the row switches on its OWN width (container query), so exactly one layout shows at every width ------ */}
                <div className="@container sm:col-span-6">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-500">
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
                        className={`flex items-center gap-1 border border-slate-200 bg-white px-2.5 py-1.5 text-phx-xs font-bold text-slate-700 transition hover:bg-slate-50 motion-reduce:transition-none ${LANDING_FOCUS} ${adminControlDepthClassName}`}
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
                          <div className="hidden gap-2 @2xl:grid @2xl:grid-cols-[minmax(0,1fr)_100px_100px_120px_80px_36px]">
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
                              className={`flex h-10 w-full items-center justify-center border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 motion-reduce:transition-none ${LANDING_FOCUS} ${adminControlDepthClassName}`}
                              onClick={() =>
                                removeProductLine(line.key)
                              }
                              type="button"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          {/* Mobile layout (#6 --- short product names) */}
                          <div className="space-y-2 @2xl:hidden">
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
                                className={`flex h-10 w-10 items-center justify-center border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 motion-reduce:transition-none ${LANDING_FOCUS} ${adminControlDepthClassName}`}
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
              <div className="border-t border-slate-200 px-3 py-3 sm:px-4">
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
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <TrendingUp aria-hidden="true" className="h-3.5 w-3.5 shrink-0 self-center text-slate-500" />
                    <span className={MICRO_LABEL}>Required ROI:</span>{" "}
                    <span className={cn("text-phx-md font-bold tabular-nums", LANDING_INK)}>
                      {egp(roiPreview.requiredRoiValue)}
                    </span>
                  </div>
                  <button
                    aria-describedby={
                      saveBlockers.length > 0 ? SAVE_BLOCKED_HINT_ID : undefined
                    }
                    className={cn(phxButtonAccentClassName, "min-h-10 justify-center motion-reduce:transition-none", LANDING_FOCUS)}
                    disabled={!canSave}
                    type="submit"
                  >
                    {isSaving ? (
                      <LoadingSpinner className="text-white" />
                    ) : resubmitRequestId ? (
                      <RefreshCcw aria-hidden="true" className="h-3.5 w-3.5" />
                    ) : (
                      <Save aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    {resubmitRequestId ? "Resubmit Request" : "Save Draft"}
                  </button>
                </div>
              </div>
            </form>
          )}
        </section>

        {/* ------ ROI Preview: one sheet — figure strip, coverage bar, capture rail, then the product table (phones: rows) ---- */}
        <section className={`@container min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <PanelHeader title="ROI Preview" />

          {/* ROI metrics row */}
          <div className="grid grid-cols-2 gap-px border-b border-slate-200 bg-slate-200 @lg:grid-cols-4">
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

          {/* Smart coverage bar --- green/amber/red, flat */}
          <div className="px-3 pt-3.5 sm:px-4">
            <LandingBar fill={coverageFill(coveragePct)} pct={coveragePct} />
          </div>

          {/* Capture quality — trust in the FUTURE ROI, scored from what the requester can still fix. */}
          <div className="flex min-w-0 gap-3 px-3 py-3 sm:px-4">
            <span
              aria-hidden="true"
              className={cn(
                "w-1 shrink-0 self-stretch",
                captureHasInput ? CAPTURE_BAND_TONE[captureConfidence.band].rail : "bg-slate-300",
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className={MICRO_LABEL}>
                  Capture Quality
                </span>
                {captureHasInput ? (
                  <span className={cn("text-phx-md font-black tabular-nums", CAPTURE_BAND_TONE[captureConfidence.band].text)}>
                    {captureConfidence.score}
                    <span className="text-phx-sm font-bold">/100</span>
                  </span>
                ) : (
                  <span className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">Not scored yet</span>
                )}
              </div>
              <p className="mt-1 break-words text-phx-xs font-medium leading-snug text-slate-600">
                {!captureHasInput
                  ? "Pick the customer, products and pay date — the score shows how measurable this request will be."
                  : captureConfidence.weakest
                    ? captureConfidence.weakest.detail
                    : "Everything needed to measure this request is captured."}
              </p>
            </div>
          </div>

          {/* Product ROI table --- Desktop (the sheet's own width decides, not the viewport) */}
          <div className="hidden border-t border-slate-200 @2xl:block">
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
                <thead className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
                  <tr>
                    <th className="border-b border-slate-200 px-3 py-2 sm:px-4">
                      Product
                    </th>
                    <th className="border-b border-slate-200 px-3 py-2 text-right">
                      Qty
                    </th>
                    <th className="border-b border-slate-200 px-3 py-2 text-right">
                      Unit Price
                    </th>
                    <th className="border-b border-slate-200 px-3 py-2 text-right">
                      ROI Value
                    </th>
                    <th className="border-b border-slate-200 px-3 py-2 text-right sm:pr-4">
                      Share
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {productLineMetrics.map((product) => (
                    <tr key={product.key}>
                      <td className={cn("min-w-0 break-words px-3 py-2 font-bold sm:px-4", LANDING_INK)} dir="auto">
                        {product.productName}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums text-slate-600">
                        {product.quantity}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums text-slate-600">
                        {egp(product.factoryPrice)}
                      </td>
                      <td className={cn("px-3 py-2 text-right font-bold tabular-nums", LANDING_INK)}>
                        {egp(product.expectedValue)}
                      </td>
                      <td className="px-3 py-2 text-right sm:pr-4">
                        <ShareBar
                          pct={Math.round(product.valueShare * 100)}
                        />
                      </td>
                    </tr>
                  ))}
                  {productLineMetrics.length === 0 ? (
                    <tr>
                      <td
                        className="px-3 py-5 text-center text-phx-sm font-medium text-slate-500"
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

          {/* Product ROI --- phone rows: hairlines, no card on the card */}
          <div className="border-t border-slate-200 @2xl:hidden">
            {productLineMetrics.length === 0 ? (
              <LandingEmpty>
                Add product quantities to preview ROI.
              </LandingEmpty>
            ) : (
              productLineMetrics.map((product) => (
                <div
                  key={product.key}
                  className="space-y-2 border-b border-slate-100 px-3 py-3 last:border-b-0 sm:px-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className={cn("min-w-0 break-words text-phx-md font-bold", LANDING_INK)} dir="auto">
                      {product.productName}
                    </p>
                    <span className={cn("shrink-0 text-phx-sm font-black tabular-nums", LANDING_INK)}>
                      {Math.round(product.valueShare * 100)}%
                    </span>
                  </div>
                  <div aria-hidden="true" className="h-1 bg-slate-100">
                    <div
                      className="h-full bg-[#08111f]"
                      style={{
                        width: `${Math.min(Math.round(product.valueShare * 100), 100)}%`,
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-phx-sm">
                    <div className="min-w-0">
                      <span className={MICRO_LABEL}>
                        Qty
                      </span>
                      <p className="break-words font-bold tabular-nums text-slate-700">
                        {product.quantity}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <span className={MICRO_LABEL}>
                        Unit
                      </span>
                      <p className="break-words font-bold tabular-nums text-slate-700">
                        {egp(product.factoryPrice)}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <span className={MICRO_LABEL}>
                        Value
                      </span>
                      <p className={cn("break-words font-bold tabular-nums", LANDING_INK)}>
                        {egp(product.expectedValue)}
                      </p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* ------ Draft Rows: hairline rows on one sheet; the newest save flashes an emerald rule, not an orange box ------- */}
        <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <PanelHeader
            right={
              workspace.drafts.length > 0 ? (
                <LandingMeta items={[`${Math.min(workspace.drafts.length, 6)} of ${workspace.drafts.length} shown`]} />
              ) : null
            }
            title="Draft Rows"
          />
          <div>
            {isLoading ? (
              <div aria-busy="true">
                <span className="sr-only">Loading</span>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    aria-hidden="true"
                    key={i}
                    className="space-y-2 border-b border-slate-100 px-3 py-3 last:border-b-0 sm:px-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-2">
                        <div className="employee-portal-skeleton h-3 w-20" />
                        <div className="employee-portal-skeleton h-4 w-16" />
                      </div>
                      <div className="employee-portal-skeleton h-3 w-20" />
                    </div>
                    <div className="employee-portal-skeleton h-3 w-24" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                {workspace.drafts.slice(0, 6).map((draft) => (
                  <div
                    className={`border-b border-l-[3px] border-b-slate-100 px-3 py-2.5 transition-colors duration-700 motion-reduce:transition-none sm:px-4 ${
                      highlightDraftId === draft.id
                        ? "border-l-emerald-500 bg-slate-50"
                        : "border-l-transparent"
                    }`}
                    key={draft.id}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-words font-mono text-phx-sm font-bold text-slate-500">
                          {draft.requestCode}
                        </p>
                        <p className={cn("mt-0.5 text-phx-md font-black tabular-nums", LANDING_INK)}>
                          {egp(draft.estimatedCost)}
                        </p>
                      </div>
                      <StatusText tone={roiStatusTone(draft.roiStatus)}>
                        {forecastRoiStatusLabel(draft.roiStatus)}
                      </StatusText>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                      <span className="flex items-center gap-1 text-phx-sm font-medium tabular-nums text-slate-500">
                        <CalendarDays aria-hidden="true" className="h-3 w-3" />
                        {draft.requestDate}
                      </span>
                      <span className="text-phx-sm font-bold text-slate-500">
                        <span className={cn("tabular-nums", LANDING_INK)}>{Math.round(draft.roiCoverageRatio * 100)}%</span>
                        {" "}forecast coverage
                      </span>
                    </div>
                  </div>
                ))}
                {workspace.drafts.length === 0 ? (
                  <LandingEmpty>
                    No draft rows yet.
                  </LandingEmpty>
                ) : (
                  <p className="break-words px-3 py-2.5 text-center text-phx-sm font-semibold text-slate-500 sm:px-4">
                    Forecast only — {ROI_ACTUAL_IN_TRACKING_NOTE}.
                  </p>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      {/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */}
      {/* ------ APPROVED REQUESTS TAB  (#1 focus trap) --------------------------------------------------------- */}
      {/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */}
      <div
        ref={approvedPanelRef}
        className={activeView === "approved" ? "space-y-3" : "hidden"}
      >
        <section className={`@container min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <div>
            <PanelHeader
              right={
                <LandingMeta
                  items={[
                    "Finance Evidence",
                    filteredApproved.length === workspace.approvedRequests.length
                      ? `${workspace.approvedRequests.length} rows`
                      : `${filteredApproved.length} / ${workspace.approvedRequests.length}`,
                  ]}
                />
              }
              title="Approved Requests"
            />

            {/* #7 --- Search input: its own toolbar row under the title */}
            {workspace.approvedRequests.length > 0 && (
              <div className="relative border-b border-slate-200 px-3 py-2.5 sm:px-4">
                <Search aria-hidden="true" className="absolute left-5.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 sm:left-6.5" />
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
              {/* Desktop table — the sheet's own width decides (container query), never a sideways scroll */}
              <div className="hidden @2xl:block">
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
                  <thead className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
                    <tr>
                      <th className="border-b border-slate-200 px-3 py-2 sm:px-4">
                        Customer &amp; Contact
                      </th>
                      <th className="border-b border-slate-200 px-3 py-2">
                        Transfer Date &amp; Line
                      </th>
                      <th className="border-b border-slate-200 px-3 py-2">
                        Notes
                      </th>
                      <th className="border-b border-slate-200 px-3 py-2 text-right">
                        Amount
                      </th>
                      <th className="border-b border-slate-200 px-3 py-2">
                        Invoice due
                      </th>
                      <th className="border-b border-slate-200 px-3 py-2">
                        Proof
                      </th>
                      <th className="border-b border-slate-200 px-3 py-2 sm:pr-4">
                        Invoice
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {filteredApproved.map((row) => (
                      <tr key={row.id} className="align-top">
                        <td className="min-w-0 break-words px-3 py-2.5 sm:px-4" dir="auto">
                          <p className={cn("font-bold", LANDING_INK)}>{row.customerName}</p>
                          <p className="mt-0.5 font-medium text-slate-600">{row.contactForMoneyTransfer}</p>
                        </td>
                        <td className="min-w-0 break-words px-3 py-2.5 font-medium tabular-nums text-slate-600">
                          {transferDateLabel(row.moneyTransferDate)}
                          <span className="mt-0.5 block">{row.line ?? "—"}</span>
                        </td>
                        <td className="min-w-0 break-words px-3 py-2.5 text-slate-500">
                          <p className="text-phx-xs font-medium break-words" dir="auto">
                            {row.notes || "—"}
                          </p>
                        </td>
                        <td className={cn("min-w-0 break-words px-3 py-2.5 text-right font-bold tabular-nums", LANDING_INK)}>
                          {egp(row.sumOfAmount)}
                        </td>
                        {/* The invoice this approval obliges, and whether it is late. The status
                            is derived from the deadline at read time, never read raw — see
                            src/lib/marketing-requests/invoice-obligation.ts. */}
                        <td className="min-w-0 break-words px-3 py-2.5 tabular-nums">
                          {row.invoiceDaysOverdue > 0 ? (
                            <span className="font-bold text-rose-700">
                              {row.invoiceDueLabel}
                            </span>
                          ) : (
                            <span className="font-medium text-slate-600">
                              {row.invoiceDueLabel}
                            </span>
                          )}
                        </td>
                        <td className="min-w-0 break-words px-3 py-2.5">
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
                        <td className="min-w-0 break-words px-3 py-2.5 sm:pr-4">
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
                          className="px-3 py-6 text-center text-phx-sm font-medium text-slate-500"
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

              {/* Phone rows — hairlines on the sheet, no card on the card */}
              <div className="divide-y divide-slate-100 @2xl:hidden">
                {filteredApproved.length === 0 ? (
                  <LandingEmpty>
                    {approvedSearch
                      ? "No matching results."
                      : "No approved requests yet."}
                  </LandingEmpty>
                ) : (
                  filteredApproved.map((row) => (
                    <div key={row.id} className="space-y-2.5 px-3 py-3 sm:px-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className={cn("break-words text-phx-md font-bold", LANDING_INK)} dir="auto">
                            {row.customerName}
                          </p>
                          <p className="mt-0.5 break-words text-phx-sm font-medium text-slate-500" dir="auto">
                            {row.contactForMoneyTransfer}
                          </p>
                        </div>
                        <span className={cn("shrink-0 text-phx-md font-black tabular-nums", LANDING_INK)}>
                          {egp(row.sumOfAmount)}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-phx-sm">
                        <span className={MICRO_LABEL}>
                          Transfer
                        </span>
                        <span className="min-w-0 break-words text-right font-bold tabular-nums text-slate-700">
                          {transferDateLabel(row.moneyTransferDate)}
                        </span>
                        <span className={MICRO_LABEL}>
                          Line
                        </span>
                        <span className="min-w-0 break-words text-right font-bold tabular-nums text-slate-700">
                          {row.line ?? "-"}
                        </span>
                        <span className={MICRO_LABEL}>
                          Invoice due
                        </span>
                        <span
                          className={
                            row.invoiceDaysOverdue > 0
                              ? "whitespace-nowrap text-right font-black tabular-nums text-rose-700"
                              : "whitespace-nowrap text-right font-bold tabular-nums text-slate-700"
                          }
                        >
                          {row.invoiceDueLabel}
                        </span>
                      </div>

                      {row.notes ? (
                        <p className="break-words text-phx-sm font-medium text-slate-600" dir="auto">
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
        </section>
      </div>

      {/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */}
      {/* ------ TRACKING TAB  (#1 focus trap) ----------------------------------------------------------------------- */}
      {/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */}
      <div
        ref={trackingPanelRef}
        className={activeView === "tracking" ? "space-y-3" : "hidden"}
      >
        {/* ------ Returned to me: hairline rows on one sheet, the state on an amber rail ------------------------------------ */}
        <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <PanelHeader
            right={<LandingMeta items={["Action Needed", `${workspace.returnedToMe.length} returned`]} />}
            title="Returned to me"
          />
          {isLoading ? (
            <TableSkeleton cols={3} rows={2} />
          ) : workspace.returnedToMe.length === 0 ? (
            <LandingEmpty>
              Nothing returned to you right now.
            </LandingEmpty>
          ) : (
            <div>
              {workspace.returnedToMe.map((request) => {
                const progress =
                  workspace.stepProgressByRequestId[request.id] ?? null;
                return (
                  <RailRow key={request.id} rail="bg-amber-400">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className={cn("break-words text-phx-md font-black", LANDING_INK)} dir="auto">
                          {customerNameMap.get(request.customerId) ??
                            "Customer"}
                        </p>
                        <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">
                          {requestTypeNameMap.get(request.requestTypeId) ??
                            "Request"}{" "}
                          · <span className={cn("font-bold tabular-nums", LANDING_INK)}>{egp(request.estimatedCost)}</span>
                        </p>
                        <p className="mt-0.5 break-words font-mono text-phx-xs font-medium text-slate-500">
                          Ref {request.requestCode}
                        </p>
                      </div>
                      <button
                        className={landingActionClassName("solid")}
                        onClick={() => void startResubmit(request)}
                        type="button"
                      >
                        <Pencil aria-hidden="true" className="h-3 w-3" />
                        Edit &amp; Resubmit
                      </button>
                    </div>
                    {progress?.returnReason ? (
                      <p className="mt-2 break-words border-t border-slate-100 pt-2 text-phx-xs font-medium text-slate-700">
                        <span className="font-bold text-amber-700">Return reason: </span>
                        {progress.returnReason}
                      </p>
                    ) : null}
                  </RailRow>
                );
              })}
            </div>
          )}
        </section>

        {/* ------ In approval: a navy rail — in flight, nothing waiting on the requester ----------------------------------- */}
        <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <PanelHeader
            right={<LandingMeta items={["In Flight", `${workspace.inApproval.length} pending`]} />}
            title="In approval"
          />
          {isLoading ? (
            <TableSkeleton cols={3} rows={3} />
          ) : workspace.inApproval.length === 0 ? (
            <LandingEmpty>
              No requests are currently in approval.
            </LandingEmpty>
          ) : (
            <div>
              {workspace.inApproval.map((request) => {
                const progress =
                  workspace.stepProgressByRequestId[request.id] ?? null;
                const expanded = expandedTrackingId === request.id;
                const detail = detailCache[request.id];
                return (
                  <RailRow key={request.id} rail="bg-[#08111f]">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className={cn("break-words text-phx-md font-black", LANDING_INK)} dir="auto">
                          {customerNameMap.get(request.customerId) ??
                            "Customer"}
                        </p>
                        <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">
                          {requestTypeNameMap.get(request.requestTypeId) ??
                            "Request"}{" "}
                          · <span className={cn("font-bold tabular-nums", LANDING_INK)}>{egp(request.estimatedCost)}</span>
                        </p>
                        <p className="mt-0.5 break-words font-mono text-phx-xs font-medium text-slate-500">
                          Ref {request.requestCode}
                        </p>
                      </div>
                      <button
                        aria-expanded={expanded}
                        className={landingActionClassName("outline")}
                        onClick={() =>
                          void toggleTrackingExpand(request.id)
                        }
                        type="button"
                      >
                        {expanded ? (
                          <ChevronDown aria-hidden="true" className="h-3 w-3" />
                        ) : (
                          <ChevronRight aria-hidden="true" className="h-3 w-3" />
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
                      <div className="mt-2 border-t border-slate-100 pt-2">
                        {loadingDetailId === request.id && !detail ? (
                          <div aria-busy="true" className="flex items-center gap-2 px-1 py-2 text-phx-xs font-medium text-slate-500">
                            <LoadingSpinner />
                            Loading timeline...
                          </div>
                        ) : detail ? (
                          <>
                            <MarketingApprovalTimeline requestCode={request.requestCode} steps={detail.steps} />
                            {detail.viewerCanComment ? (
                              <div className="mt-3 border-t border-slate-200 pt-3">
                                <p className={cn("mb-1.5", MICRO_LABEL)}>
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
                          <p className="px-1 py-2 text-phx-xs font-medium text-slate-500">
                            Timeline unavailable.
                          </p>
                        )}
                      </div>
                    ) : null}
                  </RailRow>
                );
              })}
            </div>
          )}
        </section>

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
        <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <PanelHeader
            right={<LandingMeta items={["Not Proceeding", `${workspace.rejected.length} rejected`]} />}
            title="Rejected"
          />
          {isLoading ? (
            <TableSkeleton cols={3} rows={2} />
          ) : workspace.rejected.length === 0 ? (
            <LandingEmpty>
              No requests have been rejected.
            </LandingEmpty>
          ) : (
            <div>
              {workspace.rejected.map((request) => {
                const rejection =
                  workspace.rejectionByRequestId[request.id] ?? null;
                return (
                  <RailRow key={request.id} rail="bg-rose-500">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className={cn("break-words text-phx-md font-black", LANDING_INK)} dir="auto">
                          {customerNameMap.get(request.customerId) ??
                            "Customer"}
                        </p>
                        <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">
                          {requestTypeNameMap.get(request.requestTypeId) ??
                            "Request"}{" "}
                          · <span className={cn("font-bold tabular-nums", LANDING_INK)}>{egp(request.estimatedCost)}</span>
                        </p>
                        <p className="mt-0.5 break-words font-mono text-phx-xs font-medium text-slate-500">
                          Ref {request.requestCode}
                        </p>
                      </div>
                      <StatusText tone="text-rose-700">
                        Rejected
                      </StatusText>
                    </div>

                    <div className="mt-2 border-t border-slate-100 pt-2">
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
                                  <dt className="w-[66px] shrink-0 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">
                                    {label}
                                  </dt>
                                  <dd className="min-w-0 break-words text-phx-xs font-bold tabular-nums text-slate-700" dir="auto">
                                    {value}
                                  </dd>
                                </div>
                              ))}
                          </dl>
                          {rejection.reason ? (
                            <p className="mt-1.5 break-words text-phx-xs font-medium text-slate-700">
                              <span className="font-bold text-rose-700">Reason: </span>
                              {rejection.reason}
                            </p>
                          ) : (
                            <p className="mt-1.5 text-phx-xs font-medium text-slate-500">
                              No reason was recorded.
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="break-words text-phx-xs font-medium text-slate-500">
                          Rejection details unavailable — the approval chain for
                          this request could not be read.
                        </p>
                      )}
                    </div>

                    {/* A rejected request is never closed to conversation (owner rule, 2026-09-22):
                        the requester can ask why it was refused and the approver can answer, right
                        here. Every message emails the requester, cc's everyone on the request, and
                        pings them in-app / Telegram. */}
                    <div className="mt-2 border-t border-slate-100 pt-2">
                      <button
                        aria-expanded={
                          openRejectedConversationId === request.id
                        }
                        className={landingActionClassName("outline", "w-full")}
                        onClick={() =>
                          setOpenRejectedConversationId((current) =>
                            current === request.id ? null : request.id,
                          )
                        }
                        type="button"
                      >
                        <MessageCircle aria-hidden="true" className="h-3.5 w-3.5" />
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
                  </RailRow>
                );
              })}
            </div>
          )}
        </section>

        {/* ------ Drafts: a slate rail — not yet submitted ------------------------------------------------------------------------- */}
        <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <PanelHeader
            right={<LandingMeta items={["Not Submitted", `${workspace.drafts.length} drafts`]} />}
            title="Drafts"
          />
          {isLoading ? (
            <TableSkeleton cols={3} rows={2} />
          ) : workspace.drafts.length === 0 ? (
            <LandingEmpty>
              No drafts yet.
            </LandingEmpty>
          ) : (
            <div>
              {workspace.drafts.map((draft) => (
                <RailRow key={draft.id} rail="bg-slate-300">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words font-mono text-phx-sm font-bold text-slate-500">
                        {draft.requestCode}
                      </p>
                      <p className={cn("mt-0.5 break-words text-phx-md font-black", LANDING_INK)} dir="auto">
                        {customerNameMap.get(draft.customerId) ?? "Customer"}
                      </p>
                      <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">
                        {requestTypeNameMap.get(draft.requestTypeId) ??
                          "Request"}{" "}
                        · <span className={cn("font-bold tabular-nums", LANDING_INK)}>{egp(draft.estimatedCost)}</span>
                      </p>
                    </div>
                    <button
                      className={landingActionClassName("outline")}
                      onClick={() => setActiveView("create")}
                      type="button"
                    >
                      <Pencil aria-hidden="true" className="h-3 w-3" />
                      Continue editing
                    </button>
                  </div>
                </RailRow>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* ------ Empty-data hint: a slate rail line on a white sheet ------------------------------------------------------------- */}
      {!isLoading && !workspace.canCreateDraft ? (
        <div className={`flex min-w-0 gap-3 border border-slate-200 bg-white px-3 py-2.5 sm:px-4 ${adminSoftDepthClassName}`}>
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-slate-300" />
          <p className="min-w-0 break-words text-phx-sm font-medium text-slate-600">
            You have review access to marketing requests. Draft creation is limited to assigned requesters in the employee directory.
          </p>
        </div>
      ) : !isLoading &&
        (workspace.customers.length === 0 ||
          workspace.products.length === 0) ? (
        <div className={`flex min-w-0 gap-3 border border-slate-200 bg-white px-3 py-2.5 sm:px-4 ${adminSoftDepthClassName}`}>
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-slate-300" />
          <p className="min-w-0 break-words text-phx-sm font-medium text-slate-600">
            {workspace.customers.length === 0
              ? "No active marketing customers available. Customer creation is coming next."
              : "No active marketing products available. Run the reference-data seed."}
          </p>
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
