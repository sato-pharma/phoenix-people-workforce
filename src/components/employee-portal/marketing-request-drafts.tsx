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
  PackagePlus,
  Pencil,
  RefreshCcw,
  Save,
  Search,
  Trash2,
  TrendingUp,
  Upload,
  WifiOff,
  X,
} from "lucide-react";

import { MarketingAdvisoryCommentBox } from "@/components/employee-portal/marketing-advisory-comment-box";
import {
  MarketingApprovalTimeline,
  MarketingProgressStrip,
} from "@/components/employee-portal/marketing-approval-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { calculateMarketingRoiPreview } from "@/lib/marketing-requests/roi";
import { draftCaptureConfidence, type RoiConfidenceBand } from "@/lib/marketing-requests/roi-confidence";
import {
  ROI_ACTUAL_IN_TRACKING_NOTE,
  ROI_FORECAST_COVERAGE_LABEL,
  forecastRoiStatusLabel,
} from "@/lib/marketing-requests/roi-labels";
import type {
  MarketingRequestDetail,
  MarketingRequestStepProgress,
} from "@/lib/marketing-requests/service";
import type {
  MarketingApprovedRequestRow,
  MarketingRequestPharmacyOption,
  MarketingCustomer,
  MarketingProduct,
  MarketingRequest,
  MarketingRequestType,
} from "@/lib/marketing-requests/types";
import { SearchableSelect } from "@/components/ui/searchable-select";


/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Types ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

type DraftWorkspacePayload = {
  approvedRequests: MarketingApprovedRequestRow[];
  canCreateDraft: boolean;
  customers: MarketingCustomer[];
  drafts: MarketingRequest[];
  pharmaciesByCustomer: Record<string, MarketingRequestPharmacyOption[]>;
  inApproval: MarketingRequest[];
  products: MarketingProduct[];
  requestTypes: MarketingRequestType[];
  requesterLineId: number | null;
  requesterLineName: string | null;
  returned: MarketingRequest[];
  returnedToMe: MarketingRequest[];
  stepProgressByRequestId: Record<string, MarketingRequestStepProgress>;
};

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

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
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
    customers: [],
    pharmaciesByCustomer: {},
    drafts: [],
    inApproval: [],
    products: [],
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
    <div className="animate-pulse rounded-sm border border-slate-100 bg-slate-50 px-4 py-3">
      <div className="h-2.5 w-16 rounded-sm bg-slate-200" />
      <div className="mt-2.5 h-5 w-12 rounded-sm bg-slate-200" />
    </div>
  );
}

function FormSkeleton() {
  return (
    <div className="animate-pulse space-y-4 p-5">
      <div className="h-4 w-28 rounded-sm bg-slate-200" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-10 rounded-sm bg-slate-100" />
        <div className="h-10 rounded-sm bg-slate-100" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="h-10 rounded-sm bg-slate-100" />
        <div className="h-10 rounded-sm bg-slate-100" />
        <div className="h-10 rounded-sm bg-slate-100" />
      </div>
      <div className="h-10 rounded-sm bg-slate-100" />
      <div className="h-20 rounded-sm bg-slate-100" />
    </div>
  );
}

function TableSkeleton({ cols, rows }: { cols: number; rows: number }) {
  return (
    <div className="animate-pulse">
      <div className="flex gap-2 border-b border-slate-100 bg-slate-50 px-4 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className="h-2.5 flex-1 rounded-sm bg-slate-200" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex gap-2 border-b border-slate-50 px-4 py-3"
        >
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className="h-3.5 flex-1 rounded-sm bg-slate-100" />
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
    <div className="mt-2 rounded-sm border border-slate-100 bg-slate-50 p-2">
      <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.10em] text-slate-400">
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
      className={`rounded-sm border border-slate-200 border-l-[3px] bg-white px-3 py-2.5 ${borderColors[accent]}`}
    >
      <div className="flex items-center gap-1.5">
        <Icon className={`h-3 w-3 ${iconColors[accent]}`} />
        <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
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
      <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
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
      className="h-10 w-full rounded-sm border border-slate-200 bg-white px-3 text-[13px] font-bold text-slate-800 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-100 disabled:cursor-not-allowed disabled:opacity-50"
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
    <div className="flex items-center justify-between gap-2 rounded-sm border border-slate-100 bg-slate-50 px-3 py-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.10em] text-slate-500">
        {label}
      </span>
      <span className="text-[13px] font-black text-slate-950">{value}</span>
    </div>
  );
}

function ReadOnlyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-10 min-w-0 flex-col justify-center rounded-sm border border-slate-200 bg-white px-3">
      <span className="text-[9px] font-bold uppercase tracking-[0.10em] text-slate-400">
        {label}
      </span>
      <span className="text-[13px] font-black text-slate-800">{value}</span>
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
    <label className="flex min-w-0 cursor-pointer flex-col gap-1 rounded-sm border border-slate-200 bg-slate-50 px-2.5 py-2 transition hover:border-orange-200 hover:bg-orange-50">
      <span className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
        {isUploading ? (
          <LoadingSpinner />
        ) : (
          <Upload className="h-3 w-3 text-orange-600" />
        )}
        {isUploading ? "Uploading..." : label}
      </span>
      <span className="break-all text-[10px] font-medium text-slate-500">
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

/** Inline share bar in ROI table --- gradient proportional to share % */
function ShareBar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="hidden sm:flex h-1.5 flex-1 overflow-hidden rounded-sm bg-slate-100">
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
      <div className="flex h-2 w-full overflow-hidden rounded-sm bg-slate-100">
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
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] font-medium text-slate-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 rounded-sm bg-emerald-500" />
          Covers ROI {covers}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 rounded-sm bg-amber-500" />
          Under Target {under}
        </span>
        {other > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-sm bg-slate-300" />
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
        customers: payload.customers ?? [],
        pharmaciesByCustomer: payload.pharmaciesByCustomer ?? {},
        drafts: payload.drafts ?? [],
        inApproval: payload.inApproval ?? [],
        products: payload.products ?? [],
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

  const selectedPharmacyIds = useMemo(
    () =>
      pharmacyOptions
        .map((option) => option.distributorCodeId)
        .filter((id) => !deselectedPharmacyIds.includes(id)),
    [pharmacyOptions, deselectedPharmacyIds],
  );

  // Capture quality — the same trust score the ROI tracker shows after submission, computed live
  // from only what the requester can still change (verified codes, a forecast, a pay date). Shown
  // on the preview so "is this request even measurable?" is answerable before Save, not months later.
  const captureConfidence = useMemo(() => {
    const suspectByCode = new Map(
      pharmacyOptions.map((option) => [
        option.distributorCodeId,
        option.referenceStatus === "not_found" || option.referenceStatus === "ambiguous",
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

  const canSave =
    !isSaving &&
    Boolean(
      customerId &&
        requestTypeId &&
        requestDate &&
        roiDurationMonths &&
        fieldNumber(estimatedCost) > 0,
    ) &&
    roiPreview.products.some((product) => product.quantity > 0) &&
    (!selectedRequestType?.requiresDescription ||
      otherRequestType.trim().length > 0);

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
    setRequestTypeId(String(workspace.requestTypes[0]?.id ?? ""));
    setRequestDate(todayDate);
    setPayDate("");
    setEstimatedCost("");
    setRoiDurationMonths("3");
    setOtherRequestType("");
    setNotes("");
    setProductLines([{ key: "line-1", productId: "", quantity: "" }]);
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
      showMessage("Complete the draft fields before saving.", "error");
      return;
    }

    const draftPayload = {
      customerId,
      estimatedCost: fieldNumber(estimatedCost),
      lineId: workspace.requesterLineId,
      notes,
      otherRequestType,
      payDate: payDate || null,
      pharmacies: selectedPharmacyIds.map((distributorCodeId) => ({ distributorCodeId })),
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
        <div className="flex items-center gap-2 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-900">
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
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600"
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
        <div className="rounded-sm border border-slate-200 bg-white px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
              Draft ROI Health
            </span>
            <span className="text-[11px] font-bold text-slate-600">
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
          className={`flex items-center gap-2 rounded-sm border px-3 py-2 text-[13px] font-semibold transition-all ${
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
      <div className="flex gap-1 rounded-sm border border-slate-200 bg-slate-50 p-1">
        <button
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-sm px-3 py-2 text-[13px] font-bold transition ${
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
              className={`ml-0.5 rounded-sm px-1.5 py-0.5 text-[10px] font-black ${
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
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-sm px-3 py-2 text-[13px] font-bold transition ${
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
              className={`ml-0.5 rounded-sm px-1.5 py-0.5 text-[10px] font-black ${
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
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-sm px-3 py-2 text-[13px] font-bold transition ${
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
              className={`ml-0.5 rounded-sm px-1.5 py-0.5 text-[10px] font-black ${
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
          <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] font-semibold text-amber-900">
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
                className="flex shrink-0 items-center gap-1 rounded-sm border border-amber-300 bg-white px-2.5 py-1.5 text-[11px] font-bold text-amber-800 transition hover:bg-amber-100"
                onClick={cancelResubmit}
                type="button"
              >
                <X className="h-3 w-3" />
                Cancel resubmit
              </button>
            </div>
            {resubmitReturnReason ? (
              <div className="mt-2 border-l-4 border-amber-500 bg-white/70 px-3 py-2 text-[12px] text-amber-900">
                <span className="font-bold">
                  Returned{resubmitReturnedBy ? ` by ${resubmitReturnedBy}` : ""} — reason:
                </span>{" "}
                <span className="break-words">{resubmitReturnReason}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ------ Draft Form Card ------------------------------------------------------------------------------------------------------------------------ */}
        <Card className="overflow-hidden rounded-sm border border-slate-200 bg-white p-0 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          {isLoading ? (
            <FormSkeleton />
          ) : (
            <form aria-busy={isSaving} onSubmit={submitDraft}>
              {/* Form header */}
              <div className="border-b border-slate-100 bg-gradient-to-r from-white via-orange-50/30 to-white px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-orange-600">
                      {resubmitRequestId ? "Edit & Resubmit" : "Create Draft"}
                    </p>
                    <h2 className="mt-0.5 text-[15px] font-black tracking-tight text-slate-950">
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
                      onChange={setCustomerId}
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
                            const checked = selectedPharmacyIds.includes(option.distributorCodeId);
                            const unverified = option.referenceStatus === "not_found";
                            return (
                              <label
                                className="flex cursor-pointer items-center gap-2 text-xs"
                                key={option.distributorCodeId}
                              >
                                <input
                                  checked={checked}
                                  onChange={() =>
                                    setDeselectedPharmacyIds((current) =>
                                      current.includes(option.distributorCodeId)
                                        ? current.filter((id) => id !== option.distributorCodeId)
                                        : [...current, option.distributorCodeId],
                                    )
                                  }
                                  type="checkbox"
                                />
                                <span className="text-slate-800">{option.pharmacyName}</span>
                                <span className="text-slate-500">
                                  {option.pharmacyCode} · {option.distributorName}
                                </span>
                                {unverified ? (
                                  <span className="text-amber-700">
                                    — code not recognised, sales here will not be counted
                                  </span>
                                ) : null}
                              </label>
                            );
                          })}
                        </div>
                      )}
                      {pharmacyOptions.length > 0 && selectedPharmacyIds.length === 0 ? (
                        <p className="mt-1 text-xs text-amber-700">
                          No pharmacies selected — this request could never be credited any sales.
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
                        className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
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
                      className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
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
                      className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
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
                      className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
                      min="1"
                      onChange={(event) =>
                        setRoiDurationMonths(event.target.value)
                      }
                      type="number"
                      value={roiDurationMonths}
                    />
                  </Field>
                </div>

                <div className="sm:col-span-3">
                  <Field label="Estimated Cost (EGP)">
                    <Input
                      className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
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
                        <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
                          Products
                        </p>
                        {/* A null requesterLineId means BOTH "oversight role, every line" and
                            "requester has no line assigned" — the second case gets an empty
                            product list, so labelling it "All available products" told the
                            requester the exact opposite of the truth. requesterLineName is the
                            honest discriminator: the server sets it to "All product lines" for
                            an unrestricted role and to null only when no line is assigned. */}
                        {workspace.requesterLineName === null ? (
                          <p className="mt-0.5 text-[11px] font-semibold text-amber-600">
                            No product line assigned — contact HR
                          </p>
                        ) : (
                          <p className="mt-0.5 text-[11px] font-medium text-slate-400">
                            {workspace.requesterLineId === null
                              ? "All available products"
                              : `Line: ${workspace.requesterLineName}`}
                          </p>
                        )}
                      </div>
                      <button
                        className="flex items-center gap-1 rounded-sm border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-700 transition hover:bg-slate-50"
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
                          className="rounded-sm border border-slate-200 bg-slate-50/50 p-2.5"
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
                              className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
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
                              className="flex h-10 w-full items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
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
                                className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
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
                                className="flex h-10 w-10 items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
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
                      className="min-h-20 w-full rounded-sm border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                      onChange={(event) => setNotes(event.target.value)}
                      placeholder="Optional request note"
                      value={notes}
                    />
                  </Field>
                </div>
              </div>

              {/* Form footer */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/50 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2 text-[13px] font-bold text-slate-700">
                  <TrendingUp className="h-4 w-4 shrink-0 text-orange-500" />
                  <span>
                    Required ROI: {egp(roiPreview.requiredRoiValue)}
                  </span>
                </div>
                <Button
                  className="min-h-10 gap-1.5 rounded-sm bg-orange-500 px-5 text-[13px] font-bold text-white shadow-sm hover:bg-orange-600"
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
            </form>
          )}
        </Card>

        {/* ------ ROI Preview Card --------------------------------------------------------------------------------------------------------------------- */}
        <Card className="rounded-sm border border-slate-200 bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-orange-50 text-orange-600 ring-1 ring-orange-100">
              <BarChart3 className="h-3.5 w-3.5" />
            </div>
            <div>
              <p className="text-[13px] font-black text-slate-950">
                ROI Preview
              </p>
              <p className="text-[10px] font-medium text-slate-400">
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
          <div className="mt-2 overflow-hidden rounded-sm bg-slate-100">
            <div className="flex h-2 w-full overflow-hidden">
              <div
                className={`h-full bg-gradient-to-r ${coverageGradient(coveragePct)} transition-all duration-500`}
                style={{ width: `${coveragePct}%` }}
              />
            </div>
          </div>

          {/* Capture quality — trust in the FUTURE ROI, scored from what the requester can still fix. */}
          <div className={`mt-3 rounded-sm border px-3 py-2 ${CAPTURE_BAND_STYLE[captureConfidence.band]}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.10em]">
                Capture Quality
              </span>
              <span className="text-[13px] font-black">
                {captureConfidence.score}
                <span className="text-[10px] font-bold">/100</span>
              </span>
            </div>
            <p className="mt-1 text-[11px] font-medium leading-snug">
              {captureConfidence.weakest
                ? captureConfidence.weakest.detail
                : "Everything needed to measure this request is captured."}
            </p>
          </div>

          {/* Product ROI table --- Desktop */}
          <div className="mt-3 hidden md:block overflow-hidden rounded-sm border border-slate-200">
            {isLoading ? (
              <TableSkeleton cols={5} rows={3} />
            ) : (
              <table className="w-full border-collapse text-left text-[13px]">
                <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-[0.10em] text-slate-500">
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
                      <td className="border-r border-slate-100 px-3 py-2 font-bold text-slate-950">
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
                        className="px-3 py-5 text-center text-[12px] font-medium text-slate-400"
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
              <p className="rounded-sm border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-[11px] font-medium text-slate-400">
                Add product quantities to preview ROI.
              </p>
            ) : (
              productLineMetrics.map((product) => (
                <div
                  key={product.key}
                  className="rounded-sm border border-slate-200 bg-slate-50 p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[13px] font-bold text-slate-950">
                      {product.productName}
                    </p>
                    <span className="text-[12px] font-black text-orange-600">
                      {Math.round(product.valueShare * 100)}%
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-sm bg-slate-200">
                    <div
                      className="h-full bg-gradient-to-r from-orange-500 to-orange-200"
                      style={{
                        width: `${Math.min(Math.round(product.valueShare * 100), 100)}%`,
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px]">
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
        <Card className="rounded-sm border border-slate-200 bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-slate-100 text-slate-600 ring-1 ring-slate-200">
              <ListChecks className="h-3.5 w-3.5" />
            </div>
            <div>
              <p className="text-[13px] font-black text-slate-950">
                Draft Rows
              </p>
              <p className="text-[10px] font-medium text-slate-400">
                {workspace.drafts.length > 0
                  ? `${Math.min(workspace.drafts.length, 6)} of ${workspace.drafts.length} shown`
                  : "No drafts yet"}
              </p>
            </div>
          </div>
          <div className="mt-3 space-y-1.5">
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="animate-pulse rounded-sm border border-slate-100 bg-slate-50 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-2">
                      <div className="h-2.5 w-20 rounded-sm bg-slate-200" />
                      <div className="h-4 w-16 rounded-sm bg-slate-200" />
                    </div>
                    <div className="h-5 w-20 rounded-sm bg-slate-200" />
                  </div>
                  <div className="mt-2 h-2.5 w-24 rounded-sm bg-slate-200" />
                </div>
              ))
            ) : (
              <>
                {workspace.drafts.slice(0, 6).map((draft) => (
                  <div
                    className={`rounded-sm border p-2.5 transition-colors duration-700 ${
                      highlightDraftId === draft.id
                        ? "border-orange-300 bg-orange-50/60"
                        : "border-slate-100 bg-slate-50/60"
                    }`}
                    key={draft.id}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-mono text-[10px] font-bold text-slate-500">
                          {draft.requestCode}
                        </p>
                        <p className="mt-0.5 text-[13px] font-black text-slate-950">
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
                      <span className="flex items-center gap-1 text-[10px] font-medium text-slate-400">
                        <CalendarDays className="h-2.5 w-2.5" />
                        {draft.requestDate}
                      </span>
                      <span className="text-[10px] font-bold text-slate-500">
                        {Math.round(draft.roiCoverageRatio * 100)}%
                        {" "}forecast coverage
                      </span>
                    </div>
                  </div>
                ))}
                {workspace.drafts.length === 0 ? (
                  <p className="rounded-sm border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-[12px] font-medium text-slate-400">
                    No draft rows yet.
                  </p>
                ) : (
                  <p className="mt-1 text-center text-[10px] font-semibold text-slate-400">
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
        <Card className="overflow-hidden rounded-sm border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-orange-600">
                  Finance Evidence
                </p>
                <h2 className="mt-0.5 text-[15px] font-black tracking-tight text-slate-950">
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
                  className="h-9 w-full rounded-sm border border-slate-200 bg-white pl-8 pr-3 text-[13px] font-medium text-slate-800 outline-none placeholder:text-slate-400 focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
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
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full border-collapse text-left text-[12px]">
                  <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-[0.10em] text-slate-500">
                    <tr>
                      <th className="border-b border-r border-slate-100 px-3 py-2">
                        Transfer Date
                      </th>
                      <th className="border-b border-r border-slate-100 px-3 py-2">
                        Line
                      </th>
                      <th className="border-b border-r border-slate-100 px-3 py-2">
                        Contact
                      </th>
                      <th className="border-b border-r border-slate-100 px-3 py-2">
                        Customer
                      </th>
                      <th className="border-b border-r border-slate-100 px-3 py-2">
                        Notes
                      </th>
                      <th className="border-b border-r border-slate-100 px-3 py-2 text-right">
                        Amount
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
                        <td className="border-r border-slate-100 px-3 py-2 font-medium text-slate-600">
                          {row.moneyTransferDate ?? "-"}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2 font-medium text-slate-600">
                          {row.line ?? "-"}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2">
                          <p className="font-bold text-slate-900">
                            {row.contactForMoneyTransfer}
                          </p>
                          <p className="mt-0.5 font-mono text-[10px] font-medium text-slate-400">
                            {row.requesterHrId}
                          </p>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2 font-bold text-slate-900">
                          {row.customerName}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2 text-slate-500">
                          <p className="text-[11px] font-medium break-words">
                            {row.notes || "-"}
                          </p>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2 text-right font-bold text-slate-900">
                          {egp(row.sumOfAmount)}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2">
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
                        </td>
                        <td className="px-3 py-2">
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
                          className="px-3 py-6 text-center text-[12px] font-medium text-slate-400"
                          colSpan={8}
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
                  <p className="px-4 py-5 text-center text-[11px] font-medium text-slate-400">
                    {approvedSearch
                      ? "No matching results."
                      : "No approved requests yet."}
                  </p>
                ) : (
                  filteredApproved.map((row) => (
                    <div key={row.id} className="space-y-2 px-3 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[13px] font-bold text-slate-950">
                            {row.customerName}
                          </p>
                          <p className="mt-0.5 text-[10px] font-medium text-slate-400">
                            {row.contactForMoneyTransfer}
                            {row.requesterHrId
                              ? ` (${row.requesterHrId})`
                              : ""}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-sm bg-slate-100 px-2 py-0.5 text-[12px] font-black text-slate-900">
                          {egp(row.sumOfAmount)}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                        <span className="font-medium text-slate-400">
                          Transfer
                        </span>
                        <span className="text-right font-bold text-slate-600">
                          {row.moneyTransferDate ?? "-"}
                        </span>
                        <span className="font-medium text-slate-400">
                          Line
                        </span>
                        <span className="text-right font-bold text-slate-600">
                          {row.line ?? "-"}
                        </span>
                      </div>

                      {row.notes ? (
                        <p className="text-[10px] font-medium text-slate-500 break-words">
                          {row.notes}
                        </p>
                      ) : null}

                      <div className="grid grid-cols-2 gap-1.5 pt-0.5">
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
        <Card className="overflow-hidden rounded-sm border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-600">
                  Action Needed
                </p>
                <h2 className="mt-0.5 text-[15px] font-black tracking-tight text-slate-950">
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
              <p className="rounded-sm border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-[12px] font-medium text-slate-400">
                Nothing returned to you right now.
              </p>
            ) : (
              workspace.returnedToMe.map((request) => {
                const progress =
                  workspace.stepProgressByRequestId[request.id] ?? null;
                return (
                  <div
                    className="rounded-sm border border-amber-200 bg-amber-50/40 p-3"
                    key={request.id}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-mono text-[10px] font-bold text-slate-500">
                          {request.requestCode}
                        </p>
                        <p className="mt-0.5 text-[13px] font-black text-slate-950">
                          {customerNameMap.get(request.customerId) ??
                            "Customer"}
                        </p>
                        <p className="mt-0.5 text-[11px] font-medium text-slate-500">
                          {requestTypeNameMap.get(request.requestTypeId) ??
                            "Request"}{" "}
                          · {egp(request.estimatedCost)}
                        </p>
                      </div>
                      <button
                        className="flex shrink-0 items-center gap-1.5 rounded-sm bg-orange-500 px-3 py-2 text-[12px] font-bold text-white shadow-sm transition hover:bg-orange-600"
                        onClick={() => void startResubmit(request)}
                        type="button"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit &amp; Resubmit
                      </button>
                    </div>
                    {progress?.returnReason ? (
                      <p className="mt-2 rounded-sm border border-amber-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-amber-800">
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
        <Card className="overflow-hidden rounded-sm border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-orange-600">
                  In Flight
                </p>
                <h2 className="mt-0.5 text-[15px] font-black tracking-tight text-slate-950">
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
              <p className="rounded-sm border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-[12px] font-medium text-slate-400">
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
                    className="rounded-sm border border-slate-200 bg-slate-50/50 p-3"
                    key={request.id}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-mono text-[10px] font-bold text-slate-500">
                          {request.requestCode}
                        </p>
                        <p className="mt-0.5 text-[13px] font-black text-slate-950">
                          {customerNameMap.get(request.customerId) ??
                            "Customer"}
                        </p>
                        <p className="mt-0.5 text-[11px] font-medium text-slate-500">
                          {requestTypeNameMap.get(request.requestTypeId) ??
                            "Request"}{" "}
                          · {egp(request.estimatedCost)}
                        </p>
                      </div>
                      <button
                        aria-expanded={expanded}
                        className="flex shrink-0 items-center gap-1 rounded-sm border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-700 transition hover:bg-slate-50"
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
                      <MarketingProgressStrip progress={progress} />
                    </div>

                    {expanded ? (
                      <div className="mt-2 border-t border-slate-200 pt-2">
                        {loadingDetailId === request.id && !detail ? (
                          <div className="flex items-center gap-2 px-1 py-2 text-[11px] font-medium text-slate-400">
                            <LoadingSpinner />
                            Loading timeline...
                          </div>
                        ) : detail ? (
                          <>
                            <MarketingApprovalTimeline steps={detail.steps} />
                            {detail.viewerCanComment ? (
                              <div className="mt-3 rounded-sm border border-sky-200 bg-sky-50/40 px-3 py-3">
                                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-sky-700">
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
                          <p className="px-1 py-2 text-[11px] font-medium text-slate-400">
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

        {/* ------ Drafts ------------------------------------------------------------------------------------------------------------------------------------- */}
        <Card className="overflow-hidden rounded-sm border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
                  Not Submitted
                </p>
                <h2 className="mt-0.5 text-[15px] font-black tracking-tight text-slate-950">
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
              <p className="rounded-sm border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-[12px] font-medium text-slate-400">
                No drafts yet.
              </p>
            ) : (
              workspace.drafts.map((draft) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-slate-100 bg-slate-50/60 p-3"
                  key={draft.id}
                >
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] font-bold text-slate-500">
                      {draft.requestCode}
                    </p>
                    <p className="mt-0.5 text-[13px] font-black text-slate-950">
                      {customerNameMap.get(draft.customerId) ?? "Customer"}
                    </p>
                    <p className="mt-0.5 text-[11px] font-medium text-slate-500">
                      {requestTypeNameMap.get(draft.requestTypeId) ??
                        "Request"}{" "}
                      · {egp(draft.estimatedCost)}
                    </p>
                  </div>
                  <button
                    className="flex shrink-0 items-center gap-1 rounded-sm border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-700 transition hover:bg-slate-50"
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
        <div className="rounded-sm border border-slate-200 bg-white px-3 py-2 text-[12px] font-medium text-slate-500">
          You have review access to marketing requests. Draft creation is limited to assigned requesters in the employee directory.
        </div>
      ) : !isLoading &&
        (workspace.customers.length === 0 ||
          workspace.products.length === 0) ? (
        <div className="rounded-sm border border-slate-200 bg-white px-3 py-2 text-[12px] font-medium text-slate-500">
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
