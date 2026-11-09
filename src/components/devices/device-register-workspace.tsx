"use client";

/**
 * Company device register — the workspace.
 *
 * DESIGN IDENTITY is the HR admin workspaces', deliberately (AGENTS.md §4: match the sibling
 * pages, never invent a one-off look). Same `PremiumHero`, the same centred metric tile with its
 * 9px uppercase micro-label and `text-3xl font-black tabular-nums` figure, the same slate borders,
 * the same square corners, and the same desktop-table / mobile-card split. It is the Mailbox
 * Revocation register's twin, because it is the same kind of object: a list of open obligations
 * with a step to record against each one.
 *
 * DESKTOP GETS THE TABLE, MOBILE NEVER DOES — the owner's standing rule.
 *
 * IT FITS THE SCREEN (AGENTS.md §4). `table-fixed` with a `<colgroup>` totalling 100%, and never a
 * `min-width` under an `overflow-x-auto` — that pairing IS the bug the golden rule names, not the
 * fix for it. The width to design against is 669px, not 1280: the shell's sidebar is
 * `hidden lg:flex` at 292px, so the content box NARROWS as the viewport crosses 1024px. The action
 * column takes the largest share (34%, so ~227px at 669px) because it is the one holding a native
 * `<select>` — the employee picker — and a `<select>` is the single control the golden rule says
 * may not be shrunk. A fifth column would take it below its natural width; merge instead.
 *
 * NOTHING TRUNCATES. Long values wrap, and `break-words` is on every free-text line because an
 * asset tag, a serial and an IMEI are each one unbreakable token that ordinary wrapping cannot
 * split.
 *
 * THE PAGE LEADS WITH WHAT LEAVERS STILL HOLD, and that block sits above the table rather than
 * inside it. The custody receipt's return protocol states that final dues may not be paid before it
 * is completed — «ولا يجوز صرف المستحقات النهائية قبل استيفائه» — so the person preparing a
 * settlement has to be able to see this without filtering for it. It is a FLAG, not a block: this
 * screen never touches payroll, and the owner's standing rule across the system is that Phoenix
 * flags and a human decides.
 *
 * NO `window.prompt` OR `window.confirm`. Every reason is typed inline, against the row it is
 * about, so what somebody wrote and what they wrote it against never come apart.
 *
 * A SERIAL NUMBER OR IMEI IS CORRECTED ON ITS OWN ROW, by the Super Admin only, with a reason.
 * `/devices?correct=<entry>` — where Rep Tablets' "the register has a different IMEI" warning
 * links — opens the register on All with that entry's correction already open and scrolled to.
 */

import {
  Download,
  Laptop,
  Loader2,
  PackageCheck,
  Plus,
  RefreshCw,
  Smartphone,
  TriangleAlert,
  Upload,
  UserMinus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { PrintOptionsDialog } from "@/components/hiring-pack/print-options-dialog";
import { PremiumHero } from "@/components/ui/premium-hero";
import { CUSTODY_LAPTOP_V1, CUSTODY_MOBILE_V1 } from "@/lib/hiring-pack/custody-text";
import type {
  DeviceImportPreview,
  DeviceImportResult,
} from "@/lib/devices/bulk-import";
import { IDENTITY_REASON_MAX_LENGTH } from "@/lib/devices/device-identity";
import { importedDevicesForHandover } from "@/lib/devices/handover-queue";
import type {
  CompanyDevice,
  DeviceCategory,
  DeviceRegisterData,
  DeviceStatus,
  MarkableDeviceStatus,
  ReturnCondition,
} from "@/lib/devices/types";
import { DEVICE_STATUS_LABEL } from "@/lib/devices/types";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

type StatusFilter = "leavers" | "assigned" | "in_stock" | "missing" | "all";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "leavers", label: "Held by leavers" },
  { key: "assigned", label: "With staff" },
  { key: "in_stock", label: "In stock" },
  { key: "missing", label: "Lost or stolen" },
  { key: "all", label: "All" },
];

const CATEGORY_LABEL: Record<DeviceCategory, string> = {
  laptop: "Laptop",
  tablet: "Tablet",
  phone: "Phone",
  other: "Other",
};

const STATUS_LABEL = DEVICE_STATUS_LABEL;

const MARK_OPTIONS: { value: MarkableDeviceStatus; label: string }[] = [
  { value: "repair", label: "Send to repair" },
  { value: "lost", label: "Mark lost" },
  { value: "stolen", label: "Mark stolen" },
  { value: "retired", label: "Retire" },
  { value: "in_stock", label: "Back in stock" },
];

const RETURN_CONDITIONS: { value: ReturnCondition; label: string }[] = [
  { value: "good", label: "Good" },
  { value: "damaged", label: "Damaged" },
  { value: "incomplete", label: "Incomplete" },
];

// DATE-ONLY columns (issued_on, last_working_date), which `new Date` parses as UTC midnight. UTC
// here is CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset.
// Not an instant — do not "fix" this one to Cairo.
function formatDate(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return formatStableEnGb(parsed, {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  });
}

/** EGP, whole pounds. The estimated value is a round agreed figure, never a computed fraction. */
function formatMoney(value: number | null) {
  if (value === null) return null;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 0 })} EGP`;
}

function MetricTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "slate" | "amber" | "emerald" | "rose";
}) {
  const toneClass = {
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    slate: "text-slate-900",
  }[tone];

  return (
    <div className="min-h-32 border border-slate-200 bg-white px-4 py-4 text-center">
      <div className="text-[9px] font-black uppercase leading-tight tracking-[0.14em] text-slate-500">
        {label}
      </div>
      <p className={`mt-4 text-3xl font-black leading-none tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{sub}</p>
    </div>
  );
}

/**
 * The state chips. They WRAP — "held by a leaver for 126 days" is wider than its own column at
 * every desktop width, and `whitespace-nowrap` there overflows the cell rather than the table,
 * which no wrapper-level overflow measurement can see.
 */
function StatusChip({ device }: { device: CompanyDevice }) {
  const tone: Record<DeviceStatus, string> = {
    in_stock: "border-slate-300 bg-slate-50 text-slate-700",
    reserved: "border-violet-300 bg-violet-50 text-violet-800",
    assigned: "border-sky-300 bg-sky-50 text-sky-800",
    repair: "border-amber-300 bg-amber-50 text-amber-800",
    lost: "border-rose-300 bg-rose-50 text-rose-800",
    stolen: "border-rose-400 bg-rose-100 text-rose-900",
    retired: "border-slate-300 bg-white text-slate-500",
  };
  return (
    <span
      className={`inline-block border px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] ${tone[device.status]}`}
    >
      {STATUS_LABEL[device.status]}
    </span>
  );
}

function LeaverFlag({ device }: { device: CompanyDevice }) {
  if (!device.isHeldByLeaver) return null;
  return (
    <span className="inline-block border border-rose-400 bg-rose-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-rose-900">
      {device.holderState === "unknown"
        ? "Holder not in the directory"
        : device.daysSinceHolderLeft > 0
          ? `Left ${device.daysSinceHolderLeft} days ago`
          : "Holder has left"}
    </span>
  );
}

/** One labelled field in the register-a-device form. */
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="block text-[9px] font-black uppercase tracking-[0.14em] text-slate-500">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[10px] font-semibold text-slate-400">{hint}</span> : null}
    </label>
  );
}

const INPUT_CLASS = cn(phxFieldClassName, "mt-1 w-full min-w-0 px-2 py-1.5 text-[12px]");

type DraftKind = "issue" | "return" | "mark" | null;

/**
 * Which list an open editor belongs to.
 *
 * One device can be on screen twice — in the import result that just registered it, and in the
 * register below when the filter includes stock. Both render `DeviceActions` against the one draft,
 * so without this an editor opened in one list would open in the other as well, and what was typed
 * into either would appear in both.
 */
type DraftSurface = "register" | "import";

type Draft = {
  deviceId: string;
  kind: DraftKind;
  surface: DraftSurface;
  employeeHrId: string;
  declarationNo: string;
  handoverPlace: string;
  condition: ReturnCondition;
  shortfallNote: string;
  settlementEgp: string;
  markStatus: MarkableDeviceStatus;
  reason: string;
};

