"use client";

// What Zoom adds to an interview — the owner, 2026-09-18: the invitation to copy or send on
// WhatsApp, polls (saved or written for this interview), and after it ends who attended, their
// answers and Zoom's AI summary. Everyone the calendar reaches can read these, link holders too;
// only the owner and Editors add or remove a poll.
//
// NOTHING IS SENT FROM HERE. "Send on WhatsApp" opens WhatsApp on the person's own device with the
// invitation typed in; they press Send there, or don't.

import { Check, ClipboardCopy, ListChecks, Loader2, MessageCircle, Plus, RefreshCw, Sparkles, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { phxWhatsAppShareButtonClassName } from "@/components/ui/brand-tokens";
import { RecruitmentPill, type RecruitmentPillTone } from "@/components/recruitment/recruitment-premium";
import { Action } from "@/components/recruitment/workstation/workstation-look";
import {
  whatsAppShareUrl,
  type InterviewAttendee,
  type InterviewPoll,
  type InterviewPollAnswer,
  type InterviewPollQuestion,
  type InterviewPollSet,
  type InterviewZoomInsights,
} from "@/lib/recruitment/interview-calendar-types";
import { cairoDateKey, cairoMinutesOfDay, formatShortDate, formatTimeOfDay } from "@/lib/recruitment/interview-calendar-week";
import { cn } from "@/lib/utils";

import { type CalendarApi, reasonText } from "./calendar-api";
import { CalendarDialog, ErrorLine, NoteLine, PanelHeading } from "./calendar-dialog";
import { PollEditor, PollSetsDialog } from "./poll-editor";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

export type MeetingTarget = { kind: "booking" | "session"; id: string };

function targetPath(target: MeetingTarget): string {
  return `/${target.kind === "session" ? "sessions" : "bookings"}/${encodeURIComponent(target.id)}`;
}

function cairoTime(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return formatTimeOfDay(cairoMinutesOfDay(at));
}

function cairoStamp(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${formatShortDate(cairoDateKey(at))}, ${formatTimeOfDay(cairoMinutesOfDay(at))}`;
}

function spent(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function ZoomMeetingPanels({
  api,
  canBook,
  hasMeeting,
  pollTarget,
  target,
  zoomConnected,
}: {
  api: CalendarApi;
  canBook: boolean;
  hasMeeting: boolean;
  /** Where polls live — the session, for a slot in one. */
  pollTarget: MeetingTarget;
  target: MeetingTarget;
  zoomConnected: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <InvitationPanel api={api} hasMeeting={hasMeeting} target={target} />
      <PollsPanel api={api} canBook={canBook} slotOfSession={pollTarget.kind !== target.kind} target={pollTarget} zoomConnected={zoomConnected} />
      <ReportPanel api={api} hasMeeting={hasMeeting} target={target} />
    </div>
  );
}

// ── The invitation ─────────────────────────────────────────────────────────────────────────────

type Invitation = { text: string; joinUrl: string | null; phone: string | null };

function InvitationPanel({ api, hasMeeting, target }: { api: CalendarApi; hasMeeting: boolean; target: MeetingTarget }) {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const data = await api.get(`${targetPath(target)}/invitation`);
      setInvitation(data.invitation as Invitation);
    } catch (reason) {
      setError(reasonText(reason, "The invitation could not be read."));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("The browser did not allow copying. Select the text and copy it.");
    }
  }

  return (
    <section aria-label="Zoom invitation" className="border-t border-slate-200 pt-3">
      <PanelHeading>Zoom invitation</PanelHeading>
      {!hasMeeting ? (
        <NoteLine>The invitation appears once the Zoom meeting exists.</NoteLine>
      ) : invitation ? (
        <div className="flex flex-col gap-2">
          <p className={`max-h-56 overflow-y-auto whitespace-pre-wrap break-words border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-800 ${adminRecessedDepthClassName}`}>
            {invitation.text}
          </p>
          <div className="flex flex-wrap gap-2">
            <Action onClick={() => void copy()} tone="quiet">
              {copied ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Action>
            <a
              className={cn(phxWhatsAppShareButtonClassName, "shrink-0")}
              href={whatsAppShareUrl(invitation.text, invitation.phone)}
              rel="noreferrer"
              target="_blank"
            >
              <MessageCircle className="h-3.5 w-3.5" />
              Send on WhatsApp
            </a>
          </div>
          <p className="text-[11px] text-slate-500">
            WhatsApp opens with the invitation typed in{invitation.phone ? ", on the candidate's number" : ""}. Nothing is sent until you press Send there.
          </p>
        </div>
      ) : (
        <Action disabled={busy} onClick={() => void load()} tone="quiet">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
          Show the invitation
        </Action>
      )}
      {error ? <div className="mt-2"><ErrorLine>{error}</ErrorLine></div> : null}
    </section>
  );
}

// ── Polls ──────────────────────────────────────────────────────────────────────────────────────

const POLL_STATUS: Record<InterviewPoll["status"], { label: string; tone: RecruitmentPillTone }> = {
  created: { label: "On the Zoom meeting", tone: "emerald" },
  failed: { label: "Zoom refused it", tone: "rose" },
  pending: { label: "Waiting for the meeting", tone: "amber" },
};

function PollsPanel({
  api,
  canBook,
  slotOfSession,
  target,
  zoomConnected,
}: {
  api: CalendarApi;
  canBook: boolean;
  slotOfSession: boolean;
  target: MeetingTarget;
  zoomConnected: boolean;
}) {
  const [polls, setPolls] = useState<InterviewPoll[] | null>(null);
  const [sets, setSets] = useState<InterviewPollSet[] | null>(null);
  const [chosenSet, setChosenSet] = useState("");
  const [writing, setWriting] = useState(false);
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A string, so an effect keyed on it does not re-run for every new object naming the same meeting.
  const path = targetPath(target);

  useEffect(() => {
    let live = true;
    api
      .get(`${path}/polls`)
      .then((data) => {
        if (live) setPolls(Array.isArray(data.polls) ? (data.polls as InterviewPoll[]) : []);
      })
      .catch((reason) => {
        if (!live) return;
        setPolls([]);
        setError(reasonText(reason, "The polls could not be read."));
      });
    return () => {
      live = false;
    };
  }, [api, path]);

  useEffect(() => {
    if (!canBook) return;
    let live = true;
    api
      .get("/poll-sets")
      .then((data) => {
        if (live) setSets(Array.isArray(data.pollSets) ? (data.pollSets as InterviewPollSet[]) : []);
      })
      .catch(() => {
        if (live) setSets([]);
      });
    return () => {
      live = false;
    };
  }, [api, canBook]);

  async function run(key: string, action: () => Promise<Record<string, unknown>>, fallback: string): Promise<boolean> {
    setBusy(key);
    setError(null);
    try {
      const data = await action();
      setPolls(Array.isArray(data.polls) ? (data.polls as InterviewPoll[]) : []);
      return true;
    } catch (reason) {
      setError(reasonText(reason, fallback));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function addSaved() {
    if (!chosenSet) return;
    if (await run("add", () => api.post(`${path}/polls`, { pollSetId: chosenSet }), "The poll could not be added.")) setChosenSet("");
  }

  async function addWritten(title: string, questions: InterviewPollQuestion[]) {
    if (await run("write", () => api.post(`${path}/polls`, { questions, title }), "The poll could not be added.")) setWriting(false);
  }

  return (
    <section aria-label="Zoom polls" className="border-t border-slate-200 pt-3">
      <PanelHeading
        aside={
          canBook ? (
            <Action onClick={() => setManaging(true)} tone="ghost">
              <ListChecks className="h-3.5 w-3.5" />
              Saved polls
            </Action>
          ) : null
        }
      >
        Polls{polls && polls.length > 0 ? ` (${polls.length})` : ""}
      </PanelHeading>
      {slotOfSession ? <p className="mb-2 text-[11px] text-slate-500">These are the session&apos;s polls — every interview in it shares its meeting.</p> : null}
      {polls === null ? (
        <p className="text-[12px] text-slate-500">Reading…</p>
      ) : polls.length === 0 ? (
        <p className="border border-dashed border-slate-300 px-3 py-2 text-[12px] text-slate-500">No polls on this meeting.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {polls.map((poll) => (
            <li className={`border border-slate-200 bg-white px-3 py-2 ${adminSoftDepthClassName}`} key={poll.id}>
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block break-words text-[13px] font-semibold text-slate-900">{poll.title}</span>
                  <span className="block text-[11px] tabular-nums text-slate-500">
                    {poll.questions.length} {poll.questions.length === 1 ? "question" : "questions"}
                    {poll.fromSetName ? ` · from “${poll.fromSetName}”` : ""}
                  </span>
                  <span className="mt-1 block">
                    <RecruitmentPill tone={POLL_STATUS[poll.status].tone}>{POLL_STATUS[poll.status].label}</RecruitmentPill>
                  </span>
                  {poll.error ? <span className="block break-words text-[11px] text-red-700">{poll.error}</span> : null}
                </span>
                {canBook ? (
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {poll.status !== "created" && zoomConnected ? (
                      <Action
                        disabled={busy !== null}
                        onClick={() => void run(poll.id, () => api.post(`/polls/${encodeURIComponent(poll.id)}`, {}), "Zoom could not be reached.")}
                        tone="ghost"
                      >
                        {busy === poll.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        Try again
                      </Action>
                    ) : null}
                    <Action
                      disabled={busy !== null}
                      onClick={() => void run(`remove-${poll.id}`, () => api.del(`/polls/${encodeURIComponent(poll.id)}`), "The poll could not be removed.")}
                      tone="ghost"
                    >
                      {busy === `remove-${poll.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      Remove
                    </Action>
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canBook ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Add a saved poll"
              className={`${phxSelectClassName} min-w-0 flex-1`}
              disabled={!sets || sets.length === 0}
              onChange={(event) => setChosenSet(event.target.value)}
              value={chosenSet}
            >
              <option value="">{sets && sets.length === 0 ? "No saved polls yet" : "Add a saved poll…"}</option>
              {(sets ?? []).map((set) => (
                <option key={set.id} value={set.id}>
                  {set.name}
                </option>
              ))}
            </select>
            <Action disabled={!chosenSet || busy !== null} onClick={() => void addSaved()} tone="quiet">
              {busy === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Add
            </Action>
          </div>
          <div>
            <Action onClick={() => setWriting(true)} tone="quiet">
              <Plus className="h-3.5 w-3.5" />
              Write a poll for this {target.kind === "session" ? "session" : "interview"}
            </Action>
          </div>
        </div>
      ) : null}
      {error ? <div className="mt-2"><ErrorLine>{error}</ErrorLine></div> : null}
      {writing ? (
        <CalendarDialog eyebrow="Zoom poll" onClose={() => setWriting(false)} title={`A poll for this ${target.kind === "session" ? "session" : "interview"}`} z={250}>
          <PollEditor
            busy={busy === "write"}
            error={error}
            nameLabel="Poll title"
            onCancel={() => setWriting(false)}
            onSubmit={(title, questions) => void addWritten(title, questions)}
            submitLabel="Add poll"
          />
        </CalendarDialog>
      ) : null}
      {managing ? <PollSetsDialog api={api} onChanged={setSets} onClose={() => setManaging(false)} /> : null}
    </section>
  );
}

