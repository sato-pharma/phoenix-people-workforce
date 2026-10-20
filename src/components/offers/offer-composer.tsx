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

import {
  CalendarX2,
  Eye,
  FileDown,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Save,
  Send,
  TriangleAlert,
  Undo2,
  UserPlus,
} from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  addDays,
  DEFAULT_OFFER_VALIDITY_DAYS,
  firstOfNextMonth,
  parseLetterDate,
  todayInCairo,
  toLetterDate,
} from "@/lib/offers/dates";
import { OFFER_COPY_MAX, planOfferCopies } from "@/lib/offers/copy-recipients";
import { offerDraftWarnings, offerWarningsFor, type OfferDraftWarning } from "@/lib/offers/draft-checks";
import { deriveOfferPay } from "@/lib/offers/pay";
import {
  offerHintClassName,
  offerInputClassName,
  offerLabelClassName,
  offerMoney,
  offerTextareaClassName,
  offerWhen,
  type OfferSenderInfo,
} from "@/components/offers/offer-ui";
import {
  defaultOfferTemplateId,
  findOfferJobTitle,
  offerTemplateIdForTitle,
} from "@/lib/offers/template-choice";
import { cn } from "@/lib/utils";
import { formatOfferVacancyLabel } from "@/lib/offers/vacancy-label";
import { OFFER_START_DATE_REQUIRED_MESSAGE, offerRequiresSeat } from "@/lib/offers/joining-form";
import type {
  OfferFields,
  OfferJobTitle,
  OfferRecord,
  OfferStatus,
  OfferTemplate,
  OfferVacancyOption,
} from "@/lib/offers/types";

/**
 * An offer the candidate answered through the joining form (2026-10-08): the record is already made,
 * so the row says so instead of offering "Add employee" a second time.
 */
function joinedLabel(offer: OfferRecord): string {
  const when = offer.acceptedAt ? ` · ${offerWhen(offer.acceptedAt)}` : "";
  return `Accepted via joining form — on the Employee Master${when}`;
}

/**
 * The three date fields hold ISO `yyyy-mm-dd` here, not the English form the letter carries.
 *
 * That is the whole trick behind the date pickers: `<input type="date">` speaks only ISO, and the
 * letter speaks only English, so the draft holds ISO and `fields` below converts on the way out.
 * Nothing that is stored, rendered or sent changes shape — the conversion happens entirely inside
 * this component, one line before the values leave it.
 */
type Draft = Omit<OfferFields, "costOfLiving" | "totalMonthly"> & {
  /**
   * Who else gets a copy, as typed — several addresses separated by commas. Held here and sent with
   * the send request, never saved with the DRAFT: they are not part of the letter. The server writes
   * what it actually sent to `offers.cc_recipients` / `bcc_recipients` in the same update that marks
   * the offer sent, which is what the Offers list below reads.
   */
  bcc: string;
  cc: string;
  costOfLiving: string;
  templateId: string;
  totalMonthly: string;
  /**
   * The open seat this letter is written against, as a `<select>` value — `""` for none.
   *
   * A string, where the id is a number, for the same reason the dates are ISO here: a select's
   * value is text, and the one conversion back happens where the draft leaves this component. `""`
   * is a real answer and stays one — an offer may be written before anybody has settled which
   * chair it fills, and the Add Employee form's own picker is where that is then decided.
   */
  vacancyId: string;
};

/** How long an offer stays open by default. A week is what the letters have used. */


function blankDraft(templates: OfferTemplate[]): Draft {
  const today = todayInCairo();

  return {
    bcc: "",
    candidateEmail: "",
    candidateName: "",
    cc: "",
    contractTerm: "",
    costOfLiving: "",
    dateOfIssue: today,
    reference: "",
    reportsTo: "",
    // Blank is a real, meaningful value: it prints the standard paragraph. Prefilled from the job
    // title the moment one is chosen (see `applyTitle`), and editable for this one letter.
    roleSummary: "",
    salutationName: "",
    // Blank rather than a guess. A start date is a real negotiated fact, and a plausible default
    // is the kind of value that gets sent without being read.
    startDate: "",
    templateId: defaultOfferTemplateId(templates),
    territory: "",
    title: "",
    totalMonthly: "",
    vacancyId: "",
    validUntil: addDays(today, DEFAULT_OFFER_VALIDITY_DAYS),
  };
}

/**
 * A saved draft, back in the form (owner, 2026-09-28).
 *
 * Until this, a draft saved and then left — the form cleared, the page reloaded — could not be
 * reached again: its row carried only a PDF button, so it could be neither edited nor sent. Alaa
 * Mohsen's draft sat that way from 17 September. The stored dates are the letter's English form and
 * the form speaks ISO, so they go back through `parseLetterDate`; one that cannot be read is left
 * blank rather than guessed, and the draft checks then say so before anything is sent.
 */
