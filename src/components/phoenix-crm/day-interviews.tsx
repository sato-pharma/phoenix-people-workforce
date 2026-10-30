"use client";

/**
 * Phoenix CRM — the interviews on an Interviews day (owner, 2026-10-29: "if interviews attach the cvs
 * and scheduled time").
 *
 *   - `DayInterviewsEntry` is today's entry, inside Add visit → Interviews: the interviews already booked
 *     for him in the hiring calendar today (read live, each with its CV), and a short form to add one
 *     that is missing — the candidate's name, the time and the CV, all three required.
 *   - `DayInterviewsList` is a recorded day, read back exactly as it was saved.
 *
 * An Interviews day is saved only with at least one interview: the server refuses it otherwise
 * (`interviews_required`), and the entry keeps Save disabled until one is on screen.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, Trash2 } from "lucide-react";

import { crmPost, crmSendForm, crmUrl, useCrmAction, useCrmGet } from "@/components/phoenix-crm/api";
import { cairoClock, countText } from "@/components/phoenix-crm/format";
import { CrmButton, CrmField, CrmLoadError, CrmLoading, CrmNote, CrmSaveError, crmInputClassName } from "@/components/phoenix-crm/ui";
import type { DayInterview } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

type DayInterviews = { date: string; booked: DayInterview[]; added: DayInterview[]; saved: DayInterview[] };

const CV_ACCEPT =
  ".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png,image/webp";

const headingClassName = "text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500";

/** One interview: the time, the candidate and the CV. Wraps on a phone, never cut short. */
function InterviewRow({ interview, onRemove, removing = false }: { interview: DayInterview; onRemove?: () => void; removing?: boolean }) {
  return (
    <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 border-b border-slate-100 py-2.5 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <span className="text-sm font-black tabular-nums text-slate-900">{cairoClock(interview.scheduledAt)}</span>
      <span className="min-w-0 break-words text-sm font-bold text-slate-800" dir="auto">
        {interview.candidateName}
        {interview.durationMinutes ? <span className="font-semibold text-slate-500"> · {interview.durationMinutes} min</span> : null}
      </span>
      <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-3 sm:col-span-1 sm:justify-end">
        {interview.cvUrl ? (
          <a
            className="inline-flex min-h-9 min-w-0 items-center gap-1.5 text-sm font-black text-orange-700 underline-offset-2 hover:underline"
            href={interview.cvUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            <FileText aria-hidden className="h-4 w-4 shrink-0" />
            <span className="min-w-0 break-all">{interview.cvFileName ? `CV · ${interview.cvFileName}` : "Open CV"}</span>
          </a>
        ) : (
          <span className="text-xs font-semibold text-slate-500">No CV on the hiring calendar</span>
        )}
        {onRemove ? (
          <CrmButton busy={removing} onClick={onRemove} size="sm">
            <Trash2 aria-hidden className="h-4 w-4" />
            Remove
          </CrmButton>
        ) : null}
      </span>
    </li>
  );
}

function InterviewList({ children }: { children: ReactNode }) {
  return <ul className="grid min-w-0 border-y border-slate-200">{children}</ul>;
}

/**
 * Today's interviews, while the day is being recorded as Interviews. `onCount` tells the parent how many
 * are on screen (null while loading), so Save waits for the first one.
 */
export function DayInterviewsEntry({
  disabled,
  onCount,
  seatId,
  test,
}: {
  disabled: boolean;
  onCount: (count: number | null) => void;
  seatId: string;
  test: boolean;
}) {
  const resource = useCrmGet<DayInterviews>(crmUrl("/api/phoenix-crm/day-interviews", { seatId, test }), "interviews");
  const action = useCrmAction();
  const [candidateName, setCandidateName] = useState("");
  const [time, setTime] = useState("");
  const [cv, setCv] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = disabled || action.busy !== null;

  const data = resource.data;
  const count = data ? data.booked.length + data.added.length : null;
  useEffect(() => {
    onCount(count);
  }, [count, onCount]);

  async function add() {
    if (!cv) return;
    const form = new FormData();
    form.set("seatId", seatId);
    if (test) form.set("test", "true");
    form.set("candidateName", candidateName.trim());
    form.set("time", time);
    form.set("cv", cv);
    await action.run(
      "add",
      () => crmSendForm<DayInterview>("/api/phoenix-crm/day-interviews", form, "interview"),
      () => {
        setCandidateName("");
        setTime("");
        setCv(null);
        if (fileRef.current) fileRef.current.value = "";
        resource.reload();
      },
    );
  }

  async function remove(id: string) {
    await action.run(
      `remove:${id}`,
      () => crmPost<{ id: string }>("/api/phoenix-crm/day-interviews/remove", { id, seatId, test }, "removed"),
      () => resource.reload(),
    );
  }

  if (resource.error && !data) return <CrmLoadError message={resource.error} onRetry={resource.reload} />;
  if (!data) return <CrmLoading label="Loading today's interviews" />;

  const ready = candidateName.trim().length >= 2 && /^\d{2}:\d{2}$/.test(time) && cv !== null;

  return (
    <div className="grid min-w-0 gap-4">
      <section className="grid min-w-0 gap-1">
        <h3 className={headingClassName}>Booked in the hiring calendar</h3>
        {data.booked.length > 0 ? (
          <InterviewList>
            {data.booked.map((interview) => (
              <InterviewRow interview={interview} key={`${interview.scheduledAt}|${interview.candidateName}`} />
            ))}
          </InterviewList>
        ) : (
          <p className="text-sm font-semibold text-slate-500">No interview is booked for you in the hiring calendar today.</p>
        )}
      </section>

      {data.added.length > 0 ? (
        <section className="grid min-w-0 gap-1">
          <h3 className={headingClassName}>Added by you</h3>
          <InterviewList>
            {data.added.map((interview) => {
              const id = interview.id;
              return (
                <InterviewRow
                  interview={interview}
                  key={id ?? `${interview.scheduledAt}|${interview.candidateName}`}
                  onRemove={id && !disabled ? () => void remove(id) : undefined}
                  removing={action.busy === `remove:${id}`}
                />
              );
            })}
          </InterviewList>
        </section>
      ) : null}

      <section className="grid min-w-0 gap-3 border border-slate-200 p-3">
        <h3 className="text-sm font-black text-slate-900">Add an interview</h3>
        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <CrmField htmlFor="phoenix-crm-interview-name" label="Candidate's name">
            <input
              autoComplete="off"
              className={crmInputClassName}
              dir="auto"
              disabled={busy}
              id="phoenix-crm-interview-name"
              maxLength={200}
              onChange={(event) => setCandidateName(event.target.value)}
              value={candidateName}
            />
          </CrmField>
          <CrmField htmlFor="phoenix-crm-interview-time" label="Time">
            {/* `appearance-none`, as on every time input in the module: without it iOS draws its own rounded control. */}
            <input
              className={cn(crmInputClassName, "appearance-none")}
              disabled={busy}
              id="phoenix-crm-interview-time"
              onChange={(event) => setTime(event.target.value)}
              type="time"
              value={time}
            />
          </CrmField>
        </div>
        <CrmField hint="PDF, Word or a photo of the CV · up to 10 MB" htmlFor="phoenix-crm-interview-cv" label="CV">
          <input
            accept={CV_ACCEPT}
            className={crmInputClassName}
            disabled={busy}
            id="phoenix-crm-interview-cv"
            onChange={(event) => setCv(event.target.files?.[0] ?? null)}
            ref={fileRef}
            type="file"
          />
        </CrmField>
        {action.error ? <CrmSaveError message={action.error} onRetry={action.retry} /> : null}
        <div>
          <CrmButton busy={action.busy === "add"} disabled={!ready || busy} onClick={() => void add()}>
            Add interview
          </CrmButton>
        </div>
      </section>

      {count === 0 ? <CrmNote tone="info">Add at least one interview, with its time and CV, to save the day as Interviews.</CrmNote> : null}
    </div>
  );
}

/** A recorded Interviews day, read back exactly as it was saved. */
export function DayInterviewsList({ date, seatId, test }: { date: string; seatId: string; test: boolean }) {
  const resource = useCrmGet<DayInterviews>(crmUrl("/api/phoenix-crm/day-interviews", { date, seatId, test }), "interviews");
  if (resource.error && !resource.data) return <CrmLoadError message={resource.error} onRetry={resource.reload} />;
  if (!resource.data) return <CrmLoading label="Loading the interviews" />;
  const saved = resource.data.saved;
  if (saved.length === 0) return <p className="text-sm font-semibold text-slate-500">No interview was recorded with this day.</p>;
  return (
    <section className="grid min-w-0 gap-1">
      <h3 className={headingClassName}>Interviews · {countText(saved.length)}</h3>
      <InterviewList>
        {saved.map((interview) => (
          <InterviewRow interview={interview} key={interview.id ?? `${interview.scheduledAt}|${interview.candidateName}`} />
        ))}
      </InterviewList>
    </section>
  );
}