// ── What Zoom reported ─────────────────────────────────────────────────────────────────────────

function ReportPanel({ api, hasMeeting, target }: { api: CalendarApi; hasMeeting: boolean; target: MeetingTarget }) {
  const [insights, setInsights] = useState<InterviewZoomInsights | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = targetPath(target);

  const load = useCallback(
    async (refresh: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const data = await api.get(`${path}/insights${refresh ? "?refresh=1" : ""}`);
        setInsights(data.insights as InterviewZoomInsights);
      } catch (reason) {
        setError(reasonText(reason, "Zoom's report could not be read."));
      } finally {
        setBusy(false);
      }
    },
    [api, path],
  );

  useEffect(() => {
    if (!hasMeeting) return;
    let live = true;
    api
      .get(`${path}/insights`)
      .then((data) => {
        if (live) setInsights(data.insights as InterviewZoomInsights);
      })
      .catch((reason) => {
        if (live) setError(reasonText(reason, "Zoom's report could not be read."));
      });
    return () => {
      live = false;
    };
  }, [api, hasMeeting, path]);

  return (
    <section aria-label="What Zoom reported" className="border-t border-slate-200 pt-3">
      <PanelHeading
        aside={
          insights?.state === "ready" ? (
            <Action disabled={busy} onClick={() => void load(true)} tone="ghost">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Ask Zoom again
            </Action>
          ) : null
        }
      >
        After the interview
      </PanelHeading>
      {!hasMeeting ? (
        <NoteLine>Attendance, poll answers and the AI summary come from the Zoom meeting, once there is one.</NoteLine>
      ) : insights === null ? (
        error ? null : <p className="text-[12px] text-slate-500">Reading…</p>
      ) : insights.state === "no_meeting" ? (
        <NoteLine>Attendance, poll answers and the AI summary come from the Zoom meeting, once there is one.</NoteLine>
      ) : insights.state === "not_held" ? (
        <NoteLine tone="sky">Zoom reports who attended, their poll answers and its AI summary once the interview is over.</NoteLine>
      ) : (
        <div className="flex flex-col gap-4">
          {insights.startedAt || insights.endedAt ? (
            <p className="text-[12px] font-semibold tabular-nums text-slate-700">
              Held {cairoTime(insights.startedAt)}
              {insights.endedAt ? ` to ${cairoTime(insights.endedAt)}` : ""} (Cairo)
            </p>
          ) : null}
          <Attendance part={insights.attendance} />
          <PollAnswers part={insights.polls} />
          <Summary part={insights.summary} />
          {insights.fetchedAt ? <p className="text-[11px] tabular-nums text-slate-400">Read from Zoom {cairoStamp(insights.fetchedAt)}</p> : null}
        </div>
      )}
      {error ? <div className="mt-2"><ErrorLine>{error}</ErrorLine></div> : null}
    </section>
  );
}

