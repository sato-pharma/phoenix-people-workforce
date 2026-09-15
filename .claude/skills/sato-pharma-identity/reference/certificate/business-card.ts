/**
 * The intern's business card, and the sheet it is printed from.
 *
 * WHY THIS EXISTS AND WHAT IT IS NOT. A Future Talents intern spends four weeks
 * calling on doctors and pharmacists as Sato Pharma, and has had nothing to
 * leave behind — the certificate is the document that says the programme
 * happened, and this is the one that says it is happening. It carries a name, a
 * role, a line, an area and two ways to be reached, and it carries nothing that
 * has to be true tomorrow: no score, no rank, no claim about performance. That
 * is the same rule the journey's sentences follow for the same reason.
 *
 * TWO OUTPUTS, ONE DRAWING. `renderBusinessCard()` is a single card on a page
 * exactly the size of the card, for a print shop or a proof; `renderCardSheet()`
 * is A4 with ten of them butted two by five, fronts and backs on alternating
 * pages. Both call `front()` and `back()`, so a change to the design cannot
 * reach one and miss the other.
 *
 * THE COLOUR IS ON THE BACK, WHICH IS THE WHOLE OF THE DESIGN. The first build
 * put a navy panel down the right of the face carrying the mark, the year and
 * the roster id (both since gone from the card) — a badge, and it took 28 per cent of the front away from the
 * person whose card it is. A card of this kind is quiet on the side it is read
 * from and solid on the side it is not: the face is white, held by a 3pt brand
 * seam down its leading edge, and everything on it is set off one left margin
 * so the name, the rule under the role and the contact block share an edge. The
 * back is the flood, with the mark centred and one strap under a hairline. That
 * is not a preference about cards — it is the same rule the certificate follows,
 * where the navy masses hold the page top and bottom and the middle is left to
 * the name.
 *
 * WHAT IS PRINT-READY ABOUT IT, because a PDF of rectangles is not automatically
 * that. The cards are **butted** rather than gapped: one guillotine cut serves
 * two cards, and — the part that matters — each card's neighbour supplies the
 * bleed that a full-bleed colour would otherwise need, so a cut that drifts moves
 * ink from one card onto another rather than leaving a white hairline. That
 * argument stops at the edge of the block, which is why `BLEED` exists and why
 * the outermost cards paint their flood colours past the trim. Crop marks sit in
 * the margin at every cut line, outside the trim, where a blade can reach them.
 * There is deliberately **no keyline inset from the trim** on either face: an
 * 8pt border is the one ornament that turns an ordinary 0.5mm cutting drift into
 * a visibly crooked card, and this is a document that gets guillotined.
 *
 * THE BACKS ARE MIRRORED, and that now changes something. It used to change
 * nothing: every back was the same drawing and symmetric about its own centre,
 * so a sheet printed without the mirroring came out identical and nobody could
 * have told. The brand seam moved from the back's foot to its edge so that the
 * card has ONE blue edge rather than two blue stripes — see back() — and an
 * edge is the one thing on a card that a duplex flip can put on the wrong side.
 * The mirroring is load-bearing from here on, and the test for it finally
 * asserts something a wrong sheet would fail.
 */

import {
  A4_HEIGHT,
  A4_WIDTH,
  MM,
  Pdf,
  measure,
  mix,
  rgb,
  wrapText,
  type PdfFont,
  type RgbColor,
} from "./pdf.ts";
import { satoBadge } from "./journey-pdf.ts";
import { SATO_MARK_RATIO, satoMarkInk, type SatoMarkArt } from "./sato-mark.ts";
import { pdfFont } from "./truetype.ts";

/* The palette, off globals.css, as in journey-pdf.ts and certificate-pdf.ts. */
const BRAND = rgb("#0879b8");
const INK = rgb("#111820");
const BODY = rgb("#45515a");
const SOFT = rgb("#69757e");
const LINE = rgb("#dde4e8");
const WHITE = rgb("#ffffff");
/** The grey that stays legible on the navy, as on the journey's cover. */
const ON_DARK = rgb("#8d9aa4");

/**
 * 90 x 50 mm, which is the ordinary business card in Egypt.
 *
 * The European standard is 85 x 55 and the American one 3.5 x 2 inches; a print
 * shop in Cairo will cut 90 x 50 without being asked twice. It is the one number
 * on this page that is a local convention rather than a consequence, so it is a
 * single constant: change these two and the sheet re-lays itself, because every
 * other measurement below is derived from them or from the margin.
 */
export const CARD_W = 90 * MM;
export const CARD_H = 50 * MM;

/** Cards per sheet, and how they sit. Two by five is what A4 holds at this size. */
export const COLUMNS = 2;
export const ROWS = 5;
export const PER_SHEET = COLUMNS * ROWS;

/**
 * How far a full-bleed colour runs past the trim, at the edge of the block.
 *
 * 3mm is the trade's number. Inside the block it is unnecessary — the next card
 * along is the bleed — so this only ever applies on the four outer edges, which
 * is what `bleedFor()` works out.
 */
export const BLEED = 3 * MM;

/** The brand seam down the leading edge of the face, and the foot of the back. */
export const SEAM = 3;

/**
 * The margin every mark on the face is set off, and the column it leaves.
 *
 * One number, used on all four sides, because a card whose left margin is not
 * its right margin is the thing that reads as cheap before anybody can say why.
 *
 * It was 18 rather than 14, on the argument that the face carries no panel any
 * more so the air is the only thing holding it. That argument was made when
 * the lower half of the card held TWO contact rows and had air to spare. With
 * the company's address on it there are three, and 18 a side put 6.35mm of
 * white around a block whose own rows were 8 apart and whose divider had 2.35
 * of air on each side — which is not air holding the composition, it is air
 * hoarded at the edge while the middle of the card is starved. The owner's
 * verdict on the emitted page was the plain one: the rows are very near each
 * other and the rule above them wants more room.
 *
 * 14 is 4.94mm, still the generous end of a trade margin and well clear of any
 * guillotine drift the bleed is there to absorb, and it buys 8 points — four
 * at the head, four at the foot — which is exactly what the block needed to go
 * back to a 10 lead with 4.3 of air under the rule. It also WIDENS the column
 * by 8, which is why the address now sets a fifth of a point larger than it
 * did. Every one of those numbers is derived from this one, so this is the
 * only place any of them is decided.
 */
export const PAD = 14;
export const COLUMN = CARD_W - PAD * 2;

