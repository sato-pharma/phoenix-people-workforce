"use client";

// Recruitment / ATS — the one-click "message this candidate on WhatsApp" dialog.
//
// Opens from a candidate (number and name filled in) or from nowhere at all (a number typed by
// hand, for someone with no CV). Same component either way: two screens that drift apart is exactly
// how the manual path ends up missing a fix the candidate path got.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { cn } from "@/lib/utils";

type Template = {
  id: string;
  name: string;
  category: string;
  body: string;
  isActive: boolean;
  variableKeys: string[];
};

type CandidateContext = {
  candidateId: string;
  fullName: string;
  dialNumber: string | null;
  numberSource: "whatsapp" | "phone" | null;
  autoValues: Record<string, string>;
};

/**
 * The message preview.
 *
 * EVERY LINE CARRIES ITS OWN `dir="auto"`, never the block. These messages routinely hold an English
 * body and an Arabic address together, and `auto` on the wrapper reads only the FIRST strong
 * character in the whole block — which renders the Arabic half backwards, or the English half
 * backwards, depending on which came first. Per line, each line is judged on its own text and both
 * halves come out the right way round.
 */
function MessagePreview({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="border border-slate-200 bg-[#e7f6e9] p-3 text-[13px] leading-relaxed text-slate-800">
      {lines.map((line, index) => (
        // A blank line is a paragraph break in the original and must survive as vertical space, so
        // it renders a non-breaking space rather than collapsing to nothing.
        <p className="whitespace-pre-wrap break-words" dir="auto" key={index}>
          {line.length > 0 ? line : " "}
        </p>
      ))}
    </div>
  );
}

