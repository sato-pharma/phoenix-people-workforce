"use client";

/**
 * Rep Tablets, Google's half — the rules every rep tablet follows, the QR code that enrolls a new
 * one, and the tablets already enrolled, matched to the custody register.
 *
 * 🔴 THIS IS THE SECOND PATH SINCE 2026-09-25, and it does not currently enroll anything. Google
 * gives a new Cloud project a device quota of ZERO until it approves an application, so a tablet
 * scanning the code below is refused with "your organization has reached its usage limits" while the
 * enterprise holds no tablets at all. ManageEngine enrolls the fleet in the meantime, from the
 * section above this one. Nothing here is removed or stubbed: the day Google approves the quota,
 * this console works again exactly as written.
 *
 * DESIGN IDENTITY is Managed Google Play's and the device register's (AGENTS.md §4: match the
 * sibling pages, never invent a one-off look) — slate borders, square corners and 9px uppercase
 * micro-labels. It is the third page of the same job: the register records who holds a tablet,
 * Managed Google Play decides what may be published to it, this page puts it under the company's
 * rules. The page's `PremiumHero` now lives on the page itself, above the ManageEngine sections.
 *
 * IT FITS THE SCREEN. The enrolled-tablet table is `table-fixed` with a `<colgroup>` totalling 100%,
 * merged to four columns so it holds at the 669px content width the register designs against, and
 * phones get cards. Nothing truncates: every free-text line wraps.
 *
 * 🔴 THE ENROLLMENT CODE IS A CREDENTIAL. Until it expires it puts a tablet into the company's
 * fleet, so it lives in component state only while it is on screen — never in storage, never in a
 * log, never in a URL — and "Hide the code" drops it.
 *
 * THE QR CODE IS DRAWN BY REACT — one `<path>` from Phoenix's own encoder — not by a library writing
 * into a DOM node. On 2026-09-18 production's Managed Google Play page crashed because a script wrote
 * into an element React also rendered into; nothing on this page hands a node to anyone. That drawing
 * lives in `qr-image.tsx`, shared with the ManageEngine section so the two paths cannot drift.
 */

import {
  Download,
  EyeOff,
  Loader2,
  Plus,
  QrCode,
  RefreshCw,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  Usb,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { QrImage, saveQrImage } from "@/components/devices/qr-image";
import type { ManagedTabletRow, ManagedTabletTone } from "@/lib/devices/managed-tablets";
import type {
  EnrollmentResult,
  ImeiRecordResult,
  RepTabletsEnterprise,
  RepTabletsState,
} from "@/lib/devices/rep-tablets-service";
import type { EnrollmentValidity } from "@/lib/devices/tablet-enrollment";
import type { OwnerAppInstallType } from "@/lib/devices/tablet-policy";
import { cairoDate, cairoDateTime } from "@/lib/format/cairo-datetime";
import { encodeQrText } from "@/lib/qr/qr-code";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

const MICRO_LABEL = "text-[9px] font-black uppercase tracking-[0.14em] text-slate-500";
const PRIMARY_BUTTON =
  "inline-flex items-center gap-2 border border-slate-900 bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60";
const SECONDARY_BUTTON =
  "inline-flex items-center gap-2 border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60";
const DANGER_BUTTON =
  "inline-flex items-center gap-2 border border-rose-700 bg-rose-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-800 disabled:opacity-60";
const INPUT_CLASS = cn(phxFieldClassName, "mt-1 w-full min-w-0 px-2 py-1.5 text-[12px]");

// ---------------------------------------------------------------------------------------------
// WebUSB — only the few members this page reads. The DOM lib does not declare `navigator.usb`.
// ---------------------------------------------------------------------------------------------

type UsbDeviceInfo = { serialNumber?: string; manufacturerName?: string; productName?: string };
type UsbNavigator = Navigator & {
  usb?: { requestDevice(options: { filters: Array<Record<string, number>> }): Promise<UsbDeviceInfo> };
};
type UsbRegistered = { registerDeviceId: string; assetTag: string; created: boolean };

// ---------------------------------------------------------------------------------------------
// Talking to the four routes
// ---------------------------------------------------------------------------------------------

class RequestFailure extends Error {
  readonly setupRequired: boolean;

  constructor(message: string, setupRequired: boolean) {
    super(message);
    this.name = "RequestFailure";
    this.setupRequired = setupRequired;
  }
}

async function requestJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" }),
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const failure = (payload ?? {}) as { message?: unknown; setupRequired?: unknown };
    throw new RequestFailure(
      typeof failure.message === "string" && failure.message
        ? failure.message
        : "The server answered with an error and no explanation. Reload the page and try again.",
      failure.setupRequired === true,
    );
  }
  return payload as T;
}

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

// ---------------------------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------------------------

const CHIP_TONE = {
  bad: "border-rose-300 bg-rose-50 text-rose-800",
  good: "border-emerald-300 bg-emerald-50 text-emerald-800",
  info: "border-sky-300 bg-sky-50 text-sky-800",
  neutral: "border-slate-300 bg-slate-50 text-slate-700",
  warn: "border-amber-300 bg-amber-50 text-amber-800",
} as const;

/** Chips WRAP, like the register's — a nowrap chip overflows its cell, not the table. */
function Chip({ tone, children }: { tone: keyof typeof CHIP_TONE; children: ReactNode }) {
  return (
    <span className={`inline-block border px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] ${CHIP_TONE[tone]}`}>
      {children}
    </span>
  );
}