/**
 * The name's largest size, its floor, and its leading.
 *
 * A name is never abbreviated and never truncated — the same rule the
 * certificate holds, and for a stronger reason here, since this is the card the
 * person hands to somebody who has to be able to read it back. A long Egyptian
 * name **wraps** to a second line, which is what a card does; only when two
 * lines will not hold it does the size step down at all. Every name on the 2026
 * roster, up to the 35-character longest, sets at the full 16pt over two lines
 * in the 219pt column — so the floor is a safety net for a name longer than
 * anyone here has, exactly as the certificate's 22pt is.
 *
 * 16pt is eleven per cent of the height of the card, which is larger than it
 * sounds and is the point: the first build set the name at 13 beside a navy
 * panel that was competing with it, and the person whose card it is should not
 * be the second thing on it.
 */
export const NAME_MAX = 15;
export const NAME_MIN = 10.5;
/**
 * Baseline to baseline, as a multiple of the size — and it is deliberately the
 * one measurement left on this face that is a ratio rather than air.
 *
 * Everything else is derived from the ink, because the gaps between the mark,
 * the name, the role, its tick and the posting are distances between DIFFERENT
 * objects, and what an eye reads there is the paper between them. Leading is
 * not that. It is the texture of one block of type, and a block set to a fixed
 * amount of air changes texture with every face it is set in, which is the
 * wrong way round: the designer of a face chose the relationship between its
 * cap, its x-height and its descender, and a leading expressed as a multiple
 * of the size is what carries that relationship into any size and any face.
 *
 * What it costs was looked at rather than assumed, because Montserrat hangs
 * 251 below the baseline where Helvetica hung 207. At 16pt the lines sit 17.28
 * apart, so a descender on the first line clears the second line's cap by 2.06
 * where it used to clear it by 2.48, and by less again where that line opens on
 * an ascender rather than a capital. Tight, and chosen: 1.08 is what makes two
 * lines of one name read as one object, which is the same argument the negative
 * tracking below makes. It is a floor and not a comfort — fit a face that hangs
 * deeper than this one and the page has to be looked at again, because this
 * number will not move itself.
 */
const NAME_LEAD = 1.08;
/**
 * The band the name is set in, and why it is a band and not a baseline.
 *
 * The block used to hang from a single baseline at 68. That put a two-line
 * name exactly where it belonged and left a one-line name floating: twenty-six
 * points of empty paper between the mark and the top of the name, so the card
 * read as a different design depending on how many words somebody's parents
 * gave them - and roughly half the roster fits on one line. The block is now
 * centred in the air between the mark and the role, by its VISUAL extent, cap
 * line to descender, rather than by its baselines. One line sits in the middle
 * of that space; two lines fill it; nothing below the name moves either way.
 *
 * The band itself is DERIVED, in the spine below: it is exactly the height two
 * lines at full size need, cap line to descender, because that is the setting
 * it has to hold. Give it slack and a one-line name is centred on air nobody
 * chose; take any away and the longest name on the roster walks into the role.
 */

/**
 * Display type wants a little less air between its letters than body type.
 *
 * Two tenths of a point at 16, which is under one and a half per cent - it is
 * not felt as tightness, only as a name that holds together as one object. It
 * goes through `wrapText` as well as through the setting, or the wrap measures
 * a line this file then prints at a different width.
 */
const NAME_TRACK = -0.2;

/**
 * Helvetica's capital height and descender depth, out of its own AFM.
 *
 * The name is centred on what it LOOKS like it occupies, and a baseline is
 * neither. These are the FALLBACK's numbers rather than the card's, though:
 * what the spine is built on when the two files below cannot be read, and
 * nothing else. The card's own come off whichever face is actually in force —
 * see `cardType()` — because a cap height is a property of a typeface and not
 * of this file, and Montserrat puts 700 units of the em into a capital where
 * Helvetica puts 718. Exported because `tests/business-card.test.mts` measures
 * a run of base-14 type by the same box this file sets it in, and a test
 * carrying its own copy of 0.718 would go on passing the day this file stopped
 * agreeing with it.
 */
export const CAP = 0.718;
export const DESCENDER = 0.207;

/**
 * The card is set in Montserrat, and that was a licensing question first.
 *
 * Every line on this card was Helvetica, which is the one face that means no
 * face was chosen — and this is the document in the programme where that
 * shows, because it is the only one somebody holds. The rule the certificate's
 * script settled applies here unchanged and it is the rule that decides the
 * shortlist: the file is committed to this repository and shipped to a Linux
 * server, which is redistribution, so the OS/2 `fsType` bits are not the
 * permission that matters and the licence has to allow it outright. Montserrat
 * is under the SIL Open Font License 1.1, whose text already sits in
 * `public/fonts` beside it because the certificate's face needed it there.
 *
 * Why this one, of the faces that clear that bar. It is geometric, which is
 * the same claim a design system makes when it says every corner is 90°; its
 * heritage is signage, so letterspaced capitals are its strongest register and
 * that is exactly this card's micro voice — the role, the posting, the labels,
 * the id; and it is the closest geometric relative to the Sato Pharma wordmark
 * sitting directly above the name. Roboto was rejected for being Android's
 * default, which reads as a default; Rubik for rounded terminals, which fight
 * the identity rather than carry it; and Barlow Condensed for condensing a
 * name, which is the one thing this card's own rules forbid.
 *
 * TWO FACES OR NONE. Six of the eight items on this card are bold and two are
 * regular, so half an embedded family is a card whose name is Montserrat and
 * whose email address is Helvetica — plainly worse than Helvetica throughout,
 * and a failure nothing on the page announces. If either file fails to read,
 * both are dropped together: `doc.text()` takes a null font and falls back to
 * the `face` beside it, and the metrics fall back with it.
 */
const DISPLAY_FILE = "sans-bold.ttf";
const TEXT_FILE = "sans-regular.ttf";

/** The two faces the card is set in, and what their ink does. */
export type CardType = {
  /** The bold face, or null for Helvetica-Bold. Handed straight to `font:`. */
  display: PdfFont | null;
  /** The regular face, or null for Helvetica. */
  text: PdfFont | null;
  /** The display face's cap height and descender, as fractions of the em. */
  cap: number;
  descender: number;
  /** And the text face's, which is what the two contact values are set in. */
  bodyCap: number;
  bodyDescender: number;
};

/**
 * The faces this card is actually going to be set in, with their own metrics.
 *
 * `pdfFont()` reads the file off disk and caches the answer — including a null
 * — so this costs one read per face per process however many cards are printed.
 * Exported for the test, which has to measure a run in the face it was set in
 * rather than in the face this file used to use.
 */
export function cardType(): CardType {
  const display = pdfFont(DISPLAY_FILE);
  const text = pdfFont(TEXT_FILE);
  if (!display || !text) {
    return {
      display: null,
      text: null,
      cap: CAP,
      descender: DESCENDER,
      bodyCap: CAP,
      bodyDescender: DESCENDER,
    };
  }
  return {
    display,
    text,
    cap: display.capHeight / 1000,
    descender: Math.abs(display.descent) / 1000,
    bodyCap: text.capHeight / 1000,
    bodyDescender: Math.abs(text.descent) / 1000,
  };
}

