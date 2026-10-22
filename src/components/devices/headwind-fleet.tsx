"use client";

/**
 * Remote control of the rep tablets, through the company's OWN Headwind MDM server.
 *
 * WHY THERE ARE TWO OF THESE SECTIONS. ManageEngine's free edition caps the fleet at 25 tablets and
 * its screen sharing is a paid add-on; the owner expects about a hundred tablets. Headwind MDM
 * Community, on a small server of the company's own, has no device cap at all — so the fleet moves
 * onto it, one tablet at a time. Android allows only ONE device owner per tablet, so a tablet is in
 * exactly one of the two sections, never both, and this one grows as the other empties.
 *
 * 🔴 VIEWING AND TAKING OVER A SCREEN ARE FREE HERE, AND THAT IS THE WHOLE POINT OF THE PAIR. They do
 * not go through the MDM at all: the company's own RustDesk relay carries them, and the RustDesk app
 * on the Super Admin's computer is what draws the screen. So those two buttons carry no amber mark
 * and no "Paid" chip — the contrast with the ManageEngine section above is deliberate and visible.
 *
 * 🔴 AN ACTION PHOENIX CANNOT YET SEND IS SHOWN, GREYED, WITH THE REASON — never hidden and never
 * offered as if it worked. Headwind drives every action down one push channel, and it publishes the
 * word for only two of them; the rest are read off the server's own API list once it is up. A button
 * that reported success while reaching nothing would be the worst outcome on a custody console, so
 * those are disabled here and refused by the server too. The chip says PENDING — colour is never the
 * only signal.
 *
 * DESIGN IDENTITY is the Rep Tablets page it sits under — the same slate borders, square corners and
 * 9px micro-labels. IT FITS THE SCREEN: the desktop table is `table-fixed` with three columns and the
 * action buttons on their own full-width row beneath each tablet, so nothing is shrunk to fit; phones
 * get cards. Nothing truncates — every line wraps. The factory reset asks twice before it fires.
 */

import { ChevronDown, ChevronRight, Loader2, MapPin, Monitor, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ARM_WINDOW_MS } from "@/components/devices/headwind-panel-kit";
import { HeadwindTabletPanel } from "@/components/devices/headwind-tablet-panel";
import type { AssignableEmployee, DeviceStatus } from "@/lib/devices/types";
import { cairoDateTime } from "@/lib/format/cairo-datetime";

const MICRO_LABEL = "text-[9px] font-black uppercase tracking-[0.14em] text-slate-500";

/** Tailwind's `md` — the width where the desktop table shows and the phone cards hide. */
const TABLE_QUERY = "(min-width: 768px)";