function PartHeading({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-black text-slate-800">
      <span className="text-orange-600">{icon}</span>
      {label}
    </p>
  );
}

function Attendance({ part }: { part: InterviewZoomInsights["attendance"] }) {
  const people: InterviewAttendee[] = part.data ?? [];
  return (
    <div>
      <PartHeading icon={<Users className="h-3.5 w-3.5" />} label={`Who attended${people.length > 0 ? ` (${people.length})` : ""}`} />
      {people.length === 0 ? (
        <p className="break-words text-[12px] text-slate-500">{part.note ?? "Nobody joined."}</p>
      ) : (
        <ul className={`divide-y divide-slate-100 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          {people.map((person, index) => (
            <li className="px-3 py-2" key={`${person.name}-${index}`}>
              <p className="break-words text-[13px] font-semibold text-slate-900">{person.name}</p>
              {person.email ? <p className="break-all text-[11px] text-slate-500">{person.email}</p> : null}
              <p className="text-[11px] tabular-nums text-slate-600">
                {person.joinedAt ? `Joined ${cairoTime(person.joinedAt)}` : ""}
                {person.leftAt ? ` · left ${cairoTime(person.leftAt)}` : ""} · in the meeting {spent(person.seconds)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PollAnswers({ part }: { part: InterviewZoomInsights["polls"] }) {
  const answers: InterviewPollAnswer[] = part.data ?? [];
  const byQuestion = new Map<string, InterviewPollAnswer[]>();
  for (const answer of answers) byQuestion.set(answer.question, [...(byQuestion.get(answer.question) ?? []), answer]);
  return (
    <div>
      <PartHeading icon={<ListChecks className="h-3.5 w-3.5" />} label="Poll answers" />
      {answers.length === 0 ? (
        <p className="break-words text-[12px] text-slate-500">{part.note ?? "No poll was answered."}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {[...byQuestion.entries()].map(([question, rows]) => (
            <li className={`border border-slate-200 bg-white px-3 py-2 ${adminSoftDepthClassName}`} key={question}>
              <p className="break-words text-[12px] font-bold text-slate-800">{question}</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {rows.map((row, index) => (
                  <li className="break-words text-[12px] text-slate-700" key={index}>
                    <span className="font-semibold">{row.participant}</span>: {row.answer}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Summary({ part }: { part: InterviewZoomInsights["summary"] }) {
  const summary = part.data;
  return (
    <div>
      <PartHeading icon={<Sparkles className="h-3.5 w-3.5" />} label="AI summary" />
      {!summary ? (
        <p className="break-words text-[12px] text-slate-500">{part.note ?? "Zoom has no summary for this meeting."}</p>
      ) : (
        <div className="flex flex-col gap-2 border border-sky-200 border-l-[3px] border-l-sky-600 bg-sky-50/60 px-3 py-2 text-[12px] text-slate-800">
          {summary.title ? <p className="font-bold">{summary.title}</p> : null}
          {summary.overview ? <p className="whitespace-pre-wrap break-words">{summary.overview}</p> : null}
          {summary.details.map((detail, index) => (
            <div key={index}>
              {detail.label ? <p className="font-semibold">{detail.label}</p> : null}
              <p className="whitespace-pre-wrap break-words">{detail.summary}</p>
            </div>
          ))}
          {summary.nextSteps.length > 0 ? (
            <div>
              <p className="font-semibold">Next steps</p>
              <ul className="list-disc pl-4">
                {summary.nextSteps.map((step, index) => (
                  <li className="break-words" key={index}>
                    {step}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {summary.content ? <p className="whitespace-pre-wrap break-words">{summary.content}</p> : null}
          <p className="text-[11px] text-slate-500">Written by Zoom&apos;s AI from the meeting — check it before relying on it.</p>
        </div>
      )}
    </div>
  );
}
