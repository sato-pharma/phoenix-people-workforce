"use client";

import * as React from "react";
import { AlertCircle, ArrowDown, ArrowUp, CheckCircle2, Eye, EyeOff, Loader2, RotateCcw } from "lucide-react";

import { AdminCallout, AdminSectionHeader } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  WHATSAPP_BODY_MAX,
  WHATSAPP_LIST_MAX_ROWS,
  WHATSAPP_ROW_DESCRIPTION_MAX,
  WHATSAPP_ROW_TITLE_MAX,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import {
  answerConfigViolations,
  optionLabelViolations,
  promptViolations,
  REGION_TOKEN,
  type OptionLabel,
} from "@/lib/recruitment/inbound/whatsapp-question-prompts";

/**
 * The six questions the WhatsApp CV bot has always asked — the question itself AND the answers the
 * applicant taps: their words, which of them are shown, and in what order.
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
  supportsRegionToken: boolean;
  options: BuiltInPromptOptionRow[];
  optionsNote: string;
  isCustomised: boolean;
  savedBody: string | null;
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

function counterClass(length: number, max: number): string {
  if (length > max) return "text-red-600";
  if (length > max * 0.9) return "text-amber-600";
  return "text-slate-400";
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

type Draft = { body: string; options: Record<string, OptionLabel>; shown: string[] };

function draftFor(prompt: BuiltInPromptRow): Draft {
  return {
    body: prompt.savedBody ?? prompt.defaultBody,
    options: Object.fromEntries(
      prompt.options.map((option) => [option.value, liveOptionLabel(prompt, option)]),
    ),
    shown: liveShownValues(prompt),
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
          const bodyDirty = draft.body.trim() !== liveBody.trim();
          const optionsDirty =
            JSON.stringify(nextOptionLabels) !== JSON.stringify(prompt.savedOptionLabels ?? {});
          const answersDirty = !sameList(draft.shown, liveShownValues(prompt));
          const dirty = bodyDirty || optionsDirty || answersDirty;

          const optionByValue = new Map(prompt.options.map((option) => [option.value, option]));
          const hiddenValues = prompt.options
            .map((option) => option.value)
            .filter((value) => !draft.shown.includes(value));

          const issues = [
            ...promptViolations({ bodyText: draft.body, key: prompt.key }),
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
                {prompt.isCustomised ? (
                  <span className="rounded-full bg-orange-50 px-2 py-0.5 text-phx-xs font-semibold text-orange-700">
                    Your wording
                  </span>
                ) : (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-phx-xs font-semibold text-slate-500">
                    Default
                  </span>
                )}
              </div>

              <label className="mt-3 block text-phx-xs font-medium text-slate-600" htmlFor={`prompt-${prompt.key}`}>
                What the applicant reads
              </label>
              <textarea
                className="mt-1 w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-orange-300 disabled:bg-slate-50 disabled:text-slate-400"
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
                  Write <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-700">{REGION_TOKEN}</code> where
                  the region name should appear — the bot replaces it with the region they chose.
                </p>
              ) : null}

              {/* ── The answers ───────────────────────────────────────────────────────────────── */}
              <div className="mt-4 rounded border border-slate-200 bg-slate-50/60 p-3">
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
                        <div className="rounded border border-slate-200 bg-white p-3" key={value}>
                          {/* The label and the code are separate elements, not one sentence: at
                              375px the longest code (national_sales_manager) broke across two lines
                              inside a combined badge, and a code split mid-word reads as two codes. */}
                          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                            <span className="text-phx-xs font-semibold text-slate-500">
                              Answer {index + 1}
                            </span>
                            <span className="flex items-center gap-1.5">
                              <span className="text-phx-xs text-slate-400">sends back</span>
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-phx-xs whitespace-nowrap text-slate-500">
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
                                className="mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700 outline-none focus:border-orange-300 disabled:bg-slate-50 disabled:text-slate-400"
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
                                className="mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700 outline-none focus:border-orange-300 disabled:bg-slate-50 disabled:text-slate-400"
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
                            className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded border border-dashed border-slate-300 bg-white/60 p-2"
                            key={value}
                          >
                            <span className="text-phx-xs text-slate-500">{option.defaultTitle}</span>
                            <span className="flex items-center gap-1.5">
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-phx-xs whitespace-nowrap text-slate-500">
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
                      },
                      "Saved. The bot uses the new wording on the very next applicant.",
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
                    // An empty body with no labels and no answer changes is the reset gesture the
                    // route understands: the row is dropped and the code's own words and answers
                    // return together.
                    onClick={() =>
                      post(
                        prompt.key,
                        { bodyText: "", hiddenOptions: [], optionLabels: {}, optionOrder: [] },
                        "Back to the default question and answers.",
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
