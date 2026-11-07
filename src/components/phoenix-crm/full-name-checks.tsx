"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { CrmCardsOnPhone, CrmTable, crmTdClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import { phxButtonApproveClassName, phxButtonDangerClassName } from "@/components/ui/form-tokens";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { HeldFullName } from "@/lib/phoenix-crm/pm-name-rules";

/**
 * PM customers' full names waiting for a decision (owner, 2026-11-07, pm-name-rules.ts): the name a rep
 * wrote matched what was read off the signboard or timetable under 60%, or a validated customer's board was
 * never read. Approve renames the customer; reject keeps the old name and the customer stays blocked
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
      description="A rep wrote a PM customer's first, middle and last name, and it matched the signboard or timetable under 60%, or the customer is validated and nothing was read off the board. Approve renames the customer. Reject keeps the old name, and the customer stays out of the plan and Add visit until the rep writes it again."
      title={`PM full names to check (${shown.length})`}
    >
      {problem ? <p className="border-b border-rose-200 bg-rose-50 px-5 py-3 text-sm text-rose-800">{problem}</p> : null}
      <CrmCardsOnPhone>
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
      </CrmCardsOnPhone>
      <CrmTable columns={["30%", "30%", "12%", "28%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>Customer</th>
            <th className={crmThClassName}>Read off the board</th>
            <th className={crmThClassName}>Match</th>
            <th className={crmThClassName}>Decision</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.customerId}>
              <td className={crmTdClassName}>
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
              <td className={crmTdClassName} dir="auto">
                {board(row)}
              </td>
              <td className={crmTdClassName}>{match(row)}</td>
              <td className={crmTdClassName}>{actions(row)}</td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
    </AdminTableShell>
  );
}
