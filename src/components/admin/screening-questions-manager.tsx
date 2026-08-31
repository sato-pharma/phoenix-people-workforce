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
  WHATSAPP_LIST_MAX_ROWS,
  WHATSAPP_ROW_DESCRIPTION_MAX,
  WHATSAPP_ROW_TITLE_MAX,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import { screeningQuestionViolations, type ScreeningQuestionKind } from "@/lib/recruitment/inbound/whatsapp-screening-questions";
import type { ScreeningQuestionAdminRow } from "@/lib/recruitment/inbound/whatsapp-screening-questions-admin";

type Props = {
  initialError: string | null;
  initialQuestions: ScreeningQuestionAdminRow[];
};

type EditableOption = { title: string; description: string };

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
};

function newOption(): EditableOption {
  return { description: "", title: "" };
}

function fromServerRow(row: ScreeningQuestionAdminRow): EditableQuestion {
  return {
    bodyText: row.bodyText,
    clientKey: row.id,
    hasAnswers: row.hasAnswers,
    id: row.id,
    isActive: row.isActive,
    kind: row.kind,
    options: (row.options ?? []).map((option) => ({
      description: option.description ?? "",
      title: option.title,
    })),
    questionKey: row.questionKey,
  };
}

/** The admin never sees or sets the internal row-id token — it is derived from the option's own
 *  title, disambiguated within the question, right before every validation check and every save. */
function withDerivedValues(options: readonly EditableOption[]) {
  const used = new Set<string>();
  return options.map((option, index) => {
    const base = option.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `option_${index + 1}`;
    let value = base;
    let suffix = 2;
    while (used.has(value)) {
      value = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(value);
    return { description: option.description.trim() || null, title: option.title.trim(), value };
  });
}

function rowIssues(question: EditableQuestion): string[] {
  return screeningQuestionViolations({
    bodyText: question.bodyText,
    kind: question.kind,
    // A brand-new row has no question_key yet — the server generates and validates the real one at
    // save time. This placeholder only stands in so the OTHER checks (length, option shape) can run
    // live, without a spurious "key format" complaint on a question nobody has saved yet.
    options: question.kind === "tappable" ? withDerivedValues(question.options) : null,
    questionKey: question.questionKey ?? "draft_question",
  });
}

function counterClass(length: number, max: number): string {
  if (length > max) return "text-red-600";
  if (length > max * 0.9) return "text-amber-600";
  return "text-slate-400";
}

export function ScreeningQuestionsManager({ initialError, initialQuestions }: Props) {
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
        bodyText: "",
        clientKey: `new-${newRowCounter.current}`,
        hasAnswers: false,
        id: null,
        isActive: true,
        kind: "tappable",
        options: [newOption()],
        questionKey: null,
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
            bodyText: row.bodyText.trim(),
            id: row.id,
            isActive: row.isActive,
            kind: row.kind,
            options: row.kind === "tappable" ? withDerivedValues(row.options) : null,
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
    <div className="space-y-6 p-6">
      <AdminSectionHeader
        action={
          <Button aria-label="Refresh" disabled={loading} onClick={refresh} size="sm" variant="outline">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        }
        description="Whatever you add here, the WhatsApp bot asks after its own six questions (role, background, region, area, experience, salary) — those never change. Add a tappable list or a free-text question, put them in the order you want, and save. No code change, no deploy — it takes effect on the very next reply."
        title="WhatsApp Screening Questions"
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
            const locked = row.hasAnswers;
            return (
              <Card className="p-4" key={row.clientKey}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-phx-xs font-bold text-slate-500">
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
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-phx-2xs text-slate-500">
                        {row.questionKey}
                      </span>
                    ) : (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-phx-2xs font-bold uppercase tracking-wider text-blue-600">
                        New
                      </span>
                    )}
                    {locked ? (
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-phx-2xs font-bold uppercase tracking-wider text-amber-700">
                        Answered — locked
                      </span>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-phx-xs font-semibold text-slate-500">
                      <Switch checked={row.isActive} onChange={(checked) => updateRow(row.clientKey, { isActive: checked })} />
                      {row.isActive ? "Active" : "Inactive"}
                    </label>
                    {!locked ? (
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
                    className="mt-1 w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-orange-300 disabled:bg-slate-50 disabled:text-slate-400"
                    disabled={locked}
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
                      disabled={locked}
                      onChange={() => updateRow(row.clientKey, { kind: "tappable" })}
                      type="radio"
                    />
                    Tappable options
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-slate-700">
                    <input
                      checked={row.kind === "free_text"}
                      disabled={locked}
                      onChange={() => updateRow(row.clientKey, { kind: "free_text" })}
                      type="radio"
                    />
                    Free text
                  </label>
                </div>

                {row.kind === "tappable" ? (
                  <div className="mt-3 space-y-2">
                    {row.options.map((option, optionIndex) => (
                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" key={optionIndex}>
                        <div>
                          <Input
                            aria-label={`Option ${optionIndex + 1} title`}
                            disabled={locked}
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
                            disabled={locked}
                            maxLength={WHATSAPP_ROW_DESCRIPTION_MAX + 20}
                            onChange={(event) => updateOption(row.clientKey, optionIndex, { description: event.target.value })}
                            placeholder="Description (optional)"
                            value={option.description}
                          />
                          <span className={`text-phx-2xs ${counterClass(option.description.length, WHATSAPP_ROW_DESCRIPTION_MAX)}`}>
                            {option.description.length} / {WHATSAPP_ROW_DESCRIPTION_MAX}
                          </span>
                        </div>
                        {!locked ? (
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
                    {!locked ? (
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
