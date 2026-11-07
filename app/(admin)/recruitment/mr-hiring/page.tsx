import { CalendarClock, ClipboardCheck, Hourglass, Stethoscope, UserRoundCheck } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip } from "@/components/admin/admin-design-system";
import { PageContainer } from "@/components/layout/page-container";
import { MrHiringBoard } from "@/components/recruitment/mr-hiring/mr-hiring-board";
import { RecruitmentKpiStrip, RecruitmentPageHeader, RecruitmentPanel } from "@/components/recruitment/recruitment-premium";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { parseCandidatePageId } from "@/lib/recruitment/candidate-page-link";
import { mrViewer } from "@/lib/recruitment/mr-hiring/access";
import { loadMrBoardRecords, mrRowsFor } from "@/lib/recruitment/mr-hiring/server";
import { fenceRowsByCandidate } from "@/lib/recruitment/workspace/fence";

export const dynamic = "force-dynamic";

// Medical Rep Hiring — the 8 November 2026 workflow, step for step (docs/recruitment-mr-hiring-
// workflow.md): one WhatsApp channel, HR screening and a 1st interview, the DSM's 2nd interview with
// mandatory feedback, the RSM's interview for the Pedia line where it applies, the HR Manager's 3rd
// interview and the NSM's final (or one joint final), the NSM's recommendation, the HR Manager's final
// decision, and the offer.
//
// For the HR Manager (the Super Admin) and Talent Acquisition, who work it, and the CEO, who reads it.
// Every button is offered only where the route behind it will accept it (src/lib/recruitment/
// mr-hiring/rows.ts), and the NSM's proposed salary is removed on the server for the CEO. The DSM and
// the RSM and the NSM work their own interviews from the manager portal's "My Medical Rep interviews".
export default async function MrHiringPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/recruitment/mr-hiring");
  const viewer = mrViewer(access);
  if (!viewer.readsAll) redirect("/employee-portals");

  // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is never on this board. A Medical
  // Rep candidate is not one, so for everyone this costs nothing.
  const records = await fenceRowsByCandidate(access, await loadMrBoardRecords(access), (record) => record.facts.candidateId);
  const rows = mrRowsFor(access, records);
  const initialCandidateId = parseCandidatePageId((await searchParams).candidate);

  const open = rows.filter((row) => row.stage.open);
  const waitingForHr = open.filter((row) => row.stage.open && row.stage.waitingFor.kind === "hr" && row.stage.step !== "offer").length;
  const waitingForManagers = open.filter((row) => row.stage.open && row.stage.waitingFor.kind === "interviewer").length;
  const waitingForDecision = open.filter((row) => row.stage.open && row.stage.waitingFor.kind === "hr_manager").length;
  const booked = open.filter((row) => row.stage.open && row.stage.state === "booked").length;
  const offers = open.filter((row) => row.stage.open && row.stage.step === "offer").length;

  // The candidate pages live under the viewer's own recruitment address; the CEO opens none.
  const candidateRoot = viewer.isHrManager ? "/recruitment" : viewer.isTalentAcquisition ? "/hr/recruitment" : null;

  return (
    <PageContainer>
      <RecruitmentPageHeader
        badges={
          <>
            <AdminInsightChip tone="orange">From Saturday 7 November 2026</AdminInsightChip>
            <AdminInsightChip tone="slate">Medical Representative only</AdminInsightChip>
          </>
        }
        description="One channel, one system, one process — from the WhatsApp CV to the offer. Every Medical Rep CV received from Saturday 7 November 2026, the step it is on, and the one thing to do next. An earlier CV finishes in the workspace as before."
        icon={<Stethoscope aria-hidden="true" className="h-3.5 w-3.5" />}
        title="Medical Rep Hiring"
      />
      <RecruitmentKpiStrip
        className="mt-4"
        items={[
          { description: "Screening, booking or the 1st interview result", icon: <ClipboardCheck className="h-4 w-4" />, label: "Waiting for HR", value: waitingForHr },
          { description: "A DSM's feedback, an RSM's evaluation, or an NSM's result or recommendation", icon: <Hourglass className="h-4 w-4" />, label: "Waiting for managers", tone: "violet", value: waitingForManagers },
          { description: "The HR Manager's interview result or final decision", icon: <UserRoundCheck className="h-4 w-4" />, label: "Waiting for the HR Manager", tone: "rose", value: waitingForDecision },
          { description: "Interviews booked and not held yet", icon: <CalendarClock className="h-4 w-4" />, label: "Interviews booked", tone: "blue", value: booked },
          { description: "To prepare, sent, or answered", icon: <ClipboardCheck className="h-4 w-4" />, label: "At the offer", tone: "emerald", value: offers },
        ]}
      />
      <RecruitmentPanel
        className="mt-4"
        count={rows.length}
        description="Open a candidate for their hiring journey: every step, every evaluation and the full timeline."
        title="Medical Rep candidates"
        bodyClassName="p-3 sm:p-4"
      >
        <MrHiringBoard candidateRoot={candidateRoot} initialCandidateId={initialCandidateId} rows={rows} />
      </RecruitmentPanel>
    </PageContainer>
  );
}
