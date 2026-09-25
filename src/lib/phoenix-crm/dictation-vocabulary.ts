/**
 * Phoenix CRM — the product vocabulary the dictation corrector matches against.
 *
 * WHERE THIS CAME FROM. Not invented, and not a guess at how a name is spelled in Arabic. Every
 * spelling below was counted in 136,983 real visit comments written by the field force between
 * 2026-01-01 and 2026-09-24 — 128,933 of them Arabic, 21,495 mixing Arabic and Latin in one
 * sentence, 1,070,057 word tokens in all. The numbers beside each variant are real occurrences on
 * 2026-09-25.
 *
 * The full account — what was measured, the query that produced it, every count per product, and
 * why four products are missing — is `docs/phoenix-crm-dictation-vocabulary.md`. It lives there
 * rather than here because this module is built clean and its own files never name the legacy
 * system's tables; `tests/phoenix-crm-boundary.test.ts` enforces that and caught an earlier version
 * of this file for citing one in a comment.
 *
 * WHY A LEXICON AT ALL. The browser speech engine is Google's or Apple's. It is trained on general
 * Egyptian Arabic and has never heard of Tebofortin, so it returns the nearest ordinary word it
 * knows. That is the one failure that matters here: the rest of the sentence comes back fine and the
 * product name — the only part anyone reads the comment for — comes back wrong.
 *
 * WHY THE VARIANTS ARE THE FIELD'S OWN SPELLINGS. The corpus shows reps already disagree with each
 * other in writing: saginkgo 2,521 · saginko 690 · saginco 128; royafloxacin 2,257 · royafloxacine
 * 372 · royafloxcain 184; dolabactin 2,100 · dolapactin 355. Those are humans typing, not a
 * recogniser, which makes them the best available evidence of what this word sounds like to someone
 * who says it every day — and therefore of what the engine is likely to return.
 *
 * WHAT IS NOT A VARIANT. Clitic-prefixed forms are absent on purpose: the article and the
 * conjunctions are stripped before matching and restored after, so listing a prefixed spelling here
 * would be listing the same word twice. Tiers are absent too — Advance, Intens, Max and Forte are
 * heavily spoken but they qualify a product rather than name one. So are molecules: what is IN
 * Saginko or Royafloxacin is not the product, and a doctor asking about the molecule means something
 * different from one naming the brand.
 *
 * CORRECTION STAYS IN ITS OWN SCRIPT. A name said in Arabic is corrected to the canonical ARABIC
 * spelling, never rewritten into Latin, and the reverse. A rep dictating Egyptian Arabic should not
 * find English in his comment because the system preferred it.
 *
 * FOUR PRODUCTS ARE DELIBERATELY ABSENT: Osteosat, Satoslim, Royanoxicam and Tigogrow. All four are
 * real products and all four return effectively zero mentions in the corpus, because they are Head
 * Office and the field force does not carry them. Listing them would only create opportunities to
 * "correct" a real word into a product nobody said.
 */

export type VocabularyEntry = {
  /** The spelling this brand is written as when the sentence is in Latin script. */
  latin: string;
  /** The spelling it is written as when the sentence is in Arabic script. */
  arabic: string;
  /** Latin spellings observed in the corpus, plus the canonical form itself. */
  latinVariants: string[];
  /** Arabic spellings observed in the corpus, bare — clitics are stripped before matching. */
  arabicVariants: string[];
};

/**
 * `latin` is the product's name as `source_of_sales_products` records it, which is the spelling the
 * sales and closing side already uses. It differs from the field's most common typing in exactly one
 * case — the corpus prefers "Saginkgo" (2,521) over the product table's "Saginko" (690) — and the
 * product table wins, because a comment that spells a product the way every other screen spells it
 * is the point of correcting it at all.
 */
