"use client";

// Step 1 of the request flow (the owner, 2026-09-23): a District Manager and above, or HR, asks for
// an interview by choosing a DAY — no time — the person who will conduct it, and the CVs. HR gives
// each CV a real time afterwards (the inbox), which turns the request into booked slots on both the
// requester's and the interviewer's calendar.
//
// No time field here on purpose. The whole request is: a day, an interviewer, and one or more CVs —
// each picked from Recruitment or attached from outside. A CV attached here is kept on the request
// only; whether an outside person becomes a Recruitment candidate is HR's choice when they book.

import { Loader2, Plus, Send, Trash2 } from "lucide-react";
import { useState } from "react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import type { InterviewRequest } from "@/lib/recruitment/interview-calendar-types";
import { formatDayLong } from "@/lib/recruitment/interview-calendar-week";
import { cn } from "@/lib/utils";

import { type CalendarApi } from "./calendar-api";
import { CalendarDialog, ErrorLine, NoteLine, PanelHeading } from "./calendar-dialog";
import { InterviewerPicker, type ChosenInterviewer } from "./interviewer-picker";
import { MonthPicker, cursorFor, type MonthCursor } from "./month-picker";
import { CV_LIMIT_BYTES, PersonPicker, initialPersonChoice, personLabel, personProblem, type PersonChoice } from "./person-picker";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

const MAX_ITEMS = 25;

type ItemRow = { key: string; choice: PersonChoice };

let itemSeq = 0;
function newItem(canSearch: boolean): ItemRow {
  itemSeq += 1;
  // A requester never adds outside people to Recruitment from here — HR decides that at booking.
  return { choice: initialPersonChoice(canSearch, false), key: `item-${itemSeq}` };
}

/** The wire item for one CV: a Recruitment candidate, or an outside person whose CV rides along. */
function wireItem(choice: PersonChoice, cvField: string): { payload: Record<string, unknown>; file: File | null } {
  if (choice.kind === "phoenix") return { file: null, payload: { candidateId: choice.candidate?.id ?? null } };
  const external = { email: choice.email.trim(), name: choice.name.trim(), phone: choice.phone.trim() };
  if (choice.cv) return { file: choice.cv, payload: { cvField, external } };
  return { file: null, payload: { external } };
}

