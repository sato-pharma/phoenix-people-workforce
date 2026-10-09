"use client";

import { useCallback, useMemo, useState } from "react";

import { BrickMoveRefreshStatus, useBrickMoveRefresh } from "@/components/sales/brick-move-refresh";
import { describeBrickSalesMove, parseBrickSalesMove } from "@/lib/sales/master-data/brick-move-result";
import type { HeldMappingChange } from "@/lib/sales/mapping-guard";
import {
  describeMonth,
  formatEgp,
  type HoldDetail,
  type HoldDistributorFact,
  type SuggestionVerdict,
} from "@/lib/sales/mapping-guard-hold-shape";

// ─────────────────────────────────────────────────────────────────────────────
// Mapping guard — the screen where a held change is released or refused.
//
// IT FITS BY CONSTRUCTION. `w-full table-fixed` over a `<colgroup>` of PERCENTAGES, so the table is
// the container's width at every viewport and there is no min-width floor for a horizontal scroller
// to hide. The evidence a decision needs — what the distributor's own file says, and what the
// normalizer would answer — is a SECOND ROW spanning the table rather than four more columns,
// because the golden rule says fit by merging, never by shrinking type. Long pharmacy names and
// Arabic addresses WRAP, which the rule permits; nothing is cut short, which it forbids.
//
// Mobile gets cards, never this table — the admin shell rule.
//
// SQUARE EDGES throughout. No radius anywhere in this file, deliberately: tokens.css still defaults
// --phx-radius to 4px, so a component that inherits a sibling's rounding inherits the bug with it.
//
// THE ROW SHOWS WHAT DID NOT HAPPEN. "Now" is what the map says today and is the truth; "Wanted" is
// what the blocked change asked for. Getting these the wrong way round would invite him to approve
// the state he already has, so they are labelled rather than implied by position.
//
// 🔴 LOCKING IS WHY THIS SCREEN EXISTS NOW (owner, 2026-10-09: "add the lock button and the money on
// each hold row"). Neither answer used to decide the CUSTOMER: Allow writes the upload's own
// `sheet-verified`, so the next file that disagrees is held again, and Keep as is writes nothing to
// the mapping at all. Only confidence 100 is skipped outright by the monthly self-heal. So the lock
// is ON by default here and says in words what it does — turning it off is the exception, not the
// default he has to find.
// ─────────────────────────────────────────────────────────────────────────────

const headBase =
  "px-2 py-2 align-bottom text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500";
const headCell = `${headBase} text-left`;
const bodyCell = "px-2 py-2 align-top text-sm text-slate-700 break-words";
const microLabel = "text-phx-2xs uppercase tracking-[0.12em] text-slate-400";

// THE TIME IS FORMATTED ON THE SERVER, in `listHeldMappingChanges`, and printed here verbatim.
//
// Asking the reader's own ICU build for a short month name renders "Sep" on one browser and "Sept"
// on another, because CLDR 42 changed it, and React discards the server HTML over that one
// character — hydration error #418. It was live on the visits page until 2026-09-08 and it only
// ever shows up in September, which is now.

function Movement({ from, to }: { from: string; to: string }) {
  return (
    <div className="space-y-1">
      <div className={microLabel}>Now</div>
      <div className="font-semibold text-[#0B0B0B]">{from}</div>
      <div className={microLabel}>Wanted</div>
      <div className="text-slate-600">{to}</div>
    </div>
  );
}

