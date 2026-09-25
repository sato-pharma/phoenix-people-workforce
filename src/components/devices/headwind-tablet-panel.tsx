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

import { Loader2, MapPin } from "lucide-react";
import { useState } from "react";

import {
  Busy,
  CannotDo,
  Done,
  Failed,
  MICRO_LABEL,
  PANEL_ACTION,
  PANEL_ARMED,
  PANEL_INPUT,
  Panel,
  postJson,
  useRead,
} from "@/components/devices/headwind-panel-kit";
import { cairoDateTime } from "@/lib/format/cairo-datetime";

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

function ActionsPanel({ deviceNumber }: { deviceNumber: string }) {
  const catalogue = useRead<{ actions: ActionAvailability[] }>("/api/devices/headwind/actions");
  const [state, setState] = useState<ActionState>({ deviceNumber, ...NO_ACTION_PENDING });

  // Derived during the render, never reset in an effect. An armed Factory reset belongs to ONE tablet:
  // carried across a switch, the next press would erase a different rep's tablet.
  const own = state.deviceNumber === deviceNumber ? state : { deviceNumber, ...NO_ACTION_PENDING };

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
                    className={`mt-1 h-16 ${PANEL_INPUT}`}
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
                  ? `Press again to ${action.label.toLowerCase()} ${deviceNumber}. This cannot be undone.`
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
  batteryLevel: number | null;
  source: "check-in" | "plugin";
};
type LocationRead = { fixes: LocationFix[]; pluginEnabled: boolean; note: string };

const SOURCE_CHIP = "border border-slate-300 px-1 text-[8px] font-black uppercase tracking-[0.12em] text-slate-500";

function MovementsPanel({ deviceNumber }: { deviceNumber: string }) {
  const query = encodeURIComponent(deviceNumber);
  const [round, setRound] = useState(0);
  const movements = useRead<LocationRead>(
    `/api/devices/headwind?deviceNumber=${query}&view=locations&round=${round}`,
  );

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
          {movements.data.fixes.length > 0 ? (
            <ul className="space-y-1">
              {movements.data.fixes.map((fix) => (
                <li
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                  key={`${fix.source}:${fix.recordedAt ?? "unknown"}:${fix.latitude},${fix.longitude}`}
                >
                  <span className={SOURCE_CHIP}>{fix.source === "check-in" ? "Check-in" : "History plugin"}</span>
                  <span className="break-words text-[11px] font-bold text-slate-900">
                    {fix.recordedAt ? cairoDateTime(fix.recordedAt) : "No time given"}
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
function WipePanel({ deviceNumber }: { deviceNumber: string }) {
  const scope = useRead<WipeScope>("/api/devices/headwind/wipe");
  const [state, setState] = useState<WipeState>({ deviceNumber, ...NO_WIPE_PENDING });
  const own = state.deviceNumber === deviceNumber ? state : { deviceNumber, ...NO_WIPE_PENDING };

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
              ? `Press again to erase ${erases.join(", ")} from ${deviceNumber}`
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
                        : `Removes ${app.packageName} from the tablet. Nothing is shown to the rep.`
                    }
                    type="button"
                  >
                    {own.busy === app.packageName ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                    {own.armed === app.packageName ? `Press again to remove ${app.packageName}` : "Remove"}
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

export function HeadwindTabletPanel({ deviceNumber }: { deviceNumber: string }) {
  const query = encodeURIComponent(deviceNumber);
  const detail = useRead<DeviceDetail>(`/api/devices/headwind?deviceNumber=${query}&view=detail`);
  const history = useRead<{ commands: CommandRecord[] }>(`/api/devices/headwind?deviceNumber=${query}&view=history`);

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

      <ActionsPanel deviceNumber={deviceNumber} />

      <AppsPanel deviceNumber={deviceNumber} />

      <MovementsPanel deviceNumber={deviceNumber} />

      <WipePanel deviceNumber={deviceNumber} />

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
          )
        ) : null}
      </Panel>
    </div>
  );
}
