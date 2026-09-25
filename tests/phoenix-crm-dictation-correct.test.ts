import assert from "node:assert/strict";
import { correctDictatedProducts } from "../src/lib/phoenix-crm/dictation-correct.ts";
import { PRODUCT_VOCABULARY, PROTECTED_SHORT_FORMS } from "../src/lib/phoenix-crm/dictation-vocabulary.ts";

/**
 * Every word that occurs 200 or more times in the 136,983 old-CRM visit comments and is NOT a
 * product mention: real Egyptian Arabic as the field force writes it, plus the English the reps mix
 * in. Provenance and the query: `docs/phoenix-crm-dictation-vocabulary.md`.
 *
 * This is the safety net, and it is the reason the vocabulary can be widened again without fear.
 * Every one of these must come back byte-for-byte. Add a variant that starts capturing a word reps
 * actually use, and this test names the word instead of the defect reaching a clinical note.
 *
 * Four groups in here sit deliberately close to the line and must still never be touched:
 *   · الايفي · الرويا · التيبو — short forms. A rep who says one said it.
 *   · الجينكوبيلوبا · الليفو — molecules, not brands.
 *   · ادفانس · انتنس · الماكس · الفورت — Lacto and Tebofortin TIERS, which qualify a product
 *     rather than name one.
 *   · The Latin words: a rep writing "advance" or "intens" is not writing a brand either.
 */
const ORDINARY_CORPUS_WORDS: readonly string[] = `
الدكتور دكتور صيدليه بيكتب زياره الايفي متوفر ادفانس عياده كلمته الفتره بالكتابه تابعت بكتابه كتابات
الجايه فيدباك باطنه الرويا وقالي مستشفي المتابعه متابعه محمود الباطنه بخصوص بيتكتب الجديده بيكتبه
الصيدليه الكتابه التحدث الحالات انتنس فكرته الزياره بزياده وطلبت موجود بتكتب ادفانسيد مصطفي الفيدباك
ابراهيم وبيكتب دكتوره علشان وتكلمت الدكتوره زورته وافاد التيبو والرويا هيكتبه التركيزات معاها اطفال
بكتبه حالات قالتلي هيكتب واتفقت ومتوفر متوفرين وكلمته الانف قولتله المستشفي وجاري وتركيزاته والاذن
توفير اجازه سامبل الانتنس معايا واكدت كلمتها وقالت الادفانس الاطفال كويسه البرودكت وفكرته ياخدوا
مرتين القادمه يكتبه والايفي والدكتور اوردر بالشير ادفانسد علبتين بيطلع السيد بمعدل تركيزاته ووعدت
الدكاتره الاصناف كتاباته وتابعت صيدليات الفورت ايمان الكتابات معاهم اسامه كتبته تركيز المناسبه
متوفره اتكتب وبيكتبه دلوقتي وكلمت ومتوفرين عارفه التاكيد حالاته الصدر بالاضافه وقولتله هيبدا السيزون
بيكتبهم جراحه اسلام الاتنين وقالتلي روشتات بكتبهم وهتابع المبارك كتابه وعرفته العادي الفطر هياخد
التوفير العياده شكرته واعصاب كلمنا زورتها وشغال رمضان كلمتهم اسماء معانا مسالك كلمناه حضرتك الدين
قليله الادويه وماكس يتكتب ودكتور بتاعه فارما عندهم والفيدباك العام الصيدليات الشهر مكتبش السعر
والماكس عبدالله الاسبوع اتكلمت النهارده ايهاب شغالين مشكله الشير بجانب شيماء الماكس الفرصه التركيز
محتاج بيسمع بياخد الحميات والتحدث المره اماني حضانه عيادات مناقشه اميره الحضانه دايما تاكيد هكتبه
السابورت واتكلمنا تركيزات هتكتبه السلام هيكون الدنيا الليفو بالبرودكت هتابع عليهم وعياده حاليا
عايزين فاكره بيقول سيكتبهم الماده والاعصاب توفيره السعيد بتابع اسماعيل عرفته تذكير الشعب تانيه
متكتبش والتاكيد تذكيره الجينكوبيلوبا والله بنكتبه ادفنس فكرتها الاول بالرويا هيجربه الهيرو وعلبه
للحالات ومحفوظ عبدالرحمن اسراء فاطمه الالبان المنتجات الجراحه الرحمن بتكتبه الحياه البيشنت هيبقي
اللبن وسعره الايمان دمياط وعدوا وذكرته علطول الوفاء ورويا بركات بالتركيزات الروشتات موجوده بلغته
اقراص تكرارات الطيبي لكتابتهم واحده تعاقد عاوزين شعبان هيوفر هاديه طوارئ بالفعل وسالني خصوصا عينات
زياده سليمان عندها توفيرهم اكتبه العزيز مسمعش بيخرج الشركه روشته بكتابته ودكتوره عليها ممدوح اشتكي
وعجبه جديده بتوفير سالته قولتلها هيرجع بتمام الكحه داوود وبيتكتب محتاجه يكتبهم مايكل بانها اليوم
الشريف النسيم استشاري المسالك بمناسبه وسالته بيكتبوا وافادت هكتبهم بتاعته محتاجين رانيا عثمان استوك
موجودين ريهام الاطباء تكتبه اتوفر التذكير هتكتب المشتريات الشيخ سلامه فقالت الاستقبال وشكرته قالوا
لديهم ووعدني النجار وفكرتها وكلمتها الاسم بتركيزاته نيورو مناسب الحميد المايند ووعدوا كومنت متحركش
لمحمد داليا هيلثي الزيارات وشريط النواقص عبدالعزيز يادكتور
pedia meeting chest neuro following feedback leave advance intens positive pharmacy annual
prospection prospiction visit training about syrup hospital mohamed ahmed reminding
`
  .split(/\s+/)
  .filter(Boolean);

