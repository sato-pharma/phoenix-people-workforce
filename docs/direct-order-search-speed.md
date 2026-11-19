# Direct Orders customer search — why a short probe was slow, and what answers it now

Function: `public.phx_search_direct_order_customers(p_query, p_distributor_code, p_limit)`. It feeds the
customer picker on the Direct Orders request form: the rep types, and the list under the box narrows.
Migration: `supabase/migrations/20261016210000_direct_order_search_short_probe_fast_path.sql`.
Pinned by `tests/direct-order-search-short-probe-fast-path.test.ts`.

## What was measured (production, 16 Oct 2026)

- 125 calls recorded: mean 590 ms, worst 5,316 ms.
- A probe of one or two characters took 1.9–2.1 s warm (`'10'` 1,959 ms, `'ab'` 1,925 ms, two Arabic
  letters 2,083 ms). A cold run also read about 1,100 index pages from disk.
- The directory holds 81,016 active customers.

## Why

The search matches the customer CODE (contains) or the Arabic-normalised NAME (contains). Both columns
have trigram indexes, and a trigram index cannot narrow anything for fewer than three characters: for
`'%10%'` it returns every row. So all 81,016 rows were re-checked, each one calling
`phx_normalize_arabic` (about 17 microseconds) and up to three `ILIKE`s. That re-check was about 2.3 s of
the 2.5 s warm run. The second keystroke of a name is exactly this case.

## What changed (two things, both output-identical)

1. **`phx_normalize_arabic` has a cheaper body.** Same text in, same text out. Three letter-folding
   regexes became one `translate()` over seven letters; the two removals (harakat/tatweel, then
   whitespace) became one `regexp_replace` over one class that keeps the original `\s`; and the function
   is plpgsql, which skips the SQL-function executor start (about 3.5 microseconds a call). The index
   definitions are untouched and store the same values, so nothing was rebuilt. Equality was checked on
   all 1,112,063 code points, 162,384 real names/codes/addresses and 185,193 synthetic strings: 0
   differences.
