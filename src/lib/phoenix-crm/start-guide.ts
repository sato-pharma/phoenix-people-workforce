/**
 * Phoenix CRM — the one-page start guide a District Manager sends a rep, in English and Arabic.
 *
 * WHY IT IS A SYSTEM DOCUMENT AND NOT A FILE SOMEBODY KEEPS. It was first built as a one-off page in
 * a scratchpad, which is exactly how a company document rots: the app's wording changes, the guide
 * does not, and a rep is sent looking for a button that was renamed a month ago. Here the guide sits
 * beside the screens it describes, wears the HR premium identity from the module that owns it, and is
 * built from the code that serves it — once per language per server process since 2026-10-16 (the
 * route keeps the page; a deploy starts a new process, which is the only time the text can change).
 * That is why this builder must stay a pure function of the language: no clock, no person, no data.
 *
 * 🔴 IT IS UPDATED IN THE SAME PR AS THE FLOW IT DESCRIBES — BOTH LANGUAGES, NEVER ONE (owner,
 * 2026-10-01: "UPDATE AND KEEP ALWAYS UPDATED ARABIC OR EN"). A change to the rep's screens that
 * leaves this page alone is the rot the module header above describes, and the Arabic page is the
 * half that gets forgotten, because the English one is the half a reviewer reads. What the test can
 * enforce mechanically, it does: every label either page names must still exist as a real string in
 * `src/components/phoenix-crm/`, every label they use must be registered in START_GUIDE_UI_LABELS,
 * the deadline for logging a visit is read from `VISIT_DAY_CUTOFF_HOURS` rather than typed, and both
 * pages must carry the same count of steps and notes. What it cannot enforce is a NEW field nobody
 * mentioned here — so adding one to the rep's flow means adding a line to both pages in that PR.
 *
 * 🔴 NOTHING ON EITHER PAGE TELLS A REP HE IS BEING CHECKED — no distance, no accuracy, no flag, not
 * the existence of a check. That is Golden Rule #1's BLIND half (`AGENTS.md` §4), and a start guide
 * is precisely where a well-meaning sentence about "making sure you are at the clinic" would land.
 * `tests/phoenix-crm-start-guide.test.ts` asserts the silent vocabulary never appears here.
 *
 * 🔴 THE BUTTON NAMES STAY ENGLISH ON THE ARABIC PAGE, AND EACH IS ISOLATED IN <bdi>. They stay
 * English because they are English ON HIS SCREEN — an Arabic guide naming them in Arabic sends a rep
 * hunting for words the app does not contain. They are isolated because an English run inside an
 * Arabic paragraph drags the NEUTRAL characters beside it: the full stop after "Save" has no strong
 * direction of its own, so the bidirectional algorithm resolves it to the paragraph and paints it at
 * the LEFT end of the run. `<bdi>` keeps the punctuation with the run. This is the same failure
 * `house-identity.ts` documents on its own letterhead, one level further in.
 *
 * 🔴 AND THEY NEVER BREAK ACROSS A LINE. Measured before this landed: "Unplanned visit" wrapped with
 * "Unplanned" ending one line and "visit" starting the next, which a rep has to reassemble before he
 * can match it against his screen — and matching it is the ONLY reason these are in English at all.
 */

import { HOUSE_IDENTITY_CSS, HOUSE_TYPE, type HouseLetterheadInput } from "@/lib/hiring-pack/house-identity";
import {
  PREMIUM_COMPANY_DOCUMENT_BRAND,
  PREMIUM_IDENTITY_CSS,
  premiumLetterhead,
  premiumPageChrome,
  premiumSheetCss,
} from "@/lib/hiring-pack/premium-identity";
import { systemLegalEntity } from "@/config/system-settings";
// 🔴 THE DEADLINE IS INTERPOLATED, NEVER TYPED (owner, 2026-10-02 — the hour goes on every due date a
// rep reads). Both halves of this guide said "the Thursday before it" with no hour, and the guide is
// the one page a new rep is handed: it taught him the cut-off was midnight. One constant, so the hour
// here can never drift from the deadline the server stamps him late against.
import { PLAN_DEADLINE_LABEL } from "@/lib/phoenix-crm/calendar";

export type StartGuideLanguage = "en" | "ar";

