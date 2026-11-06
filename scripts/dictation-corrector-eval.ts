import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { correctDictatedProducts, normalizeArabic } from "../src/lib/phoenix-crm/dictation-correct.ts";
import { PRODUCT_VOCABULARY } from "../src/lib/phoenix-crm/dictation-vocabulary.ts";
import { getSupabaseAdmin } from "../src/lib/supabase/server.ts";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "dictation-corrector-eval",
  entry: import.meta.url,
  known: ["--min-hits", "--out", "--freeze", "--token-cache"],
});

// Measures the Phoenix CRM dictation corrector against the whole old-CRM comment corpus.
//
// WHY THIS EXISTS. The corrector respells product names in what the speech engine returns. Whether
// it helps is an empirical question and the unit tests cannot answer it: they check the cases
// someone thought of. This checks it against every word the field force actually writes.
//
// The dangerous direction is a FALSE POSITIVE — a real word rewritten into a drug name that the rep
// never said, in a clinical note, where nobody downstream can tell it was invented. So the headline
// number here is not "how many words were fixed". It is "how many words were touched that should
// not have been", and the answer has to be zero.
//
// WHAT IT DOES. Pages the comments, tokenizes them exactly the way the corrector does, builds the
// distinct-token frequency table, and runs the corrector over every distinct token. Each change is
// then classified:
//
//   known      the token is a listed variant of the product it became, or that variant behind a
//              clitic — an intended correction
//   review     the token became a product name without being a listed spelling of it. Every one of
//              these is a judgement call a human has to make, and a FALSE POSITIVE hides here.
//
// And it measures the other direction too — RECALL. A token the corrector leaves alone that is
// nevertheless close to a product name is a miss: a misspelling the thresholds were too tight for.
// That list is where widening the vocabulary pays, and it is computed with its OWN distance
// function rather than the corrector's, so a bug in the matcher cannot hide in the measurement of
// the matcher.
//
// It also runs the corrector over whole comments, because a token in running text can split
// differently from the same token alone.
//
// It reads ONLY. Which database it reads is decided entirely by the env it runs with — the same
// NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY pair the app uses — and it prints the host,
// so the output is never ambiguous about which corpus produced the numbers.
//
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//        --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
//        scripts/dictation-corrector-eval.ts [--min-hits 5] [--out <path>] \
//        [--token-cache <path>] [--freeze <path>]
//
// Re-run it after ANY change to the vocabulary. A widened lexicon that leaves the review list empty
// is safe to ship; one that adds entries to it is not, until each is judged. Pass `--token-cache`
// on the first run and every run after it costs seconds rather than a quarter of an hour.
//
// `--freeze` writes the committed fixture `tests/phoenix-crm-dictation-corpus.test.ts` runs against,
// which is how the same check reaches CI on a machine with no database credentials at all.

const PAGE = 1000;
const SOURCE_TABLE = "ireports360_visits";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const minHits = Number(arg("--min-hits", "5"));
const outPath = arg("--out", "dictation-corrector-eval.md");
/** `--freeze` also writes the corpus fixture the offline CI check runs against. */
const freezePath = process.argv.includes("--freeze")
  ? arg("--freeze", "tests/fixtures/dictation-corpus-tokens.json")
  : null;

/**
 * How far from a product name a word can be and still be worth freezing.
 *
 * The fixture exists to catch a FALSE POSITIVE, so what it has to contain is every real word that
 * sits within reach of a product name — the words a widened vocabulary might start swallowing. A
 * word further away than this cannot be reached by any threshold the corrector would plausibly
 * carry, so freezing it would only make the file bigger.
 */
const FREEZE_WITHIN_EDITS = 5;

/**
 * `--token-cache <path>` — read the corpus ONCE, then iterate for free.
 *
 * The expensive half of this script is not the matching, it is pulling 137,000 comments and
 * counting a million words. That half does not change when the vocabulary does, which is the only
 * thing anyone re-runs this for. Cached, a vocabulary experiment costs seconds instead of a quarter
 * of an hour, and the difference between a check that gets run and one that does not is usually
 * exactly that.
 *
 * The cache holds the same thing the fixture does — words and counts, no sentences — and it is a
 * scratch file, not a committed one.
 */
const tokenCachePath = process.argv.includes("--token-cache")
  ? arg("--token-cache", "dictation-corpus-tokens.cache.json")
  : null;