export const PRODUCT_VOCABULARY: readonly VocabularyEntry[] = [
  {
    latin: "Tebofortin", // corpus: tebofortin 4,364
    arabic: "تيبوفورتين", // corpus: 6,972 bare, 13,218 more behind a clitic
    latinVariants: [
      "tebofortin",
      "tebofortein", // 75
      "tepofortin", // 13
      "tebofrtin", // 11
      "tebofoetin", // 11
      "tebofotin", // 6
      "tebofortine",
      "teboforten",
    ],
    arabicVariants: [
      "تيبوفورتين",
      "تبوفورتين",
      "تيبوفرتين", // 15
      "تيورفورتين", // 12
      "نيبوفورتين", // 11
      "تيبوقورتين", // 10
      "تييوفورتين", // 9
      "تيبفورتين", // 7
      "تيبوفورتن",
    ],
  },
  {
    latin: "Royafloxacin", // corpus: royafloxacin 2,257
    arabic: "رويافلوكساسين", // corpus: 2,637 bare, 10,509 more behind a clitic
    latinVariants: [
      "royafloxacin",
      "royafloxacine", // 372
      "royafloxcain", // 184
      "royafloxaccin", // 55
      "reofloxacin", // 15
      "royafloksasin",
      "royafloxasin",
    ],
    arabicVariants: [
      "رويافلوكساسين",
      "رويافلوكسين", // 779 — the largest single misspelling of any product
      "رؤيافلوكساسين", // 27
      "رافلوكساسين", // 18
      "رويافلوكساسن",
    ],
  },
  {
    latin: "Saginko", // product table; corpus prefers saginkgo 2,521 · saginko 690 · saginco 128
    arabic: "ساجنكو", // corpus: 3,715 bare, 7,104 more behind a clitic
    latinVariants: ["saginko", "saginkgo", "saginco", "sajinko", "saginkho"],
    arabicVariants: [
      "ساجنكو",
      "ساجينكو", // 360
      "سانجكو", // 204 — added from the RECALL half of the measurement, not the precision half:
      // the corrector was leaving it alone. Levenshtein charges 2 for a transposed pair, which put
      // it just outside a six-letter word's budget of 1, so 204 real comments went uncorrected
      // while every other Saginko misspelling was caught.
      "ساجنكوا", // 6
      "ساچنكو",
      "سجنكو",
    ],
  },
  {
    latin: "Ivyronc", // corpus: ivyronc 1,472
    arabic: "ايفيرونك", // corpus: 1,151 bare, 17,883 more behind a clitic — the most-spoken product
    latinVariants: ["ivyronc", "ivyronk", "iveronc", "ivironc", "ivyron"],
    arabicVariants: [
      "ايفيرونك",
      "إيفيرونك",
      "ايفرونك", // 11
      "ايفيرونج",
    ],
  },
  {
    latin: "Lacto", // corpus: lacto 656 — Lacto Advanced / Basic carry the tier separately
    arabic: "لاكتو", // corpus: 2,894
    latinVariants: ["lacto", "lakto", "laktu"],
    arabicVariants: [
      "لاكتو",
      "لاكتوا", // 63
      "لكتو",
    ],
  },
  {
    latin: "Conviban", // corpus: conviban 1,817
    arabic: "كونفيبان", // corpus: 1,639 bare, 3,871 more behind a clitic
    latinVariants: [
      "conviban",
      "conveban", // 24
      "convipan", // 5
      "konviban",
      "convibane",
    ],
    arabicVariants: [
      "كونفيبان",
      "كونفبان", // 98
      "كونڤيبان",
      "كنفيبان",
    ],
  },
  {
    latin: "Guamusin", // corpus: guamusin 732
    arabic: "جواميسين", // corpus: 371 bare, 5,919 more behind a clitic
    latinVariants: [
      "guamusin",
      "guamucin", // 86
      "guamosin",
      "gawamosin",
      "gwamusin",
    ],
    arabicVariants: [
      "جواميسين",
      "جوامسين", // 344
      "جواموسين", // 262 — all three spellings are in live use
      "جواماسين", // 32
    ],
  },
  {
    latin: "Dolabactin", // corpus: dolabactin 2,100 · dolapactin 355
    arabic: "دولاباكتين", // corpus: 893 bare, 4,525 more behind a clitic
    latinVariants: ["dolabactin", "dolapactin", "dolabaktin", "dulabactin"],
    arabicVariants: [
      "دولاباكتين",
      "دولابكتين", // 864
      "دولاباكتن", // 59
      "دولاباكتبن", // 6
    ],
  },
  {
    latin: "Rispadex", // corpus: rispadex 570
    arabic: "ريسبادكس", // corpus: 367 bare, 823 more behind a clitic
    latinVariants: [
      "rispadex",
      "rispedex", // 8
      "rispadix", // 6
      "risphadex",
    ],
    arabicVariants: [
      "ريسبادكس",
      "ريسباديكس", // 14
      "رسبادكس",
    ],
  },
  {
    latin: "Dopaminect", // corpus: dopaminect 430 — the product table also carries "Dopaminict"
    arabic: "دوبامينكت", // corpus: 10 bare, 50 more behind a clitic — the smallest by far
    latinVariants: [
      "dopaminect",
      "dopaminct", // 5
      "dopaminict",
      "dopamenect",
      "dopaminekt",
    ],
    arabicVariants: ["دوبامينكت", "دوبامنكت", "دوبامينيكت"],
  },
];

