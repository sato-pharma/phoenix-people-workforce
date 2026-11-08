"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  adminPanelClassName,
  adminPanelHeaderClassName,
  adminSoftPanelClassName,
} from "@/components/admin/admin-design-tokens";
import {
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxCheckInputClassName,
  phxFieldClassName,
  phxLabelClassName,
} from "@/components/ui/form-tokens";
import { cairoDate, cairoDateTime, cairoMonthDayTime12h, utcDate } from "@/lib/format/cairo-datetime";
import {
  summarizeCeoApprovals,
  type CeoApprovalFinanceState,
  type MarketingCeoApprovalRow,
  type MarketingCeoApprovals,
} from "@/lib/marketing-requests/ceo-approvals";

const money = (value: number): string => Math.round(value).toLocaleString("en-US");

/** "11:03 AM" — built from digits by the shared formatter, never asked of the browser. */
function cairoTime12h(iso: string | null | undefined): string {
  return cairoMonthDayTime12h(iso).split(", ").at(-1) ?? "-";
}

/** Only the paint is decided here; the state itself is `buildCeoApprovalRows`, pinned by a test. */
const FINANCE_TONE: Record<CeoApprovalFinanceState, string> = {
  closed_out: "bg-slate-100 text-slate-600",
  executed: "bg-emerald-50 text-emerald-800",
  held: "bg-amber-100 text-amber-800",
  waiting_finance: "bg-amber-50 text-amber-800",
  waiting_other: "bg-sky-50 text-sky-800",
};

function StatusCell({ row }: { row: MarketingCeoApprovalRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <span className={`inline-block px-1.5 py-0.5 text-phx-xs font-black ${FINANCE_TONE[row.financeState]}`}>{row.statusLabel}</span>
      {row.financeState === "executed" ? (
        <p className="break-words text-phx-xs text-slate-600">
          Executed{row.executedByName ? ` by ${row.executedByName}` : ""}
          {row.executedAtIso ? ` · ${cairoDate(row.executedAtIso)}, ${cairoTime12h(row.executedAtIso)}` : ""}
        </p>
      ) : (
        <p className="break-words text-phx-xs text-slate-600">{row.financeLabel}</p>
      )}
    </div>
  );
}

function PayDateCell({ row }: { row: MarketingCeoApprovalRow }) {
  return (
    <div className="min-w-0">
      <p className="text-slate-700">{utcDate(row.payDate)}</p>
      {row.payDateOverdue ? <p className="text-phx-xs font-bold text-rose-700">Passed, not paid</p> : null}
    </div>
  );
}

function ApprovalCell({ row }: { row: MarketingCeoApprovalRow }) {
  return (
    <div className="min-w-0">
      <p className="font-semibold text-slate-800">{cairoDate(row.approvedAtIso)}</p>
      <p className="text-phx-xs text-slate-500">{cairoTime12h(row.approvedAtIso)}</p>
      {row.approvedOnBehalfBy ? <p className="break-words text-phx-xs text-slate-500">pressed by {row.approvedOnBehalfBy}</p> : null}
    </div>
  );
}

function RequestCodeLink({ row }: { row: MarketingCeoApprovalRow }) {
  return (
    <Link className="break-all font-bold text-slate-900 hover:text-orange-700 hover:underline" href={row.href}>
      {row.requestCode}
    </Link>
  );
}

function RangeForm({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = new URLSearchParams({ from: draftFrom, to: draftTo });
    router.push(`${pathname}?${query.toString()}`);
  }

  return (
    <form className={`${adminSoftPanelClassName} flex flex-wrap items-end gap-3 p-4`} onSubmit={submit}>
      <label className="min-w-0 flex-1 basis-40">
        <span className={phxLabelClassName}>From (Cairo)</span>
        <input
          className={phxFieldClassName}
          max={draftTo || undefined}
          onChange={(event) => setDraftFrom(event.target.value)}
          required
          type="date"
          value={draftFrom}
        />
      </label>
      <label className="min-w-0 flex-1 basis-40">
        <span className={phxLabelClassName}>To (Cairo)</span>
        <input
          className={phxFieldClassName}
          min={draftFrom || undefined}
          onChange={(event) => setDraftTo(event.target.value)}
          required
          type="date"
          value={draftTo}
        />
      </label>
      <button className={phxButtonPrimaryClassName} type="submit">
        Show report
      </button>
    </form>
  );
}

