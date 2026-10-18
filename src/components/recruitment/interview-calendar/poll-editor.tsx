"use client";

// Writing a Zoom poll — for one interview, or once as a SAVED poll to add to any interview (the
// owner, 2026-09-18: "both"). A question takes one answer, several, or a written one; a choice
// question has two to ten choices. Zoom runs the poll inside the meeting; the answers come back to
// the interview's report after it ends.

import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { Action } from "@/components/recruitment/workstation/workstation-look";
import {
  POLL_QUESTION_TYPE_LABEL,
  checkPollQuestions,
  type InterviewPollQuestion,
  type InterviewPollQuestionType,
  type InterviewPollSet,
} from "@/lib/recruitment/interview-calendar-types";

import { type CalendarApi, reasonText } from "./calendar-api";
import { CalendarDialog, ErrorLine, NoteLine, PanelHeading } from "./calendar-dialog";
import {
  phxFieldClassName,
  phxLabelTextClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

type DraftQuestion = { name: string; type: InterviewPollQuestionType; answers: string[] };

function blankQuestion(): DraftQuestion {
  return { answers: ["", ""], name: "", type: "single" };
}

const inputClass = `${phxFieldClassName} block`;

export function PollEditor({
  busy,
  error,
  initialName = "",
  initialQuestions,
  nameLabel,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  busy: boolean;
  error: string | null;
  initialName?: string;
  initialQuestions?: InterviewPollQuestion[];
  nameLabel: string;
  onCancel: () => void;
  onSubmit: (name: string, questions: InterviewPollQuestion[]) => void;
  submitLabel: string;
}) {
  const [name, setName] = useState(initialName);
  const [questions, setQuestions] = useState<DraftQuestion[]>(() =>
    initialQuestions && initialQuestions.length > 0
      ? initialQuestions.map((question) => ({ ...question, answers: question.type === "short_answer" ? [] : [...question.answers] }))
      : [blankQuestion()],
  );
  const [problem, setProblem] = useState<string | null>(null);

  function change(index: number, next: Partial<DraftQuestion>) {
    setQuestions((current) => current.map((question, at) => (at === index ? { ...question, ...next } : question)));
  }

  function submit() {
    const title = name.trim();
    if (!title) {
      setProblem(`Give the ${nameLabel.toLowerCase()} first.`);
      return;
    }
    const checked = checkPollQuestions(questions);
    if ("error" in checked) {
      setProblem(checked.error);
      return;
    }
    setProblem(null);
    onSubmit(title, checked.questions);
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="block">
        <span className={phxLabelTextClassName}>{nameLabel}</span>
        <input className={`mt-1 ${inputClass}`} maxLength={120} onChange={(event) => setName(event.target.value)} value={name} />
      </label>
      <ol className="flex flex-col gap-3">
        {questions.map((question, index) => (
          <li className={`border border-slate-200 border-l-[3px] border-l-orange-500 bg-white p-3 ${adminSoftDepthClassName}`} key={index}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] font-black uppercase tracking-[0.06em] tabular-nums text-slate-800">Question {index + 1}</p>
              {questions.length > 1 ? (
                <button
                  aria-label={`Remove question ${index + 1}`}
                  className="inline-flex h-7 w-7 items-center justify-center border border-transparent text-slate-400 hover:border-red-200 hover:text-red-700"
                  onClick={() => setQuestions((current) => current.filter((_, at) => at !== index))}
                  type="button"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <input
              aria-label={`Question ${index + 1}`}
              className={`mt-1 ${inputClass}`}
              maxLength={255}
              onChange={(event) => change(index, { name: event.target.value })}
              placeholder="What do you want to ask?"
              value={question.name}
            />
            <select
              aria-label={`Kind of answer for question ${index + 1}`}
              className={`${phxSelectClassName} mt-2`}
              onChange={(event) => {
                const type = event.target.value as InterviewPollQuestionType;
                change(index, { answers: type === "short_answer" ? [] : question.answers.length >= 2 ? question.answers : ["", ""], type });
              }}
              value={question.type}
            >
              {(Object.keys(POLL_QUESTION_TYPE_LABEL) as InterviewPollQuestionType[]).map((type) => (
                <option key={type} value={type}>
                  {POLL_QUESTION_TYPE_LABEL[type]}
                </option>
              ))}
            </select>
            {question.type !== "short_answer" ? (
              <div className="mt-2 flex flex-col gap-1.5">
                {question.answers.map((answer, answerIndex) => (
                  <div className="flex items-center gap-1.5" key={answerIndex}>
                    <input
                      aria-label={`Choice ${answerIndex + 1} of question ${index + 1}`}
                      className={inputClass}
                      maxLength={200}
                      onChange={(event) =>
                        change(index, { answers: question.answers.map((value, at) => (at === answerIndex ? event.target.value : value)) })
                      }
                      placeholder={`Choice ${answerIndex + 1}`}
                      value={answer}
                    />
                    {question.answers.length > 2 ? (
                      <button
                        aria-label={`Remove choice ${answerIndex + 1}`}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-transparent text-slate-400 hover:border-red-200 hover:text-red-700"
                        onClick={() => change(index, { answers: question.answers.filter((_, at) => at !== answerIndex) })}
                        type="button"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                ))}
                {question.answers.length < 10 ? (
                  <div>
                    <Action onClick={() => change(index, { answers: [...question.answers, ""] })} tone="ghost">
                      <Plus className="h-3.5 w-3.5" />
                      Add a choice
                    </Action>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-slate-500">Each person types their own answer.</p>
            )}
          </li>
        ))}
      </ol>
      {questions.length < 25 ? (
        <div>
          <Action onClick={() => setQuestions((current) => [...current, blankQuestion()])} tone="quiet">
            <Plus className="h-3.5 w-3.5" />
            Add a question
          </Action>
        </div>
      ) : null}
      {problem || error ? <ErrorLine>{problem ?? error}</ErrorLine> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Action onClick={onCancel} size="md" tone="quiet">
          Cancel
        </Action>
        <Action disabled={busy} onClick={submit} size="md" tone="primary">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {submitLabel}
        </Action>
      </div>
    </div>
  );
}

/** The saved polls: write once, add to any Zoom interview. The owner and Editors. */
export function PollSetsDialog({
  api,
  onChanged,
  onClose,
}: {
  api: CalendarApi;
  onChanged?: (sets: InterviewPollSet[]) => void;
  onClose: () => void;
}) {
  const [sets, setSets] = useState<InterviewPollSet[] | null>(null);
  const [editing, setEditing] = useState<InterviewPollSet | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get("/poll-sets")
      .then((data) => {
        if (live) setSets(Array.isArray(data.pollSets) ? (data.pollSets as InterviewPollSet[]) : []);
      })
      .catch((reason) => {
        if (!live) return;
        setSets([]);
        setError(reasonText(reason, "The saved polls could not be read."));
      });
    return () => {
      live = false;
    };
  }, [api]);

  function land(data: Record<string, unknown>) {
    const next = Array.isArray(data.pollSets) ? (data.pollSets as InterviewPollSet[]) : [];
    setSets(next);
    onChanged?.(next);
  }

  async function save(name: string, questions: InterviewPollQuestion[]) {
    setBusy("save");
    setError(null);
    try {
      land(editing && editing !== "new" ? await api.patch(`/poll-sets/${editing.id}`, { name, questions }) : await api.post("/poll-sets", { name, questions }));
      setEditing(null);
    } catch (reason) {
      setError(reasonText(reason, "The poll could not be saved."));
    } finally {
      setBusy(null);
    }
  }

  async function remove(set: InterviewPollSet) {
    setBusy(set.id);
    setError(null);
    try {
      land(await api.del(`/poll-sets/${set.id}`));
    } catch (reason) {
      setError(reasonText(reason, "The poll could not be deleted."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <CalendarDialog
      eyebrow="Zoom polls"
      onClose={onClose}
      sub="Write a poll once and add it to any Zoom interview. Polls already added keep their own copy."
      title="Saved polls"
      z={260}
    >
      {editing ? (
        <PollEditor
          busy={busy === "save"}
          error={error}
          initialName={editing === "new" ? "" : editing.name}
          initialQuestions={editing === "new" ? undefined : editing.questions}
          key={editing === "new" ? "new" : editing.id}
          nameLabel="Poll name"
          onCancel={() => setEditing(null)}
          onSubmit={(name, questions) => void save(name, questions)}
          submitLabel="Save poll"
        />
      ) : (
        <div className="flex flex-col gap-3">
          <PanelHeading
            aside={
              <Action onClick={() => setEditing("new")} tone="primary">
                <Plus className="h-3.5 w-3.5" />
                New poll
              </Action>
            }
          >
            {sets === null ? "Reading…" : `${sets.length} saved`}
          </PanelHeading>
          {error ? <ErrorLine>{error}</ErrorLine> : null}
          {sets !== null && sets.length === 0 ? <NoteLine>No saved polls yet.</NoteLine> : null}
          <ul className={`divide-y divide-slate-100 border border-slate-200 bg-white empty:hidden ${adminSoftDepthClassName}`}>
            {(sets ?? []).map((set) => (
              <li className="flex items-start justify-between gap-3 px-3 py-2" key={set.id}>
                <span className="min-w-0">
                  <span className="block break-words text-[13px] font-semibold text-slate-900">{set.name}</span>
                  <span className="block text-[11px] tabular-nums text-slate-500">
                    {set.questions.length} {set.questions.length === 1 ? "question" : "questions"}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1">
                  <Action disabled={busy !== null} onClick={() => setEditing(set)} tone="ghost">
                    <Pencil className="h-3.5 w-3.5" />
                    Change
                  </Action>
                  <Action disabled={busy !== null} onClick={() => void remove(set)} tone="ghost">
                    {busy === set.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    Delete
                  </Action>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </CalendarDialog>
  );
}
