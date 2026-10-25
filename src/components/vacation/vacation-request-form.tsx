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
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileText,
  SendHorizonal,
  WifiOff,
  X,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { Input } from "@/components/ui/input";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { PageContainer } from "@/components/layout/page-container";
import { isOwnedByViewer, normalizeOwnerHrId } from "@/lib/browser-storage/owner-scoped";
import { addDaysToDateOnly, parseDateOnly, toDateOnlyString } from "@/lib/date-only";
import {
  availableBalanceAfterPending,
  calculateVacationDurationDays,
  getAnnualVacationMinimumStartDate,
  getVacationPolicyWarnings,
  getVacationPolicyToday,
  vacationUnpaidReasonLabel,
} from "@/lib/vacation/calculations";
import type {
  VacationBalanceSnapshot,
  VacationDayPart,
  VacationEmployeeSummary,
  VacationType,
  VacationWeeklyOffPolicyRecord,
} from "@/lib/vacation/types";
import { VACATION_DAY_PARTS, VACATION_REQUEST_TYPES } from "@/lib/vacation/types";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import {
  phxButtonAccentClassName,
  phxLabelTextClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";


/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Types ────────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

type VacationRequestFormProps = {
  initialData: {
    balance: VacationBalanceSnapshot | null;
    balances?: Partial<Record<VacationType, VacationBalanceSnapshot | null>>;
    dayPartOptions: ReadonlyArray<{ label: string; value: VacationDayPart }>;
    employee: VacationEmployeeSummary;
    manager: VacationEmployeeSummary | null;
    managerOfManager: VacationEmployeeSummary | null;
    thirdManager?: VacationEmployeeSummary | null;
    pendingPaidDaysByType?: Partial<Record<VacationType, number>>;
    vacationTypeOptions: ReadonlyArray<{ label: string; value: VacationType }>;
    weeklyOffPolicy: VacationWeeklyOffPolicyRecord | null;
  } | null;
  initialError: string | null;
  showHero?: boolean;
};

type VacationRequestPageTab = "request" | "policy" | "national";

type NationalHoliday = {
  description: string | null;
  durationDays: number;
  endDate: string | null;
  id: string;
  name: string;
  startDate: string;
};

type NationalHolidayPayload = {
  calendarId: string | null;
  connected: boolean;
  holidays: NationalHoliday[];
  message: string | null;
  month: number;
  sourceLabel: string;
  success: boolean;
  year: number;
};

type QueuedVacationSubmission = {
  createdAt: number;
  id: string;
  lastSyncError: string | null;
  /**
   * Whose request this is. Absent on entries queued before 2026-10-26, which are never sent: the
   * replay posts under the SIGNED-IN session, so an entry replayed for the wrong person became that
   * person's leave request (src/lib/browser-storage/owner-scoped.ts).
   */
  ownerHrId?: string;
  payload: QueuedVacationPayload;
  retryCount: number;
};

type QueuedVacationPayload = {
  dayPart: VacationDayPart;
  employeeNote?: string;
  endDate: string;
  otherReason?: string;
  startDate: string;
  vacationType: Exclude<VacationType, "compensatory" | "sick">;
};

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Offline Queue Hook (#2) + SSR Hydration Guard ────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

const vacationQueueDbName = "phoenix-vacation-offline-queue";
const vacationQueueStoreName = "queued-submissions";

function openVacationQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(vacationQueueDbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(vacationQueueStoreName)) {
        db.createObjectStore(vacationQueueStoreName, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB is unavailable."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function readQueuedVacationSubmissions() {
  const db = await openVacationQueueDb();
  return new Promise<QueuedVacationSubmission[]>((resolve, reject) => {
    const request = db.transaction(vacationQueueStoreName, "readonly").objectStore(vacationQueueStoreName).getAll();
    request.onerror = () => reject(request.error ?? new Error("Unable to read vacation offline queue."));
    request.onsuccess = () => resolve((request.result ?? []) as QueuedVacationSubmission[]);
  });
}

async function putQueuedVacationSubmission(submission: QueuedVacationSubmission) {
  const db = await openVacationQueueDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(vacationQueueStoreName, "readwrite").objectStore(vacationQueueStoreName).put(submission);
    request.onerror = () => reject(request.error ?? new Error("Unable to save vacation offline queue."));
    request.onsuccess = () => resolve();
  });
}

async function deleteQueuedVacationSubmission(id: string) {
  const db = await openVacationQueueDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(vacationQueueStoreName, "readwrite").objectStore(vacationQueueStoreName).delete(id);
    request.onerror = () => reject(request.error ?? new Error("Unable to remove queued vacation submission."));
    request.onsuccess = () => resolve();
  });
}

/**
 * The queue is per BROWSER, and a shared phone serves several people, so the hook only ever replays,
 * counts or adds entries for `ownerHrId` — the signed-in person. Another person's entries stay
 * stored for when they sign back in; an un-owned legacy entry is removed, since nobody can be told
 * it was theirs.
 */