function draftFromOffer(offer: OfferRecord, templates: OfferTemplate[]): Draft {
  return {
    // Copies are typed per send and never saved with a draft (see `Draft`), so an opened draft has none.
    bcc: "",
    candidateEmail: offer.candidateEmail,
    candidateName: offer.candidateName,
    cc: "",
    contractTerm: offer.contractTerm,
    costOfLiving: offer.costOfLiving > 0 ? String(offer.costOfLiving) : "",
    dateOfIssue: parseLetterDate(offer.dateOfIssue) ?? "",
    reference: offer.reference,
    reportsTo: offer.reportsTo,
    roleSummary: offer.roleSummary,
    salutationName: offer.salutationName,
    startDate: parseLetterDate(offer.startDate) ?? "",
    templateId: offer.templateId ?? defaultOfferTemplateId(templates),
    territory: offer.territory,
    title: offer.title,
    totalMonthly: offer.totalMonthly > 0 ? String(offer.totalMonthly) : "",
    vacancyId: offer.vacancyId === null ? "" : String(offer.vacancyId),
    validUntil: parseLetterDate(offer.validUntil) ?? "",
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

/**
 * Who else received an offer, under the candidate's address (owner, 2026-09-28: "show who was
 * copied on each offer in the offers list").
 *
 * ONE rendering for the desktop row and the phone card, so the two can never disagree about who was
 * copied. Nothing at all when nobody was: a "CC: none" line on every row would bury the few that
 * matter. `[overflow-wrap:anywhere]` rather than an ellipsis — the point of the line is reading every
 * address in full, and a long list must wrap rather than push the row sideways.
 */
function OfferCopiedTo({ offer }: { offer: OfferRecord }) {
  const lines = [
    { addresses: offer.ccRecipients, label: "CC" },
    { addresses: offer.bccRecipients, label: "BCC" },
  ].filter((line) => line.addresses.length > 0);
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => (
        <span className="mt-0.5 block text-xs text-slate-500 [overflow-wrap:anywhere]" key={line.label}>
          <span className="font-bold text-phx-ink-soft">{line.label}</span> {line.addresses.join(", ")}
        </span>
      ))}
    </>
  );
}

/**
 * The open seat an offer was written against, under its job title.
 *
 * ONE rendering for the desktop row and the phone card, like `OfferCopiedTo` above, so the two can
 * never disagree about which chair a letter is for.
 *
 * Three states, and the third is the one worth having on screen: a seat that was chosen and is no
 * longer open was filled by somebody else while this letter was out. That is not an error and
 * nothing here can fix it — it is simply the fact that Add Employee will ask for the seat again,
 * said before somebody clicks and wonders why the form came up empty.
 */
function OfferSeat({ offer, vacancies }: { offer: OfferRecord; vacancies: OfferVacancyOption[] }) {
  if (offer.vacancyId === null) return null;
  const vacancy = vacancies.find((option) => option.vacancyId === offer.vacancyId);
  return (
    <span className="mt-0.5 block text-xs text-slate-500 [overflow-wrap:anywhere]">
      <span className="font-bold text-phx-ink-soft">Seat</span>{" "}
      {vacancy ? formatOfferVacancyLabel(vacancy) : "no longer open — choose it again on Add Employee"}
    </span>
  );
}

