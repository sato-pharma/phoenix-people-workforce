/**
 * The certificate, which is the one document in this programme that is signed.
 *
 * WHY IT IS NOT THE JOURNEY. The journey PDF is a record: seven pages, every
 * day, every figure, carefully worded so that it never claims anything a count
 * did not earn — and carefully not worded as an award, because nobody signs it.
 * That honesty is the problem. It is the only file leaving the programme, so it
 * lands in front of a future employer being asked to do a certificate's job,
 * which is to say in one page that this person was here and finished. So there
 * are two documents now, each free to be the thing it is: the journey stays
 * granular and unsigned, and this page says one sentence and carries a name
 * under a rule.
 *
 * WHAT IT WILL AND WILL NOT SAY. Completion, the dates, the training focus and
 * the role completing it makes somebody eligible for (owner, 13 Sep 2026), and
 * the key cards from the last page of the journey — nothing else. The rank
 * appears **only for the top three of a line**, because a certificate is not a
 * leaderboard and "18th of 22" on a signed page is a thing you would not hand
 * to anybody. Eligibility for a role is the company's own statement about what
 * the programme qualifies somebody for; it makes no claim about aptitude or
 * conduct, and no promise of employment.
 *
 * WHO IS ELIGIBLE is decided by the route, not here — the programme must have
 * finished and the intern must still be active. This file will render whatever
 * it is handed, which is what makes it testable.
 *
 * Landscape A4, which is the one place this design system bends to a
 * convention: a certificate read in portrait reads as a letter. Every corner is
 * still 90 degrees and the hierarchy is still rules and weight.
 */

import {
  Pdf,
  measure,
  mix,
  rgb,
  type PdfFace,
  type PdfFont,
  type RgbColor,
} from "./pdf.ts";
import { pdfFont } from "./truetype.ts";
import { satoBadge } from "./journey-pdf.ts";
import { tidyArea } from "./business-card.ts";
import {
  satoMark,
  satoMarkInk,
  SATO_ARABIC_RATIO,
  SATO_MARK_RATIO,
} from "./sato-mark.ts";
import { dateSpan, fullDate, keyCards, ordinalWord, type Journey } from "./journey.ts";
import { QR_QUIET } from "./qr.ts";
import { drawVerificationQr, verificationCode } from "./verification.ts";

/* The palette, off globals.css, as in journey-pdf.ts. */
const BRAND = rgb("#0879b8");
const INK = rgb("#111820");
/**
 * The navy the intern's name is written in, and the one colour on this page
 * that is nobody's derivation.
 *
 * Everything else here is INK, including the head band — and the name was INK
 * too, to the byte, which is what makes this worth a comment rather than a
 * constant. The owner asked three times for the name to be "the dark navy of
 * the upper strip" and sent a swatch of it: 158 x 76 pixels, every one of them
 * rgb(17,24,32), which is INK exactly. The value already matched. What did not
 * match is what the eye gets, because **a mass and a hairline at the same value
 * do not weigh the same** — the sentence this file already makes about the
 * watermark, arriving from the other side. #111820 as a 104pt block reads navy;
 * #111820 as a calligraphic hairline the renderer antialiases toward the paper
 * reads black. A value chosen to match a mass cannot read as that mass at
 * hairline weight, so matching the number was the wrong way to satisfy the
 * instruction and three replies proving the number matched were three useless
 * replies.
 *
 * So the name takes a navy that reads navy: #17304d, chosen by rendering it
 * against #1b3a5f and #0f2b4d at the real display size and looking. The lighter
 * one starts to lose the authority a signed page wants; the deeper one is
 * within a hair of this and no clearer. It stays the darkest thing on the page
 * after the band itself, which is the rule the certificate is built on — the
 * person is the largest and strongest object on it.
 */
const NAVY = rgb("#17304d");
const BODY = rgb("#45515a");
const SOFT = rgb("#69757e");
const FAINT = rgb("#8a959d");
const LINE = rgb("#dde4e8");
const HAIR = rgb("#e1e7eb");
const CANVAS = rgb("#f2f5f7");
const TINT = rgb("#f3f9fc");
const TINT_LINE = rgb("#b9d8e9");
const WHITE = rgb("#ffffff");

/** The grey that stays legible on the navy band, as on the journey's cover. */
const ON_DARK = rgb("#8d9aa4");
/** The navy band at the head, and the base that answers it. */
const BAND = 104;
const BASE = 20;

/**
 * The height of the company's mark on the band.
 *
 * It was 24pt — about seven per cent of the width of the sheet, which on a
 * document Sato Pharma is signing is not branding, it is a footnote. At 50 it
 * is the first thing on the page, which is what the issuer of a certificate
 * should be.
 */
const MARK_H = 50;
/** The seal, needed by the foot before the foot is laid out. */
const SEAL = 64;