const EMPTY_DRAFT: Draft = {
  deviceId: "",
  kind: null,
  surface: "register",
  employeeHrId: "",
  declarationNo: "",
  handoverPlace: "",
  condition: "good",
  shortfallNote: "",
  settlementEgp: "",
  markStatus: "repair",
  reason: "",
};

const EMPTY_NEW_DEVICE = {
  assetTag: "",
  category: "laptop" as DeviceCategory,
  manufacturer: "",
  model: "",
  serialNumber: "",
  imei: "",
  deviceName: "",
  processor: "",
  installedRam: "",
  systemType: "",
  windowsDeviceId: "",
  windowsProductId: "",
  simNumber: "",
  lineNumber: "",
  estimatedValueEgp: "",
  purchasedOn: "",
  note: "",
};

/** Rows reach the register two ways, and the commit press has to know which it is committing. */
type ImportSource = "file" | "action1";

/** What a pull reported about itself, shown so a blank column is diagnosable on the spot. */
type Action1PullInfo = {
  endpointsSeen: number;
  fieldsSeen: string[];
  organizationId: string;
};

/** Posts a serial/IMEI correction; answers null when it saved, or the sentence it was refused with. */
type CorrectIdentity = (payload: {
  deviceId: string;
  serialNumber: string;
  imei: string;
  reason: string;
  /** What the editor opened on — the server refuses the save if the entry holds something else now. */
  shownSerialNumber: string | null;
  shownImei: string | null;
}) => Promise<string | null>;

