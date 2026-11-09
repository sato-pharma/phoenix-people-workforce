"use client";

/**
 * One tablet on the company's Headwind server, opened out beneath its row.
 *
 * Six reads, each only while the tablet is open: everything the server holds about it, what can be
 * done to it, the apps on it, where it has been, what a corporate wipe would erase, and what Phoenix
 * has done to it. They are separate requests so the fleet list stays one.
 *
 * 🔴 THE HISTORY IS "WHAT PHOENIX DID", NOT "WHAT EVER HAPPENED", AND IT SAYS SO ON THE SCREEN.
 * Headwind publishes no command history of its own, so this reads Phoenix's own audit rows. An empty
 * list therefore means nobody has acted on this tablet from here — never that nothing has happened to
 * it. Those two sentences must not look alike on a custody console, so the heading carries the
 * distinction rather than leaving a person to assume the wider one.
 *
 * 🔴 NO SECTION HERE DRAWS A CONTROL THAT CANNOT WORK — the owner's ruling of 2026-09-25, "do not
 * build a dead button". The custody actions come from the server's own catalogue, which asks this
 * particular Headwind box what it can honour; an action out of reach is printed as a sentence saying
 * what would put it in reach, in the place the button would have been. So a button on this panel is a
 * button that reaches a tablet.
 *
 * DESIGN IDENTITY is the section above it — slate borders, square corners, 9px micro-labels, wrapped
 * text with nothing truncated, and Cairo times. The shared pieces are in `headwind-panel-kit.tsx`.
 */

import { FolderOpen, Loader2, MapPin, UploadCloud, Video } from "lucide-react";
import { useRef, useState } from "react";