function subscribeToTableWidth(callback: () => void) {
  const query = window.matchMedia(TABLE_QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

/**
 * 🔴 WHICH LAYOUT IS ON SCREEN, SO AN OPENED TABLET MOUNTS ITS PANEL ONCE. The fleet renders the
 * desktop table AND the phone cards at the same time and lets CSS hide one, so an opened tablet used to
 * mount `HeadwindTabletPanel` twice — every deep read (apps, details, location, history) ran twice, and
 * the hidden copy kept its own armed and busy state. The server snapshot is `true`; nothing is open on
 * first paint, so it never decides what the server renders.
 */
function useTableLayout(): boolean {
  return useSyncExternalStore(
    subscribeToTableWidth,
    () => window.matchMedia(TABLE_QUERY).matches,
    () => true,
  );
}

const ACTION_BUTTON =
  "inline-flex items-center gap-1.5 border border-slate-300 px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50";
const DANGER_ACTION =
  "inline-flex items-center gap-1.5 border border-rose-700 px-2.5 py-1.5 text-[12px] font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50";
const DANGER_ARMED = "border-rose-700 bg-rose-700 text-white hover:bg-rose-800";
// Emerald marks the two things that cost money on ManageEngine and cost nothing here. Like every
// style constant in these components it is a SELF-CONTAINED class string, not ACTION_BUTTON with a
// colour appended — the two would both carry a border-colour and, with no tailwind-merge here, source
// order in the stylesheet (not the className) would decide the winner.
const FREE_ACTION =
  "inline-flex items-center gap-1.5 border border-emerald-600 bg-emerald-50 px-2.5 py-1.5 text-[12px] font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:opacity-50";
/** The little square "FREE" chip inside a screen-session button — colour is never the only signal. */
const FREE_CHIP = "border border-emerald-600 px-1 text-[8px] font-black uppercase tracking-[0.12em] text-emerald-800";
/** An action whose wire name is not confirmed yet: greyed, with its own chip saying why. */
const PENDING_ACTION =
  "inline-flex items-center gap-1.5 border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[12px] font-semibold text-slate-400";
const PENDING_CHIP = "border border-slate-300 px-1 text-[8px] font-black uppercase tracking-[0.12em] text-slate-500";

type FleetRow = {
  deviceNumber: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  imei: string | null;
  osVersion: string | null;
  platformLabel: string;
  isAndroid: boolean;
  enrollmentStatus: string | null;
  configurationName: string | null;
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  agentVersion: string | null;
  lastContactAt: string | null;
  latitude: number | null;
  longitude: number | null;
  locatedAt: string | null;
  rustDeskId: string | null;
  assetTag: string | null;
  holderName: string | null;
  holderJobTitle: string | null;
  registerDeviceId: string | null;
  registerStatus: DeviceStatus | null;
  assignmentId: string | null;
  placeholderName: string | null;
  unregistered: boolean;
};
type CommandDef = {
  id: string;
  label: string;
  description: string;
  destructive: boolean;
  ready: boolean;
  /** Why it refuses, when it does — the server writes this sentence, never the console. */
  pendingReason: string | null;
};
type FleetState = {
  rows: FleetRow[];
  registerError: boolean;
  /** Managed tablets not in the custody register yet that a person could confirm — the count, never the act. */
  pendingRegistration: number;
  imeisToRecord: number;
  remoteScreenReady: boolean;
  commands: CommandDef[];
  assignable: AssignableEmployee[];
};
type LocationResult = { latitude: number | null; longitude: number | null; address: string | null; locatedAt: string | null };
type CommandResult = { command: string; assetTag: string | null; message: string };
type ScreenTarget = {
  // 🔴 `relayLabel`, never `relayHost` — the host is null on RustDesk's public relay and a toast
  // built from it reads "through null". The label is always a phrase.
  target: { rustDeskId: string; connectUrl: string; relayLabel: string; mode: string } | null;
  reason: string | null;
};
type ImeiRecordResult = {
  recorded: Array<{ assetTag: string; imei: string }>;
  alreadyRecorded: string[];
  failed: Array<{ assetTag: string; message: string }>;
};
/** The custody entry a person confirmed into the register from a tablet's row. */
type RegisterResult = { assetTag: string; created: boolean };

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

function locationText(location: LocationResult): string {
  if (location.address) return location.address;
  if (location.latitude !== null && location.longitude !== null) {
    return `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;
  }
  return "No position reported for this tablet yet.";
}

export function HeadwindFleet() {
  const [data, setData] = useState<FleetState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [locations, setLocations] = useState<Record<string, string>>({});
  /** One tablet is open at a time — its deep reads only run while it is. */
  const [openDeviceNumber, setOpenDeviceNumber] = useState<string | null>(null);
  /** And it opens in the ONE layout on screen — see `useTableLayout`. */
  const tableLayout = useTableLayout();

  const load = useCallback(async (isCurrent: () => boolean) => {
    try {
      const state = await requestJson<FleetState>("/api/devices/headwind");
      if (!isCurrent()) return;
      setData(state);
      setSetupRequired(false);
      // A read that worked clears the last one's failure — a red box over a fleet that loaded is a lie.
      setLoadError(null);
    } catch (caught) {
      if (!isCurrent()) return;
      if (caught instanceof RequestFailure && caught.setupRequired) setSetupRequired(true);
      else setLoadError(messageOf(caught, "Could not read the Headwind fleet."));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);

  // An IMEI a tablet reports that its register entry does not hold yet is copied in by the page
  // itself, so nobody types fifteen digits off a Settings screen — the same thing the Google and
  // ManageEngine halves have done since 2026-09-18 and 2026-09-25. ONCE PER VISIT: a copy that fails
  // is shown, never retried in a loop.
  const imeiAsked = useRef(false);
  const [imeiNotice, setImeiNotice] = useState<string | null>(null);
  const [imeiError, setImeiError] = useState<string | null>(null);
  const pendingImeis = data?.imeisToRecord ?? 0;

  useEffect(() => {
    if (pendingImeis === 0 || imeiAsked.current) return;
    imeiAsked.current = true;
    void requestJson<ImeiRecordResult>("/api/devices/headwind/imei", {})
      .then((result) => {
        setImeiNotice(imeiCopiedText(result));
        setImeiError(imeiFailedText(result));
        return load(() => true);
      })
      .catch((caught: unknown) => {
        setImeiError(messageOf(caught, "Could not copy the tablets' IMEIs into the custody register."));
      });
  }, [load, pendingImeis]);

  /**
   * One reload the panels can ask for by name.
   *
   * The remote screen ID is typed in the panel underneath a row and displayed IN that row, so without
   * this the row would keep showing "no screen ID" beside a panel that had just saved one — two true
   * halves of the same screen disagreeing, which on a custody console reads as a failed write.
   */
  const refresh = useCallback(() => {
    void load(() => true);
  }, [load]);

  const runCommand = useCallback(
    async (row: FleetRow, command: string, destructive: boolean) => {
      const key = `${row.deviceNumber}:${command}`;
      if (destructive && confirmKey !== key) {
        setConfirmKey(key);
        window.setTimeout(() => setConfirmKey((current) => (current === key ? null : current)), ARM_WINDOW_MS);
        return;
      }
      setConfirmKey(null);
      setBusyKey(key);
      setErrors((previous) => ({ ...previous, [row.deviceNumber]: "" }));
      try {
        const result = await requestJson<CommandResult>("/api/devices/headwind", {
          command,
          deviceNumber: row.deviceNumber,
        });
        setNotices((previous) => ({ ...previous, [row.deviceNumber]: result.message }));
        await load(() => true);
      } catch (caught) {
        setErrors((previous) => ({ ...previous, [row.deviceNumber]: messageOf(caught, "Could not take that action.") }));
      } finally {
        setBusyKey(null);
      }
    },
    [confirmKey, load],
  );

  const locate = useCallback(async (row: FleetRow) => {
    const key = `${row.deviceNumber}:LOCATE`;
    setBusyKey(key);
    setErrors((previous) => ({ ...previous, [row.deviceNumber]: "" }));
    try {
      const result = await requestJson<LocationResult>(
        `/api/devices/headwind?deviceNumber=${encodeURIComponent(row.deviceNumber)}`,
      );
      const when = result.locatedAt ? ` · ${cairoDateTime(result.locatedAt)}` : "";
      setLocations((previous) => ({ ...previous, [row.deviceNumber]: `${locationText(result)}${when}` }));
    } catch (caught) {
      setErrors((previous) => ({ ...previous, [row.deviceNumber]: messageOf(caught, "Could not read the tablet's position.") }));
    } finally {
      setBusyKey(null);
    }
  }, []);

  /**
   * Open a screen session on a tablet.
   *
   * 🔴 THE LINK IS BUILT ON THE SERVER AND CARRIES NO CREDENTIAL. What comes back names the tablet and
   * the company's relay; the RustDesk app on this computer is what connects. A tablet with no RustDesk
   * ID yet comes back with a sentence saying so, which is shown as a notice, never as an error — it is
   * a setup step, not a failure.
   */
  const openScreen = useCallback(async (row: FleetRow, mode: "view" | "control") => {
    const key = `${row.deviceNumber}:SCREEN_${mode}`;
    setBusyKey(key);
    setErrors((previous) => ({ ...previous, [row.deviceNumber]: "" }));
    try {
      const result = await requestJson<ScreenTarget>(
        `/api/devices/headwind?deviceNumber=${encodeURIComponent(row.deviceNumber)}&view=screen&mode=${mode}`,
      );
      if (!result.target) {
        setNotices((previous) => ({ ...previous, [row.deviceNumber]: result.reason ?? "This tablet is not set up for screen sessions yet." }));
        return;
      }
      setNotices((previous) => ({
        ...previous,
        [row.deviceNumber]:
          mode === "control"
            ? `Opening control of ${row.assetTag ?? row.name} in the RustDesk app, through ${result.target!.relayLabel}.`
            : `Opening the screen of ${row.assetTag ?? row.name} in the RustDesk app, through ${result.target!.relayLabel}.`,
      }));
      window.location.href = result.target.connectUrl;
    } catch (caught) {
      setErrors((previous) => ({ ...previous, [row.deviceNumber]: messageOf(caught, "Could not open a screen session.") }));
    } finally {
      setBusyKey(null);
    }
  }, []);

  /**
   * Add one managed tablet to the custody register — the person-confirmed step that replaced the
   * silent auto-create (owner, 2026-10-22). On success the fleet is read again, so the row moves from
   * "Not in the custody register" to its new asset tag and the waiting count above it drops.
   */
  const addToCustody = useCallback(
    async (row: FleetRow) => {
      const key = `${row.deviceNumber}:REGISTER`;
      setBusyKey(key);
      setErrors((previous) => ({ ...previous, [row.deviceNumber]: "" }));
      try {
        const result = await requestJson<RegisterResult>("/api/devices/headwind/register", {
          deviceNumber: row.deviceNumber,
        });
        setNotices((previous) => ({
          ...previous,
          [row.deviceNumber]: result.created
            ? `Added ${result.assetTag} to the custody register.`
            : `This tablet is already in the custody register as ${result.assetTag}.`,
        }));
        await load(() => true);
      } catch (caught) {
        setErrors((previous) => ({
          ...previous,
          [row.deviceNumber]: messageOf(caught, "Could not add this tablet to the custody register."),
        }));
      } finally {
        setBusyKey(null);
      }
    },
    [load],
  );

  const toggleOpen = useCallback((row: FleetRow) => {
    setOpenDeviceNumber((current) => (current === row.deviceNumber ? null : row.deviceNumber));
  }, []);

  const rows = data?.rows ?? [];
  const commands = data?.commands ?? [];
  const pendingCommands = commands.filter((command) => !command.ready);

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-black text-slate-900">Remote control · company server</h2>
        <p className="text-[11px] font-semibold text-slate-500">Live from Headwind · Super Admin only</p>
      </div>
      <p className="mt-1 max-w-3xl text-[12px] font-semibold text-slate-600">
        The tablets on the company&rsquo;s own device-management server. Nothing on it is licensed per tablet and
        there is nothing to renew. Viewing and taking over a tablet&rsquo;s screen run through the company&rsquo;s own relay and
        cost nothing. Open a tablet to see everything the server holds about it, the apps on it, and every action taken
        from Phoenix. Each action sent to a tablet from here is recorded against it in the audit log; opening its
        screen in RustDesk is not an action on the tablet and is not recorded.
      </p>

      {/*
        🔴 THIS BLOCK IS EMPTY TODAY AND THAT IS THE POINT — every one of the seven actions is
        carried. Lock, locate and factory reset were the three that were not, and the owner's ruling of
        2026-09-25 ("do not build a dead button") is why they are: lock and factory reset moved to the
        Phoenix add-on on our own Headwind box, and locate to `locations.ts`. `HEADWIND_UNCONFIRMED_REASONS`
        is now `{}`, so `pendingCommands` is empty and nothing below renders.

        IT STAYS ANYWAY, because the honest failure mode is the one it catches: if a future action
        genuinely cannot be sent, it must appear here as its OWN sentence rather than as a control that
        greys out. Each reason is different in kind — a box that needs rebuilding is not the same as a
        permission Android grants only to a manufacturer — and one shared "pending" sentence would leave
        a person deciding about a stolen tablet unable to tell which they were looking at.
      */}
      {pendingCommands.length > 0 ? (
        <div className="mt-3 flex max-w-3xl flex-col gap-2 border border-slate-200 bg-white px-4 py-3 text-[11px] font-semibold text-slate-600">
          <p className={MICRO_LABEL}>Switched off, and why</p>
          {pendingCommands.map((command) => (
            <p key={command.id}>
              <span className={`mr-1 inline-block ${PENDING_CHIP}`}>{command.label}</span>
              {command.pendingReason ??
                "Phoenix will not send this yet, so the button is switched off rather than reporting a success that never reached the tablet."}
            </p>
          ))}
        </div>
      ) : null}

      {setupRequired ? (
        <div className="mt-4 border border-amber-300 bg-amber-50 px-4 py-3 text-[12px] font-semibold text-amber-900">
          The company&rsquo;s Headwind server is not connected yet. Once its address and admin login are set, the fleet
          and its remote actions appear here.
        </div>
      ) : null}

      {loading ? (
        <p className="mt-4 flex items-center gap-2 text-[12px] font-semibold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Reading the fleet from the company server…
        </p>
      ) : null}

      {loadError ? (
        <div className="mt-4 border border-rose-300 bg-rose-50 px-4 py-3 text-[12px] font-semibold text-rose-800">
          {loadError}
        </div>
      ) : null}

      {!loading && !setupRequired && !loadError && rows.length === 0 ? (
        <p className="mt-4 border border-slate-200 bg-white px-4 py-6 text-center text-[12px] font-bold text-slate-500">
          No tablets are on the company server yet. Enrol one and it appears here by itself.
        </p>
      ) : null}

      {data && !data.remoteScreenReady && rows.length > 0 ? (
        <div className="mt-4 border border-slate-200 bg-white px-4 py-3 text-[12px] font-semibold text-slate-600">
          Screen viewing and control are off because the company&rsquo;s own relay is only half set up — one of its two
          settings is missing. Clear both to go back to RustDesk&rsquo;s public relay, or set both. Everything else on
          this list works either way.
        </div>
      ) : null}

      {data?.registerError ? (
        <div className="mt-4 border border-amber-300 bg-amber-50 px-4 py-3 text-[12px] font-semibold text-amber-900">
          The custody register could not be read, so holders are not shown — the fleet and its actions still work.
        </div>
      ) : null}

      {data && data.pendingRegistration > 0 ? (
        <div className="mt-4 border border-amber-300 bg-amber-50 px-4 py-3 text-[12px] font-semibold text-amber-900">
          {data.pendingRegistration === 1
            ? "One managed tablet is not in the custody register yet. Add it to custody from its row below."
            : `${data.pendingRegistration} managed tablets are not in the custody register yet. Add each to custody from its row below.`}
        </div>
      ) : null}
      {imeiNotice ? (
        <p className="mt-4 border border-emerald-300 bg-emerald-50 px-4 py-3 text-[12px] font-semibold text-emerald-900">
          {imeiNotice}
        </p>
      ) : null}
      {imeiError ? (
        <div className="mt-4 border border-amber-300 bg-amber-50 px-4 py-3 text-[12px] font-semibold text-amber-900">
          {imeiError}
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
                    commands={commands}
                    confirmKey={confirmKey}
                    error={errors[row.deviceNumber]}
                    key={row.deviceNumber}
                    location={locations[row.deviceNumber]}
                    notice={notices[row.deviceNumber]}
                    onCommand={runCommand}
                    onLocate={locate}
                    onRegister={addToCustody}
                    onRefresh={refresh}
                    onScreen={openScreen}
                    onToggle={toggleOpen}
                    open={tableLayout && openDeviceNumber === row.deviceNumber}
                    remoteScreenReady={data?.remoteScreenReady ?? false}
                    assignable={data?.assignable ?? []}
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
                commands={commands}
                confirmKey={confirmKey}
                error={errors[row.deviceNumber]}
                key={row.deviceNumber}
                location={locations[row.deviceNumber]}
                notice={notices[row.deviceNumber]}
                onCommand={runCommand}
                onLocate={locate}
                onRegister={addToCustody}
                onRefresh={refresh}
                onScreen={openScreen}
                onToggle={toggleOpen}
                open={!tableLayout && openDeviceNumber === row.deviceNumber}
                remoteScreenReady={data?.remoteScreenReady ?? false}
                assignable={data?.assignable ?? []}
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
  commands: CommandDef[];
  remoteScreenReady: boolean;
  busyKey: string | null;
  confirmKey: string | null;
  notice?: string;
  error?: string;
  location?: string;
  /** This tablet's deep panel is showing — its reads are mounted. */
  open: boolean;
  onCommand: (row: FleetRow, command: string, destructive: boolean) => void;
  onLocate: (row: FleetRow) => void;
  /** Add this managed tablet to the custody register — the person-confirmed step. */
  onRegister: (row: FleetRow) => void;
  onScreen: (row: FleetRow, mode: "view" | "control") => void;
  onToggle: (row: FleetRow) => void;
  /** Read the fleet again — a remote screen ID recorded in the panel has to reach the row above it. */
  onRefresh: () => void;
  /** Active employees the custody panel can assign or reconcile a tablet to. */
  assignable: AssignableEmployee[];
};

function TabletCell({ row }: { row: FleetRow }) {
  return (
    <>
      {row.assetTag ? (
        <p className="break-words text-[12px] font-black text-slate-900">{row.assetTag}</p>
      ) : row.unregistered ? (
        <p className="break-words text-[12px] font-black text-amber-700">Not in the custody register</p>
      ) : (
        // The register could not be read — "not in it" would be a guess, and it would offer an Add.
        <p className="break-words text-[12px] font-black text-slate-500">Custody not readable</p>
      )}
      <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
        {[row.manufacturer, row.model].filter(Boolean).join(" ") || row.name}
      </p>
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
    if (!row.unregistered) {
      return <p className="break-words text-[11px] font-semibold text-slate-400">Not known — the custody register could not be read</p>;
    }
    return (
      <p className="break-words text-[11px] font-semibold text-slate-400">
        {row.serialNumber || row.imei
          ? "Nobody yet — add it to custody from this row"
          : "Nobody yet — it can be added to custody once it reports its serial number or IMEI"}
      </p>
    );
  }
  return row.holderName ? (
    <>
      <p className="break-words text-[12px] font-bold text-slate-900">{row.holderName}</p>
      <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
        {row.holderJobTitle ?? "Job title not recorded"}
      </p>
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
        {row.enrollmentStatus ? (
          <span className="border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">
            {row.enrollmentStatus}
          </span>
        ) : null}
        {row.batteryLevel !== null ? (
          <span className="border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">
            Battery {row.batteryLevel}%{row.batteryCharging ? " · charging" : ""}
          </span>
        ) : null}
        {row.configurationName ? (
          <span className="border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">
            {row.configurationName}
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

function FleetActions({
  row,
  commands,
  remoteScreenReady,
  busyKey,
  confirmKey,
  open,
  onCommand,
  onLocate,
  onRegister,
  onScreen,
  onToggle,
}: BlockProps) {
  const busy = (key: string) => busyKey === key;
  const anyBusy = busyKey !== null && busyKey.startsWith(`${row.deviceNumber}:`);
  const normal = commands.filter((command) => !command.destructive);
  const destructive = commands.filter((command) => command.destructive);
  // A tablet the register has never seen can be confirmed into custody here — but only if it reports a
  // serial or an IMEI, since a row with neither cannot be told apart and the server would refuse it.
  const canAddToCustody = row.unregistered && Boolean(row.serialNumber ?? row.imei);
  return (
    <div className="flex flex-wrap gap-2">
      <button className={ACTION_BUTTON} onClick={() => onToggle(row)} type="button">
        {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
        {open ? "Close this tablet" : "Open this tablet"}
      </button>

      {canAddToCustody ? (
        <button
          className={ACTION_BUTTON}
          disabled={anyBusy}
          onClick={() => onRegister(row)}
          title="Add this tablet to the Device Custody register, under the next PHX-TAB number"
          type="button"
        >
          {busy(`${row.deviceNumber}:REGISTER`) ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Plus className="h-3.5 w-3.5" aria-hidden />
          )}
          Add to custody
        </button>
      ) : null}

      {/* The free pair — no amber, no Paid chip. See the header. */}
      {(["view", "control"] as const).map((mode) => (
        <button
          className={FREE_ACTION}
          disabled={anyBusy || !remoteScreenReady}
          key={mode}
          onClick={() => onScreen(row, mode)}
          title={
            remoteScreenReady
              ? "Opens in the RustDesk app on this computer, through the relay this fleet is set to"
              : "Off until the company's own relay is set fully, or cleared back to the public one"
          }
          type="button"
        >
          {busy(`${row.deviceNumber}:SCREEN_${mode}`) ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Monitor className="h-3.5 w-3.5" aria-hidden />
          )}
          {mode === "view" ? "View the screen" : "Take control"}
          <span className={FREE_CHIP}>Free</span>
        </button>
      ))}

      {normal.map((command) =>
        command.ready ? (
          <button
            className={ACTION_BUTTON}
            disabled={anyBusy}
            key={command.id}
            onClick={() => onCommand(row, command.id, false)}
            title={command.description}
            type="button"
          >
            {busy(`${row.deviceNumber}:${command.id}`) ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {command.label}
          </button>
        ) : (
          <span
            className={PENDING_ACTION}
            key={command.id}
            title={command.pendingReason ?? command.description}
          >
            {command.label}
            <span className={PENDING_CHIP}>Pending</span>
          </span>
        ),
      )}

      <button className={ACTION_BUTTON} disabled={anyBusy} onClick={() => onLocate(row)} type="button">
        {busy(`${row.deviceNumber}:LOCATE`) ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <MapPin className="h-3.5 w-3.5" aria-hidden />
        )}
        Last known position
      </button>

      {destructive.map((command) => {
        const key = `${row.deviceNumber}:${command.id}`;
        const armed = confirmKey === key;
        if (!command.ready) {
          return (
            <span
              className={PENDING_ACTION}
              key={command.id}
              title={command.pendingReason ?? command.description}
            >
              {command.label}
              <span className={PENDING_CHIP}>Pending</span>
            </span>
          );
        }
        return (
          <button
            className={`${DANGER_ACTION} ${armed ? DANGER_ARMED : ""}`}
            disabled={anyBusy}
            key={command.id}
            onClick={() => onCommand(row, command.id, true)}
            type="button"
          >
            {busy(key) ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {armed ? `Press again to ${command.label.toLowerCase()} ${row.assetTag ?? row.name}` : command.label}
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
          {open ? (
            <HeadwindTabletPanel
              custody={{
                assignable: props.assignable,
                assignmentId: row.assignmentId,
                holderJobTitle: row.holderJobTitle,
                holderName: row.holderName,
                placeholderName: row.placeholderName,
                registerDeviceId: row.registerDeviceId,
                registerStatus: row.registerStatus,
              }}
              deviceNumber={row.deviceNumber}
              onCustodyChanged={props.onRefresh}
              onRemoteScreenIdSaved={props.onRefresh}
              remoteScreenId={row.rustDeskId}
              tabletName={row.assetTag ?? row.name}
            />
          ) : null}
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
          {open ? (
            <HeadwindTabletPanel
              custody={{
                assignable: props.assignable,
                assignmentId: row.assignmentId,
                holderJobTitle: row.holderJobTitle,
                holderName: row.holderName,
                placeholderName: row.placeholderName,
                registerDeviceId: row.registerDeviceId,
                registerStatus: row.registerStatus,
              }}
              deviceNumber={row.deviceNumber}
              onCustodyChanged={props.onRefresh}
              onRemoteScreenIdSaved={props.onRefresh}
              remoteScreenId={row.rustDeskId}
              tabletName={row.assetTag ?? row.name}
            />
          ) : null}
        </td>
      </tr>
    </>
  );
}
