"use client";

// Recruitment / ATS — the owner's WhatsApp template workshop: write, edit, reorder, switch off,
// delete, and send one to any number without a CV behind it.
//
// The editor deliberately shows the raw body with its `{{placeholders}}` visible rather than a rich
// editor with chips. The owner writes these by pasting a message he already sends by hand and
// replacing the parts that change — a WYSIWYG surface would fight that paste, and a placeholder he
// cannot see is one he cannot delete.

import { useCallback, useEffect, useMemo, useState } from "react";

import { deleteRequest, getJson, patchJson, postJson } from "@/components/recruitment/recruitment-fetch";
// The SHARED Cairo formatter, not a local toLocaleString. This string is hydrated, and en-GB's
// abbreviated September changed from "Sep" to "Sept" in CLDR 42 — so a browser on older ICU
// renders different bytes from the server and React throws #418, visibly, only in September.
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { WhatsAppSendDialog } from "@/components/recruitment/whatsapp-send-dialog";
import { cn } from "@/lib/utils";
import {
  phxFieldClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

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
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="border border-[#25D366] bg-[#25D366] px-4 py-2 text-sm font-semibold text-white"
          onClick={() => setSendOpen(true)}
          type="button"
        >
          Send to any number
        </button>
        {canManage ? (
          <button
            className="border border-phx-accent bg-phx-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-phx-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/60"
            onClick={startCreate}
            type="button"
          >
            New template
          </button>
        ) : null}
      </div>

      {error ? <p className="border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error}</p> : null}
      {loading ? <p className="text-sm text-slate-600">Loading…</p> : null}

      {editorOpen && canManage ? (
        <div className="border border-slate-300 bg-white">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-2">
            <h3 className="text-sm font-semibold text-slate-900">{creating ? "New template" : "Edit template"}</h3>
          </div>
          <div className="space-y-3 px-4 py-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600" htmlFor="tpl-name">
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
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600" htmlFor="tpl-category">
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
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600" htmlFor="tpl-body">
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
              <p className="mt-1 text-xs text-slate-600">
                Anything inside {"{{ }}"} becomes a box to fill in when you send. Press one below to insert it.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((key) => (
                  <button
                    className="border border-phx-line bg-[#FBFCFD] px-2 py-1 font-mono text-[11px] text-slate-700 transition hover:border-phx-accent-line hover:bg-white hover:text-slate-900"
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
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  checked={draft.isActive}
                  className="h-4 w-4 border border-slate-400"
                  onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })}
                  type="checkbox"
                />
                Available to send
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700" htmlFor="tpl-order">
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

            <div className="flex flex-wrap gap-2">
              <button
                className="border border-phx-accent bg-phx-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-phx-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/60 disabled:border-slate-300 disabled:bg-slate-300"
                disabled={busy}
                onClick={save}
                type="button"
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                className="border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
                onClick={cancelEdit}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {grouped.map(([category, list]) => (
        <div className="space-y-2" key={category}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">{category}</h3>
          <div className="space-y-2">
            {list.map((template) => (
              <div
                className={cn(
                  "border bg-white p-3",
                  template.isActive ? "border-slate-300" : "border-slate-200 bg-slate-50",
                )}
                key={template.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">
                      {template.name}
                      {template.isActive ? null : (
                        <span className="ml-2 border border-slate-400 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                          Switched off
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-slate-600">Last changed {cairoDateTime(template.updatedAt)} (Cairo)</p>
                  </div>
                  {canManage ? (
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        className="border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                        onClick={() => startEdit(template)}
                        type="button"
                      >
                        Edit
                      </button>
                      <button
                        className="border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                        disabled={busy}
                        onClick={() => toggleActive(template)}
                        type="button"
                      >
                        {template.isActive ? "Switch off" : "Switch on"}
                      </button>
                      <button
                        className="border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
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
                  className="mt-2 whitespace-pre-wrap break-words border border-slate-200 bg-slate-50 p-2 text-[13px] leading-relaxed text-slate-700"
                  dir="auto"
                >
                  {template.body}
                </p>
                {template.variableKeys.length > 0 ? (
                  <p className="mt-1.5 text-xs text-slate-600">
                    Asks for: {template.variableKeys.join(", ")}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}

      {sendOpen ? <WhatsAppSendDialog onClose={() => setSendOpen(false)} /> : null}
    </div>
  );
}