/**
 * The Arabic ornament: how tall, where it hangs, how far it runs off the page,
 * and how pale it is.
 *
 * The owner's ruling, 12 Sep 2026, holding up the AUC certificate: the Arabic
 * goes *behind*, exactly as that page has it. Which is worth stating precisely,
 * because the first attempt here put it centred across the middle of the sheet
 * and that is not what AUC does. On that certificate the Arabic is a tall
 * calligraphic block standing down the **right-hand side**, tucked under the
 * header, **bleeding off the right edge of the paper**, sitting beside the text
 * rather than under the middle of it. Every one of those four is deliberate,
 * and a centred version reads as a background image where this reads as a mark
 * struck into the paper.
 *
 * So: hung from the top at ARABIC_TOP, immediately under the navy band the way
 * AUC's sits immediately under its logo; ARABIC_H tall, which is just under
 * half the sheet; and pushed right until it reaches the edge of the sheet.
 *
 * **What that shape is, is the company's and not this file's.** Until 12 Sep
 * 2026 the artwork was `ساتو` typeset over `فارما` in Amiri Bold — a portrait
 * block, which is what let it stand down the right edge as a column — and it
 * was a stand-in for a mark nobody had sent yet. Sato Pharma's own wordmark is
 * one calligraphic line drawn through a single elliptical sweep, 1.35:1, and a
 * composition like that cannot be broken onto two lines the way typeset words
 * can. So the height is unchanged and the width simply follows it: 285 tall is
 * 385 wide, nearly half the sheet, and the ornament is a field in the right of
 * the page rather than a column down the edge of it. Everything the owner's
 * ruling actually named survives that — behind, to the right, under the head,
 * laid to the trim — and the only casualty is a sentence in this file that
 * said the block was tall.
 *
 * **How far past that edge it may go is nought, and that is the one place this
 * page cannot copy AUC.** Arabic is written right to left, so the right edge of
 * this block is where both words BEGIN. Cutting it there does not crop an
 * ornament, it amputates the first letter of each word: at the 34pt it ran off
 * at first, `ساتو فارما` printed as `ـاتو` over `ـارما`, with the س and the ف
 * off the sheet entirely. That is not a watermark of the company's name, it is
 * a watermark of something else — and this file already holds the rule it
 * breaks, three paragraphs down, where a missing artwork draws nothing because
 * a degraded version of the company's name is a defect rather than a degraded
 * ornament. AUC can bleed theirs because the cut lands on the end of their
 * composition; here it lands on the start of the word.
 *
 * What survives of the ruling is everything else, and the bleed is replaced by
 * the strongest thing available that costs no letter: the **ink** is laid to
 * the trim. ARABIC_BLEED is how far the ink passes the page edge, not how far
 * the file does — the stand-in carried about nine pixels of clear space a side,
 * so placing it by its own frame left a 2.8pt white margin and a block that
 * read as placed rather than as struck into the paper. The wordmark that
 * replaced it is cropped to its own ink and that margin is now nought, which is
 * precisely why the placement still goes through `satoMarkInk()` rather than
 * being simplified back to the frame: the correction is worth nothing today and
 * worth a visible white edge the day somebody re-exports the artwork with a
 * designer's clear space around it. It is measured off the file for the same
 * reason the business card's mark is.
 *
 * Its foot is the number with a reason: 111 + 285 = 396, and the figures strip
 * has a floor of 400. A tinted strip painted across the bottom of the ornament
 * would cut it in half with a straight horizontal edge, which is the one thing
 * that would give away that it is a raster rather than watermarked stock.
 *
 * The strength is stronger than the centred version needed (0.08). That was
 * argued on nothing of consequence being set over it — the citation measured at
 * most 500pt in a centred 734pt column and stopped short of where the column
 * began — and the wordmark reaches 385pt in from the trim, so the second line
 * of the citation and the tail of a long name now do cross it. Rendered at
 * 0.07, 0.10 and 0.13 against the new artwork, which carries far more mass than
 * a typesetting of the same two words: 0.13 competes with the frame and shows
 * through the citation, 0.07 is a ghost, and at 0.10 the text over it stays
 * black on white and the tone behind it reads as the paper rather than as an
 * image. Crossing text is what a watermark is for; the value did not have to
 * move, but it had to be asked again, because it was chosen for a mark a third
 * this size.
 *
 * It is 0.10 and not the 0.13 it was first set at, and the reason is a thing no
 * colour value can tell you: **a mass and a hairline at the same value do not
 * weigh the same.** At 13 per cent the darkest pixel of the ornament is about
 * 224 of 255, which is very slightly LIGHTER than the keyline it crosses (221)
 * — and on the page the ornament plainly outweighed the frame, because one is
 * a 200pt block of tone and the other is a 1pt line the renderer antialiases
 * into something fainter still. Set beside 0.08, which goes to a ghost on a
 * laser print, 0.10 is the one that reads as watermarked stock: present, and
 * not competing with the structure of the page. It was chosen by rendering all
 * three and looking at the same corner in each, which is the only way this
 * particular question can be asked.
 */
const ARABIC_H = 285;
const ARABIC_TOP = 111;
const ARABIC_BLEED = 0;
const ARABIC_INK = 0.1;

/**
 * The display size of the name, and the floor it may step down to.
 *
 * Exported because `tests/certificate.test.mts` reads the size back out of the
 * content stream, and a test that hardcodes 48 would pass for the wrong reason
 * the day somebody decides the name should be larger still.
 */
export const NAME_SIZE = 48;
export const NAME_MIN = 22;

/**
 * The air the name keeps each side of the column, together.
 *
 * Measured against the roster rather than guessed: the longest full name on
 * the 2026 cohort is 35 characters, which at this air lands at 40pt — still
 * comfortably the largest thing on the page. The floor below is a safety net
 * for a name longer than anyone here has, not a size anybody is expected to
 * get.
 */
export const NAME_AIR = 40;

/**
 * The face the name is set in, and the file it comes out of.
 *
 * The owner's ruling, 12 Sep 2026: the name should be written rather than set —
 * the elegant script on the certificate he sent, in Latin, on the **name** and
 * not on the title. None of the fourteen faces a PDF reader is required to
 * carry is a script, so this is the one place in the project where a font
 * travels inside the file; see PdfFont in pdf.ts and src/lib/truetype.ts.
 *
 * It can be absent and the page still builds, exactly as the mark can: a
 * missing font gives null and the name is set in Helvetica Bold at the sizes
 * above, which is what it was set in before there was a script at all. That is
 * not a nicety — the file is read off disk at request time on Railway, and "your
 * certificate could not be generated" is not an acceptable answer to a font.
 */
const SCRIPT_FILE = "certificate-name.ttf";

/**
 * The floor the script steps down to, and why it is not NAME_MIN.
 *
 * A script face carries its weight in the strokes rather than in the counters,
 * so it stops being legible at a photocopier long before Helvetica Bold does.
 * The floor is higher for the same reason the display size is.
 *
 * It was 34, and 34 was not a floor — it was a cap. The step-down stops when it
 * reaches the floor whether the name fits or not, so a floor set above the size
 * a long name actually needs prints past the column instead of stepping to it:
 * a 48-character name came out 13.7pt over a 694pt column and a 50-character
 * one 43.2pt over, both at 34pt, on a page whose whole argument is that a name
 * is never cut. Pinyon needs 33pt for the first and 32pt for the second, so the
 * floor is set with room under those rather than on top of them. It is still
 * well above the 22pt this stepped to before the script arrived, and no name on
 * the 2026 roster comes anywhere near it — the longest, at 35 characters,
 * settles at 45pt.
 */
export const SCRIPT_MIN = 28;

/**
 * The name's baseline, the highest its ink may reach, and its cap-height ruler.
 *
 * The baseline is fixed and the size is what gives, which is the opposite of
 * the first build: with two typefaces in play, anchoring the size and letting
 * the baseline move puts the rule under the name in a different place on every
 * certificate. NAME_CEIL is the air under "THIS IS TO CERTIFY THAT" — the
 * flourishes of a script face are the thing that would collide with it, and they
 * are the reason the whole spine above and below the name opened up by twenty
 * points when the script arrived.
 */
const NAME_BASE = 268;
const NAME_CEIL = 208;
/* Width of the paper outline under the name, in points: half of it is the
   clear margin cut round each letter out of the Arabic behind. Rendered at 0, 5
   and 8 against the wordmark and looked at: 5 is a hairline gap that half
   disappears at reading distance, 8 is the one where the Arabic plainly stops
   at the name and the name plainly stands in front of it. */