export const START_GUIDE_LANGUAGES: readonly StartGuideLanguage[] = ["en", "ar"] as const;

/** The document code every Sato paper carries. Read by the test, so it cannot drift silently. */
export const START_GUIDE_DOCUMENT_CODE = "SATO-DIS-2026-01 v1.0";

export function isStartGuideLanguage(value: unknown): value is StartGuideLanguage {
  return typeof value === "string" && (START_GUIDE_LANGUAGES as readonly string[]).includes(value);
}

/**
 * An English UI label, isolated and unbreakable.
 *
 * Exported so the test can assert that EVERY English label on the Arabic page went through it,
 * rather than asserting that some did.
 */
export function startGuideUiLabel(label: string): string {
  return `<bdi><strong>${label}</strong></bdi>`;
}

const ui = startGuideUiLabel;

/**
 * The labels this guide names, exactly as the screens spell them.
 *
 * 🔴 KEPT HONEST IN BOTH DIRECTIONS BY THE TEST, because a hand-kept list like this is the half that
 * rots: every label the pages actually use must be registered here — or it escapes the `<bdi>` check
 * and ships bare on the Arabic page — and every label registered here must still exist as a real
 * string in `src/components/phoenix-crm/`, or the guide is sending a rep to a button that was
 * renamed. "Capture location" sat on both pages while missing from this list, uncaught for exactly
 * that reason.
 */
export const START_GUIDE_UI_LABELS = [
  "Visits",
  "Planned visit",
  "Unplanned visit",
  "Out of plan",
  "Out of list",
  "AM",
  "PM",
  "Log visit",
  "List",
  "Validate",
  "Open",
  "Capture location",
  "Phone",
  "Change the details",
  // The plan, one week at a time (owner, 2026-10-01).
  "Plan",
  "Send this week",
  "Ask to edit this week",
] as const;

interface GuideContent {
  dir: "ltr" | "rtl";
  lang: string;
  head: Omit<HouseLetterheadInput, "legalNameAr" | "legalNameEn">;
  lead: string;
  steps: readonly (readonly [string, string])[];
  notes: readonly (readonly [string, string])[];
  footer: string;
  downloadName: string;
}

