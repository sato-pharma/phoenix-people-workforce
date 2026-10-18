"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

import { AdminCallout, AdminSectionHeader } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  WHATSAPP_BODY_MAX,
  WHATSAPP_LIST_BUTTON_MAX,
  WHATSAPP_LIST_MAX_ROWS,
  WHATSAPP_ROW_DESCRIPTION_MAX,
  WHATSAPP_ROW_TITLE_MAX,
  WHATSAPP_SECTION_TITLE_MAX,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import { QuestionAudiencePicker } from "@/components/admin/question-audience-picker";
import {
  EXTRA_QUESTION_BUTTON_DEFAULT,
  EXTRA_QUESTION_SECTION_DEFAULT,
  screeningQuestionViolations,
  withStableOptionValues,
  type ScreeningQuestionKind,
} from "@/lib/recruitment/inbound/whatsapp-screening-questions";
import type { ScreeningQuestionAdminRow } from "@/lib/recruitment/inbound/whatsapp-screening-questions-admin";
import { phxTextareaClassName } from "@/components/ui/form-tokens";

type Props = {
  initialError: string | null;
  initialQuestions: ScreeningQuestionAdminRow[];
  /** True when rendered beneath the built-in-question editor on the shared screen, which already
   *  supplies the page padding. Standalone, this component keeps owning its own. */
  embedded?: boolean;
};

/**
 * `value` is the code this answer sends back, and it is STICKY once saved: null for an option nobody
 * has saved yet, the server's own value forever after.
 *
 * THIS FIELD IS WHY EDITING AN ANSWERED QUESTION IS SAFE. The value used to be re-derived from the
 * title on every single save, so retitling "Yes, I have one" to "Yes" silently rewrote the code from
 * `yes_i_have_one` to `yes`. That did not matter while an answered question was frozen; the moment
 * the owner asked (2026-09-05) to be able to edit the wording of a question people have already
 * answered, it became the way a menu already sitting on somebody's phone stops working - their tap
 * carries the OLD value, `decideNextExtraStep` finds no option with it, and the reply is dropped as
 * `unknown_value` with no error anywhere. Keeping the value fixed is what makes the retitle a
 * relabel, exactly as the six built-in questions above already treat theirs.
 */
type EditableOption = { title: string; description: string; value: string | null };

type EditableQuestion = {
  /** Stable React key — the server id once saved, a local placeholder before that. Never the
   *  question_key: that does not exist yet for a brand-new row. */
  clientKey: string;
  id: string | null;
  questionKey: string | null;
  bodyText: string;
  kind: ScreeningQuestionKind;
  options: EditableOption[];
  isActive: boolean;
  hasAnswers: boolean;
  /** Empty means EVERYONE, which is what the server stores as null. Kept as an array rather than a
   *  nullable one so the checkbox handlers never have to reason about two empty states. */
  appliesToRoleFamilies: string[];
  /**
   * The words WhatsApp draws AROUND a tappable question's list — the button that opens it and the
   * heading above the answers. Empty is "use the generic default", which is what the server stores
   * as null; kept as a string rather than a nullable one for the same reason the audience is an
   * array, so the input handlers never reason about two empty states.
   */
  buttonLabel: string;
  sectionTitle: string;
  /** The words sent when an answer ends the conversation. Null on a question that never ends it. */
  endMessage: string | null;
  /** Which answers end it, as the applicant sees them - read-only, so the owner can see the rule the
   *  message belongs to. */
  endTitles: string[];
  /** The option codes behind `endTitles`, kept so the live check sees the same rule the server holds. */
  endValues: string[];
  /** A plain-words description of the answer this question waits for, or null when always asked. */
  showIfSummary: string | null;
};

function newOption(): EditableOption {
  return { description: "", title: "", value: null };
}