const NAME_HALO = 8;

/**
 * How large the script is set, and why it is a number rather than a ratio.
 *
 * A point size means nothing across typefaces: Helvetica Bold puts 718 of its
 * 1000 units into a capital, and a calligraphic face spends much of its em on
 * ascenders and flourishes — so the same 48pt reads perhaps a third smaller and
 * would leave the name competing with the figures under it. The first attempt
 * therefore solved for the size, setting the script so its capitals matched the
 * height Helvetica Bold's capitals had. **It did not survive a real font.**
 * `sCapHeight` only exists from OS/2 version 2, plenty of script faces still
 * ship version 1 (Monotype Corsiva does), and the honest fallback — the
 * ascender — is *larger* than a cap height, so the ratio came out below 1 and
 * made the script smaller than the sans it was replacing. A derivation that
 * inverts on missing data is worse than a number somebody chose.
 *
 * So it is chosen, the way NAME_SIZE was chosen: by rendering the page. What is
 * still derived is the part a number cannot get right — the face's own ascent
 * and descent decide whether this size collides with the line above it and
 * where the rule below it goes.
 */
export const SCRIPT_SIZE = 68;

/**
 * The sheen on the name — where the light sits, how deep it runs and how far
 * the letter darkens away from it.
 *
 * SHEEN_AT is in EMS ABOVE THE BASELINE rather than in points or in a fraction
 * of the block, because the name steps from 68pt to 28pt and a highlight in
 * points walks up the letters as they shrink. 0.55 em is a shade above this
 * face's x-height, which is the one place a sheen can sit and land on every
 * letter of a name: a capital carries light at its middle there and a lowercase
 * letter carries it along its top. Lower, at the x-height itself, it lights the
 * whole body of every small letter and the word reads PALER at the size it
 * prints — which is the opposite of what four rounds of this page asked for.
 *
 * SHEEN_HALF is the half-depth of the light, in fractions of the cap-to-
 * descender span: a sixth of the block lit, and the rest of the letter at navy
 * or below it, so the word's average value goes DOWN while a highlight crosses
 * it. That is what makes this read as polish rather than as ink that failed —
 * broad ramps were rendered and they all read as a faded name.
 */
const SHEEN_AT = 0.55;
const SHEEN_HALF = 0.07;
/** How far toward white the brightest line goes, and toward INK the foot. */
const SHEEN_LIFT = 0.5;
const SHEEN_DEEP = 0.55;
/**
 * How many strips the sheen is built from.
 *
 * Each one is the whole name drawn again inside a clip, so this is the price of
 * the effect as well as its smoothness: 26 costs about 4KB on a 166KB file, and
 * a band is a third of a point at 68pt, which is under a printer's dot.
 */
const SHEEN_BANDS = 26;

/** How far the face's ink rises above the baseline, in points at this size. */
function ascentOf(size: number, script: PdfFont | null): number {
  /* Helvetica Bold's em box ascends 936 and its capitals 718; a name is made of
     capitals, and the em box would refuse a size that is perfectly well placed.
     A script face's own ascent is honest about its flourishes — and the tallest
     thing in a script name genuinely is a flourish — so it is used as given. */
  return script ? (script.ascent / 1000) * size : 0.718 * size;
}

/** How far it drops below, as a positive number of points. */
function descentOf(size: number, script: PdfFont | null): number {
  return script ? (Math.abs(script.descent) / 1000) * size : size * 0.21;
}

/**
 * The script face, read once per process. Null is a working certificate.
 *
 * Exported because `tests/certificate.test.mts` has to measure the stepped-down
 * name with the SAME metrics this file set it in. Measuring a script name with
 * Helvetica's widths does not fail, it just quietly checks a different string
 * than the one on the page — and which of the two faces is in play is decided
 * by whether a file exists, so a test cannot assume either.
 */
export function nameFont(): PdfFont | null {
  return pdfFont(SCRIPT_FILE);
}

const MICRO = { size: 7.2, face: "bold", tracking: 1.3 } as const;

/** A4 landscape. */
const W = 842;
const H = 595;

/** The signature. One person ran this programme, and it is his name on it. */
const SIGNATORY = { name: "Omar Anwar Gawish", role: "HR Section Head" };

/**
 * What the programme trained for and the role completing it makes somebody
 * eligible for (owner, 13 Sep 2026). Worded afresh rather than carried over
 * from the 2025 certificate, and said in the citation itself rather than in
 * the foot: it is part of what the page certifies, so it belongs in the one
 * sentence that follows "this is to certify that".
 */
const FOCUS = "medical sales promotion";
const ROLE = "Medical Representative";

/**
 * The issuer, named in type as well as drawn as a mark.
 *
 * The sentence used to say "completed the Future Talents 2026 field
 * programme", which never names the company at all — so an employer reading
 * the one line that matters had to infer the issuer from a logo. It is also
 * the fallback that matters: `satoMark()` can return null and the page still
 * builds, and a certificate that loses its mark must not also lose whose
 * certificate it is.
 */
const COMPANY = "Sato Pharma";

/**
 * The rank, but only where a certificate can carry one.
 *
 * Top three of the line, nothing else. Fourth place on a signed page is worse
 * than no rank at all, and a rank out of a line size the reader cannot see is
 * an invitation to guess.
 *
 * Where it appears it carries BOTH ranks (owner, 13 Sep 2026: "show rank in
 * line and rank in total") — the line's first, because that is the honour that
 * earned the chip, then the programme's, worded exactly as the journey's
 * closing words it so the two documents cannot be read as two claims.
 */
function honour(journey: Journey): string[] {
  const { standing, identity } = journey;
  if (!standing?.scored || !identity.line) return [];
  if (standing.linePlace < 1 || standing.linePlace > 3) return [];
  const word = ["first", "second", "third"][standing.linePlace - 1];
  const marks = [`Finished ${word} of ${standing.lineSize} on the ${identity.line} line`];
  if (standing.place > 0) {
    marks.push(`${ordinalWord(standing.place)} of ${standing.of} across the programme`);
  }
  return marks;
}

/**
 * The one sentence, assembled from the record like every other sentence here.
 *
 * "Completed the four weeks" is a claim about attendance, which the span is; it
 * is not a claim about performance, which the figures below are left to make on
 * their own.
 */
