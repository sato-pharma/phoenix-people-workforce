"use client";

// Compose and send an offer.
//
// THE MAGIC FORMULA, ON SCREEN. HR types ONE number — the total monthly package — and the letter's
// entire compensation table falls out of it: cost of living comes from the chosen job title, basic
// is 70% of what remains, and transport is the remainder. The breakdown is shown live beside the
// inputs, before anything is saved, because a salary is the one field on this form nobody should
// discover was wrong after it reached a candidate.
//
// The preview is rendered by the SERVER, from the same renderer that produces the real PDF. A
// second, client-side implementation of the layout would drift, and the day it did the preview
// would start lying about a document somebody signs.

import { Eye, FileDown, Loader2, Mail, Plus, RefreshCw, Save, Send, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { addDays, firstOfNextMonth, todayInCairo, toLetterDate } from "@/lib/offers/dates";
import { offerDraftWarnings, offerWarningsFor, type OfferDraftWarning } from "@/lib/offers/draft-checks";
import { deriveOfferPay } from "@/lib/offers/pay";
import {
  offerHintClassName,
  offerInputClassName,
  offerLabelClassName,
  offerMoney,
  offerWhen,
  type OfferSenderInfo,
} from "@/components/offers/offer-ui";
import {
  defaultOfferTemplateId,
  findOfferJobTitle,
  offerTemplateIdForTitle,
} from "@/lib/offers/template-choice";
import { cn } from "@/lib/utils";
import type { OfferFields, OfferJobTitle, OfferRecord, OfferStatus, OfferTemplate } from "@/lib/offers/types";

/**
 * The three date fields hold ISO `yyyy-mm-dd` here, not the English form the letter carries.
 *
 * That is the whole trick behind the date pickers: `<input type="date">` speaks only ISO, and the
 * letter speaks only English, so the draft holds ISO and `fields` below converts on the way out.
 * Nothing that is stored, rendered or sent changes shape — the conversion happens entirely inside
 * this component, one line before the values leave it.
 */
type Draft = Omit<OfferFields, "costOfLiving" | "totalMonthly"> & {
  costOfLiving: string;
  templateId: string;
  totalMonthly: string;
};

/** How long an offer stays open by default. A week is what the letters have used. */
const DEFAULT_VALIDITY_DAYS = 7;

function blankDraft(templates: OfferTemplate[]): Draft {
  const today = todayInCairo();

  return {
    candidateEmail: "",
    candidateName: "",
    contractTerm: "",
    costOfLiving: "",
    dateOfIssue: today,
    reference: "",
    reportsTo: "",
    salutationName: "",
    // Blank rather than a guess. A start date is a real negotiated fact, and a plausible default
    // is the kind of value that gets sent without being read.
    startDate: "",
    templateId: defaultOfferTemplateId(templates),
    territory: "",
    title: "",
    totalMonthly: "",
    validUntil: addDays(today, DEFAULT_VALIDITY_DAYS),
  };
}

/**
 * Status → one of Badge's four semantic variants.
 *
 * "sent" is `warning` rather than a neutral grey on purpose: a sent offer is not a finished thing,
 * it is one waiting on somebody else, and it should read differently from a draft nobody has acted
 * on. Draft and withdrawn are both "not in play" and share the neutral.
 */
const STATUS_VARIANT: Record<OfferStatus, "danger" | "neutral" | "success" | "warning"> = {
  accepted: "success",
  declined: "danger",
  draft: "neutral",
  sent: "warning",
  withdrawn: "neutral",
};

export function OfferComposer({
  canManage,
  jobTitles,
  offers,
  onOffers,
  onReport,
  sender,
  templates,
}: {
  canManage: boolean;
  jobTitles: OfferJobTitle[];
  offers: OfferRecord[];
  onOffers: (offers: OfferRecord[]) => void;
  onReport: (message: string | null, kind: "error" | "success") => void;
  sender: OfferSenderInfo;
  templates: OfferTemplate[];
}) {
  const [draft, setDraft] = useState<Draft>(() => blankDraft(templates));
  const [savedId, setSavedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Whether the reference in the box was typed by a person.
   *
   * A generated reference is a convenience and may be replaced freely as the title changes. One
   * somebody typed is a decision — continuing a run from a paper file, reissuing under an agreed
   * number — and must survive every later edit to the form. This flag is the difference, and it is
   * the reason correcting a typo in the job title cannot silently renumber a letter.
   *
   * HELD TWICE, and both are needed. The state is what the hint under the box reads: a ref read
   * during render does not re-render when it changes, so the hint would go on saying "allocated
   * automatically" after somebody had typed their own. The ref is what the fetch below re-checks
   * AFTER its await — a state value captured in that closure is the value from before the request
   * started, which is exactly the moment the person began typing.
   */
  const [referenceTyped, setReferenceTyped] = useState(false);
  const referenceTypedRef = useRef(false);
  const referenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Keeps the two in step. Nothing may set one without the other. */
  const markReferenceTyped = useCallback((typed: boolean) => {
    referenceTypedRef.current = typed;
    setReferenceTyped(typed);
  }, []);

  const total = Number(draft.totalMonthly || 0);
  const costOfLiving = Number(draft.costOfLiving || 0);
  const pay = useMemo(
    () => deriveOfferPay({ costOfLiving, totalMonthly: total }),
    [costOfLiving, total],
  );

  const fields: OfferFields = useMemo(
    () => ({
      candidateEmail: draft.candidateEmail.trim(),
      candidateName: draft.candidateName.trim(),
      contractTerm: draft.contractTerm.trim(),
      costOfLiving,
      // ISO in the form, English on the letter. `toLetterDate` answers "" for anything it cannot
      // read, which leaves the placeholder standing in braces rather than printing a wrong date.
      dateOfIssue: toLetterDate(draft.dateOfIssue),
      reference: draft.reference.trim(),
      reportsTo: draft.reportsTo.trim(),
      salutationName: draft.salutationName.trim() || draft.candidateName.trim(),
      startDate: toLetterDate(draft.startDate),
      territory: draft.territory.trim(),
      title: draft.title.trim(),
      totalMonthly: total,
      validUntil: toLetterDate(draft.validUntil),
    }),
    [costOfLiving, draft, total],
  );

  const warnings: OfferDraftWarning[] = useMemo(
    () =>
      offerDraftWarnings({
        candidateEmail: draft.candidateEmail,
        dateOfIssue: draft.dateOfIssue,
        // The offer being edited is not a duplicate of itself.
        existingEmails: offers.filter((offer) => offer.id !== savedId).map((offer) => offer.candidateEmail),
        startDate: draft.startDate,
        validUntil: draft.validUntil,
      }),
    [draft.candidateEmail, draft.dateOfIssue, draft.startDate, draft.validUntil, offers, savedId],
  );

  const template = templates.find((t) => t.id === draft.templateId) ?? templates[0] ?? null;

  const refreshPreview = useCallback(async () => {
    if (!template) return;
    try {
      const response = await fetch("/api/offers/preview", {
        body: JSON.stringify({
          blocks: template.blocks,
          fields,
          fontFamily: template.fontFamily,
          fontSizePt: template.fontSizePt,
          theme: template.theme,
          variant: template.variant,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { html?: string; message?: string };
      if (!response.ok) throw new Error(payload.message || "The preview could not be rendered.");
      setPreviewHtml(payload.html ?? "");
    } catch (error) {
      onReport(error instanceof Error ? error.message : "The preview could not be rendered.", "error");
    }
  }, [fields, onReport, template]);

  // Debounced: typing a salary character by character must not fire a render per keystroke.
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => void refreshPreview(), 450);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [refreshPreview]);

  /**
   * Ask the server what reference this title's next offer would carry, and show it.
   *
   * PROPOSED only — the real one is allocated again inside the insert, so two people composing at
   * once cannot both take the same number. What this buys is that HR sees the reference, and the
   * live preview shows it on the letter, instead of `{{reference}}` sitting in braces until save.
   *
   * Silent on failure. A reference that could not be proposed leaves the box empty, and an empty
   * box is exactly what makes the server generate one — so the offer still gets its number. An
   * error toast here would be reporting a problem that has already fixed itself.
   */
  const proposeReference = useCallback(
    async (title: string, dateOfIssue: string) => {
      if (!canManage || referenceTypedRef.current || !title.trim()) return;
      const year = Number(dateOfIssue.slice(0, 4)) || new Date().getUTCFullYear();
      try {
        const response = await fetch(
          `/api/offers/next-reference?title=${encodeURIComponent(title)}&year=${year}`,
        );
        const payload = (await response.json().catch(() => ({}))) as { reference?: string };
        if (!response.ok || !payload.reference) return;
        // Re-checked after the await: the person may have started typing their own while this was
        // in flight, and overwriting it then is precisely what the flag exists to prevent. The REF
        // and not the state, because the state captured in this closure predates the request.
        if (referenceTypedRef.current) return;
        setDraft((current) => ({ ...current, reference: payload.reference ?? "" }));
      } catch {
        // Left blank on purpose — see above.
      }
    },
    [canManage],
  );

  // Debounced, because the title box is a free-text field with a datalist: typing "District Sales
  // Manager" letter by letter would otherwise ask the server twenty-one times.
  useEffect(() => {
    if (referenceTimer.current) clearTimeout(referenceTimer.current);
    referenceTimer.current = setTimeout(() => void proposeReference(draft.title, draft.dateOfIssue), 500);
    return () => {
      if (referenceTimer.current) clearTimeout(referenceTimer.current);
    };
  }, [draft.dateOfIssue, draft.title, proposeReference]);

  /**
   * Choosing a title fills its cost of living, its reporting line, its contract term and — where
   * the title has one — the letter design its offers are written on.
   *
   * Each of these is a STARTING POINT, never a lock: every field stays editable afterwards, and a
   * title with no answer for a field leaves what is already there alone. That last part is why an
   * unbound title does not reset the design back to the default — somebody who deliberately chose
   * a design and then corrected a typo in the title should not watch that choice revert.
   */
  function chooseTitle(title: string) {
    const match = findOfferJobTitle(title, jobTitles);
    const bound = offerTemplateIdForTitle(title, jobTitles, templates);
    setDraft((current) => ({
      ...current,
      contractTerm: match?.contractTerm ?? current.contractTerm,
      // Only when the title is known. A blank rather than a zero, because a zero would look like a
      // valid answer and would silently inflate basic and transport on a signed letter.
      costOfLiving: match ? String(match.costOfLiving) : current.costOfLiving,
      reportsTo: match?.reportsTo ?? current.reportsTo,
      templateId: bound ?? current.templateId,
      title,
    }));
  }

  async function call(url: string, method: string, body?: unknown) {
    const response = await fetch(url, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method,
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
      message?: string;
      success?: boolean;
    };
    if (!response.ok || payload.success === false) throw new Error(payload.message || "That did not work.");
    return payload;
  }

  async function saveDraft(): Promise<string | null> {
    if (!fields.candidateName) {
      onReport("The candidate's name is required.", "error");
      return null;
    }
    if (!fields.title) {
      onReport("Choose a job title.", "error");
      return null;
    }
    if (!(total > 0)) {
      onReport("Type the total monthly package.", "error");
      return null;
    }

    setBusy("save");
    try {
      const body = { ...fields, templateId: draft.templateId || null };
      const payload = savedId
        ? await call(`/api/offers/${savedId}`, "PATCH", body)
        : await call("/api/offers", "POST", body);
      const offer = payload.offer as OfferRecord;
      setSavedId(offer.id);
      // The stored reference wins over the proposed one. The server allocates again at insert, so
      // if somebody else took the number in between, this is where the screen learns the real one
      // rather than continuing to show a number that belongs to another letter.
      if (offer.reference && offer.reference !== draft.reference) {
        setDraft((current) => ({ ...current, reference: offer.reference }));
      }
      onOffers([offer, ...offers.filter((existing) => existing.id !== offer.id)]);
      onReport(`Draft saved for ${offer.candidateName}. Reference ${offer.reference || "not set"}.`, "success");
      return offer.id;
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not save this offer.", "error");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function sendOffer() {
    if (!fields.candidateEmail) {
      onReport("An email address is required before the offer can be sent.", "error");
      return;
    }
    const id = savedId ?? (await saveDraft());
    if (!id) return;

    setBusy("send");
    try {
      const payload = (await call(`/api/offers/${id}/send`, "POST")) as {
        attachmentWarning?: string | null;
        from?: string;
        offer?: OfferRecord;
        recipient?: string;
        skipped?: boolean;
        skippedReason?: string | null;
      };

      if (payload.offer) {
        onOffers([payload.offer, ...offers.filter((existing) => existing.id !== payload.offer!.id)]);
      }

      if (payload.skipped) {
        // Never reported as sent. A suppressed send is the one case where a candidate never
        // received their offer, and it must not be hidden behind a green tick.
        onReport(
          `The offer was NOT delivered: ${payload.skippedReason ?? "the send was suppressed"}. Nothing was marked as sent.`,
          "error",
        );
        return;
      }

      setSavedId(null);
      // A fresh form gets a fresh generated reference. Without this reset, a manually typed
      // reference from the offer just sent would suppress generation for every offer after it.
      markReferenceTyped(false);
      setDraft(blankDraft(templates));
      onReport(
        `Offer sent to ${payload.recipient} from ${payload.from}.` +
          (payload.attachmentWarning ? ` ${payload.attachmentWarning}` : " The signed-ready PDF is attached."),
        "success",
      );
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not send this offer.", "error");
    } finally {
      setBusy(null);
    }
  }

  const money = (label: string, value: number, note?: string) => (
    <div className="rounded-2xl border border-phx-line bg-white px-4 py-3 shadow-sm" key={label}>
      <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">{label}</p>
      <p className="mt-1 whitespace-nowrap text-lg font-black tabular-nums text-slate-900">EGP {offerMoney(value)}</p>
      {note ? <p className="mt-0.5 whitespace-nowrap text-phx-xs text-phx-ink-faint">{note}</p> : null}
    </div>
  );

  /** Amber, and never an ellipsis — a note about a letter has to be readable in full. */
  const noteList = (messages: string[]) =>
    messages.length === 0 ? null : (
      <div className="mt-1.5 flex flex-col gap-1">
        {messages.map((message) => (
          <p className="flex items-start gap-1.5 text-phx-xs font-semibold leading-4 text-[#B45309]" key={message}>
            <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
            <span>{message}</span>
          </p>
        ))}
      </div>
    );

  const text = (key: keyof Draft, label: string, placeholder?: string, hint?: string) => (
    <div key={key}>
      <label className={offerLabelClassName} htmlFor={`offer-${key}`}>{label}</label>
      <input
        className={offerInputClassName}
        disabled={!canManage}
        id={`offer-${key}`}
        onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
        placeholder={placeholder}
        value={String(draft[key] ?? "")}
      />
      {hint ? <p className={offerHintClassName}>{hint}</p> : null}
      {noteList(offerWarningsFor(warnings, key as OfferDraftWarning["field"]))}
    </div>
  );

  /** A one-click date shortcut. Sets the field and nothing else. */
  const chip = (key: "dateOfIssue" | "startDate" | "validUntil", label: string, value: string) => (
    <button
      className="rounded-lg border border-phx-line bg-white px-2 py-1 text-phx-xs font-bold whitespace-nowrap text-phx-ink-2 shadow-sm transition hover:border-phx-accent-line hover:text-[#B45309] disabled:cursor-not-allowed disabled:opacity-50"
      disabled={!canManage || !value}
      key={label}
      onClick={() => setDraft((current) => ({ ...current, [key]: value }))}
      type="button"
    >
      {label}
    </button>
  );

  /**
   * A date field: a real picker, the shortcuts that field actually needs, and — underneath — the
   * exact words that will appear on the letter.
   *
   * That last line is the part worth keeping. The form holds `2026-09-01` and the letter says
   * `01 September 2026`, and showing both means nobody has to trust that the conversion is right.
   */
  const dateField = (
    key: "dateOfIssue" | "startDate" | "validUntil",
    label: string,
    chips: { label: string; value: string }[],
  ) => {
    const printed = toLetterDate(String(draft[key] ?? ""));
    return (
      <div key={key}>
        <label className={offerLabelClassName} htmlFor={`offer-${key}`}>{label}</label>
        <input
          className={offerInputClassName}
          disabled={!canManage}
          id={`offer-${key}`}
          onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
          type="date"
          value={String(draft[key] ?? "")}
        />
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {chips.map((entry) => chip(key, entry.label, entry.value))}
        </div>
        <p className={offerHintClassName}>
          {printed ? `Prints on the letter as ${printed}` : "Not set — the letter will show this field empty."}
        </p>
        {noteList(offerWarningsFor(warnings, key as OfferDraftWarning["field"]))}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <AdminTableShell
        action={
          <div className="flex flex-wrap gap-2">
            <Button disabled={!canManage || busy !== null} onClick={() => void saveDraft()} size="lg" type="button" variant="secondary">
              {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save draft
            </Button>
            <Button disabled={!canManage || busy !== null} onClick={() => void sendOffer()} size="lg" type="button">
              {busy === "send" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send offer
            </Button>
          </div>
        }
        description={`The letter goes out as ${sender.from}. Replies land at ${sender.replyTo}.`}
        title="New offer"
      >
        <div className="grid gap-4 px-5 py-5 sm:px-6 md:grid-cols-2 xl:grid-cols-3">
          {text("candidateName", "Candidate name", "SAMAA SHALABY")}
          {text(
            "salutationName",
            "How the letter addresses them",
            "Dr SAMAA SHALABY",
            // Shows the resolved value rather than the rule, so nobody has to work out what a blank
            // box will produce. This is the salutation that reaches the candidate.
            fields.salutationName
              ? `The letter will open "Dear ${fields.salutationName},"`
              : "Blank uses the candidate name.",
          )}
          {text("candidateEmail", "Email address", "name@example.com", "The offer and its PDF go here.")}

          <div>
            <label className={offerLabelClassName} htmlFor="offer-title">Job title</label>
            <input
              className={offerInputClassName}
              disabled={!canManage}
              id="offer-title"
              list="offer-title-options"
              onChange={(event) => chooseTitle(event.target.value)}
              placeholder="District Sales Manager"
              value={draft.title}
            />
            <datalist id="offer-title-options">
              {jobTitles.map((entry) => (
                <option key={entry.id} value={entry.title} />
              ))}
            </datalist>
            <p className={offerHintClassName}>
              {findOfferJobTitle(draft.title, jobTitles)
                ? offerTemplateIdForTitle(draft.title, jobTitles, templates)
                  ? "Cost of living, reporting line, contract term and letter design filled from the catalogue."
                  : "Cost of living, reporting line and contract term filled from the catalogue."
                : "Not in the catalogue — type the cost of living yourself, or add the title on the Job titles tab."}
            </p>
          </div>

          {text("territory", "Territory", "Delta 3")}
          {text("reportsTo", "Reports to", "National Sales Manager")}
          {text("contractTerm", "Contract term", "One year, renewable")}

          <div>
            <label className={offerLabelClassName} htmlFor="offer-reference">Reference</label>
            <div className="flex gap-2">
              <input
                className={cn(offerInputClassName, "font-mono tabular-nums")}
                disabled={!canManage}
                id="offer-reference"
                onChange={(event) => {
                  markReferenceTyped(true);
                  setDraft((current) => ({ ...current, reference: event.target.value }));
                }}
                placeholder="SP-HR-DSM-2026-019"
                value={draft.reference}
              />
              <Button
                aria-label="Generate a new reference"
                disabled={!canManage || !draft.title.trim()}
                onClick={() => {
                  markReferenceTyped(false);
                  setDraft((current) => ({ ...current, reference: "" }));
                  void proposeReference(draft.title, draft.dateOfIssue);
                }}
                size="sm"
                title="Generate a new reference from the job title and the year"
                type="button"
                variant="secondary"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className={offerHintClassName}>
              {referenceTyped
                ? "Typed by hand — this exact number will be used and kept."
                : draft.title.trim()
                  ? "Allocated automatically from the job title and the year. Type over it to use your own."
                  : "Choose a job title and a number is allocated automatically."}
            </p>
          </div>

          {dateField("dateOfIssue", "Date of issue", [{ label: "Today", value: todayInCairo() }])}

          {dateField("validUntil", "Offer valid until", [
            { label: "7 days", value: addDays(draft.dateOfIssue, 7) },
            { label: "14 days", value: addDays(draft.dateOfIssue, 14) },
            { label: "30 days", value: addDays(draft.dateOfIssue, 30) },
          ])}

          {dateField("startDate", "Start date", [
            { label: "1st of next month", value: firstOfNextMonth(draft.dateOfIssue) },
            { label: "In 2 weeks", value: addDays(draft.dateOfIssue, 14) },
            { label: "In 1 month", value: addDays(draft.dateOfIssue, 30) },
          ])}

          <div>
            <label className={offerLabelClassName} htmlFor="offer-total">Total monthly package (EGP)</label>
            <input
              className={cn(offerInputClassName, "tabular-nums text-lg font-black")}
              disabled={!canManage}
              id="offer-total"
              inputMode="numeric"
              onChange={(event) => setDraft((current) => ({ ...current, totalMonthly: event.target.value }))}
              placeholder="30000"
              value={draft.totalMonthly}
            />
            <p className={offerHintClassName}>Type this one number. Everything below is derived from it.</p>
          </div>

          <div>
            <label className={offerLabelClassName} htmlFor="offer-col">Cost of living (EGP)</label>
            <input
              className={cn(offerInputClassName, "tabular-nums")}
              disabled={!canManage}
              id="offer-col"
              inputMode="numeric"
              onChange={(event) => setDraft((current) => ({ ...current, costOfLiving: event.target.value }))}
              placeholder="3500"
              value={draft.costOfLiving}
            />
            <p className={offerHintClassName}>Flat per title. Override it here only for this one offer.</p>
          </div>

          <div>
            <label className={offerLabelClassName} htmlFor="offer-template">Letter template</label>
            <select
              className={offerInputClassName}
              disabled={!canManage}
              id="offer-template"
              onChange={(event) => setDraft((current) => ({ ...current, templateId: event.target.value }))}
              value={draft.templateId}
            >
              {templates.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                  {entry.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
            <p className={offerHintClassName}>
              {draft.templateId && draft.templateId === offerTemplateIdForTitle(draft.title, jobTitles, templates)
                ? `Chosen for you — this is the design set for ${findOfferJobTitle(draft.title, jobTitles)?.title ?? "this title"}. Change it here for this one offer.`
                : "Which design this letter is drawn in. Set one per job title on the Job titles tab."}
            </p>
          </div>
        </div>

        <div className="border-t border-slate-200/80 bg-slate-50/50 px-5 py-5 sm:px-6">
          <p className="mb-3 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
            Derived compensation
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {money("Basic salary", pay.basic.monthly, `${offerMoney(pay.basic.annual)} a year`)}
            {money("Transportation", pay.transport.monthly, `${offerMoney(pay.transport.annual)} a year`)}
            {money("Cost of living", pay.costOfLiving.monthly, `${offerMoney(pay.costOfLiving.annual)} a year`)}
            {money("Total package", pay.total.monthly, `${offerMoney(pay.total.annual)} a year`)}
          </div>
          <p className="mt-3 text-phx-xs leading-4 text-phx-ink-faint">
            Basic is 70% of the package after cost of living; transportation is exactly what remains, so the three
            lines always add back to the total to the pound.
          </p>
        </div>
      </AdminTableShell>

      <AdminTableShell
        action={
          <Button onClick={() => void refreshPreview()} size="sm" type="button" variant="secondary">
            <Eye className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
        description="Rendered by the same code that produces the PDF and the email, so what you see here is what the candidate receives."
        title="Letter preview"
      >
        <div className="max-h-[720px] overflow-auto bg-slate-100 p-4">
          {previewHtml ? (
            <iframe
              className="mx-auto block w-full max-w-[860px] rounded-xl border border-phx-line bg-white shadow-lg"
              height={900}
              sandbox=""
              srcDoc={previewHtml}
              title="Offer letter preview"
            />
          ) : (
            <p className="py-10 text-center text-sm text-slate-500">Fill the fields above to see the letter.</p>
          )}
        </div>
      </AdminTableShell>

      <AdminTableShell description="Newest first. A sent offer keeps the exact letter it was sent with." title="Offers">
        {/*
          Desktop: mobile already gets the cards below, so the rule's mobile half was met — the
          desktop half was not. `overflow-x-auto` over a `min-w-[860px]` floor is the shape the
          fits-the-screen golden rule (AGENTS.md §4) names as the bug, not the fix: 860px is wider
          than the content column at 768px or in a 1024px window, so Status, Sent and the PDF
          button sat behind a sideways scroll on a laptop.

          `table-fixed` + `<colgroup>` instead, with the cells wrapping. The candidate's name and
          email were one nowrap line and are now stacked, which is the column merge the rule asks
          for rather than a narrower font.
        */}
        <div className="hidden md:block">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-[26%]" />
              <col className="w-[18%]" />
              <col className="w-[16%]" />
              <col className="w-[13%]" />
              <col className="w-[13%]" />
              <col className="w-[14%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200/80 bg-slate-50/60 text-left">
                {["Candidate", "Title", "Package", "Status", "Sent", ""].map((heading) => (
                  <th
                    className="break-words px-5 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft"
                    key={heading}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {offers.map((offer) => (
                <tr className="border-b border-slate-100 last:border-0" key={offer.id}>
                  <td className="break-words px-5 py-3">
                    <span className="block font-bold text-slate-900">{offer.candidateName}</span>
                    {/* `break-all`: an email address has no space to break at. */}
                    <span className="block break-all text-xs text-slate-500">{offer.candidateEmail}</span>
                  </td>
                  <td className="break-words px-5 py-3 text-slate-600">{offer.title}</td>
                  <td className="break-words px-5 py-3 text-right tabular-nums text-slate-900">
                    EGP {offerMoney(offer.totalMonthly)}
                  </td>
                  <td className="px-5 py-3">
                    <Badge className="capitalize" variant={STATUS_VARIANT[offer.status]}>
                      {offer.status}
                    </Badge>
                  </td>
                  <td className="break-words px-5 py-3 text-slate-600">{offerWhen(offer.sentAt)}</td>
                  <td className="px-5 py-3 text-right">
                    <Button asChild size="sm" type="button" variant="secondary">
                      <a href={`/api/offers/${offer.id}/pdf`} rel="noreferrer" target="_blank">
                        <FileDown className="h-3.5 w-3.5" /> PDF
                      </a>
                    </Button>
                  </td>
                </tr>
              ))}
              {offers.length === 0 ? (
                <tr>
                  <td className="px-5 py-8 text-center text-slate-500" colSpan={6}>
                    No offers yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 px-5 py-5 md:hidden">
          {offers.map((offer) => (
            <div className="rounded-2xl border border-phx-line bg-white p-4 shadow-sm" key={offer.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {/* No `truncate` here on purpose — the owner's standing rule is that text is
                      never cut off with an ellipsis, and a half-shown candidate name on a phone is
                      exactly the failure that rule exists to prevent. A long name wraps instead. */}
                  <p className="break-words text-sm font-black text-slate-900">{offer.candidateName}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{offer.title}</p>
                </div>
                <Badge className="capitalize" variant={STATUS_VARIANT[offer.status]}>
                  {offer.status}
                </Badge>
              </div>
              <p className="mt-2 text-sm font-bold tabular-nums text-slate-900">EGP {offerMoney(offer.totalMonthly)}</p>
              <p className="mt-1 text-xs text-slate-500">{offerWhen(offer.sentAt)}</p>
              <div className="mt-3 flex gap-2">
                <Button asChild size="sm" type="button" variant="secondary">
                  <a href={`/api/offers/${offer.id}/pdf`} rel="noreferrer" target="_blank">
                    <FileDown className="h-3.5 w-3.5" /> PDF
                  </a>
                </Button>
              </div>
            </div>
          ))}
          {offers.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">No offers yet.</p> : null}
        </div>
      </AdminTableShell>

      {!canManage ? (
        <p className="inline-flex items-center gap-2 text-xs font-semibold text-phx-ink-faint">
          <Mail className="h-3.5 w-3.5" /> You can read offers but not create or send them.
        </p>
      ) : null}
      {templates.length === 0 ? (
        <p className="inline-flex items-center gap-2 text-xs font-semibold text-phx-ink-faint">
          <Plus className="h-3.5 w-3.5" /> No template yet — open the Letter designer tab to create one.
        </p>
      ) : null}
    </div>
  );
}
