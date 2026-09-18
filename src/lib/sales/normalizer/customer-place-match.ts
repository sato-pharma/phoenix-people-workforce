import { foldCustomerNameText } from "@/lib/sales/normalizer/customer-normalize";

// The third free step of the customer pipeline (customer-suggest.ts): the pharmacy's NAME holds the
// name of one of our bricks ("صيدلية النزهه", "صيدليات السلام الجديده"). This is the owner's own
// idea (2026-09-18: "check first the name of the customer, if you find any brick from ours, put
// it"). Pure — no I/O.
//
// Measured the same day on 2,000 held-out Pharma Overseas pharmacies the owner's sources settled:
// on the ones it answers, a place in the NAME was right exactly as often as the AI. A place in the
// ADDRESS was not — on the same pharmacies it was right 74 times where the AI was right 86, because
// an address names streets, mosques and neighbouring towns as landmarks. So the address never
// answers here; it can only VETO: a name place is dropped when the address points at a different
// area, or at several.
//
// A brick name is recognised as a whole run of words, never inside another word, and never right
// after a street word ("ش النزهه" is a street called النزهه, not the district). A place shared by
// bricks in two areas answers nothing — the owner's "if this brick has the same name in another
// area" case goes to the next step.

// Words that make the next place name a street, a building or a landmark. Folded exactly like the
// text they are compared with, so ة/ه and ى/ي spellings are the same word.
const STREET_WORDS = new Set(
  [
    "ش", "شارع", "طريق", "ط", "ميدان", "م", "كوبري", "كوبرى", "ترعه", "ترعة", "مسجد", "جامع", "مستشفي", "مستشفى",
    "مدرسه", "كنيسه", "برج", "عماره", "عمارة", "محطه", "موقف", "سوق", "حاره", "عطفه", "زقاق", "امتداد", "بجوار",
    "امام", "خلف", "اول", "بشارع", "بطريق", "بميدان",
  ].map((word) => foldCustomerNameText(word)),
);

// A place name with fewer characters than this (spaces aside) is too common a word to identify a brick.
const MIN_PLACE_LETTERS = 5;

export type PlaceBrick = { brickId: string; brickName: string; areaCode: string };

export type PlaceGazetteer = {
  // first word of a place phrase -> the phrases that start with it
  byFirstWord: Map<string, { words: string[]; bricks: string[] }[]>;
  areaByBrick: ReadonlyMap<string, string>;
};

export type PlaceHit = { ambiguous: true } | { ambiguous: false; areaCode: string; brickId: string | null };

export type PlaceMatch = { areaCode: string; brickId: string };

export function buildPlaceGazetteer(bricks: readonly PlaceBrick[]): PlaceGazetteer {
  const phraseBricks = new Map<string, Set<string>>();
  const areaByBrick = new Map<string, string>();
  for (const brick of bricks) {
    const brickId = String(brick.brickId);
    areaByBrick.set(brickId, brick.areaCode);
    const full = String(brick.brickName ?? "");
    // A brick named "X - Y" is known by its whole name and by the part before the dash.
    for (const part of new Set([full, full.split(" - ")[0]])) {
      const phrase = foldCustomerNameText(part).replace(/\s+\d+$/, "").trim(); // "النزهه 2" -> "النزهه"
      if (phrase.replace(/\s/g, "").length < MIN_PLACE_LETTERS) continue;
      const set = phraseBricks.get(phrase);
      if (set) set.add(brickId);
      else phraseBricks.set(phrase, new Set([brickId]));
    }
  }
  const byFirstWord = new Map<string, { words: string[]; bricks: string[] }[]>();
  for (const [phrase, set] of phraseBricks) {
    const words = phrase.split(" ");
    const entry = { bricks: [...set], words };
    const list = byFirstWord.get(words[0]);
    if (list) list.push(entry);
    else byFirstWord.set(words[0], [entry]);
  }
  return { areaByBrick, byFirstWord };
}

/** Our brick places named in a text: none, one area (with its brick when only one brick matched), or several areas. */
export function findPlace(gazetteer: PlaceGazetteer, text: string): PlaceHit | null {
  const words = foldCustomerNameText(text).split(" ").filter(Boolean);
  const hitBricks = new Set<string>();
  for (let i = 0; i < words.length; i += 1) {
    const phrases = gazetteer.byFirstWord.get(words[i]);
    if (!phrases) continue;
    if (i > 0 && STREET_WORDS.has(words[i - 1])) continue;
    // "ش 26 النزهه": a street word two back, with only a short number or letter between, still makes it a street.
    if (i > 1 && STREET_WORDS.has(words[i - 2]) && words[i - 1].length <= 2) continue;
    for (const phrase of phrases) {
      if (i + phrase.words.length > words.length) continue;
      let whole = true;
      for (let k = 1; k < phrase.words.length; k += 1) if (words[i + k] !== phrase.words[k]) { whole = false; break; }
      if (!whole) continue;
      for (const brickId of phrase.bricks) hitBricks.add(brickId);
    }
  }
  if (hitBricks.size === 0) return null;
  const areas = new Set([...hitBricks].map((brickId) => gazetteer.areaByBrick.get(brickId)));
  if (areas.size !== 1) return { ambiguous: true };
  const [areaCode] = [...areas];
  if (areaCode === undefined) return null;
  return { ambiguous: false, areaCode, brickId: hitBricks.size === 1 ? [...hitBricks][0] : null };
}

/**
 * The brick a pharmacy's NAME points at, kept only when it is one brick in one area and the address
 * does not point somewhere else. An address naming no place of ours is no objection.
 */
export function placeFromName(gazetteer: PlaceGazetteer, name: string, address: string): PlaceMatch | null {
  const fromName = findPlace(gazetteer, name);
  if (!fromName || fromName.ambiguous || !fromName.brickId) return null;
  const fromAddress = findPlace(gazetteer, address);
  if (fromAddress && (fromAddress.ambiguous || fromAddress.areaCode !== fromName.areaCode)) return null;
  return { areaCode: fromName.areaCode, brickId: fromName.brickId };
}