const CONTENT: Record<StartGuideLanguage, GuideContent> = {
  en: {
    dir: "ltr",
    lang: "en",
    downloadName: "Phoenix CRM - Recording a Visit.html",
    head: {
      titleEn: "Phoenix CRM — Recording a Visit",
      titleAr: "تسجيل الزيارة",
      subtitleEn: "For medical representatives",
    },
    lead: "Your customer list is already in the app. Recording a visit is a few taps — no photo.",
    steps: [
      [
        "Open Visits and choose the type first",
        `${ui("Planned visit")} offers the customers on the plan you sent for today. For anybody else choose ${ui("Unplanned visit")}: ${ui("Out of plan")} is someone on your list — write one line saying why you went; ${ui("Out of list")} is someone who is not on your list yet.`,
      ],
      [
        // 🔴 "Choose the customer", NEVER "the doctor". The owner's rule of 2026-09-23 — "make it ALL
        // AM PM not doctors and accounts" — governs every screen string in this module, and this page
        // is one of them. `tests/phoenix-crm-am-pm-words.test.ts` caught the first draft of this line.
        "Choose the customer",
        "Your plan is grouped by brick, in the order you will travel. You do not need to add anybody.",
      ],
      [
        "Someone not on your list",
        `With ${ui("Out of list")} choose ${ui("AM")} or ${ui("PM")} yourself, write the name, the speciality and their ${ui("Phone")} if you have it, then photograph the clinic sign, press ${ui("Capture location")} and set the days and hours — once, for good. After the visit, ask on the ${ui("List")} to add them to your list.`,
      ],
      [
        "Fill in the visit",
        "Single, double or chain. The products you discussed come back filled in from last time, with the date they came from. Samples, the pharmacy stock and the next step are there if you need them.",
      ],
      [
        "Write the comment, or say it",
        `<strong>The comment is required.</strong> Type it, or say it and the words are written for you. A voice note is stored only when you press ${ui("Log visit")} — recording one on its own saves nothing.`,
      ],
      [
        `Press ${ui("Log visit")}`,
        "<strong>Log visit is one tap</strong>: the time is taken for you and there is no photo to take. You can log today's visits until 2 AM.",
      ],
    ],
    notes: [
      [
        "Validating a customer",
        `On the ${ui("List")}, a customer not validated yet has ${ui("Validate")}: one live photo of the clinic sign (it keeps its own location), ${ui("Capture location")} for the location once more, their ${ui("Phone")} if you have it, and the days and hours — once, for good. A validated customer has ${ui("Open")}. The phone is optional: add or correct it any time with ${ui("Change the details")}.`,
      ],
      [
        "Your plan",
        `You plan one week at a time: the coming week, due on the Thursday before it at ${PLAN_DEADLINE_LABEL}. Open ${ui("Plan")}, pick a day, tick your customers and press ${ui("Send this week")}. A late week is still accepted. To change a week you already sent, press ${ui("Ask to edit this week")}: your district manager, then SFE, then HR approve it.`,
      ],
    ],
    footer: "Sato Pharma · Phoenix CRM",
  },

  ar: {
    dir: "rtl",
    lang: "ar",
    downloadName: "Phoenix CRM - تسجيل الزيارة.html",
    // Arabic-led: no `titleEn`, so the letterhead emits its original Arabic-only shape.
    head: { titleAr: "تسجيل الزيارة", subtitleAr: "لمندوبي الدعاية الطبية" },
    lead: "قائمة عملائك موجودة بالفعل في التطبيق. تسجيل الزيارة لمسات قليلة — بدون صورة.",
    steps: [
      [
        `افتح ${ui("Visits")} واختر نوع الزيارة أولاً`,
        `تعرض ${ui("Planned visit")} العملاء الموجودين في الخطة التي أرسلتها لهذا اليوم. لأي عميل آخر اختر ${ui("Unplanned visit")}: ${ui("Out of plan")} لعميل في قائمتك — اكتب سطراً واحداً عن سبب الزيارة، و${ui("Out of list")} لعميل ليس في قائمتك بعد.`,
      ],
      [
        // The Arabic half of the same rule. The AM/PM test reads English and would never have caught
        // this one, which is exactly why it is corrected by hand rather than left because CI was green.
        "اختر العميل",
        "خطتك مرتبة حسب البريك، بالترتيب الذي ستتحرك به. لست بحاجة إلى إضافة أحد.",
      ],
      [
        "عميل ليس في قائمتك",
        `مع ${ui("Out of list")} اختر ${ui("AM")} أو ${ui("PM")} بنفسك، واكتب الاسم والتخصص ورقم ${ui("Phone")} إن كان معك، ثم صوّر لافتة العيادة واضغط ${ui("Capture location")} وسجّل الأيام والمواعيد — مرة واحدة فقط. بعد الزيارة اطلب من ${ui("List")} إضافته إلى قائمتك.`,
      ],
      [
        "أكمل بيانات الزيارة",
        "زيارة فردية أو مزدوجة أو متسلسلة. المنتجات التي تحدثت عنها تعود مُدخلة من المرة السابقة ومعها تاريخها. العينات ومخزون الصيدلية والخطوة التالية موجودة إن احتجتها.",
      ],
      [
        "اكتب التعليق أو قله",
        `<strong>التعليق مطلوب.</strong> اكتبه، أو قله وتُكتب الكلمات لك. الملاحظة الصوتية لا تُحفظ إلا عند الضغط على ${ui("Log visit")} — وتسجيلها وحده لا يحفظ شيئاً.`,
      ],
      [
        `اضغط ${ui("Log visit")}`,
        "<strong>تسجيل الزيارة ضغطة واحدة</strong>: الوقت يُسجَّل تلقائياً ولا توجد صورة. يمكنك تسجيل زيارات اليوم حتى الساعة الثانية صباحاً.",
      ],
    ],
    notes: [
      [
        "اعتماد العميل",
        `في ${ui("List")}، العميل الذي لم يُعتمد بعد عليه زر ${ui("Validate")}: صورة حية واحدة للافتة العيادة (بموقعها)، وزر ${ui("Capture location")} لالتقاط الموقع مرة أخرى، ورقم ${ui("Phone")} إن كان معك، والأيام والمواعيد — مرة واحدة وإلى الأبد. العميل المعتمد عليه زر ${ui("Open")}. ورقم الهاتف اختياري: أضفه أو صحّحه في أي وقت من ${ui("Change the details")}.`,
      ],
      [
        "خطتك",
        `تخطط أسبوعاً واحداً في كل مرة: الأسبوع القادم، وموعده الخميس الذي يسبقه الساعة <bdi>${PLAN_DEADLINE_LABEL}</bdi>. افتح ${ui("Plan")}، واختر اليوم، وعلّم على عملائك، ثم اضغط ${ui("Send this week")}. الأسبوع المتأخر مقبول أيضاً. لتعديل أسبوع أرسلته اضغط ${ui("Ask to edit this week")}: يوافق مدير المنطقة، ثم SFE، ثم الموارد البشرية.`,
      ],
    ],
    footer: "ساتو فارما · Phoenix CRM",
  },
};

