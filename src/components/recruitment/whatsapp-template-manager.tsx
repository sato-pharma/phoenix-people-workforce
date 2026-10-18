"use client";

// Recruitment / ATS — the owner's WhatsApp template workshop: write, edit, reorder, switch off,
// delete, and send one to any number without a CV behind it.
//
// The editor deliberately shows the raw body with its `{{placeholders}}` visible rather than a rich
// editor with chips. The owner writes these by pasting a message he already sends by hand and
// replacing the parts that change — a WYSIWYG surface would fight that paste, and a placeholder he
// cannot see is one he cannot delete.
//
// THE LOOK (owner, 2026-10-19, the full-module premium sweep): the two actions sit in the recessed
// tray, the editor is a panel under the house dark band wearing the form kit's labels and buttons, and
// each category is its own panel listing its templates with the full wording in a recessed well.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Braces, LayoutTemplate, Loader2, MessageCircle, PencilLine, Plus } from "lucide-react";

import { deleteRequest, getJson, patchJson, postJson } from "@/components/recruitment/recruitment-fetch";
// The SHARED Cairo formatter, not a local toLocaleString. This string is hydrated, and en-GB's
// abbreviated September changed from "Sep" to "Sept" in CLDR 42 — so a browser on older ICU
// renders different bytes from the server and React throws #418, visibly, only in September.
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { WhatsAppSendDialog } from "@/components/recruitment/whatsapp-send-dialog";
import { cn } from "@/lib/utils";
import { phxWhatsAppSendButtonClassName } from "@/components/ui/brand-tokens";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxCheckInputClassName,
  phxFieldClassName,
  phxHintClassName,
  phxLabelClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { adminControlDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  RecruitmentEmptyState,
  RecruitmentPanel,
  RecruitmentPill,
  recruitmentToolbarClassName,
} from "@/components/recruitment/recruitment-premium";

type Template = {
  id: string;
  name: string;
  category: string;
  body: string;
  isActive: boolean;
  sortOrder: number;
  variableKeys: string[];
  updatedAt: string | null;
};

type Draft = { name: string; category: string; body: string; isActive: boolean; sortOrder: number };

const EMPTY_DRAFT: Draft = { body: "", category: "Interview", isActive: true, name: "", sortOrder: 0 };

/** Offered under the editor as one-press inserts, so a placeholder never has to be typed by hand. */
const SUGGESTIONS = [
  "candidate_first_name",
  "candidate_name",
  "job_title",
  "interview_date",
  "interview_time",
  "dress_code",
  "interviewer_name",
  "interviewer_title",
  "location_link",
  "address",
  "website",
  "sender_name",
  "company_name",
];

/** The small square row controls — Edit, Switch off/on — lifted like every control in the module. */
const rowButtonClass = `inline-flex items-center gap-1 border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`;