function statement(journey: Journey): Word[] {
  const { identity, span } = journey;
  /* The area is printed the way the business card prints it — the roster's
     "October -Zayed" reads "October · Zayed" — and it is one unbreakable word
     to the wrap, because it is a name: "in October - / Zayed" was what the
     balancer made of it when it was three words. The stored value is an RLS
     join key and is not touched. */
  const area = tidyArea(identity.area) ?? identity.area;
  const parts: [string, Emphasis, "whole"?][] = [
    [`completed ${COMPANY}'s`, "plain"],
    [identity.programmeName, "strong", "whole"],
    [identity.line ? `field programme on the ${identity.line} line in` : "field programme in", "plain"],
    [`${area},`, "plain", "whole"],
    [`from ${dateSpan(span.start, span.end)}, with a training focus on`, "plain"],
    /* The emphasised phrases are whole too: a bold phrase broken across two
       lines reads as two emphases, and "medical / sales promotion," is what
       the long Pediatrics citation made of it. */
    [`${FOCUS},`, "strong", "whole"],
    ["and is thereby eligible for the role of", "plain"],
    [`${ROLE}.`, "accent", "whole"],
  ];
  return parts.flatMap(([text, em, whole]) =>
    whole
      ? [{ text, em }]
      : text.split(" ").filter(Boolean).map((word) => ({ text: word, em })),
  );
}

/**
 * Where the eye lands in the citation (owner, 13 Sep 2026: "highlight what's
 * important and colour what you want the eye of the reader to fall on").
 *
 * One colour and one weight, and nothing else, because a sentence with three
 * colours in it is a brochure. The ROLE is the only coloured thing in it, in the
 * brand blue the title above is set in, since it is what the certificate is for
 * as far as the next employer is concerned. The programme and the training
 * focus are set bold in ink: what was done, and what it was in. Everything else
 * — the line, the area, the dates, the grammar — stays in the body grey, which
 * is what lets the three stand forward at a glance without the sentence
 * reading as a row of labels. The same size throughout: a word set larger
 * inside a line of body type is an advert, not an emphasis.
 */
type Emphasis = "plain" | "strong" | "accent";
type Word = { text: string; em: Emphasis };
const CITE = 13;
const EMPHASIS: Record<Emphasis, { face: PdfFace; color: RgbColor }> = {
  plain: { face: "regular", color: BODY },
  strong: { face: "bold", color: INK },
  accent: { face: "bold", color: BRAND },
};
const SPACE = measure(" ", CITE, "regular");

/** A line's width as it prints, each word in its own face. */
function lineWidth(words: Word[]): number {
  return words.reduce(
    (n, word, i) => n + measure(word.text, CITE, EMPHASIS[word.em].face) + (i ? SPACE : 0),
    0,
  );
}

/** Greedy wrap over styled words, which wrapText() cannot measure. */
function wrapWords(words: Word[], max: number): Word[][] {
  const lines: Word[][] = [];
  let line: Word[] = [];
  for (const word of words) {
    if (line.length && lineWidth([...line, word]) > max) {
      lines.push(line);
      line = [];
    }
    line.push(word);
  }
  if (line.length) lines.push(line);
  return lines;
}

/**
 * One centred line of the citation, drawn a run at a time. Consecutive words
 * in the same emphasis go out as one run, so the reader copying the text gets
 * whole phrases and the stream carries a handful of Tj rather than one a word.
 */
function citationLine(doc: Pdf, words: Word[], left: number, y: number, width: number) {
  let x = left + (width - lineWidth(words)) / 2;
  for (let i = 0; i < words.length; ) {
    let j = i;
    while (j < words.length && words[j].em === words[i].em) j += 1;
    const text = words.slice(i, j).map((word) => word.text).join(" ");
    const { face, color } = EMPHASIS[words[i].em];
    doc.text(text, x, y, { size: CITE, face, color });
    x += measure(text, CITE, face) + SPACE;
    i = j;
  }
}

/** A filename that says what it is and whose it is. */
export function certificateFilename(journey: Journey): string {
  const name = journey.identity.fullName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `ftp2026-certificate-${name || "record"}.pdf`;
}

