// تفقيط — an Egyptian-pound amount written out in Arabic words.
//
// WHY THIS IS A MODULE AND NOT A ONE-LINER. مادة (2) of the employment contract prints the monthly
// salary twice: once in digits and once in words, the second inside "(( ........ ) فقط لا غير)".
// Writing the two out by hand is the single most consequential transcription in the whole hiring
// pack, because when the digits and the words disagree, Egyptian contract practice reads the WORDS
// as controlling. A slip of the pen there is not a typo, it is a different salary.
//
// The grammar is not decorative. Arabic reads a compound number units-first — 45 is "خمسة وأربعون",
// five-and-forty — and the scale word inflects with the count in front of it: one thousand is ألف,
// two is ألفان, three to ten take the plural آلاف, and eleven upwards return to the singular
// accusative ألفاً. Getting that wrong produces something a lawyer would notice.

const UNITS = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"] as const;

const TEENS = [
  "عشرة",
  "أحد عشر",
  "اثنا عشر",
  "ثلاثة عشر",
  "أربعة عشر",
  "خمسة عشر",
  "ستة عشر",
  "سبعة عشر",
  "ثمانية عشر",
  "تسعة عشر",
] as const;

const TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"] as const;

const HUNDREDS = [
  "",
  "مائة",
  "مائتان",
  "ثلاثمائة",
  "أربعمائة",
  "خمسمائة",
  "ستمائة",
  "سبعمائة",
  "ثمانمائة",
  "تسعمائة",
] as const;

/** مائتان in إضافة — see `spellGroup`. */
const HUNDREDS_CONSTRUCT_DUAL = "مائتا";

/** The largest amount this converter will spell. A salary above it is a data error, not a number. */
export const MAX_SPELLABLE_AMOUNT = 999_999_999;

/**
 * Spell a bare 1–999. Returns "" for 0 so callers can drop an empty scale group.
 *
 * `construct` marks the case where the counted noun (or a scale word) follows this group IMMEDIATELY.
 * It matters for exactly one number: مائتان is a dual, and an Arabic dual in إضافة loses its nūn —
 * مائتا جنيه, not مائتان جنيه. Anything at all between the two puts the nūn back, which is why 250
 * stays مائتان وخمسون جنيهاً, so the construct form applies only when the hundreds ARE the whole group.
 */
function spellGroup(value: number, construct = false): string {
  const hundreds = Math.floor(value / 100);
  const remainder = value % 100;
  const parts: string[] = [];

  if (hundreds > 0) {
    parts.push(
      hundreds === 2 && construct && remainder === 0 ? HUNDREDS_CONSTRUCT_DUAL : HUNDREDS[hundreds],
    );
  }

  if (remainder >= 10 && remainder <= 19) {
    parts.push(TEENS[remainder - 10]);
  } else {
    const tens = Math.floor(remainder / 10);
    const units = remainder % 10;
    // Units lead: 45 is five-and-forty, never forty-five.
    if (units > 0) parts.push(UNITS[units]);
    if (tens > 0) parts.push(TENS[tens]);
  }

  return parts.join(" و");
}

/**
 * The scale word for a group, inflected for how many of them there are.
 *
 * The counted noun — the تمييز — takes four shapes, not three. One and two need no numeral at all:
 * ألف already means one thousand and ألفان two. Three to ten take the plural (ثلاثة آلاف). Eleven
 * to ninety-nine take the SINGULAR IN THE ACCUSATIVE, which in writing means the tanwīn alif:
 * اثنا عشر ألفاً, never اثنا عشر ألف. A hundred and above return to the bare singular (مائة ألف).
 *
 * In a compound the تمييز follows the LAST element rather than the total — 105,000 is
 * مائة وخمسة آلاف, because the number ends in five — so the choice is made on `count % 100`.
 */
type CountedNoun = {
  singular: string;
  dual: string;
  plural: string;
  accusative: string;
  /** The dual in إضافة, which drops the nūn: ألفان alone, but ألفا جنيه when a noun follows. */
  dualConstruct?: string;
};

const THOUSAND: CountedNoun = {
  singular: "ألف",
  dual: "ألفان",
  plural: "آلاف",
  accusative: "ألفاً",
  dualConstruct: "ألفا",
};

const MILLION: CountedNoun = {
  singular: "مليون",
  dual: "مليونان",
  plural: "ملايين",
  accusative: "مليوناً",
  dualConstruct: "مليونا",
};

/**
 * Just the noun, in the shape the count in front of it requires. The numeral itself is spelled
 * separately, because a compound like 12,750 needs its parts assembled before the noun is chosen.
 */
function nounForm(count: number, forms: CountedNoun): string {
  if (count === 1) return forms.singular;
  if (count === 2) return forms.dual;
  const tail = count % 100;
  if (tail >= 3 && tail <= 10) return forms.plural;
  if (tail >= 11) return forms.accusative;
  return forms.singular;
}

/**
 * A scale word (ألف / مليون) inflected for its count.
 *
 * `construct` marks the case where the scale word is the LAST thing before the counted noun and is
 * therefore in إضافة with it. That kills the tanwīn: 25,000 pounds is خمسة وعشرون ألف جنيه, never
 * خمسة وعشرون ألفاً جنيهاً. When something else intervenes — 12,750, which ends in وسبعمائة وخمسون —
 * the scale word keeps its own ending and the noun agrees with that tail instead.
 */