2. **A probe of one or two plain characters is answered from a GIN index.**
   `phx_direct_order_search_keys(code, name)` writes every 1- and 2-character piece of the lower-cased code
   (prefix `c:`) and of the lower-cased normalised name (prefix `n:`);
   `source_of_sales_customer_map_search_keys_idx` indexes it (partial on `active`, like its trigram
   siblings). The search flags `short_probe` when the trimmed probe matches
   `^[0-9A-Za-zء-ي]{1,2}$` and looks the pieces up with `&&`. Every other probe — three or more
   characters, or any `%`, `_`, `\`, dash, slash or space — takes the existing trigram path, unchanged.

Why the result is identical: `ILIKE '%x%'` lower-cases both sides and looks for `x` as a substring, and
for `x` of one or two characters from that alphabet `lower()` works character by character, so "the
lower-cased code contains `x`" is "its 1- and 2-character pieces include `x`", which is what the index holds.
The Phoenix-pharmacies half, the ranking and the limit are byte-for-byte the originals.

## Proof it was identical

Before and after the migration, on **staging** (179 probes) and on **production** (177 probes, every
probe against every distributor filter it was given), the function returned the same row count, the same row
set and the same row order. The fingerprint (row count, order-insensitive hash, order-sensitive hash) was
taken by a scratch function before the migration and again after, and compared probe by probe.

## What it did to the timings (staging, 179 probes)

- Probes of one or two plain characters: 1.3–1.9 s to mostly 3–50 ms. The plan for `'10'` shows the trigram
  arm as "never executed" and the short arm on the new index, 36 ms against about 1.5 s.
- Common bigrams and single common characters still return a large set (up to the 100-row limit after
  ranking): 150–380 ms.
- Probes that take the slow path (wildcards, symbols, spaces) improved from about 1.1–1.4 s to about
  0.75–0.95 s through the cheaper normaliser alone.

## What it did NOT fix

A common three- or four-character probe (letters that occur in thousands of names) still takes about 1 s:
a trigram index narrows it to a long list of candidates, each of which is then verified. The only further
options are a stored, indexed normalised-name column (a write-path change across imports) or a behaviour
change (start searching at three characters). Neither is done here.

## Rules that keep it right

- `phx_normalize_arabic` backs two other indexes. Its output must stay identical for every input; the
  removal class is deliberately NOT widened, because a range reaching the letters at U+0621..U+063A
  reduces a probe to the empty string and the search then matches every row while looking like it works.
- The short-probe bound (`{1,2}`), the key function's longest piece (2) and the `c:`/`n:` prefixes move
  together. A probe longer than the pieces finds nothing and returns an empty list that reads as "no such
  customer". The test refuses any of them changing alone.
- The alphabet must never contain `%`, `_` or `\`: inside an `ILIKE` those mean something other than "contains".
- The search stays `SECURITY INVOKER`. The key function is revoked from `public`, `anon` and
  `authenticated` by name (this project's default ACL hands new public functions to the latter two) and
  granted to `service_role` only.
- The existing `customer_code` trigram index (`search-direct-order-customer-code-trgm-live-on-prod-2026-08-14`)
  stays: it still serves every probe of three or more characters.

## The name is matched word by word (19 Nov 2026)

**What was wrong.** A rep (Mohamed Ramadan) could find two pharmacies by code but not by name. The
name test was "the whole typed text, spaces removed, is one unbroken piece of the normalised name",
and the distributor names are bare ("رياض طهطا ن", "خالد عبدالرحيم-قوص ن م"). So typing the word
"pharmacy" first, or the words in another order, found nothing. Measured on production: "صيدلية رياض",
"صيدليه رياض" and "صيدلية خالد عبدالرحيم" returned 0 rows; "رياض طهطا" and both codes found them.

**What the search does now** (`20261119234441_direct_order_search_word_by_word.sql`):

- The typed text is split into words on spaces and punctuation. Every word must appear somewhere in
  the normalised name, in any order.
- The generic words are left out: صيدلية, الصيدلية, صيدليات, ص, د, دكتور, دكتورة, pharmacy, dr. A probe made
  only of them falls back to the old whole-text test.
- Each word drops a leading "ال" when two or more letters remain, so "صيدلية الرياض" finds "رياض طهطا ن".
- Hamza on alef (أ إ آ ٱ), ى and ئ against ي, ة against ه, tashkeel and tatweel were already folded by
  `phx_normalize_arabic` on both sides. That function is NOT changed: three indexes are built on it.

**Nothing that was found before is lost, or moved down.** The new test is a superset of the old one,
because the normaliser works one character at a time. Every row carries `old_match` (the old test
would have returned it), and that is the first ranking key. So the first N rows always hold the old
first N rows in the old order, and the extra matches come after them. Proven on production with 17
probes against a temporary copy of the old function: every old answer is kept, in the same order.

**Speed** (production, the generic plan a SQL function gets):

| Probe | Old | New |
| --- | --- | --- |
| محمد (18,173 names) | 318 ms | 309–322 ms |
| مصطفى | 62–119 ms | 68–105 ms |
| محمد علي | 22–32 ms (found only "محمدعلي" written together) | 54–117 ms |
| صيدلية محمد | 9 ms (3 rows) | 850–950 ms (every محمد, the 3 first) |
| the two pharmacies, by name or code | 7–12 ms | 9–21 ms |

Three things in the SQL hold that speed; the test refuses each of them changing:

- A one-word probe keeps the name test alone on `p.lead`. A `p.norm is not null` beside it can no
  longer be proven from the `ilike`, so the planner adds a Filter that repeats the whole OR, and the
  plpgsql normaliser runs twice per row (688–880 ms on "محمد" in the drafts).
- A probe of two or more words tests its two LONGEST words as index conditions, so the trigram index
  intersects them. `ilike all` over the array, which no GIN index can use, only re-checks a third word.
- The two directory arms are split on word count, and they never both return a row.

**The app's own cut.** `searchDirectOrderPharmacyDirectory` asks SQL for its full 100 rows and applies the
caller's limit after the area and wholesaler filters. Before, it cut to 30 first, so a common word could
fill the page with other areas' pharmacies, which the area filter then removed.

## Rollback

For the word-by-word match only: `create or replace` the search with the body in
`20261016210000_direct_order_search_short_probe_fast_path.sql` (section 3), and put the `p_limit` and the
`.slice` in `searchDirectOrderPharmacyDirectory` back.

For everything: `create or replace` the two functions back to the bodies in `20260807120000_direct_order_search_arabic_space_fold.sql`
(the normaliser) and `20260804183000_direct_order_customer_directory_search.sql` (the search), then
`drop index public.source_of_sales_customer_map_search_keys_idx` and
`drop function public.phx_direct_order_search_keys(text, text)`. Nothing else depends on the new objects.
