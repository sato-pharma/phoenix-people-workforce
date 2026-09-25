# Phoenix CRM — where the dictation vocabulary came from

`src/lib/phoenix-crm/dictation-vocabulary.ts` holds a list of product spellings. This is the
account of how that list was produced, kept here rather than in the module because Phoenix CRM is
built clean and its own files never name the old CRM's tables — `tests/phoenix-crm-boundary.test.ts`
enforces that, and it caught an earlier version of the vocabulary file for citing one in a comment.

## What was measured

The old CRM's visit comments, `public.ireports360_visits.comment` on the production project
`ozucdzovmcqvepbozvqf`, read 2026-09-25:

| | |
| --- | --- |
| Non-empty comments, 2026-01-01 → 2026-09-24 | **136,983** |
| Containing Arabic | 128,933 |
| Mixing Arabic and Latin in one sentence | 21,495 |
| Distinct word tokens (4+ characters) | 37,150 |
| Total word tokens | 1,070,057 |

## Why the field's own spelling is the evidence

The browser speech engine is Google's on Chrome and Apple's on Safari. It is trained on general
Egyptian Arabic, has never heard of Tebofortin, and returns the nearest ordinary word it knows.
There is no way to teach it one — no fine-tuning, no vocabulary hint. So the only place a
Phoenix-specific vocabulary can be applied is **after** the engine answers.

What the engine is likely to return for a word is best predicted by how the people who say that word
every day already write it down. The corpus shows they disagree with each other constantly, and
those disagreements are the variant lists:

```sql
-- the query behind every count in this document
with toks as (
  select lower(t) as raw
  from public.ireports360_visits v,
       lateral regexp_split_to_table(coalesce(v.comment,''), '[^[:alnum:]]+') t
  where v.comment is not null and btrim(v.comment) <> '' and length(t) between 4 and 24
)
select translate(regexp_replace(raw, '[ًٌٍَُِّْـٰ]', '', 'g'), 'أإآٱىةچڤگ', 'اااايهجفك') as norm,
       count(*) as n
from toks group by 1 order by n desc;
```

Clitic-prefixed forms (`الـ`, `والـ`, `بالـ`, `عالـ`, `للـ`) were counted separately and are **not**
variants — the corrector strips the clitic, matches the stem, and puts the clitic back. They are
listed here because their volume is what proves the clitic handling is load-bearing rather than
theoretical.

## The ten products, as the field writes them

Counts are token occurrences on 2026-09-25.

### Tebofortin — `تيبوفورتين`

Bare stem 6,972 · Latin `tebofortin` 4,364. Clitic forms: `الـ` 10,739 · `بالـ` 1,214 · `والـ` 762 ·
`للـ` 503 · `وـ` 609.
Arabic misspellings: `تيبوفرتين` 15 · `تيبفورتين` 7 · `تيبوقورتين` 10 · `تييوفورتين` 9 ·
`تيورفورتين` 12 · `نيبوفورتين` 11.
Latin misspellings: `tebofortein` 75 · `tepofortin` 13 · `tebofrtin` 11 · `tebofoetin` 11 ·
`tebofotin` 6.

### Royafloxacin — `رويافلوكساسين`

Bare stem 2,637 · Latin `royafloxacin` 2,257. Clitic forms: `الـ` 5,833 · `والـ` 4,301 ·
`عالـ` 275 · `بالـ` 100.
Arabic misspellings: `رويافلوكسين` 779 (the largest single misspelling of any product) ·
`رؤيافلوكساسين` 27 · `رافلوكساسين` 18.
Latin misspellings: `royafloxacine` 372 · `royafloxcain` 184 · `royafloxaccin` 55 · `reofloxacin` 15.

`فلوكساسين` on its own (165) is the molecule, not the brand, and is deliberately not a variant.

### Saginko — `ساجنكو`

Bare stem 3,715 · Latin `saginko` 690, but the field writes **`saginkgo` 2,521** far more often, and
`saginco` 128. The product table's spelling wins anyway — the point of correcting a name is that the
comment then matches every other screen.
Arabic: `ساجينكو` 360 · `ساجنكوا` 6.

