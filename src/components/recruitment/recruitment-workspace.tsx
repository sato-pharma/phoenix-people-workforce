"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Briefcase,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Eye,
  FileSpreadsheet,
  Send,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";

import {
  AdminCallout,
  AdminPageHero,
  AdminSectionHeader,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Input } from "@/components/ui/input";
import type { ApplicationWithContext } from "@/lib/recruitment/applications";
import type { CandidateProfile } from "@/lib/recruitment/candidates";
import { APPLIED_FOR_SOURCE_LABEL, APPLIED_FOR_SOURCE_SHORT, candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import { candidateDisplayName, isShortenedCandidateName } from "@/lib/recruitment/candidate-display";
import {
  applicationStageLabel,
  humanizeRecruitmentTerm,
  requisitionStatusLabel,
} from "@/lib/recruitment/labels";
// offer-rules is the pure half of the offer service — no database imports — so the same
// completeness check runs in the browser and on the server without pulling a Supabase client in.
import { isOfferStage, missingOfferTerms } from "@/lib/recruitment/offer-rules";
import type { Offer } from "@/lib/recruitment/offers";
import {
  candidateSourceChannel,
  type CandidateSourceChannelKey,
} from "@/lib/recruitment/candidate-source-context";
import { cairoDayKey, type CandidatePoolStats } from "@/lib/recruitment/candidate-stats";
import type { HiringManagerOption } from "@/lib/recruitment/hiring-manager-notify";
import type { SelectionBoardEntry } from "@/lib/recruitment/selection";
import type { RecruitmentDashboard } from "@/lib/recruitment/dashboard";
import {
  computePipelineMetrics,
  daysInStage,
  STALLED_AFTER_DAYS,
} from "@/lib/recruitment/pipeline-metrics";
import { isTerminalApplicationStage } from "@/lib/recruitment/types";
import type { Candidate, Interview, InterviewType, RecruitmentActionKey, RecruitmentFile, Requisition } from "@/lib/recruitment/types";
import {
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  candidateStatuses,
  candidateStatusLabel,
  candidateStatusLabels,
  normalizeCandidateStatus,
  type CandidateStatus,
} from "@/lib/recruitment/candidate-status";
import {
  NON_EGYPTIAN_FLAG_LABEL,
  isStatedNonEgyptian,
  nonEgyptianFlagTitle,
} from "@/lib/recruitment/nationality";
import { NOT_A_CV_LABEL, NOT_A_CV_TITLE, isNotACv } from "@/lib/recruitment/not-a-cv";
import { interviewOutcomes, interviewScorecardCriteria, summarizeScorecard } from "@/lib/recruitment/scorecards";
import type { VacancyReportRow } from "@/lib/reports/vacancies";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { BulkCvExtractionPanel } from "@/components/recruitment/bulk-cv-extraction-panel";
import { CandidateFieldsPanel } from "@/components/recruitment/candidate-fields-panel";
import { CvExtractionPanel } from "@/components/recruitment/cv-extraction-panel";
import { CvExtractionReviewBoard } from "@/components/recruitment/cv-extraction-review-board";
import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
import {
  countUnappliedCvFields,
  seedReviewFieldsFromCandidate,
  type ExtractedCandidateFields,
  type StoredCvExtraction,
} from "@/lib/recruitment/cv-extraction-fields";
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
  // Counted on the server, deliberately — "arrived today" depends on the clock, and a clock read
  // during hydration can disagree with the one from the server render. See candidate-stats.ts.
  candidateStats: CandidatePoolStats;
  dashboard: RecruitmentDashboard | null;
  filesEnabled: boolean;
  // The ~30 real managers a candidate can be sent to, straight from their job title. Distinct from
  // `managers` below, which is the whole employee directory and fills the requisition form.
  hiringManagers: HiringManagerOption[];
  initialError: string | null;
  managers: ManagerOption[];
  openVacancies: VacancyReportRow[];
};

type TabKey = "pipeline" | "requisitions" | "candidates";

const fieldClass =
  "w-full border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-orange-400 focus:outline-none";

// Same look as the candidate pool's filter labels (poolFilterLabelClass), but rendered as a plain
// div/span rather than a <label>. SearchableSelect is a portalled combobox, not a native <select>,
// so an implicit label would re-target the click and reopen the panel the user just dismissed.
const requisitionFieldLabelClass = "text-[11px] font-semibold uppercase tracking-wide text-slate-500";

/**
 * A labelled cell in the "Open a requisition" grid.
 *
 * Every control in this form used to carry its name in a placeholder only. A placeholder is not a
 * label: it vanishes the instant a value lands, and it cannot say which of two mutually exclusive
 * paths a field belongs to. That is what made the typed-title path unreachable in practice — the
 * job-title input sits in the grid cell directly beneath the vacant-seat combobox, so an open
 * dropdown panel covers it, and with nothing but grey placeholder text to go on it read as part of
 * the same cascade rather than the alternative to it.
 */
function RequisitionField({ hint, label, children }: { hint?: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={requisitionFieldLabelClass}>{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-slate-500">{hint}</span> : null}
    </div>
  );
}

// Every moment this module shows a person is Cairo local time, never a raw UTC string.
function cairoDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "—";
  const date = value.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
  const time = value.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Cairo",
  });
  return `${date} · ${time}`;
}

// Light-touch color coding for stage/status pills — shared by the mobile cards and
// the desktop tables below so both surfaces read consistently at a glance. Purely
// presentational: it maps existing stage/status strings to a color, nothing more.
type BadgeTone = "orange" | "emerald" | "amber" | "rose" | "sky" | "slate";

const badgeToneClassName: Record<BadgeTone, string> = {
  amber: "bg-amber-100 text-amber-700",
  emerald: "bg-emerald-100 text-emerald-700",
  orange: "bg-orange-100 text-orange-700",
  rose: "bg-rose-100 text-rose-700",
  sky: "bg-sky-100 text-sky-700",
  slate: "bg-slate-100 text-slate-600",
};

function StagePill({ children, tone }: { children: ReactNode; tone: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        badgeToneClassName[tone],
      )}
    >
      {children}
    </span>
  );
}

// Intake channel -> pill colour. Presentational only: the channel itself is decided in the domain
// (candidateSourceChannel), so a new channel gets its label there and its colour here, never a guess.
const sourceChannelTone: Record<CandidateSourceChannelKey, BadgeTone> = {
  email: "sky",
  manual: "slate",
  other: "slate",
  whatsapp: "emerald",
};

const stageToneMap: Record<string, BadgeTone> = {
  application_received: "slate",
  in_candidate_pool: "slate",
  cv_screening: "sky",
  phone_screening: "sky",
  interview_scheduling: "sky",
  hr_interview: "sky",
  hiring_manager_interview: "sky",
  shortlisted: "orange",
  manager_interview_completed: "orange",
  final_selection: "orange",
  backup_candidate: "amber",
  on_hold: "amber",
  no_response: "amber",
  call_back: "amber",
  offer_draft: "orange",
  offer_pending_approval: "orange",
  offer_approved: "orange",
  offer_generated: "orange",
  offer_negotiation: "orange",
  offer_initiated: "orange",
  offer_sent: "orange",
  offer_accepted: "emerald",
  pre_boarding: "emerald",
  hired: "emerald",
  offer_declined: "rose",
  offer_expired: "rose",
  application_rejected: "rose",
  application_withdrawn: "rose",
};

function stageTone(stage: string): BadgeTone {
  return stageToneMap[stage] ?? "slate";
}

const requisitionStatusToneMap: Record<string, BadgeTone> = {
  req_draft: "slate",
  req_open: "sky",
  req_published: "orange",
  req_on_hold: "amber",
  req_filled: "emerald",
  req_closed: "rose",
  req_cancelled: "rose",
};

function requisitionStatusTone(status: string): BadgeTone {
  return requisitionStatusToneMap[status] ?? "slate";
}

// The same colour language the stage pills use. `new` stays grey deliberately: nearly every row in
// the pool is new, and a screen where every pill is coloured tells the eye nothing.
const candidateStatusToneMap: Record<CandidateStatus, BadgeTone> = {
  hired: "emerald",
  new: "slate",
  rejected: "rose",
  sent_to_manager: "orange",
  shortlisted: "sky",
};

function candidateStatusTone(status: string | null | undefined): BadgeTone {
  const normalized = normalizeCandidateStatus(status);
  return normalized ? candidateStatusToneMap[normalized] : "slate";
}

// Shared shape for the per-status requisition workflow buttons — used by both the
// desktop table cell and the mobile card's actions slot (RequisitionActionsControl).
type RequisitionActionItem = {
  action: RecruitmentActionKey;
  label: string;
  reason?: boolean;
  variant?: "default" | "secondary" | "destructive";
};
type RequisitionActionsMap = Record<string, RequisitionActionItem[]>;

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

/**
 * PATCH, which this file did not have — and its absence was a silent, total defect.
 *
 * The candidate status route exports PATCH and only PATCH, but the one control that wrote a status
 * called postJson against it. Next.js answers a POST to a PATCH-only route with 405, so every
 * "Update status" click in the history of this module failed, and the error surfaced as a generic
 * "Request failed." That is a large part of why 225 of the 226 candidates in production still carry
 * the database default: the button was never capable of changing it.
 */
async function patchJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "PATCH",
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


/**
 * The one action the module exists for: put this candidate in front of the hiring manager.
 *
 * It sits at the TOP of the actions panel, above every stage control, because it is the thing a
 * recruiter actually comes here to do. Before this it had no button at all — the send fired as a
 * hidden side effect of choosing a requisition, inside a catch that swallowed failures, so 3 of
 * production's 5 assignments told nobody and looked identical to the 2 that worked.
 *
 * The line above the button is the whole point: it reads back the recorded send, so "has the
 * manager been told?" is answered on screen instead of guessed. It survives a reload because it
 * comes from the audit row, not from component state.
 */
