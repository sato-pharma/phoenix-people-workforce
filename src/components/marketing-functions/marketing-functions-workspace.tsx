"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { FormBlock, FormError, FormField } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonApproveClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxCheckTileClassName,
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { monthStartDate, monthTitle, shortDateLabel } from "@/lib/marketing-functions/months";
import { categoryFigures, monthFigures } from "@/lib/marketing-functions/rules";
import type { MarketingFunctionItem, MarketingMonthSheet, RepOption } from "@/lib/marketing-functions/types";
import {
  FIELD_VISIT_TYPE_LABELS,
  MARKETING_FUNCTION_CATEGORIES,
  MARKETING_FUNCTION_COLUMNS,
  MARKETING_FUNCTION_EMPHASIS_COLOR,
  MARKETING_FUNCTION_ORIGIN_LABELS,
  MARKETING_FUNCTION_STATUSES,
  MARKETING_FUNCTION_STATUS_LABELS,
  MARKETING_FUNCTIONS_ACTUAL,
  MARKETING_FUNCTIONS_MONTH_END,
  MARKETING_FUNCTIONS_PLANNED,
  MARKETING_FUNCTIONS_PURPOSE,
  MARKETING_FUNCTIONS_TITLE,
  MARKETING_MONTH_STATUS_LABELS,
  type MarketingFunctionCategory,
  type MarketingFunctionCategoryKey,
  type MarketingFunctionStatus,
} from "@/lib/marketing-functions/vocabulary";
import { cn } from "@/lib/utils";

// Dr. Rasha's Monthly Marketing Functions sheet, as a screen. Her eight bands, her fills and her column
// heads are drawn exactly as her workbook draws them (vocabulary.ts — final, never restyled); what the
// screen adds is the one-tap status, the Planned / Actual tag, the counts, carry-forward and the review.

type Row = MarketingFunctionItem & { key: string };

type Props = {
  sheet: MarketingMonthSheet | null;
  monthKey: string;
  monthOptions: string[];
  /** Every Product Manager, for a reader to choose whose sheet to open. Empty for the author himself. */
  authors: RepOption[];
  basePath: string;
  feedbackBasePath: string;
  todayIso: string;
};

const STATUS_CHIP: Record<MarketingFunctionStatus, string> = {
  not_started: "border-slate-300 bg-white text-slate-600",
  in_progress: "border-orange-400 bg-orange-50 text-orange-800",
  done: "border-slate-900 bg-slate-900 text-white",
  postponed: "border-slate-400 bg-slate-100 text-slate-700",
  cancelled: "border-rose-300 bg-rose-50 text-rose-700",
};

let rowSeed = 0;
function withKeys(items: MarketingFunctionItem[]): Row[] {
  return items.map((item) => ({ ...item, key: item.id ?? `new-${(rowSeed += 1)}` }));
}

function stripKeys(rows: Row[]): MarketingFunctionItem[] {
  return rows.map((row) => {
    const { key, ...item } = row;
    void key;
    return item;
  });
}

function CategoryLabel({ category }: { category: MarketingFunctionCategory }) {
  const parts = category.emphasis ? category.detail.split(category.emphasis) : [category.detail];
  return (
    <span className="block text-sm leading-snug text-slate-900">
      <span className="font-black">{category.title}</span>{" "}
      <span className="font-medium">
        {parts.length === 2 ? (
          <>
            {parts[0]}
            <span className="font-bold" style={{ color: MARKETING_FUNCTION_EMPHASIS_COLOR }}>
              {category.emphasis}
            </span>
            {parts[1]}
          </>
        ) : (
          category.detail
        )}
      </span>
    </span>
  );
}

function StatusChip({
  value,
  editable,
  label,
  onChange,
}: {
  value: MarketingFunctionStatus | null;
  editable: boolean;
  label: string;
  onChange: (next: MarketingFunctionStatus | null) => void;
}) {
  if (!editable) {
    return value ? (
      <span className={cn("inline-block border px-2 py-0.5 text-xs font-bold", STATUS_CHIP[value])}>
        {MARKETING_FUNCTION_STATUS_LABELS[value]}
      </span>
    ) : (
      <span className="text-xs text-slate-500">Not set</span>
    );
  }
  return (
    <select
      aria-label={label}
      className={cn(phxSelectClassName, "h-9 text-xs font-bold")}
      onChange={(event) => onChange((event.target.value || null) as MarketingFunctionStatus | null)}
      value={value ?? ""}
    >
      <option value="">Not set</option>
      {MARKETING_FUNCTION_STATUSES.map((status) => (
        <option key={status} value={status}>
          {MARKETING_FUNCTION_STATUS_LABELS[status]}
        </option>
      ))}
    </select>
  );
}

function ItemEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  onDelete,
  saving,
}: {
  draft: Row;
  onChange: (next: Row) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: (() => void) | null;
  saving: boolean;
}) {
  const category = MARKETING_FUNCTION_CATEGORIES.find((entry) => entry.key === draft.categoryKey)!;
  return (
    <FormBlock
      label={<span className="text-sm font-black text-slate-900">{draft.id ? "Edit item" : "New item"} · {category.title}</span>}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
        <FormField className="md:col-span-2" label="Product">
          <input
            className={phxFieldClassName}
            maxLength={160}
            onChange={(event) => onChange({ ...draft, product: event.target.value })}
            placeholder="Which product"
            value={draft.product ?? ""}
          />
        </FormField>
        <FormField className="md:col-span-4" label={`${MARKETING_FUNCTION_COLUMNS.description} ${MARKETING_FUNCTION_COLUMNS.descriptionDetail}`} required>
          <textarea
            className={phxTextareaClassName}
            maxLength={2000}
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
            rows={2}
            value={draft.description}
          />
        </FormField>
        <FormField className="md:col-span-2" label={MARKETING_FUNCTION_COLUMNS.dueDate}>
          <input
            className={phxFieldClassName}
            onChange={(event) => onChange({ ...draft, dueDate: event.target.value || null })}
            type="date"
            value={draft.dueDate ?? ""}
          />
        </FormField>
        <FormField className="md:col-span-4" label="Planned or Actual">
          <div className="grid grid-cols-2 gap-2">
            {(["planned", "actual"] as const).map((origin) => (
              <button
                aria-pressed={draft.origin === origin}
                className={cn(phxCheckTileClassName(draft.origin === origin), "justify-center")}
                key={origin}
                onClick={() => onChange({ ...draft, origin })}
                type="button"
              >
                {MARKETING_FUNCTION_ORIGIN_LABELS[origin]}
              </button>
            ))}
          </div>
        </FormField>
        <FormField className="md:col-span-3" label={MARKETING_FUNCTION_COLUMNS.statusMid}>
          <StatusChip
            editable
            label={MARKETING_FUNCTION_COLUMNS.statusMid}
            onChange={(statusMid) => onChange({ ...draft, statusMid })}
            value={draft.statusMid}
          />
          <input
            className={cn(phxFieldClassName, "mt-2")}
            maxLength={2000}
            onChange={(event) => onChange({ ...draft, noteMid: event.target.value })}
            placeholder="Note (optional)"
            value={draft.noteMid ?? ""}
          />
        </FormField>
        <FormField className="md:col-span-3" label={MARKETING_FUNCTION_COLUMNS.statusEnd}>
          <StatusChip
            editable
            label={MARKETING_FUNCTION_COLUMNS.statusEnd}
            onChange={(statusEnd) => onChange({ ...draft, statusEnd })}
            value={draft.statusEnd}
          />
          <input
            className={cn(phxFieldClassName, "mt-2")}
            maxLength={2000}
            onChange={(event) => onChange({ ...draft, noteEnd: event.target.value })}
            placeholder="Note (optional)"
            value={draft.noteEnd ?? ""}
          />
        </FormField>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4">
        <div>
          {onDelete ? (
            <button className={phxButtonGhostClassName} disabled={saving} onClick={onDelete} type="button">
              Remove item
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={phxButtonGhostClassName} disabled={saving} onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className={phxButtonPrimaryClassName}
            disabled={saving || !draft.description.trim()}
            onClick={onSave}
            type="button"
          >
            {saving ? "Saving" : "Save item"}
          </button>
        </div>
      </div>
    </FormBlock>
  );
}

export function MarketingFunctionsWorkspace({ sheet, monthKey, monthOptions, authors, basePath, feedbackBasePath, todayIso }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() => withKeys(sheet?.items ?? []));
  const [draft, setDraft] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [, startTransition] = useTransition();
  const editorRef = useRef<HTMLDivElement>(null);

  // The editor opens under the sheet; bring it to him rather than leave it below the fold.
  const draftKey = draft?.key ?? null;
  useEffect(() => {
    if (draftKey) editorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [draftKey]);

  const items = useMemo(() => stripKeys(rows), [rows]);
  const totals = monthFigures(items);
  const byCategory = categoryFigures(items);
  const editable = Boolean(sheet?.canEdit);

  function go(next: { month?: string; author?: string }) {
    const params = new URLSearchParams();
    params.set("month", next.month ?? monthKey);
    const author = next.author ?? (authors.length > 0 ? sheet?.authorHrId : undefined);
    if (author) params.set("author", author);
    startTransition(() => router.push(`${basePath}?${params.toString()}`));
  }

  async function call(url: string, init: RequestInit, done: string): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        setError(typeof body.message === "string" ? body.message : "That did not save. Try again.");
        return null;
      }
      setNotice(done);
      return body;
    } catch {
      setError("The connection dropped. Try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function persist(next: Row[], done: string): Promise<boolean> {
    const body = await call(
      "/api/marketing-functions/items",
      { body: JSON.stringify({ items: stripKeys(next), month: monthKey }), method: "PUT" },
      done,
    );
    if (!body) return false;
    const saved = body.sheet as MarketingMonthSheet | null;
    setRows(withKeys(saved?.items ?? stripKeys(next)));
    startTransition(() => router.refresh());
    return true;
  }

  function startNew(categoryKey: MarketingFunctionCategoryKey) {
    // Added after the month began, it is something he did rather than planned: her "Actual".
    const origin = todayIso > monthStartDate(monthKey) ? "actual" : "planned";
    setDraft({
      categoryKey,
      description: "",
      dueDate: null,
      id: null,
      key: `new-${(rowSeed += 1)}`,
      noteEnd: null,
      noteMid: null,
      origin,
      product: null,
      statusEnd: null,
      statusMid: null,
    });
  }

  async function saveDraft() {
    if (!draft) return;
    const exists = rows.some((row) => row.key === draft.key);
    const next = exists ? rows.map((row) => (row.key === draft.key ? draft : row)) : [...rows, draft];
    if (await persist(next, "Saved.")) setDraft(null);
  }

  async function removeDraft() {
    if (!draft) return;
    if (await persist(rows.filter((row) => row.key !== draft.key), "Item removed.")) setDraft(null);
  }

  async function setStatus(row: Row, field: "statusMid" | "statusEnd", value: MarketingFunctionStatus | null) {
    await persist(
      rows.map((entry) =>
        entry.key !== row.key ? entry : field === "statusMid" ? { ...entry, statusMid: value } : { ...entry, statusEnd: value },
      ),
      "Saved.",
    );
  }

  async function submit() {
    const body = await call("/api/marketing-functions/submit", { body: JSON.stringify({ month: monthKey }), method: "POST" }, "Submitted for review.");
    if (body) startTransition(() => router.refresh());
  }

  async function carryForward() {
    const body = await call(
      "/api/marketing-functions/carry-forward",
      { body: JSON.stringify({ month: monthKey }), method: "POST" },
      "Carried forward.",
    );
    if (body) {
      const copied = Number(body.copied ?? 0);
      const nextKey = String(body.nextMonthKey ?? "");
      setNotice(copied === 0 ? "Nothing to carry: every item is done or cancelled." : `${copied} unfinished ${copied === 1 ? "item" : "items"} copied into ${monthTitle(nextKey)}.`);
    }
  }

  async function review(decision: "review" | "reopen") {
    if (!sheet?.month) return;
    const body = await call(
      "/api/marketing-functions/review",
      { body: JSON.stringify({ decision, monthId: sheet.month.id, note: reviewNote }), method: "POST" },
      decision === "review" ? "Marked Reviewed." : "Reopened for the Product Manager.",
    );
    if (body) {
      setReviewNote("");
      startTransition(() => router.refresh());
    }
  }

  const status = sheet?.month?.status ?? null;
  const exportHref = sheet
    ? `/api/marketing-functions/export?month=${encodeURIComponent(monthKey)}&author=${encodeURIComponent(sheet.authorHrId)}`
    : null;

  return (
    <div className="space-y-5">
      <section className="border border-slate-200 bg-white p-4 sm:p-5">
        <p className="text-sm leading-relaxed text-slate-700">{MARKETING_FUNCTIONS_PURPOSE}</p>
        <ul className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-700 md:grid-cols-2">
          <li className="border-l-2 border-slate-900 pl-3">
            <span className="font-black">Planned:</span> {MARKETING_FUNCTIONS_PLANNED.replace(/^Planned:\s*/, "")}
          </li>
          <li className="border-l-2 border-orange-500 pl-3">
            <span className="font-black">Actual:</span> {MARKETING_FUNCTIONS_ACTUAL.replace(/^Actual:\s*/, "")}
          </li>
        </ul>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">{MARKETING_FUNCTIONS_MONTH_END}</p>
      </section>

      <section className="grid grid-cols-1 gap-3 border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
        <FormField label="Month">
          <select aria-label="Month" className={phxSelectClassName} onChange={(event) => go({ month: event.target.value })} value={monthKey}>
            {monthOptions.map((key) => (
              <option key={key} value={key}>
                {monthTitle(key)}
              </option>
            ))}
          </select>
        </FormField>
        {authors.length > 0 ? (
          <FormField label="Product Manager">
            <SearchableSelect
              aria-label="Product Manager"
              onValueChange={(value) => go({ author: value })}
              placeholder="Choose a Product Manager"
              value={sheet?.authorHrId ?? ""}
              wrapValue
            >
              <option value="">Choose a Product Manager</option>
              {authors.map((author) => (
                <option key={author.hrId} value={author.hrId}>
                  {author.name}
                  {author.line ? ` · ${author.line}` : ""}
                </option>
              ))}
            </SearchableSelect>
          </FormField>
        ) : null}
        <div className={cn("grid grid-cols-3 gap-2", authors.length > 0 ? "sm:col-span-2" : "sm:col-span-1 lg:col-span-3")}>
          {[
            { label: "Planned", value: String(totals.planned) },
            { label: "Actual", value: String(totals.actual) },
            { label: "Done", value: totals.donePercent === null ? "None yet" : `${totals.donePercent}%` },
          ].map((figure) => (
            <div className="border border-slate-200 px-3 py-2" key={figure.label}>
              <p className="text-phx-xs font-black uppercase tracking-wide text-slate-500">{figure.label}</p>
              <p className="text-xl font-black tabular-nums text-slate-900">{figure.value}</p>
            </div>
          ))}
        </div>
      </section>

      {!sheet ? (
        <p className="border border-slate-200 bg-white p-6 text-sm text-slate-600">Choose a Product Manager to open their sheet.</p>
      ) : (
        <>
          <section className="flex flex-col gap-3 border border-slate-200 bg-white p-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <h2 className="text-base font-black text-slate-900">
                {MARKETING_FUNCTIONS_TITLE} · {monthTitle(monthKey)} · {sheet.authorName}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {status ? MARKETING_MONTH_STATUS_LABELS[status] : "Not started"}
                {sheet.month?.reviewedAt && sheet.month.reviewedByName
                  ? ` by ${sheet.month.reviewedByName}`
                  : ""}
              </p>
              {sheet.month?.reviewNote ? (
                <p className="mt-1 border-l-2 border-slate-300 pl-2 text-sm text-slate-700">{sheet.month.reviewNote}</p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {exportHref ? (
                <a className={phxButtonGhostClassName} href={exportHref}>
                  Export to Excel
                </a>
              ) : null}
              {sheet.canCarryForward ? (
                <button className={phxButtonGhostClassName} disabled={busy} onClick={carryForward} type="button">
                  Carry unfinished to next month
                </button>
              ) : null}
              {sheet.canSubmit ? (
                <button className={phxButtonAccentClassName} disabled={busy || rows.length === 0} onClick={submit} type="button">
                  Submit for review
                </button>
              ) : null}
            </div>
          </section>

          {sheet.canReview || sheet.canReopen ? (
            <section className="border border-slate-200 bg-white p-4">
              <FormField label="Review note (optional)">
                <textarea className={phxTextareaClassName} maxLength={2000} onChange={(event) => setReviewNote(event.target.value)} rows={2} value={reviewNote} />
              </FormField>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                {sheet.canReopen ? (
                  <button className={phxButtonGhostClassName} disabled={busy} onClick={() => review("reopen")} type="button">
                    Reopen for changes
                  </button>
                ) : null}
                {sheet.canReview ? (
                  <button className={phxButtonApproveClassName} disabled={busy} onClick={() => review("review")} type="button">
                    Mark Reviewed
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          <FormError>{error}</FormError>
          {notice ? <p className="border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700">{notice}</p> : null}

          {/* Desktop: her sheet. One table, her five column heads, a band per category. */}
          <div className="hidden border border-slate-300 bg-white md:block">
            <table className="w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[36%]" />
                <col className="w-[12%]" />
                <col className="w-[15%]" />
                <col className="w-[15%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-400 text-left text-slate-900">
                  <th className="px-3 py-2 font-black">{MARKETING_FUNCTION_COLUMNS.category}</th>
                  <th className="px-3 py-2 font-black">
                    {MARKETING_FUNCTION_COLUMNS.description}{" "}
                    <span className="text-xs font-medium">{MARKETING_FUNCTION_COLUMNS.descriptionDetail}</span>
                  </th>
                  <th className="px-3 py-2 font-black">{MARKETING_FUNCTION_COLUMNS.dueDate}</th>
                  <th className="px-3 py-2 font-black">{MARKETING_FUNCTION_COLUMNS.statusMid}</th>
                  <th className="px-3 py-2 font-black">{MARKETING_FUNCTION_COLUMNS.statusEnd}</th>
                </tr>
              </thead>
              {MARKETING_FUNCTION_CATEGORIES.map((category) => {
                const bandRows = rows.filter((row) => row.categoryKey === category.key);
                const lines = category.key === "field" ? sheet.fieldActivity : [];
                const span = Math.max(1, bandRows.length + lines.length + (editable ? 1 : 0));
                const figures = byCategory[category.key];
                return (
                  <tbody className="border-b border-slate-300" key={category.key} style={{ backgroundColor: category.fill }}>
                    {Array.from({ length: span }).map((_, index) => {
                      const row = bandRows[index];
                      const line = row ? null : lines[index - bandRows.length];
                      const isAddRow = !row && !line && editable;
                      return (
                        <tr className="border-t border-black/10 align-top" key={row?.key ?? line?.id ?? `add-${category.key}`}>
                          {index === 0 ? (
                            <th className="border-r border-black/10 px-3 py-2 text-left align-top font-normal" rowSpan={span} scope="rowgroup">
                              <CategoryLabel category={category} />
                              {figures.planned + figures.actual > 0 ? (
                                <span className="mt-2 block text-xs font-bold text-slate-700">
                                  {figures.done} done of {figures.planned + figures.actual}
                                </span>
                              ) : null}
                            </th>
                          ) : null}
                          {row ? (
                            <>
                              <td className="px-3 py-2">
                                <p className="whitespace-pre-wrap break-words text-slate-900">
                                  {row.product ? <span className="font-black">{row.product}: </span> : null}
                                  {row.description}
                                </p>
                                <p className="mt-1 text-xs font-bold text-slate-600">
                                  {MARKETING_FUNCTION_ORIGIN_LABELS[row.origin]}
                                  {editable ? (
                                    <button className="ml-2 font-black text-slate-900 underline underline-offset-2" onClick={() => setDraft(row)} type="button">
                                      Edit
                                    </button>
                                  ) : null}
                                </p>
                              </td>
                              <td className="px-3 py-2 tabular-nums" style={category.dueDateFill ? { backgroundColor: category.dueDateFill } : undefined}>
                                {row.dueDate ? shortDateLabel(row.dueDate) : ""}
                              </td>
                              <td className="px-3 py-2">
                                <StatusChip editable={editable} label={`${MARKETING_FUNCTION_COLUMNS.statusMid}: ${row.description}`} onChange={(value) => setStatus(row, "statusMid", value)} value={row.statusMid} />
                                {row.noteMid ? <p className="mt-1 break-words text-xs text-slate-700">{row.noteMid}</p> : null}
                              </td>
                              <td className="px-3 py-2">
                                <StatusChip editable={editable} label={`${MARKETING_FUNCTION_COLUMNS.statusEnd}: ${row.description}`} onChange={(value) => setStatus(row, "statusEnd", value)} value={row.statusEnd} />
                                {row.noteEnd ? <p className="mt-1 break-words text-xs text-slate-700">{row.noteEnd}</p> : null}
                              </td>
                            </>
                          ) : line ? (
                            <>
                              <td className="px-3 py-2">
                                <Link className="font-bold text-slate-900 underline underline-offset-2" href={`${feedbackBasePath}/${line.id}`}>
                                  {FIELD_VISIT_TYPE_LABELS[line.visitType]} visit with {line.repName}
                                </Link>
                                <p className="mt-1 text-xs font-bold text-slate-600">From the signed field visit feedback</p>
                              </td>
                              <td className="px-3 py-2 tabular-nums" style={category.dueDateFill ? { backgroundColor: category.dueDateFill } : undefined}>
                                {shortDateLabel(line.visitDate)}
                              </td>
                              <td className="px-3 py-2" />
                              <td className="px-3 py-2">
                                <span className={cn("inline-block border px-2 py-0.5 text-xs font-bold", STATUS_CHIP.done)}>Done</span>
                              </td>
                            </>
                          ) : isAddRow ? (
                            <td className="px-3 py-2" colSpan={4}>
                              <button className="text-sm font-black text-slate-900 underline underline-offset-2" onClick={() => startNew(category.key)} type="button">
                                Add an item to {category.title}
                              </button>
                            </td>
                          ) : (
                            <td className="px-3 py-2 text-slate-600" colSpan={4}>
                              Nothing in this category.
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
            </table>
          </div>

          {/* Phone: one card per band, the band's own fill on its head. */}
          <div className="space-y-3 md:hidden">
            {MARKETING_FUNCTION_CATEGORIES.map((category) => {
              const bandRows = rows.filter((row) => row.categoryKey === category.key);
              const lines = category.key === "field" ? sheet.fieldActivity : [];
              return (
                <section className="border border-slate-300 bg-white" key={category.key}>
                  <header className="px-3 py-2" style={{ backgroundColor: category.fill }}>
                    <CategoryLabel category={category} />
                  </header>
                  <ul className="divide-y divide-slate-200">
                    {bandRows.map((row) => (
                      <li className="space-y-2 px-3 py-3" key={row.key}>
                        <p className="whitespace-pre-wrap break-words text-sm text-slate-900">
                          {row.product ? <span className="font-black">{row.product}: </span> : null}
                          {row.description}
                        </p>
                        <p className="text-xs font-bold text-slate-600">
                          {MARKETING_FUNCTION_ORIGIN_LABELS[row.origin]}
                          {row.dueDate ? ` · ${MARKETING_FUNCTION_COLUMNS.dueDate} ${shortDateLabel(row.dueDate)}` : ""}
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <p className="mb-1 text-phx-xs font-black uppercase tracking-wide text-slate-500">{MARKETING_FUNCTION_COLUMNS.statusMid}</p>
                            <StatusChip editable={editable} label={MARKETING_FUNCTION_COLUMNS.statusMid} onChange={(value) => setStatus(row, "statusMid", value)} value={row.statusMid} />
                          </div>
                          <div>
                            <p className="mb-1 text-phx-xs font-black uppercase tracking-wide text-slate-500">{MARKETING_FUNCTION_COLUMNS.statusEnd}</p>
                            <StatusChip editable={editable} label={MARKETING_FUNCTION_COLUMNS.statusEnd} onChange={(value) => setStatus(row, "statusEnd", value)} value={row.statusEnd} />
                          </div>
                        </div>
                        {editable ? (
                          <button className="text-sm font-black text-slate-900 underline underline-offset-2" onClick={() => setDraft(row)} type="button">
                            Edit
                          </button>
                        ) : null}
                      </li>
                    ))}
                    {lines.map((line) => (
                      <li className="px-3 py-3" key={line.id}>
                        <Link className="text-sm font-bold text-slate-900 underline underline-offset-2" href={`${feedbackBasePath}/${line.id}`}>
                          {FIELD_VISIT_TYPE_LABELS[line.visitType]} visit with {line.repName}
                        </Link>
                        <p className="mt-1 text-xs font-bold text-slate-600">{shortDateLabel(line.visitDate)} · Done</p>
                      </li>
                    ))}
                    {editable ? (
                      <li className="px-3 py-3">
                        <button className="text-sm font-black text-slate-900 underline underline-offset-2" onClick={() => startNew(category.key)} type="button">
                          Add an item to {category.title}
                        </button>
                      </li>
                    ) : null}
                    {!editable && bandRows.length === 0 && lines.length === 0 ? (
                      <li className="px-3 py-3 text-sm text-slate-500">Nothing in this category.</li>
                    ) : null}
                  </ul>
                </section>
              );
            })}
          </div>

          {draft ? (
            <div
              className="border-l-8"
              ref={editorRef}
              style={{ borderLeftColor: MARKETING_FUNCTION_CATEGORIES.find((category) => category.key === draft.categoryKey)?.fill }}
            >
              <ItemEditor
                draft={draft}
                onCancel={() => setDraft(null)}
                onChange={setDraft}
                onDelete={rows.some((row) => row.key === draft.key) ? removeDraft : null}
                onSave={saveDraft}
                saving={busy}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