import {
  Busy,
  CannotDo,
  Done,
  Failed,
  MICRO_LABEL,
  PANEL_ACTION,
  PANEL_ARMED,
  Panel,
  postJson,
  readJson,
  useDisarmAfterWindow,
  useRead,
} from "@/components/devices/headwind-panel-kit";
import { TabletFleetMap } from "@/components/devices/tablet-fleet-map";
import { fixesToPoints } from "@/lib/devices/headwind/dashboard";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { DEVICE_STATUS_LABEL, type AssignableEmployee, type DeviceStatus } from "@/lib/devices/types";
import {
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

type DeviceFact = { label: string; value: string };
type DeviceDetail = { deviceNumber: string; headline: DeviceFact[]; sections: Array<{ title: string; facts: DeviceFact[] }> };
type InstalledApp = {
  packageName: string;
  name: string;
  version: string | null;
  isRemoteScreenApp: boolean;
  /** The server decides this, never the browser — see `isManagementApp` in `headwind/apps.ts`. */
  isManagementApp: boolean;
};
type AppsRead = { installed: InstalledApp[]; remoteScreenAppPresent: boolean };
type RemovalResult = { packageName: string; assetTag: string | null; message: string };
type CommandRecord = { summary: string; actor: string | null; issuedAt: string };

function FactList({ facts }: { facts: DeviceFact[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
      {facts.map((fact) => (
        <div className="flex flex-wrap items-baseline gap-x-2" key={`${fact.label}:${fact.value}`}>
          <dt className="break-words text-[11px] font-semibold text-slate-500">{fact.label}</dt>
          <dd className="break-words text-[11px] font-bold text-slate-900">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function failureText(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Custody actions — lock, lost mode, factory reset, reset the screen lock, ring, show a message.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

type ActionAvailability = {
  id: string;
  label: string;
  description: string;
  carrier: "add-on" | "phoenix-app" | "impossible";
  destructive: boolean;
  needsMessage: boolean;
  available: boolean;
  unavailableReason: string | null;
};

/**
 * 🔴 THE SAME NUMBER AS `HEADWIND_MESSAGE_LIMIT` IN `src/lib/devices/headwind/actions.ts`, AND IT IS
 * COPIED RATHER THAN IMPORTED ON PURPOSE. That module reaches `writeRequiredAuditLog`, so importing
 * one constant from it would pull the audit writer and the Supabase admin client into a browser
 * bundle. The counter here is a courtesy — the server refuses a long message whatever this says — and
 * `tests/headwind-bridge.test.ts` pins the two numbers together so they cannot drift apart silently.
 */
const MESSAGE_LIMIT = 300;

type ActionState = {
  /** The tablet this state belongs to — see the derivation in `AppsPanel` and `useRead`'s own note. */
  deviceNumber: string;
  armed: string | null;
  busy: string | null;
  notice: string | null;
  failure: string | null;
  words: Record<string, string>;
};

/**
 * 🔴 ANNOTATED, NOT `as const`, BECAUSE OF `words`. Under `as const` the empty map is typed `{}`, so
 * the `own` ternary below resolves to `Record<string, string> | {}` and every `own.words[action.id]`
 * read stops compiling. The other two pending constants in this file hold only primitives and are
 * unaffected — this one is the map.
 */
const NO_ACTION_PENDING: Omit<ActionState, "deviceNumber"> = {
  armed: null,
  busy: null,
  failure: null,
  notice: null,
  words: {},
};

function ActionsPanel({ deviceNumber, tabletName }: { deviceNumber: string; tabletName: string }) {
  const catalogue = useRead<{ actions: ActionAvailability[] }>("/api/devices/headwind/actions");
  const [state, setState] = useState<ActionState>({ deviceNumber, ...NO_ACTION_PENDING });

  // Derived during the render, never reset in an effect. An armed Factory reset belongs to ONE tablet:
  // carried across a switch, the next press would erase a different rep's tablet.
  const own = state.deviceNumber === deviceNumber ? state : { deviceNumber, ...NO_ACTION_PENDING };
  useDisarmAfterWindow(own.armed, () => setState((current) => ({ ...current, armed: null })));

  async function take(action: ActionAvailability) {
    if (action.destructive && own.armed !== action.id) {
      setState({ ...own, armed: action.id, failure: null, notice: null });
      return;
    }
    setState({ ...own, armed: null, busy: action.id, failure: null, notice: null });
    try {
      const result = await postJson<{ message: string }>("/api/devices/headwind/actions", {
        action: action.id,
        deviceNumber,
        message: own.words[action.id] ?? null,
      });
      setState({ ...own, armed: null, busy: null, failure: null, notice: result.message });
    } catch (caught: unknown) {
      setState({
        ...own,
        armed: null,
        busy: null,
        failure: failureText(caught, "Could not take that action on the tablet."),
        notice: null,
      });
    }
  }

  const actions = catalogue.data?.actions ?? [];
  const available = actions.filter((action) => action.available);
  const unavailable = actions.filter((action) => !action.available);

  return (
    <Panel title="What can be done to this tablet">
      {catalogue.loading ? <Busy what="what this server can do" /> : null}
      {catalogue.error ? <Failed message={catalogue.error} /> : null}
      {own.notice ? <Done message={own.notice} /> : null}
      {own.failure ? <Failed message={own.failure} /> : null}

      {available.length > 0 ? (
        <ul className="space-y-2">
          {available.map((action) => (
            <li className="border-b border-slate-100 pb-2 last:border-b-0 last:pb-0" key={action.id}>
              <p className="break-words text-[11px] font-bold text-slate-900">{action.label}</p>
              <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">{action.description}</p>
              {action.needsMessage ? (
                <label className="mt-1 block min-w-0">
                  <span className={`block ${MICRO_LABEL}`}>The words to show, in your own wording</span>
                  <textarea
                    className={cn(phxTextareaClassName, "mt-1")}
                    maxLength={MESSAGE_LIMIT}
                    onChange={(event) =>
                      setState({ ...own, words: { ...own.words, [action.id]: event.target.value } })
                    }
                    placeholder="This tablet belongs to Sato Pharma. Please call 0100 000 0000 to return it."
                    value={own.words[action.id] ?? ""}
                  />
                  <span className="mt-0.5 block text-[10px] font-semibold text-slate-400">
                    {(own.words[action.id] ?? "").length} of {MESSAGE_LIMIT} characters. Longer than that and it
                    runs off a small tablet&rsquo;s screen.
                  </span>
                </label>
              ) : null}
              <button
                className={`mt-1 ${own.armed === action.id ? PANEL_ARMED : PANEL_ACTION}`}
                disabled={own.busy !== null}
                onClick={() => void take(action)}
                type="button"
              >
                {own.busy === action.id ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                {/*
                  The armed label names the ACT and the TABLET, and is built from the action's own
                  label rather than from a sentence written for the one destructive action there is
                  today — a hard-coded "erase it completely" would quietly become a lie the first time
                  a second destructive action is added. What it costs is directly above it, in the
                  server's own description.
                */}
                {own.armed === action.id
                  ? `Press again to ${action.label.toLowerCase()} ${tabletName}. This cannot be undone.`
                  : action.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        🔴 NOT GREYED BUTTONS — SENTENCES. The two reasons an action can be out of reach are nothing
        alike: one says this Headwind box has not been rebuilt with the Phoenix add-on, which a rebuild
        fixes and changes nothing on any tablet; the other says Android grants the permission only to
        the tablet's own manufacturer, which nothing fixes at any price. A greyed control would read as
        "not built yet" for both. The sentences come from the server.
      */}
      {unavailable.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          <p className={MICRO_LABEL}>Not available, and why</p>
          {unavailable.map((action) => (
            <CannotDo key={action.id} label={action.label} reason={action.unavailableReason ?? ""} />
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Movements.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

type LocationFix = {
  latitude: number;
  longitude: number;
  recordedAt: string | null;
  firstRecordedAt: string | null;
  reports: number;
  batteryLevel: number | null;
  source: "check-in" | "plugin";
};
type LocationRead = {
  fixes: LocationFix[];
  pluginEnabled: boolean;
  collection: "on" | "off" | "unknown";
  note: string;
};

/**
 * When a row's position was reported. 🔴 A run of identical reports is ONE row that says so — a tablet
 * sitting indoors re-sends its last fix with every report, and fifty rows of it read as fifty sightings.
 */
function fixWhen(fix: LocationFix): string {
  if (!fix.recordedAt) return "No time given";
  if (fix.reports > 1 && fix.firstRecordedAt && fix.firstRecordedAt !== fix.recordedAt) {
    return `Same position reported ${fix.reports} times, ${cairoDateTime(fix.firstRecordedAt)} to ${cairoDateTime(fix.recordedAt)}`;
  }
  return cairoDateTime(fix.recordedAt);
}

const SOURCE_CHIP = "border border-slate-300 px-1 text-[8px] font-black uppercase tracking-[0.12em] text-slate-500";

function MovementsPanel({ deviceNumber }: { deviceNumber: string }) {
  const query = encodeURIComponent(deviceNumber);
  const [round, setRound] = useState(0);
  const movements = useRead<LocationRead>(
    `/api/devices/headwind?deviceNumber=${query}&view=locations&round=${round}`,
  );
  const [switching, setSwitching] = useState(false);
  const [switchResult, setSwitchResult] = useState<{ ok: boolean; message: string } | null>(null);

  // 🔴 A PERSON'S PRESS, NEVER A SIDE EFFECT OF READING. Opening this panel used to switch collection on
  // for the whole server from inside the read; it is now this button, CSRF-guarded and audited.
  async function switchOnHistory() {
    setSwitching(true);
    setSwitchResult(null);
    try {
      const result = await postJson<{ message: string }>("/api/devices/headwind", { action: "location-history-on" });
      setSwitchResult({ message: result.message, ok: true });
      setRound((current) => current + 1);
    } catch (caught) {
      setSwitchResult({ message: caught instanceof Error ? caught.message : "Could not switch movement history on.", ok: false });
    } finally {
      setSwitching(false);
    }
  }

  return (
    <Panel title="Where this tablet has been">
      {movements.loading ? <Busy what="the movements" /> : null}
      {movements.error ? <Failed message={movements.error} /> : null}
      {movements.data && !movements.loading && !movements.error ? (
        <div className="space-y-2">
          {/*
            🔴 THE SERVER'S OWN SENTENCE, PRINTED WHOLE. An empty history has three different meanings
            — the plugin is not on this box, it is on but this tablet has not reported since, or the
            free agent may never feed it at all — and only the server knows which. Summarising it here
            as "no movements" would turn "we do not know" into "it did not move", on the one screen
            where that difference decides whether somebody goes looking for a tablet.
          */}
          <p className="break-words text-[11px] font-semibold text-slate-500">{movements.data.note}</p>
          {movements.data.collection === "off" ? (
            <button className={PANEL_ACTION} disabled={switching} onClick={() => void switchOnHistory()} type="button">
              {switching ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <MapPin className="h-3.5 w-3.5" aria-hidden />}
              Switch on movement history for every tablet
            </button>
          ) : null}
          {switchResult ? (switchResult.ok ? <Done message={switchResult.message} /> : <Failed message={switchResult.message} />) : null}
          {/*
            The trail before the list. Each fix is a numbered stop joined in time order, so a route
            reads at a glance where the list reads as a log. The map draws only when there is a fix to
            place — the note already says what an empty history means, and an empty map frame under it
            would say it a second time in a worse way.
          */}
          {movements.data.fixes.length > 0 ? (
            <TabletFleetMap
              caption="Each numbered stop is one reported position with a time, joined oldest to newest, from one source only: the history plugin when it has positions, the check-ins otherwise. A straight line between two stops is not a road, only the two points we were told; a position with no time is listed below but not drawn."
              kind="trail"
              points={fixesToPoints(movements.data.fixes)}
              title="This tablet's trail"
            />
          ) : null}
          {movements.data.fixes.length > 0 ? (
            <ul className="space-y-1">
              {movements.data.fixes.map((fix) => (
                <li
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                  key={`${fix.source}:${fix.recordedAt ?? "unknown"}:${fix.firstRecordedAt ?? ""}:${fix.latitude},${fix.longitude}`}
                >
                  <span className={SOURCE_CHIP}>{fix.source === "check-in" ? "Check-in" : "History plugin"}</span>
                  <span className="break-words text-[11px] font-bold text-slate-900">
                    {fixWhen(fix)}
                  </span>
                  <a
                    className="inline-flex items-center gap-1 break-all text-[11px] font-semibold text-slate-600 underline"
                    href={`https://www.google.com/maps?q=${fix.latitude},${fix.longitude}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <MapPin className="h-3 w-3 shrink-0" aria-hidden />
                    {fix.latitude.toFixed(5)}, {fix.longitude.toFixed(5)}
                  </a>
                  {fix.batteryLevel !== null ? (
                    <span className="text-[11px] font-semibold text-slate-500">Battery {fix.batteryLevel}%</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <button className={PANEL_ACTION} onClick={() => setRound((current) => current + 1)} type="button">
            Read the movements again
          </button>
        </div>
      ) : null}
    </Panel>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Files — the files this tablet's rules push, plus a live file browse over RustDesk.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

type ConfigurationFile = { fileId: number | null; name: string; description: string | null; url: string | null };
type FilesRead = {
  configurationId: number | null;
  configurationName: string | null;
  files: ConfigurationFile[];
  note: string;
};
type ScreenTarget = { target: { connectUrl: string } | null; reason: string | null };

/** Open a custom-scheme link (RustDesk) without navigating the admin page away from under the person. */
function openExternal(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

type FilesState = {
  deviceNumber: string;
  round: number;
  armed: number | null;
  busy: string | null;
  uploading: boolean;
  notice: string | null;
  failure: string | null;
};

const NO_FILES_PENDING = { armed: null, busy: null, failure: null, notice: null, round: 0, uploading: false } as const;

/**
 * 🔴 "FILES ON THIS TABLET" MEANS THE FILES ON THIS TABLET'S RULES, AND THAT REACHES EVERY TABLET ON
 * THEM. Headwind keeps no per-tablet file store to read or write — a file is on a tablet because it is
 * in that tablet's configuration. So this panel is honest about it in the note and in the armed Remove,
 * which says the file leaves every tablet on these rules, not only this one. Browsing ONE tablet's real
 * storage is a RustDesk file-transfer session on the Super Admin's own computer — the button below opens
 * it; there is no `rustdesk://file-transfer` deep link, so it opens the connection and says which tab.
 */
function FilesPanel({ deviceNumber, tabletName }: { deviceNumber: string; tabletName: string }) {
  const query = encodeURIComponent(deviceNumber);
  const [state, setState] = useState<FilesState>({ deviceNumber, ...NO_FILES_PENDING });
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Derived during the render, never reset in an effect — the rule every panel here follows, so an
  // armed Remove or a half-chosen upload for one tablet never follows the panel onto another rep's.
  const own = state.deviceNumber === deviceNumber ? state : { deviceNumber, ...NO_FILES_PENDING };
  useDisarmAfterWindow(own.armed === null ? null : String(own.armed), () =>
    setState((current) => ({ ...current, armed: null })),
  );
  const files = useRead<FilesRead>(`/api/devices/headwind?deviceNumber=${query}&view=files&round=${own.round}`);
  const configurationId = files.data?.configurationId ?? null;

  async function remove(file: ConfigurationFile) {
    if (file.fileId === null || configurationId === null) return;
    if (own.armed !== file.fileId) {
      setState({ ...own, armed: file.fileId, failure: null, notice: null });
      return;
    }
    setState({ ...own, armed: null, busy: String(file.fileId), failure: null, notice: null });
    try {
      const result = await postJson<{ message: string }>("/api/devices/headwind/configurations", {
        change: "file",
        configurationId,
        fileId: file.fileId,
        remove: true,
      });
      setState({ ...own, armed: null, busy: null, failure: null, notice: result.message, round: own.round + 1 });
    } catch (caught: unknown) {
      setState({ ...own, armed: null, busy: null, failure: failureText(caught, "Could not take that file off the rules."), notice: null });
    }
  }

  async function upload(file: File) {
    if (configurationId === null) return;
    setState({ ...own, busy: null, failure: null, notice: null, uploading: true });
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("kind", "file");
      form.append("configurationId", String(configurationId));
      const response = await fetch("/api/devices/headwind/upload", { body: form, cache: "no-store", method: "POST" });
      const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
      if (!response.ok) {
        throw new Error(typeof payload?.message === "string" ? payload.message : "The server refused the file.");
      }
      if (fileInput.current) fileInput.current.value = "";
      setState({
        ...own,
        failure: null,
        notice: typeof payload?.message === "string" ? payload.message : "Sent.",
        round: own.round + 1,
        uploading: false,
      });
    } catch (caught: unknown) {
      setState({ ...own, failure: failureText(caught, "Could not send that file to the tablets."), notice: null, uploading: false });
    }
  }

  async function browseLive() {
    setState({ ...own, busy: "browse", failure: null, notice: null });
    try {
      const screen = await readJson<ScreenTarget>(`/api/devices/headwind?deviceNumber=${query}&view=screen&mode=control`);
      if (!screen.target) {
        setState({ ...own, busy: null, failure: screen.reason ?? "This tablet is not set up for a remote session yet.", notice: null });
        return;
      }
      openExternal(screen.target.connectUrl);
      setState({
        ...own,
        busy: null,
        failure: null,
        notice:
          "Opening RustDesk on your computer for a live session with this tablet. In RustDesk, use the " +
          "File Transfer tab to browse and move this tablet's own files — that is live, one tablet, and " +
          "separate from the pushed files listed above.",
      });
    } catch (caught: unknown) {
      setState({ ...own, busy: null, failure: failureText(caught, "Could not open a session with this tablet."), notice: null });
    }
  }

  return (
    <Panel title="Files on this tablet">
      {files.loading ? <Busy what="the files" /> : null}
      {files.error ? <Failed message={files.error} /> : null}
      {own.notice ? <Done message={own.notice} /> : null}
      {own.failure ? <Failed message={own.failure} /> : null}
      {files.data && !files.loading && !files.error ? (
        <div className="space-y-2">
          <p className="break-words text-[11px] font-semibold text-slate-500">{files.data.note}</p>

          {files.data.files.length > 0 ? (
            <ul className="space-y-1">
              {files.data.files.map((file) => (
                <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1" key={`${file.fileId ?? file.name}`}>
                  {file.url ? (
                    <a
                      className="break-all text-[11px] font-bold text-slate-900 underline"
                      href={file.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {file.name}
                    </a>
                  ) : (
                    <span className="break-all text-[11px] font-bold text-slate-900">{file.name}</span>
                  )}
                  {file.description ? (
                    <span className="break-words text-[11px] font-semibold text-slate-500">{file.description}</span>
                  ) : null}
                  {file.fileId !== null && configurationId !== null ? (
                    <button
                      className={own.armed === file.fileId ? PANEL_ARMED : PANEL_ACTION}
                      disabled={own.busy !== null || own.uploading}
                      onClick={() => void remove(file)}
                      type="button"
                    >
                      {own.busy === String(file.fileId) ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                      {own.armed === file.fileId
                        ? `Press again to remove ${file.name} from every tablet on these rules`
                        : "Remove"}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] font-semibold text-slate-500">No files are pushed through this tablet&rsquo;s rules yet.</p>
          )}

          {configurationId !== null ? (
            <div className="border-t border-slate-100 pt-2">
              <p className={MICRO_LABEL}>Send a file to these rules</p>
              <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
                It reaches every tablet on these rules at its next check-in, not only this one.
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <input
                  className={cn(phxFieldClassName, "max-w-xs flex-1 basis-56")}
                  disabled={own.uploading || own.busy !== null}
                  onChange={(event) => {
                    const chosen = event.target.files?.[0];
                    if (chosen) void upload(chosen);
                  }}
                  ref={fileInput}
                  type="file"
                />
                {own.uploading ? (
                  <span className="flex items-center gap-1 text-[11px] font-semibold text-slate-500">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Sending <UploadCloud className="h-3 w-3" aria-hidden />
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="border-t border-slate-100 pt-2">
            <p className={MICRO_LABEL}>Browse this tablet&rsquo;s own files, live</p>
            <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
              The list above is what the rules push to every tablet. To look at the real files on{" "}
              <span className="font-bold text-slate-900">{tabletName}</span> itself, open a RustDesk session and use its
              File Transfer tab. The session opens on your own computer; Phoenix never carries the screen or the files.
            </p>
            <button className={`mt-1 ${PANEL_ACTION}`} disabled={own.busy !== null} onClick={() => void browseLive()} type="button">
              {own.busy === "browse" ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <FolderOpen className="h-3 w-3" aria-hidden />}
              Browse this tablet&rsquo;s files live
            </button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Screen recordings — on-demand capture, filed in Phoenix. Never a live feed, never calls or messages.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

type Recording = {
  id: string;
  deviceNumber: string;
  assetTag: string | null;
  requestedByHrId: string;
  status: "requested" | "ready" | "failed" | "expired";
  requestedAt: string;
  durationRequestedS: number;
  capturedSeconds: number | null;
  sizeBytes: number | null;
  uploadedAt: string | null;
  error: string | null;
  playbackUrl: string | null;
};
type RecordingsRead = { recordings: Recording[] };
type RecordingsState = {
  deviceNumber: string;
  busy: boolean;
  failure: string | null;
  notice: string | null;
  round: number;
  durationSeconds: number;
};

const RECORDING_LENGTHS = [
  { label: "15 seconds", value: 15 },
  { label: "1 minute", value: 60 },
  { label: "3 minutes", value: 180 },
  { label: "5 minutes", value: 300 },
] as const;

const NO_RECORDING_PENDING = { busy: false, durationSeconds: 60, failure: null, notice: null, round: 0 } as const;

function formatSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function describeRecording(recording: Recording): string {
  const parts = [`asked for ${formatSeconds(recording.durationRequestedS)}`];
  if (recording.status === "requested") parts.push("waiting for the tablet");
  if (recording.status === "ready") {
    if (recording.capturedSeconds) parts.push(`${formatSeconds(recording.capturedSeconds)} captured`);
    if (recording.sizeBytes) parts.push(formatBytes(recording.sizeBytes));
  }
  if (recording.status === "expired") parts.push("the tablet never uploaded it");
  return parts.join(" · ");
}

function recordingStatusLabel(status: Recording["status"]): string {
  if (status === "ready") return "Ready";
  if (status === "requested") return "Recording…";
  if (status === "failed") return "Failed";
  return "Expired";
}

/**
 * On-demand screen recording of this one tablet. Press Record, pick a length; the tablet captures its
 * own screen and uploads the file, which appears here to play back. The capture is driven by the
 * tablet's launcher, not a live session — and calls and messages are never recorded.
 *
 * The state is derived per device the same way every panel here is, so a half-chosen length or a
 * just-started capture for one tablet never follows the panel onto another rep's.
 */
function RecordingsPanel({ deviceNumber }: { deviceNumber: string }) {
  const query = encodeURIComponent(deviceNumber);
  const [state, setState] = useState<RecordingsState>({ deviceNumber, ...NO_RECORDING_PENDING });
  const own = state.deviceNumber === deviceNumber ? state : { deviceNumber, ...NO_RECORDING_PENDING };
  const recordings = useRead<RecordingsRead>(
    `/api/devices/headwind?deviceNumber=${query}&view=recordings&round=${own.round}`,
  );

  async function startRecording() {
    setState({ ...own, busy: true, failure: null, notice: null });
    try {
      const result = await postJson<{ message: string }>("/api/devices/headwind/record", {
        deviceNumber,
        durationSeconds: own.durationSeconds,
      });
      setState({ ...own, busy: false, failure: null, notice: result.message, round: own.round + 1 });
    } catch (caught: unknown) {
      setState({ ...own, busy: false, failure: failureText(caught, "Could not start a recording on this tablet."), notice: null });
    }
  }

  return (
    <Panel title="Screen recordings">
      <div className="space-y-3">
        <p className="break-words text-[11px] font-semibold text-slate-500">
          Records this tablet&rsquo;s screen on demand and files it here &mdash; nobody needs to be watching. Calls
          and messages are never recorded. A recording appears below once the tablet has uploaded it.
        </p>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className={MICRO_LABEL}>Length</span>
            <select
              className={phxSelectClassName}
              disabled={own.busy}
              onChange={(event) => setState({ ...own, durationSeconds: Number(event.target.value) })}
              value={own.durationSeconds}
            >
              {RECORDING_LENGTHS.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <button className={PANEL_ACTION} disabled={own.busy} onClick={startRecording} type="button">
            {own.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Video className="h-3.5 w-3.5" />}
            Record this screen
          </button>
        </div>

        {own.notice ? <Done message={own.notice} /> : null}
        {own.failure ? <Failed message={own.failure} /> : null}
        {recordings.loading ? <Busy what="the recordings" /> : null}
        {recordings.error ? <Failed message={recordings.error} /> : null}

        {recordings.data && !recordings.loading && !recordings.error ? (
          recordings.data.recordings.length === 0 ? (
            <p className="text-[11px] font-semibold text-slate-500">No recordings yet.</p>
          ) : (
            <ul className="space-y-2">
              {recordings.data.recordings.map((recording) => (
                <li className="space-y-1 border-t border-slate-100 pt-2" key={recording.id}>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-[11px] font-bold text-slate-900">{cairoDateTime(recording.requestedAt)}</span>
                    <span className="text-[9px] font-bold uppercase tracking-wide text-slate-600">
                      {recordingStatusLabel(recording.status)}
                    </span>
                    <span className="break-words text-[10px] font-semibold text-slate-500">
                      {describeRecording(recording)}
                    </span>
                  </div>
                  {recording.status === "ready" && recording.playbackUrl ? (
                    <video
                      className="w-full max-w-md border border-slate-200"
                      controls
                      preload="metadata"
                      src={recording.playbackUrl}
                    />
                  ) : null}
                  {recording.status === "failed" && recording.error ? (
                    <p className="break-words text-[10px] font-semibold text-rose-600">{recording.error}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </Panel>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Corporate wipe.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

type WipeScope = { apps: string[]; folders: string[] };
type WipeState = { deviceNumber: string; armed: boolean; busy: boolean; notice: string | null; failure: string | null };

const NO_WIPE_PENDING = { armed: false, busy: false, failure: null, notice: null } as const;

/**
 * 🔴 TWO PRESSES, AND THE SECOND ONE NAMES THE CAMERA ROLL OUT LOUD. The owner chose the scope that
 * includes the camera roll over the one that spared it, which means this takes a rep's field photos
 * with it. That is the right answer for a tablet changing hands and the wrong one by accident, and
 * the rep is never prompted — the agent is the device owner, so it simply happens. So the only place
 * a mistake can be caught is here, before it is sent, which is why the armed button says what goes
 * rather than saying "confirm".
 */
function WipePanel({ deviceNumber, tabletName }: { deviceNumber: string; tabletName: string }) {
  const scope = useRead<WipeScope>("/api/devices/headwind/wipe");
  const [state, setState] = useState<WipeState>({ deviceNumber, ...NO_WIPE_PENDING });
  const own = state.deviceNumber === deviceNumber ? state : { deviceNumber, ...NO_WIPE_PENDING };
  useDisarmAfterWindow(own.armed, () => setState((current) => ({ ...current, armed: false })));

  async function wipe() {
    if (!own.armed) {
      setState({ ...own, armed: true, failure: null, notice: null });
      return;
    }
    setState({ ...own, armed: false, busy: true, failure: null, notice: null });
    try {
      const result = await postJson<{ message: string }>("/api/devices/headwind/wipe", { deviceNumber });
      setState({ ...own, armed: false, busy: false, failure: null, notice: result.message });
    } catch (caught: unknown) {
      setState({
        ...own,
        armed: false,
        busy: false,
        failure: failureText(caught, "Could not erase the company's data from that tablet."),
        notice: null,
      });
    }
  }

  const erases = scope.data ? [...scope.data.apps, ...scope.data.folders] : [];

  return (
    <Panel title="Erase the company's data from this tablet">
      {scope.loading ? <Busy what="what a wipe erases" /> : null}
      {scope.error ? <Failed message={scope.error} /> : null}
      {own.notice ? <Done message={own.notice} /> : null}
      {own.failure ? <Failed message={own.failure} /> : null}
      {scope.data && !scope.loading && !scope.error ? (
        <div className="space-y-2">
          <p className="break-words text-[11px] font-semibold text-slate-500">
            For a tablet changing hands. It clears what the company put on the tablet and leaves the tablet
            itself enrolled, managed and ready for the next person &mdash; this is not a factory reset. Nothing
            is shown to the rep.
          </p>
          <div>
            <p className={MICRO_LABEL}>What goes</p>
            <ul className="mt-1 space-y-0.5">
              {erases.map((entry) => (
                <li className="break-words text-[11px] font-bold text-slate-900" key={entry}>
                  {entry}
                </li>
              ))}
            </ul>
          </div>
          <button
            className={own.armed ? PANEL_ARMED : PANEL_ACTION}
            disabled={own.busy}
            onClick={() => void wipe()}
            type="button"
          >
            {own.busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
            {own.armed
              ? `Press again to erase ${erases.join(", ")} from ${tabletName}`
              : "Erase the company's data"}
          </button>
        </div>
      ) : null}
    </Panel>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Apps.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The apps on one tablet, each with a Remove that reaches the tablet silently.
 *
 * 🔴 REMOVAL IS TWO PRESSES, AND THE SECOND ONE SAYS THE PACKAGE OUT LOUD. The rep is never prompted
 * — the agent is the device owner, so the app simply goes — which means the only place a mistake can
 * be caught is here, before it is sent. The armed button therefore names the package rather than
 * saying "confirm", and the app list is re-read afterwards so nobody reads a stale list as proof.
 *
 * 🔴 AND "SENT" IS NOT "GONE". The server accepts the message and hands it on; whether the tablet was
 * awake to act on it shows in the list at its next check-in. The sentence shown says exactly that.
 */
type RemovalState = {
  /** The tablet this state belongs to — see the derivation below, and `useRead`'s own note. */
  deviceNumber: string;
  /** Bumped after a removal so the app list is read again; it is part of the URL `useRead` keys on. */
  round: number;
  armed: string | null;
  busy: string | null;
  notice: string | null;
  failure: string | null;
};

const NOTHING_PENDING = { armed: null, busy: null, failure: null, notice: null, round: 0 } as const;

function AppsPanel({ deviceNumber }: { deviceNumber: string }) {
  const query = encodeURIComponent(deviceNumber);
  const [state, setState] = useState<RemovalState>({ deviceNumber, ...NOTHING_PENDING });

  // 🔴 DERIVED DURING THE RENDER, NEVER RESET IN AN EFFECT — the same rule `useRead` explains, and
  // here it is not only about render counts. An armed Remove belongs to ONE tablet: carried across a
  // switch, the next press would take an app off a different rep's tablet. Keeping the tablet's number
  // inside the state means the previous tablet's armed button, notice and failure are simply not this
  // tablet's, and are not shown.
  const own = state.deviceNumber === deviceNumber ? state : { deviceNumber, ...NOTHING_PENDING };
  useDisarmAfterWindow(own.armed, () => setState((current) => ({ ...current, armed: null })));
  const apps = useRead<AppsRead>(`/api/devices/headwind?deviceNumber=${query}&view=apps&round=${own.round}`);

  async function remove(packageName: string) {
    if (own.armed !== packageName) {
      setState({ ...own, armed: packageName, failure: null, notice: null });
      return;
    }
    setState({ ...own, armed: null, busy: packageName, failure: null, notice: null });
    try {
      const result = await postJson<RemovalResult>("/api/devices/headwind/apps", { deviceNumber, packageName });
      setState({ ...own, armed: null, busy: null, failure: null, notice: result.message, round: own.round + 1 });
    } catch (caught: unknown) {
      setState({
        ...own,
        armed: null,
        busy: null,
        failure: failureText(caught, "Could not remove that app."),
        notice: null,
      });
    }
  }

  return (
    <Panel title="Apps on this tablet">
      {apps.loading ? <Busy what="the apps" /> : null}
      {apps.error ? <Failed message={apps.error} /> : null}
      {own.notice ? <Done message={own.notice} /> : null}
      {own.failure ? <Failed message={own.failure} /> : null}
      {apps.data && !apps.loading && !apps.error ? (
        apps.data.installed.length === 0 ? (
          <p className="text-[11px] font-semibold text-slate-500">
            The tablet has not reported its apps yet. The list fills in at its next check-in.
          </p>
        ) : (
          <ul className="space-y-1">
            {apps.data.installed.map((app) => (
              <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1" key={app.packageName}>
                <span className="break-words text-[11px] font-bold text-slate-900">{app.name}</span>
                {app.version ? (
                  <span className="break-words text-[11px] font-semibold text-slate-500">{app.version}</span>
                ) : null}
                {app.isRemoteScreenApp ? (
                  <span className="border border-emerald-600 px-1 text-[8px] font-black uppercase tracking-[0.12em] text-emerald-800">
                    Screen sharing
                  </span>
                ) : null}
                {app.isManagementApp ? (
                  <span
                    className="border border-slate-300 px-1 text-[8px] font-black uppercase tracking-[0.12em] text-slate-500"
                    title="This is the app that manages the tablet. Removing it would cut the tablet off from the company server for good."
                  >
                    Manages this tablet
                  </span>
                ) : (
                  <button
                    className={own.armed === app.packageName ? PANEL_ARMED : PANEL_ACTION}
                    disabled={own.busy !== null}
                    onClick={() => void remove(app.packageName)}
                    title={
                      app.isRemoteScreenApp
                        ? "Removing this ends screen sharing on this tablet until it is installed again."
                        : app.name === app.packageName
                          ? `Removes ${app.name} from the tablet. Nothing is shown to the rep.`
                          : // Two apps can share a label; the package is what tells them apart at the second press.
                            `Removes ${app.name} (${app.packageName}) from the tablet. Nothing is shown to the rep.`
                    }
                    type="button"
                  >
                    {own.busy === app.packageName ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                    {own.armed === app.packageName ? `Press again to remove ${app.name}` : "Remove"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Panel>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * The remote screen ID — the one number in the whole setup that a person has to type.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

type RemoteScreenIdState = {
  deviceNumber: string;
  value: string;
  busy: boolean;
  notice: string | null;
  failure: string | null;
};

/**
 * 🔴 THIS SECTION EXISTS BECAUSE THE HEADWIND CONSOLE CANNOT SHOW THE FIELD. The ID lives in
 * Headwind's `custom1` — deliberately, so there is no second list to keep in step — and the Community
 * console only draws its custom inputs when `settings.customPropertyName1` is named. It is `null` on
 * this server, and no screen in that console sets it, so the one number a screen session is aimed at
 * had nowhere it could be typed. It is typed here.
 */
function RemoteScreenIdPanel({
  deviceNumber,
  tabletName,
  current,
  onSaved,
}: {
  deviceNumber: string;
  tabletName: string;
  current: string | null;
  onSaved?: () => void;
}) {
  const fresh = (): RemoteScreenIdState => ({
    busy: false,
    deviceNumber,
    failure: null,
    notice: null,
    value: current ?? "",
  });
  const [state, setState] = useState<RemoteScreenIdState>(fresh);
  // Derived during the render, never reset in an effect — the same rule the other panels follow, and
  // for the same reason: a number half-typed for one tablet must not follow the panel onto another
  // rep's, where pressing Record would aim screen sessions at the wrong device.
  const own = state.deviceNumber === deviceNumber ? state : fresh();

  async function save() {
    setState({ ...own, busy: true, failure: null, notice: null });
    try {
      const result = await postJson<{ message: string; remoteScreenId: string | null }>(
        "/api/devices/headwind/remote-id",
        { deviceNumber, remoteScreenId: own.value },
      );
      setState({ ...own, busy: false, failure: null, notice: result.message, value: result.remoteScreenId ?? "" });
      onSaved?.();
    } catch (caught: unknown) {
      setState({
        ...own,
        busy: false,
        failure: failureText(caught, "Could not record the tablet's remote screen ID."),
        notice: null,
      });
    }
  }

  return (
    <Panel title="Remote screen ID">
      <p className="break-words text-[11px] font-semibold text-slate-500">
        Open RustDesk on the tablet and copy the number it shows at the top. It is what <em>View the screen</em> and{" "}
        <em>Take control</em> are aimed at, and it changes every time the tablet is re-enrolled. Leave it empty to
        clear it — better no ID than one pointing at a tablet that no longer answers.
      </p>
      {/*
        🔴 THE BOX IS CAPPED, AND THAT IS FROM LOOKING AT IT ON PRODUCTION. Left to grow it filled the
        whole panel — a 1,552px input for nine digits on a 2,124px window — which reads as a paragraph
        field and matches nothing else on the page; the server-settings inputs beside it sit in a
        two-column grid at about half the width. `basis-40` still lets it drop under the button and use
        the full width on a phone, where the cap is never reached.
      */}
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="min-w-0 max-w-xs flex-1 basis-40">
          <span className={`block ${MICRO_LABEL}`}>What RustDesk shows on the tablet</span>
          <input
            className={cn(phxFieldClassName, "mt-1")}
            inputMode="numeric"
            onChange={(event) => setState({ ...own, failure: null, notice: null, value: event.target.value })}
            placeholder="123 456 789"
            type="text"
            value={own.value}
          />
        </label>
        <button className={PANEL_ACTION} disabled={own.busy} onClick={() => void save()} type="button">
          {own.busy ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : null}
          {current ? `Change the ID of ${tabletName}` : `Record the ID of ${tabletName}`}
        </button>
      </div>
      {own.notice ? <Done message={own.notice} /> : null}
      {own.failure ? <Failed message={own.failure} /> : null}
    </Panel>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Custody — assign, or reserve for a not-yet-hired holder, and the day-one reconcile.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

type CustodyProps = {
  deviceNumber: string;
  /** The matched register device id — null while the register has not placed this tablet yet. */
  registerDeviceId: string | null;
  /**
   * The register could not be read this time, so a missing `registerDeviceId` means "not known", not
   * "not in it" — the row offers no Add to custody then, and this panel must not point at one.
   */
  registerUnreadable?: boolean;
  registerStatus: DeviceStatus | null;
  /** The live custody record — the holder's, or the reservation's. */
  assignmentId: string | null;
  holderName: string | null;
  holderJobTitle: string | null;
  /** When reserved: the typed name it is held for. */
  placeholderName: string | null;
  assignable: AssignableEmployee[];
  /** Re-read the fleet after a change, so the row and this panel catch up. */
  onChanged?: () => void;
};

/**
 * The register's status as the Device custody page says it — never the stored code. "marked repair"
 * and "marked in_stock" are what a raw status reads as on this panel. The page's own list, shared.
 */
const REGISTER_STATUS_WORDS = DEVICE_STATUS_LABEL;

type CustodyMode = null | "assign" | "reserve" | "reconcile" | "reassign";

type CustodyState = {
  deviceNumber: string;
  mode: CustodyMode;
  /** The chosen employee (assign / reconcile). */
  hrId: string;
  /** The typed placeholder name (reserve / reassign). */
  name: string;
  armedRevoke: boolean;
  busy: boolean;
  notice: string | null;
  failure: string | null;
};

const NO_CUSTODY_PENDING: Omit<CustodyState, "deviceNumber"> = {
  armedRevoke: false,
  busy: false,
  failure: null,
  hrId: "",
  mode: null,
  name: "",
  notice: null,
};

/**
 * 🔴 THE RESERVATION MODEL, NOT A SIGNED CUSTODY (owner, 2026-09-28). A reservation earmarks a tablet
 * for a name before anyone is hired; it owes nothing and freezes no value. `Reconcile` on day one is
 * the moment the real signed custody is created and the device's value is frozen onto it (البند 9).
 * All of that is enforced in the database — this panel only chooses which verb to send.
 */
function CustodyPanel(props: CustodyProps) {
  const { deviceNumber, registerDeviceId, registerStatus, assignmentId, assignable } = props;
  const [state, setState] = useState<CustodyState>({ deviceNumber, ...NO_CUSTODY_PENDING });
  // Derived during the render, never reset in an effect — the rule every panel here follows, so a
  // half-filled form for one tablet never follows onto another rep's row.
  const own = state.deviceNumber === deviceNumber ? state : { deviceNumber, ...NO_CUSTODY_PENDING };
  useDisarmAfterWindow(own.armedRevoke, () => setState((current) => ({ ...current, armedRevoke: false })));

  async function send(body: Record<string, unknown>, fallback: string) {
    // The armed Revoke is spent by this press: cleared here and on failure, as every other panel does, so
    // a failed request can never hand back a button that one press re-sends.
    setState({ ...own, armedRevoke: false, busy: true, failure: null, notice: null });
    try {
      await postJson<unknown>("/api/devices", body);
      setState({ deviceNumber, ...NO_CUSTODY_PENDING, notice: "Done." });
      props.onChanged?.();
    } catch (caught: unknown) {
      setState({ ...own, armedRevoke: false, busy: false, failure: failureText(caught, fallback) });
    }
  }

  if (!registerDeviceId) {
    return (
      <Panel title="Custody">
        <p className="text-[11px] font-semibold text-slate-500">
          {props.registerUnreadable
            ? "The custody register could not be read just now, so who holds this tablet is not known and nothing can be assigned from here. Open it again once the register reads."
            : "This tablet is not in the custody register yet. A person adds it: once the tablet has reported its serial number or IMEI, press Add to custody on its row above. Then it can be assigned or reserved from here."}
        </p>
      </Panel>
    );
  }

  const employeePicker = (verb: "assign" | "reconcile") => (
    <label className="min-w-0 max-w-xs flex-1 basis-48">
      <span className={`block ${MICRO_LABEL}`}>Employee</span>
      <select
        className={cn(phxSelectClassName, "mt-1")}
        onChange={(event) => setState({ ...own, failure: null, hrId: event.target.value })}
        value={own.hrId}
      >
        <option value="">Choose an employee…</option>
        {assignable.map((person) => (
          <option key={person.hrId} value={person.hrId}>
            {person.name}
            {person.jobTitle ? ` — ${person.jobTitle}` : ""}
          </option>
        ))}
      </select>
      <button
        className={`mt-1 ${PANEL_ACTION}`}
        disabled={own.busy || !own.hrId}
        onClick={() =>
          void send(
            verb === "assign"
              ? { action: "issue", deviceId: registerDeviceId, employeeHrId: own.hrId }
              : { action: "reconcile", assignmentId, employeeHrId: own.hrId },
            verb === "assign" ? "Could not assign the tablet." : "Could not reconcile the reservation.",
          )
        }
        type="button"
      >
        {own.busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
        {verb === "assign" ? "Sign it out to this employee" : "Hand over to this employee"}
      </button>
    </label>
  );

  const namePicker = (verb: "reserve" | "reassign") => (
    <label className="min-w-0 max-w-xs flex-1 basis-48">
      <span className={`block ${MICRO_LABEL}`}>Held for (name)</span>
      <input
        className={cn(phxFieldClassName, "mt-1")}
        onChange={(event) => setState({ ...own, failure: null, name: event.target.value })}
        placeholder="The person it is being kept for"
        type="text"
        value={own.name}
      />
      <button
        className={`mt-1 ${PANEL_ACTION}`}
        disabled={own.busy || !own.name.trim()}
        onClick={() =>
          void send(
            verb === "reserve"
              ? { action: "reserve", deviceId: registerDeviceId, placeholderName: own.name }
              : { action: "reassign_placeholder", assignmentId, newName: own.name },
            verb === "reserve" ? "Could not reserve the tablet." : "Could not reassign the reservation.",
          )
        }
        type="button"
      >
        {own.busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
        {verb === "reserve" ? "Reserve it for this name" : "Reassign to this name"}
      </button>
    </label>
  );

  return (
    <Panel title="Custody">
      {own.notice ? <Done message={own.notice} /> : null}
      {own.failure ? <Failed message={own.failure} /> : null}

      {registerStatus === "in_stock" ? (
        <div className="space-y-2">
          <p className="break-words text-[11px] font-semibold text-slate-500">
            In stock. Sign it out to someone here now, or reserve it for a name until they start.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className={PANEL_ACTION} disabled={own.busy} onClick={() => setState({ ...own, mode: own.mode === "assign" ? null : "assign", failure: null, notice: null })} type="button">
              Assign to an employee
            </button>
            <button className={PANEL_ACTION} disabled={own.busy} onClick={() => setState({ ...own, mode: own.mode === "reserve" ? null : "reserve", failure: null, notice: null })} type="button">
              Reserve for a name
            </button>
          </div>
          {own.mode === "assign" ? <div className="flex flex-wrap items-end gap-2">{employeePicker("assign")}</div> : null}
          {own.mode === "reserve" ? <div className="flex flex-wrap items-end gap-2">{namePicker("reserve")}</div> : null}
        </div>
      ) : null}

      {registerStatus === "reserved" ? (
        <div className="space-y-2">
          <p className="break-words text-[11px] font-bold text-slate-900">
            Reserved for {props.placeholderName ?? "someone"}
          </p>
          <p className="break-words text-[11px] font-semibold text-slate-500">
            Nobody has signed for it yet. On day one, reconcile it to the hired employee — that creates the
            signed custody and freezes the value.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className={PANEL_ACTION} disabled={own.busy} onClick={() => setState({ ...own, mode: own.mode === "reconcile" ? null : "reconcile", failure: null, notice: null })} type="button">
              Reconcile to an employee
            </button>
            <button className={PANEL_ACTION} disabled={own.busy} onClick={() => setState({ ...own, mode: own.mode === "reassign" ? null : "reassign", failure: null, notice: null })} type="button">
              Reassign to a different name
            </button>
            <button
              className={own.armedRevoke ? PANEL_ARMED : PANEL_ACTION}
              disabled={own.busy}
              onClick={() =>
                own.armedRevoke
                  ? void send({ action: "revoke", assignmentId }, "Could not revoke the reservation.")
                  : setState({ ...own, armedRevoke: true, failure: null, notice: null })
              }
              type="button"
            >
              {own.busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
              {own.armedRevoke ? "Press again to cancel the reservation" : "Revoke"}
            </button>
          </div>
          {own.mode === "reconcile" ? <div className="flex flex-wrap items-end gap-2">{employeePicker("reconcile")}</div> : null}
          {own.mode === "reassign" ? <div className="flex flex-wrap items-end gap-2">{namePicker("reassign")}</div> : null}
        </div>
      ) : null}

      {registerStatus === "assigned" ? (
        <p className="break-words text-[11px] font-semibold text-slate-500">
          Signed out to{" "}
          <span className="font-bold text-slate-900">{props.holderName ?? "someone"}</span>
          {props.holderJobTitle ? ` (${props.holderJobTitle})` : ""}. Record its return on the Device custody page.
        </p>
      ) : null}

      {registerStatus && !["in_stock", "reserved", "assigned"].includes(registerStatus) ? (
        <p className="break-words text-[11px] font-semibold text-slate-500">
          This tablet is marked <span className="font-bold text-slate-900">{REGISTER_STATUS_WORDS[registerStatus]}</span>{" "}
          in the register, so it cannot be assigned or reserved until that changes on the Device custody page.
        </p>
      ) : null}
    </Panel>
  );
}

export function HeadwindTabletPanel({
  deviceNumber,
  tabletName = deviceNumber,
  remoteScreenId = null,
  onRemoteScreenIdSaved,
  custody,
  onCustodyChanged,
}: {
  deviceNumber: string;
  /**
   * What a person calls this tablet — its asset tag where the register knows it. Every armed sentence
   * names the tablet with this, so "Press again to factory reset PHX-TAB-0008" names the tablet on its
   * label, not Headwind's device number.
   */
  tabletName?: string;
  remoteScreenId?: string | null;
  onRemoteScreenIdSaved?: () => void;
  custody?: Omit<CustodyProps, "deviceNumber" | "onChanged">;
  onCustodyChanged?: () => void;
}) {
  const query = encodeURIComponent(deviceNumber);
  const detail = useRead<DeviceDetail>(`/api/devices/headwind?deviceNumber=${query}&view=detail`);
  const history = useRead<{ commands: CommandRecord[]; more: boolean }>(
    `/api/devices/headwind?deviceNumber=${query}&view=history`,
  );

  return (
    <div className="mt-3 space-y-3">
      <Panel title="What the company server holds about this tablet">
        {detail.loading ? <Busy what="the tablet" /> : null}
        {detail.error ? <Failed message={detail.error} /> : null}
        {detail.data && !detail.loading && !detail.error ? (
          detail.data.headline.length === 0 && detail.data.sections.length === 0 ? (
            <p className="text-[11px] font-semibold text-slate-500">
              The tablet has not reported anything about itself yet. It fills in at its next check-in.
            </p>
          ) : (
            <div className="space-y-3">
              {detail.data.headline.length > 0 ? <FactList facts={detail.data.headline} /> : null}
              {detail.data.sections.map((section) => (
                <div className="border-t border-slate-100 pt-2" key={section.title}>
                  <p className={MICRO_LABEL}>{section.title}</p>
                  <div className="mt-1">
                    <FactList facts={section.facts} />
                  </div>
                </div>
              ))}
            </div>
          )
        ) : null}
      </Panel>

      {custody ? <CustodyPanel deviceNumber={deviceNumber} {...custody} onChanged={onCustodyChanged} /> : null}

      <RemoteScreenIdPanel
        current={remoteScreenId}
        deviceNumber={deviceNumber}
        onSaved={onRemoteScreenIdSaved}
        tabletName={tabletName}
      />

      <ActionsPanel deviceNumber={deviceNumber} tabletName={tabletName} />

      <AppsPanel deviceNumber={deviceNumber} />

      <MovementsPanel deviceNumber={deviceNumber} />

      <FilesPanel deviceNumber={deviceNumber} tabletName={tabletName} />

      <RecordingsPanel deviceNumber={deviceNumber} />

      <WipePanel deviceNumber={deviceNumber} tabletName={tabletName} />

      <Panel title="What has been done to this tablet from Phoenix">
        {history.loading ? <Busy what="the history" /> : null}
        {history.error ? <Failed message={history.error} /> : null}
        {history.data && !history.loading && !history.error ? (
          history.data.commands.length === 0 ? (
            <p className="text-[11px] font-semibold text-slate-500">
              Nothing has been done to this tablet from Phoenix yet. Actions taken in the company server&rsquo;s own
              console are not listed here — this is Phoenix&rsquo;s own record.
            </p>
          ) : (
            <div className="space-y-1.5">
              <ul className="space-y-1">
                {history.data.commands.map((record) => (
                  <li className="flex flex-wrap items-baseline gap-x-2" key={`${record.issuedAt}:${record.summary}`}>
                    <span className="break-words text-[11px] font-bold text-slate-900">{record.summary}</span>
                    <span className="break-words text-[11px] font-semibold text-slate-500">
                      {cairoDateTime(record.issuedAt)}
                      {record.actor ? ` · ${record.actor}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {/* Fifty is where the list stops, not where the history does — said, so it never reads as all. */}
              {history.data.more ? (
                <p className="break-words text-[11px] font-semibold text-slate-500">
                  These are the latest {history.data.commands.length} actions. Older ones are not listed here.
                </p>
              ) : null}
            </div>
          )
        ) : null}
      </Panel>
    </div>
  );
}