function SendToManagerCard({
  application,
  pending,
  run,
}: {
  application: ApplicationWithContext;
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
}) {
  const managerName =
    application.requisition?.hiringManagerName ?? application.requisition?.hiringManagerHrId ?? null;
  const notified = application.managerNotified;

  return (
    <div className="space-y-2 border border-orange-200 bg-orange-50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-orange-700">Send to the hiring manager</p>
      {managerName ? (
        <p className="text-xs text-slate-600">
          {notified
            ? `Sent to ${notified.managerName} on ${cairoDateTime(notified.sentAt)}.`
            : `${managerName} has not been told about this candidate yet.`}
        </p>
      ) : (
        <p className="text-xs text-slate-600">
          This position has no hiring manager on record, so there is nobody to send it to. Set one on the
          requisition first.
        </p>
      )}
      <Button
        disabled={pending || !managerName}
        onClick={() =>
          run(async () => {
            const data = await postJson(`/api/recruitment/applications/${application.id}/notify-manager`, {});
            const result = (data.result ?? {}) as { managerName?: unknown; reason?: unknown; sent?: unknown };
            if (result.sent !== true) {
              return result.reason === "actor_is_the_manager"
                ? "You are the hiring manager for this position — no message was sent."
                : "This position has no hiring manager on record, so nothing was sent.";
            }
            const name = typeof result.managerName === "string" ? result.managerName : "the hiring manager";
            return `Sent to ${name}.`;
          })
        }
      >
        {notified ? "Send again" : "Send to manager"}
      </Button>
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

/**
 * The offer, from draft to the candidate's answer.
 *
 * Everything here posts to one route with an `intent`; the server decides what is allowed. The
 * buttons are shown by stage so the recruiter sees the one thing to do next, but hiding a button
 * is not the gate — approval is Super-Admin-only in the workflow registry, and sending refuses
 * outright while the offer is unapproved.
 */
function OfferCard({
  application,
  canApprove,
  pending,
  run,
}: {
  application: ApplicationWithContext;
  canApprove: boolean;
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
}) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [loading, setLoading] = useState(true);
  const [jobTitle, setJobTitle] = useState("");
  const [monthlyGross, setMonthlyGross] = useState("");
  const [startDate, setStartDate] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");

  const stage = application.stage;
  const applicationId = application.id;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/recruitment/applications/${applicationId}/offer`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { offer?: Offer | null };
      const loaded = data.offer ?? null;
      setOffer(loaded);
      // Seed the form from the saved offer, falling back to the requisition's own title so a first
      // draft does not start empty.
      setJobTitle(loaded?.jobTitle ?? application.requisition?.jobTitle ?? "");
      setMonthlyGross(loaded?.monthlyGross != null ? String(loaded.monthlyGross) : "");
      setStartDate(loaded?.startDate ?? "");
      setNotes(loaded?.notes ?? "");
    } finally {
      setLoading(false);
    }
  }, [applicationId, application.requisition?.jobTitle]);

  // Scheduled rather than called straight from the effect body: load() sets state synchronously
  // on its first line, and react-hooks/set-state-in-effect is an ERROR here, not a warning.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      void load();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  const post = (body: Record<string, unknown>, message: string) =>
    run(async () => {
      await postJson(`/api/recruitment/applications/${applicationId}/offer`, body);
      await load();
      setReason("");
      return message;
    });

  const editable = stage === "offer_initiated" || stage === "offer_draft" || stage === "offer_negotiation";
  const draftTerms = {
    jobTitle: jobTitle.trim() || null,
    monthlyGross: monthlyGross.trim() ? Number(monthlyGross) : null,
    startDate: startDate.trim() || null,
  };
  const missing = missingOfferTerms(draftTerms);

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Offer</p>

      {loading ? (
        <p className="text-xs text-slate-500">Loading the offer…</p>
      ) : editable ? (
        <div className="space-y-1">
          <Input placeholder="Job title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
          <Input
            placeholder="Monthly gross salary (EGP)"
            type="number"
            value={monthlyGross}
            onChange={(e) => setMonthlyGross(e.target.value)}
          />
          <Input placeholder="Start date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <textarea
            className={fieldClass}
            placeholder="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() =>
                post(
                  {
                    intent: "save_draft",
                    jobTitle: jobTitle.trim() || undefined,
                    monthlyGross: monthlyGross.trim() || undefined,
                    startDate: startDate.trim() || undefined,
                    notes: notes.trim() || undefined,
                  },
                  "Offer draft saved.",
                )
              }
            >
              Save draft
            </Button>
            <Button
              size="sm"
              disabled={pending || missing.length > 0 || stage !== "offer_draft"}
              onClick={() => post({ intent: "submit_approval" }, "Offer submitted for approval.")}
            >
              Submit for approval
            </Button>
          </div>
          {missing.length > 0 ? (
            <p className="text-xs text-amber-700">
              Still needed before approval: {missing.join(", ")}.
            </p>
          ) : stage !== "offer_draft" ? (
            <p className="text-xs text-slate-500">Save the draft first, then submit it for approval.</p>
          ) : null}
        </div>
      ) : offer ? (
        <dl className="space-y-1 text-xs">
          <OfferFact label="Job title" value={offer.jobTitle ?? "—"} />
          <OfferFact
            label="Monthly gross"
            value={offer.monthlyGross != null ? `${offer.monthlyGross.toLocaleString("en-GB")} EGP` : "—"}
          />
          <OfferFact label="Start date" value={offer.startDate ?? "—"} />
          {offer.submittedForApprovalAt ? (
            <OfferFact label="Submitted" value={cairoDateTime(offer.submittedForApprovalAt)} />
          ) : null}
          {offer.approvedAt ? <OfferFact label="Approved" value={cairoDateTime(offer.approvedAt)} /> : null}
          {offer.sentAt ? <OfferFact label="Sent" value={cairoDateTime(offer.sentAt)} /> : null}
          {offer.respondedAt ? (
            <OfferFact label={humanizeRecruitmentTerm(offer.response ?? "answered")} value={cairoDateTime(offer.respondedAt)} />
          ) : null}
          {offer.notes ? <OfferFact label="Notes" value={offer.notes} /> : null}
        </dl>
      ) : (
        <p className="text-xs text-slate-500">No offer has been prepared on this application yet.</p>
      )}

      {stage === "offer_pending_approval" ? (
        canApprove ? (
          <div className="space-y-2 pt-1">
            <textarea
              className={fieldClass}
              placeholder="Reason (only needed when sending it back)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={pending} onClick={() => post({ intent: "approve" }, "Offer approved.")}>
                Approve offer
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  post({ intent: "reject_approval", reason: reason.trim() || undefined }, "Offer sent back to draft.")
                }
              >
                Send back to draft
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            Waiting for approval. Talent Acquisition cannot approve an offer it prepared.
          </p>
        )
      ) : null}

      {stage === "offer_approved" ? (
        <div className="space-y-1 pt-1">
          <Button size="sm" disabled={pending} onClick={() => post({ intent: "mark_sent" }, "Offer recorded as sent.")}>
            Record offer as sent
          </Button>
          <p className="text-xs text-slate-500">
            Nothing is emailed from here. Send the letter as usual, then record it.
          </p>
        </div>
      ) : null}

      {stage === "offer_sent" ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            disabled={pending}
            onClick={() => post({ intent: "record_response", response: "accepted" }, "Offer accepted.")}
          >
            Candidate accepted
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              run(async () => {
                await postJson(`/api/recruitment/applications/${applicationId}/workflow`, {
                  action: "app_offer_negotiation" satisfies RecruitmentActionKey,
                });
                return "Marked as negotiating.";
              })
            }
          >
            Negotiating
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => post({ intent: "record_response", response: "expired" }, "Offer marked as expired.")}
          >
            Expired
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => post({ intent: "record_response", response: "declined" }, "Offer declined.")}
          >
            Candidate declined
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function OfferFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="whitespace-nowrap text-slate-500">{label}</dt>
      <dd className="whitespace-nowrap font-medium text-slate-900">{value}</dd>
    </div>
  );
}

export function RecruitmentWorkspace(props: Props) {
  const { candidateStats, dashboard, initialError } = props;
  const router = useRouter();
  // The inbound-CV notification deep-links to ?candidate=<id> so a reviewer lands on the profile
  // holding the extracted fields, not on a module landing page they'd have to search from.
  const workspaceParams = useSearchParams();
  const linkedCandidateId = workspaceParams.get("candidate");
  const [pending, startTransition] = useTransition();
  // Candidates, not Pipeline. Production on 2026-08-15: the pipeline held 7 applications ever while
  // 152 CVs arrived that week — so the module opened on its emptiest screen and put the work two
  // clicks away, behind a tab labelled with someone else's vocabulary.
  // ...except when HR sends someone back here holding a freshly created employee's HR_ID
  // (?application=<id>), which is a return trip into the pipeline, not a fresh visit.
  const [tab, setTab] = useState<TabKey>(() => (workspaceParams.get("application") ? "pipeline" : "candidates"));
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

  const requisitions = dashboard?.requisitions ?? [];
  const applications = dashboard?.applications ?? [];

  return (
    <div className="space-y-6">
      <AdminPageHero
        eyebrow="People Management"
        icon={<BriefcaseBusiness className="h-4 w-4" />}
        title="Recruitment"
        description="Read every CV as it arrives, decide on it, and send the ones worth seeing straight to the hiring manager."
      />

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {notice ? <AdminCallout tone="success">{notice}</AdminCallout> : null}

      {/*
        These four count CVs, not requisitions. The previous set — open requisitions, active
        applications, hires, total applications — read 3 / 7 / 0 / 7 in production on 2026-08-15,
        the same week 152 CVs arrived, so the headline of the module described the part nobody uses.
      */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          description="CVs received today, Cairo time."
          icon={<FileSpreadsheet className="h-5 w-5" />}
          label="Arrived today"
          tone="orange"
          value={candidateStats.arrivedToday}
        />
        <AdminStatCard
          description="CVs received in the last 7 days."
          icon={<Users className="h-5 w-5" />}
          label="Arrived this week"
          tone="blue"
          value={candidateStats.arrivedLast7Days}
        />
        <AdminStatCard
          description="Still on the status intake set — nobody has looked yet."
          icon={<UserPlus className="h-5 w-5" />}
          label="Not yet reviewed"
          tone="violet"
          value={candidateStats.notYetReviewed}
        />
        <AdminStatCard
          description="Candidates a hiring manager has been told about."
          icon={<CheckCircle2 className="h-5 w-5" />}
          label="Sent to a manager"
          tone="emerald"
          value={candidateStats.sentToManager}
        />
      </div>

      {/* Candidates first, because it is where the work is and where the module now opens. */}
      <div className="flex flex-wrap gap-2">
        {(["candidates", "requisitions", "pipeline"] as TabKey[]).map((key) => (
          <Button key={key} variant={tab === key ? "default" : "ghost"} onClick={() => setTab(key)}>
            {humanizeRecruitmentTerm(key)}
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
          asOf={candidateStats.asOf}
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
          hiringManagers={props.hiringManagers}
          managers={props.managers}
          openVacancies={props.openVacancies}
          pending={pending}
          requisitions={requisitions}
          run={run}
        />
      ) : (
        <CandidatesTab
          asOf={candidateStats.asOf}
          canDelete={props.canDelete}
          canImport={props.canImport}
          canManage={props.canManageCandidates}
          candidates={props.candidates}
          hiringManagers={props.hiringManagers}
          linkedCandidateId={linkedCandidateId}
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

/**
 * How long this application has sat where it is.
 *
 * Terminal applications show nothing at all rather than a number that only grows: a rejected
 * candidate is not waiting for anybody, and "waiting 90 days" against a closed row reads as a
 * backlog that does not exist.
 */
function WaitingInStage({ application, asOf }: { application: ApplicationWithContext; asOf: string }) {
  if (isTerminalApplicationStage(application.stage)) return <span className="text-slate-300">—</span>;
  const days = daysInStage(application, asOf);
  if (days === null) return <span className="text-slate-300">—</span>;
  const label = days === 0 ? "Today" : days === 1 ? "1 day" : `${days} days`;
  return (
    <span className={cn(days >= STALLED_AFTER_DAYS ? "font-semibold text-rose-600" : "text-slate-600")}>{label}</span>
  );
}

function PipelineApplicationCard({
  application,
  asOf,
  canDelete,
  onSelect,
  pending,
  run,
  selected,
}: {
  application: ApplicationWithContext;
  asOf: string;
  canDelete: boolean;
  onSelect: () => void;
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
  selected: boolean;
}) {
  const waiting = isTerminalApplicationStage(application.stage) ? null : daysInStage(application, asOf);
  const stalledDays = waiting !== null && waiting >= STALLED_AFTER_DAYS ? waiting : null;

  return (
    <div className={cn("cursor-pointer transition-colors", selected && "bg-orange-50")} onClick={onSelect}>
      <PortalRecordCard
        accent={selected ? "orange" : "slate"}
        actions={
          canDelete ? (
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
          ) : undefined
        }
        meta={application.requisition?.jobTitle ?? "—"}
        status={<StagePill tone={stageTone(application.stage)}>{applicationStageLabel(application.stage)}</StagePill>}
        title={candidateDisplayName(application.candidate?.fullName ?? "") || "Unknown candidate"}
      >
        {/* Kept to a two-word pill so it can never wrap on a phone. Who and when is on the desktop
            table and in the actions panel, where there is room for it. */}
        {/* A flex row, not two adjacent inline pills: JSX drops the whitespace between expressions
            on separate lines, so without this the two badges render touching each other. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {application.managerNotified ? (
            <StagePill tone="emerald">Manager told</StagePill>
          ) : (
            <StagePill tone="amber">Manager not told</StagePill>
          )}
          {/* Only when it is stalled. Every card carrying its own waiting time would put a second
              pill on all of them and cost the list a line of height for a fact that, at three days
              old, nobody needs. The desktop table has the day count on every row. */}
          {stalledDays !== null ? <StagePill tone="rose">{`Waiting ${stalledDays} days`}</StagePill> : null}
        </div>
      </PortalRecordCard>
    </div>
  );
}

function PipelineTab({
  applications,
  asOf,
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
  /** The instant the server stamped this page at. Nothing here reads the clock during render — a
      "waiting 21 days" computed in the browser would disagree with the server's HTML and hydrate
      badly, the same reason the pool's stat cards take theirs from the server. */
  asOf: string;
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
  // Both seeded from the URL, so the round trip through HR's Add Employee form comes back to the
  // application it started from with the new HR_ID already in the box — see the hire card below.
  // Lazy initialisers rather than an effect: react-hooks/set-state-in-effect is an error here.
  const hireParams = useSearchParams();
  // Talent Acquisition works in the portal shell and Super Admin in the admin one; the same
  // workspace renders in both, so the way out to Add Employee is derived from where we already are
  // rather than passed down as another prop.
  const hirePathname = usePathname();
  const addEmployeeHref = hirePathname?.startsWith("/employee-portals")
    ? "/employee-portals/employees"
    : "/employees";
  const [selectedId, setSelectedId] = useState<string | null>(() => hireParams.get("application"));
  const [reason, setReason] = useState("");
  const [employeeHrId, setEmployeeHrId] = useState(() => hireParams.get("hiredHrId") ?? "");
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

  // The three numbers that say whether hiring is moving, as opposed to how big it is. Derived from
  // the applications already on screen — see pipeline-metrics.ts for why that is the whole of it.
  const metrics = computePipelineMetrics(applications, asOf);

  return (
    <>
      {/* Same cards as the pool's, because they are the same kind of fact — the module does not get
          a second look for its second tab. These sit inside the Pipeline tab rather than beside the
          four at the top: those count CVs arriving, which is a different question from whether the
          people already in the pipeline are moving. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <AdminStatCard
          description={
            metrics.hiresMeasured === 0
              ? "Nobody has been hired through the pipeline yet, so there is nothing to measure."
              : `Typical days from application to hire, across ${metrics.hiresMeasured === 1 ? "1 hire" : `${metrics.hiresMeasured} hires`}.`
          }
          icon={<Clock className="h-5 w-5" />}
          label="Time to hire"
          tone="blue"
          value={metrics.medianDaysToHire === null ? "—" : `${metrics.medianDaysToHire} days`}
        />
        <AdminStatCard
          description={`Live applications nobody has moved in ${metrics.stalledAfterDays} days.`}
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Stalled"
          tone={metrics.stalled > 0 ? "orange" : "emerald"}
          value={metrics.stalled}
        />
        <AdminStatCard
          description={
            metrics.offersSent === 0
              ? "No offer has been sent yet."
              : "Offers accepted, out of the offers sent."
          }
          icon={<Send className="h-5 w-5" />}
          label="Offers accepted"
          tone="violet"
          value={metrics.offersSent === 0 ? "—" : `${metrics.offersAccepted} of ${metrics.offersSent}`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <AdminTableShell title="Pipeline" description="Every application and its current stage. Select a row to act on it.">
          <PortalResponsiveDataList
            empty={<PortalEmptyState message="Add a candidate from the Candidates tab." title="No applications yet" />}
            getKey={(application) => application.id}
            items={applications}
            renderCard={(application) => (
              <PipelineApplicationCard
                application={application}
                asOf={asOf}
                canDelete={canDelete}
                onSelect={() => selectApplication(application.id)}
                pending={pending}
                run={run}
                selected={selectedId === application.id}
              />
            )}
            renderTable={() => (
              <PortalDesktopTable minWidth="820px">
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Requisition</th>
                    <th>Stage</th>
                    {/* The "Stalled" card says how many; this says which. Without it the count is a
                        number nobody can act on. */}
                    <th>Waiting</th>
                    <th>Manager told</th>
                    <th className="w-px"></th>
                  </tr>
                </thead>
                <tbody>
                  {applications.map((application) => (
                    <tr
                      key={application.id}
                      className={selectedId === application.id ? "bg-orange-50" : "cursor-pointer"}
                      onClick={() => selectApplication(application.id)}
                    >
                      {/* The stored name is the whole forwarded-mail envelope on 40% of this
                          pool, so the raw value wrapped a row onto three lines. Same treatment the
                          candidate table has always given it: the name on screen, the envelope on
                          hover. */}
                      <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-900" title={application.candidate?.fullName}>
                        {candidateDisplayName(application.candidate?.fullName ?? "") || "Unknown candidate"}
                      </td>
                      <td className="px-3 py-2">{application.requisition?.jobTitle ?? "—"}</td>
                      <td className="px-3 py-2">
                        <StagePill tone={stageTone(application.stage)}>{applicationStageLabel(application.stage)}</StagePill>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <WaitingInStage application={application} asOf={asOf} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {application.managerNotified
                          ? `${application.managerNotified.managerName} · ${cairoDateTime(application.managerNotified.sentAt)}`
                          : "Not sent"}
                      </td>
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
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
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
                  {selected.requisition?.jobTitle} · {applicationStageLabel(selected.stage)}
                </p>
              </div>

              {canManage ? <SendToManagerCard application={selected} pending={pending} run={run} /> : null}

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

              {canManage && isOfferStage(selected.stage) ? (
                <OfferCard
                  key={selected.id + selected.stage}
                  application={selected}
                  canApprove={canApprove}
                  pending={pending}
                  run={run}
                />
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

              {canApprove &&
              (selected.stage === "offer_accepted" ||
                selected.stage === "offer_initiated" ||
                selected.stage === "pre_boarding") ? (
                <div className="space-y-2 border-t border-slate-200 pt-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mark as hired</p>
                  <p className="text-xs text-slate-500">
                    The employee record is created by the normal HR &quot;Add Employee&quot; flow (it also closes the
                    matching vacancy). Opening it from here carries the candidate&apos;s details and the offer
                    across, and brings you back with their HR_ID already filled in.
                  </p>
                  <a
                    className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 shadow-sm transition hover:bg-slate-50"
                    href={`${addEmployeeHref}?fromApplication=${encodeURIComponent(selected.id)}`}
                  >
                    Open Add Employee with these details
                  </a>
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
    </>
  );
}

function RequisitionActionsControl({
  canDelete,
  canManage,
  pending,
  requisition,
  requisitionActions,
  run,
}: {
  canDelete: boolean;
  canManage: boolean;
  pending: boolean;
  requisition: Requisition;
  requisitionActions: RequisitionActionsMap;
  run: (work: () => Promise<string | void>) => void;
}) {
  if (!canManage) return <span className="text-xs text-slate-400">View only</span>;

  return (
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
  );
}

function RequisitionCard({
  canDelete,
  canManage,
  pending,
  requisition,
  requisitionActions,
  run,
}: {
  canDelete: boolean;
  canManage: boolean;
  pending: boolean;
  requisition: Requisition;
  requisitionActions: RequisitionActionsMap;
  run: (work: () => Promise<string | void>) => void;
}) {
  return (
    <PortalRecordCard
      accent="slate"
      actions={
        <RequisitionActionsControl
          canDelete={canDelete}
          canManage={canManage}
          pending={pending}
          requisition={requisition}
          requisitionActions={requisitionActions}
          run={run}
        />
      }
      meta={requisition.jobTitle}
      status={<StagePill tone={requisitionStatusTone(requisition.status)}>{requisitionStatusLabel(requisition.status)}</StagePill>}
      title={requisition.requisitionCode}
    >
      <PortalRecordFields
        fields={[
          { label: "Hiring manager", value: requisition.hiringManagerName ?? requisition.hiringManagerHrId ?? "—" },
        ]}
      />
    </PortalRecordCard>
  );
}

function RequisitionsTab({
  canCreate,
  canDelete,
  canManage,
  hiringManagers,
  managers,
  openVacancies,
  pending,
  requisitions,
  run,
}: {
  canCreate: boolean;
  canDelete: boolean;
  canManage: boolean;
  hiringManagers: HiringManagerOption[];
  managers: ManagerOption[];
  openVacancies: VacancyReportRow[];
  pending: boolean;
  requisitions: Requisition[];
  run: (work: () => Promise<string | void>) => void;
}) {
  const [vacancyId, setVacancyId] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [hiringManagerHrId, setHiringManagerHrId] = useState("");
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
  const typedJobTitle = jobTitle.trim();
  // Two ways in, and exactly two: an open seat, or a title with a manager attached to it. Until
  // 2026-08-15 this read `!vacancyId`, which is why 18 of the 21 positions in the catalogue could
  // never be recruited for — the service accepted them all along.
  const canSubmit = vacancyId ? true : Boolean(typedJobTitle && hiringManagerHrId);

  const requisitionActions: RequisitionActionsMap = {
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
        <AdminTableShell
          title="Open a requisition"
          description="Two ways in: wrap a seat that is already vacant on the organogram, or type any job title and name the manager who will hire for it. Either one is enough."
        >
          <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
            <RequisitionField
              hint="Only seats vacant on the organogram today."
              label="Vacant seat (optional)"
            >
              <SearchableSelect
                className={fieldClass}
                value={posSel}
                onChange={(e) => {
                  setPosSel(e.target.value);
                  setLineSel("");
                  setVacancyId("");
                }}
              >
                <option value="">Choose a vacant seat…</option>
                {Array.from(positionsById.entries()).map(([id, title]) => (
                  <option key={id} value={id}>
                    {title}
                  </option>
                ))}
              </SearchableSelect>
            </RequisitionField>
            <RequisitionField label="Line">
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
            </RequisitionField>
            <RequisitionField label="Vacant area">
              <SearchableSelect className={fieldClass} value={vacancyId} disabled={!lineSel} onChange={(e) => setVacancyId(e.target.value)}>
                <option value="">Vacant area…</option>
                {areaVacancies.map((vacancy) => (
                  <option key={vacancy.id} value={vacancy.id}>
                    {vacancy.areaName ?? "Area"} · {vacancy.vacancyCode}
                  </option>
                ))}
              </SearchableSelect>
            </RequisitionField>
            {/*
              The cascade above only reaches seats that exist on the organogram — Medical Rep and
              District Manager, 3 of the 21 positions in the catalogue. Everything else is hired
              against a typed title, which the service has always accepted; this input is what makes
              it reachable. A vacancy still wins where both are given.

              It sits in the grid cell directly under the vacant-seat combobox, so an open dropdown
              panel covers it completely. That is why it needs a standing label rather than a
              placeholder: once the panel closes, the label is still there to say this is the other
              way in, not a third field of the cascade above it.
            */}
            <RequisitionField label="Or type a job title">
              <Input
                placeholder="Any title — no vacant seat needed"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
              />
            </RequisitionField>
            {selectedVacancy ? (
              <RequisitionField hint="Comes with the seat." label="Hiring manager">
                <div className={`${fieldClass} bg-slate-50 text-slate-600`}>
                  {selectedVacancy.managerName ?? selectedVacancy.managerHrId ?? "—"}
                </div>
              </RequisitionField>
            ) : (
              // Required with no vacancy, and not for tidiness: canSeeRequisition scopes on the
              // hiring manager and the recruitment owner, never on line or area — so a seatless
              // requisition with nobody named here is invisible to the very person meant to hire.
              <RequisitionField hint="Required — they are who sees this requisition." label="Hiring manager">
                <SearchableSelect
                  className={fieldClass}
                  value={hiringManagerHrId}
                  onChange={(e) => setHiringManagerHrId(e.target.value)}
                >
                  <option value="">Hiring manager…</option>
                  {hiringManagers.map((manager) => (
                    <option key={manager.hrId} value={manager.hrId}>
                      {manager.name} · {manager.jobTitle}
                    </option>
                  ))}
                </SearchableSelect>
              </RequisitionField>
            )}
            <RequisitionField label="Recruitment owner">
              <SearchableSelect className={fieldClass} value={ownerHrId} onChange={(e) => setOwnerHrId(e.target.value)}>
                <option value="">Recruitment owner…</option>
                {managers.map((manager) => (
                  <option key={manager.hrId} value={manager.hrId}>
                    {manager.fullName} ({manager.hrId})
                  </option>
                ))}
              </SearchableSelect>
            </RequisitionField>
            <RequisitionField label="Priority">
              <SearchableSelect className={fieldClass} value={priority} onChange={(e) => setPriority(e.target.value)}>
                {["low", "normal", "high", "urgent"].map((value) => (
                  <option key={value} value={value}>
                    {humanizeRecruitmentTerm(value)} priority
                  </option>
                ))}
              </SearchableSelect>
            </RequisitionField>
            <RequisitionField label="Grade">
              <Input placeholder="Grade" value={grade} onChange={(e) => setGrade(e.target.value)} />
            </RequisitionField>
            <RequisitionField label="Salary band min">
              <Input
                placeholder="Salary band min"
                type="number"
                value={bandMin}
                onChange={(e) => setBandMin(e.target.value)}
              />
            </RequisitionField>
            <RequisitionField label="Salary band max">
              <Input
                placeholder="Salary band max"
                type="number"
                value={bandMax}
                onChange={(e) => setBandMax(e.target.value)}
              />
            </RequisitionField>
            <RequisitionField label="Deadline">
              <Input
                placeholder="Deadline"
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </RequisitionField>
            <div className="sm:col-span-2 lg:col-span-3">
              <Button
                disabled={pending || !canSubmit}
                onClick={() =>
                  run(async () => {
                    await postJson("/api/recruitment/requisitions", {
                      vacancyId: vacancyId ? Number(vacancyId) : undefined,
                      jobTitle: typedJobTitle || undefined,
                      hiringManagerHrId: hiringManagerHrId || undefined,
                      recruitmentOwnerHrId: ownerHrId || undefined,
                      grade: grade || undefined,
                      salaryBandMin: bandMin ? Number(bandMin) : undefined,
                      salaryBandMax: bandMax ? Number(bandMax) : undefined,
                      priority,
                      recruitmentDeadline: deadline || undefined,
                    });
                    setVacancyId("");
                    setJobTitle("");
                    setHiringManagerHrId("");
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

      {/*
        The seats nobody is recruiting for.

        openVacancies is ALREADY exactly this list — listOpenVacanciesForRequisition subtracts every
        vacancy that has an active requisition — and until now it only ever filled the cascading
        picker above. So the number was computed on every page load and never shown: on production
        2026-08-21 there were 35 open seats against 2 requisitions, and the pipeline was empty
        largely because there was nothing to attach a candidate TO.

        Nothing is created automatically. An empty seat on the organogram is not the same thing as a
        decision to hire, so this lists them and makes each one a single click that inherits the
        seat's line, area and manager — rather than three cascading selects a recruiter has to walk
        33 times.
      */}
      {canCreate && openVacancies.length > 0 ? (
        <AdminTableShell
          title="Vacant seats with no requisition"
          description={`${openVacancies.length} open ${openVacancies.length === 1 ? "seat" : "seats"} on the organogram nobody is recruiting for. Opening one inherits its line, area and manager.`}
        >
          <ul className="divide-y divide-slate-100">
            {openVacancies.map((vacancy) => (
              <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-3" key={vacancy.id}>
                <div className="min-w-0">
                  <p className="whitespace-nowrap text-sm font-semibold text-slate-800">
                    {vacancy.jobTitle ?? vacancy.positionTitle ?? "Untitled seat"}
                  </p>
                  <p className="mt-0.5 whitespace-nowrap text-xs text-slate-500">
                    {[vacancy.lineName, vacancy.areaName, vacancy.managerName ?? vacancy.managerHrId]
                      .filter(Boolean)
                      .join(" · ") || vacancy.vacancyCode}
                  </p>
                </div>
                <Button
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      await postJson("/api/recruitment/requisitions", { vacancyId: vacancy.id });
                      return "Requisition opened.";
                    })
                  }
                  size="sm"
                  variant="secondary"
                >
                  Open requisition
                </Button>
              </li>
            ))}
          </ul>
        </AdminTableShell>
      ) : null}

      <AdminTableShell title="Requisitions" description="All recruitment openings and their status.">
        <PortalResponsiveDataList
          empty={<PortalEmptyState message="Requisitions will appear here once one is opened." title="No requisitions yet" />}
          getKey={(requisition) => requisition.id}
          items={requisitions}
          renderCard={(requisition) => (
            <RequisitionCard
              canDelete={canDelete}
              canManage={canManage}
              pending={pending}
              requisition={requisition}
              requisitionActions={requisitionActions}
              run={run}
            />
          )}
          renderTable={() => (
            <PortalDesktopTable minWidth="860px">
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
                {requisitions.map((requisition) => (
                  <tr key={requisition.id}>
                    <td className="px-3 py-2 font-medium text-slate-900">{requisition.requisitionCode}</td>
                    <td className="px-3 py-2">{requisition.jobTitle}</td>
                    <td className="px-3 py-2">
                      <StagePill tone={requisitionStatusTone(requisition.status)}>{requisitionStatusLabel(requisition.status)}</StagePill>
                    </td>
                    <td className="px-3 py-2">{requisition.hiringManagerName ?? requisition.hiringManagerHrId ?? "—"}</td>
                    <td className="px-3 py-2">
                      <RequisitionActionsControl
                        canDelete={canDelete}
                        canManage={canManage}
                        pending={pending}
                        requisition={requisition}
                        requisitionActions={requisitionActions}
                        run={run}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </AdminTableShell>
    </div>
  );
}

/**
 * Shortlist and Reject — a decision on a CV that needs no requisition, no seat and no application.
 *
 * These two plus "Send to manager" (the picker below) are the whole of what Talent Acquisition does
 * with an arriving CV, and until now none of the three could be recorded without first inventing a
 * requisition. Measured in production on 2026-08-15: 226 candidates, 6 human workflow moves ever.
 *
 * Reject asks for a reason and Shortlist does not, which is not an oversight — "why did we turn this
 * person down" is asked months later and the answer has to be written while it is still known. The
 * prompt is the same one the requisition workflow buttons use; cancelling it abandons the decision,
 * and an empty answer is accepted, because forcing a sentence out of someone clearing a backlog is
 * how you get "n/a" typed 200 times.
 */
function CandidateDecisionButtons({
  candidate,
  current: currentProp,
  onDecided,
  pending,
  run,
  variant = "icon",
}: {
  candidate: Candidate;
  /** Precomputed status, when the caller already normalized it. Optional so the profile can omit it. */
  current?: CandidateStatus | null;
  /** Lets the profile panel, which holds its own copy of the candidate, follow the change. */
  onDecided?: (status: CandidateStatus, note: string | null) => void;
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
  /** "icon" for the dense pool row, "label" where there is room for words (the profile panel). */
  variant?: "icon" | "label";
}) {
  const current = currentProp ?? normalizeCandidateStatus(candidate.status);

  const decide = (status: CandidateStatus, note: string | null) =>
    run(async () => {
      await patchJson(`/api/recruitment/candidates/${candidate.id}/status`, { status, note: note ?? undefined });
      onDecided?.(status, note);
      return `${candidateDisplayName(candidate.fullName)} marked ${candidateStatusLabels[status].toLowerCase()}.`;
    });

  const shortlist = () => decide("shortlisted", null);
  const reject = () => {
    const entered = window.prompt(`Why is ${candidate.fullName} not proceeding?`);
    if (entered === null) return;
    const note = entered.trim().slice(0, CANDIDATE_STATUS_NOTE_MAX_LENGTH);
    decide("rejected", note || null);
  };

  if (variant === "label") {
    return (
      <>
        <Button variant="secondary" disabled={pending || current === "shortlisted"} onClick={shortlist}>
          Shortlist
        </Button>
        <Button variant="destructive" disabled={pending || current === "rejected"} onClick={reject}>
          Reject
        </Button>
      </>
    );
  }

  return (
    <>
      <PoolIconButton
        disabled={pending || current === "shortlisted"}
        label={current === "shortlisted" ? "Already shortlisted" : "Shortlist"}
        tone="positive"
        onClick={shortlist}
      >
        <Check className="h-3.5 w-3.5" />
      </PoolIconButton>
      <PoolIconButton
        disabled={pending || current === "rejected"}
        label={current === "rejected" ? "Already rejected" : "Reject"}
        tone="danger"
        onClick={reject}
      >
        <X className="h-3.5 w-3.5" />
      </PoolIconButton>
    </>
  );
}

/** Breathing room left above the profile panel when it is scrolled into view. */
const PROFILE_LANDING_GAP = 12;

/**
 * One compact icon button in the pool's action strip. Square, 28px, no label — the name lives in
 * `aria-label` and the native tooltip so a screen reader and a hovering recruiter get the same word.
 */
const poolIconButtonClass =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center border border-slate-200 bg-white text-slate-500 transition hover:border-[#FDBA74] hover:text-[#F97316] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-200 disabled:hover:text-slate-500";

function PoolIconButton({
  active,
  disabled,
  label,
  onClick,
  tone = "default",
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  tone?: "default" | "danger" | "positive";
  children: ReactNode;
}) {
  const toneClass =
    tone === "danger"
      ? "hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600"
      : tone === "positive"
        ? "hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
        : "";
  return (
    <button
      aria-label={label}
      className={cn(poolIconButtonClass, toneClass, active && "border-[#FDBA74] bg-orange-50 text-[#F97316]")}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * The amber duplicate marker in the name cell — and, since 2026-08-21, the button that resolves it.
 *
 * The flag is written onto BOTH rows of a pair, each pointing at the other, so clicking the row you
 * want gone is what chooses the direction. That is the whole control: no picker, no "which one do
 * you want to keep" dialog, no second place to click Merge by mistake. It also costs the row no
 * width, which the actions strip next door could not have given it — six icon buttons already
 * measure 212px inside a 220px column, and a seventh puts every flagged row onto two lines.
 *
 * Read-only viewers keep the marker exactly as it was: a tooltip saying what matched.
 */
function DuplicateFlagControl({
  candidate,
  canManage,
  otherName,
  pending,
  run,
}: {
  candidate: Candidate;
  canManage: boolean;
  /** The record this one would be merged into. Blank when it has since been deleted or filtered. */
  otherName: string;
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
}) {
  const flag = candidate.possibleDuplicate;
  if (!flag) return null;
  const matchedOn = flag.reason === "name" ? "name" : "phone number";
  const thisName = candidateDisplayName(candidate.fullName) || "this record";

  if (!canManage || !otherName) {
    return (
      <span className="shrink-0 text-amber-600" title={`Possible duplicate of another candidate (matched on ${matchedOn})`}>
        <Copy className="h-3 w-3" />
      </span>
    );
  }

  return (
    <button
      aria-label={`Merge ${thisName} into ${otherName}`}
      className="shrink-0 text-amber-600 hover:text-amber-800"
      disabled={pending}
      onClick={(event) => {
        // The whole name cell opens the profile. Merging is a different intention entirely.
        event.stopPropagation();
        if (
          !window.confirm(
            `Merge ${thisName} into ${otherName}?\n\nThis record is removed. Its CV, files, applications and history move across, and anything blank on ${otherName} is filled in from here. Nothing already on ${otherName} is overwritten.`,
          )
        )
          return;
        run(async () => {
          const data = await postJson(`/api/recruitment/candidates/${flag.candidateId}/merge`, {
            duplicateId: candidate.id,
          });
          return typeof data.summary === "string" ? data.summary : "Candidate records merged.";
        });
      }}
      title={`Possible duplicate of ${otherName} (matched on ${matchedOn}) — merge this record into it`}
      type="button"
    >
      <Copy className="h-3 w-3" />
    </button>
  );
}

/**
 * The row of actions on a candidate — and, since 2026-08-15, the shortest path in the module.
 *
 * Sending a CV to a District Manager is what the module exists to do, and starting an application
 * is the rarer, heavier act. Measured in production the day that was built: 221 candidates, 214 of
 * whom had never been shown to anybody, because reaching a manager meant first inventing a
 * requisition with a job title, line, area, seat and owner. None of that is needed to ask someone
 * to look at a CV — so both still live here, one keystroke away.
 *
 * What changed on 2026-08-20 is the SHAPE, not the reach. This cell used to render eight controls
 * side by side, two of them `w-full` dropdowns. A full-width item inside a wrapping flex row claims
 * the whole line, so every button fell onto its own line and each row stood eight lines tall —
 * which is also why merely capping the cell's width did nothing: a narrower cell wraps the same
 * eight controls onto just as many lines. The fix is fewer things on the line. Six icon buttons sit
 * on one row (~200px), and the two pickers open on demand into the panel underneath, which is only
 * mounted for the candidate being acted on.
 *
 * The "Sent to …" line is the same idea as SendToManagerCard's: it reads the send back off the
 * candidate row, so "has anyone been told about this person?" is answered on screen rather than
 * guessed, and it survives a reload because it is stored, not component state.
 */
function CandidateActionsControl({
  candidate,
  canDelete,
  canManage,
  hiringManagers,
  openPanel,
  openProfile,
  openRequisitions,
  pending,
  run,
  sendTo,
  setOpenPanel,
  setSendTo,
  setStartReq,
  startReq,
}: {
  candidate: Candidate;
  canDelete: boolean;
  canManage: boolean;
  hiringManagers: HiringManagerOption[];
  /** Which picker, if any, this candidate has open — lifted so only one row expands at a time. */
  openPanel: "send" | "start" | null;
  openProfile: (id: string) => void;
  openRequisitions: Requisition[];
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
  sendTo: Record<string, string>;
  setOpenPanel: (panel: "send" | "start" | null) => void;
  setSendTo: Dispatch<SetStateAction<Record<string, string>>>;
  setStartReq: Dispatch<SetStateAction<Record<string, string>>>;
  startReq: Record<string, string>;
}) {
  const notified = candidate.managerNotified;
  const current = normalizeCandidateStatus(candidate.status);

  const sendToManager = () =>
    run(async () => {
      const data = await postJson(`/api/recruitment/candidates/${candidate.id}/notify-manager`, {
        managerHrId: sendTo[candidate.id],
      });
      const result = (data.result ?? {}) as { managerName?: unknown };
      const name = typeof result.managerName === "string" ? result.managerName : "the manager";
      setOpenPanel(null);
      return `${candidateDisplayName(candidate.fullName)} sent to ${name}.`;
    });

  const startApplication = () =>
    run(async () => {
      await postJson("/api/recruitment/applications", {
        requisitionId: startReq[candidate.id],
        candidateId: candidate.id,
      });
      setOpenPanel(null);
      return "Application started.";
    });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <PoolIconButton disabled={pending} label="Open profile" onClick={() => void openProfile(candidate.id)}>
          <Eye className="h-3.5 w-3.5" />
        </PoolIconButton>
        {canManage ? (
          <>
            <CandidateDecisionButtons candidate={candidate} current={current} pending={pending} run={run} />
            <PoolIconButton
              active={openPanel === "send"}
              disabled={pending}
              label={notified ? `Send again — last sent to ${notified.name}` : "Send to manager"}
              onClick={() => setOpenPanel(openPanel === "send" ? null : "send")}
            >
              <Send className="h-3.5 w-3.5" />
            </PoolIconButton>
            <PoolIconButton
              active={openPanel === "start"}
              disabled={pending}
              label="Start an application"
              onClick={() => setOpenPanel(openPanel === "start" ? null : "start")}
            >
              <Briefcase className="h-3.5 w-3.5" />
            </PoolIconButton>
            {canDelete ? (
              <PoolIconButton
                disabled={pending}
                label="Delete candidate"
                tone="danger"
                onClick={() => {
                  if (
                    !window.confirm(
                      `Delete candidate ${candidateDisplayName(candidate.fullName)} and all of their applications? This cannot be undone.`,
                    )
                  )
                    return;
                  run(async () => {
                    await deleteRequest(`/api/recruitment/candidates/${candidate.id}`);
                    return "Candidate deleted.";
                  });
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </PoolIconButton>
            ) : null}
          </>
        ) : null}
      </div>

      {/* Only the row being acted on mounts a picker, so 555 rows do not carry 1,110 dropdowns. */}
      {canManage && openPanel === "send" ? (
        <div className="flex items-center gap-1.5 border border-orange-200 bg-orange-50/60 p-1.5">
          <SearchableSelect
            className="h-8 w-full min-w-0 border border-slate-300 bg-white px-2 text-xs text-slate-900"
            value={sendTo[candidate.id] ?? ""}
            onChange={(e) => setSendTo((prev) => ({ ...prev, [candidate.id]: e.target.value }))}
          >
            <option value="">Send to manager…</option>
            {hiringManagers.map((manager) => (
              <option key={manager.hrId} value={manager.hrId}>
                {manager.name} · {manager.jobTitle}
              </option>
            ))}
          </SearchableSelect>
          <Button className="h-8 shrink-0" disabled={pending || !sendTo[candidate.id]} onClick={sendToManager}>
            {notified ? "Send again" : "Send"}
          </Button>
        </div>
      ) : null}

      {canManage && openPanel === "start" ? (
        <div className="flex items-center gap-1.5 border border-slate-200 bg-slate-50 p-1.5">
          <SearchableSelect
            className="h-8 w-full min-w-0 border border-slate-300 bg-white px-2 text-xs text-slate-900"
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
          <Button className="h-8 shrink-0" disabled={pending || !startReq[candidate.id]} onClick={startApplication}>
            Start
          </Button>
        </div>
      ) : null}

      {notified ? (
        // Truncated, with the whole sentence on hover: the column is a fixed 220px, and a manager
        // with a long name must not be what pushes the table back into horizontal scroll.
        <p className="truncate text-[11px] text-slate-500" title={`Sent to ${notified.name} on ${cairoDateTime(notified.sentAt)}`}>
          Sent to {notified.name} on {cairoDateTime(notified.sentAt)}
        </p>
      ) : null}
    </div>
  );
}

function CandidatePoolCard({
  candidate,
  canDelete,
  canManage,
  hiringManagers,
  isNew,
  openProfile,
  openRequisitions,
  pending,
  run,
  sendTo,
  setSendTo,
  setStartReq,
  startReq,
}: {
  candidate: Candidate;
  canDelete: boolean;
  canManage: boolean;
  hiringManagers: HiringManagerOption[];
  isNew: boolean;
  openProfile: (id: string) => void;
  openRequisitions: Requisition[];
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
  sendTo: Record<string, string>;
  setSendTo: Dispatch<SetStateAction<Record<string, string>>>;
  setStartReq: Dispatch<SetStateAction<Record<string, string>>>;
  startReq: Record<string, string>;
}) {
  // One card is one candidate, so the open picker is local here — unlike the table, where the state
  // is lifted so two rows cannot expand at once.
  const [openPanel, setOpenPanel] = useState<"send" | "start" | null>(null);

  return (
    <PortalRecordCard
      accent="slate"
      actions={
        <CandidateActionsControl
          candidate={candidate}
          canDelete={canDelete}
          canManage={canManage}
          hiringManagers={hiringManagers}
          openPanel={openPanel}
          openProfile={openProfile}
          openRequisitions={openRequisitions}
          pending={pending}
          run={run}
          sendTo={sendTo}
          setOpenPanel={setOpenPanel}
          setSendTo={setSendTo}
          setStartReq={setStartReq}
          startReq={startReq}
        />
      }
      status={
        <span className="inline-flex items-center gap-1.5">
          {isNew ? <StagePill tone="orange">New</StagePill> : null}
          {/* Same flag as the desktop table, on the pill row where a phone reader looks first. */}
          {isStatedNonEgyptian(candidate.nationality) ? <StagePill tone="rose">{NON_EGYPTIAN_FLAG_LABEL}</StagePill> : null}
          {/* Amber, not rose: nothing is wrong with the person, the attachment is simply a
              certificate. Rose is reserved for "this candidate cannot be hired". */}
          {isNotACv(candidate) ? <StagePill tone="amber">{NOT_A_CV_LABEL}</StagePill> : null}
          <StagePill tone={candidateStatusTone(candidate.status)}>{candidateStatusLabel(candidate.status)}</StagePill>
        </span>
      }
      title={candidateDisplayName(candidate.fullName)}
    >
      <PortalRecordFields
        fields={[
          // Mobile leads with the routing fact, same as the desktop table's second column — and
          // reads it the same way, off whichever piece of evidence answered. The label says which
          // one that was, since a card has no tooltip to carry it.
          ...(() => {
            const appliedFor = candidateRowAppliedFor(candidate);
            return [
              {
                label:
                  appliedFor.source && appliedFor.source !== "stated"
                    ? `Applying for (${APPLIED_FOR_SOURCE_SHORT[appliedFor.source]})`
                    : "Applying for",
                value: appliedFor.text ?? "Not stated",
              },
            ];
          })(),
          ...(isStatedNonEgyptian(candidate.nationality)
            ? [{ label: "Nationality", value: nonEgyptianFlagTitle(candidate.nationality) }]
            : []),
          // The pill above says what; this says why. On desktop that sentence is the tooltip, and a
          // phone has no hover — without it the card is a blank row wearing a two-word label.
          ...(isNotACv(candidate) ? [{ label: "CV file", value: NOT_A_CV_TITLE }] : []),
          { label: "Received", value: cairoDateTime(candidate.createdAt) },
          { label: "Email", value: candidate.email ?? "—" },
          { label: "Phone", value: candidate.phone ?? "—" },
          // Mobile gets the channel on EVERY row, same as the desktop badge. It used to appear
          // only when a shortLabel existed, so a WhatsApp CV with no caption showed no source at
          // all — the case the owner hit.
          { label: "Source", value: candidateSourceChannel(candidate.source, candidate.sourceContext).label },
          ...(candidate.sourceContext?.shortLabel
            ? [{ label: "Their words", value: candidate.sourceContext.shortLabel }]
            : []),
          ...(candidate.possibleDuplicate
            ? [
                {
                  label: "⚠ Possible duplicate",
                  value: candidate.possibleDuplicate.reason === "phone_tail" ? "shares a phone number" : "shares a name",
                },
              ]
            : []),
          // A phone has no hover, so where the desktop table puts the stored envelope in a tooltip
          // the card has to spell it out — otherwise the shortened name is the only thing on screen.
          ...(isShortenedCandidateName(candidate.fullName) ? [{ label: "As received", value: candidate.fullName }] : []),
        ]}
      />
    </PortalRecordCard>
  );
}

/** How far back the pool is showing. "all" is the default — hiding rows by default reads as data loss. */
type PoolDateFilter = "today" | "week" | "month" | "all";

const DAY_MS = 24 * 60 * 60 * 1000;

const poolDateFilterLabels: Record<PoolDateFilter, string> = {
  all: "All time",
  month: "Last 30 days",
  today: "Today",
  week: "Last 7 days",
};

/**
 * The order the options are OFFERED in, which is not the order they are declared in.
 *
 * The map above is sorted alphabetically by key, the way every other label map in this file is, and
 * the dropdown used to render `Object.keys()` of it — so the recruiter read
 * "All time / Last 30 days / Today / Last 7 days", with the two shortest windows either side of the
 * longest. Widening from "now" outwards is the only order that reads as a scale.
 */
const poolDateFilterOrder: readonly PoolDateFilter[] = ["all", "today", "week", "month"];

/**
 * Has the applicant sold pharmaceuticals before? Three answers, because the CV genuinely gives
 * three: yes, no, and it did not say. Measured in production 2026-08-15 — 81 / 80 / 66.
 */
type PoolExperienceFilter = "all" | "yes" | "no" | "unknown";

const poolExperienceFilterLabels: Record<PoolExperienceFilter, string> = {
  all: "Any experience",
  no: "No pharma experience",
  unknown: "Experience not stated",
  yes: "Has pharma experience",
};

// Matches the filter panel on the CRM master table — same label case, same control border, same
// focus ring. Sibling pages set the design identity here; this screen does not get its own look.
const poolFilterLabelClass = "flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500";
const poolFilterSelectClass =
  "border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none";

function CandidatesTab({
  asOf,
  canDelete,
  canImport,
  canManage,
  candidates,
  hiringManagers,
  linkedCandidateId,
  openRequisitions,
  pending,
  run,
  setError,
  setNotice,
}: {
  /** The instant the server counted the stat cards from — see CandidatePoolStats. */
  asOf: string;
  canDelete: boolean;
  canImport: boolean;
  canManage: boolean;
  candidates: Candidate[];
  hiringManagers: HiringManagerOption[];
  linkedCandidateId: string | null;
  openRequisitions: Requisition[];
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
  setError: (value: string | null) => void;
  setNotice: (value: string | null) => void;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const profilePanelRef = useRef<HTMLDivElement | null>(null);
  const profileHeaderRef = useRef<HTMLDivElement | null>(null);
  // The scroll position the pool was at when the profile was opened, so closing it puts the
  // recruiter back on the row they pressed rather than at the foot of a 555-row table.
  const returnScrollYRef = useRef<number | null>(null);
  // True while the profile's own header is off screen, which is the only moment the floating way
  // back earns its place. Kept in state rather than derived on scroll — an IntersectionObserver
  // fires on the compositor, a scroll handler on this page would run against 555 rows.
  const [wayBackOffScreen, setWayBackOffScreen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [nationalId, setNationalId] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [startReq, setStartReq] = useState<Record<string, string>>({});
  // Which manager is picked for each candidate, keyed by candidate id rather than held per row, so
  // a pick survives the re-render that router.refresh() triggers after some other row is sent.
  const [sendTo, setSendTo] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [dateFilter, setDateFilter] = useState<PoolDateFilter>("all");
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  // "Has this person sold pharma before?" — the first question asked of every Medical Rep CV, and
  // the AI has already answered it on 161 of the 227 people in the pool (81 yes, 80 no, 66 it could
  // not tell). Free to filter on, and it turns a scroll through 226 rows into a look at 81.
  const [experienceFilter, setExperienceFilter] = useState<PoolExperienceFilter>("all");
  // 132 of the 555 rows in production share a person with another row — the same CV forwarded twice,
  // or the same applicant applying again. The flag was already computed; there was no way to ask for
  // just those rows, which is the only way anyone is going to work through them.
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  // Bulk send: which candidates are ticked, and who they all go to. Held here rather than per row
  // so the choice survives the re-render router.refresh() triggers after some other row is acted on.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkManagerHrId, setBulkManagerHrId] = useState("");
  // Which row, if any, has a picker open. One at a time: 555 rows must not each mount two
  // dropdowns, and two open pickers on screen is two places to click Send by mistake.
  const [openRowPanel, setOpenRowPanel] = useState<{ id: string; panel: "send" | "start" } | null>(null);
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [viewCvFile, setViewCvFile] = useState<RecruitmentFile | null>(null);
  const [statusDraft, setStatusDraft] = useState("");
  const [statusNoteDraft, setStatusNoteDraft] = useState("");
  const [retryExtraction, setRetryExtraction] = useState<{ fields: ExtractedCandidateFields; extractionId: string | null } | null>(
    null,
  );
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryPositionKey, setRetryPositionKey] = useState(defaultCvPositionKey);
  // The extraction already on record for this candidate. Automated email/WhatsApp intake reads
  // every inbound CV and stores the result, so for those candidates the fields are waiting here
  // before anyone opens the profile — reviewing them costs nothing, unlike "Extract from CV".
  const [storedExtraction, setStoredExtraction] = useState<StoredCvExtraction | null>(null);

  // Every "how long ago" on this screen is measured from the SAME instant the stat cards were
  // counted from, stamped once on the server. Two benefits: the cards and the list can never
  // disagree about what "today" means, and nothing in this component reads the clock during render,
  // which is what makes a server-rendered "arrived today" survive hydration.
  const asOfMs = new Date(asOf).getTime();
  const todayKey = cairoDayKey(asOf);
  const isNewArrival = (candidate: Candidate) =>
    new Date(candidate.createdAt).getTime() >= asOfMs - DAY_MS;

  // Built from the data rather than a hardcoded list: the mailboxes and channels that feed this
  // pool change without the UI being told, and an option for a source nobody uses is noise.
  //
  // Keyed on the CHANNEL BADGE rather than on the raw column, so the filter offers exactly the
  // words the Source column shows. Reading `candidate.source` directly and dropping the blanks --
  // which is what this did — lost the one candidate whose source is NULL: the pool held 562 while
  // Email (211) + WhatsApp (350) summed to 561, and no option in the list could reach that person.
  // `candidateSourceChannel` already resolves NULL to "Manual" for the badge, so going through it
  // makes the filter and the column answer from one function instead of disagreeing from two.
  const sourceOptions = Array.from(
    new Set(
      candidates.map((candidate) => candidateSourceChannel(candidate.source, candidate.sourceContext).label),
    ),
  ).sort((left, right) => left.localeCompare(right));

  const duplicateCount = candidates.filter((candidate) => candidate.possibleDuplicate).length;
  // Built over the WHOLE pool, not the filtered view: a duplicate's counterpart is very often
  // filtered out (different status, different source, older than the date filter), and a merge
  // button that cannot name what it merges into is a merge nobody will click.
  const candidateNameById = new Map(
    candidates.map((candidate) => [candidate.id, candidateDisplayName(candidate.fullName)] as const),
  );

  const q = query.trim().toLowerCase();
  const visibleCandidates = candidates
    .filter((c) => {
      if (
        q &&
        // The DERIVED role is searched as well as the stored one. Searching "district manager" has
        // to find the 198 rows whose only statement of it is the intake subject line, otherwise the
        // column answers on screen and the search box still says there is nobody.
        ![
          c.fullName,
          c.email,
          c.phone,
          candidateStatusLabel(c.status),
          c.source,
          c.nationalId,
          c.appliedForJobTitle,
          candidateRowAppliedFor(c).text,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(q))
      ) {
        return false;
      }
      if (statusFilter && normalizeCandidateStatus(c.status) !== statusFilter) return false;
      if (sourceFilter && candidateSourceChannel(c.source, c.sourceContext).label !== sourceFilter) return false;
      if (duplicatesOnly && !c.possibleDuplicate) return false;
      // Three-way, not a checkbox: null is a real and common answer here (66 rows), and it means
      // "the CV did not say", which is not the same as "no". Folding unknown into either bucket
      // would quietly hide people.
      if (experienceFilter === "yes" && c.hasMedicalRepExperience !== true) return false;
      if (experienceFilter === "no" && c.hasMedicalRepExperience !== false) return false;
      if (experienceFilter === "unknown" && typeof c.hasMedicalRepExperience === "boolean") return false;
      if (dateFilter === "all") return true;
      if (dateFilter === "today") return cairoDayKey(c.createdAt) === todayKey;
      const created = new Date(c.createdAt).getTime();
      if (Number.isNaN(created)) return false;
      return created >= asOfMs - (dateFilter === "week" ? 7 : 30) * DAY_MS;
    })
    // Newest first, always. The pool grew by 152 rows in the last 7 days; anything else buries the
    // CV that arrived an hour ago under one from March.
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  const visibleIds = visibleCandidates.map((candidate) => candidate.id);
  const selectedVisibleIds = selectedIds.filter((id) => visibleIds.includes(id));
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleIds.length === visibleIds.length;
  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));

  const openProfile = async (id: string) => {
    // Where the recruiter was standing in the pool. The profile panel renders BELOW a table that
    // is 555 rows long, so opening it throws the page to the bottom; without this the only way
    // back to row 300 is to scroll for it. Captured before the fetch, so it is the position at the
    // moment the button was pressed.
    returnScrollYRef.current = typeof window === "undefined" ? null : window.scrollY;
    setProfile(null);
    setWayBackOffScreen(false);
    setViewCvFile(null);
    setError(null);
    setRetryExtraction(null);
    setRetryError(null);
    setRetryPositionKey(defaultCvPositionKey);
    setStoredExtraction(null);
    try {
      const res = await fetch(`/api/recruitment/candidates/${id}`);
      const data = (await res.json().catch(() => ({}))) as {
        profile?: CandidateProfile;
        latestCvExtraction?: StoredCvExtraction | null;
        message?: string;
      };
      if (!res.ok || !data.profile) throw new Error(data.message ?? "Failed to load candidate profile.");
      setProfile(data.profile);
      // Deliberately blank, not seeded with the current status. The control below is now "set
      // ANOTHER status", so pre-filling it would arm the button with the value already stored — and
      // for the 225 legacy rows that value is 'Candidate Created', which the route rejects.
      setStatusDraft("");
      setStatusNoteDraft("");
      setStoredExtraction(data.latestCvExtraction ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load candidate profile.");
    }
  };

  // What is actually left for a human: findings the AI made that are still absent from the
  // candidate. Intake already auto-applies the high-confidence ones without marking the row
  // reviewed (cv-auto-apply.ts), so counting raw findings would nag on every inbound candidate
  // forever with a number that overstates the work.
  const storedSchema = storedExtraction
    ? getCvPositionSchema(storedExtraction.positionKey) ?? getCvPositionSchema(defaultCvPositionKey)!
    : null;
  const pendingExtractionFieldCount =
    storedExtraction && storedSchema && profile
      ? countUnappliedCvFields(storedExtraction.fields, profile.candidate, storedSchema)
      : 0;

  // Opens the review board on the extraction ALREADY stored for this candidate — no AI call, no
  // cost, because this CV was read once at intake. Empty slots are seeded from the saved record so
  // saving applies the AI's findings on top of what is known instead of replacing it (a direct
  // WhatsApp applicant's phone comes from the sender, and no CV field would restore it).
  const reviewStoredExtraction = (candidate: Candidate, extraction: StoredCvExtraction) => {
    const schema = getCvPositionSchema(extraction.positionKey) ?? getCvPositionSchema(defaultCvPositionKey)!;
    setRetryError(null);
    setRetryPositionKey(schema.positionKey);
    setRetryExtraction({
      extractionId: extraction.extractionId,
      fields: seedReviewFieldsFromCandidate(extraction.fields, candidate, schema),
    });
  };

  /**
   * Bring the profile into view when it opens.
   *
   * This was a smooth `scrollIntoView`, and on a pool this long it did nothing at all. Measured
   * against production on 2026-08-21 with the panel 15,489px below the fold: the smooth call left
   * `window.scrollY` at 18402 after 1.8 seconds, while the identical call asking for an instant
   * scroll landed on the panel, and a plain `window.scrollTo` moved the page freely. There is no
   * scrollable ancestor to blame — Chrome simply abandons a programmatic smooth scroll of that
   * length. So the recruiter pressed the eye, the page sat still, and the profile had opened
   * sixteen screens away with nothing on screen to say so.
   *
   * Instant, and computed from the panel's own box rather than delegated, so the landing position
   * is a number this code chose. Nobody wants a sixteen-screen animated flight anyway.
   */
  useEffect(() => {
    if (!profile || typeof window === "undefined") return;
    const panel = profilePanelRef.current;
    if (!panel) return;
    // After paint — the panel's box is only real once it has been laid out.
    const frame = requestAnimationFrame(() => {
      const top = panel.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ behavior: "auto", top: Math.max(0, top - PROFILE_LANDING_GAP) });
    });
    return () => cancelAnimationFrame(frame);
  }, [profile]);

  /**
   * Is the way back off screen?
   *
   * The panel's own header only helps while it is in view. This watches it, and the moment it is
   * not on screen — the recruiter scrolled back up into the table, or the scroll above never
   * happened — a fixed pill appears so there is always one click back to the row they pressed.
   *
   * This is the ONLY way back once the panel is scrolled past, and it went unseen for as long as
   * that header was sticky: a sticky header never stops intersecting, so this observer never fired.
   */
  useEffect(() => {
    const header = profileHeaderRef.current;
    if (!profile || !header || typeof IntersectionObserver === "undefined") return;
    // Nothing is set here in the effect body on purpose — react-hooks/set-state-in-effect is an
    // error in this repo. The pill is cleared by the two things that actually change the profile:
    // openProfile and returnToPool.
    const observer = new IntersectionObserver(([entry]) => setWayBackOffScreen(!entry.isIntersecting));
    observer.observe(header);
    return () => observer.disconnect();
  }, [profile]);

  /**
   * Close the profile and put the recruiter back where they pressed it.
   *
   * Reading a CV is one step in a pass down a 555-row pool, so the pool position is the thing to
   * preserve. Falls back to doing nothing when there is no remembered position — a profile reached
   * by the ?candidate= deep link was never opened from a row, and jumping to the top of a table the
   * recruiter has not scrolled would be its own surprise.
   */
  const returnToPool = () => {
    const returnTo = returnScrollYRef.current;
    returnScrollYRef.current = null;
    setProfile(null);
    setWayBackOffScreen(false);
    setViewCvFile(null);
    setRetryExtraction(null);
    setRetryError(null);
    setRetryPositionKey(defaultCvPositionKey);
    setStoredExtraction(null);
    if (returnTo === null || typeof window === "undefined") return;
    // After paint: the panel has to be gone before the page is short enough to scroll back into.
    // Instant, for the same measured reason as the scroll in — over these distances Chrome does not
    // run a smooth programmatic scroll at all, and a return that silently does nothing is the whole
    // complaint. It also matches what a Back button should feel like: the page you left, at once.
    requestAnimationFrame(() => window.scrollTo({ behavior: "auto", top: returnTo }));
  };

  // Follow the ?candidate= deep link from the inbound-CV notification, once. Ref-guarded rather
  // than keyed on `profile` so closing the panel doesn't immediately reopen it.
  const autoOpenedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!linkedCandidateId || autoOpenedRef.current === linkedCandidateId) return;
    autoOpenedRef.current = linkedCandidateId;
    void openProfile(linkedCandidateId);
    // openProfile is recreated every render; re-running on it would fight the ref guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedCandidateId]);

  // Re-run extraction on a candidate that already has a CV on file — for one manually
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
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "CV extraction failed.");
      const fields = data.fields as ExtractedCandidateFields | undefined;
      if (!fields) throw new Error("No fields were returned. Try again.");
      setRetryExtraction({ extractionId: typeof data.extractionId === "string" ? data.extractionId : null, fields });
    } catch (caught) {
      setRetryError(caught instanceof Error ? caught.message : "CV extraction failed.");
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
              Or extract from a Medical Rep CV
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

      <AdminTableShell
        title="Candidate pool"
        description={`${visibleCandidates.length} of ${candidates.length} shown, newest first. Every applicant stays here — even rejected ones.`}
      >
        <div className="space-y-3 p-3">
          <Input
            placeholder="Search name, applying for, email, phone, status, source"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex flex-wrap items-end gap-3">
            <label className={poolFilterLabelClass}>
              Received
              <select
                className={poolFilterSelectClass}
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value as PoolDateFilter)}
              >
                {poolDateFilterOrder.map((key) => (
                  <option key={key} value={key}>
                    {poolDateFilterLabels[key]}
                  </option>
                ))}
              </select>
            </label>
            <label className={poolFilterLabelClass}>
              Status
              <select
                className={poolFilterSelectClass}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">Any status</option>
                {candidateStatuses.map((status) => (
                  <option key={status} value={status}>
                    {candidateStatusLabels[status]}
                  </option>
                ))}
              </select>
            </label>
            <label className={poolFilterLabelClass}>
              Pharma experience
              <select
                className={poolFilterSelectClass}
                value={experienceFilter}
                onChange={(e) => setExperienceFilter(e.target.value as PoolExperienceFilter)}
              >
                {(Object.keys(poolExperienceFilterLabels) as PoolExperienceFilter[]).map((key) => (
                  <option key={key} value={key}>
                    {poolExperienceFilterLabels[key]}
                  </option>
                ))}
              </select>
            </label>
            {sourceOptions.length > 1 ? (
              <label className={poolFilterLabelClass}>
                Source
                <select
                  className={poolFilterSelectClass}
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                >
                  <option value="">Any source</option>
                  {sourceOptions.map((source) => (
                    <option key={source} value={source}>
                      {source}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {duplicateCount > 0 ? (
              <button
                aria-pressed={duplicatesOnly}
                className={`inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border px-3 text-xs font-semibold transition ${
                  duplicatesOnly
                    ? "border-[#F97316] bg-orange-50 text-[#C2410C]"
                    : "border-[#D8E0EA] bg-white text-slate-600 hover:border-[#FDBA74] hover:text-[#F97316]"
                }`}
                onClick={() => setDuplicatesOnly((previous) => !previous)}
                type="button"
              >
                <Copy className="h-3.5 w-3.5" />
                Possible duplicates
                <span className="tabular-nums opacity-70">{duplicateCount}</span>
              </button>
            ) : null}
            {dateFilter !== "all" || experienceFilter !== "all" || statusFilter || sourceFilter || query || duplicatesOnly ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setDateFilter("all");
                  setExperienceFilter("all");
                  setStatusFilter("");
                  setSourceFilter("");
                  setQuery("");
                  setDuplicatesOnly(false);
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        </div>

        {/*
          Bulk send. One notification names everybody in it rather than one alert per candidate:
          the pool takes 152 CVs a week and the District Sales Managers receive nearly all of them,
          so per-person alerts are how a useful signal gets muted. Desktop only — the ticks live in
          the table, and picking twelve people out of a stack of cards on a phone is not a workflow.
        */}
        {canManage && selectedVisibleIds.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-y border-orange-200 bg-orange-50 px-3 py-2">
            <span className="whitespace-nowrap text-xs font-semibold text-slate-700">
              {selectedVisibleIds.length} selected
            </span>
            <SearchableSelect
              className={`${fieldClass} sm:w-72`}
              value={bulkManagerHrId}
              onChange={(e) => setBulkManagerHrId(e.target.value)}
            >
              <option value="">Send all of them to…</option>
              {hiringManagers.map((manager) => (
                <option key={manager.hrId} value={manager.hrId}>
                  {manager.name} · {manager.jobTitle}
                </option>
              ))}
            </SearchableSelect>
            <Button
              disabled={pending || !bulkManagerHrId}
              onClick={() =>
                run(async () => {
                  const data = await postJson("/api/recruitment/candidates/notify-manager", {
                    candidateIds: selectedVisibleIds,
                    managerHrId: bulkManagerHrId,
                  });
                  const result = (data.result ?? {}) as { count?: unknown; managerName?: unknown };
                  const name = typeof result.managerName === "string" ? result.managerName : "the manager";
                  const count = typeof result.count === "number" ? result.count : selectedVisibleIds.length;
                  setSelectedIds([]);
                  setBulkManagerHrId("");
                  return `${count} ${count === 1 ? "candidate" : "candidates"} sent to ${name}.`;
                })
              }
            >
              Send
            </Button>
            <Button variant="ghost" onClick={() => setSelectedIds([])}>
              Clear selection
            </Button>
          </div>
        ) : null}
        <PortalResponsiveDataList
          empty={<PortalEmptyState message="Add a candidate above, or try a different search." title="No candidates found" />}
          getKey={(candidate) => candidate.id}
          items={visibleCandidates}
          renderCard={(candidate) => (
            <CandidatePoolCard
              candidate={candidate}
              canDelete={canDelete}
              canManage={canManage}
              hiringManagers={hiringManagers}
              isNew={isNewArrival(candidate)}
              openProfile={openProfile}
              openRequisitions={openRequisitions}
              pending={pending}
              run={run}
              sendTo={sendTo}
              setSendTo={setSendTo}
              setStartReq={setStartReq}
              startReq={startReq}
            />
          )}
          renderTable={() => (
            /*
             * Rebuilt 2026-08-20 to fit the page without sideways scroll; re-cut 2026-08-24 when
             * that goal turned out to cost 223 clipped cells, which the owner's standing rule
             * forbids outright. Fitting the window is a preference; never truncating and never
             * wrapping is a rule, so the rule wins and the table may now scroll under 1360px.
             *
             * `table-fixed` plus the colgroup below is what makes that true rather than hopeful:
             * with a fixed layout the browser obeys the declared widths instead of sizing columns
             * to their widest cell, so a single 185-character intake blob can no longer widen the
             * whole table. Everything except the name is a fixed pixel width; Candidate takes the
             * remainder, so the table is exactly as wide as its container at any window size.
             *
             * Email and Phone lost their own columns and moved under the name. In production 258
             * of 555 rows have no email and 316 no phone, so two columns were spending ~340px to
             * show a dash most of the time.
             */
            <PortalDesktopTable className="table-fixed" minWidth="1360px">
              {/*
               * Every width below is the width its text actually wants, measured cell by cell
               * against all 555 production rows on 2026-08-21 (99th percentile, at each line's own
               * computed font, plus the 24px of cell padding):
               *
               *   Candidate 261 · Applying for 301 · Status 50 · Received 60
               *
               * Against that, the first cut of this table gave Candidate 443 and Applying-for 140.
               * Status and Received were also 100 and 116 for content needing 50 and 60. So the one
               * column carrying the fact that decides who a CV goes to was the only one starved,
               * and every longer role read "Personnel and Recruitment Speci…".
               *
               * Applying-for now takes the flexible slot — 328px at the 1172px this table renders
               * at, 304 of it text, clear of the 301 it needs. Candidate is pinned at 280 rather
               * than left to sprawl. Actions stays 220: six 28px icon buttons plus gaps and padding
               * measure 212, and the strip has to fit on one line or the row grows again.
               *
               * Re-measured 2026-08-24 against 574 production rows, counting the cells actually
               * clipped rather than the widths they were given:
               *
               *   Source 173 · Applying for 29 · Candidate 21 · everything else 0
               *
               * Candidate overflowed by at most 43px, so 280 → 332 ends all 21. Source's 173 were
               * never a width problem — worst overflow 7,094px — and are fixed by not drawing a
               * line that cannot fit (see the cell); with only the badge left it drops 116 → 104.
               * Applying-for needed 173px more than the 292 it had, which is what the minWidth of
               * 1360 buys: 36 + 332 + 96 + 96 + 104 + 220 = 884 fixed, leaving 476 for the flexible
               * column against the 465 it wants. Below 1360px the wrapper scrolls; nothing clips.
               */}
              <colgroup>
                {canManage ? <col className="w-[36px]" /> : null}
                <col className="w-[332px]" />
                <col />
                <col className="w-[96px]" />
                <col className="w-[96px]" />
                <col className="w-[104px]" />
                <col className="w-[220px]" />
              </colgroup>
              {/* No colours here on purpose. The admin shell's locked rules in globals.css paint
                  every `thead th` black, centred and 0.78rem with !important, so the header already
                  matches every other admin table — restating it locally would only be a lie the next
                  reader has to check. Padding is all that is left to say. */}
              <thead className="font-black uppercase tracking-[0.08em]">
                <tr>
                  {canManage ? (
                    <th className="px-3 py-2.5">
                      <input
                        aria-label="Select every candidate shown"
                        checked={allVisibleSelected}
                        className="h-4 w-4 accent-orange-600"
                        onChange={(e) => setSelectedIds(e.target.checked ? visibleIds : [])}
                        type="checkbox"
                      />
                    </th>
                  ) : null}
                  <th className="px-3 py-2.5">Candidate</th>
                  <th className="px-3 py-2.5">Applying for</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Received</th>
                  <th className="px-3 py-2.5">Source</th>
                  <th className="px-3 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleCandidates.map((candidate) => {
                  const displayName = candidateDisplayName(candidate.fullName);
                  const contact = [candidate.email, candidate.phone].filter(Boolean).join(" · ");
                  const appliedFor = candidateRowAppliedFor(candidate);
                  return (
                    <tr className="align-top transition-colors hover:bg-orange-50/50" key={candidate.id}>
                      {canManage ? (
                        <td className="px-3 py-2.5">
                          <input
                            aria-label={`Select ${displayName}`}
                            checked={selectedIds.includes(candidate.id)}
                            className="h-4 w-4 accent-orange-600"
                            onChange={() => toggleSelected(candidate.id)}
                            type="checkbox"
                          />
                        </td>
                      ) : null}
                      {/*
                       * The name, and under it whatever way there is to reach the person. 220 of
                       * the 555 production rows store the forwarder's whole envelope here rather
                       * than a name, so what is shown is the derived one — the stored value is
                       * still the hover text, and still what the search box matches on.
                       */}
                      <td className="px-3 py-2.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className="min-w-0 truncate font-semibold text-[#0F172A]"
                            title={candidate.fullName}
                          >
                            {displayName}
                          </span>
                          {/* Phoenix recruits Egyptian nationals only. Flagged, never filtered —
                              the row still lists and every action still works; a person decides. */}
                          {isStatedNonEgyptian(candidate.nationality) ? (
                            <span className="shrink-0">
                              <StagePill tone="rose">
                                <span title={nonEgyptianFlagTitle(candidate.nationality)}>{NON_EGYPTIAN_FLAG_LABEL}</span>
                              </StagePill>
                            </span>
                          ) : null}
                          {/* 132 of 555 rows share a person with another row. The flag was already
                              computed and already on the mobile card; the desktop table — the
                              surface Talent Acquisition actually works in — never showed it. */}
                          <DuplicateFlagControl
                            candidate={candidate}
                            canManage={canManage}
                            otherName={
                              candidate.possibleDuplicate
                                ? (candidateNameById.get(candidate.possibleDuplicate.candidateId) ?? "")
                                : ""
                            }
                            pending={pending}
                            run={run}
                          />
                        </div>
                        {/* No "from the forwarded message" caption here any more: it appeared on
                            nearly every row, so it carried no information, and it cost a third
                            line of height on all 555 of them (75px → 59px without it). The stored
                            envelope is still the name's hover text, which is where it belongs. */}
                        <div className="mt-0.5 truncate text-[11px] text-slate-500" title={contact || undefined}>
                          {contact || <span className="text-slate-300">No contact details</span>}
                        </div>
                      </td>
                      {/* Second column on purpose: after the name, "which job is this for" is the
                          one fact that decides who the CV goes to. Only 15 rows store a title, so
                          the rest is read off whatever the sender wrote — shown in italic grey, and
                          named in the tooltip, so a derived role never reads as a stated one. The
                          tooltip carries the untouched wording it was read from, which is what lets
                          a recruiter overrule it without opening the mail. */}
                      <td className="px-3 py-2.5">
                        {appliedFor.text ? (
                          <span
                            className={`block truncate ${appliedFor.source === "stated" ? "text-slate-900" : "italic text-slate-500"}`}
                            title={
                              appliedFor.source === "stated"
                                ? [candidate.appliedForJobTitle, candidate.appliedForEvidence].filter(Boolean).join("\n")
                                : `${APPLIED_FOR_SOURCE_LABEL[appliedFor.source ?? "subject"]}:\n"${appliedFor.evidence ?? appliedFor.text}"`
                            }
                          >
                            {appliedFor.text}
                          </span>
                        ) : null}
                        {/* "Not stated" gives way to the badge — it is the weaker of the two facts,
                            and stacking both would say the same nothing twice. */}
                        {!appliedFor.text && !isNotACv(candidate) ? (
                          <span className="text-slate-300">Not stated</span>
                        ) : null}
                        {/* The badge lives in THIS cell rather than beside the name, deliberately
                            twice over. It is a fact about the attachment, not about the person, and
                            a warning pinned to someone's name reads as a judgement on them. And
                            this is the cell whose emptiness raises the question: a certificate
                            yields no job title, so the reader is already staring at this blank
                            space asking why. It is also the widest column, where the 280px
                            Candidate cell would have squeezed a name that already truncates. */}
                        {isNotACv(candidate) ? (
                          <div className={appliedFor.text ? "mt-0.5" : undefined}>
                            <StagePill tone="amber">
                              <span title={NOT_A_CV_TITLE}>{NOT_A_CV_LABEL}</span>
                            </StagePill>
                          </div>
                        ) : null}
                      </td>
                      {/* The reason for the current status sits in the tooltip rather than a column
                          of its own: it is read when someone asks "why", not on every scan of the
                          pool. The durable copy is in ats_candidate_status_events either way. */}
                      <td className="px-3 py-2.5">
                        <StagePill tone={candidateStatusTone(candidate.status)}>
                          <span title={candidate.statusNote ?? undefined}>{candidateStatusLabel(candidate.status)}</span>
                        </StagePill>
                      </td>
                      {/* When it landed, Cairo time — the column the pool had no answer for. Date
                          over time rather than one line, so a fixed-width column can show the whole
                          stamp instead of clipping it; the Candidate cell is two lines anyway, so
                          this costs no row height. The New pill marks the last 24 hours, measured
                          from the server's stamp. */}
                      <td className="whitespace-nowrap px-3 py-2.5 text-[11px] text-slate-600">
                        <div>{cairoDateTime(candidate.createdAt).split(" · ")[0]}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-slate-400">
                          {cairoDateTime(candidate.createdAt).split(" · ")[1] ?? ""}
                          {isNewArrival(candidate) ? <StagePill tone="orange">New</StagePill> : null}
                        </div>
                      </td>
                      {/*
                          The channel, and only the channel. "WhatsApp or email?" is the question
                          this column is scanned for, and a badge answers it at 104px.

                          It used to carry the sender's own first line underneath, and that line was
                          the single worst thing on this tab: 173 of the 225 rows carrying one
                          overflowed, one of them by 7,094px, and those 173 were the bulk of the 223
                          clipped cells on the whole page. `shortLabel` is whatever the sender wrote
                          first — a forwarded mail stores an entire message there, reaching 1,546
                          characters — so no column width answers it.

                          Nor does a length limit. Measured in the real font on 2026-08-24: only 38
                          of the 225 lines fit the 80px of content box this column has, and what
                          fits is "Cv.pdf", "Afroz cv", "cv" — filenames, not information. A
                          threshold that admits those and wraps the other 187 buys nothing, and
                          wrapping breaks the same rule the ellipsis did.

                          So the line is not drawn here at all. Nothing is lost: the sender's words
                          are this cell's hover title, they are on the mobile card under "Their
                          words", and they are still what the search box matches.
                      */}
                      <td
                        className="px-3 py-2.5"
                        title={candidate.sourceContext?.detailLines.join("\n") || undefined}
                      >
                        {(() => {
                          const channel = candidateSourceChannel(candidate.source, candidate.sourceContext);
                          return (
                            <StagePill tone={sourceChannelTone[channel.key]}>
                              <span title={channel.title}>{channel.label}</span>
                            </StagePill>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5">
                        <CandidateActionsControl
                          candidate={candidate}
                          canDelete={canDelete}
                          canManage={canManage}
                          hiringManagers={hiringManagers}
                          openPanel={openRowPanel?.id === candidate.id ? openRowPanel.panel : null}
                          openProfile={openProfile}
                          openRequisitions={openRequisitions}
                          pending={pending}
                          run={run}
                          sendTo={sendTo}
                          setOpenPanel={(panel) => setOpenRowPanel(panel ? { id: candidate.id, panel } : null)}
                          setSendTo={setSendTo}
                          setStartReq={setStartReq}
                          startReq={startReq}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </AdminTableShell>

      {profile ? (
        <div ref={profilePanelRef} className="space-y-3 border border-slate-200 p-4">
          {/*
           * NOT sticky, deliberately. It was, and it sliced the global header in half: the app's own
           * topbar is `sticky top-0 z-20` (src/components/layout/topbar.tsx), this was `sticky top-0
           * z-20` too, and with the same offset and the same stacking level the one later in the DOM
           * wins — so the search box and the role chip were painted over.
           *
           * Pinning this lower and pushing it down by the topbar's height would mean hard-coding
           * 81px/89px, a number nothing in the design tokens owns. There is no need: the floating
           * pill below already does this job, and BETTER, because it is anchored to the viewport
           * rather than to the top of a panel. It just never appeared, because it is shown when this
           * header scrolls out of view and a sticky header never does. Removing the sticky fixes the
           * overlap and switches on the fallback that was written for exactly this.
           */}
          <div
            className="-mx-4 -mt-4 mb-1 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2.5"
            ref={profileHeaderRef}
          >
            <button
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border border-[#D8E0EA] bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-[#FDBA74] hover:text-[#F97316]"
              onClick={returnToPool}
              type="button"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to the pool
            </button>
            <p className="truncate text-xs text-slate-500" title={profile.candidate.fullName}>
              {candidateDisplayName(profile.candidate.fullName)}
            </p>
          </div>
          {/*
           * The way back, anchored to the screen instead of to the page.
           *
           * Everything above assumes the recruiter is looking at the panel. This is for when they
           * are not: they scrolled back up into the table with the profile still open, or the
           * scroll-in failed the way it did in production before today. Nothing on this page has a
           * transform, so `fixed` really is the viewport (checked, not assumed) — the pill sits in
           * the corner whatever the page did, and it is the same one click as the header's.
           */}
          {wayBackOffScreen ? (
            <button
              className="fixed bottom-6 right-6 z-50 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#FDBA74] bg-white px-4 py-2.5 text-xs font-semibold text-[#F97316] shadow-[0_10px_30px_rgba(15,23,42,0.18)] transition hover:bg-[#FFF7ED]"
              onClick={returnToPool}
              type="button"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to the pool
            </button>
          ) : null}
          <div className="flex items-center justify-between">
            <div>
              <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                {profile.candidate.fullName}
                {/* The profile is where Reject is pressed, so the eligibility flag has to be here
                    too — not only in the pool a recruiter scrolled past to get here. */}
                {isStatedNonEgyptian(profile.candidate.nationality) ? (
                  <StagePill tone="rose">
                    <span title={nonEgyptianFlagTitle(profile.candidate.nationality)}>{NON_EGYPTIAN_FLAG_LABEL}</span>
                  </StagePill>
                ) : null}
                {/* Read off the stored extraction rather than the pool row, because THIS panel is
                    where "Read the CV again" sits — the button that charged for the same thirteen
                    certificate photographs three times over. The verdict shown has to be the one
                    that button would re-ask, and this is the freshest copy of it. Gate on the
                    explicit false: null is "nobody has judged this file", which is every row
                    written before the column existed. */}
                {storedExtraction?.isCv === false ? (
                  <StagePill tone="amber">
                    <span title={NOT_A_CV_TITLE}>{NOT_A_CV_LABEL}</span>
                  </StagePill>
                ) : null}
              </p>
              <p className="text-xs text-slate-500">
                {profile.candidate.email ?? "—"} · {profile.candidate.phone ?? "—"} · Source: {profile.candidate.source ?? "—"}
              </p>
            </div>
            <Button variant="ghost" onClick={returnToPool}>
              Close
            </Button>
          </div>

          {/* The applied-for role, with the wording it was read from directly beneath it. The
              evidence is shown rather than hidden in a tooltip because this value is INFERRED from
              a covering message, not transcribed from the CV — a recruiter has to be able to see
              the sentence and disagree with it. Same resolution as the pool table, so the profile
              never disagrees with the row that was clicked to reach it. */}
          {(() => {
            const appliedFor = candidateRowAppliedFor(profile.candidate);
            if (!appliedFor.text) return null;
            const readFrom =
              appliedFor.source === "stated" ? profile.candidate.appliedForEvidence : appliedFor.evidence;
            return (
              <div className="rounded-md border border-slate-200 bg-white p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Applying for</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{appliedFor.text}</p>
                {readFrom ? (
                  <p className="mt-1 text-xs text-slate-600">
                    {appliedFor.source ? APPLIED_FOR_SOURCE_LABEL[appliedFor.source] : "Read from"}: {readFrom}
                  </p>
                ) : null}
              </div>
            );
          })()}

          {profile.candidate.sourceContext && profile.candidate.sourceContext.detailLines.length > 0 ? (
            <div className="rounded-md border border-slate-200 bg-slate-50/60 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {profile.candidate.sourceContext.channel === "email" ? "Email subject" : "First WhatsApp messages"}
              </p>
              <div className="mt-1 space-y-1">
                {profile.candidate.sourceContext.detailLines.map((line, index) => (
                  <p key={index} className="text-xs text-slate-700">
                    {line}
                  </p>
                ))}
              </div>
            </div>
          ) : null}

          {canManage && (storedExtraction || profile.files.some((file) => file.kind === "cv")) ? (
            <div className="space-y-2">
              {!retryExtraction && storedExtraction && pendingExtractionFieldCount > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-orange-200 bg-orange-50/70 p-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      {pendingExtractionFieldCount} {pendingExtractionFieldCount === 1 ? "field" : "fields"} read from this CV
                      {" "}still missing from this candidate
                    </p>
                    <p className="text-xs text-slate-600">
                      Intake fills in what the AI was confident about; these are the rest. Review and save them — no new read
                      needed.
                    </p>
                  </div>
                  <Button onClick={() => reviewStoredExtraction(profile.candidate, storedExtraction)} size="sm">
                    Review extracted fields
                  </Button>
                </div>
              ) : null}
              {!retryExtraction && profile.files.some((file) => file.kind === "cv") ? (
                <div className="flex flex-wrap items-center gap-2">
                  {/* Only rendered if a second schema ever exists. The schema is universal now and
                      the job title is an extracted field, so there is nothing to choose — a
                      one-option dropdown would just be a control that does nothing. */}
                  {listCvPositionSchemas().length > 1 ? (
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
                  ) : null}
                  <Button
                    disabled={retryBusy}
                    onClick={() => void startRetryExtraction(profile.candidate.id, retryPositionKey)}
                    size="sm"
                    variant="secondary"
                  >
                    {retryBusy ? "Reading CV…" : storedExtraction ? "Read the CV again" : "Extract from CV"}
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
                  schema={getCvPositionSchema(retryPositionKey) ?? getCvPositionSchema(defaultCvPositionKey)!}
                />
              ) : null}
            </div>
          ) : null}

          {canManage ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <StagePill tone={candidateStatusTone(profile.candidate.status)}>
                  {candidateStatusLabel(profile.candidate.status)}
                </StagePill>
                {profile.candidate.statusChangedAt ? (
                  <span className="whitespace-nowrap text-xs text-slate-500">
                    Changed {cairoDateTime(profile.candidate.statusChangedAt)}
                  </span>
                ) : null}
                <CandidateDecisionButtons
                  candidate={profile.candidate}
                  onDecided={(status, note) =>
                    setProfile((prev) =>
                      prev ? { ...prev, candidate: { ...prev.candidate, status, statusNote: note } } : prev,
                    )
                  }
                  pending={pending}
                  run={run}
                  variant="label"
                />
              </div>
              {profile.candidate.statusNote ? (
                <p className="text-xs text-slate-600">Reason: {profile.candidate.statusNote}</p>
              ) : null}
              {/* The full list, for the moves the two buttons do not cover — Hired, and putting
                  somebody back to New after a rejection was reconsidered. The note travels with it,
                  which is the whole reason the free-text status box that used to sit here is gone:
                  it recorded a sentence where a state belonged, and it could not save either. */}
              <div className="flex flex-wrap gap-2">
                <SearchableSelect
                  className={`${fieldClass} sm:w-56`}
                  value={statusDraft}
                  onChange={(e) => setStatusDraft(e.target.value)}
                >
                  <option value="">Set another status…</option>
                  {candidateStatuses.map((status) => (
                    <option key={status} value={status}>
                      {candidateStatusLabels[status]}
                    </option>
                  ))}
                </SearchableSelect>
                <Input
                  maxLength={CANDIDATE_STATUS_NOTE_MAX_LENGTH}
                  placeholder="Reason (optional)"
                  value={statusNoteDraft}
                  onChange={(e) => setStatusNoteDraft(e.target.value)}
                />
                <Button
                  variant="secondary"
                  disabled={pending || !statusDraft}
                  onClick={() =>
                    run(async () => {
                      const note = statusNoteDraft.trim() || null;
                      await patchJson(`/api/recruitment/candidates/${profile.candidate.id}/status`, {
                        note: note ?? undefined,
                        status: statusDraft,
                      });
                      setProfile((prev) =>
                        prev
                          ? { ...prev, candidate: { ...prev.candidate, status: statusDraft, statusNote: note } }
                          : prev,
                      );
                      const label = candidateStatusLabel(statusDraft);
                      setStatusDraft("");
                      setStatusNoteDraft("");
                      return `${profile.candidate.fullName} marked ${label.toLowerCase()}.`;
                    })
                  }
                >
                  Update status
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              Status: {candidateStatusLabel(profile.candidate.status)}
              {profile.candidate.statusNote ? ` · ${profile.candidate.statusNote}` : ""}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Applied positions</p>
              {profile.applications.length === 0 ? (
                <p className="text-xs text-slate-400">None</p>
              ) : (
                profile.applications.map((entry) => (
                  <p key={entry.application.id} className="text-xs text-slate-600">
                    {entry.jobTitle ?? "—"} · {applicationStageLabel(entry.application.stage)}
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
                    {humanizeRecruitmentTerm(entry.interview.interviewType)} · {entry.summary.average ?? "—"} · {entry.interview.outcome ?? "—"}
                  </p>
                ))
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">CV / files</p>
              {profile.files.length === 0 ? (
                <p className="text-xs text-slate-400">No files</p>
              ) : (
                profile.files.map((file) =>
                  file.kind === "cv" && detectCvFileKind(file.mimeType ?? "", file.fileName) !== "unsupported" ? (
                    <button
                      className="block text-left text-xs text-orange-600 underline-offset-2 hover:underline"
                      key={file.id}
                      onClick={() => setViewCvFile(file)}
                      type="button"
                    >
                      {file.fileName}
                    </button>
                  ) : (
                    <p className="text-xs text-slate-600" key={file.id}>
                      {file.fileName}
                    </p>
                  ),
                )
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
                    {humanizeRecruitmentTerm(event.action)} · {event.reason ?? "—"}
                  </p>
                ))
              )}
            </div>
          </div>
          {profile.candidate.notes ? <p className="text-xs text-slate-600">Notes: {profile.candidate.notes}</p> : null}

          {viewCvFile ? (
            <CvPreviewModal
              downloadUrl={`/api/recruitment/files/${viewCvFile.id}/download`}
              fileName={viewCvFile.fileName}
              mimeType={viewCvFile.mimeType}
              onClose={() => setViewCvFile(null)}
              sidePanel={<CandidateFieldsPanel candidate={profile.candidate} schema={getCvPositionSchema(defaultCvPositionKey)!} />}
            />
          ) : null}
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
                  <span className="font-medium text-slate-800">{humanizeRecruitmentTerm(interview.interviewType)}</span>
                  <span className="text-slate-500">
                    {interview.scheduledAt ? new Date(interview.scheduledAt).toLocaleString() : "Unscheduled"}
                  </span>
                </div>
                <div className="text-slate-500">
                  Outcome: {interview.outcome ? humanizeRecruitmentTerm(interview.outcome) : "—"}
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
                            {humanizeRecruitmentTerm(value)}
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
