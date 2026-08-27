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

import { Eye, FileDown, Loader2, Mail, Plus, Save, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

type Draft = Omit<OfferFields, "costOfLiving" | "totalMonthly"> & {
  costOfLiving: string;
  templateId: string;
  totalMonthly: string;
};

function blankDraft(templates: OfferTemplate[]): Draft {
  const today = new Date();
  const iso = (date: Date) =>
    date.toLocaleDateString("en-GB", { day: "2-digit", month: "long", timeZone: "Africa/Cairo", year: "numeric" });
  const validUntil = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

  return {
    candidateEmail: "",
    candidateName: "",
    contractTerm: "",
    costOfLiving: "",
    dateOfIssue: iso(today),
    reference: "",
    reportsTo: "",
    salutationName: "",
    startDate: "",
    templateId: defaultOfferTemplateId(templates),
    territory: "",
    title: "",
    totalMonthly: "",
    validUntil: iso(validUntil),
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
      dateOfIssue: draft.dateOfIssue.trim(),
      reference: draft.reference.trim(),
      reportsTo: draft.reportsTo.trim(),
      salutationName: draft.salutationName.trim() || draft.candidateName.trim(),
      startDate: draft.startDate.trim(),
      territory: draft.territory.trim(),
      title: draft.title.trim(),
      totalMonthly: total,
      validUntil: draft.validUntil.trim(),
    }),
    [costOfLiving, draft, total],
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
      onOffers([offer, ...offers.filter((existing) => existing.id !== offer.id)]);
      onReport(`Draft saved for ${offer.candidateName}.`, "success");
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
    <div className="rounded-2xl border border-[#D8E0EA] bg-white px-4 py-3 shadow-sm" key={label}>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">{label}</p>
      <p className="mt-1 whitespace-nowrap text-lg font-black tabular-nums text-slate-900">EGP {offerMoney(value)}</p>
      {note ? <p className="mt-0.5 whitespace-nowrap text-[11px] text-[#94A3B8]">{note}</p> : null}
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
    </div>
  );

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
          {text("salutationName", "How the letter addresses them", "Dr SAMAA SHALABY", "Blank uses the candidate name.")}
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
          {text("startDate", "Start date", "1 September 2026")}
          {text("contractTerm", "Contract term", "One year, renewable")}
          {text("reference", "Reference", "SP-HR-DSM-2026-019")}
          {text("dateOfIssue", "Date of issue")}
          {text("validUntil", "Offer valid until")}

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
          <p className="mb-3 text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
            Derived compensation
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {money("Basic salary", pay.basic.monthly, `${offerMoney(pay.basic.annual)} a year`)}
            {money("Transportation", pay.transport.monthly, `${offerMoney(pay.transport.annual)} a year`)}
            {money("Cost of living", pay.costOfLiving.monthly, `${offerMoney(pay.costOfLiving.annual)} a year`)}
            {money("Total package", pay.total.monthly, `${offerMoney(pay.total.annual)} a year`)}
          </div>
          <p className="mt-3 text-[11px] leading-4 text-[#94A3B8]">
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
              className="mx-auto block w-full max-w-[860px] rounded-xl border border-[#D8E0EA] bg-white shadow-lg"
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
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-slate-200/80 bg-slate-50/60 text-left">
                {["Candidate", "Title", "Package", "Status", "Sent", ""].map((heading) => (
                  <th
                    className="whitespace-nowrap px-5 py-3 text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]"
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
                  <td className="whitespace-nowrap px-5 py-3">
                    <span className="font-bold text-slate-900">{offer.candidateName}</span>
                    <span className="ml-2 text-xs text-slate-500">{offer.candidateEmail}</span>
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-slate-600">{offer.title}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-slate-900">
                    EGP {offerMoney(offer.totalMonthly)}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3">
                    <Badge className="capitalize" variant={STATUS_VARIANT[offer.status]}>
                      {offer.status}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-slate-600">{offerWhen(offer.sentAt)}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-right">
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
            <div className="rounded-2xl border border-[#D8E0EA] bg-white p-4 shadow-sm" key={offer.id}>
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
        <p className="inline-flex items-center gap-2 text-xs font-semibold text-[#94A3B8]">
          <Mail className="h-3.5 w-3.5" /> You can read offers but not create or send them.
        </p>
      ) : null}
      {templates.length === 0 ? (
        <p className="inline-flex items-center gap-2 text-xs font-semibold text-[#94A3B8]">
          <Plus className="h-3.5 w-3.5" /> No template yet — open the Letter designer tab to create one.
        </p>
      ) : null}
    </div>
  );
}