function scaleWord(count: number, forms: CountedNoun, construct = false): string {
  if (count === 1) return forms.singular;
  if (count === 2) return construct ? (forms.dualConstruct ?? forms.dual) : forms.dual;

  // The scale word follows the numeral directly in every branch, so the group is always in إضافة
  // with it — that is what turns 200,000 into مائتا ألف rather than مائتان ألف.
  const tail = count % 100;
  if (tail >= 3 && tail <= 10) return `${spellGroup(count, true)} ${forms.plural}`;
  if (tail >= 11 && !construct) return `${spellGroup(count, true)} ${forms.accusative}`;
  return `${spellGroup(count, true)} ${forms.singular}`;
}

/** Spell a whole number of pounds. Exported for the tests; callers want `spellEgyptianAmount`. */
export function spellArabicInteger(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  const whole = Math.floor(value);
  if (whole === 0) return "صفر";
  if (whole > MAX_SPELLABLE_AMOUNT) return "";

  const millions = Math.floor(whole / 1_000_000);
  const thousands = Math.floor((whole % 1_000_000) / 1000);
  const rest = whole % 1000;
  const parts: string[] = [];

  if (millions > 0) parts.push(scaleWord(millions, MILLION));
  if (thousands > 0) parts.push(scaleWord(thousands, THOUSAND));
  if (rest > 0) parts.push(spellGroup(rest));

  return parts.join(" و");
}

/**
 * A whole number followed by the thing it counts — "اثنا عشر ألفاً وسبعمائة وخمسون جنيهاً مصرياً".
 *
 * The counted noun agrees with the LAST element of the number, not with its total, and when the
 * number ends on a scale word that scale word enters إضافة with the noun and both go bare. Those
 * two rules together are the whole difference between a cheque an Egyptian bank accepts and one it
 * queries, which is the standard this clause is written to.
 */
function spellCounted(whole: number, forms: CountedNoun): string {
  // One and two are carried by the noun's own singular and dual — "جنيه مصري", "جنيهان مصريان".
  // Spelling the numeral as well would print "واحد جنيه مصري".
  if (whole === 1) return forms.singular;
  if (whole === 2) return forms.dual;

  const millions = Math.floor(whole / 1_000_000);
  const thousands = Math.floor((whole % 1_000_000) / 1000);
  const rest = whole % 1000;
  const parts: string[] = [];

  if (millions > 0) parts.push(scaleWord(millions, MILLION, rest === 0 && thousands === 0));
  if (thousands > 0) parts.push(scaleWord(thousands, THOUSAND, rest === 0));
  // The trailing group sits directly against the counted noun, so it is in إضافة with it.
  if (rest > 0) parts.push(spellGroup(rest, true));

  // A number ending on a scale word is in إضافة with the noun, which puts the noun in the singular
  // whatever the scale count was: خمسة وعشرون ألف جنيه.
  const governing = rest > 0 ? rest : 1;
  return `${parts.join(" و")} ${nounForm(governing, forms)}`;
}

const POUND: CountedNoun = {
  singular: "جنيه مصري",
  dual: "جنيهان مصريان",
  plural: "جنيهات مصرية",
  accusative: "جنيهاً مصرياً",
};

const PIASTRE: CountedNoun = {
  singular: "قرش",
  dual: "قرشان",
  plural: "قروش",
  accusative: "قرشاً",
};

/**
 * The full contract phrase for an amount — pounds, and piastres when there are any.
 *
 * Returns "" rather than a placeholder when the amount is missing or out of range. A caller that
 * receives "" must print a gap, never a zero: "صفر جنيه" on an employment contract is a worse
 * outcome than an obvious blank, because a blank gets questioned and a zero gets signed.
 */
export function spellEgyptianAmount(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "";
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_SPELLABLE_AMOUNT) return "";

  // Round to piastres first: 4999.999 must read as five thousand, not as four thousand nine
  // hundred and ninety-nine pounds and a hundred piastres.
  const totalPiastres = Math.round(amount * 100);
  // Zero is a blank, not "صفر جنيه" — see the note above. A contract salary of nothing is a data
  // error, and an obvious gap gets questioned where a spelled zero gets signed.
  if (totalPiastres === 0) return "";
  const pounds = Math.floor(totalPiastres / 100);
  const piastres = totalPiastres % 100;

  const poundWords = spellCounted(pounds, POUND);
  if (piastres === 0) return poundWords;

  return `${poundWords} و${spellCounted(piastres, PIASTRE)}`;
}

/**
 * Split an amount into the pounds/piastres pair Form 1 prints into two separate box grids.
 *
 * The form has no decimal point anywhere — جنيه and قرش are physically different boxes — so a wage
 * of 6250.5 has to arrive as ("6250", "50") and never as "6250.5".
 */
export function splitPoundsAndPiastres(
  amount: number | null | undefined,
): { pounds: string; piastres: string } | null {
  if (amount === null || amount === undefined) return null;
  if (!Number.isFinite(amount) || amount < 0) return null;

  const totalPiastres = Math.round(amount * 100);
  return {
    pounds: String(Math.floor(totalPiastres / 100)),
    // Always two digits: an empty right-hand box reads as an unfinished form.
    piastres: String(totalPiastres % 100).padStart(2, "0"),
  };
}
