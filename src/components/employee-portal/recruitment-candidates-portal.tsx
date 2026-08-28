"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
import { APPLIED_FOR_SOURCE_LABEL, candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import type { ApplicationWithContext } from "@/lib/recruitment/applications";
import {
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  candidateStatusLabel,
  hiringManagerDecisionLabels,
  isUnreviewedCandidateStatus,
  type HiringManagerDecision,
} from "@/lib/recruitment/candidate-status";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { groupCandidatesByPosition } from "@/lib/recruitment/position-folder";
import type { Candidate, Interview } from "@/lib/recruitment/types";

type Props = {
  initialApplications: ApplicationWithContext[];
  /**
   * The CVs a recruiter pushed STRAIGHT to this manager — no requisition, no application, no seat on
   * the org chart. This is the flow the module is actually used for; the applications above are the
   * long way round, taken 7 times in the module's history against 226 candidates.
   */
  initialSentToMe: Candidate[];
};

type CandidateFileSummary = { id: string; fileName: string; kind: string; mimeType: string | null };

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Request failed.");
  return data;
}

async function sendJson(url: string, method: "POST" | "PATCH", body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Request failed.");
  return data;
}

// A narrow, DM-relevant subset of the full 26-stage pipeline — everything else (CV/phone
// screening, interview scheduling) is Talent Acquisition's own stage, shown as a neutral
// "with Talent Acquisition" badge below.
const stageLabels: Record<string, { label: string; tone: string }> = {
  application_rejected: { label: "Not qualified", tone: "border-rose-200 bg-rose-50 text-rose-700" },
  application_withdrawn: { label: "Withdrawn", tone: "border-slate-200 bg-slate-100 text-slate-500" },
  final_selection: { label: "Final selection (Talent Acquisition)", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  hired: { label: "Hired", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  hiring_manager_interview: { label: "Ready for your interview", tone: "border-amber-200 bg-amber-50 text-amber-700" },
  manager_interview_completed: { label: "Passed to Talent Acquisition", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
};

function stageBadge(stage: string) {
  return stageLabels[stage] ?? { label: "With Talent Acquisition", tone: "border-slate-200 bg-slate-50 text-slate-500" };
}

function formatYesNo(value: boolean | null | undefined) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Not stated";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

// Every moment shown to a person is Cairo local time, never a raw UTC string. Written here rather
// than imported, matching the copies in recruitment-workspace.tsx and intake-health-view.tsx — the
// three differ in separator and empty-value, and this one matches the workspace, which is the screen
// a recruiter is looking at when they talk to the manager about the same candidate.
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
  const time = value.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" });
  return `${date} · ${time}`;
}

/**
 * View CV / Download, for any candidate the caller is allowed to see.
 *
 * Shared by both cards below because the rule it encodes is not obvious and must not be re-derived:
 * "View CV" has to actually VIEW the CV. The bare file route serves Content-Disposition: attachment
 * unless asked for "inline", so a plain link saves the file and shows the manager nothing — and a
 * download manager will intercept it besides. The preview modal renders the real document, so it IS
 * the view action here; saving a copy sits beside it rather than being the only behaviour.
 */
function CandidateCvActions({ candidateId }: { candidateId: string }) {
  const [files, setFiles] = useState<CandidateFileSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await getJson(`/api/recruitment/hiring-manager/candidates/${candidateId}/files`);
        if (!active) return;
        setFiles(Array.isArray(data.files) ? (data.files as CandidateFileSummary[]) : []);
      } catch {
        /* leave empty — the card still shows the candidate's own details */
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [candidateId]);

  const cvFile = files.find((file) => file.kind === "cv");
  // "unsupported" means the preview modal cannot render this file type, so saving it is the only way
  // to read it — that is the one case where the CV button may still be a download.
  const cvKind = cvFile ? detectCvFileKind(cvFile.mimeType ?? "", cvFile.fileName) : "unsupported";
  const href = cvFile ? `/api/recruitment/hiring-manager/candidates/${candidateId}/files/${cvFile.id}` : "";

  if (!loaded) return null;
  if (!cvFile) return <p className="text-xs text-slate-400">No CV file on record.</p>;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {cvKind !== "unsupported" ? (
          <Button variant="secondary" onClick={() => setPreviewOpen(true)}>
            View CV — {cvFile.fileName}
          </Button>
        ) : null}
        <a
          className="inline-flex w-fit items-center rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
          href={href}
          rel="noreferrer"
          target="_blank"
        >
          {cvKind === "unsupported" ? `Download — ${cvFile.fileName}` : "Download"}
        </a>
      </div>
      {previewOpen ? (
        <CvPreviewModal
          downloadUrl={href}
          fileName={cvFile.fileName}
          mimeType={cvFile.mimeType}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </>
  );
}

const hiringManagerCriteria = [
  { key: "territory_knowledge", label: "Territory knowledge" },
  { key: "sales_skills", label: "Sales skills" },
  { key: "business_awareness", label: "Business awareness" },
  { key: "product_knowledge", label: "Product knowledge" },
  { key: "customer_handling", label: "Customer handling" },
] as const;

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="text-slate-700">{value?.trim() ? value : "—"}</p>
    </div>
  );
}