/**
 * Every request the CEO approved between two Cairo dates. Every row starts ticked; unticking one
 * takes it out of the tiles and the total, which both read `summarizeCeoApprovals` over the ticked
 * set. Read-only: a request code opens the request, nothing here decides or pays.
 *
 * The parent keys this component by the range, so a new range starts with every row ticked again.
 */
export function MarketingCeoApprovalsReport({ report }: { report: MarketingCeoApprovals }) {
  const { rows, range } = report;
  const allIds = useMemo(() => rows.map((row) => row.requestId), [rows]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allIds));
  const headerBox = useRef<HTMLInputElement>(null);

  const allTicked = rows.length > 0 && selected.size === rows.length;
  const noneTicked = selected.size === 0;

  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = !allTicked && !noneTicked;
  }, [allTicked, noneTicked]);

  const totals = useMemo(() => summarizeCeoApprovals(rows, selected), [rows, selected]);

  function toggle(requestId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allTicked ? new Set() : new Set(allIds));
  }

  const rangeLabel = `${utcDate(range.from)} to ${utcDate(range.to)}`;

  const tiles = [
    { hint: `of ${rows.length} approved`, label: "Selected", value: String(totals.count) },
    { hint: "requested value of the selected", label: "Total value (EGP)", value: money(totals.totalValue) },
    {
      hint: `${totals.executedCount} request${totals.executedCount === 1 ? "" : "s"} paid out`,
      label: "Executed by Finance (EGP)",
      value: money(totals.executedValue),
    },
    {
      hint: `${totals.waitingCount} request${totals.waitingCount === 1 ? "" : "s"} still open${totals.overdueCount ? ` · ${totals.overdueCount} past pay date` : ""}`,
      label: "Not yet executed (EGP)",
      value: money(totals.waitingValue),
    },
  ];

  return (
    <div className="space-y-6">
      <RangeForm from={range.from} to={range.to} />

      {rows.length === 0 ? (
        <div className={`${adminSoftPanelClassName} p-6`}>
          <p className="text-phx-md font-bold text-slate-900">The CEO approved no marketing request from {rangeLabel}</p>
          <p className="mt-1 text-phx-sm text-slate-600">Pick other dates above. Read {cairoDateTime(report.generatedAtIso)} Cairo.</p>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {tiles.map((tile) => (
              <div className={`${adminSoftPanelClassName} p-4`} key={tile.label}>
                <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{tile.label}</dt>
                <dd className="mt-1 text-phx-lg font-bold text-slate-900">
                  {tile.value}
                  <span className="mt-0.5 block text-phx-xs font-normal text-slate-500">{tile.hint}</span>
                </dd>
              </div>
            ))}
          </dl>

          <section className={`${adminPanelClassName} @container`}>
            <header className={`${adminPanelHeaderClassName} flex flex-wrap items-center justify-between gap-3 px-4 py-3`}>
              <div className="min-w-0">
                <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-white">Approved by the CEO · {rangeLabel}</p>
                <p className="mt-0.5 text-phx-xs text-slate-300">Read {cairoDateTime(report.generatedAtIso)} Cairo</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-phx-xs font-bold text-slate-200">
                  {selected.size} of {rows.length} selected
                </span>
                <button className={phxButtonGhostClassName} onClick={toggleAll} type="button">
                  {allTicked ? "Clear all" : "Select all"}
                </button>
              </div>
            </header>

            <table className="hidden w-full table-fixed text-left text-sm @min-[1100px]:table">
              <colgroup>
                <col className="w-[4%]" />
                <col className="w-[3%]" />
                <col className="w-[13%]" />
                <col className="w-[13%]" />
                <col className="w-[10%]" />
                <col className="w-[8%]" />
                <col className="w-[9%]" />
                <col className="w-[8%]" />
                <col className="w-[10%]" />
                <col className="w-[13%]" />
                <col className="w-[9%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-phx-line text-phx-xs font-black uppercase tracking-wider text-slate-500">
                  <th className="px-2 py-2" scope="col">
                    <input
                      aria-label="Select every request"
                      checked={allTicked}
                      className={phxCheckInputClassName}
                      onChange={toggleAll}
                      ref={headerBox}
                      type="checkbox"
                    />
                  </th>
                  <th className="px-1 py-2" scope="col">#</th>
                  <th className="px-2 py-2" scope="col">Request code</th>
                  <th className="px-2 py-2" scope="col">Customer</th>
                  <th className="px-2 py-2" scope="col">Requester</th>
                  <th className="px-2 py-2" scope="col">Line</th>
                  <th className="px-2 py-2" scope="col">Type</th>
                  <th className="px-2 py-2 text-right" scope="col">Value (EGP)</th>
                  <th className="px-2 py-2" scope="col">Dr Anwar approval</th>
                  <th className="px-2 py-2" scope="col">Live report status</th>
                  <th className="px-2 py-2" scope="col">Pay date</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const ticked = selected.has(row.requestId);
                  return (
                    <tr
                      className={`border-b border-[#f1f4f6] align-top hover:bg-orange-50/40 ${ticked ? "" : "opacity-45"}`}
                      key={row.requestId}
                    >
                      <td className="px-2 py-2">
                        <input
                          aria-label={`Select ${row.requestCode}`}
                          checked={ticked}
                          className={phxCheckInputClassName}
                          onChange={() => toggle(row.requestId)}
                          type="checkbox"
                        />
                      </td>
                      <td className="px-1 py-2 text-slate-500">{index + 1}</td>
                      <td className="px-2 py-2"><RequestCodeLink row={row} /></td>
                      <td className="break-words px-2 py-2 font-semibold text-slate-900" dir="auto">{row.customerName}</td>
                      <td className="break-words px-2 py-2 text-slate-800">{row.requesterName}</td>
                      <td className="break-words px-2 py-2 text-slate-700">{row.lineName}</td>
                      <td className="break-words px-2 py-2 text-slate-700" dir="auto">{row.requestType}</td>
                      <td className="px-2 py-2 text-right font-bold text-slate-900">{money(row.estimatedCost)}</td>
                      <td className="px-2 py-2"><ApprovalCell row={row} /></td>
                      <td className="px-2 py-2"><StatusCell row={row} /></td>
                      <td className="px-2 py-2"><PayDateCell row={row} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="hidden flex-wrap items-baseline justify-between gap-3 border-t-2 border-slate-900 bg-slate-50 px-3 py-3 @min-[1100px]:flex">
              <p className="font-black text-slate-900">
                Total of {totals.count} selected: EGP {money(totals.totalValue)}
              </p>
              <p className="text-phx-xs font-bold text-slate-600">
                Executed {money(totals.executedValue)} · not yet executed {money(totals.waitingValue)}
              </p>
            </div>

            <div className="space-y-2 p-3 @min-[1100px]:hidden">
              <label className="flex items-center gap-2 border border-phx-line bg-slate-50 px-3 py-2 text-phx-sm font-bold text-slate-800">
                <input checked={allTicked} className={phxCheckInputClassName} onChange={toggleAll} type="checkbox" />
                Select every request ({selected.size} of {rows.length})
              </label>
              {rows.map((row, index) => {
                const ticked = selected.has(row.requestId);
                return (
                  <article className={`border border-phx-line p-3 ${ticked ? "" : "opacity-45"}`} key={row.requestId}>
                    <div className="flex items-start gap-3">
                      <input
                        aria-label={`Select ${row.requestCode}`}
                        checked={ticked}
                        className={`${phxCheckInputClassName} mt-1`}
                        onChange={() => toggle(row.requestId)}
                        type="checkbox"
                      />
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-phx-xs text-slate-500">#{index + 1}</p>
                            <RequestCodeLink row={row} />
                            <p className="break-words font-semibold text-slate-900" dir="auto">{row.customerName}</p>
                          </div>
                          <p className="shrink-0 text-right font-bold text-slate-900">EGP {money(row.estimatedCost)}</p>
                        </div>
                        <p className="break-words text-phx-sm text-slate-700">
                          {row.requesterName} · {row.lineName} · <span dir="auto">{row.requestType}</span>
                        </p>
                        <dl className="grid grid-cols-1 gap-2 text-phx-sm @min-[420px]:grid-cols-3">
                          <div className="min-w-0">
                            <dt className="text-phx-xs font-bold uppercase tracking-wider text-slate-500">Dr Anwar approval</dt>
                            <dd><ApprovalCell row={row} /></dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-phx-xs font-bold uppercase tracking-wider text-slate-500">Live report status</dt>
                            <dd><StatusCell row={row} /></dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-phx-xs font-bold uppercase tracking-wider text-slate-500">Pay date</dt>
                            <dd><PayDateCell row={row} /></dd>
                          </div>
                        </dl>
                      </div>
                    </div>
                  </article>
                );
              })}
              <div className="border-t-2 border-slate-900 bg-slate-50 px-3 py-3 font-black text-slate-900">
                Total of {totals.count} selected: EGP {money(totals.totalValue)}
                <p className="text-phx-xs font-bold text-slate-600">
                  Executed {money(totals.executedValue)} · not yet executed {money(totals.waitingValue)}
                </p>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
