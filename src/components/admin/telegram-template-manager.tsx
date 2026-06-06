"use client";

import { useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { AlertCircle, CheckCircle2, Eye, Save, Send, ToggleLeft, ToggleRight } from "lucide-react";

import type { TelegramTemplateView } from "@/lib/notifications/telegram-templates";
import { insertTelegramPlaceholder } from "@/lib/notifications/telegram-template-placeholders";

type Props = {
  canUpdate: boolean;
  initialTemplates: TelegramTemplateView[];
};

type Draft = {
  buttons: TemplateButtonDraft[];
  ctaEnabled: boolean;
  ctaLabel: string;
  ctaUrl: string;
  isActive: boolean;
  message: string;
  templateKey: string;
  title: string;
};

type TemplateButtonDraft = {
  enabled: boolean;
  label: string;
  type: "open_phoenix" | "view_details" | "custom";
  url: string;
};

type PreviewState = {
  buttons: Array<{ label: string; type: string; url: string }>;
  ctaLabel: string | null;
  ctaUrl: string | null;
  message: string;
  title: string;
};

const placeholderDragType = "application/x-phoenix-telegram-placeholder";

function statusClass(active: boolean) {
  return active ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600";
}

function formatDate(value: string | null) {
  if (!value) return "Not saved yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function createDraft(template: TelegramTemplateView): Draft {
  const buttons = template.buttons.length > 0
    ? template.buttons
    : [{ enabled: template.ctaEnabled, label: template.ctaLabel, type: "open_phoenix" as const, url: template.ctaUrl }];
  const firstButton = buttons[0] ?? { enabled: false, label: "Open Phoenix", type: "open_phoenix" as const, url: "{{actionUrl}}" };
  return {
    buttons,
    ctaEnabled: firstButton.enabled,
    ctaLabel: firstButton.label,
    ctaUrl: firstButton.url,
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
  const [preview, setPreview] = useState<PreviewState>(() => ({
    buttons: selectedTemplate.buttons.filter((button) => button.enabled).map((button) => ({ label: button.label, type: button.type, url: button.url })),
    ctaLabel: selectedTemplate.ctaEnabled ? selectedTemplate.ctaLabel : null,
    ctaUrl: selectedTemplate.ctaEnabled ? selectedTemplate.ctaUrl : null,
    message: selectedTemplate.message,
    title: selectedTemplate.title,
  }));
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const buttonUrlRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const titleRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function selectTemplate(template: TelegramTemplateView) {
    setSelectedKey(template.templateKey);
    setDraft(createDraft(template));
    setPreview({
      buttons: template.buttons.filter((button) => button.enabled).map((button) => ({ label: button.label, type: button.type, url: button.url })),
      ctaLabel: template.ctaEnabled ? template.ctaLabel : null,
      ctaUrl: template.ctaEnabled ? template.ctaUrl : null,
      message: template.message,
      title: template.title,
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

  function startPlaceholderDrag(event: DragEvent<HTMLButtonElement>, placeholder: string) {
    event.dataTransfer.setData(placeholderDragType, placeholder);
    event.dataTransfer.setData("text/plain", `{{${placeholder}}}`);
    event.dataTransfer.effectAllowed = "copy";
  }

  function placeholderFromDrop(event: DragEvent<HTMLElement>) {
    const raw = event.dataTransfer.getData(placeholderDragType) || event.dataTransfer.getData("text/plain");
    const placeholder = raw.replace(/^\{\{\s*/, "").replace(/\s*\}\}$/, "").trim();
    return selectedTemplate.allowedPlaceholders.includes(placeholder) ? placeholder : null;
  }

  function allowPlaceholderDrop(event: DragEvent<HTMLElement>) {
    if (!canUpdate) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function dropMessagePlaceholder(event: DragEvent<HTMLTextAreaElement>) {
    const placeholder = placeholderFromDrop(event);
    if (!placeholder) return;
    event.preventDefault();
    insertPlaceholder(placeholder);
  }

  function dropTitlePlaceholder(event: DragEvent<HTMLInputElement>) {
    const placeholder = placeholderFromDrop(event);
    if (!placeholder) return;
    event.preventDefault();
    insertTitlePlaceholder(placeholder);
  }

  function dropButtonPlaceholder(index: number, event: DragEvent<HTMLInputElement>) {
    const placeholder = placeholderFromDrop(event);
    if (!placeholder) return;
    event.preventDefault();
    insertButtonPlaceholder(index, placeholder);
  }

  function insertTitlePlaceholder(placeholder: string) {
    const input = titleRef.current;
    const start = input?.selectionStart ?? draft.title.length;
    const end = input?.selectionEnd ?? start;
    const nextTitle = insertTelegramPlaceholder(draft.title, placeholder, start, end);
    setDraft((current) => ({ ...current, title: nextTitle }));
    requestAnimationFrame(() => {
      input?.focus();
      const nextCursor = start + placeholder.length + 4;
      input?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function insertButtonPlaceholder(index: number, placeholder: string) {
    const input = buttonUrlRefs.current[index];
    const currentUrl = draft.buttons[index]?.url ?? "";
    const start = input?.selectionStart ?? currentUrl.length;
    const end = input?.selectionEnd ?? start;
    const nextUrl = insertTelegramPlaceholder(currentUrl, placeholder, start, end);
    setDraft((current) => ({
      ...current,
      buttons: current.buttons.map((button, buttonIndex) => buttonIndex === index ? { ...button, url: nextUrl } : button),
    }));
    requestAnimationFrame(() => {
      input?.focus();
      const nextCursor = start + placeholder.length + 4;
      input?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function addButton(type: TemplateButtonDraft["type"]) {
    const defaults: Record<TemplateButtonDraft["type"], TemplateButtonDraft> = {
      custom: { enabled: true, label: "Open Phoenix", type: "custom", url: "{{actionUrl}}" },
      open_phoenix: { enabled: true, label: "Open Phoenix", type: "open_phoenix", url: "{{actionUrl}}" },
      view_details: { enabled: true, label: "View Details", type: "view_details", url: "{{requestUrl}}" },
    };
    setDraft((current) => current.buttons.length >= 3 ? current : { ...current, buttons: [...current.buttons, defaults[type]] });
  }

  function updateButton(index: number, patch: Partial<TemplateButtonDraft>) {
    setDraft((current) => ({
      ...current,
      buttons: current.buttons.map((button, buttonIndex) => buttonIndex === index ? { ...button, ...patch } : button),
    }));
  }

  function removeButton(index: number) {
    setDraft((current) => ({ ...current, buttons: current.buttons.filter((_button, buttonIndex) => buttonIndex !== index) }));
  }

  function resetToDefault() {
    setDraft({
      buttons: [{ enabled: false, label: "Open Phoenix", type: "open_phoenix", url: "{{actionUrl}}" }],
      ctaEnabled: false,
      ctaLabel: "Open Phoenix",
      ctaUrl: "{{actionUrl}}",
      isActive: false,
      message: selectedTemplate.defaultMessage,
      templateKey: selectedTemplate.templateKey,
      title: selectedTemplate.defaultTitle,
    });
    setPreview({ buttons: [], ctaLabel: null, ctaUrl: null, message: selectedTemplate.defaultMessage, title: selectedTemplate.defaultTitle });
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
            buttons: saved.buttons.filter((button: TemplateButtonDraft) => button.enabled).map((button: TemplateButtonDraft) => ({ label: button.label, type: button.type, url: button.url })),
            ctaLabel: saved.ctaEnabled ? saved.ctaLabel : null,
            ctaUrl: saved.ctaEnabled ? saved.ctaUrl : null,
            message: saved.message,
            title: saved.title,
          });
        }
      } else if (payload.data?.templates) {
        setTemplates(payload.data.templates);
      } else if (payload.data?.message) {
        setPreview({
          buttons: payload.data.buttons ?? [],
          ctaLabel: payload.data.ctaLabel ?? null,
          ctaUrl: payload.data.ctaUrl ?? null,
          message: payload.data.message,
          title: payload.data.title ?? draft.title,
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
  const buttonUrls = draft.buttons.map((button) => button.url).join(" ");
  const usedPlaceholders = selectedTemplate.recommendedPlaceholders.filter((placeholder) => draft.message.includes(`{{${placeholder}}}`) || buttonUrls.includes(`{{${placeholder}}}`) || draft.title.includes(`{{${placeholder}}}`));
  const missingRecommended = selectedTemplate.recommendedPlaceholders.filter((placeholder) => !usedPlaceholders.includes(placeholder));
  const qualityScore = Math.max(0, Math.min(100,
    40
    + (draft.message.trim() ? 20 : 0)
    + (tooLong ? -20 : 10)
    + Math.round((usedPlaceholders.length / Math.max(selectedTemplate.recommendedPlaceholders.length, 1)) * 20)
    + (draft.buttons.some((button) => button.enabled && button.label.trim() && button.url.trim()) ? 10 : draft.buttons.some((button) => button.enabled) ? -10 : 0),
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
                  onDragOver={allowPlaceholderDrop}
                  onDrop={dropTitlePlaceholder}
                  ref={titleRef}
                  value={draft.title}
                />
              </label>

              <div>
                <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-sm font-bold text-slate-800">Available placeholders</p>
                    <p className="text-xs font-semibold text-slate-500">Write any normal text, then click or drag variables into the title, message, or button URL fields.</p>
                  </div>
                  <p className="text-xs font-bold text-slate-500">{selectedTemplate.allowedPlaceholders.length} variables available</p>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedTemplate.allowedPlaceholders.map((placeholder) => (
                    <button
                      className="rounded border border-orange-200 bg-orange-50 px-2.5 py-1.5 text-xs font-bold text-orange-800 disabled:opacity-50"
                      disabled={!canUpdate}
                      draggable={canUpdate}
                      key={placeholder}
                      onClick={() => insertPlaceholder(placeholder)}
                      onDragStart={(event) => startPlaceholderDrag(event, placeholder)}
                      type="button"
                    >
                      {"{{"}{placeholder}{"}}"}
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="py-1 text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Insert into title</span>
                  {selectedTemplate.recommendedPlaceholders.slice(0, 6).map((placeholder) => (
                    <button
                      className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-700 disabled:opacity-50"
                      disabled={!canUpdate}
                      draggable={canUpdate}
                      key={`title-${placeholder}`}
                      onClick={() => insertTitlePlaceholder(placeholder)}
                      onDragStart={(event) => startPlaceholderDrag(event, placeholder)}
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
                    <p className="text-sm font-black text-slate-950">Smart Action Buttons</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">Safe Telegram URL buttons only. Approve and Reject are reserved for a later authenticated Phoenix confirmation phase.</p>
                  </div>
                  <span className="rounded border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-600">
                    {draft.buttons.filter((button) => button.enabled).length}/3 enabled
                  </span>
                </div>

                <div className="mt-4 space-y-3">
                  {draft.buttons.map((button, index) => (
                    <div className="rounded border border-slate-200 bg-white p-3" key={`${button.type}-${index}`}>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            className={`inline-flex items-center gap-2 rounded border px-2.5 py-1.5 text-xs font-bold disabled:opacity-50 ${button.enabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}
                            disabled={!canUpdate}
                            onClick={() => updateButton(index, { enabled: !button.enabled })}
                            type="button"
                          >
                            {button.enabled ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                            {button.enabled ? "Enabled" : "Disabled"}
                          </button>
                          <select
                            className="rounded border border-slate-200 bg-white px-2 py-1.5 text-xs font-bold text-slate-700"
                            disabled={!canUpdate}
                            onChange={(event) => {
                              const type = event.target.value as TemplateButtonDraft["type"];
                              updateButton(index, {
                                label: type === "view_details" ? "View Details" : type === "open_phoenix" ? "Open Phoenix" : button.label,
                                type,
                                url: type === "view_details" ? "{{requestUrl}}" : type === "open_phoenix" ? "{{actionUrl}}" : button.url,
                              });
                            }}
                            value={button.type}
                          >
                            <option value="open_phoenix">Open Phoenix</option>
                            <option value="view_details">View Details</option>
                            <option value="custom">Custom</option>
                          </select>
                        </div>
                        <button
                          className="rounded border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-600 disabled:opacity-50"
                          disabled={!canUpdate}
                          onClick={() => removeButton(index)}
                          type="button"
                        >
                          Remove
                        </button>
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <label className="block">
                          <span className="text-xs font-bold text-slate-700">Button label</span>
                          <input
                            className="mt-1 w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                            disabled={!canUpdate || !button.enabled}
                            onChange={(event) => updateButton(index, { label: event.target.value })}
                            placeholder="Open Phoenix"
                            value={button.label}
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs font-bold text-slate-700">Button URL or placeholder</span>
                          <input
                            className="mt-1 w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                            disabled={!canUpdate || !button.enabled}
                            onChange={(event) => updateButton(index, { url: event.target.value })}
                            onDragOver={allowPlaceholderDrop}
                            onDrop={(event) => dropButtonPlaceholder(index, event)}
                            placeholder="{{actionUrl}}"
                            ref={(node) => { buttonUrlRefs.current[index] = node; }}
                            value={button.url}
                          />
                        </label>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {["actionUrl", "requestUrl", "employeePortalUrl"].filter((placeholder) => selectedTemplate.allowedPlaceholders.includes(placeholder)).map((placeholder) => (
                          <button
                            className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-700 disabled:opacity-50"
                            disabled={!canUpdate || !button.enabled}
                            draggable={canUpdate && button.enabled}
                            key={`${index}-${placeholder}`}
                            onClick={() => insertButtonPlaceholder(index, placeholder)}
                            onDragStart={(event) => startPlaceholderDrag(event, placeholder)}
                            type="button"
                          >
                            {"{{"}{placeholder}{"}}"}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="rounded border border-orange-200 bg-orange-50 px-2.5 py-1.5 text-xs font-bold text-orange-800 disabled:opacity-50"
                    disabled={!canUpdate || draft.buttons.length >= 3}
                    onClick={() => addButton("open_phoenix")}
                    type="button"
                  >
                    Add Open Phoenix
                  </button>
                  <button
                    className="rounded border border-orange-200 bg-orange-50 px-2.5 py-1.5 text-xs font-bold text-orange-800 disabled:opacity-50"
                    disabled={!canUpdate || draft.buttons.length >= 3}
                    onClick={() => addButton("view_details")}
                    type="button"
                  >
                    Add View Details
                  </button>
                  <button
                    className="rounded border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 disabled:opacity-50"
                    disabled={!canUpdate || draft.buttons.length >= 3}
                    onClick={() => addButton("custom")}
                    type="button"
                  >
                    Add Custom URL
                  </button>
                </div>

                <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                  Approve and Reject buttons are intentionally blocked in this phase. They will open Phoenix confirmation pages in a later secured rollout.
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
                  onDragOver={allowPlaceholderDrop}
                  onDrop={dropMessagePlaceholder}
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
              <div className="mt-4 rounded border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-800">
                <p className="font-black text-slate-950">{preview.title}</p>
                <p className="mt-3 whitespace-pre-wrap">{preview.message}</p>
              </div>
              <div className="mt-4 rounded border border-slate-200 bg-white p-4">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Smart Button Preview</p>
                {preview.buttons.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {preview.buttons.map((button, index) => (
                      <div className="rounded border border-orange-200 bg-orange-50 px-3 py-2 text-center text-sm font-black text-orange-800" key={`${button.label}-${index}`}>
                        {button.label}
                        <p className="mt-1 break-all text-xs font-semibold text-orange-700">{button.url}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm font-semibold text-slate-500">No buttons enabled. Telegram sends plain text only.</p>
                )}
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
