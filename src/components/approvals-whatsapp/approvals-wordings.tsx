"use client";

// Approvals WhatsApp — the Wordings tab: every wording on the approvals number with Meta's status and any rejection
// reason, and a form that submits a new one to Meta for review (owner, 19 Nov 2026: "Submit from the screen").
//
// Only an APPROVED wording ever reaches the composer or the bulk send; a pending or rejected one is listed here and
// nowhere else. Fields are named — {{first_name}} — and Meta reviews each with the example given beside it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Send } from "lucide-react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import { getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { phxFieldClassName, phxHintClassName, phxLabelClassName, phxSelectClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { codeOrWords, humanizeCode } from "@/lib/format/code-label";
import { cn } from "@/lib/utils";

import { APPROVALS_API, Notice, Panel } from "./approvals-shared";

type Listing = { name: string; language: string; category: string | null; status: string; rejectedReason: string | null; bodyText: string; sendable: boolean };

const STATUS_WORDS: Record<string, string> = {
  APPROVED: "Approved",
  DISABLED: "Disabled by Meta",
  IN_APPEAL: "In appeal",
  PAUSED: "Paused by Meta",
  PENDING: "Waiting for Meta's review",
  REJECTED: "Rejected",
};

function languageWord(language: string): string {
  if (language === "ar") return "Arabic";
  if (language.startsWith("en")) return "English";
  return language;
}

function paramNames(body: string): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)) if (!names.includes(match[1]!)) names.push(match[1]!);
  return names;
}

export function ApprovalsWordings() {
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<"ar" | "en">("ar");
  const [category, setCategory] = useState<"UTILITY" | "MARKETING">("UTILITY");
  const [body, setBody] = useState("");
  const [examples, setExamples] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "good" | "warn"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getJson(`${APPROVALS_API}/templates`);
      setListings(Array.isArray(data.templates) ? (data.templates as Listing[]) : []);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "WhatsApp did not return the wordings.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState in load() runs after the awaited fetch
    void load();
  }, [load]);

  const params = useMemo(() => paramNames(body), [body]);

  async function submit() {
    setBusy(true);
    setResult(null);
    try {
      const data = await postJson(`${APPROVALS_API}/templates`, {
        body,
        category,
        examples: Object.fromEntries(params.map((param) => [param, examples[param] ?? ""])),
        language,
        name: name.trim(),
      });
      setResult({ text: `Sent ${humanizeCode(name.trim())} to Meta. Its status: ${STATUS_WORDS[String(data.status ?? "").toUpperCase()] ?? humanizeCode(String(data.status ?? "pending"))}.`, tone: "good" });
      setName("");
      setBody("");
      setExamples({});
      await load();
    } catch (caught) {
      setResult({ text: caught instanceof Error ? caught.message : "Meta did not take the wording.", tone: "warn" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel
        aside={
          <Action onClick={() => void load()} tone="ghost">
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
            Read again
          </Action>
        }
        title="Wordings on this number"
      >
        {loadError ? <Notice tone="warn">{loadError}</Notice> : null}
        {listings === null && !loadError ? <p className="text-[12px] text-phx-ink-soft">Reading the wordings from WhatsApp</p> : null}
        {listings && listings.length === 0 ? <p className="text-[12px] text-phx-ink-soft">No wording on this number yet.</p> : null}
        <ul className="flex flex-col">
          {(listings ?? []).map((listing) => (
            <li className="flex flex-col gap-1.5 border-b border-phx-line py-2.5 last:border-b-0" key={`${listing.name}|${listing.language}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="break-words text-[13px] font-bold text-phx-ink">{humanizeCode(listing.name)}</span>
                <span
                  className={cn(
                    "border px-1.5 py-0.5 text-[11px] font-bold leading-none",
                    listing.status === "APPROVED"
                      ? "border-phx-ok-line bg-phx-ok-bg text-phx-ok"
                      : listing.status === "REJECTED" || listing.status === "DISABLED"
                        ? "border-phx-danger-line bg-phx-danger-bg text-phx-danger"
                        : "border-phx-warn-line bg-phx-warn-bg text-phx-warn",
                  )}
                >
                  {STATUS_WORDS[listing.status] ?? humanizeCode(listing.status)}
                </span>
              </div>
              <span className="text-[11px] text-phx-ink-soft">
                {languageWord(listing.language)}
                {listing.category ? ` · ${humanizeCode(listing.category)}` : ""}
                {listing.status === "APPROVED" && !listing.sendable ? " · needs something this screen cannot supply yet, so it is not offered for sending" : ""}
              </span>
              {listing.rejectedReason ? <p className="break-words text-[12px] text-phx-danger">Meta&apos;s reason: {codeOrWords(listing.rejectedReason)}</p> : null}
              <p className="whitespace-pre-wrap break-words bg-phx-surface-2 p-2 text-[12px] leading-relaxed text-phx-ink-2" dir="auto">
                {listing.bodyText}
              </p>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Submit a new wording">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col">
            <span className={phxLabelClassName}>Name</span>
            <input className={phxFieldClassName} dir="ltr" maxLength={512} onChange={(event) => setName(event.target.value)} placeholder="phx_finance_notice" value={name} />
            <span className={phxHintClassName}>Small English letters, numbers and _ only. Meta never shows the name to the person.</span>
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col">
              <span className={phxLabelClassName}>Language</span>
              <select className={phxSelectClassName} onChange={(event) => setLanguage(event.target.value as "ar" | "en")} value={language}>
                <option value="ar">Arabic</option>
                <option value="en">English</option>
              </select>
            </label>
            <label className="flex flex-col">
              <span className={phxLabelClassName}>Kind</span>
              <select className={phxSelectClassName} onChange={(event) => setCategory(event.target.value as "UTILITY" | "MARKETING")} value={category}>
                <option value="UTILITY">Utility — about something the person is already part of</option>
                <option value="MARKETING">Marketing — an announcement or an offer</option>
              </select>
            </label>
          </div>
          <label className="flex flex-col">
            <span className={phxLabelClassName}>The message</span>
            <textarea className={phxTextareaClassName} dir="auto" maxLength={1024} onChange={(event) => setBody(event.target.value)} placeholder="مرحباً {{name_with_title}}، …" rows={6} value={body} />
            <span className={phxHintClassName}>Write a field as {"{{first_name}}"}. A message may not start or end with a field. At most 1,024 characters.</span>
          </label>
          {params.map((param) => (
            <label className="flex flex-col" key={param}>
              <span className={phxLabelClassName}>Example for {`{{${param}}}`}</span>
              <input className={phxFieldClassName} dir="auto" maxLength={200} onChange={(event) => setExamples((current) => ({ ...current, [param]: event.target.value }))} value={examples[param] ?? ""} />
            </label>
          ))}
          {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
          <div>
            <Action disabled={busy || !name.trim() || !body.trim()} onClick={() => void submit()} size="md" tone="primary">
              <Send aria-hidden className="h-3.5 w-3.5" />
              {busy ? "Sending to Meta" : "Submit to Meta for review"}
            </Action>
          </div>
        </div>
      </Panel>
    </div>
  );
}