/** Every listed spelling, folded the way the corrector folds them, per product. */
function listedSpellings(): Map<string, Set<string>> {
  const byProduct = new Map<string, Set<string>>();
  for (const entry of PRODUCT_VOCABULARY) {
    byProduct.set(
      entry.latin,
      new Set([
        ...entry.latinVariants.map((v) => v.toLowerCase()),
        ...entry.arabicVariants.map(normalizeArabic),
      ]),
    );
  }
  return byProduct;
}

/**
 * Is `from` a listed spelling of the product `to` names, on its own or behind a clitic?
 *
 * The comparison folds Arabic exactly as the matcher does. Without that, `الايڤيرونك` — 427 real
 * comments, a Persian ڤ where the canonical name has ف — was reported as an unlisted change
 * needing judgement, when it is the listed spelling reached through the fold the vocabulary was
 * written to rely on. Roughly 900 occurrences of noise came from that one omission.
 *
 * Deliberately generous about the prefix: the point is to separate "the corrector did what the
 * vocabulary says" from "the corrector went beyond it", not to re-test the clitic logic.
 */
function isIntended(from: string, to: string, spellings: Map<string, Set<string>>): boolean {
  const entry = PRODUCT_VOCABULARY.find((e) => to.endsWith(e.latin) || to.endsWith(e.arabic));
  if (!entry) return false;
  const listed = spellings.get(entry.latin);
  if (!listed) return false;
  const folded = normalizeArabic(from.toLowerCase());
  for (const spelling of listed) {
    if (folded === spelling || folded.endsWith(spelling)) return true;
  }
  return false;
}

