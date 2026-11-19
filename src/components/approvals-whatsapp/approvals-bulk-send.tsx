"use client";

// Approvals WhatsApp — the Bulk send tab: one approved wording to many people, each field filled per person.
//
// The order is the owner's: choose the wording, say how each field is filled (fixed text, or an employee field such as
// the name with its Arabic title), choose the people, PREVIEW what three of them will read and who is skipped, then
// send. The preview and the send are worked out by the same server function, so they cannot disagree. The send runs on
// the server, throttled, one message per person; one failure never stops the rest, and the Reports tab shows each one.
//
// Meta's TIER_250 limit is shown and enforced: a send that would take today's new contacts past 250 is refused whole,
// on the server, before anything goes.

import { useEffect, useMemo, useState } from "react";
import { Eye, SendHorizontal } from "lucide-react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import { getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { phxCheckInputClassName, phxFieldClassName, phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { humanizeCode } from "@/lib/format/code-label";
import { EMPLOYEE_PARAMETER_FIELDS, type ParameterSource } from "@/lib/approvals-whatsapp/rules";
import type { InboxTemplate } from "@/lib/whatsapp-inbox/graph";

import { APPROVALS_API, Figure, Notice, Panel, phoneText, RecipientPicker, type ApprovalsEmployeeOption, type RecipientChoice } from "./approvals-shared";

type ListOption = { id: string; name: string; memberCount: number };

type Preview = {
  recipientCount: number;
  sample: Array<{ name: string; renderedBody: string; waId: string }>;
  noNumber: Array<{ hrId: string; name: string }>;
  invalidPasted: Array<{ text: string; reason: string }>;
  duplicates: Array<{ waId: string; name: string | null }>;
  unfilled: Array<{ waId: string; name: string; missing: string[] }>;
  tier: { allowed: boolean; limit: number; newContacts: number; overBy: number; remaining: number; usedToday: number };
  tooMany: boolean;
};

function templateKey(template: Pick<InboxTemplate, "name" | "language">): string {
  return `${template.name}|${template.language}`;
}