function useOfflineQueue(onReplay: (payload: QueuedVacationPayload) => Promise<void>, ownerHrId: string) {
  const [queue, setQueue] = useState<QueuedVacationSubmission[]>([]);
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
    readQueuedVacationSubmissions()
      .then((stored) => {
        const unowned = stored.filter((item) => !normalizeOwnerHrId(item.ownerHrId));
        for (const item of unowned) void deleteQueuedVacationSubmission(item.id).catch(() => undefined);
        setQueue(stored.filter((item) => normalizeOwnerHrId(item.ownerHrId)));
      })
      .catch(() => undefined);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const ownQueue = queue.filter((item) => isOwnedByViewer(item.ownerHrId, ownerHrId));

  // Replay queue when back online — the signed-in person's own entries only.
  useEffect(() => {
    const pending = queue.filter((item) => isOwnedByViewer(item.ownerHrId, ownerHrId));
    if (!isOnline || pending.length === 0 || replayingRef.current) return;
    replayingRef.current = true;

    (async () => {
      for (const item of pending) {
        try {
          await onReplay(item.payload);
          await deleteQueuedVacationSubmission(item.id);
          setQueue((current) => current.filter((q) => q.id !== item.id));
        } catch (error) {
          const failed = { ...item, lastSyncError: error instanceof Error ? error.message : "Replay failed.", retryCount: item.retryCount + 1 };
          await putQueuedVacationSubmission(failed).catch(() => undefined);
          setQueue((current) => current.map((q) => q.id === item.id ? failed : q));
          break; // Stop on first failure — will retry next online event
        }
      }
      replayingRef.current = false;
    })();
  }, [isOnline, queue, onReplay, ownerHrId]);

  /** False, and nothing stored, when the page does not know who is signed in: an un-owned entry is never sent. */
  async function enqueue(payload: QueuedVacationPayload): Promise<boolean> {
    const owner = normalizeOwnerHrId(ownerHrId);
    if (!owner) return false;
    const submission: QueuedVacationSubmission = {
      createdAt: Date.now(),
      id: `q-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      lastSyncError: null,
      ownerHrId: owner,
      payload,
      retryCount: 0,
    };
    await putQueuedVacationSubmission(submission);
    setQueue((current) => [...current, submission]);
    return true;
  }

  return { enqueue, isOnline, queueLength: ownQueue.length };
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Helpers ──────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function formatDays(days: number) {
  return `${Number(days.toFixed(2))} day${days === 1 ? "" : "s"}`;
}

function durationDisplay(days: number) {
  if (days === 0.5) return "Half day";
  if (days === 1) return "1 day";
  return `${Number(days.toFixed(2))} days`;
}

function dateLabel(value: string) {
  return stableEnGbFormatter({
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function dateParts(value: string) {
  const parsed = parseDateOnly(value) ?? new Date();
  return {
    month: parsed.getMonth() + 1,
    year: parsed.getFullYear(),
  };
}

function dateOnlyFromParts(year: number, month: number, day: number) {
  return toDateOnlyString(new Date(year, month - 1, day)) ?? "";
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate();
}

function isFridayDate(value: string) {
  const parsed = parseDateOnly(value);
  return parsed?.getDay() === 5;
}

function isRequestDateSelectable(input: {
  compensatoryEventDate: string;
  date: string;
  dayPart: VacationDayPart;
  endDate: string;
  picker: "start" | "end";
  startDate: string;
  vacationType: VacationType;
}) {
  if (isFridayDate(input.date)) return false;

  const today = todayDateOnly();
  if (input.date < today) return false;

  if (input.picker === "end") {
    if (input.dayPart !== "full_day") return input.date === input.startDate;
    if (input.date < input.startDate) return false;
  }

  if (input.vacationType === "emergency") {
    return input.date === today;
  }

  if (input.vacationType === "annual") {
    // Annual vacation may start today. The shared guard above already blocks past dates and
    // Fridays; a same-day annual request is reclassified to "emergency" by the backend.
    return input.date >= today;
  }

  if (input.vacationType === "compensatory" && input.compensatoryEventDate) {
    const expiryDate = addDaysToDateOnly(input.compensatoryEventDate, 14);
    if (input.date < input.compensatoryEventDate) return false;
    if (expiryDate && input.date > expiryDate) return false;
  }

  return true;
}

function todayDateOnly() {
  return getVacationPolicyToday();
}

function annualMinimumDateOnly() {
  return getAnnualVacationMinimumStartDate();
}

function currentMonthSelection() {
  const now = new Date();
  return {
    month: now.getMonth() + 1,
    year: now.getFullYear(),
  };
}

function monthLabel(month: number, year: number) {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

// DATE-ONLY (a national-holiday date, a `date` column), which `new Date` parses as UTC midnight. UTC
// here is CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset. Not
// an instant — do not "fix" this one to Cairo.
function formatHolidayDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function stepMonth(month: number, year: number, delta: number) {
  let m = month + delta;
  let y = year;
  if (m > 12) {
    m = 1;
    y++;
  }
  if (m < 1) {
    m = 12;
    y--;
  }
  return { month: m, year: y };
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Skeleton Loaders ─────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function HolidayTableSkeleton() {
  return (
    <div className="animate-pulse border border-slate-200 bg-white">
      <div className="flex gap-4 border-b border-slate-100 bg-slate-50 px-3 py-2.5">
        {[80, 56, 56, 44].map((w, i) => (
          <div key={i} className="h-2.5 bg-slate-200" style={{ width: `${w}px` }} />
        ))}
      </div>
      {[0, 1, 2].map((r) => (
        <div key={r} className="flex gap-4 border-b border-slate-50 px-3 py-3">
          {[120, 64, 64, 44].map((w, c) => (
            <div key={c} className="h-3 bg-slate-100" style={{ width: `${w}px` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Balance Usage Bar ────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function BalanceUsageBar({
  balance,
  pendingPaidDays,
}: {
  balance: VacationBalanceSnapshot | null | undefined;
  pendingPaidDays: number;
}) {
  if (!balance || !balance.entitlementDays) return null;

  const usedPct = Math.min((balance.usedPaidDays / balance.entitlementDays) * 100, 100);
  // Held days stack on top of the used days and share the same 100% ceiling, so the bar cannot
  // overflow its track when someone has requested more than is left.
  const pendingPct = Math.min((pendingPaidDays / balance.entitlementDays) * 100, 100 - usedPct);
  const remainPct = 100 - usedPct - pendingPct;

  const barColor =
    remainPct >= 60
      ? "from-emerald-600 to-emerald-300"
      : remainPct >= 30
        ? "from-amber-500 to-amber-300"
        : "from-rose-600 to-rose-300";

  return (
    <div className="mt-3 space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-x-2 text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-400">
        <span>
          Used {formatDays(balance.usedPaidDays)}
          {pendingPaidDays > 0 ? <> + {formatDays(pendingPaidDays)} awaiting approval</> : null}
        </span>
        <span>of {formatDays(balance.entitlementDays)}</span>
      </div>
      <div className="flex h-2 w-full overflow-hidden bg-slate-100">
        <div
          className={cn("h-full bg-gradient-to-r transition-all duration-500", barColor)}
          style={{ width: `${usedPct}%` }}
        />
        <div
          className="h-full bg-amber-300 transition-all duration-500"
          style={{ width: `${pendingPct}%` }}
        />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Balance Card ─────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function VacationBalanceCard({
  balance,
  pendingPaidDays,
}: {
  balance: VacationBalanceSnapshot | null | undefined;
  pendingPaidDays: number;
}) {
  const isFirstSixMonthsLock = balance?.unpaidReason === "first_six_months";
  const headlineLabel = isFirstSixMonthsLock ? "Accrued balance" : "Available balance";
  // The headline counts leave the employee has already taken but nobody has decided yet. Without
  // this, someone who books a week and is still waiting on an approver sees an untouched balance
  // and books it again — the number only moved on approval, which can be weeks later.
  const availableDays = balance ? availableBalanceAfterPending(balance.balanceBeforeDays, pendingPaidDays) : 0;
  const headlineValue = balance
    ? formatDays(isFirstSixMonthsLock ? balance.entitlementDays : availableDays)
    : "-";
  const description = isFirstSixMonthsLock
    ? "Accrued balance is tracked from the hire date but becomes available after completing 6 months."
    : balance?.unpaidReason
      ? vacationUnpaidReasonLabel(balance.unpaidReason)
      : pendingPaidDays > 0
        ? "Approved paid vacations, less the days already requested and awaiting approval."
        : "Available based on current approved paid vacations.";

  return (
    <div className="border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-400">
            {headlineLabel}
          </p>
          <p className="mt-1.5 text-[1.75rem] font-extrabold leading-none tracking-[-0.04em] text-slate-900">
            {headlineValue}
          </p>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-orange-50 text-orange-500">
          <CalendarDays className="h-4 w-4" />
        </div>
      </div>

      <p className="mt-2 text-phx-sm font-medium leading-5 text-slate-500">{description}</p>

      <BalanceUsageBar balance={balance} pendingPaidDays={pendingPaidDays} />

      {pendingPaidDays > 0 ? (
        <p className="mt-2 text-phx-sm font-semibold leading-5 text-amber-700">
          {formatDays(pendingPaidDays)} already requested and waiting for a decision. Held from this
          balance now; it is charged for real when the request is approved.
        </p>
      ) : null}

      {isFirstSixMonthsLock && balance ? (
        <p className="mt-2 text-phx-sm font-semibold leading-5 text-amber-700">
          Available now: {formatDays(availableDays)}. Not available for use yet.
        </p>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Summary Person ───────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

/** A name, never the HR ID under it — the owner's rule is human-readable names, never raw IDs. */
function VacationSummaryPerson({
  label,
  name,
}: {
  label: string;
  name: string;
}) {
  return (
    <div className="border border-slate-100 bg-slate-50/50 px-3 py-3">
      <p className="text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-400">
        {label}
      </p>
      <p className="mt-1 break-words text-phx-md font-semibold leading-5 text-slate-900">
        {name}
      </p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Date Picker (focus trap + click outside) ─────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function VacationDatePicker({
  compensatoryEventDate,
  dayPart,
  disabled = false,
  endDate,
  label,
  onChange,
  picker,
  startDate,
  vacationType,
  value,
}: {
  compensatoryEventDate: string;
  dayPart: VacationDayPart;
  disabled?: boolean;
  endDate: string;
  label: string;
  onChange: (value: string) => void;
  picker: "start" | "end";
  startDate: string;
  vacationType: VacationType;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [panelDate, setPanelDate] = useState<{ month: number; year: number } | null>(null);
  const [focusedDay, setFocusedDay] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedParts = dateParts(value);
  const visibleMonth = panelDate?.month ?? selectedParts.month;
  const visibleYear = panelDate?.year ?? selectedParts.year;

  const totalDaysInMonth = daysInMonth(visibleYear, visibleMonth);
  const monthDays = Array.from({ length: totalDaysInMonth }, (_, index) => index + 1);
  const firstDayOffset = new Date(visibleYear, visibleMonth - 1, 1).getDay();
  const yearOptions = Array.from({ length: 8 }, (_, index) => new Date().getFullYear() - 1 + index);

  // Reset focused day when calendar opens or month changes.
  useEffect(() => {
    if (open) {
      const sel = dateParts(value);
      if (sel.month === visibleMonth && sel.year === visibleYear) {
        const parsed = parseDateOnly(value);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: sync keyboard focus target when panel opens/navigates
        setFocusedDay(parsed ? parsed.getDate() : 1);
      } else {
        setFocusedDay(1);
      }
    }
  }, [open, visibleMonth, visibleYear, value]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  // Focus trap + Escape + Arrow key navigation (#5)
  useEffect(() => {
    if (!open) return;
    const container = dropdownRef.current;
    if (!container) return;

    const focusableSelector =
      'button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    // Focus first element on open
    const firstEl = container.querySelector<HTMLElement>(focusableSelector);
    firstEl?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }

      // Arrow key calendar navigation (#5)
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(e.key)) {
        const activeEl = document.activeElement;
        const isDayButton =
          activeEl instanceof HTMLButtonElement &&
          activeEl.closest("[data-calendar-grid]") !== null;

        if (isDayButton || e.key === "Enter") {
          e.preventDefault();

          setFocusedDay((current) => {
            if (current === null) return 1;
            let next = current;
            if (e.key === "ArrowLeft") next = Math.max(1, current - 1);
            if (e.key === "ArrowRight") next = Math.min(totalDaysInMonth, current + 1);
            if (e.key === "ArrowUp") next = Math.max(1, current - 7);
            if (e.key === "ArrowDown") next = Math.min(totalDaysInMonth, current + 7);
            if (e.key === "Enter") {
              // Select the currently focused date
              const date = dateOnlyFromParts(visibleYear, visibleMonth, current);
              const selectable = isRequestDateSelectable({
                compensatoryEventDate,
                date,
                dayPart,
                endDate,
                picker,
                startDate,
                vacationType,
              });
              if (selectable) {
                onChange(date);
                setPanelDate(null);
                setOpen(false);
                triggerRef.current?.focus();
              }
              return current;
            }
            return next;
          });
          return;
        }
      }

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
  }, [open, totalDaysInMonth, visibleMonth, visibleYear, compensatoryEventDate, dayPart, endDate, onChange, picker, startDate, vacationType]);

  // Auto-focus the focused day button when focusedDay changes
  useEffect(() => {
    if (!open || focusedDay === null) return;
    const container = dropdownRef.current;
    if (!container) return;
    const btn = container.querySelector<HTMLButtonElement>(`[data-day="${focusedDay}"]`);
    btn?.focus();
  }, [open, focusedDay]);

  return (
    <div className="relative space-y-1.5">
      <span className={phxLabelTextClassName}>{label}</span>
      <button
        ref={triggerRef}
        className={cn(
          "flex h-10 w-full items-center justify-between border border-slate-200 bg-white px-3 text-left text-phx-md font-semibold text-slate-800 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-100",
          disabled ? "cursor-not-allowed opacity-55" : "hover:border-orange-200",
        )}
        disabled={disabled}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{dateLabel(value)}</span>
        <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
      </button>

      {open && !disabled ? (
        // The calendar never narrows below 300px, which is wider than one column of the two-up date
        // row on a laptop with the sidebar open (~296px). Anchored left, the END picker's calendar
        // then hung past the card's right edge; anchoring it right makes the extra width grow back
        // into the card instead.
        <div
          ref={dropdownRef}
          className={cn(
            "absolute z-30 mt-1 w-full min-w-[300px] border border-slate-200 bg-white p-3 shadow-[0_8px_24px_rgba(15,23,42,0.12)]",
            picker === "end" ? "right-0" : "left-0",
          )}
        >
          <div className="grid grid-cols-2 gap-1.5">
            <SearchableSelect
              className="h-9 px-2 text-phx-md"
              value={visibleMonth}
              onChange={(event) =>
                setPanelDate({
                  month: Number(event.target.value),
                  year: visibleYear,
                })}
            >
              {Array.from({ length: 12 }, (_, index) => index + 1).map((monthValue) => (
                <option key={monthValue} value={monthValue}>
                  {new Intl.DateTimeFormat("en", { month: "long" }).format(new Date(Date.UTC(2026, monthValue - 1, 1)))}
                </option>
              ))}
            </SearchableSelect>
            <SearchableSelect
              className="h-9 px-2 text-phx-md"
              value={visibleYear}
              onChange={(event) =>
                setPanelDate({
                  month: visibleMonth,
                  year: Number(event.target.value),
                })}
            >
              {yearOptions.map((yearValue) => (
                <option key={yearValue} value={yearValue}>{yearValue}</option>
              ))}
            </SearchableSelect>
          </div>

          <div className="mt-2 grid grid-cols-7 gap-0.5 text-center text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
              <span className={day === "Fri" ? "text-rose-500" : ""} key={day}>{day}</span>
            ))}
          </div>
          <div className="mt-1.5 grid grid-cols-7 gap-0.5" data-calendar-grid>
            {Array.from({ length: firstDayOffset }).map((_, index) => (
              <span key={`empty-${index}`} />
            ))}
            {monthDays.map((day) => {
              const date = dateOnlyFromParts(visibleYear, visibleMonth, day);
              const friday = isFridayDate(date);
              const selectable = isRequestDateSelectable({
                compensatoryEventDate,
                date,
                dayPart,
                endDate,
                picker,
                startDate,
                vacationType,
              });
              const selected = date === value;
              const focused = focusedDay === day;
              return (
                <button
                  className={cn(
                    "h-8 text-phx-md font-bold transition",
                    selected ? "bg-orange-500 text-white" : "",
                    !selected && focused ? "ring-2 ring-orange-300" : "",
                    !selected && friday ? "bg-rose-50 text-rose-500" : "",
                    !selected && !friday && selectable ? "bg-white text-slate-800 hover:bg-orange-50" : "",
                    !selected && !selectable && !friday ? "bg-slate-50 text-slate-300" : "",
                    !selectable ? "cursor-not-allowed" : "",
                  )}
                  data-day={day}
                  disabled={!selectable}
                  key={date}
                  tabIndex={focused ? 0 : -1}
                  type="button"
                  onClick={() => {
                    onChange(date);
                    setPanelDate(null);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-phx-xs font-medium leading-4 text-slate-400">
            Fridays in red. Grey dates outside current vacation policy.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Policy Data ──────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

const applicationPolicyItems = [
  {
    example: "Example: if an employee is hired on 1 Feb 2026, the first-year Annual balance accrues at 1.25 days per month. After the first anniversary, the monthly accrual becomes 1.75 days.",
    rule: "Annual Leave is accrued monthly. The first employment year is based on 15 days per year, then 21 days per year after completing one full year of service.",
    situation: "Use this when the employee requests a planned future vacation.",
    title: "Annual balance accrual",
    tone: "green",
  },
  {
    example: "Example: if today is 21 May and the employee requests 21 May, the system treats it as Emergency. If the employee requests 22 May or later, it stays Normal Annual when balance is available.",
    rule: "Annual requests are classified automatically as Normal, Emergency, or Unpaid. The employee does not choose the subtype.",
    situation: "Use this to understand why the final subtype may differ from the selected request type.",
    title: "Automatic Annual classification",
    tone: "yellow",
  },
  {
    example: "Example: a full-day Emergency request submitted at 9:30 AM can remain paid if balance and eligibility allow it. The same request submitted at 10:15 AM is submitted as unpaid for review. PM-only Emergency can be submitted later.",
    rule: "Emergency requests must be for today only. Full-day and AM-only Emergency should be submitted before 10:00 AM Cairo time. PM-only Emergency can be submitted later.",
    situation: "Use this when the employee needs same-day leave.",
    title: "Emergency same-day rule",
    tone: "red",
  },
  {
    example: "Example: an employee hired on 1 April 2026 who requests annual vacation on 15 August 2026 will be marked unpaid because the employee has not completed 6 months yet.",
    rule: "Before completing 6 months from hire date, every annual vacation request is unpaid.",
    situation: "Use this for any employee still inside the first 6 months of employment.",
    title: "First 6 months",
    tone: "red",
  },
  {
    example: "Example: if the request duration is 3 days and the available paid balance is 1.5 days, the request is not rejected automatically. The available 1.5 days are deducted from the paid balance, and the remaining 1.5 days are submitted as unpaid for manager and HR review.",
    rule: "If available paid balance is not enough, the system does not create negative balance. The request is split into the paid balance available and the remaining unpaid days.",
    situation: "Use this when balance is insufficient but the business still needs the request to go through approval.",
    title: "Insufficient balance",
    tone: "red",
  },
  {
    example: "Example: if Friday is full off for the employee title, a Thursday-to-Sunday request counts Thursday, Saturday, and Sunday only.",
    rule: "Duration is calculated automatically from the selected dates, day part, public holidays, and the Vacation Control weekly-off setup for the employee title.",
    situation: "Use this when the request crosses Fridays, Saturdays, half-days, or configured weekly-off days.",
    title: "Duration calculation",
    tone: "green",
  },
  {
    example: "Example: if an official national holiday is on 23 July, a vacation request ending on 22 July or starting on 24 July will be rejected because it is directly attached to the official holiday.",
    rule: "Vacation requests are not allowed directly before or directly after an official national holiday. This is the only policy case where the system rejects the request automatically.",
    situation: "Use this when reviewing vacation dates around official national holidays.",
    title: "Official holiday adjacency",
    tone: "red",
  },
  {
    example: "Example: a one-day vacation on 22 May must be entered from 22 May to 22 May. AM-only and PM-only requests are always single-date requests.",
    rule: "A single-day request uses the same start and end date. Half-day requests cannot span multiple dates.",
    situation: "Use this when the employee is requesting one day or half a day.",
    title: "Single-day and half-day entry",
    tone: "green",
  },
  {
    example: "Example: if the employee uploads a private medical insurance form from GlobeMed only, this does not qualify as Sick vacation. The Sick request must include a stamped governmental hospital certificate. If the employee selects Other, the notes must explain the reason so HR can decide how it should be treated.",
    rule: "Sick vacation requires a medical certificate stamped from a governmental hospital to integrate with social insurance. Private medical insurance forms, including GlobeMed forms, do not qualify as Sick vacation documents. Other vacation requires explanation and HR review before deciding whether it affects balance, does not affect balance, or will be unpaid.",
    situation: "Use this for medical leave or non-standard vacation reasons.",
    title: "Sick and Other requests",
    tone: "yellow",
  },
  {
    example: "Example: if an employee worked during a Friday conference on 1 May, the compensatory day can be used up to 15 May. After that two-week window, the compensatory day expires.",
    rule: "Compensatory Day is used as a day off instead of a worked weekly-off event day. It does not deduct from Annual balance and must be used within 14 days from the event date.",
    situation: "Use this when the employee worked during an approved event or conference on a weekly off day.",
    title: "Compensatory Day",
    tone: "green",
  },
  {
    example: "Example: if a workday has no CRM entry or a day is missing in CRM, and there is no approved Phoenix vacation or official national holiday, the day will be handled as absence. If the employee has available vacation balance, it will be deducted from that balance. If there is no available balance, the day will be deducted from monthly payroll. If CRM visits are below the required KPI, repeated cases may be treated as partial absence, such as half-day or quarter-day absence, based on the visit count and after prior communication.",
    rule: "CRM is integrated with Phoenix. A workday should not have no CRM entry unless the employee has an approved Phoenix vacation request or the day is an official national holiday. Daily work, daily visits, and required CRM KPIs are counted in Phoenix attendance logic.",
    situation: "Use this when checking daily visits on CRM, below-KPI visits, and repeated CRM action cases.",
    title: "CRM and Phoenix Integration",
    tone: "red",
  },
] as const;

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Policy Panel ─────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function VacationPolicyPanel() {
  const toneClasses = {
    green: {
      card: "border-emerald-100 bg-emerald-50/60",
      label: "text-emerald-600",
      text: "text-emerald-900",
    },
    red: {
      card: "border-rose-100 bg-rose-50/70",
      label: "text-rose-600",
      text: "text-rose-900",
    },
    yellow: {
      card: "border-amber-100 bg-amber-50/70",
      label: "text-amber-600",
      text: "text-amber-900",
    },
  } as const;

  return (
    <div className="border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-orange-600">Application Policy</p>
            <h3 className="mt-1 text-base font-extrabold tracking-[-0.02em] text-slate-900">How vacation requests are classified and reviewed</h3>
            <p className="mt-1.5 text-phx-md font-medium leading-5 text-slate-600">
              These rules explain what the system calculates automatically and what remains subject to manager and HR review.
            </p>
          </div>
          <Badge className="w-fit border border-orange-200 bg-orange-50 px-2.5 py-1 text-phx-2xs font-bold uppercase tracking-[0.12em] text-orange-700">
            Policy Guide
          </Badge>
        </div>

        <div className="grid gap-2">
          {applicationPolicyItems.map((item, index) => (
            <div
              className="border border-slate-200 bg-white px-3 py-3"
              key={item.title}
            >
              <div className="flex items-start gap-2.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center bg-orange-50 text-phx-xs font-bold text-orange-700">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h4 className="text-phx-md font-bold text-slate-900">{item.title}</h4>
                  <p className="mt-1 text-phx-sm font-medium leading-5 text-slate-700">{item.rule}</p>
                  <div className="mt-2 grid gap-1.5 lg:grid-cols-2">
                    <div className="border border-slate-100 bg-slate-50 px-2.5 py-2">
                      <p className="text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-400">Situation</p>
                      <p className="mt-0.5 text-phx-xs font-medium leading-4 text-slate-600">{item.situation}</p>
                    </div>
                    <div className={cn("border px-2.5 py-2", toneClasses[item.tone].card)}>
                      <p className={cn("text-phx-2xs font-bold uppercase tracking-[0.10em]", toneClasses[item.tone].label)}>Example</p>
                      <p className={cn("mt-0.5 text-phx-xs font-medium leading-4", toneClasses[item.tone].text)}>{item.example}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── National Holidays Panel (smart filter + mobile cards) ────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function NationalEgyptianVacationPanel() {
  const initialSelection = useMemo(() => currentMonthSelection(), []);
  const [month, setMonth] = useState(initialSelection.month);
  const [year, setYear] = useState(initialSelection.year);
  const [data, setData] = useState<NationalHolidayPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      setLoading(true);
      setError(null);

      fetch(`/api/vacations/national-holidays?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(typeof payload.message === "string" ? payload.message : "Unable to load Egyptian national holidays.");
          }
          setData(payload as NationalHolidayPayload);
        })
        .catch((loadError) => {
          if (controller.signal.aborted) return;
          setError(loadError instanceof Error ? loadError.message : "Unable to load Egyptian national holidays.");
          setData(null);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [month, year]);

  const yearOptions = useMemo(() => {
    const currentYear = initialSelection.year;
    return Array.from({ length: 11 }, (_, index) => currentYear - 5 + index);
  }, [initialSelection.year]);

  function goPrev() {
    const next = stepMonth(month, year, -1);
    setMonth(next.month);
    setYear(next.year);
  }

  function goNext() {
    const next = stepMonth(month, year, 1);
    setMonth(next.month);
    setYear(next.year);
  }

  return (
    <div className="border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-orange-600">Google Calendar Connection</p>
          <h3 className="mt-1 text-base font-extrabold tracking-normal text-slate-900">National Egyptian holiday</h3>
          <p className="mt-1.5 text-phx-md font-medium leading-5 text-slate-600">
            Connected to Google Calendar. Government holiday decisions can be moved or shifted. Follow the official HR announcement before taking any national holiday.
          </p>
        </div>
        <Badge className="w-fit border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-phx-2xs font-bold uppercase tracking-[0.12em] text-emerald-700">
          Google Calendar
        </Badge>
      </div>

      {/* ── Smart period filter ─────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap items-center gap-1.5 border border-slate-200 bg-slate-50 p-1.5">
        <button
          className="flex h-8 w-8 shrink-0 items-center justify-center border border-slate-200 bg-white text-slate-500 transition hover:bg-orange-50 hover:text-orange-600"
          onClick={goPrev}
          title="Previous month"
          type="button"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>

        <SearchableSelect
          aria-label="National holidays month"
          className="h-8 flex-1 min-w-[100px] px-2 text-phx-md"
          value={month}
          onChange={(event) => setMonth(Number(event.target.value))}
        >
          {Array.from({ length: 12 }, (_, index) => index + 1).map((monthValue) => (
            <option key={monthValue} value={monthValue}>
              {new Intl.DateTimeFormat("en", { month: "long" }).format(new Date(Date.UTC(2026, monthValue - 1, 1)))}
            </option>
          ))}
        </SearchableSelect>

        <SearchableSelect
          aria-label="National holidays year"
          className="h-8 w-[80px] shrink-0 px-2 text-phx-md"
          value={year}
          onChange={(event) => setYear(Number(event.target.value))}
        >
          {yearOptions.map((yearValue) => (
            <option key={yearValue} value={yearValue}>{yearValue}</option>
          ))}
        </SearchableSelect>

        <button
          className="flex h-8 w-8 shrink-0 items-center justify-center border border-slate-200 bg-white text-slate-500 transition hover:bg-orange-50 hover:text-orange-600"
          onClick={goNext}
          title="Next month"
          type="button"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ── Content ────────────────────────────────────────────────── */}
      <div className="mt-3">
        {error ? (
          <AdminCallout tone="danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </AdminCallout>
        ) : null}

        {data?.message ? (
          <AdminCallout tone={data.connected ? "warning" : "danger"}>
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{data.message}</span>
          </AdminCallout>
        ) : null}

        {loading ? (
          <HolidayTableSkeleton />
        ) : data && !data.connected ? null : data?.holidays.length ? (
          <>
            {/* Desktop table (xs+) */}
            <div className="hidden md:block overflow-hidden border border-slate-200 bg-white">
              <table className="w-full border-collapse text-left text-phx-sm">
                <thead className="bg-slate-50 text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500">
                  <tr>
                    <th className="border-b border-r border-slate-100 px-3 py-2">Holiday</th>
                    <th className="border-b border-r border-slate-100 px-3 py-2">Start</th>
                    <th className="border-b border-r border-slate-100 px-3 py-2">End</th>
                    <th className="border-b border-slate-100 px-3 py-2">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {data.holidays.map((holiday) => (
                    <tr className="align-top transition hover:bg-orange-50/30" key={holiday.id}>
                      <td className="border-r border-slate-100 px-3 py-2">
                        <p className="font-bold text-slate-900">{holiday.name}</p>
                        {holiday.description ? (
                          <p className="mt-0.5 text-phx-xs font-medium leading-4 text-slate-500">{holiday.description}</p>
                        ) : null}
                      </td>
                      <td className="border-r border-slate-100 px-3 py-2 font-medium text-slate-700">
                        {formatHolidayDate(holiday.startDate)}
                      </td>
                      <td className="border-r border-slate-100 px-3 py-2 font-medium text-slate-700">
                        {formatHolidayDate(holiday.endDate ?? holiday.startDate)}
                      </td>
                      <td className="px-3 py-2">
                        <Badge className="w-fit border border-emerald-200 bg-emerald-50 text-emerald-700">
                          {formatDays(holiday.durationDays)}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile card view (< xs) */}
            <div className="block md:hidden space-y-2">
              {data.holidays.map((holiday) => (
                <div key={holiday.id} className="border border-slate-200 bg-white p-3">
                  <p className="text-phx-md font-bold text-slate-900">{holiday.name}</p>
                  {holiday.description ? (
                    <p className="mt-0.5 text-phx-xs font-medium leading-4 text-slate-500">{holiday.description}</p>
                  ) : null}
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <div>
                      <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Start</p>
                      <p className="mt-0.5 text-phx-sm font-medium text-slate-700">{formatHolidayDate(holiday.startDate)}</p>
                    </div>
                    <div>
                      <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">End</p>
                      <p className="mt-0.5 text-phx-sm font-medium text-slate-700">{formatHolidayDate(holiday.endDate ?? holiday.startDate)}</p>
                    </div>
                    <div>
                      <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Duration</p>
                      <Badge className="mt-0.5 w-fit border border-emerald-200 bg-emerald-50 text-emerald-700">
                        {formatDays(holiday.durationDays)}
                      </Badge>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="border border-slate-200 bg-white px-3 py-4 text-phx-md font-medium text-slate-600">
            No official Egyptian national vacations found for {monthLabel(month, year)} in Google Calendar.
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Attachment upload transport ───────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

// Sick documents and compensatory-day event photos are often phone camera photos (routinely 5-9MB),
// which exceed Vercel's ~4.5MB serverless request-body cap. Files above this threshold stream straight
// to Storage via a short-lived signed upload URL instead of riding through the submit request body;
// the submit call then references the file by storage path. Small files keep the original direct path.
const LARGE_ATTACHMENT_THRESHOLD = 4 * 1024 * 1024;

// Hard ceiling for a single evidence file. Matches the server-side limit (route-guards + service.ts)
// and the leave-attachments storage bucket file_size_limit. Files above this are rejected client-side
// with a clear message before any upload is attempted.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_LABEL = "20MB";

// A sick request may carry several documents (owner, 2026-10-03). Ten at a time matches the add-more
// route's own per-call cap; more can be added after submitting, which is the point of the feature.
const MAX_SICK_DOCUMENTS = 10;

async function uploadVacationAttachmentToStorage(file: File, kind: "sick" | "compensatory"): Promise<string> {
  const urlRes = await fetch("/api/vacations/attachments/upload-url", {
    body: JSON.stringify({ fileName: file.name, kind }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const urlPayload = (await urlRes.json().catch(() => ({}))) as { signedUrl?: string; path?: string; message?: string };
  if (!urlRes.ok || !urlPayload.signedUrl || !urlPayload.path) {
    throw new Error(urlPayload.message ?? "Could not start the upload for this file.");
  }
  const putRes = await fetch(urlPayload.signedUrl, {
    body: file,
    headers: { "content-type": file.type || "application/octet-stream", "x-upsert": "false" },
    method: "PUT",
  });
  if (!putRes.ok) throw new Error("The file could not be uploaded. Please try again.");
  return urlPayload.path;
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Exported Component (Error Boundary Wrapper) ──────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

export function VacationRequestForm(props: VacationRequestFormProps) {
  return (
    <WorkspaceErrorBoundary fallbackTitle="Vacation request failed to load">
      <VacationRequestFormInner {...props} />
    </WorkspaceErrorBoundary>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Main Form ────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function VacationRequestFormInner({ initialData, initialError, showHero = true }: VacationRequestFormProps) {
  const router = useRouter();
  // Stay on the current surface after submit: this form renders on both /leave-management/vacation-request
  // (admin) and /employee-portals/vacation-request (portal). Pushing the admin report URL from the portal
  // bounces the user through the (admin) layout to /employee-portals (the landing page).
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<VacationRequestPageTab>("request");
  const [vacationType, setVacationType] = useState<VacationType>("annual");
  const [dayPart, setDayPart] = useState<VacationDayPart>("full_day");
  const [startDate, setStartDate] = useState(annualMinimumDateOnly());
  const [endDate, setEndDate] = useState(annualMinimumDateOnly());
  // Every medical document picked for this request, in the order picked. Picking again ADDS to the
  // list — it never replaces it — which is the same rule the post-submit upload follows.
  const [sickDocuments, setSickDocuments] = useState<File[]>([]);
  const [otherReason, setOtherReason] = useState("");
  const [compensatoryEventName, setCompensatoryEventName] = useState("");
  const [compensatoryEventDate, setCompensatoryEventDate] = useState("");
  const [compensatoryEventLocation, setCompensatoryEventLocation] = useState("");
  const [compensatoryManager1, setCompensatoryManager1] = useState("");
  const [compensatoryManager2, setCompensatoryManager2] = useState("");
  const [compensatoryPhoto, setCompensatoryPhoto] = useState<File | null>(null);
  const [employeeNote, setEmployeeNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [error, setError] = useState(initialError);

  // Offline queue (#2)
  const replayVacationRequest = useCallback(async (payload: QueuedVacationPayload) => {
    const response = await fetch("/api/vacations/requests", {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(typeof body.message === "string" ? body.message : "Replay failed.");
    }
  }, []);

  const { enqueue, isOnline, queueLength } = useOfflineQueue(replayVacationRequest, initialData?.employee.hrId ?? "");

  // Reject an oversized evidence file at selection time so the employee gets an immediate, clear
  // message (with the actual file size) instead of a confusing failure when the upload runs.
  function selectAttachment(file: File | null, label: string, setter: (next: File | null) => void) {
    if (file && file.size > MAX_ATTACHMENT_BYTES) {
      const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
      setError(`${label} is too large (${sizeMb}MB). Maximum size is ${MAX_ATTACHMENT_LABEL}.`);
      setter(null);
      return;
    }
    setError(null);
    setter(file);
  }

  // Picking medical documents ADDS to what is already listed, so a second trip to the file picker
  // (one scan at a time, which is how a phone gallery hands them over) does not throw away the first.
  // A file already listed under the same name and size is not added twice.
  function addSickDocuments(files: File[]) {
    if (files.length === 0) return;
    const oversized = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      const sizeMb = (oversized.size / (1024 * 1024)).toFixed(1);
      setError(`${oversized.name} is too large (${sizeMb}MB). Maximum size is ${MAX_ATTACHMENT_LABEL} per file.`);
      return;
    }
    setSickDocuments((current) => {
      const next = [...current];
      for (const file of files) {
        if (next.length >= MAX_SICK_DOCUMENTS) break;
        if (next.some((existing) => existing.name === file.name && existing.size === file.size)) continue;
        next.push(file);
      }
      return next;
    });
    setError(
      files.length + sickDocuments.length > MAX_SICK_DOCUMENTS
        ? `Up to ${MAX_SICK_DOCUMENTS} documents can be attached here. You can upload more after submitting.`
        : null,
    );
  }

  function removeSickDocument(index: number) {
    setSickDocuments((current) => current.filter((_, position) => position !== index));
  }

  const durationPreview = useMemo(() => {
    try {
      return {
        days: calculateVacationDurationDays({
          dayPart,
          endDate,
          startDate,
          weeklyOffPolicy: initialData?.weeklyOffPolicy,
        }),
        error: null,
      };
    } catch (previewError) {
      return {
        days: 0,
        error: previewError instanceof Error ? previewError.message : "Invalid vacation dates.",
      };
    }
  }, [dayPart, endDate, initialData?.weeklyOffPolicy, startDate]);

  const policyWarnings = useMemo(
    () => getVacationPolicyWarnings({ dayPart, endDate, startDate, vacationType }),
    [dayPart, endDate, startDate, vacationType],
  );

  function buildFormData(storagePaths: { sick?: string[] | null; compensatory?: string | null } = {}) {
    const formData = new FormData();
    formData.append("dayPart", dayPart);
    formData.append("endDate", endDate);
    if (employeeNote.trim()) formData.append("employeeNote", employeeNote.trim());
    formData.append("startDate", startDate);
    formData.append("vacationType", vacationType);
    if (vacationType === "other") {
      formData.append("otherReason", otherReason);
    }
    // One transport for the whole set, so the order the employee picked survives: either every file
    // rides in this body, or every file was streamed to Storage and is named by its path here.
    if (sickDocuments.length > 0) {
      const sickPaths = storagePaths.sick ?? [];
      if (sickPaths.length > 0) {
        sickDocuments.forEach((file, index) => {
          const path = sickPaths[index];
          if (!path) return;
          formData.append("sickAttachmentStoragePath", path);
          // Carry the original type/name so server-side validation uses the same source as the direct
          // path (browser File.type/name), independent of what Storage reports on download.
          formData.append("sickAttachmentContentType", file.type);
          formData.append("sickAttachmentFileName", file.name);
        });
      } else {
        for (const file of sickDocuments) formData.append("sickDocument", file);
      }
    }
    if (vacationType === "compensatory") {
      formData.append("compensatoryEventDate", compensatoryEventDate);
      formData.append("compensatoryEventLocation", compensatoryEventLocation);
      formData.append("compensatoryEventName", compensatoryEventName);
      formData.append("compensatoryManager1", compensatoryManager1);
      formData.append("compensatoryManager2", compensatoryManager2);
      if (compensatoryPhoto) {
        if (storagePaths.compensatory) {
          formData.append("compensatoryAttachmentStoragePath", storagePaths.compensatory);
          // Carry the original type/name so server-side validation uses the same source as the direct
          // path (browser File.type/name), independent of what Storage reports on download.
          formData.append("compensatoryAttachmentContentType", compensatoryPhoto.type);
          formData.append("compensatoryAttachmentFileName", compensatoryPhoto.name);
        } else {
          formData.append("compensatoryPhoto", compensatoryPhoto);
        }
      }
    }
    return formData;
  }

  function buildQueuedPayload(): QueuedVacationPayload | null {
    if (vacationType === "sick" || vacationType === "compensatory") return null;
    return {
      dayPart,
      employeeNote: employeeNote.trim() || undefined,
      endDate,
      otherReason: vacationType === "other" ? otherReason : undefined,
      startDate,
      vacationType,
    };
  }

  async function submitRequest() {
    setSubmitting(true);
    setError(null);

    // Offline queue fallback (#2)
    if (!isOnline) {
      const queuedPayload = buildQueuedPayload();
      if (!queuedPayload) {
        setSubmitting(false);
        setError("Online connection is required for evidence upload. Sick and compensatory vacation requests cannot be queued offline.");
        return;
      }
      const queued = await enqueue(queuedPayload);
      setSubmitting(false);
      if (!queued) {
        setError("Your request could not be saved offline. Reconnect and submit it again.");
        return;
      }
      setSubmitSuccess(true);
      setTimeout(() => {
        setSubmitSuccess(false);
      }, 2200);
      return;
    }

    try {
      const storagePaths: { sick?: string[] | null; compensatory?: string | null } = {};
      // The TOTAL matters, not each file: five 3MB photos ride in one body and would meet the same
      // ~4.5MB cap a single large file does. Over the threshold, every file goes to Storage first.
      const sickTotalBytes = sickDocuments.reduce((sum, file) => sum + file.size, 0);
      if (sickDocuments.length > 0 && sickTotalBytes > LARGE_ATTACHMENT_THRESHOLD) {
        const paths: string[] = [];
        for (const file of sickDocuments) {
          paths.push(await uploadVacationAttachmentToStorage(file, "sick"));
        }
        storagePaths.sick = paths;
      }
      if (vacationType === "compensatory" && compensatoryPhoto && compensatoryPhoto.size > LARGE_ATTACHMENT_THRESHOLD) {
        storagePaths.compensatory = await uploadVacationAttachmentToStorage(compensatoryPhoto, "compensatory");
      }
      const formData = buildFormData(storagePaths);

      const response = await fetch("/api/vacations/requests", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "Vacation request failed.");
      }

      // Optimistic success animation (#3)
      setSubmitSuccess(true);
      setTimeout(() => {
        const reportBase = pathname?.startsWith("/employee-portals")
          ? "/employee-portals/vacation-report"
          : "/leave-management/vacation-report";
        // `tab=requests` is what puts the request just sent on screen. The report opens on its
        // Entitlements tab by default, so the status filter alone landed the employee on their
        // balance row with the new request one tab away — the one thing they came to confirm.
        router.push(`${reportBase}?tab=requests&status=pending_manager`);
        router.refresh();
      }, 1200);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Vacation request failed.");
    } finally {
      setSubmitting(false);
    }
  }

  const balance = initialData?.balances?.[vacationType] ?? initialData?.balance;
  // Days held by this employee’s own submitted-but-undecided requests, in the same pool as the
  // selected type (annual and emergency share one; the rest stand alone).
  const pendingPaidDays = initialData?.pendingPaidDaysByType?.[vacationType] ?? 0;
  const isSick = vacationType === "sick";
  const isOther = vacationType === "other";
  const isCompensatory = vacationType === "compensatory";
  const compensatoryExpiryDate = isCompensatory && compensatoryEventDate
    ? addDaysToDateOnly(compensatoryEventDate, 14)
    : null;
  const compensatoryDateError = isCompensatory && compensatoryEventDate
    ? compensatoryEventDate > todayDateOnly()
      ? "Compensatory Day cannot be submitted before the event has taken place. Submit it on or after the event date, with the event photo."
      : startDate < compensatoryEventDate
      ? "Compensatory Day cannot be requested before the event date."
      : compensatoryExpiryDate && startDate > compensatoryExpiryDate
        ? `Compensatory Day expires on ${formatHolidayDate(compensatoryExpiryDate)}. It must be used within 14 days from the event date.`
        : null
    : null;
  const submitDisabled =
    !initialData ||
    !initialData.balance ||
    submitting ||
    Boolean(durationPreview.error) ||
    (isSick && sickDocuments.length === 0) ||
    (isOther && !otherReason.trim()) ||
    (isCompensatory && (
      !compensatoryEventName.trim() ||
      !compensatoryEventDate ||
      !compensatoryEventLocation.trim() ||
      !compensatoryManager1.trim() ||
      !compensatoryPhoto ||
      Boolean(compensatoryDateError)
    ));

  function updateVacationType(value: VacationType) {
    setVacationType(value);
    setSickDocuments([]);
    setOtherReason("");
    setCompensatoryEventName("");
    setCompensatoryEventDate("");
    setCompensatoryEventLocation("");
    setCompensatoryManager1("");
    setCompensatoryManager2("");
    setCompensatoryPhoto(null);
    if (value === "emergency") {
      const today = todayDateOnly();
      setStartDate(today);
      setEndDate(today);
      return;
    }
  }

  function updateDayPart(value: VacationDayPart) {
    setDayPart(value);
    if (value !== "full_day") {
      setEndDate(startDate);
    }
  }

  function updateStartDate(value: string) {
    const nextValue = value;
    setStartDate(nextValue);
    if (dayPart !== "full_day" || endDate < nextValue) {
      setEndDate(nextValue);
    }
  }

  /* ═══════════════════════════════════════════════════════════════ */
  /* ─── Render ───────────────────────────────────────────────────── */
  /* ═══════════════════════════════════════════════════════════════ */

  const tabItems = [
    { label: "Vacation Request", value: "request" as const },
    { label: "Vacation Policy", value: "policy" as const },
    { label: "National Holidays", value: "national" as const },
  ];

  return (
    <PageContainer className="vacation-request-premium">
      <div className="space-y-3" dir="auto">
        {showHero ? (
          <AdminPageHero
            description="Submit a vacation request for direct manager approval and HR review."
            eyebrow="Leave Management"
            icon={<CalendarDays className="h-3.5 w-3.5" />}
            title="Vacation Request"
          />
        ) : null}

        {error ? (
          <AdminCallout tone="danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </AdminCallout>
        ) : null}

        {/* ── Offline banner (#2) ────────────────────────────────── */}
        {!isOnline ? (
          <div className="flex items-center gap-2 border border-amber-200 bg-amber-50 px-3 py-2.5 text-phx-md font-bold text-amber-800">
            <WifiOff className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              You are offline. Annual, emergency, and other requests are saved in this browser and sent automatically when you reconnect. Evidence requests require online upload.
              {queueLength > 0 ? ` (${queueLength} queued)` : ""}
            </span>
          </div>
        ) : null}

        {/* ── Optimistic success animation (#3) ──────────────────── */}
        {submitSuccess ? (
          <div className="flex items-center gap-2.5 border border-emerald-200 bg-emerald-50 px-4 py-3 text-phx-md font-bold text-emerald-800 animate-in fade-in duration-300">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
            <span>{isOnline ? "Request submitted successfully. Redirecting..." : "Request queued in this browser. It will retry when you are back online."}</span>
          </div>
        ) : null}

        {/* ── Tab Bar ────────────────────────────────────────────── */}
        {/* Three equal columns on a phone. The three labels need ~380px on one line and a phone's
            content column is ~351px, so the old `overflow-x-auto` strip scrolled sideways — the
            pattern the fits-the-screen rule names. Each label now wraps inside its own third. */}
        <div
          className="grid w-full grid-cols-3 gap-0.5 border border-slate-200 bg-slate-50 p-0.5 sm:flex"
          role="tablist"
          aria-label="Vacation request page tabs"
        >
          {tabItems.map((tab) => {
            const active = activeTab === tab.value;
            return (
              <button
                aria-selected={active}
                className={cn(
                  "min-h-9 px-2 py-1 text-center text-phx-md font-bold leading-tight transition sm:shrink-0 sm:whitespace-nowrap sm:px-3",
                  active ? "bg-white text-orange-600 shadow-sm" : "text-slate-500 hover:bg-white/70 hover:text-slate-700",
                )}
                key={tab.value}
                role="tab"
                type="button"
                onClick={() => setActiveTab(tab.value)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* ── Tab Content ────────────────────────────────────────── */}
        {activeTab === "policy" ? (
          <VacationPolicyPanel />
        ) : activeTab === "national" ? (
          <NationalEgyptianVacationPanel />
        ) : (
          <div className="space-y-3">
            {/* ── Balance + Summary strip ─────────────────────────── */}
            <div className="grid gap-2 xl:grid-cols-[280px_1fr]">
              <VacationBalanceCard balance={balance} pendingPaidDays={pendingPaidDays} />

              <div className="border border-slate-200 bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
                <div
                  className={
                    initialData?.thirdManager
                      ? "grid gap-2 md:grid-cols-[1fr_1fr_1fr_1fr_auto] md:items-center"
                      : "grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto] md:items-center"
                  }
                >
                  <VacationSummaryPerson
                    label="Employee"
                    name={initialData?.employee.displayName ?? "-"}
                  />
                  <VacationSummaryPerson
                    label="Direct manager"
                    name={initialData?.manager?.displayName ?? "Not assigned"}
                  />
                  <VacationSummaryPerson
                    label="Manager of manager"
                    name={initialData?.managerOfManager?.displayName ?? (initialData?.manager ? "Top of hierarchy" : "Not assigned")}
                  />
                  {initialData?.thirdManager ? (
                    <VacationSummaryPerson label="Third approver" name={initialData.thirdManager.displayName} />
                  ) : null}
                  <Badge
                    className="w-fit px-3 py-1.5 text-phx-2xs font-bold tracking-[0.12em] md:justify-self-end"
                    variant={balance?.paymentStatus === "paid" ? "success" : "warning"}
                  >
                    {balance?.paymentStatus === "paid"
                      ? "Paid eligible"
                      : balance?.paymentStatus === "partial"
                        ? `${formatDays(balance.paidDurationDays)} paid / ${formatDays(balance.unpaidDurationDays)} unpaid`
                        : "Unpaid if requested today"}
                  </Badge>
                </div>
              </div>
            </div>

            {/* ── Main form card ──────────────────────────────────── */}
            <div className="border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
              <div className="grid gap-3 sm:grid-cols-2">
                {/* Vacation type selector */}
                <div className="space-y-1.5 sm:col-span-2">
                  <span className={phxLabelTextClassName}>Vacation type</span>
                  <div
                    className="grid grid-cols-2 gap-1 border border-slate-200 bg-slate-50 p-0.5 sm:grid-cols-4"
                    role="tablist"
                    aria-label="Vacation type"
                  >
                    {(initialData?.vacationTypeOptions ?? VACATION_REQUEST_TYPES).map((option) => {
                      const active = vacationType === option.value;
                      return (
                        <button
                          key={option.value}
                          aria-selected={active}
                          className={cn(
                            "min-h-[36px] px-2 py-1.5 text-phx-sm font-bold transition sm:text-phx-md",
                            active ? "bg-white text-orange-600 shadow-sm" : "text-slate-500 hover:bg-white/70 hover:text-slate-700",
                          )}
                          role="tab"
                          type="button"
                          onClick={() => updateVacationType(option.value)}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Day part */}
                <div className="space-y-1.5">
                  <span className={phxLabelTextClassName}>Day part</span>
                  <ChoiceGroup
                    aria-label="Day part"
                    className="grid-cols-3"
                    onChange={updateDayPart}
                    options={initialData?.dayPartOptions ?? VACATION_DAY_PARTS}
                    value={dayPart}
                  />
                </div>

                {/* Date pickers */}
                <VacationDatePicker
                  compensatoryEventDate={compensatoryEventDate}
                  dayPart={dayPart}
                  endDate={endDate}
                  label="Vacation start from"
                  picker="start"
                  startDate={startDate}
                  vacationType={vacationType}
                  value={startDate}
                  onChange={updateStartDate}
                />

                <VacationDatePicker
                  compensatoryEventDate={compensatoryEventDate}
                  dayPart={dayPart}
                  disabled={dayPart !== "full_day"}
                  endDate={endDate}
                  label="Vacation to"
                  picker="end"
                  startDate={startDate}
                  vacationType={vacationType}
                  value={endDate}
                  onChange={setEndDate}
                />

                {/* Duration preview */}
                <div className="border border-orange-100 bg-orange-50/60 px-3 py-3 sm:col-span-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-orange-700">Calculated duration</p>
                      <p className="mt-1 text-xl font-extrabold text-slate-900">
                        {durationPreview.error ? "Invalid" : durationDisplay(durationPreview.days)}
                      </p>
                      <p className="mt-0.5 text-phx-xs font-medium text-orange-800">
                        Duration updates automatically based on selected dates and day part.
                      </p>
                    </div>
                    {!durationPreview.error ? (
                      <Badge className="w-fit border border-orange-200 bg-white text-orange-700">
                        {formatDays(durationPreview.days)}
                      </Badge>
                    ) : null}
                  </div>
                  {durationPreview.error ? <p className="mt-2 text-phx-sm font-semibold text-rose-700">{durationPreview.error}</p> : null}
                  {policyWarnings.length > 0 ? (
                    <div className="mt-2 border border-amber-200 bg-amber-50 px-2.5 py-2 text-phx-xs font-bold leading-4 text-amber-800">
                      {policyWarnings.map((warning) => (
                        <p key={warning}>{warning}</p>
                      ))}
                      <p className="mt-1 text-amber-700">The request can still be submitted for human review. HR owns the final decision.</p>
                    </div>
                  ) : null}
                </div>

                {/* Sick document upload — several files, and picking again ADDS to the list */}
                {isSick ? (
                  <div className="space-y-1.5 sm:col-span-2">
                    <span className={phxLabelTextClassName}>Medical documents</span>
                    <label className="flex cursor-pointer flex-col items-center justify-center border-2 border-dashed border-sky-200 bg-sky-50/50 px-4 py-4 text-center transition hover:border-sky-300 hover:bg-sky-50">
                      <input
                        accept=".pdf,.doc,.docx,image/jpeg,image/png,image/webp"
                        className="sr-only"
                        multiple
                        type="file"
                        // Cleared after every pick so choosing the SAME file again, or coming back
                        // for a second scan, still fires a change event and adds to the list.
                        onChange={(event) => {
                          addSickDocuments(Array.from(event.target.files ?? []));
                          event.target.value = "";
                        }}
                      />
                      <span className="bg-sky-600 px-3 py-1.5 text-phx-md font-bold text-white shadow-sm">
                        {sickDocuments.length > 0 ? "Add more documents" : "Browse medical documents"}
                      </span>
                      <span className="mt-1.5 text-phx-xs font-medium leading-4 text-slate-600">
                        Upload a stamped governmental hospital document. Several photos or PDFs can be attached — picking again adds to the list. PDF, Word, JPG, PNG, or WEBP accepted. Up to {MAX_ATTACHMENT_LABEL} per file.
                      </span>
                    </label>
                    {sickDocuments.length > 0 ? (
                      <ul className="space-y-1">
                        {sickDocuments.map((file, index) => (
                          <li
                            className="flex items-start justify-between gap-2 border border-slate-200 bg-white px-2.5 py-1.5"
                            key={`${file.name}-${file.size}`}
                          >
                            <span className="flex min-w-0 items-start gap-1.5 text-phx-xs font-semibold leading-4 text-slate-700">
                              <FileText className="mt-0.5 h-3 w-3 shrink-0 text-sky-600" />
                              <span className="break-words">
                                {file.name} <span className="font-medium text-slate-500">({(file.size / (1024 * 1024)).toFixed(1)}MB)</span>
                              </span>
                            </span>
                            <button
                              aria-label={`Remove ${file.name}`}
                              className="shrink-0 border border-slate-200 p-1 text-slate-500 transition hover:border-rose-200 hover:text-rose-600"
                              onClick={() => removeSickDocument(index)}
                              type="button"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="text-phx-xs font-medium text-slate-500">
                      {sickDocuments.length > 0
                        ? `${sickDocuments.length} document${sickDocuments.length === 1 ? "" : "s"} attached. You can upload more after submitting, and they are added to these — nothing is replaced.`
                        : "At least one document is required for sick vacation requests."}
                    </p>
                  </div>
                ) : null}

                {/* Other reason */}
                {isOther ? (
                  <label className="space-y-1.5 sm:col-span-2">
                    <span className={phxLabelTextClassName}>Other vacation explanation</span>
                    <textarea
                      className={cn(phxTextareaClassName, "min-h-24")}
                      placeholder="Explain what this Other vacation is for. HR will review whether it affects balance, does not affect balance, or will be unpaid."
                      required
                      value={otherReason}
                      onChange={(event) => setOtherReason(event.target.value)}
                    />
                    <p className="text-phx-xs font-medium text-slate-500">
                      Required for Other vacation requests.
                    </p>
                  </label>
                ) : null}

                {/* Compensatory evidence */}
                {isCompensatory ? (
                  <div className="space-y-3 border border-orange-100 bg-orange-50/40 p-3 sm:col-span-2">
                    <div>
                      <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-orange-700">Compensatory Day evidence</p>
                      <p className="mt-0.5 text-phx-xs font-medium leading-4 text-orange-800">
                        Required because this day is granted instead of work done during a weekly-off event. Does not deduct from vacation balance and expires 14 days after the event date.
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="space-y-1.5">
                        <span className={phxLabelTextClassName}>Event name</span>
                        <Input
                          placeholder="Conference or event name"
                          required
                          value={compensatoryEventName}
                          onChange={(event) => setCompensatoryEventName(event.target.value)}
                        />
                      </label>
                      <label className="space-y-1.5">
                        <span className={phxLabelTextClassName}>Event date</span>
                        <Input
                          required
                          type="date"
                          value={compensatoryEventDate}
                          onChange={(event) => setCompensatoryEventDate(event.target.value)}
                        />
                        {compensatoryExpiryDate ? (
                          <p className="text-phx-xs font-medium text-orange-800">
                            Available until {formatHolidayDate(compensatoryExpiryDate)}.
                          </p>
                        ) : null}
                      </label>
                      <label className="space-y-1.5 sm:col-span-2">
                        <span className={phxLabelTextClassName}>Event location</span>
                        <Input
                          placeholder="Venue, city, or territory"
                          required
                          value={compensatoryEventLocation}
                          onChange={(event) => setCompensatoryEventLocation(event.target.value)}
                        />
                      </label>
                      <label className="space-y-1.5">
                        <span className={phxLabelTextClassName}>Manager with you 1</span>
                        <Input
                          placeholder="Manager name"
                          required
                          value={compensatoryManager1}
                          onChange={(event) => setCompensatoryManager1(event.target.value)}
                        />
                      </label>
                      <label className="space-y-1.5">
                        <span className={phxLabelTextClassName}>Manager with you 2</span>
                        <Input
                          placeholder="Manager name (optional)"
                          value={compensatoryManager2}
                          onChange={(event) => setCompensatoryManager2(event.target.value)}
                        />
                      </label>
                      <div className="space-y-1.5 sm:col-span-2">
                        <label className={phxLabelTextClassName} htmlFor="compensatory-photo">
                          Event photo
                        </label>
                        <label className="flex cursor-pointer flex-col items-center justify-center border-2 border-dashed border-orange-200 bg-white/60 px-4 py-4 text-center transition hover:border-orange-300 hover:bg-white" htmlFor="compensatory-photo">
                          <input
                            accept="image/jpeg,image/png,image/webp"
                            className="sr-only"
                            id="compensatory-photo"
                            required
                            type="file"
                            onChange={(event) => selectAttachment(event.target.files?.[0] ?? null, "Event photo", setCompensatoryPhoto)}
                          />
                          <span className="bg-orange-500 px-3 py-1.5 text-phx-md font-bold text-white shadow-sm">
                            Browse event photo
                          </span>
                          <span className="mt-1.5 text-phx-xs font-medium leading-4 text-slate-600">
                            Upload the event or conference photo. JPG, PNG, or WEBP accepted. Up to {MAX_ATTACHMENT_LABEL}.
                          </span>
                        </label>
                        <p className="text-phx-xs font-medium text-slate-500">
                          {compensatoryPhoto ? compensatoryPhoto.name : "Required event or conference photo."}
                        </p>
                      </div>
                    </div>
                    {compensatoryDateError ? (
                      <div className="border border-rose-200 bg-rose-50 px-2.5 py-2 text-phx-xs font-bold leading-4 text-rose-800">
                        {compensatoryDateError}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {/* Optional employee note */}
                <label className="space-y-1.5 sm:col-span-2">
                  <span className={phxLabelTextClassName}>Note <span className="font-medium normal-case tracking-normal text-slate-400">(optional)</span></span>
                  <textarea
                    className={cn(phxTextareaClassName, "min-h-16")}
                    maxLength={500}
                    placeholder="Any context for your manager — travel plans, coverage arrangements, etc."
                    value={employeeNote}
                    onChange={(event) => setEmployeeNote(event.target.value)}
                  />
                  {employeeNote.length > 0 && (
                    <p className="text-phx-xs font-medium text-slate-400">{employeeNote.length}/500</p>
                  )}
                </label>
              </div>

              {/* Submit area */}
              <div className="mt-4 flex flex-col gap-2 border border-slate-100 bg-slate-50 px-3 py-3 sm:flex-row sm:items-center sm:justify-end">
                <button
                  className={cn(
                    phxButtonAccentClassName,
                    // Submitted turns the same button green — the only state the accent token does
                    // not carry, and the one thing a rep looks for after pressing it.
                    submitSuccess && "border-emerald-600 bg-emerald-600 hover:bg-emerald-700",
                  )}
                  disabled={submitDisabled || submitSuccess}
                  onClick={submitRequest}
                  type="button"
                >
                  {submitSuccess ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <SendHorizonal className="h-3.5 w-3.5" />
                  )}
                  {submitSuccess
                    ? "Submitted"
                    : submitting
                      ? "Submitting..."
                      : !isOnline
                        ? "Queue Request"
                        : "Submit Request"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
