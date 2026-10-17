"use client";

/**
 * Phoenix CRM — the visit form. One button: Log visit.
 *
 * Owner, 2026-09-29: "the medical rep just presses; in the back end we take his location". The form
 * records the visit, and nothing the server can derive. What the save needs comes first, what it
 * does not comes after a line that says so:
 *
 *   - Single / Double / Chain. Under Double and Chain one list shows his managers and his line's product
 *     managers, and he ticks ONE (Double) or TWO (Chain) — owner, 2026-10-06 (visit-company.ts is the
 *     rule, resolveVisitParticipants the server's check);
 *   - the products discussed, filled in from his last visit to this customer;
 *   - the comment, typed or spoken (one control, both halves) — REQUIRED since 2026-09-30, which is
 *     why it sits straight under the products rather than after the optional steps;
 *   - OPTIONAL: the pharmacy and its per-product stock answers (the box stays, it never blocks);
 *   - OPTIONAL: what he left behind — a record, never a stock movement;
 *   - OPTIONAL and OPEN: the customer's objection and his next step, both chips.
 *
 * 🔴 TWO OPTIONAL STEPS START FOLDED (owner, 2026-10-02, asked how step 3 should follow Report It: "I
 * need all the points in the current form of entering the visit … I don't need too many steps and too
 * many clicks by the reps"). Every point stays and keeps its header, so the form still shows all
 * seven; a folded one opens IN PLACE with one tap on its row, the way Report It adds a block. No step
 * was added and no press was added to a visit that skips them — the usual visit — while the step
 * shrinks to what the save needs. Never fold a REQUIRED step: the bar's jump would land on a closed
 * box.
 *
 * 🔴 STEP 7 — the objection and the next step — IS UNFOLDED AGAIN (owner, 2026-10-06: "unfold
 * objection and next step in Phoenix CRM"). It had been folded with the other two, and the field
 * answered: across the module's first three live days the reps recorded a next step on 1 visit of 332
 * and an objection on 2 — the two questions a pharmaceutical manager actually coaches on, behind a
 * tap nobody took. Optional is untouched: the save still never asks for either, so this costs the rep
 * who skips them nothing but the scroll, and saves a tap for the rep who answers. Only the owner's
 * own word can fold it again — his 2026-10-02 ruling is what this amends.
 *
 * Log visit lives in a bar held at the bottom of the screen, under his thumb wherever he has scrolled
 * to, and the bar names the ONE thing still missing in the save's own words — so he never taps into a
 * refusal he could have seen coming, and never hunts for the step it means.
 *
 * NO photo, NO date, NO AM/PM picker: the server stamps the time, AM or PM comes from the customer,
 * and the location is read silently from the moment this form opens (use-silent-fix.ts). GOLDEN RULE
 * #1: nothing on this screen says a location exists, what it is compared with, or how good it was.
 * The one sentence about it is his own work failing — location switched off.
 *
 * Only today's visits are logged, until 02:00 the next morning (the visit day is the Cairo date of the
 * time minus two hours) — the server decides that too, so there is nothing to choose here.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, Check, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, History, Plus } from "lucide-react";

import { crmPost, errorCodeOf, messageOf, newClientId } from "@/components/phoenix-crm/api";
import { dayLabel } from "@/components/phoenix-crm/format";
import { customerMetaText, monthVisitsText, PENDING_COUNTS_NOTE, PENDING_PILL, pendingVisitsText } from "@/components/phoenix-crm/labels";
import { CrmSpeak, type VoiceNoteValue } from "@/components/phoenix-crm/speak";
import { useBrowserNamed } from "@/components/phoenix-crm/use-browser-name";
import { silentFixPayload, useSilentFix } from "@/components/phoenix-crm/use-silent-fix";
import { crmStepBackClassName, crmStepNextClassName } from "@/components/phoenix-crm/step-form";
import { customerDirectionsUrl, PlaceWindows } from "@/components/phoenix-crm/visit-customer-picker";
import { DirectionsLink } from "@/components/phoenix-crm/directions-link";
import { CompanyPicker, type CompanyPerson } from "@/components/phoenix-crm/visit-company-picker";
import { DoubleVisitQuestion, NO_DOUBLE_VISIT, type DoubleVisitAnswerDraft } from "@/components/phoenix-crm/double-visit-question";
import {
  CrmBackBar,
  CrmBlock,
  CrmButton,
  CrmChoice,
  CrmField,
  CrmNote,
  CrmPanel,
  CrmPill,
  crmInputClassName,
  crmTextareaClassName,
  type CrmChoiceOption,
} from "@/components/phoenix-crm/ui";
import { deviceInstallId } from "@/lib/phoenix-crm/device-install";
import { CHOOSE_A_DAY, CHOOSE_A_PERSON, isDoubleVisitCustomer } from "@/lib/phoenix-crm/double-visit-request-rules";
import { appendDictated } from "@/lib/phoenix-crm/dictation";
import {
  NO_FIX_FOR_A_VISIT,
  PHARMACY_NAME_MAX,
  VISIT_COMMENT_MAX,
  VISIT_COMMENT_REQUIRED,
  VISIT_PRODUCTS_MAX,
  type ProductAvailability,
} from "@/lib/phoenix-crm/entry-rules";
import { SAMPLE_MATERIALS, SAMPLE_QUANTITY_MAX, type SamplesGiven } from "@/lib/phoenix-crm/samples";
import type { PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";
import { OUT_OF_LIST_REP_NOTE, UNPLANNED_REASON_MAX, UNPLANNED_REASON_MIN } from "@/lib/phoenix-crm/unplanned-rules";
import {
  RECORDING_IN_FLIGHT_NEXT,
  UNSAVED_VOICE_NOTE_LEAVE_LABEL,
  UNSAVED_VOICE_NOTE_STAY_LABEL,
  voiceNoteLeaveWarning,
  type VoiceNoteLeaveWarning,
} from "@/lib/phoenix-crm/unsaved-voice-note";
import { isFollowUp, OBJECTION_NOTE_MAX, VISIT_NEXT_STEPS, VISIT_OBJECTIONS, type VisitNextStep, type VisitObjection } from "@/lib/phoenix-crm/visit-outcome";
import { COMPANY_PICKS, companyToStorage, type VisitCompanyChoice } from "@/lib/phoenix-crm/visit-company";
import type { SavedVisit, VisitCustomerOption, VisitFormView, VisitPerson } from "@/lib/phoenix-crm/view-types";
import { isVisitRecordingRefusal } from "@/lib/phoenix-crm/visit-recording-rules";
import { cn } from "@/lib/utils";

/**
 * The kind of visit he chose on the first steps. The server re-decides it from the plan's own history
 * — and files a pharmacy as planned whatever the plan says, because a pharmacy is never planned, never
 * off plan and never approved (owner, 2026-10-02/03, pharmacy-call-rules.ts).
 */
export type LogVisitType = "planned" | "out_of_plan" | "out_of_list" | "pharmacy";

/** The visit type as he reads it. */
export function logVisitTypeLabel(visitType: LogVisitType): string {
  if (visitType === "planned") return "Planned visit";
  if (visitType === "out_of_plan") return "Out of plan";
  if (visitType === "pharmacy") return "Pharmacy visit";
  return "Out of list";
}

/** Who approves an off-plan visit, as one sentence: his manager first, then SFE. */
export function decidersText(form: Pick<VisitFormView, "managers">): string {
  return form.managers[0] ? `${form.managers[0].name} decides it first, then SFE.` : "SFE decides it.";
}

/**
 * GOLDEN RULE #1, the EASY half (owner, 2026-09-26): nothing is asked twice. He sees the same customer
 * every few weeks and re-taps the same products every time, and the answer is already in his own last
 * visit — so the form opens with them filled in, and the line under the grid says which day they came
 * from, so he can see what he is agreeing to and change any of it.
 */
