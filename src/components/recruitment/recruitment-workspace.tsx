"use client";

import { useRef, useState, useTransition } from "react";
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
import type { RecruitmentDashboard } from "@/lib/recruitment/dashboard";
import type { Candidate, Interview, InterviewType, RecruitmentActionKey, Requisition } from "@/lib/recruitment/types";
import { interviewOutcomes, interviewScorecardCriteria, summarizeScorecard } from "@/lib/recruitment/scorecards";
import type { OnboardingItem } from "@/lib/recruitment/onboarding";
import type { OfferLetterVersion } from "@/lib/recruitment/offer-letters";
import type { VacancyReportRow } from "@/lib/reports/vacancies";

type ManagerOption = { hrId: string; fullName: string };

type Props = {
  canApprove: boolean;
  canCreateRequisition: boolean;
  canImport: boolean;
  canManage: boolean;
  canManageCandidates: boolean;
  canViewCandidates: boolean;
  candidates: Candidate[];
  dashboard: RecruitmentDashboard | null;
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

const nextStageAction: Record<string, { action: RecruitmentActionKey; label: string; needsReason?: boolean }> = {
  in_candidate_pool: { action: "app_to_cv_screen", label: "Start CV screening" },
  cv_screening: { action: "app_to_phone_screen", label: "Move to phone screening" },
  phone_screening: { action: "app_to_interview_scheduling", label: "Move to interview scheduling" },
  interview_scheduling: { action: "app_to_hr_interview", label: "Move to HR interview" },
  hr_interview: { action: "app_record_hr_interview", label: "Record HR interview" },
  hiring_manager_interview: { action: "app_record_hm_interview", label: "Record manager interview" },
  final_selection: { action: "app_select", label: "Select for offer", needsReason: true },
};

const rejectableStages = new Set([
  "in_candidate_pool",
  "cv_screening",
  "phone_screening",
  "interview_scheduling",
  "hr_interview",
  "hiring_manager_interview",
  "final_selection",
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
          canManage={props.canManage}
          managers={props.managers}
          pending={pending}
          run={run}
        />
      ) : tab === "requisitions" ? (
        <RequisitionsTab
          canCreate={props.canCreateRequisition}
          canManage={props.canManage}
          managers={props.managers}
          openVacancies={props.openVacancies}
          pending={pending}
          requisitions={requisitions}
          run={run}
        />
      ) : (
        <CandidatesTab
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
  canManage,
  managers,
  pending,
  run,
}: {
  applications: ApplicationWithContext[];
  canApprove: boolean;
  canManage: boolean;
  managers: ManagerOption[];
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [baseSalary, setBaseSalary] = useState("");
  const [startDate, setStartDate] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [manualHrId, setManualHrId] = useState("");
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [interviewsError, setInterviewsError] = useState<string | null>(null);
  const [onboardingItems, setOnboardingItems] = useState<OnboardingItem[]>([]);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [offerLetters, setOfferLetters] = useState<OfferLetterVersion[]>([]);
  const [offerLettersError, setOfferLettersError] = useState<string | null>(null);

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

  const loadOnboarding = async (appId: string) => {
    try {
      const res = await fetch(`/api/recruitment/applications/${appId}/onboarding`);
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to load onboarding.");
      setOnboardingItems(Array.isArray(data.items) ? (data.items as OnboardingItem[]) : []);
      setOnboardingError(null);
    } catch (caught) {
      setOnboardingItems([]);
      setOnboardingError(caught instanceof Error ? caught.message : "Failed to load onboarding.");
    }
  };

  const loadOfferLetters = async (offerId: string) => {
    try {
      const res = await fetch(`/api/recruitment/offers/${offerId}/letter`);
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to load offer letters.");
      setOfferLetters(Array.isArray(data.versions) ? (data.versions as OfferLetterVersion[]) : []);
      setOfferLettersError(null);
    } catch (caught) {
      setOfferLetters([]);
      setOfferLettersError(caught instanceof Error ? caught.message : "Failed to load offer letters.");
    }
  };

  const selectApplication = (appId: string) => {
    setSelectedId(appId);
    void loadInterviews(appId);
    void loadOnboarding(appId);
    const application = applications.find((row) => row.id === appId);
    if (application?.offerId) void loadOfferLetters(application.offerId);
    else setOfferLetters([]);
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
              </tr>
            </thead>
            <tbody>
              {applications.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-slate-500" colSpan={3}>
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

            {canManage && selected.stage === "offer_initiated" ? (
              <div className="space-y-2 border-t border-slate-200 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Send offer</p>
                <Input placeholder="Base salary" type="number" value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} />
                <Input placeholder="Start date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                <Input placeholder="Expires in days" type="number" value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} />
                <Button
                  disabled={pending || !baseSalary || !startDate}
                  onClick={() =>
                    run(async () => {
                      await postJson(`/api/recruitment/applications/${selected.id}/offer`, {
                        baseSalary: Number(baseSalary),
                        startDate,
                        expiresInDays: Number(expiresInDays) || 7,
                      });
                      return "Offer sent to the candidate.";
                    })
                  }
                >
                  Send offer
                </Button>
              </div>
            ) : null}

            {selected.stage === "offer_sent" ? (
              <p className="text-xs text-slate-500">Waiting on the candidate&apos;s decision (synced from the offer link).</p>
            ) : null}

            {canApprove && (selected.stage === "offer_accepted" || selected.stage === "pre_boarding") ? (
              <div className="space-y-2 border-t border-slate-200 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Approve &amp; hire</p>
                <Input placeholder="Manual HR ID (optional)" value={manualHrId} onChange={(e) => setManualHrId(e.target.value)} />
                <Button
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const data = await postJson(`/api/recruitment/applications/${selected.id}/convert`, {
                        manualHrId: manualHrId.trim() || undefined,
                      });
                      setManualHrId("");
                      return `Hired as ${typeof data.employeeHrId === "string" ? data.employeeHrId : "a new employee"}.`;
                    })
                  }
                >
                  Approve &amp; hire
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

            <OnboardingSection
              canManage={canManage}
              error={onboardingError}
              items={onboardingItems}
              onReload={() => loadOnboarding(selected.id)}
            />

            {selected.offerId ? (
              <OfferLetterSection
                canManage={canManage}
                error={offerLettersError}
                offerId={selected.offerId}
                onReload={() => {
                  if (selected.offerId) void loadOfferLetters(selected.offerId);
                }}
                versions={offerLetters}
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
  canManage,
  managers,
  openVacancies,
  pending,
  requisitions,
  run,
}: {
  canCreate: boolean;
  canManage: boolean;
  managers: ManagerOption[];
  openVacancies: VacancyReportRow[];
  pending: boolean;
  requisitions: Requisition[];
  run: (work: () => Promise<string | void>) => void;
}) {
  const [vacancyId, setVacancyId] = useState("");
  const [grade, setGrade] = useState("");
  const [bandMin, setBandMin] = useState("");
  const [bandMax, setBandMax] = useState("");
  const [ownerHrId, setOwnerHrId] = useState("");
  const [priority, setPriority] = useState("normal");
  const [deadline, setDeadline] = useState("");

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
            <select className={fieldClass} value={vacancyId} onChange={(e) => setVacancyId(e.target.value)}>
              <option value="">Select an open vacancy…</option>
              {openVacancies.map((vacancy) => (
                <option key={vacancy.id} value={vacancy.id}>
                  {vacancy.vacancyCode} · {vacancy.jobTitle ?? vacancy.positionTitle ?? "Role"} · {vacancy.areaName ?? ""}
                </option>
              ))}
            </select>
            <select className={fieldClass} value={ownerHrId} onChange={(e) => setOwnerHrId(e.target.value)}>
              <option value="">Recruitment owner…</option>
              {managers.map((manager) => (
                <option key={manager.hrId} value={manager.hrId}>
                  {manager.fullName} ({manager.hrId})
                </option>
              ))}
            </select>
            <select className={fieldClass} value={priority} onChange={(e) => setPriority(e.target.value)}>
              {["low", "normal", "high", "urgent"].map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)} priority
                </option>
              ))}
            </select>
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
  canImport,
  canManage,
  candidates,
  openRequisitions,
  pending,
  run,
  setError,
  setNotice,
}: {
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
  const [fullName, setFullName] = useState("");
  const [nationalId, setNationalId] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [startReq, setStartReq] = useState<Record<string, string>>({});

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
        </AdminTableShell>
      ) : null}

      <AdminTableShell title="Candidate pool" description="Candidates in the pool. Start an application against an open requisition.">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Start application</th>
              </tr>
            </thead>
            <tbody>
              {candidates.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-slate-500" colSpan={4}>
                    No candidates with applications yet. Add a candidate and start an application.
                  </td>
                </tr>
              ) : (
                candidates.map((candidate) => (
                  <tr key={candidate.id}>
                    <td className="px-3 py-2 font-medium text-slate-900">{candidate.fullName}</td>
                    <td className="px-3 py-2">{candidate.email ?? "—"}</td>
                    <td className="px-3 py-2">{candidate.phone ?? "—"}</td>
                    <td className="px-3 py-2">
                      {canManage ? (
                        <div className="flex gap-1.5">
                          <select
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
                          </select>
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
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to schedule.");
      setInterviewerHrId("");
      setScheduledAt("");
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
                      <select className={fieldClass} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                        <option value="">Outcome…</option>
                        {interviewOutcomes.map((value) => (
                          <option key={value} value={value}>
                            {titleCase(value)}
                          </option>
                        ))}
                      </select>
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
          <select className={fieldClass} value={type} onChange={(e) => setType(e.target.value as InterviewType)}>
            <option value="phone">Phone screen</option>
            <option value="hr">HR interview</option>
            <option value="hiring_manager">Hiring manager interview</option>
          </select>
          <select className={fieldClass} value={interviewerHrId} onChange={(e) => setInterviewerHrId(e.target.value)}>
            <option value="">Interviewer…</option>
            {managers.map((manager) => (
              <option key={manager.hrId} value={manager.hrId}>
                {manager.fullName} ({manager.hrId})
              </option>
            ))}
          </select>
          <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          <Button disabled={busy} onClick={() => void schedule()}>
            Schedule interview
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function OnboardingSection({
  canManage,
  error,
  items,
  onReload,
}: {
  canManage: boolean;
  error: string | null;
  items: OnboardingItem[];
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const patch = async (itemId: string, body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/recruitment/onboarding/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Update failed.");
      onReload();
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  };

  if (items.length === 0) {
    return (
      <div className="space-y-1 border-t border-slate-200 pt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Onboarding</p>
        <p className="text-xs text-slate-500">Move the candidate to pre-boarding to start the document checklist.</p>
      </div>
    );
  }

  const documents = items.filter((item) => item.category === "document");
  const joining = items.filter((item) => item.category === "joining");

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Onboarding</p>
      {(error ?? err) ? <p className="text-xs text-rose-600">{error ?? err}</p> : null}

      {documents.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold text-slate-600">Documents</p>
          <ul className="space-y-1">
            {documents.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-1.5 text-xs">
                <span>{item.label}</span>
                <span className="flex items-center gap-1.5">
                  <span className="text-slate-500">{titleCase(item.status)}</span>
                  {canManage ? (
                    <>
                      <Button variant="secondary" disabled={busy} onClick={() => void patch(item.id, { status: "approved" })}>
                        Approve
                      </Button>
                      <Button variant="ghost" disabled={busy} onClick={() => void patch(item.id, { status: "rejected" })}>
                        Reject
                      </Button>
                      <Button variant="ghost" disabled={busy} onClick={() => void patch(item.id, { status: "waived" })}>
                        Waive
                      </Button>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {joining.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold text-slate-600">Joining tasks</p>
          <ul className="space-y-1">
            {joining.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-1.5 text-xs">
                <span>{item.label}</span>
                <span className="flex items-center gap-1.5">
                  <span className="text-slate-500">{titleCase(item.status)}</span>
                  {canManage ? (
                    item.status === "completed" ? (
                      <Button variant="ghost" disabled={busy} onClick={() => void patch(item.id, { status: "pending" })}>
                        Reset
                      </Button>
                    ) : (
                      <Button variant="secondary" disabled={busy} onClick={() => void patch(item.id, { status: "completed" })}>
                        Mark done
                      </Button>
                    )
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function OfferLetterSection({
  canManage,
  error,
  offerId,
  onReload,
  versions,
}: {
  canManage: boolean;
  error: string | null;
  offerId: string;
  onReload: () => void;
  versions: OfferLetterVersion[];
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/recruitment/offers/${offerId}/letter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to generate letter.");
      onReload();
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : "Failed to generate letter.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Offer letter</p>
      {(error ?? err) ? <p className="text-xs text-rose-600">{error ?? err}</p> : null}
      {versions.length === 0 ? (
        <p className="text-xs text-slate-500">No letter generated yet.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {versions.map((versionItem) => (
            <li key={versionItem.id} className="flex items-center justify-between gap-2">
              <span>Version {versionItem.version}</span>
              <Button
                variant="secondary"
                onClick={() => window.open(`/api/recruitment/offer-letter/${versionItem.id}`, "_blank")}
              >
                Open / Save PDF
              </Button>
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <Button disabled={busy} onClick={() => void generate()}>
          Generate letter
        </Button>
      ) : null}
    </div>
  );
}
