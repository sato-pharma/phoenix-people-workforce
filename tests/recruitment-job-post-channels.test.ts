import assert from "node:assert/strict";

import {
  CHANNEL_CODE_PREFIX,
  deriveChannelCode,
  extractChannelCode,
  isValidChannelCode,
  normalizeChannelCode,
} from "../src/lib/recruitment/outreach/channel-code.ts";
import { nameFromGroupUrl, parseChannelPasteList } from "../src/lib/recruitment/outreach/channel-import.ts";
import {
  buildApplyLink,
  buildApplyMessage,
  composeJobAdvert,
  normalizeWhatsAppNumber,
  renderAdvertForChannel,
} from "../src/lib/recruitment/outreach/job-advert.ts";

/**
 * Advertising channels — which Facebook group actually produced each CV.
 *
 * The whole feature is one loop: a code goes OUT inside an apply link, the applicant sends it back
 * inside their own first message, and intake reads it off. Two independent halves that have to
 * agree on one string. Section 4 closes that loop explicitly, because every other assertion here
 * would still pass if the builder and the extractor quietly disagreed about the format.
 *
 * Context for the strictness in section 2: the extractor runs over free text an applicant typed —
 * a greeting, a covering note, an email subject. A loose pattern would attribute CVs to groups
 * that never produced them, and a wrong attribution is worse than none: it is the number the owner
 * would use to decide which groups to stop posting in.
 */
