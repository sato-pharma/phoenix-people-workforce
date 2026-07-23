"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ApplicationWithContext } from "@/lib/recruitment/applications";
import type { Interview } from "@/lib/recruitment/types";

type Props = { initialApplications: ApplicationWithContext[] };

type CandidateFileSummary = { id: string; fileName: string; kind: string };

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
  const [files, setFiles] = useState<CandidateFileSummary[]>([]);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [loaded, setLoaded] = useState(false);
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
        const [filesData, interviewsData] = await Promise.all([
          getJson(`/api/recruitment/hiring-manager/candidates/${candidate.id}/files`),
          getJson(`/api/recruitment/hiring-manager/applications/${application.id}/interviews`),
        ]);
        if (!active) return;
        setFiles(Array.isArray(filesData.files) ? (filesData.files as CandidateFileSummary[]) : []);
        setInterviews(Array.isArray(interviewsData.interviews) ? (interviewsData.interviews as Interview[]) : []);
      } catch {
        /* leave empty — the card still shows the candidate's own details */
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [candidate.id, application.id]);

  const cvFile = files.find((file) => file.kind === "cv");
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

      {loaded && cvFile ? (
        <a
          className="inline-flex w-fit items-center rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
          href={`/api/recruitment/hiring-manager/candidates/${candidate.id}/files/${cvFile.id}`}
          rel="noreferrer"
          target="_blank"
        >
          View CV — {cvFile.fileName}
        </a>
      ) : loaded ? (
        <p className="text-xs text-slate-400">No CV file on record.</p>
      ) : null}

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

export function RecruitmentCandidatesPortal({ initialApplications }: Props) {
  const [applications, setApplications] = useState(initialApplications);

  const reload = async () => {
    try {
      const data = await getJson("/api/recruitment/hiring-manager/applications");
      const list = Array.isArray(data.applications) ? (data.applications as ApplicationWithContext[]) : [];
      setApplications(list.filter((application) => application.candidate && application.requisition));
    } catch {
      /* keep the current list on a transient reload failure */
    }
  };

  if (applications.length === 0) {
    return (
      <Card className="rounded-lg border border-gray-200 bg-white p-10 text-center shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
        <p className="text-base font-semibold text-slate-700">No candidates yet</p>
        <p className="mt-1 text-sm text-slate-400">
          Candidates assigned to your open positions by Talent Acquisition will appear here.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {applications.map((application) => (
        <CandidateCard application={application} key={application.id} onChanged={reload} />
      ))}
    </div>
  );
}