function fromServerRow(row: ScreeningQuestionAdminRow): EditableQuestion {
  return {
    appliesToRoleFamilies: row.appliesToRoleFamilies ?? [],
    bodyText: row.bodyText,
    buttonLabel: row.buttonLabel ?? "",
    clientKey: row.id,
    endMessage: row.endOn ? row.endOn.message : null,
    endTitles: row.endOn
      ? (row.options ?? []).filter((option) => row.endOn?.values.includes(option.value)).map((option) => option.title)
      : [],
    endValues: row.endOn ? row.endOn.values : [],
    hasAnswers: row.hasAnswers,
    id: row.id,
    isActive: row.isActive,
    kind: row.kind,
    options: (row.options ?? []).map((option) => ({
      description: option.description ?? "",
      title: option.title,
      // Carried through rather than dropped - see EditableOption. Dropping it here was the bug.
      value: option.value,
    })),
    questionKey: row.questionKey,
    sectionTitle: row.sectionTitle ?? "",
    showIfSummary: row.showIf
      ? `Only asked after the answer to ${row.showIf.questionKey} is one of: ${row.showIf.values.join(", ")}`
      : null,
  };
}

function rowIssues(question: EditableQuestion): string[] {
  return screeningQuestionViolations({
    // Empty is the "ask everyone" state on this screen, and null is how the server spells it — so it
    // is normalised HERE too, not only on save. Passing [] through would trip the validator own
    // "selected none" complaint against a question the admin has deliberately left open to all.
    appliesToRoleFamilies: question.appliesToRoleFamilies.length > 0 ? question.appliesToRoleFamilies : null,
    bodyText: question.bodyText,
    // Only a tappable question has a list, and the validator refuses these on a free-text one — so
    // switching the answer type back must not keep complaining about words no box is showing.
    buttonLabel: question.kind === "tappable" ? question.buttonLabel : null,
    kind: question.kind,
    // A brand-new row has no question_key yet — the server generates and validates the real one at
    // save time. This placeholder only stands in so the OTHER checks (length, option shape) can run
    // live, without a spurious "key format" complaint on a question nobody has saved yet.
    // Only a question that already carries the ending rule has an ending message here, so the rule is
    // rebuilt around the words being typed and the validator sees what would be saved.
    endOn: question.endMessage === null ? null : { message: question.endMessage, values: question.endValues },
    options: question.kind === "tappable" ? withStableOptionValues(question.options) : null,
    questionKey: question.questionKey ?? "draft_question",
    sectionTitle: question.kind === "tappable" ? question.sectionTitle : null,
  });
}

function counterClass(length: number, max: number): string {
  if (length > max) return "text-red-600";
  if (length > max * 0.9) return "text-amber-600";
  return "text-slate-400";
}

