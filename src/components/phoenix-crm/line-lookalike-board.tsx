"use client";

/**
 * Phoenix CRM — the Place checks tab "Same customer, other line" (owner, 2026-11-16: "same customer diff rep
 * same area diff line", then "Fix rule + review list": "put the ready groups on a list for the Super Admin to
 * confirm one by one. Nothing is validated without that confirmation").
 *
 * The rule is `line-lookalikes.ts`. Each card is one pair: a customer still waiting on one line, and the
 * customer another line of the same area has validated under a name written another way. "Same customer"
 * validates the waiting row from the other line's places now; "Not the same" takes the pair off the list for
 * good. Nothing else on the card acts.
 *
 * 🔴 THE SUPER ADMIN'S ALONE, LAZY AND KEPT — drawn only on his board, read when the tab is first opened,
 * kept mounted afterwards. The route refuses everyone else as well.
 *
 * 🔴 THE SHARED FILTER BAR NARROWS IT: a pair stays when either of its two rows passes.
 */

import { useMemo, useState, type ReactNode } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { crmPost, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { countText } from "@/components/phoenix-crm/format";
import { CrmButton, CrmFacts, CrmLoadError, CrmLoading, CrmNote, CrmPill, CrmShowMore, CrmStat, CrmStatGrid } from "@/components/phoenix-crm/ui";
import type { LineLookalikeBoard, LineLookalikeRow, LineLookalikeSide, LineLookalikeSource } from "@/lib/phoenix-crm/line-lookalikes";
import { matchesValidationReviewFilters, type ValidationReviewFilters } from "@/lib/phoenix-crm/validation-review-filters";

const ROUTE = "/api/phoenix-crm/validation-reviews/line-lookalikes";

const PAIRS_PAGE = 20;

type Answer = "same" | "not_same";
type Saved = { answer: Answer; validated: boolean };

function sidePasses(row: LineLookalikeRow, side: LineLookalikeSide | LineLookalikeSource, filters: ValidationReviewFilters): boolean {
  const source = "placeCount" in side ? side : null;
  return matchesValidationReviewFilters(
    {
      repName: side.repName,
      line: side.line,
      region: row.region,
      listType: row.listType,
      customerName: side.name,
      territory: side.territory,
      speciality: side.speciality,
      placeLabel: null,
      address: source?.address ?? null,
      brickName: source?.brickName ?? null,
      areaName: row.areaName,
    },
    filters,
  );
}

function SideCard({ heading, side, children }: { heading: string; side: LineLookalikeSide; children?: ReactNode }) {
  return (
    <div className="min-w-0 space-y-2 border border-slate-200 bg-white p-3">
      <p className="break-words text-xs font-black uppercase tracking-wide text-slate-500">{heading}</p>
      <p className="break-words text-sm font-black text-slate-950" dir="auto">
        {side.name}
      </p>
      <p className="break-words text-xs font-semibold text-slate-700">
        {side.repName} · {side.territory}
      </p>
      {side.speciality ? <p className="break-words text-xs text-slate-500">{side.speciality}</p> : null}
      {children}
    </div>
  );
}

function PairCard({ row, onAnswered }: { row: LineLookalikeRow; onAnswered: (row: LineLookalikeRow, saved: Saved) => void }) {
  const [busy, setBusy] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answer = async (choice: Answer) => {
    setBusy(choice);
    setError(null);
    try {
      const saved = await crmPost<Saved>(ROUTE, { waitingCustomerId: row.waitingCustomerId, sourceCustomerId: row.sourceCustomerId, answer: choice }, "saved");
      onAnswered(row, saved);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-w-0 space-y-3 border-t-4 border-slate-200 px-4 py-4 first:border-t-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <CrmPill tone={row.confidence === "certain" ? "good" : "info"}>{row.confidenceText}</CrmPill>
        <CrmPill tone="neutral">{row.listType}</CrmPill>
        {row.areaName ? <CrmPill tone="neutral">{row.areaName}</CrmPill> : null}
        {row.reasons.map((reason) => (
          <CrmPill key={reason} tone="neutral">
            {reason}
          </CrmPill>
        ))}
        {row.warnings.map((warning) => (
          <CrmPill key={warning} tone="warn">
            {warning}
          </CrmPill>
        ))}
      </div>
      {/* A phone stacks the two sides; from md they stand side by side (the Customer matches board's way). */}
      <div className="min-w-0 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
        <SideCard heading={`Waiting on ${row.waiting.line ?? "another line"}`} side={row.waiting} />
        <SideCard heading={`Validated on ${row.source.line ?? "another line"}`} side={row.source}>
          <CrmFacts
            facts={[
              { label: "Validated by", value: row.source.validatedByName ?? "Not recorded" },
              { label: "When", value: row.source.validatedAtText ?? "Not recorded" },
              { label: "Brick", value: row.source.brickName ?? "Not named" },
              { label: "Places it gives", value: countText(row.source.placeCount) },
            ]}
          />
          {row.source.address ? (
            <p className="break-words text-xs text-slate-500" dir="auto">
              {row.source.address}
            </p>
          ) : null}
        </SideCard>
      </div>
      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <CrmButton busy={busy === "same"} disabled={busy !== null} onClick={() => void answer("same")} size="sm" variant="success">
          Same customer — validate it
        </CrmButton>
        <CrmButton busy={busy === "not_same"} disabled={busy !== null} onClick={() => void answer("not_same")} size="sm" variant="secondary">
          Not the same
        </CrmButton>
      </div>
    </div>
  );
}

export function LineLookalikeBoardView({ filters }: { filters: ValidationReviewFilters }) {
  const resource = useCrmGet<LineLookalikeBoard>(ROUTE, "board");
  const [shown, setShown] = useState(PAIRS_PAGE);
  const [answered, setAnswered] = useState<ReadonlyMap<string, Saved>>(new Map());
  const [validatedRows, setValidatedRows] = useState<ReadonlySet<string>>(new Set());
  const board = resource.data;

  const rows = useMemo(
    () =>
      board
        ? board.rows.filter(
            (row) =>
              !answered.has(row.key) &&
              !validatedRows.has(row.waitingCustomerId) &&
              (sidePasses(row, row.waiting, filters) || sidePasses(row, row.source, filters)),
          )
        : [],
    [board, answered, validatedRows, filters],
  );

  if (!board) {
    return resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Comparing the three lines' lists" />;
  }

  const onAnswered = (row: LineLookalikeRow, saved: Saved) => {
    setAnswered((current) => new Map(current).set(row.key, saved));
    // Validated now: every other pair of that row has nothing left to confirm.
    if (saved.validated) setValidatedRows((current) => new Set(current).add(row.waitingCustomerId));
  };
  const confirmedNow = [...answered.values()].filter((saved) => saved.validated).length;
  const notSameNow = [...answered.values()].filter((saved) => saved.answer === "not_same").length;
  const anyFilter = filters.rep !== "" || filters.line !== "" || filters.region !== "" || filters.area !== "" || filters.list !== "" || filters.text.trim() !== "";

  return (
    <div className="space-y-5">
      <CrmStatGrid>
        <CrmStat label="To confirm" note="Waiting on one line, validated on another" tone={rows.length > 0 ? "warn" : "neutral"} value={countText(rows.length)} />
        <CrmStat label="Certain" note="The same phone or the same old-CRM contact" value={countText(board.certain)} />
        <CrmStat label="Very likely" note="The name, written another way" value={countText(board.veryLikely)} />
        <CrmStat label="Answered" note={`${countText(board.confirmed + confirmedNow)} confirmed · ${countText(board.notSame + notSameNow)} not the same`} value={countText(board.confirmed + board.notSame + answered.size)} />
      </CrmStatGrid>

      <AdminCallout tone="neutral">
        <span className="min-w-0 break-words">
          A pair is listed when one line has validated a customer and another line of the same area, on another rep&apos;s list, still waits on a customer
          whose name is written another way — a word spelled differently, the words in another order, a middle name left out — or who shares the phone
          number or the old-CRM contact. The three-lines rule validates the exact same name by itself; these it never validates. Same customer validates the
          waiting row now, from the other line&apos;s places and under that line&apos;s validator; Not the same is kept and never asked again. Two
          facilities of different kinds are never listed.{anyFilter ? " The filters above narrow this tab; a pair stays when either row passes." : ""}
        </span>
      </AdminCallout>

      {confirmedNow > 0 ? <CrmNote tone="good">{countText(confirmedNow)} validated from this list just now.</CrmNote> : null}

      <AdminTableShell
        title={`Same customer, other line (${countText(rows.length)})`}
        description="Each card is one customer still waiting on one line, beside the customer another line of the same area validated. Certain pairs come first."
      >
        {rows.length === 0 ? (
          <div className="px-4 py-4">
            <AdminCallout tone="success">
              <span>{anyFilter ? "No pair matches these filters." : "Nothing to confirm: no waiting customer looks like another line's validated one."}</span>
            </AdminCallout>
          </div>
        ) : (
          <>
            {rows.slice(0, shown).map((row) => (
              <PairCard key={row.key} onAnswered={onAnswered} row={row} />
            ))}
            <CrmShowMore left={rows.length - shown} onMore={() => setShown((count) => count + PAIRS_PAGE)} page={PAIRS_PAGE} />
          </>
        )}
      </AdminTableShell>
    </div>
  );
}