export function RequestInterviewDialog({
  api,
  canSearch,
  defaultDay,
  onClose,
  onCreated,
  todayKey,
}: {
  api: CalendarApi;
  canSearch: boolean;
  /** The day the calendar is showing, so the picker opens near it. */
  defaultDay?: string | null;
  onClose: () => void;
  onCreated: (request: InterviewRequest) => void;
  todayKey: string;
}) {
  const [day, setDay] = useState<string | null>(null);
  const [cursor, setCursor] = useState<MonthCursor>(() => cursorFor(defaultDay && defaultDay >= todayKey ? defaultDay : todayKey));
  const [interviewer, setInterviewer] = useState<ChosenInterviewer | null>(null);
  const [items, setItems] = useState<ItemRow[]>(() => [newItem(canSearch)]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const itemProblems = items.map((item) => personProblem(item.choice));
  const readyItems = items.filter((_, index) => itemProblems[index] === null);
  const problem = !day
    ? "Choose the day."
    : !interviewer
      ? "Choose who will conduct the interview."
      : readyItems.length === 0
        ? "Add at least one CV."
        : null;

  function setChoice(key: string, choice: PersonChoice) {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, choice } : item)));
  }

  async function submit() {
    if (problem || busy || !day || !interviewer) return;
    setBusy(true);
    setError(null);
    try {
      const wire = readyItems.map((item, index) => wireItem(item.choice, `cv${index}`));
      const payload = {
        interviewerHrId: interviewer.hrId,
        items: wire.map((entry) => entry.payload),
        note: note.trim() || null,
        requestedDay: day,
      };
      const hasFile = wire.some((entry) => entry.file);
      const created = hasFile
        ? await (() => {
            const form = new FormData();
            form.set("payload", JSON.stringify(payload));
            for (const entry of wire) {
              if (entry.file) form.set(String(entry.payload.cvField), entry.file);
            }
            return api.postForm("/requests", form);
          })()
        : await api.post("/requests", payload);
      onCreated((created.request ?? created) as InterviewRequest);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The request could not be sent.");
      setBusy(false);
    }
  }

  return (
    <CalendarDialog
      eyebrow="Request an interview"
      footer={
        <>
          <p className="min-w-0 break-words text-[12px] text-slate-600">
            {problem ?? `Ready — ${readyItems.length} ${readyItems.length === 1 ? "CV" : "CVs"} for ${interviewer?.name} on ${day ? formatDayLong(day) : ""}.`}
          </p>
          <div className="flex shrink-0 gap-2">
            <Action onClick={onClose} size="md" tone="quiet">
              Cancel
            </Action>
            <Action disabled={busy || problem !== null} onClick={() => void submit()} size="md" tone="primary">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send request
            </Action>
          </div>
        </>
      }
      onClose={onClose}
      sub="HR gives each CV a time and it appears on your calendar and the interviewer's."
      title="Ask HR to book interviews"
      width="lg"
    >
      <div className="flex flex-col gap-5">
        <section>
          <PanelHeading>The day</PanelHeading>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] sm:items-start">
            <div className={`border border-slate-200 bg-white p-3 ${adminSoftDepthClassName}`}>
              <MonthPicker cursor={cursor} onCursor={setCursor} onSelect={setDay} selected={day} todayKey={todayKey} />
            </div>
            <NoteLine tone={day ? "emerald" : "slate"}>
              {day ? `Interviews on ${formatDayLong(day)}. HR sets the time of each one.` : "Pick a day. You choose the day; HR chooses the times."}
            </NoteLine>
          </div>
        </section>

        <section>
          <PanelHeading>Who conducts it</PanelHeading>
          <InterviewerPicker api={api} onChange={setInterviewer} value={interviewer} />
          <p className="mt-1 text-[11px] text-slate-500">The line&apos;s National Sales Manager, or the HR head — a District Manager and above.</p>
        </section>

        <section>
          <PanelHeading aside={<span className="text-[11px] font-bold tabular-nums text-slate-500">{items.length} of {MAX_ITEMS}</span>}>The CVs</PanelHeading>
          <ul className="flex flex-col gap-3">
            {items.map((item, index) => (
              <li className={`border border-slate-200 bg-slate-50/60 p-3 ${adminRecessedDepthClassName}`} key={item.key}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-[12px] font-black uppercase tracking-[0.06em] text-slate-800">
                    <span className="inline-flex items-center gap-1.5">
                      <span aria-hidden className="inline-block h-3 w-[3px] bg-orange-500" />
                      CV {index + 1}
                    </span>
                    {personLabel(item.choice) ? <span className="break-words font-semibold normal-case tracking-normal text-slate-500"> — {personLabel(item.choice)}</span> : null}
                  </p>
                  {items.length > 1 ? (
                    <button
                      aria-label={`Remove CV ${index + 1}`}
                      className="inline-flex h-7 w-7 items-center justify-center border border-transparent text-slate-500 hover:border-slate-200 hover:text-red-700"
                      onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}
                      type="button"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
                <PersonPicker api={api} canAdd={false} canSearch={canSearch} onChange={(choice) => setChoice(item.key, choice)} value={item.choice} />
              </li>
            ))}
          </ul>
          {items.length < MAX_ITEMS ? (
            <Action className="mt-3" onClick={() => setItems((current) => [...current, newItem(canSearch)])} tone="quiet">
              <Plus className="h-3.5 w-3.5" />
              Add another CV
            </Action>
          ) : null}
        </section>

        <section>
          <PanelHeading>A note for HR (optional)</PanelHeading>
          <textarea
            aria-label="A note for HR"
            className={cn(
              phxTextareaClassName, "block w-full",
            )}
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Anything HR should know before they call — a preferred time of day, which role, and so on."
            rows={2}
            value={note}
          />
        </section>

        {items.some((item) => item.choice.kind === "outside" && item.choice.cv && item.choice.cv.size > CV_LIMIT_BYTES) ? (
          <ErrorLine>One CV is larger than 10&nbsp;MB. Remove or replace it.</ErrorLine>
        ) : null}
        {error ? <ErrorLine>{error}</ErrorLine> : null}
      </div>
    </CalendarDialog>
  );
}
