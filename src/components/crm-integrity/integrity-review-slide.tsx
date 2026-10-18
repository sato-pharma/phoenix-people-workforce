"use client";

/**
 * One location case as a slide of the one-by-one review on Place checks (owner, 2026-10-18: "make the
 * place checks, integrity cases, all place checks tabs, but in tabs").
 *
 * The photograph fills the stage; when the case kept none, the map of its readings does. The column is
 * the case read whole, in the board's own order of importance: who and what, what the system found, the
 * location against the validation location, the numbered story, the map when the photo holds the stage,
 * and the measurements folded away. The footer settles it.
 *
 * 🔴 EVERY PART IS THE BOARD'S OWN. The panels are exported from `integrity-board-view.tsx` where they
 * live, and the row is built by `integrityBoardRow`, the one mapping the board and its export already
 * share — so the review and the board can never print different facts about one case. The decision is
 * `IntegritySettleControl`, the board's own button, posting to the board's own route.
 *
 * 🔴 IT LIVES HERE AND NOT IN `src/components/phoenix-crm/`, for the reason `integrity-settle.tsx` gives:
 * that directory is the rep's own bundle and may not so much as name this board.
 */

import {
  CaseComparisonPanel,
  CaseMapPanel,
  CaseTimeline,
  casePhoto,
  Reasons,
} from "@/components/crm-integrity/integrity-board-view";
import { IntegritySettleControl } from "@/components/crm-integrity/integrity-settle";
import { DeckSection, DeckStageEmpty, DeckStagePhoto, DeckSubjectHeader } from "@/components/place-review-deck/deck-parts";
import { CrmNote, CrmPill } from "@/components/phoenix-crm/ui";
import type { IntegrityBoardRow } from "@/lib/crm-integrity/integrity-board-rows";
import { integritySourceStoryLabel } from "@/lib/crm-integrity/integrity-case-story";
import type { IntegrityCase } from "@/lib/phoenix-crm/server/integrity-board";

/** A case filed on a polyclinic or centre counts as a polyclinic under the review's switch. */
export function integrityCaseIsPolyclinic(entry: Pick<IntegrityCase, "subjectKind">): boolean {
  return entry.subjectKind === "shared_place";
}

/** The photograph, large — or, when the case kept none, its readings on the map. */
export function IntegrityCaseStage({ row }: { row: IntegrityBoardRow }) {
  const { entry } = row;
  if (entry.photoPath !== null) {
    const photo = casePhoto(entry);
    return <DeckStagePhoto alt={photo.alt} caption={photo.caption} label={photo.heading} path={entry.photoPath} />;
  }
  if (row.map === null) {
    return (
      <DeckStageEmpty
        label="The photograph"
        lines={["A one-tap visit keeps no photograph, by design, and no usable reading was kept for this case either. The column beside it is the whole case."]}
        title="No photograph and no map for this case"
      />
    );
  }
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-y-auto">
      <p className="px-4 pt-3 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">No photograph was kept — the readings on the map</p>
      <div className="m-4 min-w-0 bg-white p-4">
        <CaseMapPanel map={row.map} />
      </div>
    </div>
  );
}

/** The case, read whole. */
export function IntegrityCaseColumn({ row }: { row: IntegrityBoardRow }) {
  const { entry, story } = row;
  const who = [entry.repName, entry.repLine, entry.repArea].filter(Boolean).join(" · ");
  return (
    <>
      <DeckSubjectHeader
        eyebrow={`Integrity case · ${integritySourceStoryLabel(entry.source)}`}
        lines={[who, entry.subjectLabel ? `About ${entry.subjectLabel}` : null].filter((line): line is string => Boolean(line))}
        pills={
          <>
            <CrmPill tone={entry.strong ? "bad" : "warn"}>{entry.strong ? "Strong case" : "Worth a look"}</CrmPill>
            {integrityCaseIsPolyclinic(entry) ? <CrmPill tone="info">Polyclinic</CrmPill> : null}
            {entry.customerList ? <CrmPill>{entry.customerList}</CrmPill> : null}
            {entry.isTest ? <CrmPill>Test entry</CrmPill> : null}
          </>
        }
        title={entry.customerName}
      />
      <DeckSection title="What the system found">
        <p className="break-words text-sm font-black leading-6 text-slate-900" dir="auto">
          {story.headline}
        </p>
        <Reasons entry={entry} />
      </DeckSection>
      <DeckSection title="This location against the validation location">
        <CaseComparisonPanel comparison={story.comparison} />
      </DeckSection>
      <DeckSection title="What happened, in order">
        <ol className="min-w-0 list-decimal space-y-1 pl-5">
          {story.story.map((sentence, index) => (
            <li className="break-words text-sm leading-6 text-slate-700" dir="auto" key={`${index}-${sentence.slice(0, 24)}`}>
              {sentence}
            </li>
          ))}
        </ol>
      </DeckSection>
      {/* The map sits here only when the photograph holds the stage; otherwise the stage IS the map. */}
      {entry.photoPath !== null ? (
        <DeckSection title="The two locations on the map">
          <CaseMapPanel map={row.map} />
        </DeckSection>
      ) : null}
      <div className="px-5 py-4">
        <details className="min-w-0 border border-slate-200 bg-slate-50 px-3 py-2">
          <summary className="cursor-pointer text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">The measurements behind this</summary>
          <div className="min-w-0 space-y-2 pt-3">
            <ul className="space-y-1">
              {story.evidence.map((fact) => (
                <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs leading-5 text-slate-600" key={fact.label}>
                  <span className="font-bold text-slate-800">{fact.label}:</span>
                  <span className="min-w-0 break-words" dir="auto">
                    {fact.value}
                  </span>
                </li>
              ))}
            </ul>
            <div className="pt-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">What has happened here</div>
            <CaseTimeline entry={entry} />
          </div>
        </details>
      </div>
    </>
  );
}

/**
 * The decision: settle it with a reason — the board's ready-made reasons one tap away — or leave it.
 * A case a later reading has taken away is not offered the button, exactly as on the board.
 */
export function IntegrityCaseFooter({ canSettle, row }: { canSettle: boolean; row: IntegrityBoardRow }) {
  const { entry } = row;
  const offersDecision = canSettle && (entry.laterReading === null || !entry.laterReading.withdrawsFlag);
  if (!offersDecision) {
    return <CrmNote tone="neutral">{canSettle ? "A later reading no longer supports this case, so there is nothing to settle here." : "Settling a case is the Super Admin's alone."}</CrmNote>;
  }
  // Keyed by the case, so a note half-typed on one case never follows him onto the next.
  return <IntegritySettleControl key={entry.id} caseId={entry.id} presets settlement={entry.settlement} startOpen />;
}