function labelFor(key: string): string {
  const known: Record<string, string> = {
    address: "Address",
    candidate_first_name: "First name",
    candidate_name: "Full name",
    company_name: "Company",
    dress_code: "Dress code",
    feedback: "Feedback",
    interview_date: "Date",
    interview_time: "Time",
    interviewer_name: "Interviewer",
    interviewer_title: "Interviewer job title",
    job_title: "Job title",
    location_link: "Location (Maps link)",
    sender_name: "Your name",
    website: "Web site",
  };
  if (known[key]) return known[key];
  return key
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Placeholders that want more than one line, so the box matches the shape of the answer. */
const MULTILINE_KEYS = new Set(["address", "feedback", "notes"]);

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/gu;

/** Local mirror of the server renderer, for the live preview only. The server re-renders on send. */
function renderPreview(body: string, values: Record<string, string>): string {
  return body.replace(PLACEHOLDER_PATTERN, (whole, rawKey: string) => {
    const value = values[String(rawKey).trim().toLowerCase()];
    return value && value.trim() ? value.trim() : whole;
  });
}

function keysOf(body: string): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    const key = String(match[1] ?? "").trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

export function WhatsAppSendDialog({
  candidateId,
  candidateName,
  onClose,
}: {
  candidateId?: string | null;
  candidateName?: string | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [candidate, setCandidate] = useState<CandidateContext | null>(null);
  const [manualAutoValues, setManualAutoValues] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [toNumber, setToNumber] = useState("");
  /** Set only when the browser swallowed the popup — then the link is offered to click by hand. */
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const query = candidateId ? `?candidateId=${encodeURIComponent(candidateId)}` : "";
        const data = await getJson(`/api/recruitment/whatsapp-templates${query}`);
        if (cancelled) return;
        const list = (data.templates ?? []) as Template[];
        const context = (data.candidate ?? null) as CandidateContext | null;
        setTemplates(list);
        setCandidate(context);
        setManualAutoValues((data.manualAutoValues ?? {}) as Record<string, string>);
        setToNumber(context?.dialNumber ?? "");
        setSelectedId(list[0]?.id ?? null);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not load the templates.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [candidateId]);

  const selected = useMemo(() => templates.find((t) => t.id === selectedId) ?? null, [templates, selectedId]);

  // The auto values are the starting point for every field; whatever the recruiter has typed sits on
  // top. Recomputed rather than copied into state so switching template never strands a stale value.
  const effectiveValues = useMemo(
    () => ({ ...(candidate?.autoValues ?? manualAutoValues), ...values }),
    [candidate, manualAutoValues, values],
  );

  const fields = useMemo(() => (selected ? keysOf(selected.body) : []), [selected]);
  const preview = useMemo(
    () => (selected ? renderPreview(selected.body, effectiveValues) : ""),
    [selected, effectiveValues],
  );
  const missing = useMemo(
    () => fields.filter((key) => !(effectiveValues[key] ?? "").trim()),
    [fields, effectiveValues],
  );

  const setValue = useCallback((key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  /**
   * Prepare the message, then open WhatsApp.
   *
   * THE TAB IS OPENED SYNCHRONOUSLY, BEFORE THE AWAIT, and only navigated once the server answers.
   * A `window.open` called after an await is no longer attributable to the click that started it, so
   * every popup blocker swallows it — silently, which reads as "the button does nothing". Opening
   * first and navigating second keeps the user gesture attached to the open.
   *
   * If the blocker refuses even that, `win` is null and the URL is offered as a link instead, rather
   * than the click appearing to fail.
   */
  const onSend = useCallback(async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    setBlockedUrl(null);

    const win = typeof window !== "undefined" ? window.open("", "_blank", "noopener,noreferrer") : null;
    try {
      const data = await postJson("/api/recruitment/whatsapp-templates/send", {
        candidateId: candidateId ?? null,
        templateId: selected.id,
        toNumber: toNumber.trim() || null,
        values: effectiveValues,
      });
      const url = String(data.url ?? "");
      if (!url) throw new Error("The message could not be prepared.");
      if (win) {
        win.location.href = url;
      } else {
        setBlockedUrl(url);
      }
      onClose();
    } catch (sendError) {
      win?.close();
      setError(sendError instanceof Error ? sendError.message : "Could not prepare the message.");
    } finally {
      setBusy(false);
    }
  }, [selected, busy, candidateId, toNumber, effectiveValues, onClose]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const who = candidate?.fullName ?? candidateName ?? "a WhatsApp number";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-2 sm:p-6">
      <div
        aria-label={`Send a WhatsApp message to ${who}`}
        aria-modal="true"
        className="w-full max-w-3xl border border-slate-300 bg-white shadow-xl"
        ref={dialogRef}
        role="dialog"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">WhatsApp message</h2>
            <p className="text-xs text-slate-600" dir="auto">
              To {who}
            </p>
          </div>
          <button
            className="border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          {loading ? <p className="text-sm text-slate-600">Loading your templates…</p> : null}

          {!loading && templates.length === 0 ? (
            <p className="text-sm text-slate-700">
              No templates yet. Add one on the WhatsApp Templates screen, then come back here.
            </p>
          ) : null}

          {!loading && templates.length > 0 ? (
            <>
              <div>
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Template
                </span>
                {/* Wraps rather than scrolls — the fits-the-screen rule. No min-width floor anywhere. */}
                <div className="flex flex-wrap gap-2">
                  {templates.map((template) => (
                    <button
                      className={cn(
                        "border px-3 py-1.5 text-left text-xs font-medium",
                        template.id === selectedId
                          ? "border-[#0A527D] bg-[#0A527D] text-white"
                          : "border-slate-300 bg-white text-slate-700 hover:border-[#0A6BA6]",
                      )}
                      key={template.id}
                      onClick={() => {
                        setSelectedId(template.id);
                        setBlockedUrl(null);
                      }}
                      type="button"
                    >
                      {template.name}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600" htmlFor="wa-number">
                  WhatsApp number
                </label>
                <input
                  className="w-full border border-slate-300 px-3 py-2 text-sm text-slate-900"
                  id="wa-number"
                  inputMode="tel"
                  onChange={(event) => setToNumber(event.target.value)}
                  placeholder="01012345678, or +44… for a number outside Egypt"
                  value={toNumber}
                />
                <p className="mt-1 text-xs text-slate-600">
                  {candidate?.numberSource
                    ? `From this candidate's ${candidate.numberSource === "whatsapp" ? "WhatsApp" : "phone"} field. Change it here if it is wrong.`
                    : candidateId
                      ? "Nothing usable on file for this candidate — type the number."
                      : "Type any number. Nothing needs to exist in the system."}
                </p>
              </div>

              {fields.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {fields.map((key) => (
                    <div className={cn(MULTILINE_KEYS.has(key) && "sm:col-span-2")} key={key}>
                      <label
                        className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600"
                        htmlFor={`wa-field-${key}`}
                      >
                        {labelFor(key)}
                      </label>
                      {MULTILINE_KEYS.has(key) ? (
                        <textarea
                          className="w-full border border-slate-300 px-3 py-2 text-sm text-slate-900"
                          dir="auto"
                          id={`wa-field-${key}`}
                          onChange={(event) => setValue(key, event.target.value)}
                          rows={3}
                          value={effectiveValues[key] ?? ""}
                        />
                      ) : (
                        <input
                          className="w-full border border-slate-300 px-3 py-2 text-sm text-slate-900"
                          dir="auto"
                          id={`wa-field-${key}`}
                          onChange={(event) => setValue(key, event.target.value)}
                          value={effectiveValues[key] ?? ""}
                        />
                      )}
                    </div>
                  ))}
                </div>
              ) : null}

              <div>
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Preview
                </span>
                <MessagePreview text={preview} />
              </div>
            </>
          ) : null}

          {error ? <p className="border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error}</p> : null}

          {blockedUrl ? (
            <p className="border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
              Your browser blocked the pop-up.{" "}
              <a className="font-semibold underline" href={blockedUrl} rel="noopener noreferrer" target="_blank">
                Open WhatsApp
              </a>
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-xs text-slate-600">
            Opens WhatsApp with the message written. You press send there.
          </p>
          <button
            className="border border-[#25D366] bg-[#25D366] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300"
            disabled={busy || !selected || missing.length > 0 || !toNumber.trim()}
            onClick={onSend}
            type="button"
          >
            {busy ? "Preparing…" : "Open in WhatsApp"}
          </button>
        </div>
        {missing.length > 0 ? (
          <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-600">
            Still to fill in: {missing.map((key) => labelFor(key)).join(", ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
