import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripCommentsCompact } from "./support/comment-strip.ts";

import { pickLastVisitProducts, type LastVisitRow } from "../src/lib/phoenix-crm/last-visit-products.ts";

/**
 * Phoenix CRM — "same as last visit", the EASY half of GOLDEN RULE #1.
 *
 * Owner, 2026-09-26: "very easy very simple … nothing is asked twice." A rep sees the same doctor
 * every few weeks and re-taps the same three products every time. The answer was already in his own
 * last visit, so the form fills them in the moment he picks the customer and names the day they came
 * from; he changes any of them with one tap, exactly as before.
 *
 * The three rules here are the ones that are wrong in the QUIET direction — nothing crashes, a rep
 * simply saves a product he did not discuss.
 */

const LINE = ["Satoprazole", "Lacto Advanced", "Royanoxicam"];

function row(patch: Partial<LastVisitRow>): LastVisitRow {
  return {
    customerId: "c1",
    visitDate: "2026-09-10",
    capturedAt: "2026-09-10T08:00:00.000Z",
    products: ["Satoprazole"],
    ...patch,
  };
}

/**
 * Comments removed AND the blank lines they leave collapsed.
 *
 * `stripComments` blanks a comment in place so `file:line` stays honest, which is right for a
 * whole-file match and wrong for the fixed-size windows below: the explanation above `pickCustomer`
 * is longer than the window, so the code it explains fell outside it. That is the exact trap the
 * stripper's own header records.
 */
function source(path: string): string {
  return stripCommentsCompact(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

export function runPhoenixCrmLastVisitProductsTests(): void {
  // ── The newest visit wins, and a tie inside one day is broken by the server's own clock ─────────
  {
    const map = pickLastVisitProducts(
      [
        row({ visitDate: "2026-09-01", products: ["Royanoxicam"] }),
        row({ visitDate: "2026-09-18", products: ["Lacto Advanced"] }),
        row({ visitDate: "2026-09-10", products: ["Satoprazole"] }),
      ],
      LINE,
      12,
    );
    assert.deepEqual(map.get("c1"), { date: "2026-09-18", products: ["Lacto Advanced"] }, "the newest day wins whatever order the rows arrive in");

    const sameDay = pickLastVisitProducts(
      [
        row({ capturedAt: "2026-09-10T07:00:00.000Z", products: ["Royanoxicam"] }),
        row({ capturedAt: "2026-09-10T13:00:00.000Z", products: ["Lacto Advanced"] }),
      ],
      LINE,
      12,
    );
    assert.deepEqual(sameDay.get("c1")?.products, ["Lacto Advanced"], "two visits on one day: the later capture wins");
  }

  // ── A product the line no longer sells is dropped ───────────────────────────────────────────────
  //
  // Prefilling a name the grid does not offer would show him a selection he cannot see, cannot clear
  // and would then SAVE — the quietest way to put a retired product back into the numbers.
  {
    const map = pickLastVisitProducts([row({ products: ["Satoprazole", "Withdrawn Syrup"] })], LINE, 12);
    assert.deepEqual(map.get("c1")?.products, ["Satoprazole"], "a retired product never comes back");

    const allGone = pickLastVisitProducts([row({ products: ["Withdrawn Syrup"] })], LINE, 12);
    assert.equal(allGone.has("c1"), false, "a visit whose products are ALL retired carries nothing over, rather than offering an empty list");
  }

  // ── A customer with no earlier visit is ABSENT, never present and empty ─────────────────────────
  //
  // The screen has to tell "nothing to carry over" from "he discussed nothing": the first hides the
  // sentence, the second would print "Filled in from your last visit" over an empty grid.
  {
    const map = pickLastVisitProducts([row({ customerId: "c1" })], LINE, 12);
    assert.equal(map.has("c2"), false, "a customer he has never visited is not in the map at all");
  }

  // ── The cap and the duplicates ──────────────────────────────────────────────────────────────────
  {
    const many = pickLastVisitProducts([row({ products: [...LINE, ...LINE] })], LINE, 2);
    assert.equal(many.get("c1")?.products.length, 2, "never more than the form's own maximum");
    const dupes = pickLastVisitProducts([row({ products: ["Satoprazole", "Satoprazole", " Satoprazole "] })], LINE, 12);
    assert.deepEqual(dupes.get("c1")?.products, ["Satoprazole"], "the same product twice is once");
  }

  // ── Today's own visit can never prefill itself ──────────────────────────────────────────────────
  //
  // A second visit to one customer on one day is refused by the database, but a rep who visits a
  // customer at 9am and opens the form again at 11am must not be handed HIS OWN morning back as
  // "last visit" — that is not carrying anything over. The floor is in the read, not in the rules.
  {
    // `loadLastVisits` since E3 (2026-09-26): one read, two answers — the products the form carries
    // over, and the commitment the rep made last time. The floor below belongs to both.
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    const start = visits.indexOf("async function loadLastVisits");
    assert.notEqual(start, -1, "loadLastVisits is still there");
    // A window, not a parse. `source()` blanks comments IN PLACE, so it holds line numbers steady and
    // a comment inside the function still costs the window its length — sized for the whole of it and
    // proved by the last assertion below, which reads the closing line of the same function.
    const body = visits.slice(start, start + 2400);
    assert.ok(body.includes("pickLastVisitProducts("), "and it is still the caller of the pure rule");
    assert.ok(body.includes('.lt("visit_date", today)'), "the read must stop strictly before today");
    assert.ok(body.includes("fetchAllRowsKeyset"), "and must page, like every other read in the module");
  }

  // ── Both apps prefill, so the two copies cannot drift ───────────────────────────────────────────
  {
    // The web app: since the one-tap rebuild (2026-09-29) the customer is chosen on the steps BEFORE the
    // form, and the form (visit-log-form.tsx) opens on him — so the products are filled in by the
    // form's own first state, from his last visit, rather than by a picker handler.
    {
      const path = "src/components/phoenix-crm/visit-log-form.tsx";
      const code = source(path);
      const start = code.indexOf("function carriedProducts(");
      assert.notEqual(start, -1, `${path} still carries the last visit's products`);
      const body = code.slice(start, start + 300);
      assert.ok(body.includes("lastVisit"), `${path} must carry the last visit's products over`);
      assert.match(
        code,
        /const \[products, setProducts\] = useState<string\[\]>\(\(\) => \{[^}]*carriedProducts\(customer\)/,
        `${path} must fill the products in when the form opens, not merely read them`,
      );
      assert.ok(
        code.includes("Filled in from your last visit on"),
        `${path} must say which day they came from — a silent prefill he cannot see the source of is worse than asking`,
      );
    }
    // The phone still picks the customer on its form.
    for (const path of ["mobile/src/features/crm/visits-screen.tsx"]) {
      const code = source(path);
      const start = code.indexOf("function pickCustomer");
      assert.notEqual(start, -1, `${path} still picks a customer`);
      const body = code.slice(start, start + 900);
      assert.ok(body.includes("lastVisit"), `${path} must carry the last visit's products over when he picks the customer`);
      assert.ok(body.includes("setProducts("), `${path} must fill the products in, not merely read them`);
      assert.ok(
        code.includes("Filled in from your last visit on"),
        `${path} must say which day they came from — a silent prefill he cannot see the source of is worse than asking`,
      );
    }
  }

  console.log("phoenix-crm last visit products: OK");
}
