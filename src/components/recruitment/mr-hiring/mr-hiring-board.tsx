"use client";

// Recruitment / Medical Rep hiring — the page's one board: the numbered steps with their counts, then
// every Medical Rep candidate with where they are, their interview, the last result and ONE button
// for the next thing to do. A bordered table on a wide screen, cards below its own width — never a
// sideways scroll. Opening a candidate opens their hiring journey.

import { useState } from "react";
import { useRouter } from "next/navigation";

import { RecruitmentPill } from "@/components/recruitment/recruitment-premium";
import { MrJourneyDrawer } from "@/components/recruitment/mr-hiring/mr-journey-drawer";
import { adminPanelHeaderClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { phxCheckTileClassName, phxFieldClassName } from "@/components/ui/form-tokens";
import { candidatePageHref } from "@/lib/recruitment/candidate-page-link";
import { cairoDayShort, cairoWhen, MR_ACTION_LABELS, mrStageHeadline, mrStageStateLine, mrStageTone } from "@/lib/recruitment/mr-hiring/display";
import type { MrRow } from "@/lib/recruitment/mr-hiring/rows";
import {
  MR_CLOSED,
  MR_CLOSED_LABELS,
  MR_RESULT_STEP_LABELS,
  MR_STEP_LABELS,
  MR_STEPS,
  mrResultLabel,
  mrStepNumber,
  type MrClosed,
  type MrStep,
} from "@/lib/recruitment/mr-hiring/vocabulary";
import { cn } from "@/lib/utils";

type Filter = "open" | "all" | MrStep | MrClosed;

function filterOf(row: MrRow): MrStep | MrClosed {
  return row.stage.open ? row.stage.step : row.stage.closed;
}

/** The one button a row offers — the next thing THIS viewer can do, or null. */
function nextActionLabel(row: MrRow): string | null {
  if (row.can.record === "final_decision") return "Make the decision";
  if (row.can.record === "hr_screening") return "Screen the CV";
  if (row.can.decideWithoutDsm && !row.can.record) return "Decide without DSM feedback";
  if (row.can.record === "dsm") return "Record DSM feedback";
  if (row.can.record === "rsm") return "Record RSM evaluation";
  if (row.can.record) return "Record the result";
  if (row.can.recommend) return "Write the recommendation";
  if (row.can.book.length > 0) return row.stage.open && row.stage.action ? MR_ACTION_LABELS[row.stage.action] : "Book the interview";
  if (row.offerHref) return "Prepare offer";
  if (row.stage.open && (row.stage.action === "open_offer" || row.stage.action === "mark_hired")) return MR_ACTION_LABELS[row.stage.action];
  return null;
}

function interviewText(row: MrRow): string {
  const booking = row.stage.open ? row.stage.booking : null;
  if (!booking) return "—";
  const where = booking.platform === "zoom" ? "Zoom" : `In person · ${booking.location?.trim() || "Head office"}`;
  return `${cairoWhen(booking.startsAt)} · ${where}${booking.interviewerName ? ` · ${booking.interviewerName}` : ""}`;
}

function lastResultText(row: MrRow): string {
  const result = row.lastResult;
  if (!result) return "—";
  return `${MR_RESULT_STEP_LABELS[result.step]}: ${mrResultLabel(result.step, result.result)}${result.decidedWithoutDsm ? " (no DSM feedback)" : ""}`;
}

export function MrHiringBoard({
  candidateRoot,
  initialCandidateId,
  rows,
}: {
  /** The recruitment address the viewer's candidate pages live under, or null when they have none (the CEO). */
  candidateRoot: string | null;
  initialCandidateId: string | null;
  rows: MrRow[];
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(
    initialCandidateId && rows.some((row) => row.candidateId === initialCandidateId) ? initialCandidateId : null,
  );

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(filterOf(row), (counts.get(filterOf(row)) ?? 0) + 1);
  const openCount = rows.filter((row) => row.stage.open).length;

  const text = query.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (filter === "open" && !row.stage.open) return false;
    if (filter !== "open" && filter !== "all" && filterOf(row) !== filter) return false;
    if (!text) return true;
    return [row.name, row.area, row.governorate].some((value) => String(value ?? "").toLowerCase().includes(text));
  });

  const chip = (key: Filter, label: string, count: number, number?: number) => (
    <button
      aria-pressed={filter === key}
      className={cn(phxCheckTileClassName(filter === key), "w-auto gap-2 py-2")}
      key={key}
      onClick={() => setFilter(key)}
      type="button"
    >
      {number ? <span className="font-black tabular-nums text-orange-600">{number}</span> : null}
      <span className="break-words text-left">{label}</span>
      <span className="font-black tabular-nums text-slate-900">{count}</span>
    </button>
  );

  return (
    <div className="min-w-0 space-y-4">
      <nav aria-label="Steps" className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {chip("open", "In progress", openCount)}
          {MR_STEPS.map((step) => chip(step, MR_STEP_LABELS[step], counts.get(step) ?? 0, mrStepNumber(step)))}
        </div>
        <div className="flex flex-wrap gap-2">
          {MR_CLOSED.map((closed) => chip(closed, MR_CLOSED_LABELS[closed], counts.get(closed) ?? 0))}
          {chip("all", "Everyone", rows.length)}
        </div>
      </nav>

      <input
        aria-label="Search by name, area or governorate"
        className={cn(phxFieldClassName, "max-w-md")}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by name, area or governorate"
        value={query}
      />

      {visible.length === 0 ? (
        <p className="border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">No candidates here.</p>
      ) : (
        <div className="@container min-w-0">
          <table className="hidden w-full table-fixed border-collapse border border-slate-200 @4xl:table">
            <colgroup>
              <col className="w-[24%]" />
              <col className="w-[26%]" />
              <col className="w-[20%]" />
              <col className="w-[16%]" />
              <col className="w-[14%]" />
            </colgroup>
            <thead>
              <tr className={cn(adminPanelHeaderClassName, "text-left text-white")}>
                {["Candidate", "Step and what's next", "Interview", "Last result", "Next"].map((label) => (
                  <th className="px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.12em]" key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, index) => {
                const action = nextActionLabel(row);
                return (
                  <tr
                    className={cn("cursor-pointer border-t border-slate-200 align-top hover:bg-orange-50/50", index % 2 === 1 ? "bg-slate-50/70" : "bg-white")}
                    key={row.candidateId}
                    onClick={() => setOpenId(row.candidateId)}
                  >
                    <td className="px-3 py-2.5">
                      <p className="break-words text-sm font-bold text-slate-900">{row.name}</p>
                      <p className="break-words text-xs text-slate-500">
                        {[row.area, row.governorate].filter(Boolean).join(" · ") || "No area"} · CV {cairoDayShort(row.receivedAt)}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <RecruitmentPill tone={mrStageTone(row.stage)}>{mrStageHeadline(row.stage)}</RecruitmentPill>
                      <p className="mt-1 break-words text-xs text-slate-600">{mrStageStateLine(row.stage)}</p>
                    </td>
                    <td className="break-words px-3 py-2.5 text-xs text-slate-700">{interviewText(row)}</td>
                    <td className="break-words px-3 py-2.5 text-xs text-slate-700">{lastResultText(row)}</td>
                    <td className="px-3 py-2.5">
                      {action ? (
                        <span className="inline-block break-words border border-orange-500 bg-orange-50 px-2 py-1 text-xs font-black text-orange-700">{action}</span>
                      ) : (
                        <span className="text-xs text-slate-400">Open</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <ul className="grid gap-2 @4xl:hidden">
            {visible.map((row) => {
              const action = nextActionLabel(row);
              return (
                <li key={row.candidateId}>
                  <button
                    className={`block w-full border border-slate-200 bg-white px-3 py-3 text-left hover:border-orange-400 ${adminSoftDepthClassName}`}
                    onClick={() => setOpenId(row.candidateId)}
                    type="button"
                  >
                    <p className="break-words text-sm font-bold text-slate-900">{row.name}</p>
                    <p className="break-words text-xs text-slate-500">
                      {[row.area, row.governorate].filter(Boolean).join(" · ") || "No area"} · CV {cairoDayShort(row.receivedAt)}
                    </p>
                    <div className="mt-2">
                      <RecruitmentPill tone={mrStageTone(row.stage)}>{mrStageHeadline(row.stage)}</RecruitmentPill>
                    </div>
                    <p className="mt-1 break-words text-xs text-slate-600">{mrStageStateLine(row.stage)}</p>
                    {row.stage.open && row.stage.booking ? <p className="mt-1 break-words text-xs text-slate-700">{interviewText(row)}</p> : null}
                    {row.lastResult ? <p className="mt-1 break-words text-xs text-slate-700">{lastResultText(row)}</p> : null}
                    {action ? (
                      <span className="mt-2 inline-block break-words border border-orange-500 bg-orange-50 px-2 py-1 text-xs font-black text-orange-700">{action}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {openId ? (
        <MrJourneyDrawer
          candidateHref={candidateRoot ? candidatePageHref(candidateRoot, openId) : null}
          candidateId={openId}
          onChanged={() => router.refresh()}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}
