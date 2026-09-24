"use client";

/**
 * Remote control of the rep tablets, through the ManageEngine bridge.
 *
 * The tablets are enrolled in ManageEngine (which has device quota); Phoenix drives them over
 * ManageEngine's REST API so there is one console to look at — this one. This section lists the fleet
 * matched to the custody register and, per tablet, every remote action: lock, restart, reset the
 * screen lock, report in, ring, shut down, view or control the screen, pause and resume kiosk mode,
 * lost mode on/off, locate, and the two wipes. Every press hits `/api/devices/manageengine`, which is
 * Super Admin only, same-origin, and writes a required audit row naming the tablet.
 *
 * OPENING A TABLET mounts `ManageEngineTabletPanel` beneath its row — everything ManageEngine holds
 * about it, the apps on it (with sending and removing), and its command history. Those three reads
 * only run while a tablet is open, so the fleet list stays one request.
 *
 * DESIGN IDENTITY is the Rep Tablets page it sits under — the same slate borders, square corners and
 * 9px micro-labels. IT FITS THE SCREEN: the desktop table is `table-fixed` with three columns and the
 * action buttons on their own full-width row beneath each tablet, so nothing is shrunk to fit; phones
 * get cards. Nothing truncates — every line wraps. Destructive actions ask twice before they fire.
 */

import { ChevronDown, ChevronRight, Loader2, MapPin } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ManageEngineTabletPanel } from "@/components/devices/manageengine-tablet-panel";
import { cairoDateTime } from "@/lib/format/cairo-datetime";

const MICRO_LABEL = "text-[9px] font-black uppercase tracking-[0.14em] text-slate-500";
const ACTION_BUTTON =
  "inline-flex items-center gap-1.5 border border-slate-300 px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50";
const DANGER_ACTION =
  "inline-flex items-center gap-1.5 border border-rose-700 px-2.5 py-1.5 text-[12px] font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50";
const DANGER_ARMED = "border-rose-700 bg-rose-700 text-white hover:bg-rose-800";

type FleetRow = {
  deviceId: string;
  name: string;
  model: string | null;
  serialNumber: string | null;
  imei: string | null;
  platformLabel: string;
  isAndroid: boolean;
  osVersion: string | null;
  enrollmentStatus: string | null;
  lostMode: boolean;
  lastContactAt: string | null;
  assetTag: string | null;
  holderName: string | null;
  holderJobTitle: string | null;
  unregistered: boolean;
};
type FleetState = { rows: FleetRow[]; registerError: boolean };
type LocationResult = { latitude: number | null; longitude: number | null; address: string | null; locatedAt: string | null };
type CommandResult = { command: string; assetTag: string | null; message: string };

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

/**
 * Every non-destructive action, in the order a person reaches for them: the everyday three, then
 * finding a tablet, then the screen-sharing pair, then kiosk mode. Each maps to one command id the
 * route knows; ManageEngine answers with its own reason when a tablet or a licence cannot take one.
 */
const NORMAL_ACTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "LOCK", label: "Lock now" },
  { id: "RESTART", label: "Restart" },
  { id: "RESET_PASSCODE", label: "Reset screen lock" },
  { id: "SCAN", label: "Report in now" },
  { id: "RING", label: "Ring the alarm" },
  { id: "SHUTDOWN", label: "Shut down" },
  { id: "REMOTE_VIEW", label: "View the screen" },
  { id: "REMOTE_CONTROL", label: "Take control" },
  { id: "PAUSE_KIOSK", label: "Pause kiosk mode" },
  { id: "RESUME_KIOSK", label: "Resume kiosk mode" },
];
const DESTRUCTIVE_ACTIONS: ReadonlyArray<{ id: string; label: string; armed: string }> = [
  { armed: "Press again to remove", id: "CORPORATE_WIPE", label: "Remove company data" },
  { armed: "Press again to factory-reset", id: "COMPLETE_WIPE", label: "Full factory reset" },
];