/**
 * The rest of the spine, and every line of it is a GAP rather than a position.
 *
 * This was seven coordinates measured from the top of the card, which is a
 * rhythm written down as its answers: move the mark and the seven numbers
 * under it are all quietly wrong, in a diff that shows one line changed. Each
 * gap below is the air between the INK of one thing and the ink of the next
 * — a cap line, a descender, the bottom of a rule — and the coordinates are
 * derived from them in order. Only the gaps are decisions; everything else is
 * arithmetic, which is the only way a spine stays a rhythm.
 */
/**
 * How tall the mark's INK is on the face, and it is on the margin like the rest.
 *
 * Not the height of the file it comes out of: see `markFrame()` below for the
 * seven per cent of clear space that sits between the two, and for why a mark
 * placed by the edges of its own file is misaligned with everything set under
 * it. Exported for the same reason the metrics above are.
 */
export const MARK_INK_H = 13;
const MARK_FOOT = PAD + MARK_INK_H;

/**
 * The face has two VOICES, and it used to have three sizes pretending to be one.
 *
 * Body is what a person reads off the card and dials: the contact rows, and
 * nothing else. Micro is everything the company says about them — the role,
 * the posting — set in caps and letterspaced,
 * which is how this design system has always spoken in the margins.
 *
 * The posting was the odd one out and it was a composition problem rather than
 * a size problem. Set in body grey at 7.2 it looked exactly like the contact
 * rows, so the hairline under it appeared to cut a block of three body lines
 * into one and two, for no reason the eye could name. It is micro now, which
 * puts it where it belongs — with the role, in the block that says what this
 * person does — and the divider goes back to separating the card's two
 * statements rather than interrupting one of them. It also pays for the mark:
 * a micro posting is 3pt shorter than a body one, which is exactly what the
 * mark grew by, so the divider kept the air it was given in the pass before.
 */
/* Both are exported, because the suite can no longer find the body size by
   looking at the phone number. It used to: the phone was the one row that had
   never had to step down, so its size WAS the body size, and reading it off
   the page was better than importing a constant the module could quietly move.
   The address ended that — the block steps as a whole now, so on a card whose
   address is long the phone steps with it and the proxy reports 6.6 as though
   it were the full size, which is an assertion that agrees with the code and
   not with the page. The ceiling has to come from here; what the test still
   derives, and the part actually worth deriving, is that the size it settled
   on is the LARGEST one that fits — one notch up has to overflow, or the clamp
   stopped somewhere nobody chose. */
export const BODY_SIZE = 7.2;
export const BODY_MIN = 6;

const ROLE_SIZE = 5.8;
const POSTING_SIZE = 5;
const LABEL_SIZE = 5;

/**
 * The four marks that say what each contact row is, and they are DISCS.
 *
 * The owner's ruling on 12 Sep 2026, with a reference beside it: a filled blue
 * circle with a white glyph standing in it — a handset, an envelope, a globe, a
 * pin — which is how a contact line is marked on nearly every card a pharmacist
 * has ever been handed. Two sets of marks drawn out of rectangles came before
 * this and both were refused, the second in three words. The rule that kept
 * them square — this design system owns the rectangle and not the circle — is a
 * rule about the system's own furniture, and these are not furniture: they are
 * pictograms whose whole value is that a reader has seen them a thousand times.
 * A square phone is a phone nobody has seen.
 *
 * The disc is what makes them read, and that is a finding rather than a taste.
 * A glyph drawn bare at a capital's height has nothing round it to separate it
 * from the type beside it, so its silhouette has to carry the whole
 * identification alone; inside a disc the disc does the separating and the
 * glyph only has to be recognisable. It is why none of the six bare handsets
 * drawn in the pass before survived.
 *
 * Still no icon font and no icon library, which would be the fifth runtime
 * dependency: every disc and glyph is a polygon or a stroked polyline out of
 * pdf.ts, and a curve is sampled into straight segments finely enough that no
 * reader at card distance can see a facet. The writer has no curve operator and
 * does not need one.
 *
 * Sizes are fractions of the row's CAP HEIGHT, so the marks step with the block
 * and change with the face. The disc is larger than a capital — it has to hold
 * a glyph — and is centred on the middle of the cap box, so the column of discs
 * lines up with the type's optical centre rather than with its baseline.
 */
export const DISC = 1.3;
/** The air between a disc and its value, as a fraction of the body size. */
export const GUTTER = 0.6;

type ContactKind = "phone" | "email" | "web" | "address";

/** Points round an ellipse, `from` to `to` in radians, y DOWN the page. */
function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  steps: number,
  from = 0,
  to = Math.PI * 2,
): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

/**
 * One mark: a disc in `color` with its glyph in paper, centred on the middle of
 * the cap box of the row whose baseline is given.
 *
 * The glyph is PAINTED in paper — there is no transparency in this writer and
 * deliberately none — which is fine because every mark sits on the white face.
 * Nothing on the navy back calls this, and the suite says so.
 */
