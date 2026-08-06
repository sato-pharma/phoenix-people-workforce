import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { codeCandidates } from "../src/lib/direct-orders/invoice-extraction.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Invoice-photo prefill (spec B5).
//
// Two rules carry the whole feature, and both are the kind that fail silently:
//
//   1. What the reader returns is a CLAIM. Every code is re-resolved against master data, and
//      anything that does not resolve is NAMED, never quietly dropped and never replaced with the
//      nearest plausible match. This module exists because codes that did not exist were accepted
//      once — 12 phantom pharmacies, 509,736 EGP. A reader that invents a code industrialises that.
//
//   2. It is never announced (spec D4). No "AI", no model name, no provider, no confidence score,
//      no sparkle — anywhere a user can see. A leak here is invisible to typecheck and to every
//      other test in the suite.
//
// The extraction path is OpenAI- and Supabase-bound end to end, so the resolution rules are pinned
// by source; the D4 sweep and the both-forms check execute for real.
// ─────────────────────────────────────────────────────────────────────────────

const EXTRACTOR = "../src/lib/direct-orders/invoice-extraction.ts";
const CAPTURE = "../src/components/direct-orders/invoice-capture.tsx";
const ROUTE = "../app/api/direct-orders/invoice-extract/route.ts";
const ADMIN_FORM = "../src/components/direct-orders/direct-order-submit-form.tsx";
const PORTAL_FORM = "../src/components/employee-portal/direct-order-portal-submit.tsx";

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