const STATE_CHIP: Record<ManagedTabletTone, keyof typeof CHIP_TONE> = { bad: "bad", ok: "info", warn: "warn" };

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className={`block ${MICRO_LABEL}`}>{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[10px] font-semibold text-slate-400">{hint}</span> : null}
    </label>
  );
}

function ErrorBox({ title, message }: { title: string; message: string }) {
  return (
    <div className="border border-rose-300 bg-rose-50 p-4">
      <p className="text-[9px] font-black uppercase tracking-[0.14em] text-rose-800">{title}</p>
      <p className="mt-1 break-words text-sm text-rose-900">{message}</p>
    </div>
  );
}

function WarningBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-amber-700" />
        <div className="min-w-0 space-y-2">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-amber-800">{title}</p>
          <div className="break-words text-sm text-amber-900">{children}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The enterprise
// ---------------------------------------------------------------------------------------------

/** One fact about the enterprise. `min-w-0` plus wrapping: a long binding breaks, it never scrolls. */
function EnterpriseFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 border border-slate-200 bg-slate-50 px-3 py-2">
      <p className={MICRO_LABEL}>{label}</p>
      <p className="mt-1 break-words text-sm font-bold text-slate-900">{children}</p>
    </div>
  );
}

/**
 * Which enterprise on Google this fleet is, and how many tablets it holds.
 *
 * THE COUNT IS EVERY STATE, which is the count Google itself works from — so it is the number to
 * read against a refusal that speaks of a limit, and a count of zero says that refusal was about
 * something other than this fleet's size.
 */
