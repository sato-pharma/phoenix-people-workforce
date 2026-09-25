"use client";

/**
 * One tablet on the company's Headwind server, opened out beneath its row.
 *
 * Three reads, each only while the tablet is open: everything the server holds about it, the apps on
 * it, and what Phoenix has done to it. They are separate requests so the fleet list stays one.
 *
 * 🔴 THE HISTORY IS "WHAT PHOENIX DID", NOT "WHAT EVER HAPPENED", AND IT SAYS SO ON THE SCREEN.
 * Headwind publishes no command history of its own, so this reads Phoenix's own audit rows. An empty
 * list therefore means nobody has acted on this tablet from here — never that nothing has happened to
 * it. Those two sentences must not look alike on a custody console, so the heading carries the
 * distinction rather than leaving a person to assume the wider one.
 *
 * DESIGN IDENTITY is the section above it — slate borders, square corners, 9px micro-labels, wrapped
 * text with nothing truncated, and Cairo times.
 */

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { cairoDateTime } from "@/lib/format/cairo-datetime";

const MICRO_LABEL = "text-[9px] font-black uppercase tracking-[0.14em] text-slate-500";
// Self-contained class strings, never a base constant with a colour appended: there is no
// tailwind-merge in these components, so two competing border colours would be decided by stylesheet
// source order rather than by the className. Same rule as `headwind-fleet.tsx`.
// `max-w-full break-all text-left` is not decoration: the armed button's label carries a package name,
// which is one unbreakable word, and at 375px a long one would push the row wider than the screen.
// Wrapping wins over shrinking type — the fits-the-screen rule.
const REMOVE_ACTION =
  "inline-flex max-w-full items-center gap-1.5 break-all border border-slate-300 px-2 py-0.5 text-left text-[10px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50";
const REMOVE_ARMED =
  "inline-flex max-w-full items-center gap-1.5 break-all border border-rose-700 bg-rose-700 px-2 py-0.5 text-left text-[10px] font-semibold text-white transition hover:bg-rose-800 disabled:opacity-50";

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

async function removeApp(deviceNumber: string, packageName: string): Promise<RemovalResult> {
  const response = await fetch("/api/devices/headwind/apps", {
    body: JSON.stringify({ deviceNumber, packageName }),
    cache: "no-store",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const failure = (payload ?? {}) as { message?: unknown };
    throw new Error(
      typeof failure.message === "string" && failure.message
        ? failure.message
        : "The server answered with an error and no explanation.",
    );
  }
  return payload as RemovalResult;
}
type CommandRecord = { summary: string; actor: string | null; issuedAt: string };

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const failure = (payload ?? {}) as { message?: unknown };
    throw new Error(
      typeof failure.message === "string" && failure.message
        ? failure.message
        : "The server answered with an error and no explanation.",
    );
  }
  return payload as T;
}

/**
 * One read of one URL, with its answer kept beside the URL it belongs to.
 *
 * 🔴 THE URL IS PART OF THE STATE ON PURPOSE, AND THAT IS WHAT KEEPS "LOADING" OUT OF THE EFFECT.
 * The obvious shape — three `useState`s and a `setLoading(true)` at the top of the effect — sets
 * state synchronously while the effect runs, which cascades a second render every time the tablet
 * changes (and `react-hooks/set-state-in-effect` refuses it). Storing the answer together with the
 * URL it answers means the switch to "loading" is DERIVED during the render that changed the URL:
 * an answer whose URL is no longer the one being asked about is simply not shown. So a stale
 * tablet's facts can never appear under a different tablet's heading, which on a custody console
 * matters more than the render count does.
 */
type ReadState<T> = { url: string; data: T | null; error: string | null; answered: boolean };

function useRead<T>(url: string): { data: T | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<ReadState<T>>({ answered: false, data: null, error: null, url });

  useEffect(() => {
    let current = true;
    readJson<T>(url)
      .then((result) => {
        if (current) setState({ answered: true, data: result, error: null, url });
      })
      .catch((caught: unknown) => {
        if (current) {
          setState({
            answered: true,
            data: null,
            error: caught instanceof Error && caught.message ? caught.message : "Could not read this.",
            url,
          });
        }
      });
    return () => {
      current = false;
    };
  }, [url]);

  const settled = state.answered && state.url === url;
  return { data: settled ? state.data : null, error: settled ? state.error : null, loading: !settled };
}

function Panel({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div className="border border-slate-200 bg-white px-4 py-3">
      <p className={MICRO_LABEL}>{title}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Busy({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-2 text-[11px] font-semibold text-slate-500">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Reading {what}…
    </p>
  );
}

function Failed({ message }: { message: string }) {
  return <p className="break-words text-[11px] font-bold text-rose-700">{message}</p>;
}

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

  // 🔴 DERIVED DURING THE RENDER, NEVER RESET IN AN EFFECT — the same rule `useRead` above explains,
  // and here it is not only about render counts. An armed Remove belongs to ONE tablet: carried
  // across a switch, the next press would take an app off a different rep's tablet. Keeping the
  // tablet's number inside the state means the previous tablet's armed button, notice and failure are
  // simply not this tablet's, and are not shown.
  const own = state.deviceNumber === deviceNumber ? state : { deviceNumber, ...NOTHING_PENDING };
  const apps = useRead<AppsRead>(`/api/devices/headwind?deviceNumber=${query}&view=apps&round=${own.round}`);

  async function remove(packageName: string) {
    if (own.armed !== packageName) {
      setState({ ...own, armed: packageName, failure: null, notice: null });
      return;
    }
    setState({ ...own, armed: null, busy: packageName, failure: null, notice: null });
    try {
      const result = await removeApp(deviceNumber, packageName);
      setState({ ...own, armed: null, busy: null, failure: null, notice: result.message, round: own.round + 1 });
    } catch (caught: unknown) {
      setState({
        ...own,
        armed: null,
        busy: null,
        failure: caught instanceof Error && caught.message ? caught.message : "Could not remove that app.",
        notice: null,
      });
    }
  }

  return (
    <Panel title="Apps on this tablet">
      {apps.loading ? <Busy what="the apps" /> : null}
      {apps.error ? <Failed message={apps.error} /> : null}
      {own.notice ? <p className="break-words text-[11px] font-bold text-emerald-800">{own.notice}</p> : null}
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
                    className={own.armed === app.packageName ? REMOVE_ARMED : REMOVE_ACTION}
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

      <AppsPanel deviceNumber={deviceNumber} />

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
