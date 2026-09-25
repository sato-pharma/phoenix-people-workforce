"use client";

/**
 * One tablet, opened up — everything ManageEngine holds about it, the apps on it, and what has been
 * asked of it, inside Phoenix.
 *
 * WHY IT IS A PANEL AND NOT A PAGE. The fleet table answers "which tablets and who holds them"; this
 * answers "what is going on with THIS one". Keeping it under the row means the answer arrives without
 * losing the list, and a tablet in lost mode stays visible at the top while its detail is read.
 *
 * EACH SECTION FETCHES ITSELF, ONCE, WHEN THE PANEL IS OPENED. Four reads reach ManageEngine —
 * detail, the rules it carries, apps, command history — and a tablet that has not been opened costs
 * nothing. A section that fails says so in its own box and leaves the others working: ManageEngine
 * answers these endpoints independently and one being unavailable (a remote-control add-on, say) is
 * not a reason to blank the tablet.
 *
 * IT FITS THE SCREEN (AGENTS.md §4). Facts are a wrapping grid, not a table, so nothing has to be
 * shrunk or scrolled sideways at 375px; every value wraps and nothing truncates. Corners are square,
 * labels are the page's 9px micro-labels, and times are Cairo local.
 */

import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { cairoDateTime } from "@/lib/format/cairo-datetime";

const MICRO_LABEL = "text-[9px] font-black uppercase tracking-[0.14em] text-slate-500";
const ACTION_BUTTON =
  "inline-flex items-center gap-1.5 border border-slate-300 px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50";

type DeviceFact = { label: string; value: string };
type DeviceDetail = { deviceId: string; headline: DeviceFact[]; sections: { title: string; facts: DeviceFact[] }[] };
type TabletApp = {
  appId: string;
  name: string;
  identifier: string | null;
  version: string | null;
  releaseLabelId: string | null;
  releaseLabelName: string | null;
  managed: boolean;
};
type AppsState = { installed: TabletApp[]; available: TabletApp[]; repositoryError: boolean };
type CommandRecord = { commandId: string | null; name: string; status: string | null; remarks: string | null; issuedAt: string | null };
type TabletProfile = {
  profileId: string;
  name: string;
  description: string | null;
  /** What the rules cover, in words — "Screen lock", "What the tablet may do". */
  payloads: string[];
  /** Only on rules the tablet is carrying: ManageEngine's own word on whether it took them. */
  status?: string | null;
  appliedAt?: string | null;
};
type ProfileState = { applied: TabletProfile[]; available: TabletProfile[]; catalogueError: boolean };

async function readJson<T>(url: string, body?: unknown): Promise<T> {
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
    const failure = (payload ?? {}) as { message?: unknown };
    throw new Error(
      typeof failure.message === "string" && failure.message
        ? failure.message
        : "The server answered with an error and no explanation.",
    );
  }
  return payload as T;
}

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

/** A value that is an ISO instant is shown in Cairo time; anything else is shown as it came. */
function factValue(value: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? cairoDateTime(value) : value;
}

function SectionShell({
  title,
  loading,
  error,
  children,
}: {
  title: string;
  loading: boolean;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="border border-slate-200 bg-white px-3 py-3">
      <p className={MICRO_LABEL}>{title}</p>
      {loading ? (
        <p className="mt-2 flex items-center gap-2 text-[11px] font-semibold text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Reading from ManageEngine…
        </p>
      ) : null}
      {error ? <p className="mt-2 break-words text-[11px] font-bold text-rose-700">{error}</p> : null}
      {!loading && !error ? children : null}
    </div>
  );
}

