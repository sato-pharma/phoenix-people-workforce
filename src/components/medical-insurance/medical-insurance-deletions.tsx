"use client";

import { Search } from "lucide-react";
import * as React from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { phxFieldClassName, phxLabelClassName } from "@/components/ui/form-tokens";
import { formatLeftDay } from "@/lib/employees/left-flag";
import { coveragePeriodWords, deletionStandingWords, splitRegister, type MedicalInsuranceMemberRow, type MedicalInsuranceView } from "@/lib/medical-insurance/view";
import { cn } from "@/lib/utils";

import { MedicalInsuranceMemberPerson, matchesMember } from "./medical-insurance-members";
import { cellClassName, headerClassName, SaveError, sendJson, textLinkClassName, useSave } from "./medical-insurance-parts";

type Props = { canEdit: boolean; view: MedicalInsuranceView };

/**
 * DELETIONS, KEPT FOR GOOD AND NEVER MIXED WITH THE MEMBERS ON COVER (owner, 27 Nov 2026: "if even ended … I need
 * them to not disappear … never mix with others. So deletions, historical deletions, put them in a separate tab").
 * Every register row whose cover has an end, the latest first: the period, where it stands, and the reason. Nothing
 * here deletes a row; Put back returns someone to Members, with the family their end took.
 */
export function MedicalInsuranceDeletionsTab({ canEdit, view }: Props) {
  const [query, setQuery] = React.useState("");
  const reinstate = useSave();
  const { deletions } = splitRegister(view.members);
  const visible = deletions.filter((member) => matchesMember(member, query));

  function renderDeletion(member: MedicalInsuranceMemberRow) {
    const standing = deletionStandingWords(member, view.asOf, formatLeftDay);
    return (
      <>
        <p className={cn("break-words text-phx-xs font-black", member.open ? "text-phx-warn" : "text-phx-ink")}>{standing}</p>
        <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{coveragePeriodWords(member.coverageStart, member.coverageEnd, formatLeftDay)}</p>
        {member.endReason ? <p className="break-words text-phx-xs font-semibold text-phx-ink-soft" dir="auto">{member.endReason}</p> : null}
        {member.notes ? <p className="break-words text-phx-xs font-semibold text-phx-ink-faint" dir="auto">{member.notes}</p> : null}
      </>
    );
  }

  function renderPutBack(member: MedicalInsuranceMemberRow) {
    if (!canEdit) return null;
    return (
      <button
        className={textLinkClassName}
        disabled={reinstate.busy}
        onClick={() => void reinstate.save(() => sendJson(`/api/medical-insurance/members/${member.id}`, "PATCH", { action: "reinstate" }))}
        type="button"
      >
        Put back
      </button>
    );
  }

  return (
    <AdminTableShell
      action={
        <div className="w-full sm:w-64">
          <label className={phxLabelClassName} htmlFor="medical-insurance-deletions-search">Search</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-soft" />
            <input className={cn(phxFieldClassName, "pl-9")} id="medical-insurance-deletions-search" onChange={(event) => setQuery(event.target.value)} placeholder="Name, member number or job" type="search" value={query} />
          </div>
        </div>
      }
      description="Everyone whose cover has been ended, the latest first. They stay here for good and never mix with the members on cover. Put back returns someone to Members, with their family."
      title="Deletions"
    >
      <SaveError error={reinstate.error} />
      {visible.length === 0 ? (
        <p className="p-4 text-sm font-semibold text-phx-ink-soft">{deletions.length === 0 ? "Nobody has been taken off the policy yet." : "Nobody matches this search."}</p>
      ) : (
        <>
          <div className="hidden md:block">
            <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
              <colgroup>
                <col className="w-[33%]" />
                <col className="w-[9%]" />
                <col className="w-[14%]" />
                <col className="w-[32%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead>
                <tr>
                  <th className={headerClassName}>Person</th>
                  <th className={headerClassName}>Plan</th>
                  <th className={headerClassName}>Member number</th>
                  <th className={headerClassName}>Deletion</th>
                  <th className={headerClassName}><span className="sr-only">Change</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((member) => (
                  <tr key={member.id}>
                    <td className={cellClassName}><MedicalInsuranceMemberPerson member={member} /></td>
                    <td className={cellClassName}><span className="text-phx-xs font-bold text-phx-ink">{member.category}</span></td>
                    <td className={cellClassName}>
                      <p className="break-words text-phx-xs font-bold text-phx-ink">{member.certificateNumber ?? "Not yet given"}</p>
                      {member.staffNumber ? <p className="break-words text-phx-xs font-semibold text-phx-ink-faint">Staff {member.staffNumber}</p> : null}
                    </td>
                    <td className={cellClassName}>{renderDeletion(member)}</td>
                    <td className={cellClassName}>{renderPutBack(member)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 p-4 md:hidden">
            {visible.map((member) => (
              <div className="space-y-2 border border-phx-line bg-white p-4" key={member.id}>
                <MedicalInsuranceMemberPerson member={member} />
                <p className="break-words text-phx-xs font-bold text-phx-ink">Plan {member.category}, member number {member.certificateNumber ?? "not yet given"}{member.staffNumber ? `, staff ${member.staffNumber}` : ""}</p>
                {renderDeletion(member)}
                {renderPutBack(member)}
              </div>
            ))}
          </div>
        </>
      )}
    </AdminTableShell>
  );
}