/** Build the certificate and hand back its bytes. */
export function renderCertificatePdf(journey: Journey): Uint8Array {
  const doc = new Pdf({
    width: W,
    height: H,
    margin: 54,
    info: {
      title: `${journey.identity.fullName} — Certificate of completion`,
      author: "Sato Pharma",
      subject: `${journey.identity.programmeName}, ${dateSpan(journey.span.start, journey.span.end)}`,
      creator: "Sato Pharma · Future Talents Field",
    },
  });

  doc.page();

  const mid = doc.left;
  const box = doc.right - doc.left;

  /* ------------------------------------------------------- the watermark --
     FIRST, and that is the whole of its correctness: a PDF content stream has
     no z-order beyond the order things are painted in, so "behind" means
     "before". Drawn after the name it would not be a watermark, it would be a
     grey block over somebody's name, and the page would still open and still
     validate. tests/certificate.test.mts pins the order in the stream for
     exactly that reason.

     Unlike the mark, a missing file here draws NOTHING and says nothing. The
     mark falls back to type because a certificate that loses its artwork must
     not also lose whose certificate it is; an ornament has no such duty, and
     "Sato Pharma" set 560pt wide in grey across the middle of the page is not
     a degraded watermark, it is a defect. */
  const arabic = satoMark("arabic", WHITE, {
    color: INK,
    strength: ARABIC_INK,
  });
  /* Where it landed, for the one thing on the page painted across it later. */
  let watermark: { x: number; w: number } | null = null;
  if (arabic) {
    const arabicW = ARABIC_H * SATO_ARABIC_RATIO;
    /* Measured from the RIGHT edge of the paper, not from the content column,
       and from the right edge of the INK rather than of the file. They are the
       same thing on the artwork in the tree, which is cropped to its own ink,
       and they were 2.8pt apart on the stand-in before it — the difference
       between a mark laid to the trim and a mark with a white hairline down the
       outside of it. Placing it by the file is also what let 34pt of bleed read
       as a number when it was in fact the whole of the first letter of both
       words. Falling back to the file's own frame if the box cannot be measured
       costs whatever clear space the file carries and nothing else; it cannot
       put ink off the sheet. */
    const ink = satoMarkInk("arabic");
    watermark = { x: W + ARABIC_BLEED - arabicW * (ink ? ink.right : 1), w: arabicW };
    doc.image(arabic, watermark.x, ARABIC_TOP, watermark.w, ARABIC_H);
  }

  /* ------------------------------------------------------------ the head --
     A full-bleed navy band with the mark reversed out of it, closed by a 3pt
     brand seam — the journey's cover treatment, so the two documents are
     visibly one pair, and a band commits where a logo on white reads as a
     letterhead. It is shallower than the journey's because this page has one
     thing to say and the band is not it. */
  doc.rect(0, 0, W, BAND, INK);
  doc.rect(0, BAND, W, 3, BRAND);
  const markW = MARK_H * SATO_MARK_RATIO;
  satoBadge(
    doc,
    "reverse",
    INK,
    WHITE,
    mid + (box - markW) / 2,
    (BAND - MARK_H) / 2,
    MARK_H,
  );

  /* A matching seam and base at the foot. The page is then held top and bottom
     the way a printed certificate is, and the three navy masses — band, seal,
     base — read top, corner, bottom rather than as one heavy end. */
  doc.rect(0, H - BASE - 3, W, 3, BRAND);
  doc.rect(0, H - BASE, W, BASE, INK);
  doc.text(COMPANY.toUpperCase() + " · FUTURE TALENTS PROGRAM 2026", mid, H - 7, {
    ...MICRO,
    size: 6.6,
    color: mix(ON_DARK, WHITE, 0.25),
    align: "center",
    width: box,
  });

  /* ----------------------------------------------------------- the frame --
     A double keyline with corner ticks. Two hairlines at different weights say
     engraved where one says boxed, and the eight rectangles of the ticks are
     what let the keylines stay light and still feel finished. All of it is
     rectangles, so the design system keeps its word — nothing on this page is
     not a rectangle, and there is still no circle anywhere. */
  const frameY = 120;
  const frameH = 424;
  frame(doc, 20, frameY, W - 40, frameH, LINE, 1);
  frame(doc, 27, frameY + 7, W - 54, frameH - 14, HAIR, 1);
  corners(doc, 20, frameY, W - 40, frameH, 16);

  /* ------------------------------------------------------------ the award --
     Title, engraved rule, connector, then the name. The connector is what
     fixes the grammar: without "this is to certify that", the sentence under
     the name has to open in lower case and reads as a caption rather than a
     citation. */
  doc.text("CERTIFICATE OF COMPLETION", mid, 152, {
    ...MICRO,
    size: 10,
    tracking: 4.8,
    color: BRAND,
    align: "center",
    width: box,
  });
  doc.rule(mid + (box - 46) / 2, 166, 46, INK, 2);
  doc.text("THIS IS TO CERTIFY THAT", mid, 192, {
    size: 7.5,
    face: "bold",
    tracking: 2.4,
    color: FAINT,
    align: "center",
    width: box,
  });

  /* The name is the content of this page and it is now sized like it. At 36pt
     it was a report heading on an 842pt sheet — correct in every coordinate
     and wrong at a glance, which is the whole failure mode of judging a
     document from its numbers. A very long name steps down instead of being
     cut, because a certificate that abbreviates somebody's name is worse than
     one with smaller type on it. */
  const name = journey.identity.fullName;
  const script = nameFont();
  const metric = script ?? "bold";
  /* A script face is not tracked. Helvetica Bold at display size needs a point
     of negative tracking to stop the letters looking loose; a calligraphic face
     is drawn to join, and taking space out of the joins is what turns it from
     handwriting into a row of letters that happen to touch. */
  const tracking = script ? 0 : -0.6;

  let nameSize = script ? SCRIPT_SIZE : NAME_SIZE;
  const floor = script ? SCRIPT_MIN : NAME_MIN;
  while (
    nameSize > floor &&
    (measure(name, nameSize, metric, tracking) > box - NAME_AIR ||
      NAME_BASE - ascentOf(nameSize, script) < NAME_CEIL)
  ) {
    nameSize -= 1;
  }
  /* The name is the front layer, and it has to LOOK like one (owner, 13 Sep
     2026: "make the name layered at the front"). In paint order it always was
     — the Arabic is drawn first — but the calligraphy's own sweeps ran straight
     up to every letter, so the two read as one tangle rather than as a name
     standing in front of a ground. So the name is drawn once first in PAPER,
     fat, which cuts a clear margin out of whatever sits behind it; the real
     name then lands inside that margin. There is no transparency in this
     writer, and this is how an engraver does it without any: a knock-out, not
     a shadow. It is the only other fill-then-stroke run on the page and it is
     the same string, so a reader copying the text gets the name twice only
     if it copies paint rather than text. */
  doc.text(name, mid, NAME_BASE, {
    size: nameSize,
    face: "bold",
    font: script,
    tracking,
    color: WHITE,
    ink: NAME_HALO,
    align: "center",
    width: box,
  });
  doc.text(name, mid, NAME_BASE, {
    size: nameSize,
    face: "bold",
    font: script,
    tracking,
    color: NAVY,
    /* Stroked as well as filled, three tenths of a point, in its own ink. It is
       not a bold and must not become one: there is no second weight of a
       calligraphic face, and 0.6 was rendered beside this and flattens the
       thick-to-thin contrast that is the whole reason a script is on this page.
       It is here because the same antialiasing that made INK read black at this
       weight takes a bite out of any colour set this thin — the stroke is what
       makes the navy above arrive on the paper at the value it was chosen at,
       rather than a paler version of it. */
    ink: 0.3,
    align: "center",
    width: box,
  });

  /* And then the gloss, which is the same name drawn 26 times through 26
     horizontal clips, each strip in its own value: bright on one line just
     above the x-height, deepening toward INK below it and, more gently, above.
     What the eye gets is a polished surface — the light does not move the
     colour, it says the colour is on something.

     It is built out of rectangles and one clip because there is no gradient in
     this writer and no transparency, and neither is being added for a line of
     type: a shading pattern is a dictionary per page, a resource entry and a
     print-only class of reader bug. The clip is a RECTANGLE and deliberately
     not the other thing PDF offers, which is clipping to the outlines of the
     text itself in render mode 7 — that is one call instead of 26 and its
     failure mode is what settled it. A reader that does not honour a text clip
     paints every band across the whole column, which on this page is a navy
     block where somebody's name should be; it is not hypothetical, it is what
     Chrome's renderer did when the text state was reset one token too early.
     The worst a reader that ignored a rectangle clip could do here is print the
     name in one flat colour, over a name that is already on the page.

     The name under all of this is the plain filled line above, which is the one
     every other assertion on this page reads and the one a reader copies out as
     text. The sheen never replaces it; it is laid over it. */
  const inkTop = NAME_BASE - ascentOf(nameSize, script);
  const inkSpan = ascentOf(nameSize, script) + descentOf(nameSize, script);
  const lit = (NAME_BASE - nameSize * SHEEN_AT - inkTop) / inkSpan;
  const deepest = mix(NAVY, INK, SHEEN_DEEP);
  const sheen = (t: number): RgbColor => {
    const off = Math.abs(t - lit);
    /* Squared, so the light has a soft shoulder rather than an edge: a hard
       edge across a letter reads as a crop, and this is supposed to read as a
       reflection. */
    if (off < SHEEN_HALF) return mix(NAVY, WHITE, SHEEN_LIFT * (1 - (off / SHEEN_HALF) ** 2));
    /* Above the light the letter darkens a little and below it a lot, which is
       the asymmetry of a surface lit from in front and above. */
    if (t < lit) return mix(NAVY, deepest, 0.3 * Math.min(1, (lit - t - SHEEN_HALF) / 0.2));
    return mix(NAVY, deepest, Math.min(1, (t - lit - SHEEN_HALF) / 0.45));
  };
  for (let i = 0; i < SHEEN_BANDS; i += 1) {
    const t = (i + 0.5) / SHEEN_BANDS;
    /* A third of a point of overlap on each strip. Without it the clips meet on
       a coordinate the rasteriser rounds twice, and a hairline of white paper
       shows through the letter on every band boundary. */
    doc.clip(mid, inkTop + (inkSpan * i) / SHEEN_BANDS, box, inkSpan / SHEEN_BANDS + 0.35, (d) => {
      d.text(name, mid, NAME_BASE, {
        size: nameSize,
        face: "bold",
        font: script,
        tracking,
        color: sheen(t),
        ink: 0.3,
        align: "center",
        width: box,
      });
    });
  }

  /* The rule under the name is measured to the name with a fixed overhang each
     side: a rule the width of the column reads as a divider and a rule the
     width of the word reads as an underline, and this is neither.

     Its height is measured too, and that is new with the script: a calligraphic
     descender is nearly half an em deep, so the rule that sat 20pt under a
     Helvetica baseline would be struck through by the tail of a `y` in
     "Elsawy". It clears the face's own descender instead, which means the whole
     spine below it moves with the name rather than being a set of numbers that
     happen to work for one typeface. */
  const nameW = measure(name, nameSize, metric, tracking);
  /* Capped at the column and not at some fraction of it: the cap used to be
     `box - 160`, which is wider than most names and therefore invisible — until
     a name that fills the column, where it produced a rule SHORTER than the
     name sitting on it. An underline that stops before the word does reads as a
     mistake, and it only appears for the longest name in a cohort, which is
     nobody's fixture. */
  const ruleW = Math.max(220, Math.min(box, nameW + 56));
  const ruleY = NAME_BASE + descentOf(nameSize, script) + 8;
  /* NAVY rather than INK, and it follows the name rather than the frame for
     the reason it is measured to the name rather than to the column: a rule the
     width of the word is an underline and belongs to the word. Left in INK it
     is a black stub under a navy name, which is the same defect the business
     card fixed by making its role underline brand blue. */
  doc.rule(mid + (box - ruleW) / 2, ruleY, ruleW, NAVY, 1.2);

  /* The citation, wrapped short and centred. A narrow measure on a page this
     wide is deliberate: centred text only reads as centred when the block is
     visibly narrower than the space around it. Which measure inside that cap
     it actually takes is balanceLines()'s answer, not this number's.

     Since the sentence also carries the training focus and the role (13 Sep
     2026) it is three lines, not two, and the page found the room a few points
     at a time rather than in one visible move: the cap opened from 500 to the
     column less 160 so each clause, bold words and all, can hold a line of its
     own, the citation
     sits 30 under the rule rather than 34, the lead is 18.5 rather than 19.5,
     the chip sits 14 over the strip rather than 18, the title block rose 4 and
     the frame and foot dropped 4. Taken in one place, any of those would have
     been a change somebody could see. */
  const lines = balanceLines(statement(journey), box - 160);
  let y = ruleY + 30;
  for (const line of lines) {
    citationLine(doc, line, mid, y, box);
    y += 18.5;
  }

  /* The honour — top three of a line only — set in a tinted chip. A chip rather
     than another line of type because this is the one thing on the page that is
     an award rather than a record, and because a box is how this design system
     emphasises without reaching for a medal. */
  /* Both ranks share the one chip, split by a hairline in the chip's own
     keyline blue: two chips side by side would read as two awards, and one
     run of type joined by a middot reads as one long label nobody finishes. */
  const marks = honour(journey);
  let chipBottom = y;
  if (marks.length > 0) {
    const labels = marks.map((mark) => mark.toUpperCase());
    const widths = labels.map((label) => measure(label, 7.6, "bold", 1.8));
    const gap = 16;
    const chipW = widths.reduce((n, w) => n + w, 0) + gap * 2 * (labels.length - 1) + 36;
    const chipX = mid + (box - chipW) / 2;
    const chipY = y - 5;
    chipBottom = chipY + 24;
    doc.rect(chipX, chipY, chipW, 24, TINT);
    /* Holding both ranks, the chip reaches the tail of the wordmark, and a flat
       tint painted across a watermark cuts it with a straight edge — the thing
       that gives away a raster on paper, and the reason the figures strip keeps
       a floor. There is no transparency for it to show through, so the part
       under the chip is drawn again: the same artwork in the same place,
       flattened against the chip's tint instead of the paper and clipped to the
       chip, so the stroke runs on under the keyline. The second raster is paid
       for only by a certificate whose chip actually reaches the wordmark. */
    const under = watermark;
    const tinted =
      under && chipX + chipW > under.x && chipY < ARABIC_TOP + ARABIC_H
        ? satoMark("arabic", TINT, { color: INK, strength: ARABIC_INK })
        : null;
    if (under && tinted) {
      doc.clip(chipX, chipY, chipW, 24, (d) => {
        d.image(tinted, under.x, ARABIC_TOP, under.w, ARABIC_H);
      });
    }
    frame(doc, chipX, chipY, chipW, 24, TINT_LINE, 1);
    let x = chipX + 18;
    labels.forEach((label, index) => {
      if (index > 0) doc.rect(x - gap, chipY + 6, 1, 12, TINT_LINE);
      doc.text(label, x, chipY + 16, {
        size: 7.6,
        face: "bold",
        tracking: 1.8,
        color: BRAND,
      });
      x += widths[index] + gap * 2;
    });
  }

  /* ---------------------------------------------------------- the figures --
     The key cards on a tinted strip closed top and bottom and divided by
     hairlines. The dividers are what make it a table of figures rather than
     stray numbers, and the strip is the only tint on the page. At half the name's size they are
     clearly the supporting evidence and not the headline, which is the right
     way round for a document somebody is proud of.

     Its position has a floor rather than being a number: everything above it now
     moves with the name's own descender, and a two-line citation under a chip
     would otherwise sit on top of it. It lands at 388 for every name that does
     not need the room, which is nearly all of them. */
  const stripY = Math.max(400, chipBottom + 14);
  const stripH = 44;
  const stripX = mid + 20;
  const stripW = box - 40;
  doc.rect(stripX, stripY, stripW, stripH, CANVAS);
  doc.rule(stripX, stripY, stripW, INK, 1.2);
  doc.rule(stripX, stripY + stripH, stripW, LINE, 1);

  /* The same cards the journey's last page closes on, from the one function
     both documents read — see keyCards(). Four, or five for somebody with an
     approved order. */
  const figures = keyCards(journey);
  const slot = stripW / figures.length;
  figures.forEach(([value, label], index) => {
    const x = stripX + slot * index;
    if (index > 0) doc.rect(x, stripY + 9, 1, stripH - 18, LINE);
    doc.text(value, x, stripY + 27, {
      size: 22,
      face: "bold",
      color: INK,
      align: "center",
      width: slot,
    });
    doc.text(label.toUpperCase(), x, stripY + 39, {
      ...MICRO,
      size: 6.8,
      color: SOFT,
      align: "center",
      width: slot,
    });
  });

  /* ------------------------------------------------------------- the foot --
     Two columns on one grid: who signed it on the left, what it was issued
     from on the right, and the seal outboard of both. They were nearly aligned
     once — the provenance rows sat three and four points below the signature
     rows — which is the one misalignment that reads as a mistake rather than a
     choice, because the eye resolves "almost" as "wrong". Both columns now
     carry a micro label, a rule at the same height, and rows on the same two
     baselines. */
  const sigY = 492;
  const provW = box - SEAL - 28;

  doc.text("SIGNED", doc.left, sigY - 8, { ...MICRO, size: 6.6, color: FAINT });
  doc.text("RECORD", doc.left, sigY - 8, {
    ...MICRO,
    size: 6.6,
    color: FAINT,
    align: "right",
    width: provW,
  });

  /* Both rules are measured to what sits under them, for the reason the rule
     under the name is: a fixed 214pt rule over a 115pt role line is a number
     nobody chose, and it shows. Drawn full width, the lighter of the two also
     ran straight through the other for eighty points — on the page, a
     signature line that fades out halfway along. */
  const sigRule = ruleFor(
    measure(SIGNATORY.name, 11.5, "bold"),
    measure(SIGNATORY.role + " · " + COMPANY, 8.6),
  );
  /* The record column carries the date of issue and nothing else (owner,
     13 Sep 2026). It printed the FTP number until then, and a certificate is
     handed to strangers: that number is the one the journey's password is cut
     from, so it no longer leaves the portal on this page. */
  const issued = fullDate(journey.span.end);
  const provRule = ruleFor(measure(issued, 9.5, "bold"), measure("Date of issue", 8.6));
  /* The provenance rule is FAINT and not LINE, which is a one-token change and
     was worth rendering all three to settle. LINE is the frame's own grey, so a
     rule drawn in it eight points under a micro label — beside a rule in full
     ink, at the same height, in a column built to mirror it — does not read as
     the quieter of two rules. It reads as a rule that failed to print, because
     the eye has the signature's right there to compare it with. FAINT is the
     colour the label above it and both rows under it are already set in, so the
     rule belongs to its column rather than to the frame, and the step down from
     the signature stays plainly a step. Ink on both was the third render and is
     worse than either: it makes a record id look like a second signature. */
  doc.rule(doc.left, sigY, sigRule, INK, 1);
  doc.rule(doc.left + provW - provRule, sigY, provRule, FAINT, 1);

  doc.text(SIGNATORY.name, doc.left, sigY + 17, {
    size: 11.5,
    face: "bold",
    color: INK,
  });
  doc.text(issued, doc.left, sigY + 17, {
    size: 9.5,
    face: "bold",
    color: BODY,
    align: "right",
    width: provW,
  });
  doc.text(SIGNATORY.role + " · " + COMPANY, doc.left, sigY + 31, {
    size: 8.6,
    color: FAINT,
  });
  doc.text("Date of issue", doc.left, sigY + 31, {
    size: 8.6,
    color: FAINT,
    align: "right",
    width: provW,
  });

  /* The seal is where a certificate would carry wax and this one cannot: a
     circle is the one shape this design system does not own, so it is a square
     ink tile with a keyline inset inside it, the year reversed out, and the
     same brand seam across its foot as the head carries. It is centred on the
     block beside it rather than hung from a round number. */
  const sealX = doc.right - SEAL;
  const sealY = 470;
  doc.rect(sealX, sealY, SEAL, SEAL, INK);
  frame(
    doc,
    sealX + 6,
    sealY + 6,
    SEAL - 12,
    SEAL - 12,
    mix(ON_DARK, INK, 0.5),
    1,
  );
  doc.rect(sealX, sealY + SEAL - 3, SEAL, 3, BRAND);
  /* The two lines sit 22 and 43 below the tile rather than 26 and 47, which is
     the one thing inside the seal a coordinate could not have told anyone. The
     inset keyline is 6pt off all four edges, so the box the type sits in is
     exactly square and the eye holds it to that. The block it holds is the cap
     top of FTP down to the year's baseline — neither line has a descender — and
     at 26/47 that ran 15.3pt below the inset and 11pt above it: symmetrical box,
     type visibly low in it, with the year crowding the keyline it sits over.
     Four points up puts the block 11.3 under and 15 over, which is a shade
     ABOVE centre and is where a block of caps and figures wants to be; dead
     centre was rendered too and reads a touch heavy at the foot. */
  doc.text("FTP", sealX, sealY + 22, {
    size: 7,
    face: "bold",
    tracking: 2.4,
    color: mix(ON_DARK, WHITE, 0.45),
    align: "center",
    width: SEAL,
  });
  doc.text(journey.span.end.slice(0, 4), sealX, sealY + 43, {
    size: 16,
    face: "bold",
    color: WHITE,
    align: "center",
    width: SEAL,
  });

  /* The verification code (owner, 13 Sep 2026): a third column of the foot, on
     the page's spine between the signature and the record, under its own micro
     label on the same baseline as SIGNED and RECORD — so it reads as part of
     the foot's grid rather than as a sticker dropped into the gap. It is 40pt:
     the owner turned down 60 as too large for a signed page. A code needs four
     modules of white on every side, and this one has type above it and the
     inner keyline below, so it hangs a quiet zone under the label's foot and
     shrinks rather than crowds if that leaves less than 40pt before the
     keyline. The keyline is a 1pt rectangle whose box ends at frameH - 7, so
     its ink starts a point above that; the label's foot is taken a quarter of
     its size under the baseline, which is where a run's box ends. */
  const code = verificationCode(journey.identity.verificationId);
  const innerKeyline = frameY + frameH - 7 - 1;
  const verifyFoot = sigY - 8 + 6.6 * 0.25;
  const qrRoom = innerKeyline - verifyFoot;
  const qrSide = Math.min(40, (qrRoom * code.size) / (code.size + 2 * QR_QUIET));
  doc.text("SCAN TO VERIFY", mid + box / 2 - 60, sigY - 8, {
    ...MICRO,
    size: 6.6,
    color: FAINT,
    align: "center",
    width: 120,
  });
  drawVerificationQr(
    doc,
    code,
    mid + box / 2 - qrSide / 2,
    verifyFoot + (QR_QUIET * qrSide) / code.size,
    qrSide,
  );

  /* What this page is, said plainly — and set OUTSIDE the keyline, because the
     frame holds the certificate and this is a note about where it came from.
     It claims nothing about employment, and saying so is cheaper than being
     asked. */
  doc.text(
    "Issued from the Future Talents portal. The figures above are the record it holds for this programme.",
    mid,
    H - BASE - 15,
    { size: 7.6, color: FAINT, tracking: 0.4, align: "center", width: box },
  );

  return doc.bytes();
}

