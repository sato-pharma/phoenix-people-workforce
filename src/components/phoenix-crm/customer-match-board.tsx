"use client";

/**
 * Phoenix CRM — the fourth tab of Place checks: the SAME customer validated by more than one rep at places
 * that do not agree (owner, 2026-10-26, "Build the check").
 *
 * The rule is `customer-match-groups.ts`. Each card is one customer: every rep's validation of them, grouped
 * by the point it sits at, so the reading that stands alone is visible beside the ones that agree. It lists
 * and stores nothing; the decider opens the validation in the review queue to act on it.
 *
 * 🔴 THE DECIDERS' ALONE, LAZY AND KEPT — the same as "Same place, several reps": never drawn in
 * `mode="team"`, read when the tab is first opened, kept mounted afterwards.
 *
 * 🔴 THE SHARED FILTER BAR NARROWS IT WITHOUT SPLITTING A CARD: a customer stays whole when any of its
 * validations passes.
 *
 * 🔴 NEUTRAL WORDS: where each reading sits and how far apart — never a verdict on a rep.
 */

import { useMemo, useState } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { useCrmGet } from "@/components/phoenix-crm/api";
import { countText } from "@/components/phoenix-crm/format";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { CrmButton, CrmFacts, CrmLoadError, CrmLoading, CrmPill, CrmShowMore, CrmStat, CrmStatGrid } from "@/components/phoenix-crm/ui";
import {
  conflictSentence,
  customerInsightsOf,
  CUSTOMER_REASON_TEXT,
  SAME_AREA_FAR_METERS,
  type CustomerConflict,
  type CustomerMatchBoard,
  type CustomerMember,
  type CustomerSubject,
} from "@/lib/phoenix-crm/customer-match-groups";
import { formatDistance } from "@/lib/phoenix-crm/geo";
import {
  matchesValidationReviewFilters,
  validationReviewPeriodCutoff,
  withinValidationReviewPeriod,
  type ValidationReviewFilters,
} from "@/lib/phoenix-crm/validation-review-filters";

const ROUTE = "/api/phoenix-crm/validation-reviews/same-customer";

type BoardView = CustomerMatchBoard & { capped: boolean };

const CONFLICTS_PAGE = 20;
const MEMBERS_SHOWN = 6;

function subjectPasses(subject: CustomerSubject, filters: ValidationReviewFilters, cutoff: number | null): boolean {
  if (!withinValidationReviewPeriod(subject.capturedAt, cutoff)) return false;
  return matchesValidationReviewFilters(
    {
      repName: subject.repName,
      line: subject.line,
      region: subject.region,
      listType: subject.listType,
      customerName: subject.title,
      territory: subject.territory,
      speciality: subject.speciality,
      placeLabel: null,
      address: subject.address,
      brickName: subject.brickName,
      areaName: subject.areaName,
    },
    filters,
  );
}

function MemberCard({ member }: { member: CustomerMember }) {
  return (
    <div className={`min-w-0 space-y-3 border border-l-[3px] border-slate-200 bg-white p-3 ${member.pinOnOther ? "border-l-amber-500" : ""}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="inline-flex min-h-6 items-center justify-center border border-slate-300 bg-slate-50 px-1.5 text-xs font-black text-slate-700">
          Point {member.point_group}
        </span>
        <CrmPill tone={member.agreeing > 1 ? "good" : "neutral"}>
          {member.agreeing > 1 ? `${countText(member.agreeing)} validations agree here` : "The only validation here"}
        </CrmPill>
        {member.pinOnOther ? <CrmPill tone="warn">Pin on {member.pinOnOther.otherRepName}&apos;s point</CrmPill> : null}
      </div>
      <div className="flex min-w-0 gap-3">
        <div className="w-20 shrink-0">
          <CrmPhotoThumb alt={`Sign photo: ${member.title}, validated by ${member.repName}`} className="h-20 w-20" lazy path={member.photoPath} rotatable />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="break-words text-sm font-black text-slate-950">{member.title}</p>
          <p className="break-words text-xs font-semibold text-slate-700">
            {member.repName} · {member.territory}
          </p>
          <p className="break-words text-xs text-slate-500">
            {[member.listType, member.speciality, member.capturedAtText].filter((part): part is string => Boolean(part)).join(" · ")}
          </p>
          {member.address ? <p className="break-words text-xs text-slate-500">{member.address}</p> : null}
        </div>
      </div>
      <CrmFacts
        facts={[
          { label: "Area", value: member.areaName ?? "Not named" },
          { label: "Brick", value: member.brickName ?? "Not named" },
          { label: "Pin vs photo", value: member.pinGapMeters === null ? "One reading only" : formatDistance(member.pinGapMeters) },
          {
            label: "Pin vs other rep",
            value: member.pinOnOther ? `${formatDistance(member.pinOnOther.pinToOtherMeters)} from ${member.pinOnOther.otherRepName}'s validation` : "Not on another rep's point",
          },
        ]}
      />
    </div>
  );
}