export function OfferComposer({
  canManage,
  jobTitles,
  offers,
  onOffers,
  onReport,
  sender,
  templates,
  vacancies,
}: {
  canManage: boolean;
  jobTitles: OfferJobTitle[];
  offers: OfferRecord[];
  onOffers: (offers: OfferRecord[]) => void;
  onReport: (message: string | null, kind: "error" | "success") => void;
  sender: OfferSenderInfo;
  templates: OfferTemplate[];
  /** The open seats a letter can be written against. Empty is a state, not a failure. */
  vacancies: OfferVacancyOption[];
}) {
  /**
   * The way out to Add Employee, derived from where this screen already is rather than passed down
   * as another prop — the same derivation `recruitment-workspace.tsx` makes for its own hire link,
   * and for the same reason: this module is rendered by an admin page and by a portal twin, and the
   * two shells serve the employees screen at different paths.
   */
  const pathname = usePathname();
  const addEmployeeHref = pathname?.startsWith("/employee-portals") ? "/employee-portals/employees" : "/employees";

  const [draft, setDraft] = useState<Draft>(() => blankDraft(templates));
  const [savedId, setSavedId] = useState<string | null>(null);

  /**
   * "Send an offer" from the recruitment workspace opens this screen as
   * `/offers?candidate=<id>&vacancy=<id>&title=<offer title>`.
   *
   * THE ARROW STAYS RECRUITMENT -> OFFERS. Nothing here imports recruitment code: the name and the
   * address are FETCHED from the candidate's own route, under the viewer's own grant (a viewer who
   * cannot read candidates simply gets the title and seat, and types the person), and the letter is
   * pointed at the candidate afterwards through the recruitment side's own writer,
   * `PATCH /api/recruitment/candidates/<id>/offer-letter` — the same door a recruiter uses by hand.
   * Every prefilled box stays editable; approving and sending stay his click here.
   */
  const searchParams = useSearchParams();
  const prefillCandidateId = searchParams?.get("candidate") ?? null;
  const prefillVacancyId = searchParams?.get("vacancy") ?? null;
  const prefillTitle = searchParams?.get("title") ?? null;
  const appliedPrefillRef = useRef<string | null>(null);
  // The candidate THIS form was filled for. Held in state, not re-read from the URL, so a second
  // letter typed into the same screen after the first was sent is never pointed at them.
  const [linkCandidateId, setLinkCandidateId] = useState<string | null>(null);
  const linkedOfferRef = useRef<string | null>(null);
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
      roleSummary: draft.roleSummary.trim(),
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

  // The same reader the server runs before sending, so what this screen says will be copied is what
  // the provider is handed.
  const copies = useMemo(
    () => planOfferCopies({ bcc: draft.bcc, candidateEmail: draft.candidateEmail, cc: draft.cc }),
    [draft.bcc, draft.candidateEmail, draft.cc],
  );

  /**
   * The seats worth offering, narrowed by the job title that has already been chosen.
   *
   * Without this the list is every open seat — 44 on production, 42 of them Medical Representative
   * — and picking the right one means reading past forty rows for the wrong job. The match is on
   * the seat's position title OR its own `job_title`, because the two disagree on real rows.
   *
   * TWO things are deliberately never filtered out:
   *
   *   * the seat already CHOSEN on this offer, even when it no longer matches the title. Correcting
   *     a typo in the title must not silently empty a `<select>` whose value is still stored — the
   *     row would vanish, the box would read blank, and the next save would clear a real decision.
   *   * every seat, when the title matches none of them. A title that is new, or spelled
   *     differently from the organogram's, must not leave somebody with an empty picker and no way
   *     to reach the seat they can see is open.
   */
  const seatOptions = useMemo(() => {
    const wanted = draft.title.trim().toLowerCase();
    if (!wanted) return vacancies;

    const matching = vacancies.filter((vacancy) => {
      const position = (vacancy.positionTitle ?? "").trim().toLowerCase();
      const jobTitle = (vacancy.jobTitle ?? "").trim().toLowerCase();
      return position === wanted || jobTitle === wanted;
    });
    // Nothing matched: show everything rather than nothing, so an unfamiliar title is never a dead
    // end. Narrowing to a list of one — the chosen seat — would be worse than not narrowing at all.
    if (matching.length === 0) return vacancies;

    const chosen = vacancies.find((vacancy) => String(vacancy.vacancyId) === draft.vacancyId);
    if (chosen && !matching.includes(chosen)) return [chosen, ...matching];
    return matching;
  }, [draft.title, draft.vacancyId, vacancies]);

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
   * Choosing a title fills its cost of living, its reporting line, its contract term, what the
   * letter says the job IS, and — where the title has one — the letter design it is written on.
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
      // The paragraph this position's letters open with. `?? current` for the same reason as the
      // fields above — a title nobody has worded yet must not wipe a paragraph typed here for this
      // one letter. Blank then stands, and blank prints the standard sentence.
      roleSummary: match?.roleSummary ?? current.roleSummary,
      templateId: bound ?? current.templateId,
      title,
    }));
  }

  /**
   * Choosing the open seat this letter is written against.
   *
   * It fills TERRITORY from the seat's own area, in the same spirit as `chooseTitle` above: a
   * starting point, never a lock, and the box stays editable afterwards. That is worth having on
   * its own — measured across all 28 offers on production, `territory` was typed by hand as "Qena"
   * where the organogram holds "Qena 1" and "Qena 2", so the letter and the seat disagreed about
   * the job on the day it was signed.
   *
   * It does NOT touch "Reports to", and that is deliberate rather than an omission. The letter's
   * reporting line is a ROLE — every production offer reads "District Sales Manager" — while the
   * seat carries a PERSON's name. Substituting one for the other would rewrite what the letter
   * promises about the job, and the person in that chair can change before the first working day.
   *
   * Clearing the seat leaves territory exactly as it stands. Un-choosing a seat is not a statement
   * that the territory was wrong, and blanking a field somebody typed is never a safe read of a
   * click meant to undo something else.
   */
  function chooseVacancy(value: string) {
    const vacancy = vacancies.find((option) => String(option.vacancyId) === value);
    setDraft((current) => ({
      ...current,
      territory: vacancy?.areaName?.trim() || current.territory,
      vacancyId: value,
    }));
  }

  useEffect(() => {
    if (!prefillCandidateId) return;
    const key = `${prefillCandidateId}|${prefillVacancyId ?? ""}|${prefillTitle ?? ""}`;
    if (appliedPrefillRef.current === key) return;
    appliedPrefillRef.current = key;

    let cancelled = false;
    // Scheduled, not inline: react-hooks/set-state-in-effect is an ERROR in this repo.
    const timer = setTimeout(async () => {
      if (prefillTitle) chooseTitle(prefillTitle);
      if (prefillVacancyId && vacancies.some((option) => String(option.vacancyId) === prefillVacancyId)) {
        chooseVacancy(prefillVacancyId);
      }
      setSavedId(null);
      linkedOfferRef.current = null;
      setLinkCandidateId(prefillCandidateId);
      try {
        const response = await fetch(`/api/recruitment/candidates/${encodeURIComponent(prefillCandidateId)}`, {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => ({}))) as {
          profile?: { candidate?: { email?: string | null; fullName?: string | null } };
        };
        if (cancelled) return;
        const person = response.ok ? payload.profile?.candidate : undefined;
        if (!person) {
          onReport("Could not load the candidate's name and address — type them in.", "error");
          return;
        }
        setDraft((current) => ({
          ...current,
          candidateEmail: current.candidateEmail || (person.email ?? "").trim(),
          candidateName: current.candidateName || (person.fullName ?? "").trim(),
        }));
      } catch {
        if (!cancelled) onReport("Could not load the candidate's name and address — type them in.", "error");
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // chooseTitle/chooseVacancy are declarations in this component body; the ref guard applies the
    // prefill once per link, and re-running on anything else would overwrite what was typed since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillCandidateId, prefillVacancyId, prefillTitle]);

  /**
   * Point the candidate this form was filled for at the letter just saved — once per letter, best
   * effort. The offer is already saved; a refused link is said, never turned into a failed save.
   */
  async function linkLetterToCandidate(offerId: string) {
    if (!linkCandidateId || linkedOfferRef.current === offerId) return;
    linkedOfferRef.current = offerId;
    try {
      await call(`/api/recruitment/candidates/${encodeURIComponent(linkCandidateId)}/offer-letter`, "PATCH", { offerId });
    } catch (error) {
      linkedOfferRef.current = null;
      onReport(
        `The offer was saved, but it could not be linked to the candidate's record: ${
          error instanceof Error ? error.message : "the link was refused"
        }`,
        "error",
      );
    }
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

  /**
   * Record what the candidate answered.
   *
   * `PATCH /api/offers/[id]` has accepted "accepted" and "declined" since the module shipped and
   * NOTHING has ever called it with either - the two words appear in this file only as badge
   * colours, for a status no button could reach. So an offer's outcome lived in somebody's memory
   * and the letter sat on "sent" forever.
   *
   * Only for a SENT offer. A draft has not been answered because it has not been asked, and
   * re-answering an offer already marked accepted or declined would overwrite a recorded fact with
   * a mis-click - which is why this is not offered on those rows either.
   */
  async function recordAnswer(offer: OfferRecord, status: "accepted" | "declined") {
    setBusy(offer.id);
    try {
      const payload = (await call(`/api/offers/${offer.id}`, "PATCH", { status })) as { offer?: OfferRecord };
      if (payload.offer) {
        onOffers([payload.offer, ...offers.filter((existing) => existing.id !== payload.offer!.id)]);
      }
      onReport(`${offer.candidateName} ${status} offer ${offer.reference}.`, "success");
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not record that answer.", "error");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Take a sent offer back (owner, 2026-09-29).
   *
   * ── Why this had to exist ──
   * "withdrawn" has been a valid status since the module shipped, the PATCH route has always
   * accepted it, and NOTHING has ever sent it — the same hole Accepted and Declined sat in until
   * the day before. So withdrawing an offer meant writing the row on production by hand, which is
   * exactly how Abdallah Saad's SP-HR-MR-2026-025 was withdrawn on 2026-09-29, and how the five
   * withdrawn offers before it got there. A status only a database write can reach is not a state
   * the business owns.
   *
   * ── It is the COMPANY's act, not the candidate's ──
   * Which is why it is separate from `recordAnswer` rather than a third value passed to it.
   * Accepted and Declined record what somebody else said; this records what Phoenix decided. The
   * wording, the confirm and the button's own colour all follow from that difference.
   *
   * ── Confirmed first ──
   * A withdrawn offer cannot be resent (`offerResendRefusal`), cannot be answered — the Accepted
   * and Declined buttons are gone from the row the moment it lands — and cannot be returned to
   * draft, which the route refuses outright. The only way forward from here is a new letter under
   * a new reference. That is a one-way door and it asks before going through it.
   *
   * Only a SENT offer, like the two beside it. A draft was never sent, so there is nothing to take
   * back; an accepted or declined one has been answered, and reaching back past a recorded fact is
   * the mis-click this module has refused since Accepted shipped.
   */
  async function withdrawOffer(offer: OfferRecord) {
    if (
      !window.confirm(
        `Withdraw offer ${offer.reference} to ${offer.candidateName}?\n\n` +
          "The offer is taken back. It can no longer be accepted, declined or resent, and it cannot " +
          "be returned to a draft — reaching this candidate again means a new letter under a new reference.",
      )
    ) {
      return;
    }
    setBusy(offer.id);
    try {
      const payload = (await call(`/api/offers/${offer.id}`, "PATCH", { status: "withdrawn" })) as {
        offer?: OfferRecord;
      };
      if (payload.offer) {
        onOffers([payload.offer, ...offers.filter((existing) => existing.id !== payload.offer!.id)]);
      }
      onReport(`Offer ${offer.reference} to ${offer.candidateName} was withdrawn.`, "success");
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not withdraw this offer.", "error");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Tell the candidate the offer has expired, and withdraw it (owner, 2026-10-07).
   *
   * The candidate-facing half of Withdraw. Withdraw takes the offer back silently; this does the
   * same but first sends the person a short Sato note that their offer has lapsed, to the same
   * address the letter went to. One confirmed press, one offer — never a batch — so it stays inside
   * the standing rule that a rejection-style notice is never sent automatically.
   *
   * Confirmed first, because it both writes to a stranger's inbox and retires the offer: the same
   * one-way door as Withdraw, with a message attached. The server sends the notice and only then
   * marks the row withdrawn, so a suppressed send leaves the offer exactly as it was.
   */
  async function expireOffer(offer: OfferRecord) {
    if (
      !window.confirm(
        `Tell ${offer.candidateName} at ${offer.candidateEmail} that offer ${offer.reference} has expired, and withdraw it?\n\n` +
          "A short notice goes to the candidate, and the offer is taken back — it can no longer be " +
          "accepted, declined or resent, and this cannot be undone.",
      )
    ) {
      return;
    }
    setBusy(offer.id);
    try {
      const payload = (await call(`/api/offers/${offer.id}/expire`, "POST", {})) as {
        from?: string;
        offer?: OfferRecord;
        recipient?: string;
        skipped?: boolean;
        skippedReason?: string | null;
      };
      if (payload.skipped) {
        onReport(
          `No expiry notice was sent: ${payload.skippedReason ?? "the send was suppressed"}. The offer was left unchanged.`,
          "error",
        );
        return;
      }
      if (payload.offer) {
        onOffers([payload.offer, ...offers.filter((existing) => existing.id !== payload.offer!.id)]);
      }
      onReport(
        `Offer ${offer.reference} marked expired — ${payload.recipient} was notified from ${payload.from}, and the offer was withdrawn.`,
        "success",
      );
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not mark this offer expired.", "error");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Send a sent offer's letter again — the same letter, to the same address (owner, 2026-09-28).
   *
   * For the candidate who says it never arrived: on 2026-09-28 Resend accepted Norhan Gamal's offer
   * and then failed it, the row read "sent", and the only way to reach her again was to withdraw the
   * letter and compose a new one under a new reference. The server renders from the snapshot frozen
   * at the first send and changes nothing on the row.
   *
   * Confirmed first: it puts the company's terms in a stranger's inbox and cannot be recalled. One
   * request id per press, so a double-submit of that press still sends a single letter.
   */
  async function resendOffer(offer: OfferRecord) {
    if (!window.confirm(`Send offer ${offer.reference} to ${offer.candidateEmail} again? The same letter goes out; nothing on the offer changes.`)) {
      return;
    }
    setBusy(offer.id);
    try {
      const payload = (await call(`/api/offers/${offer.id}/resend`, "POST", { requestId: crypto.randomUUID() })) as {
        attachmentWarning?: string | null;
        from?: string;
        recipient?: string;
        skipped?: boolean;
        skippedReason?: string | null;
      };
      if (payload.skipped) {
        onReport(`The offer was NOT resent: ${payload.skippedReason ?? "the send was suppressed"}.`, "error");
        return;
      }
      onReport(
        `Offer ${offer.reference} resent to ${payload.recipient} from ${payload.from}.` +
          (payload.attachmentWarning ? ` ${payload.attachmentWarning}` : " The PDF is attached."),
        "success",
      );
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not resend this offer.", "error");
    } finally {
      setBusy(null);
    }
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
      // `vacancyId` rides beside `fields` rather than inside it, exactly like `templateId`: those
      // fields feed the letter's tokens, and neither a design nor a seat id prints on a letter.
      const body = {
        ...fields,
        templateId: draft.templateId || null,
        vacancyId: draft.vacancyId ? Number(draft.vacancyId) : null,
      };
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
      await linkLetterToCandidate(offer.id);
      return offer.id;
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not save this offer.", "error");
      return null;
    } finally {
      setBusy(null);
    }
  }

  /**
   * Put a saved draft back in the form, ready to check and send. Its stored reference is kept as
   * typed, so the title-driven proposal can never renumber a letter that already has its number.
   */
  function openDraft(offer: OfferRecord) {
    markReferenceTyped(true);
    // A different letter: the candidate a link opened this screen for is not its candidate.
    setLinkCandidateId(null);
    setSavedId(offer.id);
    setDraft(draftFromOffer(offer, templates));
    onReport(`Opened the draft for ${offer.candidateName} (${offer.reference}). Check it, then press Send offer.`, "success");
    window.scrollTo({ behavior: "smooth", top: 0 });
  }

  async function sendOffer() {
    if (!fields.candidateEmail) {
      onReport("An email address is required before the offer can be sent.", "error");
      return;
    }
    // Refused here before anything is saved or sent, in the same words the server would use: one
    // bad address stops the whole send rather than quietly going out without that person.
    if (copies.problems.length > 0) {
      onReport(copies.problems.join(" "), "error");
      return;
    }
    // The server refuses it too; saying so here keeps a dateless letter from being saved and sent.
    if (!draft.startDate) {
      onReport(OFFER_START_DATE_REQUIRED_MESSAGE, "error");
      return;
    }
    // ALWAYS save first, even when the draft is already saved. Before this, Send used the saved id
    // as it stood, so an edit made after the last save — a salary, a start date — was on the screen
    // and in the preview but NOT in the letter that went out. Saving now is what makes the letter
    // sent the letter shown.
    const id = await saveDraft();
    if (!id) return;

    setBusy("send");
    try {
      const payload = (await call(`/api/offers/${id}/send`, "POST", { bcc: copies.bcc, cc: copies.cc })) as {
        attachmentWarning?: string | null;
        bcc?: string[];
        cc?: string[];
        copyNotes?: string[];
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
      // The next letter typed here is for somebody else.
      setLinkCandidateId(null);
      // A fresh form gets a fresh generated reference. Without this reset, a manually typed
      // reference from the offer just sent would suppress generation for every offer after it.
      markReferenceTyped(false);
      setDraft(blankDraft(templates));
      // Read back from what the server actually handed the provider, not from the boxes — so the
      // message names who really received a copy.
      const sentCc = payload.cc ?? [];
      const sentBcc = payload.bcc ?? [];
      onReport(
        `Offer sent to ${payload.recipient} from ${payload.from}.` +
          (sentCc.length > 0 ? ` CC: ${sentCc.join(", ")}.` : "") +
          (sentBcc.length > 0 ? ` BCC: ${sentBcc.join(", ")}.` : "") +
          (payload.attachmentWarning ? ` ${payload.attachmentWarning}` : " The signed-ready PDF is attached.") +
          ((payload.copyNotes ?? []).length > 0 ? ` ${(payload.copyNotes ?? []).join(" ")}` : ""),
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

  /**
   * A copy line — CC or BCC. Several addresses, separated by commas.
   *
   * Under the box, the addresses exactly as they will be sent: lower-cased, de-duplicated, the
   * candidate's own address and CC repeats taken out. Same idea as the date fields' "Prints on the
   * letter as" line — nobody has to trust that the parsing is right, they can read it.
   */
  const copyField = (key: "bcc" | "cc", label: string, placeholder: string, who: string, idle: string) => {
    const list = copies[key];
    const bad = copies.invalid[key];
    // The notes that concern both lines together — the cap, the candidate's address, a CC repeated on
    // BCC — are shown once, under BCC, the second of the pair.
    const shared = key === "bcc" ? [...(copies.limitProblem ? [copies.limitProblem] : []), ...copies.notes] : [];
    return (
      <div key={key}>
        <label className={offerLabelClassName} htmlFor={`offer-${key}`}>{label}</label>
        <input
          autoComplete="off"
          className={offerInputClassName}
          disabled={!canManage}
          id={`offer-${key}`}
          onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
          placeholder={placeholder}
          spellCheck={false}
          value={draft[key]}
        />
        {/* `[overflow-wrap:anywhere]`: an address has no space to break at, and a long one must wrap
            rather than push the form sideways at 375px. Never an ellipsis — the whole point of this
            line is reading every address in full. */}
        <p className={cn(offerHintClassName, "[overflow-wrap:anywhere]")}>
          {list.length > 0 ? `${who} ${list.join(", ")}` : idle}
        </p>
        {noteList([
          ...(bad.length > 0
            ? [`Not ${bad.length === 1 ? "an email address" : "email addresses"}: ${bad.join(", ")}. The offer cannot be sent until ${bad.length === 1 ? "it is" : "they are"} fixed or removed.`]
            : []),
          ...shared,
        ])}
      </div>
    );
  };

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
          {printed
            ? `Prints on the letter as ${printed}`
            : key === "startDate"
              ? "Required before the offer can be sent — the candidate's joining form records it as the first day."
              : "Not set — the letter will show this field empty."}
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
          {/* One address as the example, not two: measured on production at 375px the pair was cut
              off at "hr@sa" in a 275px box. The hint underneath is what says several may go. */}
          {copyField(
            "cc",
            "CC",
            "manager@satopharma.com",
            "Copied openly to",
            "Optional. The candidate sees who is copied here. Separate several addresses with commas.",
          )}
          {copyField(
            "bcc",
            "BCC",
            "someone@satopharma.com",
            "Copied secretly to",
            `Optional. Nobody else sees who is copied here. Up to ${OFFER_COPY_MAX} copies across CC and BCC.`,
          )}

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
                  ? "Cost of living, reporting line, contract term, wording and letter design filled from the catalogue."
                  : "Cost of living, reporting line, contract term and wording filled from the catalogue."
                : "Not in the catalogue — type the cost of living yourself, or add the title on the Job titles tab."}
            </p>
          </div>

          {/* The open seat this letter is written against. Optional, and last in this group on
              purpose: it FILLS the territory above it, so it reads top-down as "the job, then which
              chair", and choosing it after the title is what lets the list be filtered by the
              title. A native <select> rather than a combobox — 44 rows is a list, not a search —
              and the option text wraps in the browser's own panel, so no label is ever cut off. */}
          <div>
            <label className={offerLabelClassName} htmlFor="offer-vacancy">Vacant seat</label>
            <select
              className={offerInputClassName}
              disabled={!canManage}
              id="offer-vacancy"
              onChange={(event) => chooseVacancy(event.target.value)}
              value={draft.vacancyId}
            >
              <option value="">Not decided yet</option>
              {seatOptions.map((vacancy) => (
                <option key={vacancy.vacancyId} value={String(vacancy.vacancyId)}>
                  {formatOfferVacancyLabel(vacancy)}
                </option>
              ))}
            </select>
            <p className={offerHintClassName}>
              {offerRequiresSeat(draft.title) && !draft.vacancyId
                ? "Required for a Medical Representative or District Manager offer — the candidate's joining form places the new hire in this seat, so the offer cannot be sent without it."
                : vacancies.length === 0
                  ? "No open seats are on file. The letter can still be written; the seat is then chosen on Add Employee."
                  : draft.vacancyId
                    ? "The candidate's joining form places the new hire in this seat on acceptance. The seat is closed by the hire, not by this offer."
                    : "Optional. Choosing it now means the joining form places the candidate in this seat on acceptance."}
            </p>
          </div>

          {text("territory", "Territory", "Delta 3")}
          {text("reportsTo", "Reports to", "National Sales Manager")}
          {text("contractTerm", "Contract term", "One year, renewable")}

          {/* The paragraph the letter opens with, prefilled from the job title and overridable for
              this one letter. Full width across every breakpoint because it is prose: a paragraph in
              a third of a row wraps into a column nobody can read while writing it, and the
              fits-the-screen rule's answer to prose is width, never a smaller typeface. */}
          <div className="md:col-span-2 xl:col-span-3">
            <label className={offerLabelClassName} htmlFor="offer-role-summary">
              What the letter says this job is
            </label>
            <textarea
              className={offerTextareaClassName}
              disabled={!canManage}
              id="offer-role-summary"
              onChange={(event) => setDraft((current) => ({ ...current, roleSummary: event.target.value }))}
              placeholder="Throughout our selection process you demonstrated… and we would like you to bring both to {{territory}}."
              rows={4}
              value={draft.roleSummary}
            />
            <p className={offerHintClassName}>
              {draft.roleSummary.trim()
                ? "This letter's own words. Changing it here changes this one letter; the Job titles tab changes every future offer for the position."
                : findOfferJobTitle(draft.title, jobTitles)
                  ? "This position has no wording of its own yet, so the letter prints the standard sentence. Write it once on the Job titles tab and every future offer for the position carries it."
                  : "Blank prints the standard sentence. Write {{territory}} where the candidate's own area should appear."}
            </p>
          </div>

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
            {/* The actions column carries FIVE controls on a sent offer since Withdraw joined
                Accepted, Declined, Resend and PDF (2026-09-29), so it takes 6 points from Title and
                Package, which wrap. The controls wrap too, onto as many lines as they need — that
                is the fits-the-screen rule's answer, and the reason adding a fifth costs no width:
                `flex-wrap` with no `min-width` anywhere under it can never produce a sideways
                scroll, however many controls a row grows. */}
            <colgroup>
              <col className="w-[25%]" />
              <col className="w-[15%]" />
              <col className="w-[14%]" />
              <col className="w-[13%]" />
              <col className="w-[13%]" />
              <col className="w-[20%]" />
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
                    <OfferCopiedTo offer={offer} />
                  </td>
                  <td className="break-words px-5 py-3 text-slate-600">
                    {offer.title}
                    <OfferSeat offer={offer} vacancies={vacancies} />
                  </td>
                  <td className="break-words px-5 py-3 text-right tabular-nums text-slate-900">
                    EGP {offerMoney(offer.totalMonthly)}
                  </td>
                  <td className="px-5 py-3">
                    <Badge className="capitalize" variant={STATUS_VARIANT[offer.status]}>
                      {offer.status}
                    </Badge>
                  </td>
                  <td className="break-words px-5 py-3 text-slate-600">{offerWhen(offer.sentAt)}</td>
                  <td className="px-5 py-3">
                    {/* Wraps rather than scrolls: the fits-the-screen rule, and three controls do
                        not fit one line at 375px. */}
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {canManage && offer.status === "sent" ? (
                        <>
                          <Button
                            disabled={busy !== null}
                            onClick={() => void recordAnswer(offer, "accepted")}
                            size="sm"
                            type="button"
                          >
                            Accepted
                          </Button>
                          <Button
                            disabled={busy !== null}
                            onClick={() => void recordAnswer(offer, "declined")}
                            size="sm"
                            type="button"
                            variant="destructive"
                          >
                            Declined
                          </Button>
                          <Button
                            disabled={busy !== null}
                            onClick={() => void resendOffer(offer)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            <Send className="h-3.5 w-3.5" /> Resend offer
                          </Button>
                          <Button
                            disabled={busy !== null}
                            onClick={() => void withdrawOffer(offer)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            <Undo2 className="h-3.5 w-3.5" /> Withdraw
                          </Button>
                          <Button
                            disabled={busy !== null}
                            onClick={() => void expireOffer(offer)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            <CalendarX2 className="h-3.5 w-3.5" /> Expire offer
                          </Button>
                        </>
                      ) : null}
                      {canManage && offer.status === "draft" ? (
                        <Button
                          disabled={busy !== null}
                          onClick={() => openDraft(offer)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <Eye className="h-3.5 w-3.5" /> Open draft
                        </Button>
                      ) : null}
                      {offer.employeeHrId ? (
                        <span className="text-xs font-semibold text-emerald-700">{joinedLabel(offer)}</span>
                      ) : canManage && offer.status === "accepted" ? (
                        <Button asChild size="sm" type="button">
                          <a href={`${addEmployeeHref}?fromOffer=${encodeURIComponent(offer.id)}`}>
                            <UserPlus className="h-3.5 w-3.5" /> Add employee
                          </a>
                        </Button>
                      ) : null}
                      <Button asChild size="sm" type="button" variant="secondary">
                        <a href={`/api/offers/${offer.id}/pdf`} rel="noreferrer" target="_blank">
                          <FileDown className="h-3.5 w-3.5" /> PDF
                        </a>
                      </Button>
                    </div>
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
                  {/* The address the letter actually went to. The desktop table has carried this
                      under the name since it shipped; this card did not, so on a phone — which is
                      how these are read — an offer was a name and nothing else.
                      Measured 2026-09-08: three offers sat here reading as three different people,
                      and were one person testing the feature into a single inbox. Nothing on this
                      card could have shown that. `break-all` because an email has no space to break
                      at, and no `truncate` because a half-shown address is worse than a wrapped one:
                      the whole value of this line is telling two addresses apart. */}
                  <p className="mt-0.5 break-all text-xs text-slate-500">{offer.candidateEmail}</p>
                  <OfferCopiedTo offer={offer} />
                  <p className="mt-0.5 text-xs text-slate-500">{offer.title}</p>
                  <OfferSeat offer={offer} vacancies={vacancies} />
                </div>
                {/* `shrink-0`: the status never gives up width to the column beside it. Measured on
                    production 2026-09-28 at 375px: once a card carried a long copy line, flex shrank
                    both sides and "Sent" was clipped to 33 of its 36px. The text column wraps
                    instead — it is `min-w-0`, and every line in it can break. */}
                <Badge className="shrink-0 capitalize" variant={STATUS_VARIANT[offer.status]}>
                  {offer.status}
                </Badge>
              </div>
              <p className="mt-2 text-sm font-bold tabular-nums text-slate-900">EGP {offerMoney(offer.totalMonthly)}</p>
              <p className="mt-1 text-xs text-slate-500">{offerWhen(offer.sentAt)}</p>
              {/* Wraps, like the table's cell: three controls do not fit one line at 375px, and
                  the fits-the-screen rule makes wrapping the answer rather than a sideways scroll. */}
              <div className="mt-3 flex flex-wrap gap-2">
                {/* The same two gates as the desktop row, restated because this is a second
                    rendering of the same decision rather than a second rule:
                      - `canManage`: recording an answer is a management action, not something a
                        read-only viewer may do.
                      - `status === "sent"`: a draft has not been answered because it has not been
                        asked, and re-answering a recorded accept or decline would overwrite a fact
                        with a mis-click.
                    Until now these buttons existed only in the table, so an answer could be
                    recorded at a desk and nowhere else — while a phone is how these are read. An
                    offer whose outcome nobody can record sits on "sent" forever, which is exactly
                    the state that made every letter look outstanding. */}
                {canManage && offer.status === "sent" ? (
                  <>
                    <Button
                      disabled={busy !== null}
                      onClick={() => void recordAnswer(offer, "accepted")}
                      size="sm"
                      type="button"
                    >
                      Accepted
                    </Button>
                    <Button
                      disabled={busy !== null}
                      onClick={() => void recordAnswer(offer, "declined")}
                      size="sm"
                      type="button"
                      variant="destructive"
                    >
                      Declined
                    </Button>
                    <Button
                      disabled={busy !== null}
                      onClick={() => void resendOffer(offer)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Send className="h-3.5 w-3.5" /> Resend offer
                    </Button>
                    <Button
                      disabled={busy !== null}
                      onClick={() => void withdrawOffer(offer)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Undo2 className="h-3.5 w-3.5" /> Withdraw
                    </Button>
                    <Button
                      disabled={busy !== null}
                      onClick={() => void expireOffer(offer)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <CalendarX2 className="h-3.5 w-3.5" /> Expire offer
                    </Button>
                  </>
                ) : null}
                {canManage && offer.status === "draft" ? (
                  <Button
                    disabled={busy !== null}
                    onClick={() => openDraft(offer)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Eye className="h-3.5 w-3.5" /> Open draft
                  </Button>
                ) : null}
                {offer.employeeHrId ? (
                  <span className="text-xs font-semibold text-emerald-700">{joinedLabel(offer)}</span>
                ) : canManage && offer.status === "accepted" ? (
                  <Button asChild size="sm" type="button">
                    <a href={`${addEmployeeHref}?fromOffer=${encodeURIComponent(offer.id)}`}>
                      <UserPlus className="h-3.5 w-3.5" /> Add employee
                    </a>
                  </Button>
                ) : null}
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
