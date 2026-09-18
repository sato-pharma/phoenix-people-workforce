"use client";

import { useCallback, useState } from "react";

import { BrickMoveRefreshStatus, useBrickMoveRefresh } from "@/components/sales/brick-move-refresh";
import { describeBrickSalesMove, parseBrickSalesMove } from "@/lib/sales/master-data/brick-move-result";
import type { HeldMappingChange } from "@/lib/sales/mapping-guard";

// ─────────────────────────────────────────────────────────────────────────────
// Mapping guard — the screen where a held change is released or refused.
//
// IT FITS BY CONSTRUCTION. `w-full table-fixed` over a `<colgroup>` of PERCENTAGES, so the table is
// the container's width at every viewport and there is no min-width floor for a horizontal scroller
// to hide. Five columns, not eight: the kind sits under the subject and the timestamp under the
// writer, because the golden rule says fit by MERGING columns, never by shrinking type. Long
// pharmacy names WRAP, which the rule permits; nothing is cut short, which it forbids.
//
// Mobile gets cards, never this table — the admin shell rule.
//
// SQUARE EDGES throughout. No radius anywhere in this file, deliberately: tokens.css still defaults
// --phx-radius to 4px, so a component that inherits a sibling's rounding inherits the bug with it.
//
// THE ROW SHOWS WHAT DID NOT HAPPEN. "Now" is what the map says today and is the truth; "Wanted" is
// what the blocked change asked for. Getting these the wrong way round would invite him to approve
// the state he already has, so they are labelled rather than implied by position.
// ─────────────────────────────────────────────────────────────────────────────

const headBase =
  "px-2 py-2 align-bottom text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500";
const headCell = `${headBase} text-left`;
const bodyCell = "px-2 py-2 align-top text-sm text-slate-700 break-words";

// THE TIME IS FORMATTED ON THE SERVER, in `listHeldMappingChanges`, and printed here verbatim.
//
// Asking the reader's own ICU build for a short month name renders "Sep" on one browser and "Sept"
// on another, because CLDR 42 changed it, and React discards the server HTML over that one
// character — hydration error #418. It was live on the visits page until 2026-09-08 and it only
// ever shows up in September, which is now.

function Movement({ from, to }: { from: string; to: string }) {
  return (
    <div className="space-y-1">
      <div className="text-phx-2xs uppercase tracking-[0.12em] text-slate-400">Now</div>
      <div className="font-semibold text-[#0B0B0B]">{from}</div>
      <div className="text-phx-2xs uppercase tracking-[0.12em] text-slate-400">Wanted</div>
      <div className="text-slate-600">{to}</div>
    </div>
  );
}

function Decide({
  busy,
  onDecide,
}: {
  busy: boolean;
  onDecide: (decision: "approved" | "rejected") => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      <button
        className="border border-emerald-700 bg-emerald-700 px-2 py-1 text-phx-2xs font-bold uppercase tracking-[0.12em] text-white disabled:opacity-50"
        disabled={busy}
        onClick={() => onDecide("approved")}
        type="button"
      >
        Allow
      </button>
      <button
        className="border border-slate-300 bg-white px-2 py-1 text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-700 disabled:opacity-50"
        disabled={busy}
        onClick={() => onDecide("rejected")}
        type="button"
      >
        Keep as is
      </button>
    </div>
  );
}

// What an Allow did beyond the map row: a pharmacy a brick move held takes its open-month sales
// with it, in the same step as the approval.
type SalesNotice = { subject: string; lines: string[] };