### Ivyronc — `ايفيرونك`

Bare stem 1,151 · Latin `ivyronc` 1,472. Clitic forms are the biggest of any product: `الـ` 11,604 ·
`والـ` 3,462 · `بالـ` 2,684 · `للـ` 110 · `عالـ` 23.
Arabic misspelling: `ايفرونك` 11.

### Lacto — `لاكتو`

Bare stem 2,894 · Latin `lacto` 656 · `لاكتوا` 63. Advanced and Basic are tiers carried separately.

### Conviban — `كونفيبان`

Bare stem 1,639 · Latin `conviban` 1,817. Clitic forms: `الـ` 2,040 · `والـ` 1,611 · `وـ` 619.
Arabic: `كونفبان` 98. Latin: `conveban` 24 · `convipan` 5.

### Guamusin — `جواميسين`

Bare stem 371 · Latin `guamusin` 732. Clitic forms: `والـ` 3,247 · `الـ` 2,320 · `عالـ` 217 ·
`بالـ` 135.
Arabic: `جوامسين` 344 · `جواموسين` 262 · `جواماسين` 32 — all three in live use.
Latin: `guamucin` 86.

### Dolabactin — `دولاباكتين`

Bare stem 893 · Latin `dolabactin` 2,100. Clitic forms: `والـ` 2,682 · `الـ` 1,671 · `بالـ` 172.
Arabic: `دولابكتين` 864 · `دولاباكتن` 59 · `دولاباكتبن` 6. Latin: `dolapactin` 355.

### Rispadex — `ريسبادكس`

Bare stem 367 · Latin `rispadex` 570. Clitic forms: `الـ` 439 · `والـ` 347.
Arabic: `ريسباديكس` 14. Latin: `rispedex` 8 · `rispadix` 6.

### Dopaminect — `دوبامينكت`

The smallest by far: bare stem 10 · Latin `dopaminect` 430 · `dopaminct` 5. The product table also
carries the spelling "Dopaminict".

## The four products deliberately left out

Osteosat, Satoslim, Royanoxicam and Tigogrow are all in `source_of_sales_products` and all return
effectively zero mentions in the corpus, because they are Head Office lines the field force does not
carry. Adding them would create chances to "correct" a real word into a product nobody said, with no
upside. `tests/phoenix-crm-dictation-correct.test.ts` asserts they stay out.

## The ordinary-word corpus, and what it is for

The safety net grows with the lexicon. `ORDINARY_CORPUS_WORDS` in the test file is the set of words
with **200 or more occurrences** in these same comments that are not product mentions — real
Egyptian Arabic as the field force writes it, plus the English the reps mix in. Every one of them
must survive the corrector byte-for-byte.

That list is what makes widening the vocabulary safe to do again: add a variant, and if it starts
capturing a word reps actually use, the test names the word.

Words in it that sit deliberately close to the line, and must NOT be corrected:

- `الايفي` 8,022 · `الرويا` 3,762 · `التيبو` — short forms. A rep who says one said it.
- `الجينكوبيلوبا` — ginkgo biloba, the molecule, not the brand.
- `الليفو` — levofloxacin, a competitor's molecule.
- `ادفانس` · `انتنس` · `الماكس` · `الفورت` — Lacto and Tebofortin **tiers**, not brand names.

## What running it against the whole corpus actually found

The lists above are evidence of how the field force *spells*. They say nothing about whether the
corrector built on them behaves. That is an empirical question, and the unit tests cannot answer it —
they check the cases somebody thought of. So `scripts/dictation-corrector-eval.ts` runs the corrector
over every distinct word in all 137,000 comments and sorts what it changes into two columns: changes
that match a spelling the vocabulary explicitly lists, and changes that do not. A false positive can
only be hiding in the second column.

The first run, on 2026-09-25, read 136,986 comments and 32,868 distinct words. It found the corrector
doing the worst thing this feature is capable of.

### It was rewriting competitors' drugs into Phoenix's own