function carriedProducts(customer: VisitCustomerOption): string[] {
  return customer.lastVisit ? [...customer.lastVisit.products] : [];
}

// ── The steps ───────────────────────────────────────────────────────────────────────────────────

/**
 * Where each required step can be scrolled to. The bar's "Next" line and a refused Log visit both take
 * him there, so the sentence that says what is missing is never more than one tap from the box that
 * answers it. The reason and the comment are their own inputs' ids.
 */
export type VisitFormPart = "details" | "log";

const STEP_REASON = "phoenix-crm-visit-reason";
const STEP_WHO = "phoenix-crm-visit-who";
const STEP_PRODUCTS = "phoenix-crm-visit-products";
const STEP_COMMENT = "phoenix-crm-visit-comment";
const STEP_DOUBLE = "phoenix-crm-visit-double";

type StepMark = "required" | "done" | "optional";

/**
 * The mark on the right of a step's header. Required turns to Done the moment it is answered, so the
 * form reads as a short list of what is left rather than a long list of boxes, and Optional says the
 * visit logs without it.
 *
 * A plain call rather than a component, on purpose: the phone-parity test reads every step title off
 * its `<CrmBlock … title="…">` tag with a pattern that stops at the first `>`, and a nested tag in
 * `actions` would end that read before the title.
 */
function stepMark(mark: StepMark) {
  if (mark === "done") {
    return (
      <CrmPill tone="good">
        <Check aria-hidden className="h-3 w-3" />
        Done
      </CrmPill>
    );
  }
  return mark === "required" ? <CrmPill tone="orange">Required</CrmPill> : <CrmPill>Optional</CrmPill>;
}

/**
 * The optional steps that are still FOLDED until he opens one (owner, 2026-10-02).
 *
 * 🔴 "What you took away" — the objection and the next step — LEFT THIS TYPE on 2026-10-06, at the
 * owner's own instruction ("unfold objection and next step in Phoenix CRM"), which is the only thing
 * that can lift one of his own rulings. It renders open, so it needs no key here and no tap to reach:
 * a key that nothing folds would leave a row on screen that can never be shown.
 */
type VisitExtra = "pharmacy" | "left";

/**
 * An optional step, folded: Report It's dashed "add" row, the whole row one tap. Its header stays above
 * it, so every point of the form is still in view; nothing is asked, and the visit logs with all three
 * folded.
 */
function FoldedStep({ disabled, label, note, onOpen }: { disabled: boolean; label: string; note: string; onOpen: () => void }) {
  return (
    <button
      className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-none border border-dashed border-slate-300 bg-white px-3 py-2.5 text-left transition hover:border-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onOpen}
      type="button"
    >
      <Plus aria-hidden className="h-4 w-4 shrink-0 text-orange-600" />
      <span className="min-w-0">
        <span className="block break-words text-sm font-black text-slate-800">{label}</span>
        <span className="mt-0.5 block break-words text-xs font-semibold text-slate-500">{note}</span>
      </span>
    </button>
  );
}

// ── Who was on the visit ────────────────────────────────────────────────────────────────────────

type Participants = {
  options: Array<CrmChoiceOption<PhoenixCrmVisitKind>>;
  /**
   * Entering as the rep: everyone the Double and Chain lists offer — the managers above the territory
   * (nearest first) and the line's product managers (owner, 2026-10-06). Empty when entering as a manager.
   */
  offers: CompanyPerson[];
  /** Entering as a manager: the visit's manager (the viewer). Null for a rep, who picks from `offers`. */
  manager: VisitPerson | null;
  seniorOptions: VisitPerson[];
  senior: VisitPerson | null;
};

/** The chosen person, or the only one there is. */
function pickPerson<T extends { hrId: string }>(options: ReadonlyArray<T>, hrId: string | null): T | null {
  return options.find((person) => person.hrId === hrId) ?? (options.length === 1 ? options[0] : null);
}

/** The choice a rep made on the first row, as the shared rule reads it. A rep is never offered the product-manager kind. */
function choiceOf(kind: PhoenixCrmVisitKind): VisitCompanyChoice {
  return kind === "double" || kind === "chain" ? kind : "single";
}

/** A manager entering on this territory has a rep to go with: it has one, and it is not themself. */
function enteringManagerHasRep(form: VisitFormView): boolean {
  const me = form.managers.find((person) => person.position === form.viewerPosition) ?? null;
  return Boolean(form.territory.repHrId && form.territory.repHrId !== me?.hrId);
}

/**
 * Who can be on the visit, by the same rule the save applies (resolveVisitParticipants). A rep sees ONE
 * list — the managers above his territory and his line's product managers — and ticks one person for
 * a double visit or two for a chain (`visit-company.ts` says what each pick is filed as). A manager
 * entering is the visit's manager, goes with the territory's rep, and for a chain picks a manager above
 * themself.
 */
function participantsOf(form: VisitFormView, seniorHrId: string | null): Participants {
  const people = form.managers;
  if (form.enteredAs === "manager") {
    const me = people.find((person) => person.position === form.viewerPosition) ?? null;
    const rep = enteringManagerHasRep(form) ? form.territory.repName : null;
    const seniorOptions = me ? people.filter((person) => person.position > me.position) : [];
    return {
      options: [
        // Closed for a district manager (owner, 2026-10-16): he logs his own visits under My single
        // visits on the Visits tab, where they count in his own report only.
        form.ownVisitClosed
          ? { value: "single", label: "My own visit", note: "Log it under My single visits", disabled: true }
          : { value: "single", label: "My own visit", note: "Without the rep" },
        { value: "double", label: "Double visit", note: rep ? `With ${rep}` : "This territory has no rep", disabled: !rep },
        {
          value: "chain",
          label: "Chain visit",
          note: !rep ? "This territory has no rep" : seniorOptions.length === 0 ? "No senior manager above you" : `With ${rep} and a senior manager`,
          disabled: !rep || seniorOptions.length === 0,
        },
      ],
      offers: [],
      manager: me,
      seniorOptions,
      senior: pickPerson(seniorOptions, seniorHrId),
    };
  }

  const offers: CompanyPerson[] = [
    ...people.map((person) => ({ hrId: person.hrId, name: person.name, title: person.title, role: "manager" as const, position: person.position })),
    ...form.productManagers.map((person) => ({ hrId: person.hrId, name: person.name, title: person.title, role: "product_manager" as const, position: null })),
  ];
  return {
    options: [
      { value: "single", label: "Single visit", note: "On my own" },
      {
        value: "double",
        label: "Double visit",
        note: offers.length > 0 ? "With one person from the list" : "No manager above this territory",
        disabled: offers.length === 0,
      },
      {
        value: "chain",
        label: "Chain visit",
        // A chain is the management line, so it needs a manager among its two: two product managers alone
        // are not a chain (`visit-company.ts`).
        note: people.length > 0 && offers.length > 1 ? "With two people from the list" : "Needs a manager and one more person from the list",
        disabled: people.length === 0 || offers.length < 2,
      },
    ],
    offers,
    manager: null,
    seniorOptions: [],
    senior: null,
  };
}

function personOptions(people: ReadonlyArray<{ hrId: string; name: string; title: string }>): Array<CrmChoiceOption<string>> {
  return people.map((person) => ({ value: person.hrId, label: person.name, note: person.title }));
}

/** One line of step 4's read-back: what was entered, never a box. Long text wraps; Arabic reads right to left. */
function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-l-[3px] border-slate-200 pl-3">
      <dt className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-line break-words text-sm font-bold text-slate-900" dir="auto">
        {value}
      </dd>
    </div>
  );
}

// ── The pharmacy stock check ────────────────────────────────────────────────────────────────────

