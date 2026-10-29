"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Fragment, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Briefcase,
  BriefcaseBusiness,
  Check,
  ClipboardList,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  FileSpreadsheet,
  FolderOpen,
  FolderPlus,
  Megaphone,
  Send,
  Sparkles,
  Trash2,
  Undo2,
  UserPlus,
  Users,
  Workflow,
  X,
} from "lucide-react";
import Link from "next/link";

import {
  AdminCallout,
  AdminInsightChip,
  AdminStatCard,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Input } from "@/components/ui/input";
import { JobAdvertPanel } from "@/components/recruitment/job-advert-panel";
import { CandidateFoldersTab } from "@/components/recruitment/candidate-folders-tab";
import { deleteRequest, patchJson, postJson } from "@/components/recruitment/recruitment-fetch";
import {
  RecruitmentEmptyState,
  RecruitmentKpiStrip,
  RecruitmentPageHeader,
  RecruitmentPanel,
  RecruitmentPill,
  RecruitmentTabBar,
} from "@/components/recruitment/recruitment-premium";
import type { CvFolderCabinetData } from "@/components/recruitment/cv-folder-cabinet";
import { CandidateDecisionTabStrip } from "@/components/recruitment/candidate-decision-tab-strip";
import {
  RecruitmentTabUnavailable,
  RecruitmentUnavailableNotice,
} from "@/components/recruitment/recruitment-unavailable-notice";
import type { RecruitmentReadSource } from "@/lib/recruitment/page-reads";
import {
  candidateMatchesDecisionTab,
  countCandidatesByDecisionTab,
  DEFAULT_CANDIDATE_DECISION_TAB,
  statusFilterForDecisionTab,
  type CandidateDecisionTab,
} from "@/lib/recruitment/candidate-decision-tabs";
import { buildCvFolderTree, flattenCvFolderTree } from "@/lib/recruitment/cv-folder-tree";
import type { ApplicationWithContext } from "@/lib/recruitment/applications";
import type { CandidateProfile } from "@/lib/recruitment/candidates";
import { APPLIED_FOR_SOURCE_LABEL, APPLIED_FOR_SOURCE_SHORT, candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import {
  candidateMatchesPoolQuery,
  normalizeCandidatePoolQuery,
} from "@/lib/recruitment/candidate-pool-search";
import { candidateDisplayName, isShortenedCandidateName } from "@/lib/recruitment/candidate-display";
import { candidatePageHref, recruitmentRootFromPathname } from "@/lib/recruitment/candidate-page-link";
import { managerLabelOrNull } from "@/lib/recruitment/person-labels";
import {
  candidateFolderKeyLabels,
  candidateFolderKindLabels,
  candidateFolderKinds,
  candidateFolderRefusal,
  districtManagerFolderOptions,
  PARAMEDICAL_FOLDER_KEY,
  partitionCandidatesByFolder,
  type CandidateFolderKind,
} from "@/lib/recruitment/candidate-folder";
import type { CandidateFolderAreaOption } from "@/lib/recruitment/candidate-folder-options";
import {
  groupCandidatesByNotifiedManager,
  managerSeatLabel,
  type ManagerGroup,
} from "@/lib/recruitment/manager-grouping";
import { downloadFromApiRoute } from "@/lib/navigation/browser-navigation";
import { screeningHref } from "@/lib/recruitment/screening-link";
import {
  applicationStageLabel,
  humanizeRecruitmentTerm,
  requisitionStatusLabel,
} from "@/lib/recruitment/labels";
import {
  adminChipDepthClassName,
  adminControlDepthClassName,
  adminPanelDepthClassName,
  adminRecessedDepthClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";
// offer-rules is the pure half of the offer service — no database imports — so the same
// completeness check runs in the browser and on the server without pulling a Supabase client in.
import { isOfferStage, missingOfferTerms } from "@/lib/recruitment/offer-rules";
import type { Offer } from "@/lib/recruitment/offers";
import {
  candidateSourceChannel,
  type CandidateSourceChannelKey,
} from "@/lib/recruitment/candidate-source-context";
import {
  candidateRegionCodes,
  candidateRegionLabels,
  foreignRegionLabel,
  type CandidateRegionCode,
} from "@/lib/recruitment/candidate-region";
import {
  candidateRoleFamilies,
  candidateRoleFamilyLabels,
  normalizeJobTitle,
  type CandidateRoleFamily,
} from "@/lib/recruitment/candidate-role-family";
import {
  candidateScreeningFacts,
  candidateScreeningRoleFamily,
  formatYearsOfExperience,
  screeningRoleFamilies,
  UNCONFIRMED_FACT_TITLE,
} from "@/lib/recruitment/candidate-screening-facts";
import { cairoDayKey, type CandidatePoolStats } from "@/lib/recruitment/candidate-stats";
import { foldersToOffer } from "@/lib/recruitment/folder-choice";
import type { HiringManagerOption } from "@/lib/recruitment/hiring-manager-notify";
import type { SelectionBoardEntry } from "@/lib/recruitment/selection";
import type { RecruitmentDashboard } from "@/lib/recruitment/dashboard";
import {
  computePipelineMetrics,
  daysInStage,
  STALLED_AFTER_DAYS,
} from "@/lib/recruitment/pipeline-metrics";
import { isTerminalApplicationStage } from "@/lib/recruitment/types";
import type { Candidate, Interview, InterviewType, PositionCatalogueOption, RecruitmentActionKey, RecruitmentFile, Requisition } from "@/lib/recruitment/types";
import {
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  candidateStatuses,
  candidateStatusLabel,
  candidateStatusLabels,
  normalizeCandidateStatus,
  statusChangeRefusal,
  type CandidateStatus,
} from "@/lib/recruitment/candidate-status";
import {
  NON_EGYPTIAN_FLAG_LABEL,
  isStatedNonEgyptian,
  nonEgyptianFlagTitle,
} from "@/lib/recruitment/nationality";
import { NOT_A_CV_LABEL, NOT_A_CV_TITLE, isNotACv } from "@/lib/recruitment/not-a-cv";
import { EXPERIENCE_GAP_LABEL, experienceAnswerGap, factsHaveExperienceGap } from "@/lib/recruitment/experience-answer-gap";
import { EMAIL_CHECK_LABEL, candidateEmailProblem } from "@/lib/recruitment/candidate-email-check";
import {
  candidateCvTabDescriptions,
  candidateCvTabLabels,
  candidateCvTabs,
  partitionCandidatesByRedFlag,
  type CandidateCvTab,
} from "@/lib/recruitment/red-flag";
import { interviewOutcomes, interviewScorecardCriteria, summarizeScorecard } from "@/lib/recruitment/scorecards";
import type { VacancyReportRow } from "@/lib/reports/vacancies";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { BulkCvExtractionPanel } from "@/components/recruitment/bulk-cv-extraction-panel";
import { CandidateFieldsPanel } from "@/components/recruitment/candidate-fields-panel";
import { WhatsAppReplyBox } from "@/components/recruitment/whatsapp-reply-box";
import { ScheduleInterviewButton } from "@/components/recruitment/interview-calendar/schedule-interview-button";
import { ActionLink } from "@/components/recruitment/workstation/workstation-look";
import { linkedInProfileHref } from "@/lib/recruitment/linkedin-profile";
import { CvExtractionPanel } from "@/components/recruitment/cv-extraction-panel";
import { CvExtractionReviewBoard } from "@/components/recruitment/cv-extraction-review-board";
import { CandidateFactsSummary } from "@/components/recruitment/candidate-facts-summary";
import { candidateWhatsAppAnswers, type ScreeningQuestionLabel } from "@/lib/recruitment/whatsapp-answers";
import {
  applyPoolColumnLayout,
  poolAnswersByColumn,
  poolAnswersOutsideColumns,
  poolAnswerSummary,
  poolColumnCatalogue,
  poolColumnViewKey,
  poolDefaultColumns,
  poolRoleQuestionsCaption,
  poolSharedColumnKeys,
  type PoolSharedColumnKey,
  type PoolTableColumn,
  type PoolWhatsAppQuestions,
} from "@/lib/recruitment/pool-whatsapp-columns";
import { PoolColumnChooser, PoolEditableAnswer, PoolEditableCell } from "@/components/recruitment/pool-question-columns";
import { usePoolColumnLayout } from "@/components/recruitment/use-pool-column-layout";
import { WhatsAppAnswersList } from "@/components/recruitment/whatsapp-answers-list";
import { CandidateScreeningSession } from "@/components/recruitment/candidate-screening-session";
import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
// The screening queue's two pickers, used verbatim here.
//
// The owner, 2026-08-31: *"I tell you a thing. You should implement it everywhere if needed and if
// applicable. I don't have to tell you everything one by one."* The pool sends CVs to the same 32
// managers, for the same 45 open seats, out of flat dropdowns with exactly the faults the screening
// ones were rebuilt to end — seventeen District Sales Managers no label could tell apart, and two
// seats in Behira 1 · Pedia that read as one row typed twice. Sharing the components is also what
// stops the two screens drifting into disagreeing about how a manager's seat is written.
import { FolderChoice } from "@/components/recruitment/folder-choice";
import { ManagerPicker } from "@/components/recruitment/manager-picker";
import { FREE_POSITION, VacancyPicker } from "@/components/recruitment/vacancy-picker";
import {
  countUnappliedCvFields,
  seedReviewFieldsFromCandidate,
  type ExtractedCandidateFields,
  type StoredCvExtraction,
} from "@/lib/recruitment/cv-extraction-fields";
import { defaultCvPositionKey, getCvPositionSchema, listCvPositionSchemas } from "@/lib/recruitment/cv-field-schemas";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import {
  phxButtonGhostClassName,
  phxFieldClassName,
  phxLabelTextClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";


type ManagerOption = { hrId: string; fullName: string };

type Props = {
  /** Every active area with the region it files under in RECRUITMENT — the folder picker's list. */
  areaOptions: CandidateFolderAreaOption[];
  canApprove: boolean;
  canCreateRequisition: boolean;
  canDelete: boolean;
  /** `candidates: update` — what the cv-folders routes enforce, so what the folder buttons gate on. */
  canFileCandidates: boolean;
  canImport: boolean;
  canManage: boolean;
  canManageCandidates: boolean;
  canViewCandidates: boolean;
  candidates: Candidate[];
  // Counted on the server, deliberately — "arrived today" depends on the clock, and a clock read
  // during hydration can disagree with the one from the server render. See candidate-stats.ts.
  candidateStats: CandidatePoolStats;
  /** The hand-built folder tree and its memberships — the folders tab's top section. */
  cvFolderCabinet: CvFolderCabinetData;
  dashboard: RecruitmentDashboard | null;
  filesEnabled: boolean;
  // The ~30 real managers a candidate can be sent to, straight from their job title. Distinct from
  // `managers` below, which is the whole employee directory and fills the requisition form.
  hiringManagers: HiringManagerOption[];
  managers: ManagerOption[];
  openVacancies: VacancyReportRow[];
  // The full catalogue of active positions (all 21) offered in the requisition Position dropdown —
  // distinct from openVacancies, which is only the handful of positions with a vacant seat today.
  positionCatalogue: PositionCatalogueOption[];
  // The reads the server could not complete (src/lib/recruitment/page-reads.ts). Every list above keeps
  // its EMPTY shape for a source named here, and an empty shape is not an answer: the page says which
  // part is missing instead of showing a zero or an empty table.
  unavailableSources: RecruitmentReadSource[];
  /**
   * The WhatsApp bot's questions and who each is asked to, so the pool's headers follow them
   * (pool-whatsapp-columns.ts). Null when the list could not be read.
   */
  whatsappQuestions: PoolWhatsAppQuestions | null;
};

type TabKey = "pipeline" | "requisitions" | "candidates" | "folders" | "advertise";

// One mark per tab, so the bar reads at a glance and the selected one carries the accent.
const workspaceTabIcon: Record<TabKey, ReactNode> = {
  advertise: <Megaphone className="h-4 w-4" />,
  candidates: <Users className="h-4 w-4" />,
  folders: <FolderOpen className="h-4 w-4" />,
  pipeline: <Workflow className="h-4 w-4" />,
  requisitions: <ClipboardList className="h-4 w-4" />,
};

/** Under a tile whose figure is a dash because the pool did not load -- a zero would read as "no CVs". */
const POOL_UNAVAILABLE_TILE_NOTE = "Unavailable right now.";

/**
 * Which inline picker a pool row has open. Lifted to the table so only ONE row expands at a time —
 * 555 rows each carrying its own dropdowns is the thing this state exists to prevent.
 */
type PoolRowPanel = "send" | "start" | "folder";

const fieldClass  = phxFieldClassName;

// ── Source-of-hire: the advert picker ─────────────────────────────────────────────────────────────
//
// Which advert this candidate actually came from. Loaded once from the same directory the advert
// panel builds. It is the ONLY route to advert-level source-of-hire in practice: the tracked code
// rides inside the applicant's own first message, and a forwarded WhatsApp CV — the bulk of intake —
// drops that message, so almost nothing arrives attributed. HR tags the real advert here instead.
type PickerChannel = { code: string; name: string; kind: string; isActive: boolean };

function useJobPostChannels(): PickerChannel[] | null {
  const [channels, setChannels] = useState<PickerChannel[] | null>(null);
  // setState only inside the scheduled callback — react-hooks/set-state-in-effect is an error here
  // and blocks the required lint check (see the advert panel's own note).
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/recruitment/job-post-channels", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (cancelled) return;
        setChannels(
          res.ok && json.success === true && Array.isArray(json.channels)
            ? (json.channels as PickerChannel[])
            : [],
        );
      } catch {
        if (!cancelled) setChannels([]);
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  return channels;
}

function SourceAdvertSelect({
  value,
  onChange,
  channels,
  disabled,
}: {
  value: string;
  onChange: (code: string) => void;
  channels: PickerChannel[] | null;
  disabled?: boolean;
}) {
  // Active channels, plus whatever is already selected even if it was since retired — so a hire
  // tagged to a group that has since closed keeps showing that group, not a blank.
  const options = (channels ?? [])
    .filter((channel) => channel.isActive || channel.code === value)
    .sort((left, right) => left.name.localeCompare(right.name));
  return (
    <select
      className={fieldClass}
      disabled={disabled || channels === null}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{channels === null ? "Loading adverts…" : "Source advert — not set"}</option>
      {options.map((channel) => (
        <option key={channel.code} value={channel.code}>
          {channel.name}
        </option>
      ))}
    </select>
  );
}

/**
 * Tag (or change) the source advert of an already-hired application.
 *
 * Keyed by application id at the call site, so the picker re-seeds from that hire's stored tag when
 * a different row is selected. This is the after-the-fact path: HR usually learns the real source
 * later, and every hire that arrived without a tracked code needs tagging by hand for it to count.
 */
function HiredSourceCard({
  application,
  channels,
  pending,
  run,
}: {
  application: { id: string; attributedChannelCode: string | null };
  channels: PickerChannel[] | null;
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
}) {
  const stored = application.attributedChannelCode ?? "";
  const [code, setCode] = useState(stored);
  const dirty = code !== stored;
  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Source advert</p>
      <p className="text-xs text-slate-500">
        Which advert this hire came from. Tagging it here is what makes the hire count under its real
        advert in Hiring Analytics — most CVs arrive with no tracked code.
      </p>
      <SourceAdvertSelect channels={channels} disabled={pending} value={code} onChange={setCode} />
      <Button
        disabled={pending || !dirty}
        onClick={() =>
          run(async () => {
            await postJson(`/api/recruitment/applications/${application.id}/attribute-source`, {
              channelCode: code || "",
            });
            return code ? "Source advert saved." : "Source advert cleared.";
          })
        }
      >
        Save source advert
      </Button>
    </div>
  );
}

// Same look as the candidate pool's filter labels (poolFilterLabelClass), but rendered as a plain
// div/span rather than a <label>. SearchableSelect is a portalled combobox, not a native <select>,
// so an implicit label would re-target the click and reopen the panel the user just dismissed.
const requisitionFieldLabelClass = phxLabelTextClassName;

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
      {hint ? <span className="text-phx-xs text-slate-500">{hint}</span> : null}
    </div>
  );
}