export function ApprovalsBulkSend({
  dailyLimit,
  employees,
  lists,
  onSent,
}: {
  dailyLimit: { limit: number; usedToday: number } | null;
  employees: ApprovalsEmployeeOption[];
  lists: ListOption[];
  onSent: (broadcastId: string) => void;
}) {
  const [templates, setTemplates] = useState<InboxTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState("");
  const [mapping, setMapping] = useState<Record<string, ParameterSource>>({});
  const [choice, setChoice] = useState<RecipientChoice>({ employeeHrIds: [], pasted: "" });
  const [listId, setListId] = useState("");
  const [previewState, setPreviewState] = useState<{ key: string; data: Preview } | null>(null);
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJson(`${APPROVALS_API}/templates`)
      .then((data) => {
        if (!cancelled) setTemplates(Array.isArray(data.approved) ? (data.approved as InboxTemplate[]) : []);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setTemplatesError(caught instanceof Error ? caught.message : "WhatsApp did not return the wordings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(() => templates?.find((template) => templateKey(template) === selectedKey) ?? null, [selectedKey, templates]);
  const fields = selected ? [...selected.headerFields, ...selected.bodyFields] : [];

  // Anything that changes what would be sent throws the preview away: a send must follow the preview it was shown. The
  // preview and the tick are kept against the inputs they were made for, and count only while those inputs still hold.
  const inputsKey = JSON.stringify([selectedKey, mapping, choice, listId]);
  const preview = previewState?.key === inputsKey ? previewState.data : null;
  const confirmed = preview !== null && confirmedKey === inputsKey;

  function setField(key: string, source: ParameterSource) {
    setMapping((current) => ({ ...current, [key]: source }));
  }

  function body(previewOnly: boolean) {
    return {
      language: selected?.language,
      mapping,
      preview: previewOnly,
      recipients: { employeeHrIds: choice.employeeHrIds, listId: listId || undefined, pasted: choice.pasted },
      templateName: selected?.name,
    };
  }

  async function runPreview() {
    if (!selected) return;
    const key = inputsKey;
    setBusy(true);
    setError(null);
    setConfirmedKey(null);
    try {
      setPreviewState({ data: (await postJson(`${APPROVALS_API}/broadcasts`, body(true))) as unknown as Preview, key });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The preview could not be worked out.");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!selected || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const data = await postJson(`${APPROVALS_API}/broadcasts`, body(false));
      if (typeof data.broadcastId === "string") onSent(data.broadcastId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The bulk send did not start.");
    } finally {
      setBusy(false);
    }
  }

  const canSend = Boolean(preview && preview.recipientCount > 0 && preview.tier.allowed && !preview.tooMany && confirmed);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Figure label="New contacts today" value={dailyLimit ? dailyLimit.usedToday : null} />
        <Figure label="Daily limit (TIER_250)" value={dailyLimit ? dailyLimit.limit : null} />
        <Figure label="Left today" tone={dailyLimit && dailyLimit.limit - dailyLimit.usedToday < 25 ? "warn" : "plain"} value={dailyLimit ? Math.max(0, dailyLimit.limit - dailyLimit.usedToday) : null} />
      </div>

      <Panel title="1 · The wording">
        {templatesError ? <Notice tone="warn">{templatesError}</Notice> : null}
        {templates === null && !templatesError ? <p className="text-[12px] text-phx-ink-soft">Reading the approved wordings from WhatsApp</p> : null}
        {templates && templates.length === 0 ? <Notice>No wording is approved on this number yet. Submit one on the Wordings tab.</Notice> : null}
        {templates && templates.length > 0 ? (
          <label className="flex max-w-xl flex-col">
            <span className={phxLabelClassName}>Approved wording</span>
            <select
              className={phxSelectClassName}
              onChange={(event) => {
                setSelectedKey(event.target.value);
                setMapping({});
              }}
              value={selectedKey}
            >
              <option value="">Choose a wording</option>
              {templates.map((template) => (
                <option key={templateKey(template)} value={templateKey(template)}>
                  {humanizeCode(template.name)} · {template.language === "ar" ? "Arabic" : template.language.startsWith("en") ? "English" : template.language}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {selected ? (
          <p className="mt-3 whitespace-pre-wrap break-words border border-phx-line bg-phx-surface-2 p-3 text-[13px] leading-relaxed text-phx-ink" dir="auto">
            {selected.bodyText}
          </p>
        ) : null}
      </Panel>

      {selected && fields.length > 0 ? (
        <Panel title="2 · How each field is filled">
          <div className="flex flex-col gap-3">
            {fields.map((field) => {
              const source = mapping[field.key];
              const kind = source?.source ?? "fixed";
              return (
                <div className="grid grid-cols-1 gap-2 border-b border-phx-line pb-3 last:border-b-0 last:pb-0 md:grid-cols-3" key={field.key}>
                  <div className="flex flex-col">
                    <span className={phxLabelClassName}>{field.label}</span>
                    <select
                      className={phxSelectClassName}
                      onChange={(event) =>
                        setField(
                          field.key,
                          event.target.value === "fixed" ? { source: "fixed", text: "" } : { fallback: null, field: event.target.value as (typeof EMPLOYEE_PARAMETER_FIELDS)[number]["key"], source: "employee" },
                        )
                      }
                      value={kind === "fixed" ? "fixed" : (source as Extract<ParameterSource, { source: "employee" }>).field}
                    >
                      <option value="fixed">Fixed text, the same for everyone</option>
                      {EMPLOYEE_PARAMETER_FIELDS.map((option) => (
                        <option key={option.key} value={option.key}>
                          Each person&apos;s {option.label.charAt(0).toLowerCase() + option.label.slice(1)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {kind === "fixed" ? (
                    <label className="flex flex-col md:col-span-2">
                      <span className={phxLabelClassName}>The text</span>
                      <input
                        className={phxFieldClassName}
                        dir="auto"
                        maxLength={1000}
                        onChange={(event) => setField(field.key, { source: "fixed", text: event.target.value })}
                        placeholder={field.example ? `For example: ${field.example}` : undefined}
                        value={source?.source === "fixed" ? source.text : ""}
                      />
                    </label>
                  ) : (
                    <label className="flex flex-col md:col-span-2">
                      <span className={phxLabelClassName}>For a pasted number with no employee record</span>
                      <input
                        className={phxFieldClassName}
                        dir="auto"
                        maxLength={200}
                        onChange={(event) => source?.source === "employee" && setField(field.key, { ...source, fallback: event.target.value })}
                        placeholder="Leave empty to skip such numbers"
                        value={source?.source === "employee" ? (source.fallback ?? "") : ""}
                      />
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      ) : null}

      {selected ? (
        <Panel title="3 · Who receives it">
          <div className="flex flex-col gap-3">
            {lists.length > 0 ? (
              <label className="flex max-w-xl flex-col">
                <span className={phxLabelClassName}>Add a saved list</span>
                <select className={phxSelectClassName} onChange={(event) => setListId(event.target.value)} value={listId}>
                  <option value="">No saved list</option>
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name} ({list.memberCount})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <RecipientPicker choice={choice} employees={employees} onChange={setChoice} />
          </div>
        </Panel>
      ) : null}

      {selected ? (
        <Panel title="4 · Preview, then send">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Action disabled={busy} onClick={() => void runPreview()} size="md" tone="quiet">
                <Eye aria-hidden className="h-3.5 w-3.5" />
                {busy && !preview ? "Working it out" : "Preview"}
              </Action>
            </div>
            {error ? <Notice tone="warn">{error}</Notice> : null}
            {preview ? <PreviewView preview={preview} /> : null}
            {preview && preview.recipientCount > 0 && preview.tier.allowed && !preview.tooMany ? (
              <div className="flex flex-col gap-2 border-t border-phx-line pt-3">
                <label className="flex items-start gap-2 text-[13px] text-phx-ink">
                  <input checked={confirmed} className={phxCheckInputClassName} onChange={(event) => setConfirmedKey(event.target.checked ? inputsKey : null)} type="checkbox" />
                  <span>
                    Send {humanizeCode(selected.name)} to {preview.recipientCount} {preview.recipientCount === 1 ? "person" : "people"} now, from +20 10 40631155.
                  </span>
                </label>
                <div>
                  <Action disabled={busy || !canSend} onClick={() => void send()} size="md" tone="primary">
                    <SendHorizontal aria-hidden className="h-3.5 w-3.5" />
                    {busy ? "Starting the send" : `Send to ${preview.recipientCount}`}
                  </Action>
                </div>
              </div>
            ) : null}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function PreviewView({ preview }: { preview: Preview }) {
  const skipped = preview.noNumber.length + preview.invalidPasted.length + preview.duplicates.length + preview.unfilled.length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Figure label="Will receive it" tone="good" value={preview.recipientCount} />
        <Figure label="Skipped" tone={skipped > 0 ? "warn" : "plain"} value={skipped} />
        <Figure label="New contacts today after it" tone={preview.tier.allowed ? "plain" : "bad"} value={preview.tier.usedToday + preview.tier.newContacts} />
        <Figure label="Daily limit" value={preview.tier.limit} />
      </div>

      {!preview.tier.allowed ? (
        <Notice tone="warn">
          This would pass today&apos;s limit of {preview.tier.limit} new contacts by {preview.tier.overBy}. {preview.tier.remaining} new {preview.tier.remaining === 1 ? "contact is" : "contacts are"} left today. Send to fewer people, or send the rest tomorrow.
        </Notice>
      ) : null}
      {preview.tooMany ? <Notice tone="warn">One bulk send can reach at most 250 people. Split it into smaller sends.</Notice> : null}
      {preview.recipientCount === 0 ? <Notice tone="warn">Nobody would receive this. Choose people or paste numbers.</Notice> : null}

      {preview.sample.length > 0 ? (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
          {preview.sample.map((item) => (
            <article className="flex min-w-0 flex-col gap-2 border border-phx-line p-3" key={item.waId}>
              <header className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="break-words text-[13px] font-bold text-phx-ink" dir="auto">
                  {item.name}
                </span>
                <span className="text-[11px] tabular-nums text-phx-ink-soft" dir="ltr">
                  {phoneText(item.waId)}
                </span>
              </header>
              <p className="whitespace-pre-wrap break-words bg-phx-surface-2 p-2 text-[13px] leading-relaxed text-phx-ink" dir="auto">
                {item.renderedBody}
              </p>
            </article>
          ))}
        </div>
      ) : null}

      {preview.noNumber.length > 0 ? <Notice tone="warn">No WhatsApp number on file, skipped: {preview.noNumber.map((item) => item.name).join(", ")}</Notice> : null}
      {preview.invalidPasted.length > 0 ? <Notice tone="warn">Not a usable number, skipped: {preview.invalidPasted.map((item) => item.text).join(", ")}</Notice> : null}
      {preview.duplicates.length > 0 ? <Notice>Chosen twice, sent once: {preview.duplicates.map((item) => item.name ?? phoneText(item.waId)).join(", ")}</Notice> : null}
      {preview.unfilled.length > 0 ? (
        <Notice tone="warn">
          A field could not be filled, skipped: {preview.unfilled.map((item) => `${item.name} (${item.missing.join(", ")})`).join("; ")}
        </Notice>
      ) : null}
    </div>
  );
}