export function ScreeningQuestionsManager({ embedded, initialError, initialQuestions }: Props) {
  const [rows, setRows] = React.useState<EditableQuestion[]>(() => initialQuestions.map(fromServerRow));
  const [error, setError] = React.useState<string | null>(initialError);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [deletingKey, setDeletingKey] = React.useState<string | null>(null);
  const newRowCounter = React.useRef(0);

  function addQuestion() {
    newRowCounter.current += 1;
    setRows((prev) => [
      ...prev,
      {
        appliesToRoleFamilies: [],
        bodyText: "",
        buttonLabel: "",
        clientKey: `new-${newRowCounter.current}`,
        endMessage: null,
        endTitles: [],
        endValues: [],
        hasAnswers: false,
        id: null,
        isActive: true,
        kind: "tappable",
        options: [newOption()],
        questionKey: null,
        // Blank, like the button above it — a brand-new question starts on the generic defaults, so
        // nothing is stored until the owner actually words them.
        sectionTitle: "",
        showIfSummary: null,
      },
    ]);
    setNotice(null);
  }

  function updateRow(clientKey: string, patch: Partial<EditableQuestion>) {
    setRows((prev) => prev.map((row) => (row.clientKey === clientKey ? { ...row, ...patch } : row)));
  }

  function updateOption(clientKey: string, index: number, patch: Partial<EditableOption>) {
    setRows((prev) =>
      prev.map((row) =>
        row.clientKey === clientKey
          ? { ...row, options: row.options.map((option, i) => (i === index ? { ...option, ...patch } : option)) }
          : row,
      ),
    );
  }

  function addOption(clientKey: string) {
    setRows((prev) =>
      prev.map((row) => (row.clientKey === clientKey ? { ...row, options: [...row.options, newOption()] } : row)),
    );
  }

  function removeOption(clientKey: string, index: number) {
    setRows((prev) =>
      prev.map((row) =>
        row.clientKey === clientKey ? { ...row, options: row.options.filter((_, i) => i !== index) } : row,
      ),
    );
  }

  function moveRow(index: number, direction: -1 | 1) {
    setRows((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function refresh() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/screening-questions");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as { questions: ScreeningQuestionAdminRow[] };
      setRows((json.questions ?? []).map(fromServerRow));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  const allIssues = React.useMemo(() => rows.flatMap((row) => rowIssues(row)), [rows]);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/screening-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questions: rows.map((row) => ({
            appliesToRoleFamilies: row.appliesToRoleFamilies,
            bodyText: row.bodyText.trim(),
            buttonLabel: row.kind === "tappable" ? row.buttonLabel.trim() : null,
            endMessage: row.endMessage === null ? undefined : row.endMessage.trim(),
            id: row.id,
            isActive: row.isActive,
            kind: row.kind,
            options: row.kind === "tappable" ? withStableOptionValues(row.options) : null,
            sectionTitle: row.kind === "tappable" ? row.sectionTitle.trim() : null,
          })),
        }),
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(json.error ?? json.message ?? `HTTP ${response.status}`);
      }
      const json = (await response.json()) as { questions: ScreeningQuestionAdminRow[] };
      setRows((json.questions ?? []).map(fromServerRow));
      setNotice("Saved. The bot uses the new list on the very next reply.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function deleteQuestion(row: EditableQuestion) {
    if (!row.id) {
      setRows((prev) => prev.filter((item) => item.clientKey !== row.clientKey));
      return;
    }
    setDeletingKey(row.clientKey);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/screening-questions?id=${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(json.error ?? json.message ?? `HTTP ${response.status}`);
      }
      setRows((prev) => prev.filter((item) => item.clientKey !== row.clientKey));
      setNotice("Question deleted.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeletingKey(null);
    }
  }

  return (
    <div className={embedded ? "space-y-6" : "space-y-6 p-6"}>
      <AdminSectionHeader
        action={
          <Button aria-label="Refresh" disabled={loading} onClick={refresh} size="sm" variant="outline">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        }
        description="Brand-new questions of your own, asked AFTER the six above. Add a tappable list or a free-text question, put them in the order you want, and save. No code change, no deploy — it takes effect on the very next reply."
        title="Extra questions you add"
      />

      {error ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </AdminCallout>
      ) : null}

      {notice ? (
        <AdminCallout tone="success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </AdminCallout>
      ) : null}

      {rows.length === 0 ? (
        <Card className="p-5">
          <p className="text-sm text-slate-500">
            No extra questions are configured. The bot stops at the fixed six, exactly as it always has.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((row, index) => {
            const issues = rowIssues(row);
            // ANSWERED QUESTIONS: the WORDING is editable and the STRUCTURE is not. Owner's
            // decision, 2026-09-05, asked directly - he wanted to be able to edit a question people
            // had already answered, and chose the narrower of the two ways to give him that.
            //
            // What that line separates: retitling an answer is a relabel, because the code beneath
            // it is sticky (see EditableOption) and stored answers hold the TITLE AS IT READ WHEN IT
            // WAS ANSWERED - a historical fact this screen cannot reach in either direction. Adding
            // or removing an answer, or switching the question between tappable and free text, is
            // not a relabel: it changes what a menu already on somebody's phone can send back, and
            // there is no reading of the old answers that survives it.
            const structureLocked = row.hasAnswers;
            return (
              <Card className="p-4" key={row.clientKey}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center bg-slate-100 text-phx-xs font-bold text-slate-500">
                      {index + 1}
                    </span>
                    <div className="flex flex-col">
                      <Button
                        aria-label="Move up"
                        className="h-5 w-6 p-0"
                        disabled={index === 0}
                        onClick={() => moveRow(index, -1)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        aria-label="Move down"
                        className="h-5 w-6 p-0"
                        disabled={index === rows.length - 1}
                        onClick={() => moveRow(index, 1)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {row.questionKey ? (
                      <span className="bg-slate-100 px-1.5 py-0.5 font-mono text-phx-2xs text-slate-500">
                        {row.questionKey}
                      </span>
                    ) : (
                      <span className="bg-blue-50 px-1.5 py-0.5 text-phx-2xs font-bold uppercase tracking-wider text-blue-600">
                        New
                      </span>
                    )}
                    {structureLocked ? (
                      <span className="bg-amber-50 px-1.5 py-0.5 text-phx-2xs font-bold uppercase tracking-wider text-amber-700">
                        Answered — wording only
                      </span>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-phx-xs font-semibold text-slate-500">
                      <Switch checked={row.isActive} onChange={(checked) => updateRow(row.clientKey, { isActive: checked })} />
                      {row.isActive ? "Active" : "Inactive"}
                    </label>
                    {!structureLocked ? (
                      <Button
                        aria-label="Delete question"
                        disabled={deletingKey === row.clientKey}
                        onClick={() => deleteQuestion(row)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {deletingKey === row.clientKey ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4 text-red-500" />
                        )}
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="mt-3">
                  <div className="flex items-center justify-between">
                    <label className="text-phx-xs font-bold uppercase tracking-wider text-slate-400" htmlFor={`body-${row.clientKey}`}>
                      Question text
                    </label>
                    <span className={`text-phx-2xs ${counterClass(row.bodyText.length, WHATSAPP_BODY_MAX)}`}>
                      {row.bodyText.length} / {WHATSAPP_BODY_MAX}
                    </span>
                  </div>
                  <textarea
                    className={`${phxTextareaClassName} mt-1`}
                    id={`body-${row.clientKey}`}
                    onChange={(event) => updateRow(row.clientKey, { bodyText: event.target.value })}
                    placeholder="e.g. Do you already have a valid driving license?"
                    rows={2}
                    value={row.bodyText}
                  />
                </div>

                <div className="mt-3 flex items-center gap-4">
                  <span className="text-phx-xs font-bold uppercase tracking-wider text-slate-400">Answer type</span>
                  <label className="flex items-center gap-1.5 text-sm text-slate-700">
                    <input
                      checked={row.kind === "tappable"}
                      disabled={structureLocked}
                      onChange={() => updateRow(row.clientKey, { kind: "tappable" })}
                      type="radio"
                    />
                    Tappable options
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-slate-700">
                    <input
                      checked={row.kind === "free_text"}
                      disabled={structureLocked}
                      onChange={() => updateRow(row.clientKey, { kind: "free_text" })}
                      type="radio"
                    />
                    Free text
                  </label>
                </div>

                {/* WHO IS ASKED. The same component the six built-in questions above use, so the
                    two halves of this screen cannot describe the same control differently.
                    Deliberately NOT disabled when the question is answered: the lock protects the
                    answer CODES already collected under this key, and narrowing who gets asked NEXT
                    orphans nothing. "Stop asking reps this" is exactly the edit somebody needs to
                    make on a live question. */}
                <div className="mt-3">
                  <QuestionAudiencePicker
                    idPrefix={`extra-${row.clientKey}`}
                    onChange={(next) => updateRow(row.clientKey, { appliesToRoleFamilies: next })}
                    value={row.appliesToRoleFamilies}
                  />
                </div>

                {row.showIfSummary ? (
                  <p className="mt-3 text-phx-xs text-slate-500">{row.showIfSummary}</p>
                ) : null}

                {row.endMessage !== null ? (
                  <div className="mt-3">
                    <div className="flex items-center justify-between">
                      <label
                        className="text-phx-xs font-bold uppercase tracking-wider text-slate-400"
                        htmlFor={`end-${row.clientKey}`}
                      >
                        {`Sent when the answer is ${row.endTitles.join(" or ")} - the conversation ends here`}
                      </label>
                      <span className={`text-phx-2xs ${counterClass((row.endMessage ?? "").length, WHATSAPP_BODY_MAX)}`}>
                        {(row.endMessage ?? "").length} / {WHATSAPP_BODY_MAX}
                      </span>
                    </div>
                    <textarea
                      className={`mt-1 ${phxTextareaClassName}`}
                      id={`end-${row.clientKey}`}
                      onChange={(event) => updateRow(row.clientKey, { endMessage: event.target.value })}
                      rows={4}
                      value={row.endMessage ?? ""}
                    />
                  </div>
                ) : null}

                {row.kind === "tappable" ? (
                  <div className="mt-3 space-y-2">
                    {/* The two words WhatsApp puts AROUND the list, not inside the message: the
                        button is the tap target under it, and the heading sits above the answers.
                        Left empty they stay generic and English, which is what made a reworded
                        question read half-translated — so the placeholder shows exactly what an
                        empty box sends rather than leaving it a mystery. */}
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <Input
                          aria-label="The button that opens the answers"
                          maxLength={WHATSAPP_LIST_BUTTON_MAX + 10}
                          onChange={(event) => updateRow(row.clientKey, { buttonLabel: event.target.value })}
                          placeholder={EXTRA_QUESTION_BUTTON_DEFAULT}
                          value={row.buttonLabel}
                        />
                        <span
                          className={`text-phx-2xs ${counterClass(row.buttonLabel.length, WHATSAPP_LIST_BUTTON_MAX)}`}
                        >
                          Button — {row.buttonLabel.length} / {WHATSAPP_LIST_BUTTON_MAX}
                        </span>
                      </div>
                      <div>
                        <Input
                          aria-label="The heading above the answers"
                          maxLength={WHATSAPP_SECTION_TITLE_MAX + 10}
                          onChange={(event) => updateRow(row.clientKey, { sectionTitle: event.target.value })}
                          placeholder={EXTRA_QUESTION_SECTION_DEFAULT}
                          value={row.sectionTitle}
                        />
                        <span
                          className={`text-phx-2xs ${counterClass(row.sectionTitle.length, WHATSAPP_SECTION_TITLE_MAX)}`}
                        >
                          Heading — {row.sectionTitle.length} / {WHATSAPP_SECTION_TITLE_MAX}
                        </span>
                      </div>
                    </div>

                    {row.options.map((option, optionIndex) => (
                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" key={optionIndex}>
                        <div>
                          <Input
                            aria-label={`Option ${optionIndex + 1} title`}
                            maxLength={WHATSAPP_ROW_TITLE_MAX + 20}
                            onChange={(event) => updateOption(row.clientKey, optionIndex, { title: event.target.value })}
                            placeholder="Option text"
                            value={option.title}
                          />
                          <span className={`text-phx-2xs ${counterClass(option.title.length, WHATSAPP_ROW_TITLE_MAX)}`}>
                            {option.title.length} / {WHATSAPP_ROW_TITLE_MAX}
                          </span>
                        </div>
                        <div>
                          <Input
                            aria-label={`Option ${optionIndex + 1} description`}
                            maxLength={WHATSAPP_ROW_DESCRIPTION_MAX + 20}
                            onChange={(event) => updateOption(row.clientKey, optionIndex, { description: event.target.value })}
                            placeholder="Description (optional)"
                            value={option.description}
                          />
                          <span className={`text-phx-2xs ${counterClass(option.description.length, WHATSAPP_ROW_DESCRIPTION_MAX)}`}>
                            {option.description.length} / {WHATSAPP_ROW_DESCRIPTION_MAX}
                          </span>
                        </div>
                        {!structureLocked ? (
                          <Button
                            aria-label="Remove option"
                            className="h-9 w-9 shrink-0 self-start p-0"
                            disabled={row.options.length <= 1}
                            onClick={() => removeOption(row.clientKey, optionIndex)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        ) : null}
                      </div>
                    ))}
                    {!structureLocked ? (
                      <Button
                        className="gap-1.5"
                        disabled={row.options.length >= WHATSAPP_LIST_MAX_ROWS}
                        onClick={() => addOption(row.clientKey)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add option
                      </Button>
                    ) : null}
                    <p className="text-phx-2xs text-slate-400">
                      {`${row.options.length} / ${WHATSAPP_LIST_MAX_ROWS} options — WhatsApp's own limit.`}
                    </p>
                  </div>
                ) : null}

                {issues.length > 0 ? (
                  <AdminCallout tone="warning">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      {issues.map((issue) => (
                        <p key={issue}>{issue}</p>
                      ))}
                    </div>
                  </AdminCallout>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button className="gap-1.5" onClick={addQuestion} type="button" variant="outline">
          <Plus className="h-4 w-4" />
          Add question
        </Button>
        <Button className="gap-2" disabled={saving || rows.length === 0 || allIssues.length > 0} onClick={save} type="button">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}