function EnterpriseSection({ enterprise }: { enterprise: RepTabletsEnterprise }) {
  return (
    <section className="space-y-4 border border-slate-200 bg-white p-5">
      <div>
        <p className={MICRO_LABEL}>The Google enterprise</p>
        <h2 className="mt-1 text-lg font-black text-slate-900">
          {enterprise.displayName ?? "Phoenix’s Android Enterprise"}
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Every rule, QR code and tablet on this page belongs to this one enterprise on Google. Its tablet count is
          what Google counts when it decides whether another tablet may enroll.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <EnterpriseFact label="Tablets Google holds">
          {enterprise.deviceCount === 1 ? "1 tablet" : `${enterprise.deviceCount} tablets`}
        </EnterpriseFact>
        <EnterpriseFact label="Binding">{enterprise.name}</EnterpriseFact>
        <EnterpriseFact label="How it was made">{enterprise.kind ?? "Google did not say"}</EnterpriseFact>
        <EnterpriseFact label="Google contacts">
          {enterprise.contactEmail ?? "No address on the enterprise"}
        </EnterpriseFact>
      </div>

      {enterprise.byState.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className={MICRO_LABEL}>What they are doing</span>
          {enterprise.byState.map((state) => (
            <Chip key={state.label} tone="neutral">
              {state.label}: {state.count}
            </Chip>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-600">
          Google holds no tablets at all under this enterprise. A refusal to enroll that speaks of a limit is
          therefore not about how many tablets this fleet has &mdash; it is a limit on the Google project behind the
          QR code, and it is lifted on Google&rsquo;s side, not here.
        </p>
      )}

      {enterprise.error ? (
        <WarningBox title="The enterprise&rsquo;s own details did not load">
          <p>The tablet count above is still what Google holds. {enterprise.error}</p>
        </WarningBox>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The enrolled tablets
// ---------------------------------------------------------------------------------------------

const MATCHED_BY_LABEL: Record<NonNullable<ManagedTabletRow["matchedBy"]>, string> = {
  enrollment: "Matched by its enrollment code",
  imei: "Matched by IMEI",
  serial: "Matched by serial number",
};

/** One thing wrong with a tablet, and — where a screen can fix it — where that screen is. */
type AttentionLine = { tone: "bad" | "warn"; text: string; link?: { href: string; label: string } };

function attentionLines(row: ManagedTabletRow): AttentionLine[] {
  const lines: AttentionLine[] = [];
  if (row.enrolledWithAnotherTabletsCode) {
    lines.push({
      text: `Enrolled with the code made for ${row.assetTag}, but its serial number is not that tablet's. Check which tablet this is before it is handed over.`,
      tone: "bad",
    });
  }
  if (row.imeiStatus === "on_another_tablet") {
    lines.push({
      text: `The custody register records this tablet's IMEI on ${row.imeiRecordedOn}. Check which tablet this is before it is handed over.`,
      tone: "bad",
    });
  } else if (row.imeiStatus === "register_differs") {
    // Never corrected from here: the tablet's word is not taken over a number somebody typed. A
    // person dials *#06#, and if the register is the wrong one, corrects it on the register's own
    // row — Super Admin only, with a reason, audited with the old value (`/api/devices/identity`).
    lines.push({
      link: row.registerDeviceId
        ? {
            href: `/devices?correct=${encodeURIComponent(row.registerDeviceId)}`,
            label: `Correct the IMEI of ${row.assetTag} in the custody register`,
          }
        : undefined,
      text: `The custody register has IMEI ${row.registerImei} for ${row.assetTag}, but the tablet reports ${row.imei}. Dial *#06# on the tablet to see which is right — if the register is wrong, correct it there.`,
      tone: "warn",
    });
  } else if (row.imeiStatus === "held_back") {
    lines.push({
      text: row.enrolledWithAnotherTabletsCode
        ? "Its IMEI is not copied into the register until it is clear which tablet this is."
        : row.serialNumber
          ? `The register has no serial number for ${row.assetTag} to confirm this is it, so its IMEI is not copied into the register.`
          : `The tablet has not reported a serial number to confirm it is ${row.assetTag}, so its IMEI is not copied into the register yet.`,
      tone: "warn",
    });
  } else if (row.imeiStatus === "contested") {
    lines.push({
      text: `Another enrolled tablet is matched to ${row.assetTag}, or reports the same IMEI, so this IMEI is not copied into the register until that is sorted out.`,
      tone: "warn",
    });
  }
  if (!row.onRepPolicy) {
    lines.push({ text: "Not on the rep tablet rules.", tone: "warn" });
  } else if (row.policyUpToDate === false) {
    lines.push({ text: "Has not picked up the latest rules yet — it will at its next check-in.", tone: "warn" });
  }
  for (const issue of row.issues) lines.push({ text: issue, tone: "warn" });
  return lines;
}

function TabletIdentity({ row }: { row: ManagedTabletRow }) {
  return (
    <>
      {row.assetTag ? (
        <p className="break-words text-[12px] font-black text-slate-900">{row.assetTag}</p>
      ) : (
        <p className="break-words text-[12px] font-black text-amber-700">Not in the custody register</p>
      )}
      <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">{row.model}</p>
      {row.serialNumber ? (
        <p className="mt-0.5 break-words text-[11px] font-bold text-slate-700" dir="ltr">
          S/N {row.serialNumber}
        </p>
      ) : null}
      {row.imei ? (
        <p className="mt-0.5 break-words text-[11px] font-bold text-slate-700">
          <span dir="ltr">IMEI {row.imei}</span>
          {row.imeiStatus === "to_record" ? (
            <span className="font-semibold text-slate-500"> · not in the register yet</span>
          ) : null}
        </p>
      ) : (
        <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
          {row.imeiStatus === "none" ? "Reports no IMEI — a Wi-Fi-only tablet has none" : "IMEI not reported yet"}
        </p>
      )}
      <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
        {row.androidVersion ? `Android ${row.androidVersion}` : "Android version not reported yet"}
        {row.securityPatchLevel ? ` · security patch ${cairoDate(row.securityPatchLevel)}` : ""}
      </p>
    </>
  );
}

function TabletHolder({ row, registerUnavailable }: { row: ManagedTabletRow; registerUnavailable: boolean }) {
  if (!row.registerDeviceId) {
    return (
      <p className="break-words text-[11px] font-semibold text-slate-500">
        {registerUnavailable
          ? "The register could not be read, so the holder is unknown."
          : "Unknown — add this tablet to the custody register to see who holds it."}
      </p>
    );
  }
  return (
    <>
      {row.holderName ? (
        <>
          <p className="break-words text-[12px] font-bold text-slate-900">{row.holderName}</p>
          <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
            {row.holderJobTitle ?? "Job title not recorded"}
          </p>
        </>
      ) : (
        <p className="break-words text-[11px] font-semibold text-slate-400">Nobody — held by the company</p>
      )}
      {row.matchedBy ? (
        <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-400">{MATCHED_BY_LABEL[row.matchedBy]}</p>
      ) : null}
    </>
  );
}

function TabletRules({ row }: { row: ManagedTabletRow }) {
  const lines = attentionLines(row);
  return (
    <>
      <div className="flex flex-wrap gap-1">
        <Chip tone={STATE_CHIP[row.stateTone]}>{row.stateLabel}</Chip>
        {row.compliant ? <Chip tone="good">Following the rules</Chip> : <Chip tone="warn">Not following every rule</Chip>}
      </div>
      {lines.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {lines.map((line) => (
            <li
              className={`break-words text-[11px] font-semibold ${line.tone === "bad" ? "text-rose-700" : "text-amber-800"}`}
              key={line.text}
            >
              {line.text}
              {line.link ? (
                <>
                  {" "}
                  <Link className="font-black text-slate-900 underline underline-offset-2 hover:text-slate-700" href={line.link.href}>
                    {line.link.label}
                  </Link>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function TabletTimes({ row }: { row: ManagedTabletRow }) {
  return (
    <>
      <p className="break-words text-[11px] font-bold text-slate-700">
        {row.lastReportAt ? `Reported ${cairoDateTime(row.lastReportAt)}` : "No report yet"}
      </p>
      {row.lastSyncAt ? (
        <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
          Rules synced {cairoDateTime(row.lastSyncAt)}
        </p>
      ) : null}
      {row.enrolledAt ? (
        <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">Enrolled {cairoDate(row.enrolledAt)}</p>
      ) : null}
    </>
  );
}

function imeiCopiedText(result: ImeiRecordResult): string | null {
  const tags = result.recorded.map((entry) => entry.assetTag);
  if (tags.length === 0) return null;
  if (tags.length === 1) return `Copied ${tags[0]}'s IMEI into the custody register, as the tablet reports it.`;
  return `Copied the IMEIs of ${tags.slice(0, -1).join(", ")} and ${tags[tags.length - 1]} into the custody register, as the tablets report them.`;
}

function imeiFailedText(result: ImeiRecordResult): string | null {
  if (result.failed.length === 0) return null;
  return result.failed.map((entry) => `${entry.assetTag}: ${entry.message}`).join(" · ");
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

type PolicyChangeBody =
  | { action: "save" }
  | { action: "add"; app: string; installType: OwnerAppInstallType }
  | { action: "remove"; packageName: string };

export function RepTabletsConsole({ enterpriseBound }: { enterpriseBound: boolean }) {
  const [data, setData] = useState<RepTabletsState | null>(null);
  // True from the first render when the enterprise is bound: the first load starts in an effect,
  // which may not set state synchronously (see below).
  const [loading, setLoading] = useState(enterpriseBound);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(!enterpriseBound);

  const [policyBusy, setPolicyBusy] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [policyNotice, setPolicyNotice] = useState<string | null>(null);
  const [appInput, setAppInput] = useState("");
  const [installType, setInstallType] = useState<OwnerAppInstallType>("FORCE_INSTALLED");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const [target, setTarget] = useState("");
  const [validFor, setValidFor] = useState<EnrollmentValidity | null>(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<EnrollmentResult | null>(null);
  const [usbBusy, setUsbBusy] = useState(false);
  const [usbError, setUsbError] = useState<string | null>(null);
  const [usbNotice, setUsbNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // One read of the page, shared by the first load and every refresh. It sets state only inside
  // the promise's callbacks, which is what lets the first load run from an effect: an async loader
  // called straight from an effect body trips react-hooks/set-state-in-effect. BiometricDevicesCard
  // solves the same problem the same way.
  const readState = useCallback(
    (isCurrent: () => boolean) =>
      requestJson<RepTabletsState>("/api/devices/tablets")
        .then((state) => {
          if (!isCurrent()) return;
          setData(state);
          setSetupRequired(false);
        })
        .catch((caught: unknown) => {
          if (!isCurrent()) return;
          if (caught instanceof RequestFailure && caught.setupRequired) setSetupRequired(true);
          else setLoadError(messageOf(caught, "Could not load the rep tablets."));
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        }),
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    await readState(() => true);
  }, [readState]);

  useEffect(() => {
    if (!enterpriseBound) return;
    let current = true;
    void readState(() => current);
    return () => {
      current = false;
    };
  }, [enterpriseBound, readState]);

  // An IMEI a tablet reports that its register entry does not hold yet is copied in by the page
  // itself, so nobody types fifteen digits off a Settings screen. Once per entry per visit: a copy
  // that fails is shown, never retried in a loop. The ref only stops the page asking twice — what
  // the page shows comes from state. Like the first load, state is set only in the callbacks.
  const imeiAsked = useRef(new Set<string>());
  const [imeiSettled, setImeiSettled] = useState<ReadonlySet<string>>(() => new Set());
  const [imeiNotice, setImeiNotice] = useState<string | null>(null);
  const [imeiError, setImeiError] = useState<string | null>(null);
  const imeiPending = useMemo(
    () => [
      ...new Set(
        (data?.tablets ?? []).flatMap((row) =>
          row.imeiStatus === "to_record" && row.registerDeviceId ? [row.registerDeviceId] : [],
        ),
      ),
    ],
    [data],
  );
  const imeiCopying = imeiPending.filter((id) => !imeiSettled.has(id)).length;

  useEffect(() => {
    const unasked = imeiPending.filter((id) => !imeiAsked.current.has(id));
    if (unasked.length === 0) return;
    for (const id of unasked) imeiAsked.current.add(id);
    void requestJson<ImeiRecordResult>("/api/devices/tablets/imei", {})
      .then((result) => {
        // A later pass that copies nothing new keeps the earlier notice; its failures replace the
        // earlier ones, because the server tries every entry still missing an IMEI on each pass.
        const copied = imeiCopiedText(result);
        setImeiNotice((previous) => copied ?? previous);
        setImeiError(imeiFailedText(result));
        return readState(() => true);
      })
      .catch((caught: unknown) => {
        setImeiError(messageOf(caught, "Could not copy the tablets' IMEIs into the custody register."));
      })
      .finally(() => {
        setImeiSettled((previous) => new Set([...previous, ...unasked]));
      });
  }, [imeiPending, readState]);

  // The expiry line turns into "expired" on its own while the code is on screen.
  useEffect(() => {
    if (!enrollment?.expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [enrollment]);

  const changePolicy = useCallback(
    async (change: PolicyChangeBody, busyKey: string, done: string) => {
      setPolicyBusy(busyKey);
      setPolicyError(null);
      setPolicyNotice(null);
      try {
        await requestJson<{ version: string | null }>("/api/devices/tablets/policy", change);
        setPolicyNotice(done);
        await load();
        return true;
      } catch (caught) {
        setPolicyError(messageOf(caught, "Could not save the tablet rules."));
        return false;
      } finally {
        setPolicyBusy(null);
      }
    },
    [load],
  );

  const addApp = useCallback(async () => {
    const app = appInput.trim();
    if (!app) {
      setPolicyError("Paste the app's Google Play link, or its package name.");
      return;
    }
    if (await changePolicy({ action: "add", app, installType }, "add", "Added. Every rep tablet picks it up at its next check-in.")) {
      setAppInput("");
    }
  }, [appInput, changePolicy, installType]);

  const removeApp = useCallback(
    async (packageName: string, title: string) => {
      if (
        await changePolicy(
          { action: "remove", packageName },
          `remove:${packageName}`,
          `Removed ${title}. It is uninstalled from every rep tablet at its next check-in.`,
        )
      ) {
        setConfirmRemove(null);
      }
    },
    [changePolicy],
  );

  const effectiveValidity: EnrollmentValidity = validFor ?? data?.defaultValidity ?? "24h";

  const makeCode = useCallback(async (forTablet?: string) => {
    setEnrollBusy(true);
    setEnrollError(null);
    setEnrollment(null);
    try {
      const created = await requestJson<EnrollmentResult>("/api/devices/tablets/enrollment", {
        registerDeviceId: (forTablet ?? target) || null,
        validFor: effectiveValidity,
      });
      setNow(Date.now());
      setEnrollment(created);
    } catch (caught) {
      setEnrollError(messageOf(caught, "Could not make an enrollment code."));
    } finally {
      setEnrollBusy(false);
    }
  }, [effectiveValidity, target]);

  // Plug the tablet in, pick it once in the browser's USB chooser: its serial number comes from the
  // USB descriptor (no Developer mode), Phoenix files it under the next PHX-TAB number, and the
  // tablet's own one-time QR code is made straight away.
  const connectUsb = useCallback(async () => {
    setUsbError(null);
    setUsbNotice(null);
    const usb = (navigator as UsbNavigator).usb;
    if (!usb) {
      setUsbError("This browser cannot read USB devices. Open this page in Chrome or Edge on a computer.");
      return;
    }
    let picked: UsbDeviceInfo;
    try {
      picked = await usb.requestDevice({ filters: [] });
    } catch {
      return; // The chooser was closed without picking a tablet.
    }
    setUsbBusy(true);
    try {
      const registered = await requestJson<UsbRegistered>("/api/devices/tablets/usb", {
        manufacturer: picked.manufacturerName ?? null,
        model: picked.productName ?? null,
        serialNumber: picked.serialNumber ?? null,
      });
      setUsbNotice(
        registered.created
          ? `Added to the custody register as ${registered.assetTag}. Its QR code is below.`
          : `Already in the custody register as ${registered.assetTag}. Its QR code is below.`,
      );
      await load();
      setTarget(registered.registerDeviceId);
      await makeCode(registered.registerDeviceId);
    } catch (caught) {
      setUsbError(messageOf(caught, "Could not add the tablet to the custody register."));
    } finally {
      setUsbBusy(false);
    }
  }, [load, makeCode]);

  const qr = useMemo(() => {
    if (!enrollment) return null;
    try {
      return encodeQrText(enrollment.qrPayload);
    } catch {
      return null;
    }
  }, [enrollment]);

  const expired = enrollment?.expiresAt ? Date.parse(enrollment.expiresAt) <= now : false;
  const policy = data?.policy ?? null;
  const tablets = data?.tablets ?? [];

  return (
    <div className="space-y-6">
      {/* The page's hero moved to the page itself when ManageEngine became the first section
          (2026-09-25) — this console is no longer what opens the screen. */}
      <div>
        <p className={MICRO_LABEL}>Google Android Enterprise &middot; second path</p>
        <h2 className="mt-1 text-lg font-black text-slate-900">Enrolling through Google</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Everything below belongs to Google&rsquo;s Android Management API, not ManageEngine. It is kept whole and it
          works the moment Google approves the device quota for the Cloud project behind it &mdash; until then a tablet
          scanning the Google code is refused with &ldquo;your organization has reached its usage limits&rdquo;, even
          though the enterprise holds no tablets at all. Enroll through ManageEngine above.
        </p>
      </div>

      {setupRequired ? (
        <div className="space-y-4 border border-slate-200 bg-white p-5">
          <div>
            <p className={MICRO_LABEL}>Setup — one time</p>
            <h2 className="mt-1 text-lg font-black text-slate-900">Phoenix is not bound to an Android Enterprise yet</h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-600">
              The binding is made once, on the Managed Google Play page. Until it exists there are no rules to set and
              nothing a tablet could enroll into.
            </p>
          </div>
          <Link className={SECONDARY_BUTTON} href="/devices/managed-play">
            Open Managed Google Play
          </Link>
        </div>
      ) : null}

      {!setupRequired && !data && loading ? (
        <div className="flex items-center justify-center gap-2 border border-slate-200 bg-white p-10 text-sm text-slate-500">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          Asking Google for the rep tablets…
        </div>
      ) : null}

      {!setupRequired && loadError ? (
        <div className="space-y-3">
          <ErrorBox message={loadError} title="The rep tablets did not load" />
          <button className={SECONDARY_BUTTON} disabled={loading} onClick={() => void load()} type="button">
            {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <RefreshCw aria-hidden className="size-4" />}
            Try again
          </button>
        </div>
      ) : null}

      {!setupRequired && data && policy ? (
        <>
          {/* ── The enterprise ────────────────────────────────────────────────────────── */}
          <EnterpriseSection enterprise={data.enterprise} />

          {/* ── The rules ─────────────────────────────────────────────────────────────── */}
          <section className="space-y-4 border border-slate-200 bg-white p-5">
            <div>
              <p className={MICRO_LABEL}>Tablet rules</p>
              <h2 className="mt-1 text-lg font-black text-slate-900">What every rep tablet follows</h2>
              <p className="mt-1 max-w-3xl text-sm text-slate-600">
                One set of rules for every rep tablet. A change here reaches every enrolled tablet at its next check-in.
              </p>
            </div>

            {!policy.exists ? (
              <WarningBox title="The rules are not on Google yet">
                <p>
                  Save them once and every tablet enrolled from then on follows them. No tablet can be enrolled before
                  that.
                </p>
                <button
                  className={PRIMARY_BUTTON}
                  disabled={policyBusy !== null}
                  onClick={() =>
                    void changePolicy({ action: "save" }, "save", "Saved. The rules are on Google and tablets can be enrolled.")
                  }
                  type="button"
                >
                  {policyBusy === "save" ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
                  {policyBusy === "save" ? "Saving…" : "Save the rules to Google"}
                </button>
              </WarningBox>
            ) : policy.drift.length > 0 ? (
              <WarningBox title="Google's copy has drifted">
                <p>
                  {policy.drift.join(", ")} on Google {policy.drift.length === 1 ? "is" : "are"} not what Phoenix sets.
                  Saving puts every tablet back on the rules below.
                </p>
                <button
                  className={PRIMARY_BUTTON}
                  disabled={policyBusy !== null}
                  onClick={() => void changePolicy({ action: "save" }, "save", "Saved. Google's copy matches the rules again.")}
                  type="button"
                >
                  {policyBusy === "save" ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
                  {policyBusy === "save" ? "Saving…" : "Put the rules back"}
                </button>
              </WarningBox>
            ) : (
              <p className="border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">
                In force on Google, exactly as listed below.
              </p>
            )}

            <ul className="grid gap-3 md:grid-cols-2">
              {data.rules.map((rule) => (
                <li className="border border-slate-200 p-3" key={rule.title}>
                  <p className="break-words text-[12px] font-black text-slate-900">{rule.title}</p>
                  <p className="mt-1 break-words text-[12px] text-slate-600">{rule.detail}</p>
                </li>
              ))}
            </ul>
          </section>

          {/* ── The apps ──────────────────────────────────────────────────────────────── */}
          <section className="space-y-4 border border-slate-200 bg-white p-5">
            <div>
              <p className={MICRO_LABEL}>Apps</p>
              <h2 className="mt-1 text-lg font-black text-slate-900">Apps on the rep tablets</h2>
              <p className="mt-1 max-w-3xl text-sm text-slate-600">
                Only the apps listed here can be installed from a rep tablet&rsquo;s store. Adding one reaches every
                tablet at its next check-in; removing one uninstalls it from every tablet.
              </p>
            </div>

            {policyError ? <ErrorBox message={policyError} title="The rules were not saved" /> : null}
            {policyNotice ? (
              <p className="border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">
                {policyNotice}
              </p>
            ) : null}

            <ul className="divide-y divide-slate-200 border border-slate-200">
              <li className="px-4 py-3">
                <p className="break-words text-[12px] font-black text-slate-900">Chrome</p>
                <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
                  Installed on every tablet · Phoenix runs in it, so it is always there and cannot be removed.
                </p>
              </li>
              {policy.apps.map((app) => {
                const installLabel =
                  data.installTypes.find((entry) => entry.value === app.installType)?.label ?? app.installType;
                const removing = policyBusy === `remove:${app.packageName}`;
                return (
                  <li className="px-4 py-3" key={app.packageName}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-[12px] font-black text-slate-900">{app.title}</p>
                        <p className="mt-0.5 break-all text-[11px] font-semibold text-slate-400" dir="ltr">
                          {app.packageName}
                        </p>
                        <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">{installLabel}</p>
                      </div>
                      {confirmRemove === app.packageName ? null : (
                        <button
                          className={SECONDARY_BUTTON}
                          disabled={policyBusy !== null}
                          onClick={() => {
                            setPolicyError(null);
                            setPolicyNotice(null);
                            setConfirmRemove(app.packageName);
                          }}
                          type="button"
                        >
                          <Trash2 aria-hidden className="size-4" />
                          Remove
                        </button>
                      )}
                    </div>
                    {confirmRemove === app.packageName ? (
                      <div className="mt-3 space-y-3 border border-rose-300 bg-rose-50 p-4">
                        <p className="break-words text-sm text-rose-900">
                          Remove <span className="font-semibold">{app.title}</span>? It is uninstalled from every rep
                          tablet at its next check-in, together with anything the rep saved inside it.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <button
                            className={DANGER_BUTTON}
                            disabled={policyBusy !== null}
                            onClick={() => void removeApp(app.packageName, app.title)}
                            type="button"
                          >
                            {removing ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Trash2 aria-hidden className="size-4" />}
                            {removing ? "Removing…" : "Remove from every tablet"}
                          </button>
                          <button
                            className={SECONDARY_BUTTON}
                            disabled={removing}
                            onClick={() => setConfirmRemove(null)}
                            type="button"
                          >
                            Keep it
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
              {policy.apps.length === 0 ? (
                <li className="px-4 py-3 text-[12px] font-semibold text-slate-500">
                  No other app yet. The tablets carry Chrome and their own built-in apps only.
                </li>
              ) : null}
            </ul>

            <form
              className="grid gap-3 border border-slate-200 bg-slate-50 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
              onSubmit={(event) => {
                event.preventDefault();
                void addApp();
              }}
            >
              <Field hint="Open the app on play.google.com and copy the address — it carries ?id= and the app's package name." label="Google Play link or package name">
                <input
                  className={INPUT_CLASS}
                  dir="ltr"
                  onChange={(event) => setAppInput(event.target.value)}
                  placeholder="https://play.google.com/store/apps/details?id=com.example.app"
                  value={appInput}
                />
              </Field>
              <Field label="How it reaches the tablets">
                <select
                  className={INPUT_CLASS}
                  onChange={(event) => setInstallType(event.target.value as OwnerAppInstallType)}
                  value={installType}
                >
                  {data.installTypes.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="md:col-span-2">
                <button className={PRIMARY_BUTTON} disabled={policyBusy !== null} type="submit">
                  {policyBusy === "add" ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Plus aria-hidden className="size-4" />}
                  {policyBusy === "add" ? "Adding…" : "Add to the rep tablets"}
                </button>
              </div>
            </form>
          </section>

          {/* ── Enrollment ────────────────────────────────────────────────────────────── */}
          <section className="space-y-4 border border-slate-200 bg-white p-5">
            <div>
              <p className={MICRO_LABEL}>Enroll a tablet</p>
              <h2 className="mt-1 text-lg font-black text-slate-900">Make a QR code for a new tablet</h2>
              <p className="mt-1 max-w-3xl text-sm text-slate-600">
                Choose the tablet from the custody register and the code works for that one tablet, once. Choose
                &ldquo;Any rep tablet&rdquo; to set up several from one code until it expires.
              </p>
            </div>

            {!policy.exists ? (
              <p className="border border-slate-300 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
                Save the tablet rules above first — a tablet enrolled before then would have no rules to follow.
              </p>
            ) : (
              <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <Field
                  hint={
                    data.enrollable.length === 0
                      ? "No tablet in the custody register yet — add it there to make a code for it by name."
                      : undefined
                  }
                  label="Which tablet"
                >
                  <select className={INPUT_CLASS} onChange={(event) => setTarget(event.target.value)} value={target}>
                    <option value="">Any rep tablet — works for every tablet until it expires</option>
                    {data.enrollable.map((tablet) => (
                      <option key={tablet.id} value={tablet.id}>
                        {[
                          tablet.assetTag,
                          tablet.model,
                          tablet.holderName ?? "not issued",
                          tablet.enrolled ? "already enrolled" : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Usable for">
                  <select
                    className={INPUT_CLASS}
                    onChange={(event) => setValidFor(event.target.value as EnrollmentValidity)}
                    value={effectiveValidity}
                  >
                    {data.validity.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="flex flex-wrap gap-2 md:col-span-2">
                  <button className={PRIMARY_BUTTON} disabled={enrollBusy || usbBusy} onClick={() => void makeCode()} type="button">
                    {enrollBusy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <QrCode aria-hidden className="size-4" />}
                    {enrollBusy ? "Making the code…" : "Make the QR code"}
                  </button>
                  <button className={SECONDARY_BUTTON} disabled={enrollBusy || usbBusy} onClick={() => void connectUsb()} type="button">
                    {usbBusy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Usb aria-hidden className="size-4" />}
                    {usbBusy ? "Reading the tablet…" : "Connect a tablet by USB"}
                  </button>
                </div>
                <p className="text-[11px] font-semibold text-slate-500 md:col-span-2">
                  Plug the tablet into this computer, press Connect and pick it in the list. Phoenix reads its serial
                  number, adds it to the custody register under the next PHX-TAB number and makes its QR code. A tablet
                  that enrolls with an &ldquo;Any rep tablet&rdquo; code is added by itself too, the next time this page
                  loads.
                </p>
              </div>
            )}

            {usbError ? <ErrorBox message={usbError} title="The tablet was not added" /> : null}
            {usbNotice ? (
              <p className="border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">{usbNotice}</p>
            ) : null}
            {enrollError ? <ErrorBox message={enrollError} title="No code was made" /> : null}

            {enrollment ? (
              <div className="grid gap-5 border border-slate-300 p-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
                <div className="min-w-0 space-y-3">
                  {qr ? (
                    <QrImage
                      code={qr}
                      label={enrollment.assetTag ? `Enrollment QR code for ${enrollment.assetTag}` : "Enrollment QR code for any rep tablet"}
                    />
                  ) : (
                    <p className="border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                      The QR code could not be drawn. Use the typed code on the right instead.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {qr ? (
                      <button
                        className={SECONDARY_BUTTON}
                        onClick={() =>
                          saveQrImage(
                            qr,
                            `${enrollment.assetTag ?? "Any rep tablet"} · until ${cairoDateTime(enrollment.expiresAt)}`,
                            `rep-tablet-enrollment-${(enrollment.assetTag ?? "any-tablet").replace(/[^A-Za-z0-9-]+/g, "-")}.png`,
                          )
                        }
                        type="button"
                      >
                        <Download aria-hidden className="size-4" />
                        Save as image
                      </button>
                    ) : null}
                    <button className={SECONDARY_BUTTON} onClick={() => setEnrollment(null)} type="button">
                      <EyeOff aria-hidden className="size-4" />
                      Hide the code
                    </button>
                  </div>
                </div>

                <div className="min-w-0 space-y-4">
                  <div>
                    <p className={MICRO_LABEL}>{enrollment.assetTag ? `For ${enrollment.assetTag}` : "For any rep tablet"}</p>
                    <p className={`mt-1 break-words text-sm font-semibold ${expired ? "text-rose-700" : "text-slate-900"}`}>
                      {expired
                        ? `Expired ${cairoDateTime(enrollment.expiresAt)} — make a new one.`
                        : `Usable until ${cairoDateTime(enrollment.expiresAt)}, Cairo time (${enrollment.validForLabel}).`}
                    </p>
                    <p className="mt-1 break-words text-[12px] text-slate-600">
                      {enrollment.oneTimeOnly
                        ? "It works once: the first tablet that scans it uses it up."
                        : "It works for any number of tablets until it expires."}
                    </p>
                  </div>

                  <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
                    <li>
                      Start from the tablet&rsquo;s first Welcome screen — new out of the box, or erased from Settings ›
                      System › Reset options.
                    </li>
                    <li>Tap the same empty spot on the Welcome screen six times. The tablet opens its QR scanner.</li>
                    <li>Join Wi-Fi if it asks, then point the tablet at this code.</li>
                    <li>
                      Accept the notice that the tablet belongs to the company. It sets itself up, installs Chrome and
                      applies the rules — allow a few minutes.
                    </li>
                    <li>It then appears under Enrolled tablets below. Hand it over once it shows there.</li>
                  </ol>

                  <div>
                    <p className={MICRO_LABEL}>No QR scanner?</p>
                    <p className="mt-1 text-sm text-slate-700">
                      At the Google sign-in step, type <span className="font-mono font-semibold">afw#setup</span> in the
                      email box instead, then enter this code when the tablet asks for it:
                    </p>
                    <p className="mt-2 break-all border border-slate-300 bg-slate-50 p-3 font-mono text-sm font-semibold text-slate-900" dir="ltr">
                      {enrollment.enrollmentCode}
                    </p>
                  </div>

                  <div className="flex items-start gap-3 border border-slate-300 bg-slate-50 p-4">
                    <ShieldAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-slate-700" />
                    <p className="break-words text-sm text-slate-700">
                      {enrollment.oneTimeOnly
                        ? "Whoever scans this first puts that tablet into the company's fleet. Show it only to the tablet you are setting up."
                        : "Until it expires, this code puts ANY tablet that scans it into the company's fleet. Show it only to the tablets you are setting up, and do not send it on WhatsApp or by email — the saved image carries the code too."}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          {/* ── The enrolled tablets ──────────────────────────────────────────────────── */}
          <section className="border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className={MICRO_LABEL}>Enrolled tablets</p>
                <h2 className="mt-1 text-lg font-black text-slate-900">
                  {tablets.length === 1 ? "1 tablet" : `${tablets.length} tablets`} on Google&rsquo;s list
                </h2>
                <p className="mt-1 text-[11px] font-semibold text-slate-500">Checked {cairoDateTime(data.loadedAt)}</p>
              </div>
              <button className={SECONDARY_BUTTON} disabled={loading} onClick={() => void load()} type="button">
                {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <RefreshCw aria-hidden className="size-4" />}
                {loading ? "Checking…" : "Check again"}
              </button>
            </div>

            {data.pendingRegistration > 0 ? (
              <p className="mt-4 border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
                {data.pendingRegistration === 1
                  ? "One enrolled tablet is not in the custody register yet. Plug it in and add it with “Connect a tablet by USB”."
                  : `${data.pendingRegistration} enrolled tablets are not in the custody register yet. Plug each one in and add it with “Connect a tablet by USB”.`}
              </p>
            ) : null}

            {data.registerError ? (
              <div className="mt-4">
                <WarningBox title="The custody register could not be read">
                  <p>The tablets are listed without their asset tags and holders. {data.registerError}</p>
                </WarningBox>
              </div>
            ) : null}

            {imeiCopying > 0 || imeiNotice || imeiError ? (
              <div className="mt-4 space-y-3">
                {imeiCopying > 0 ? (
                  <p className="flex items-center gap-2 border border-slate-200 bg-slate-50 px-4 py-3 text-[12px] font-bold text-slate-600">
                    <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
                    {imeiCopying === 1
                      ? "Copying the IMEI one tablet reports into the custody register…"
                      : `Copying the IMEIs ${imeiCopying} tablets report into the custody register…`}
                  </p>
                ) : null}
                {imeiNotice ? (
                  <p className="border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">
                    {imeiNotice}
                  </p>
                ) : null}
                {imeiError ? <ErrorBox message={imeiError} title="Some IMEIs were not copied into the register" /> : null}
              </div>
            ) : null}

            {tablets.length === 0 ? (
              <p className="mt-5 border border-slate-200 bg-white px-4 py-6 text-center text-[12px] font-bold text-slate-500">
                No tablet is enrolled yet. Make a QR code above and scan it from a tablet&rsquo;s Welcome screen.
              </p>
            ) : null}

            {/* DESKTOP — four columns, merged rather than shrunk so the table holds at 669px. */}
            {tablets.length > 0 ? (
              <div className="mt-5 hidden md:block">
                <table className="w-full table-fixed border-collapse">
                  <colgroup>
                    <col className="w-[28%]" />
                    <col className="w-[22%]" />
                    <col className="w-[32%]" />
                    <col className="w-[18%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-slate-300 bg-slate-50">
                      {["Tablet", "Holder", "Rules", "Last heard"].map((heading) => (
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
                    {tablets.map((row) => (
                      <tr className="border-b border-slate-200 align-top" key={row.key}>
                        <td className="px-3 py-3">
                          <TabletIdentity row={row} />
                        </td>
                        <td className="px-3 py-3">
                          <TabletHolder registerUnavailable={Boolean(data.registerError)} row={row} />
                        </td>
                        <td className="px-3 py-3">
                          <TabletRules row={row} />
                        </td>
                        <td className="px-3 py-3">
                          <TabletTimes row={row} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {/* MOBILE — one card per tablet. */}
            {tablets.length > 0 ? (
              <div className="mt-5 space-y-3 md:hidden">
                {tablets.map((row) => (
                  <div className="space-y-2 border border-slate-200 bg-white px-4 py-3" key={row.key}>
                    <TabletIdentity row={row} />
                    <div className="border-t border-slate-100 pt-2">
                      <TabletHolder registerUnavailable={Boolean(data.registerError)} row={row} />
                    </div>
                    <div className="border-t border-slate-100 pt-2">
                      <TabletRules row={row} />
                    </div>
                    <div className="border-t border-slate-100 pt-2">
                      <TabletTimes row={row} />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
