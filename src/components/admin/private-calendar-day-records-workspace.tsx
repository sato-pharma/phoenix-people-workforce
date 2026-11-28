"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Sparkles, X } from "lucide-react";

import { CheckTile, FormActions, FormBlock, FormError, FormField, FormGrid } from "@/components/ui/form-kit";
import {
  phxButtonApproveClassName,
  phxButtonDangerDenseClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import type { DayQuestion, DayQuestionsResult } from "@/lib/private-calendar/day-record-question-rules";
import type { DayRecordListRow, DayRecordPickerGroup, DayRecordSaveResult } from "@/lib/private-calendar/day-records-admin";
import { cn } from "@/lib/utils";

// PRIVATE CALENDAR DAY RECORDS — the Super Admin's own screen (owner, 2026-11-28). Three parts, in the
// order he works them: the questions Phoenix asks him (a line's training days, a rep's conference), the
// one-step record for a group ("we all had a meeting on Thursday"), and the month's standing records.
// Nothing here covers a day until he saves it; the AI's suggestion only pre-ticks a box.

type Payload = { groups: DayRecordPickerGroup[]; questions: DayQuestionsResult; records: DayRecordListRow[] };

const DAY_FORMAT = stableEnGbFormatter({ day: "numeric", month: "short", timeZone: "UTC", weekday: "short", year: "numeric" });

function dayLabel(iso: string) {
  return DAY_FORMAT.format(new Date(`${iso}T00:00:00Z`));
}

async function fetchMonth(key: string): Promise<Payload> {
  const [year, monthNumber] = key.split("-").map(Number);
  const response = await fetch(`/api/private-calendar/day-records?year=${year}&month=${monthNumber}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to load the day records.");
  return payload.data as Payload;
}

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/private-calendar/day-records", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to save.");
  return payload.data;
}

function QuestionCard({ onAnswered, question }: { onAnswered: (message: string) => void; question: DayQuestion }) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(question.days.filter((day) => day.suggested === true).map((day) => day.date)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result =
        question.kind === "line_training"
          ? await post({ action: "answer", dates: question.days.map((day) => day.date), hrId: question.hrId, kind: "line_training", ticked: [...ticked] })
          : await post({
              action: "answer",
              confirm: question.days.filter((day) => ticked.has(day.date)).map((day) => day.recordId),
              decline: question.days.filter((day) => !ticked.has(day.date)).map((day) => day.recordId),
              kind: "rep_named",
            });
      onAnswered(`${question.name}: ${result.confirmed} day${result.confirmed === 1 ? "" : "s"} recorded, ${result.declined} not.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save.");
      setBusy(false);
    }
  }

  return (
    <FormBlock label={question.kind === "line_training" ? `${question.lineName ?? "Line"} training · ${question.name}` : `Conference · ${question.name}`}>
      <p className="text-sm leading-relaxed text-slate-700">{question.prompt}</p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {question.days.map((day) => (
          <CheckTile
            checked={ticked.has(day.date)}
            className="items-start"
            key={day.date}
            onChange={(next) =>
              setTicked((current) => {
                const copy = new Set(current);
                if (next) copy.add(day.date);
                else copy.delete(day.date);
                return copy;
              })
            }
          >
            <span className="min-w-0 break-words">
              <span className="block font-bold text-slate-900">{dayLabel(day.date)}</span>
              {day.people ? <span className="block text-xs font-medium text-slate-500">{day.people} of the line logged Training</span> : null}
              {day.notes.length > 0 ? <span className="mt-1 block text-xs font-normal text-slate-600">{day.notes.join(" · ")}</span> : null}
              {day.suggestionReason ? (
                <span className="mt-1 flex items-start gap-1 text-xs font-medium text-indigo-900">
                  <Sparkles aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    {day.suggested ? "Suggested: with the line" : "Suggested: not with the line"} — {day.suggestionReason}
                  </span>
                </span>
              ) : null}
            </span>
          </CheckTile>
        ))}
      </div>
      <FormError className="mt-3">{error}</FormError>
      <FormActions
        left={
          <button className={phxButtonGhostClassName} disabled={busy} onClick={() => setTicked(new Set(question.days.map((day) => day.date)))} type="button">
            Tick every day
          </button>
        }
        right={
          <button className={phxButtonApproveClassName} disabled={busy} onClick={save} type="button">
            <Check aria-hidden className="h-4 w-4" />
            {busy ? "Saving" : `Save — ${ticked.size} of ${question.days.length} day${question.days.length === 1 ? "" : "s"}`}
          </button>
        }
      />
    </FormBlock>
  );
}

