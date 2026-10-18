"use client";

// Recruitment / ATS — the one-click "message this candidate on WhatsApp" dialog.
//
// Opens from a candidate, from an EMPLOYEE, or from nowhere at all (a number typed by hand, for
// someone with no CV). Same component all three ways: two screens that drift apart is exactly how
// one path ends up missing a fix another path got.
//
// The employee target exists because a probationer is not a candidate. Measured 2026-09-08: of the
// 30 people inside their 90-day window, 29 had no candidate record, so a probation message driven
// off the CV list would have been typed by hand nearly every time.
//
// THE LOOK (owner, 2026-10-19, the full-module premium sweep): a lifted sheet under the house dark
// band, the form kit's labels and fields, the templates as one square segmented tray, and the message
// previewed as the bubble the person will read. The one green control is the brand token, because it
// is the button that opens WhatsApp — it sends nothing by itself.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Eye, LayoutTemplate, Loader2, MessageCircle, Smartphone, X } from "lucide-react";

import { getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { cn } from "@/lib/utils";
import { phxWhatsAppSendButtonClassName } from "@/components/ui/brand-tokens";
import {
  phxFieldClassName,
  phxHintClassName,
  phxLabelClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import {
  adminChipDepthClassName,
  adminPanelDepthClassName,
  adminPanelHeaderClassName,
  adminRecessedDepthClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";
import { RecruitmentEmptyState } from "@/components/recruitment/recruitment-premium";

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

type EmployeeContext = {
  employeeHrId: string;
  fullName: string;
  jobTitle: string;
  dialNumber: string | null;
  numberSource: "mobile" | null;
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
    <div className={`ml-auto max-w-[92%] border border-slate-200 bg-[#e7f6e9] px-3 py-2.5 text-[13px] leading-relaxed text-slate-800 ${adminSoftDepthClassName}`}>
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
// Keys whose value is a block of text rather than a phrase. They get a textarea and the full width.
//
// `document_list` is auto-filled from the Hiring Documents checklist and normally arrives complete,
// so this is its FALLBACK shape — what the recruiter sees if the checklist cannot be read. A single
// -line <input> cannot hold a seven-line bullet block at all (there is no way to type a newline into
// one), which would leave the only recovery path unusable exactly when it is needed.
const MULTILINE_KEYS = new Set(["address", "document_list", "feedback", "notes"]);

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
  employeeHrId,
  employeeName,
  onClose,
}: {
  candidateId?: string | null;
  candidateName?: string | null;
  /** An employee target. Mutually exclusive with candidateId — a person is one or the other here. */
  employeeHrId?: string | null;
  employeeName?: string | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [candidate, setCandidate] = useState<CandidateContext | null>(null);
  const [employee, setEmployee] = useState<EmployeeContext | null>(null);
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
        // THE ROUTE PATH IS A WHOLE LITERAL IN BOTH BRANCHES, and it has to be. `...templates${query}`
        // reads fine but leaves an interpolation welded to the last path segment, which no static
        // scan can tell from another segment — recruitment-api-routes-exist.test.ts reported it as a
        // route that does not exist, which is the same shape as the 404-button bug that test was
        // written for. Keeping the `?` inside the literal keeps the path readable to that guard.
        // THE ROUTE PATH STAYS A WHOLE LITERAL IN EVERY BRANCH — see the note above; an
        // interpolation welded to the last path segment reads to a static scan as a route that
        // does not exist, which is the shape of the 404-button bug that guard was written for.
        const url = candidateId
          ? `/api/recruitment/whatsapp-templates?candidateId=${encodeURIComponent(candidateId)}`
          : employeeHrId
            ? `/api/recruitment/whatsapp-templates?employeeHrId=${encodeURIComponent(employeeHrId)}`
            : "/api/recruitment/whatsapp-templates";
        const data = await getJson(url);
        if (cancelled) return;
        const list = (data.templates ?? []) as Template[];
        const context = (data.candidate ?? null) as CandidateContext | null;
        const staff = (data.employee ?? null) as EmployeeContext | null;
        setTemplates(list);
        setCandidate(context);
        setEmployee(staff);
        setManualAutoValues((data.manualAutoValues ?? {}) as Record<string, string>);
        setToNumber(context?.dialNumber ?? staff?.dialNumber ?? "");
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
  }, [candidateId, employeeHrId]);

  const selected = useMemo(() => templates.find((t) => t.id === selectedId) ?? null, [templates, selectedId]);

  // The auto values are the starting point for every field; whatever the recruiter has typed sits on
  // top. Recomputed rather than copied into state so switching template never strands a stale value.
  const effectiveValues = useMemo(
    () => ({ ...(candidate?.autoValues ?? employee?.autoValues ?? manualAutoValues), ...values }),
    [candidate, employee, manualAutoValues, values],
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
   * 🔴 NEVER PASS `noopener` HERE. `window.open` returns **null** whenever the feature list contains
   * noopener — by specification, not as a quirk — while still opening the tab. That combination is
   * the worst of both: the tab exists, the handle to navigate it does not, so the code below takes
   * the "popup was blocked" branch and the tab is left sitting on about:blank forever. Shipped that
   * way on 2026-09-08 and reported within the hour: "when i press send i was redirected to
   * about:blank". The opener reference is the price of being able to navigate the tab at all, and
   * the destination is wa.me, so it is a price worth paying.
   *
   * If a blocker genuinely refuses, `win` is null and the URL is offered as a link instead, rather
   * than the click appearing to fail.
   */
  const onSend = useCallback(async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    setBlockedUrl(null);

    const win = typeof window !== "undefined" ? window.open("", "_blank") : null;
    // Say something in the new tab straight away. Rendering the message server-side takes a moment,
    // and a tab that sits empty in the meantime is indistinguishable from one that is broken — which
    // is exactly how the noopener bug above was experienced.
    if (win) {
      try {
        win.document.write(
          '<!doctype html><title>Preparing your WhatsApp message…</title>' +
            '<body style="font:14px system-ui;padding:24px;color:#334155">Preparing your WhatsApp message…</body>',
        );
        win.document.close();
      } catch {
        // A browser that refuses the write still navigates fine — the holding text is a courtesy.
      }
    }
    try {
      const data = await postJson("/api/recruitment/whatsapp-templates/send", {
        candidateId: candidateId ?? null,
        employeeHrId: employeeHrId ?? null,
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
      const reason = sendError instanceof Error ? sendError.message : "Could not prepare the message.";
      // Close the holding tab, and if the browser refuses to close it, leave the reason IN it rather
      // than abandoning a blank tab the user has to work out for themselves.
      try {
        win?.close();
        if (win && !win.closed) {
          win.document.body.textContent = reason;
        }
      } catch {
        // Nothing further to do — the same reason is shown in the dialog below.
      }
      setError(reason);
    } finally {
      setBusy(false);
    }
  }, [selected, busy, candidateId, employeeHrId, toNumber, effectiveValues, onClose]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const who = candidate?.fullName ?? employee?.fullName ?? candidateName ?? employeeName ?? "a WhatsApp number";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/60 p-2 sm:p-6">
      <div
        aria-label={`Send a WhatsApp message to ${who}`}
        aria-modal="true"
        className={`w-full max-w-3xl border border-slate-300 bg-white ${adminPanelDepthClassName}`}
        ref={dialogRef}
        role="dialog"
      >
        <div
          className={cn(
            "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3 text-white sm:px-5",
            adminPanelHeaderClassName,
          )}
        >
          <div className="flex min-w-0 grow basis-56 items-start gap-2.5">
            <MessageCircle aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none text-orange-300" />
            <div className="min-w-0">
              <h2 className="text-sm font-black uppercase tracking-[0.12em] text-white">WhatsApp message</h2>
              <p className="mt-0.5 break-words text-xs text-slate-300" dir="auto">
                To {who}
              </p>
            </div>
          </div>
          <button
            className="inline-flex items-center gap-1 border border-white/25 bg-white/10 px-2.5 py-1.5 text-xs font-bold text-white transition hover:bg-white/20"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
            Close
          </button>
        </div>

        <div className="space-y-5 px-4 py-4 sm:px-5">
          {loading ? (
            <p className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600" role="status">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-orange-500" />
              Loading your templates…
            </p>
          ) : null}

          {!loading && templates.length === 0 ? (
            <RecruitmentEmptyState
              icon={<LayoutTemplate aria-hidden="true" className="h-5 w-5" />}
              message="Add one on the WhatsApp Templates screen, then come back here."
              title="No templates yet"
            />
          ) : null}

          {!loading && templates.length > 0 ? (
            <>
              <div>
                <span className={phxLabelClassName}>Template</span>
                {/* Wraps rather than scrolls — the fits-the-screen rule. No min-width floor anywhere.
                    One recessed tray of square segments, the chosen one lifted onto white with the
                    module's orange underline — the same object as the module's tab bar. */}
                <div
                  className={`flex flex-wrap gap-1 border border-slate-200 bg-slate-100/80 p-1 ${adminRecessedDepthClassName}`}
                  role="group"
                >
                  {templates.map((template) => (
                    <button
                      aria-pressed={template.id === selectedId}
                      className={cn(
                        "border-b-2 px-3 py-1.5 text-left text-xs font-bold transition-colors",
                        template.id === selectedId
                          ? `border-b-orange-500 bg-white text-slate-950 ${adminChipDepthClassName}`
                          : "border-b-transparent text-slate-600 hover:bg-white/70 hover:text-slate-900",
                      )}
                      key={template.id}
                      onClick={() => {
                        setSelectedId(template.id);
                        setBlockedUrl(null);
                      }}
                      type="button"
                    >
                      <span className="break-words" dir="auto">
                        {template.name}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className={cn(phxLabelClassName, "flex items-center gap-1.5")} htmlFor="wa-number">
                  <Smartphone aria-hidden="true" className="h-3.5 w-3.5 text-orange-500" />
                  WhatsApp number
                </label>
                <input
                  className={phxFieldClassName}
                  id="wa-number"
                  inputMode="tel"
                  onChange={(event) => setToNumber(event.target.value)}
                  placeholder="01012345678, or +44… for a number outside Egypt"
                  value={toNumber}
                />
                <p className={phxHintClassName}>
                  {candidate?.numberSource
                    ? `From this candidate's ${candidate.numberSource === "whatsapp" ? "WhatsApp" : "phone"} field. Change it here if it is wrong.`
                    : employee?.numberSource
                      ? "From this employee's mobile number. Change it here if it is wrong."
                      : candidateId
                        ? "Nothing usable on file for this candidate — type the number."
                        : employeeHrId
                          ? "No mobile number on file for this employee — type the number."
                          : "Type any number. Nothing needs to exist in the system."}
                </p>
              </div>

              {fields.length > 0 ? (
                <div className="grid grid-cols-1 gap-4 border-t border-slate-200 pt-4 sm:grid-cols-2">
                  {fields.map((key) => (
                    <div className={cn("min-w-0", MULTILINE_KEYS.has(key) && "sm:col-span-2")} key={key}>
                      <label className={phxLabelClassName} htmlFor={`wa-field-${key}`}>
                        {labelFor(key)}
                      </label>
                      {MULTILINE_KEYS.has(key) ? (
                        <textarea
                          className={phxTextareaClassName}
                          dir="auto"
                          id={`wa-field-${key}`}
                          onChange={(event) => setValue(key, event.target.value)}
                          rows={3}
                          value={effectiveValues[key] ?? ""}
                        />
                      ) : (
                        <input
                          className={phxFieldClassName}
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
                <span className={cn(phxLabelClassName, "flex items-center gap-1.5")}>
                  <Eye aria-hidden="true" className="h-3.5 w-3.5 text-orange-500" />
                  Preview
                </span>
                {/* The message as the person will see it: a bubble on the chat's own pale ground. */}
                <div className={`border border-slate-200 bg-slate-50 p-3 sm:p-4 ${adminRecessedDepthClassName}`}>
                  <MessagePreview text={preview} />
                </div>
              </div>
            </>
          ) : null}

          {error ? (
            <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800" role="alert">
              {error}
            </p>
          ) : null}

          {blockedUrl ? (
            <p className="flex items-start gap-2 border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none text-amber-600" />
              <span className="min-w-0 break-words">
                Your browser blocked the pop-up.{" "}
                <a className="font-bold underline" href={blockedUrl} rel="noopener noreferrer" target="_blank">
                  Open WhatsApp
                </a>
              </span>
            </p>
          ) : null}
        </div>

        <div className={`flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3 sm:px-5 ${adminRecessedDepthClassName}`}>
          <p className="min-w-0 grow basis-56 text-xs text-slate-600">
            Opens WhatsApp with the message written. You press send there.
          </p>
          <button
            className={cn(
              phxWhatsAppSendButtonClassName,
              "disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300",
            )}
            disabled={busy || !selected || missing.length > 0 || !toNumber.trim()}
            onClick={onSend}
            type="button"
          >
            {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <MessageCircle aria-hidden="true" className="h-4 w-4" />}
            {busy ? "Preparing…" : "Open in WhatsApp"}
          </button>
        </div>
        {missing.length > 0 ? (
          <p className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-900 sm:px-5">
            Still to fill in: {missing.map((key) => labelFor(key)).join(", ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