function CandidateCard({ application, onChanged }: { application: ApplicationWithContext; onChanged: () => void }) {
  const candidate = application.candidate!;
  const requisition = application.requisition!;
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scheduledAt, setScheduledAt] = useState("");
  const [location, setLocation] = useState("");
  const [meetingLink, setMeetingLink] = useState("");
  const [scores, setScores] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const interviewsData = await getJson(`/api/recruitment/hiring-manager/applications/${application.id}/interviews`);
        if (!active) return;
        setInterviews(Array.isArray(interviewsData.interviews) ? (interviewsData.interviews as Interview[]) : []);
      } catch {
        /* leave empty — the card still shows the candidate's own details */
      }
    })();
    return () => {
      active = false;
    };
  }, [application.id]);

  const hmInterview = interviews.find((interview) => interview.interviewType === "hiring_manager") ?? null;
  const badge = stageBadge(application.stage);
  const canAct = application.stage === "hiring_manager_interview";

  const schedule = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await sendJson(`/api/recruitment/hiring-manager/applications/${application.id}/interviews`, "POST", {
        interviewType: "hiring_manager",
        location: location || undefined,
        meetingLink: meetingLink || undefined,
        scheduledAt: scheduledAt || undefined,
      });
      // Update local state directly — onChanged() only refreshes the parent's application
      // list, which doesn't change this card's own [candidate.id, application.id] effect
      // dependencies, so it would never re-fetch this card's interviews on its own.
      if (data.interview) setInterviews((prev) => [data.interview as Interview, ...prev]);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to schedule the interview.");
    } finally {
      setBusy(false);
    }
  };

  const recordOutcome = async (decision: "proceed" | "not_qualified") => {
    if (!hmInterview) return;
    if (decision === "not_qualified" && !notes.trim()) {
      setError("Add a short reason before marking the candidate not qualified.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const numericScores: Record<string, number> = {};
      for (const [key, value] of Object.entries(scores)) {
        const n = Number(value);
        if (Number.isFinite(n) && value !== "") numericScores[key] = n;
      }
      const outcomeData = await sendJson(`/api/recruitment/hiring-manager/interviews/${hmInterview.id}`, "PATCH", {
        notes,
        outcome: decision === "proceed" ? "recommended" : "rejected",
        score: numericScores,
      });
      if (outcomeData.interview) {
        const updated = outcomeData.interview as Interview;
        setInterviews((prev) => prev.map((interview) => (interview.id === updated.id ? updated : interview)));
      }
      await sendJson(`/api/recruitment/hiring-manager/applications/${application.id}/workflow`, "POST", {
        action: decision === "proceed" ? "app_record_hm_interview" : "app_reject",
        reason: decision === "not_qualified" ? notes : undefined,
      });
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to record the interview outcome.");
    } finally {
      setBusy(false);
    }
  };

  const tenureLine = [
    candidate.medicalRepEmployer,
    [formatDate(candidate.medicalRepExperienceFrom), formatDate(candidate.medicalRepExperienceTo)]
      .filter(Boolean)
      .join(" – "),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-slate-900">{candidate.fullName}</p>
          <p className="text-xs text-slate-500">
            {requisition.jobTitle} · {requisition.requisitionCode}
          </p>
        </div>
        <span className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold ${badge.tone}`}>
          {badge.label}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Email" value={candidate.email} />
        <Field label="Phone" value={candidate.phone} />
        <Field label="Governorate" value={candidate.governorate} />
        <Field label="Address" value={candidate.address} />
        <Field label="Faculty" value={candidate.faculty} />
        <Field label="University" value={candidate.university} />
        <Field label="Prior work experience" value={formatYesNo(candidate.hasPriorWorkExperience)} />
        <Field label="Medical Rep experience" value={formatYesNo(candidate.hasMedicalRepExperience)} />
        {candidate.hasMedicalRepExperience ? <Field label="Medical Rep tenure" value={tenureLine} /> : null}
      </div>

      <CandidateCvActions candidateId={candidate.id} />

      {error ? <p className="text-xs text-rose-600">{error}</p> : null}

      {canAct && !hmInterview ? (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Schedule your interview</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              className="rounded-md border border-gray-200 px-3 py-2 text-sm"
              onChange={(event) => setScheduledAt(event.target.value)}
              type="datetime-local"
              value={scheduledAt}
            />
            <input
              className="rounded-md border border-gray-200 px-3 py-2 text-sm"
              onChange={(event) => setLocation(event.target.value)}
              placeholder="Location (or phone/video)"
              value={location}
            />
            <input
              className="rounded-md border border-gray-200 px-3 py-2 text-sm"
              onChange={(event) => setMeetingLink(event.target.value)}
              placeholder="Meeting link (optional)"
              value={meetingLink}
            />
          </div>
          <Button disabled={busy || !scheduledAt} onClick={schedule} size="sm">
            Schedule interview
          </Button>
        </div>
      ) : null}

      {canAct && hmInterview && !hmInterview.outcome ? (
        <div className="space-y-3 border-t border-slate-100 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Interview{hmInterview.scheduledAt ? ` on ${formatDate(hmInterview.scheduledAt)}` : ""} — record your feedback
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {hiringManagerCriteria.map((criterion) => (
              <label className="flex items-center justify-between gap-2 text-xs text-slate-600" key={criterion.key}>
                {criterion.label}
                <select
                  className="rounded-md border border-gray-200 px-2 py-1 text-sm"
                  onChange={(event) => setScores((prev) => ({ ...prev, [criterion.key]: event.target.value }))}
                  value={scores[criterion.key] ?? ""}
                >
                  <option value="">—</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <textarea
            className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Feedback notes"
            rows={2}
            value={notes}
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => recordOutcome("proceed")} size="sm">
              Proceed to second interview
            </Button>
            <Button disabled={busy} onClick={() => recordOutcome("not_qualified")} size="sm" variant="destructive">
              Not qualified
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * A CV a recruiter sent straight to this manager, and the two answers they can give back.
 *
 * The whole module exists to get to this card: a CV arrives, the AI reads it, a recruiter sends the
 * person to the District Manager who would actually work with them. Everything the manager needs to
 * answer is on the card — the extracted details, the CV itself, and the two buttons — because the
 * alternative is the state this replaced, where the alert arrived and pointed at a page the manager
 * was not allowed to open.
 */
function SentCandidateCard({ candidate: initial }: { candidate: Candidate }) {
  const [candidate, setCandidate] = useState(initial);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const notified = candidate.managerNotified;
  // Only an untouched candidate still needs an answer. Once the manager (or Talent Acquisition) has
  // moved them, the card shows what was decided instead of offering the buttons again — a second
  // "Not interested" on somebody already rejected writes a new event and tells nobody anything.
  const awaitingAnswer = isUnreviewedCandidateStatus(candidate.status) || candidate.status === "sent_to_manager";

  const answer = async (decision: HiringManagerDecision) => {
    if (decision === "not_interested" && !note.trim()) {
      setError("Add a short reason so Talent Acquisition knows why.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await sendJson(`/api/recruitment/hiring-manager/candidates/${candidate.id}/decision`, "PATCH", {
        decision,
        note: note.trim() || undefined,
      });
      if (data.candidate) setCandidate(data.candidate as Candidate);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to record your answer.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-slate-900">{candidate.fullName}</p>
          {/* The one question a manager opens this card to answer. Read through the same evidence
              ladder the pool table uses, because `applied_for_job_title` is filled on 15 of the 555
              production rows — reading only that made this line say "no role stated" on 540 CVs.
              The source is named in the hover text, so a derived role never reads as a stated one. */}
          {(() => {
            const appliedFor = candidateRowAppliedFor(candidate);
            return (
              <p
                className="text-xs text-slate-500"
                title={appliedFor.source ? `${APPLIED_FOR_SOURCE_LABEL[appliedFor.source]}: ${appliedFor.evidence}` : undefined}
              >
                {appliedFor.text ? `Applying for ${appliedFor.text}` : "No role stated on the application"}
              </p>
            );
          })()}
        </div>
        <span className="inline-block rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
          {candidateStatusLabel(candidate.status)}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Phone" value={candidate.phone} />
        <Field label="Email" value={candidate.email} />
        <Field label="Governorate" value={candidate.governorate} />
        <Field label="Current job title" value={candidate.currentJobTitle} />
        <Field label="Current employer" value={candidate.currentEmployer} />
        <Field
          label="Years of experience"
          value={candidate.yearsExperience === null ? null : String(candidate.yearsExperience)}
        />
        <Field label="Medical Rep experience" value={formatYesNo(candidate.hasMedicalRepExperience)} />
        <Field label="CV received" value={cairoDateTime(candidate.createdAt)} />
        <Field label="Sent to you" value={notified ? cairoDateTime(notified.sentAt) : null} />
      </div>

      <CandidateCvActions candidateId={candidate.id} />

      {error ? <p className="text-xs text-rose-600">{error}</p> : null}

      {awaitingAnswer ? (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Your answer</p>
          <textarea
            className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
            maxLength={CANDIDATE_STATUS_NOTE_MAX_LENGTH}
            onChange={(event) => setNote(event.target.value)}
            placeholder="A short note for Talent Acquisition (required if you are not interested)"
            rows={2}
            value={note}
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void answer("interview")} size="sm">
              {hiringManagerDecisionLabels.interview}
            </Button>
            <Button disabled={busy} onClick={() => void answer("not_interested")} size="sm" variant="destructive">
              {hiringManagerDecisionLabels.not_interested}
            </Button>
          </div>
        </div>
      ) : (
        <div className="border-t border-slate-100 pt-3">
          <p className="text-xs text-slate-500">
            You answered: {candidateStatusLabel(candidate.status)}
            {candidate.statusNote?.trim() ? ` — ${candidate.statusNote}` : ""}
          </p>
        </div>
      )}
    </Card>
  );
}

export function RecruitmentCandidatesPortal({ initialApplications, initialSentToMe: sentToMe }: Props) {
  const [applications, setApplications] = useState(initialApplications);

  // Folded on the SAME function the recruiter's screen and the tests use, so a folder cannot mean
  // one thing where it is created and another where it is read.
  const { folders: positionFolders, unfiled: unfiledSends } = useMemo(
    () => groupCandidatesByPosition(sentToMe),
    [sentToMe],
  );

  const reload = async () => {
    try {
      const data = await getJson("/api/recruitment/hiring-manager/applications");
      const list = Array.isArray(data.applications) ? (data.applications as ApplicationWithContext[]) : [];
      setApplications(list.filter((application) => application.candidate && application.requisition));
    } catch {
      /* keep the current list on a transient reload failure */
    }
  };

  if (applications.length === 0 && sentToMe.length === 0) {
    return (
      <Card className="rounded-lg border border-gray-200 bg-white p-10 text-center shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
        <p className="text-base font-semibold text-slate-700">No candidates yet</p>
        <p className="mt-1 text-sm text-slate-400">
          CVs that Talent Acquisition sends you, and candidates assigned to your open positions, will appear here.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Sent-to-you first, deliberately: this is the list the notification links to, and it is the
          one that needs an answer. The requisition-based applications below are the longer route
          and are already sitting in a workflow. */}
      {sentToMe.length > 0 ? (
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Sent to you</h2>
            <p className="text-xs text-slate-500">CVs Talent Acquisition asked you to look at.</p>
          </div>
          {/* ── One folder per position ───────────────────────────────────────────────────────
              The owner, 2026-08-28: "he goes to a folder called Nasr City Medical Reps ... he can
              look at the same page when he wants a certain position." A manager filling a seat
              reads the CVs for that seat together, and a flat newest-first list interleaves five
              vacancies, so comparing two candidates for one job means scrolling past three for
              other ones.

              A single folder is a list with a heading on it, so the headings only appear once
              there is genuinely something to separate. */}
          {positionFolders.length > 1
            ? positionFolders.map((folder) => (
                <div className="space-y-3" key={folder.key}>
                  <div className="flex items-baseline justify-between gap-3 border-b border-slate-200 pb-1">
                    <h3 className="text-sm font-bold text-slate-800">{folder.label}</h3>
                    <span className="shrink-0 text-xs font-semibold text-slate-500">
                      {folder.candidates.length === 1 ? "1 CV" : `${folder.candidates.length} CVs`}
                    </span>
                  </div>
                  {folder.candidates.map((candidate) => (
                    <SentCandidateCard candidate={candidate} key={candidate.id} />
                  ))}
                </div>
              ))
            : positionFolders.flatMap((folder) =>
                folder.candidates.map((candidate) => <SentCandidateCard candidate={candidate} key={candidate.id} />),
              )}
          {/* Sent before a position could be chosen, or sent without one. Never hidden — each is a
              real person somebody was asked to review — but kept apart from the folders rather than
              filed under an invented heading that would read like a vacancy of its own. */}
          {unfiledSends.length > 0 ? (
            <div className="space-y-3">
              {positionFolders.length > 0 ? (
                <div className="flex items-baseline justify-between gap-3 border-b border-slate-200 pb-1">
                  <h3 className="text-sm font-bold text-slate-800">No position given</h3>
                  <span className="shrink-0 text-xs font-semibold text-slate-500">
                    {unfiledSends.length === 1 ? "1 CV" : `${unfiledSends.length} CVs`}
                  </span>
                </div>
              ) : null}
              {unfiledSends.map((candidate) => (
                <SentCandidateCard candidate={candidate} key={candidate.id} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {applications.length > 0 ? (
        <section className="space-y-4">
          {sentToMe.length > 0 ? (
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Your open positions</h2>
              <p className="text-xs text-slate-500">Candidates assigned to a position you are the hiring manager for.</p>
            </div>
          ) : null}
          {applications.map((application) => (
            <CandidateCard application={application} key={application.id} onChanged={reload} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
