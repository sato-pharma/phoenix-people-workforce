"use client";

// WhatsApp Inbox — pick an approved template, fill its blanks, see exactly what the person will read.
//
// The list is read live from the sending number's OWN WhatsApp business account, every time the form
// opens. A template approved on the other number cannot be sent from this one, and a cached list is
// how a screen offers a template Meta has since paused. The parent keys this form by number, so
// switching number starts a fresh read rather than showing the previous number's templates.

import { useEffect, useMemo, useState } from "react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import { getJson } from "@/components/recruitment/recruitment-fetch";
import { missingTemplateFields, renderInboxTemplate, type InboxTemplate } from "@/lib/whatsapp-inbox/graph";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; templates: InboxTemplate[]; emptyReason: string | null };

export type TemplateSendInput = { templateName: string; language: string; values: Record<string, string> };

function templateKey(template: InboxTemplate): string {
  return `${template.name}|${template.language}`;
}

function templateTitle(template: InboxTemplate): string {
  return template.name.replace(/_/g, " ");
}

export function InboxTemplateForm({
  busy,
  line,
  onCancel,
  onSend,
  submitLabel,
}: {
  busy: boolean;
  /** The sending number's phone number id. */
  line: string;
  onCancel: () => void;
  onSend: (input: TemplateSendInput) => void;
  submitLabel: string;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    getJson(`/api/whatsapp-inbox/templates?line=${encodeURIComponent(line)}`)
      .then((data) => {
        if (cancelled) return;
        setState({
          emptyReason: typeof data.emptyReason === "string" ? data.emptyReason : null,
          kind: "ready",
          templates: Array.isArray(data.templates) ? (data.templates as InboxTemplate[]) : [],
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ kind: "error", message: error instanceof Error ? error.message : "Could not read the templates." });
      });
    return () => {
      cancelled = true;
    };
  }, [line]);

  const templates = useMemo(() => (state.kind === "ready" ? state.templates : []), [state]);
  const selected = useMemo(() => templates.find((template) => templateKey(template) === selectedKey) ?? null, [selectedKey, templates]);
  const missing = selected ? missingTemplateFields(selected, values) : [];
  const preview = selected ? renderInboxTemplate(selected, values) : "";
  const fields = selected ? [...selected.headerFields, ...selected.bodyFields] : [];

  return (
    <div className="flex w-full flex-col gap-2 text-[12px]">
      {state.kind === "loading" ? <p className="text-phx-ink-soft">Reading this number&apos;s approved templates from WhatsApp…</p> : null}
      {state.kind === "error" ? <p className="leading-snug text-phx-danger">{state.message}</p> : null}
      {state.kind === "ready" && templates.length === 0 ? (
        <p className="leading-snug text-phx-ink-soft">{state.emptyReason ?? "This number has no approved templates."}</p>
      ) : null}

      {templates.length > 0 ? (
        <label className="flex flex-col gap-1">
          <span className="font-bold text-phx-ink-2">Template</span>
          <select
            className="w-full border border-phx-line bg-white px-2 py-1.5 text-[13px] text-phx-ink outline-none focus:border-phx-accent"
            disabled={busy}
            onChange={(event) => {
              setSelectedKey(event.target.value);
              setValues({});
            }}
            value={selectedKey}
          >
            <option value="">Choose a template…</option>
            {templates.map((template) => (
              <option key={templateKey(template)} value={templateKey(template)}>
                {templateTitle(template)} · {template.language}
                {template.unsupportedReason ? " (cannot be sent from here)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {selected?.unsupportedReason ? <p className="leading-snug text-phx-warn">{selected.unsupportedReason}</p> : null}

      {selected && !selected.unsupportedReason ? (
        <>
          {fields.map((field) => (
            <label className="flex flex-col gap-1" key={field.key}>
              <span className="font-bold text-phx-ink-2">{field.label}</span>
              <input
                className="w-full border border-phx-line bg-white px-2 py-1.5 text-[13px] text-phx-ink outline-none focus:border-phx-accent"
                dir="auto"
                disabled={busy}
                maxLength={1024}
                onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                placeholder={field.example ? `For example: ${field.example}` : undefined}
                value={values[field.key] ?? ""}
              />
            </label>
          ))}
          <div className="border border-phx-line bg-phx-surface-2 p-2">
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-phx-ink-faint">What they will read</p>
            {preview.split("\n").map((line, index) => (
              <p className="min-h-[1em] whitespace-pre-wrap break-words text-[13px] leading-relaxed text-phx-ink" dir="auto" key={index}>
                {line}
              </p>
            ))}
          </div>
          <p className="leading-snug text-phx-ink-soft">Templates are billed by Meta per conversation.</p>
        </>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <Action
          disabled={busy || !selected || Boolean(selected.unsupportedReason) || missing.length > 0}
          onClick={() => {
            if (!selected) return;
            onSend({ language: selected.language, templateName: selected.name, values });
          }}
          title={missing.length > 0 ? `Fill in: ${missing.join(", ")}` : undefined}
          tone="primary"
        >
          {busy ? "Sending…" : submitLabel}
        </Action>
        <Action disabled={busy} onClick={onCancel} tone="ghost">
          Cancel
        </Action>
      </div>
    </div>
  );
}
