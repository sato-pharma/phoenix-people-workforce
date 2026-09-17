import assert from "node:assert/strict";

import { earlyBirdsHref } from "../src/components/early-birds/early-birds-links.ts";

// The Early Birds board asks three questions at once - whose reps, which fortnight, and which rep's
// record is open - and every control on it is a LINK rather than a client-side filter, so that each
// switch re-runs the server-side scope gate.
//
// The cost of that design is that every link has to carry the OTHER two parameters forward, and a
// dropped one is INVISIBLE in review: the page still renders, it just renders a different question's
// answer. That is exactly what shipped. The district chips wrote `?district=` and nothing else, so a
// manager reading August who switched district was silently thrown back to the live fortnight, with
// nothing on screen saying the question had changed.
//
// These are cheap string assertions on purpose. The failure they prevent is not a crash.

const BASE = "/employee-portals/early-birds";

export function runEarlyBirdsLinkTests() {
  // -- nothing set is the bare path, not a dangling "?" --------------------------
  {
    assert.equal(earlyBirdsHref(BASE, {}), BASE);
    assert.equal(earlyBirdsHref(BASE, { district: null, period: undefined, rep: null }), BASE);
  }

  // -- HEADLINE: switching one parameter keeps the other two --------------------
  // This is the regression. Read each assertion as a sentence a user would say.
  {
    const switchingDistrict = earlyBirdsHref(BASE, {
      district: "B-207",
      period: "2026-08-H1",
      rep: "B-311",
    });
    assert.ok(
      switchingDistrict.includes("period=2026-08-H1"),
      `"I was reading August and I changed district" must stay in August. Got ${switchingDistrict}.`,
    );
    assert.ok(
      switchingDistrict.includes("rep=B-311"),
      `"I had a rep's record open and I changed district" must keep it open. Got ${switchingDistrict}.`,
    );

    const switchingPeriod = earlyBirdsHref(BASE, { district: "B-207", period: "2026-09-H1" });
    assert.ok(
      switchingPeriod.includes("district=B-207"),
      `"I changed fortnight" must not throw a Super Admin back to the first district in the ` +
        `company. Got ${switchingPeriod}.`,
    );
  }

  // -- fixed key order, so two links to the same view are the same string -------
  // The active chip decides it is active by comparing hrefs, and Next.js treats two spellings of
  // one view as two routes.
  {
    assert.equal(
      earlyBirdsHref(BASE, { rep: "B-311", period: "2026-08-H1", district: "B-207" }),
      `${BASE}?district=B-207&period=2026-08-H1&rep=B-311`,
      "the parameters must serialise in a fixed order whatever order the caller passes them in",
    );
  }

  // -- an empty string is a deliberate CLEAR, not a missing value ---------------
  // It is how the history panel's close button drops the rep while keeping the district and the
  // fortnight it was opened from. If it round-tripped as `rep=`, closing the panel would reopen it
  // on a rep with an empty id.
  {
    const closed = earlyBirdsHref(BASE, { district: "B-207", period: "2026-08-H1", rep: "" });
    assert.equal(closed, `${BASE}?district=B-207&period=2026-08-H1`);
    assert.ok(!closed.includes("rep="), `closing the record must remove ?rep= entirely. Got ${closed}.`);
  }

  // -- values are encoded ------------------------------------------------------
  // An HR id is tame, but these come off a URL and go back into one, and a raw "&" would turn one
  // parameter into two.
  {
    const encoded = earlyBirdsHref(BASE, { district: "B 207&x=1" });
    assert.equal(encoded, `${BASE}?district=B%20207%26x%3D1`);
  }

  // -- a non-string never reaches the URL --------------------------------------
  // searchParams hands back `string | string[] | undefined`, so an array is a real shape here.
  {
    const query = { district: ["B-207", "B-208"] } as unknown as { district?: string | null };
    assert.equal(
      earlyBirdsHref(BASE, query),
      BASE,
      "a repeated ?district= must be dropped, never coerced to \"B-207,B-208\" - which matches no " +
        "district and would refuse the page for a viewer who did nothing wrong",
    );
  }

  // -- the admin twin builds the same shapes from its own base path ------------
  {
    assert.equal(
      earlyBirdsHref("/admin/early-birds", { district: "B-207", period: "2026-09-H2" }),
      "/admin/early-birds?district=B-207&period=2026-09-H2",
    );
  }
}