function contactIcon(
  doc: Pdf,
  kind: ContactKind,
  x: number,
  baseline: number,
  capHeight: number,
  color: RgbColor,
) {
  const r = (capHeight * DISC) / 2;
  const cx = x + r;
  const cy = baseline - capHeight / 2;
  /* Forty-eight sides: at card distance the eye resolves about twenty-four
     steps across a disc this size, so every facet is under half of one. */
  doc.polygon(arc(cx, cy, r, r, 48).slice(0, -1), color);
  const u = r;

  if (kind === "phone") {
    /* The receiver on a diagonal: a curved band bowing toward the lower left,
       thickened at both ends into the ear and mouth pieces, which stand in
       toward the curve's centre. One filled outline, then the same outline
       stroked in paper with round joins, which is what softens its corners —
       a polygon has none of its own. */
    const ox = cx + 0.5 * u;
    const oy = cy - 0.5 * u;
    const OUT = 0.98 * u;
    const IN = 0.74 * u;
    const PAD = 0.5 * u;
    const a0 = Math.PI * 0.5;
    const a1 = Math.PI;
    const pw = Math.PI * 0.15;
    const outline = [
      ...arc(ox, oy, OUT, OUT, 20, a0, a1),
      ...arc(ox, oy, PAD, PAD, 4, a1, a1 - pw),
      ...arc(ox, oy, IN, IN, 12, a1 - pw, a0 + pw),
      ...arc(ox, oy, PAD, PAD, 4, a0 + pw, a0),
    ];
    doc.polygon(outline, WHITE);
    doc.polyline([...outline, outline[0]], WHITE, 0.1 * u);
    return;
  }

  if (kind === "email") {
    /* A landscape envelope with its flap creased in the disc's own colour, from
       the top corners — inset half a pen so the round cap lands on them. */
    const w = 1.12 * u;
    const h = 0.78 * u;
    const left = cx - w / 2;
    const top = cy - h / 2;
    doc.rect(left, top, w, h, WHITE);
    const pen = 0.13 * u;
    doc.polyline(
      [
        [left + pen / 2, top + pen / 2],
        [cx, top + h * 0.56],
        [left + w - pen / 2, top + pen / 2],
      ],
      color,
      pen,
    );
    return;
  }

  if (kind === "web") {
    /* The globe: its outline, one meridian, the equator and two parallels. The
       parallels stop half a pen short of the outline, or their round caps poke
       through it. */
    const g = 0.62 * u;
    const pen = 0.1 * u;
    doc.polyline(arc(cx, cy, g, g, 40), WHITE, pen);
    doc.polyline(arc(cx, cy, g * 0.42, g, 32), WHITE, pen);
    doc.polyline(
      [
        [cx - g, cy],
        [cx + g, cy],
      ],
      WHITE,
      pen,
    );
    const lat = g * 0.5;
    const half = Math.sqrt(g * g - lat * lat) - pen / 2;
    for (const y of [cy - lat, cy + lat])
      doc.polyline(
        [
          [cx - half, y],
          [cx + half, y],
        ],
        WHITE,
        pen,
      );
    return;
  }

  /* The pin: a round head running down to a point along its two tangents, with
     the hole through the head in the disc's colour. */
  const hr = 0.4 * u;
  const hy = cy - 0.16 * u;
  const tipY = cy + 0.68 * u;
  const spread = Math.acos(hr / (tipY - hy));
  const outline = arc(
    cx,
    hy,
    hr,
    hr,
    36,
    Math.PI / 2 - spread,
    Math.PI / 2 + spread - Math.PI * 2,
  );
  doc.polygon([[cx, tipY], ...outline], WHITE);
  doc.polygon(arc(cx, hy, 0.16 * u, 0.16 * u, 24).slice(0, -1), color);
}

/** The hairline weights: the divider across the column, and the role's tick. */
const DIVIDER_H = 0.5;
const TICK_H = 1.2;

/* --- the four decisions, in the order the eye meets them ------------------ */

/* All four are exported, because they are the only numbers on this face that
   are decisions, and `tests/business-card.test.mts` measures the air the page
   actually carries between each pair of inked objects against them. That is
   not a test agreeing with the code: the gap asked for is a decision and may
   be moved freely, while the gap DELIVERED depends on the cap height and the
   descender of whatever face the card is set in — so the assertion is that the
   spine's arithmetic is reading the right face, which is the one thing here
   that a wrong answer makes invisible. */
/** Mark's foot to the name's band. The largest step on the card, and the only
    one that separates the company from the person. */
export const GAP_MARK_NAME = 6.5;
/** The name's band to the role's cap line. The role belongs to the name. */
export const GAP_NAME_ROLE = 5;
/** The role's baseline to its tick. An underline, so it is set by the type. */
export const GAP_ROLE_TICK = 3.5;
/** The tick to the posting's cap line. */
export const GAP_TICK_POSTING = 3.5;

/* --- and the arithmetic ---------------------------------------------------

   The head hangs off the mark and the foot hangs off the trim, which is what
   makes the margin one number on all four sides: the last row's DESCENDER
   sits PAD above the edge, exactly as the mark's cap line sits PAD below the
   top and the column sits PAD inside both sides. It was 13.2 at the foot
   against 18 everywhere else — the sort of difference that is invisible held
   up to a ruler and obvious held at arm's length. The divider then takes
   whatever is left between the posting and the contacts and splits it in two,
   so the rule that separates the card's two statements has the same air above
   it as below. It had 4.55 and 6.83. */
const NAME_TOP = MARK_FOOT + GAP_MARK_NAME;
/**
 * Baseline to baseline down the contact block.
 *
 * It was 10.5, which is 146 per cent of the body size — generous, and it could
 * afford to be while there were two rows. The address is a third, and a third
 * row does not fit: the block hangs from the last baseline, so it grows UPWARD,
 * and at 10.5 its first line arrives 0.37 above the posting's baseline. The
 * page still opens and validates with the posting printed through the phone
 * number, which is the failure this card has now produced four times.
 *
 * It was 8 for one round and 8 was too tight — the owner read the page and
 * said so, which is the only test this number has. 8 was arrived at by taking
 * the space out of the leading because that was the cheapest place on the card
 * to find it; the mistake was accepting that the card had nowhere else, when
 * the margin was holding 6.35mm a side. The margin is 14 now and this is 10,
 * which is 147 per cent of the size the block sets at — the same generosity
 * the two-row card had at 10.5, restored rather than invented.
 *
 * It is stated as air and not as a ratio, which is the opposite of NAME_LEAD
 * one screen up and for that constant's own reason: leading is the texture of
 * ONE block and these rows are three different objects, so what the eye reads
 * between them is paper. It is the least
 * damaging place to find the space: the alternatives were the name's band, the
 * mark, or the four gaps, and every one of those is a decision somebody made
 * on the page rather than a value that happened to be loose.
 */
const CONTACT_LEAD = 9;

/**
 * The back's own spine, on the same rule: two gaps and the rest is derived.
 *
 * The block is centred in the field ABOVE the brand seam rather than on the
 * card, because the seam reads as the foot of this side and not as part of its
 * field. The rule between the mark and the strap is centred on the air between
 * them — it had 16 points over it and 9.3 under it, which put a separator
 * visibly closer to one of the two things it separates.
 */
/**
 * The back is the one surface on this card with room, and it was not using it.
 *
 * A 90 x 50 navy field carried a mark a fifth of its width and two thirds of
 * the card was empty — which is the owner's verdict on the certificate ("Sato
 * branding is so low") standing unanswered on the side of the document that
 * has nothing else to say. It is 35 per cent of the width now, and the strap
 * grew with it, because a 5.2pt line under a mark this size reads as a caption
 * somebody forgot to set. The face is the opposite decision and deliberately
 * so: there the mark INTRODUCES a person and is smaller than their name, here
 * it DECLARES a company and takes the field. Same argument as the certificate,
 * where the mark crests the page and the name is still the largest thing on it.
 */
const BACK_MARK_INK_H = 34;
const BACK_STRAP_SIZE = 6;
const BACK_RULE_H = 1;
/** The air over the rule and under it, which is the whole of the back's design. */
const BACK_GAP = 13;

/**
 * The field the seam leaves the block, and it is a WIDTH now rather than a
 * height, because the seam moved from the foot to the edge. See back().
 */
const BACK_FIELD = CARD_W - SEAM;

