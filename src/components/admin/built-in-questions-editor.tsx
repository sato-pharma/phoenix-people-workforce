"use client";

import * as React from "react";
import { AlertCircle, ArrowDown, ArrowUp, CheckCircle2, Eye, EyeOff, Loader2, RotateCcw } from "lucide-react";

import { AdminCallout, AdminSectionHeader } from "@/components/admin/admin-design-system";
import { QuestionAudiencePicker } from "@/components/admin/question-audience-picker";
import { candidateRoleFamilyLabels, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  WHATSAPP_BODY_MAX,
  WHATSAPP_LIST_BUTTON_MAX,
  WHATSAPP_LIST_MAX_ROWS,
  WHATSAPP_ROW_DESCRIPTION_MAX,
  WHATSAPP_ROW_TITLE_MAX,
  WHATSAPP_SECTION_TITLE_MAX,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import { audienceViolations } from "@/lib/recruitment/inbound/whatsapp-question-audience";
import {
  answerConfigViolations,
  menuChromeViolations,
  optionLabelViolations,
  promptViolations,
  REGION_TOKEN,
  type OptionLabel,
} from "@/lib/recruitment/inbound/whatsapp-question-prompts";
import {
  phxFieldClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

/**
 * The six questions the WhatsApp CV bot has always asked — the question itself, the answers the
 * applicant taps (their words, which of them are shown, and in what order), and the two words
 * WhatsApp draws around the list: the button that opens it and the heading above the answers.
 *
 * Sits ABOVE the extra-question builder on the same screen, in the order an applicant meets them, so
 * the page tells the truth about the whole conversation rather than showing an empty list and
 * implying the bot asks nothing. Each question saves on its own: this is live text that reaches real
 * applicants on the next reply, and a single "save everything" button would make one careless edit
 * republish five questions the owner never looked at.
 *
 * Every answer shows the CODE it sends back, greyed and not editable. That is the honest thing to
 * put on the screen: it is what the CV pool filters, the candidate folders and the routing to
 * managers read, so it is exactly the part that must not move when the wording does.
 *
 * DELETING AN ANSWER IS HIDING IT, and the screen says so — a hidden answer keeps its place in the
 * list below the shown ones rather than vanishing. Anyone who tapped it before still reads back
 * correctly everywhere, and putting it back is one click. ADDING an answer means switching on one
 * the system already understands but does not currently offer; there is no way to invent a new one
 * here, because a tap the reply handler does not recognise is dropped in silence. To ask something
 * genuinely new, the builder below this one creates a whole question.
 */

export type BuiltInPromptOptionRow = {
  value: string;
  defaultTitle: string;
  defaultDescription?: string;
  offeredByDefault: boolean;
};

export type BuiltInPromptRow = {
  key: string;
  label: string;
  note: string;
  defaultBody: string;
  /**
   * The words WhatsApp puts around the list itself — the button that opens it and the heading above
   * the answers. BOTH NULL for the one free-text question, which has no list: the two boxes are not
   * rendered at all there rather than shown saving into nothing.
   */
  defaultButtonLabel: string | null;
  defaultSectionTitle: string | null;
  supportsRegionToken: boolean;
  options: BuiltInPromptOptionRow[];
  optionsNote: string;
  isCustomised: boolean;
  /**
   * Who is asked this question when nothing is configured. Null means every applicant; `area`
   * carries the owner's Medical-Rep rule here.
   */
  defaultAudience: readonly string[] | null;
  /** False for question 1 alone — it establishes the role, so it cannot be scoped by it. */
  canChooseAudience: boolean;
  /**
   * THREE STATES, and they are not interchangeable — see StoredAudience in
   * whatsapp-question-audience.ts. `null` is "nothing configured", so the question takes
   * `defaultAudience`. `[]` is a saved "asked to everyone", which BEATS that default and is the only
   * way to widen the area question. A non-empty array narrows it to those job titles.
   */
  savedAppliesToRoleFamilies: readonly string[] | null;
  savedBody: string | null;
  savedButtonLabel: string | null;
  savedSectionTitle: string | null;
  savedOptionLabels: Record<string, OptionLabel>;
  savedHiddenOptions: string[];
  savedOptionOrder: string[];
};

type Props = {
  initialPrompts: BuiltInPromptRow[];
};

/** What the applicant reads for one answer right now — saved if there is one, else the code's. */
function liveOptionLabel(prompt: BuiltInPromptRow, option: BuiltInPromptOptionRow): OptionLabel {
  const saved = prompt.savedOptionLabels?.[option.value] ?? {};
  return {
    description: saved.description ?? option.defaultDescription,
    title: saved.title ?? option.defaultTitle,
  };
}

/** The answers this question offers with nothing configured. */
function defaultShownValues(prompt: BuiltInPromptRow): string[] {
  return prompt.options.filter((option) => option.offeredByDefault).map((option) => option.value);
}

/**
 * The answers shown right now, in order — the same rule the bot applies, expressed against the
 * catalogue the screen already has. A saved order comes first; anything offered and not hidden keeps
 * its catalogue place after it, which is what stops a stale saved order silently dropping an answer.
 */
function liveShownValues(prompt: BuiltInPromptRow): string[] {
  const hidden = new Set(prompt.savedHiddenOptions ?? []);
  const order = new Set(prompt.savedOptionOrder ?? []);
  const shows = (option: BuiltInPromptOptionRow) =>
    !hidden.has(option.value) && (option.offeredByDefault || order.has(option.value));

  const out: string[] = [];
  for (const value of prompt.savedOptionOrder ?? []) {
    const option = prompt.options.find((entry) => entry.value === value);
    if (!option || out.includes(value) || !shows(option)) continue;
    out.push(value);
  }
  for (const option of prompt.options) {
    if (out.includes(option.value) || !shows(option)) continue;
    out.push(option.value);
  }
  return out;
}

/** True when the WORDING is overridden - as opposed to a row that exists only to hold an audience. */
function wordingIsCustomised(prompt: BuiltInPromptRow): boolean {
  return Boolean(
    prompt.savedBody
      || prompt.savedButtonLabel
      || prompt.savedSectionTitle
      || Object.keys(prompt.savedOptionLabels ?? {}).length > 0
      || (prompt.savedHiddenOptions ?? []).length > 0
      || (prompt.savedOptionOrder ?? []).length > 0,
  );
}

function counterClass(length: number, max: number): string {
  if (length > max) return "text-red-600";
  if (length > max * 0.9) return "text-amber-600";
  return "text-slate-400";
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

type Draft = {
  audience: string[];
  body: string;
  buttonLabel: string;
  options: Record<string, OptionLabel>;
  sectionTitle: string;
  shown: string[];
};

/**
 * The job titles asked this question RIGHT NOW: what is saved when anything is, else the code
 * default. This is what the tick list is seeded from, so the boxes always show what the bot actually
 * does rather than an empty list that behaves as though one box were ticked.
 *
 * `?? prompt.defaultAudience ?? []` reads the three states in order: a saved `[]` (everyone) short-
 * circuits the first `??` and correctly shows nothing ticked, a saved list shows itself, and only a
 * saved `null` falls through to the default.
 */
function liveAudience(prompt: BuiltInPromptRow): string[] {
  return [...(prompt.savedAppliesToRoleFamilies ?? prompt.defaultAudience ?? [])];
}

function draftFor(prompt: BuiltInPromptRow): Draft {
  return {
    audience: liveAudience(prompt),
    body: prompt.savedBody ?? prompt.defaultBody,
    buttonLabel: prompt.savedButtonLabel ?? prompt.defaultButtonLabel ?? "",
    options: Object.fromEntries(
      prompt.options.map((option) => [option.value, liveOptionLabel(prompt, option)]),
    ),
    sectionTitle: prompt.savedSectionTitle ?? prompt.defaultSectionTitle ?? "",
    shown: liveShownValues(prompt),
  };
}

/**
 * What to SEND for the list button and the answer heading: the typed words, or "" when they still
 * match the code's own. Same rule as the answer labels — storing a copy of a default is what makes a
 * later improvement to the code's wording invisible on a question nobody meant to customise.
 */
function changedMenuChrome(
  prompt: BuiltInPromptRow,
  draft: Draft,
): { buttonLabel: string; sectionTitle: string } {
  const button = draft.buttonLabel.trim();
  const section = draft.sectionTitle.trim();
  return {
    buttonLabel: button && button !== (prompt.defaultButtonLabel ?? "") ? button : "",
    sectionTitle: section && section !== (prompt.defaultSectionTitle ?? "") ? section : "",
  };
}

/**
 * What to SEND for one answer: only the fields the admin actually changed away from the code's own.
 * Sending a value equal to the default would store a copy that then silently goes stale the day the
 * code default is improved — the same reason there are no seed rows in the table.
 */
function changedOptionLabels(prompt: BuiltInPromptRow, draft: Draft): Record<string, OptionLabel> {
  const out: Record<string, OptionLabel> = {};
  for (const option of prompt.options) {
    const typed = draft.options[option.value] ?? {};
    const entry: OptionLabel = {};
    const title = (typed.title ?? "").trim();
    const description = (typed.description ?? "").trim();
    if (title && title !== option.defaultTitle) entry.title = title;
    if (description && description !== (option.defaultDescription ?? "")) {
      entry.description = description;
    }
    if (entry.title !== undefined || entry.description !== undefined) out[option.value] = entry;
  }
  return out;
}

/**
 * What to SEND for the answer set. An unchanged set sends two empty lists — the same "store nothing
 * you did not change" rule the labels follow, so a question left alone keeps reading as Default and
 * a later change to the code's own answers reaches it.
 */
function answerConfigToSend(
  prompt: BuiltInPromptRow,
  draft: Draft,
): { hiddenOptions: string[]; optionOrder: string[] } {
  if (sameList(draft.shown, defaultShownValues(prompt))) {
    return { hiddenOptions: [], optionOrder: [] };
  }
  return {
    hiddenOptions: prompt.options
      .map((option) => option.value)
      .filter((value) => !draft.shown.includes(value)),
    optionOrder: [...draft.shown],
  };
}

export function BuiltInQuestionsEditor({ initialPrompts }: Props) {
  const [prompts, setPrompts] = React.useState<BuiltInPromptRow[]>(initialPrompts);
  // What is currently in each box. Seeded from what is saved, falling back to the code default, so
  // every box always shows exactly what an applicant would read right now.
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>(() =>
    Object.fromEntries(initialPrompts.map((prompt) => [prompt.key, draftFor(prompt)])),
  );
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  function applyServerPrompts(next: BuiltInPromptRow[]) {
    setPrompts(next);
    setDrafts(Object.fromEntries(next.map((prompt) => [prompt.key, draftFor(prompt)])));
  }

  function setOptionField(
    key: string,
    value: string,
    field: "title" | "description",
    text: string,
  ) {
    setDrafts((prev) => {
      const draft = prev[key];
      if (!draft) return prev;
      return {
        ...prev,
        [key]: {
          ...draft,
          options: {
            ...draft.options,
            [value]: { ...(draft.options[value] ?? {}), [field]: text },
          },
        },
      };
    });
  }

  function setShown(key: string, next: (shown: string[]) => string[]) {
    setDrafts((prev) => {
      const draft = prev[key];
      if (!draft) return prev;
      return { ...prev, [key]: { ...draft, shown: next(draft.shown) } };
    });
  }

  function moveAnswer(key: string, value: string, direction: -1 | 1) {
    setShown(key, (shown) => {
      const from = shown.indexOf(value);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= shown.length) return shown;
      const next = [...shown];
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  }

  async function post(
    key: string,
    payload: {
      bodyText: string;
      optionLabels: Record<string, OptionLabel>;
      hiddenOptions: string[];
      optionOrder: string[];
      /** Blank means "keep the code's own words" — the same gesture as a blank bodyText. */
      buttonLabel?: string;
      sectionTitle?: string;
      /** Omitted entirely for question 1, which cannot be scoped. `null` clears the audience back
       *  to the code default — the reset gesture. */
      appliesToRoleFamilies?: string[] | null;
    },
    successMessage: string,
  ) {
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/question-prompts", {
        body: JSON.stringify({ ...payload, key }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(json.message ?? json.error ?? `HTTP ${response.status}`);
      }
      const json = (await response.json()) as { prompts: BuiltInPromptRow[] };
      applyServerPrompts(json.prompts ?? []);
      setNotice(successMessage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-4">
      <AdminSectionHeader
        description="These six are built in — the bot has always asked them, in this order, and they run before anything you add below. You can change every word an applicant reads, switch answers on and off, and put them in the order you want. What you cannot change is the code under each answer, shown beside it — the CV pool filters, the candidate folders and the routing to managers all read that code, so it stays put while the wording moves."
        title="The six questions the bot always asks"
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

      <div className="space-y-3">
        {prompts.map((prompt) => {
          const draft = drafts[prompt.key] ?? draftFor(prompt);
          const liveBody = prompt.savedBody ?? prompt.defaultBody;
          const nextOptionLabels = changedOptionLabels(prompt, draft);
          const nextAnswerConfig = answerConfigToSend(prompt, draft);
          const nextChrome = changedMenuChrome(prompt, draft);
          const bodyDirty = draft.body.trim() !== liveBody.trim();
          const chromeDirty =
            nextChrome.buttonLabel !== (prompt.savedButtonLabel ?? "")
            || nextChrome.sectionTitle !== (prompt.savedSectionTitle ?? "");
          const optionsDirty =
            JSON.stringify(nextOptionLabels) !== JSON.stringify(prompt.savedOptionLabels ?? {});
          const answersDirty = !sameList(draft.shown, liveShownValues(prompt));
          // Order-insensitive: ticking two boxes in the other order is not an edit.
          const audienceDirty =
            !sameList([...draft.audience].sort(), [...liveAudience(prompt)].sort());
          const dirty = bodyDirty || optionsDirty || answersDirty || audienceDirty || chromeDirty;

          const optionByValue = new Map(prompt.options.map((option) => [option.value, option]));
          const hiddenValues = prompt.options
            .map((option) => option.value)
            .filter((value) => !draft.shown.includes(value));

          const issues = [
            ...promptViolations({ bodyText: draft.body, key: prompt.key }),
            ...audienceViolations({ appliesToRoleFamilies: draft.audience, key: prompt.key }),
            // Checked on what is TYPED, not on what would be sent: a 30-character button that
            // happens to equal no default must still show the limit rather than silently save as
            // "unchanged" and leave the box looking accepted.
            ...menuChromeViolations({ buttonLabel: draft.buttonLabel, sectionTitle: draft.sectionTitle }),
            ...optionLabelViolations({
              allowedValues: prompt.options.map((option) => option.value),
              key: prompt.key,
              optionLabels: nextOptionLabels,
            }),
            ...(prompt.options.length > 0
              ? answerConfigViolations({
                  allowedValues: prompt.options.map((option) => option.value),
                  defaultOfferedValues: defaultShownValues(prompt),
                  hiddenOptions: nextAnswerConfig.hiddenOptions,
                  key: prompt.key,
                  optionOrder: nextAnswerConfig.optionOrder,
                })
              : []),
          ];
          const busy = busyKey === prompt.key;

          return (
            <Card className="p-4" key={prompt.key}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-800">{prompt.label}</p>
                  <p className="mt-0.5 text-phx-xs text-slate-500">{prompt.note}</p>
                </div>
                {/* Narrowing a question whose wording is untouched now saves a row, so
                    `isCustomised` alone would label it "Your wording" and send somebody hunting for
                    an edit that was never made. The badge names what actually changed. */}
                <span
                  className={
                    prompt.isCustomised
                      ? "bg-orange-50 px-2 py-0.5 text-phx-xs font-semibold text-orange-700"
                      : "bg-slate-100 px-2 py-0.5 text-phx-xs font-semibold text-slate-500"
                  }
                >
                  {wordingIsCustomised(prompt)
                    ? "Your wording"
                    : prompt.isCustomised
                      ? "Your audience"
                      : "Default"}
                </span>
              </div>

              <label className="mt-3 block text-phx-xs font-medium text-slate-600" htmlFor={`prompt-${prompt.key}`}>
                What the applicant reads
              </label>
              <textarea
                className={`${phxTextareaClassName} mt-1`}
                disabled={busy}
                id={`prompt-${prompt.key}`}
                onChange={(event) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [prompt.key]: { ...draft, body: event.target.value },
                  }))
                }
                rows={3}
                value={draft.body}
              />

              <div className="mt-1 flex justify-end">
                <span className={`text-phx-xs ${counterClass(draft.body.trim().length, WHATSAPP_BODY_MAX)}`}>
                  {draft.body.trim().length} / {WHATSAPP_BODY_MAX}
                </span>
              </div>

              {prompt.supportsRegionToken ? (
                <p className="mt-1 text-phx-xs text-slate-500">
                  Write <code className="bg-slate-100 px-1 py-0.5 text-slate-700">{REGION_TOKEN}</code> where
                  the region name should appear — the bot replaces it with the region they chose.
                </p>
              ) : null}

              {/* -- The two words AROUND the list -----------------------------------------------
                  WhatsApp does not draw these inside the message: the button is the tap target
                  under it, and the heading sits above the answers once it opens. They are the
                  reason a question reworded into Arabic still read half-English, so they belong on
                  the same card as the question rather than in a settings page somewhere.
                  Not rendered for the free-text question — no list, nothing to label. */}
              {prompt.defaultButtonLabel === null ? null : (
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  <div>
                    <label
                      className="block text-phx-xs font-medium text-slate-600"
                      htmlFor={`button-${prompt.key}`}
                    >
                      The button that opens the answers
                    </label>
                    <input
                      className={`${phxFieldClassName} mt-1`}
                      disabled={busy}
                      id={`button-${prompt.key}`}
                      onChange={(event) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [prompt.key]: { ...draft, buttonLabel: event.target.value },
                        }))
                      }
                      value={draft.buttonLabel}
                    />
                    <div className="mt-0.5 flex justify-end">
                      <span
                        className={`text-phx-xs ${counterClass(draft.buttonLabel.trim().length, WHATSAPP_LIST_BUTTON_MAX)}`}
                      >
                        {draft.buttonLabel.trim().length} / {WHATSAPP_LIST_BUTTON_MAX}
                      </span>
                    </div>
                  </div>

                  <div>
                    <label
                      className="block text-phx-xs font-medium text-slate-600"
                      htmlFor={`section-${prompt.key}`}
                    >
                      The heading above the answers
                    </label>
                    <input
                      className={`${phxFieldClassName} mt-1`}
                      disabled={busy}
                      id={`section-${prompt.key}`}
                      onChange={(event) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [prompt.key]: { ...draft, sectionTitle: event.target.value },
                        }))
                      }
                      value={draft.sectionTitle}
                    />
                    <div className="mt-0.5 flex justify-end">
                      <span
                        className={`text-phx-xs ${counterClass(draft.sectionTitle.trim().length, WHATSAPP_SECTION_TITLE_MAX)}`}
                      >
                        {draft.sectionTitle.trim().length} / {WHATSAPP_SECTION_TITLE_MAX}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* -- Who is asked ------------------------------------------------------------------
                  The owner's 2026-09-05 request, and the same control the extra questions below
                  carry - one component, so the two cannot drift. Question 1 gets a sentence instead
                  of a tick list: it establishes the role every other audience is judged against, so
                  there is nothing to judge it by. Saying that on the screen is the point - a missing
                  control reads as an oversight, and the next session would "fix" it. */}
              <div className="mt-4">
                {prompt.canChooseAudience ? (
                  <QuestionAudiencePicker
                    disabled={busy}
                    // On `area` "everyone" is a real change from what the bot does today, so the
                    // caption says which it is rather than stating a neutral fact that happens to be
                    // false for this one question.
                    everyoneNote={
                      prompt.defaultAudience && prompt.defaultAudience.length > 0
                        ? "Nothing ticked - every applicant is asked this question, widening it from the "
                          + `${prompt.defaultAudience
                              .map((family) => candidateRoleFamilyLabels[family as CandidateRoleFamily] ?? family)
                              .join(", ")} it asks today.`
                        : undefined
                    }
                    idPrefix={`builtin-${prompt.key}`}
                    onChange={(next) =>
                      setDrafts((prev) => ({ ...prev, [prompt.key]: { ...draft, audience: next } }))
                    }
                    value={draft.audience}
                  />
                ) : (
                  <>
                    <span className="text-phx-xs font-bold uppercase tracking-wider text-slate-400">
                      Who is asked
                    </span>
                    <p className="mt-1 text-phx-xs text-slate-500">
                      Everyone, always. This is the question that asks which job they want, so it is
                      the answer every other question&apos;s job-title list is matched against
                      - it cannot be limited by one.
                    </p>
                  </>
                )}
              </div>

              {/* -- The answers -------------------------------------------------------------- */}
              <div className="mt-4 border border-slate-200 bg-slate-50/60 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="text-phx-xs font-medium text-slate-600">What the applicant can answer</p>
                  {prompt.options.length > 0 ? (
                    <span
                      className={`text-phx-xs ${counterClass(draft.shown.length, WHATSAPP_LIST_MAX_ROWS)}`}
                    >
                      {draft.shown.length} shown / {WHATSAPP_LIST_MAX_ROWS} allowed
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-phx-xs text-slate-500">{prompt.optionsNote}</p>

                {prompt.options.length === 0 ? null : (
                  <div className="mt-3 space-y-3">
                    {draft.shown.map((value, index) => {
                      const option = optionByValue.get(value);
                      if (!option) return null;
                      const typed = draft.options[value] ?? {};
                      const title = typed.title ?? "";
                      const description = typed.description ?? "";
                      return (
                        <div className="border border-slate-200 bg-white p-3" key={value}>
                          {/* The label and the code are separate elements, not one sentence: at
                              375px the longest code (national_sales_manager) broke across two lines
                              inside a combined badge, and a code split mid-word reads as two codes. */}
                          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                            <span className="text-phx-xs font-semibold text-slate-500">
                              Answer {index + 1}
                            </span>
                            <span className="flex items-center gap-1.5">
                              <span className="text-phx-xs text-slate-400">sends back</span>
                              <span className="break-all bg-slate-100 px-1.5 py-0.5 font-mono text-phx-xs text-slate-500">
                                {value}
                              </span>
                            </span>
                          </div>

                          <div className="mt-2 grid gap-2 md:grid-cols-2">
                            <div>
                              <label
                                className="block text-phx-xs font-medium text-slate-600"
                                htmlFor={`opt-${prompt.key}-${value}-title`}
                              >
                                What they see
                              </label>
                              <input
                                className={`${phxFieldClassName} mt-1`}
                                disabled={busy}
                                id={`opt-${prompt.key}-${value}-title`}
                                onChange={(event) =>
                                  setOptionField(prompt.key, value, "title", event.target.value)
                                }
                                value={title}
                              />
                              <div className="mt-0.5 flex justify-end">
                                <span
                                  className={`text-phx-xs ${counterClass(title.trim().length, WHATSAPP_ROW_TITLE_MAX)}`}
                                >
                                  {title.trim().length} / {WHATSAPP_ROW_TITLE_MAX}
                                </span>
                              </div>
                            </div>

                            <div>
                              <label
                                className="block text-phx-xs font-medium text-slate-600"
                                htmlFor={`opt-${prompt.key}-${value}-desc`}
                              >
                                Second line, if any
                              </label>
                              <input
                                className={`${phxFieldClassName} mt-1`}
                                disabled={busy}
                                id={`opt-${prompt.key}-${value}-desc`}
                                onChange={(event) =>
                                  setOptionField(prompt.key, value, "description", event.target.value)
                                }
                                value={description}
                              />
                              <div className="mt-0.5 flex justify-end">
                                <span
                                  className={`text-phx-xs ${counterClass(description.trim().length, WHATSAPP_ROW_DESCRIPTION_MAX)}`}
                                >
                                  {description.trim().length} / {WHATSAPP_ROW_DESCRIPTION_MAX}
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <Button
                              aria-label={`Move ${title || value} up`}
                              disabled={busy || index === 0}
                              onClick={() => moveAnswer(prompt.key, value, -1)}
                              size="sm"
                              variant="outline"
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              aria-label={`Move ${title || value} down`}
                              disabled={busy || index === draft.shown.length - 1}
                              onClick={() => moveAnswer(prompt.key, value, 1)}
                              size="sm"
                              variant="outline"
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              disabled={busy}
                              onClick={() =>
                                setShown(prompt.key, (shown) => shown.filter((entry) => entry !== value))
                              }
                              size="sm"
                              variant="outline"
                            >
                              <EyeOff className="mr-1 h-3.5 w-3.5" />
                              Do not show this
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {hiddenValues.length > 0 ? (
                  <div className="mt-3">
                    <p className="text-phx-xs font-medium text-slate-600">Not shown to applicants</p>
                    <p className="mt-0.5 text-phx-xs text-slate-500">
                      These answers still exist and anyone who chose one before is unaffected — they are
                      simply not offered. Switch one on and it appears at the bottom of the list.
                    </p>
                    <div className="mt-2 space-y-2">
                      {hiddenValues.map((value) => {
                        const option = optionByValue.get(value);
                        if (!option) return null;
                        return (
                          <div
                            className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border border-dashed border-slate-300 bg-white/60 p-2"
                            key={value}
                          >
                            <span className="text-phx-xs text-slate-500">{option.defaultTitle}</span>
                            <span className="flex items-center gap-1.5">
                              <span className="break-all bg-slate-100 px-1.5 py-0.5 font-mono text-phx-xs text-slate-500">
                                {value}
                              </span>
                              <Button
                                disabled={busy}
                                onClick={() => setShown(prompt.key, (shown) => [...shown, value])}
                                size="sm"
                                variant="outline"
                              >
                                <Eye className="mr-1 h-3.5 w-3.5" />
                                Show this
                              </Button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>

              {issues.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {issues.map((issue) => (
                    <p className="text-phx-xs text-red-600" key={issue}>
                      {issue}
                    </p>
                  ))}
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  disabled={busy || !dirty || issues.length > 0}
                  onClick={() =>
                    post(
                      prompt.key,
                      {
                        bodyText:
                          draft.body.trim() === prompt.defaultBody.trim() ? "" : draft.body.trim(),
                        optionLabels: nextOptionLabels,
                        ...nextAnswerConfig,
                        ...nextChrome,
                        // Sent as the ticked list, empty included - an empty array is "asked to
                        // everyone" and is a real, storable decision, not the absence of one. Never
                        // sent for question 1, whose audience is not a choice.
                        ...(prompt.canChooseAudience ? { appliesToRoleFamilies: draft.audience } : {}),
                      },
                      "Saved. The bot uses this on the very next applicant.",
                    )
                  }
                  size="sm"
                >
                  {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  Save this question
                </Button>

                {prompt.isCustomised ? (
                  <Button
                    disabled={busy}
                    // An empty body, no labels, no answer changes and a NULL audience is the reset
                    // gesture the route understands: the row is dropped and the code's own words,
                    // answers and audience return together. The null is what makes it a whole reset
                    // rather than a wording one - omitting the field would leave a narrowed question
                    // narrowed, under a button that says it went back to default.
                    onClick={() =>
                      post(
                        prompt.key,
                        {
                          appliesToRoleFamilies: null,
                          bodyText: "",
                          buttonLabel: "",
                          hiddenOptions: [],
                          optionLabels: {},
                          optionOrder: [],
                          sectionTitle: "",
                        },
                        "Back to the default question, answers and audience.",
                      )
                    }
                    size="sm"
                    variant="outline"
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    Reset to default
                  </Button>
                ) : null}

                {dirty ? <span className="text-phx-xs text-amber-600">Not saved yet</span> : null}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