export function DeviceRegisterWorkspace({
  canCorrectIdentity,
  canImport,
  canRecord,
  canRegister,
  initialCorrectDeviceId,
  initialData,
  initialError,
}: {
  canCorrectIdentity: boolean;
  canImport: boolean;
  canRecord: boolean;
  canRegister: boolean;
  /** `?correct=<entry>` — the entry whose serial/IMEI correction opens on arrival. */
  initialCorrectDeviceId: string | null;
  initialData: DeviceRegisterData | null;
  initialError: string | null;
}) {
  const [data, setData] = useState<DeviceRegisterData | null>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  // Only an entry that exists, and only for somebody who may correct it — anything else is ignored
  // and the page opens as it always has.
  const [focusDeviceId] = useState<string | null>(() =>
    canCorrectIdentity &&
    initialCorrectDeviceId &&
    initialData?.devices.some((device) => device.id === initialCorrectDeviceId)
      ? initialCorrectDeviceId
      : null,
  );
  // The default filter is leavers, and a tablet a rep is still using is not held by a leaver — so
  // a deep link opens on All, or the row it points at would not be on the screen.
  const [filter, setFilter] = useState<StatusFilter>(focusDeviceId ? "all" : "leavers");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [newDevice, setNewDevice] = useState(EMPTY_NEW_DEVICE);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<DeviceImportPreview | null>(null);
  const [importResult, setImportResult] = useState<DeviceImportResult | null>(null);
  /**
   * Which of the two ways rows arrived.
   *
   * The black commit button is shared, so it has to commit the source that was CHECKED. Without
   * this it would always post the spreadsheet route, and a pull from Action1 that previewed 12
   * machines would answer "choose the filled-in template first" — a refusal naming a file nobody
   * was using.
   */
  const [importSource, setImportSource] = useState<ImportSource>("file");
  const [action1Info, setAction1Info] = useState<Action1PullInfo | null>(null);

  const post = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/devices", {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as DeviceRegisterData & { message?: string };
      if (!response.ok) {
        setError(body.message ?? "The device register could not be updated.");
        return null;
      }
      setData(body);
      return body;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The request failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * The serial/IMEI correction, on its own route (`company_devices:approve`). It answers the refusal
   * rather than raising the page banner: the editor sits on the row, often far below the banner,
   * and "another entry holds this IMEI" has to be read beside the number it is about.
   */
  const correctIdentity = useCallback<CorrectIdentity>(async (payload) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/devices/identity", {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as DeviceRegisterData & { message?: string };
      if (!response.ok) return body.message ?? "The serial number or IMEI could not be corrected.";
      setData(body);
      return null;
    } catch (requestError) {
      return requestError instanceof Error ? requestError.message : "The request failed.";
    } finally {
      setBusy(false);
    }
  }, []);

  // Bring a deep-linked entry into view once. Both layouts render it, one hidden by CSS, so it
  // scrolls to whichever is actually on the screen.
  useEffect(() => {
    if (!focusDeviceId) return;
    const target = Array.from(document.querySelectorAll<HTMLElement>("[data-device-row]")).find(
      (element) => element.dataset.deviceRow === focusDeviceId && element.getClientRects().length > 0,
    );
    target?.scrollIntoView({ block: "center" });
  }, [focusDeviceId]);

  const stats = data?.stats ?? null;

  const visible = useMemo(() => {
    if (!data) return [];
    return data.devices
      .filter((device) => {
        if (filter === "all") return true;
        if (filter === "leavers") return device.isHeldByLeaver;
        if (filter === "assigned") return device.status === "assigned";
        if (filter === "in_stock") return device.status === "in_stock";
        return device.status === "lost" || device.status === "stolen";
      })
      .slice()
      .sort((left, right) => {
        // What is at risk first: a leaver's device, then the longest-standing one.
        if (left.isHeldByLeaver !== right.isHeldByLeaver) return left.isHeldByLeaver ? -1 : 1;
        if (right.daysSinceHolderLeft !== left.daysSinceHolderLeft) {
          return right.daysSinceHolderLeft - left.daysSinceHolderLeft;
        }
        return left.assetTag.localeCompare(right.assetTag);
      });
  }, [data, filter]);

  /** What the last import put in stock, for its result to offer a hand-over against. */
  const importedForHandover = useMemo(
    () => importedDevicesForHandover(importResult, data?.devices ?? []),
    [data, importResult],
  );

  const openDraft = useCallback(
    (deviceId: string, kind: Exclude<DraftKind, null>, surface: DraftSurface = "register") => {
      setDraft({ ...EMPTY_DRAFT, deviceId, kind, surface });
    },
    [],
  );

  const closeDraft = useCallback(() => setDraft(EMPTY_DRAFT), []);

  const submitDraft = useCallback(
    async (device: CompanyDevice) => {
      if (draft.kind === "issue") {
        if (!draft.employeeHrId) {
          setError("Choose who is signing for this device.");
          return;
        }
        const done = await post({
          action: "issue",
          deviceId: device.id,
          employeeHrId: draft.employeeHrId,
          declarationNo: draft.declarationNo || null,
          handoverPlace: draft.handoverPlace || null,
        });
        if (done) closeDraft();
        return;
      }

      if (draft.kind === "return") {
        if (!device.assignmentId) return;
        const done = await post({
          action: "return",
          assignmentId: device.assignmentId,
          condition: draft.condition,
          shortfallNote: draft.shortfallNote || null,
          settlementEgp: draft.settlementEgp || null,
        });
        if (done) closeDraft();
        return;
      }

      if (draft.kind === "mark") {
        const done = await post({
          action: "mark",
          deviceId: device.id,
          status: draft.markStatus,
          reason: draft.reason || null,
        });
        if (done) closeDraft();
      }
    },
    [closeDraft, draft, post],
  );

  /**
   * Sends the file to one of the two import routes.
   *
   * THE FILE IS SENT AGAIN AT COMMIT, not a preview object. The server re-parses and re-validates
   * from scratch, because the register can move between the dry run and the commit — somebody else
   * registering the same asset tag in the intervening minute has to become a reported skip rather
   * than a duplicate or a crash.
   */
  const sendImport = useCallback(
    async (step: "dry-run" | "confirm", source: ImportSource = "file") => {
      const file = importFile;
      if (source === "file" && !file) {
        setError("Choose the filled-in template first.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        // The Action1 press carries no body at all: the server pulls the fleet itself, on the
        // company's own credentials, and re-pulls at commit for the same reason the file is re-read.
        let response: Response;
        if (source === "file" && file) {
          const body = new FormData();
          body.append("file", file);
          response = await fetch(`/api/devices/import/${step}`, { body, method: "POST" });
        } else {
          response = await fetch(`/api/devices/action1/${step}`, { method: "POST" });
        }

        const payload = (await response.json()) as Partial<DeviceRegisterData> &
          DeviceImportPreview & {
            action1?: Action1PullInfo;
            importResult?: DeviceImportResult;
            message?: string;
          };

        if (!response.ok) {
          setError(payload.message ?? "The import could not be read.");
          return;
        }

        setImportSource(source);

        if (step === "dry-run") {
          setImportPreview(payload);
          setAction1Info(payload.action1 ?? null);
          setImportResult(null);
          return;
        }

        // The commit answers with the refreshed register AND the per-row report, so the counts and
        // the outcomes update together rather than the page briefly showing the old numbers.
        if (payload.devices) setData(payload as DeviceRegisterData);
        setImportResult(payload.importResult ?? null);
        setImportPreview(null);
        setAction1Info(null);
        // Only the file is cleared. A pull has nothing to clear, and clearing the chosen file after
        // an Action1 commit would silently drop a spreadsheet somebody had queued up beside it.
        if (source === "file") setImportFile(null);
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "The upload failed.");
      } finally {
        setBusy(false);
      }
    },
    [importFile],
  );

  const submitNewDevice = useCallback(async () => {
    const done = await post({ action: "register", device: newDevice });
    if (done) {
      setNewDevice(EMPTY_NEW_DEVICE);
      setRegisterOpen(false);
    }
  }, [newDevice, post]);

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <PremiumHero
        kicker="Company assets"
        subtitle="Every laptop, tablet and phone the company owns, who signed for it, and what it would take to get it back. The custody receipt already says who — this says which machine, by serial and IMEI."
        title="Device custody"
      />

      {error ? (
        <div className="mt-5 flex items-start gap-3 border border-rose-200 bg-rose-50 px-4 py-3" role="alert">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
          <p className="text-[11px] font-semibold leading-relaxed text-rose-900">{error}</p>
        </div>
      ) : null}

      {stats ? (
        <div className="mt-5 grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-3 lg:grid-cols-5">
          <MetricTile
            label="Held by leavers"
            sub="not returned"
            tone={stats.heldByLeavers > 0 ? "rose" : "emerald"}
            value={stats.heldByLeavers.toLocaleString("en-US")}
          />
          <MetricTile
            label="Value at risk"
            sub="agreed on the receipt"
            tone={stats.valueHeldByLeaversEgp > 0 ? "rose" : "emerald"}
            value={stats.valueHeldByLeaversEgp.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          />
          <MetricTile
            label="With staff"
            sub="signed out"
            tone="slate"
            value={stats.assigned.toLocaleString("en-US")}
          />
          <MetricTile
            label="Lost or stolen"
            sub="cannot be seen"
            tone={stats.missing > 0 ? "amber" : "emerald"}
            value={stats.missing.toLocaleString("en-US")}
          />
          <MetricTile
            label="In stock"
            sub="ready to issue"
            tone="slate"
            value={stats.inStock.toLocaleString("en-US")}
          />
        </div>
      ) : null}

      {/* The standing notice. One sentence saying what a device with no value on it costs, because
          it is invisible until somebody counts it and it is the difference between a claim and a
          shrug. */}
      {stats && stats.withoutValue > 0 ? (
        <div className="mt-5 flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3">
          <Smartphone aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-[11px] font-semibold leading-relaxed text-amber-900">
            {stats.withoutValue} device{stats.withoutValue === 1 ? " carries" : "s carry"} no
            estimated value. البند (10) of the custody receipt caps any recovery at the figure
            printed on the form, so a device with no value on it is one the company can recover
            nothing against — set the value before it is handed over, not after it goes missing.
          </p>
        </div>
      ) : null}

      {/* THE CLEARANCE VIEW. Above the table, and grouped by person rather than by device, because
          the question at an exit is "what does he still have and what is it worth". The receipt's
          return protocol says final dues may not be paid before it is completed. */}
      {data && data.leaversHolding.length > 0 ? (
        <div className="mt-5 border border-rose-300 bg-white px-4 py-3">
          <div className="flex items-start gap-2">
            <UserMinus aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
            <p className="min-w-0 text-[11px] font-black uppercase tracking-[0.12em] text-rose-800">
              {data.leaversHolding.length} leaver
              {data.leaversHolding.length === 1 ? "" : "s"} still holding company devices
            </p>
          </div>
          <p className="mt-2 text-[11px] font-semibold leading-relaxed text-slate-700">
            The custody receipt&apos;s return protocol is the only proof a device came back, and it
            states that final dues are not paid before it is completed. Record the return against
            each device below.
          </p>
          <ul className="mt-3 space-y-2">
            {data.leaversHolding.map((leaver) => (
              <li key={leaver.employeeHrId} className="border border-slate-200 px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="min-w-0 break-words text-[12px] font-black text-slate-900">
                    {leaver.employeeName}
                  </span>
                  <span className="min-w-0 break-words text-[11px] font-semibold text-slate-500">
                    {leaver.jobTitle ?? "Job title not recorded"}
                  </span>
                  <span className="min-w-0 break-words text-[11px] font-bold text-rose-700">
                    Last day {formatDate(leaver.lastWorkingDate)}
                    {leaver.daysSinceLastDay > 0 ? ` — ${leaver.daysSinceLastDay} days ago` : ""}
                  </span>
                </div>
                <ul className="mt-1.5 space-y-1">
                  {leaver.devices.map((device) => (
                    <li
                      key={device.assignmentId}
                      className="min-w-0 break-words text-[11px] font-semibold text-slate-700"
                    >
                      {device.assetTag} — {CATEGORY_LABEL[device.category]} — {device.identifier}
                      {device.agreedValueEgp !== null
                        ? ` — ${formatMoney(device.agreedValueEgp)}`
                        : " — no agreed value"}
                    </li>
                  ))}
                </ul>
                {leaver.totalValueEgp > 0 ? (
                  <p className="mt-1.5 text-[11px] font-black uppercase tracking-[0.1em] text-slate-600">
                    Total {formatMoney(leaver.totalValueEgp)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-1.5">
        {canRegister ? (
          <button
            className="inline-flex items-center gap-2 border border-slate-900 bg-slate-900 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-slate-800"
            onClick={() => setRegisterOpen((open) => !open)}
            type="button"
          >
            {registerOpen ? (
              <X aria-hidden="true" className="h-3 w-3" />
            ) : (
              <Plus aria-hidden="true" className="h-3 w-3" />
            )}
            {registerOpen ? "Cancel" : "Register a device"}
          </button>
        ) : null}
        {canImport ? (
          <button
            className="inline-flex items-center gap-2 border border-slate-300 bg-white px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100"
            onClick={() => setImportOpen((open) => !open)}
            type="button"
          >
            <Upload aria-hidden="true" className="h-3 w-3" />
            {importOpen ? "Close the import" : "Import a spreadsheet"}
          </button>
        ) : null}
      </div>

      {/* THE BULK IMPORT. The register is useless until the fleet already out with people is in it,
          and nobody is going to type ~85 devices into a form one at a time. Download, fill, check,
          commit — with the check as its OWN step, because an asset register is evidence and the
          cheapest moment to catch a serial in the IMEI column is before 85 rows are written. */}
      {importOpen && canImport ? (
        <div className="mt-3 border border-slate-300 bg-white px-4 py-4">
          <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-600">
            Import from a spreadsheet
          </p>
          <p className="mt-1.5 text-[11px] font-semibold leading-relaxed text-slate-500">
            The template carries a dropdown of every employee, so you can record who is already
            holding each device as you enter it. A serial number or an IMEI is required on every
            row. It takes two presses: Check the file reads it and reports what it found without
            saving anything, and the black Import button is the one that writes to the register.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <a
              className="inline-flex items-center gap-2 border border-slate-300 bg-white px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100"
              href="/api/devices/import/template"
            >
              <Download aria-hidden="true" className="h-3 w-3" />
              Blank template
            </a>
            {/* The one you want the first time. One row per current employee with the holder
                already filled, so walking the fleet is adding a tag and a serial per row instead of
                typing 180 names. A row left with only a person on it is ignored by the parser. */}
            <a
              className="inline-flex items-center gap-2 border border-slate-300 bg-white px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100"
              href="/api/devices/import/template?prefill=roster"
            >
              <Download aria-hidden="true" className="h-3 w-3" />
              Walk the fleet (everyone pre-filled)
            </a>
            <input
              accept=".xlsx"
              className="min-w-0 border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700"
              onChange={(event) => {
                setImportFile(event.target.files?.[0] ?? null);
                setImportPreview(null);
                setImportResult(null);
              }}
              type="file"
            />
            <button
              className="border border-slate-300 bg-white px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              disabled={busy || !importFile}
              onClick={() => void sendImport("dry-run")}
              type="button"
            >
              Check the file
            </button>
            {importPreview && importPreview.summary.canImport > 0 ? (
              <button
                className="border border-slate-900 bg-slate-900 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-slate-800 disabled:opacity-50"
                disabled={busy}
                onClick={() => void sendImport("confirm", importSource)}
                type="button"
              >
                Import {importPreview.summary.canImport.toLocaleString("en-US")} device
                {importPreview.summary.canImport === 1 ? "" : "s"}
              </button>
            ) : null}
          </div>

          {/*
            THE SAME TWO PRESSES, WITH NO FILE IN THE MIDDLE.

            It shares the preview and the black commit button deliberately rather than growing a
            second set: the thing being checked is identical — rows against the register — and two
            "Import" buttons on one panel is how somebody commits the pull while reading the
            spreadsheet's preview.

            It is offered whether or not Action1 is connected, because the server is the only side
            that knows, and the refusal it answers with names the two variables that fix it. A
            button hidden on an unset environment variable would read as the feature not existing.
          */}
          <div className="mt-3 border border-slate-200 bg-slate-50 px-3 py-3">
            <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-600">
              Or pull the fleet from Action1
            </p>
            <p className="mt-1.5 text-[11px] font-semibold leading-relaxed text-slate-500">
              Every machine running the Action1 agent, with its manufacturer, model, serial number,
              processor and memory read off the endpoint itself rather than copied by hand. Devices
              arrive in stock and nobody is signed for anything. The import result then lists each
              one with a Hand over button: choose who is signing for it, and that press is what the
              custody receipt records. A machine already in the register comes back as a skip, so
              this is safe to run again whenever a laptop is set up.
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <button
                className="inline-flex items-center gap-2 border border-slate-300 bg-white px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                disabled={busy}
                onClick={() => void sendImport("dry-run", "action1")}
                type="button"
              >
                <RefreshCw aria-hidden="true" className="h-3 w-3" />
                Check Action1
              </button>
              {action1Info ? (
                <span className="text-[11px] font-semibold text-slate-600">
                  {action1Info.endpointsSeen.toLocaleString("en-US")} endpoint
                  {action1Info.endpointsSeen === 1 ? "" : "s"} in organization {action1Info.organizationId}
                </span>
              ) : null}
            </div>

            {/*
              The field vocabulary the pull actually saw. This is here because the mapping was
              written against Action1's published paths but not against a live response, so if a
              column comes back empty the question "what did Action1 call it" has an answer on the
              page instead of needing a developer and a token.
            */}
            {action1Info && action1Info.fieldsSeen.length > 0 ? (
              <details className="mt-2 text-[11px] font-semibold text-slate-500">
                <summary className="cursor-pointer text-slate-600">
                  Fields Action1 sent ({action1Info.fieldsSeen.length})
                </summary>
                <p className="mt-1 break-words leading-relaxed">{action1Info.fieldsSeen.join(", ")}</p>
              </details>
            ) : null}
          </div>

          {importPreview ? (
            <div className="mt-3 border border-slate-200 px-3 py-2">
              {/*
                THE PREVIEW READ AS SUCCESS, AND THAT COST THE FIRST TABLET A DAY. "Check the file"
                is a dry run: it parses, validates and reports, and writes nothing at all. The owner
                pressed it, read "1 row read, 1 ready, 0 with problems", and reasonably concluded the
                device was in the register. It was not, and nothing on screen said so — the only way
                to find out was to query the database.

                The two states get different words because they need different actions. With rows
                ready, the answer is to press the black button. With none ready that button is not
                rendered at all, so its absence has to be explained or the page reads as broken.
              */}
              {importPreview.summary.canImport > 0 ? (
                <div className="flex items-start gap-2 border border-amber-300 bg-amber-50 px-3 py-2">
                  <TriangleAlert
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 text-amber-700"
                  />
                  <p className="min-w-0 break-words text-[11px] font-bold leading-relaxed text-amber-900">
                    Nothing has been saved yet. This was a check of the file only. Press the black{" "}
                    <span className="font-black">
                      Import {importPreview.summary.canImport.toLocaleString("en-US")} device
                      {importPreview.summary.canImport === 1 ? "" : "s"}
                    </span>{" "}
                    button above to write{" "}
                    {importPreview.summary.canImport === 1 ? "it" : "them"} to the register.
                  </p>
                </div>
              ) : (
                <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2">
                  <TriangleAlert
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 text-rose-600"
                  />
                  <p className="min-w-0 break-words text-[11px] font-bold leading-relaxed text-rose-900">
                    Nothing has been saved, and nothing can be imported from this file yet — every
                    row still has a problem. Fix the rows listed below and choose the file again. The
                    Import button appears as soon as one row is ready.
                  </p>
                </div>
              )}
              <p className="mt-2 break-words text-[11px] font-bold text-slate-700">
                {importPreview.summary.total} row
                {importPreview.summary.total === 1 ? "" : "s"} read, {importPreview.summary.canImport}{" "}
                ready, {importPreview.summary.withErrors} with problems.{" "}
                {importPreview.summary.willBeIssued} will be recorded as handed over
                {importPreview.summary.heldByLeavers > 0
                  ? `, ${importPreview.summary.heldByLeavers} of them to somebody who has already left`
                  : ""}
                .
              </p>
              {importPreview.summary.withoutValue > 0 ? (
                <p className="mt-1 break-words text-[11px] font-semibold text-amber-800">
                  {importPreview.summary.withoutValue} carry no estimated value, so nothing could be
                  recovered against them.
                </p>
              ) : null}

              {/* EVERY finding, never a "+N more". The employee import learned that the expensive
                  way: a summary showing the first ten problems of three hundred is not a summary,
                  it is a wall. */}
              <ul className="mt-2 space-y-1">
                {importPreview.rows
                  .filter((row) => row.errors.length > 0 || row.warnings.length > 0)
                  .map((row) => (
                    <li
                      className="min-w-0 break-words border border-slate-200 px-2 py-1.5 text-[11px] font-semibold text-slate-700"
                      key={row.rowNumber}
                    >
                      <span className="font-black text-slate-900">
                        Row {row.rowNumber}
                        {row.assetTag ? ` — ${row.assetTag}` : ""}
                      </span>
                      {row.errors.map((message) => (
                        <span className="mt-0.5 block break-words text-rose-800" key={message}>
                          {message}
                        </span>
                      ))}
                      {row.warnings.map((message) => (
                        <span className="mt-0.5 block break-words text-amber-800" key={message}>
                          {message}
                        </span>
                      ))}
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}

          {importResult ? (
            <div className="mt-3 border border-slate-200 px-3 py-2">
              {/* The counterpart to the "nothing has been saved yet" banner above. A person who has
                  once been caught by the dry run needs to be told, in the same plain words, when
                  the write actually happened — otherwise the fix just moves the doubt. */}
              {/*
                A COMPLETED IMPORT IS NOT A SUCCESSFUL ONE. Every row can fail — a duplicate asset
                tag, a serial already in the register — and the route still answers 200 with a
                per-row report. An unconditional "Saved to the register" would then say the one
                thing that is not true, to the one person who has already been caught once by a
                screen that looked like success. So the banner is chosen by what was WRITTEN.
              */}
              {importResult.imported > 0 ? (
                <div className="flex items-start gap-2 border border-emerald-300 bg-emerald-50 px-3 py-2">
                  <PackageCheck
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700"
                  />
                  <p className="min-w-0 break-words text-[11px] font-bold leading-relaxed text-emerald-900">
                    Saved to the register.{" "}
                    {importResult.imported.toLocaleString("en-US")} device
                    {importResult.imported === 1 ? " is" : "s are"} now recorded.
                    {importResult.failed + importResult.skipped > 0
                      ? ` The other ${(importResult.failed + importResult.skipped).toLocaleString("en-US")} did not go in — see below.`
                      : ""}
                  </p>
                </div>
              ) : (
                <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2">
                  <TriangleAlert
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 text-rose-600"
                  />
                  <p className="min-w-0 break-words text-[11px] font-bold leading-relaxed text-rose-900">
                    Nothing was saved. Every row was refused, for the reasons listed below. The
                    register is unchanged.
                  </p>
                </div>
              )}
              <p className="mt-2 break-words text-[11px] font-black uppercase tracking-[0.1em] text-slate-700">
                {importResult.imported} imported, {importResult.issued} handed over,{" "}
                {importResult.skipped} skipped, {importResult.failed} failed
              </p>
              <ul className="mt-2 space-y-1">
                {importResult.outcomes
                  .filter((outcome) => outcome.result !== "imported" || outcome.error)
                  .map((outcome) => (
                    <li
                      className="min-w-0 break-words text-[11px] font-semibold text-slate-700"
                      key={outcome.rowNumber}
                    >
                      Row {outcome.rowNumber}, {outcome.assetTag}, {outcome.result}
                      {outcome.error ? `: ${outcome.error}` : ""}
                    </li>
                  ))}
              </ul>

              {/*
                WHAT THIS IMPORT PUT IN STOCK, HANDED OVER WHERE IT ARRIVED. The owner chose on
                2026-09-11 that enrolling a machine leads straight to its hand-over, with the person
                picked here rather than typed into Action1 — whose own user field, on the first
                machine enrolled, was the shared `satoh` login and named nobody. So nothing arrives
                chosen: each machine gets the register's own Hand over form, and once it is signed out
                the same row offers its receipt. Shown only to someone who may record a hand-over;
                the route asserts that again, and it is the boundary.
              */}
              {canRecord && importedForHandover.devices.length > 0 ? (
                <ImportedDevicesHandover
                  assignable={data?.assignable ?? []}
                  busy={busy}
                  devices={importedForHandover.devices}
                  draft={draft.surface === "import" ? draft : EMPTY_DRAFT}
                  onClose={closeDraft}
                  onOpen={(deviceId, kind) => openDraft(deviceId, kind, "import")}
                  onSubmit={(device) => void submitDraft(device)}
                  post={post}
                  setDraft={setDraft}
                  stillInStock={importedForHandover.stillInStock}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {registerOpen && canRegister ? (
        <div className="mt-3 border border-slate-300 bg-white px-4 py-4">
          <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-600">
            A new device
          </p>
          <p className="mt-1.5 text-[11px] font-semibold leading-relaxed text-slate-500">
            A serial number or an IMEI is required — it is what a police report, an operator
            blocklist and an insurer all ask for, and it is the one thing the paper form never
            captured.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Asset tag">
              <input
                className={INPUT_CLASS}
                onChange={(event) => setNewDevice({ ...newDevice, assetTag: event.target.value })}
                placeholder="PHX-LAP-0001"
                value={newDevice.assetTag}
              />
            </Field>
            <Field label="Category">
              <select
                className={INPUT_CLASS}
                onChange={(event) =>
                  setNewDevice({ ...newDevice, category: event.target.value as DeviceCategory })
                }
                value={newDevice.category}
              >
                {(Object.keys(CATEGORY_LABEL) as DeviceCategory[]).map((category) => (
                  <option key={category} value={category}>
                    {CATEGORY_LABEL[category]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Estimated value (EGP)" hint="The ceiling on any recovery — البند (10).">
              <input
                className={INPUT_CLASS}
                inputMode="numeric"
                onChange={(event) =>
                  setNewDevice({ ...newDevice, estimatedValueEgp: event.target.value })
                }
                value={newDevice.estimatedValueEgp}
              />
            </Field>
            <Field label="Manufacturer">
              <input
                className={INPUT_CLASS}
                onChange={(event) => setNewDevice({ ...newDevice, manufacturer: event.target.value })}
                value={newDevice.manufacturer}
              />
            </Field>
            <Field label="Model">
              <input
                className={INPUT_CLASS}
                onChange={(event) => setNewDevice({ ...newDevice, model: event.target.value })}
                value={newDevice.model}
              />
            </Field>
            <Field label="Purchased on">
              <input
                className={INPUT_CLASS}
                onChange={(event) => setNewDevice({ ...newDevice, purchasedOn: event.target.value })}
                type="date"
                value={newDevice.purchasedOn}
              />
            </Field>
            <Field label="Serial number" hint="Laptops — from the case or Windows.">
              <input
                className={INPUT_CLASS}
                dir="ltr"
                onChange={(event) => setNewDevice({ ...newDevice, serialNumber: event.target.value })}
                value={newDevice.serialNumber}
              />
            </Field>
            <Field label="IMEI" hint="Tablets and phones — dial *#06#.">
              <input
                className={INPUT_CLASS}
                dir="ltr"
                onChange={(event) => setNewDevice({ ...newDevice, imei: event.target.value })}
                value={newDevice.imei}
              />
            </Field>
            <Field label="SIM / line number">
              <input
                className={INPUT_CLASS}
                dir="ltr"
                onChange={(event) => setNewDevice({ ...newDevice, lineNumber: event.target.value })}
                value={newDevice.lineNumber}
              />
            </Field>
          </div>

          {/* نموذج رقم 1's technical block, field for field with Windows Settings → System → About,
              so whoever types it in is copying like for like. Only for a laptop — the other
              categories have no such screen. */}
          {newDevice.category === "laptop" ? (
            <div className="mt-3 grid grid-cols-1 gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Device name">
                <input
                  className={INPUT_CLASS}
                  dir="ltr"
                  onChange={(event) => setNewDevice({ ...newDevice, deviceName: event.target.value })}
                  value={newDevice.deviceName}
                />
              </Field>
              <Field label="Processor">
                <input
                  className={INPUT_CLASS}
                  dir="ltr"
                  onChange={(event) => setNewDevice({ ...newDevice, processor: event.target.value })}
                  value={newDevice.processor}
                />
              </Field>
              <Field label="Installed RAM">
                <input
                  className={INPUT_CLASS}
                  dir="ltr"
                  onChange={(event) => setNewDevice({ ...newDevice, installedRam: event.target.value })}
                  value={newDevice.installedRam}
                />
              </Field>
              <Field label="System type">
                <input
                  className={INPUT_CLASS}
                  dir="ltr"
                  onChange={(event) => setNewDevice({ ...newDevice, systemType: event.target.value })}
                  value={newDevice.systemType}
                />
              </Field>
              <Field label="Device ID">
                <input
                  className={INPUT_CLASS}
                  dir="ltr"
                  onChange={(event) =>
                    setNewDevice({ ...newDevice, windowsDeviceId: event.target.value })
                  }
                  value={newDevice.windowsDeviceId}
                />
              </Field>
              <Field label="Product ID">
                <input
                  className={INPUT_CLASS}
                  dir="ltr"
                  onChange={(event) =>
                    setNewDevice({ ...newDevice, windowsProductId: event.target.value })
                  }
                  value={newDevice.windowsProductId}
                />
              </Field>
            </div>
          ) : null}

          <button
            className="mt-3 border border-slate-900 bg-slate-900 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-slate-800 disabled:opacity-50"
            disabled={busy}
            onClick={() => void submitNewDevice()}
            type="button"
          >
            Add to the register
          </button>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-px bg-slate-200">
        {STATUS_FILTERS.map((option) => (
          <button
            className={`whitespace-nowrap border px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.1em] ${
              filter === option.key
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
            key={option.key}
            onClick={() => setFilter(option.key)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>

      {busy ? (
        <p className="mt-3 inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.1em] text-slate-500">
          <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" /> Saving
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="mt-5 border border-slate-200 bg-white px-4 py-6 text-center text-[12px] font-bold text-slate-500">
          {data && data.devices.length === 0
            ? "The register is empty. Add the first device — every one you enter is a serial somebody could give the police."
            : "Nothing here."}
        </p>
      ) : null}

      {/* DESKTOP — the table. Four fixed columns; the action column takes the largest share because
          it holds the employee `<select>`, the one control that may not be shrunk. */}
      {visible.length > 0 ? (
        <div className="mt-5 hidden md:block">
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-[30%]" />
              <col className="w-[22%]" />
              <col className="w-[14%]" />
              <col className="w-[34%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-300 bg-slate-50">
                {["Device", "Holder", "State", "Record"].map((heading) => (
                  <th
                    className="px-3 py-2 text-left text-[9px] font-black uppercase tracking-[0.14em] text-slate-500"
                    key={heading}
                    scope="col"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((device) => (
                <tr className="border-b border-slate-200 align-top" data-device-row={device.id} key={device.id}>
                  <td className="px-3 py-3">
                    <p className="break-words text-[12px] font-black text-slate-900">
                      {device.assetTag}
                    </p>
                    <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
                      {CATEGORY_LABEL[device.category]}
                      {device.manufacturer || device.model
                        ? ` — ${[device.manufacturer, device.model].filter(Boolean).join(" ")}`
                        : ""}
                    </p>
                    <p className="mt-0.5 break-words text-[11px] font-bold text-slate-700" dir="ltr">
                      {device.serialNumber
                        ? `S/N ${device.serialNumber}`
                        : `IMEI ${device.imei ?? ""}`}
                    </p>
                    {device.estimatedValueEgp !== null ? (
                      <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
                        {formatMoney(device.estimatedValueEgp)}
                      </p>
                    ) : (
                      <p className="mt-0.5 break-words text-[11px] font-bold text-amber-700">
                        No estimated value
                      </p>
                    )}
                  </td>

                  <td className="px-3 py-3">
                    {device.holderName ? (
                      <>
                        <p className="break-words text-[12px] font-bold text-slate-900">
                          {device.holderName}
                        </p>
                        <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
                          {device.holderJobTitle ?? "Job title not recorded"}
                        </p>
                        <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
                          Since {formatDate(device.issuedOn)}
                        </p>
                        {device.agreedValueEgp !== null ? (
                          <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
                            Signed for {formatMoney(device.agreedValueEgp)}
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <p className="break-words text-[11px] font-semibold text-slate-400">
                        Nobody — held by the company
                      </p>
                    )}
                  </td>

                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      <StatusChip device={device} />
                      <LeaverFlag device={device} />
                    </div>
                    {device.statusReason ? (
                      <p className="mt-1 break-words text-[11px] font-semibold text-slate-500">
                        {device.statusReason}
                      </p>
                    ) : null}
                  </td>

                  <td className="px-3 py-3">
                    {canRecord ? (
                      <DeviceActions
                        assignable={data?.assignable ?? []}
                        busy={busy}
                        correctIdentity={canCorrectIdentity ? correctIdentity : null}
                        correctionOpen={device.id === focusDeviceId}
                        device={device}
                        draft={draft.surface === "register" ? draft : EMPTY_DRAFT}
                        onClose={closeDraft}
                        onOpen={openDraft}
                        onSubmit={() => void submitDraft(device)}
                        post={post}
                        setDraft={setDraft}
                      />
                    ) : canCorrectIdentity ? (
                      <IdentityCorrection
                        busy={busy}
                        correctIdentity={correctIdentity}
                        defaultOpen={device.id === focusDeviceId}
                        device={device}
                      />
                    ) : (
                      <p className="break-words text-[11px] font-semibold text-slate-400">
                        Read only
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* MOBILE — cards. The owner's standing rule: mobile never gets a table. */}
      <div className="mt-5 space-y-3 md:hidden">
        {visible.map((device) => (
          <div className="border border-slate-200 bg-white px-4 py-3" data-device-row={device.id} key={device.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words text-[13px] font-black text-slate-900">{device.assetTag}</p>
                <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
                  {CATEGORY_LABEL[device.category]}
                  {device.manufacturer || device.model
                    ? ` — ${[device.manufacturer, device.model].filter(Boolean).join(" ")}`
                    : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                <StatusChip device={device} />
              </div>
            </div>

            <p className="mt-1.5 break-words text-[11px] font-bold text-slate-700" dir="ltr">
              {device.serialNumber ? `S/N ${device.serialNumber}` : `IMEI ${device.imei ?? ""}`}
            </p>

            <div className="mt-2 border-t border-slate-100 pt-2">
              {device.holderName ? (
                <>
                  <p className="break-words text-[12px] font-bold text-slate-900">
                    {device.holderName}
                  </p>
                  <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
                    {device.holderJobTitle ?? "Job title not recorded"} — since{" "}
                    {formatDate(device.issuedOn)}
                  </p>
                </>
              ) : (
                <p className="break-words text-[11px] font-semibold text-slate-400">
                  Nobody — held by the company
                </p>
              )}
              <div className="mt-1.5 flex flex-wrap gap-1">
                <LeaverFlag device={device} />
              </div>
            </div>

            {canRecord ? (
              <div className="mt-2 border-t border-slate-100 pt-2">
                <DeviceActions
                  assignable={data?.assignable ?? []}
                  busy={busy}
                  correctIdentity={canCorrectIdentity ? correctIdentity : null}
                  correctionOpen={device.id === focusDeviceId}
                  device={device}
                  draft={draft.surface === "register" ? draft : EMPTY_DRAFT}
                  onClose={closeDraft}
                  onOpen={openDraft}
                  onSubmit={() => void submitDraft(device)}
                  post={post}
                  setDraft={setDraft}
                />
              </div>
            ) : canCorrectIdentity ? (
              <div className="mt-2 border-t border-slate-100 pt-2">
                <IdentityCorrection
                  busy={busy}
                  correctIdentity={correctIdentity}
                  defaultOpen={device.id === focusDeviceId}
                  device={device}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The machines the last import put in stock, each with its hand-over — in the import result, where
 * they arrived.
 *
 * THE REGISTER'S OWN CONTROLS, NOT A SECOND SET. Each machine renders `DeviceActions`, so the
 * hand-over is the same form as in the table: the person is chosen from the list and never arrives
 * chosen, and the press goes through the same route to the same `phx_device_issue`. A machine signed
 * out from here STAYS here with Print receipt and its item prices, because that is the next thing
 * its paper needs.
 *
 * LAID OUT AS THE MOBILE CARDS ARE, AT EVERY WIDTH. It sits inside the import panel rather than in the
 * table's fixed columns, and one column of cards is what fits both a 375px phone and the 669px
 * desktop content box without a second table.
 */
function ImportedDevicesHandover({
  assignable,
  busy,
  devices,
  draft,
  onClose,
  onOpen,
  onSubmit,
  post,
  setDraft,
  stillInStock,
}: {
  assignable: DeviceRegisterData["assignable"];
  busy: boolean;
  devices: CompanyDevice[];
  draft: Draft;
  onClose: () => void;
  onOpen: (deviceId: string, kind: Exclude<DraftKind, null>) => void;
  onSubmit: (device: CompanyDevice) => void;
  post: (payload: Record<string, unknown>) => Promise<unknown>;
  setDraft: (draft: Draft) => void;
  stillInStock: number;
}) {
  return (
    <div className="mt-3 border-t border-slate-200 pt-3">
      <p className="break-words text-[11px] font-black uppercase tracking-[0.12em] text-slate-600">
        {stillInStock > 0
          ? `${stillInStock.toLocaleString("en-US")} of ${devices.length.toLocaleString("en-US")} still to hand over`
          : `All ${devices.length.toLocaleString("en-US")} handed over`}
      </p>
      <p className="mt-1.5 break-words text-[11px] font-semibold leading-relaxed text-slate-500">
        {stillInStock > 0
          ? "These arrived in stock with nobody signed for them. Press Hand over, choose who is signing for it, and Print receipt appears beside it."
          : "Each one is signed out. Print its receipt and price its items from here or from the register below."}
      </p>
      <ul className="mt-2 space-y-2">
        {devices.map((device) => (
          <li className="min-w-0 border border-slate-200 bg-white px-3 py-2" key={device.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words text-[12px] font-black text-slate-900">{device.assetTag}</p>
                <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
                  {CATEGORY_LABEL[device.category]}
                  {device.manufacturer || device.model
                    ? ` — ${[device.manufacturer, device.model].filter(Boolean).join(" ")}`
                    : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                <StatusChip device={device} />
              </div>
            </div>
            <p className="mt-1.5 break-words text-[11px] font-bold text-slate-700" dir="ltr">
              {device.serialNumber ? `S/N ${device.serialNumber}` : `IMEI ${device.imei ?? ""}`}
            </p>
            {device.holderName ? (
              <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-700">
                Signed for by {device.holderName}
              </p>
            ) : null}
            <div className="mt-2 border-t border-slate-100 pt-2">
              <DeviceActions
                assignable={assignable}
                busy={busy}
                device={device}
                draft={draft}
                onClose={onClose}
                onOpen={onOpen}
                onSubmit={() => onSubmit(device)}
                post={post}
                setDraft={setDraft}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The record controls for one device — the same component on desktop and mobile.
 *
 * THE ROW IS THE UNIT OF WORK. Every editor opens inside the cell it belongs to, never in a panel
 * underneath the table: the work here is one pass down a list, and a panel that renders below the
 * whole table means scrolling down to act and back up to find the next one, once per device.
 * The Mailbox Revocation register learned that the expensive way.
 *
 * WHICH ACTIONS ARE OFFERED MIRRORS WHAT THE DATABASE WILL ACCEPT. `phx_device_issue` refuses
 * anything not in stock and `phx_device_mark` refuses putting a signed-out device back in stock —
 * a screen offering a button the database refuses is worse than one that hides it.
 */
/**
 * The per-item prices that print in the receipt's «القيمة التقديرية» column.
 *
 * THE ROWS COME FROM THE TEMPLATE, not from a list typed here. A laptop signs for four items and a
 * phone for seven, and those rows are fixed positions on the printed Arabic form — so the same
 * constant the renderer reads is the one that draws these boxes, and a row added to the paper
 * cannot be forgotten here.
 *
 * A BLANK BOX IS NOT A ZERO, which is the whole reason the empty string is sent as nothing rather
 * than as 0. The form strikes the row of any item not actually handed over and leaves it out of the
 * total; a zero would assert the item was handed over and is worth nothing. Somebody who hands over
 * a laptop with no bag leaves the bag blank.
 */
function ItemPricing({
  busy,
  device,
  post,
}: {
  busy: boolean;
  device: CompanyDevice;
  post: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const template = device.category === "laptop" ? CUSTODY_LAPTOP_V1 : CUSTODY_MOBILE_V1;
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      template.itemRows.map((row) => {
        const stored = device.itemValuesEgp?.[row.number];
        return [row.number, typeof stored === "number" ? String(stored) : ""];
      }),
    ),
  );

  // Summed from what is actually typed, the same rule the paper's total label states. A box left
  // blank contributes nothing rather than counting as zero.
  const total = Object.values(values).reduce((sum, raw) => {
    const amount = Number(String(raw).trim());
    return raw.trim() !== "" && Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
  const pricedCount = Object.values(values).filter((raw) => raw.trim() !== "").length;

  if (!open) {
    return (
      <button
        className="self-start border border-slate-300 bg-white px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        disabled={busy}
        onClick={() => setOpen(true)}
        type="button"
      >
        {device.itemValuesEgp
          ? `Prices — ${total.toLocaleString("en-US")} EGP`
          : "Price the items"}
      </button>
    );
  }

  return (
    <div className="min-w-0 border border-slate-300 bg-slate-50 px-2.5 py-2">
      <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-600">
        Value of each item, in EGP
      </p>
      <p className="mt-1 text-[11px] font-semibold leading-relaxed text-slate-500">
        These print beside each item on the receipt, and clause 10 caps any recovery at them. Leave
        an item blank if it was not handed over: the form strikes that row and leaves it out of the
        total.
      </p>
      <div className="mt-2 flex flex-col gap-1.5">
        {template.itemRows.map((row) => (
          <label className="flex min-w-0 items-center gap-2" key={row.number}>
            <span className="w-4 shrink-0 text-[11px] font-black text-slate-500">{row.number}</span>
            <span className="min-w-0 flex-1 break-words text-[11px] font-semibold text-slate-700" dir="auto">
              {row.itemAr}
            </span>
            <input
              className={`${INPUT_CLASS} w-24 shrink-0 text-right`}
              inputMode="decimal"
              min="0"
              onChange={(event) => setValues({ ...values, [row.number]: event.target.value })}
              placeholder="—"
              type="number"
              value={values[row.number] ?? ""}
            />
          </label>
        ))}
      </div>
      <p className="mt-2 border-t border-slate-200 pt-1.5 text-[11px] font-black text-slate-700">
        Total {total.toLocaleString("en-US")} EGP over {pricedCount} item
        {pricedCount === 1 ? "" : "s"}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          className="border border-slate-900 bg-slate-900 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-slate-800 disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            void post({
              action: "price_items",
              assignmentId: device.assignmentId,
              itemValuesEgp: values,
            }).then((done) => {
              if (done) setOpen(false);
            });
          }}
          type="button"
        >
          Save prices
        </button>
        <button
          className="border border-slate-300 bg-white px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          disabled={busy}
          onClick={() => setOpen(false)}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Correct an entry's serial number and IMEI — Super Admin only, with a written reason.
 *
 * THE SERVER DECIDES; THIS ONLY ASKS. A malformed IMEI, a number another entry holds, a correction
 * that would leave nothing to identify the device by — `planIdentityCorrection` refuses each on the
 * server with a sentence, and the sentence is shown here, beside the fields it is about. The only
 * thing held back on the screen is an empty reason, which it can see for itself.
 *
 * BOTH CURRENT VALUES ARE SHOWN. The row prints one of the two, and a correction is about which
 * number is wrong. The fields start from what is stored and reset to it each time the editor opens,
 * so a correction saved a moment ago is what the next one starts from.
 */
function IdentityCorrection({
  busy,
  correctIdentity,
  defaultOpen,
  device,
}: {
  busy: boolean;
  correctIdentity: CorrectIdentity;
  defaultOpen: boolean;
  device: CompanyDevice;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // The pair the fields were filled from. Sent with the save, so an IMEI Rep Tablets copied in
  // while this was open is refused as a change, never erased by a blank field.
  const [shown, setShown] = useState(() => ({ serialNumber: device.serialNumber, imei: device.imei }));
  const [serialNumber, setSerialNumber] = useState(device.serialNumber ?? "");
  const [imei, setImei] = useState(device.imei ?? "");
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const buttonClass =
    "border border-slate-300 bg-white px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50";

  if (!open) {
    return (
      <div className="flex flex-col gap-1">
        <button
          className={`self-start ${buttonClass}`}
          disabled={busy}
          onClick={() => {
            setShown({ serialNumber: device.serialNumber, imei: device.imei });
            setSerialNumber(device.serialNumber ?? "");
            setImei(device.imei ?? "");
            setReason("");
            setRefusal(null);
            setSaved(false);
            setOpen(true);
          }}
          type="button"
        >
          Correct serial or IMEI
        </button>
        {saved ? (
          <p className="break-words text-[10px] font-bold text-emerald-700">
            Corrected. The old values and the reason are in the audit log.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-w-0 border border-slate-300 bg-slate-50 px-2.5 py-2">
      <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-600">
        Correct the serial number or IMEI
      </p>
      <p className="mt-1 break-words text-[11px] font-semibold leading-relaxed text-slate-500" dir="ltr">
        Now: S/N {device.serialNumber ?? "not recorded"} · IMEI {device.imei ?? "not recorded"}
      </p>
      <div className="mt-2 flex flex-col gap-1.5">
        <Field label="Serial number">
          <input
            className={INPUT_CLASS}
            dir="ltr"
            onChange={(event) => setSerialNumber(event.target.value)}
            value={serialNumber}
          />
        </Field>
        <Field label="IMEI" hint="15 digits — dial *#06# on the device to read it.">
          <input
            className={INPUT_CLASS}
            dir="ltr"
            inputMode="numeric"
            onChange={(event) => setImei(event.target.value)}
            value={imei}
          />
        </Field>
        <Field label="Reason" hint="Required. Kept in the audit log with the old and new values.">
          <input
            className={INPUT_CLASS}
            maxLength={IDENTITY_REASON_MAX_LENGTH}
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
        </Field>
      </div>
      {refusal ? (
        <p className="mt-2 break-words text-[11px] font-bold leading-relaxed text-rose-800" role="alert">
          {refusal}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          className="border border-slate-900 bg-slate-900 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-slate-800 disabled:opacity-50"
          disabled={busy || reason.trim() === ""}
          onClick={() => {
            void correctIdentity({
              deviceId: device.id,
              serialNumber,
              imei,
              reason,
              shownSerialNumber: shown.serialNumber,
              shownImei: shown.imei,
            }).then((refused) => {
              setRefusal(refused);
              if (refused) return;
              setSaved(true);
              setOpen(false);
            });
          }}
          type="button"
        >
          Save correction
        </button>
        <button className={buttonClass} disabled={busy} onClick={() => setOpen(false)} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}

function DeviceActions({
  assignable,
  busy,
  correctIdentity = null,
  correctionOpen = false,
  device,
  draft,
  onClose,
  onOpen,
  onSubmit,
  post,
  setDraft,
}: {
  assignable: DeviceRegisterData["assignable"];
  busy: boolean;
  /** Present only for somebody who may correct a serial or IMEI (Super Admin), and only in the register. */
  correctIdentity?: CorrectIdentity | null;
  /** The deep-linked entry: its correction starts open. */
  correctionOpen?: boolean;
  device: CompanyDevice;
  draft: Draft;
  onClose: () => void;
  onOpen: (deviceId: string, kind: Exclude<DraftKind, null>) => void;
  onSubmit: () => void;
  post: (payload: Record<string, unknown>) => Promise<unknown>;
  setDraft: (draft: Draft) => void;
}) {
  const open = draft.deviceId === device.id ? draft.kind : null;
  // The receipt's print prompt — how many copies, which company address — is open.
  const [askingPrint, setAskingPrint] = useState(false);
  const canIssue = device.status === "in_stock";
  const canReturn = device.assignmentId !== null;

  const buttonClass =
    "border border-slate-300 bg-white px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-100 disabled:opacity-50";

  if (open === null) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap gap-1.5">
        {canIssue ? (
          <button className={buttonClass} disabled={busy} onClick={() => onOpen(device.id, "issue")} type="button">
            Hand over
          </button>
        ) : null}
        {canReturn ? (
          <button className={buttonClass} disabled={busy} onClick={() => onOpen(device.id, "return")} type="button">
            Record a return
          </button>
        ) : null}
        {/*
          NOT OFFERED ON A RESERVED DEVICE. Its reservation is a live claim the register's own rows
          do not show, and changing the device's state under it left the reservation stranded — the
          route now refuses it (`markRefusal`). The reservation is ended where it is kept, on the
          tablet's custody panel, and then the state can change here.
        */}
        {device.status === "reserved" ? (
          <p className="break-words text-[11px] font-semibold leading-relaxed text-violet-800">
            Reserved for a new starter. Revoke the reservation, or hand it over on their first day, from the
            tablet&rsquo;s custody panel on the Tablet Dashboard before changing its state.
          </p>
        ) : (
          <button className={buttonClass} disabled={busy} onClick={() => onOpen(device.id, "mark")} type="button">
            Change state
          </button>
        )}
        {/*
          The receipt for THIS device and THIS holder — the point where the register pays for
          itself. `deviceId` carries the register row into the print, so the serial and IMEI on the
          paper are the ones the company can hand to the police rather than eight characters
          somebody copied off the underside of a laptop.

          Offered only when the device is signed out, because the receipt is about a HOLDER: with
          nobody holding it there is no name to print in «بيانات مستلم العهدة», and a receipt naming
          nobody is not a receipt. The form for a laptop is نموذج رقم 1 and for anything portable
          نموذج رقم 2 — the register already knows which, so nobody has to choose.
        */}
        {device.assignmentId && device.holderHrId ? (
          <>
            {/* ASKS FIRST, like every HR form (owner, 2026-09-20): how many copies, and which company
                address. The answer is appended to the same link this button used to be. */}
            <button
              className={buttonClass}
              onClick={() => setAskingPrint(true)}
              type="button"
            >
              Print receipt
            </button>
            {askingPrint ? (
              <PrintOptionsDialog
                askAddress
                defaultCopies={2}
                initialAddress={null}
                onCancel={() => setAskingPrint(false)}
                onConfirm={(answer) => {
                  setAskingPrint(false);
                  const paper = device.category === "laptop" ? "custodyLaptop" : "custodyMobile";
                  const address = answer.address ? `&address=${answer.address}` : "";
                  window.open(
                    `/api/hiring-pack/${encodeURIComponent(device.holderHrId ?? "")}/print?document=${paper}&copies=${answer.copies}${address}&deviceId=${encodeURIComponent(device.id)}`,
                    "_blank",
                    "noopener,noreferrer",
                  );
                }}
                registeredAddress={null}
                title={device.category === "laptop" ? "Laptop custody receipt" : "Mobile custody receipt"}
              />
            ) : null}
          </>
        ) : null}
        </div>
        {/*
          Pricing sits beside the receipt button, not behind "Change state", because it is part of
          preparing the paper rather than a change to the device's condition. Offered only while a
          handover is open: البند (9) prices what somebody signs for at THIS handover, so a device
          in stock has no handover to price.
        */}
        {device.assignmentId ? <ItemPricing busy={busy} device={device} post={post} /> : null}
        {correctIdentity ? (
          <IdentityCorrection
            busy={busy}
            correctIdentity={correctIdentity}
            defaultOpen={correctionOpen}
            device={device}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-w-0 border border-slate-300 bg-slate-50 px-2.5 py-2">
      {open === "issue" ? (
        <>
          <Field label="Signed for by">
            <select
              className={INPUT_CLASS}
              onChange={(event) => setDraft({ ...draft, employeeHrId: event.target.value })}
              value={draft.employeeHrId}
            >
              <option value="">Choose a person</option>
              {assignable.map((person) => (
                <option key={person.hrId} value={person.hrId}>
                  {person.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Declaration no.">
            <input
              className={INPUT_CLASS}
              onChange={(event) => setDraft({ ...draft, declarationNo: event.target.value })}
              value={draft.declarationNo}
            />
          </Field>
          <Field label="Place of handover">
            <input
              className={INPUT_CLASS}
              onChange={(event) => setDraft({ ...draft, handoverPlace: event.target.value })}
              value={draft.handoverPlace}
            />
          </Field>
        </>
      ) : null}

      {open === "return" ? (
        <>
          <Field label="Condition">
            <select
              className={INPUT_CLASS}
              onChange={(event) =>
                setDraft({ ...draft, condition: event.target.value as ReturnCondition })
              }
              value={draft.condition}
            >
              {RETURN_CONDITIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          {draft.condition !== "good" ? (
            <>
              <Field label="What is missing or broken">
                <input
                  className={INPUT_CLASS}
                  onChange={(event) => setDraft({ ...draft, shortfallNote: event.target.value })}
                  value={draft.shortfallNote}
                />
              </Field>
              <Field
                label="Charged (EGP)"
                hint={
                  device.agreedValueEgp !== null
                    ? `Capped at ${formatMoney(device.agreedValueEgp)} — البند (10).`
                    : "No agreed value on the receipt, so nothing can be recovered."
                }
              >
                <input
                  className={INPUT_CLASS}
                  inputMode="numeric"
                  onChange={(event) => setDraft({ ...draft, settlementEgp: event.target.value })}
                  value={draft.settlementEgp}
                />
              </Field>
            </>
          ) : null}
        </>
      ) : null}

      {open === "mark" ? (
        <>
          <Field label="New state">
            <select
              className={INPUT_CLASS}
              onChange={(event) =>
                setDraft({ ...draft, markStatus: event.target.value as MarkableDeviceStatus })
              }
              value={draft.markStatus}
            >
              {MARK_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          {draft.markStatus !== "in_stock" ? (
            <Field label="Reason">
              <input
                className={INPUT_CLASS}
                onChange={(event) => setDraft({ ...draft, reason: event.target.value })}
                value={draft.reason}
              />
            </Field>
          ) : null}
          {(draft.markStatus === "lost" || draft.markStatus === "stolen") && device.assignmentId ? (
            <p className="mt-2 break-words text-[10px] font-bold leading-relaxed text-amber-800">
              {device.holderName} keeps this on their custody record. البند (10) leaves an unreturned
              device owed until it comes back or the custody is written off.
            </p>
          ) : null}
        </>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          className="border border-slate-900 bg-slate-900 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-white hover:bg-slate-800 disabled:opacity-50"
          disabled={busy}
          onClick={onSubmit}
          type="button"
        >
          <span className="inline-flex items-center gap-1.5">
            {open === "issue" ? (
              <Laptop aria-hidden="true" className="h-3 w-3" />
            ) : (
              <PackageCheck aria-hidden="true" className="h-3 w-3" />
            )}
            Save
          </span>
        </button>
        <button className={buttonClass} disabled={busy} onClick={onClose} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}
