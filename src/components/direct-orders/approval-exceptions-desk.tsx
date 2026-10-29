"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { describeDirectOrderBasketUnits } from "@/lib/direct-orders/basket-label";
import type { DirectOrderApprovalExceptionRow } from "@/lib/direct-orders/service";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { adminPanelClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

type Props = { rows: DirectOrderApprovalExceptionRow[] };

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

/**
 * The Approval Exceptions desk (task #90 / Priority 7).
 *
 * Each row is an order nobody can act on: its next rung is addressed to an HR_ID the employee
 * directory has no record of, so it matches no session and appears in no Needs Action queue. The
 * one action re-addresses that rung to somebody who exists. It does NOT approve anything — the
 * order still owes exactly the approvals it owed before, from the same seats.
 *
 * The suggested approver is PRE-FILLED BUT NOT PRE-CONFIRMED. The directory is what was wrong in
 * the first place, so an admin reads the name and decides; a one-click "apply the suggestion" would
 * be the system repairing its own bad data with more of its own data.
 */
export function ApprovalExceptionsDesk({ rows }: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [approvers, setApprovers] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((row) => [row.stepId, row.suggestedApproverHrId ?? ""])),
  );
  const [reasons, setReasons] = useState<Record<string, string>>({});

  async function repair(row: DirectOrderApprovalExceptionRow) {
    const newApproverHrId = (approvers[row.stepId] ?? "").trim();
    const reason = (reasons[row.stepId] ?? "").trim();
    // Checked here so the person is told immediately rather than after a round trip. The service
    // requires both again — this is a convenience, never the gate.
    if (!newApproverHrId) {
      setError("Enter the HR ID of the person this approval should go to.");
      return;
    }
    if (!reason) {
      setError("Enter a reason. This changes who an in-flight order is waiting on, and it is recorded.");
      return;
    }

    setBusyId(row.stepId);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(`/api/direct-orders/${encodeURIComponent(row.requestId)}/repair-rung`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stepId: row.stepId, newApproverHrId, reason }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not repair this approval rung.");
      setOk(`Step ${row.stepOrder} is now with ${newApproverHrId}. Both they and the requester have been told.`);
      router.refresh();
    } catch (repairError) {
      setError(repairError instanceof Error ? repairError.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  }

  if (rows.length === 0) {
    return (
      <div className={`border border-phx-line bg-white px-4 py-10 text-center ${adminSoftDepthClassName}`}>
        <p className="text-sm font-bold text-slate-900">No stuck approvals</p>
        <p className="mt-1 text-xs text-slate-500">
          Every in-flight order&apos;s next approval is addressed to somebody the directory knows.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="px-1 text-phx-sm leading-5 text-slate-500">
        {rows.length} {rows.length === 1 ? "order is" : "orders are"} waiting on an employee record that no longer
        exists. Re-addressing a rung does not approve anything — the order still needs the same approvals, from the
        same seats.
      </p>

      {error ? <p className="px-1 text-sm font-semibold text-rose-600">{error}</p> : null}
      {ok ? <p className="px-1 text-sm font-semibold text-emerald-600">{ok}</p> : null}

      {rows.map((row) => (
        <section key={row.stepId} className={adminPanelClassName}>
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <div className="min-w-0">
              {/* Each product with its own units — a basket has no single quantity. Wrapped, never
                  truncated: a basket's label is longer than the header, and an ellipsis would hide
                  the very product the value is for. */}
              <p className="break-words text-sm font-bold text-slate-900">
                {describeDirectOrderBasketUnits(row, row.items)}
              </p>
              <p className="break-words text-phx-xs text-slate-500">
                {row.requesterName} · {row.pharmacyName}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm font-black tabular-nums text-slate-950">{money(row.salesValue)}</p>
              <p className="text-phx-xs font-bold text-rose-600">
                stuck {row.daysStuck} {row.daysStuck === 1 ? "day" : "days"}
              </p>
            </div>
          </header>

          <div className="space-y-3 px-4 py-3">
            <p className="text-phx-sm leading-5 text-slate-600">
              Step {row.stepOrder} is addressed to{" "}
              <span className="font-black text-rose-700">{row.unresolvedApproverHrId}</span>, who is not in the
              employee directory. {/* The HR ID is shown rather than hidden: the record itself usually
              needs fixing too, and an admin cannot do that without knowing which one it is. */}
              <Link
                href={`/admin/direct-orders/${encodeURIComponent(row.requestId)}`}
                className="ml-1 font-bold text-orange-600 hover:text-orange-700"
              >
                Open the order →
              </Link>
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="block text-phx-xs font-black uppercase tracking-wider text-slate-500">
                  Re-address to (HR ID)
                </span>
                <input
                  value={approvers[row.stepId] ?? ""}
                  onChange={(event) =>
                    setApprovers((prev) => ({ ...prev, [row.stepId]: event.target.value }))
                  }
                  placeholder="e.g. B-185"
                  className={`${phxFieldClassName} mt-1`}
                />
                {row.suggestedApproverName ? (
                  <span className="mt-1 block text-phx-xs text-slate-500">
                    Today&apos;s directory says {row.requesterName} reports to {row.suggestedApproverName}
                    {row.suggestedApproverJobTitle ? ` (${row.suggestedApproverJobTitle})` : ""} — check before
                    confirming.
                  </span>
                ) : (
                  <span className="mt-1 block text-phx-xs text-amber-700">
                    Today&apos;s directory cannot resolve a manager for {row.requesterName} either. The employee
                    record needs fixing as well as this order.
                  </span>
                )}
              </label>

              <label className="block">
                <span className="block text-phx-xs font-black uppercase tracking-wider text-slate-500">
                  Reason (recorded)
                </span>
                <input
                  value={reasons[row.stepId] ?? ""}
                  onChange={(event) => setReasons((prev) => ({ ...prev, [row.stepId]: event.target.value }))}
                  placeholder="e.g. previous manager left in June; line now reports to…"
                  className={`${phxFieldClassName} mt-1`}
                />
              </label>
            </div>

            <button
              type="button"
              disabled={busyId === row.stepId}
              onClick={() => repair(row)}
              className="min-h-[44px] border border-slate-900 bg-slate-900 px-4 text-phx-sm font-black text-white disabled:opacity-40"
            >
              {busyId === row.stepId ? "Re-addressing…" : "Re-address this rung"}
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}
