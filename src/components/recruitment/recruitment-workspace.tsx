"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  BriefcaseBusiness,
  CheckCircle2,
  FileSpreadsheet,
  UserPlus,
  Users,
} from "lucide-react";

import {
  AdminCallout,
  AdminPageHero,
  AdminSectionHeader,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ApplicationWithContext } from "@/lib/recruitment/applications";
import type { CandidateProfile } from "@/lib/recruitment/candidates";
import type { SelectionBoardEntry } from "@/lib/recruitment/selection";
import type { RecruitmentDashboard } from "@/lib/recruitment/dashboard";
import type { Candidate, Interview, InterviewType, RecruitmentActionKey, RecruitmentFile, Requisition } from "@/lib/recruitment/types";
import { interviewOutcomes, interviewScorecardCriteria, summarizeScorecard } from "@/lib/recruitment/scorecards";
import type { VacancyReportRow } from "@/lib/reports/vacancies";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { BulkCvExtractionPanel } from "@/components/recruitment/bulk-cv-extraction-panel";
import { CvExtractionPanel } from "@/components/recruitment/cv-extraction-panel";
import { CvExtractionReviewBoard } from "@/components/recruitment/cv-extraction-review-board";
import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
import type { ExtractedCandidateFields } from "@/lib/recruitment/cv-extraction";
import { defaultCvPositionKey, getCvPositionSchema, listCvPositionSchemas } from "@/lib/recruitment/cv-field-schemas";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";


type ManagerOption = { hrId: string; fullName: string };

type Props = {
  canApprove: boolean;
  canCreateRequisition: boolean;
  canDelete: boolean;
  canImport: boolean;
  canManage: boolean;
  canManageCandidates: boolean;
  canViewCandidates: boolean;
  candidates: Candidate[];
  dashboard: RecruitmentDashboard | null;
  filesEnabled: boolean;
  initialError: string | null;
  managers: ManagerOption[];
  openVacancies: VacancyReportRow[];
};

type TabKey = "pipeline" | "requisitions" | "candidates";

const fieldClass =
  "w-full border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-orange-400 focus:outline-none";

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// cv_screening, phone_screening (ScreeningCard), hiring_manager_interview (HM
// decision card) and final_selection (FinalSelectionCard) are handled by dedicated
// cards below, so they are intentionally not listed here.
const nextStageAction: Record<string, { action: RecruitmentActionKey; label: string; needsReason?: boolean }> = {
  in_candidate_pool: { action: "app_to_cv_screen", label: "Start CV screening" },
  interview_scheduling: { action: "app_to_hr_interview", label: "Move to HR interview" },
  hr_interview: { action: "app_record_hr_interview", label: "Record HR interview" },
  shortlisted: { action: "app_shortlist_to_scheduling", label: "Move to interview scheduling" },
  manager_interview_completed: { action: "app_mgr_completed_to_final", label: "Move to final selection" },
  backup_candidate: { action: "app_backup_to_offer", label: "Activate backup for offer" },
};

// Resume actions for the holding states (Rule 5/6/8).
const holdingStageActions: Record<string, Array<{ action: RecruitmentActionKey; label: string }>> = {
  on_hold: [
    { action: "app_resume_from_hold_to_cv", label: "Resume to CV screening" },
    { action: "app_resume_from_hold_to_phone", label: "Resume to phone screening" },
    { action: "app_resume_from_hold_to_hm", label: "Resume to manager interview" },
  ],
  no_response: [{ action: "app_resume_from_no_response", label: "Retry phone screening" }],
  call_back: [
    { action: "app_resume_from_call_back_to_cv", label: "Resume to CV screening" },
    { action: "app_resume_from_call_back_to_phone", label: "Resume to phone screening" },
  ],
};

const rejectableStages = new Set([
  "in_candidate_pool",
  "cv_screening",
  "phone_screening",
  "interview_scheduling",
  "hr_interview",
  "hiring_manager_interview",
  "final_selection",
  "shortlisted",
  "on_hold",
  "no_response",
  "call_back",
  "manager_interview_completed",
  "backup_candidate",
]);

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Request failed.");
  return data;
}

async function deleteRequest(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "DELETE" });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Delete failed.");
  return data;
}


function ScreeningCard({
  application,
  stage,
  pending,
  run,
}: {
  application: ApplicationWithContext;
  stage: "cv" | "phone" | "hm";
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
}) {
  const interviewType: InterviewType = stage === "cv" ? "cv" : stage === "phone" ? "phone" : "hiring_manager";
  const criteria = interviewScorecardCriteria[interviewType];
  const [scores, setScores] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState("");
  const [currentEmployer, setCurrentEmployer] = useState(application.candidate?.currentEmployer ?? "");
  const [expectedSalary, setExpectedSalary] = useState(
    application.candidate?.expectedSalary != null ? String(application.candidate.expectedSalary) : "",
  );
  const [noticePeriod, setNoticePeriod] = useState(application.candidate?.noticePeriod ?? "");

  const outcomes: Array<[string, string]> =
    stage === "cv"
      ? [
          ["shortlisted", "Shortlisted"],
          ["need_phone_screening", "Need phone screening"],
          ["on_hold", "On hold"],
          ["rejected", "Rejected"],
        ]
      : stage === "phone"
        ? [
            ["passed", "Passed"],
            ["failed", "Failed"],
            ["no_response", "No response"],
            ["call_back", "Call back"],
          ]
        : [
            ["recommended", "Recommended"],
            ["rejected", "Rejected"],
            ["hold", "Hold"],
          ];
  const reasonRequired =
    outcome === "on_hold" || outcome === "hold" || outcome === "rejected" || outcome === "failed";

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {stage === "cv" ? "CV screening" : stage === "phone" ? "Phone screening" : "Hiring manager interview"}
      </p>
      {stage === "phone" ? (
        <div className="space-y-1">
          <Input placeholder="Current employer" value={currentEmployer} onChange={(e) => setCurrentEmployer(e.target.value)} />
          <Input placeholder="Expected salary" type="number" value={expectedSalary} onChange={(e) => setExpectedSalary(e.target.value)} />
          <Input placeholder="Notice period" value={noticePeriod} onChange={(e) => setNoticePeriod(e.target.value)} />
        </div>
      ) : null}
      {criteria.map((criterion) => (
        <label key={criterion.key} className="flex items-center justify-between gap-2 text-xs">
          <span className="text-slate-600">{criterion.label}</span>
          <SearchableSelect
            className={`${fieldClass} w-20`}
            value={scores[criterion.key] ?? ""}
            onChange={(e) => setScores((prev) => ({ ...prev, [criterion.key]: e.target.value }))}
          >
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </SearchableSelect>
        </label>
      ))}
      <textarea className={fieldClass} placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <SearchableSelect className={fieldClass} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
        <option value="">Select outcome…</option>
        {outcomes.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SearchableSelect>
      {reasonRequired ? (
        <textarea className={fieldClass} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      ) : null}
      <Button
        disabled={pending || !outcome || (reasonRequired && !reason.trim())}
        onClick={() =>
          run(async () => {
            const score: Record<string, number> = {};
            for (const criterion of criteria) {
              const n = Number(scores[criterion.key]);
              if (Number.isFinite(n) && n >= 1 && n <= 5) score[criterion.key] = n;
            }
            await postJson(`/api/recruitment/applications/${application.id}/screening`, {
              stage,
              outcome,
              score,
              notes: notes.trim() || undefined,
              reason: reason.trim() || undefined,
              ...(stage === "phone"
                ? {
                    currentEmployer: currentEmployer.trim() || undefined,
                    expectedSalary: expectedSalary ? Number(expectedSalary) : undefined,
                    noticePeriod: noticePeriod.trim() || undefined,
                  }
                : {}),
            });
            return "Screening recorded.";
          })
        }
      >
        Save screening
      </Button>
    </div>
  );
}

