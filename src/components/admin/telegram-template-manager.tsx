"use client";

import { useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Eye, Save, Send, ToggleLeft, ToggleRight } from "lucide-react";

import type { TelegramTemplateView } from "@/lib/notifications/telegram-templates";
import { insertTelegramPlaceholder } from "@/lib/notifications/telegram-template-placeholders";

type Props = {
  canUpdate: boolean;
  initialTemplates: TelegramTemplateView[];
};

type Draft = {
  ctaEnabled: boolean;
  ctaLabel: string;
  ctaUrl: string;
  isActive: boolean;
  message: string;
  templateKey: string;
  title: string;
};

function statusClass(active: boolean) {
  return active ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600";
}

function formatDate(value: string | null) {
  if (!value) return "Not saved yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function createDraft(template: TelegramTemplateView): Draft {
  return {
    ctaEnabled: template.ctaEnabled,
    ctaLabel: template.ctaLabel,
    ctaUrl: template.ctaUrl,
    isActive: template.isActive,
    message: template.message,
    templateKey: template.templateKey,
    title: template.title,
  };
}

export function TelegramTemplateManager({ canUpdate, initialTemplates }: Props) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [selectedKey, setSelectedKey] = useState(initialTemplates[0]?.templateKey ?? "general_admin_test");
  const selectedTemplate = useMemo(
    () => templates.find((template) => template.templateKey === selectedKey) ?? templates[0],
    [selectedKey, templates],
  );
  const [draft, setDraft] = useState<Draft>(() => createDraft(selectedTemplate));
  const [preview, setPreview] = useState<{ ctaLabel: string | null; ctaUrl: string | null; message: string }>(() => ({
    ctaLabel: selectedTemplate.ctaEnabled ? selectedTemplate.ctaLabel : null,
    ctaUrl: selectedTemplate.ctaEnabled ? selectedTemplate.ctaUrl : null,
    message: selectedTemplate.message,
  }));
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function selectTemplate(template: TelegramTemplateView) {
    setSelectedKey(template.templateKey);
    setDraft(createDraft(template));
    setPreview({
      ctaLabel: template.ctaEnabled ? template.ctaLabel : null,
      ctaUrl: template.ctaEnabled ? template.ctaUrl : null,
      message: template.message,
    });
    setNotice(null);
    setError(null);
  }

  function insertPlaceholder(placeholder: string) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? draft.message.length;
    const end = textarea?.selectionEnd ?? start;
    const nextMessage = insertTelegramPlaceholder(draft.message, placeholder, start, end);
    setDraft((current) => ({ ...current, message: nextMessage }));
    requestAnimationFrame(() => {
      textarea?.focus();
      const nextCursor = start + placeholder.length + 4;
      textarea?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function insertCtaPlaceholder(placeholder: string) {
    setDraft((current) => ({ ...current, ctaUrl: `${current.ctaUrl}${current.ctaUrl ? "" : ""}{{${placeholder}}}` }));
  }

  function resetToDefault() {
    setDraft({
      ctaEnabled: false,
      ctaLabel: "Open Phoenix",
      ctaUrl: "{{actionUrl}}",
      isActive: false,
      message: selectedTemplate.defaultMessage,
      templateKey: selectedTemplate.templateKey,
      title: selectedTemplate.defaultTitle,
    });
    setPreview({ ctaLabel: null, ctaUrl: null, message: selectedTemplate.defaultMessage });
    setNotice("Draft reset to the safe default. Save to persist it.");
    setError(null);
  }

  async function request(method: "PATCH" | "POST", body: Record<string, unknown>, successMessage: string) {
    setBusy(String(body.action ?? "save"));
    setNotice(null);
    setError(null);
    try {
      const response = await fetch("/api/admin/notifications/telegram/templates", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Telegram template action failed.");
      if (Array.isArray(payload.data)) {
        setTemplates(payload.data);
        const saved = payload.data.find((template: TelegramTemplateView) => template.templateKey === draft.templateKey);
        if (saved) {
          setDraft(createDraft(saved));
          setPreview({
            ctaLabel: saved.ctaEnabled ? saved.ctaLabel : null,
            ctaUrl: saved.ctaEnabled ? saved.ctaUrl : null,
            message: saved.message,
          });
        }
      } else if (payload.data?.templates) {
        setTemplates(payload.data.templates);
      } else if (payload.data?.message) {
        setPreview({
          ctaLabel: payload.data.ctaLabel ?? null,
          ctaUrl: payload.data.ctaUrl ?? null,
          message: payload.data.message,
        });
      }
      setNotice(successMessage);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Telegram template action failed.");
    } finally {
      setBusy(null);
    }
  }

  const characterCount = draft.message.length;
  const tooLong = characterCount > 900;
  const usedPlaceholders = selectedTemplate.recommendedPlaceholders.filter((placeholder) => draft.message.includes(`{{${placeholder}}}`) || draft.ctaUrl.includes(`{{${placeholder}}}`));
  const missingRecommended = selectedTemplate.recommendedPlaceholders.filter((placeholder) => !usedPlaceholders.includes(placeholder));
  const qualityScore = Math.max(0, Math.min(100,
    40
    + (draft.message.trim() ? 20 : 0)
    + (tooLong ? -20 : 10)
    + Math.round((usedPlaceholders.length / Math.max(selectedTemplate.recommendedPlaceholders.length, 1)) * 20)
    + (draft.ctaEnabled && draft.ctaLabel.trim() && draft.ctaUrl.trim() ? 10 : draft.ctaEnabled ? -10 : 0),
  ));

  return (
    <div className="space-y-5">
      {notice ? (
        <div className="flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
          <CheckCircle2 className="h-4 w-4" />
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="flex items-center gap-2 rounded border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
        <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-black text-slate-950">Telegram Templates</h2>
          <p className="mt-1 text-sm text-slate-600">Templates are plain text and channel-specific. Defaults stay inactive until an admin saves them.</p>
          <div className="mt-4 space-y-2">
            {templates.map((template) => (
              <button
                className={`w-full rounded border px-3 py-3 text-left transition ${template.templateKey === selectedKey ? "border-orange-300 bg-orange-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
                key={template.templateKey}
                onClick={() => selectTemplate(template)}
                type="button"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-black text-slate-950">{template.name}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">{template.templateKey}</p>
                  </div>
                  <span className={`rounded border px-2 py-1 text-xs font-bold ${statusClass(template.isActive)}`}>
                    {template.isActive ? "active" : "inactive"}
                  </span>
                </div>
                <p className="mt-2 text-xs text-slate-500">Last updated: {formatDate(template.lastUpdated)}</p>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Edit Template</p>
              <h2 className="mt-1 text-xl font-black text-slate-950">{selectedTemplate.name}</h2>
              <p className="mt-1 text-sm text-slate-600">Workflow key: {selectedTemplate.templateKey}</p>
            </div>
            <button
              className={`inline-flex items-center gap-2 rounded border px-3 py-2 text-sm font-bold disabled:opacity-50 ${draft.isActive ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-700"}`}
              disabled={!canUpdate || Boolean(busy)}
              onClick={() => setDraft((current) => ({ ...current, isActive: !current.isActive }))}
              type="button"
            >
              {draft.isActive ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
              {draft.isActive ? "Active" : "Inactive"}
            </button>
          </div>

          <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
            <div className="space-y-4">
              <label className="block">
                <span className="text-sm font-bold text-slate-800">Template title</span>
                <input
                  className="mt-1 w-full rounded border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-900"
                  disabled={!canUpdate}
                  onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                  value={draft.title}
                />
              </label>

              <div>
                <p className="text-sm font-bold text-slate-800">Available placeholders</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedTemplate.allowedPlaceholders.map((placeholder) => (
                    <button
                      className="rounded border border-orange-200 bg-orange-50 px-2.5 py-1.5 text-xs font-bold text-orange-800 disabled:opacity-50"
                      disabled={!canUpdate}
                      key={placeholder}
                      onClick={() => insertPlaceholder(placeholder)}
                      type="button"
                    >
                      {"{{"}{placeholder}{"}}"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm font-black text-slate-950">CTA Button</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">Optional Telegram inline button. It opens Phoenix only.</p>
                  </div>
                  <button
                    className={`inline-flex items-center gap-2 rounded border px-3 py-2 text-sm font-bold disabled:opacity-50 ${draft.ctaEnabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-700"}`}
                    disabled={!canUpdate}
                    onClick={() => setDraft((current) => ({ ...current, ctaEnabled: !current.ctaEnabled }))}
                    type="button"
                  >
                    {draft.ctaEnabled ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                    {draft.ctaEnabled ? "CTA ON" : "CTA OFF"}
                  </button>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <label className="block">
                    <span className="text-xs font-bold text-slate-700">CTA label</span>
                    <input
                      className="mt-1 w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                      disabled={!canUpdate || !draft.ctaEnabled}
                      onChange={(event) => setDraft((current) => ({ ...current, ctaLabel: event.target.value }))}
                      placeholder="Open Phoenix"
                      value={draft.ctaLabel}
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-bold text-slate-700">CTA URL or placeholder</span>
                    <input
                      className="mt-1 w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                      disabled={!canUpdate || !draft.ctaEnabled}
                      onChange={(event) => setDraft((current) => ({ ...current, ctaUrl: event.target.value }))}
                      placeholder="{{actionUrl}}"
                      value={draft.ctaUrl}
                    />
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {["actionUrl", "requestUrl", "employeePortalUrl"].filter((placeholder) => selectedTemplate.allowedPlaceholders.includes(placeholder)).map((placeholder) => (
                    <button
                      className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-700 disabled:opacity-50"
                      disabled={!canUpdate || !draft.ctaEnabled}
                      key={placeholder}
                      onClick={() => insertCtaPlaceholder(placeholder)}
                      type="button"
                    >
                      {"{{"}{placeholder}{"}}"}
                    </button>
                  ))}
                </div>
              </div>

              <label className="block">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-slate-800">Plain text message</span>
                  <span className={`text-xs font-bold ${tooLong ? "text-amber-700" : "text-slate-500"}`}>{characterCount} characters</span>
                </div>
                <textarea
                  className="mt-1 min-h-64 w-full resize-y rounded border border-slate-200 px-3 py-2 font-mono text-sm leading-6 text-slate-900"
                  disabled={!canUpdate}
                  onChange={(event) => setDraft((current) => ({ ...current, message: event.target.value }))}
                  ref={textareaRef}
                  value={draft.message}
                />
              </label>

              {tooLong ? (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
                  Telegram messages should stay short. This template may be truncated by delivery policy.
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <button
                  className="inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 disabled:opacity-50"
                  disabled={Boolean(busy)}
                  onClick={() => request("POST", { ...draft, action: "preview" }, "Preview refreshed.")}
                  type="button"
                >
                  <Eye className="h-4 w-4" />
                  Preview
                </button>
                <button
                  className="inline-flex items-center gap-2 rounded border border-slate-200 bg-slate-950 px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
                  disabled={!canUpdate || Boolean(busy)}
                  onClick={() => request("PATCH", draft, "Telegram template saved.")}
                  type="button"
                >
                  <Save className="h-4 w-4" />
                  Save
                </button>
                <button
                  className="inline-flex items-center gap-2 rounded border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-bold text-orange-800 disabled:opacity-50"
                  disabled={!canUpdate || Boolean(busy)}
                  onClick={() => request("POST", { ...draft, action: "send_admin_preview" }, "Admin-only preview sent or skipped by policy.")}
                  type="button"
                >
                  <Send className="h-4 w-4" />
                  Send Admin-Only Preview
                </button>
                <button
                  className="inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 disabled:opacity-50"
                  disabled={!canUpdate || Boolean(busy)}
                  onClick={resetToDefault}
                  type="button"
                >
                  Reset to Default
                </button>
              </div>
            </div>

            <aside className="rounded border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-black text-slate-950">Live preview</p>
                  <p className="mt-1 text-xs font-semibold text-slate-500">Sample data is used only for admin preview rendering.</p>
                </div>
                <span className={`rounded border px-2 py-1 text-xs font-black ${qualityScore >= 80 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : qualityScore >= 60 ? "border-amber-200 bg-amber-50 text-amber-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
                  {qualityScore}/100
                </span>
              </div>
              <div className="mt-4 rounded border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-800 whitespace-pre-wrap">
                {preview.message}
              </div>
              <div className="mt-4 rounded border border-slate-200 bg-white p-4">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">CTA Preview</p>
                {draft.ctaEnabled ? (
                  <div className="mt-3 rounded border border-orange-200 bg-orange-50 px-3 py-2 text-center text-sm font-black text-orange-800">
                    {preview.ctaLabel ?? (draft.ctaLabel || "CTA label required")}
                  </div>
                ) : (
                  <p className="mt-3 text-sm font-semibold text-slate-500">CTA disabled. Telegram sends plain text only.</p>
                )}
                {draft.ctaEnabled ? <p className="mt-2 break-all text-xs font-semibold text-slate-500">{preview.ctaUrl ?? draft.ctaUrl}</p> : null}
              </div>
              <div className="mt-4 rounded border border-slate-200 bg-white p-3">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Recommended placeholders</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedTemplate.recommendedPlaceholders.map((placeholder) => (
                    <span className={`rounded border px-2 py-1 text-xs font-bold ${usedPlaceholders.includes(placeholder) ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`} key={placeholder}>
                      {"{{"}{placeholder}{"}}"}
                    </span>
                  ))}
                </div>
                {missingRecommended.length > 0 ? (
                  <p className="mt-2 text-xs font-semibold text-amber-700">Missing recommended placeholders: {missingRecommended.join(", ")}</p>
                ) : (
                  <p className="mt-2 text-xs font-semibold text-emerald-700">Recommended placeholders are covered.</p>
                )}
              </div>
              <div className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                Global Telegram OFF still blocks Telegram delivery. Preview tests never target employees.
              </div>
            </aside>
          </div>
        </section>
      </div>
    </div>
  );
}
