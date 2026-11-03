"use client";

import { FileSpreadsheet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  adminPanelClassName,
  adminPanelHeaderClassName,
  adminSoftPanelClassName,
} from "@/components/admin/admin-design-tokens";
import { ListCheckTwoPhotos } from "@/components/marketing-requests/list-check-two-photos";
import { cairoDateTime, utcDate } from "@/lib/format/cairo-datetime";
import { visitsSinceThen, type ListCheckBoard, type ListCheckBoardRow, type ListCheckBreakdownRow } from "@/lib/marketing-requests/crm-list-check-board";

const money = (value: number): string => `EGP ${Math.round(value).toLocaleString("en-US")}`;

const STATE_TONE: Record<string, string> = {
  check: "bg-amber-100 text-amber-900",
  left_list: "bg-rose-100 text-rose-900",
  no_holder: "bg-slate-200 text-slate-800",
  no_location: "bg-slate-200 text-slate-800",
  not_on_list: "bg-orange-100 text-orange-900",
  on_list: "bg-emerald-100 text-emerald-900",
};

function StateChip({ row }: { row: ListCheckBoardRow }) {
  return <span className={`inline-block px-1.5 py-0.5 text-phx-xs font-black ${STATE_TONE[row.state] ?? "bg-slate-100 text-slate-700"}`}>{row.stateLabel}</span>;
}

function Metres({ row }: { row: ListCheckBoardRow }) {
  if (row.metresApart === null) return <span className="text-slate-400">Not measured</span>;
  return <span className={row.far ? "font-black text-rose-800" : "text-slate-800"}>{row.metresApart.toLocaleString("en-US")} m</span>;
}

function AfterTheMoney({ row, showObjections }: { row: ListCheckBoardRow; showObjections: boolean }) {
  return (
    <div className="space-y-0.5 break-words text-phx-xs text-slate-600">
      <p className="font-black text-slate-900">{row.approvedRequests > 0 ? money(row.approvedCost) : "No approved request"}</p>
      {row.requesterNames.length > 0 ? <p dir="auto">{row.requesterNames.join(", ")}</p> : null}
      {row.firstPayDate ? <p>Pay date {utcDate(row.firstPayDate)}</p> : null}
      {row.visitsSincePay !== null ? <p>{visitsSinceThen(row.visitsSincePay)}</p> : null}
      {row.lastVisitDate ? <p>Last visit {utcDate(row.lastVisitDate)}</p> : null}
      {showObjections && row.latestObjection ? (
        <p dir="auto">
          Latest objection: {row.latestObjection.label}
          {row.latestObjection.note ? ` (${row.latestObjection.note})` : ""}
        </p>
      ) : null}
    </div>
  );
}