// One product's Has / Doesn't-have answer. Tapping the answer it already carries clears it back to
// unanswered, so a mistaken tap is undone without a third button.
function AvailabilityRow({
  product,
  answer,
  disabled,
  onSet,
}: {
  product: string;
  answer: ProductAvailability | undefined;
  disabled: boolean;
  onSet: (product: string, answer: ProductAvailability) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border border-slate-200 bg-white px-3 py-2">
      <span className="min-w-0 flex-1 break-words text-sm font-black text-slate-700">{product}</span>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        <button
          aria-pressed={answer === "has"}
          className={cn(
            "min-h-11 min-w-0 break-words rounded-none border px-3 py-1 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50",
            answer === "has" ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-emerald-300",
          )}
          disabled={disabled}
          onClick={() => onSet(product, "has")}
          type="button"
        >
          Has
        </button>
        <button
          aria-pressed={answer === "missing"}
          className={cn(
            "min-h-11 min-w-0 break-words rounded-none border px-3 py-1 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50",
            answer === "missing" ? "border-rose-500 bg-rose-500 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-rose-300",
          )}
          disabled={disabled}
          onClick={() => onSet(product, "missing")}
          type="button"
        >
          Doesn&apos;t have
        </button>
      </div>
    </div>
  );
}

type Draft = { ok: true; payload: Record<string, unknown>; customerName: string } | { ok: false; problem: string };

