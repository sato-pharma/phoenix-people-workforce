"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { phxButtonApproveClassName, phxButtonDangerClassName } from "@/components/ui/form-tokens";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { HeldFullName } from "@/lib/phoenix-crm/doctor-name-rules";

/**
 * Doctors' full names waiting for a decision (owner, 2026-11-07, doctor-name-rules.ts): the name a rep
 * wrote matched what was read off the doctor's signboard or timetable 40–59%, or a validated doctor's
 * board was never read. Approve renames the doctor; reject keeps the old name and he stays blocked
 * until the rep writes another. The rep is never told it waited.
 */
export function FullNameChecks({ rows }: { rows: HeldFullName[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = rows.filter((row) => !row.isTest);

  async function decide(customerId: string, decision: "approve" | "reject") {
    if (busy) return;
    setBusy(customerId);
    setProblem(null);
    try {
      const response = await fetch("/api/phoenix-crm/full-names", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId, decision }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setProblem(payload.error ?? "Could not save the decision.");
        return;
      }
      router.refresh();
    } catch {
      setProblem("Could not save the decision. Check the connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  if (shown.length === 0) return null;

  const actions = (row: HeldFullName) => (
    <div className="flex flex-wrap gap-2">
      <button className={phxButtonApproveClassName} disabled={busy !== null} onClick={() => void decide(row.customerId, "approve")} type="button">
        Approve name
      </button>
      <button className={phxButtonDangerClassName} disabled={busy !== null} onClick={() => void decide(row.customerId, "reject")} type="button">
        Reject
      </button>
    </div>
  );
  const match = (row: HeldFullName) => (row.percent === null ? "No board read" : `${row.percent}%`);
  const board = (row: HeldFullName) => (row.boardNames.length ? row.boardNames.join(" · ") : "Nothing was read off the board");

  return (
    <AdminTableShell
      description="A rep wrote a doctor's first, middle and last name, and it matched the doctor's signboard or timetable only in part (40% to 59%), or the doctor is validated and nothing was read off the board. Approve renames the doctor. Reject keeps the old name, and the doctor stays out of the plan and Add visit until the rep writes it again."
      title={`Doctors' full names to check (${shown.length})`}
    >
      {problem ? <p className="border-b border-rose-200 bg-rose-50 px-5 py-3 text-sm text-rose-800">{problem}</p> : null}
      <div className="hidden md:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[30%]" />
            <col className="w-[30%]" />
            <col className="w-[12%]" />
            <col className="w-[28%]" />
          </colgroup>
          <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Doctor</th>
              <th className="px-4 py-3">Read off the board</th>
              <th className="px-4 py-3">Match</th>
              <th className="px-4 py-3">Decision</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr className="border-t border-slate-200 align-top" key={row.customerId}>
                <td className="break-words px-4 py-3">
                  <p className="font-bold text-slate-900" dir="auto">
                    {row.fullName}
                  </p>
                  <p className="mt-1 text-xs text-slate-500" dir="auto">
                    Now: {row.currentName}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {row.repName}, {cairoDateTime(row.heldAt)}
                  </p>
                </td>
                <td className="break-words px-4 py-3 text-slate-700" dir="auto">
                  {board(row)}
                </td>
                <td className="px-4 py-3 font-bold text-slate-900">{match(row)}</td>
                <td className="px-4 py-3">{actions(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="divide-y divide-slate-200 md:hidden">
        {shown.map((row) => (
          <div className="space-y-2 px-4 py-4" key={row.customerId}>
            <p className="break-words font-bold text-slate-900" dir="auto">
              {row.fullName}
            </p>
            <p className="break-words text-xs text-slate-500" dir="auto">
              Now: {row.currentName}
            </p>
            <p className="text-xs text-slate-500">
              {row.repName}, {cairoDateTime(row.heldAt)}
            </p>
            <p className="break-words text-sm text-slate-700" dir="auto">
              Board: {board(row)} · <span className="font-bold">{match(row)}</span>
            </p>
            {actions(row)}
          </div>
        ))}
      </div>
    </AdminTableShell>
  );
}