/**
 * And the arithmetic, which is a function of the FACE and not a list of
 * constants any more.
 *
 * Every gap on this card is measured to the ink — a cap line, a descender, the
 * bottom of a rule — which is the third pass's whole finding; and where the ink
 * of a line of type stops is a property of the typeface rather than of this
 * file. Helvetica puts 718 thousandths of the em into a capital and hangs 207
 * below the baseline. Montserrat puts 700 and hangs 251. Written down, the day
 * the face changed the name's band would have held air nobody chose, the
 * divider would have sat off the middle of its own gap, the foot margin would
 * have stopped being the margin, and the back's block would have been centred
 * on a height that was not its own — none of it visible in the source, all of
 * it the "almost" the eye reads as a mistake. Only the four gaps and the sizes
 * are decisions now; everything below is derived, which is the same rule the
 * spine has followed since the third pass, applied one level further down.
 *
 * The display face and the text face are asked separately rather than averaged
 * into one number. The name, the role, the posting, the labels, the strap and
 * the id are the display face; the phone and the email are the text face, and
 * they are what sets the foot margin and the divider's lower edge. The two
 * weights of one family usually agree about their cap height and this one's do
 * — but a family that did not would put the foot a point out, which is exactly
 * the defect the second pass already paid for once.
 */
function spine(type: CardType) {
  const { cap, descender, bodyCap, bodyDescender } = type;

  const nameBottom = NAME_TOP + NAME_MAX * (cap + NAME_LEAD + descender);
  const roleY = nameBottom + GAP_NAME_ROLE + ROLE_SIZE * cap;
  const tickY = roleY + GAP_ROLE_TICK;
  const postingY = tickY + TICK_H + GAP_TICK_POSTING + POSTING_SIZE * cap;

  /* The last baseline on the card, and the one the deepest descender on it
     hangs from: the foot margin is PAD under that descender and not under the
     baseline, which is what makes the margin one number on all four sides.

     It takes the size the block actually sets at, which is not always
     BODY_SIZE: the block steps as a whole when its widest row will not fit the
     column, and a descender is a fraction of the size it is set in. Written as
     BODY_SIZE it put the foot margin at 18.15 for a block that had stepped —
     a seventh of a point, invisible on the page, and the exact kind of number
     nobody chose that the third pass spent itself removing. */
  const contactLastFor = (size: number) => CARD_H - PAD - size * bodyDescender;

  /* The divider is centred on the INK, and a line of capitals has none below
     its baseline.

     Everywhere else on this card a line is measured by the box its type sits
     in, cap line to descender, because that is what the eye reads for a line
     of mixed case. The posting is upper-cased by this file — not by the
     roster, so it is knowable rather than lucky — which means the descender
     third of its box is guaranteed empty paper. Counting it put a point of
     nothing on one side of the rule and not the other: 5.54 of real air above,
     4.50 below, on the object whose whole job is to sit between two things. It
     is the same defect as the pass before, one point smaller, and one point is
     the size the certificate's foot was wrong by. So the posting's foot is its
     baseline, and the contact row below is met at its cap line.

     It is a FUNCTION of how many contact rows there are, which it was not
     until the address joined them. The block hangs from the last baseline, so
     every row added lifts its top by one lead — and the divider is centred on
     the air between the posting and the FIRST row, not the last. Written as a
     fixed number it was right for two rows and silently wrong for any other
     count: three rows put the rule 10.5 into the air it is supposed to halve,
     and a person with no email on file had it hanging a lead too low. Nothing
     throws either way, which is why it is derived rather than stated. */
  const dividerFor = (rows: number, size: number) =>
    (postingY +
      (contactLastFor(size) -
        CONTACT_LEAD * (rows - 1) -
        (size * bodyCap * (1 + Math.max(1, DISC))) / 2) -
      DIVIDER_H) /
    2;

  const backBlock =
    BACK_MARK_INK_H +
    BACK_GAP +
    BACK_RULE_H +
    BACK_GAP +
    BACK_STRAP_SIZE * cap;
  const backMarkTop = (CARD_H - backBlock) / 2;
  const backRuleY = backMarkTop + BACK_MARK_INK_H + BACK_GAP;
  const backStrapY =
    backRuleY + BACK_RULE_H + BACK_GAP + BACK_STRAP_SIZE * cap;

  return {
    nameBottom,
    roleY,
    tickY,
    postingY,
    contactLastFor,
    dividerFor,
    backMarkTop,
    backRuleY,
    backStrapY,
  };
}

/** The faces, and the spine they imply. One object, settled once per document. */
type CardLayout = CardType & ReturnType<typeof spine>;

function layout(): CardLayout {
  const type = cardType();
  return { ...type, ...spine(type) };
}

const MICRO = { face: "bold", tracking: 1 } as const;

/** What a card needs to know about a person. Nothing that has to be recomputed. */
export type CardPerson = {
  fullName: string;
  submissionId: string;
  line: string | null;
  area: string | null;
  mobile: string | null;
  email: string | null;
};

/** The role every one of them holds. It is the programme, not a job title. */
const ROLE = "MEDICAL PROMOTION INTERN";

/**
 * The address the card gives, and it is the COMPANY's rather than a person's.
 *
 * It is a constant here and not a column for the reason the role is: it is the
 * same on all 65 cards, and an intern's own address has no business on a card
 * handed to a pharmacist. Nothing in the roster holds it — `accounts.address`
 * is where a DOCTOR is, which is the opposite direction — so it cannot be read
 * from anywhere and must be written down once, here.
 *
 * **It is null until somebody who knows it fills it in, and null is the safe
 * state rather than an unfinished one.** The row is filtered out when it has no
 * value, so the card sets exactly as it did before and no reader is handed an
 * address the company does not have. An invented one would be the same defect
 * `cardPhone()` refuses at the row above: a confident wrong answer printed
 * under the Sato Pharma mark, which is worse than no answer at all.
 */
const ADDRESS: string | null =
  "Property No. 8, Model N, Square 1258, Sheraton El Matar, Cairo";

/**
 * The company's website: on the face beside a globe, and on the back under the
 * mark where the programme strap was. The owner took the programme off the card
 * on 12 Sep 2026 -- no roster id on the face and no FUTURE TALENTS PROGRAM on
 * the back -- so what a pharmacist is handed is a Sato Pharma card, and nothing
 * on it says internship except the role.
 */
export const WEBSITE = "www.satopharma.com";

/**
 * An Egyptian mobile, written the way a card should write one.
 *
 * The roster holds ten digits with the trunk zero already gone — `1012345678` —
 * which is a number nobody would read aloud and nobody would dial. It comes out
 * as `+20 10 1234 5678`: international, because the card may be handed to a
 * company that stores it, and grouped, because eleven unbroken digits are
 * misread.
 *
 * Anything that is not recognisably one of those is handed back **as it was
 * stored**, trimmed and nothing else. A formatter that forces an unexpected
 * string into a shape prints a confident wrong number, and a wrong number on a
 * card is worse than an ugly one.
 */