export function VisitLogForm({
  customer,
  form,
  initialReason,
  initialVisitType,
  onBack,
  onPart,
  onReload,
  onRecordingRefused,
  onSaved,
  part,
  visitRecording = null,
  seatId,
  test,
}: {
  customer: VisitCustomerOption;
  form: VisitFormView;
  /** His "why I went", written on the step before, for a visit out of plan. */
  initialReason: string | null;
  initialVisitType: LogVisitType;
  onBack: () => void;
  /** Move between the step form's step 3 (products and comment) and step 4 (log the visit). */
  onPart: (next: VisitFormPart) => void;
  /**
   * Which step of Add visit's step form this is (owner, 2026-10-02): "details" is step 3, every box
   * of the visit; "log" is step 4, the visit read back with the ONE Log visit. The form stays mounted
   * across both, so nothing he entered is lost and the silent clock below keeps running.
   */
  part: VisitFormPart;
  /** Read the form again: the customer moved on under the screen (already visited, dropped). */
  onReload: () => void;
  onSaved: (visit: SavedVisit, customerName: string) => void;
  /**
   * The visit recording a chosen rep sent before the form opened (owner, 2026-10-16), carried in the
   * save so the server can claim it. Null for every rep the Super Admin has not switched on.
   */
  visitRecording?: { path: string; seconds: number } | null;
  /** The save refused the recording (used, too old, never arrived): Add visit puts the recorder back. */
  onRecordingRefused?: (message: string) => void;
  seatId: string;
  test: boolean;
}) {
  const readFix = useSilentFix();
  // 🔴 ONLY to clear the router's cache when a visit saves — see the note at the save. Nothing on
  // this form navigates; the rep leaves it with Back, which is exactly the navigation that broke.
  const router = useRouter();
  const [visitType, setVisitType] = useState<LogVisitType>(initialVisitType);
  const [unplannedReason, setUnplannedReason] = useState(initialReason ?? "");
  // The reason box is open when there is no reason yet — including when the server says a visit he
  // chose as planned was not on a plan sent for today, and asks for one.
  const [reasonOpen, setReasonOpen] = useState(initialVisitType === "out_of_plan" && !initialReason);
  // A district manager entering starts on Double visit: his "My own visit" is closed (owner, 2026-10-16).
  // Not on a territory with no rep, where Double visit is closed too — the step then says where his
  // visit goes instead of pre-picking one the save would refuse.
  const [kind, setKind] = useState<PhoenixCrmVisitKind>(form.ownVisitClosed && enteringManagerHasRep(form) ? "double" : "single");
  // A rep's Double (one) and Chain (two): the people ticked from the one list, in the order ticked.
  const [picked, setPicked] = useState<string[]>([]);
  // A manager entering a chain picks the senior manager above himself — his own box, unchanged.
  const [seniorHrId, setSeniorHrId] = useState<string | null>(null);
  const [products, setProducts] = useState<string[]>(() => carriedProducts(customer));
  const [pharmacyName, setPharmacyName] = useState("");
  // At the pharmacy itself (owner, 2026-10-03): the pharmacy is the customer, so there is no other
  // pharmacy to name — only its stock. Every road to a pharmacy opens this form as a pharmacy visit
  // (`routeFor` sends one there first), so the visit type is the one answer, read once.
  const atPharmacy = initialVisitType === "pharmacy";
  const [availability, setAvailability] = useState<Record<string, ProductAvailability>>({});
  // Which families in the pharmacy-stock check are expanded to show their concentrations. A family
  // with a single product is never a group, so it is never in here; the rest start collapsed.
  const [openFamilies, setOpenFamilies] = useState<Set<string>>(() => new Set());
  const [comment, setComment] = useState("");
  // The LAST question (owner, 2026-10-16): "Do you need a double visit with this customer?". It starts
  // on No, and No asks nothing more.
  const [doubleVisit, setDoubleVisit] = useState<DoubleVisitAnswerDraft>(NO_DOUBLE_VISIT);
  // What he took away from the visit. Both start unanswered and both may stay that way: nothing here
  // gates the save, and a rep who taps neither loses nothing.
  const [nextStep, setNextStep] = useState<VisitNextStep | null>(null);
  const [objection, setObjection] = useState<VisitObjection | null>(null);
  const [objectionNote, setObjectionNote] = useState("");
  // What he handed over. A RECORD, never a stock movement — nothing here subtracts from anything.
  const [samples, setSamples] = useState<SamplesGiven>({});
  // The optional steps he has opened on THIS visit. Every visit starts with both of them folded; one
  // tap opens one in place, and it stays open across Next and "Change something", so nothing typed is
  // lost. "What you took away" is not among them since 2026-10-06 — it is simply open (VisitExtra).
  const [openExtras, setOpenExtras] = useState<ReadonlySet<VisitExtra>>(() => new Set());
  // The spoken note, already uploaded by the control. Null is the normal case: it was never required.
  const [voiceNote, setVoiceNote] = useState<VoiceNoteValue | null>(null);
  const [saving, setSaving] = useState(false);
  // What the SERVER (or the missing location) said about the last press. What is still missing on the
  // form is not kept here: the bar reads that live from `draft`, so it moves on by itself as he fills
  // each thing in and can never go stale the way a copied sentence would.
  const [problem, setProblem] = useState<string | null>(null);
  // A location refusal names HIS browser, never "Phoenix" — the setting it sends him to belongs to the
  // browser (use-browser-name.ts). Every other refusal passes through untouched.
  const browserNamed = useBrowserNamed();
  // He pressed Log visit with something still missing. From then on the bar's "Next" line reads as the
  // refusal it is — rose, and announced — instead of a quiet prompt.
  const [tried, setTried] = useState(false);
  // The visit's id, made on the first press of Log visit and kept until the visit is saved, so a save
  // sent again after a dropped connection returns the saved visit instead of a second one.
  const visitIdRef = useRef<string | null>(null);
  // 🔴 SILENT (Golden Rule #1, the BLIND half). Nothing on this screen says it exists, nothing shows
  // it back, and it can never refuse a save — `clampFormOpenSeconds` drops anything odd. It is read
  // only by the Super Admin's integrity board, where a CONSTANT figure across a rep's whole month is
  // the signal and one small value is not.
  //
  // A ref, so it never causes a re-render, and set in an EFFECT rather than at `useRef(Date.now())`:
  // `Date.now` is impure and React forbids calling one during render, because a re-render would move
  // the start of the clock. Null until the form has actually mounted.
  const openedAtRef = useRef<number | null>(null);
  useEffect(() => {
    openedAtRef.current = Date.now();
  }, []);

  // He pressed Cancel or the back arrow once with a recording on the form and was told what it would
  // cost. It is reset the moment he goes back, so the warning is per ATTEMPT to leave rather than
  // once per form — a rep who returns, records a second note and leaves again is told again.
  const [leaveWarning, setLeaveWarning] = useState<VoiceNoteLeaveWarning | null>(null);
  /**
   * 🔴 THE MICROPHONE IS STILL OPEN (or the recording is still going up) — reported by `CrmSpeak`,
   * because the form is the one that can lose it. Step 3 and step 4 are two trees, so Next UNMOUNTS
   * the control and its cleanup CANCELS the recorder: what he had said was thrown away with nothing
   * said to him. Next now stops and tells him to press Stop; Back warns once and then goes.
   */
  const [recording, setRecording] = useState(false);

  /**
   * Leaving the form.
   *
   * The FIRST press with a recording running or unsaved stops and says what he is about to lose; the
   * second leaves, with nothing asked again. Both exits — the back arrow at the top and Cancel at the
   * bottom — come through here, so there is one rule and not two that can drift apart.
   */
  function close() {
    if (saving) return;
    const warning = voiceNoteLeaveWarning({ hasVoiceNote: voiceNote !== null, recording, saving, warned: leaveWarning !== null });
    if (warning) {
      setLeaveWarning(warning);
      return;
    }
    onBack();
  }

  const who = participantsOf(form, seniorHrId);
  // The rep's pick, filed as the visit's slots — or the sentence that says what is still missing. Null
  // for a manager entering, whose own two boxes are checked below.
  const company = form.enteredAs === "rep" ? companyToStorage({ choice: choiceOf(kind), offers: who.offers, picked }) : null;
  const commentLength = comment.trim().length;

  // Each required step, answered or not — the same tests `draft` applies, in the same order, so the
  // header marks and the bar's jump agree with what Log visit would refuse.
  const reasonDone = visitType !== "out_of_plan" || unplannedReason.trim().length >= UNPLANNED_REASON_MIN;
  const whoDone = kind === "single" || (company ? company.ok : who.manager !== null && (kind !== "chain" || who.senior !== null));
  const productsDone = products.length > 0;
  const commentDone = commentLength > 0;
  // The last question is asked of an AM or PM customer when the rep records his own visit, and only
  // where there is somebody to ask and a day to offer. A Yes with nobody or no day ticked is the one
  // thing in it the save refuses.
  const asksDoubleVisit = form.enteredAs === "rep" && !atPharmacy && isDoubleVisitCustomer(customer) && who.offers.length > 0 && form.doubleVisitDays.length > 0;
  const doubleVisitDone = !asksDoubleVisit || !doubleVisit.wanted || (doubleVisit.hrIds.length > 0 && doubleVisit.days.length > 0);
  // A customer already visited today is refused before any step, and there is no box that answers it.
  const openStep = customer.visitedToday
    ? null
    : !reasonDone
      ? STEP_REASON
      : !whoDone
        ? STEP_WHO
        : !productsDone
          ? STEP_PRODUCTS
          : !commentDone
            ? STEP_COMMENT
            : !doubleVisitDone
              ? STEP_DOUBLE
              : null;
  const lastProducts = customer.lastVisit?.products ?? [];

  /** Bring a step into view — mid-screen, clear of the bar held at the bottom. */
  function showStep(step: string | null) {
    if (!step) return;
    // The reason box may be closed behind "Change the reason"; open it, then scroll once it is drawn.
    if (step === STEP_REASON) setReasonOpen(true);
    // Every box lives on step 3: from the read-back on step 4, go back there first.
    if (part === "log") onPart("details");
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => document.getElementById(step)?.scrollIntoView({ behavior: "smooth", block: "center" })),
    );
  }

  /** Step 3's Next: on to the read-back once nothing required is missing, else to the first thing that is. */
  function toLog() {
    if (saving) return;
    // 🔴 THE MICROPHONE FIRST. Next swaps step 3 for the read-back, which unmounts `CrmSpeak` and
    // cancels the recorder — so going on while he is still speaking throws the recording away. He is
    // not leaving, and Stop is one tap away in the panel he is looking at, so the press is answered
    // with what to do instead and nothing is lost.
    if (recording) {
      setTried(true);
      setProblem(RECORDING_IN_FLIGHT_NEXT);
      showStep(STEP_COMMENT);
      return;
    }
    if (openStep !== null) {
      setTried(true);
      showStep(openStep);
      return;
    }
    // Already visited today is the one refusal no box answers; the bar says it, and he stays here.
    if (!check.ok) return;
    setProblem(null);
    onPart("log");
    window.requestAnimationFrame(() => document.querySelector("[data-crm-step-form]")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function toggleProduct(product: string) {
    setProblem(null);
    setProducts((current) =>
      current.includes(product) ? current.filter((entry) => entry !== product) : current.length >= VISIT_PRODUCTS_MAX ? current : [...current, product],
    );
  }

  // One tap either way: clear what came from last time, or put it back. The prefill is a convenience
  // he can see and undo, never a choice made for him.
  function clearProducts() {
    setProblem(null);
    setProducts([]);
  }

  function refillProducts() {
    setProblem(null);
    setProducts(carriedProducts(customer));
  }

  // One step up, wrapping to nothing past the cap: the whole control is one button per item, so a
  // mis-tap is undone by tapping round rather than by a second control.
  function bumpSample(key: string) {
    setProblem(null);
    setSamples((current) => {
      const next = { ...current };
      const count = (next[key] ?? 0) + 1;
      if (count > SAMPLE_QUANTITY_MAX) delete next[key];
      else next[key] = count;
      return next;
    });
  }

  // Tapping the chip that is already chosen clears it: a mis-tap on an optional field must not need a
  // third button to take back.
  function chooseNextStep(next: VisitNextStep) {
    setProblem(null);
    setNextStep((current) => (current === next ? null : next));
  }

  function chooseObjection(next: VisitObjection) {
    setProblem(null);
    setObjection((current) => (current === next ? null : next));
    if (next === "none" || objection === next) setObjectionNote("");
  }

  function setStock(product: string, answer: ProductAvailability) {
    setProblem(null);
    setAvailability((current) => {
      const next = { ...current };
      if (next[product] === answer) delete next[product];
      else next[product] = answer;
      return next;
    });
  }

  function openExtra(extra: VisitExtra) {
    setOpenExtras((current) => new Set(current).add(extra));
  }

  function toggleFamily(family: string) {
    setOpenFamilies((current) => {
      const next = new Set(current);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  }

  function draft(visitId: string, formOpenSeconds: number | null): Draft {
    if (customer.visitedToday) return { ok: false, problem: "This customer's visit for today is already saved." };
    if (visitType === "out_of_plan" && unplannedReason.trim().length < UNPLANNED_REASON_MIN) {
      return { ok: false, problem: "Write why you visited this customer off your plan." };
    }
    // A rep's slots come from the one list (visit-company.ts); a manager's from his own two boxes.
    let slots: { kind: PhoenixCrmVisitKind; managerHrId: string | null; seniorHrId: string | null; productManagerHrId: string | null };
    if (company) {
      if (!company.ok) return { ok: false, problem: company.error };
      slots = company.value;
    } else {
      if (kind !== "single" && !who.manager) return { ok: false, problem: "You are not a manager of this territory. Reload the page." };
      if (kind === "chain" && !who.senior) return { ok: false, problem: "Choose the senior manager who was on the visit." };
      slots = {
        kind,
        managerHrId: kind === "single" ? null : (who.manager?.hrId ?? null),
        seniorHrId: kind === "chain" ? (who.senior?.hrId ?? null) : null,
        productManagerHrId: null,
      };
    }
    if (products.length === 0) return { ok: false, problem: "Choose the products you discussed." };
    // Required (owner, 2026-09-30): typed, or spoken — the spoken words land in the same box.
    if (!comment.trim()) return { ok: false, problem: VISIT_COMMENT_REQUIRED };
    // The last question: a Yes names at least one person and at least one day, or it is not a request.
    if (asksDoubleVisit && doubleVisit.wanted) {
      if (doubleVisit.hrIds.length === 0) return { ok: false, problem: CHOOSE_A_PERSON };
      if (doubleVisit.days.length === 0) return { ok: false, problem: CHOOSE_A_DAY };
    }
    return {
      ok: true,
      customerName: customer.name,
      payload: {
        id: visitId,
        seatId,
        test,
        customerId: customer.customerId,
        // What he chose. The server re-decides it from the plan's own history and the customer's own
        // status, so this only settles whether the reason travels with the visit.
        visitType: visitType === "pharmacy" ? "planned" : visitType,
        unplannedReason: visitType === "out_of_plan" ? unplannedReason.trim() : null,
        kind: slots.kind,
        managerHrId: slots.managerHrId,
        seniorHrId: slots.seniorHrId,
        productManagerHrId: slots.productManagerHrId,
        products,
        // Optional since 2026-09-29: the box stays, a visit is never blocked on it. A pharmacy's own
        // visit has no box — the database names it after the pharmacy itself.
        pharmacyName: atPharmacy ? null : pharmacyName.trim() || null,
        productAvailability: availability,
        samplesGiven: samples,
        // 🔴 SILENT: what the phone counted, read in the event handler and passed in — never taken
        // here, because `draft` runs where React will not allow an impure call.
        formOpenSeconds,
        nextStep,
        nextStepOn: null,
        objection,
        objectionNote: objection && objection !== "none" ? objectionNote.trim() || null : null,
        comment: comment.trim() || null,
        // The spoken note dates nothing: the server's own clock dates the visit.
        voiceNotePath: voiceNote?.path ?? null,
        voiceNoteSeconds: voiceNote?.seconds ?? null,
        voiceNoteBytes: voiceNote?.bytes ?? null,
        // The conversation itself, for a rep the Super Admin switched on. It dates nothing either.
        recordingPath: visitRecording?.path ?? null,
        recordingSeconds: visitRecording?.seconds ?? null,
        // The last question. Null on No; the server raises the request after the visit is saved.
        doubleVisit: asksDoubleVisit && doubleVisit.wanted ? { wanted: true, hrIds: doubleVisit.hrIds, days: doubleVisit.days } : null,
      },
    };
  }

  // `savedAt` is read at the BUTTON, the one place React allows an impure call, and handed in: a
  // re-render must never be able to move the clock.
  async function save(savedAt: number) {
    if (saving) return;
    const visitId = visitIdRef.current ?? newClientId();
    // The clock is read HERE, in the event handler, where an impure call is allowed.
    const openedAt = openedAtRef.current;
    const next = draft(visitId, openedAt === null ? null : Math.max(0, Math.round((savedAt - openedAt) / 1000)));
    if (!next.ok) {
      // The bar already names what is missing, read live from this same check. The press turns that
      // line into a refusal and takes him to the step — nothing is copied, so nothing goes stale.
      setProblem(null);
      setTried(true);
      showStep(openStep);
      return;
    }
    visitIdRef.current = visitId;
    setSaving(true);
    setProblem(null);
    // Read in silence; he sees only "Saving…" while a first reading arrives.
    const fix = await readFix();
    if (!fix) {
      setProblem(NO_FIX_FOR_A_VISIT);
      setSaving(false);
      return;
    }
    try {
      // 🔴 SILENT, and read HERE for the same reason the stopwatch is: `draft` runs where React will
      // not allow an impure call, and reading this one writes to browser storage the first time. It
      // answers null wherever there is no storage to keep it in, and the save is identical either way.
      const saved = await crmPost<SavedVisit>(
        "/api/phoenix-crm/visits",
        { ...next.payload, ...silentFixPayload(fix, savedAt), deviceInstallId: deviceInstallId() },
        "visit",
      );
      // 🔴 HIS DAY ON THE LANDING PAGE GOES GREEN WHEN HE PRESSES BACK (owner, 2026-09-30: "if it is
      // submitted from those visits in the overview landing page, it is automatically marked as
      // done"). The server side was never wrong — `done` is read from the day's saved visits, and a
      // fresh request always showed the tick. What was wrong is the one navigation a rep actually
      // makes: he comes here from the panel's "+" and presses Back, and Next restores a back/forward
      // navigation from the CLIENT router cache, which still held the page as it stood before he
      // logged the visit — the row white, the "+" there, the header "AM 0 of 1".
      //
      // 🔴 `revalidatePath` ON THE SAVE ROUTE DOES NOT FIX THIS AND WAS REMOVED — measured on the
      // preview box that day. The landing page is `force-dynamic`, so there is no server cache to
      // invalidate; the stale copy is in the browser. `router.refresh()` is what empties it.
      router.refresh();
      onSaved(saved, next.customerName);
    } catch (error) {
      const code = errorCodeOf(error);
      if (isVisitRecordingRefusal(code)) {
        // The recording cannot stand on this visit. Add visit drops it and puts the recorder back, with
        // this refusal on it — a Save that could never work is not left on the screen.
        setSaving(false);
        onRecordingRefused?.(messageOf(error));
        return;
      }
      if (code && code.startsWith("phoenix_crm_voice_")) {
        // The slot was already spent, has expired, or never received the audio. Keeping the note would
        // send the rep into the same refusal on every press; dropping it lets him record again. The
        // rest of the form is left exactly as it is — the visit itself is still good.
        setVoiceNote(null);
      } else if (code === "phoenix_crm_clarification_required") {
        // The server's own test says this customer was not on a plan sent for today — the plan moved
        // under him. Open the reason box and keep everything else: he writes one line and logs the
        // SAME visit again.
        setVisitType("out_of_plan");
        setReasonOpen(true);
        // The reason box is on step 3.
        onPart("details");
      } else if (code === "phoenix_crm_id_conflict") {
        visitIdRef.current = null;
      } else if (code === "phoenix_crm_already_visited" || code === "phoenix_crm_customer_dropped" || code === "phoenix_crm_customer_not_found") {
        onReload();
      }
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  // The same draft Log visit builds, read without saving. The bar can only ever name what the save would
  // refuse, in the save's own words, because it IS the save's check — never a second copy of the rules.
  const check = draft("", null);

  const kindLabel = who.options.find((option) => option.value === kind)?.label ?? "Single visit";
  // The people, in the order they were ticked (a rep) or as the manager entering reads them.
  const whoNames = company
    ? picked.map((hrId) => who.offers.find((person) => person.hrId === hrId)?.name)
    : [kind === "double" || kind === "chain" ? who.manager?.name : null, kind === "chain" ? who.senior?.name : null];
  const whoLine = [kindLabel, ...whoNames].filter(Boolean).join(" · ");
  const objectionLabel = objection ? (VISIT_OBJECTIONS.find((entry) => entry.key === objection)?.label ?? null) : null;
  const nextStepLabel = nextStep ? (VISIT_NEXT_STEPS.find((entry) => entry.key === nextStep)?.label ?? null) : null;
  const leftLines = [...form.products.map((product) => ({ key: product, label: product })), ...SAMPLE_MATERIALS]
    .filter((item) => (samples[item.key] ?? 0) > 0)
    .map((item) => `${item.label} × ${samples[item.key]}`);
  const stockAnswered = Object.keys(availability).length;

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Back" onBack={close} title="Log visit" />

      {part === "log" ? (
        // Step 4 (owner, 2026-10-02): the visit read back in one place, then the ONE Log visit below.
        // Nothing here is a box — a change goes back to step 3, where every box is.
        <CrmBlock title="Check the visit, then log it">
          <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
            <SummaryLine label="Customer" value={`${customer.name} · ${logVisitTypeLabel(visitType)}`} />
            {visitType === "out_of_plan" ? <SummaryLine label="Why you went" value={unplannedReason.trim() || "Not written yet"} /> : null}
            <SummaryLine label="Who was on the visit" value={whoLine} />
            <SummaryLine label="Products discussed" value={products.length > 0 ? products.join(", ") : "None chosen yet"} />
            <SummaryLine
              label="Comment"
              value={`${comment.trim() || "Not written yet"}${voiceNote ? "\nYour voice note is kept with the visit." : ""}`}
            />
            {pharmacyName.trim() || stockAnswered > 0 ? (
              <SummaryLine
                label="Pharmacy"
                value={[pharmacyName.trim() || null, stockAnswered > 0 ? `${stockAnswered} ${stockAnswered === 1 ? "product" : "products"} answered` : null]
                  .filter(Boolean)
                  .join(" · ")}
              />
            ) : null}
            {leftLines.length > 0 ? <SummaryLine label="What you left" value={leftLines.join(", ")} /> : null}
            {asksDoubleVisit && doubleVisit.wanted ? (
              <SummaryLine
                label="Double visit asked"
                value={`${doubleVisit.hrIds.map((hrId) => who.offers.find((person) => person.hrId === hrId)?.name).filter(Boolean).join(", ")} · ${[...doubleVisit.days]
                  .sort()
                  .map((day) => dayLabel(day))
                  .join(" or ")}`}
              />
            ) : null}
            {objectionLabel || nextStepLabel ? (
              <SummaryLine label="What you took away" value={[objectionLabel, nextStepLabel].filter(Boolean).join(" · ")} />
            ) : null}
          </dl>
          <CrmButton className="mt-4" disabled={saving} onClick={() => onPart("details")}>
            Change something
          </CrmButton>
        </CrmBlock>
      ) : (
        <>
      <CrmBlock title="1 · Customer">
        <div className="min-w-0 border border-l-[3px] border-orange-200 border-l-orange-500 bg-orange-50/50 px-3 py-2.5">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 flex-1 break-words text-base font-black text-slate-950">{customer.name}</p>
            <CrmPill tone={visitType === "planned" || visitType === "pharmacy" ? "good" : "orange"}>{logVisitTypeLabel(visitType)}</CrmPill>
          </div>
          <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</p>
          <PlaceWindows customer={customer} />
          {customer.outside ? null : (
            <p className="mt-1 text-xs font-semibold text-slate-600">
              {customer.pending ? pendingVisitsText(customer.visitsThisMonth) : monthVisitsText(customer.visitsThisMonth, customer.target)}
            </p>
          )}
          {/* The way to his saved place, when one is saved (owner, 2026-10-02). A new tab, so this form
              is exactly as he left it when he comes back. */}
          <DirectionsLink className="mt-2" customerName={customer.name} href={customerDirectionsUrl(customer)} />
        </div>
        {/* The whole reason the next step is worth writing down: it comes back to him at the door, where
            he can still act on it — so it sits right under the customer's name, the first thing he
            reads. A reminder, never a check. */}
        {customer.lastNextStep ? (
          <CrmNote className="mt-2" tone="info">
            Last time you said you would {customer.lastNextStep.label.toLowerCase()}
            {customer.lastNextStep.dueOn ? `, by ${dayLabel(customer.lastNextStep.dueOn)}` : ""}.
          </CrmNote>
        ) : null}
        {/* Never a warning and never a gate: he logs this visit exactly as he would any other. The one
            thing worth saying is what validating buys him. */}
        {customer.pending ? (
          <CrmNote className="mt-2" title={PENDING_PILL} tone="info">
            {PENDING_COUNTS_NOTE}
          </CrmNote>
        ) : null}
        {customer.visitedToday ? (
          <CrmNote className="mt-2" tone="info">
            This customer&apos;s visit for today is already saved.
          </CrmNote>
        ) : null}
        {visitType === "out_of_list" ? (
          <CrmNote className="mt-2" title="Out of list" tone="info">
            {OUT_OF_LIST_REP_NOTE}
          </CrmNote>
        ) : null}
        {visitType === "out_of_plan" && !reasonOpen ? (
          <CrmNote className="mt-2" title="Out of plan · it counts once it is approved" tone="info">
            <span className="block whitespace-pre-line" dir="auto">
              {unplannedReason}
            </span>
            <span className="mt-1 block">{decidersText(form)}</span>
            <CrmButton className="mt-2" disabled={saving} onClick={() => setReasonOpen(true)}>
              Change the reason
            </CrmButton>
          </CrmNote>
        ) : null}
        {visitType === "out_of_plan" && reasonOpen ? (
          <div className="mt-3 grid min-w-0 gap-2">
            <CrmNote title="This customer is not on today's sent plan" tone="info">
              Write why you went. {decidersText(form)} Until then it counts in nothing — not your call rate, not coverage, not frequency.
            </CrmNote>
            <CrmField
              hint={
                unplannedReason.trim().length < UNPLANNED_REASON_MIN
                  ? `At least ${UNPLANNED_REASON_MIN} characters.`
                  : `${UNPLANNED_REASON_MAX - unplannedReason.length} characters left.`
              }
              htmlFor={STEP_REASON}
              label="Why you went"
            >
              <textarea
                className={crmTextareaClassName}
                dir="auto"
                disabled={saving}
                id={STEP_REASON}
                maxLength={UNPLANNED_REASON_MAX}
                onChange={(event) => {
                  setProblem(null);
                  setUnplannedReason(event.target.value);
                }}
                placeholder="A sentence your manager can act on — what took you there."
                rows={3}
                value={unplannedReason}
              />
            </CrmField>
          </div>
        ) : null}
      </CrmBlock>

      <CrmBlock actions={stepMark(whoDone ? "done" : "required")} className="border-t border-slate-100" title="2 · Who was on the visit">
        <div className="grid min-w-0 gap-3" id={STEP_WHO}>
          <CrmChoice
            // The count follows the options: four for a rep whose line has product managers, three for a
            // manager entering his own (he is never offered that choice). A fixed 4 would leave a hole in
            // the last row of his three, which is the unfinished look the owner called out on the List.
            columns={who.options.length >= 4 ? 4 : 3}
            label="Who was on the visit"
            onChange={(next) => {
              setProblem(null);
              setKind(next);
              // Fewer places than he had ticked: keep the first ones, so changing his mind costs no re-tap.
              setPicked((current) => current.slice(0, COMPANY_PICKS[choiceOf(next)]));
            }}
            options={who.options.map((option) => ({ ...option, disabled: option.disabled || saving }))}
            value={kind}
          />
          {form.enteredAs === "manager" && form.ownVisitClosed && !enteringManagerHasRep(form) ? (
            <p className="text-xs font-semibold leading-5 text-amber-800">
              This territory has no rep to go with. Log a visit you make alone under My single visits on the Visits tab.
            </p>
          ) : null}
          {form.enteredAs === "rep" && (kind === "double" || kind === "chain") ? (
            <CompanyPicker
              choice={kind}
              disabled={saving}
              onChange={(next) => {
                setProblem(null);
                setPicked(next);
              }}
              people={who.offers}
              picked={picked}
            />
          ) : null}
          {form.enteredAs === "manager" && kind === "chain" ? (
            <CrmField label="The senior manager">
              {who.seniorOptions.length > 0 ? (
                <CrmChoice
                  columns={2}
                  label="The senior manager"
                  onChange={(next) => {
                    setProblem(null);
                    setSeniorHrId(next);
                  }}
                  options={personOptions(who.seniorOptions).map((option) => ({ ...option, disabled: saving }))}
                  value={who.senior?.hrId ?? null}
                />
              ) : (
                <p className="text-sm font-semibold text-slate-500">No senior manager sits above the manager you chose.</p>
              )}
            </CrmField>
          ) : null}
        </div>
      </CrmBlock>

      <CrmBlock actions={stepMark(productsDone ? "done" : "required")} className="border-t border-slate-100" title="3 · Products discussed">
        {/* GOLDEN RULE #1, the EASY half: the prefill is said out loud ABOVE the grid, before he reads a
            single tick, with one tap to clear it and one to put it back. A silent prefill he cannot see
            the source of is worse than asking. */}
        {customer.lastVisit && lastProducts.length > 0 ? (
          <div className="mb-2 grid min-w-0 gap-2 border border-orange-200 bg-orange-50/60 px-3 py-2 sm:flex sm:items-center">
            <p className="flex min-w-0 flex-1 items-start gap-2 text-xs font-semibold leading-5 text-orange-900">
              <History aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />
              <span className="min-w-0 break-words">
                {productsDone
                  ? `Filled in from your last visit on ${dayLabel(customer.lastVisit.date)}. Change any of them.`
                  : `Cleared. Your last visit on ${dayLabel(customer.lastVisit.date)} goes back in with one tap.`}
              </span>
            </p>
            <CrmButton className="justify-self-start" disabled={saving} onClick={productsDone ? clearProducts : refillProducts}>
              {productsDone ? "Clear all" : "Fill in again"}
            </CrmButton>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" id={STEP_PRODUCTS}>
          {form.products.map((product) => {
            const chosen = products.includes(product);
            return (
              <button
                aria-pressed={chosen}
                className={cn(
                  "flex min-h-11 min-w-0 items-start justify-between gap-2 rounded-none border px-3 py-2 text-left text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50",
                  chosen ? "border-orange-500 bg-orange-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                )}
                disabled={saving || (!chosen && products.length >= VISIT_PRODUCTS_MAX)}
                key={product}
                onClick={() => toggleProduct(product)}
                type="button"
              >
                <span className="min-w-0 break-words">{product}</span>
                {chosen ? <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> : null}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs font-semibold text-slate-500">
          {products.length === 0 ? `Choose up to ${VISIT_PRODUCTS_MAX}.` : `${products.length} chosen, up to ${VISIT_PRODUCTS_MAX}.`}
        </p>
      </CrmBlock>

      {/* Straight after the products since 2026-09-30, when it became required: the two things the save
          needs sit together, before anything it does not. */}
      <CrmBlock actions={stepMark(commentDone ? "done" : "required")} className="border-t border-slate-100" title="4 · Comment">
        <CrmField
          error={commentLength > VISIT_COMMENT_MAX ? `Keep the comment under ${VISIT_COMMENT_MAX} characters.` : null}
          hint={`Required — type it or speak it · ${commentLength} of ${VISIT_COMMENT_MAX} characters`}
          htmlFor={STEP_COMMENT}
          label="What happened on the visit"
        >
          {/* dir="auto" so a comment spoken or typed in Arabic reads right-to-left. */}
          {/* scroll-mb keeps the box clear of the sticky Log visit bar when the phone scrolls it into view
              for typing. */}
          <textarea
            className={cn(crmTextareaClassName, "scroll-mb-48")}
            dir="auto"
            disabled={saving}
            id={STEP_COMMENT}
            maxLength={VISIT_COMMENT_MAX}
            onChange={(event) => {
              setProblem(null);
              setComment(event.target.value);
            }}
            placeholder="What the customer said, and what you agreed."
            value={comment}
          />
        </CrmField>
        {/* ONE control, both outcomes (owner, 2026-09-25): he speaks once, the words are written here as
            they settle and the audio is kept with the visit. The cap is applied here, not by the
            textarea: `maxLength` constrains TYPING and does nothing to a programmatic append, so a long
            spoken comment would push the field past VISIT_COMMENT_MAX and the server would refuse. */}
        <CrmSpeak
          disabled={saving}
          onAppend={(spoken) => setComment((current) => appendDictated(current, spoken, VISIT_COMMENT_MAX))}
          onBusy={setRecording}
          onChange={setVoiceNote}
          seatId={seatId}
          test={test}
          value={voiceNote}
        />
      </CrmBlock>

      {/* The line between what the save needs and what it does not. Everything under it may stay blank and
          the visit is still whole — said once, here, rather than as a nag on every box. */}
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-y border-slate-200 bg-slate-50 px-4 py-2.5 sm:px-5">
        <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-600">Optional</p>
        <p className="min-w-0 break-words text-xs font-semibold text-slate-500">The visit logs without these. Add what helps.</p>
      </div>

      <CrmBlock actions={stepMark("optional")} title="5 · Pharmacy you took feedback from">
        {openExtras.has("pharmacy") ? (
          <>
        {atPharmacy ? null : (
          <CrmField
            hint="Your pharmacies and the ones you named before appear as you type. It is logged as a visit to that pharmacy too."
            htmlFor="phoenix-crm-visit-pharmacy"
            label="Pharmacy name"
          >
            <input
              autoComplete="off"
              className={crmInputClassName}
              disabled={saving}
              id="phoenix-crm-visit-pharmacy"
              list="phoenix-crm-pharmacies"
              maxLength={PHARMACY_NAME_MAX}
              onChange={(event) => {
                setProblem(null);
                setPharmacyName(event.target.value);
              }}
              placeholder="e.g. El Ezaby — Nasr City"
              value={pharmacyName}
            />
            {form.pharmacies.length > 0 ? (
              <datalist id="phoenix-crm-pharmacies">
                {form.pharmacies.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            ) : null}
          </CrmField>
        )}

        <div className="mt-3 min-w-0">
          <p className="text-sm font-black text-slate-800">Does this pharmacy have these products?</p>
          <p className="mt-0.5 text-xs font-semibold text-slate-500">Answer the ones you checked — leave the rest blank.</p>
          <div className="mt-2 grid min-w-0 gap-1.5">
            {form.productFamilies.map((family) => {
              // A family with one product is answered directly — nothing to expand.
              if (family.products.length <= 1) {
                const product = family.products[0] ?? family.family;
                return <AvailabilityRow answer={availability[product]} disabled={saving} key={family.family} onSet={setStock} product={product} />;
              }
              // A family with several concentrations is a group: a header that expands to its products,
              // with a badge of how many of them have been answered so far.
              const open = openFamilies.has(family.family);
              const answered = family.products.filter((product) => availability[product]).length;
              return (
                <div className="min-w-0 border border-slate-200 bg-white" key={family.family}>
                  <button
                    aria-expanded={open}
                    className="flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-none px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={saving}
                    onClick={() => toggleFamily(family.family)}
                    type="button"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <ChevronRight className={cn("h-4 w-4 shrink-0 text-slate-400 transition-transform", open && "rotate-90")} />
                      <span className="min-w-0 break-words text-sm font-black text-slate-700">{family.family}</span>
                    </span>
                    <span className="shrink-0 text-xs font-black text-slate-500">
                      {answered > 0 ? `${answered}/${family.products.length}` : `${family.products.length}`}
                    </span>
                  </button>
                  {open ? (
                    <div className="grid min-w-0 gap-1.5 border-t border-slate-100 p-2">
                      {family.products.map((product) => (
                        <AvailabilityRow answer={availability[product]} disabled={saving} key={product} onSet={setStock} product={product} />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
          </>
        ) : (
          <FoldedStep
            disabled={saving}
            label={atPharmacy ? "Add the stock" : "Add the pharmacy"}
            note={atPharmacy ? "Which of your products it has." : "Its name, and which of your products it has."}
            onOpen={() => openExtra("pharmacy")}
          />
        )}
      </CrmBlock>

      <CrmBlock actions={stepMark("optional")} className="border-t border-slate-100" title="6 · What you left">
        {openExtras.has("left") ? (
          <>
        {/* A RECORD of what he handed over, never a stock movement: nothing subtracts, nothing is
            allocated, and no balance exists anywhere. */}
        <p className="text-xs font-semibold text-slate-500">Tap once for each one you left.</p>
        <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {[...form.products.map((product) => ({ key: product, label: product })), ...SAMPLE_MATERIALS].map((item) => {
            const count = samples[item.key] ?? 0;
            return (
              <button
                aria-label={`${item.label}: ${count}`}
                className={cn(
                  "flex min-h-11 min-w-0 items-center justify-between gap-2 rounded-none border px-3 py-2 text-left text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50",
                  count > 0 ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                )}
                disabled={saving}
                key={item.key}
                onClick={() => bumpSample(item.key)}
                type="button"
              >
                <span className="min-w-0 break-words">{item.label}</span>
                {count > 0 ? <span className="shrink-0 text-xs font-black">× {count}</span> : null}
              </button>
            );
          })}
        </div>
          </>
        ) : (
          <FoldedStep disabled={saving} label="Add what you left" note="Samples and materials, one tap for each." onOpen={() => openExtra("left")} />
        )}
      </CrmBlock>

      <CrmBlock actions={stepMark("optional")} className="border-t border-slate-100" title="7 · What you took away">
        {/* 🔴 OPEN, NOT FOLDED (owner, 2026-10-06: "unfold objection and next step in Phoenix CRM").
            Both are still OPTIONAL — nothing here gates the save and a rep who taps neither loses
            nothing — but the chips are in view instead of behind a tap. There is no folded branch to
            fall back to: a step that can never be folded must not carry the row that folds it.

            Both optional, both taps. The objection is the CUSTOMER's, never a mark against him, and the
            next step comes back to him at the door next time. */}
        <p className="text-sm font-black text-slate-800">Did the customer push back on anything?</p>
        <CrmChoice
          className="mt-2"
          label="What the customer pushed back on"
          onChange={chooseObjection}
          options={VISIT_OBJECTIONS.map((entry) => ({ value: entry.key, label: entry.label, disabled: saving }))}
          value={objection}
        />
        {objection && objection !== "none" ? (
          <CrmField
            className="mt-3"
            hint={`Optional · ${objectionNote.trim().length} of ${OBJECTION_NOTE_MAX} characters`}
            htmlFor="phoenix-crm-visit-objection-note"
            label="In the customer's own words"
          >
            <input
              className={crmInputClassName}
              dir="auto"
              disabled={saving}
              id="phoenix-crm-visit-objection-note"
              maxLength={OBJECTION_NOTE_MAX}
              onChange={(event) => setObjectionNote(event.target.value)}
              placeholder="e.g. the 30-tablet pack is too big for most patients"
              value={objectionNote}
            />
          </CrmField>
        ) : null}

        <p className="mt-4 text-sm font-black text-slate-800">What will you do next?</p>
        <CrmChoice
          className="mt-2"
          label="What you will do next"
          onChange={chooseNextStep}
          options={VISIT_NEXT_STEPS.map((entry) => ({ value: entry.key, label: entry.label, disabled: saving }))}
          value={nextStep}
        />
        {isFollowUp(nextStep) ? <p className="mt-2 text-xs font-semibold text-slate-500">It comes back to you at this customer&apos;s door next time.</p> : null}
      </CrmBlock>

      {/* THE LAST QUESTION (owner, 2026-10-16). Not a numbered step: it is asked of an AM or PM customer
          only, so the numbering the phone's form shares never changes for a pharmacy or a manager. It
          starts on No and a No asks nothing more. */}
      {asksDoubleVisit ? (
        <CrmBlock actions={stepMark("optional")} className="border-t border-slate-100" title="Do you need a double visit with this customer?">
          <DoubleVisitQuestion
            cairoToday={form.cairoToday}
            dayChoices={form.doubleVisitDays}
            disabled={saving}
            offers={who.offers}
            onChange={(next) => {
              setProblem(null);
              setDoubleVisit(next);
            }}
            value={doubleVisit}
          />
        </CrmBlock>
      ) : null}
        </>
      )}

      {/* Log visit, held above the portal's bottom bar on phones (the app sets --crm-sticky-bottom to its
          height) the way the plan's save bar is: under his thumb wherever he has scrolled to. It is still
          the form's ONE way to save — the press is read at the button and `save` keeps its own
          single-flight guard — and it says the one thing still missing before he taps, not after. */}
      <div className="sticky bottom-[var(--crm-sticky-bottom,0px)] z-20 border-t border-orange-300 bg-white px-4 py-3 shadow-[0_-10px_30px_rgba(15,23,42,0.12)] sm:px-5 lg:bottom-0">
        {/* He tried to leave with a recording on the form. Said HERE, in the bar, so it is in view from
            either exit — the back arrow at the top or Cancel at the bottom. It states the mechanism and
            offers both doors: "Leave without it" always works, because a guard he cannot get out of is a
            trap. */}
        {leaveWarning ? (
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-56">
              <p className="break-words text-sm font-black text-slate-950">{leaveWarning.title}</p>
              <p className="break-words text-xs font-semibold leading-5 text-slate-500">{leaveWarning.message}</p>
            </div>
            <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
              <CrmButton onClick={() => setLeaveWarning(null)} variant="primary">
                {UNSAVED_VOICE_NOTE_STAY_LABEL}
              </CrmButton>
              <CrmButton onClick={close}>{UNSAVED_VOICE_NOTE_LEAVE_LABEL}</CrmButton>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <div aria-live="polite" className="min-w-0 flex-1 basis-56">
              {problem ? (
                <p className="flex min-w-0 items-start gap-2 text-sm font-black text-rose-700">
                  <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0 break-words">{browserNamed(problem)}</span>
                </p>
              ) : check.ok ? (
                <p className="flex min-w-0 items-start gap-2">
                  <CircleCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <span className="min-w-0">
                    <span className="block break-words text-sm font-black text-slate-950">Ready to log</span>
                    <span className="block break-words text-xs font-semibold leading-5 text-slate-500">The optional steps can stay blank.</span>
                  </span>
                </p>
              ) : (
                // The ONE next missing thing, in the save's own words — a tap takes him to it.
                <button
                  className="flex min-h-11 w-full min-w-0 items-start gap-2 rounded-none text-left disabled:cursor-default"
                  disabled={openStep === null}
                  onClick={() => showStep(openStep)}
                  type="button"
                >
                  <ArrowDown aria-hidden className={cn("mt-0.5 h-4 w-4 shrink-0", tried ? "text-rose-600" : "text-orange-600")} />
                  <span className="min-w-0">
                    <span className={cn("block text-phx-2xs font-black uppercase tracking-[0.16em]", tried ? "text-rose-600" : "text-orange-600")}>
                      {tried ? "Still needed" : "Next"}
                    </span>
                    <span className={cn("block break-words text-sm font-black", tried ? "text-rose-700" : "text-slate-950")}>{check.problem}</span>
                  </span>
                </button>
              )}
            </div>
            {/* The step form's foot, held under his thumb (owner, 2026-10-02): Back on the left, the way
                on at the right — Next on step 3, the ONE Log visit on step 4. Back from step 3 is the
                form's own exit (it still warns about an unsaved recording); from step 4 it returns to
                the boxes. */}
            <div className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 sm:flex sm:w-auto sm:flex-row-reverse">
              {part === "log" ? (
                <CrmButton busy={saving} className="min-h-12 text-base sm:min-w-40" onClick={() => void save(Date.now())} variant="primary">
                  {saving ? "Saving…" : "Log visit"}
                </CrmButton>
              ) : (
                <button className={cn(crmStepNextClassName, "min-h-12 justify-center text-base sm:min-w-40")} disabled={saving} onClick={toLog} type="button">
                  Next
                  <ChevronRight aria-hidden className="h-4 w-4" />
                </button>
              )}
              <button
                className={cn(crmStepBackClassName, "order-first min-h-12 justify-center sm:order-none")}
                disabled={saving}
                onClick={part === "log" ? () => onPart("details") : close}
                type="button"
              >
                <ChevronLeft aria-hidden className="h-4 w-4" />
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </CrmPanel>
  );
}