/**
 * Levenshtein — deliberately a SECOND implementation, not the corrector's.
 *
 * This is the measurement, and a measurement that shares code with the thing it measures cannot
 * catch that thing being wrong. Fifteen lines is a cheap price for an independent answer.
 */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i += 1) {
    rows[i] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

/** The closest product to a token, whether or not the corrector touched it. */
function nearestProduct(token: string): { product: string; gap: number } | null {
  const arabic = /[؀-ۿ]/.test(token);
  const folded = arabic ? normalizeArabic(token) : token.toLowerCase();
  // Strip anything that reads as a prefix, so a miss is not reported as "far from the name" purely
  // because the rep wrote the article.
  // The single-letter clitics belong here as much as the compound ones. Leaving them out made the
  // report claim 895 misses on "ولاكتو" and 614 on "وتيبوفورتين" — words the corrector handles
  // perfectly, counted as failures because the MEASUREMENT could not see past their و.
  const stems = arabic
    ? [
        folded,
        ...["وبال", "فبال", "وكال", "وعال", "ولل", "فلل", "بال", "كال", "فال", "وال", "عال", "لل", "ال", "و", "ف", "ب", "ك", "ل"]
          .filter((c) => folded.startsWith(c) && folded.length > c.length + 2)
          .map((c) => folded.slice(c.length)),
      ]
    : [folded];

  let nearest: { product: string; gap: number } | null = null;
  for (const entry of PRODUCT_VOCABULARY) {
    const canonical = arabic ? normalizeArabic(entry.arabic) : entry.latin.toLowerCase();
    for (const stem of stems) {
      if (Math.abs(stem.length - canonical.length) > 4) continue;
      const gap = distance(stem, canonical);
      if (!nearest || gap < nearest.gap) nearest = { product: entry.latin, gap };
    }
  }
  return nearest;
}

async function main() {
  const frequency = new Map<string, number>();
  let comments = 0;
  let commentsChanged = 0;
  let commentsWithProduct = 0;
  let fromCache = false;

  if (tokenCachePath && existsSync(tokenCachePath)) {
    const cached = JSON.parse(readFileSync(tokenCachePath, "utf8")) as {
      comments: number;
      tokens: Record<string, number>;
    };
    comments = cached.comments;
    for (const [token, hits] of Object.entries(cached.tokens)) frequency.set(token, hits);
    fromCache = true;
    console.log(`corpus     : ${tokenCachePath} (cached — delete it to re-read the database)`);
    console.log(`             ${comments.toLocaleString()} comments, ${frequency.size.toLocaleString()} distinct words`);
  }

  const supabase = fromCache ? null : getSupabaseAdmin();
  if (supabase) {
    console.log(`corpus host: ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(unset)"}`);
    console.log(`source     : public.${SOURCE_TABLE}.comment`);
  }

  for (let from = 0; supabase; from += PAGE) {
    const { data, error } = await supabase
      .from(SOURCE_TABLE)
      .select("comment")
      .not("comment", "is", null)
      // A unique order, so the offset walk skips and repeats no visit between pages.
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`read failed at offset ${from}: ${error.message}`);
    if (!data?.length) break;

    for (const row of data as { comment: string | null }[]) {
      const comment = (row.comment ?? "").trim();
      if (!comment) continue;
      comments += 1;

      for (const piece of comment.split(/([^\p{L}\p{N}]+)/u)) {
        if (!piece || /^[^\p{L}\p{N}]+$/u.test(piece)) continue;
        frequency.set(piece, (frequency.get(piece) ?? 0) + 1);
      }

      const result = correctDictatedProducts(comment);
      if (result.corrections.length) {
        commentsChanged += 1;
        commentsWithProduct += 1;
      } else if (PRODUCT_VOCABULARY.some((e) => comment.includes(e.arabic) || comment.toLowerCase().includes(e.latin.toLowerCase()))) {
        commentsWithProduct += 1;
      }
    }

    if (data.length < PAGE) break;
    if (from % 20000 === 0) console.log(`  … ${comments.toLocaleString()} comments read`);
  }

  if (tokenCachePath && !fromCache) {
    writeFileSync(
      tokenCachePath,
      JSON.stringify({ comments, tokens: Object.fromEntries(frequency) }),
      "utf8",
    );
    console.log(`cached the corpus words -> ${tokenCachePath}`);
  }

  const spellings = listedSpellings();
  const known: { from: string; to: string; hits: number }[] = [];
  const review: { from: string; to: string; hits: number }[] = [];
  let tokensTouched = 0;
  let occurrencesTouched = 0;

  const missed: { from: string; near: string; gap: number; hits: number }[] = [];

  for (const [token, hits] of frequency) {
    const result = correctDictatedProducts(token);
    if (result.text === token) {
      // Left alone. Is it nevertheless something the vocabulary should have caught? A gap of 1-3 on
      // a name this long is a misspelling; 0 means it was already canonical and correctly untouched.
      if (token.length >= 6 && hits >= minHits) {
        const nearest = nearestProduct(token);
        if (nearest && nearest.gap > 0 && nearest.gap <= 3) {
          missed.push({ from: token, near: nearest.product, gap: nearest.gap, hits });
        }
      }
      continue;
    }
    tokensTouched += 1;
    occurrencesTouched += hits;
    const change = { from: token, to: result.text, hits };
    (isIntended(token, result.text, spellings) ? known : review).push(change);
  }

  const byHits = (a: { hits: number }, b: { hits: number }) => b.hits - a.hits;
  known.sort(byHits);
  review.sort(byHits);
  missed.sort(byHits);

  const reviewAboveFloor = review.filter((r) => r.hits >= minHits);
  const lines = [
    `# Dictation corrector — measured against the whole corpus`,
    ``,
    `Host: \`${process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(unset)"}\` · source \`public.${SOURCE_TABLE}.comment\` · generated ${new Date().toISOString()}`,
    ``,
    `| | |`,
    `| --- | --- |`,
    `| Comments read | ${comments.toLocaleString()} |`,
    ...(fromCache
      ? [`| Comments the corrector changes | not measured — run without \`--token-cache\` |`]
      : [
          `| Comments the corrector changes | ${commentsChanged.toLocaleString()} |`,
          `| Comments naming a product at all | ${commentsWithProduct.toLocaleString()} |`,
        ]),
    `| Distinct word tokens | ${frequency.size.toLocaleString()} |`,
    `| Distinct tokens changed | ${tokensTouched.toLocaleString()} |`,
    `| Occurrences changed | ${occurrencesTouched.toLocaleString()} |`,
    `| Changes matching a LISTED spelling | ${known.length.toLocaleString()} |`,
    `| Changes NEEDING REVIEW | ${review.length.toLocaleString()} (${reviewAboveFloor.length} at ${minHits}+ occurrences) |`,
    `| Left alone but CLOSE to a product | ${missed.length.toLocaleString()} (${missed.reduce((n, m) => n + m.hits, 0).toLocaleString()} occurrences) |`,
    ``,
    `## Needing review`,
    ``,
    review.length
      ? `A token became a product name without being a listed spelling of it. Each is a judgement: a real misspelling the lexicon should adopt, or a false positive the thresholds must refuse.`
      : `None. Every change the corrector makes across the whole corpus is a spelling the vocabulary explicitly lists.`,
    ``,
    ...(review.length ? [`| occurrences | the field wrote | corrector produces |`, `| ---: | --- | --- |`] : []),
    ...review.map((r) => `| ${r.hits.toLocaleString()} | \`${r.from}\` | \`${r.to}\` |`),
    ``,
    `## Left alone, but close to a product name`,
    ``,
    `The other direction. Each is a word the corrector declined and a product it sits 1–3 edits from.`,
    `Some are deliberate refusals — a competitor, a molecule, a short form, a dose. The rest are`,
    `misses, and they are where widening the vocabulary actually buys something.`,
    ``,
    ...(missed.length ? [`| occurrences | the field wrote | nearest product | edits away |`, `| ---: | --- | --- | ---: |`] : [`None.`]),
    ...missed.slice(0, 120).map((m) => `| ${m.hits.toLocaleString()} | \`${m.from}\` | ${m.near} | ${m.gap} |`),
    ``,
    `## Intended corrections, by volume`,
    ``,
    `| occurrences | the field wrote | corrector produces |`,
    `| ---: | --- | --- |`,
    ...known.slice(0, 80).map((r) => `| ${r.hits.toLocaleString()} | \`${r.from}\` | \`${r.to}\` |`),
    ``,
  ];
  writeFileSync(outPath, lines.join("\n"), "utf8");

  if (freezePath) {
    // WHAT GOES IN, AND WHAT DELIBERATELY DOES NOT. Single WORDS and how often each occurs —
    // never a sentence, never a comment, never a row id, never anything joining a word back to the
    // rep or the doctor it was written about. The check needs the vocabulary of the corpus, not its
    // content, and the content is a clinical record that does not belong in a git repository.
    //
    // Narrowed further to words within reach of a product name, because that is the only
    // neighbourhood a vocabulary change can affect. It also keeps the file to the words the check
    // reads rather than the field's whole dictionary.
    const frozen: Record<string, number> = {};
    for (const [token, hits] of frequency) {
      if (hits < 3 || token.length < 4) continue;
      const nearest = nearestProduct(token);
      if (!nearest || nearest.gap > FREEZE_WITHIN_EDITS) continue;
      frozen[token] = hits;
    }
    const ordered = Object.keys(frozen)
      .sort((a, b) => frozen[b] - frozen[a] || a.localeCompare(b))
      .reduce<Record<string, number>>((out, key) => ({ ...out, [key]: frozen[key] }), {});
    writeFileSync(
      freezePath,
      `${JSON.stringify(
        {
          note: "Single words from the old CRM's visit comments and how often each occurs. No sentences, no ids, nothing joining a word to a person. Only words within a few edits of a Phoenix product name, which is the only neighbourhood a vocabulary change can reach. Regenerate with scripts/dictation-corrector-eval.ts --freeze.",
          generated: new Date().toISOString().slice(0, 10),
          comments,
          distinctTokensInCorpus: frequency.size,
          withinEdits: FREEZE_WITHIN_EDITS,
          tokens: ordered,
        },
        null,
        1,
      )}\n`,
      "utf8",
    );
    console.log(`frozen fixture           ${Object.keys(ordered).length.toLocaleString()} tokens -> ${freezePath}`);
  }

  console.log(`\ncomments                 ${comments.toLocaleString()}`);
  console.log(`distinct tokens          ${frequency.size.toLocaleString()}`);
  console.log(`tokens changed           ${tokensTouched.toLocaleString()} (${occurrencesTouched.toLocaleString()} occurrences)`);
  console.log(`  matching a listed form ${known.length.toLocaleString()}`);
  console.log(`  NEEDING REVIEW         ${review.length.toLocaleString()} (${reviewAboveFloor.length} at ${minHits}+ occurrences)`);
  console.log(`left alone, close to one ${missed.length.toLocaleString()} (${missed.reduce((n, m) => n + m.hits, 0).toLocaleString()} occurrences)`);
  console.log(`comments changed         ${commentsChanged.toLocaleString()}`);
  console.log(`\nreport: ${outPath}`);

  if (reviewAboveFloor.length) {
    console.log(`\nTop of the review list:`);
    for (const r of reviewAboveFloor.slice(0, 40)) console.log(`  ${String(r.hits).padStart(6)}  ${r.from}  ->  ${r.to}`);
  }
}

await main();