/**
 * Words the field uses on their own that sit close to a product name and must NOT be expanded into
 * one. Counted as standalone tokens: الايفي 8,022 · الرويا 3,762 · التيبو.
 *
 * Two kinds are listed. The first is SHORT FORMS — a rep who says "الايفي" said "الايفي", and
 * expanding it to the full brand is rewriting him rather than fixing a recogniser error. The second
 * is MOLECULES — the active substance inside a product is not the product, and a comment saying a
 * doctor asked about the molecule means something different from one naming the brand.
 *
 * They are listed so the matcher recognises them as known words and leaves them ALONE, instead of
 * finding them a few edits away from a full product name and "correcting" them into one.
 *
 * "لاكتو" is NOT in this list and must not be added: it is Lacto's own canonical Arabic name, not a
 * shortening of it — Advanced and Basic are tiers carried separately. Listing a canonical name here
 * would tell the matcher to skip the very word it exists to fix.
 */
export const PROTECTED_SHORT_FORMS: readonly string[] = [
  "ايفي",
  "رويا",
  "تيبو",
  "فلوكساسين",
  "جينكوبيلوبا",
  "جينكو",
  "ليفو",
  "فورتين",
  "ادفانس",
  "انتنس",
];

/**
 * OTHER COMPANIES' PRODUCTS AND MOLECULES. Never corrected, in either script, ever.
 *
 * This list exists because the measurement found the corrector doing the worst thing it could do.
 * Run against the whole corpus (`scripts/dictation-corrector-eval.ts`), it was rewriting
 * `levofloxacin` and `moxifloxacin` — two COMPETITORS' molecules — into `Royafloxacin`, and
 * `الجينكو` into `ساجنكو`, across roughly 700 real comments. A rep reporting that a doctor writes a
 * competitor's drug would have had that turned into a claim that the doctor writes ours. Nobody
 * reading the comment afterwards could tell.
 *
 * It is the one failure mode with no honest recovery: a wrong product name is a typo someone
 * notices, and a competitor's name replaced by ours is a fabricated sale.
 *
 * Every entry is matched with the same normalization as a product name, so a Persian ڤ or a
 * hamza-carrying alef is caught too. Add to this list whenever a competitor's name turns up in the
 * evaluation's review column — that is precisely what the column is for.
 */
export const COMPETITOR_TERMS: readonly string[] = [
  // The fluoroquinolone family. Royafloxacin is one of these, so every other one is close enough to
  // it to be captured, and each is somebody else's product.
  "levofloxacin",
  "livofloxacin",
  "moxifloxacin",
  "ciprofloxacin",
  "ofloxacin",
  "norfloxacin",
  "gatifloxacin",
  "gemifloxacin",
  "lomefloxacin",
  "pefloxacin",
  "sparfloxacin",
  "ليفوفلوكساسين",
  "ليفلوكساسين",
  "موكسيفلوكساسين",
  "سيبروفلوكساسين",
  "اوفلوكساسين",
  "نورفلوكساسين",
  // Spellings of a competitor's name that the field gets WRONG. They belong here for the same
  // reason the right ones do, and they are here because the measurement caught each one leaking
  // through: matching this list exactly means a typo of a competitor is not on it until it is
  // seen, and both of these were turning into Royafloxacin.
  "يفوفلوكساسين", // اليفوفلوكساسين — levofloxacin with the ل of the article doing double duty
  "levoflpxacin",
  // Ginkgo — the molecule in Saginko, and other companies' ginkgo brands.
  "ginkgo",
  "ginkgobiloba",
  "سيراجينكو",
  "جنكو", // الجنكو, 49 — the same molecule written without the ي
  // Ivy extract — Ivyronc's molecule and a competitor brand built on it. ~300 comments.
  "ايفيبرونت",
  "ايڤيبرونت",
  "ivypront",
  // Lactose, which is not Lacto, and the other لاكت- words the field writes.
  "لاكتوز",
  "lactose",
  "لاكتر",
  "اكترا",
];