// Every moment this module shows a person is Cairo local time, never a raw UTC string.
function cairoDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "—";
  const date = formatStableEnGb(value, {
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
// The tones are the module kit's six (recruitment-premium.tsx), so a stage reads in the same colour
// here as on the candidate page, the cockpit and the calendar.
type BadgeTone = "orange" | "emerald" | "amber" | "rose" | "sky" | "slate";

function StagePill({ children, tone }: { children: ReactNode; tone: BadgeTone }) {
  return <RecruitmentPill tone={tone}>{children}</RecruitmentPill>;
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
  backup: "amber",
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
  // The workflow registry has defined app_to_pre_boarding since the ATS re-platform - from
  // offer_accepted, to pre_boarding, for Super Admin and HR Advisory, labelled "Move to
  // pre-boarding" - and this map is the ONLY thing that turns a registry action into a button.
  // offer_accepted was missing from it, so the stage could be reached by nothing at all.
  //
  // It is not a cosmetic gap. pre_boarding is a counted stage: it is the whole of the "Joining"
  // group on the HR command centre and one of the three stages pipeline-metrics treats as an
  // accepted offer. With no way in, Joining could only ever read zero, which looks like nobody is
  // joining rather than like a missing button.
  offer_accepted: { action: "app_to_pre_boarding", label: "Move to pre-boarding" },
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
  const managerName = managerLabelOrNull(
    application.requisition?.hiringManagerName,
    application.requisition?.hiringManagerHrId,
  );
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
        <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <table className="w-full table-fixed text-xs">
            <colgroup>
              <col className="w-[32%]" />
              <col className="w-[12%]" />
              <col className="w-[18%]" />
              <col className="w-[16%]" />
              <col className="w-[22%]" />
            </colgroup>
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
                    <td className="break-words px-2 py-1 font-semibold text-slate-900">{entry.candidate?.fullName ?? "—"}</td>
                    <td className="break-words px-2 py-1 tabular-nums">{entry.ratingAverage ?? "—"}</td>
                    <td className="break-words px-2 py-1 tabular-nums">{entry.candidate?.expectedSalary ?? "—"}</td>
                    <td className="break-words px-2 py-1">{entry.candidate?.noticePeriod ?? "—"}</td>
                    <td className="break-words px-2 py-1">
                      {entry.riskPreviouslyRejected ? (
                        <StagePill tone="orange">Previously rejected</StagePill>
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
            Waiting for approval. The recruiter who prepared an offer cannot approve it.
          </p>
        )
      ) : null}

      {stage === "offer_approved" ? (
        <div className="space-y-2 pt-1">
          {/*
            The approved terms, carried into the letter instead of retyped.

            Only at offer_approved, because that is the moment the retyping happens AND the moment
            the terms are final. The route runs the same approval gate again rather than trusting
            this button: a stage is what the workflow registry says, and the registry is editable
            at runtime, so approval is read from approvedAt on the server.
          */}
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              run(async () => {
                const data = await postJson(
                  `/api/recruitment/applications/${applicationId}/offer-letter`,
                  {},
                );
                const reference = typeof data.reference === "string" ? data.reference : "";
                const reused = data.reused === true;
                const inCatalogue = data.titleInCatalogue === true;
                return (
                  (reused
                    ? `A draft letter already existed for this candidate and title (${reference}).`
                    : `Offer letter ${reference} drafted with the approved terms.`)
                  + (inCatalogue
                    ? " Open it on the Offers screen to check it and send it."
                    : " The job title is not in the offer catalogue, so cost of living, contract term"
                      + " and who they report to are blank — fill them on the Offers screen before sending.")
                );
              })
            }
          >
            Draft the offer letter
          </Button>
          <Button size="sm" disabled={pending} onClick={() => post({ intent: "mark_sent" }, "Offer recorded as sent.")}>
            Record offer as sent
          </Button>
          <p className="text-xs text-slate-500">
            Nothing is emailed from here. Draft the letter, send it from the Offers screen, then record it.
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
  const { candidateStats, dashboard, unavailableSources } = props;
  // A pool that did not load holds [] -- which would read as "no CVs" in the tiles and the tabs below.
  const poolUnavailable = unavailableSources.includes("pool");
  const foldersUnavailable = poolUnavailable || unavailableSources.includes("cvFolders");
  const router = useRouter();
  // The inbound-CV notification deep-links to ?candidate=<id> so a reviewer lands on the profile
  // holding the extracted fields, not on a module landing page they'd have to search from.
  const workspaceParams = useSearchParams();
  const workspacePathname = usePathname();
  const linkedCandidateId = workspaceParams.get("candidate");
  const [pending, startTransition] = useTransition();
  // Its own transition, so "Trying again" shows only for a retry -- never because a save is under way.
  const [retrying, startRetry] = useTransition();
  // Candidates, not Pipeline. Production on 2026-08-15: the pipeline held 7 applications ever while
  // 152 CVs arrived that week — so the module opened on its emptiest screen and put the work two
  // clicks away, behind a tab labelled with someone else's vocabulary.
  // ...except when HR sends someone back here holding a freshly created employee's HR_ID
  // (?application=<id>), which is a return trip into the pipeline, not a fresh visit.
  const [tab, setTab] = useState<TabKey>(() => (workspaceParams.get("application") ? "pipeline" : "candidates"));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Open one CV from the folders screen.
   *
   * Deliberately routed through the ?candidate= deep link rather than by hoisting the profile panel
   * out of the pool tab: that link is already the one path into a profile from OUTSIDE the pool (the
   * inbound-CV notification uses it), so a filed CV opens through exactly the same code as every
   * other CV — one profile panel, one CV viewer, one thing to keep working. `openProfile` fetches
   * the candidate by id, so being off the pool does not stop it opening.
   *
   * The tab switch is what makes it visible: the panel renders inside the pool tab, so setting the
   * link without switching would load a profile onto a screen that cannot show it.
   */
  const openCandidateFromFolder = (candidateId: string) => {
    const next = new URLSearchParams(Array.from(workspaceParams.entries()));
    next.set("candidate", candidateId);
    setTab("candidates");
    router.replace(`${workspacePathname}?${next.toString()}`, { scroll: false });
  };

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

  // Asking the server for the page again re-runs every read, which is the whole remedy for a slow moment.
  const tryAgain = () =>
    startRetry(() => {
      router.refresh();
    });

  const requisitions = dashboard?.requisitions ?? [];
  const applications = dashboard?.applications ?? [];

  return (
    <div className="space-y-6">
      <RecruitmentPageHeader
        badges={
          dashboard ? (
            <>
              <AdminInsightChip tone="orange">
                {requisitions.filter((requisition) => ["req_open", "req_published"].includes(requisition.status)).length} open
                requisitions
              </AdminInsightChip>
              <AdminInsightChip tone="slate">{applications.length} in the pipeline</AdminInsightChip>
            </>
          ) : null
        }
        eyebrow="People Management"
        icon={<BriefcaseBusiness className="h-3.5 w-3.5" />}
        title="Recruitment"
        description="Read every CV as it arrives, decide on it, and send the ones worth seeing straight to the hiring manager."
      />

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {notice ? <AdminCallout tone="success">{notice}</AdminCallout> : null}
      <RecruitmentUnavailableNotice onRetry={tryAgain} pending={retrying} sources={unavailableSources} />

      {/*
        These four count CVs, not requisitions. The previous set — open requisitions, active
        applications, hires, total applications — read 3 / 7 / 0 / 7 in production on 2026-08-15,
        the same week 152 CVs arrived, so the headline of the module described the part nobody uses.
      */}
      <RecruitmentKpiStrip
        items={[
          {
            description: poolUnavailable ? POOL_UNAVAILABLE_TILE_NOTE : "CVs received today, Cairo time.",
            icon: <FileSpreadsheet className="h-5 w-5" />,
            label: "Arrived today",
            tone: "orange",
            value: poolUnavailable ? "—" : candidateStats.arrivedToday,
          },
          {
            description: poolUnavailable ? POOL_UNAVAILABLE_TILE_NOTE : "CVs received in the last 7 days.",
            icon: <Users className="h-5 w-5" />,
            label: "Arrived this week",
            tone: "blue",
            value: poolUnavailable ? "—" : candidateStats.arrivedLast7Days,
          },
          {
            description: poolUnavailable ? POOL_UNAVAILABLE_TILE_NOTE : "Still on the status intake set — nobody has looked yet.",
            icon: <UserPlus className="h-5 w-5" />,
            label: "Not yet reviewed",
            tone: "violet",
            value: poolUnavailable ? "—" : candidateStats.notYetReviewed,
          },
          {
            description: poolUnavailable ? POOL_UNAVAILABLE_TILE_NOTE : "Candidates a hiring manager has been told about.",
            icon: <CheckCircle2 className="h-5 w-5" />,
            label: "Sent to a manager",
            tone: "emerald",
            value: poolUnavailable ? "—" : candidateStats.sentToManager,
          },
        ]}
      />

      {/* Candidates first, because it is where the work is and where the module now opens. */}
      {/* Advertise is management-only: it hands out apply links and retires channels. */}
      {/* Folders sits directly after Candidates because it is the same pile, shelved — a CV is in
          one or the other and never both, so the two tabs read as two halves of one list. */}
      {/* Counts only where the number is the tab's own list: the pool and the shelves split one
          array by a rule that lives in their own components, so a count here would be a second guess. */}
      <RecruitmentTabBar
        label="Recruitment sections"
        onChange={setTab}
        tabs={(props.canManage
          ? (["candidates", "folders", "requisitions", "pipeline", "advertise"] as TabKey[])
          : (["candidates", "folders", "requisitions", "pipeline"] as TabKey[])
        ).map((key) => ({
          count: !dashboard ? null : key === "requisitions" ? requisitions.length : key === "pipeline" ? applications.length : null,
          icon: workspaceTabIcon[key],
          key,
          label: humanizeRecruitmentTerm(key),
        }))}
        value={tab}
      />

      {/* Each tab stands or falls on ITS OWN data. The pool and the folders do not need the dashboard,
          so a dashboard that did not load no longer hides the screen where the work is. */}
      {tab === "advertise" ? (
        <JobAdvertPanel />
      ) : tab === "folders" && foldersUnavailable ? (
        <RecruitmentTabUnavailable what="The CV folders list" />
      ) : tab === "folders" ? (
        // Handed the WHOLE candidate array, not the filed half. The shelf screen and the pool run
        // the same partition over the same input, which is what makes "in exactly one of the two"
        // true by construction rather than by two filters agreeing.
        <CandidateFoldersTab
          areaOptions={props.areaOptions}
          canFileCandidates={props.canFileCandidates}
          candidates={props.candidates}
          cvFolderCabinet={props.cvFolderCabinet}
          onOpenCandidate={openCandidateFromFolder}
        />
      ) : (tab === "pipeline" || tab === "requisitions") && !dashboard ? (
        <RecruitmentTabUnavailable what={tab === "pipeline" ? "The hiring pipeline" : "The requisitions list"} />
      ) : tab === "candidates" && poolUnavailable ? (
        <RecruitmentTabUnavailable what="The candidate list" />
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
          positionCatalogue={props.positionCatalogue}
          pending={pending}
          requisitions={requisitions}
          run={run}
        />
      ) : (
        <CandidatesTab
          areaOptions={props.areaOptions}
          asOf={candidateStats.asOf}
          canDelete={props.canDelete}
          canImport={props.canImport}
          canFileCandidates={props.canFileCandidates}
          canManage={props.canManageCandidates}
          candidates={props.candidates}
          cvFolderCabinet={props.cvFolderCabinet}
          hiringManagers={props.hiringManagers}
          linkedCandidateId={linkedCandidateId}
          openRequisitions={requisitions.filter((requisition) =>
            ["req_open", "req_published"].includes(requisition.status),
          )}
          openVacancies={props.openVacancies}
          pending={pending}
          run={run}
          setError={setError}
          setNotice={setNotice}
          whatsappQuestions={props.whatsappQuestions}
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
  // Built when Talent Acquisition worked in the portal shell and Super Admin in the admin one, so
  // the way out to Add Employee is derived from where we already are rather than passed down as
  // another prop. HR Advisory, the current recruiting seat, is admin-shell like Super Admin, so in
  // practice this only ever renders at the admin pathname now — see
  // tests/recruitment-hub-portal-coverage.test.ts (ORPHANED_PORTAL_MIRRORS) for why the portal
  // route this branch still serves is unreachable.
  const hirePathname = usePathname();
  const addEmployeeHref = hirePathname?.startsWith("/employee-portals")
    ? "/employee-portals/employees"
    : "/employees";
  const [selectedId, setSelectedId] = useState<string | null>(() => hireParams.get("application"));
  const [reason, setReason] = useState("");
  const [employeeHrId, setEmployeeHrId] = useState(() => hireParams.get("hiredHrId") ?? "");
  const [hireStartDate, setHireStartDate] = useState("");
  const [hireProbationMonths, setHireProbationMonths] = useState("3");
  const [hireSource, setHireSource] = useState("");
  // Loaded once for both the hire picker and the after-the-fact tag card below.
  const pickerChannels = useJobPostChannels();
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
        <RecruitmentPanel
          count={applications.length}
          description="Every application and its current stage. Select a row to act on it."
          icon={<Workflow aria-hidden="true" className="h-4 w-4" />}
          title="Pipeline"
        >
          <PortalResponsiveDataList
            empty={
              <RecruitmentEmptyState
                icon={<Workflow aria-hidden="true" className="h-5 w-5" />}
                message="Add a candidate from the Candidates tab."
                title="No applications yet"
              />
            }
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
              <PortalDesktopTable
                cols={
                  <colgroup>
                    <col className="w-[22%]" />
                    <col className="w-[20%]" />
                    <col className="w-[15%]" />
                    <col className="w-[13%]" />
                    <col className="w-[22%]" />
                    <col className="w-[8%]" />
                  </colgroup>
                }
              >
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
                      className={
                        selectedId === application.id
                          ? "bg-orange-50"
                          : "cursor-pointer transition-colors hover:bg-slate-50"
                      }
                      onClick={() => selectApplication(application.id)}
                    >
                      {/* The stored name is the whole forwarded-mail envelope on 40% of this
                          pool, so the raw value wrapped a row onto three lines. Same treatment the
                          candidate table has always given it: the name on screen, the envelope on
                          hover. */}
                      <td className="break-words px-3 py-2 font-semibold text-slate-950" title={application.candidate?.fullName}>
                        {candidateDisplayName(application.candidate?.fullName ?? "") || "Unknown candidate"}
                      </td>
                      <td className="px-3 py-2">{application.requisition?.jobTitle ?? "—"}</td>
                      <td className="px-3 py-2">
                        <StagePill tone={stageTone(application.stage)}>{applicationStageLabel(application.stage)}</StagePill>
                      </td>
                      <td className="break-words px-3 py-2">
                        <WaitingInStage application={application} asOf={asOf} />
                      </td>
                      <td className="break-words px-3 py-2 text-xs">
                        {application.managerNotified ? (
                          <>
                            <span className="block font-semibold text-slate-800">{application.managerNotified.managerName}</span>
                            <span className="block tabular-nums text-slate-500">{cairoDateTime(application.managerNotified.sentAt)}</span>
                          </>
                        ) : (
                          <StagePill tone="amber">Not sent</StagePill>
                        )}
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
        </RecruitmentPanel>

        <RecruitmentPanel
          className="self-start lg:sticky lg:top-4"
          description="Move the selected candidate through the pipeline."
          icon={<Sparkles aria-hidden="true" className="h-4 w-4" />}
          title="Actions"
        >
          {!selected ? (
            <RecruitmentEmptyState
              icon={<Workflow aria-hidden="true" className="h-5 w-5" />}
              message="Select an application to see available actions."
              title="Nothing selected"
            />
          ) : (
            <div className="space-y-3 p-4">
              <div className="border-b border-slate-200 pb-3">
                <p className="break-words text-base font-black tracking-tight text-slate-950">
                  {candidateDisplayName(selected.candidate?.fullName ?? "") || "Unknown candidate"}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <StagePill tone={stageTone(selected.stage)}>{applicationStageLabel(selected.stage)}</StagePill>
                  <span className="break-words text-xs font-medium text-slate-500">{selected.requisition?.jobTitle ?? "—"}</span>
                </div>
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
                    className={cn(phxButtonGhostClassName, "w-full justify-center")}
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
                  <div className="space-y-1">
                    <p className="text-xs text-slate-500">
                      Source advert (optional) — which advert this person came from, if you know it. Most
                      CVs arrive without a tracked code, so tagging it here is what makes them count in
                      Hiring Analytics.
                    </p>
                    <SourceAdvertSelect
                      channels={pickerChannels}
                      disabled={pending}
                      value={hireSource}
                      onChange={setHireSource}
                    />
                  </div>
                  <Button
                    disabled={pending || !employeeHrId.trim()}
                    onClick={() =>
                      run(async () => {
                        const data = await postJson(`/api/recruitment/applications/${selected.id}/convert`, {
                          employeeHrId: employeeHrId.trim(),
                          startDate: hireStartDate || undefined,
                          probationMonths: Number(hireProbationMonths) || undefined,
                          attributedChannelCode: hireSource || "",
                        });
                        setEmployeeHrId("");
                        setHireStartDate("");
                        setHireSource("");
                        return `Hired as ${typeof data.employeeHrId === "string" ? data.employeeHrId : employeeHrId.trim()}.`;
                      })
                    }
                  >
                    Mark as hired
                  </Button>
                </div>
              ) : null}

              {canManage && selected.stage === "hired" ? (
                <HiredSourceCard
                  key={selected.id}
                  application={selected}
                  channels={pickerChannels}
                  pending={pending}
                  run={run}
                />
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
                  candidateName={selected.candidate?.fullName ?? null}
                  canUpload={canManageCandidates}
                  error={candidateFilesError}
                  files={candidateFiles}
                  filesEnabled={filesEnabled}
                  onReload={() => loadCandidateFiles(selected.candidateId)}
                />
              ) : null}
            </div>
          )}
        </RecruitmentPanel>
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
      {/* THE "APPLICATION LINK" BUTTON WAS REMOVED HERE, 2026-09-05, because it could not work.
          It called POST /api/recruitment/requisitions/[id]/posting. That route and its
          `recruitment_job_postings` table were BOTH added by 670adc127 ("Phase 4a public application
          funnel") and BOTH deleted by f8ea71fc9 ("re-platform onto ats_ tables"). The button was left
          behind, so every press since has returned 404 — on a live screen, with four open
          requisitions.

          The capability it promised did not vanish; it was REPLACED. Applications now arrive through
          tracked WhatsApp and email adverts — buildApplyLink and the PX- channel codes in
          src/lib/recruitment/outreach/, with their own panel in job-advert-panel.tsx and 43 channels
          on file. Rebuilding a hosted application page to satisfy an orphaned button would resurrect
          the design that was deliberately retired.

          A sweep added with this change (tests/recruitment-api-routes-exist.test.ts) checks every
          /api/recruitment call in this module against the route tree. It found 42 calls and exactly
          one orphan — this one — so the next re-platform cannot quietly leave another. */}
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
      status={<StagePill tone={requisitionStatusTone(requisition.status)}>{requisitionStatusLabel(requisition.status)}</StagePill>}
      title={requisition.jobTitle}
    >
      <PortalRecordFields
        fields={[
          {
            label: "Hiring manager",
            value: managerLabelOrNull(requisition.hiringManagerName, requisition.hiringManagerHrId) ?? "—",
          },
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
  positionCatalogue,
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
  positionCatalogue: PositionCatalogueOption[];
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

  // The Position dropdown offers the FULL active catalogue (all 21), not only the ~3 positions that
  // have a vacant seat. openVacancies is still what tells us, for the chosen position, whether real
  // seats exist behind it — and that drives the Line -> vacant Area cascade when they do.
  const matchingVacancies = posSel
    ? openVacancies.filter((v) => String(v.positionId ?? "") === posSel)
    : [];
  const hasMatchingSeats = matchingVacancies.length > 0;
  // Rule 3a — cascade: Position -> Line -> vacant Area (each Position+Line+Area = one seat).
  const linesById = new Map<string, string>();
  for (const v of matchingVacancies) {
    if (v.lineId != null) linesById.set(String(v.lineId), v.lineName ?? "Line");
  }
  const areaVacancies = matchingVacancies.filter((v) => String(v.lineId ?? "") === lineSel);
  const selectedVacancy = openVacancies.find((v) => String(v.id) === vacancyId) ?? null;
  const typedJobTitle = jobTitle.trim();
  // Three ways in now, and the catalogue is what widened it from two: wrap an open seat, pick any of
  // the 21 active positions, or type a free title. The last two both need a named hiring manager,
  // because a seatless requisition is only visible to the manager (and owner) named on it. A vacancy
  // still wins outright.
  const canSubmit = vacancyId ? true : Boolean((posSel || typedJobTitle) && hiringManagerHrId);

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
        <RecruitmentPanel
          description="Three ways in: pick any active position from the catalogue, wrap a seat that is already vacant on the organogram, or type a free job title. A position or a typed title also needs the manager who will hire for it."
          icon={<ClipboardList aria-hidden="true" className="h-4 w-4" />}
          title="Open a requisition"
        >
          <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3">
            <RequisitionField
              hint={
                hasMatchingSeats
                  ? "This position has vacant seats — pick a line and area to wrap one."
                  : "Every active position. Most have no vacant seat — that is fine."
              }
              label="Position"
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
                <option value="">Choose a position…</option>
                {positionCatalogue.map((position) => (
                  <option key={position.id} value={String(position.id)}>
                    {position.title}
                  </option>
                ))}
              </SearchableSelect>
            </RequisitionField>
            {/*
              Line and Vacant area appear only when the chosen position actually has open seats on
              the organogram. For every other position there is nothing to cascade through, so the
              two selects would be empty — the requisition is opened against the catalogue position
              and its hiring manager instead (below).
            */}
            {hasMatchingSeats ? (
              <>
                <RequisitionField label="Line">
                  <SearchableSelect
                    className={fieldClass}
                    value={lineSel}
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
                <RequisitionField hint="Wrapping a seat inherits its area and manager." label="Vacant area">
                  <SearchableSelect className={fieldClass} value={vacancyId} disabled={!lineSel} onChange={(e) => setVacancyId(e.target.value)}>
                    <option value="">Vacant area…</option>
                    {areaVacancies.map((vacancy) => (
                      <option key={vacancy.id} value={vacancy.id}>
                        {vacancy.areaName ?? "Area"} · {vacancy.vacancyCode}
                      </option>
                    ))}
                  </SearchableSelect>
                </RequisitionField>
              </>
            ) : null}
            {/*
              The Position dropdown above now offers every active position, so almost nothing needs a
              typed title any more — a role with no vacant seat is recruited against its catalogue
              position plus a hiring manager, and the service tags it with a real position_id. This
              free-text input remains only for a role that is not in the catalogue at all; it creates
              a requisition with no position_id, as it always did. A wrapped vacancy wins over both.

              It can sit in the grid cell directly under the Position combobox, so an open dropdown
              panel may cover it. That is why it keeps a standing label rather than a placeholder:
              once the panel closes, the label still says this is another way in, not a field of the
              cascade above it.
            */}
            <RequisitionField hint="Only for a role that is not in the catalogue above." label="Or type a job title">
              <Input
                placeholder="Any title — no vacant seat needed"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
              />
            </RequisitionField>
            {selectedVacancy ? (
              <RequisitionField hint="Comes with the seat." label="Hiring manager">
                <div className={`${fieldClass} bg-slate-50 text-slate-600`}>
                  {managerLabelOrNull(selectedVacancy.managerName, selectedVacancy.managerHrId) ?? "—"}
                </div>
              </RequisitionField>
            ) : (
              // Required with no vacancy, and not for tidiness: canSeeRequisition scopes on the
              // hiring manager and the recruitment owner, never on line or area — so a seatless
              // requisition with nobody named here is invisible to the very person meant to hire.
              <RequisitionField hint="Required — they are who sees this requisition." label="Hiring manager">
                <ManagerPicker
                  onChange={(hrIds) => setHiringManagerHrId(hrIds[0] ?? "")}
                  options={hiringManagers}
                  panelId="requisition-hiring-manager"
                  placeholder="Hiring manager…"
                  value={hiringManagerHrId ? [hiringManagerHrId] : []}
                />
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
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 pt-4 sm:col-span-2 lg:col-span-3">
              <Button
                disabled={pending || !canSubmit}
                onClick={() =>
                  run(async () => {
                    await postJson("/api/recruitment/requisitions", {
                      vacancyId: vacancyId ? Number(vacancyId) : undefined,
                      // Tags a seatless requisition with a real catalogue position. When a vacancy is
                      // wrapped the server takes the seat's own position_id, so this is harmless then.
                      positionId: posSel ? Number(posSel) : null,
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
        </RecruitmentPanel>
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
        <RecruitmentPanel
          count={openVacancies.length}
          description={`${openVacancies.length} open ${openVacancies.length === 1 ? "seat" : "seats"} on the organogram nobody is recruiting for. Opening one inherits its line, area and manager.`}
          icon={<Briefcase aria-hidden="true" className="h-4 w-4" />}
          title="Vacant seats with no requisition"
        >
          <ul className="divide-y divide-slate-100">
            {openVacancies.map((vacancy) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-slate-50 sm:px-5"
                key={vacancy.id}
              >
                <div className="min-w-0 grow basis-56">
                  <p className="break-words text-sm font-bold text-slate-900">
                    {vacancy.jobTitle ?? vacancy.positionTitle ?? "Untitled seat"}
                  </p>
                  <p className="mt-0.5 break-words text-xs text-slate-500">
                    {[vacancy.lineName, vacancy.areaName, managerLabelOrNull(vacancy.managerName, vacancy.managerHrId)]
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
        </RecruitmentPanel>
      ) : null}

      <RecruitmentPanel
        count={requisitions.length}
        description="All recruitment openings and their status."
        icon={<ClipboardList aria-hidden="true" className="h-4 w-4" />}
        title="Requisitions"
      >
        <PortalResponsiveDataList
          empty={
            <RecruitmentEmptyState
              icon={<ClipboardList aria-hidden="true" className="h-5 w-5" />}
              message="Requisitions will appear here once one is opened."
              title="No requisitions yet"
            />
          }
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
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[40%]" />
                  <col className="w-[16%]" />
                  <col className="w-[24%]" />
                  <col className="w-[20%]" />
                </colgroup>
              }
            >
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Hiring manager</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {requisitions.map((requisition) => (
                  <tr className="transition-colors hover:bg-slate-50" key={requisition.id}>
                    <td className="break-words px-3 py-2 font-semibold text-slate-950">{requisition.jobTitle}</td>
                    <td className="px-3 py-2">
                      <StagePill tone={requisitionStatusTone(requisition.status)}>{requisitionStatusLabel(requisition.status)}</StagePill>
                    </td>
                    <td className="px-3 py-2">
                      {managerLabelOrNull(requisition.hiringManagerName, requisition.hiringManagerHrId) ?? "—"}
                    </td>
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
      </RecruitmentPanel>
    </div>
  );
}

/**
 * The candidate's LinkedIn profile, opened in a new tab — or nothing, when the CV gave none.
 *
 * The stored column goes through linkedInProfileHref first, so the only address this can ever link
 * to is a https://www.linkedin.com/in/ profile: a portfolio or a `javascript:` value somebody saved
 * there renders no link at all rather than a LinkedIn button that goes somewhere else. The quiet tone
 * is the reply box's own idle button, so the two read as a pair.
 */
function LinkedInProfileLink({ linkedinUrl }: { linkedinUrl: string | null }) {
  const href = linkedInProfileHref(linkedinUrl);
  if (!href) return null;
  return (
    <ActionLink href={href} rel="noopener noreferrer" target="_blank" title="Open this applicant's LinkedIn profile in a new tab." tone="quiet">
      <ExternalLink aria-hidden className="h-3.5 w-3.5" />
      LinkedIn
    </ActionLink>
  );
}

/**
 * Shortlist and Reject — a decision on a CV that needs no requisition, no seat and no application.
 *
 * These two plus "Send to manager" (the picker below) are the whole of what the recruiter does
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

  // WHY THE DISABLED TEST IS NO LONGER `current === "shortlisted"`.
  //
  // It used to be, and that is precisely how fifty CVs lost their send. Shortlist sits beside Send
  // to manager in this row; after a send the status is `sent_to_manager`, so the old test left the
  // button live and labelled plainly "Shortlist". Pressing it wrote `shortlisted` with no note and
  // discarded the send — measured on production, fifty times, each about two seconds after the send
  // it undid.
  //
  // The rule is ASKED OF THE DOMAIN rather than restated here, so this button, the profile panel's
  // copy of it and the server all refuse on one sentence. The server refuses too: this is the
  // courtesy, not the boundary.
  const shortlistRefusal =
    statusChangeRefusal(current, "shortlisted") ?? (current === "shortlisted" ? "Already shortlisted" : null);
  const shortlistLabel = current === "sent_to_manager" ? "Already sent to a manager" : "Already shortlisted";

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
        <Button variant="secondary" disabled={pending || Boolean(shortlistRefusal)} title={shortlistRefusal ?? undefined} onClick={shortlist}>
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
        disabled={pending || Boolean(shortlistRefusal)}
        label={shortlistRefusal ? shortlistLabel : "Shortlist"}
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
  `inline-flex h-7 w-7 shrink-0 items-center justify-center border border-slate-200 bg-white text-slate-500 transition hover:border-phx-accent-line hover:text-phx-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-200 disabled:hover:text-slate-500 ${adminControlDepthClassName} disabled:shadow-none`;

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
      className={cn(poolIconButtonClass, toneClass, active && "border-phx-accent-line bg-orange-50 text-phx-accent")}
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
/**
 * "This CV is good, but not for now" — the picker that puts a candidate on the shelf.
 *
 * FOUR SHELVES AND FOUR DIFFERENT SECOND QUESTIONS, which is why this is a component and not two
 * dropdowns: a Medical Representative is filed by AREA, a District Manager by REGION, anything else
 * by JOB TITLE, and Paramedical by nothing at all — it holds one folder, so there is no second
 * question to ask. Picking the shelf changes what the second control even is, or whether there is
 * one.
 *
 * The areas come from the server (au.canonical_areas, already re-tagged for the Delta (3)
 * recruitment split — see candidate-folder-options.ts), the regions from the closed list in
 * candidate-region.ts, and the job title is typed with the titles already in use offered beside it.
 * That last one is the free-typed half the owner asked for on the position picker too, and it
 * carries the same risk: two folders that read almost identically. `cleanFolderKey` collapsing
 * whitespace and the case-folded group key are what keep "Medical  Rep" and "medical rep" together.
 */
function FileToFolderPicker({
  areaOptions,
  candidate,
  onFiled,
  pending,
  run,
  usedJobTitles,
}: {
  areaOptions: CandidateFolderAreaOption[];
  candidate: Candidate;
  onFiled: () => void;
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
  /** Job titles already used as folders, so a second "Regulatory Affairs" is a pick, not a retype. */
  usedJobTitles: string[];
}) {
  const [kind, setKind] = useState<CandidateFolderKind>("medical_rep");
  const [key, setKey] = useState("");

  const regionOptions = districtManagerFolderOptions();
  // Areas are listed under their RECRUITMENT region, so a recruiter filing a Sharkia CV finds it
  // under Delta (3) — where the district actually is — rather than under Delta (2), where the sales
  // geography still deliberately files it.
  const areasByRegion = new Map<string, string[]>();
  for (const area of areaOptions) {
    const list = areasByRegion.get(area.regionCode);
    if (list) list.push(area.name);
    else areasByRegion.set(area.regionCode, [area.name]);
  }

  const file = () =>
    run(async () => {
      await patchJson(`/api/recruitment/candidates/${candidate.id}/folder`, { key, kind });
      onFiled();
      setKey("");
      return `${candidateDisplayName(candidate.fullName)} filed under ${candidateFolderKindLabels[kind]}.`;
    });

  return (
    <div className="space-y-1.5 border border-sky-200 bg-sky-50/60 p-1.5">
      <select
        className={`${phxSelectClassName} min-w-0`}
        onChange={(e) => {
          const next = e.target.value as CandidateFolderKind;
          setKind(next);
          // The key means something different on every shelf, so carrying "Nasr City" across to the
          // region shelf would file the CV under a region that does not exist. Paramedical is the one
          // shelf with nothing to choose — it holds a single folder — so its key is set here rather
          // than asked for, which is also what keeps the File button reachable.
          setKey(next === "paramedical" ? PARAMEDICAL_FOLDER_KEY : "");
        }}
        value={kind}
      >
        {candidateFolderKinds.map((option) => (
          <option key={option} value={option}>
            {candidateFolderKindLabels[option]}
          </option>
        ))}
      </select>

      {kind === "paramedical" ? (
        // NO second control, deliberately. The other three shelves ask "which one"; this one has a
        // single folder, so the honest answer to "which folder" is that there is nothing to pick.
        // Rendering the area select here — which is what the else-branch would do — would have
        // offered a recruiter a list of AREAS under the heading of a degree question.
        <p className="text-phx-xs text-slate-600">
          One folder, for graduates outside pharmacy, science, veterinary, medicine and dentistry.
        </p>
      ) : kind === "other" ? (
        <>
          <Input
            list={`folder-titles-${candidate.id}`}
            onChange={(e) => setKey(e.target.value)}
            placeholder={candidateFolderKeyLabels.other}
            value={key}
          />
          <datalist id={`folder-titles-${candidate.id}`}>
            {usedJobTitles.map((title) => (
              <option key={title} value={title} />
            ))}
          </datalist>
        </>
      ) : (
        <select
          className={`${phxSelectClassName} min-w-0`}
          onChange={(e) => setKey(e.target.value)}
          value={key}
        >
          <option value="">{`Choose a ${candidateFolderKeyLabels[kind].toLowerCase()}…`}</option>
          {kind === "district_manager"
            ? regionOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))
            : regionOptions.map((region) => {
                const areas = areasByRegion.get(region.key) ?? [];
                if (areas.length === 0) return null;
                return (
                  <optgroup key={region.key} label={region.label}>
                    {areas.map((area) => (
                      <option key={area} value={area}>
                        {area}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
        </select>
      )}

      <Button className="w-full" disabled={pending || key.trim().length === 0} onClick={file}>
        File to folder
      </Button>
    </div>
  );
}

function CandidateActionsControl({
  areaOptions,
  candidate,
  canDelete,
  canManage,
  folderJobTitles,
  hiringManagers,
  openPanel,
  openProfile,
  openRequisitions,
  openVacancies,
  pending,
  run,
  sendFreeArea,
  sendFreeTitle,
  sendPosition,
  sendTo,
  setOpenPanel,
  setSendFreeArea,
  setSendFreeTitle,
  setSendPosition,
  setSendTo,
  setStartReq,
  startReq,
}: {
  areaOptions: CandidateFolderAreaOption[];
  candidate: Candidate;
  canDelete: boolean;
  canManage: boolean;
  folderJobTitles: string[];
  hiringManagers: HiringManagerOption[];
  /** Which picker, if any, this candidate has open — lifted so only one row expands at a time. */
  openPanel: PoolRowPanel | null;
  openProfile: (id: string) => void;
  openRequisitions: Requisition[];
  openVacancies: VacancyReportRow[];
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
  sendFreeArea: Record<string, string>;
  sendFreeTitle: Record<string, string>;
  sendPosition: Record<string, string>;
  sendTo: Record<string, string>;
  setOpenPanel: (panel: PoolRowPanel | null) => void;
  setSendFreeArea: Dispatch<SetStateAction<Record<string, string>>>;
  setSendFreeTitle: Dispatch<SetStateAction<Record<string, string>>>;
  setSendPosition: Dispatch<SetStateAction<Record<string, string>>>;
  setSendTo: Dispatch<SetStateAction<Record<string, string>>>;
  setStartReq: Dispatch<SetStateAction<Record<string, string>>>;
  startReq: Record<string, string>;
}) {
  const notified = candidate.managerNotified;
  const current = normalizeCandidateStatus(candidate.status);
  const positionChoice = sendPosition[candidate.id] ?? "";
  const folderRefusal = candidateFolderRefusal(candidate);
  // The folder on the chosen manager's shelf (owner, 2026-10-16). "" lets the system file the CV.
  const [sendFolder, setSendFolder] = useState("");
  const shelfFolders = foldersToOffer(hiringManagers, sendTo[candidate.id] ? [sendTo[candidate.id] as string] : []);
  const chosenFolder = shelfFolders.includes(sendFolder) ? sendFolder : "";

  const sendToManager = () =>
    run(async () => {
      const data = await postJson(`/api/recruitment/candidates/${candidate.id}/notify-manager`, {
        managerHrId: sendTo[candidate.id],
        ...(chosenFolder ? { folderArea: chosenFolder } : {}),
        ...positionBody(positionChoice, sendFreeArea[candidate.id] ?? "", sendFreeTitle[candidate.id] ?? ""),
      });
      const result = (data.result ?? {}) as { folder?: unknown; managerName?: unknown };
      const name = typeof result.managerName === "string" ? result.managerName : "the manager";
      const folder = typeof result.folder === "string" && result.folder ? result.folder : null;
      setOpenPanel(null);
      setSendFolder("");
      setSendPosition((prev) => ({ ...prev, [candidate.id]: "" }));
      setSendFreeArea((prev) => ({ ...prev, [candidate.id]: "" }));
      setSendFreeTitle((prev) => ({ ...prev, [candidate.id]: "" }));
      return `${candidateDisplayName(candidate.fullName)} sent to ${name}${folder ? `, in the ${folder} folder` : ""}.`;
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

  // Taking a CV back out of a manager's folder (owner, 2026-10-16: "can anytime get it back"). The CV
  // is removed from that manager's folder at once; if nobody else holds it, it returns to the
  // shortlist. Nothing about it is restricted by whether the manager has opened it.
  const takeBackFromManager = () => {
    if (!notified) return;
    run(async () => {
      await postJson(`/api/recruitment/candidates/${candidate.id}/recall-from-manager`, {
        managerHrId: notified.hrId,
      });
      return `${candidateDisplayName(candidate.fullName)} taken back from ${notified.name}.`;
    });
  };

  return (
    <div className="space-y-1.5">
      {/* flex-wrap: a manager's row holds seven 28px buttons (about 232px) in an 11% column that is
          153px at 1,440px, so on one line they ran past the table and scrolled the pool sideways.
          Measured on production 2026-10-19: 1,482px inside 1,405px before, flush after. */}
      <div className="flex flex-wrap items-center gap-1">
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
            {notified?.hrId ? (
              <PoolIconButton
                disabled={pending}
                label={`Take it back from ${notified.name}`}
                onClick={takeBackFromManager}
              >
                <Undo2 className="h-3.5 w-3.5" />
              </PoolIconButton>
            ) : null}
            <PoolIconButton
              active={openPanel === "start"}
              disabled={pending}
              label="Start an application"
              onClick={() => setOpenPanel(openPanel === "start" ? null : "start")}
            >
              <Briefcase className="h-3.5 w-3.5" />
            </PoolIconButton>
            {/* Disabled rather than hidden when the CV cannot be filed. A control that vanishes
                teaches nothing; one that is greyed out with the reason on it answers "why can I not
                file this rejected CV?" without anybody having to ask. The sentence comes from
                candidateFolderRefusal, the same one the route's 400 uses. */}
            <PoolIconButton
              active={openPanel === "folder"}
              disabled={pending || folderRefusal !== null}
              label={folderRefusal ?? "File to folder — keep this CV for later"}
              onClick={() => setOpenPanel(openPanel === "folder" ? null : "folder")}
            >
              <FolderPlus className="h-3.5 w-3.5" />
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

      {canManage && openPanel === "folder" ? (
        <FileToFolderPicker
          areaOptions={areaOptions}
          candidate={candidate}
          onFiled={() => setOpenPanel(null)}
          pending={pending}
          run={run}
          usedJobTitles={folderJobTitles}
        />
      ) : null}

      {/* Only the row being acted on mounts a picker, so 555 rows do not carry 1,110 dropdowns. */}
      {canManage && openPanel === "send" ? (
        <div className="space-y-1.5 border border-orange-200 bg-orange-50/60 p-1.5">
          <PositionPicker
            disabled={pending}
            freeArea={sendFreeArea[candidate.id] ?? ""}
            freeTitle={sendFreeTitle[candidate.id] ?? ""}
            onFreeAreaChange={(value) => setSendFreeArea((prev) => ({ ...prev, [candidate.id]: value }))}
            onFreeTitleChange={(value) => setSendFreeTitle((prev) => ({ ...prev, [candidate.id]: value }))}
            onVacancyChange={(value) => setSendPosition((prev) => ({ ...prev, [candidate.id]: value }))}
            openVacancies={openVacancies}
            panelId={`pool-position-${candidate.id}`}
            vacancyChoice={positionChoice}
          />
          <FolderChoice disabled={pending} folders={shelfFolders} onChange={setSendFolder} value={chosenFolder} />
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <ManagerPicker
                disabled={pending}
                onChange={(hrIds) => setSendTo((prev) => ({ ...prev, [candidate.id]: hrIds[0] ?? "" }))}
                options={hiringManagers}
                panelId={`pool-manager-${candidate.id}`}
                value={sendTo[candidate.id] ? [sendTo[candidate.id] as string] : []}
              />
            </div>
            <Button className="h-8 shrink-0" disabled={pending || !sendTo[candidate.id]} onClick={sendToManager}>
              {notified ? "Send again" : "Send"}
            </Button>
          </div>
        </div>
      ) : null}

      {canManage && openPanel === "start" ? (
        <div className={`flex items-center gap-1.5 border border-slate-200 bg-slate-50 p-1.5 ${adminRecessedDepthClassName}`}>
          <SearchableSelect
            className="h-8 w-full min-w-0 px-2 text-xs"
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
        <div className="space-y-0.5">
          <p className="break-words text-phx-xs text-slate-500" title={`Sent to ${notified.name} on ${cairoDateTime(notified.sentAt)}`}>
            Sent to {notified.name} on {cairoDateTime(notified.sentAt)}
          </p>
          {/* The seat, on its own line rather than appended to the one above — the cell is 220px
              and one long sentence would hide the end of it, while two short lines each fit. This
              is the SENT-TIME seat, not a live lookup: a manager who moves area next month did not
              retroactively move the CVs that were sent to their old one. */}
          {managerSeatLabel(notified) ? (
            <p className="break-words text-phx-xs font-medium text-slate-400" title={managerSeatLabel(notified)}>
              {managerSeatLabel(notified)}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where one manager's pile starts, in the pool grouped by who each CV was sent to.
 *
 * Deliberately one component for both surfaces — the desktop table renders it inside a full-width
 * <td> and the mobile stack renders it above a card — so the heading a recruiter reads on a phone
 * cannot come to say something different from the one on the laptop.
 *
 * The seat here is the one FROZEN at send time, never a live lookup of where the manager sits
 * today. That is the whole reason the three columns were added: a District Sales Manager who moves
 * from Giza to Alexandria next month must not silently drag last month's CVs across the country.
 */
function ManagerGroupHeading({
  count,
  lastSentAt,
  name,
  regionName,
  seatLabel,
}: {
  count: number;
  lastSentAt: string | null;
  name: string;
  regionName: string | null;
  seatLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-sm font-black text-phx-ink">{name}</span>
      {seatLabel ? <span className="text-xs font-semibold text-slate-600">{seatLabel}</span> : null}
      {regionName ? <span className="text-xs font-medium text-slate-400">{regionName}</span> : null}
      <span className="ml-auto text-xs font-bold tabular-nums text-phx-accent-press">
        {count} {count === 1 ? "CV" : "CVs"}
      </span>
      {lastSentAt ? (
        <span className="text-phx-xs font-medium text-slate-400">last sent {cairoDateTime(lastSentAt)}</span>
      ) : null}
    </div>
  );
}

/**
 * Anchor for the jump chips above the pool. Encoded because the key is an HR_ID, not a slug.
 *
 * Two ids per group, not one, because BOTH surfaces are mounted at every width — the mobile stack
 * is `md:hidden` and the desktop table `hidden md:block`, so a single id would appear twice in the
 * document and every jump would land on whichever copy is currently display:none.
 */
function managerGroupAnchorId(key: string, surface: "table" | "card"): string {
  return `manager-group-${surface}-${encodeURIComponent(key)}`;
}

/**
 * Scroll to a manager's pile, whichever surface is actually on screen.
 *
 * getClientRects() is empty for anything inside a display:none subtree, which is exactly the test
 * needed here and is cheaper and more honest than re-deriving the breakpoint in JavaScript.
 *
 * `behavior: "auto"`, and NOT because instant is prettier. Measured on this exact page on
 * 2026-08-21: Chrome abandons a programmatic SMOOTH scroll over a long distance, leaving the page
 * where it was — so the jump reads as a dead button. This is the same 434-row page that defect was
 * found on, and a manager's pile is exactly the thing that sits fifteen screens down, so the smooth
 * version would fail here more often than anywhere else. `tests/recruitment-candidate-pool-table`
 * pins the whole file against the word, which is how this one was caught.
 */
function scrollToManagerGroup(key: string): void {
  if (typeof document === "undefined") return;
  for (const surface of ["table", "card"] as const) {
    const element = document.getElementById(managerGroupAnchorId(key, surface));
    if (element && element.getClientRects().length > 0) {
      element.scrollIntoView({ behavior: "auto", block: "start" });
      return;
    }
  }
}

/**
 * The key for the tail of the grouped pool — everyone on screen nobody has sent to a manager yet.
 *
 * They are NOT dropped. 370 of the 434 rows in production have never been sent, and a grouped view
 * that silently hides five sixths of the pool is how a recruiter concludes a CV was deleted.
 */
const UNSENT_GROUP_KEY = "not-sent";

/**
 * Which position a CV being sent to a manager is FOR.
 *
 * The owner, 2026-08-28, on the screening send flow this mirrors: "before sending the CV to the
 * manager, I should be able to choose his area and his job title, so the same title, same area
 * are consolidated." That request reaches every send-to-manager surface, not only screening's —
 * this pool's per-row and bulk sends had no position picker at all until this one.
 *
 * Optional, deliberately: a send with no position is still a legitimate send, so nothing here
 * blocks it. Backed by the same open vacancies the requisitions panel already reads — a genuinely
 * new seat that never got a vacancy row is the one case this picker cannot offer, and free typing
 * covers it.
 */
function PositionPicker({
  disabled = false,
  freeArea,
  freeTitle,
  onFreeAreaChange,
  onFreeTitleChange,
  onVacancyChange,
  openVacancies,
  panelId,
  vacancyChoice,
}: {
  disabled?: boolean;
  freeArea: string;
  freeTitle: string;
  onFreeAreaChange: (value: string) => void;
  onFreeTitleChange: (value: string) => void;
  onVacancyChange: (value: string) => void;
  openVacancies: VacancyReportRow[];
  /** Unique on screen: a row's send panel and the bulk bar can both be open at once. */
  panelId: string;
  vacancyChoice: string;
}) {
  // Area, then line, then title — the order `listOpenVacancyOptions` uses on the screening page, so
  // both screens read the same way inside a group. The picker itself does the title grouping.
  const sorted = [...openVacancies].sort(
    (left, right) =>
      Number(!left.areaName) - Number(!right.areaName) ||
      (left.areaName ?? "").localeCompare(right.areaName ?? "") ||
      (left.lineName ?? "").localeCompare(right.lineName ?? "") ||
      (left.jobTitle ?? "").localeCompare(right.jobTitle ?? ""),
  );
  return (
    <div className="space-y-1.5">
      <VacancyPicker
        disabled={disabled}
        onChange={onVacancyChange}
        panelId={panelId}
        vacancies={sorted.map((vacancy) => ({
          areaName: vacancy.areaName,
          id: vacancy.id,
          jobTitle: vacancy.jobTitle ?? "",
          lineName: vacancy.lineName,
          managerName: vacancy.managerName,
          regionName: vacancy.regionName,
        }))}
        value={vacancyChoice}
      />
      {vacancyChoice === FREE_POSITION ? (
        <div className="grid grid-cols-2 gap-1.5">
          <input
            aria-label="Area"
            className={`${phxFieldClassName} min-w-0`}
            onChange={(event) => onFreeAreaChange(event.target.value)}
            placeholder="Area"
            value={freeArea}
          />
          <input
            aria-label="Job title"
            className={`${phxFieldClassName} min-w-0`}
            onChange={(event) => onFreeTitleChange(event.target.value)}
            placeholder="Job title"
            value={freeTitle}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The position fields a send-to-manager POST body carries, from what {@link PositionPicker} holds. */
function positionBody(
  vacancyChoice: string,
  freeArea: string,
  freeTitle: string,
): Record<string, unknown> {
  if (vacancyChoice === FREE_POSITION) {
    return { positionAreaName: freeArea, positionJobTitle: freeTitle };
  }
  if (vacancyChoice) {
    return { vacancyId: Number(vacancyChoice) };
  }
  return {};
}

/** The tooltip on a grey-italic answer: the bot never asked this, so the CV is standing in. */
const POOL_CV_STAND_IN_TITLE = "Not answered on WhatsApp — read off the CV instead.";

/** The Which region? · Which area? header's explanation of its two lines. */
const POOL_PLACE_HEADER_TITLE =
  "Where they want to work. A second line naming an AREA is the applicant's own answer from WhatsApp; a second line naming a governorate is the address read off their CV.";

type PoolSharedCell = {
  className: string;
  content: ReactNode;
  /**
   * The cell shows a CV answer and no WhatsApp one — the cells a card marks "(from CV)". The folded
   * card counts these, so its button never says "Add answers" over answers it is hiding.
   */
  fromCvOnly: boolean;
};

/**
 * The five built-in columns' cells, for the desktop row AND the phone card (owner, 2026-10-19 — "Phone
 * card shows the CV"). The card used to print its own bare answer, so where the bot never asked a
 * question it showed "—" while the row beside it showed the CV standing in — George Samir Lotfy read
 * "Faculty of Biotechnology" on a desk and nothing on a phone. One function, so the two cannot drift.
 *
 * `touch` spells out what a desk reader gets from a tooltip: a phone has no hover.
 */
function poolSharedCells(
  candidate: Candidate,
  { touch = false }: { touch?: boolean } = {},
): Record<PoolSharedColumnKey, PoolSharedCell> {
  const appliedFor = candidateRowAppliedFor(candidate);
  // Resolved ONCE and handed to every cell, so the row can never show a region that disagrees with
  // its own role cell — and so the filter above, which calls the same function, is answering about
  // the same person the reader sees.
  const facts = candidateScreeningFacts(candidate);
  const roleFamily = candidateScreeningRoleFamily(facts, appliedFor.text);
  // The family line is worth a row of height only when it adds something the line above does not
  // already say. `normalizeJobTitle` rather than a string compare so "MEDICAL REPRESENTATIVE" and
  // "Medical Representative" count as the same words.
  const roleTitleAlreadySaysFamily =
    roleFamily !== null &&
    normalizeJobTitle(facts.roleTitle?.value ?? appliedFor.text) === normalizeJobTitle(candidateRoleFamilyLabels[roleFamily]);
  // "Flag CV vs WhatsApp gaps" (owner, 2026-10-19): the band they tapped against the years the CV
  // counts, by experience-answer-gap.ts's one rule.
  const experienceGap = experienceAnswerGap(facts.declaredExperience?.value, facts.years?.value);
  // Where the CV stands in for a WhatsApp answer. The cells' "(from CV)" markers and the folded
  // card's count both read these, so the button and what it opens cannot disagree.
  const backgroundFromCv = !facts.background && Boolean(candidate.faculty || candidate.degree);
  const regionFromCv = Boolean(facts.region && !facts.region.value.declared);
  const experienceFromCvOnly = !facts.declaredExperience && Boolean(facts.years);
  return {
    appliedFor: {
      className: "px-3 py-2.5",
      content: (
        <>
          {/* Second column on purpose: after the name, "what does this person do" is
              the fact that decides who a CV goes to.

              The header is the bot's first question, "What are you applying for?", so
              since 2026-10-19 the top line is their ANSWER — the applied-for ladder, whose
              "stated" rung is what they tapped on WhatsApp — and the job they hold now
              drops to a small "Now:" line under it. Until then the CV's current title led
              and the answer sat beneath it. The bottom line is the FAMILY, a fixed vocabulary of eight,
              and it is what makes 426 free-text titles scannable at all: "district
              Manger", "District Sales Manager" and "SENIOR DISTRICT MANAGER |
              PHARMACEUTICAL SALES & LEADERSHIP" are three spellings of one job, and all
              three read District Manager here. It is also exactly what the Role filter
              matches on, so what the reader sees is what the dropdown will find.

              Grey italic still means "we were told this rather than shown it", the same
              convention this cell has used since 2026-08-21 — now extended to the CV
              reader's own hedged answers, which the tooltip names in plain words. */}
          {appliedFor.text ? (
            <span
              className={`block break-words ${appliedFor.source === "stated" ? "text-slate-900" : "italic text-slate-500"}`}
              title={
                appliedFor.source === "stated"
                  ? [candidate.appliedForJobTitle, candidate.appliedForEvidence].filter(Boolean).join("\n")
                  : `${APPLIED_FOR_SOURCE_LABEL[appliedFor.source ?? "subject"]}:\n"${appliedFor.evidence ?? appliedFor.text}"`
              }
            >
              {appliedFor.text}
            </span>
          ) : facts.roleTitle ? (
            <span
              className={`block break-words ${facts.roleTitle.confirmed ? "text-slate-900" : "italic text-slate-500"}`}
              title={
                facts.roleTitle.confirmed
                  ? `Their current job title, as recorded.\n${facts.roleTitle.value}`
                  : `${UNCONFIRMED_FACT_TITLE}\n\nRead off the CV as their current job title:\n"${facts.roleTitle.value}"`
              }
            >
              {facts.roleTitle.value}
            </span>
          ) : null}
          {/* The job they hold now, when it is not the job they asked for — the header
              asks what they are applying for, so their current title is the second fact. */}
          {appliedFor.text &&
          facts.roleTitle &&
          normalizeJobTitle(appliedFor.text) !== normalizeJobTitle(facts.roleTitle.value) ? (
            <div
              className="mt-0.5 break-words text-phx-xs text-slate-500"
              title={facts.roleTitle.confirmed ? "Their current job title, as recorded." : UNCONFIRMED_FACT_TITLE}
            >
              Now: {facts.roleTitle.value}
            </div>
          ) : null}
          {/* The family, under the words it was worked out from — and only when the
              two differ. Repeating "Medical Representative" under a title that already
              reads "Medical Representative" is another line that says nothing, which
              is the exact fault this rebuild exists to fix. */}
          {roleFamily && !roleTitleAlreadySaysFamily ? (
            <div className="mt-0.5 break-words text-phx-xs font-semibold uppercase tracking-[0.06em] text-slate-400">
              {candidateRoleFamilyLabels[roleFamily]}
            </div>
          ) : null}
          {/* "Not stated" gives way to the badge — it is the weaker of the two facts,
              and stacking both would say the same nothing twice. */}
          {!appliedFor.text && !facts.roleTitle && !isNotACv(candidate) ? (
            <span className="text-slate-300">Not stated</span>
          ) : null}
          {/* The badge lives in THIS cell rather than beside the name, deliberately
              twice over. It is a fact about the attachment, not about the person, and
              a warning pinned to someone's name reads as a judgement on them. And
              this is the cell whose emptiness raises the question: a certificate
              yields no job title, so the reader is already staring at this blank
              space asking why. It is also the widest column, where the 332px
              Candidate cell would have squeezed the name — which since 2026-09-03
              wraps rather than truncating, so it needs that width more, not less. */}
          {isNotACv(candidate) ? (
            <div className={appliedFor.text || facts.roleTitle ? "mt-0.5" : undefined}>
              <StagePill tone="amber">
                <span title={NOT_A_CV_TITLE}>{NOT_A_CV_LABEL}</span>
              </StagePill>
            </div>
          ) : null}
        </>
      ),
      fromCvOnly: false,
    },
    background: {
      className: "px-2 py-2.5",
      content: (
        <>
          {/* "What did you graduate in?" — their own answer from WhatsApp; where the bot
              never asked, the faculty read off the CV in grey italic. */}
          {facts.background ? (
            <span className="block break-words font-semibold text-slate-800" dir="auto" title="Their own answer on WhatsApp.">
              {facts.background.value}
            </span>
          ) : backgroundFromCv ? (
            <span className="block break-words italic text-slate-500" dir="auto" title={POOL_CV_STAND_IN_TITLE}>
              {candidate.faculty || candidate.degree}
              {touch ? <span className="not-italic text-slate-400"> (from CV)</span> : null}
            </span>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </>
      ),
      fromCvOnly: backgroundFromCv,
    },
    place: {
      className: "px-2 py-2.5",
      content: (
        <>
          {/* Where they are, which the pool could filter on but never showed — so a
              screener narrowing to Alex-BHR had to take the filter's word for it and
              could not tell, looking at the rows it returned, why any of them were
              there. The region is the company's own map of Egypt, never geography's
              (Beni Suef and Fayoum are Giza here, by the owner's call), so the
              governorate it was derived from sits underneath: the reader needs to see
              the working, not just the verdict. */}
          {facts.region ? (
            <span
              className={`block break-words font-semibold ${facts.region.confirmed ? "text-slate-800" : "italic font-normal text-slate-500"}`}
              title={
                facts.region.value.declared
                  ? `The applicant chose this themselves when they applied on WhatsApp.${
                      facts.governorate ? ` Their CV gives the address as "${facts.governorate.value}".` : ""
                    }`
                  : facts.region.confirmed
                    ? `Company region for ${facts.governorate?.value ?? ""}.`
                    : `${UNCONFIRMED_FACT_TITLE}\n\nRead off the CV as: "${facts.governorate?.value ?? ""}"`
              }
            >
              {facts.region.value.label}
              {touch && regionFromCv ? (
                <span className="font-normal not-italic text-slate-400"> (from CV)</span>
              ) : null}
            </span>
          ) : null}
          {/* The area they asked for outranks the governorate on their CV, and only one
              of the two fits: it answers the same question more precisely, and it is
              the only line on this row the applicant wrote himself. The governorate is
              not lost — it moves into the tooltip.

              ONE element, not a branch into two. That began as a no-ellipsis ratchet
              argument — two sibling elements each carrying the class would have counted
              as two sites — and since 2026-09-03 this line wraps instead of truncating,
              so the ratchet no longer decides it. The choice stands on its own: the two
              are alternative answers to one question, not facts to stack, and a second
              line would add height to every row to repeat what the tooltip says. */}
          {facts.area || facts.governorate ? (
            <div
              className={`mt-0.5 break-words text-phx-xs ${facts.area ? "text-slate-600" : "text-slate-500"}`}
              title={
                facts.area
                  ? `Asked to work in ${facts.area.value}.${
                      facts.governorate ? ` CV address: ${facts.governorate.value}.` : ""
                    }`
                  : facts.governorate!.value
              }
            >
              {facts.area ? facts.area.value : facts.governorate!.value}
            </div>
          ) : facts.region ? null : (
            <span className="text-slate-300">Not on file</span>
          )}
        </>
      ),
      fromCvOnly: regionFromCv,
    },
    experience: {
      className: "px-2 py-2.5",
      content: (
        <>
          {/* How long they have worked, and whether any of it was as a medical rep —
              the two questions that decide whether a pharma CV is worth opening, and
              neither had a column.

              The years are the CV reader's arithmetic over the work history far more
              often than a figure printed on the CV, which is why 117 of them are hedged
              and why a hedged one shows in grey italic with a "~". Showing it is still
              right: "~7 yrs, check it" is a decision a screener can act on and a blank
              cell is not. */}
          {/* Their WhatsApp answer leads — a band they chose about themselves. The CV's
              counted years follow, smaller, because the two answer differently. */}
          {facts.declaredExperience ? (
            <span className="block break-words font-semibold text-slate-800" title="Their own answer on WhatsApp.">
              {facts.declaredExperience.value}
            </span>
          ) : null}
          {facts.years ? (
            <span
              className={`whitespace-nowrap ${
                facts.declaredExperience
                  ? "mt-0.5 block text-phx-xs italic text-slate-500"
                  : facts.years.confirmed
                    ? "font-semibold text-slate-800"
                    : "italic text-slate-500"
              }`}
              title={
                facts.years.confirmed
                  ? "Total years of experience, as recorded."
                  : `${UNCONFIRMED_FACT_TITLE}\n\nWorked out from the work history on the CV.`
              }
            >
              {facts.years.confirmed ? "" : "~"}
              {formatYearsOfExperience(facts.years.value)}
              {/* Standing in for a missing answer it says "(from CV)", like the cells beside it and
                  the folded card's "Show 3 from CV" (George Samir Lotfy's read "<1 mo (CV)" under
                  that button, 2026-10-19). Under their own answer it stays "(CV)": the CV's figure
                  set against what they said, not a stand-in. */}
              {touch ? (
                <span className="not-italic text-slate-400">{experienceFromCvOnly ? " (from CV)" : " (CV)"}</span>
              ) : null}
            </span>
          ) : facts.declaredExperience ? null : (
            <span className="text-slate-300">—</span>
          )}
          {/* The answer and the CV cannot both be right. Amber, like "Not a CV": nothing is
              wrong with the person, there is a question to ask before sending them on. The phone
              card says it above its folded answers instead, so it is not said twice there. */}
          {experienceGap && !touch ? (
            <div className="mt-0.5">
              <StagePill tone="amber">
                <span title={experienceGap.explanation}>{EXPERIENCE_GAP_LABEL}</span>
              </StagePill>
            </div>
          ) : null}
          {/* `false` is an ANSWER here, not an absence: "never worked as a medical
              rep" is exactly what a screener of a pharma pool wants to know, and
              leaving it blank would hide the finding. Only a missing answer is blank. */}
          {facts.pharmaRep ? (
            <div className="mt-0.5">
              <StagePill tone={facts.pharmaRep.value ? "emerald" : "slate"}>
                <span title={facts.pharmaRep.confirmed ? undefined : UNCONFIRMED_FACT_TITLE}>
                  {facts.pharmaRep.value ? "Pharma rep" : "No pharma"}
                  {facts.pharmaRep.confirmed ? "" : " ?"}
                </span>
              </StagePill>
            </div>
          ) : null}
        </>
      ),
      fromCvOnly: experienceFromCvOnly,
    },
    salary: {
      className: "px-2 py-2.5",
      content: (
        <>
          {/* "Expected salary" — verbatim, never a parsed figure: "25 k to 30 k" and
              "negotiable" are the answer. Grey italic is a figure typed into the ATS. */}
          {facts.expectedSalary ? (
            <span
              className={`block break-words ${candidate.declaredExpectedSalary ? "font-semibold text-slate-800" : "italic text-slate-500"}`}
              dir="auto"
              title={candidate.declaredExpectedSalary ? "Their own answer on WhatsApp." : "Typed into the candidate record — not a WhatsApp answer."}
            >
              {facts.expectedSalary.value}
              {touch && !candidate.declaredExpectedSalary ? (
                <span className="not-italic text-slate-400"> (typed in)</span>
              ) : null}
            </span>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </>
      ),
      // "(typed in)" is the ATS record, not the CV.
      fromCvOnly: false,
    },
  };
}

/**
 * What each field of a column's editor opens with: the answer on the record now, "" for a missing one.
 * Read from the record's own columns, so the editor shows exactly what a save will replace — the
 * applied-for title even where the bot never asked it, and never the CV standing in for an answer.
 */
function poolCurrentAnswerValues(
  candidate: Candidate,
  column: PoolTableColumn,
  answers: ReadonlyMap<string, string>,
): Record<string, string> {
  const valueOf = (editKey: string): string => {
    switch (editKey) {
      case "job_title":
        return candidate.appliedForJobTitle ?? "";
      case "background":
        return candidate.declaredBackground ?? "";
      case "region":
        return answers.get("region") ?? "";
      case "area":
        return candidate.preferredAreaName ?? "";
      case "experience":
        return candidate.declaredExperience ?? "";
      case "salary":
        return candidate.declaredExpectedSalary ?? "";
      default:
        return answers.get(editKey) ?? "";
    }
  };
  return Object.fromEntries(column.editKeys.map((editKey) => [editKey, valueOf(editKey)]));
}

/**
 * Saves one column's edit — one call per answer that changed, so the place column can make two. The
 * desktop cell and the phone card both save through here, so they cannot drift apart.
 */
async function savePoolColumnAnswers(
  candidateId: string,
  column: PoolTableColumn,
  values: Readonly<Record<string, string>>,
  currentValues: Readonly<Record<string, string>>,
): Promise<void> {
  for (const editKey of column.editKeys) {
    const next = (values[editKey] ?? "").trim();
    if (next === (currentValues[editKey] ?? "").trim()) continue;
    await patchJson(`/api/recruitment/candidates/${candidateId}/whatsapp-answer`, { key: editKey, value: next });
  }
}

/** An admin question's answer under its column. Only the applicant can answer these, so no CV stands in. */
function PoolAnswerText({ answer }: { answer: string | null }) {
  return answer ? (
    <span className="block whitespace-pre-wrap break-words font-semibold text-slate-800" dir="auto">
      {answer}
    </span>
  ) : (
    <span className="text-slate-300">—</span>
  );
}

function CandidatePoolCard({
  answerColumns,
  areaOptions,
  candidate,
  candidateHref,
  canDelete,
  canEditAnswers,
  canManage,
  folderJobTitles,
  hiringManagers,
  isNew,
  openProfile,
  openRequisitions,
  openVacancies,
  pending,
  roleQuestionKeys,
  run,
  sendFreeArea,
  sendFreeTitle,
  sendPosition,
  sendTo,
  setSendFreeArea,
  setSendFreeTitle,
  setSendPosition,
  setSendTo,
  setStartReq,
  startReq,
  whatsappQuestions,
}: {
  /** The table's own columns, in the reader's order — the questions the card lists with a pencil each. */
  answerColumns: readonly PoolTableColumn[];
  areaOptions: CandidateFolderAreaOption[];
  candidate: Candidate;
  /** The candidate's own page, in the shell the pool is in. */
  candidateHref: string;
  canDelete: boolean;
  /** The table's grant, candidates:update — the same reader edits on a phone as at a desk. */
  canEditAnswers: boolean;
  canManage: boolean;
  folderJobTitles: string[];
  hiringManagers: HiringManagerOption[];
  isNew: boolean;
  openProfile: (id: string) => void;
  openRequisitions: Requisition[];
  openVacancies: VacancyReportRow[];
  pending: boolean;
  /** The answer keys of the questions the Role filter's role is asked; empty with no role picked. */
  roleQuestionKeys: ReadonlySet<string>;
  run: (work: () => Promise<string | void>) => void;
  sendFreeArea: Record<string, string>;
  sendFreeTitle: Record<string, string>;
  sendPosition: Record<string, string>;
  sendTo: Record<string, string>;
  setSendFreeArea: Dispatch<SetStateAction<Record<string, string>>>;
  setSendFreeTitle: Dispatch<SetStateAction<Record<string, string>>>;
  setSendPosition: Dispatch<SetStateAction<Record<string, string>>>;
  setSendTo: Dispatch<SetStateAction<Record<string, string>>>;
  setStartReq: Dispatch<SetStateAction<Record<string, string>>>;
  startReq: Record<string, string>;
  /** The bot's questions, so the card lists every WhatsApp answer under the question it answers. */
  whatsappQuestions: PoolWhatsAppQuestions | null;
}) {
  // One card is one candidate, so the open picker is local here — unlike the table, where the state
  // is lifted so two rows cannot expand at once.
  const [openPanel, setOpenPanel] = useState<PoolRowPanel | null>(null);

  // The same facts the desktop row reads, resolved by the same module. A phone screener is doing
  // the identical job with less screen, so the card must not answer fewer questions than the table
  // — it was showing an email address and a timestamp where the row now shows a job, a region and
  // a length of career.
  const appliedFor = candidateRowAppliedFor(candidate);
  const facts = candidateScreeningFacts(candidate);
  const roleFamily = candidateScreeningRoleFamily(facts, appliedFor.text);
  const roleTitleAlreadySaysFamily =
    roleFamily !== null &&
    normalizeJobTitle(facts.roleTitle?.value ?? appliedFor.text) ===
      normalizeJobTitle(candidateRoleFamilyLabels[roleFamily]);

  // A card has no hover, so "we are not sure of this" has to survive in the text itself: grey
  // italic and a trailing "?", the same two marks the row uses, minus the tooltip that explains
  // them. The label carries the explanation instead — "(from CV)" rather than a sentence.
  const shown = (value: string, confirmed: boolean) =>
    confirmed ? value : <span className="font-medium italic text-slate-500">{value} ?</span>;
  // The phone's half of "the headers are the WhatsApp questions": a card has no header row, so it
  // lists every answer under the question it answers — the same list the profile panel shows.
  const whatsappAnswers = candidateWhatsAppAnswers(candidate, whatsappQuestions?.questions ?? null);
  // "Add it on phones" (owner, 2026-10-19): a reader who can edit the table's answers can edit them
  // here too. The card lists the table's columns, each with the same pencil, editor and save; the
  // answers no column holds follow read-only. One answer open at a time, like the table.
  const [editingColumnKey, setEditingColumnKey] = useState<string | null>(null);
  const [answersOpen, setAnswersOpen] = useState(false);
  const answerValues = poolAnswersByColumn(candidate, whatsappQuestions);
  const sharedCells = poolSharedCells(candidate, { touch: true });
  const experienceGap = experienceAnswerGap(facts.declaredExperience?.value, facts.years?.value);
  const emailProblem = candidateEmailProblem(candidate.email);
  const answersOutsideColumns = poolAnswersOutsideColumns(whatsappAnswers, answerColumns);
  const displayName = candidateDisplayName(candidate.fullName);
  // Under a role filter, "Asked only to … applicants" repeats the filter on every question that role is
  // asked — and on a phone it ran to five lines for a question asked to five roles — so the card leaves
  // it off those. An answer to a question that role is NOT asked keeps it: that is the line explaining
  // why it is there.
  const withoutFilterAudience = <Answer extends { key: string; askedTo: string | null }>(answers: readonly Answer[]) =>
    answers.map((answer) => (roleQuestionKeys.has(answer.key) ? { ...answer, askedTo: null } : answer));
  const hasAnswersSection = canEditAnswers
    ? answerColumns.length > 0 || answersOutsideColumns.length > 0
    : whatsappAnswers.length > 0;
  // Folded until asked for (owner, 2026-10-19 — "Fold answers on phones"): open, the answers were half
  // of every card — 381px of a 793px median card on a 812px phone, so 65 cards were a 52,000px scroll
  // (production, 375px). The heading row stays, with the count, and one tap opens them in place.
  const answersBodyId = `pool-card-answers-${candidate.id}`;
  const answerCount = whatsappAnswers.length;
  // "Add answers" promised an empty list, yet a card with no WhatsApp answers opens onto every CV
  // answer standing in for one — George Samir Lotfy's opened onto his faculty, region and years, each
  // marked "(from CV)" (production, 375px, 2026-10-19; owner: "fix the folded card's Add answers label
  // when it holds CV answers"). The reader's columns that carry that marker are counted, so the button
  // says what it is hiding.
  const cvOnlyAnswerCount = answerColumns.filter(
    (column) =>
      (poolSharedColumnKeys as readonly string[]).includes(column.key) &&
      sharedCells[column.key as PoolSharedColumnKey].fromCvOnly,
  ).length;
  const answersToggleLabel = answersOpen
    ? "Hide answers"
    : answerCount > 0
      ? `Show ${answerCount} ${answerCount === 1 ? "answer" : "answers"}`
      : canEditAnswers && cvOnlyAnswerCount > 0
        ? `Show ${cvOnlyAnswerCount} from CV`
        : "Add answers";
  // Full width between the screening facts and the contact details, never one of the half-width
  // fields: as a field the list ran about 900px down one half of the card with the other half empty
  // beside it (production, 375px, 2026-10-19), and an open editor needs the room.
  const whatsappAnswersSection = hasAnswersSection ? (
    <section aria-label={`WhatsApp answers of ${displayName}`} className="my-2 border border-slate-100 bg-slate-50 px-2.5 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">WhatsApp answers</h4>
        <button
          aria-controls={answersBodyId}
          aria-expanded={answersOpen}
          className={`inline-flex min-h-8 items-center border border-slate-200 bg-white px-2.5 text-phx-xs font-semibold text-slate-600 transition hover:border-orange-300 hover:text-orange-600 ${adminControlDepthClassName}`}
          onClick={() => {
            setAnswersOpen((open) => !open);
            setEditingColumnKey(null);
          }}
          type="button"
        >
          {answersToggleLabel}
        </button>
      </div>
      {answersOpen ? (
        <div id={answersBodyId}>
          {canEditAnswers ? (
            <>
              <dl className="mt-1 divide-y divide-slate-100">
                {answerColumns.map((column) => {
                  const currentValues = poolCurrentAnswerValues(candidate, column, answerValues);
                  return (
                    <div className="min-w-0 py-1.5" key={column.key}>
                      <dt className="break-words text-xs text-slate-500" dir="auto">
                        {column.header}
                        {column.askedTo && !roleQuestionKeys.has(column.key) ? (
                          <span className="block text-phx-xs text-slate-400">{column.askedTo}</span>
                        ) : null}
                      </dt>
                      <dd className="mt-0.5 min-w-0 text-xs">
                        <PoolEditableAnswer
                          canEdit
                          column={column}
                          currentValues={currentValues}
                          editing={editingColumnKey === column.key}
                          onCancel={() => setEditingColumnKey(null)}
                          onSave={(values) =>
                            run(async () => {
                              await savePoolColumnAnswers(candidate.id, column, values, currentValues);
                              setEditingColumnKey(null);
                              return `Saved the answer to "${column.header}" for ${displayName}.`;
                            })
                          }
                          onStartEdit={() => setEditingColumnKey(column.key)}
                          pending={pending}
                          touch
                        >
                          {/* A built-in column shows exactly what its table cell shows, CV stand-in
                              and all; an admin question's answer has no other source. */}
                          {(poolSharedColumnKeys as readonly string[]).includes(column.key) ? (
                            sharedCells[column.key as PoolSharedColumnKey].content
                          ) : (
                            <PoolAnswerText answer={poolAnswerSummary(currentValues, column) || null} />
                          )}
                        </PoolEditableAnswer>
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {answersOutsideColumns.length > 0 ? (
                <WhatsAppAnswersList
                  answers={withoutFilterAudience(answersOutsideColumns)}
                  className="mt-1 border-t border-slate-100 pt-2"
                />
              ) : null}
            </>
          ) : (
            <WhatsAppAnswersList answers={withoutFilterAudience(whatsappAnswers)} className="mt-1" />
          )}
        </div>
      ) : null}
    </section>
  ) : null;

  return (
    <PortalRecordCard
      accent="slate"
      actions={
        <CandidateActionsControl
          areaOptions={areaOptions}
          candidate={candidate}
          canDelete={canDelete}
          canManage={canManage}
          folderJobTitles={folderJobTitles}
          hiringManagers={hiringManagers}
          openPanel={openPanel}
          openProfile={openProfile}
          openRequisitions={openRequisitions}
          openVacancies={openVacancies}
          pending={pending}
          run={run}
          sendFreeArea={sendFreeArea}
          sendFreeTitle={sendFreeTitle}
          sendPosition={sendPosition}
          sendTo={sendTo}
          setOpenPanel={setOpenPanel}
          setSendFreeArea={setSendFreeArea}
          setSendFreeTitle={setSendFreeTitle}
          setSendPosition={setSendPosition}
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
          {/* One "New", never two side by side (owner, 2026-10-19 — "fix the double NEW pill on phone
              candidate cards"). The orange one says it arrived in the last day, the status one that
              nobody has looked yet; on a fresh candidate both read "New" and sat touching, so the
              orange one speaks for both. The desktop row keeps both, the date between them. */}
          {isNew && candidateStatusLabel(candidate.status) === "New" ? null : (
            <StagePill tone={candidateStatusTone(candidate.status)}>{candidateStatusLabel(candidate.status)}</StagePill>
          )}
        </span>
      }
      title={
        // Same as the desktop row: the name opens the candidate's own page in a new tab.
        <a
          className="hover:text-orange-600 hover:underline"
          href={candidateHref}
          rel="noopener"
          target="_blank"
          title={candidate.fullName}
        >
          {candidateDisplayName(candidate.fullName)}
        </a>
      }
    >
      <PortalRecordFields
        fields={[
          // The three screening facts lead, ahead of every contact detail — deciding whether this
          // CV is worth opening is the whole job, and a phone shows about four fields before the
          // reader has to scroll. Same order as the desktop columns, for the same reason.
          {
            label: facts.roleTitle
              ? facts.roleTitle.confirmed
                ? "Role"
                : "Role (from CV)"
              : appliedFor.source && appliedFor.source !== "stated"
                ? `Applying for (${APPLIED_FOR_SOURCE_SHORT[appliedFor.source]})`
                : "Applying for",
            value: (
              <>
                {facts.roleTitle
                  ? shown(facts.roleTitle.value, facts.roleTitle.confirmed)
                  : appliedFor.text
                    ? shown(appliedFor.text, appliedFor.source === "stated")
                    : "Not stated"}
                {/* The family, and only when it is not just the title again in capitals. */}
                {roleFamily && !roleTitleAlreadySaysFamily ? (
                  <div className="mt-0.5 text-phx-2xs font-black uppercase tracking-[0.06em] text-slate-400">
                    {candidateRoleFamilyLabels[roleFamily]}
                  </div>
                ) : null}
              </>
            ),
          },
          // What they asked for, when that is a different question from what they do. With no job
          // title on file the field above already IS this line, so it would only repeat itself.
          ...(facts.roleTitle &&
          appliedFor.text &&
          normalizeJobTitle(appliedFor.text) !== normalizeJobTitle(facts.roleTitle.value)
            ? [
                {
                  label:
                    appliedFor.source && appliedFor.source !== "stated"
                      ? `Applying for (${APPLIED_FOR_SOURCE_SHORT[appliedFor.source]})`
                      : "Applying for",
                  value: appliedFor.text,
                },
              ]
            : []),
          // The company's region over the governorate it came from, same as the row: the map is
          // the company's own, so the reader has to be able to see the working.
          //
          // The gate is the REGION, not the governorate, and that is the fix rather than a tidy-up.
          // An applicant who tapped a region and an area on WhatsApp but whose CV carries no
          // address had `facts.governorate` null, so this whole block was skipped and the card
          // showed nothing at all about where they want to work — while holding their exact answer.
          ...(facts.region || facts.governorate
            ? [
                {
                  label: facts.region?.value.declared
                    ? "Region (asked)"
                    : (facts.region ? facts.region.confirmed : Boolean(facts.governorate?.confirmed))
                      ? "Region"
                      : "Region (from CV)",
                  value: (
                    <>
                      {shown(
                        facts.region ? facts.region.value.label : facts.governorate!.value,
                        facts.region ? facts.region.confirmed : facts.governorate!.confirmed,
                      )}
                      {facts.area ? (
                        <div className="mt-0.5 text-phx-2xs font-semibold text-slate-600">{facts.area.value}</div>
                      ) : facts.region && facts.governorate ? (
                        <div className="mt-0.5 text-phx-2xs font-semibold text-slate-500">
                          {facts.governorate.value}
                        </div>
                      ) : null}
                    </>
                  ),
                },
              ]
            : []),
          // `false` is an answer, not a blank — "never worked as a medical rep" is exactly what a
          // screener of a pharma pool needs, so the pill is drawn either way.
          ...(facts.years || facts.pharmaRep
            ? [
                {
                  label: "Experience",
                  value: (
                    <>
                      {facts.years
                        ? shown(
                            `${facts.years.confirmed ? "" : "~"}${formatYearsOfExperience(facts.years.value)}`,
                            facts.years.confirmed,
                          )
                        : "Not stated"}
                      {/* Here, above the fold, for every reader: the answers below are folded by
                          default ("Fold answers on phones"), and a flag hidden in them goes unseen. */}
                      {experienceGap ? (
                        <div className="mt-1">
                          <StagePill tone="amber">{EXPERIENCE_GAP_LABEL}</StagePill>
                          <div className="mt-0.5 break-words text-phx-xs text-amber-800">{experienceGap.explanation}</div>
                        </div>
                      ) : null}
                      {facts.pharmaRep ? (
                        <div className="mt-1">
                          <StagePill tone={facts.pharmaRep.value ? "emerald" : "slate"}>
                            {facts.pharmaRep.value ? "Pharma rep" : "No pharma"}
                            {facts.pharmaRep.confirmed ? "" : " ?"}
                          </StagePill>
                        </div>
                      ) : null}
                    </>
                  ),
                },
              ]
            : []),
        ]}
      />
      {whatsappAnswersSection}
      <PortalRecordFields
        fields={[
          ...(isStatedNonEgyptian(candidate.nationality)
            ? [{ label: "Nationality", value: nonEgyptianFlagTitle(candidate.nationality) }]
            : []),
          // The pill above says what; this says why. On desktop that sentence is the tooltip, and a
          // phone has no hover — without it the card is a blank row wearing a two-word label.
          ...(isNotACv(candidate) ? [{ label: "CV file", value: NOT_A_CV_TITLE }] : []),
          { label: "Received", value: cairoDateTime(candidate.createdAt) },
          { label: "Email", value: candidate.email ?? "—" },
          // A phone has no hover, so the reason is spelled out as its own line under the address.
          ...(emailProblem ? [{ label: `⚠ ${EMAIL_CHECK_LABEL}`, value: emailProblem.explanation }] : []),
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
const poolFilterLabelClass = phxLabelTextClassName;
const poolFilterSelectClass =
  phxSelectClassName;

function CandidatesTab({
  areaOptions,
  asOf,
  canDelete,
  canFileCandidates,
  canImport,
  canManage,
  candidates,
  cvFolderCabinet,
  hiringManagers,
  linkedCandidateId,
  openRequisitions,
  openVacancies,
  pending,
  run,
  setError,
  setNotice,
  whatsappQuestions,
}: {
  /** Every active area, tagged with the region it files under in RECRUITMENT — the folder picker's
      area list. Loaded on the server because it reads the org chart; see candidate-folder-options.ts. */
  areaOptions: CandidateFolderAreaOption[];
  /** The instant the server counted the stat cards from — see CandidatePoolStats. */
  asOf: string;
  canDelete: boolean;
  /**
   * `candidates: update` — what the cv-folders routes enforce, so what "Move to folder" gates on.
   * Its own prop rather than `canManage` (`candidates: create` here): a button gated on a grant its
   * route does not assert either hides from somebody who may press it or shows one that 403s.
   */
  canFileCandidates: boolean;
  canImport: boolean;
  canManage: boolean;
  candidates: Candidate[];
  /** The folders the owner built by hand — the destinations "Move to folder" offers. */
  cvFolderCabinet: CvFolderCabinetData;
  hiringManagers: HiringManagerOption[];
  linkedCandidateId: string | null;
  openRequisitions: Requisition[];
  openVacancies: VacancyReportRow[];
  pending: boolean;
  run: (work: () => Promise<string | void>) => void;
  setError: (value: string | null) => void;
  setNotice: (value: string | null) => void;
  /** The bot's questions — the pool's headers follow them. Null when they could not be read. */
  whatsappQuestions: PoolWhatsAppQuestions | null;
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
  // Which position (an open vacancy id, or FREE_POSITION with the two fields below) rides along
  // with that send — see PositionPicker. Keyed by candidate id for the same reason as sendTo.
  const [sendPosition, setSendPosition] = useState<Record<string, string>>({});
  const [sendFreeArea, setSendFreeArea] = useState<Record<string, string>>({});
  const [sendFreeTitle, setSendFreeTitle] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [dateFilter, setDateFilter] = useState<PoolDateFilter>("all");
  // THE DECISION TAB, where the Status select used to be. The owner, 2026-09-18: "in any screening
  // page you must show did not decide yet ... shortlisted ... rejected", so that when a new CV
  // arrives he sees it at once. The pool opens on "Not decided yet", like every screen that lists
  // CVs; the rule that places a CV on a tab is candidate-decision-tabs.ts, shared with them all.
  const [decisionTab, setDecisionTab] = useState<CandidateDecisionTab>(DEFAULT_CANDIDATE_DECISION_TAB);
  const [sourceFilter, setSourceFilter] = useState("");
  // "Has this person sold pharma before?" — the first question asked of every Medical Rep CV, and
  // the AI has already answered it on 161 of the 227 people in the pool (81 yes, 80 no, 66 it could
  // not tell). Free to filter on, and it turns a scroll through 226 rows into a look at 81.
  const [experienceFilter, setExperienceFilter] = useState<PoolExperienceFilter>("all");
  // "Upper Egypt district managers" was impossible two ways over: there was no region grouping at
  // all, and searching the title text for "district manager" misses nine of the 27 who are one —
  // three spell it "manger" and six are titled "District Sales Manager". Both filters read a
  // domain classifier rather than the raw column, so the misspelling and the variant both land.
  const [roleFilter, setRoleFilter] = useState<CandidateRoleFamily | "" | "unknown">("");
  const [regionFilter, setRegionFilter] = useState<CandidateRegionCode | "" | "unknown" | "foreign">("");
  // 132 of the 555 rows in production share a person with another row — the same CV forwarded twice,
  // or the same applicant applying again. The flag was already computed; there was no way to ask for
  // just those rows, which is the only way anyone is going to work through them.
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  // "A 'CV differs' filter" (owner, 2026-10-19): the rows whose WhatsApp experience band and CV
  // count cannot both be right — 13 of the 52 that carry both on production that day. The amber
  // flag was on each row; this is the way to ask for just those, to work through them in one go.
  const [experienceGapOnly, setExperienceGapOnly] = useState(false);
  // The pool, split in two. Red means one thing on this screen and has since the flags were built:
  // this person cannot be hired — the CV states a nationality that is not Egyptian, or somebody has
  // already rejected them. Both were visible as a pill and neither could be asked for, so the CVs
  // worth acting on were read past every time somebody came back to see what had arrived.
  //
  // A tab rather than another checkbox on the toolbar, and rather than a filter that defaults to
  // hiding them. The owner's standing rule across this platform is that the system FLAGS and never
  // rejects: both piles are counted in the tab strip, both open in one click, and every action works
  // identically in either. Nothing is hidden — it is put in the other pile and the pile is labelled.
  const [cvTab, setCvTab] = useState<CandidateCvTab>("active");
  // "What is sitting with the Giza District Sales Manager?" — a question the pool could not answer
  // at all before 2026-08-27, because a push recorded only a manager NAME and the list stayed one
  // flat column ordered by arrival. Off by default: the pool is a pool first, and 370 of the 434
  // rows in production have never been sent to anybody, so grouping would show one enormous
  // ungrouped remainder to anyone who did not ask for it.
  const [groupByManager, setGroupByManager] = useState(false);
  // Bulk send: which candidates are ticked, and who they all go to. Held here rather than per row
  // so the choice survives the re-render router.refresh() triggers after some other row is acted on.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkManagerHrId, setBulkManagerHrId] = useState("");
  // The folder on that manager's shelf the whole batch is filed in; "" lets the system choose.
  const [bulkManagerFolder, setBulkManagerFolder] = useState("");
  const bulkShelfFolders = foldersToOffer(hiringManagers, bulkManagerHrId ? [bulkManagerHrId] : []);
  const bulkChosenFolder = bulkShelfFolders.includes(bulkManagerFolder) ? bulkManagerFolder : "";
  // Which of the owner's own folders the ticked CVs are moved into — see "Move to folder" below.
  const [bulkFolderId, setBulkFolderId] = useState("");
  // Same position choice as sendPosition/sendFreeArea/sendFreeTitle, held once rather than keyed
  // per candidate — the whole point of a bulk send is one manager and one filing for everybody in it.
  const [bulkPosition, setBulkPosition] = useState("");
  const [bulkFreeArea, setBulkFreeArea] = useState("");
  const [bulkFreeTitle, setBulkFreeTitle] = useState("");
  // Which row, if any, has a picker open. One at a time: 555 rows must not each mount two
  // dropdowns, and two open pickers on screen is two places to click Send by mistake.
  const [openRowPanel, setOpenRowPanel] = useState<{ id: string; panel: PoolRowPanel } | null>(null);
  // Screening mode holds a SNAPSHOT of the queue taken when it opens, not a live view: re-sorting
  // the list under a reader who is halfway through it is how you lose your place, which is the
  // exact complaint this whole mode answers.
  const [screeningQueue, setScreeningQueue] = useState<Candidate[] | null>(null);
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
  // The wording of the admin-defined WhatsApp questions, so the profile prints each of the applicant's
  // answers under the question it answers. Arrives with the profile; null until then.
  const [screeningQuestions, setScreeningQuestions] = useState<ScreeningQuestionLabel[] | null>(null);

  // Which shell this pool is rendering in, so the screening link points at the twin the caller can
  // actually open. A hard-coded /recruitment/screening in the portal would bounce Talent
  // Acquisition straight back out through the (admin) group's redirect.
  const poolPathname = usePathname();
  const poolParams = useSearchParams();
  const screeningBasePath = poolPathname?.startsWith("/employee-portals")
    ? "/employee-portals/recruitment"
    : "/recruitment";
  // Where a pressed name goes: that candidate's own page, in this same shell — /hr/recruitment
  // included, so an HR seat keeps the HR sidebar (candidate-page-link.ts).
  const candidatePageRoot = recruitmentRootFromPathname(poolPathname);

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
  // The same resolution the row's "CV differs" flag reads, so the count, the filter and the flag
  // can never disagree about who is in it.
  const experienceGapIds = new Set(
    candidates.filter((candidate) => factsHaveExperienceGap(candidateScreeningFacts(candidate))).map((candidate) => candidate.id),
  );
  const experienceGapCount = experienceGapIds.size;
  // Built over the WHOLE pool, not the filtered view: a duplicate's counterpart is very often
  // filtered out (different status, different source, older than the date filter), and a merge
  // button that cannot name what it merges into is a merge nobody will click.
  const candidateNameById = new Map(
    candidates.map((candidate) => [candidate.id, candidateDisplayName(candidate.fullName)] as const),
  );

  // THE SHELF COMES OFF THE POOL FIRST, before search, before every filter and before the red/active
  // split. The owner's requirement in his own words: *"the CV that I push to a folder ... it is not
  // appearing now on the main page."* Taking it out here rather than inside the predicate below is
  // what makes that true of the counts as well as the rows — a filed CV must not be sitting inside
  // "Active 322" waiting for somebody to notice the arithmetic does not add up.
  //
  // `poolCandidates` and the folder screen come from ONE partition of ONE array, so a CV is in
  // exactly one of them by construction. Two independent filters here is precisely how a candidate
  // ends up in neither and is lost.
  const { pool: poolCandidates, shelves: folderShelves } = partitionCandidatesByFolder(candidates);
  // The job titles already in use as folders, offered beside the free-typed field. This is what
  // keeps a second "Regulatory Affairs Specialist" from opening a folder that reads almost exactly
  // like the first — the same risk the owner accepted on the position picker, answered the same way.
  const folderJobTitles = (folderShelves.find((shelf) => shelf.kind === "other")?.folders ?? []).map(
    (folder) => folder.storedKey,
  );

  const q = normalizeCandidatePoolQuery(query);
  const filteredCandidates = poolCandidates
    .filter((c) => {
      // One predicate, shared with the filed-CV band below. Two copies of it here is how a person
      // becomes findable on one half of the partition and invisible on the other.
      if (!candidateMatchesPoolQuery(c, q)) return false;
      if (sourceFilter && candidateSourceChannel(c.source, c.sourceContext).label !== sourceFilter) return false;
      if (duplicatesOnly && !c.possibleDuplicate) return false;
      if (experienceGapOnly && !experienceGapIds.has(c.id)) return false;
      // Both are three-way for the same reason the experience filter is: "we were never told" is
      // not "none of the above", and on this pool it is the single commonest answer.
      //
      // Both read `candidateScreeningFacts` — the SAME resolution the row renders — rather than the
      // raw column, and that is the point rather than a tidy-up. While the filter read
      // `c.currentJobTitle` alone it disagreed with the screen: Mahmoud Refaat Selim sat in the pool
      // on 2026-08-24 showing "District Sales Manager, Alexandria" in his role cell with his title
      // column NULL, so the one filter built to find him could not. Filtering on a different fact
      // from the one displayed is not a narrower filter, it is a wrong one.
      //
      // Coverage, measured on the same 426 rows: role 177 -> 221 from the hedged CV titles alone,
      // and further again through the resolved "Applying for" text; region 267 -> 269.
      if (roleFilter || regionFilter) {
        const facts = candidateScreeningFacts(c);
        if (roleFilter) {
          // Both families, for the reason screeningRoleFamilies gives: a senior medical rep applying
          // for a district manager seat is in the District Manager filter as well as his own.
          const families = screeningRoleFamilies(facts, candidateRowAppliedFor(c).text);
          if (roleFilter === "unknown" ? families.length > 0 : !families.includes(roleFilter)) return false;
        }
        if (regionFilter) {
          const region = facts.region?.value.code ?? null;
          const foreign = Boolean(facts.region?.value.foreignCountry);
          // Three buckets, not two. A null code means either "we do not know where they live" or
          // "we do, and it is not in Egypt" — asking for the second under a heading that says the
          // first would misdescribe a person we actually have an address for.
          if (regionFilter === "foreign") {
            if (!foreign) return false;
          } else if (regionFilter === "unknown") {
            if (region !== null || foreign) return false;
          } else if (region !== regionFilter) {
            return false;
          }
        }
      }
      // Three-way, not a checkbox: null is a real and common answer here (66 rows), and it means
      // "the CV did not say", which is not the same as "no". Folding unknown into either bucket
      // would quietly hide people.
      //
      // Reads the resolved fact for the same reason the two above do — 14 people have a medical-rep
      // answer the CV reader hedged, so the column is null while the row shows "Pharma rep".
      if (experienceFilter !== "all") {
        const pharma = candidateScreeningFacts(c).pharmaRep?.value ?? null;
        if (experienceFilter === "yes" && pharma !== true) return false;
        if (experienceFilter === "no" && pharma !== false) return false;
        if (experienceFilter === "unknown" && typeof pharma === "boolean") return false;
      }
      if (dateFilter === "all") return true;
      if (dateFilter === "today") return cairoDayKey(c.createdAt) === todayKey;
      const created = new Date(c.createdAt).getTime();
      if (Number.isNaN(created)) return false;
      return created >= asOfMs - (dateFilter === "week" ? 7 : 30) * DAY_MS;
    })
    // Newest first, always. The pool grew by 152 rows in the last 7 days; anything else buries the
    // CV that arrived an hour ago under one from March.
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  // The split, taken AFTER every other filter, so each tab counts what is actually on screen: a
  // search for "Ahmed" that turns up two rejected people says "Red-flagged 2", not the pool total.
  // Both sides are built in one pass over one predicate — two filters here would be two places for
  // the definition of red to drift apart from each other and from the pill on the row.
  //
  // THE DECISION TABS are counted over the same filtered list, before the tab itself narrows it, so
  // each number on the strip is the list that tab opens under the filters now on screen.
  const decisionCounts = countCandidatesByDecisionTab(filteredCandidates);
  const inDecisionTab = filteredCandidates.filter((candidate) =>
    candidateMatchesDecisionTab(candidate.status, decisionTab),
  );
  const cvTabCandidates = partitionCandidatesByRedFlag(inDecisionTab);
  // On the Rejected tab the Active / Red-flagged split has nothing to say — a rejection IS a red flag
  // (red-flag.ts), so "Active" would read zero on every visit. That tab shows its whole pile.
  const showsRedSplit = decisionTab !== "rejected";
  const visibleCandidates = showsRedSplit ? cvTabCandidates[cvTab] : inDecisionTab;

  // THE OTHER HALF OF THE PARTITION — searched only while somebody is actively looking for a person.
  //
  // Filing a CV to a folder takes it off this page on purpose, and that rule is untouched: with an
  // empty search box the pool shows exactly what it showed before. What filing must NOT do is take
  // the person out of the one box built to find people. On 2026-09-03 the pool held 734 CVs with
  // 150 filed, the Folders tab had no search of its own, and typing a filed applicant's own name
  // returned nothing anywhere in the application — a CV nobody can look up is indistinguishable
  // from a CV that was lost, which is exactly what was reported.
  //
  // Deliberately NOT merged into the table above. These rows are not in the pool, and showing them
  // as if they were would make the count in the tab strip wrong and re-open the complaint that
  // filed CVs come back to the main page.
  const filedCount = folderShelves.reduce((total, shelf) => total + shelf.candidateCount, 0);
  // Says what is being withheld and by which mechanism, because the old wording named only one of
  // the two. It read "488 of 734 shown ... the red tab holds them, it never removes them" while the
  // red tab held 97 of the 246 missing and folders held the other 150 — so the sentence sent anyone
  // looking for a filed CV to a tab that does not contain it. Both mechanisms are named now, and
  // neither clause is written unless it is actually withholding something.
  const poolShellDescription = [
    `${visibleCandidates.length} of ${candidates.length} shown, newest first.`,
    decisionTab === "all" ? "" : "The decision tabs above the list hold the rest of the pool.",
    filedCount > 0 ? `${filedCount} are filed in folders and sit on the Folders tab, not here.` : "",
    showsRedSplit ? "Nobody is removed — the red tab holds the rest." : "",
  ]
    .filter(Boolean)
    .join(" ");

  const filedMatches = q
    ? folderShelves.flatMap((shelf) =>
        shelf.folders.flatMap((folder) =>
          folder.candidates
            .filter((candidate) => candidateMatchesPoolQuery(candidate, q))
            .map((candidate) => ({ candidate, folderLabel: folder.label, shelfLabel: shelf.label })),
        ),
      )
    : [];

  // Grouped by the manager each CV was SENT to, and only ever over what is already on screen — so
  // narrowing to "this week" narrows the piles too, rather than showing groups that disagree with
  // the count in the panel header. Candidates nobody has sent keep their place at the end: they
  // are still part of the pool, they are simply not part of this question.
  const managerGroups: ManagerGroup[] = groupByManager ? groupCandidatesByNotifiedManager(visibleCandidates) : [];
  const notifiedVisibleCount = visibleCandidates.filter((candidate) => candidate.managerNotified).length;
  const unsentVisible = groupByManager ? visibleCandidates.filter((candidate) => !candidate.managerNotified) : [];
  // One flat list again once the groups are laid end to end, because the table below is a single
  // <tbody> and the mobile list a single stack. The section headings come from the map next to
  // this one rather than from a nested render, which keeps the 200-line row renderer untouched.
  const displayedCandidates = groupByManager ? [...managerGroups.flatMap((group) => group.candidates), ...unsentVisible] : visibleCandidates;
  // THE HEADERS FOLLOW THE WHATSAPP QUESTIONS (owner, 2026-10-19 — "switch by role"). With no role
  // picked the table's columns are the questions every applicant meets; with one picked they become
  // every question THAT role is asked, each cell the candidate's own answer. pool-whatsapp-columns.ts
  // decides which; the answers come from the same reader the profile panel uses.
  const answersByCandidateId = new Map(
    displayedCandidates.map((candidate) => [candidate.id, poolAnswersByColumn(candidate, whatsappQuestions)]),
  );
  const answeredKeys = new Set([...answersByCandidateId.values()].flatMap((answers) => [...answers.keys()]));
  const roleView: CandidateRoleFamily | null = roleFilter && roleFilter !== "unknown" ? roleFilter : null;
  // "Full control" (owner, 2026-10-19): the reader may add any question as a column, hide one and
  // reorder them, kept per view in this browser. Nothing saved means the view's own WhatsApp questions.
  const [savedColumns, saveColumns] = usePoolColumnLayout(poolColumnViewKey(roleView));
  const defaultColumns = poolDefaultColumns({ answeredKeys, roleFamily: roleView, whatsapp: whatsappQuestions });
  const columnCatalogue = poolColumnCatalogue(whatsappQuestions, answeredKeys);
  const tableColumns = applyPoolColumnLayout(defaultColumns, columnCatalogue, savedColumns);
  // Every question the picked role is asked — its default columns, before the reader's layout. A phone
  // card leaves "Asked only to …" off these, since the filter already says it.
  const roleQuestionKeys: ReadonlySet<string> = new Set(roleView ? defaultColumns.map((column) => column.key) : []);
  // The measured, pinned widths below are for the shared five exactly as they ship; any other set of
  // columns shares the width equally instead.
  const usesPinnedLayout = !roleView && !savedColumns;
  // Which answer cell is open for editing — one at a time, like the row pickers.
  const [editingCell, setEditingCell] = useState<{ candidateId: string; columnKey: string } | null>(null);
  const groupHeaderByCandidateId = new Map<string, ManagerGroup>();
  if (groupByManager) {
    for (const group of managerGroups) {
      const first = group.candidates[0];
      if (first) groupHeaderByCandidateId.set(first.id, group);
    }
  }
  const firstUnsentId = groupByManager ? (unsentVisible[0]?.id ?? null) : null;

  // The owner's own folders, flattened in the order his folder screen draws them.
  const cvFolderChoices = flattenCvFolderTree(
    buildCvFolderTree(cvFolderCabinet.rows, new Map(Object.entries(cvFolderCabinet.members))),
  );

  const visibleIds = visibleCandidates.map((candidate) => candidate.id);
  // The tick column is for whoever the bulk bar has a button for: sending (candidates: create) or
  // moving into a folder (candidates: update).
  const canSelect = canManage || canFileCandidates;
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
    setScreeningQuestions(null);
    try {
      const res = await fetch(`/api/recruitment/candidates/${id}`);
      const data = (await res.json().catch(() => ({}))) as {
        profile?: CandidateProfile;
        latestCvExtraction?: StoredCvExtraction | null;
        message?: string;
        screeningQuestions?: ScreeningQuestionLabel[] | null;
      };
      if (!res.ok || !data.profile) throw new Error(data.message ?? "Failed to load candidate profile.");
      setProfile(data.profile);
      // Deliberately blank, not seeded with the current status. The control below is now "set
      // ANOTHER status", so pre-filling it would arm the button with the value already stored — and
      // for the 225 legacy rows that value is 'Candidate Created', which the route rejects.
      setStatusDraft("");
      setStatusNoteDraft("");
      setStoredExtraction(data.latestCvExtraction ?? null);
      setScreeningQuestions(data.screeningQuestions ?? null);
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
    setScreeningQuestions(null);
    // Drop the ?candidate= link on the way out. Without this, a CV opened from a folder (or from the
    // inbound-CV notification) could be opened exactly ONCE: the deep-link effect is guarded on the
    // id, so closing and pressing the same CV again would set a value the guard had already seen and
    // nothing would happen. Clearing the link is what makes the second press work.
    if (linkedCandidateId) {
      const next = new URLSearchParams(Array.from(poolParams.entries()));
      next.delete("candidate");
      const query = next.toString();
      router.replace(query ? `${poolPathname}?${query}` : (poolPathname ?? ""), { scroll: false });
    }
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
    // Cleared link ⇒ forget what was opened, so pressing the SAME CV again reopens it. The guard
    // exists to stop the panel reopening on every render, not to make a CV openable once per visit.
    if (!linkedCandidateId) {
      autoOpenedRef.current = null;
      return;
    }
    if (autoOpenedRef.current === linkedCandidateId) return;
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
        <RecruitmentPanel
          description="Create a candidate record (deduplicated by National ID, then email or phone)."
          icon={<UserPlus aria-hidden="true" className="h-4 w-4" />}
          title="Add a candidate"
        >
          <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-4">
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
              <Button variant="secondary" onClick={() => downloadFromApiRoute("/api/recruitment/candidates/template")}>
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
        </RecruitmentPanel>
      ) : null}

      <RecruitmentPanel
        description={poolShellDescription}
        icon={<Users aria-hidden="true" className="h-4 w-4" />}
        title="Candidate pool"
      >
        <div className="space-y-3 p-3">
          {/* The two piles, before anything else on the toolbar — because which pile you are in
              changes what every control below it is filtering. Counts are live and reflect the
              filters underneath, so "Red-flagged 2" on a search means two in THAT search.

              Both tabs always render, even at zero. A tab that disappears when it empties is a
              tab that reads as a bug the day it comes back, and "0 red-flagged" is the single
              most useful thing this strip can say. */}
          {/* THE DECISION TABS come first of all: which verdict pile you are in changes what
              every control below it is filtering, the red split included. */}
          <CandidateDecisionTabStrip
            active={decisionTab}
            counts={decisionCounts}
            onSelect={(tab) => {
              setDecisionTab(tab);
              // A tick on a row the new tab does not show would be acted on unseen by the bulk bar.
              setSelectedIds([]);
            }}
          />
          {showsRedSplit ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className={`inline-flex overflow-hidden border border-phx-line ${adminChipDepthClassName}`}>
              {candidateCvTabs.map((key) => {
                const isActive = cvTab === key;
                return (
                  <button
                    aria-pressed={isActive}
                    className={cn(
                      "inline-flex h-9 items-center gap-1.5 whitespace-nowrap px-3 text-xs font-semibold transition",
                      key === "red" ? "border-l border-phx-line" : "",
                      isActive
                        ? key === "red"
                          ? "bg-rose-50 text-rose-700"
                          : "bg-orange-50 text-phx-accent-press"
                        : "bg-white text-slate-600 hover:bg-slate-50",
                    )}
                    key={key}
                    onClick={() => setCvTab(key)}
                    title={candidateCvTabDescriptions[key]}
                    type="button"
                  >
                    {key === "red" ? <span aria-hidden className="h-2 w-2 shrink-0 bg-rose-500" /> : null}
                    {candidateCvTabLabels[key]}
                    <span className="tabular-nums opacity-70">{cvTabCandidates[key].length}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-slate-500">{candidateCvTabDescriptions[cvTab]}</p>
          </div>
          ) : null}
          <Input
            placeholder="Search name, applying for, email, phone, status, source"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* Filed CVs that answer the search, directly under the box that asked. Rendered only
              while a search is running, so the page at rest is unchanged — and rendered as its own
              band rather than as table rows, because these CVs are genuinely not in the pool and a
              row that looks identical to a pool row would say they were.

              Fits-the-screen rule: no fixed widths, no nowrap, no truncation. A long name and a
              long folder label both WRAP. */}
          {q && filedMatches.length > 0 ? (
            <div className="border border-amber-200 bg-amber-50 p-3">
              <p className="text-xs font-semibold text-amber-900">
                {filedMatches.length === 1
                  ? "1 more CV matches, filed in a folder"
                  : `${filedMatches.length} more CVs match, filed in folders`}
              </p>
              <p className="mt-0.5 text-xs text-amber-800">
                Filed CVs are kept off the pool on purpose. They are listed here so a search never
                comes back empty for somebody who is in the system.
              </p>
              <ul className="mt-2 space-y-1.5">
                {filedMatches.map(({ candidate, folderLabel, shelfLabel }) => (
                  <li
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-amber-200 pt-1.5 first:border-t-0 first:pt-0"
                    key={candidate.id}
                  >
                    <button
                      className="text-left text-xs font-semibold text-amber-900 underline underline-offset-2 hover:text-amber-700"
                      onClick={() => void openProfile(candidate.id)}
                      type="button"
                    >
                      {candidateDisplayName(candidate.fullName)}
                    </button>
                    <span className="text-xs text-amber-800">
                      {shelfLabel} · {folderLabel}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
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
            <label className={poolFilterLabelClass}>
              Role
              <select
                className={poolFilterSelectClass}
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value as CandidateRoleFamily | "" | "unknown")}
              >
                <option value="">Any role</option>
                {candidateRoleFamilies.map((family) => (
                  <option key={family} value={family}>
                    {candidateRoleFamilyLabels[family]}
                  </option>
                ))}
                <option value="unknown">No job title on file</option>
              </select>
            </label>
            <label className={poolFilterLabelClass}>
              Region
              <select
                className={poolFilterSelectClass}
                value={regionFilter}
                onChange={(e) => setRegionFilter(e.target.value as CandidateRegionCode | "" | "unknown" | "foreign")}
              >
                <option value="">Any region</option>
                {candidateRegionCodes.map((code) => (
                  <option key={code} value={code}>
                    {candidateRegionLabels[code]}
                  </option>
                ))}
                <option value="foreign">{foreignRegionLabel}</option>
                <option value="unknown">No governorate on file</option>
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
                    ? "border-phx-accent bg-orange-50 text-phx-accent-press"
                    : "border-phx-line bg-white text-slate-600 hover:border-phx-accent-line hover:text-phx-accent"
                }`}
                onClick={() => setDuplicatesOnly((previous) => !previous)}
                type="button"
              >
                <Copy className="h-3.5 w-3.5" />
                Possible duplicates
                <span className="tabular-nums opacity-70">{duplicateCount}</span>
              </button>
            ) : null}
            {experienceGapCount > 0 || experienceGapOnly ? (
              <button
                aria-pressed={experienceGapOnly}
                className={`inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border px-3 text-xs font-semibold transition ${
                  experienceGapOnly
                    ? "border-phx-accent bg-orange-50 text-phx-accent-press"
                    : "border-phx-line bg-white text-slate-600 hover:border-phx-accent-line hover:text-phx-accent"
                }`}
                onClick={() => setExperienceGapOnly((previous) => !previous)}
                title="Only the CVs whose experience count disagrees with the band chosen on WhatsApp"
                type="button"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                {EXPERIENCE_GAP_LABEL}
                <span className="tabular-nums opacity-70">{experienceGapCount}</span>
              </button>
            ) : null}
            {/* Group by the manager the CV was SENT to — the owner asked for this in those exact
                terms: "the same area are listed together and the same title are listed together".
                It reads the seat frozen onto the candidate at send time, so a manager who changes
                area does not silently rewrite where last month's CVs went. Hidden when nothing on
                screen has been sent, because an empty grouping is a control that does nothing. */}
            {notifiedVisibleCount > 0 ? (
              <button
                aria-pressed={groupByManager}
                className={`inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border px-3 text-xs font-semibold transition ${
                  groupByManager
                    ? "border-phx-accent bg-orange-50 text-phx-accent-press"
                    : "border-phx-line bg-white text-slate-600 hover:border-phx-accent-line hover:text-phx-accent"
                }`}
                onClick={() => setGroupByManager((previous) => !previous)}
                type="button"
              >
                <Users className="h-3.5 w-3.5" />
                Group by manager
                <span className="tabular-nums opacity-70">{notifiedVisibleCount}</span>
              </button>
            ) : null}
            {/* The way into screening mode, and deliberately the loudest control on the toolbar.
                It takes the queue EXACTLY as filtered and ordered on screen, so narrowing to
                "District Manager · Alex-BHR" and pressing this is a session with an end. */}
            {visibleCandidates.length > 0 ? (
              <Button onClick={() => setScreeningQueue(inDecisionTab)}>
                Screen {visibleCandidates.length} {visibleCandidates.length === 1 ? "CV" : "CVs"}
              </Button>
            ) : null}
            {/* The same queue with an ADDRESS. Deliberately a second control rather than a
                replacement: the button above carries every filter on this toolbar exactly, which a
                URL cannot, while this one is bookmarkable and survives closing the browser. It
                opens on the unread pile because that is the reason to come back a second time. */}
            <Link
              className="inline-flex items-center gap-1.5 border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
              href={screeningHref(screeningBasePath, { seen: "unseen", status: statusFilterForDecisionTab(decisionTab) })}
              title="Open the screening queue on its own page, starting with the CVs you have never read"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Screening page
            </Link>
            {/* THE OTHER PILE, and on a two-person queue it is the bigger one.
                "Unseen" means *I* have not read it, which since screening became a two-person job
                includes everything HR-010 has already worked. This is the pile nobody has touched:
                554 of 781 candidates on 2026-09-05. A second link rather than a replacement, because
                the one above is in the owner's bookmarks and answers a different question. */}
            <Link
              className="inline-flex items-center gap-1.5 border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
              href={screeningHref(screeningBasePath, { seen: "untouched", status: statusFilterForDecisionTab(decisionTab) })}
              title="Open the screening queue on the CVs nobody has read yet — not you, not the other screener"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Nobody has read
            </Link>
            {dateFilter !== "all" || experienceFilter !== "all" || sourceFilter || roleFilter || regionFilter || query || duplicatesOnly || experienceGapOnly ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setDateFilter("all");
                  setExperienceFilter("all");
                  setSourceFilter("");
                  setRoleFilter("");
                  setRegionFilter("");
                  setQuery("");
                  setDuplicatesOnly(false);
                  setExperienceGapOnly(false);
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        </div>

        {/* Who is holding what, in one line, before the list itself. With five managers and 434
            rows the grouping is only useful if you can see the shape of it without scrolling
            through it, and a chip jumps straight to that manager's pile. Ordered by title then
            area then name — the same order the send dropdown uses, so the summary reads in the
            order the recruiter chose from. */}
        {groupByManager && managerGroups.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 border-y border-orange-200 bg-orange-50/60 px-3 py-2">
            <span className="mr-1 whitespace-nowrap text-xs font-black uppercase tracking-wide text-slate-500">
              {managerGroups.length} {managerGroups.length === 1 ? "manager" : "managers"}
            </span>
            {managerGroups.map((group) => {
              const seatLabel = managerSeatLabel(group.seat);
              return (
                <button
                  className="inline-flex items-center gap-1.5 whitespace-nowrap border border-phx-accent-line bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:border-phx-accent hover:text-phx-accent-press"
                  key={group.key}
                  onClick={() => scrollToManagerGroup(group.key)}
                  title={seatLabel ? `${group.seat.name} — ${seatLabel}` : group.seat.name}
                  type="button"
                >
                  <span className="font-bold">{group.seat.name}</span>
                  {seatLabel ? <span className="font-medium text-slate-500">{seatLabel}</span> : null}
                  <span className="font-bold tabular-nums text-phx-accent-press">{group.candidates.length}</span>
                </button>
              );
            })}
            {unsentVisible.length > 0 ? (
              <button
                className={`inline-flex items-center gap-1.5 whitespace-nowrap border border-phx-line bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:border-slate-400 ${adminControlDepthClassName}`}
                onClick={() => scrollToManagerGroup(UNSENT_GROUP_KEY)}
                type="button"
              >
                Not sent yet
                <span className="font-bold tabular-nums text-slate-500">{unsentVisible.length}</span>
              </button>
            ) : null}
          </div>
        ) : null}

        {/*
          Bulk send. One notification names everybody in it rather than one alert per candidate:
          the pool takes 152 CVs a week and the District Sales Managers receive nearly all of them,
          so per-person alerts are how a useful signal gets muted. Desktop only — the ticks live in
          the table, and picking twelve people out of a stack of cards on a phone is not a workflow.
        */}
        {canSelect && selectedVisibleIds.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-y border-orange-200 bg-orange-50 px-3 py-2">
            <span className="whitespace-nowrap text-xs font-semibold text-slate-700">
              {selectedVisibleIds.length} selected
            </span>
            {canManage ? (
            <>
            <div className="w-56 sm:w-64">
              <PositionPicker
                disabled={pending}
                freeArea={bulkFreeArea}
                freeTitle={bulkFreeTitle}
                onFreeAreaChange={setBulkFreeArea}
                onFreeTitleChange={setBulkFreeTitle}
                onVacancyChange={setBulkPosition}
                openVacancies={openVacancies}
                panelId="pool-position-bulk"
                vacancyChoice={bulkPosition}
              />
            </div>
            <div className="w-56 sm:w-72">
              <ManagerPicker
                disabled={pending}
                onChange={(hrIds) => setBulkManagerHrId(hrIds[0] ?? "")}
                options={hiringManagers}
                panelId="pool-manager-bulk"
                placeholder="Send all of them to…"
                value={bulkManagerHrId ? [bulkManagerHrId] : []}
              />
            </div>
            {bulkShelfFolders.length > 0 ? (
              <div className="w-56 sm:w-64">
                <FolderChoice disabled={pending} folders={bulkShelfFolders} onChange={setBulkManagerFolder} value={bulkChosenFolder} />
              </div>
            ) : null}
            <Button
              disabled={pending || !bulkManagerHrId}
              onClick={() =>
                run(async () => {
                  const data = await postJson("/api/recruitment/candidates/notify-manager", {
                    candidateIds: selectedVisibleIds,
                    managerHrId: bulkManagerHrId,
                    ...(bulkChosenFolder ? { folderArea: bulkChosenFolder } : {}),
                    ...positionBody(bulkPosition, bulkFreeArea, bulkFreeTitle),
                  });
                  const result = (data.result ?? {}) as { count?: unknown; managerName?: unknown };
                  const name = typeof result.managerName === "string" ? result.managerName : "the manager";
                  const count = typeof result.count === "number" ? result.count : selectedVisibleIds.length;
                  setSelectedIds([]);
                  setBulkManagerHrId("");
                  setBulkManagerFolder("");
                  setBulkPosition("");
                  setBulkFreeArea("");
                  setBulkFreeTitle("");
                  return `${count} ${count === 1 ? "candidate" : "candidates"} sent to ${name}.`;
                })
              }
            >
              Send
            </Button>
            </>
            ) : null}
            {/* MOVE TO ONE OF THE OWNER'S OWN FOLDERS — his words, 2026-09-18: make a folder called
                "Archive" and "cut the rejected CVs and put them there", so they stop appearing with
                all the CVs and a new one is easy to see. So: the Rejected tab, tick, Move. A CV moved
                into a folder he built appears only inside that folder (isInCvFolder), and it comes
                back from the folder's own screen with "Back to the pool". Gated on `candidates:
                update`, the grant the folder routes assert. */}
            {canFileCandidates && cvFolderChoices.length > 0 ? (
              <>
                <label className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-700">
                  Move to folder
                  <select
                    className={cn(phxSelectClassName, "sm:w-auto")}
                    disabled={pending}
                    onChange={(event) => setBulkFolderId(event.target.value)}
                    value={bulkFolderId}
                  >
                    <option value="">Pick a folder…</option>
                    {cvFolderChoices.map((node) => (
                      <option key={node.id} value={node.id}>
                        {`${"— ".repeat(node.depth - 1)}${node.name}`}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  disabled={pending || !bulkFolderId}
                  variant="secondary"
                  onClick={() =>
                    run(async () => {
                      const folder = cvFolderChoices.find((node) => node.id === bulkFolderId);
                      const count = selectedVisibleIds.length;
                      await postJson(`/api/recruitment/cv-folders/${bulkFolderId}/items`, {
                        candidateIds: selectedVisibleIds,
                        mode: "move",
                      });
                      setSelectedIds([]);
                      setBulkFolderId("");
                      return `${count} ${count === 1 ? "CV" : "CVs"} moved to ${folder ? folder.path.join(" › ") : "the folder"}.`;
                    })
                  }
                >
                  Move
                </Button>
              </>
            ) : null}
            {/* The ticks were already there for bulk-send; this is the same selection, read into
                screening mode instead. Sourced from visibleCandidates rather than the raw ids, so
                the queue opens in the same newest-first order the table is already showing. */}
            <Button
              variant="secondary"
              onClick={() =>
                setScreeningQueue(visibleCandidates.filter((candidate) => selectedVisibleIds.includes(candidate.id)))
              }
            >
              Screen selected
            </Button>
            <Button variant="ghost" onClick={() => setSelectedIds([])}>
              Clear selection
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-2 px-1 pb-2">
          <p className="min-w-0 flex-1 text-xs text-slate-600">
            {roleView
              ? poolRoleQuestionsCaption(roleView, tableColumns.length)
              : "The columns are the WhatsApp questions every applicant is asked. Pick a role to see that role's own questions."}
          </p>
          <PoolColumnChooser
            catalogue={columnCatalogue}
            columns={tableColumns}
            isCustom={savedColumns !== null}
            onChange={saveColumns}
            viewLabel={roleView ? candidateRoleFamilyLabels[roleView] : "all roles"}
          />
        </div>
        <PortalResponsiveDataList
          breakpoint="xl"
          empty={
            <RecruitmentEmptyState
              icon={<Users aria-hidden="true" className="h-5 w-5" />}
              message="Add a candidate above, or try a different search."
              title="No candidates found"
            />
          }
          getKey={(candidate) => candidate.id}
          items={displayedCandidates}
          renderCard={(candidate) => {
            // The mobile half of the grouping. Rendered above the first card of each pile rather
            // than as its own list level, because the wrapper this sits in is what carries the
            // divider between rows — a nested list would draw a second one.
            const groupHeader = groupHeaderByCandidateId.get(candidate.id) ?? null;
            return (
              <>
                {groupHeader ? (
                  <div
                    className="border-l-4 border-phx-accent bg-orange-50/70 px-4 py-2"
                    id={managerGroupAnchorId(groupHeader.key, "card")}
                  >
                    <ManagerGroupHeading
                      count={groupHeader.candidates.length}
                      lastSentAt={groupHeader.lastSentAt}
                      name={groupHeader.seat.name}
                      regionName={groupHeader.seat.regionName}
                      seatLabel={managerSeatLabel(groupHeader.seat)}
                    />
                  </div>
                ) : null}
                {candidate.id === firstUnsentId ? (
                  <div
                    className="border-l-4 border-slate-300 bg-slate-50 px-4 py-2"
                    id={managerGroupAnchorId(UNSENT_GROUP_KEY, "card")}
                  >
                    <ManagerGroupHeading
                      count={unsentVisible.length}
                      lastSentAt={null}
                      name="Not sent to a manager yet"
                      regionName={null}
                      seatLabel=""
                    />
                  </div>
                ) : null}
                <CandidatePoolCard
                  answerColumns={tableColumns}
                  areaOptions={areaOptions}
                  candidate={candidate}
                  candidateHref={candidatePageHref(candidatePageRoot, candidate.id)}
                  canDelete={canDelete}
                  canEditAnswers={canFileCandidates}
                  canManage={canManage}
                  folderJobTitles={folderJobTitles}
                  hiringManagers={hiringManagers}
                  isNew={isNewArrival(candidate)}
                  openProfile={openProfile}
                  openRequisitions={openRequisitions}
                  openVacancies={openVacancies}
                  pending={pending}
                  roleQuestionKeys={roleQuestionKeys}
                  run={run}
                  sendFreeArea={sendFreeArea}
                  sendFreeTitle={sendFreeTitle}
                  sendPosition={sendPosition}
                  sendTo={sendTo}
                  setSendFreeArea={setSendFreeArea}
                  setSendFreeTitle={setSendFreeTitle}
                  setSendPosition={setSendPosition}
                  setSendTo={setSendTo}
                  setStartReq={setStartReq}
                  startReq={startReq}
                  whatsappQuestions={whatsappQuestions}
                />
              </>
            );
          }}
          renderTable={() => (
            /*
             * Rebuilt 2026-08-20, re-cut 2026-08-24, and now on the shared fits-the-screen
             * primitive: `PortalDesktopTable` is `table-fixed w-full` and its cells wrap, so the
             * table is always exactly as wide as its container and never scrolls sideways. The
             * `cols` colgroup below keeps Candidate pinned to the width its own longest production
             * name needs (332px — re-measured 2026-08-24, floor is 323px) and lets Role/"Applying
             * for" — the one fact that decides who a CV goes to — take whatever is left, exactly as
             * before; the five narrower facts (Region, Experience, Status, Received, Actions) are
             * now percentages of the table's own width so they shrink with the viewport instead of
             * forcing a scrollbar. table-fixed means the browser obeys the declared widths instead
             * of sizing columns to their widest cell, so a single 185-character intake blob can no
             * longer widen the table. Below `xl` the paired card list carries the pool instead of
             * this dense table — narrower than that, Candidate's 332px pin alone would leave Role
             * too thin to read.
             *
             * Email and Phone lost their own columns and moved under the name. In production 258
             * of 555 rows have no email and 316 no phone, so two columns were spending ~340px to
             * show a dash most of the time.
             */
            <PortalDesktopTable
              breakpoint="xl"
              className="table-fixed"
              cols={
                /*
                 * Candidate and the select box are the only fixed-pixel columns — Candidate must
                 * stay pinned in px (never a percentage) because the pool table regression test
                 * pins this exact shape: a `<col className="w-[Npx]" />` immediately followed by a
                 * bare `<col />` for Role, so a future edit that reintroduces a starved "Applying
                 * for" column fails loudly instead of shipping quietly. The remaining five columns
                 * are percentages of the table's own width, sized from the same cell-by-cell
                 * production measurement (Region 112, Experience 124, Status 96, Received 156,
                 * Actions 220, out of the ~924px this table renders at from `xl`): Source stopped
                 * being a column and became a badge on the Received cell's second line; the employer
                 * is deliberately absent (its strings reach 285 chars) and lives on the profile
                 * card, where the text can breathe.
                 */
                /*
                 * Since 2026-10-19 the columns are the WhatsApp questions, and Status and Received
                 * moved under the name (the Candidate cell's third line) to give them the room: the
                 * shared five are Applying for (the flexible one) and four narrow answers.
                 *
                 * Widened 2026-10-19 ("fix the cramped Expected salary column"): at a 1280px window
                 * the table is 1,203px and the answers were 96 / 108 / 96 / 84px while Applying for
                 * took 318px, so the answer editor opened in 84px and "Biotechnology" broke mid-word.
                 * The answers now take 10 / 10 / 9 / 9%, leaving Applying for about 247px there and
                 * about 104px at the ~924px the table renders from `xl`.
                 */
                usesPinnedLayout ? (
                <colgroup>
                  {canSelect ? <col className="w-[36px]" /> : null}
                  <col className="w-[332px]" />
                  <col />
                  <col className="w-[10%]" />
                  <col className="w-[10%]" />
                  <col className="w-[9%]" />
                  <col className="w-[9%]" />
                  <col className="w-[11%]" />
                </colgroup>
                ) : (
                  /* A role's own questions, or a layout the reader chose: the name keeps a quarter,
                     the questions share the rest equally, so eight questions still fit the screen. */
                  <colgroup>
                    {canSelect ? <col className="w-[36px]" /> : null}
                    <col className="w-[24%]" />
                    {tableColumns.map((column) => (
                      <col key={column.key} />
                    ))}
                    <col className="w-[11%]" />
                  </colgroup>
                )
              }
            >
              {/* No colours here on purpose. The admin shell's locked rules in globals.css paint
                  every `thead th` black, centred and 0.78rem with !important, so the header already
                  matches every other admin table — restating it locally would only be a lie the next
                  reader has to check. Padding is all that is left to say. */}
              <thead className="font-black uppercase tracking-[0.08em]">
                <tr>
                  {canSelect ? (
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
                  {/* The WhatsApp bot's own questions, in sentence case: they are questions, and a
                      sentence in capitals is slower to read than the answer under it. A cell's
                      answer is in plain type; grey italic is the CV standing in where the bot never
                      asked, and its tooltip says so. */}
                  {tableColumns.map((column) => (
                    <th
                      className="px-2 py-2.5 normal-case tracking-normal"
                      dir="auto"
                      key={column.key}
                      title={column.key === "place" ? POOL_PLACE_HEADER_TITLE : (column.askedTo ?? undefined)}
                    >
                      {column.header}
                    </th>
                  ))}
                  <th className="px-3 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {displayedCandidates.map((candidate) => {
                  const displayName = candidateDisplayName(candidate.fullName);
                  const contact = [candidate.email, candidate.phone].filter(Boolean).join(" · ");
                  const emailProblem = candidateEmailProblem(candidate.email);
                  // The desktop half of the grouping. A full-width heading row rather than a
                  // nested table, so all 200 lines of the row renderer below stay exactly as they
                  // are and the columns cannot come to disagree between one pile and the next.
                  const groupHeader = groupHeaderByCandidateId.get(candidate.id) ?? null;
                  const headingColSpan = (canSelect ? 1 : 0) + tableColumns.length + 2;
                  const whatsappAnswers = answersByCandidateId.get(candidate.id) ?? new Map<string, string>();
                  // The five built-in columns' cells — the same cells whichever view shows them, each
                  // keyed by its column so a reader's layout can put them in any order.
                  const sharedCells = poolSharedCells(candidate);
                  return (
                    <Fragment key={candidate.id}>
                      {groupHeader ? (
                        <tr className="bg-orange-50/70" id={managerGroupAnchorId(groupHeader.key, "table")}>
                          <td className="border-l-4 border-phx-accent px-3 py-2" colSpan={headingColSpan}>
                            <ManagerGroupHeading
                              count={groupHeader.candidates.length}
                              lastSentAt={groupHeader.lastSentAt}
                              name={groupHeader.seat.name}
                              regionName={groupHeader.seat.regionName}
                              seatLabel={managerSeatLabel(groupHeader.seat)}
                            />
                          </td>
                        </tr>
                      ) : null}
                      {candidate.id === firstUnsentId ? (
                        <tr className="bg-slate-50" id={managerGroupAnchorId(UNSENT_GROUP_KEY, "table")}>
                          <td className="border-l-4 border-slate-300 px-3 py-2" colSpan={headingColSpan}>
                            <ManagerGroupHeading
                              count={unsentVisible.length}
                              lastSentAt={null}
                              name="Not sent to a manager yet"
                              regionName={null}
                              seatLabel=""
                            />
                          </td>
                        </tr>
                      ) : null}
                    <tr className="align-top transition-colors hover:bg-orange-50/50">
                      {canSelect ? (
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
                          {/* The name opens everything on file for this person, in a new tab, so
                              the filtered pool is still here when that tab is closed. */}
                          <a
                            className="min-w-0 break-words font-semibold text-phx-ink hover:text-orange-600 hover:underline"
                            href={candidatePageHref(candidatePageRoot, candidate.id)}
                            rel="noopener"
                            target="_blank"
                            title={candidate.fullName}
                          >
                            {displayName}
                          </a>
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
                              surface the recruiting seat actually works in — never showed it. */}
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
                        <div className="mt-0.5 break-words text-phx-xs text-slate-500" title={contact || undefined}>
                          {contact || <span className="text-slate-300">No contact details</span>}
                        </div>
                        {/* An address that cannot receive mail (owner, 2026-10-19 — "Stop broken
                            emails at intake"). Flagged with the likely address, never rewritten: the
                            email is also the duplicate-check key, so a person confirms it. */}
                        {emailProblem ? (
                          <div className="mt-0.5">
                            <StagePill tone="amber">
                              <span title={emailProblem.explanation}>{EMAIL_CHECK_LABEL}</span>
                            </StagePill>
                          </div>
                        ) : null}
                        {/* Status, then when it landed (Cairo time) and on which channel — under the
                            name since 2026-10-19, when their two columns went to the WhatsApp
                            questions. The reason for the status is the pill's tooltip; the sender's
                            own words are the date's (never drawn: `shortLabel` reaches 1,546
                            characters, and is on the mobile card under "Their words"). */}
                        <div
                          className="mt-1 flex flex-wrap items-center gap-1.5 text-phx-xs text-slate-600"
                          title={candidate.sourceContext?.detailLines.join("\n") || undefined}
                        >
                          <StagePill tone={candidateStatusTone(candidate.status)}>
                            <span title={candidate.statusNote ?? undefined}>{candidateStatusLabel(candidate.status)}</span>
                          </StagePill>
                          <span className="break-words">{cairoDateTime(candidate.createdAt)}</span>
                          {isNewArrival(candidate) ? <StagePill tone="orange">New</StagePill> : null}
                          {(() => {
                            const channel = candidateSourceChannel(candidate.source, candidate.sourceContext);
                            return (
                              <StagePill tone={sourceChannelTone[channel.key]}>
                                <span title={channel.title}>{channel.label}</span>
                              </StagePill>
                            );
                          })()}
                        </div>
                      </td>
                      {tableColumns.map((column) => {
                        const shared = (poolSharedColumnKeys as readonly string[]).includes(column.key)
                          ? sharedCells[column.key as PoolSharedColumnKey]
                          : null;
                        const currentValues = poolCurrentAnswerValues(candidate, column, whatsappAnswers);
                        return (
                          <PoolEditableCell
                            canEdit={canFileCandidates}
                            className={shared?.className ?? "px-2 py-2.5"}
                            column={column}
                            currentValues={currentValues}
                            editing={editingCell?.candidateId === candidate.id && editingCell.columnKey === column.key}
                            key={column.key}
                            onCancel={() => setEditingCell(null)}
                            onSave={(values) =>
                              run(async () => {
                                await savePoolColumnAnswers(candidate.id, column, values, currentValues);
                                setEditingCell(null);
                                return `Saved the answer to "${column.header}" for ${displayName}.`;
                              })
                            }
                            onStartEdit={() => setEditingCell({ candidateId: candidate.id, columnKey: column.key })}
                            pending={pending}
                          >
                            {shared ? shared.content : <PoolAnswerText answer={whatsappAnswers.get(column.key) ?? null} />}
                          </PoolEditableCell>
                        );
                      })}
                      <td className="px-3 py-2.5">
                        <CandidateActionsControl
                          areaOptions={areaOptions}
                          candidate={candidate}
                          canDelete={canDelete}
                          canManage={canManage}
                          folderJobTitles={folderJobTitles}
                          hiringManagers={hiringManagers}
                          openPanel={openRowPanel?.id === candidate.id ? openRowPanel.panel : null}
                          openProfile={openProfile}
                          openRequisitions={openRequisitions}
                          openVacancies={openVacancies}
                          pending={pending}
                          run={run}
                          sendFreeArea={sendFreeArea}
                          sendFreeTitle={sendFreeTitle}
                          sendPosition={sendPosition}
                          sendTo={sendTo}
                          setOpenPanel={(panel) => setOpenRowPanel(panel ? { id: candidate.id, panel } : null)}
                          setSendFreeArea={setSendFreeArea}
                          setSendFreeTitle={setSendFreeTitle}
                          setSendPosition={setSendPosition}
                          setSendTo={setSendTo}
                          setStartReq={setStartReq}
                          startReq={startReq}
                        />
                      </td>
                    </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </RecruitmentPanel>

      {profile ? (
        <div ref={profilePanelRef} className={`space-y-3 border border-slate-200 bg-white p-4 sm:p-5 ${adminPanelDepthClassName}`}>
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
              className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border border-phx-line bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-phx-accent-line hover:text-phx-accent ${adminControlDepthClassName}`}
              onClick={returnToPool}
              type="button"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to the pool
            </button>
            <p className="break-words text-xs text-slate-500" title={profile.candidate.fullName}>
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
              className="fixed bottom-6 right-6 z-50 inline-flex items-center gap-1.5 whitespace-nowrap border border-phx-accent-line bg-white px-4 py-2.5 text-xs font-semibold text-phx-accent shadow-[0_10px_30px_rgba(15,23,42,0.18)] transition hover:bg-phx-accent-soft"
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
              {/* Answering them on WhatsApp, directly under the number it would be sent to. Gated on
                  canManage, the same recruitment:update the route enforces, so a reader is not shown
                  a box that would refuse them. It draws only a small button until opened, and checks
                  the 24-hour window before offering to type — see whatsapp-reply-box.tsx.

                  Their LinkedIn profile sits beside it, because it is the other way of reaching the
                  person (the owner asked for it there, 2026-09-18). NOT gated on canManage: it opens a
                  page and changes nothing, and anybody on this panel can already read the email and
                  phone printed above it. It wraps under the reply box's panel when that is opened,
                  which is `w-full`, and comes back beside the button when it is closed.

                  Schedule interview closes the row (owner, 2026-09-18: "from any screen, any CV"). It
                  gates itself on the interview calendar's own sharing, not on canManage, and draws
                  nothing for anyone who cannot book — which is why the row is always mounted and
                  `empty:hidden` takes its margin back when nothing in it drew. */}
              <div className="mt-2 flex flex-wrap items-center gap-2 empty:hidden">
                {canManage ? <WhatsAppReplyBox candidateId={profile.candidate.id} /> : null}
                <LinkedInProfileLink linkedinUrl={profile.candidate.linkedinUrl} />
                <ScheduleInterviewButton
                  candidate={{
                    id: profile.candidate.id,
                    jobTitle: profile.candidate.appliedForJobTitle,
                    name: profile.candidate.fullName,
                  }}
                />
              </div>
            </div>
            <Button variant="ghost" onClick={returnToPool}>
              Close
            </Button>
          </div>

          {/* Who this person is. Same block, same module, as screening mode — extracted
              2026-08-24 so the drawer and the queue can never drift apart. */}
          <CandidateFactsSummary
            candidate={profile.candidate}
            extraction={storedExtraction}
            screeningQuestions={screeningQuestions}
          />

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
              <div className={`border border-slate-200 bg-white p-3 ${adminSoftDepthClassName}`}>
                <p className="text-phx-xs font-semibold uppercase tracking-wide text-slate-500">Applying for</p>
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
            <div className={`border border-slate-200 bg-slate-50/60 p-3 ${adminRecessedDepthClassName}`}>
              <p className="text-phx-xs font-semibold uppercase tracking-wide text-slate-500">
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
                <div className="flex flex-wrap items-center justify-between gap-2 border border-orange-200 bg-orange-50/70 p-3">
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
                      className={phxSelectClassName}
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

          {screeningQueue ? (
            <CandidateScreeningSession
              candidates={screeningQueue}
              // Deliberately the list BEFORE the red split, with the pool's current tab passed
              // through. The queue owns its own tab strip, so handing it the already-split list
              // would leave it with a Red-flagged tab that read zero however many red CVs the
              // search had actually turned up.
              initialCvTab={cvTab}
              // `canManage` is the pool's own `recruitment: update` gate, and it is the same grant
              // the send route enforces — so a reader who cannot send simply gets no picker here,
              // exactly as on the standalone page.
              hiringManagers={canManage ? hiringManagers : []}
              onClose={(decidedCount) => {
                setScreeningQueue(null);
                // Only pay for a reload when something actually changed. Leaving the queue after
                // reading a few is free.
                if (decidedCount > 0) router.refresh();
              }}
            />
          ) : null}

          {viewCvFile ? (
            <CvPreviewModal
              downloadUrl={`/api/recruitment/files/${viewCvFile.id}/download`}
              fileName={viewCvFile.fileName}
              headerActions={
                <ScheduleInterviewButton
                  candidate={{
                    id: profile.candidate.id,
                    jobTitle: profile.candidate.appliedForJobTitle,
                    name: profile.candidate.fullName,
                  }}
                />
              }
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
              <li key={interview.id} className={`border border-slate-200 bg-white p-2.5 text-xs ${adminSoftDepthClassName}`}>
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                  <span className="font-bold text-slate-900">{humanizeRecruitmentTerm(interview.interviewType)}</span>
                  <span className="tabular-nums text-slate-500">
                    {interview.scheduledAt ? cairoDateTime(interview.scheduledAt) : "Unscheduled"}
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
                            className={cn(phxFieldClassName, "w-16")}
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
  candidateName,
  canUpload,
  error,
  files,
  filesEnabled,
  onReload,
}: {
  candidateId: string;
  /** For the preview's Schedule interview button, which needs a name to put on the calendar. */
  candidateName: string | null;
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
          headerActions={
            candidateName ? <ScheduleInterviewButton candidate={{ id: candidateId, name: candidateName }} /> : null
          }
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