export function runPhoenixCrmDictationCorrectTests() {
  // ── The vocabulary itself ─────────────────────────────────────────────────────────────────────
  for (const entry of PRODUCT_VOCABULARY) {
    assert.ok(
      entry.latinVariants.includes(entry.latin.toLowerCase()),
      `${entry.latin} must list its own canonical spelling as a variant, or a correctly-spelled word scores as a near-miss against the others`,
    );
    assert.ok(
      entry.arabicVariants.includes(entry.arabic),
      `${entry.latin} must list its own Arabic spelling as a variant, for the same reason`,
    );
    assert.equal(
      new Set(entry.latinVariants).size,
      entry.latinVariants.length,
      `${entry.latin} lists a Latin variant twice — harmless at runtime but it means the list was edited without being read`,
    );
    assert.equal(
      new Set(entry.arabicVariants).size,
      entry.arabicVariants.length,
      `${entry.latin} lists an Arabic variant twice — same reason`,
    );
  }

  // A variant belongs to exactly one product. The same spelling under two brands makes every
  // sentence containing it a coin toss the corrector is not entitled to make.
  const seen = new Map<string, string>();
  for (const entry of PRODUCT_VOCABULARY) {
    for (const variant of [...entry.latinVariants, ...entry.arabicVariants]) {
      const owner = seen.get(variant);
      assert.equal(
        owner,
        undefined,
        `"${variant}" is listed under both ${owner} and ${entry.latin} — one spelling cannot mean two products`,
      );
      seen.set(variant, entry.latin);
    }
  }

  // ── Head Office products are absent ON PURPOSE ────────────────────────────────────────────────
  // They return effectively zero mentions in 136,983 field comments because the field force does not
  // carry them. Adding one creates a chance to "correct" a real word into a product nobody said.
  for (const absent of ["Osteosat", "Satoslim", "Royanoxicam", "Tigogrow"]) {
    assert.ok(
      !PRODUCT_VOCABULARY.some((e) => e.latin === absent),
      `${absent} is Head Office and unmentioned in the corpus — it must not be in the lexicon`,
    );
  }

  // ── A correct sentence is returned untouched ──────────────────────────────────────────────────
  const clean = "كلمت الدكتور عن التيبوفورتين وتركيزاته";
  assert.equal(correctDictatedProducts(clean).text, clean, "a sentence whose product name is already canonical is not rewritten");
  assert.equal(correctDictatedProducts(clean).corrections.length, 0, "and it reports no corrections");

  // ── Arabic: the clitic is kept and only the stem is respelled ─────────────────────────────────
  const withArticle = correctDictatedProducts("كلمته على التبوفورتين");
  assert.equal(withArticle.text, "كلمته على التيبوفورتين", "ال is preserved and only the product stem is corrected");
  assert.equal(withArticle.corrections[0]?.from, "التبوفورتين", "the correction reports the word as it was spoken");

  assert.equal(
    correctDictatedProducts("تابعت مع الدكتور والدولاباكتن").text,
    "تابعت مع الدكتور والدولاباكتين",
    "the compound clitic وال is taken whole rather than leaving ال stranded on the front of the stem",
  );

  // عال is the Egyptian contraction of "على ال". Over 500 real comments use it on a product name,
  // and the first version of the clitic list was missing it, so every one of them went uncorrected.
  assert.equal(
    correctDictatedProducts("اتكلمنا عالرويافلوكسين").text,
    "اتكلمنا عالرويافلوكساسين",
    "عال is a clitic the field really uses — the stem behind it is corrected and the contraction is put back",
  );

  // ── Arabic misspellings straight from the corpus ──────────────────────────────────────────────
  assert.equal(
    correctDictatedProducts("بيكتب الرويافلوكسين").text,
    "بيكتب الرويافلوكساسين",
    "رويافلوكسين (779 occurrences — the single largest misspelling in the corpus) folds to the canonical name",
  );
  assert.equal(
    correctDictatedProducts("والدولابكتين").text,
    "والدولاباكتين",
    "دولابكتين (864) folds to the canonical name",
  );
  assert.equal(correctDictatedProducts("الجوامسين").text, "الجواميسين", "جوامسين (344) folds to the canonical name");

  // ── A product name that BEGINS with a clitic letter ───────────────────────────────────────────
  // ك and ل are both clitics and both start a product name. Reading only the longest clitic cut
  // كونفيبان down to ونفيبان and لاكتو to اكتو, so Conviban and Lacto — spoken bare, which is how
  // 1,639 and 2,894 real comments write them — were silently never corrected at all.
  assert.equal(correctDictatedProducts("بيكتب كونفبان").text, "بيكتب كونفيبان", "كونفبان (98) folds to the canonical name even though the name itself starts with the clitic ك");
  assert.equal(correctDictatedProducts("لاكتوا").text, "لاكتو", "لاكتوا (63) folds to the canonical name even though the name itself starts with the clitic ل");
  assert.equal(correctDictatedProducts("للاكتو").text, "للاكتو", "and ل in front of لاكتو is still read as a clitic, so the rep's own grammar comes back intact");

  // ── Latin: the field's own misspellings, straight from the corpus ─────────────────────────────
  assert.equal(correctDictatedProducts("bekteb saginkgo").text, "bekteb Saginko", "saginkgo (2,521 in the corpus) folds to the product table's spelling");
  assert.equal(correctDictatedProducts("royafloxcain").text, "Royafloxacin", "royafloxcain (184) folds to the canonical name");
  assert.equal(correctDictatedProducts("dolapactin").text, "Dolabactin", "dolapactin (355) folds to the canonical name");
  assert.equal(correctDictatedProducts("tebofortein").text, "Tebofortin", "tebofortein (75) folds to the canonical name");
  assert.equal(correctDictatedProducts("rispedex").text, "Rispadex", "rispedex (8) folds to the canonical name");

  // ── Mixed script in one sentence, which is 21,495 of the real comments ────────────────────────
  const mixed = correctDictatedProducts("كلمته علي royafloxcain و التبوفورتين");
  assert.equal(mixed.text, "كلمته علي Royafloxacin و التيبوفورتين", "each token is corrected in its OWN script — Arabic stays Arabic, Latin stays Latin");
  assert.equal(mixed.corrections.length, 2, "both product names are reported");

  // ── Punctuation, spacing and newlines survive exactly ─────────────────────────────────────────
  assert.equal(
    correctDictatedProducts("بيكتب التبوفورتين.\nو dolapactin كمان").text,
    "بيكتب التيبوفورتين.\nو Dolabactin كمان",
    "the separators come back byte-for-byte — the rep's text is respelled, never reflowed",
  );

  // ── WHAT IT MUST REFUSE TO DO ─────────────────────────────────────────────────────────────────
  // These are the assertions that matter. A corrector that fires too eagerly puts a drug name into a
  // clinical note that the rep never said, and nobody downstream can tell it was invented.
  const ordinary = "الدكتور كويس ومتعاون والزيارة كانت ممتازة";
  assert.equal(correctDictatedProducts(ordinary).text, ordinary, "ordinary Egyptian Arabic is never touched — only tokens close to a KNOWN product are");

  assert.equal(correctDictatedProducts("صيدلية").text, "صيدلية", "a common word is not dragged toward a product name");
  assert.equal(correctDictatedProducts("meeting with the team").text, "meeting with the team", "ordinary English is left alone");

  // THE SAFETY NET. Every word the field force writes 200+ times, one at a time and then all in one
  // sentence. This is what makes widening the lexicon safe: a variant that starts capturing a real
  // word fails here, by name, instead of silently rewriting a doctor's prescribing.
  for (const word of ORDINARY_CORPUS_WORDS) {
    const result = correctDictatedProducts(word);
    assert.equal(
      result.text,
      word,
      `"${word}" occurs 200+ times in real visit comments and is not a product — the corrector rewrote it to "${result.text}", which would put a claim in a clinical note that the rep never made`,
    );
  }
  const wholeCorpusSentence = ORDINARY_CORPUS_WORDS.join(" ");
  assert.equal(
    correctDictatedProducts(wholeCorpusSentence).text,
    wholeCorpusSentence,
    "and none of them is captured in running text either, where a neighbouring word could change the split",
  );

  // The behavioural half of the short-form guard. Note honestly what this does and does not prove:
  // the three-and-four-letter forms are ALSO blocked by the distance thresholds on their own, so
  // this assertion passing does not by itself demonstrate that PROTECTED_SHORT_FORMS is doing
  // anything. It was verified by disabling the guard and watching this stay green. The two
  // molecules, فلوكساسين and جينكوبيلوبا, are long enough that the guard IS what saves them.
  for (const shortForm of PROTECTED_SHORT_FORMS) {
    const spoken = `بيكتب ال${shortForm}`;
    assert.equal(
      correctDictatedProducts(spoken).text,
      spoken,
      `a rep who says ال${shortForm} said ال${shortForm} — expanding it to a full brand is rewriting him, not fixing a recogniser error`,
    );
  }

  // The half that DOES bite, and the reason the guard is kept. The guard becomes load-bearing the
  // moment someone adds a short form to a variant list — putting "ايفي" under Ivyronc looks like an
  // obvious improvement and would silently start expanding الايفي into الايفيرونك, which is the exact
  // rewriting the guard exists to prevent. This invariant makes that edit go red instead of shipping.
  for (const entry of PRODUCT_VOCABULARY) {
    for (const shortForm of PROTECTED_SHORT_FORMS) {
      assert.ok(
        !entry.arabicVariants.includes(shortForm),
        `"${shortForm}" is a word the field uses on its own and must never be listed as a variant of ${entry.latin} — doing so makes the corrector expand it into a brand the rep did not say`,
      );
    }
  }

  // ── It fails toward leaving the text alone ────────────────────────────────────────────────────
  const nonsense = "كلمته عن البرمجيات";
  assert.equal(correctDictatedProducts(nonsense).text, nonsense, "a long word that is not near any product is left exactly as spoken");

  assert.equal(correctDictatedProducts("").text, "", "empty input is returned unchanged");
  assert.equal(correctDictatedProducts("   ").text, "   ", "whitespace-only input is returned unchanged rather than trimmed — the caller owns trimming");

  // A three-letter Latin token is a preposition, never a brand, whatever it is close to.
  assert.equal(correctDictatedProducts("and the doc").text, "and the doc", "short Latin tokens are excluded before matching");

  // ── Another company's product is never rewritten into ours ────────────────────────────────────
  // The worst thing this feature can do, and it was doing it. Measured against the whole corpus by
  // `scripts/dictation-corrector-eval.ts`, the corrector turned levofloxacin and moxifloxacin —
  // two competitors' molecules — into Royafloxacin, and الجينكو into ساجنكو, across roughly 700
  // real comments. A rep reporting that a doctor writes someone else's drug would have had that
  // turned into a claim that the doctor writes ours, with nothing downstream able to tell.
  for (const [competitor, occurrences] of [
    ["levofloxacin", 53],
    ["moxifloxacin", 55],
    ["Levofloxacin", 30],
    ["livofloxacin", 4],
    ["ليفوفلوكساسين", 43],
    ["الليفلوكساسين", 8],
    ["الجينكو", 498],
    ["والجينكو", 37],
    ["الچينكو", 9],
    ["ايفيبرونت", 165],
    ["اللاكتوز", 18],
  ] as const) {
    assert.equal(
      correctDictatedProducts(competitor).text,
      competitor,
      `"${competitor}" (${occurrences} real comments) is another company's product or a molecule — turning it into a Phoenix brand fabricates a sale in a clinical note`,
    );
  }

  // The refusal is EXACT, not fuzzy, and the second measurement is what settled that. The two sides
  // of the line are one letter apart — الليفلوكساسين is levofloxacin, الريفلوكساسين is somebody
  // typing Royafloxacin — and a fuzzy refusal was measured to cost about 160 genuine corrections to
  // prevent about 5 fabrications. Exact costs the opposite trade, and the price of exact is that a
  // MISSPELLED competitor is not on the list until it is seen. So it is seen, and then listed.
  assert.equal(
    correctDictatedProducts("الريفلوكساسين").text,
    "الرويافلوكساسين",
    "الريفلوكساسين (116) is a Royafloxacin misspelling and is still corrected — the competitor list is matched exactly so it cannot swallow our own typos",
  );
  for (const [leaked, occurrences] of [
    ["اليفوفلوكساسين", 6],
    ["levoflpxacin", 1],
    ["الجنكو", 49],
  ] as const) {
    assert.equal(
      correctDictatedProducts(leaked).text,
      leaked,
      `"${leaked}" (${occurrences}) is a MISSPELLED competitor or molecule — the second corpus run caught it turning into a Phoenix brand through the gap an exact blocklist leaves, and listing the wrong spelling is how that gap is closed`,
    );
  }

  // ── The recall half of the measurement, which is where widening actually pays ─────────────────
  assert.equal(
    correctDictatedProducts("سانجكو").text,
    "ساجنكو",
    "سانجكو (204) is a transposed Saginko — Levenshtein charges 2 for a swapped pair, which put it just outside a six-letter word's budget, so it was the one large misspelling the corrector was silently leaving alone",
  );
  // And the widening did not reach past the word it was for.
  assert.equal(correctDictatedProducts("سانجده").text, "سانجده", "a different six-letter word near the new variant is still left alone");

  // ── A dose is not a spelling mistake ──────────────────────────────────────────────────────────
  // The matcher compares letters, so a token carrying a strength matched the name and came back
  // with the strength deleted — the name tidied and the SKU silently lost, which is worse than the
  // misspelling it fixed. Both digit sets, because the corpus writes both.
  for (const [token, occurrences] of [
    ["respadex3", 82],
    ["Respadex3", 7],
    ["التيبوفورتين40", 9],
    ["التيبوفورتين٨٠", 8],
    ["الكونفيبان25", 4],
    ["لاكتو٢", 5],
    ["بالكونفبان٢٥", 3],
  ] as const) {
    assert.equal(
      correctDictatedProducts(token).text,
      token,
      `"${token}" (${occurrences} real comments) carries a strength — correcting the letters would delete the dose, which is the part that distinguishes the two things the rep could have meant`,
    );
  }

  // ── The whole-word reading cannot eat the rep's grammar ───────────────────────────────────────
  // A name with the article on the front is only two edits from the bare name, so the whole-word
  // reading could win and replace the article along with the name. Measured: الاكتووا came back as
  // لاكتو, with the rep's ال deleted.
  assert.equal(
    correctDictatedProducts("الاكتووا").text,
    "الاكتووا",
    "الاكتووا is left exactly as written — it used to come back as لاكتو with the rep's ال deleted, and refusing it is the right end of that fix: the stem is too far from the name to correct, and the whole word is too far to match past its own article",
  );
  assert.equal(
    correctDictatedProducts("وللدولاياكتين").text,
    "وللدولاباكتين",
    "ولل is read as one prefix chain, so the rep's grammar comes back whole rather than collapsing to a bare و",
  );
  // And the near-exact case still works, which is what the cap is carefully not breaking.
  assert.equal(correctDictatedProducts("كونفبان").text, "كونفيبان", "a listed spelling that opens with ك still matches whole — the cap allows an exact hit");
  assert.equal(correctDictatedProducts("لاكتوا").text, "لاكتو", "and one that opens with ل does too");

  // ── The correction trail is usable ────────────────────────────────────────────────────────────
  const trail = correctDictatedProducts("saginkgo و التبوفورتين");
  assert.deepEqual(
    trail.corrections.map((c) => c.to),
    ["Saginko", "التيبوفورتين"],
    "corrections are reported in the order they appear, so a reviewer can see what the engine got wrong",
  );
  for (const correction of trail.corrections) {
    assert.notEqual(correction.from, correction.to, "a no-op is never reported as a correction");
  }
}