/**
 * Words a line of the citation may not end on.
 *
 * Not "any short word": the OTC line is three letters and ends a line perfectly
 * well. These are function words, which point at the word after them, so a
 * centred line that ends on one leaves the reader mid-phrase across a line
 * break — "on the OTC line in / Cairo" being the one that was actually on the
 * page. The list is deliberately small and literal rather than a rule about
 * length or a part-of-speech test, because everything it has to cover is in
 * this one generated sentence.
 */
const DANGLERS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "from",
  "by",
  "with",
]);

/**
 * The citation, broken the way somebody would break it by hand.
 *
 * wrapText() is greedy — it fills each line to the measure and moves on, which
 * is right for a column of body text and wrong for one centred sentence with
 * air on both sides of it. At the 500pt cap this page gives it, the 2026
 * citation came out **474pt over 262pt**: a long line, a short line, and "in"
 * stranded at the end of the first one, away from the Cairo it belongs to. Both
 * halves of that are invisible in the source, because the wrap is correct — it
 * is the measure that is wrong, and the right measure depends on the sentence.
 *
 * So the measure is searched for rather than chosen. Every width from the cap
 * down is tried; the ones that need MORE lines than the cap does are discarded,
 * because a balanced sentence is not worth an extra line on a page this short.
 * Of the rest, one that ends no line on a DANGLER wins over one that does, and
 * between two of the same kind the more even pair of lines wins. The 2026
 * citation lands at 366/371 breaking after "programme", and the longest line
 * and area a roster could plausibly carry lands at 466/377 after "Pediatrics".
 *
 * If every candidate strands a function word — a sentence with no good break in
 * it — the evenest wrap is still returned. A citation set slightly badly is a
 * citation; no citation is a defect.
 */
