import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseSatoEmailDraft } from "@/lib/sato-email/draft";
import { satoTypedAddressPolicy } from "@/lib/sato-email/typed-policy";
import {
  SATO_EMAIL_MAX_TYPED_ADDRESSES,
  isOutsideCompanyAddress,
  isTypedEmailAddress,
  parseTypedEmailAddresses,
} from "@/lib/sato-email/typed-recipients";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * The Sato Email Composer's "choose people yourself": addresses typed by hand.
 *
 * Owner 2026-09-13: "make an option to manual search and choose single or multiple reciepients and
 * option to manually write emails my self". A typed address is the one recipient nobody vetted, so
 * the pins here are the ones that keep it honest — nothing typed is dropped without a word, nothing
 * that is not a mailbox reaches the provider, and an outside address never goes without a reason.
 */
export function runSatoEmailTypedRecipientsTests() {
  // --- 1. Reading what was typed or pasted -------------------------------------------------------
  assert.deepEqual(
    parseTypedEmailAddresses("A@SatoPharma.com, b@clinic.com;\nc@example.org  a@satopharma.com"),
    { invalid: [], valid: ["a@satopharma.com", "b@clinic.com", "c@example.org"] },
    "commas, semicolons, new lines and spaces all separate; case is folded and a repeat is kept once",
  );
  assert.deepEqual(
    parseTypedEmailAddresses("Omar Gawish <omar@satopharma.com>; Nour Adel <nour@clinic.com>"),
    { invalid: [], valid: ["omar@satopharma.com", "nour@clinic.com"] },
    "an Outlook paste keeps the address inside the angle brackets, not the name in front of it",
  );
  assert.deepEqual(parseTypedEmailAddresses("mailto:hr@satopharma.com").valid, ["hr@satopharma.com"]);

  const bad = parseTypedEmailAddresses("not-an-email, x@phoenix.local, y@local, z@nodot, ok@satopharma.com");
  assert.deepEqual(bad.valid, ["ok@satopharma.com"]);
  assert.deepEqual(
    bad.invalid,
    ["not-an-email", "x@phoenix.local", "y@local", "z@nodot"],
    "what is not a mailbox comes back as typed, so the screen can leave it for the sender to correct",
  );
  assert.equal(isTypedEmailAddress("phx-6f6d6172@auth.phoenix.local"), false, "the login-key identity address is never a mailbox");

  assert.equal(isOutsideCompanyAddress("omar@satopharma.com"), false);
  assert.equal(isOutsideCompanyAddress("omar@eg.satopharma.com"), false);
  assert.equal(isOutsideCompanyAddress("omar@satopharma.com.evil.org"), true, "a look-alike domain is outside");

  // --- 2. The shared draft reader ----------------------------------------------------------------
  const base = { bodyHtml: "<p>Hello</p>", clientRequestId: "sato-typed-1", subject: "Notice" };

  const typedOnly = parseSatoEmailDraft({ ...base, emails: ["Omar@SatoPharma.com", "omar@satopharma.com", "b@clinic.com"] });
  assert.ok("draft" in typedOnly, "a draft addressed only to typed addresses is a real draft");
  assert.deepEqual(typedOnly.draft.emails, ["omar@satopharma.com", "b@clinic.com"]);

  const wrong = parseSatoEmailDraft({ ...base, emails: ["b@clinic.com", "omar at sato"] });
  assert.ok("message" in wrong && wrong.message.includes("omar at sato"), "a bad address refuses the draft and names itself");

  const nobody = parseSatoEmailDraft(base);
  assert.ok("message" in nobody && /email address/.test(nobody.message), "nobody chosen at all is still refused");

  assert.ok("message" in parseSatoEmailDraft({ ...base, emails: "b@clinic.com" }), "emails must be an array");

  const tooMany = Array.from({ length: SATO_EMAIL_MAX_TYPED_ADDRESSES + 1 }, (_, index) => `p${index}@satopharma.com`);
  assert.ok("message" in parseSatoEmailDraft({ ...base, emails: tooMany }), "the typed-address cap holds at the parser");

  const listOnly = parseSatoEmailDraft({ ...base, listKeys: ["all_staff"] });
  assert.ok("draft" in listOnly && listOnly.draft.emails.length === 0, "typed addresses stay optional");

  // --- 3. An outside address never goes without the sender's own reason --------------------------
  const previousDomains = process.env.PHOENIX_HR_EMAIL_ALLOWED_DOMAINS;
  process.env.PHOENIX_HR_EMAIL_ALLOWED_DOMAINS = "satopharma.com";
  try {
    assert.deepEqual(satoTypedAddressPolicy([], null), { outside: [], problem: null });
    assert.deepEqual(satoTypedAddressPolicy(["omar@satopharma.com"], null), { outside: [], problem: null });

    const unexplained = satoTypedAddressPolicy(["omar@satopharma.com", "nour@clinic.com"], null);
    assert.deepEqual(unexplained.outside, ["nour@clinic.com"]);
    assert.ok(unexplained.problem?.includes("nour@clinic.com"), "the refusal names the outside address");

    assert.ok(satoTypedAddressPolicy(["nour@clinic.com"], "too short").problem, "a reason under 10 characters is no reason");
    assert.deepEqual(
      satoTypedAddressPolicy(["nour@clinic.com"], "Clinic partner receiving the rota"),
      { outside: ["nour@clinic.com"], problem: null },
    );
  } finally {
    if (previousDomains === undefined) delete process.env.PHOENIX_HR_EMAIL_ALLOWED_DOMAINS;
    else process.env.PHOENIX_HR_EMAIL_ALLOWED_DOMAINS = previousDomains;
  }

  // --- 4. …and the send checks it BEFORE any mail leaves -----------------------------------------
  // The per-batch policy would only skip the batch holding the address and send the rest. The whole
  // send has to be refused first, so the order inside sendSatoEmail is the assertion.
  const service = readFileSync(path.join(REPO_ROOT, "src/lib/sato-email/service.ts"), "utf8");
  const send = service.slice(service.indexOf("export async function sendSatoEmail("));
  // The CALL alone proves nothing — a verdict computed and then ignored reads identically. The
  // refusal that returns before any mail is what is pinned.
  const refusal =
    /const typed = satoTypedAddressPolicy\(normalized\.emails, normalized\.externalJustification\);\s*if \(typed\.problem\) \{\s*return \{ \.\.\.empty, skippedReason: typed\.problem, status: "failed" \};/.exec(
      send,
    );
  assert.ok(refusal, "sendSatoEmail must judge the typed addresses AND refuse the whole send when they may not go");
  const typedCheck = refusal.index;
  assert.ok(typedCheck < send.indexOf("emailNotificationsEnabled()"), "the typed-address check must run before the send path opens");
  assert.ok(typedCheck < send.indexOf("await sendPhoenixEmail({"), "the typed-address check must run before the first email");
  assert.match(
    service,
    /resolveSatoEmailAudience\(\{\s*emails: normalized\.emails,/,
    "preview and send must both put the typed addresses into the audience they count",
  );
}