function FinalSelectionCard({
  application,
  pending,
  run,
}: {
  application: ApplicationWithContext;
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
}) {
  const [board, setBoard] = useState<SelectionBoardEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState("");

  const loadBoard = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/recruitment/requisitions/${application.requisitionId}/selection-board`);
      const data = (await res.json().catch(() => ({}))) as { board?: SelectionBoardEntry[] };
      setBoard(data.board ?? []);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Final selection</p>
      <Button variant="secondary" disabled={pending || loading} onClick={() => void loadBoard()}>
        {loading ? "Loading…" : "Compare candidates"}
      </Button>
      {board ? (
        <div className="overflow-x-auto border border-slate-200">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="px-2 py-1 text-left">Candidate</th>
                <th className="px-2 py-1 text-left">Avg</th>
                <th className="px-2 py-1 text-left">Salary</th>
                <th className="px-2 py-1 text-left">Notice</th>
                <th className="px-2 py-1 text-left">Risk</th>
              </tr>
            </thead>
            <tbody>
              {board.length === 0 ? (
                <tr>
                  <td className="px-2 py-2 text-center text-slate-400" colSpan={5}>
                    No candidates at selection.
                  </td>
                </tr>
              ) : (
                board.map((entry) => (
                  <tr key={entry.application.id} className={entry.application.id === application.id ? "bg-orange-50" : ""}>
                    <td className="px-2 py-1 font-medium text-slate-900">{entry.candidate?.fullName ?? "—"}</td>
                    <td className="px-2 py-1">{entry.ratingAverage ?? "—"}</td>
                    <td className="px-2 py-1">{entry.candidate?.expectedSalary ?? "—"}</td>
                    <td className="px-2 py-1">{entry.candidate?.noticePeriod ?? "—"}</td>
                    <td className="px-2 py-1">
                      {entry.riskPreviouslyRejected ? (
                        <span className="bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700">
                          Previously rejected
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      <textarea
        className={fieldClass}
        placeholder="Reason (required for Select / Reject)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending || !reason.trim()}
          onClick={() =>
            run(async () => {
              await postJson(`/api/recruitment/applications/${application.id}/workflow`, {
                action: "app_select" satisfies RecruitmentActionKey,
                reason: reason.trim(),
              });
              return "Candidate selected for offer.";
            })
          }
        >
          Selected
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() =>
            run(async () => {
              await postJson(`/api/recruitment/applications/${application.id}/workflow`, {
                action: "app_to_backup" satisfies RecruitmentActionKey,
              });
              return "Marked as backup candidate.";
            })
          }
        >
          Backup candidate
        </Button>
        <Button
          variant="destructive"
          disabled={pending || !reason.trim()}
          onClick={() =>
            run(async () => {
              await postJson(`/api/recruitment/applications/${application.id}/workflow`, {
                action: "app_reject" satisfies RecruitmentActionKey,
                reason: reason.trim(),
              });
              return "Application rejected.";
            })
          }
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

export function RecruitmentWorkspace(props: Props) {
  const { dashboard, initialError } = props;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<TabKey>("pipeline");
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);

  const run = (work: () => Promise<string | void>) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const message = await work();
        if (message) setNotice(message);
        router.refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Something went wrong.");
      }
    });
  };

  const summary = dashboard?.summary;
  const requisitions = dashboard?.requisitions ?? [];
  const applications = dashboard?.applications ?? [];

  return (
    <div className="space-y-6">
      <AdminPageHero
        eyebrow="People Management"
        icon={<BriefcaseBusiness className="h-4 w-4" />}
        title="Recruitment"
        description="Open requisitions against vacant seats, track candidates through the pipeline, and convert the selected hire into an employee."
      />

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {notice ? <AdminCallout tone="success">{notice}</AdminCallout> : null}

      {summary ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <AdminStatCard
            description="Requisitions open or published for hiring."
            icon={<BriefcaseBusiness className="h-5 w-5" />}
            label="Open requisitions"
            tone="orange"
            value={summary.openRequisitions}
          />
          <AdminStatCard
            description="Candidates currently moving through the pipeline."
            icon={<Users className="h-5 w-5" />}
            label="Active applications"
            tone="blue"
            value={summary.activeApplications}
          />
          <AdminStatCard
            description="Applications converted into employees."
            icon={<CheckCircle2 className="h-5 w-5" />}
            label="Hires"
            tone="emerald"
            value={summary.hires}
          />
          <AdminStatCard
            description="Total applications recorded."
            icon={<FileSpreadsheet className="h-5 w-5" />}
            label="Total applications"
            tone="violet"
            value={summary.totalApplications}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {(["pipeline", "requisitions", "candidates"] as TabKey[]).map((key) => (
          <Button key={key} variant={tab === key ? "default" : "ghost"} onClick={() => setTab(key)}>
            {titleCase(key)}
          </Button>
        ))}
      </div>

      {!dashboard ? (
        <AdminCallout tone="warning">
          Recruitment data could not be loaded. If this is a fresh environment, apply the recruitment migrations on staging.
        </AdminCallout>
      ) : tab === "pipeline" ? (
        <PipelineTab
          applications={applications}
          canApprove={props.canApprove}
          canDelete={props.canDelete}
          canManage={props.canManage}
          canManageCandidates={props.canManageCandidates}
          canViewCandidates={props.canViewCandidates}
          filesEnabled={props.filesEnabled}
          managers={props.managers}
          pending={pending}
          run={run}
        />
      ) : tab === "requisitions" ? (
        <RequisitionsTab
          canCreate={props.canCreateRequisition}
          canDelete={props.canDelete}
          canManage={props.canManage}
          managers={props.managers}
          openVacancies={props.openVacancies}
          pending={pending}
          requisitions={requisitions}
          run={run}
        />
      ) : (
        <CandidatesTab
          canDelete={props.canDelete}
          canImport={props.canImport}
          canManage={props.canManageCandidates}
          candidates={props.candidates}
          openRequisitions={requisitions.filter((requisition) =>
            ["req_open", "req_published"].includes(requisition.status),
          )}
          pending={pending}
          run={run}
          setError={setError}
          setNotice={setNotice}
        />
      )}
    </div>
  );
}

function PipelineTab({
  applications,
  canApprove,
  canDelete,
  canManage,
  canManageCandidates,
  canViewCandidates,
  filesEnabled,
  managers,
  pending,
  run,
}: {
  applications: ApplicationWithContext[];
  canApprove: boolean;
  canDelete: boolean;
  canManage: boolean;
  canManageCandidates: boolean;
  canViewCandidates: boolean;
  filesEnabled: boolean;
  managers: ManagerOption[];
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [employeeHrId, setEmployeeHrId] = useState("");
  const [hireStartDate, setHireStartDate] = useState("");
  const [hireProbationMonths, setHireProbationMonths] = useState("3");
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [interviewsError, setInterviewsError] = useState<string | null>(null);
  const [candidateFiles, setCandidateFiles] = useState<RecruitmentFile[]>([]);
  const [candidateFilesError, setCandidateFilesError] = useState<string | null>(null);

  const loadInterviews = async (appId: string) => {
    try {
      const res = await fetch(`/api/recruitment/applications/${appId}/interviews`);
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to load interviews.");
      setInterviews(Array.isArray(data.interviews) ? (data.interviews as Interview[]) : []);
      setInterviewsError(null);
    } catch (caught) {
      setInterviews([]);
      setInterviewsError(caught instanceof Error ? caught.message : "Failed to load interviews.");
    }
  };

  const loadCandidateFiles = async (candidateId: string) => {
    try {
      const res = await fetch(`/api/recruitment/candidates/${candidateId}/files`);
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to load files.");
      setCandidateFiles(Array.isArray(data.files) ? (data.files as RecruitmentFile[]) : []);
      setCandidateFilesError(null);
    } catch (caught) {
      setCandidateFiles([]);
      setCandidateFilesError(caught instanceof Error ? caught.message : "Failed to load files.");
    }
  };

  const selectApplication = (appId: string) => {
    setSelectedId(appId);
    void loadInterviews(appId);
    const application = applications.find((row) => row.id === appId);
    if (canViewCandidates && application?.candidateId) void loadCandidateFiles(application.candidateId);
    else setCandidateFiles([]);
  };

  const selected = applications.find((application) => application.id === selectedId) ?? null;
  const next = selected ? nextStageAction[selected.stage] : undefined;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <AdminTableShell title="Pipeline" description="Every application and its current stage. Select a row to act on it.">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Requisition</th>
                <th>Stage</th>
                <th className="w-px"></th>
              </tr>
            </thead>
            <tbody>
              {applications.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-slate-500" colSpan={4}>
                    No applications yet. Add a candidate from the Candidates tab.
                  </td>
                </tr>
              ) : (
                applications.map((application) => (
                  <tr
                    key={application.id}
                    className={selectedId === application.id ? "bg-orange-50" : "cursor-pointer"}
                    onClick={() => selectApplication(application.id)}
                  >
                    <td className="px-3 py-2 font-medium text-slate-900">
                      {application.candidate?.fullName ?? "Unknown candidate"}
                    </td>
                    <td className="px-3 py-2">{application.requisition?.jobTitle ?? "—"}</td>
                    <td className="px-3 py-2">{titleCase(application.stage)}</td>
                    <td className="px-3 py-2 text-right">
                      {canDelete ? (
                        <Button
                          variant="destructive"
                          disabled={pending}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!window.confirm("Delete this application permanently? This cannot be undone.")) return;
                            run(async () => {
                              await deleteRequest(`/api/recruitment/applications/${application.id}`);
                              return "Application deleted.";
                            });
                          }}
                        >
                          Delete
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </AdminTableShell>

      <div className="space-y-3">
        <AdminSectionHeader title="Actions" description="Move the selected candidate through the pipeline." />
        {!selected ? (
          <p className="text-sm text-slate-500">Select an application to see available actions.</p>
        ) : (
          <div className="space-y-3 border border-slate-200 p-4">
            <div>
              <p className="text-sm font-semibold text-slate-900">{selected.candidate?.fullName}</p>
              <p className="text-xs text-slate-500">
                {selected.requisition?.jobTitle} · {titleCase(selected.stage)}
              </p>
            </div>

            {canManage && next ? (
              <div className="space-y-2">
                {next.needsReason ? (
                  <textarea
                    className={fieldClass}
                    placeholder="Reason (required)"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                ) : null}
                <Button
                  disabled={pending || (next.needsReason && !reason.trim())}
                  onClick={() =>
                    run(async () => {
                      await postJson(`/api/recruitment/applications/${selected.id}/workflow`, {
                        action: next.action,
                        reason: reason.trim() || undefined,
                      });
                      setReason("");
                      return `${next.label} complete.`;
                    })
                  }
                >
                  {next.label}
                </Button>
              </div>
            ) : null}

            {canManage &&
            (selected.stage === "cv_screening" ||
              selected.stage === "phone_screening" ||
              selected.stage === "hiring_manager_interview") ? (
              <ScreeningCard
                key={selected.id + selected.stage}
                application={selected}
                stage={
                  selected.stage === "cv_screening" ? "cv" : selected.stage === "phone_screening" ? "phone" : "hm"
                }
                pending={pending}
                run={run}
              />
            ) : null}

            {canManage && selected.stage === "final_selection" ? (
              <FinalSelectionCard key={selected.id} application={selected} pending={pending} run={run} />
            ) : null}

            {canManage && holdingStageActions[selected.stage] ? (
              <div className="space-y-2 border-t border-slate-200 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Resume</p>
                {holdingStageActions[selected.stage].map((item) => (
                  <Button
                    key={item.action}
                    variant="secondary"
                    disabled={pending}
                    onClick={() =>
                      run(async () => {
                        await postJson(`/api/recruitment/applications/${selected.id}/workflow`, { action: item.action });
                        return `${item.label} complete.`;
                      })
                    }
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            ) : null}

            {canApprove && (selected.stage === "offer_initiated" || selected.stage === "pre_boarding") ? (
              <div className="space-y-2 border-t border-slate-200 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mark as hired</p>
                <p className="text-xs text-slate-500">
                  Create the employee record first via the normal HR &quot;Add Employee&quot; flow (it also closes
                  the matching vacancy), then enter their HR_ID here to link this application.
                </p>
                <Input placeholder="Employee HR_ID" value={employeeHrId} onChange={(e) => setEmployeeHrId(e.target.value)} />
                <Input placeholder="Start date (optional)" type="date" value={hireStartDate} onChange={(e) => setHireStartDate(e.target.value)} />
                <Input
                  placeholder="Probation (months, optional)"
                  type="number"
                  value={hireProbationMonths}
                  onChange={(e) => setHireProbationMonths(e.target.value)}
                />
                <Button
                  disabled={pending || !employeeHrId.trim()}
                  onClick={() =>
                    run(async () => {
                      const data = await postJson(`/api/recruitment/applications/${selected.id}/convert`, {
                        employeeHrId: employeeHrId.trim(),
                        startDate: hireStartDate || undefined,
                        probationMonths: Number(hireProbationMonths) || undefined,
                      });
                      setEmployeeHrId("");
                      setHireStartDate("");
                      return `Hired as ${typeof data.employeeHrId === "string" ? data.employeeHrId : employeeHrId.trim()}.`;
                    })
                  }
                >
                  Mark as hired
                </Button>
              </div>
            ) : null}

            {canManage && rejectableStages.has(selected.stage) ? (
              <div className="space-y-2 border-t border-slate-200 pt-3">
                <textarea
                  className={fieldClass}
                  placeholder="Reason for reject / withdraw"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    disabled={pending || !reason.trim()}
                    onClick={() =>
                      run(async () => {
                        await postJson(`/api/recruitment/applications/${selected.id}/workflow`, {
                          action: "app_reject" satisfies RecruitmentActionKey,
                          reason: reason.trim(),
                        });
                        setReason("");
                        return "Application rejected.";
                      })
                    }
                  >
                    Reject
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={pending || !reason.trim()}
                    onClick={() =>
                      run(async () => {
                        await postJson(`/api/recruitment/applications/${selected.id}/workflow`, {
                          action: "app_withdraw" satisfies RecruitmentActionKey,
                          reason: reason.trim(),
                        });
                        setReason("");
                        return "Application withdrawn.";
                      })
                    }
                  >
                    Withdraw
                  </Button>
                </div>
              </div>
            ) : null}

            <InterviewsSection
              applicationId={selected.id}
              canManage={canManage}
              error={interviewsError}
              interviews={interviews}
              managers={managers}
              onReload={() => loadInterviews(selected.id)}
            />

            {canViewCandidates && selected.candidateId ? (
              <FilesSection
                candidateId={selected.candidateId}
                canUpload={canManageCandidates}
                error={candidateFilesError}
                files={candidateFiles}
                filesEnabled={filesEnabled}
                onReload={() => loadCandidateFiles(selected.candidateId)}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function RequisitionsTab({
  canCreate,
  canDelete,
  canManage,
  managers,
  openVacancies,
  pending,
  requisitions,
  run,
}: {
  canCreate: boolean;
  canDelete: boolean;
  canManage: boolean;
  managers: ManagerOption[];
  openVacancies: VacancyReportRow[];
  pending: boolean;
  requisitions: Requisition[];
  run: (work: () => Promise<string | void>) => void;
}) {
  const [vacancyId, setVacancyId] = useState("");
  const [posSel, setPosSel] = useState("");
  const [lineSel, setLineSel] = useState("");
  const [grade, setGrade] = useState("");
  const [bandMin, setBandMin] = useState("");
  const [bandMax, setBandMax] = useState("");
  const [ownerHrId, setOwnerHrId] = useState("");
  const [priority, setPriority] = useState("normal");
  const [deadline, setDeadline] = useState("");

  // Rule 3a — cascade: Position -> Line -> vacant Area (each Position+Line+Area = one seat).
  const positionsById = new Map<string, string>();
  for (const v of openVacancies) {
    if (v.positionId != null) positionsById.set(String(v.positionId), v.positionTitle ?? v.jobTitle ?? "Position");
  }
  const linesById = new Map<string, string>();
  for (const v of openVacancies) {
    if (String(v.positionId ?? "") === posSel && v.lineId != null) linesById.set(String(v.lineId), v.lineName ?? "Line");
  }
  const areaVacancies = openVacancies.filter(
    (v) => String(v.positionId ?? "") === posSel && String(v.lineId ?? "") === lineSel,
  );
  const selectedVacancy = openVacancies.find((v) => String(v.id) === vacancyId) ?? null;

  const requisitionActions: Record<string, Array<{ action: RecruitmentActionKey; label: string; reason?: boolean; variant?: "default" | "secondary" | "destructive" }>> = {
    req_draft: [
      { action: "req_open", label: "Open" },
      { action: "req_cancel", label: "Cancel", reason: true, variant: "destructive" },
    ],
    req_open: [
      { action: "req_publish", label: "Publish" },
      { action: "req_hold", label: "Hold", reason: true, variant: "secondary" },
      { action: "req_close", label: "Close", reason: true, variant: "destructive" },
    ],
    req_published: [
      { action: "req_hold", label: "Hold", reason: true, variant: "secondary" },
      { action: "req_close", label: "Close", reason: true, variant: "destructive" },
    ],
    req_on_hold: [
      { action: "req_resume", label: "Resume" },
      { action: "req_close", label: "Close", reason: true, variant: "destructive" },
    ],
  };

  return (
    <div className="space-y-4">
      {canCreate ? (
        <AdminTableShell title="Open a requisition" description="Wrap an open vacancy and add the recruitment details.">
          <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
            <SearchableSelect
              className={fieldClass}
              value={posSel}
              onChange={(e) => {
                setPosSel(e.target.value);
                setLineSel("");
                setVacancyId("");
              }}
            >
              <option value="">Position…</option>
              {Array.from(positionsById.entries()).map(([id, title]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </SearchableSelect>
            <SearchableSelect
              className={fieldClass}
              value={lineSel}
              disabled={!posSel}
              onChange={(e) => {
                setLineSel(e.target.value);
                setVacancyId("");
              }}
            >
              <option value="">Line…</option>
              {Array.from(linesById.entries()).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </SearchableSelect>
            <SearchableSelect className={fieldClass} value={vacancyId} disabled={!lineSel} onChange={(e) => setVacancyId(e.target.value)}>
              <option value="">Vacant area…</option>
              {areaVacancies.map((vacancy) => (
                <option key={vacancy.id} value={vacancy.id}>
                  {vacancy.areaName ?? "Area"} · {vacancy.vacancyCode}
                </option>
              ))}
            </SearchableSelect>
            <div className={`${fieldClass} bg-slate-50 text-slate-600`}>
              Manager: {selectedVacancy ? selectedVacancy.managerName ?? selectedVacancy.managerHrId ?? "—" : "—"}
            </div>
            <SearchableSelect className={fieldClass} value={ownerHrId} onChange={(e) => setOwnerHrId(e.target.value)}>
              <option value="">Recruitment owner…</option>
              {managers.map((manager) => (
                <option key={manager.hrId} value={manager.hrId}>
                  {manager.fullName} ({manager.hrId})
                </option>
              ))}
            </SearchableSelect>
            <SearchableSelect className={fieldClass} value={priority} onChange={(e) => setPriority(e.target.value)}>
              {["low", "normal", "high", "urgent"].map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)} priority
                </option>
              ))}
            </SearchableSelect>
            <Input placeholder="Grade" value={grade} onChange={(e) => setGrade(e.target.value)} />
            <Input placeholder="Salary band min" type="number" value={bandMin} onChange={(e) => setBandMin(e.target.value)} />
            <Input placeholder="Salary band max" type="number" value={bandMax} onChange={(e) => setBandMax(e.target.value)} />
            <Input placeholder="Deadline" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            <div className="sm:col-span-2 lg:col-span-3">
              <Button
                disabled={pending || !vacancyId}
                onClick={() =>
                  run(async () => {
                    await postJson("/api/recruitment/requisitions", {
                      vacancyId: Number(vacancyId),
                      recruitmentOwnerHrId: ownerHrId || undefined,
                      grade: grade || undefined,
                      salaryBandMin: bandMin ? Number(bandMin) : undefined,
                      salaryBandMax: bandMax ? Number(bandMax) : undefined,
                      priority,
                      recruitmentDeadline: deadline || undefined,
                    });
                    setVacancyId("");
                    setPosSel("");
                    setLineSel("");
                    setGrade("");
                    setBandMin("");
                    setBandMax("");
                    setDeadline("");
                    return "Requisition created.";
                  })
                }
              >
                Create requisition
              </Button>
            </div>
          </div>
        </AdminTableShell>
      ) : null}

      <AdminTableShell title="Requisitions" description="All recruitment openings and their status.">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Code</th>
                <th>Role</th>
                <th>Status</th>
                <th>Hiring manager</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {requisitions.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-slate-500" colSpan={5}>
                    No requisitions yet.
                  </td>
                </tr>
              ) : (
                requisitions.map((requisition) => (
                  <tr key={requisition.id}>
                    <td className="px-3 py-2 font-medium text-slate-900">{requisition.requisitionCode}</td>
                    <td className="px-3 py-2">{requisition.jobTitle}</td>
                    <td className="px-3 py-2">{titleCase(requisition.status)}</td>
                    <td className="px-3 py-2">{requisition.hiringManagerName ?? requisition.hiringManagerHrId ?? "—"}</td>
                    <td className="px-3 py-2">
                      {canManage ? (
                        <div className="flex flex-wrap gap-1.5">
                          {(requisitionActions[requisition.status] ?? []).map((item) => (
                            <Button
                              key={item.action}
                              variant={item.variant ?? "default"}
                              disabled={pending}
                              onClick={() =>
                                run(async () => {
                                  let reason: string | undefined;
                                  if (item.reason) {
                                    const entered = window.prompt(`Reason for "${item.label}"`);
                                    if (entered === null) return;
                                    reason = entered;
                                  }
                                  await postJson(`/api/recruitment/requisitions/${requisition.id}/workflow`, {
                                    action: item.action,
                                    reason,
                                  });
                                  return `${item.label} complete.`;
                                })
                              }
                            >
                              {item.label}
                            </Button>
                          ))}
                          {["req_open", "req_published"].includes(requisition.status) ? (
                            <Button
                              variant="secondary"
                              disabled={pending}
                              onClick={() =>
                                run(async () => {
                                  const data = await postJson(`/api/recruitment/requisitions/${requisition.id}/posting`, {});
                                  const path = typeof data.path === "string" ? data.path : "";
                                  return `Application link: ${window.location.origin}${path}`;
                                })
                              }
                            >
                              Application link
                            </Button>
                          ) : null}
                          {canDelete ? (
                            <Button
                              variant="destructive"
                              disabled={pending}
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    `Delete requisition ${requisition.requisitionCode} and all of its applications? This cannot be undone.`,
                                  )
                                )
                                  return;
                                run(async () => {
                                  await deleteRequest(`/api/recruitment/requisitions/${requisition.id}`);
                                  return "Requisition deleted.";
                                });
                              }}
                            >
                              Delete
                            </Button>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">View only</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </AdminTableShell>
    </div>
  );
}

function CandidatesTab({
  canDelete,
  canImport,
  canManage,
  candidates,
  openRequisitions,
  pending,
  run,
  setError,
  setNotice,
}: {
  canDelete: boolean;
  canImport: boolean;
  canManage: boolean;
  candidates: Candidate[];
  openRequisitions: Requisition[];
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
  setError: (value: string | null) => void;
  setNotice: (value: string | null) => void;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const profilePanelRef = useRef<HTMLDivElement | null>(null);
  const [fullName, setFullName] = useState("");
  const [nationalId, setNationalId] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [startReq, setStartReq] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [statusDraft, setStatusDraft] = useState("");
  const [retryExtraction, setRetryExtraction] = useState<{ fields: ExtractedCandidateFields; extractionId: string | null } | null>(
    null,
  );
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryPositionKey, setRetryPositionKey] = useState(defaultCvPositionKey);

  const q = query.trim().toLowerCase();
  const visibleCandidates = q
    ? candidates.filter((c) =>
        [c.fullName, c.email, c.phone, c.status, c.source, c.nationalId]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(q)),
      )
    : candidates;

  const openProfile = async (id: string) => {
    setProfile(null);
    setError(null);
    setRetryExtraction(null);
    setRetryError(null);
    setRetryPositionKey(defaultCvPositionKey);
    try {
      const res = await fetch(`/api/recruitment/candidates/${id}`);
      const data = (await res.json().catch(() => ({}))) as { profile?: CandidateProfile; message?: string };
      if (!res.ok || !data.profile) throw new Error(data.message ?? "Failed to load candidate profile.");
      setProfile(data.profile);
      setStatusDraft(data.profile.candidate.status);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load candidate profile.");
    }
  };

  // The profile panel renders below the (often long) candidate table — without this it opens
  // out of view and looks like the Profile button did nothing.
  useEffect(() => {
    if (profile) profilePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [profile]);

  // Re-run AI extraction on a candidate that already has a CV on file — for one manually
  // created, or where the first extraction pass wasn't saved as-is. Reuses the same
  // cv-extract endpoint and drag-and-drop review board as the "create from CV" flow.
  const startRetryExtraction = async (candidateId: string, positionKey: string) => {
    setRetryBusy(true);
    setRetryError(null);
    try {
      const res = await fetch(`/api/recruitment/candidates/${candidateId}/cv-extract`, {
        body: JSON.stringify({ positionKey }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "AI CV extraction failed.");
      const fields = data.fields as ExtractedCandidateFields | undefined;
      if (!fields) throw new Error("The AI did not return any fields.");
      setRetryExtraction({ extractionId: typeof data.extractionId === "string" ? data.extractionId : null, fields });
    } catch (caught) {
      setRetryError(caught instanceof Error ? caught.message : "AI CV extraction failed.");
    } finally {
      setRetryBusy(false);
    }
  };

  const saveRetryExtraction = async (candidateId: string, values: Record<string, unknown>) => {
    setRetryBusy(true);
    setRetryError(null);
    try {
      const res = await fetch(`/api/recruitment/candidates/${candidateId}`, {
        body: JSON.stringify({ ...values, extractionId: retryExtraction?.extractionId }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to save the candidate.");
      setRetryExtraction(null);
      await openProfile(candidateId);
    } catch (caught) {
      setRetryError(caught instanceof Error ? caught.message : "Failed to save the candidate.");
    } finally {
      setRetryBusy(false);
    }
  };

  const onImport = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a spreadsheet to import first.");
      return;
    }
    setError(null);
    setNotice(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/recruitment/candidates/import", { method: "POST", body: formData });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Import failed.");
      const s = data.summary as { created?: number; matched?: number; failed?: number } | undefined;
      setNotice(`Imported: ${s?.created ?? 0} new, ${s?.matched ?? 0} matched, ${s?.failed ?? 0} failed.`);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed.");
    }
  };

  return (
    <div className="space-y-4">
      {canManage ? (
        <AdminTableShell title="Add a candidate" description="Create a candidate record (deduplicated by National ID, then email or phone).">
          <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
            <Input placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            <Input placeholder="National ID" value={nationalId} onChange={(e) => setNationalId(e.target.value)} />
            <Input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Input placeholder="Mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <div className="sm:col-span-2 lg:col-span-4 flex flex-wrap gap-2">
              <Button
                disabled={pending || !fullName.trim()}
                onClick={() =>
                  run(async () => {
                    const data = await postJson("/api/recruitment/candidates", {
                      fullName,
                      nationalId: nationalId || undefined,
                      email: email || undefined,
                      phone: phone || undefined,
                    });
                    setFullName("");
                    setNationalId("");
                    setEmail("");
                    setPhone("");
                    return data.created ? "Candidate added." : "Matched an existing candidate.";
                  })
                }
              >
                <UserPlus className="mr-1.5 h-4 w-4" /> Add candidate
              </Button>
              <Button variant="secondary" onClick={() => { window.location.href = "/api/recruitment/candidates/template"; }}>
                Download import template
              </Button>
              {canImport ? (
                <>
                  <input ref={fileRef} accept=".xlsx" className="text-sm" type="file" />
                  <Button variant="secondary" disabled={pending} onClick={onImport}>
                    Import spreadsheet
                  </Button>
                </>
              ) : null}
            </div>
          </div>
          <div className="border-t border-slate-100 p-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Or let AI read a Medical Rep CV
            </p>
            <CvExtractionPanel
              onCreated={(id) => {
                setNotice("Candidate saved from CV.");
                router.refresh();
                void openProfile(id);
              }}
            />
          </div>
          <div className="border-t border-slate-100 p-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Or process a batch of CVs at once
            </p>
            <BulkCvExtractionPanel
              onCreated={() => {
                setNotice("Candidate saved from CV.");
                router.refresh();
              }}
            />
          </div>
        </AdminTableShell>
      ) : null}

      <AdminTableShell title="Candidate pool" description="Every applicant stays here and is searchable — even rejected ones.">
        <div className="p-3">
          <Input
            placeholder="Search name, email, phone, status, source…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleCandidates.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-slate-500" colSpan={5}>
                    No candidates found.
                  </td>
                </tr>
              ) : (
                visibleCandidates.map((candidate) => (
                  <tr key={candidate.id}>
                    <td className="px-3 py-2 font-medium text-slate-900">{candidate.fullName}</td>
                    <td className="px-3 py-2">{candidate.status}</td>
                    <td className="px-3 py-2">{candidate.email ?? "—"}</td>
                    <td className="px-3 py-2">{candidate.phone ?? "—"}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1.5">
                        <Button variant="ghost" disabled={pending} onClick={() => void openProfile(candidate.id)}>
                          Profile
                        </Button>
                        {canManage ? (
                          <>
                          <SearchableSelect
                            className={fieldClass}
                            value={startReq[candidate.id] ?? ""}
                            onChange={(e) => setStartReq((prev) => ({ ...prev, [candidate.id]: e.target.value }))}
                          >
                            <option value="">Requisition…</option>
                            {openRequisitions.map((requisition) => (
                              <option key={requisition.id} value={requisition.id}>
                                {requisition.jobTitle}
                              </option>
                            ))}
                          </SearchableSelect>
                          <Button
                            disabled={pending || !startReq[candidate.id]}
                            onClick={() =>
                              run(async () => {
                                await postJson("/api/recruitment/applications", {
                                  requisitionId: startReq[candidate.id],
                                  candidateId: candidate.id,
                                });
                                return "Application started.";
                              })
                            }
                          >
                            Start
                          </Button>
                          {canDelete ? (
                            <Button
                              variant="destructive"
                              disabled={pending}
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    `Delete candidate ${candidate.fullName} and all of their applications? This cannot be undone.`,
                                  )
                                )
                                  return;
                                run(async () => {
                                  await deleteRequest(`/api/recruitment/candidates/${candidate.id}`);
                                  return "Candidate deleted.";
                                });
                              }}
                            >
                              Delete
                            </Button>
                          ) : null}
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </AdminTableShell>

      {profile ? (
        <div ref={profilePanelRef} className="space-y-3 border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-900">{profile.candidate.fullName}</p>
              <p className="text-xs text-slate-500">
                {profile.candidate.email ?? "—"} · {profile.candidate.phone ?? "—"} · Source: {profile.candidate.source ?? "—"}
              </p>
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setProfile(null);
                setRetryExtraction(null);
                setRetryError(null);
                setRetryPositionKey(defaultCvPositionKey);
              }}
            >
              Close
            </Button>
          </div>

          {canManage && profile.files.some((file) => file.kind === "cv") ? (
            <div className="space-y-2">
              {!retryExtraction ? (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="rounded-md border border-gray-200 px-2 py-1.5 text-sm"
                    disabled={retryBusy}
                    onChange={(event) => setRetryPositionKey(event.target.value)}
                    value={retryPositionKey}
                  >
                    {listCvPositionSchemas().map((option) => (
                      <option key={option.positionKey} value={option.positionKey}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    disabled={retryBusy}
                    onClick={() => void startRetryExtraction(profile.candidate.id, retryPositionKey)}
                    size="sm"
                    variant="secondary"
                  >
                    {retryBusy ? "Reading CV…" : "AI extract from CV"}
                  </Button>
                </div>
              ) : null}
              {retryError && !retryExtraction ? <p className="text-xs text-rose-600">{retryError}</p> : null}
              {retryExtraction ? (
                <CvExtractionReviewBoard
                  busy={retryBusy}
                  error={retryError}
                  fields={retryExtraction.fields}
                  onCancel={() => {
                    setRetryExtraction(null);
                    setRetryError(null);
                  }}
                  onSave={(values) => saveRetryExtraction(profile.candidate.id, values)}
                  saveLabel="Save extracted fields"
                  schema={getCvPositionSchema(retryPositionKey)!}
                />
              ) : null}
            </div>
          ) : null}

          {canManage ? (
            <div className="flex gap-2">
              <Input placeholder="Status" value={statusDraft} onChange={(e) => setStatusDraft(e.target.value)} />
              <Button
                variant="secondary"
                disabled={pending || !statusDraft.trim()}
                onClick={() =>
                  run(async () => {
                    await postJson(`/api/recruitment/candidates/${profile.candidate.id}/status`, { status: statusDraft.trim() });
                    setProfile((prev) => (prev ? { ...prev, candidate: { ...prev.candidate, status: statusDraft.trim() } } : prev));
                    return "Status updated.";
                  })
                }
              >
                Update status
              </Button>
            </div>
          ) : (
            <p className="text-xs text-slate-500">Status: {profile.candidate.status}</p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Applied positions</p>
              {profile.applications.length === 0 ? (
                <p className="text-xs text-slate-400">None</p>
              ) : (
                profile.applications.map((entry) => (
                  <p key={entry.application.id} className="text-xs text-slate-600">
                    {entry.jobTitle ?? "—"} · {titleCase(entry.application.stage)}
                  </p>
                ))
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Ratings (avg {profile.ratingAverage ?? "—"})
              </p>
              {profile.interviews.length === 0 ? (
                <p className="text-xs text-slate-400">No interviews</p>
              ) : (
                profile.interviews.map((entry) => (
                  <p key={entry.interview.id} className="text-xs text-slate-600">
                    {titleCase(entry.interview.interviewType)} · {entry.summary.average ?? "—"} · {entry.interview.outcome ?? "—"}
                  </p>
                ))
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">CV / files</p>
              {profile.files.length === 0 ? (
                <p className="text-xs text-slate-400">No files</p>
              ) : (
                profile.files.map((file) => (
                  <p key={file.id} className="text-xs text-slate-600">
                    {file.fileName}
                  </p>
                ))
              )}
              {profile.candidate.cvExternalUrl ? (
                <a className="text-xs text-orange-600" href={profile.candidate.cvExternalUrl} target="_blank" rel="noreferrer">
                  CV link
                </a>
              ) : null}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rejection history</p>
              {profile.rejectionHistory.length === 0 ? (
                <p className="text-xs text-slate-400">None</p>
              ) : (
                profile.rejectionHistory.map((event) => (
                  <p key={event.id} className="text-xs text-slate-600">
                    {titleCase(event.action)} · {event.reason ?? "—"}
                  </p>
                ))
              )}
            </div>
          </div>
          {profile.candidate.notes ? <p className="text-xs text-slate-600">Notes: {profile.candidate.notes}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function InterviewsSection({
  applicationId,
  canManage,
  error,
  interviews,
  managers,
  onReload,
}: {
  applicationId: string;
  canManage: boolean;
  error: string | null;
  interviews: Interview[];
  managers: ManagerOption[];
  onReload: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<InterviewType>("hr");
  const [interviewerHrId, setInterviewerHrId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [location, setLocation] = useState("");
  const [meetingLink, setMeetingLink] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState("");
  const [notes, setNotes] = useState("");

  const schedule = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/recruitment/applications/${applicationId}/interviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interviewType: type,
          interviewerHrId: interviewerHrId || undefined,
          scheduledAt: scheduledAt || undefined,
          location: location || undefined,
          meetingLink: meetingLink || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to schedule.");
      setInterviewerHrId("");
      setScheduledAt("");
      setLocation("");
      setMeetingLink("");
      onReload();
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : "Failed to schedule.");
    } finally {
      setBusy(false);
    }
  };

  const openRecord = (interview: Interview) => {
    setRecordingId(interview.id);
    const initial: Record<string, string> = {};
    for (const [key, value] of Object.entries(interview.score ?? {})) initial[key] = String(value);
    setScores(initial);
    setOutcome(interview.outcome ?? "");
    setNotes(interview.notes ?? "");
  };

  const saveRecord = async (interview: Interview) => {
    setBusy(true);
    setErr(null);
    try {
      const numericScores: Record<string, number> = {};
      for (const [key, value] of Object.entries(scores)) {
        const n = Number(value);
        if (Number.isFinite(n) && value !== "") numericScores[key] = n;
      }
      const res = await fetch(`/api/recruitment/interviews/${interview.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: outcome || null, score: numericScores, notes: notes || null }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to record.");
      setRecordingId(null);
      onReload();
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : "Failed to record.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Interviews</p>
      {(error ?? err) ? <p className="text-xs text-rose-600">{error ?? err}</p> : null}

      {interviews.length === 0 ? (
        <p className="text-xs text-slate-500">No interviews scheduled.</p>
      ) : (
        <ul className="space-y-2">
          {interviews.map((interview) => {
            const summary = summarizeScorecard(interview.interviewType, interview.score ?? {});
            return (
              <li key={interview.id} className="border border-slate-200 p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-800">{titleCase(interview.interviewType)}</span>
                  <span className="text-slate-500">
                    {interview.scheduledAt ? new Date(interview.scheduledAt).toLocaleString() : "Unscheduled"}
                  </span>
                </div>
                <div className="text-slate-500">
                  Outcome: {interview.outcome ? titleCase(interview.outcome) : "—"}
                  {summary.average !== null ? ` · Avg ${summary.average}/5` : ""}
                </div>
                {canManage ? (
                  recordingId === interview.id ? (
                    <div className="mt-2 space-y-1.5">
                      {interviewScorecardCriteria[interview.interviewType].map((criterion) => (
                        <label key={criterion.key} className="flex items-center justify-between gap-2">
                          <span>{criterion.label}</span>
                          <input
                            className="w-16 border border-slate-300 px-2 py-1"
                            max={5}
                            min={1}
                            type="number"
                            value={scores[criterion.key] ?? ""}
                            onChange={(e) => setScores((prev) => ({ ...prev, [criterion.key]: e.target.value }))}
                          />
                        </label>
                      ))}
                      <SearchableSelect className={fieldClass} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                        <option value="">Outcome…</option>
                        {interviewOutcomes.map((value) => (
                          <option key={value} value={value}>
                            {titleCase(value)}
                          </option>
                        ))}
                      </SearchableSelect>
                      <textarea className={fieldClass} placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
                      <div className="flex gap-2">
                        <Button disabled={busy} onClick={() => void saveRecord(interview)}>
                          Save
                        </Button>
                        <Button variant="ghost" disabled={busy} onClick={() => setRecordingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button className="mt-1" variant="secondary" onClick={() => openRecord(interview)}>
                      Record outcome
                    </Button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canManage ? (
        <div className="space-y-1.5 pt-1">
          <SearchableSelect className={fieldClass} value={type} onChange={(e) => setType(e.target.value as InterviewType)}>
            <option value="phone">Phone screen</option>
            <option value="hr">HR interview</option>
            <option value="hiring_manager">Hiring manager interview</option>
          </SearchableSelect>
          <SearchableSelect className={fieldClass} value={interviewerHrId} onChange={(e) => setInterviewerHrId(e.target.value)}>
            <option value="">Interviewer…</option>
            {managers.map((manager) => (
              <option key={manager.hrId} value={manager.hrId}>
                {manager.fullName} ({manager.hrId})
              </option>
            ))}
          </SearchableSelect>
          <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          <Input placeholder="Location (office / video)" value={location} onChange={(e) => setLocation(e.target.value)} />
          <Input placeholder="Meeting link" value={meetingLink} onChange={(e) => setMeetingLink(e.target.value)} />
          <Button disabled={busy} onClick={() => void schedule()}>
            Schedule interview
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FilesSection({
  candidateId,
  canUpload,
  error,
  files,
  filesEnabled,
  onReload,
}: {
  candidateId: string;
  canUpload: boolean;
  error: string | null;
  files: RecruitmentFile[];
  filesEnabled: boolean;
  onReload: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<RecruitmentFile | null>(null);

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setErr("Choose a file first.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("kind", "cv");
      const res = await fetch(`/api/recruitment/candidates/${candidateId}/files`, { method: "POST", body: formData });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Upload failed.");
      if (fileRef.current) fileRef.current.value = "";
      onReload();
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Files</p>
      {(error ?? err) ? <p className="text-xs text-rose-600">{error ?? err}</p> : null}
      {files.length === 0 ? (
        <p className="text-xs text-slate-500">No files.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {files.map((file) => (
            <li key={file.id} className="flex items-center justify-between gap-2">
              <span>
                {file.fileName} <span className="text-slate-400">({file.kind})</span>
              </span>
              <span className="flex items-center gap-2">
                {detectCvFileKind(file.mimeType ?? "", file.fileName) !== "unsupported" ? (
                  <Button variant="secondary" onClick={() => setPreviewFile(file)}>
                    Preview
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  onClick={() => window.open(`/api/recruitment/files/${file.id}/download`, "_blank")}
                >
                  Download
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {previewFile ? (
        <CvPreviewModal
          downloadUrl={`/api/recruitment/files/${previewFile.id}/download`}
          fileName={previewFile.fileName}
          mimeType={previewFile.mimeType}
          onClose={() => setPreviewFile(null)}
          previewTextUrl={`/api/recruitment/files/${previewFile.id}/preview-text`}
        />
      ) : null}
      {canUpload ? (
        filesEnabled ? (
          <div className="flex items-center gap-2">
            <input ref={fileRef} className="text-xs" type="file" />
            <Button variant="secondary" disabled={busy} onClick={() => void upload()}>
              Upload
            </Button>
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            File uploads need Google Drive credentials. Candidates can still include a CV link.
          </p>
        )
      ) : null}
    </div>
  );
}
