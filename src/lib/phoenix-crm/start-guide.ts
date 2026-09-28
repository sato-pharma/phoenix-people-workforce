/**
 * Phoenix CRM — the one-page start guide a District Manager sends a rep, in English and Arabic.
 *
 * WHY IT IS A SYSTEM DOCUMENT AND NOT A FILE SOMEBODY KEEPS. It was first built as a one-off page in
 * a scratchpad, which is exactly how a company document rots: the app's wording changes, the guide
 * does not, and a rep is sent looking for a button that was renamed a month ago. Here the guide sits
 * beside the screens it describes, wears the house identity from the one module that owns it, and is
 * regenerated on every request.
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

import {
  HOUSE_IDENTITY_CSS,
  HOUSE_TYPE,
  houseLetterhead,
  type HouseLetterheadInput,
} from "@/lib/hiring-pack/house-identity";
import { systemLegalEntity } from "@/config/system-settings";

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

/** The labels this guide names, exactly as the visit screen spells them. */
export const START_GUIDE_UI_LABELS = ["Visits", "Planned visit", "Unplanned visit", "Start", "Save"] as const;

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
    lead: "Your customer list is already in the app. Recording a visit is six steps and one photo.",
    steps: [
      [
        "Open Visits and choose the type first",
        `${ui("Planned visit")} offers only the customers on a plan you have already sent for today. Until you send a plan that list is empty, so choose ${ui("Unplanned visit")} and write one line saying why you went.`,
      ],
      [
        // 🔴 "Choose the customer", NEVER "the doctor". The owner's rule of 2026-09-23 — "make it ALL
        // AM PM not doctors and accounts" — governs every screen string in this module, and this page
        // is one of them. `tests/phoenix-crm-am-pm-words.test.ts` caught the first draft of this line.
        "Choose the customer",
        "Your list is already in the app and grouped by brick, in the order you will travel. You do not need to add anybody.",
      ],
      [
        "Press Start, and take the photo",
        `${ui("Start")} opens the camera and your location together. Photograph the clinic sign or the door. <strong>The photo is what records the visit</strong> — without it nothing is saved.`,
      ],
      [
        "Fill in the products you discussed",
        "From your second visit to the same customer these come back already filled in from last time, with the date they came from. Change any of them.",
      ],
      [
        "Add a voice note if you want to",
        `Say it instead of typing it. <strong>A voice note is stored only when you press ${ui("Save")}</strong> — recording one on its own saves nothing.`,
      ],
      ["Press Save", "That is the visit recorded."],
    ],
    notes: [
      [
        "The first time at a new place",
        "You capture the place once — its photo and its location. That same photo records the visit when you save within thirty minutes, so a new customer costs one photo, not two.",
      ],
      [
        "Your monthly plan",
        "It is due on the last Thursday of the month before. Send it when you can: a late plan is always accepted, never refused.",
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
    lead: "قائمة عملائك موجودة بالفعل في التطبيق. تسجيل الزيارة ست خطوات وصورة واحدة.",
    steps: [
      [
        `افتح ${ui("Visits")} واختر نوع الزيارة أولاً`,
        `تعرض ${ui("Planned visit")} العملاء الموجودين في خطة أرسلتها لهذا اليوم فقط، وحتى ترسل خطة تكون هذه القائمة فارغة. اختر ${ui("Unplanned visit")} واكتب سطراً واحداً يوضح سبب الزيارة.`,
      ],
      [
        // The Arabic half of the same rule. The AM/PM test reads English and would never have caught
        // this one, which is exactly why it is corrected by hand rather than left because CI was green.
        "اختر العميل",
        "قائمتك موجودة في التطبيق ومرتبة حسب البريك، بالترتيب الذي ستتحرك به. لست بحاجة إلى إضافة أحد.",
      ],
      [
        `اضغط ${ui("Start")} والتقط الصورة`,
        `يفتح ${ui("Start")} الكاميرا والموقع معاً. صوّر لافتة العيادة أو بابها. <strong>الصورة هي ما يسجل الزيارة</strong> — وبدونها لا يُحفظ شيء.`,
      ],
      [
        "أدخل المنتجات التي تحدثت عنها",
        "من زيارتك الثانية للعميل نفسه تعود هذه المنتجات مُدخلة من المرة السابقة، ومعها تاريخها. غيّر منها ما تشاء.",
      ],
      [
        "أضف ملاحظة صوتية إن أردت",
        `قلها بدلاً من كتابتها. <strong>الملاحظة الصوتية لا تُحفظ إلا عند الضغط على ${ui("Save")}</strong> — وتسجيلها وحده لا يحفظ شيئاً.`,
      ],
      [`اضغط ${ui("Save")}`, "بذلك تكون الزيارة قد سُجلت."],
    ],
    notes: [
      [
        "أول مرة في مكان جديد",
        "تسجل المكان مرة واحدة — صورته وموقعه. وتسجل هذه الصورة نفسها الزيارة إذا حفظت خلال ثلاثين دقيقة، فالعميل الجديد يكلفك صورة واحدة لا صورتين.",
      ],
      [
        "خطتك الشهرية",
        "موعدها آخر خميس من الشهر السابق. أرسلها متى استطعت: الخطة المتأخرة مقبولة دائماً ولا تُرفض.",
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
 * keystroke. The print stylesheet is A4 with the house margins, so "Save as PDF" gives exactly the
 * page this function describes.
 */
export function buildPhoenixCrmStartGuide(language: StartGuideLanguage): string {
  const c = CONTENT[language];
  const letterhead = houseLetterhead({
    legalNameAr: systemLegalEntity.legalNameAr,
    legalNameEn: systemLegalEntity.legalNameEn,
    ...c.head,
  });

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
  @page { size: A4; margin: 14mm 16mm; }
  /* THE SQUARE-EDGE GOLDEN RULE. No round or semi-round corners, anywhere. */
  * { box-sizing: border-box; border-radius: 0; }
  body {
    margin: 0 auto; padding: 14mm 16mm; max-width: 210mm;
    color: var(--phx-doc-body);
    font-family: ${bodyFont};
    font-size: 10pt; line-height: ${c.dir === "rtl" ? 1.6 : 1.45};
  }
  /* On paper the @page margin already provides the frame, so the screen padding is removed rather
     than doubled. */
  @media print { body { padding: 0; max-width: none; } }
  h1, .lh__title h1 { font-family: ${c.dir === "rtl" ? bodyFont : `"${HOUSE_TYPE.display}", ${bodyFont}`}; }

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
     golden rule is fitting by reflowing, never by scrolling sideways. */
  .notes { display: flex; flex-wrap: wrap; gap: 7mm; margin-top: 4.5mm; }
  .note { flex: 1 1 60mm; border-top: 1.2pt solid var(--phx-doc-blue); padding-top: 2.2mm; }
  .note h3 { margin: 0 0 .9mm; color: var(--phx-doc-deep); font-size: 9.5pt; font-weight: 700; }
  .note p { margin: 0; font-size: 9pt; }

  footer {
    margin-top: 6mm; padding-top: 2mm; border-top: .5pt solid var(--phx-doc-hair);
    display: flex; flex-wrap: wrap; gap: 2mm 6mm; justify-content: space-between;
    color: var(--phx-doc-muted); font-size: 7pt;
  }
  /* The document code is matched character by character against the standard, so it is monospace and
     pinned LTR on both pages. */
  footer .code { font-family: "${HOUSE_TYPE.mono}", monospace; direction: ltr; }
</style></head>
<body>
${letterhead}
<p class="lead">${c.lead}</p>
<ol class="steps">${stepRows}</ol>
<div class="notes">${noteRows}</div>
<footer><span>${c.footer}</span><span class="code">${START_GUIDE_DOCUMENT_CODE}</span></footer>
</body></html>`;
}