function balanceLines(words: Word[], cap: number): Word[][] {
  const target = wrapWords(words, cap).length;
  if (target < 2) return wrapWords(words, cap);

  let best: Word[][] | null = null;
  let bestScore = Infinity;
  /* Greedy wrapping at any width fills a line past its comma whenever the next
     word fits, so no width alone sets one clause to a line: at the width that
     holds the first clause, the second line swallows the "and" of the third.
     So the clauses are also packed whole, as one more candidate scored on the
     same terms as the rest. */
  const packed: Word[][] = [];
  let clause: Word[] = [];
  words.forEach((word, index) => {
    clause.push(word);
    if (!word.text.endsWith(",") && index < words.length - 1) return;
    const last = packed[packed.length - 1];
    if (last && lineWidth([...last, ...clause]) <= cap) last.push(...clause);
    else packed.push(clause);
    clause = [];
  });
  const fits = packed.every((line) => lineWidth(line) <= cap);
  const candidates = fits ? [packed] : [];
  for (let w = cap; w >= 160; w -= 2) candidates.push(wrapWords(words, w));

  for (const lines of candidates) {
    if (lines.length !== target) continue;
    const widths = lines.map(lineWidth);
    const spread = Math.max(...widths) - Math.min(...widths);
    const dangles = lines
      .slice(0, -1)
      .some((line) => DANGLERS.has(line[line.length - 1].text.toLowerCase()));
    /* A line that ends inside a clause rather than on its comma costs less than
       a stranded function word and more than any imbalance on this page. The
       sentence is three clauses — where, the training, the role — and set one to
       a line it reads as a citation; set evenly it splits "medical / sales
       promotion" and "Medical / Representative" for the sake of a tidy block. */
    const loose = lines
      .slice(0, -1)
      .filter((line) => !/[,.;]$/.test(line[line.length - 1].text)).length;
    /* A stranded function word costs more than any imbalance can: the widest
       spread available here is under 400pt, so the penalty cannot be traded
       against evenness by a sentence that happens to break badly. */
    const score = spread + (dangles ? 1000 : 0) + loose * 300;
    if (score < bestScore) {
      bestScore = score;
      best = lines;
    }
  }
  return best ?? wrapWords(words, cap);
}