function FactGrid({ facts }: { facts: DeviceFact[] }) {
  return (
    <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
      {facts.map((fact) => (
        <div className="min-w-0" key={`${fact.label}:${fact.value}`}>
          <dt className={MICRO_LABEL}>{fact.label}</dt>
          <dd className="break-words text-[12px] font-bold text-slate-900">{factValue(fact.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailSection({ deviceId }: { deviceId: string }) {
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Every setState lands inside the promise's callbacks, which is what lets the first read run from
  // an effect: an async loader called straight from an effect body trips
  // react-hooks/set-state-in-effect. RepTabletsConsole, on this same page, solves it the same way.
  const load = useCallback(
    (isCurrent: () => boolean) =>
      readJson<DeviceDetail>(`/api/devices/manageengine?deviceId=${encodeURIComponent(deviceId)}&view=detail`)
        .then((result) => {
          if (isCurrent()) setDetail(result);
        })
        .catch((caught: unknown) => {
          if (isCurrent()) setError(messageOf(caught, "Could not read this tablet's details."));
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        }),
    [deviceId],
  );

  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);

  const empty = detail !== null && detail.headline.length === 0 && detail.sections.length === 0;

  return (
    <SectionShell error={error} loading={loading} title="What the tablet reports">
      {empty ? (
        <p className="mt-2 text-[11px] font-semibold text-slate-500">
          ManageEngine holds no details for this tablet yet. Press “Report in now” and open it again.
        </p>
      ) : null}
      {detail && detail.headline.length > 0 ? <FactGrid facts={detail.headline} /> : null}
      {detail?.sections.map((section) => (
        <div className="mt-3 border-t border-slate-100 pt-2" key={section.title}>
          <p className={MICRO_LABEL}>{section.title}</p>
          <FactGrid facts={section.facts} />
        </div>
      ))}
    </SectionShell>
  );
}

function AppsSection({ deviceId }: { deviceId: string }) {
  const [state, setState] = useState<AppsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chosen, setChosen] = useState("");

  // A promise chain, not an async body — see DetailSection above.
  const load = useCallback(
    (isCurrent: () => boolean) =>
      readJson<AppsState>(`/api/devices/manageengine?deviceId=${encodeURIComponent(deviceId)}&view=apps`)
        .then((result) => {
          if (!isCurrent()) return;
          setState(result);
          setError(null);
        })
        .catch((caught: unknown) => {
          if (isCurrent()) setError(messageOf(caught, "Could not read the apps on this tablet."));
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        }),
    [deviceId],
  );

  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);

  const change = useCallback(
    async (body: Record<string, unknown>, key: string) => {
      setBusy(key);
      setNotice(null);
      try {
        const result = await readJson<{ message: string }>("/api/devices/manageengine/apps", { deviceId, ...body });
        setNotice(result.message);
        await load(() => true);
      } catch (caught) {
        setError(messageOf(caught, "Could not change the apps on this tablet."));
      } finally {
        setBusy(null);
      }
    },
    [deviceId, load],
  );

  const available = state?.available ?? [];
  const pick = available.find((app) => app.appId === chosen) ?? null;

  return (
    <SectionShell error={error} loading={loading} title="Apps on this tablet">
      <div className="mt-2 space-y-2">
        {(state?.installed ?? []).length === 0 ? (
          <p className="text-[11px] font-semibold text-slate-500">
            ManageEngine lists no apps for this tablet yet. Ask it to report in and open this again.
          </p>
        ) : null}
        {(state?.installed ?? []).map((app) => (
          <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-2" key={app.appId}>
            <div className="min-w-0">
              <p className="break-words text-[12px] font-bold text-slate-900">{app.name}</p>
              <p className="break-words text-[11px] font-semibold text-slate-500" dir="ltr">
                {[app.identifier, app.version ? `Version ${app.version}` : null, app.managed ? "Sent by the company" : "Installed by the rep"]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            {app.managed ? (
              <button
                className={ACTION_BUTTON}
                disabled={busy !== null}
                onClick={() => void change({ appId: app.appId, appName: app.name, change: "REMOVE" }, `remove:${app.appId}`)}
                type="button"
              >
                {busy === `remove:${app.appId}` ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                )}
                Remove
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {state?.repositoryError ? (
        <p className="mt-2 break-words text-[11px] font-bold text-amber-700">
          The company app repository could not be read, so there is nothing to send from here yet.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">
        <label className="min-w-0 flex-1">
          <span className={MICRO_LABEL}>Send an app to this tablet</span>
          <select
            className="mt-1 w-full min-w-0 border border-slate-300 bg-white px-2 py-1.5 text-[12px] font-semibold text-slate-900"
            disabled={available.length === 0 || busy !== null}
            onChange={(event) => setChosen(event.target.value)}
            value={chosen}
          >
            <option value="">
              {available.length === 0 ? "Every app in the company repository is already on it" : "Choose an app"}
            </option>
            {available.map((app) => (
              <option key={app.appId} value={app.appId}>
                {app.name}
                {app.version ? ` — version ${app.version}` : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          className={ACTION_BUTTON}
          disabled={pick === null || busy !== null}
          onClick={() =>
            pick
              ? void change(
                  { appId: pick.appId, appName: pick.name, change: "INSTALL", releaseLabelId: pick.releaseLabelId },
                  `install:${pick.appId}`,
                )
              : undefined
          }
          type="button"
        >
          {busy?.startsWith("install:") ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          Install it
        </button>
        <button
          className={ACTION_BUTTON}
          disabled={busy !== null}
          onClick={() => void change({ change: "REFRESH" }, "refresh")}
          type="button"
        >
          {busy === "refresh" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          )}
          Ask for its app list
        </button>
      </div>

      {notice ? <p className="mt-2 break-words text-[11px] font-bold text-emerald-800">{notice}</p> : null}
    </SectionShell>
  );
}

/**
 * The rules this tablet is carrying — ManageEngine's profiles, the vendor's half of what Google's
 * policy did.
 *
 * WHAT IS ON THE TABLET, AND WHAT ELSE IT COULD BE PUT ON. The rules themselves are authored in
 * ManageEngine's console — Phoenix never writes a profile's contents, because their REST API does
 * not document the Android restriction keys and a guessed key would publish a profile that restricts
 * nothing while this screen says the tablet is locked down. What Phoenix drives is WHICH tablet
 * carries WHICH of the company's rule sets, and both directions are audited by asset tag.
 */
function RulesSection({ deviceId }: { deviceId: string }) {
  const [state, setState] = useState<ProfileState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chosen, setChosen] = useState("");

  // A promise chain, not an async body — see DetailSection above.
  const load = useCallback(
    (isCurrent: () => boolean) =>
      readJson<ProfileState>(`/api/devices/manageengine/profiles?deviceId=${encodeURIComponent(deviceId)}`)
        .then((result) => {
          if (!isCurrent()) return;
          setState(result);
          setError(null);
        })
        .catch((caught: unknown) => {
          if (isCurrent()) setError(messageOf(caught, "Could not read the rules on this tablet."));
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        }),
    [deviceId],
  );

  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);

  const change = useCallback(
    async (body: Record<string, unknown>, key: string) => {
      setBusy(key);
      setNotice(null);
      try {
        const result = await readJson<{ message: string }>("/api/devices/manageengine/profiles", { deviceId, ...body });
        setNotice(result.message);
        await load(() => true);
      } catch (caught) {
        setError(messageOf(caught, "Could not change the rules on this tablet."));
      } finally {
        setBusy(null);
      }
    },
    [deviceId, load],
  );

  const available = state?.available ?? [];
  const pick = available.find((profile) => profile.profileId === chosen) ?? null;

  return (
    <SectionShell error={error} loading={loading} title="What this tablet is allowed to do">
      <div className="mt-2 space-y-2">
        {(state?.applied ?? []).length === 0 ? (
          <p className="text-[11px] font-semibold text-slate-500">
            This tablet carries none of the company&apos;s rule sets — it is running on whatever the enrollment left on
            it. Put one on below.
          </p>
        ) : null}
        {(state?.applied ?? []).map((profile) => (
          <div
            className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-2"
            key={profile.profileId}
          >
            <div className="min-w-0">
              <p className="break-words text-[12px] font-bold text-slate-900">{profile.name}</p>
              <p className="break-words text-[11px] font-semibold text-slate-500">
                {[
                  profile.payloads.join(" · ") || null,
                  profile.status,
                  profile.appliedAt ? cairoDateTime(profile.appliedAt) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {profile.description ? (
                <p className="break-words text-[11px] font-semibold text-slate-500">{profile.description}</p>
              ) : null}
            </div>
            <button
              className={ACTION_BUTTON}
              disabled={busy !== null}
              onClick={() => void change({ change: "REMOVE", profileId: profile.profileId }, `remove:${profile.profileId}`)}
              type="button"
            >
              {busy === `remove:${profile.profileId}` ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              )}
              Take off
            </button>
          </div>
        ))}
      </div>

      {state?.catalogueError ? (
        <p className="mt-2 break-words text-[11px] font-bold text-amber-700">
          The company&apos;s rule sets could not be read, so there is nothing to put on from here yet.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">
        <label className="min-w-0 flex-1">
          <span className={MICRO_LABEL}>Put a rule set on this tablet</span>
          <select
            className="mt-1 w-full min-w-0 border border-slate-300 bg-white px-2 py-1.5 text-[12px] font-semibold text-slate-900"
            disabled={available.length === 0 || busy !== null}
            onChange={(event) => setChosen(event.target.value)}
            value={chosen}
          >
            <option value="">
              {available.length === 0
                ? "Every rule set the company has is already on it"
                : "Choose a rule set"}
            </option>
            {available.map((profile) => (
              <option key={profile.profileId} value={profile.profileId}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className={ACTION_BUTTON}
          disabled={pick === null || busy !== null}
          onClick={() => (pick ? void change({ change: "APPLY", profileId: pick.profileId }, `apply:${pick.profileId}`) : undefined)}
          type="button"
        >
          {busy?.startsWith("apply:") ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          Put it on
        </button>
      </div>

      {notice ? <p className="mt-2 break-words text-[11px] font-bold text-emerald-800">{notice}</p> : null}
    </SectionShell>
  );
}

function HistorySection({ deviceId }: { deviceId: string }) {
  const [commands, setCommands] = useState<CommandRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A promise chain, not an async body — see DetailSection above.
  const load = useCallback(
    (isCurrent: () => boolean) =>
      readJson<{ commands: CommandRecord[] }>(
        `/api/devices/manageengine?deviceId=${encodeURIComponent(deviceId)}&view=history`,
      )
        .then((result) => {
          if (isCurrent()) setCommands(result.commands ?? []);
        })
        .catch((caught: unknown) => {
          if (isCurrent()) setError(messageOf(caught, "Could not read what has been asked of this tablet."));
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        }),
    [deviceId],
  );

  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);

  return (
    <SectionShell error={error} loading={loading} title="What has been asked of it">
      {commands.length === 0 ? (
        <p className="mt-2 text-[11px] font-semibold text-slate-500">Nothing has been sent to this tablet yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {commands.slice(0, 20).map((command, index) => (
            <li className="border-b border-slate-100 pb-2" key={command.commandId ?? `${command.name}-${index}`}>
              <p className="break-words text-[12px] font-bold text-slate-900">{command.name}</p>
              <p className="break-words text-[11px] font-semibold text-slate-500">
                {[command.issuedAt ? cairoDateTime(command.issuedAt) : null, command.status, command.remarks]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </SectionShell>
  );
}

/** The four deep reads for one tablet, mounted only once its row is opened. */
export function ManageEngineTabletPanel({ deviceId }: { deviceId: string }) {
  return (
    <div className="mt-3 space-y-3 border-t border-slate-200 pt-3">
      <DetailSection deviceId={deviceId} />
      <RulesSection deviceId={deviceId} />
      <AppsSection deviceId={deviceId} />
      <HistorySection deviceId={deviceId} />
    </div>
  );
}