/** What a release would re-credit, and in which months. Nothing is abbreviated away. */
function AtStake({ detail }: { detail: HoldDetail | undefined }) {
  const sales = detail?.sales ?? null;
  if (!sales || sales.rowCount === 0) {
    return <p className="text-sm text-slate-500">No tracked sales filed under this customer.</p>;
  }
  return (
    <div className="space-y-1">
      <div className="font-semibold text-[#0B0B0B]">{formatEgp(sales.trackedValue)}</div>
      <div className={microLabel}>{sales.months.length === 1 ? "in 1 month" : `in ${sales.months.length} months`}</div>
      {sales.restatedValue > 0 ? (
        <p className="border border-amber-200 bg-amber-50 px-2 py-1 text-phx-2xs text-amber-900">
          {formatEgp(sales.restatedValue)} of it sits in months already finished, so a release moves
          that credit to the other area in sheets a manager has already downloaded.
        </p>
      ) : null}
      <ul className="space-y-1 text-phx-2xs text-slate-600">
        {sales.months.map((month) => (
          <li key={month.period}>
            {describeMonth(month.period)} — {formatEgp(month.trackedValue)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the distributor's own file carried for this customer.
 *
 * "Add the column that have the address that came with the distributor ... and there is a
 * distributor that send their bricks ... get the address, the brick, the government. Very
 * important." (owner, 2026-10-09). It is the evidence behind the hold: the self-heal proposed the
 * move because the file itself resolved the pharmacy elsewhere, so this text is the case being made.
 */
function FiledByDistributor({ detail }: { detail: HoldDetail | undefined }) {
  const facts = detail?.filed ?? [];
  return (
    <div className="border border-phx-line bg-slate-50/60 p-3">
      <p className={microLabel}>What {detail?.distributorName ?? "the distributor"} filed</p>
      {detail?.storedAddress ? (
        <p className="mt-2 text-sm text-slate-700">
          <span className={microLabel}>Phoenix holds</span>
          <br />
          {detail.storedAddress}
        </p>
      ) : null}
      {facts.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">Nothing filed under this code yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {facts.map((fact) => (
            <li className="border-l-2 border-slate-300 pl-2 text-sm text-slate-700" key={keyOfFact(fact)}>
              <p className={microLabel}>
                {describeMonth(fact.period)} · {fact.rowsFiled === 1 ? "1 line" : `${fact.rowsFiled} lines`}
              </p>
              {fact.filedName ? <p className="font-semibold text-[#0B0B0B]">{fact.filedName}</p> : null}
              {fact.filedAddress ? <p>{fact.filedAddress}</p> : null}
              <p className="text-phx-2xs text-slate-500">
                {[
                  fact.filedBrickName ? `brick ${fact.filedBrickName}` : fact.filedBrickId ? `brick ${fact.filedBrickId}` : null,
                  fact.filedArea ? `territory ${fact.filedArea}` : null,
                  fact.filedRegion ? `governorate ${fact.filedRegion}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "no territory text in the file"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function keyOfFact(fact: HoldDistributorFact): string {
  return [fact.period, fact.filedName, fact.filedAddress, fact.filedBrickId, fact.filedArea, fact.filedRegion]
    .map((part) => part ?? "")
    .join("|");
}

const VERDICT_WORDS: Record<SuggestionVerdict, string> = {
  "agrees-with-change": "This backs the change: allowing it puts the pharmacy where the normalizer says it belongs.",
  "agrees-with-mapping": "This backs the mapping as it stands: keeping it as is matches the normalizer.",
  "none": "",
  "third-answer": "This matches NEITHER side: both Allow and Keep as is would leave it in the wrong place.",
};

/**
 * The normalizer's own answer — "add the normalizer to recommend and suggest" (owner, 2026-10-09).
 *
 * The free steps only: an already-mapped twin, the same address as a mapped pharmacy, one of our own
 * brick names inside the pharmacy name, plus AI answers already paid for. No AI call, so opening
 * this screen spends nothing — and the answer is the import's own pipeline rather than a second
 * opinion invented for this page.
 */
function NormalizerSays({ detail }: { detail: HoldDetail | undefined }) {
  const suggestion = detail?.suggestion ?? null;
  return (
    <div className="border border-phx-line bg-white p-3">
      <p className={microLabel}>What the normalizer suggests</p>
      {!suggestion ? (
        <p className="mt-2 text-sm text-slate-500">
          No suggestion: this pharmacy has no mapped twin, no matching address and no brick name in
          its own name, so the normalizer has nothing to go on and the answer is a ruling.
        </p>
      ) : (
        <div className="mt-2 space-y-1 text-sm text-slate-700">
          <p className="font-semibold text-[#0B0B0B]">{suggestion.label}</p>
          <p className="text-phx-2xs text-slate-500">
            {describeSuggestionSource(suggestion.source)}
            {suggestion.confidence === null ? "" : ` · confidence ${suggestion.confidence}`}
          </p>
          {suggestion.verdict === "third-answer" ? (
            <p className="border border-amber-200 bg-amber-50 px-2 py-1 text-phx-2xs text-amber-900">
              {VERDICT_WORDS["third-answer"]}
            </p>
          ) : (
            <p className="text-phx-2xs text-slate-600">{VERDICT_WORDS[suggestion.verdict]}</p>
          )}
        </div>
      )}
    </div>
  );
}

function describeSuggestionSource(source: string): string {
  if (source === "propagated") return "from a twin of this pharmacy that is already mapped";
  if (source === "address") return "from another mapped pharmacy at the same address";
  if (source === "place") return "from one of our own brick names inside the pharmacy name";
  if (source === "ai") return "from an answer already on file for this pharmacy";
  return source;
}

function Decide({
  busy,
  compact,
  onDecide,
}: {
  busy: boolean;
  compact?: boolean;
  onDecide: (decision: "approved" | "rejected") => void;
}) {
  return (
    <div className={compact ? "flex flex-wrap gap-1" : "flex flex-wrap gap-2"}>
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

/** The ceiling the route enforces, repeated here so the screen never sends a request it refuses. */
const MAX_PER_CLICK = 60;

export function MappingGuardReview({
  initialDetails,
  initialHolds,
}: {
  initialDetails?: Record<number, HoldDetail>;
  initialHolds: HeldMappingChange[];
}) {
  const [holds, setHolds] = useState(initialHolds);
  const [details] = useState<Record<number, HoldDetail>>(initialDetails ?? {});
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failures, setFailures] = useState<Array<{ holdId: number; reason?: string }>>([]);
  // ON by default, and deliberately: an unlocked answer does not survive the next upload.
  const [lock, setLock] = useState(true);
  const [salesNotice, setSalesNotice] = useState<SalesNotice | null>(null);
  const refresh = useBrickMoveRefresh();
  const { run: rebuildMovedFiles } = refresh;

  const lockable = useMemo(
    () => new Set(holds.filter((hold) => details[hold.id]?.lockable !== false).map((hold) => hold.id)),
    [details, holds],
  );

  const toggle = useCallback((holdId: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(holdId)) next.delete(holdId);
      else next.add(holdId);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((current) => {
      if (current.size > 0) return new Set<number>();
      return new Set(holds.slice(0, MAX_PER_CLICK).map((hold) => hold.id));
    });
  }, [holds]);

  const decide = useCallback(async (holdIds: number[], decision: "approved" | "rejected") => {
    if (holdIds.length === 0) return;
    setBusy(true);
    setBusyId(holdIds.length === 1 ? holdIds[0] : null);
    setError(null);
    setDone(null);
    setFailures([]);
    setSalesNotice(null);
    const only = holdIds.length === 1 ? holds.find((hold) => hold.id === holdIds[0]) : undefined;
    try {
      const response = await fetch("/api/sales/mapping-guard/decide", {
        body: JSON.stringify({ decision, holdIds, lock }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        holds?: HeldMappingChange[];
        decided?: number;
        locked?: number;
        failed?: Array<{ holdId: number; reason?: string }>;
        brickMoves?: Array<{ holdId: number; brickMove?: unknown }>;
      };

      if (Array.isArray(payload.holds)) setHolds(payload.holds);
      setSelected(new Set());

      if (!response.ok || !payload.success) {
        setError(payload.error ?? "That did not go through.");
        setFailures(payload.failed ?? []);
        return;
      }

      const decided = payload.decided ?? holdIds.length;
      const locked = payload.locked ?? 0;
      setDone(
        `${decided === 1 ? "One change was" : `${decided} changes were`} ${decision === "approved" ? "allowed" : "kept as they are"}` +
          (locked > 0
            ? `, and ${locked === 1 ? "that mapping is" : `${locked} of those mappings are`} locked: no upload can move ${locked === 1 ? "it" : "them"} again.`
            : ". Nothing was locked, so an upload may propose the same move again."),
      );
      setFailures(payload.failed ?? []);

      // EVERY move in the click, never just the first. One answer used to be one pharmacy; a
      // selection of sixty can move the sales of several, and reading `brickMoves[0]` would leave
      // the others' moved files unrebuilt — silently, because the screen would still report a move.
      const moves = (payload.brickMoves ?? []).flatMap((entry) => {
        const move = parseBrickSalesMove(entry.brickMove);
        return move ? [{ holdId: entry.holdId, move }] : [];
      });
      if (moves.length > 0) {
        const nameOf = (holdId: number) =>
          holds.find((hold) => hold.id === holdId)?.subject ?? only?.subject ?? "The pharmacy";
        setSalesNotice({
          lines: moves.flatMap(({ holdId, move }) => {
            const described = describeBrickSalesMove(move);
            const body = described.length > 0 ? described : ["It had no sales in an open month."];
            return moves.length === 1 ? body : body.map((line) => `${nameOf(holdId)}: ${line}`);
          }),
          subject: moves.length === 1 ? nameOf(moves[0].holdId) : `${moves.length} pharmacies`,
        });
        if (moves.some(({ move }) => move.pendingFiles > 0)) void rebuildMovedFiles();
      }
    } catch {
      setError("That did not go through.");
    } finally {
      setBusy(false);
      setBusyId(null);
    }
  }, [holds, lock, rebuildMovedFiles]);

  const lockNote = lock
    ? "Your answer will be locked on each customer you decide: it is stamped as your ruling, and the monthly upload skips a locked mapping outright."
    : "Your answer will NOT be locked. The next upload that disagrees can propose the same move again, and this row will come back.";

  const notices = (
    <>
      {error ? (
        <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
      ) : null}
      {done ? (
        <p className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">
          {done}
        </p>
      ) : null}
      {failures.length > 0 ? (
        <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-semibold">
            {failures.length === 1 ? "One change was not decided." : `${failures.length} changes were not decided.`}
          </p>
          <ul className="mt-1 space-y-1">
            {failures.map((failure) => (
              <li key={failure.holdId}>
                Hold {failure.holdId} — {failure.reason ?? "it had already been decided."}
              </li>
            ))}
          </ul>
        </div>
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

  const selectedIds = holds.filter((hold) => selected.has(hold.id)).map((hold) => hold.id);

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

      {/* The lock, and the selection's own buttons. Square, flat, and it wraps rather than scrolls. */}
      <div className="space-y-2 border border-phx-line bg-white p-3">
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            checked={lock}
            className="mt-1 h-4 w-4 border border-slate-400 accent-emerald-700"
            onChange={(event) => setLock(event.target.checked)}
            type="checkbox"
          />
          <span>
            <span className="font-semibold text-[#0B0B0B]">Lock my answer so no upload can change it again</span>
            <br />
            <span className="text-phx-2xs text-slate-600">{lockNote}</span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
          <button
            className="border border-slate-300 bg-white px-2 py-1 text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-700 disabled:opacity-50"
            disabled={busy}
            onClick={toggleAll}
            type="button"
          >
            {selected.size > 0 ? "Clear the selection" : `Select the first ${Math.min(holds.length, MAX_PER_CLICK)}`}
          </button>
          <span className="text-sm text-slate-600">
            {selected.size === 0
              ? "Tick the rows you want to answer together."
              : `${selected.size} selected${selected.size >= MAX_PER_CLICK ? ` — ${MAX_PER_CLICK} is the most one click can carry, so every answer is recorded` : ""}.`}
          </span>
          {selected.size > 0 ? (
            <Decide busy={busy} onDecide={(decision) => void decide(selectedIds, decision)} />
          ) : null}
        </div>
      </div>

      {/* Desktop: the fitting table. Five columns, no horizontal scroller. */}
      <div className="hidden border border-phx-line bg-white md:block">
        <table className="w-full table-fixed border-separate border-spacing-0">
          <colgroup>
            <col style={{ width: "4%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "14%" }} />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/70">
              <th className={headBase} scope="col">
                <span className="sr-only">Select</span>
              </th>
              <th className={headCell} scope="col">What</th>
              <th className={headCell} scope="col">Change</th>
              <th className={headCell} scope="col">Why it was stopped</th>
              <th className={headCell} scope="col">At stake</th>
              <th className={headCell} scope="col">Decide</th>
            </tr>
          </thead>
          <tbody>
            {holds.map((hold) => {
              const detail = details[hold.id];
              return [
                <tr key={`${hold.id}-row`}>
                  <td className={bodyCell}>
                    <input
                      aria-label={`Select ${hold.subject}`}
                      checked={selected.has(hold.id)}
                      className="h-4 w-4 border border-slate-400 accent-emerald-700"
                      disabled={busy}
                      onChange={() => toggle(hold.id)}
                      type="checkbox"
                    />
                  </td>
                  <td className={`${bodyCell} font-semibold text-[#0B0B0B]`}>
                    {detail?.storedName ?? hold.subject}
                    <div className={`mt-1 font-normal ${microLabel}`}>
                      {hold.kind} · {hold.subject}
                    </div>
                    {detail?.distributorName ? (
                      <div className="mt-1 text-phx-2xs font-normal text-slate-500">{detail.distributorName}</div>
                    ) : null}
                    {detail && detail.siblingPending > 0 ? (
                      <div className="mt-1 text-phx-2xs font-normal text-amber-800">
                        {detail.siblingPending === 1
                          ? "One more row is pending for this same customer."
                          : `${detail.siblingPending} more rows are pending for this same customer.`}
                      </div>
                    ) : null}
                    {detail?.lockable === false ? (
                      <div className="mt-1 text-phx-2xs font-normal text-slate-500">
                        A brick or area hold cannot be locked: only a customer mapping carries a ruling.
                      </div>
                    ) : null}
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
                    <p className="mt-2 text-phx-2xs text-slate-400">
                      {hold.writer} · {hold.when}
                    </p>
                  </td>
                  <td className={bodyCell}>
                    <AtStake detail={detail} />
                  </td>
                  <td className={bodyCell}>
                    <Decide
                      busy={busy && (busyId === hold.id || busyId === null)}
                      compact
                      onDecide={(decision) => void decide([hold.id], decision)}
                    />
                    {lock && lockable.has(hold.id) ? (
                      <p className="mt-1 text-phx-2xs text-emerald-800">Will be locked</p>
                    ) : null}
                  </td>
                </tr>,
                <tr className="border-b border-slate-200" key={`${hold.id}-evidence`}>
                  <td className="px-2 pb-3" colSpan={6}>
                    <div className="grid gap-2 lg:grid-cols-2">
                      <FiledByDistributor detail={detail} />
                      <NormalizerSays detail={detail} />
                    </div>
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: cards, never the table. */}
      <div className="space-y-2 md:hidden">
        {holds.map((hold) => {
          const detail = details[hold.id];
          return (
            <div className="border border-phx-line bg-white p-3" key={hold.id}>
              <label className="flex items-start gap-2">
                <input
                  aria-label={`Select ${hold.subject}`}
                  checked={selected.has(hold.id)}
                  className="mt-1 h-4 w-4 border border-slate-400 accent-emerald-700"
                  disabled={busy}
                  onChange={() => toggle(hold.id)}
                  type="checkbox"
                />
                <span>
                  <span className="text-sm font-semibold text-[#0B0B0B]">{detail?.storedName ?? hold.subject}</span>
                  <br />
                  <span className={microLabel}>
                    {hold.kind} · {hold.subject}
                  </span>
                </span>
              </label>
              {detail?.distributorName ? (
                <p className="mt-1 text-phx-2xs text-slate-500">{detail.distributorName}</p>
              ) : null}
              {detail && detail.siblingPending > 0 ? (
                <p className="mt-1 text-phx-2xs text-amber-800">
                  {detail.siblingPending === 1
                    ? "One more row is pending for this same customer."
                    : `${detail.siblingPending} more rows are pending for this same customer.`}
                </p>
              ) : null}
              <div className="mt-2 text-sm">
                <Movement from={hold.from} to={hold.to} />
              </div>
              <ul className="mt-2 space-y-1 text-sm text-slate-700">
                {hold.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <div className="mt-2">
                <AtStake detail={detail} />
              </div>
              <div className="mt-2 space-y-2">
                <FiledByDistributor detail={detail} />
                <NormalizerSays detail={detail} />
              </div>
              <p className="mt-2 text-phx-2xs text-slate-400">
                {hold.writer} · {hold.when}
              </p>
              <div className="mt-3">
                <Decide
                  busy={busy && (busyId === hold.id || busyId === null)}
                  onDecide={(decision) => void decide([hold.id], decision)}
                />
                {lock && lockable.has(hold.id) ? (
                  <p className="mt-1 text-phx-2xs text-emerald-800">Will be locked</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
