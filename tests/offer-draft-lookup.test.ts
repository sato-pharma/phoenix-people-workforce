import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { offerEmailLikePattern, pickDraftOfferRow } from "@/lib/offers/service";

/**
 * "Fix the offer lookup that only sees the newest 200 offers" (owner, 7 Nov 2026, from the row-cap audit).
 *
 * Making a letter from a recruitment application first looks for a DRAFT already on file for the same
 * job title and the same candidate email, and reuses it. That look-up used to be a `.find()` over
 * `listOffers()`, which is only the newest 200 letters: a draft older than that was invisible, so the
 * candidate was given a second letter, with a second reference number, for the same job.
 *
 * What is pinned: the route no longer scans the list; the read goes to the database for THIS email's
 * drafts and pages to the last row; and the exact comparison (title and email, any case, edge spaces
 * ignored, a blank email never matches) is kept bit for bit.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

type Row = { candidate_email: string; id: string; title: string };
const row = (id: string, title: string, candidate_email: string): Row => ({ candidate_email, id, title });

export function runOfferDraftLookupTests() {
  // 1. The exact call: both fields must match, case and edge spaces do not matter, the newest wins.
  {
    const rows = [
      row("newest", "Medical Representative", "Sara@Example.com"),
      row("older", " medical representative ", " sara@example.com "),
      row("other-job", "Area Manager", "sara@example.com"),
      row("other-person", "Medical Representative", "sara.k@example.com"),
    ];
    assert.equal(pickDraftOfferRow(rows, "medical representative", "SARA@example.com")?.id, "newest", "the newest matching draft is the one reused");
    assert.equal(pickDraftOfferRow(rows.slice(1), "Medical Representative", "sara@example.com")?.id, "older", "edge spaces and case do not hide a draft");
    assert.equal(pickDraftOfferRow(rows, "Area Manager", "sara@example.com")?.id, "other-job", "the job title is part of the match");
    assert.equal(pickDraftOfferRow(rows, "Medical Representative", "sara.k@example.com")?.id, "other-person", "a longer address that merely contains the email is not the same person");
    assert.equal(pickDraftOfferRow(rows, "Area Manager", "sara.k@example.com"), undefined, "the right person on the wrong job is no match");
    assert.equal(pickDraftOfferRow(rows, "Sales Manager", "sara@example.com"), undefined, "an unknown title is no match");
  }

  // 2. A blank email or title never matches, even a row that also has a blank one.
  {
    const rows = [row("blank", "Medical Representative", "")];
    assert.equal(pickDraftOfferRow(rows, "Medical Representative", ""), undefined, "no email asked, no draft reused");
    assert.equal(pickDraftOfferRow(rows, "Medical Representative", "   "), undefined, "spaces are no email");
    assert.equal(pickDraftOfferRow([row("x", "", "a@b.com")], "", "a@b.com"), undefined, "no title asked, no draft reused");
  }

  // 3. The SQL narrowing can only over-read: any case, stray spaces, and LIKE's own characters are literal.
  {
    assert.equal(offerEmailLikePattern("Sara@Example.com"), "%sara@example.com%");
    assert.equal(offerEmailLikePattern("  sara@example.com "), "%sara@example.com%");
    assert.equal(offerEmailLikePattern("a_b%c\\d@x.com"), "%a\\_b\\%c\\\\d@x.com%", "an underscore, a percent sign and a backslash are read literally");
  }

  // 4. The route asks the database; it no longer scans the newest 200.
  {
    const route = read("app/api/recruitment/applications/[id]/offer-letter/route.ts");
    assert.match(route, /await findDraftOfferFor\(draft\.title, draft\.candidateEmail\)/, "the reuse look-up goes to the database");
    assert.doesNotMatch(route, /listOffers/, "the newest-200 list is not used to decide whether a draft exists");
  }

  // 5. The read pages to the last row, narrows to drafts and the email in SQL, and is never a bare list.
  {
    const service = read("src/lib/offers/service.ts");
    const from = service.indexOf("export async function findDraftOfferFor");
    assert.ok(from >= 0, "the look-up exists");
    const body = service.slice(from, service.indexOf("export function offerEmailLikePattern", from));
    assert.match(body, /fetchAllRows<OfferRow>/, "paged to the last row, so a busy email cannot hide a draft");
    assert.match(body, /\.eq\("status", "draft"\)/, "only drafts are read");
    assert.match(body, /\.ilike\("candidate_email", offerEmailLikePattern\(wantedEmail\)\)/, "narrowed by this candidate's email in SQL");
    assert.match(body, /pickDraftOfferRow\(rows, title, candidateEmail\)/, "the exact comparison is made after the read");
    assert.doesNotMatch(body, /listOffers\(/, "never found through the newest-200 list");
    assert.doesNotMatch(body, /\.limit\(|\.range\(\s*0\s*,\s*(?:99|199|499|999)\s*\)/, "no fixed window on the read");
  }
}