export function cardPhone(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("0020")) digits = digits.slice(4);
  if (digits.startsWith("20") && digits.length === 12) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  if (!/^1[0125]\d{8}$/.test(digits)) return value;
  return `+20 ${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}`;
}

/**
 * An area, tidied for print and **for print only**.
 *
 * `profiles.area` is free text compared with `=` inside the RLS policies since
 * migration 025, so it is a join key: rewriting the stored value is how an
 * intern loses their account picker. This touches nothing but the characters
 * that go on the card — `Sohag1` reads as a typo, `October -Zayed` as a
 * hyphenation accident, and both are on the roster today. The database keeps
 * what it has.
 */
export function tidyArea(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!value) return null;
  return value
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/\s*-\s+|\s+-\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The line and the area as one line of type, either of them possibly absent. */
function posting(person: CardPerson): string | null {
  const area = tidyArea(person.area);
  const line = (person.line ?? "").trim();
  if (line && area) return `${line} · ${area}`;
  return line || area || null;
}

/** A filename that says whose card it is, on certificateFilename()'s pattern. */
export function cardFilename(person: CardPerson): string {
  const name = person.fullName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `ftp2026-card-${name || person.submissionId}.pdf`;
}

/**
 * The box to hand `satoBadge()` so the mark's INK lands where it was asked for.
 *
 * The artwork is 355 x 134 with about seven per cent of clear space on every
 * side of it. That is correct in a logo file and wrong in a layout: drawn at
 * x=18 the mark puts its first letter at 20.3 while the name under it starts
 * at 18, and two and a third points of indent under a name is exactly the
 * "almost aligned" the certificate's foot already taught this project to stop
 * shipping — the eye resolves it as a mistake rather than as a choice. The
 * same seven per cent means a height of 13 draws a mark 11.3 tall, so the
 * number in the spine above is not the number on the paper either.
 *
 * So the caller says where the ink goes and how tall the ink is, and this
 * solves for the frame around it. `satoMarkInk()` measures the file on disk,
 * so new artwork with different clear space moves this with it; when it cannot
 * be read the mark is being set as type, and type has no clear space to
 * correct for, which is why the fallback is the identity.
 */
function markFrame(art: SatoMarkArt, inkHeight: number) {
  const ink = satoMarkInk(art);
  if (!ink) {
    const height = inkHeight;
    const width = height * SATO_MARK_RATIO;
    return { width, height, inkWidth: width, dx: 0, dy: 0 };
  }
  const height = inkHeight / (ink.bottom - ink.top);
  const width = height * SATO_MARK_RATIO;
  return {
    width,
    height,
    inkWidth: (ink.right - ink.left) * width,
    /* From where the ink is asked to start to where the frame must start. */
    dx: -ink.left * width,
    dy: -ink.top * height,
  };
}

/** How far past the trim a flood may run, per side, for a card at (col,row). */
function bleedFor(col: number, row: number) {
  return {
    left: col === 0 ? BLEED : 0,
    right: col === COLUMNS - 1 ? BLEED : 0,
    top: row === 0 ? BLEED : 0,
    bottom: row === ROWS - 1 ? BLEED : 0,
  };
}

type Bleed = ReturnType<typeof bleedFor>;

/** No bleed at all: a single card on its own page has no block to be inside. */
const TRIMMED: Bleed = { left: 0, right: 0, top: 0, bottom: 0 };

/**
 * The face of the card: white, one margin, and the name.
 *
 * `ox`/`oy` are where the card's own top-left corner sits on the page, so the
 * whole drawing is written in card coordinates and placed once. That is what
 * lets the single-card page and the ten-up sheet be the same code rather than
 * two layouts that drift apart.
 *
 * Everything on this face is set off ONE left margin — the mark, the name, the
 * rule under the role, the posting, the contact discs — so the eye has a
 * single edge to travel down. There is nothing hard right any more: the roster
 * id that sat there came off the card with the programme's name, on the
 * owner's ruling of 12 Sep 2026.
 */