export function WhatsAppTemplateManager({ canManage }: { canManage: boolean }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  /** Which textarea the placeholder buttons should insert into — the one being edited. */
  const [bodyElement, setBodyElement] = useState<HTMLTextAreaElement | null>(null);

  /**
   * The fetch on its own, touching no state.
   *
   * Split out so the first load and every later refresh share one request shape while the FIRST one
   * can avoid setting state synchronously — `setState` inside an effect body is a lint ERROR in this
   * repo (react-hooks/set-state-in-effect), and `reload` below opens with `setLoading(true)`.
   */
  const fetchTemplates = useCallback(async (): Promise<Template[]> => {
    const data = await getJson("/api/recruitment/whatsapp-templates?includeInactive=true");
    return (data.templates ?? []) as Template[];
  }, []);

  /** Refresh after a save, a delete or a switch — always from an event handler, never from an effect. */
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await fetchTemplates());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the templates.");
    } finally {
      setLoading(false);
    }
  }, [fetchTemplates]);

  useEffect(() => {
    // `loading` already starts true, so the spinner is on screen without this effect setting it —
    // which is what keeps every setState here on the far side of an await.
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchTemplates();
        if (cancelled) return;
        setTemplates(list);
        setError(null);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not load the templates.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchTemplates]);

  const startEdit = useCallback((template: Template) => {
    setCreating(false);
    setEditingId(template.id);
    setDraft({
      body: template.body,
      category: template.category,
      isActive: template.isActive,
      name: template.name,
      sortOrder: template.sortOrder,
    });
  }, []);

  const startCreate = useCallback(() => {
    setEditingId(null);
    setCreating(true);
    // A new template starts after the last one, so it lands at the bottom rather than jumping to the
    // top of a list the owner has already put in his own order.
    setDraft({ ...EMPTY_DRAFT, sortOrder: (templates[templates.length - 1]?.sortOrder ?? 0) + 10 });
  }, [templates]);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setCreating(false);
    setDraft(EMPTY_DRAFT);
    setError(null);
  }, []);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        await postJson("/api/recruitment/whatsapp-templates", draft);
      } else if (editingId) {
        await patchJson(`/api/recruitment/whatsapp-templates/${editingId}`, draft);
      }
      cancelEdit();
      await reload();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the template.");
    } finally {
      setBusy(false);
    }
  }, [busy, creating, editingId, draft, cancelEdit, reload]);

  const toggleActive = useCallback(
    async (template: Template) => {
      setBusy(true);
      setError(null);
      try {
        await patchJson(`/api/recruitment/whatsapp-templates/${template.id}`, { isActive: !template.isActive });
        await reload();
      } catch (toggleError) {
        setError(toggleError instanceof Error ? toggleError.message : "Could not change the template.");
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const remove = useCallback(
    async (template: Template) => {
      // A deleted template cannot be recovered from this screen, so the confirm names it rather than
      // asking "are you sure?" about nothing in particular.
      if (!window.confirm(`Delete the template "${template.name}"? Messages already sent are kept.`)) return;
      setBusy(true);
      setError(null);
      try {
        await deleteRequest(`/api/recruitment/whatsapp-templates/${template.id}`);
        if (editingId === template.id) cancelEdit();
        await reload();
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : "Could not delete the template.");
      } finally {
        setBusy(false);
      }
    },
    [editingId, cancelEdit, reload],
  );

  /**
   * Insert `{{key}}` where the cursor is, rather than appending at the end.
   *
   * Appending would be useless for the common case — the owner is mid-sentence writing "Date: " and
   * wants the placeholder right there. The cursor is restored after the inserted text so he can keep
   * typing without reaching for the mouse.
   */
  const insertPlaceholder = useCallback(
    (key: string) => {
      const token = `{{${key}}}`;
      const element = bodyElement;
      if (!element) {
        setDraft((current) => ({ ...current, body: `${current.body}${token}` }));
        return;
      }
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? start;
      setDraft((current) => ({
        ...current,
        body: `${current.body.slice(0, start)}${token}${current.body.slice(end)}`,
      }));
      requestAnimationFrame(() => {
        element.focus();
        element.setSelectionRange(start + token.length, start + token.length);
      });
    },
    [bodyElement],
  );

  const editorOpen = creating || editingId !== null;
  const grouped = useMemo(() => {
    const byCategory = new Map<string, Template[]>();
    for (const template of templates) {
      const key = template.category || "Other";
      const bucket = byCategory.get(key) ?? [];
      bucket.push(template);
      byCategory.set(key, bucket);
    }
    return [...byCategory.entries()];
  }, [templates]);

  return (
    <div className="space-y-5">
      <div className={recruitmentToolbarClassName}>
        <button
          className={phxWhatsAppSendButtonClassName}
          onClick={() => setSendOpen(true)}
          type="button"
        >
          <MessageCircle aria-hidden="true" className="h-4 w-4" />
          Send to any number
        </button>
        {canManage ? (
          <button className={phxButtonAccentClassName} onClick={startCreate} type="button">
            <Plus aria-hidden="true" className="h-4 w-4" />
            New template
          </button>
        ) : null}
        {loading ? (
          <span className="inline-flex items-center gap-1.5 self-center text-xs font-semibold text-slate-500" role="status">
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800" role="alert">
          {error}
        </p>
      ) : null}

      {editorOpen && canManage ? (
        <RecruitmentPanel
          description="Anything inside {{ }} becomes a box to fill in when you send."
          icon={<PencilLine aria-hidden="true" className="h-4 w-4" />}
          title={creating ? "New template" : "Edit template"}
        >
          <div className="space-y-4 px-4 py-4 sm:px-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className={phxLabelClassName} htmlFor="tpl-name">
                  Name
                </label>
                <input
                  className={phxFieldClassName}
                  id="tpl-name"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="Interview invitation"
                  value={draft.name}
                />
              </div>
              <div>
                <label className={phxLabelClassName} htmlFor="tpl-category">
                  Category
                </label>
                <input
                  className={phxFieldClassName}
                  id="tpl-category"
                  onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                  placeholder="Interview"
                  value={draft.category}
                />
              </div>
            </div>

            <div>
              <label className={phxLabelClassName} htmlFor="tpl-body">
                Message
              </label>
              <textarea
                className={cn(phxTextareaClassName, "font-mono leading-relaxed")}
                dir="auto"
                id="tpl-body"
                onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                ref={setBodyElement}
                rows={14}
                value={draft.body}
              />
              <p className={phxHintClassName}>
                Anything inside {"{{ }}"} becomes a box to fill in when you send. Press one below to insert it.
              </p>
              <div className={`mt-2 flex flex-wrap gap-1.5 border border-slate-200 bg-slate-50/80 p-2 ${adminRecessedDepthClassName}`}>
                {SUGGESTIONS.map((key) => (
                  <button
                    className={`border border-phx-line bg-[#FBFCFD] px-2 py-1 font-mono text-[11px] text-slate-700 transition hover:border-phx-accent-line hover:bg-white hover:text-slate-900 ${adminControlDepthClassName}`}
                    key={key}
                    onClick={() => insertPlaceholder(key)}
                    type="button"
                  >
                    {`{{${key}}}`}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                <input
                  checked={draft.isActive}
                  className={phxCheckInputClassName}
                  onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })}
                  type="checkbox"
                />
                Available to send
              </label>
              <label className="flex items-center gap-2 text-sm font-semibold text-slate-700" htmlFor="tpl-order">
                Order
                <input
                  className={cn(phxFieldClassName, "w-20")}
                  id="tpl-order"
                  onChange={(event) => setDraft({ ...draft, sortOrder: Number(event.target.value) || 0 })}
                  type="number"
                  value={draft.sortOrder}
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
              <button className={phxButtonAccentClassName} disabled={busy} onClick={save} type="button">
                {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
                {busy ? "Saving…" : "Save"}
              </button>
              <button className={phxButtonGhostClassName} onClick={cancelEdit} type="button">
                Cancel
              </button>
            </div>
          </div>
        </RecruitmentPanel>
      ) : null}

      {!loading && !error && templates.length === 0 ? (
        <RecruitmentPanel icon={<LayoutTemplate aria-hidden="true" className="h-4 w-4" />} title="Templates">
          <RecruitmentEmptyState
            icon={<LayoutTemplate aria-hidden="true" className="h-5 w-5" />}
            message={
              canManage
                ? "Press New template to write the first one."
                : "Nobody has written a WhatsApp template yet."
            }
            title="No templates yet"
          />
        </RecruitmentPanel>
      ) : null}

      {grouped.map(([category, list]) => (
        <RecruitmentPanel
          count={list.length}
          icon={<LayoutTemplate aria-hidden="true" className="h-4 w-4" />}
          key={category}
          title={<span dir="auto">{category}</span>}
        >
          <ul className="divide-y divide-slate-100">
            {list.map((template) => (
              <li
                className={cn(
                  "relative px-4 py-4 sm:px-5",
                  template.isActive ? "bg-white" : "bg-slate-50/70",
                )}
                key={template.id}
              >
                {/* The side rail: orange for a template that can be sent, grey for one switched off. */}
                <span
                  aria-hidden="true"
                  className={cn("absolute inset-y-0 left-0 w-[3px]", template.isActive ? "bg-orange-400" : "bg-slate-300")}
                />
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 grow basis-56">
                    <p className="flex flex-wrap items-center gap-2 break-words text-sm font-black text-slate-950" dir="auto">
                      {template.name}
                      {template.isActive ? null : <RecruitmentPill tone="slate">Switched off</RecruitmentPill>}
                    </p>
                    <p className="mt-0.5 text-xs tabular-nums text-slate-500">
                      Last changed {cairoDateTime(template.updatedAt)} (Cairo)
                    </p>
                  </div>
                  {canManage ? (
                    <div className="flex flex-wrap gap-1.5">
                      <button className={rowButtonClass} onClick={() => startEdit(template)} type="button">
                        Edit
                      </button>
                      <button
                        className={rowButtonClass}
                        disabled={busy}
                        onClick={() => toggleActive(template)}
                        type="button"
                      >
                        {template.isActive ? "Switch off" : "Switch on"}
                      </button>
                      <button
                        className={`inline-flex items-center gap-1 border border-rose-300 bg-white px-2.5 py-1.5 text-xs font-bold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`}
                        disabled={busy}
                        onClick={() => remove(template)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
                </div>
                {/* The whole body, wrapped — never clipped and never an ellipsis. */}
                <p
                  className={`mt-3 whitespace-pre-wrap break-words border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] leading-relaxed text-slate-700 ${adminRecessedDepthClassName}`}
                  dir="auto"
                >
                  {template.body}
                </p>
                {template.variableKeys.length > 0 ? (
                  <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
                    <Braces aria-hidden="true" className="h-3.5 w-3.5 text-orange-500" />
                    <span className="font-bold">Asks for:</span> {template.variableKeys.join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </RecruitmentPanel>
      ))}

      {sendOpen ? <WhatsAppSendDialog onClose={() => setSendOpen(false)} /> : null}
    </div>
  );
}