function DecideButtons({ canDecide, row }: { canDecide: boolean; row: ListCheckBoardRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canDecide) return null;

  async function decide(decision: "same" | "not_same") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/marketing-requests/list-check/decide", {
        body: JSON.stringify({ checkId: row.checkId, decision }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        setError(payload?.message ?? "The answer could not be saved. Reload and try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("The answer did not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const buttonClassName = "min-h-10 border px-3 text-phx-sm font-bold disabled:opacity-50";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {row.matchedCrmCustomerId ? (
        <button className={`${buttonClassName} border-emerald-700 bg-emerald-700 text-white`} disabled={busy} onClick={() => void decide("same")} type="button">
          Same doctor
        </button>
      ) : null}
      <button className={`${buttonClassName} border-slate-300 bg-white text-slate-800`} disabled={busy} onClick={() => void decide("not_same")} type="button">
        {row.matchedCrmCustomerId ? "Not the same" : "Not on the list"}
      </button>
      {error ? <p className="text-phx-xs font-bold text-rose-800">{error}</p> : null}
    </div>
  );
}

function Breakdown({ rows, title }: { rows: ListCheckBreakdownRow[]; title: string }) {
  return (
    <section className={adminPanelClassName}>
      <header className={`${adminPanelHeaderClassName} px-4 py-3`}>
        <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-white">{title}</p>
      </header>
      <table className="w-full table-fixed text-phx-xs">
        <colgroup>
          <col className="w-[40%]" />
          <col className="w-[20%]" />
          <col className="w-[40%]" />
        </colgroup>
        <thead className="text-left text-slate-500">
          <tr>
            <th className="px-3 py-2 font-bold">Name</th>
            <th className="px-3 py-2 font-bold">On list</th>
            <th className="px-3 py-2 font-bold">Approved money</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-t border-slate-100 align-top" key={row.name}>
              <td className="break-words px-3 py-2 font-bold text-slate-900" dir="auto">
                {row.name}
              </td>
              <td className="px-3 py-2 text-slate-700">
                {row.onListCustomers} of {row.customers}
              </td>
              <td className="break-words px-3 py-2 text-slate-700">
                {money(row.approvedCost)}
                {row.approvedCostOffList > 0 ? <span className="block font-bold text-rose-800">{money(row.approvedCostOffList)} not confirmed</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function QueueRow({ canDecide, row }: { canDecide: boolean; row: ListCheckBoardRow }) {
  return (
    <div className="space-y-2 border-t border-slate-100 p-3 first:border-t-0">
      <p className="text-phx-xs text-slate-600">
        {row.lineName ?? "No line recorded"}
        {row.looksLikeNursery ? <span className="ml-2 font-black text-rose-800">Looks like a nursery</span> : null}
      </p>
      <ListCheckTwoPhotos
        customerName={row.customerName}
        customerPhotoUrl={row.customerPhotoUrl}
        doctorName={row.matchedName}
        doctorPhotoUrl={row.doctorPhotoUrl}
        metresApart={row.metresApart}
        reason={row.reason}
      />
      <DecideButtons canDecide={canDecide} row={row} />
    </div>
  );
}

/**
 * Desktop reads a table, a phone reads cards, and neither ever scrolls sideways. Dark blue is the marketing
 * request and light blue the rep's list, his colours from the audit sheet (owner, 2026-10-27).
 */
export function MarketingListCheckBoard({ board }: { board: ListCheckBoard }) {
  const [filter, setFilter] = useState<string | null>(null);
  const leftList = board.rows.filter((row) => row.state === "left_list");
  const queue = board.rows.filter((row) => row.open);
  const shown = filter ? board.rows.filter((row) => row.state === filter) : board.rows;

  if (board.rows.length === 0) {
    return (
      <div className={`${adminSoftPanelClassName} p-6`}>
        <p className="text-phx-md font-bold text-slate-900">The check has not run yet</p>
        <p className="mt-1 text-phx-sm text-slate-600">Read {cairoDateTime(board.generatedAtIso)} Cairo.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {board.cards.map((card) => (
          <button
            aria-pressed={filter === card.state}
            className={`${adminSoftPanelClassName} p-4 text-left ${filter === card.state ? "ring-2 ring-orange-500" : ""}`}
            key={card.state}
            onClick={() => setFilter(filter === card.state ? null : card.state)}
            type="button"
          >
            <span className="block text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{card.label}</span>
            <span className="mt-1 block text-phx-lg font-bold text-slate-900">{card.customers.toLocaleString("en-US")}</span>
            <span className="mt-0.5 block text-phx-xs text-slate-500">{money(card.approvedCost)} approved</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {/* `download` is load-bearing: the target streams a binary, which a <Link> would hand to the client router. */}
        <a
          className="inline-flex min-h-10 items-center border border-slate-300 bg-white px-4 text-phx-sm font-bold text-slate-700 hover:border-orange-300 hover:text-orange-700"
          download
          href="/api/marketing-requests/list-check/export"
        >
          <FileSpreadsheet className="mr-2 h-3.5 w-3.5 shrink-0" />
          Download Excel
        </a>
        <p className="text-phx-xs text-slate-500">
          {money(board.totals.approvedCost)} approved, {money(board.totals.approvedCostOffList)} of it not confirmed on a rep&rsquo;s list. Estimated cost, never sales.
        </p>
      </div>

      {leftList.length > 0 ? (
        <section className="border border-rose-300 bg-rose-50">
          <p className="border-b border-rose-200 px-4 py-2 text-phx-sm font-black text-rose-900">Left the list after being on it</p>
          <ul>
            {leftList.map((row) => (
              <li className="border-t border-rose-100 px-4 py-2 text-phx-sm first:border-t-0" key={row.checkId}>
                <span className="font-bold text-slate-900" dir="auto">
                  {row.customerName}
                </span>
                <span className="ml-2 text-phx-xs text-slate-600">
                  {row.lineName ?? "No line recorded"}
                  {row.leftListAt ? `, seen ${cairoDateTime(row.leftListAt)} Cairo` : ""}
                  {row.approvedRequests > 0 ? `, ${money(row.approvedCost)} approved` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {queue.length > 0 ? (
        <section className={adminPanelClassName}>
          <header className={`${adminPanelHeaderClassName} px-4 py-3`}>
            <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-white">Check queue, {queue.length.toLocaleString("en-US")} waiting</p>
            <p className="mt-0.5 text-phx-xs text-slate-300">
              {board.canDecide ? "Compare the two photos and answer. Your name and the time are recorded." : "The SFE Manager or the Super Admin answers these."}
            </p>
          </header>
          {queue.map((row) => (
            <QueueRow canDecide={board.canDecide} key={row.checkId} row={row} />
          ))}
        </section>
      ) : null}

      <section className={adminPanelClassName}>
        <header className={`${adminPanelHeaderClassName} px-4 py-3`}>
          <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-white">Every customer{filter ? `, ${shown[0]?.stateLabel ?? "none here"}` : ""}</p>
          <p className="mt-0.5 text-phx-xs text-slate-300">Read {cairoDateTime(board.generatedAtIso)} Cairo</p>
        </header>
        <div className="hidden xl:block">
          <table className="w-full table-fixed text-phx-xs">
            <colgroup>
              <col className="w-[15%]" />
              <col className="w-[15%]" />
              <col className="w-[10%]" />
              <col className="w-[10%]" />
              <col className="w-[7%]" />
              <col className="w-[12%]" />
              <col className="w-[10%]" />
              <col className="w-[21%]" />
            </colgroup>
            <thead className="text-left">
              <tr>
                <th className="bg-[#0a527d] px-2 py-2 font-black text-white">Marketing name</th>
                <th className="bg-[#1482c2] px-2 py-2 font-black text-white">Rep&rsquo;s list name</th>
                <th className="bg-[#0a527d] px-2 py-2 font-black text-white">Marketing area</th>
                <th className="bg-[#1482c2] px-2 py-2 font-black text-white">List area</th>
                <th className="px-2 py-2 font-black text-slate-700">Apart</th>
                <th className="px-2 py-2 font-black text-slate-700">Rep</th>
                <th className="px-2 py-2 font-black text-slate-700">State</th>
                <th className="px-2 py-2 font-black text-slate-700">Money and what followed</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr className="border-t border-slate-100 align-top" key={row.checkId} title={row.reason}>
                  <td className="break-words px-2 py-2 font-bold text-slate-900" dir="auto">
                    {row.customerName}
                    <span className="block font-normal text-slate-500">{row.lineName ?? "No line recorded"}</span>
                  </td>
                  <td className="break-words px-2 py-2 text-slate-900" dir="auto">
                    {row.matchedName ?? "None"}
                  </td>
                  <td className="break-words px-2 py-2 text-slate-700">{row.marketingAreaName ?? "Not read"}</td>
                  <td className="break-words px-2 py-2 text-slate-700">{row.listAreaName ?? "None"}</td>
                  <td className="break-words px-2 py-2">
                    <Metres row={row} />
                  </td>
                  <td className="break-words px-2 py-2 text-slate-700" dir="auto">
                    {row.repNames.length > 0 ? row.repNames.join(", ") : "No rep"}
                  </td>
                  <td className="space-y-1 px-2 py-2">
                    <StateChip row={row} />
                    {row.looksLikeNursery ? <span className="block font-black text-rose-800">Nursery?</span> : null}
                    {row.decidedByName ? <span className="block break-words text-slate-500">Answered by {row.decidedByName}</span> : null}
                  </td>
                  <td className="px-2 py-2">
                    <AfterTheMoney row={row} showObjections={board.showObjections} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="xl:hidden">
          {shown.map((row) => (
            <li className="space-y-2 border-t border-slate-100 p-3 first:border-t-0" key={row.checkId}>
              <div className="flex flex-wrap items-center gap-2">
                <StateChip row={row} />
                <span className="text-phx-xs text-slate-500">{row.lineName ?? "No line recorded"}</span>
                {row.looksLikeNursery ? <span className="text-phx-xs font-black text-rose-800">Nursery?</span> : null}
              </div>
              <div className="grid grid-cols-2 gap-2 text-phx-xs">
                <div className="min-w-0 border-t-4 border-[#0a527d] pt-1">
                  <p className="break-words font-bold text-slate-900" dir="auto">{row.customerName}</p>
                  <p className="break-words text-slate-600">{row.marketingAreaName ?? "Not read"}</p>
                </div>
                <div className="min-w-0 border-t-4 border-[#1482c2] pt-1">
                  <p className="break-words font-bold text-slate-900" dir="auto">{row.matchedName ?? "None"}</p>
                  <p className="break-words text-slate-600">{row.listAreaName ?? "None"}</p>
                </div>
              </div>
              <p className="break-words text-phx-xs text-slate-600" dir="auto">
                <Metres row={row} />
                {" · "}
                {row.repNames.length > 0 ? row.repNames.join(", ") : "No rep"}
              </p>
              <p className="break-words text-phx-xs text-slate-500">{row.reason}</p>
              {row.decidedByName ? <p className="break-words text-phx-xs text-slate-500">Answered by {row.decidedByName}</p> : null}
              <AfterTheMoney row={row} showObjections={board.showObjections} />
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-4 2xl:grid-cols-3">
        <Breakdown rows={board.byRequester} title="By requester" />
        <Breakdown rows={board.byLine} title="By line" />
        <Breakdown rows={board.byArea} title="By area" />
      </div>
    </div>
  );
}