export function PrivateCalendarDayRecordsWorkspace({
  activities,
  initialMonth,
  today,
}: {
  activities: Array<{ label: string; value: string }>;
  initialMonth: string;
  today: string;
}) {
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<Payload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [date, setDate] = useState(today);
  const [activityType, setActivityType] = useState(activities[0]?.value ?? "meeting");
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<DayRecordSaveResult | null>(null);
  const [armedVoid, setArmedVoid] = useState<string | null>(null);

  const load = useCallback(async (key: string) => {
    try {
      setData(await fetchMonth(key));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load the day records.");
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetchMonth(month)
      .then((payload) => {
        if (!alive) return;
        setData(payload);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(error instanceof Error ? error.message : "Unable to load the day records.");
      });
    return () => {
      alive = false;
    };
  }, [month]);

  const needle = search.trim().toLowerCase();
  const groups = useMemo(
    () =>
      (data?.groups ?? [])
        .map((group) => ({
          ...group,
          people: needle
            ? group.people.filter((person) => `${person.name} ${person.lineName ?? ""} ${group.label}`.toLowerCase().includes(needle))
            : group.people,
        }))
        .filter((group) => group.people.length > 0),
    [data, needle],
  );

  function setMany(hrIds: string[], on: boolean) {
    setPicked((current) => {
      const copy = new Set(current);
      for (const hrId of hrIds) {
        if (on) copy.add(hrId);
        else copy.delete(hrId);
      }
      return copy;
    });
  }

  async function saveGroup() {
    setSaving(true);
    setSaveError(null);
    setSaveResult(null);
    try {
      const result = (await post({ action: "record", activityType, date, hrIds: [...picked], note })) as DayRecordSaveResult;
      setSaveResult(result);
      setPicked(new Set());
      await load(month);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save.");
    } finally {
      setSaving(false);
    }
  }

  async function voidRecord(id: string) {
    setArmedVoid(null);
    try {
      await post({ action: "void", id });
      setNotice("The day record was removed. That day reads from the calendar's other sources again.");
      await load(month);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to remove the day record.");
    }
  }

  const questions = data?.questions.questions ?? [];

  return (
    <div className="space-y-5">
      <FormBlock
        action={
          <input aria-label="Month" className={cn(phxFieldClassName, "w-auto")} max={today.slice(0, 7)} onChange={(event) => event.target.value && setMonth(event.target.value)} type="month" value={month} />
        }
        label={`Waiting on you · ${questions.length}`}
      >
        {loadError ? <FormError>{loadError}</FormError> : null}
        {notice ? <p className="mb-3 border-l-2 border-indigo-900 bg-white px-3 py-2 text-sm text-slate-700">{notice}</p> : null}
        {!data && !loadError ? <p className="text-sm text-slate-500">Reading the month.</p> : null}
        {data && questions.length === 0 ? (
          <p className="text-sm text-slate-500">No questions for this month. Every line training day is answered, and no rep has named anyone on a conference.</p>
        ) : null}
        {data && questions.length > 0 && !data.questions.aiAnswered ? (
          <p className="mb-3 text-xs text-slate-500">No suggestion this time — every day starts unticked.</p>
        ) : null}
        <div className="space-y-3">
          {questions.map((question) => (
            <QuestionCard
              key={question.id}
              onAnswered={(message) => {
                setNotice(message);
                void load(month);
              }}
              question={question}
            />
          ))}
        </div>
      </FormBlock>

      <FormBlock label="Record a day for a group">
        <FormGrid>
          <FormField htmlFor="day-record-date" label="Day" required>
            <input className={phxFieldClassName} id="day-record-date" max={today} onChange={(event) => setDate(event.target.value)} type="date" value={date} />
          </FormField>
          <FormField htmlFor="day-record-activity" label="What it was" required>
            <select className={phxSelectClassName} id="day-record-activity" onChange={(event) => setActivityType(event.target.value)} value={activityType}>
              {activities.map((activity) => (
                <option key={activity.value} value={activity.value}>
                  {activity.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField htmlFor="day-record-search" label="Find a person">
            <input className={phxFieldClassName} id="day-record-search" onChange={(event) => setSearch(event.target.value)} placeholder="Name, line or job title" type="search" value={search} />
          </FormField>
        </FormGrid>
        <FormField className="mt-4" htmlFor="day-record-note" label="Note" hint="Shown on each person's calendar for that day.">
          <textarea className={phxTextareaClassName} id="day-record-note" maxLength={500} onChange={(event) => setNote(event.target.value)} rows={2} value={note} />
        </FormField>

        <div className="mt-4 space-y-2">
          {groups.map((group) => {
            const ids = group.people.map((person) => person.hrId);
            const tickedCount = ids.filter((id) => picked.has(id)).length;
            const open = openGroups.has(group.label) || Boolean(needle);
            return (
              <div className="border border-slate-200 bg-white" key={group.label}>
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <button
                    className="min-w-0 break-words text-left text-sm font-bold text-slate-900"
                    onClick={() =>
                      setOpenGroups((current) => {
                        const copy = new Set(current);
                        if (copy.has(group.label)) copy.delete(group.label);
                        else copy.add(group.label);
                        return copy;
                      })
                    }
                    type="button"
                  >
                    {group.label} <span className="font-medium text-slate-500">· {tickedCount} of {ids.length} ticked</span>
                  </button>
                  <div className="flex gap-2">
                    <button className={phxButtonGhostClassName} onClick={() => setMany(ids, true)} type="button">
                      Select all
                    </button>
                    <button className={phxButtonGhostClassName} disabled={tickedCount === 0} onClick={() => setMany(ids, false)} type="button">
                      Clear
                    </button>
                  </div>
                </div>
                {open ? (
                  <div className="grid grid-cols-1 gap-2 border-t border-slate-200 p-3 sm:grid-cols-2 xl:grid-cols-3">
                    {group.people.map((person) => (
                      <CheckTile checked={picked.has(person.hrId)} key={person.hrId} onChange={(next) => setMany([person.hrId], next)}>
                        <span className="min-w-0 break-words">
                          <span className="block text-slate-900">{person.name}</span>
                          {person.lineName ? <span className="block text-xs font-medium text-slate-500">{person.lineName}</span> : null}
                        </span>
                      </CheckTile>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <FormError className="mt-3">{saveError}</FormError>
        {saveResult ? (
          <div className="mt-3 border-l-2 border-indigo-900 bg-white px-3 py-2 text-sm text-slate-700">
            <p className="font-bold text-slate-900">
              Recorded for {saveResult.recorded.length} {saveResult.recorded.length === 1 ? "person" : "people"}.
            </p>
            {saveResult.skipped.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {saveResult.skipped.map((person) => (
                  <li key={person.hrId}>
                    {person.name} — {person.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <FormActions
          left={<span className="text-sm text-slate-600">{picked.size} ticked</span>}
          right={
            <button className={phxButtonPrimaryClassName} disabled={saving || picked.size === 0 || !date} onClick={saveGroup} type="button">
              {saving ? "Saving" : `Record ${dayLabel(date || today)} for ${picked.size} ${picked.size === 1 ? "person" : "people"}`}
            </button>
          }
        />
      </FormBlock>

      <FormBlock label={`Day records this month · ${data?.records.length ?? 0}`}>
        {data && data.records.length === 0 ? <p className="text-sm text-slate-500">No day records this month.</p> : null}
        <ul className="divide-y divide-slate-200">
          {(data?.records ?? []).map((record) => (
            <li className="flex flex-wrap items-start justify-between gap-2 py-2" key={record.id}>
              <span className="min-w-0 flex-1 break-words text-sm text-slate-700">
                <span className="font-bold text-slate-900">{record.name}</span> · {dayLabel(record.date)} · {record.activityLabel}
                <span className="block text-xs text-slate-500">
                  {record.enteredBy}
                  {record.note ? ` · ${record.note}` : ""}
                </span>
              </span>
              {armedVoid === record.id ? (
                <span className="flex gap-2">
                  <button className={phxButtonDangerDenseClassName} onClick={() => voidRecord(record.id)} type="button">
                    Remove it
                  </button>
                  <button className={phxButtonGhostClassName} onClick={() => setArmedVoid(null)} type="button">
                    Keep
                  </button>
                </span>
              ) : (
                <button aria-label={`Remove ${record.name}'s day record`} className={phxButtonGhostClassName} onClick={() => setArmedVoid(record.id)} type="button">
                  <X aria-hidden className="h-4 w-4" />
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </FormBlock>
    </div>
  );
}
