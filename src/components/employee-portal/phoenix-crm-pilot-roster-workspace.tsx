"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, UserMinus, UserPlus } from "lucide-react";

import {
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalSection,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
import type { PhoenixCrmRosterRow, PhoenixCrmRosterView } from "@/lib/crm/native-visits/phoenix-crm-types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

/**
 * The Phoenix CRM pilot roster (the owner, 2026-09-14): the Super Admin ticks the medical reps who work
 * in Phoenix CRM, from any line, and adds or removes one on any day. A rep on the roster enters visits
 * and plans in Phoenix CRM from the day they are added; nobody else sees it. The server decides.
 */

const DAY_FORMAT = stableEnGbFormatter({ day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Cairo" });
const TIME_FORMAT = stableEnGbFormatter({
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});

function dayLabel(isoDay: string) {
  return DAY_FORMAT.format(new Date(`${isoDay}T12:00:00Z`));
}

function statusText(row: PhoenixCrmRosterRow) {
  return row.onRoster && row.startsOn ? `In the pilot since ${dayLabel(row.startsOn)}` : "Not in the pilot";
}

function changedText(row: PhoenixCrmRosterRow) {
  if (!row.changedAt) return null;
  return `${row.onRoster ? "Added" : "Removed"} by ${row.changedBy ?? "Unknown employee"}, ${TIME_FORMAT.format(new Date(row.changedAt))}`;
}

async function readJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

export function PhoenixCrmPilotRosterWorkspace() {
  const [view, setView] = useState<PhoenixCrmRosterView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingHrId, setSavingHrId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [line, setLine] = useState("");
  const [show, setShow] = useState<"all" | "on" | "off">("all");

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/crm/phoenix-crm/pilot-reps", { cache: "no-store" });
      const body = await readJson<{ view?: PhoenixCrmRosterView; message?: string }>(response);
      if (!response.ok || !body?.view) throw new Error(body?.message ?? "Could not load the pilot reps.");
      setView(body.view);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the pilot reps.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // load sets state only after its fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function change(row: PhoenixCrmRosterRow, action: "add" | "remove") {
    if (action === "remove" && !window.confirm(`Take ${row.name} out of Phoenix CRM? The visits and plans already saved stay.`)) return;
    setSavingHrId(row.hrId);
    setError(null);
    setNote(null);
    try {
      const response = await fetch("/api/crm/phoenix-crm/pilot-reps", {
        body: JSON.stringify({ action, repHrId: row.hrId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = await readJson<{ view?: PhoenixCrmRosterView; message?: string }>(response);
      if (!response.ok || !body?.view) throw new Error(body?.message ?? "Could not change the pilot reps.");
      setView(body.view);
      setNote(action === "add" ? `${row.name} is in the pilot from today.` : `${row.name} is out of the pilot.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not change the pilot reps.");
    } finally {
      setSavingHrId(null);
    }
  }

  const lines = useMemo(
    () => Array.from(new Set((view?.rows ?? []).map((row) => row.lineName).filter((name): name is string => Boolean(name)))).sort(),
    [view],
  );

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (view?.rows ?? []).filter(
      (row) =>
        (!line || row.lineName === line) &&
        (show === "all" || (show === "on" ? row.onRoster : !row.onRoster)) &&
        (!query ||
          row.name.toLowerCase().includes(query) ||
          (row.areaName ?? "").toLowerCase().includes(query) ||
          (row.managerName ?? "").toLowerCase().includes(query)),
    );
  }, [line, search, show, view]);

  function actionButton(row: PhoenixCrmRosterRow) {
    const saving = savingHrId === row.hrId;
    return row.onRoster ? (
      <Button disabled={savingHrId != null} onClick={() => void change(row, "remove")} size="sm" variant="outline">
        <UserMinus className="h-4 w-4" />
        {saving ? "Removing" : "Remove"}
      </Button>
    ) : (
      <Button disabled={savingHrId != null} onClick={() => void change(row, "add")} size="sm">
        <UserPlus className="h-4 w-4" />
        {saving ? "Adding" : "Add"}
      </Button>
    );
  }

  return (
    <PortalSection
      actions={
        <Button disabled={busy} onClick={() => void load()} size="sm" variant="outline">
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      }
      description="Tick the medical reps who work in Phoenix CRM, from any line. A rep you add enters visits and plans here from today; what a removed rep already saved stays. Nobody else sees Phoenix CRM."
      eyebrow="Pilot reps"
      title={view ? `${view.onRosterCount} ${view.onRosterCount === 1 ? "rep" : "reps"} in the pilot` : "Pilot reps"}
    >
      <div className="grid gap-3 border-b border-slate-100 px-4 py-4 sm:grid-cols-3 sm:px-5">
        <input
          aria-label="Search reps"
          className={portalInputClassName}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search a rep, area or manager"
          value={search}
        />
        <select aria-label="Line" className={portalInputClassName} onChange={(event) => setLine(event.target.value)} value={line}>
          <option value="">Every line</option>
          {lines.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Show"
          className={portalInputClassName}
          onChange={(event) => setShow(event.target.value as "all" | "on" | "off")}
          value={show}
        >
          <option value="all">Every rep</option>
          <option value="on">In the pilot</option>
          <option value="off">Not in the pilot</option>
        </select>
      </div>

      {error ? <p className="mx-4 mt-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 sm:mx-5">{error}</p> : null}
      {note ? <p className="mx-4 mt-4 rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 sm:mx-5">{note}</p> : null}

      {!view ? (
        <PortalEmptyState message={busy ? "Loading the reps." : "The reps could not be loaded."} title="Pilot reps" />
      ) : rows.length === 0 ? (
        <PortalEmptyState message="No rep matches these filters." title="No reps" />
      ) : (
        <>
          <div className="divide-y divide-slate-100 md:hidden">
            {rows.map((row) => (
              <PortalRecordCard
                accent={row.onRoster ? "emerald" : "slate"}
                actions={actionButton(row)}
                key={row.hrId}
                meta={[row.jobTitle, row.lineName, row.areaName].filter(Boolean).join(" · ")}
                title={row.name}
              >
                <PortalRecordFields
                  fields={[
                    { label: "Pilot", value: statusText(row) },
                    { label: "Manager", value: row.managerName ?? "None" },
                  ]}
                />
                {changedText(row) ? <p className="mt-2 text-xs font-medium text-slate-500">{changedText(row)}</p> : null}
              </PortalRecordCard>
            ))}
          </div>
          <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse text-left text-sm">
              <colgroup>
                <col className="w-[28%]" />
                <col className="w-[22%]" />
                <col className="w-[18%]" />
                <col className="w-[20%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead className="border-b border-slate-200 bg-slate-50 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Rep</th>
                  <th className="px-4 py-3">Line · Area</th>
                  <th className="px-4 py-3">Manager</th>
                  <th className="px-4 py-3">Pilot</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.hrId}>
                    <td className="break-words px-4 py-3">
                      <p className="font-bold text-slate-900">{row.name}</p>
                      <p className="text-xs font-medium text-slate-500">{row.jobTitle}</p>
                    </td>
                    <td className="break-words px-4 py-3 text-slate-700">{[row.lineName, row.areaName].filter(Boolean).join(" · ")}</td>
                    <td className="break-words px-4 py-3 text-slate-700">{row.managerName ?? "None"}</td>
                    <td className="break-words px-4 py-3">
                      <p className={row.onRoster ? "font-bold text-emerald-700" : "font-medium text-slate-500"}>{statusText(row)}</p>
                      {changedText(row) ? <p className="text-xs font-medium text-slate-500">{changedText(row)}</p> : null}
                    </td>
                    <td className="px-4 py-3 text-right">{actionButton(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </PortalSection>
  );
}