function locationText(location: LocationResult): string {
  if (location.address) return location.address;
  if (location.latitude !== null && location.longitude !== null) {
    return `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;
  }
  return "No position reported for this tablet yet.";
}

export function ManageEngineFleet({ bridgeConfigured }: { bridgeConfigured: boolean }) {
  const [data, setData] = useState<FleetState | null>(null);
  const [loading, setLoading] = useState(bridgeConfigured);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(!bridgeConfigured);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [locations, setLocations] = useState<Record<string, string>>({});
  /** One tablet is open at a time — its three deep reads only run while it is. */
  const [openDeviceId, setOpenDeviceId] = useState<string | null>(null);

  const load = useCallback(async (isCurrent: () => boolean) => {
    try {
      const state = await requestJson<FleetState>("/api/devices/manageengine");
      if (!isCurrent()) return;
      setData(state);
      setSetupRequired(false);
    } catch (caught) {
      if (!isCurrent()) return;
      if (caught instanceof RequestFailure && caught.setupRequired) setSetupRequired(true);
      else setLoadError(messageOf(caught, "Could not read the ManageEngine fleet."));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!bridgeConfigured) return;
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [bridgeConfigured, load]);

  const runCommand = useCallback(
    async (row: FleetRow, command: string, destructive: boolean) => {
      const key = `${row.deviceId}:${command}`;
      if (destructive && confirmKey !== key) {
        setConfirmKey(key);
        window.setTimeout(() => setConfirmKey((current) => (current === key ? null : current)), 4000);
        return;
      }
      setConfirmKey(null);
      setBusyKey(key);
      setErrors((previous) => ({ ...previous, [row.deviceId]: "" }));
      try {
        const result = await requestJson<CommandResult>("/api/devices/manageengine", { command, deviceId: row.deviceId });
        setNotices((previous) => ({ ...previous, [row.deviceId]: result.message }));
        await load(() => true);
      } catch (caught) {
        setErrors((previous) => ({ ...previous, [row.deviceId]: messageOf(caught, "Could not take that action.") }));
      } finally {
        setBusyKey(null);
      }
    },
    [confirmKey, load],
  );

  const locate = useCallback(async (row: FleetRow) => {
    const key = `${row.deviceId}:LOCATE`;
    setBusyKey(key);
    setErrors((previous) => ({ ...previous, [row.deviceId]: "" }));
    try {
      const result = await requestJson<LocationResult>(
        `/api/devices/manageengine?deviceId=${encodeURIComponent(row.deviceId)}&view=locate`,
      );
      const when = result.locatedAt ? ` · ${cairoDateTime(result.locatedAt)}` : "";
      setLocations((previous) => ({ ...previous, [row.deviceId]: `${locationText(result)}${when}` }));
    } catch (caught) {
      setErrors((previous) => ({ ...previous, [row.deviceId]: messageOf(caught, "Could not locate the tablet.") }));
    } finally {
      setBusyKey(null);
    }
  }, []);

  const toggleOpen = useCallback((row: FleetRow) => {
    setOpenDeviceId((current) => (current === row.deviceId ? null : row.deviceId));
  }, []);

  const rows = data?.rows ?? [];

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-black text-slate-900">Remote control</h2>
        <p className="text-[11px] font-semibold text-slate-500">Live from ManageEngine · Super Admin only</p>
      </div>
      <p className="mt-1 max-w-3xl text-[12px] font-semibold text-slate-600">
        Lock, restart, reset a screen lock, ring a tablet that is mislaid, ask one to report in, shut it down, view or
        take over its screen, pause and resume kiosk mode, put a lost tablet into lost mode and locate it, or wipe one
        that is stolen or being retired. Open a tablet to see everything ManageEngine holds about it, the apps on it —
        sending one or taking one off — and every command it has been sent. Each action is recorded against the tablet in
        the audit log.
      </p>

      {setupRequired ? (
        <div className="mt-4 border border-amber-300 bg-amber-50 px-4 py-3 text-[12px] font-semibold text-amber-900">
          The ManageEngine bridge is not connected yet. Once the Zoho Self Client credential is set, the fleet and its
          remote actions appear here.
        </div>
      ) : null}

      {loading ? (
        <p className="mt-4 flex items-center gap-2 text-[12px] font-semibold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Reading the fleet from ManageEngine…
        </p>
      ) : null}

      {loadError ? (
        <div className="mt-4 border border-rose-300 bg-rose-50 px-4 py-3 text-[12px] font-semibold text-rose-800">
          {loadError}
        </div>
      ) : null}

      {!loading && !setupRequired && !loadError && rows.length === 0 ? (
        <p className="mt-4 border border-slate-200 bg-white px-4 py-6 text-center text-[12px] font-bold text-slate-500">
          ManageEngine manages no tablets yet. Enrol one from its console and it appears here.
        </p>
      ) : null}

      {data?.registerError ? (
        <div className="mt-4 border border-amber-300 bg-amber-50 px-4 py-3 text-[12px] font-semibold text-amber-900">
          The custody register could not be read, so holders are not shown — the fleet and its actions still work.
        </div>
      ) : null}

      {rows.length > 0 ? (
        <>
          {/* DESKTOP — three columns, with each tablet's actions on their own full-width row. */}
          <div className="mt-4 hidden md:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[34%]" />
                <col className="w-[26%]" />
                <col className="w-[40%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-300 bg-slate-50">
                  {["Tablet", "Holder", "Status"].map((heading) => (
                    <th className={`px-3 py-2 text-left ${MICRO_LABEL}`} key={heading} scope="col">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <FleetRowBlock
                    busyKey={busyKey}
                    columns={3}
                    confirmKey={confirmKey}
                    error={errors[row.deviceId]}
                    key={row.deviceId}
                    location={locations[row.deviceId]}
                    notice={notices[row.deviceId]}
                    onCommand={runCommand}
                    onLocate={locate}
                    onToggle={toggleOpen}
                    open={openDeviceId === row.deviceId}
                    row={row}
                    variant="desktop"
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* MOBILE — one card per tablet. */}
          <div className="mt-4 space-y-3 md:hidden">
            {rows.map((row) => (
              <FleetRowBlock
                busyKey={busyKey}
                columns={1}
                confirmKey={confirmKey}
                error={errors[row.deviceId]}
                key={row.deviceId}
                location={locations[row.deviceId]}
                notice={notices[row.deviceId]}
                onCommand={runCommand}
                onLocate={locate}
                onToggle={toggleOpen}
                open={openDeviceId === row.deviceId}
                row={row}
                variant="mobile"
              />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

type BlockProps = {
  row: FleetRow;
  variant: "desktop" | "mobile";
  columns: number;
  busyKey: string | null;
  confirmKey: string | null;
  notice?: string;
  error?: string;
  location?: string;
  /** This tablet's deep panel is showing — its three reads are mounted. */
  open: boolean;
  onCommand: (row: FleetRow, command: string, destructive: boolean) => void;
  onLocate: (row: FleetRow) => void;
  onToggle: (row: FleetRow) => void;
};

function TabletCell({ row }: { row: FleetRow }) {
  return (
    <>
      {row.assetTag ? (
        <p className="break-words text-[12px] font-black text-slate-900">{row.assetTag}</p>
      ) : (
        <p className="break-words text-[12px] font-black text-amber-700">Not in the custody register</p>
      )}
      <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">{row.model ?? row.name}</p>
      {row.serialNumber ? (
        <p className="mt-0.5 break-words text-[11px] font-bold text-slate-700" dir="ltr">
          S/N {row.serialNumber}
        </p>
      ) : null}
      {row.imei ? (
        <p className="mt-0.5 break-words text-[11px] font-bold text-slate-700" dir="ltr">
          IMEI {row.imei}
        </p>
      ) : null}
    </>
  );
}

function HolderCell({ row }: { row: FleetRow }) {
  if (!row.assetTag) {
    return <p className="break-words text-[11px] font-semibold text-slate-400">Unknown — add it to the register</p>;
  }
  return row.holderName ? (
    <>
      <p className="break-words text-[12px] font-bold text-slate-900">{row.holderName}</p>
      <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">{row.holderJobTitle ?? "Job title not recorded"}</p>
    </>
  ) : (
    <p className="break-words text-[11px] font-semibold text-slate-400">Nobody — held by the company</p>
  );
}

function StatusCell({ row, location }: { row: FleetRow; location?: string }) {
  return (
    <>
      <div className="flex flex-wrap gap-1">
        <span className="border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">
          {row.platformLabel}
          {row.osVersion ? ` ${row.osVersion}` : ""}
        </span>
        {row.lostMode ? (
          <span className="border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-800">In lost mode</span>
        ) : null}
        {row.enrollmentStatus ? (
          <span className="border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">
            {row.enrollmentStatus}
          </span>
        ) : null}
      </div>
      <p className="mt-1 break-words text-[11px] font-semibold text-slate-500">
        {row.lastContactAt ? `Last seen ${cairoDateTime(row.lastContactAt)}` : "Not heard from yet"}
      </p>
      {location ? (
        <p className="mt-1 flex items-start gap-1 break-words text-[11px] font-bold text-slate-700">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden /> {location}
        </p>
      ) : null}
    </>
  );
}

function FleetActions({ row, busyKey, confirmKey, open, onCommand, onLocate, onToggle }: BlockProps) {
  const busy = (key: string) => busyKey === key;
  const anyBusy = busyKey !== null && busyKey.startsWith(`${row.deviceId}:`);
  const lostToggle = row.lostMode
    ? { id: "DISABLE_LOST_MODE", label: "End lost mode" }
    : { id: "ENABLE_LOST_MODE", label: "Put in lost mode" };
  return (
    <div className="flex flex-wrap gap-2">
      <button className={ACTION_BUTTON} onClick={() => onToggle(row)} type="button">
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        )}
        {open ? "Close this tablet" : "Open this tablet"}
      </button>
      {NORMAL_ACTIONS.map((action) => (
        <button
          className={ACTION_BUTTON}
          disabled={anyBusy}
          key={action.id}
          onClick={() => onCommand(row, action.id, false)}
          type="button"
        >
          {busy(`${row.deviceId}:${action.id}`) ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          {action.label}
        </button>
      ))}
      <button className={ACTION_BUTTON} disabled={anyBusy} onClick={() => onCommand(row, lostToggle.id, false)} type="button">
        {busy(`${row.deviceId}:${lostToggle.id}`) ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
        {lostToggle.label}
      </button>
      <button className={ACTION_BUTTON} disabled={anyBusy} onClick={() => onLocate(row)} type="button">
        {busy(`${row.deviceId}:LOCATE`) ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <MapPin className="h-3.5 w-3.5" aria-hidden />
        )}
        Locate
      </button>
      {DESTRUCTIVE_ACTIONS.map((action) => {
        const key = `${row.deviceId}:${action.id}`;
        const armed = confirmKey === key;
        return (
          <button
            className={`${DANGER_ACTION} ${armed ? DANGER_ARMED : ""}`}
            disabled={anyBusy}
            key={action.id}
            onClick={() => onCommand(row, action.id, true)}
            type="button"
          >
            {busy(key) ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {armed ? action.armed : action.label}
          </button>
        );
      })}
    </div>
  );
}

function FleetRowBlock(props: BlockProps) {
  const { row, variant, columns, notice, error, location, open } = props;
  if (variant === "mobile") {
    return (
      <div className="space-y-2 border border-slate-200 bg-white px-4 py-3">
        <TabletCell row={row} />
        <div className="border-t border-slate-100 pt-2">
          <HolderCell row={row} />
        </div>
        <div className="border-t border-slate-100 pt-2">
          <StatusCell location={location} row={row} />
        </div>
        <div className="border-t border-slate-100 pt-2">
          <FleetActions {...props} />
          {notice ? <p className="mt-2 break-words text-[11px] font-bold text-emerald-800">{notice}</p> : null}
          {error ? <p className="mt-2 break-words text-[11px] font-bold text-rose-700">{error}</p> : null}
          {open ? <ManageEngineTabletPanel deviceId={row.deviceId} /> : null}
        </div>
      </div>
    );
  }
  return (
    <>
      <tr className="border-b border-slate-100 align-top">
        <td className="px-3 pt-3">
          <TabletCell row={row} />
        </td>
        <td className="px-3 pt-3">
          <HolderCell row={row} />
        </td>
        <td className="px-3 pt-3">
          <StatusCell location={location} row={row} />
        </td>
      </tr>
      <tr className="border-b border-slate-200">
        <td className="px-3 pb-3 pt-2" colSpan={columns}>
          <FleetActions {...props} />
          {notice ? <p className="mt-2 break-words text-[11px] font-bold text-emerald-800">{notice}</p> : null}
          {error ? <p className="mt-2 break-words text-[11px] font-bold text-rose-700">{error}</p> : null}
          {open ? <ManageEngineTabletPanel deviceId={row.deviceId} /> : null}
        </td>
      </tr>
    </>
  );
}