function front(
  doc: Pdf,
  person: CardPerson,
  ox: number,
  oy: number,
  bleed: Bleed,
  card: CardLayout,
) {
  /* The brand seam down the leading edge, and the only colour on this side.
     It is the certificate's head treatment stood on end, which is the whole of
     what makes the two documents read as one family. */
  doc.rect(
    ox - bleed.left,
    oy - bleed.top,
    SEAM + bleed.left,
    CARD_H + bleed.top + bleed.bottom,
    BRAND,
  );

  const textX = ox + PAD;

  /* The dark artwork on white paper. Pass the wrong ground and every edge
     haloes — the note in sato-mark.ts — and the ground here is the paper.
     Placed by its INK, so its first letter lands on the same 18pt margin as
     the name, the role and the contacts; the frame it needs in order to do
     that starts a couple of points to the left of the margin. */
  const mark = markFrame("dark", MARK_INK_H);
  satoBadge(
    doc,
    "dark",
    WHITE,
    INK,
    textX + mark.dx,
    oy + PAD + mark.dy,
    mark.height,
  );

  /* -------------------------------------------------------------- the name --
     The column is the whole card now, so a name wraps before it shrinks: two
     lines of 16pt read better on a card than one line of 10. The block is then
     centred in its band by what it LOOKS like it occupies — the cap line of the
     first line down to the descender of the last — so one line sits in the
     middle of the air between the mark and the role instead of hanging at the
     bottom of it, and two lines fill the same band. Nothing below the name
     moves in either case, which is the property the single baseline had and
     the reason it survived as long as it did. */
  const display = card.display ?? "bold";
  let size = NAME_MAX;
  let lines = wrapText(person.fullName, COLUMN, size, display, NAME_TRACK);
  while (size > NAME_MIN && lines.length > 2) {
    size -= 0.5;
    lines = wrapText(person.fullName, COLUMN, size, display, NAME_TRACK);
  }

  const lead = size * NAME_LEAD;
  const extent =
    size * card.cap + lead * (lines.length - 1) + size * card.descender;
  let y = NAME_TOP + (card.nameBottom - NAME_TOP - extent) / 2 + size * card.cap;
  for (const line of lines) {
    doc.text(line, textX, oy + y, {
      size,
      face: "bold",
      font: card.display,
      tracking: NAME_TRACK,
      color: INK,
    });
    y += lead;
  }

  doc.text(ROLE, textX, oy + card.roleY, {
    ...MICRO,
    font: card.display,
    size: ROLE_SIZE,
    tracking: 1,
    color: BRAND,
  });
  /* An underline and not a divider: measured to a quarter of the column, it
     reads as emphasis under the role. The full-width one below is the divider,
     and the two are deliberately different weights and different colours so
     that neither can be mistaken for the other.

     It is brand blue and not black, which settles the colour logic of the
     whole face rather than only this rule: blue is the company — the seam, the
     role, this — and black is the person, their name and the number somebody
     is going to dial. A black stub under a blue line belonged to neither.

     And it is MEASURED, to the first word of the line it sits under. It was
     24pt beside a comment calling it a quarter of the column, which is 54.8 —
     so it was neither a quarter of anything nor a width anybody had chosen,
     which is the case the certificate's three rules already settled: a rule
     the width of the column is a divider and a rule the width of the word is
     an underline, and a number in between is a number that shows. */
  doc.rule(
    textX,
    oy + card.tickY,
    measure(ROLE.split(" ")[0], ROLE_SIZE, display, 1),
    BRAND,
    TICK_H,
  );

  /* Upper case, letterspaced, grey: the role's voice one step quieter. A
     posting is a label the company puts on somebody, not a sentence, and
     setting it as one is what made it read as a stray contact row. */
  const where = posting(person);
  if (where) {
    doc.text(where.toUpperCase(), textX, oy + card.postingY, {
      ...MICRO,
      font: card.display,
      size: POSTING_SIZE,
      tracking: 0.8,
      color: BODY,
    });
  }

  /* ---------------------------------------------------------- the contacts --
     Held apart from the name block by one hairline across the full column,
     because a card is two statements — who this is, and how to reach them —
     and the rule is what says so without a heading. Each row is preceded by a
     drawn mark, because a bare string of digits under a name is not obviously
     a phone number and a bare line of street and district is not obviously an
     address — see `contactIcon`, which is also where the reason they are drawn
     here rather than fetched from an icon set is written down. */
  const phone = cardPhone(person.mobile);
  const email = (person.email ?? "").trim();

  const rows = (
    [
      ["phone", phone, INK],
      ["email", email || null, BODY],
      ["web", WEBSITE, BODY],
      ["address", ADDRESS, BODY],
    ] as const
  ).filter(([, value]) => value);

  /* The mark column is MEASURED, exactly as the letter column was: one disc,
     plus `GUTTER` of an em of the body size as the air before the value.

     It is measured at the FULL body size and not at the size the block ends up
     setting at, which keeps it out of a circle — the column decides how much
     room the values have, the room decides whether the block steps, and the
     step would otherwise decide the column. The marks themselves are drawn at
     whatever size the row settles on, so a stepped block keeps a hair more
     gutter than it strictly needs. That is the right way for it to be wrong:
     the alternative is a column that breathes in and out with the longest
     address on the card.

     It takes the cap height of the face ACTUALLY IN FORCE and not the module's
     `CAP`, which is the fallback's metric and nothing else — the sixth pass's
     whole finding, arriving in the one measurement it had not reached, since
     the disc is drawn off that same cap height. */
  const labelW = DISC * BODY_SIZE * card.bodyCap + GUTTER * BODY_SIZE;

  const roomFor = COLUMN - labelW;
  const body = card.text ?? "regular";

  /* ONE body size down the block, and it is the size the widest row needs.

     The company's address is 62 characters and comes to 222 in a column that
     holds 207, so something has to give, and the clamp used to run per row: it
     set the address at 6.6 while the phone and the email directly above it
     stayed at 7.2. That is not a smaller line, it is three body rows at two
     sizes, and it reads as a mistake rather than as a choice — the same defect
     the third pass took out of this card when the posting and the contacts
     were set a fifth of a point apart. Nobody can see a fifth of a point;
     everybody can see six tenths. The face has one body voice, so the whole
     block steps together or not at all, and what a reader sees is a contact
     block set a shade small rather than one line that failed.

     WRAPPING THE ADDRESS WAS THE OTHER ANSWER AND THE CARD REFUSED IT. It is
     the card's own rule — the name wraps before it shrinks — and the address
     is the one row entitled to it, since an email over two lines is a wrong
     email address and a phone number over two lines is a wrong number, while
     an address over two lines is how an address is written. It sets 133 over
     87 breaking on the comma after `Square 1258,`, which is good setting; it
     is also a FOURTH line, and four do not fit. The block hangs from the last
     baseline and grows upward into the posting: four lines need a lead of 6.87
     or less against the 8 below, which is 95 per cent leading on body type, so
     the wrap buys an even address by printing the posting through the phone
     number. Measured, rendered and reverted rather than reasoned about — the
     emitted page had OTC · CAIRO sitting between the two, and nothing threw. */
  let bodySize = BODY_SIZE;
  while (
    bodySize > BODY_MIN &&
    rows.some(([, value]) => measure(value!, bodySize, body) > roomFor)
  )
    bodySize -= 0.2;

  const contactLines = rows.map(([kind, value, color]) => ({
    kind,
    text: value!,
    color,
  }));

  /* Drawn after the LINES are known, because where it sits depends on how many
     there are — see `dividerFor` in the spine. */
  doc.rule(
    textX,
    oy + card.dividerFor(contactLines.length, bodySize),
    COLUMN,
    LINE,
    DIVIDER_H,
  );

  contactLines.forEach(({ kind, text: value, color }, index) => {
    /* Hung from the LAST baseline, so the foot of the card is the foot of the
       card whether there are four lines or one. */
    const row =
      card.contactLastFor(bodySize) -
      CONTACT_LEAD * (contactLines.length - 1 - index);
    /* Brand blue, as the owner's reference has it: the discs are the company
       saying how to reach it, which is the face's colour rule — blue is the
       company, black is the person — and a grey disc reads as a disabled
       button. */
    contactIcon(doc, kind, textX, oy + row, bodySize * card.bodyCap, BRAND);
    doc.text(value!, textX + labelW, oy + row, {
      size: bodySize,
      color,
      font: card.text,
    });
  });

}

/**
 * The back: the flood, the mark, and one line.
 *
 * There is nothing else on it on purpose. The back of a card is seen for about
 * as long as it takes to turn over, so it has one job — to be unmistakably the
 * company's — and every additional object on it costs the mark some of the
 * attention it exists to hold. The hairline and the strap under it are there so
 * the mark is not floating in an empty rectangle; they are set at the size and
 * the letterspacing the journey's own straps use.
 *
 * Every back is identical, and since the seam moved to the edge it is no longer
 * symmetric about its own centre: which side the seam is on is now a duplex
 * question. See the note at the top, and the seam's own comment below.
 */