function SalesMovedNotice({ notice }: { notice: SalesNotice }) {
  return (
    <div className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">
      <p className="font-semibold">{notice.subject} was allowed, and its open-month sales moved with it.</p>
      <ul className="mt-1 space-y-1">
        {notice.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

export function MappingGuardReview({ initialHolds }: { initialHolds: HeldMappingChange[] }) {
  const [holds, setHolds] = useState(initialHolds);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [salesNotice, setSalesNotice] = useState<SalesNotice | null>(null);
  const refresh = useBrickMoveRefresh();
  const { run: rebuildMovedFiles } = refresh;

  const decide = useCallback(async (holdId: number, decision: "approved" | "rejected") => {
    setBusyId(holdId);
    setError(null);
    setSalesNotice(null);
    const subject = holds.find((hold) => hold.id === holdId)?.subject ?? "The pharmacy";
    try {
      const response = await fetch("/api/sales/mapping-guard/decide", {
        body: JSON.stringify({ decision, holdId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        holds?: HeldMappingChange[];
        brickMove?: unknown;
      };
      if (!response.ok || !payload.success) {
        setError(payload.error ?? "That did not go through.");
        // A 409 means somebody decided it already, so the list on screen is the stale thing.
        if (response.status === 409) setHolds((current) => current.filter((hold) => hold.id !== holdId));
        return;
      }
      setHolds(payload.holds ?? []);
      const brickMove = parseBrickSalesMove(payload.brickMove);
      if (brickMove) {
        const lines = describeBrickSalesMove(brickMove);
        setSalesNotice({ lines: lines.length > 0 ? lines : ["It had no sales in an open month."], subject });
        if (brickMove.pendingFiles > 0) void rebuildMovedFiles();
      }
    } catch {
      setError("That did not go through.");
    } finally {
      setBusyId(null);
    }
  }, [holds, rebuildMovedFiles]);

  const notices = (
    <>
      {error ? (
        <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
      ) : null}
      {salesNotice ? <SalesMovedNotice notice={salesNotice} /> : null}
      <BrickMoveRefreshStatus refresh={refresh} />
    </>
  );

  if (holds.length === 0) {
    return (
      <div className="space-y-3">
        {notices}
        <div className="border border-phx-line bg-white px-4 py-8 text-center">
          <p className="text-sm font-semibold text-[#0B0B0B]">Nothing is waiting.</p>
          <p className="mt-1 text-sm text-slate-600">
            Every customer, brick and area re-mapping has gone through. You are told here only when one
            overwrites a decision of yours or moves a customer to another region.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {notices}

      <p className="text-sm text-slate-600">
        {holds.length === 1
          ? "One change is held. Nothing has been altered."
          : `${holds.length} changes are held. Nothing has been altered.`}{" "}
        Allow applies the change. Keep as is refuses it and leaves the mapping exactly where it stands.
        Allowing a pharmacy that a brick move held also moves its sales in every open month; a published
        month never changes.
      </p>

      {/* Desktop: the fitting table. Five columns, no horizontal scroller. */}
      <div className="hidden border border-phx-line bg-white md:block">
        <table className="w-full table-fixed border-separate border-spacing-0">
          <colgroup>
            <col style={{ width: "24%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "28%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "12%" }} />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/70">
              <th className={headCell}>What</th>
              <th className={headCell}>Change</th>
              <th className={headCell}>Why it was stopped</th>
              <th className={headCell}>Changed by</th>
              <th className={headCell}>Decide</th>
            </tr>
          </thead>
          <tbody>
            {holds.map((hold) => (
              <tr className="border-b border-slate-100" key={hold.id}>
                <td className={`${bodyCell} font-semibold text-[#0B0B0B]`}>
                  {hold.subject}
                  <div className="mt-1 text-phx-2xs font-normal uppercase tracking-[0.12em] text-slate-400">
                    {hold.kind}
                  </div>
                </td>
                <td className={bodyCell}>
                  <Movement from={hold.from} to={hold.to} />
                </td>
                <td className={bodyCell}>
                  <ul className="space-y-1">
                    {hold.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </td>
                <td className={bodyCell}>
                  {hold.writer}
                  <div className="mt-1 text-phx-2xs text-slate-400">{hold.when}</div>
                </td>
                <td className={bodyCell}>
                  <Decide busy={busyId === hold.id} onDecide={(decision) => decide(hold.id, decision)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: cards, never the table. */}
      <div className="space-y-2 md:hidden">
        {holds.map((hold) => (
          <div className="border border-phx-line bg-white p-3" key={hold.id}>
            <p className="text-sm font-semibold text-[#0B0B0B]">{hold.subject}</p>
            <p className="text-phx-2xs uppercase tracking-[0.12em] text-slate-400">{hold.kind}</p>
            <div className="mt-2 text-sm">
              <Movement from={hold.from} to={hold.to} />
            </div>
            <ul className="mt-2 space-y-1 text-sm text-slate-700">
              {hold.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <p className="mt-2 text-phx-2xs text-slate-400">
              {hold.writer} · {hold.when}
            </p>
            <div className="mt-3">
              <Decide busy={busyId === hold.id} onDecide={(decision) => decide(hold.id, decision)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
