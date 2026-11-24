"use client";

/**
 * Phoenix CRM — the Super Admin's late visits (owner, 24 Nov 2026: "never any visit to be lost from either a rep or
 * from the manager", then "SUPER ADMIN APPROVE IT ONLY SUPER ADMIN").
 *
 * A visit a phone held for want of signal that could not be sent inside its two hours, or before the 02:00 close, is
 * filed whole and waits here. Approve enters it on the day it was PRESSED through the missed-record door, so every rule
 * that door keeps holds here too, and a refusal is that door's own sentence, shown on the row. Reject keeps it on file
 * as rejected. The person reads only "Sent for approval" on the phone.
 *
 * It fits the screen: a phone draws cards first, the desktop a `table-fixed` table whose colgroup and header row come
 * from ONE array. No `overflow-x`, no ellipsis.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, X } from "lucide-react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { CrmButton, CrmCardsOnPhone, CrmEmpty, CrmPill, CrmTable, crmTdClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import { utcDate } from "@/lib/format/cairo-datetime";
import { LATE_VISITS_ADMIN_PATH, type LateVisitItem, type LateVisitsBoard as Board } from "@/lib/phoenix-crm/late-visit-rules";

const COLUMNS = [
  { head: "Visit", width: "38%" },
  { head: "Who and when", width: "34%" },
  { head: "Decision", width: "28%" },
] as const;

export type LateVisitsTab = "waiting" | "decided";

function VisitCell({ item }: { item: LateVisitItem }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="break-words font-black text-slate-900" dir="auto">
        {item.customerName}
      </p>
      <div className="flex flex-wrap gap-1">
        <CrmPill tone={item.visitLabel === "Off plan" ? "warn" : "info"}>{item.visitLabel}</CrmPill>
      </div>
      {item.products.length > 0 ? (
        <p className="break-words text-xs text-slate-600" dir="auto">
          {item.products.join(" · ")}
        </p>
      ) : null}
      {item.comment ? (
        <p className="break-words text-xs text-slate-600" dir="auto">
          {item.comment}
        </p>
      ) : null}
    </div>
  );
}

function WhoCell({ item }: { item: LateVisitItem }) {
  return (
    <div className="min-w-0 space-y-1 text-xs text-slate-600">
      <p className="break-words text-sm font-black text-slate-900">{item.senderName}</p>
      <p className="break-words">{item.territoryName}</p>
      <p className="break-words font-bold text-slate-800">
        Pressed on {utcDate(`${item.pressedDay}T12:00:00Z`)}
        {item.pressedAtText ? `, ${item.pressedAtText} on the phone's clock` : ", the phone sent no time"}
      </p>
      <p className="break-words">Reached Phoenix {item.arrivedAtText}</p>
    </div>
  );
}

function DecisionCell({ item }: { item: LateVisitItem }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (item.status !== "pending") {
    return (
      <div className="min-w-0 space-y-1 text-xs text-slate-600">
        <CrmPill tone={item.status === "approved" ? "good" : "bad"}>{item.status === "approved" ? "Approved" : "Rejected"}</CrmPill>
        <p className="break-words">
          {item.decidedByName ? `By ${item.decidedByName}` : null}
          {item.decidedAtText ? `, ${item.decidedAtText}` : null}
        </p>
      </div>
    );
  }

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    setError(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/late-visits/decide", { id: item.id, decision }, "decided");
      router.refresh();
    } catch (failure) {
      // The missed-record door's own sentence: the same customer already visited that day, a leaver's day, and so on.
      setError(messageOf(failure));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap gap-2">
        <CrmButton busy={busy === "approve"} disabled={busy !== null} onClick={() => decide("approve")} size="sm" variant="success">
          <Check aria-hidden className="h-4 w-4" />
          Approve onto that day
        </CrmButton>
        <CrmButton busy={busy === "reject"} disabled={busy !== null} onClick={() => decide("reject")} size="sm" variant="danger">
          <X aria-hidden className="h-4 w-4" />
          Reject
        </CrmButton>
      </div>
      {error ? <p className="break-words text-xs font-bold text-rose-700">{error}</p> : null}
    </div>
  );
}

const LIST_TEXT: Record<LateVisitsTab, { title: string; description: string; empty: string }> = {
  waiting: {
    title: "Waiting for your decision",
    description:
      "Visits a phone kept for want of signal and sent after their day closed. Approve enters the visit on the day it was pressed, under the same rules as a missed record; Reject keeps it on file. The person reads only that it was sent for approval.",
    empty: "No late visit waits for you.",
  },
  decided: {
    title: "Decided in the last 30 days",
    description: "Every late visit you approved or rejected in the last 30 days, newest first.",
    empty: "Nothing was decided in the last 30 days.",
  },
};

export function LateVisitsBoard({ board, tab }: { board: Board; tab: LateVisitsTab }) {
  const items = tab === "decided" ? board.decided : board.pending;
  const text = LIST_TEXT[tab];
  const tabs: ReadonlyArray<{ key: LateVisitsTab; label: string }> = [
    { key: "waiting", label: `Waiting (${board.pending.length})` },
    { key: "decided", label: `Decided (${board.decided.length})` },
  ];
  return (
    <div className="min-w-0 space-y-4">
      <nav aria-label="Late visits" className="flex flex-wrap gap-2">
        {tabs.map((entry) => (
          <Link
            aria-current={entry.key === tab ? "page" : undefined}
            className={
              entry.key === tab
                ? "inline-flex min-h-10 items-center border border-orange-600 bg-orange-600 px-3 text-sm font-black text-white"
                : "inline-flex min-h-10 items-center border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 hover:border-slate-400"
            }
            href={`${LATE_VISITS_ADMIN_PATH}?tab=${entry.key}`}
            key={entry.key}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      <AdminTableShell description={text.description} title={`${text.title} (${items.length})`}>
        {items.length === 0 ? (
          <CrmEmpty title={text.empty} />
        ) : (
          <>
            <CrmCardsOnPhone>
              {items.map((item) => (
                <div className="min-w-0 space-y-3 px-4 py-4" key={item.id}>
                  <VisitCell item={item} />
                  <WhoCell item={item} />
                  <DecisionCell item={item} />
                </div>
              ))}
            </CrmCardsOnPhone>
            <CrmTable columns={[...COLUMNS.map((column) => column.width)]}>
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th className={crmThClassName} key={column.head}>
                      {column.head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className={crmTdClassName}>
                      <VisitCell item={item} />
                    </td>
                    <td className={crmTdClassName}>
                      <WhoCell item={item} />
                    </td>
                    <td className={crmTdClassName}>
                      <DecisionCell item={item} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </CrmTable>
          </>
        )}
      </AdminTableShell>
    </div>
  );
}