/**
 * A rule measured to the two lines that sit under it.
 *
 * The same argument as the rule under the name, applied to the foot: a rule
 * whose length nobody chose looks exactly like a rule whose length nobody
 * chose.
 */
function ruleFor(a: number, b: number): number {
  return Math.max(150, Math.max(a, b) + 48);
}

/**
 * A rectangle drawn as four hairlines rather than filled.
 *
 * The writer has no stroked rectangle and does not need one: four rects are
 * four rects, and doing it here keeps the weight explicit at every call site,
 * which is what a double keyline needs.
 */
function frame(
  doc: Pdf,
  x: number,
  y: number,
  w: number,
  h: number,
  color: RgbColor,
  weight: number,
) {
  doc.rect(x, y, w, weight, color);
  doc.rect(x, y + h - weight, w, weight, color);
  doc.rect(x, y, weight, h, color);
  doc.rect(x + w - weight, y, weight, h, color);
}

/**
 * The four corner ticks.
 *
 * Two short ink rules at each corner, over the keyline. This is the one piece
 * of ornament on the page and it earns its place: it is what a reader reads as
 * engraved, it costs eight rectangles, and it is the reason the keylines can
 * stay hairline-light and still feel finished.
 */
function corners(
  doc: Pdf,
  x: number,
  y: number,
  w: number,
  h: number,
  arm: number,
) {
  const t = 1.4;
  const right = x + w - arm;
  const bottom = y + h - t;
  doc.rect(x, y, arm, t, INK);
  doc.rect(x, y, t, arm, INK);
  doc.rect(right, y, arm, t, INK);
  doc.rect(x + w - t, y, t, arm, INK);
  doc.rect(x, bottom, arm, t, INK);
  doc.rect(x, y + h - arm, t, arm, INK);
  doc.rect(right, bottom, arm, t, INK);
  doc.rect(x + w - t, y + h - arm, t, arm, INK);
}
