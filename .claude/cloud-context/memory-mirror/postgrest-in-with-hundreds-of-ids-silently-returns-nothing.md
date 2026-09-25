---
name: postgrest-in-with-hundreds-of-ids-silently-returns-nothing
description: "A PostgREST .in() fails three ways — an empty set with NO error, 22P02 on a single null id, and UND_ERR_HEADERS_OVERFLOW / 'fetch failed' on a read that SUCCEEDED. Only the first is quiet; the other two read as a network fault."
metadata:
  type: reference
---

The filter goes in the URL, so `.in()` has three distinct failure modes and **only one of them is
quiet**. The hook used to name the quiet one alone, which sends a session hunting for missing data
when what it has is a hard error.

## 1 — Zero rows, no error (the quiet one)

`.in("candidate_id", ids)` with **409** ids returned **zero rows and no error**. The same query with
67 ids worked. Supabase hands back `{ data: [], error: null }`, and **the empty result is
indistinguishable from a true answer.** On 2026-08-25 this reported "never read at all: **409 of
409**" candidates and "0 have a stored file" — both nonsense. Chunked at 50, the truth was **10 never
read, all 10 with a file**.

## 2 — One `null` id fails the WHOLE request

postgrest-js stringifies each value into the filter, so a JavaScript `null` reaches Postgres as the
literal text `null`: `22P02 invalid input syntax for type uuid: "null"`. No partial answer, no
per-row degradation — the read throws. **`new Set(ids)` does not save you**; it dedupes the null to
one entry and sends it. Measured through the real client on production 2026-09-10 while fixing
`/admin/customer-pharmacy-mapping` (PR #3627), where four active links carry a NULL
`distributor_code_id` **on purpose** (a venue with no distributor account) and the page died behind
an opaque "Customer pharmacy mapping failed."

## 3 — The read that SUCCEEDS overflows the response headers

PostgREST echoes the query string back in the `Content-Location` **response** header, so the URL is
paid for twice and the response header block crosses Node's 16,384-byte cap
(`require("http").maxHeaderSize`). It surfaces as `TypeError: fetch failed` with
`UND_ERR_HEADERS_OVERFLOW` on `cause` — **which reads as a network fault**, not as a query that is
too long. The echo is percent-encoded and so runs *longer* than what you sent (a 14,759-char URL
echoed at 15,507), meaning the cliff is lower than the URL length suggests: binary-searched on
production 2026-09-10, **395 ids succeed and 396 throw**, a request URL of about 14.8KB.

**They arrive in that order.** A 400 carries no long `Content-Location`, so while the null is still
in the array you only ever see the `22P02` — fixing it is what exposes the overflow. Measured: 411
Set entries (410 real + one null) in one `.in()` returns `22P02`, never the overflow.

## How to avoid all three

Chunk at ~50 and drop nullish ids in the same pass. 50 uuids build a filter of about 1.9KB.

```js
const idFilterChunks = (ids) => {
  const unique = Array.from(new Set(ids.filter((id) => id != null)));
  const chunks = [];
  for (let i = 0; i < unique.length; i += 50) chunks.push(unique.slice(i, i + 50));
  return chunks;
};
```

**How to catch mode 1:** print the row count of the intermediate fetch, not just the derived answer.
`Extraction rows found: 726` is what exposed it — a pool of 409 candidates cannot have 0.

Full account, all three modes with the measurements: `docs/agents-session-traps.md`, under this
hook's own wording. Sibling shape trap:
[[postgrest-neq-on-an-absent-jsonb-key-matches-nothing]]. Bit while measuring
[[the-medical-rep-cv-schema-reads-12-fields-universal-reads-38]].