export function runDirectOrderInvoicePrefillTests() {
  const extractor = read(EXTRACTOR);
  const capture = read(CAPTURE);
  const route = read(ROUTE);

  // ── Rule 1: an unresolved code prefills NOTHING ──────────────────────────────────────────
  // The RULE is unchanged and load-bearing; only its implementation moved. It used to pin one
  // literal `hits.find(...)` expression, which broke the moment padding and printed pairs had to be
  // tolerated — the old exact-only compare resolved 0 of 6 real invoices. What must never return is
  // a FIRST-HIT or nearest-name match, so that is what is asserted now: the code is compared, the
  // comparison is on the code key, and a candidate is taken only when it is unique.
  assert.match(
    extractor,
    /matches\.length === 1/,
    "THE CUSTOMER CODE MUST BE CONFIRMED BY A UNIQUE DIRECTORY MATCH: a fuzzy or first-hit match would prefill the nearest-looking pharmacy, which is worse than no prefill because it looks deliberate",
  );
  // `matches[0]` is fine and is what the code does — it is the sole element of an array already
  // proven to have length 1. What must never appear is `hits[0]`: taking the first row the
  // DIRECTORY SEARCH returned, with no uniqueness check at all.
  assert.ok(
    !/\bhits\[0\]/.test(extractor),
    "nothing may take the first search hit: with 89 codes colliding once leading zeros are stripped, first-hit resolution files the order against the wrong real pharmacy",
  );
  assert.match(
    extractor,
    /codeKey\(hit\.customerCode\)/,
    "the comparison must still be on the normalized CODE, never on the name — a name compare is how the nearest-looking pharmacy gets prefilled",
  );
  assert.match(
    extractor,
    /if \(!exact\) \{[\s\S]{0,600}?return null;/,
    "AN UNRECOGNISED CUSTOMER CODE MUST RESOLVE TO NULL: prefilling a pharmacy the master database has never heard of is exactly how the 12 phantom pharmacies were created, only faster",
  );
  // The dangerous "helpful" behaviour is falling back to a name match when the code misses.
  assert.doesNotMatch(
    extractor,
    /if \(!exact\)[\s\S]{0,400}?hits\[0\]/,
    "THE RESOLVER MUST NOT FALL BACK TO THE FIRST/NEAREST HIT when the code does not match — that silently lands the order on a different pharmacy",
  );

  // ── Rule 1b: an unmatched line keeps its place ───────────────────────────────────────────
  assert.match(
    extractor,
    /return \{ read, product: null, problem \};/,
    "AN UNMATCHED LINE MUST BE RETURNED, NOT FILTERED: dropping it turns a five-line invoice into four with nobody able to notice — the same silent-discard bug the half-filled distributor row already caused",
  );
  assert.doesNotMatch(
    extractor,
    /\.filter\(\(line\) => line\.product\)/,
    "unmatched lines must never be filtered out of the result",
  );

  // ── Rule 1c: quantities are read, never invented ─────────────────────────────────────────
  assert.match(
    extractor,
    /NEVER guess, complete, correct or infer a code/,
    "the instructions must forbid guessing a code outright — a wrong code is treated as a real pharmacy",
  );
  assert.match(
    extractor,
    /if \(read\.qty == null \|\| read\.qty <= 0\)/,
    "a line with no readable quantity must be flagged rather than defaulted to some number",
  );
  // A quantity is a whole number of boxes; a fractional or negative read is a misread.
  assert.match(extractor, /function count\(value: unknown\)/, "quantities must go through a single normaliser");
  assert.match(extractor, /!Number\.isFinite\(n\) \|\| n < 0/, "a negative or non-finite quantity must not survive");

  // ── Rule 2: D4 — the reader is never announced ───────────────────────────────────────────
  // Only user-visible strings matter: code comments explain WHY and must stay. Extract the string
  // literals and JSX text, then sweep those.
  const bannedWord = /\b(AI|A\.I\.|GPT|OpenAI|LLM|model|artificial intelligence|machine learning|confidence score)\b/i;

  /**
   * Split a source file into its string literals and its remaining code, in ONE string-aware pass.
   *
   * This is deliberately a scanner and not a set of regexes, and the history is worth keeping
   * because both regex attempts failed SILENTLY — the suite stayed green while the check had
   * stopped looking:
   *
   *   1. `/"([^"\\]{4,})"/g` desynchronised on an empty string: `""` cannot match a 4-plus
   *      character body, so the engine paired ITS closing quote with the next opening quote and
   *      every literal after that point was mis-paired.
   *
   *   2. Stripping comments with `/\/\*[\s\S]*?\*\//g` ate 2,698 characters of this component,
   *      because `accept="image/*"` contains `/*`. The regex read that as a comment opening and
   *      deleted everything up to the next `*​/` — a JSX comment far below — taking the button
   *      label with it. A planted "AI is reading the invoice…" was therefore invisible.
   *
   * A scanner cannot make either mistake: it consumes a string literal whole, so `/*` inside one is
   * never treated as a comment, and it never has to guess which quote pairs with which.
   *
   * Known limit: a regex literal containing a quote would confuse it. Neither file has one, and a
   * wrong answer here fails loudly rather than quietly, which is the right direction to be wrong in.
   */
  const scan = (source: string): { strings: string[]; code: string } => {
    const strings: string[] = [];
    let code = "";
    let i = 0;
    while (i < source.length) {
      const c = source[i];
      const next = source[i + 1];
      if (c === "/" && next === "/") {
        while (i < source.length && source[i] !== "\n") i += 1;
        continue;
      }
      if (c === "/" && next === "*") {
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        let value = "";
        while (j < source.length && source[j] !== c) {
          if (source[j] === "\\") {
            value += source[j + 1] ?? "";
            j += 2;
            continue;
          }
          value += source[j];
          j += 1;
        }
        strings.push(value);
        // A space, so removing the literal cannot weld two identifiers into one word.
        code += " ";
        i = j + 1;
        continue;
      }
      code += c;
      i += 1;
    }
    return { strings, code };
  };

  for (const [label, source] of [
    ["the capture component", capture],
    ["the API route", route],
  ] as const) {
    const { strings: allStrings, code } = scan(source);
    // Import specifiers are machinery: "@/lib/ai/openai-client" is never shown to anyone, and
    // flagging it would train the next person to weaken the banned-word list rather than trust it.
    const importSpecifiers = new Set(
      [...source.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]),
    );
    const strings = allStrings.filter((s) => !importSpecifiers.has(s));
    // JSX text lives between tags, not in a literal, so it comes from the comment-free code.
    const jsxText = [...code.matchAll(/>\s*([A-Za-z][^<>{}]{8,})\s*</g)].map((m) => m[1]);
    for (const text of [...strings, ...jsxText]) {
      // className strings are not prose and legitimately contain no banned words anyway; skip the
      // Tailwind soup so a class like "text-slate-900" cannot trip a substring rule later.
      if (/^[a-z0-9:\-\[\]#/. ]+$/.test(text)) continue;
      // A module path or URL is never shown to a user. Narrow and explicit, so real prose that
      // merely starts with a symbol is still swept.
      if (/^[@.]{1,2}\//.test(text) || /^https?:\/\//.test(text)) continue;
      assert.doesNotMatch(
        text,
        bannedWord,
        `D4 VIOLATION — ${label} shows the user "${text}". The reader must present as Phoenix itself: no AI label, no model name, no confidence score, anywhere a user can see (standing owner rule, 2026-08-04)`,
      );
    }
  }
  // Comments are excluded on purpose: the comment in invoice-capture.tsx that STATES this rule
  // ("no sparkle icon") would otherwise trip it. A check that fires on its own documentation
  // teaches the next person to delete the documentation.
  const captureScan = scan(capture);
  assert.doesNotMatch(
    [...captureScan.strings, captureScan.code].join("\n"),
    /✨|🤖|sparkle/i,
    "NO SPARKLE OR ROBOT ICONOGRAPHY — spec D4. The feature presents as Phoenix being smart, never as a machine being consulted.",
  );

  // ── The reader runs server-side only ─────────────────────────────────────────────────────
  assert.doesNotMatch(
    capture,
    /openai|api\.openai\.com|OPENAI_API_KEY/i,
    "THE MODEL MUST NEVER BE CALLED FROM THE BROWSER: spec D4 requires that nothing client-side betrays one, and a browser call would also expose the key",
  );
  assert.match(
    capture,
    /fetch\("\/api\/direct-orders\/invoice-extract"/,
    "the component must go through our own route, which is where the permission check lives",
  );

  // ── An outage must not read as a bad photo ───────────────────────────────────────────────
  assert.match(
    route,
    /error instanceof PhoenixOpenAiError[\s\S]{0,400}?status: 503/,
    "AN UPSTREAM FAILURE MUST NOT BE DRESSED UP AS A BAD INVOICE: otherwise the rep retakes a perfectly good photo five times to fix an outage on our side",
  );
  assert.match(route, /assertSameOriginMutation/, "the route must carry CSRF like every other POST here");

  // ── Reachability: BOTH forms, or the people holding invoices cannot use it ────────────────
  for (const [label, rel] of [
    ["the admin submit form", ADMIN_FORM],
    ["the PORTAL submit form", PORTAL_FORM],
  ] as const) {
    const form = read(rel);
    assert.match(
      form,
      /<InvoiceCapture/,
      `INVOICE PREFILL IS UNREACHABLE FROM ${label}: every medical rep and district manager is redirected into the portal, so a capture mounted on only one form is a feature the people holding the invoices cannot use — exactly what happened to the pharmacy-validation capture (11 held orders, 509,736 EGP, zero validation requests)`,
    );
    assert.match(
      form,
      /onApply=\{\(payload\) => \{[\s\S]{0,400}?setProductCode\(payload\.productCode\)/,
      `${label} must actually apply what was read, not just render the control`,
    );
  }

  // ── The route is declared, or the access-registry gate fails CI ──────────────────────────
  assert.match(
    read("../src/lib/security/access-registry.ts"),
    /pattern: "\/api\/direct-orders\/invoice-extract"/,
    "every app/api route must be declared in the access registry",
  );

  // ── Two ways in: the camera, or a photo they already have ─────────────────────────────────
  // One input carrying `capture="environment"` opens the camera on most phones and never offers
  // the gallery. A rep whose invoice arrived on WhatsApp — which is how a great many of them
  // arrive — had no route at all. The fix is two inputs, because that single attribute IS the
  // difference and toggling it before a click is unreliable across mobile browsers.
  {
    const capture = read(CAPTURE);
    assert.match(capture, /ref=\{cameraRef\}/, "the camera route must exist");
    assert.match(capture, /ref=\{uploadRef\}/, "the upload route must exist");

    // The camera input carries `capture`; the upload input must NOT.
    const inputs = [...capture.matchAll(/<input\b[\s\S]*?\/>/g)].map((m) => m[0]);
    const cameraInput = inputs.find((tag) => tag.includes("cameraRef"));
    const uploadInput = inputs.find((tag) => tag.includes("uploadRef"));
    assert.ok(cameraInput && uploadInput, "both file inputs must be present");
    assert.match(cameraInput!, /capture="environment"/, "the camera route must ask for the rear lens");
    assert.ok(
      !/capture=/.test(uploadInput!),
      "THE UPLOAD ROUTE MUST NOT CARRY `capture`: that one attribute makes a phone open the camera " +
        "and never offer the files, which is exactly the dead end this second button exists to remove",
    );

    assert.match(
      capture,
      /void read\(file, "camera"\)/,
      "the camera route must record itself as the camera",
    );
    assert.match(capture, /void read\(file, "upload"\)/, "the upload route must record itself as an upload");
    assert.match(
      capture,
      /Choose a photo/,
      "the second route needs a visible button — an input nobody can reach is not a route",
    );
  }

  // ── The source is recorded, and never used to refuse ──────────────────────────────────────
  {
    const extractor = read(EXTRACTOR);
    assert.match(
      extractor,
      /source: input\.source \?\? "upload"/,
      "which route was used must reach the outcome record, or 'do forwarded photos read worse' cannot be answered",
    );
    assert.ok(
      !/input\.source === "upload"[\s\S]{0,200}(throw|badRequest|return null)/.test(extractor),
      "THE SOURCE MUST NEVER GATE THE READ: a rep whose invoice arrived on WhatsApp has no camera " +
        "shot to offer, and refusing them sends them back to typing codes by hand",
    );
    const route = read(ROUTE);
    assert.match(
      route,
      /body\.source === "camera" \? "camera" : "upload"/,
      "the source must be normalised at the boundary, not trusted from the client — it lands in an audit row",
    );
  }

  // ── A misread number must be CORRECTABLE, not a reason to start over ──────────────────────
  // The reading was accept-as-printed or nothing. A quantity that came back 240 against a printed
  // 249 therefore sent the submitter to type the entire order by hand — and hand-typing codes is
  // the behaviour this whole feature exists to remove. Refusing a one-digit correction was quietly
  // reinstating it, so the numbers are inputs seeded from the reading.
  {
    const capture = read(CAPTURE);
    assert.match(
      capture,
      /onChange=\{\(event\) => setField\(index, "qty", event\.target\.value, line\.read\)\}/,
      "THE QUANTITY MUST BE CORRECTABLE: accept-as-printed or nothing sends a submitter with one wrong digit back to typing the whole order by hand, which is the behaviour invoice prefill exists to remove",
    );
    assert.match(
      capture,
      /onChange=\{\(event\) => setField\(index, "bonus", event\.target\.value, line\.read\)\}/,
      "the bonus must be correctable for the same reason as the quantity",
    );
    assert.match(
      capture,
      /placeholder=\{line\.read\.qty == null \? "not read — type it" : undefined\}/,
      "a quantity that did not read must be TYPEABLE, not a dead line: the product matched, so only one number is missing and the rest of the reading is still worth having",
    );
    assert.match(
      capture,
      /setAppliedIndex\(\(current\) => \(current === index \? null : current\)\)/,
      "EDITING MUST UN-USE THE LINE: the form still holds the old numbers, and a button still reading 'Used' would tell the submitter their correction had been applied when it had not",
    );
  }

  // ── The product stays un-editable — the rule that predates all of this ────────────────────
  // Making the numbers editable must not quietly extend to the identity of the thing being
  // ordered. A line the master database could not confirm still has no button; that is what stops
  // a code nobody has checked from entering at speed.
  {
    const capture = read(CAPTURE);
    assert.match(
      capture,
      /\{line\.product \? \(\s*<button/,
      "AN UNCONFIRMED PRODUCT MUST STILL HAVE NO BUTTON: editable quantities must not become an editable product code — the master database confirming the line is the gate this module was built around",
    );
    assert.ok(
      !/setField\(index, "productCode"/.test(capture),
      "the product code must never become a free-text field: that is the exact hole the pharmacy combo box was built to close",
    );
  }

  // ── A thin reading advises a retake; it never blocks ──────────────────────────────────────
  // Same rule as AREA_PROXIMITY_FLAG_KM in the validation service: a hard gate rejects real work
  // and produces the "the new system blocked everything" complaint the design exists to avoid. A
  // rep in a dim pharmacy with a creased invoice must still be able to file the order by hand.
  {
    const capture = read(CAPTURE);
    assert.match(
      capture,
      /Retake the photo/,
      "a thin reading must offer a retake while the submitter is still standing in front of the invoice — ten seconds there against an approval cycle later",
    );
    assert.match(
      capture,
      /nothing here stops you submitting/,
      "THE RETAKE MUST NEVER BE A GATE: refusing the submission would send the rep back to typing codes by hand, which is what created the false pharmacies",
    );
    assert.ok(
      !/disabled=\{!result\b/.test(capture) && !/return null;[\s\S]{0,80}could not be read/i.test(capture),
      "no branch may make submission conditional on a successful reading",
    );
  }

  // ── The reading records how well it went, and can never fail because of it ────────────────
  // Whether to preprocess the photograph before reading it costs a multi-megabyte library on the
  // phone of a rep paying for mobile data. That decision needs counts, not an impression.
  {
    const extractor = read(EXTRACTOR);
    // ONE capture drives both checks. Written as two independent assertions first, which made the
    // second unreachable: `writeRequiredAuditLog` does not contain the substring `writeAuditLog`,
    // so swapping to the unforgiving write tripped the "must record its outcome" assertion instead
    // and the forgiving-write rule never ran. Capturing the function NAME beside the payload is
    // what makes the swap fire the assertion that is actually about it.
    const outcome = /await (write\w*AuditLog)\(\{[\s\S]{0,500}?codeRead/.exec(extractor);
    assert.ok(
      outcome,
      "the reading must record its own outcome, or the question 'is the photograph the bottleneck' can only be answered by opinion",
    );
    assert.equal(
      outcome[1],
      "writeAuditLog",
      "THE OUTCOME RECORD MUST USE THE FORGIVING AUDIT WRITE: writeRequiredAuditLog re-throws, which would make a measurement the reason a rep standing in a pharmacy cannot read their invoice — the tail wagging the dog",
    );
  }

  // ── The customer code is anchored on its printed label, not on "a long number" ─────────────
  // The owner's real PharmaOverseas page carries at least five long numbers and only one is the
  // pharmacy: the barcode, the account number beside اسم الحساب, كود العميل, the location code
  // الكود المكاني, and the sales order number رقم أمر البيع. A plausible WRONG one is the most
  // damaging thing this reader can produce — it resolves against master data as some other real
  // pharmacy, and the order is filed against a customer who never placed it. A null is recoverable;
  // a confident mismatch is not.
  {
    const extractor = read(EXTRACTOR);
    // Scoped to the RULE STRING, not the file. Checked file-wide first, which was worthless: the
    // comment above the constant documents the same five Arabic labels, so deleting the anchor from
    // the instruction actually sent to the reader left the comment behind and every assertion
    // stayed green. A test that a comment can satisfy is not a test of the instruction.
    const rule = /const CUSTOMER_CODE_RULE =([\s\S]*?);\n/.exec(extractor);
    assert.ok(rule, "CUSTOMER_CODE_RULE must remain a single named constant, so it can be asserted on and reused by both passes");
    const ruleText = rule[1];

    assert.match(
      ruleText,
      /كود الحساب/,
      "THE RULE MUST NAME THE LABEL THAT IS ACTUALLY PRINTED: four real PharmaOverseas invoices read كود الحساب, not كود العميل — an earlier version named the wrong one and told the reader to return null without it, which is worse than the vague instruction it replaced",
    );
    assert.match(
      ruleText,
      /ACCOUNT NUMBER/,
      "the rule must describe the FIELD, not just a label: the Ibnsina invoice carries neither Arabic label, so a label-only definition cannot generalise past one distributor",
    );
    assert.match(
      ruleText,
      /report the WHOLE printed value/,
      "A PAIR MUST BE REPORTED WHOLE: the field is often '812702 / 1573334', and a reader that picks a half looks certain while being wrong half the time — choosing belongs in codeCandidates, where a unique-match rule can arbitrate",
    );
    for (const decoy of ["الكود المكاني", "رقم أمر البيع"]) {
      assert.ok(
        ruleText.includes(decoy),
        `the decoy ${decoy} must be named and refused IN THE INSTRUCTION — naming the field identifies the number, naming the wrong ones is what makes them rejectable`,
      );
    }
    // Fragment chosen to sit inside ONE string literal. The full sentence spans a `" +` line break,
    // so matching it against source text fails on formatting rather than on meaning.
    assert.match(
      ruleText,
      /do NOT substitute another number/,
      "a missing code must return null rather than the nearest long number: a wrong code is worse than no code, because it will be treated as a real pharmacy",
    );
    // Both passes must carry the same rule, or the rescue could accept a number the first pass
    // was told to refuse — and the rescue is the one running on the worst photographs.
    for (const constant of ["INSTRUCTIONS", "HEADER_ONLY_INSTRUCTIONS"]) {
      const body = new RegExp(`const ${constant} =([\\s\\S]*?);\\n`).exec(extractor);
      assert.ok(body, `${constant} must remain a named constant`);
      assert.match(
        body[1],
        /CUSTOMER_CODE_RULE/,
        `${constant} must include CUSTOMER_CODE_RULE: if the rescue pass does not carry the same rule, it can accept on the worst photographs a number the first pass was told to refuse`,
      );
    }
  }

  // ── The printed code must reach its pharmacy: padding, and pairs ──────────────────────────
  // Measured in production on 2026-08-06: SIX invoice reads, six codes read off the paper,
  // ZERO resolved. The reader was never the problem — matching was, for two reasons, and every
  // case below is a real invoice the owner photographed.
  //
  //   PADDING  `source_of_sales_customer_map` stores PharmaOverseas (PS) codes zero-padded to ten
  //            digits — 28,576 of 28,577 rows. The paper prints 1573270; the map holds 0001573270.
  //   PAIRS    The header prints "812702 / 1573334". Across five invoices the LEFT half matched
  //            nothing and the RIGHT half matched exactly one pharmacy, every time.
  {
    // Every one of these is a real header, with the code that is actually in master data.
    const invoices: Array<{ printed: string; inMasterData: string; pharmacy: string }> = [
      { printed: "812702 / 1573334", inMasterData: "0001573334", pharmacy: "لمياء * عمرو هريدي" },
      { printed: "850254 / 1558852", inMasterData: "0001558852", pharmacy: "ابتسام بلال كفر البطيخ" },
      { printed: "802714 / 1504289", inMasterData: "0001504289", pharmacy: "الشريف - مغاغه" },
      { printed: "836397 / 1556836", inMasterData: "0001556836", pharmacy: "السيد ابوالفتوح ج كفر شكر" },
      { printed: "1573270", inMasterData: "0001573270", pharmacy: "محمود احمد صالح الجديدة" },
    ];
    for (const invoice of invoices) {
      const candidates = codeCandidates(invoice.printed);
      const unpadded = invoice.inMasterData.replace(/^0+(?=\d)/, "");
      assert.ok(
        candidates.includes(unpadded),
        `"${invoice.printed}" must produce the candidate ${unpadded} so it can reach ${invoice.pharmacy} ` +
          `(stored as ${invoice.inMasterData}). Got: ${candidates.join(", ")}`,
      );
    }
  }

  // The printed form is tried FIRST, so a genuine exact hit can never be displaced by a looser
  // reading of the same string.
  {
    assert.equal(
      codeCandidates("0001573270")[0],
      "0001573270",
      "the code exactly as printed must be the first candidate — a looser form must never outrank an exact one",
    );
    // Padding travels BOTH ways. The five real invoices all print the short form against a padded
    // master record, and the split loop happens to cover those — so this direction (a padded code
    // printed on the paper, a short one in master data) was left unasserted, and the line that
    // implements it could be deleted with the suite still green. Caught by prove-it-fails.
    assert.ok(
      codeCandidates("0001573270").includes("1573270"),
      "a code printed WITH padding must also be tried without it — padding differs between the paper and master data in both directions, and only one of them is covered by splitting a pair",
    );
    assert.deepEqual(codeCandidates(""), [], "an empty code must produce no candidates rather than one empty query");
    // The invariant is that no candidate is EMPTY — an empty query is a substring of every code in
    // the directory. ("000" legitimately yields "0" as well; the search refuses anything under two
    // characters, and the uniqueness rule refuses the rest.)
    for (const probe of ["000", "0", "812702 / 1573334", "  0001573270  ", "//", "0-0"]) {
      const candidates = codeCandidates(probe);
      assert.ok(
        candidates.every((candidate) => candidate.length > 0),
        `no candidate may be the empty string — it is a substring of every code in the directory. "${probe}" gave: ${JSON.stringify(candidates)}`,
      );
      assert.equal(
        new Set(candidates).size,
        candidates.length,
        `candidates must be unique — a repeated form is a wasted directory query. "${probe}" gave: ${JSON.stringify(candidates)}`,
      );
    }
  }

  // ── An ambiguous code REFUSES rather than guessing ────────────────────────────────────────
  // 89 codes in the live customer map become ambiguous once leading zeros are stripped. Taking the
  // first close-looking row would file an order against the wrong REAL pharmacy — the exact failure
  // this module exists to stop, arriving with better handwriting.
  {
    const extractor = read(EXTRACTOR);
    assert.match(
      extractor,
      /if \(matches\.length > 1\) \{/,
      "AN AMBIGUOUS CODE MUST REFUSE: 89 codes collide once leading zeros are stripped, and picking one would file the order against the wrong real pharmacy",
    );
    assert.match(
      extractor,
      /matches more than one pharmacy in the master/,
      "the refusal must say WHY in words the submitter can act on, not fall back to the generic not-found sentence",
    );
    assert.match(
      extractor,
      /for \(const candidate of codeCandidates\(read\.customerCode\)\) \{[\s\S]{0,300}?await searchDirectOrderPharmacyDirectory/,
      "EACH CANDIDATE MUST BE SEARCHED, NOT JUST FILTERED: the directory search is a substring match, so a printed pair queries for the whole string, matches nothing, and leaves nothing to filter — the pair only resolves if its halves are searched in their own right",
    );
  }

  // ── The retry is bounded, conditional, and cannot turn a read into an error ────────────────
  {
    const extractor = read(EXTRACTOR);
    assert.match(
      extractor,
      /if \(text\(parsed\.customer_code\) == null\) \{/,
      "THE SECOND PASS MUST FIRE ONLY ON A MISS: running it every time doubles the wait for every rep to rescue the minority of photographs that needed it",
    );
    assert.ok(
      !/while\s*\(|for\s*\([^)]*retr/i.test(extractor),
      "THE RETRY MUST RUN EXACTLY ONCE: a loop turns a dark photograph into a stack of identical calls and a rep watching a spinner",
    );
    const retryBlock = extractor.slice(extractor.indexOf("if (text(parsed.customer_code) == null)"));
    assert.match(
      retryBlock.slice(0, 1400),
      /\} catch \{/,
      "A FAILED RESCUE MUST BE SWALLOWED: the first read is still worth returning, and an attempt to improve it must never be the reason an otherwise usable read becomes an error the submitter sees",
    );
    assert.match(
      extractor,
      /retried,\s*\n\s*rescuedByRetry,/,
      "the retry must record whether it actually rescued anything — an extra call per miss is only justified if it recovers codes, and that is a number, not an opinion",
    );
    for (const field of ["codeRead", "codeResolved", "linesRead", "linesMatched"]) {
      assert.ok(
        extractor.includes(`${field}:`),
        `the outcome must record ${field} — read-rate and match-rate are the two numbers that decide whether preprocessing is worth its bundle`,
      );
    }
  }
}
