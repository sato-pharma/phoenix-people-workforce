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

type DeviceFact = { label: string; value: string };
type DeviceDetail = { deviceNumber: string; headline: DeviceFact[]; sections: Array<{ title: string; facts: DeviceFact[] }> };
type InstalledApp = { packageName: string; name: string; version: string | null; isRemoteScreenApp: boolean };
type AppsRead = { installed: InstalledApp[]; remoteScreenAppPresent: boolean };
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

export function HeadwindTabletPanel({ deviceNumber }: { deviceNumber: string }) {
  const query = encodeURIComponent(deviceNumber);
  const detail = useRead<DeviceDetail>(`/api/devices/headwind?deviceNumber=${query}&view=detail`);
  const apps = useRead<AppsRead>(`/api/devices/headwind?deviceNumber=${query}&view=apps`);
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

      <Panel title="Apps on this tablet">
        {apps.loading ? <Busy what="the apps" /> : null}
        {apps.error ? <Failed message={apps.error} /> : null}
        {apps.data && !apps.loading && !apps.error ? (
          apps.data.installed.length === 0 ? (
            <p className="text-[11px] font-semibold text-slate-500">
              The tablet has not reported its apps yet. The list fills in at its next check-in.
            </p>
          ) : (
            <ul className="space-y-1">
              {apps.data.installed.map((app) => (
                <li className="flex flex-wrap items-baseline gap-x-2" key={app.packageName}>
                  <span className="break-words text-[11px] font-bold text-slate-900">{app.name}</span>
                  {app.version ? (
                    <span className="break-words text-[11px] font-semibold text-slate-500">{app.version}</span>
                  ) : null}
                  {app.isRemoteScreenApp ? (
                    <span className="border border-emerald-600 px-1 text-[8px] font-black uppercase tracking-[0.12em] text-emerald-800">
                      Screen sharing
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </Panel>

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