function ConflictCard({ conflict }: { conflict: CustomerConflict }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? conflict.members : conflict.members.slice(0, MEMBERS_SHOWN);
  const hidden = conflict.members.length - shown.length;
  return (
    <div className="min-w-0 space-y-3 border-t-4 border-slate-200 px-4 py-4 first:border-t-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <p className="break-words text-base font-black text-slate-950">{conflict.title}</p>
        {conflict.reasons.map((reason) => (
          <CrmPill key={reason} tone="warn">
            {CUSTOMER_REASON_TEXT[reason]}
          </CrmPill>
        ))}
        <CrmPill tone="neutral">
          {countText(conflict.seats)} reps · {countText(conflict.members.length)} validations · {countText(conflict.points)} points
        </CrmPill>
        <CrmPill tone="neutral">Up to {formatDistance(conflict.spreadMeters)} apart</CrmPill>
      </div>
      <p className="break-words text-sm font-semibold text-slate-800">{conflictSentence(conflict)}</p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((member) => (
          <MemberCard key={member.key} member={member} />
        ))}
      </div>
      {hidden > 0 || (showAll && conflict.members.length > MEMBERS_SHOWN) ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {hidden > 0 ? (
            <CrmButton onClick={() => setShowAll(true)} size="sm">
              Show {countText(hidden)} more validation{hidden === 1 ? "" : "s"} of this customer
            </CrmButton>
          ) : (
            <CrmButton onClick={() => setShowAll(false)} size="sm" variant="ghost">
              Show fewer
            </CrmButton>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function CustomerMatchBoardView({ filters }: { filters: ValidationReviewFilters }) {
  const resource = useCrmGet<BoardView>(ROUTE, "board");
  const [shown, setShown] = useState(CONFLICTS_PAGE);
  const board = resource.data;
  const cutoff = useMemo(() => validationReviewPeriodCutoff(filters.period), [filters.period]);
  const conflicts = useMemo(
    () => (board ? board.conflicts.filter((conflict) => conflict.members.some((member) => subjectPasses(member, filters, cutoff))) : []),
    [board, filters, cutoff],
  );
  const insights = useMemo(() => customerInsightsOf(conflicts), [conflicts]);

  if (!board) {
    return resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Comparing every customer's validations" />;
  }
  const anyFilter =
    filters.rep !== "" || filters.line !== "" || filters.region !== "" || filters.area !== "" || filters.list !== "" || filters.period !== "all" || filters.text.trim() !== "";

  return (
    <div className="space-y-5">
      {board.capped ? (
        <AdminCallout tone="warning">
          <span>This tab is comparing the newest validations only: there are more than it can hold in one read.</span>
        </AdminCallout>
      ) : null}

      <CrmStatGrid>
        <CrmStat label="Customers listed" note="Validated by two or more reps at places that do not agree" tone={insights.conflicts > 0 ? "warn" : "neutral"} value={countText(insights.conflicts)} />
        <CrmStat label="One area, places far apart" note={`More than ${formatDistance(SAME_AREA_FAR_METERS)} apart`} value={countText(insights.sameAreaFar)} />
        <CrmStat label="A pin on another rep's point" note="The photograph was taken elsewhere" tone={insights.pinOnOther > 0 ? "warn" : "neutral"} value={countText(insights.pinOnOther)} />
        <CrmStat label="Validations compared" note={`by ${countText(insights.reps)} reps`} value={countText(insights.validations)} />
      </CrmStatGrid>

      <AdminCallout tone="neutral">
        <span className="min-w-0 break-words">
          A customer is listed when two reps validated the same name on the same list, and either both places name one area but sit more than{" "}
          {formatDistance(SAME_AREA_FAR_METERS)} apart, or one rep&apos;s pin sits on the other rep&apos;s point while that rep&apos;s own photograph was taken
          somewhere else. The photograph&apos;s own position is the reading trusted. A morning and an evening place of one person are never compared, and two names
          with different specialities are never taken for one customer.{anyFilter ? " The filters above narrow this tab; a customer stays whole when any of its validations passes." : ""}
        </span>
      </AdminCallout>

      <AdminTableShell
        title={`Same customer, several reps (${countText(conflicts.length)})`}
        description="Each card is one customer, with every rep's validation of them grouped by the point it sits at. Validations that agree share a point number; one that stands alone is the reading to look at."
      >
        {conflicts.length === 0 ? (
          <div className="px-4 py-4">
            <AdminCallout tone="success">
              <span>{anyFilter ? "No customer matches these filters." : "Every customer validated by several reps sits at places that agree."}</span>
            </AdminCallout>
          </div>
        ) : (
          <>
            {conflicts.slice(0, shown).map((conflict) => (
              <ConflictCard key={conflict.id} conflict={conflict} />
            ))}
            <CrmShowMore left={conflicts.length - shown} onMore={() => setShown((count) => count + CONFLICTS_PAGE)} page={CONFLICTS_PAGE} />
          </>
        )}
      </AdminTableShell>
    </div>
  );
}
