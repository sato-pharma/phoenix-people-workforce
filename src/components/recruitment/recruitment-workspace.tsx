"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
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
import { resolveFixedSalaryAmounts } from "@/lib/payroll/policy";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import { documentsComplete, type OnboardingItem } from "@/lib/recruitment/onboarding-checklist";
import type { OfferLetterVersion } from "@/lib/recruitment/offer-letters";
import type { VacancyReportRow } from "@/lib/reports/vacancies";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { BulkCvExtractionPanel } from "@/components/recruitment/bulk-cv-extraction-panel";
import { CvExtractionPanel } from "@/components/recruitment/cv-extraction-panel";
import { CvExtractionReviewBoard } from "@/components/recruitment/cv-extraction-review-board";
import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
import type { ExtractedCandidateFields } from "@/lib/recruitment/cv-extraction";
import { defaultCvPositionKey, getCvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
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

function OfferSalaryPreview({ baseSalary, jobTitle }: { baseSalary: string; jobTitle: string | null | undefined }) {
  const base = Number(baseSalary);
  if (!Number.isFinite(base) || base <= 0) return null;
  const allowances = resolveStandardSalaryAllowances({ jobTitle: jobTitle ?? null });
  const fixed = resolveFixedSalaryAmounts({
    baseSalary: base,
    extraCostOfLiving: allowances.extraCostOfLiving,
    fuelAllowance: allowances.fuelAllowance,
  });
  const rows: Array<[string, number]> = [
    ["Base salary", fixed.baseSalary],
    ["Basic salary", fixed.basicSalary],
    ["Extra cost of living", allowances.extraCostOfLiving],
    ["Fuel allowance", allowances.fuelAllowance],
    ["Net salary", fixed.netSalary],
  ];
  return (
    <div className="border border-slate-200 bg-slate-50 p-2 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between">
          <span className="text-slate-500">{label}</span>
          <span className="font-semibold text-slate-900">{value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

type OfferApprovalStep = {
  id: string;
  sequence: number;
  approverKind: string;
  approverRole: string | null;
  approverHrId: string | null;
  required: boolean;
  decision: string;
  canAct: boolean;
  reason: string | null;
};

function approverLabel(step: OfferApprovalStep): string {
  if (step.approverKind === "person") {
    return `Department Head${step.approverHrId ? ` (${step.approverHrId})` : ""}`;
  }
  if (step.approverRole === "Super Admin") return "HR Manager";
  if (step.approverRole === "Finance Manager") return "Finance";
  return step.approverRole ?? "Approver";
}

// Staged offer pipeline: prepare -> approval chain -> generate -> send, plus the
// negotiation re-prepare loop. Self-contained (own busy/notice state + chain fetch).
function OfferPipelinePanel({ application, canManage }: { application: ApplicationWithContext; canManage: boolean }) {
  const router = useRouter();
  const appId = application.id;
  const stage = application.stage;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [baseSalary, setBaseSalary] = useState("");
  const [startDate, setStartDate] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [probationMonths, setProbationMonths] = useState("3");
  const [benefitsText, setBenefitsText] = useState("");
  const [reason, setReason] = useState("");
  const [steps, setSteps] = useState<OfferApprovalStep[]>([]);
  const offerAttachmentsRef = useRef<HTMLInputElement>(null);

  const reloadChain = useCallback(async () => {
    try {
      const res = await fetch(`/api/recruitment/applications/${appId}/offer/approval`);
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setSteps(Array.isArray(data.steps) ? (data.steps as OfferApprovalStep[]) : []);
    } catch {
      setSteps([]);
    }
  }, [appId]);

  useEffect(() => {
    if (stage !== "offer_pending_approval") return;
    let active = true;
    void (async () => {
      try {
        const res = await fetch(`/api/recruitment/applications/${appId}/offer/approval`);
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (active) setSteps(Array.isArray(data.steps) ? (data.steps as OfferApprovalStep[]) : []);
      } catch {
        if (active) setSteps([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [stage, appId]);

  const offerStages = [
    "offer_initiated",
    "offer_draft",
    "offer_pending_approval",
    "offer_approved",
    "offer_generated",
    "offer_negotiation",
  ];
  if (!canManage || !offerStages.includes(stage)) return null;

  const act = (work: () => Promise<string>) => {
    setBusy(true);
    setErr(null);
    setNote(null);
    void (async () => {
      try {
        const message = await work();
        setNote(message);
        router.refresh();
      } catch (caught) {
        setErr(caught instanceof Error ? caught.message : "Request failed.");
      } finally {
        setBusy(false);
      }
    })();
  };

  const benefitsPayload = () =>
    benefitsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf(":");
        return idx >= 0
          ? { label: line.slice(0, idx).trim(), detail: line.slice(idx + 1).trim() }
          : { label: line, detail: "" };
      })
      .filter((benefit) => benefit.label);

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Offer pipeline</p>
      {note ? <p className="text-xs text-emerald-600">{note}</p> : null}
      {err ? <p className="text-xs text-rose-600">{err}</p> : null}

      {stage === "offer_initiated" ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            From requisition: {application.requisition?.jobTitle ?? "—"} · Manager{" "}
            {application.requisition?.hiringManagerHrId ?? "—"}
          </p>
          <Input placeholder="Base salary" type="number" value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} />
          <Input placeholder="Start date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <Input placeholder="Probation (months)" type="number" value={probationMonths} onChange={(e) => setProbationMonths(e.target.value)} />
          <Input placeholder="Expires in days" type="number" value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} />
          <textarea
            className={fieldClass}
            placeholder="Benefits — one per line as 'Label: detail'"
            value={benefitsText}
            onChange={(e) => setBenefitsText(e.target.value)}
          />
          <OfferSalaryPreview baseSalary={baseSalary} jobTitle={application.requisition?.jobTitle} />
          <Button
            disabled={busy || !baseSalary}
            onClick={() =>
              act(async () => {
                await postJson(`/api/recruitment/applications/${appId}/offer/prepare`, {
                  baseSalary: Number(baseSalary),
                  startDate: startDate || undefined,
                  expiresInDays: Number(expiresInDays) || 7,
                  probationPeriodMonths: Number(probationMonths) || 3,
                  benefits: benefitsPayload(),
                });
                return "Offer draft prepared.";
              })
            }
          >
            Prepare offer draft
          </Button>
        </div>
      ) : null}

      {stage === "offer_draft" ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">Offer draft ready. Submit it to start the approval chain.</p>
          <Button
            disabled={busy}
            onClick={() =>
              act(async () => {
                await postJson(`/api/recruitment/applications/${appId}/offer/submit-approval`, {});
                return "Submitted for approval.";
              })
            }
          >
            Submit for approval
          </Button>
        </div>
      ) : null}

      {stage === "offer_pending_approval" ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">Approval chain</p>
          {steps.length === 0 ? (
            <p className="text-xs text-slate-500">Loading…</p>
          ) : (
            <ul className="space-y-2 text-xs">
              {steps.map((step) => (
                <li key={step.id} className="border border-slate-200 p-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-900">{approverLabel(step)}</span>
                    <span
                      className={
                        step.decision === "approved"
                          ? "text-emerald-600"
                          : step.decision === "rejected"
                            ? "text-rose-600"
                            : "text-slate-500"
                      }
                    >
                      {titleCase(step.decision)}
                    </span>
                  </div>
                  {step.canAct ? (
                    <div className="mt-2 flex gap-2">
                      <Button
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            await postJson(`/api/recruitment/applications/${appId}/offer/approval`, {
                              stepId: step.id,
                              decision: "approved",
                            });
                            await reloadChain();
                            return "Approval recorded.";
                          })
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={busy || !reason.trim()}
                        onClick={() =>
                          act(async () => {
                            await postJson(`/api/recruitment/applications/${appId}/offer/approval`, {
                              stepId: step.id,
                              decision: "rejected",
                              reason: reason.trim(),
                            });
                            await reloadChain();
                            setReason("");
                            return "Rejection recorded.";
                          })
                        }
                      >
                        Reject
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <textarea
            className={fieldClass}
            placeholder="Reason (required to reject)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      ) : null}

      {stage === "offer_approved" ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">Approved. Generate the offer letter + salary summary.</p>
          <Button
            disabled={busy}
            onClick={() =>
              act(async () => {
                const data = await postJson(`/api/recruitment/applications/${appId}/offer/generate`, {});
                return `Documents generated${typeof data.version === "number" ? ` (V${data.version})` : ""}.`;
              })
            }
          >
            Generate documents
          </Button>
        </div>
      ) : null}

      {stage === "offer_generated" ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            Documents generated. The offer-letter PDF is attached automatically — add any extra files (signed
            contract, etc.) below, then send.
          </p>
          <input
            ref={offerAttachmentsRef}
            type="file"
            multiple
            className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-slate-700 hover:file:bg-slate-200"
          />
          <Button
            disabled={busy}
            onClick={() =>
              act(async () => {
                const files = Array.from(offerAttachmentsRef.current?.files ?? []);
                // Mirror the server caps so HR gets an immediate error instead of a partial
                // send (the route hard-rejects >6 files or an oversized total).
                if (files.length > 6) {
                  throw new Error("You can attach at most 6 files. Remove some and try again.");
                }
                const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
                if (totalBytes > 25 * 1024 * 1024) {
                  throw new Error("Attachments exceed the 25 MB total limit.");
                }
                if (files.length > 0) {
                  const form = new FormData();
                  for (const file of files) form.append("attachments", file);
                  const res = await fetch(`/api/recruitment/applications/${appId}/offer/send`, {
                    method: "POST",
                    body: form,
                  });
                  if (!res.ok) {
                    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
                    throw new Error(
                      (typeof data.message === "string" && data.message) ||
                        (typeof data.error === "string" && data.error) ||
                        "Failed to send the prepared offer.",
                    );
                  }
                } else {
                  await postJson(`/api/recruitment/applications/${appId}/offer/send`, {});
                }
                if (offerAttachmentsRef.current) offerAttachmentsRef.current.value = "";
                return files.length > 0
                  ? `Offer sent with the PDF + ${files.length} attachment${files.length === 1 ? "" : "s"}.`
                  : "Offer sent to the candidate (with offer-letter PDF).";
              })
            }
          >
            Send offer
          </Button>
        </div>
      ) : null}

      {stage === "offer_negotiation" ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">Candidate requested negotiation. Re-prepare a new version.</p>
          <Button
            disabled={busy}
            onClick={() =>
              act(async () => {
                await postJson(`/api/recruitment/applications/${appId}/offer/renegotiate`, {});
                return "Offer returned to draft for a new version.";
              })
            }
          >
            Re-prepare (new version)
          </Button>
        </div>
      ) : null}
    </div>
  );
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
  const [manualHrId, setManualHrId] = useState("");
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [interviewsError, setInterviewsError] = useState<string | null>(null);
  const [onboardingItems, setOnboardingItems] = useState<OnboardingItem[]>([]);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [offerLetters, setOfferLetters] = useState<OfferLetterVersion[]>([]);
  const [offerLettersError, setOfferLettersError] = useState<string | null>(null);
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
    void loadOnboarding(appId);
    const application = applications.find((row) => row.id === appId);
    if (application?.offerId) void loadOfferLetters(application.offerId);
    else setOfferLetters([]);
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

            <OfferPipelinePanel application={selected} canManage={canManage} />

            {selected.stage === "offer_sent" ? (
              <p className="text-xs text-slate-500">Waiting on the candidate&apos;s decision (synced from the offer link).</p>
            ) : null}

            {canApprove && (selected.stage === "offer_accepted" || selected.stage === "pre_boarding") ? (
              <div className="space-y-2 border-t border-slate-200 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Approve &amp; hire</p>
                {selected.seniorApprovalStatus === "approved" ? (
                  <p className="text-xs text-emerald-600">Senior sign-off complete.</p>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() =>
                      run(async () => {
                        await postJson(`/api/recruitment/applications/${selected.id}/senior-approval`, {});
                        return "Senior sign-off recorded.";
                      })
                    }
                  >
                    Senior sign-off (Super Admin)
                  </Button>
                )}
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

  // Re-run AI extraction on a candidate that already has a CV on file — for one manually
  // created, or where the first extraction pass wasn't saved as-is. Reuses the same
  // cv-extract endpoint and drag-and-drop review board as the "create from CV" flow.
  const startRetryExtraction = async (candidateId: string) => {
    setRetryBusy(true);
    setRetryError(null);
    try {
      const res = await fetch(`/api/recruitment/candidates/${candidateId}/cv-extract`, { method: "POST" });
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
        <div className="space-y-3 border border-slate-200 p-4">
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
              }}
            >
              Close
            </Button>
          </div>

          {canManage && profile.files.some((file) => file.kind === "cv") ? (
            <div className="space-y-2">
              {!retryExtraction ? (
                <Button
                  disabled={retryBusy}
                  onClick={() => void startRetryExtraction(profile.candidate.id)}
                  size="sm"
                  variant="secondary"
                >
                  {retryBusy ? "Reading CV…" : "AI extract from CV"}
                </Button>
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
                  schema={getCvPositionSchema(defaultCvPositionKey)!}
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
          <p className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-slate-600">
            Documents
            {documentsComplete(documents.map((item) => item.status)) ? (
              <span className="bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">Documents Verified</span>
            ) : (
              <span className="bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">Documents Pending</span>
            )}
          </p>
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
                      <Button variant="ghost" disabled={busy} onClick={() => void patch(item.id, { status: "missing" })}>
                        Missing
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
          <p className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-slate-600">
            Joining tasks
            <span className="bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">Joining Scheduled</span>
          </p>
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
              <span>
                V{versionItem.version} · {versionItem.kind === "salary_summary" ? "Salary summary" : "Offer letter"}
              </span>
              <Button
                variant="secondary"
                onClick={() =>
                  window.open(
                    versionItem.kind === "salary_summary"
                      ? `/api/recruitment/salary-summary/${versionItem.id}`
                      : `/api/recruitment/offer-letter/${versionItem.id}`,
                    "_blank",
                  )
                }
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
