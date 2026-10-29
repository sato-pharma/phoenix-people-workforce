"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { describeDirectOrderBasketUnits } from "@/lib/direct-orders/basket-label";
import type { HeldDirectOrderRow } from "@/lib/direct-orders/service";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { humanizeCode } from "@/lib/format/code-label";
import { cn } from "@/lib/utils";
import {
  phxButtonApproveDenseClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { PortalDesktopTable, PortalResponsiveDataList } from "@/components/employee-portal/portal-primitives";
import { adminPanelClassName, adminPanelHeaderClassName, adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

type Props = { rows: HeldDirectOrderRow[] };

// Why it is held, at a glance. `code_conflict` is amber rather than grey on purpose: a real code
// that does not fit is a more interesting problem than no code at all, and it is the one an admin
// should look at first.
const GROUND_TONE: Record<string, string> = {
  unproven: "bg-slate-200 text-slate-600",
  code_conflict: "bg-amber-100 text-amber-800",
  pharmacy_rejected: "bg-rose-100 text-rose-800",
  admin_released: "bg-emerald-100 text-emerald-800",
  code_proven: "bg-emerald-100 text-emerald-800",
  verified: "bg-emerald-100 text-emerald-800",
};

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

const cairoStamp = (iso: string | null) =>
  iso
    ? stableEnGbFormatter({
        timeZone: "Africa/Cairo",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso))
    : "—";

/**
 * The Held Desk (spec C3 — docs/specs/direct-orders-v2.md): every direct order parked outside
 * the approval flow, oldest first, with the one action the owner asked for — select requests,
 * press the button, and each requester gets ONE email by name (CC: SFE, direct manager, CEO)
 * saying the request is held until they bring a valid pharmacy code.
 */
export function HeldDesk({ rows }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [renameOn, setRenameOn] = useState<Record<string, boolean>>({});

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const selectedCount = useMemo(() => rows.filter((row) => selected.has(row.id)).length, [rows, selected]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)));
  }

  // Decisions are PHARMACY-level, not request-level — "I know this pharmacy is real" has to cover
  // its sibling orders and the next one submitted, or every reorder re-freezes behind the same
  // unanswered question. So the desk groups here, and each panel states how many orders it moves.
  const pharmacies = useMemo(() => {
    const byId = new Map<string, { rows: HeldDirectOrderRow[]; head: HeldDirectOrderRow }>();
    for (const row of rows) {
      const existing = byId.get(row.pharmacyId);
      if (existing) existing.rows.push(row);
      else byId.set(row.pharmacyId, { rows: [row], head: row });
    }
    return [...byId.values()];
  }, [rows]);

  async function decide(
    pharmacyId: string,
    body: Record<string, unknown>,
    successMessage: (result: Record<string, unknown>) => string,
  ) {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const res = await fetch("/api/direct-orders/held/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pharmacyId, ...body }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.success !== true) {
        throw new Error(String(data.message ?? "Could not record the decision."));
      }
      setOk(successMessage(data));
      setReasons((prev) => ({ ...prev, [pharmacyId]: "" }));
      router.refresh();
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function sendNotices() {
    setError(null);
    setOk(null);
    const requestIds = rows.filter((row) => selected.has(row.id)).map((row) => row.id);
    if (requestIds.length === 0) {
      setError("Select at least one held request first.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/direct-orders/held/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestIds }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        message?: string;
        sent?: number;
        skipped?: Array<{ requestId: string; reason: string }>;
      };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not send the held notices.");
      const skippedNote = data.skipped?.length ? ` (${data.skipped.length} skipped — no longer held)` : "";
      setOk(`Sent ${data.sent ?? 0} notice${(data.sent ?? 0) === 1 ? "" : "s"}${skippedNote}. Each went as one email — requester in To, SFE + manager + CEO in CC.`);
      setSelected(new Set());
      router.refresh();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const urgency = (days: number) =>
    days <= 2 ? "bg-rose-100 text-rose-800" : days <= 6 ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600";

  if (rows.length === 0) {
    return (
      <section className={`border border-phx-line bg-white px-4 py-8 text-center ${adminSoftDepthClassName}`}>
        <p className="text-sm font-bold text-slate-600">No held direct orders.</p>
        <p className="mt-1 text-phx-sm text-slate-400">
          Every submitted request is on a venue the master database recognises.
        </p>
      </section>
    );
  }

  return (
    <section className={adminPanelClassName}>
      <header className={`${adminPanelHeaderClassName} flex flex-wrap items-center justify-between gap-3 px-4 py-2.5`}>
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">
          Held requests — {rows.length}
        </h3>
        <button
          type="button"
          disabled={busy || selectedCount === 0}
          onClick={sendNotices}
          className="bg-orange-500 px-3 py-1.5 text-phx-sm font-black uppercase tracking-wider text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-400"
        >
          {busy ? "Sending…" : `Notify requester${selectedCount === 1 ? "" : "s"} (${selectedCount})`}
        </button>
      </header>

      {error ? <p className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700">{error}</p> : null}
      {ok ? <p className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700">{ok}</p> : null}

      <PortalResponsiveDataList
        empty={null}
        getKey={(row) => row.id}
        items={rows}
        renderCard={(row) => (
          <label className="block p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words text-sm font-black text-slate-900">{row.requesterName}</p>
                <p className="break-words text-phx-xs text-slate-500">{row.requesterRole}</p>
              </div>
              <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} aria-label={`Select ${row.requesterName}'s request`} />
            </div>
            <p className="mt-2 break-words text-sm font-semibold text-slate-800" dir="auto">
              {row.pharmacyName}
            </p>
            <p className="break-words text-phx-sm text-slate-600">
              {describeDirectOrderBasketUnits(row, row.items)} · {money(row.salesValue)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-phx-xs text-slate-500">
              <span>Held {cairoStamp(row.heldAt)}</span>
              <span className={`px-1.5 py-0.5 font-black ${urgency(row.daysRemaining)}`}>
                expires in {row.daysRemaining}d
              </span>
              <span>notice: {row.lastNoticeAt ? cairoStamp(row.lastNoticeAt) : "never"}</span>
            </div>
          </label>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                <col className="w-[5%]" />
                <col className="w-[17%]" />
                <col className="w-[20%]" />
                <col className="w-[20%]" />
                <col className="w-[13%]" />
                <col className="w-[12%]" />
                <col className="w-[13%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-phx-line text-phx-xs font-black uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all held requests" />
                </th>
                <th className="px-3 py-2">Requester</th>
                <th className="px-3 py-2">Venue</th>
                <th className="px-3 py-2">Order</th>
                <th className="px-3 py-2">Held since</th>
                <th className="px-3 py-2">Expires in</th>
                <th className="px-3 py-2">Last notice</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-[#f1f4f6] align-top hover:bg-orange-50/40">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(row.id)}
                      onChange={() => toggle(row.id)}
                      aria-label={`Select ${row.requesterName}'s request`}
                    />
                  </td>
                  <td className="break-words px-3 py-2">
                    <p className="font-bold text-slate-900">{row.requesterName}</p>
                    <p className="text-phx-xs text-slate-500">{row.requesterRole}</p>
                  </td>
                  <td className="break-words px-3 py-2 font-semibold text-slate-800" dir="auto">
                    {row.pharmacyName}
                  </td>
                  <td className="break-words px-3 py-2 text-slate-700">
                    {/* Each product with its own units — a basket has no single quantity. */}
                    <p>{describeDirectOrderBasketUnits(row, row.items)}</p>
                    <p className="font-bold text-slate-900">{money(row.salesValue)}</p>
                  </td>
                  <td className="break-words px-3 py-2 text-slate-600">{cairoStamp(row.heldAt)}</td>
                  <td className="px-3 py-2">
                    <span className={`px-1.5 py-0.5 text-phx-xs font-black ${urgency(row.daysRemaining)}`}>
                      {row.daysRemaining} day{row.daysRemaining === 1 ? "" : "s"}
                    </span>
                  </td>
                  <td className="break-words px-3 py-2 text-slate-600">{row.lastNoticeAt ? cairoStamp(row.lastNoticeAt) : "never"}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />

      {/* ── WHY each pharmacy is held, and the three rulings ────────────────────────────────
          The desk used to show a name, a date and a countdown — nothing about the CODE, which is
          the one fact that decides whether an order should be held at all. An admin had to leave
          the page to learn anything actionable, so orders sat until the 14-day clock killed them.

          Cards on both breakpoints, deliberately: this is a decision surface, not a data table,
          and the reason box has to sit beside the button that requires it. */}
      <div className="space-y-3 border-t border-phx-line p-3">
        <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
          Decide — {pharmacies.length} pharmac{pharmacies.length === 1 ? "y" : "ies"}
        </p>
        {pharmacies.map(({ head, rows: pharmacyRows }) => {
          const candidate = head.nameCodeCandidates[0] ?? null;
          const reason = reasons[head.pharmacyId] ?? "";
          const orderCount = pharmacyRows.length;
          return (
            <article key={head.pharmacyId} className="border border-phx-line p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-black text-slate-900" dir="auto">
                    {head.pharmacyName}
                  </p>
                  <p className="text-phx-xs text-slate-500">
                    {orderCount} held order{orderCount === 1 ? "" : "s"} ·{" "}
                    {money(pharmacyRows.reduce((sum, row) => sum + row.salesValue, 0))}
                  </p>
                </div>
                <span className={`px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-wide ${GROUND_TONE[head.holdGround] ?? "bg-slate-200 text-slate-600"}`}>
                  {humanizeCode(head.holdGround)}
                </span>
              </div>

              <p className="mt-2 text-phx-sm text-slate-700">{head.holdGroundNote}</p>

              {/* Declared vs mapped, side by side — the comparison this desk never showed. */}
              <dl className="mt-2 space-y-1 text-phx-xs">
                <div className="flex flex-wrap gap-x-2">
                  <dt className="font-black uppercase tracking-wider text-slate-400">Declared</dt>
                  <dd className="text-slate-700">
                    brick {head.declaredBrickId ?? "—"} · area {head.declaredAreaCode ?? "—"}
                  </dd>
                </div>
                {head.distributorCodes.length === 0 ? (
                  <div className="text-slate-500">No distributor code on file.</div>
                ) : (
                  head.distributorCodes.map((pair) => (
                    <div key={`${pair.distributorCode}-${pair.customerCode}`} className="flex flex-wrap gap-x-2">
                      <dt className="font-black uppercase tracking-wider text-slate-400">
                        {pair.distributorName || pair.distributorCode}
                      </dt>
                      <dd className="text-slate-700">
                        {pair.customerCode} → brick {pair.mappedBrickId ?? "unmapped"} · area{" "}
                        {pair.mappedAreaCode ?? "unmapped"}
                      </dd>
                    </div>
                  ))
                )}
              </dl>

              {head.holdReleaseGround ? (
                <p className={`mt-2 border border-slate-200 bg-slate-50 px-2 py-1.5 text-phx-xs text-slate-600 ${adminRecessedDepthClassName}`}>
                  Already ruled <b>{humanizeCode(head.holdReleaseGround)}</b> on{" "}
                  {cairoStamp(head.holdReleaseDecidedAt)} — {head.holdReleaseReason}
                </p>
              ) : null}

              {/* The wrong-field repair: one click links the code AND fixes retail attribution.
                  Auto-releasing instead would enter the chain with still no code on file. */}
              {candidate ? (
                <div className="mt-2 border border-emerald-300 bg-emerald-50 px-3 py-2">
                  <p className="text-phx-sm font-black text-emerald-900">
                    This pharmacy&apos;s NAME is a real {candidate.distributorName} customer code.
                  </p>
                  <p className="mt-0.5 text-phx-sm text-emerald-800" dir="auto">
                    {candidate.customerCode} · {candidate.customerName}
                    {candidate.areaCode ? ` · area ${candidate.areaCode}` : ""}
                  </p>
                  <label className="mt-1.5 flex items-center gap-2 text-phx-xs text-emerald-900">
                    <input
                      type="checkbox"
                      checked={renameOn[head.pharmacyId] !== false}
                      onChange={(event) =>
                        setRenameOn((prev) => ({ ...prev, [head.pharmacyId]: event.target.checked }))
                      }
                    />
                    Also rename the pharmacy to &quot;{candidate.customerName}&quot;
                  </label>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      decide(
                        head.pharmacyId,
                        {
                          decision: "link_code",
                          distributorCode: candidate.distributorCode,
                          customerCode: candidate.customerCode,
                          renameToCustomerName: renameOn[head.pharmacyId] !== false,
                        },
                        (result) =>
                          `Code linked. ${Number(result.released ?? 0)} order(s) moved into the approval chain.`,
                      )
                    }
                    className={cn(
                      phxButtonApproveDenseClassName,
                      "mt-2 px-3 py-1.5 text-phx-sm font-black uppercase tracking-wider disabled:bg-slate-300",
                    )}
                  >
                    Link this code
                  </button>
                </div>
              ) : null}

              <textarea
                value={reason}
                onChange={(event) => setReasons((prev) => ({ ...prev, [head.pharmacyId]: event.target.value }))}
                rows={2}
                placeholder="Reason (required for both buttons below)…"
                className={`${phxTextareaClassName} mt-2`}
                dir="auto"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    decide(head.pharmacyId, { decision: "release", reason }, (result) =>
                      `Released ${Number(result.released ?? 0)} order(s) into the approval chain.`,
                    )
                  }
                  className="bg-slate-900 px-3 py-1.5 text-phx-sm font-black uppercase tracking-wider text-white hover:bg-black disabled:bg-slate-300"
                >
                  Release {orderCount} order{orderCount === 1 ? "" : "s"} to SFE
                </button>
                <button
                  type="button"
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    decide(head.pharmacyId, { decision: "keep", reason }, () => "Recorded — the request stays held.")
                  }
                  className="border border-slate-400 px-3 py-1.5 text-phx-sm font-black uppercase tracking-wider text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Keep held
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
