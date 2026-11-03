"use client";

/**
 * Phoenix CRM — the Rep Exceptions page of the Super Admin and the SFE Manager (owner, 2026-11-03).
 *
 * Opens on the exceptions in force, with who set each and when ("the first thing that appears"). Under them the ordinary
 * module: everyone who once had one, or any rep the filter brings up. Each rep has a switch and two dates, and a date
 * change on a live exception has its own save.
 *
 * It fits the screen: a phone draws cards, the desktop a `table-fixed` table whose colgroup and header row come
 * from ONE array, so the two cannot disagree. No `overflow-x`, no ellipsis.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { cairoClock24 } from "@/components/phoenix-crm/format";
import {
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmField,
  CrmPill,
  CrmSelect,
  CrmTable,
  crmInputClassName,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { Switch } from "@/components/ui/switch";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import {
  REP_EXCEPTIONS_ADMIN_PATH,
  repExceptionDatesProblem,
  repExceptionStateLabel,
  repExceptionsExplainer,
  type RepExceptionAction,
  type RepExceptionRow,
  type RepExceptionsAdminView,
} from "@/lib/phoenix-crm/rep-exception-rules";
import { cn } from "@/lib/utils";

const REP_COLUMNS = [
  { head: "Rep", width: "30%" },
  { head: "Dates", width: "40%" },
  { head: "No limit", width: "30%" },
] as const;

type Draft = { from: string; until: string };

export function RepExceptionsAdmin({ view }: { view: RepExceptionsAdminView }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ hrId: string; message: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const locked = busy !== null || refreshing;

  function choose(hrId: string) {
    setError(null);
    setDrafts({});
    startRefresh(() => router.push(hrId ? `${REP_EXCEPTIONS_ADMIN_PATH}?rep=${encodeURIComponent(hrId)}` : REP_EXCEPTIONS_ADMIN_PATH));
  }

  function datesOf(row: RepExceptionRow): Draft {
    return drafts[row.hrId] ?? { from: row.from, until: row.until };
  }

  function edit(row: RepExceptionRow, change: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [row.hrId]: { ...datesOf(row), ...change } }));
  }

  async function act(row: RepExceptionRow, action: RepExceptionAction) {
    if (locked) return;
    const dates = datesOf(row);
    if (action === "open") {
      const problem = repExceptionDatesProblem(dates.from, dates.until, view.today);
      if (problem) {
        setError({ hrId: row.hrId, message: problem });
        return;
      }
    }
    setBusy(row.hrId);
    setError(null);
    try {
      await crmPost("/api/phoenix-crm/rep-exceptions", { hrId: row.hrId, action, from: dates.from, until: dates.until }, "result");
      setDrafts((current) => {
        const next = { ...current };
        delete next[row.hrId];
        return next;
      });
      startRefresh(() => router.refresh());
    } catch (failure) {
      setError({ hrId: row.hrId, message: messageOf(failure) });
    } finally {
      setBusy(null);
    }
  }

  function repCell(row: RepExceptionRow) {
    return (
      <div className="grid min-w-0 gap-1">
        <span className="break-words font-black text-slate-900" dir="auto">
          {row.name}
        </span>
        <span className="break-words text-xs font-semibold text-slate-600">{`${row.lineName} · ${row.areaName}`}</span>
        {row.hireDate ? <span className="break-words text-xs font-semibold text-slate-500">{`Hired ${formatPhoenixLongDate(row.hireDate)}`}</span> : null}
      </div>
    );
  }

  function dateControls(row: RepExceptionRow, place: string) {
    const dates = datesOf(row);
    const changed = dates.from !== row.from || dates.until !== row.until;
    const rowError = error?.hrId === row.hrId ? error.message : null;
    const fromId = `rep-exception-${place}-from-${row.hrId}`;
    const untilId = `rep-exception-${place}-until-${row.hrId}`;
    return (
      <div className="grid min-w-0 gap-2">
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <CrmField htmlFor={fromId} label="First day">
            <input
              className={cn(crmInputClassName, "appearance-none")}
              disabled={locked}
              id={fromId}
              onChange={(event) => edit(row, { from: event.target.value })}
              type="date"
              value={dates.from}
            />
          </CrmField>
          <CrmField htmlFor={untilId} label="Last day">
            <input
              className={cn(crmInputClassName, "appearance-none")}
              disabled={locked}
              id={untilId}
              min={dates.from}
              onChange={(event) => edit(row, { until: event.target.value })}
              type="date"
              value={dates.until}
            />
          </CrmField>
        </div>
        {rowError ? <p className="break-words text-xs font-bold text-rose-800">{rowError}</p> : null}
        {row.on && changed ? (
          <div>
            <CrmButton busy={busy === row.hrId} disabled={locked} onClick={() => void act(row, "open")} size="sm" variant="primary">
              Save dates
            </CrmButton>
          </div>
        ) : null}
      </div>
    );
  }

  function switchCell(row: RepExceptionRow) {
    return (
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <Switch
            checked={row.on}
            label={`No limit: ${row.name}`}
            onChange={(next) => {
              if (locked) return;
              void act(row, next ? "open" : "close");
            }}
          />
          <span className="text-xs font-black text-slate-600">{busy === row.hrId ? "Saving" : row.on ? "On" : "Off"}</span>
        </div>
        <p className="break-words text-sm font-black text-slate-900">{repExceptionStateLabel(row, view.today, formatPhoenixLongDate)}</p>
        {row.on ? (
          <>
            <p className="break-words text-xs font-semibold text-slate-600" dir="auto">{`Set by ${row.setByName ?? "Not recorded"}`}</p>
            <p className="break-words text-xs font-semibold text-slate-500">{row.setAt ? `${formatPhoenixLongDate(row.setAt)}, ${cairoClock24(row.setAt)}` : "When: Not recorded"}</p>
          </>
        ) : null}
      </div>
    );
  }

  // A live rep who is also chosen in the filter is drawn in both lists, so every id carries its list's name.
  function repList(rows: RepExceptionRow[], list: "live" | "other") {
    return (
      <>
        <CrmCardsOnPhone>
          {rows.map((row) => (
            <CrmCard
              accent={row.on ? "border-l-orange-500" : "border-l-slate-300"}
              key={row.hrId}
              meta={`${row.lineName} · ${row.areaName}`}
              status={<CrmPill tone={row.on ? "warn" : "info"}>{row.on ? "No limit" : "Usual limit"}</CrmPill>}
              title={
                <span className="break-words font-black text-slate-900" dir="auto">
                  {row.name}
                </span>
              }
            >
              <div className="grid min-w-0 gap-3">
                {switchCell(row)}
                {dateControls(row, `${list}-card`)}
              </div>
            </CrmCard>
          ))}
        </CrmCardsOnPhone>

        <CrmTable columns={[...REP_COLUMNS.map((column) => column.width)]}>
          <thead>
            <tr>
              {REP_COLUMNS.map((column) => (
                <th className={crmThClassName} key={column.head}>
                  {column.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.hrId}>
                <td className={crmTdClassName}>{repCell(row)}</td>
                <td className={crmTdClassName}>{dateControls(row, `${list}-row`)}</td>
                <td className={crmTdClassName}>{switchCell(row)}</td>
              </tr>
            ))}
          </tbody>
        </CrmTable>
      </>
    );
  }

  return (
    <div className="grid min-w-0 gap-5">
      <section className="min-w-0 border border-slate-200 bg-white">
        <header className="min-w-0 border-b border-slate-200 px-4 py-3.5 sm:px-5">
          <h2 className="text-base font-black text-slate-950">Exceptions in force</h2>
          <p className="mt-1 break-words text-sm font-medium leading-6 text-slate-600">Every rep the usual limit does not reach now or on dates already set, who set it and when.</p>
        </header>
        {view.exceptions.length === 0 ? (
          <CrmEmpty message="Every rep is on the usual limit." title="No rep has an exception now" />
        ) : (
          repList(view.exceptions, "live")
        )}
      </section>

      <section className="min-w-0 border border-slate-200 bg-white">
        <header className="grid min-w-0 gap-3 border-b border-slate-200 px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-base font-black text-slate-950">Unplanned visit limit</h2>
            <p className="mt-1 break-words text-sm font-medium leading-6 text-slate-600">{repExceptionsExplainer(view)}</p>
          </div>
          <CrmField htmlFor="rep-exceptions-rep" label="Medical rep">
            <CrmSelect disabled={refreshing} id="rep-exceptions-rep" onChange={(event) => choose(event.target.value)} value={view.selected?.hrId ?? ""}>
              <option value="">Reps who had one before</option>
              {view.reps.map((rep) => (
                <option key={rep.hrId} value={rep.hrId}>
                  {`${rep.name} · ${rep.lineName} · ${rep.areaName}`}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
        </header>

        {view.rows.length === 0 ? <CrmEmpty message="Choose a medical rep above to give one." title="Choose a rep" /> : repList(view.rows, "other")}
      </section>
    </div>
  );
}
