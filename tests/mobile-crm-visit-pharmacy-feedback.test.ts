import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripCommentsCompact } from "./support/comment-strip.ts";

import { parseVisitDraft } from "../src/lib/phoenix-crm/entry-rules.ts";

/**
 * Phoenix CRM — the phone's Add Visit form carries the pharmacy feedback the server requires.
 *
 * #4341 added the pharmacy name and the per-product stock check to a visit: the server's
 * `parseVisitDraft` now REFUSES a body with no pharmacy name, and the web form (visits-tab.tsx) grew
 * both halves. The phone's form was never updated, so every save from the app came back
 * "Write the pharmacy you took feedback from." with no field on screen to write it in — the rep at
 * the door could not save a visit at all. This pins the fix from both ends: the server contract that
 * makes the field load-bearing, and the phone payload that must carry it.
 *
 * GOLDEN RULE #1 (AGENTS.md §4): the rep's app is the simplest thing he touches and it never tells
 * him he is being checked. So the added section is stock only — no distance, flag or location wording
 * of any kind, mirroring the web.
 */

function source(path: string): string {
  return stripCommentsCompact(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

// A live fix over Cairo; enough for parseCapturedFix to accept the body.
function visitBody(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    customerId: "11111111-1111-4111-8111-111111111111",
    kind: "single",
    products: ["Satoprazole"],
    pharmacyName: "El Ezaby — Nasr City",
    comment: "Discussed the new dose.",
    photoPath: "phoenix-crm/visits/seat/photo.jpg",
    lat: 30.05,
    lon: 31.23,
    accuracyMeters: 12,
    ...patch,
  };
}

export function runMobileCrmVisitPharmacyFeedbackTests(): void {
  // ── The server contract: the pharmacy name travels when sent, and is OPTIONAL ──────────────────
  //
  // Owner, 2026-09-29: the pharmacy stock check stays on the visit but never blocks it. So the
  // server now ACCEPTS a visit with no pharmacy (it was the refusal that stranded the phone before
  // #4341's fix), and one the phone does send is carried through untouched.
  {
    const ok = parseVisitDraft(visitBody({}));
    assert.equal(ok.ok, true, "a visit with a pharmacy name is accepted");
    if (ok.ok) assert.equal(ok.value.pharmacyName, "El Ezaby — Nasr City", "the pharmacy name is carried through");

    const missing = parseVisitDraft(visitBody({ pharmacyName: "" }));
    assert.equal(missing.ok, true, "no pharmacy name is accepted — the stock check is optional since 2026-09-29");
    if (missing.ok) assert.equal(missing.value.pharmacyName, null, "and it is stored as no pharmacy, never an empty name");

    const blank = parseVisitDraft(visitBody({ pharmacyName: "   " }));
    assert.equal(blank.ok, true, "a whitespace-only pharmacy name is simply no pharmacy");
  }

  // ── The stock answers travel with it, filtered to the two real values ───────────────────────────
  {
    const draft = parseVisitDraft(
      visitBody({ productAvailability: { Satoprazole: "has", "Lacto Advanced": "missing", Royanoxicam: "nonsense" } }),
    );
    assert.equal(draft.ok, true, "the stock answers do not block the save");
    if (draft.ok) {
      assert.equal(draft.value.productAvailability.Satoprazole, "has", "a Has answer is kept");
      assert.equal(draft.value.productAvailability["Lacto Advanced"], "missing", "a Doesn't-have answer is kept");
      assert.equal("Royanoxicam" in draft.value.productAvailability, false, "an answer that is neither is dropped, never refused");
    }
  }

  // ── The phone's payload actually carries the two fields ─────────────────────────────────────────
  //
  // The regression that broke the app was invisible to the server contract above: the phone simply
  // never put pharmacyName or productAvailability in the body. Pin the payload the draft() builds.
  {
    const code = source("mobile/src/features/crm/visits-screen.tsx");
    const start = code.indexOf("function draft(");
    assert.notEqual(start, -1, "the phone still builds a visit draft");
    const body = code.slice(start, start + 2200);
    assert.ok(body.includes('if (!pharmacyName.trim())'), "the phone refuses a visit with no pharmacy name, like the web form");
    assert.ok(body.includes("pharmacyName: pharmacyName.trim()"), "the phone's visit payload carries the pharmacy name");
    assert.ok(body.includes("productAvailability: availability"), "and the per-product stock answers");
  }

  // ── The section exists, is numbered like the web, and adds no tracking wording ──────────────────
  {
    const code = source("mobile/src/features/crm/visits-screen.tsx");

    // 🔴 DERIVED FROM THE WEB, not hard-coded (2026-09-26). This block used to pin "6 · Live photo"
    // by its literal number, and E3 inserting a step above it turned a correct phone into a red test
    // — the pin read the number rather than the rule it stands for, which is that the two forms are
    // numbered the SAME. A later step adds another section and the same thing happens again. Now the
    // web's own step titles are the expected list, so the phone can only fail this by DIVERGING.
    const titles = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]).filter((title) => /^\d+ · /.test(title));
    // Since 2026-09-29 the web's form lives in visit-log-form.tsx and has NO photo step ("Log visit" is
    // one tap). Since 2026-09-30 the web's Comment follows its Products — the comment became required,
    // and the required steps lead — while the phone keeps its own order until its form is next rebuilt.
    // So what is pinned is that the two carry the SAME steps under the SAME names, each numbered 1, 2,
    // 3… in its own order with no gap; only a trailing photo step may follow on the phone.
    const web = titles(source("src/components/phoenix-crm/visit-log-form.tsx"), /<CrmBlock[^>]*title="([^"]+)"/g);
    const phone = titles(code, /<CrmSection title="([^"]+)"/g);
    assert.ok(web.length >= 6, `the web form's steps must actually be found — got ${web.length}`);
    const named = (list: string[]) => list.map((title) => title.replace(/^\d+ · /, "")).sort();
    const phoneShared = phone.filter((title) => !/Live photo/.test(title));
    assert.deepEqual(named(phoneShared), named(web), "the two forms carry the same steps, named alike");
    for (const [app, list] of [["web", web], ["phone", phone]] as const) {
      assert.deepEqual(
        list.map((title) => Number(/^(\d+) · /.exec(title)?.[1])),
        list.map((_, index) => index + 1),
        `${app}: the steps are numbered 1, 2, 3… in order, with no gap`,
      );
    }
    assert.ok(phone.slice(phoneShared.length).every((title) => /Live photo/.test(title)), "anything more on the phone is its photo step, at the end");
    assert.equal(web.some((title) => /photo/i.test(title)), false, "the web's visit has no photo step");
    assert.ok(phone.includes("4 · Pharmacy you took feedback from"), "and the pharmacy section is one of them, at 4");
    assert.ok(code.includes("Does this pharmacy have these products?"), "the stock grid asks the same question as the web");

    // GOLDEN RULE #1, the BLIND half: the rep's form never hints at a check. The only visit save
    // wording about location is the neutral pill on a saved row; the Add Visit form itself must not
    // gain a distance/flag/tracking line with this change.
    const formStart = code.indexOf('title="4 · Pharmacy you took feedback from"');
    const formEnd = code.indexOf('title="5 · Comment"');
    const section = code.slice(formStart, formEnd);
    for (const banned of ["distance", "flag", "tracked", "checked against", "location check"]) {
      assert.ok(!section.toLowerCase().includes(banned), `the pharmacy section says nothing about "${banned}"`);
    }
  }

  console.log("mobile CRM visit pharmacy feedback: OK");
}