export async function runRecruitmentJobPostChannelTests() {
  // ── 1 · Deriving a code from a group name ───────────────────────────────────
  assert.equal(deriveChannelCode("Medical Reps Egypt"), "PX-MRE", "multi-word names become initials");
  assert.equal(deriveChannelCode("Pharmacists"), "PX-PHARMACIST", "a single word is truncated to the 10-char body");
  assert.equal(
    deriveChannelCode("Pharma Jobs - Cairo"),
    "PX-PJC",
    "punctuation is a word separator, not a letter",
  );

  // An Arabic-named group yields no ASCII initials at all. It still needs a handle, so it falls
  // back to a sequence rather than producing an empty or invalid code.
  const arabic = deriveChannelCode("مجموعة الصيادلة");
  assert.equal(arabic, "PX-CH", "a name with no ASCII falls back rather than producing an empty code");
  assert.ok(isValidChannelCode(arabic), "the fallback is still a valid code");

  // Two groups genuinely can share initials — that is a suffix, not an error.
  assert.equal(deriveChannelCode("Medical Reps Egypt", ["PX-MRE"]), "PX-MRE2");
  assert.equal(deriveChannelCode("Medical Reps Egypt", ["PX-MRE", "PX-MRE2"]), "PX-MRE3");

  // The suffix eats into the BODY, never the prefix, so a long name plus a suffix stays valid.
  const crowded = deriveChannelCode("Pharmacists", ["PX-PHARMACIST"]);
  assert.ok(isValidChannelCode(crowded), `a suffixed long name stays valid (got ${crowded})`);

  // ── 2 · Reading a code back out of what the applicant actually sent ─────────
  assert.equal(
    extractChannelCode(["Hello, I would like to apply for Medical Representative (Giza). Ref: PX-MRE"]),
    "PX-MRE",
    "the code is found inside the pre-filled message we generated",
  );
  assert.equal(extractChannelCode(["ref: px-mre"]), "PX-MRE", "applicants retype in lower case");
  assert.equal(extractChannelCode(["[PX-MRE]"]), "PX-MRE", "bracketed form still reads");

  // Oldest-first: the covering message wins over anything quoted later in the thread.
  assert.equal(
    extractChannelCode(["Ref: PX-MRE", "resending, Ref: PX-PJC"]),
    "PX-MRE",
    "the first message wins, not the last",
  );

  // The refusals. Each of these is a CV that must stay unattributed rather than land on a group
  // that never produced it.
  assert.equal(extractChannelCode(["XPX-MRE"]), null, "a code glued to the end of a word is not a code");
  assert.equal(
    extractChannelCode(["PX-ABCDEFGHIJK"]),
    null,
    "an over-long token is rejected outright, never truncated to a real code",
  );
  assert.equal(extractChannelCode(["I studied at PX and worked at Pharco"]), null, "a bare PX is not a code");
  assert.equal(extractChannelCode([null, undefined, ""]), null, "empty input is not an error");
  assert.equal(extractChannelCode([]), null, "no messages means no code");

  assert.equal(isValidChannelCode("PX-M"), false, "a one-character body is too short to survive a retype");
  assert.equal(isValidChannelCode("MRE"), false, "the prefix is what makes the pattern safe — it is required");
  assert.equal(normalizeChannelCode("  px-mre  "), "PX-MRE", "codes normalise to upper case");
  assert.equal(CHANNEL_CODE_PREFIX, "PX-");

  // ── 3 · Apply links ────────────────────────────────────────────────────────
  // All three ways an Egyptian mobile gets written have to reach the same chat.
  assert.equal(normalizeWhatsAppNumber("+20 100 123 4567"), "201001234567");
  assert.equal(normalizeWhatsAppNumber("0020 100 123 4567"), "201001234567");
  assert.equal(normalizeWhatsAppNumber("01001234567"), "201001234567", "a bare local mobile is assumed Egyptian");
  assert.equal(normalizeWhatsAppNumber("123"), null, "too short to be a phone number");
  assert.equal(normalizeWhatsAppNumber(""), null);

  const waLink = buildApplyLink({
    code: "PX-MRE",
    destination: "+20 100 123 4567",
    jobTitle: "Medical Representative",
    kind: "whatsapp",
    location: "Giza",
  });
  assert.ok(waLink?.startsWith("https://wa.me/201001234567?text="), `wa.me link shape (got ${waLink})`);

  const mailLink = buildApplyLink({
    code: "PX-MRE",
    destination: "careers@example.com",
    jobTitle: "Medical Representative",
    kind: "email",
  });
  assert.ok(mailLink?.startsWith("mailto:careers@example.com?subject="), `mailto shape (got ${mailLink})`);

  // A broken link costs a real applicant, so these return null rather than something plausible.
  assert.equal(
    buildApplyLink({ code: "nonsense", destination: "+20 100 123 4567", jobTitle: "X", kind: "whatsapp" }),
    null,
    "an invalid code produces no link",
  );
  assert.equal(
    buildApplyLink({ code: "PX-MRE", destination: "not-an-email", jobTitle: "X", kind: "email" }),
    null,
    "a malformed address produces no link",
  );

  // ── 4 · The round trip — the invariant the whole feature rests on ──────────
  //
  // Build a link the way the composer does, pull the pre-filled text back out the way WhatsApp
  // hands it to the applicant, and read the code the way intake does. If these two halves ever
  // disagree about the format, every advert keeps working and every CV silently loses its source.
  for (const code of ["PX-MRE", "PX-CH", "PX-PHARMACIST", "PX-MRE2"]) {
    const link = buildApplyLink({
      code,
      destination: "01001234567",
      jobTitle: "Medical Representative",
      kind: "whatsapp",
      location: "Giza",
    });
    assert.ok(link, `a valid code must produce a link (${code})`);
    const prefilled = new URL(link).searchParams.get("text");
    assert.ok(prefilled, `the link carries a pre-filled message (${code})`);
    assert.equal(
      extractChannelCode([prefilled]),
      code,
      `round trip: what the composer wrote is what intake reads back (${code})`,
    );
  }

  // The message reads like something a person would send — that is why they do not delete it.
  assert.equal(
    buildApplyMessage({ code: "PX-MRE", jobTitle: "Medical Representative", location: "Giza" }),
    "Hello, I would like to apply for Medical Representative (Giza). Ref: PX-MRE",
  );

  // ── 5 · The advert body ────────────────────────────────────────────────────
  const advert = composeJobAdvert({
    bulletPoints: ["2+ years in pharmaceutical sales", "Own car preferred"],
    companyName: "Sato Pharma",
    jobTitle: "Medical Representative",
    location: "Giza",
  });
  assert.ok(advert.includes("Sato Pharma is hiring: Medical Representative"));
  assert.ok(advert.includes("Location: Giza"));
  assert.ok(advert.includes("- 2+ years in pharmaceutical sales"));
  // Neither salary nor eligibility wording is templated in — both are the recruiter's call, not
  // something a default should put in front of the public on his behalf.
  assert.ok(!/salary|EGP|nationa/i.test(advert), "the default advert states no salary and no eligibility rule");

  assert.equal(
    renderAdvertForChannel("Body text\n", "https://wa.me/201001234567?text=hi"),
    "Body text\nhttps://wa.me/201001234567?text=hi",
  );
  assert.equal(renderAdvertForChannel("Body text", null), "Body text", "no link means no dangling blank line");

  // ── 6 · Parsing a pasted list of groups ────────────────────────────────────
  const parsed = parseChannelPasteList(
    [
      "# my groups",
      "",
      "Medical Reps Egypt | https://facebook.com/groups/medical.reps.egypt",
      "https://facebook.com/groups/123456789",
      "https://www.facebook.com/groups/pharma-jobs-cairo",
      "Referrals from staff",
      "Medical Reps Egypt | https://facebook.com/groups/duplicate",
    ].join("\n"),
  );
  assert.equal(parsed.length, 4, `four usable rows (got ${JSON.stringify(parsed)})`);
  assert.deepEqual(parsed[0], {
    name: "Medical Reps Egypt",
    url: "https://facebook.com/groups/medical.reps.egypt",
  });
  assert.equal(parsed[1].name, "Facebook group 123456789", "a numeric group id gets a renameable placeholder");
  assert.equal(parsed[2].name, "Pharma Jobs Cairo", "a vanity slug becomes a readable name");
  assert.deepEqual(parsed[3], { name: "Referrals from staff", url: null }, "a name with no URL is still a channel");

  assert.equal(nameFromGroupUrl("https://facebook.com/groups/123"), "Facebook group 123");
  assert.equal(nameFromGroupUrl("https://example.com/not-a-group"), null);
  assert.equal(parseChannelPasteList("").length, 0, "an empty paste is not an error");

  // Tab-separated, because that is what a copy out of a spreadsheet produces.
  const tabbed = parseChannelPasteList("Pharma Jobs\thttps://facebook.com/groups/999");
  assert.deepEqual(tabbed, [{ name: "Pharma Jobs", url: "https://facebook.com/groups/999" }]);
}
