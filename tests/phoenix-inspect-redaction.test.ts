import assert from "node:assert/strict";

import { sanitizeUrlForLog } from "../scripts/phoenix-inspect/lib/fence.mjs";
import {
  SAFE_WORDS,
  buildKeepIndex,
  extractSourceLiterals,
  findAriaLeaks,
  findSensitivePatterns,
  isMaskedShape,
  maskDocument,
  maskString,
  maskerHelpers,
  pageCall,
  sanitizeAriaSnapshot,
  sourceCandidatesFor,
  verifyDocument,
} from "../scripts/phoenix-inspect/lib/redact.mjs";

/**
 * Phoenix Visual Intelligence: the explorer masks every visible string except literals from reviewed
 * source, character for character, and a second pass refuses any shot that still carries unmasked
 * text. These pin the character rules (names, HR ids, phones, emails, national ids, Arabic, digits),
 * the keep list, the post-mask check, and that the copy sent into the page is the tested code.
 */
export function runPhoenixInspectRedactionTests() {
  const keep = new Set(["Call Rate", "Coverage", "Showing", "medical reps in your reach"]);
  const safe = new Set(SAFE_WORDS);

  // Data is masked with its shape kept.
  assert.equal(maskString("Sammy Example", keep, safe), "Xxxxx Xxxxxxx", "a name keeps its length and capitals");
  assert.equal(maskString("Z-9043", keep, safe), "X-0000", "an HR id");
  assert.equal(maskString("01012345678", keep, safe), "00000000000", "a phone number");
  assert.equal(maskString("sammy.e@example.com", keep, safe), "xxxxx.x@xxxxxxx.xxx", "an email");
  assert.equal(maskString("29913990000000", keep, safe), "00000000000000", "a national id");
  assert.equal(maskString("12,450 EGP", keep, safe), "00,000 XXX", "a salary-like amount");
  assert.equal(maskString("أحمد مصطفى", keep, safe), "ــــ ـــــ", "Arabic letters become tatweels");
  assert.equal(maskString("٢٠٢٦", keep, safe), "0000", "Arabic-Indic digits become 0");
  assert.equal(maskString("87.5%", keep, safe), "00.0%", "punctuation and symbols stay");
  assert.equal(maskString("Zoë", keep, safe), "Xxx", "other Latin letters are masked too");
  assert.equal(maskString("  ", keep, safe), "  ", "whitespace is left alone");

  // Kept: whole literals from source, and calendar words; nothing else.
  assert.equal(maskString("Call Rate", keep, safe), "Call Rate");
  assert.equal(maskString("  Coverage ", keep, safe), "  Coverage ", "a kept literal survives surrounding whitespace");
  assert.equal(maskString("Call Rate of Sammy", keep, safe), "Xxxx Xxxx xx Xxxxx", "a literal inside other text is not kept");
  assert.equal(maskString("August 2026", keep, safe), "August 0000", "a month name is kept, the year masked");
  assert.equal(maskString("May Hassan", keep, safe), "Xxx Xxxxxx", "May is a first name too, so it is never a kept calendar word");
  assert.ok(!SAFE_WORDS.includes("May"));

  // The post-mask shape check.
  assert.equal(isMaskedShape("Xxxxx Xxxxxxx · 00.0%", safe), true);
  assert.equal(isMaskedShape("August 0000", safe), true);
  assert.equal(isMaskedShape("ــــ 00", safe), true);
  assert.equal(isMaskedShape("Xxxxx Sammy", safe), false, "one unmasked word fails the check");
  assert.equal(isMaskedShape("00 7", safe), false, "one unmasked digit fails the check");
  assert.equal(isMaskedShape("أ", safe), false, "Arabic text fails the check");

  // Patterns searched in KEPT text.
  assert.deepEqual(findSensitivePatterns("Calls per working day"), []);
  assert.ok(findSensitivePatterns("write to hr@example.com").includes("email"));

  // The accessibility snapshot's link addresses: ids masked, query values dropped, other origins withheld.
  const origin = "https://phoenix-people-workforce-staging.up.railway.app";
  const aria = [
    '- link "xxxxx xxxxx":',
    "  - /url: /admin/kpis/call-rate/Z-9043?month=2026-08&rep=Z-9043",
    '- link "Docs":',
    "  - /url: https://example.org/people/Z-9043",
    '- heading "Call Rate" [level=1]',
  ].join("\n");
  const cleaned = sanitizeAriaSnapshot(aria, origin, sanitizeUrlForLog);
  assert.ok(!cleaned.includes("1043") && !cleaned.includes("2026-08"), cleaned);
  assert.ok(cleaned.includes("/admin/kpis/call-rate/:id?month=…&rep=…"), cleaned);
  assert.ok(cleaned.includes("https://example.org/(off-origin path withheld)"), cleaned);
  assert.ok(cleaned.includes('- heading "Call Rate" [level=1]'), "lines without an address are left alone");
  assert.deepEqual(findSensitivePatterns(cleaned), [], "a cleaned snapshot passes the pattern check");
  assert.ok(findSensitivePatterns(aria).includes("hr-id-like"), "the raw snapshot would have failed it");
  // After masking, the shapes of ids, emails and numbers are not leaks; anything still unmasked is.
  const masked = ['- row "X-0000 00000000000":', '  - cell "xxxxx.x@xxxxxxx.xxx"', "  - cell \"+00 000 000 0000\"", '  - textbox "X-0000": Xxxxx', "  - /url: /admin/kpis/call-rate/:id?month=…"].join("\n");
  assert.deepEqual(findAriaLeaks(masked), [], "masked shapes pass");
  assert.deepEqual(findAriaLeaks(`${masked}\n  - cell "Z-9043"`), ["hr-id-like"]);
  assert.deepEqual(findAriaLeaks('- cell "sammy.e@example.com"'), ["email"]);
  assert.deepEqual(findAriaLeaks('- cell "+20 101 234 5678"'), ["egyptian-mobile"]);
  assert.deepEqual(findAriaLeaks('- cell "29913990000000"'), ["national-id", "long-number"]);
  assert.ok(findSensitivePatterns("call 01012345678").includes("egyptian-mobile"));
  assert.ok(findSensitivePatterns("+20 101 234 5678").includes("egyptian-mobile"));
  assert.ok(findSensitivePatterns("id 29913990000000").includes("national-id"));
  assert.ok(findSensitivePatterns("owner B-10").includes("hr-id-like"));
  assert.ok(findSensitivePatterns("ref 1234567").includes("long-number"));
  assert.deepEqual(findSensitivePatterns("A 3, B 2, C 1"), [], "grade rules are not an HR id");

  // Source literals: strings and JSX text, never comments.
  const literals = extractSourceLiterals(`
    // Owner said "Mohamed Ali" should see this
    /* "Secret Name" */
    const label = "Call Rate";
    const hint = 'Calls per working day.';
    const title = \`Coverage band\`;
    const line = \`Week \${n} of the month\`;
    return <p className="x">Showing <span>{visible}</span> of{" "}<span>{total}</span> medical reps in your reach</p>;
  `);
  for (const expected of ["Call Rate", "Calls per working day.", "Coverage band", "Week", "of the month", "Showing", "medical reps in your reach"]) {
    assert.ok(literals.has(expected), `"${expected}" is a source literal`);
  }
  assert.ok(!literals.has("Mohamed Ali"), "a quoted name in a line comment is not kept");
  assert.ok(!literals.has("Secret Name"), "a quoted name in a block comment is not kept");
  assert.ok(![...literals].some((text) => /^\d+$/.test(text)), "a literal must carry a letter");

  // Literals map a shot back to its files.
  const index = buildKeepIndex([
    { file: "a.tsx", source: `const t = "Only In A"; const s = "Shared";` },
    { file: "b.tsx", source: `const s = "Shared"; const u = "Only In B";` },
  ]);
  const candidates = sourceCandidatesFor(["Only In A", "Shared", "Unknown text"], index);
  assert.deepEqual(candidates.map((candidate) => [candidate.file, candidate.confidence]), [["a.tsx", "high"], ["b.tsx", "medium"]]);
  assert.deepEqual(candidates[0].evidence, ["Only In A", "Shared"]);

  // The copy sent into the page is self-contained and behaves exactly like the tested one.
  const serialized = new Function(`return (${maskerHelpers.toString()})`)()();
  for (const sample of ["Sammy Z-9043 01012345678", "أحمد ٢٠٢٦", "Call Rate", "August 2026"]) {
    assert.equal(serialized.maskString(sample, keep, safe), maskString(sample, keep, safe), `the page copy masks "${sample.length} chars" the same way`);
  }
  // Both in-page calls are valid expressions (parsed, not run: they need a document).
  for (const fn of [maskDocument, verifyDocument]) {
    const expression = pageCall(fn, ["Call Rate"], SAFE_WORDS);
    assert.doesNotThrow(() => new Function(`return ${expression};`), `${fn.name} serializes into a valid expression`);
    assert.ok(expression.includes("maskerHelpers"), "the factory travels with the call");
  }
}