| the field wrote | it became | comments |
| --- | --- | ---: |
| `moxifloxacin` | `Royafloxacin` | 55 |
| `levofloxacin` | `Royafloxacin` | 53 |
| `Levofloxacin` | `Royafloxacin` | 30 |
| `ليفوفلوكساسين` | `لرويافلوكساسين` | 43 |
| `الجينكو` | `ساجنكو` | 498 |
| `والجينكو` | `والساجنكو` | 37 |
| `ايفيبرونت` and its family | `ايفيرونك` | ~300 |
| `اللاكتوز` | `اللاكتو` | 18 |

Roughly a thousand comments. A rep reporting that a doctor writes a competitor's drug would have had
that turned into a claim that the doctor writes ours, in a clinical note, where nobody downstream
could tell it was invented. A wrong product name is a typo someone notices; a competitor's name
replaced by ours is a fabricated sale.

`COMPETITOR_TERMS` closes it. The list is matched **exactly**, not fuzzily, and the second run
settled why: `الليفلوكساسين` is levofloxacin and `الريفلوكساسين` is somebody typing Royafloxacin —
one letter apart. A fuzzy refusal was measured to cost about 160 genuine corrections to prevent about
5 fabrications. The price of exact matching is that a *misspelled* competitor is not on the list
until it is seen; the second run saw `اليفوفلوكساسين` and `levoflpxacin` leaking through, and they
were added. That loop — measure, read the review column, list what leaked — is how the list is kept,
and it is cheap enough to run because the corpus words are cached.

### It was deleting doses

`respadex3` → `Rispadex` (82), `التيبوفورتين٨٠` → `التيبوفورتين` (8), `الكونفيبان25` (4), `لاكتو٢` (5)
and a dozen more. The matcher compares letters, so a token carrying a strength matched the name and
came back with the strength gone — the name tidied and the SKU silently lost, which is worse than the
misspelling it fixed. Nothing carrying a digit is touched now, in either digit set.

### It was eating the rep's grammar

`الاكتووا` came back as `لاكتو`, with the article deleted, because a name wearing the article is only
two edits from the bare name and the whole-word reading won. The whole-word reading of a word that
opens with a clitic now has to be near-exact.

### The other direction: what it was missing

The same harness measures recall — words left alone that nevertheless sit within a few edits of a
product name. Most of that list is the guard working: `الدكتور` (24,658 occurrences, 3 edits from
Lacto), `الماكس`, `اكتوبر`, `الخانكة`, `الايفون`, `vaginal`, `action`. One entry was a genuine miss:
**`سانجكو`, 204 comments** — a transposed Saginko. Levenshtein charges 2 for a swapped pair, which put
it just outside a six-letter word's budget of 1, so it was the one large misspelling going
uncorrected while every other Saginko variant was caught. It is now listed.

### Where it stands

On the third run: 136,992 comments, 33,104 distinct words, **833 words changed across 43,870
occurrences**, no competitor and no dose among them.

**This is not, and cannot be, "100% accurate".** The browser's speech engine is Google's or Apple's
and there is no interface to teach either one a word — nothing here trains anything, and a voice
*note* stores audio nobody transcribes, so there is nothing to train there either. What this does is
respell product names after the engine has guessed, using the spellings the field itself writes. It
will still miss words, and the thresholds are deliberately set so that when it is unsure it leaves
the rep's own word alone.

## Keeping it honest after this

`tests/phoenix-crm-dictation-corpus.test.ts` freezes 13,330 of those corpus words — **words and
counts only, never a sentence, never anything joining a word to a person** — and runs the same
measurement on every PR, in under a second, with no database. It pins the exact number of words the
corrector changes. Widening the vocabulary moves that number and turns the check red with the old
count and the new one side by side, so re-pinning is a deliberate act taken with the evaluation
report open, not a silent widening nobody measured.

Re-running the full measurement:

```
node --env-file-if-exists=.env.local --experimental-strip-types \
     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
     scripts/dictation-corrector-eval.ts --token-cache corpus.cache.json --freeze tests/fixtures/dictation-corpus-tokens.json
```

The first run takes about a quarter of an hour, almost all of it reading the corpus. `--token-cache`
writes the word counts to a scratch file, and every run after that takes seconds — which is the
difference between a check that gets run when the vocabulary changes and one that does not.