function back(doc: Pdf, ox: number, oy: number, bleed: Bleed, card: CardLayout) {
  doc.rect(
    ox - bleed.left,
    oy - bleed.top,
    CARD_W + bleed.left + bleed.right,
    CARD_H + bleed.top + bleed.bottom,
    INK,
  );

  /* Centred on the ink rather than on the file, for the reason the face is set
     off it. The clear space happens to be symmetric here, so this lands in the
     same place today — but a replacement artwork with a descender hanging off
     one end would not, and nothing on the page would say so. */
  const mark = markFrame("reverse", BACK_MARK_INK_H);
  satoBadge(
    doc,
    "reverse",
    INK,
    WHITE,
    ox + (BACK_FIELD - mark.inkWidth) / 2 + mark.dx,
    oy + card.backMarkTop + mark.dy,
    mark.height,
  );

  /* Brand blue, the same decision the underline on the face makes: both objects
     on this side are the company's, so the one rule between them is the
     company's colour. Mixed into the flood it read as a scuff on it.

     Measured to the mark's own ink, on the face's rule: it was 34, which is
     neither the mark above it nor the strap below it nor a fraction of either.
     A rule the width of the thing it hangs under is the one width on this side
     that is an answer rather than a guess. */
  doc.rule(
    ox + (BACK_FIELD - mark.inkWidth) / 2,
    oy + card.backRuleY,
    mark.inkWidth,
    BRAND,
    BACK_RULE_H,
  );
  doc.text(WEBSITE.toUpperCase(), ox, oy + card.backStrapY, {
    ...MICRO,
    font: card.display,
    size: BACK_STRAP_SIZE,
    tracking: 1.4,
    color: ON_DARK,
    align: "center",
    width: BACK_FIELD,
  });

  /* ----------------------------------------------------------- the seam -----
     The card has ONE blue edge and this is the other half of it.

     The face carries a 3pt seam down its leading edge and this side used to
     carry one across its foot, described here as "answering" it. It was not
     answering it — it was a second blue bar somewhere else. Turn the card
     over and the colour left the side of the card and appeared along the
     bottom, which reads as two decorations rather than as one object.

     A duplex flip mirrors x and leaves y alone (the sheet is turned about its
     vertical centreline, which is what `mirrored` does to the columns), so the
     face's LEFT edge is this side's RIGHT edge. Drawn there, the seam is the
     same physical edge of the same piece of card, front and back: it does not
     move when you turn it over, and the card reads as having a blue spine
     rather than two blue stripes.

     This is also the first thing on the back that is not symmetric about its
     own centre, which is the note at the top of this file finally coming due:
     the mirroring in sheet() has been a no-op on every design until now, and
     the assertion that the backs are mirrored has been passing on a drawing
     that could not tell. It can tell now. */
  doc.rect(
    ox + CARD_W - SEAM,
    oy - bleed.top,
    SEAM + bleed.right,
    CARD_H + bleed.top + bleed.bottom,
    BRAND,
  );
}

/** One card, on a page the size of the card. For a proof, or for one person. */
export function renderBusinessCard(person: CardPerson): Uint8Array {
  const doc = new Pdf({
    width: CARD_W,
    height: CARD_H,
    margin: 0,
    info: {
      title: `${person.fullName} — Sato Pharma business card`,
      author: "Sato Pharma",
      subject: "Business card",
      creator: "Sato Pharma",
    },
  });
  const card = layout();
  doc.page();
  front(doc, person, 0, 0, TRIMMED, card);
  doc.page();
  back(doc, 0, 0, TRIMMED, card);
  return doc.bytes();
}

/** Where the block of cards sits on A4, centred on both axes. */
export const SHEET_X = (A4_WIDTH - COLUMNS * CARD_W) / 2;
export const SHEET_Y = (A4_HEIGHT - ROWS * CARD_H) / 2;

/**
 * Every card, ten to a sheet, fronts and backs on alternating pages.
 *
 * The pages come out front, back, front, back so that a duplex printer set to
 * long-edge binding produces finished sheets in one pass, and so that a simplex
 * printer can be given the odd pages and then the even ones without anybody
 * having to work out the order.
 */
export function renderCardSheet(people: CardPerson[]): Uint8Array {
  const doc = new Pdf({
    width: A4_WIDTH,
    height: A4_HEIGHT,
    margin: 0,
    info: {
      title: `Sato Pharma — business cards, ${people.length} to print`,
      author: "Sato Pharma",
      subject: `${COLUMNS} x ${ROWS} to a sheet, 90 x 50 mm, fronts and backs`,
      creator: "Sato Pharma",
    },
  });

  /* A PDF with no pages at all is not a file any reader will open, so an empty
     roster still gets one sheet — blank, with the crop marks on it. That is
     what "nobody matched the filter" should look like: a sheet with nothing on
     it, not a download that fails to open. */
  const card = layout();
  const sheets = Math.max(1, Math.ceil(people.length / PER_SHEET));
  for (let sheet = 0; sheet < sheets; sheet++) {
    const batch = people.slice(sheet * PER_SHEET, (sheet + 1) * PER_SHEET);

    doc.page();
    batch.forEach((person, index) => {
      const col = index % COLUMNS;
      const row = Math.floor(index / COLUMNS);
      front(doc, person, slotX(col), slotY(row), bleedFor(col, row), card);
    });
    cropMarks(doc, card);

    doc.page();
    batch.forEach((_, index) => {
      const col = index % COLUMNS;
      const row = Math.floor(index / COLUMNS);
      /* Mirrored about the sheet's vertical centre: the back of a page is the
         front seen from behind, so column 0 on the face is column 1 here. It is
         invisible on a symmetric back and load-bearing the moment one is not. */
      const mirrored = COLUMNS - 1 - col;
      back(doc, slotX(mirrored), slotY(row), bleedFor(mirrored, row), card);
    });
    cropMarks(doc, card);
  }

  return doc.bytes();
}

function slotX(col: number): number {
  return SHEET_X + col * CARD_W;
}

function slotY(row: number): number {
  return SHEET_Y + row * CARD_H;
}

/**
 * The cut lines, drawn in the margin and never across the card.
 *
 * A mark that crosses the trim prints on the finished card, so each one starts
 * a little outside the block and runs outwards. They are drawn at every cut —
 * the block's own edges and each butted join — because a guillotine operator
 * lines up on a mark, not on the edge of a colour.
 */
function cropMarks(doc: Pdf, card: CardLayout) {
  const off = BLEED + 2;
  const arm = 12;
  const hair = mix(LINE, INK, 0.5);

  for (let col = 0; col <= COLUMNS; col++) {
    const x = slotX(col);
    doc.vrule(x, SHEET_Y - off - arm, arm, hair, 0.5);
    doc.vrule(x, SHEET_Y + ROWS * CARD_H + off, arm, hair, 0.5);
  }
  for (let row = 0; row <= ROWS; row++) {
    const y = slotY(row);
    doc.rule(SHEET_X - off - arm, y, arm, hair, 0.5);
    doc.rule(SHEET_X + COLUMNS * CARD_W + off, y, arm, hair, 0.5);
  }

  doc.text(
    `Sato Pharma · business cards · 90 × 50 mm · cut on the marks`,
    0,
    A4_HEIGHT - 14,
    {
      size: 5.6,
      font: card.text,
      tracking: 0.8,
      color: mix(SOFT, WHITE, 0.45),
      align: "center",
      width: A4_WIDTH,
    },
  );
}