/** The file name the browser offers when the guide is downloaded. */
export function startGuideDownloadName(language: StartGuideLanguage): string {
  return CONTENT[language].downloadName;
}

/**
 * The guide as a complete HTML document, ready to print or save as PDF.
 *
 * HTML rather than a server-rendered PDF because this app has no server-side PDF renderer and is not
 * gaining one for a single page: every house paper here is HTML the browser prints, and a guide that
 * dragged in a headless browser would add a large dependency to a Railway container to save one
 * keystroke. The print stylesheet is A4, so "Save as PDF" gives exactly the page this function
 * describes.
 *
 * WEARS THE HR PREMIUM IDENTITY since 2026-10-13, when the owner ticked "change to the premium look"
 * for it on the review page. DRESS ONLY: the masthead, the frame, the watermark and the running foot
 * are `premium-identity.ts`'s, and every step, sentence, label and note below is exactly what it was.
 * The foot names Sato Pharma and carries the identity code (`PREMIUM_COMPANY_DOCUMENT_BRAND`), so the
 * old in-flow footer keeps only the guide's own words — the code would otherwise print twice.
 *
 * 🔴 THE BROWSER PRINTS THIS, NOT A SERVER, AND IT IS READ ON PHONES. Two consequences. `@page` has
 * `margin: 0` (the premium frame and foot are `position: fixed` and need the whole sheet), which also
 * removes the browser's own header and footer text from the printout; the sheet's padding is what
 * keeps the content clear of them, so the usable height is 297 - 12.5 - 19.5 = 265 mm and the one
 * page is held by measurement, not by a test. And the 210 mm frame, watermark and foot exist for
 * paper and for a desktop that is at least that wide: below 830 px they are not drawn and the
 * masthead stacks, so a phone gets the content reflowing exactly as it did, with no sideways scroll.
 */
