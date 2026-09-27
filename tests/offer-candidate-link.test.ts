import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * An offer must know WHICH CANDIDATE it was written for.
 *
 * WHY THIS EXISTS. `offers` carried only the free-text `candidate_name` and `candidate_email`, so the
 * funnel — candidate, offer, hire, organogram seat — could be reassembled only by matching names.
 * Measured on production 2026-09-28: of 27 offers just 3 could be traced to a candidate at all, eight
 * offer recipients were already active seated employees while seven of their offers still read `sent`,
 * and a name match put an offer for a Medical Representative onto the OWNER'S OWN employee record
 * (B-10) and a second onto a District Manager. A text column cannot be made safe; an id can.
 *
 * Everything here is asserted against the SOURCE and the migration FILE rather than a live database,
 * because that is what a required check can actually see — and because each of these is a wiring fact
 * whose failure mode is silence rather than an error.
 */
export function runOfferCandidateLinkTests(): void {
  const migration = readFileSync("supabase/migrations/20260928011309_add_offers_candidate_id.sql", "utf8");
  const service = readFileSync("src/lib/offers/service.ts", "utf8");
  const types = readFileSync("src/lib/offers/types.ts", "utf8");
  const route = readFileSync("app/api/offers/route.ts", "utf8");
  const merge = readFileSync("src/lib/recruitment/candidate-merge-service.ts", "utf8");

  // ── The column, and the one delete rule that is correct here ──────────────────────────────────
  // ON DELETE SET NULL, never CASCADE: deleting a candidate must never destroy the record that an
  // offer was made to them. Getting this backwards would mean a candidate merge silently deleting a
  // salary offer — which is exactly the class of bug the interview booking turned out to be.
  assert.ok(/add column if not exists candidate_id uuid/i.test(migration), "the column must be added");
  assert.ok(
    /references public\.ats_candidates\(id\) on delete set null/i.test(migration),
    "the foreign key must be ON DELETE SET NULL — CASCADE would destroy the record of an offer when a candidate row goes",
  );
  assert.ok(!/on delete cascade/i.test(migration), "no CASCADE anywhere in this migration");

  // NULLABLE on purpose. Three of the eight people hired on 2026-09-28 had no candidate record at
  // all, so a NOT NULL here would have refused to record their offers.
  assert.ok(!/candidate_id uuid not null/i.test(migration), "the column stays nullable — an offer may exist for somebody who never came through the ATS");

  // ── The backfill resolves on the E-MAIL, never on the NAME ────────────────────────────────────
  // Names are what put an offer on B-10. And one address is not evidence either: on production
  // achieverrr303@gmail.com is the recipient on six different people's offers, so any address used by
  // offers for more than one distinct name is excluded outright rather than trusted.
  assert.ok(/c\.email_norm = lower\(btrim\(o\.candidate_email\)\)/.test(migration), "the backfill joins on email_norm");
  assert.ok(
    /having count\(distinct lower\(btrim\(candidate_name\)\)\) > 1/.test(migration),
    "an address used by offers for more than one person must be excluded from the backfill",
  );
  assert.ok(
    !/join public\.ats_candidates c on .*full_name/i.test(migration),
    "the backfill must never resolve a candidate by name",
  );

  // ── The link is carried end to end, or it is decorative ───────────────────────────────────────
  assert.ok(/candidateId: string \| null;/.test(types), "OfferRecord must expose candidateId");
  assert.ok(/candidate_id: string \| null;/.test(service), "the row shape must carry candidate_id");
  assert.ok(/candidateId: row\.candidate_id \?\? null,/.test(service), "toOffer must read it back");
  assert.ok(
    /candidateId\?: string \| null; templateId\?: string \| null/.test(service),
    "createOffer must accept the link the way it already accepts templateId",
  );
  assert.ok(/candidate_id: fields\.candidateId \?\? null,/.test(service), "createOffer must persist it");

  // The route accepts a uuid or nothing. A bad id would be a WRONG link — worse than the null this
  // column is designed to carry — and the foreign key would refuse it with a 500 instead of an offer.
  assert.ok(
    /candidateId: isUuid\(text\("candidateId"\)\) \? text\("candidateId"\) : null,/.test(route),
    "the route must accept candidateId only when it is a uuid",
  );

  // ── A candidate MERGE must keep the link, not cut it ──────────────────────────────────────────
  // The FK is SET NULL, so a merge would not destroy the offer but WOULD quietly detach it from the
  // person — putting the data straight back into the state this column exists to end.
  const childTables = merge.slice(merge.indexOf("const childTables"), merge.indexOf("] as const"));
  assert.ok(
    childTables.includes('"offers"'),
    "offers must be in childTables, or a candidate merge SET NULLs the link it just earned",
  );
  assert.ok(
    /if \(table === "offers"\) movedOffers = moved;/.test(merge),
    "the merge must count the offers it moved",
  );
  assert.ok(
    /countedNoun\(input\.movedOffers, "job offer", "job offers"\)/.test(merge),
    "a job offer is a promise already made to a person, so the merge summary must name it rather than move it silently",
  );
  assert.ok(/movedOffers: number;/.test(merge), "CandidateMergeResult must carry movedOffers");
}