export function buildPhoenixCrmStartGuide(language: StartGuideLanguage): string {
  const c = CONTENT[language];
  const masthead = premiumLetterhead(
    {
      legalNameAr: systemLegalEntity.legalNameAr,
      legalNameEn: systemLegalEntity.legalNameEn,
      ...c.head,
    },
    { compact: true },
  );

  const stepRows = c.steps
    .map(([head, text], i) => `<li><span class="n">${i + 1}</span><div><h2>${head}</h2><p>${text}</p></div></li>`)
    .join("");
  const noteRows = c.notes.map(([head, text]) => `<div class="note"><h3>${head}</h3><p>${text}</p></div>`).join("");

  // Arabic body type: Segoe UI is the Windows face with full Arabic coverage, and Aptos has none —
  // naming Aptos first on an Arabic page falls back glyph by glyph and mixes two faces inside a word.
  const bodyFont =
    c.dir === "rtl"
      ? `"Segoe UI", "${HOUSE_TYPE.body}", Tahoma, Arial, sans-serif`
      : `"${HOUSE_TYPE.body}", "Segoe UI", Arial, sans-serif`;

  const titleText = c.head.titleEn ?? c.head.titleAr;

  return `<!doctype html>
<html lang="${c.lang}" dir="${c.dir}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phoenix CRM — ${titleText}</title>
<style>
${HOUSE_IDENTITY_CSS}
${premiumSheetCss(".guide")}
${PREMIUM_IDENTITY_CSS}
  /* THE SQUARE-EDGE GOLDEN RULE. No round or semi-round corners, anywhere. */
  * { box-sizing: border-box; border-radius: 0; }
  body {
    margin: 0 auto; max-width: 210mm;
    color: var(--phx-doc-body);
    font-family: ${bodyFont};
    font-size: 10pt; line-height: ${c.dir === "rtl" ? 1.6 : 1.45};
  }
  /* The sheet's own padding is the page's inset, so on paper the body only has to stop being capped. */
  @media print { body { max-width: none; } }
  /* A desktop wide enough for the whole sheet shows it as a sheet, so the foot sits at the bottom of
     it. Below that the frame is not drawn, the masthead stacks, and the page reflows as a phone
     always has. */
  @media screen and (min-width: 831px) { .guide { min-height: 297mm; } }
  @media screen and (max-width: 830px) {
    .pm-chrome { display: none; }
    .guide { padding-bottom: 14mm; }
    .pm-mast.pm-mast--compact { grid-template-columns: 1fr; row-gap: 1.5mm; }
    .pm-mast.pm-mast--compact .pm-mast__latin { margin: 0 auto; }
  }

  .lead {
    margin: 4mm 0 0; padding-bottom: 2.4mm;
    border-bottom: .5pt solid var(--phx-doc-hair);
    color: var(--phx-doc-deep); font-size: 10.5pt; font-weight: 600;
  }

  ol.steps { list-style: none; margin: 0; padding: 0; }
  ol.steps li {
    display: flex; gap: 5mm; align-items: flex-start;
    padding: 2.9mm 0; border-bottom: .5pt solid var(--phx-doc-hair);
  }
  /* A ruled numeral, never a filled disc — the INK RULE is the point, not a preference. The digit is
     pinned LTR so a two-digit number could never be read right-to-left. */
  ol.steps .n {
    flex: 0 0 8mm; height: 8mm; display: flex; align-items: center; justify-content: center;
    border: .7pt solid var(--phx-doc-blue); color: var(--phx-doc-deep);
    font-size: 11pt; font-weight: 700; line-height: 1; direction: ltr;
  }
  ol.steps h2 { margin: 0 0 .8mm; color: var(--phx-doc-deep); font-size: 10.5pt; font-weight: 700; }
  ol.steps p { margin: 0; }
  strong { color: var(--phx-doc-deep); }
  /* A button name never breaks across a line — see the header. */
  bdi { white-space: nowrap; }

  /* Two notes side by side on paper and on a desktop; stacked on a phone, because the fits-the-screen
     golden rule is fitting by reflowing, never by scrolling sideways.
     🔴 THE PAGE IS ONE A4 SIDE, AND A THIRD NOTE COSTS A WHOLE WRAPPED ROW. Measured 2026-10-01 on
     the real route at 210mm against the 269mm usable height: with two notes English is 245.2mm and
     Arabic 243.5mm (~24mm spare); a third note pushed them to 265mm and 264.3mm — 4mm short of
     spilling onto a second page. Shortening the third note's WORDS bought nothing, because the height came from the
     extra row, not the sentence; the phone went into the validation note instead. So a new fact
     belongs in an existing note, and a genuinely new note means dropping one. No test here can see
     this — it needs a browser at 210mm. Since the premium sheet (2026-10-13) the usable height is
     265mm and the two pages end at 238mm (English) and 226mm (Arabic) of it, 40.7mm and 52.6mm
     above the foot rule, so the arithmetic above still holds with room for one more row. */
  .notes { display: flex; flex-wrap: wrap; gap: 7mm; margin-top: 4.5mm; }
  .note { flex: 1 1 60mm; border-top: 1.2pt solid var(--phx-doc-blue); padding-top: 2.2mm; }
  .note h3 { margin: 0 0 .9mm; color: var(--phx-doc-deep); font-size: 9.5pt; font-weight: 700; }
  .note p { margin: 0; font-size: 9pt; }

  .closing {
    margin: 6mm 0 0; padding-top: 2mm; border-top: .5pt solid var(--phx-doc-hair);
    color: var(--phx-doc-muted); font-size: 7pt; text-align: center;
  }
</style></head>
<body>
<div class="guide">
${masthead}
<p class="lead">${c.lead}</p>
<ol class="steps">${stepRows}</ol>
<div class="notes">${noteRows}</div>
<p class="closing">${c.footer}</p>
${premiumPageChrome({ brand: PREMIUM_COMPANY_DOCUMENT_BRAND })}
</div>
</body></html>`;
}
