import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CHANNEL_CODE_PREFIX,
  deriveChannelCode,
  extractChannelCode,
  isValidChannelCode,
  normalizeChannelCode,
} from "../src/lib/recruitment/outreach/channel-code.ts";
import {
  kindFromUrl,
  nameFromChannelUrl,
  nameFromGroupUrl,
  parseChannelPasteList,
} from "../src/lib/recruitment/outreach/channel-import.ts";
import {
  applyDestinationForChannel,
  buildApplyLink,
  buildApplyMessage,
  composeJobAdvert,
  normalizeWhatsAppNumber,
  renderAdvertForChannel,
} from "../src/lib/recruitment/outreach/job-advert.ts";
import {
  forwarderMatches,
  phoneDigitsTail,
  resolveForwarderChannelFromList,
} from "../src/lib/recruitment/outreach/forwarder-match.ts";

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
    kind: "facebook_group",
    name: "Medical Reps Egypt",
    url: "https://facebook.com/groups/medical.reps.egypt",
  });
  assert.equal(parsed[1].name, "Facebook group 123456789", "a numeric group id gets a renameable placeholder");
  assert.equal(parsed[2].name, "Pharma Jobs Cairo", "a vanity slug becomes a readable name");
  assert.deepEqual(
    parsed[3],
    { kind: null, name: "Referrals from staff", url: null },
    "a name with no URL is still a channel, and there is nothing to infer a kind from",
  );

  assert.equal(nameFromGroupUrl("https://facebook.com/groups/123"), "Facebook group 123");
  assert.equal(nameFromGroupUrl("https://example.com/not-a-group"), null);
  assert.equal(parseChannelPasteList("").length, 0, "an empty paste is not an error");

  // Tab-separated, because that is what a copy out of a spreadsheet produces.
  const tabbed = parseChannelPasteList("Pharma Jobs\thttps://facebook.com/groups/999");
  assert.deepEqual(tabbed, [{ kind: "facebook_group", name: "Pharma Jobs", url: "https://facebook.com/groups/999" }]);

  // ── 7 · A whole research table, pasted exactly as it arrives ───────────────
  //
  // This is the shape that actually turned up on 2026-08-24: a header row, ten tab-separated
  // columns, three platforms mixed together, and a SECOND URL in the last column holding the page
  // the row was researched from. Two things have to hold or the paste is worse than useless — the
  // header must not become a channel named "Platform", and the FIRST link must win, because
  // attributing a CV to the research source instead of the group it came from is a wrong number,
  // and a wrong number is what gets used to decide which groups to stop posting in.
  const table = parseChannelPasteList(
    [
      "Platform\tGroup / channel\tPublic URL\tActivity\tApprox. members\tRegion\tLanguage\tFocus\tAccess notes\tSource",
      "WhatsApp\tAll Medical Reps – Cairo\thttps://chat.whatsapp.com/EF1I33PPgEF3b9XJ7k4pDG\tRe-shared ~4 months ago\tNot public\tCairo\tArabic / English\tMedical reps\tInvite required\thttps://www.facebook.com/groups/515545825214204/",
      "WhatsApp Channel\tJob Way Medical Recruitment\thttps://whatsapp.com/channel/0029Va5fzfRHFxP9uRFc3Y37\tOfficial site listing\tNot public\tEgypt + Gulf\tArabic / English\tMedical recruitment\tBroadcast\thttps://www.jobway-egy.com/",
      "Telegram\tRecruitmentblogs\thttps://t.me/Recruitmentblogs\tCurrent indexed channel\t~35.2K\tEgypt\tArabic / English\tPharma vacancies\tOpen channel\thttps://t.me/Recruitmentblogs",
      "Facebook\tEgypt Medical Rep vacancies\thttps://www.facebook.com/groups/14921391140/\tIndexed within ~5 days\t~89.1K\tEgypt\tArabic / English\tMedical-rep vacancies\tPublic group\thttps://www.facebook.com/groups/14921391140/",
    ].join("\n"),
  );

  assert.equal(
    table.length,
    4,
    `the header row is dropped and the four channels kept (got ${JSON.stringify(table.map((row) => row.name))})`,
  );
  assert.equal(
    table[0].name,
    "All Medical Reps – Cairo",
    "the name is the column before the link, not the platform column in front of it",
  );
  assert.equal(
    table[0].url,
    "https://chat.whatsapp.com/EF1I33PPgEF3b9XJ7k4pDG",
    "the first link wins — the trailing source column is provenance, not the destination",
  );
  assert.equal(table[0].kind, "whatsapp_group");
  assert.equal(table[1].kind, "whatsapp_channel", "whatsapp.com/channel is a broadcast feed, not a group");
  assert.equal(table[2].kind, "telegram_channel");
  assert.equal(table[3].kind, "facebook_group");

  // Kind inference on its own. The group/channel split is the one that costs real time when wrong:
  // it decides whether the recruiter can paste, or has to ask an admin to carry the advert.
  assert.equal(kindFromUrl("https://t.me/+AbCdEf123"), "telegram_group", "an invite hash is unmistakably a group");
  assert.equal(kindFromUrl("https://t.me/joinchat/AbCdEf"), "telegram_group");
  assert.equal(
    kindFromUrl("https://t.me/Recruitmentblogs"),
    "telegram_channel",
    "a bare handle is reported as a channel — claiming you can post where you cannot is the worse error",
  );
  assert.equal(kindFromUrl("https://www.facebook.com/SatoPharmaEgypt"), "facebook_page");
  assert.equal(kindFromUrl("https://example.com/jobs"), "other");
  assert.equal(kindFromUrl(null), null, "no link means nothing to infer from");

  // A bare link on any platform still earns a row rather than being dropped.
  assert.equal(nameFromChannelUrl("https://t.me/Recruitmentblogs"), "Recruitmentblogs");
  assert.equal(nameFromChannelUrl("https://chat.whatsapp.com/EF1I33PPgEF3b9XJ7k4pDG"), "WhatsApp group EF1I33");
  assert.equal(
    nameFromChannelUrl("https://t.me/+SecretHash99"),
    "Telegram group",
    "a join hash is a secret, not a display name — it must never be printed as one",
  );

  // ── 8 · The code surviving a WhatsApp forward ──────────────────────────────
  //
  // 95% of CVs reach us as a forward from a relay handset, and a forward drops the applicant's
  // separate greeting — the surface the tapped-link code sits on by default. What a forward DOES
  // carry alongside the file is its caption and its filename, so intake reads the code off those
  // too. The caption already arrives folded into coverMessage; the filename is read as its own
  // source, because it is deliberately kept OUT of coverMessage (a raw "Cv.pdf" must never reach
  // the job-matching model as if it were a covering note). The leading boundary is any
  // non-alphanumeric, so a space, dash, underscore or dot in a filename all delimit the code.
  assert.equal(
    extractChannelCode([null, null, "Ahmed Mohamed CV PX-MRE.pdf"]),
    "PX-MRE",
    "the code is read off the CV filename, the one surface a bare forward preserves",
  );
  assert.equal(
    extractChannelCode([null, null, "cv-px-pjc.pdf"]),
    "PX-PJC",
    "a lower-cased code in the filename still reads",
  );
  assert.equal(
    extractChannelCode([null, null, "Ahmed_Mohamed_PX-CH.docx"]),
    "PX-CH",
    "an underscore is a boundary too — the code is not glued to a word",
  );
  assert.equal(
    extractChannelCode(["Ref: PX-PJC", null, "cv-PX-MRE.pdf"]),
    "PX-PJC",
    "a real greeting still wins over the filename — the filename is read LAST",
  );
  assert.equal(
    extractChannelCode([null, null, "Ahmed_Mohamed_Cv.pdf"]),
    null,
    "an ordinary CV filename carries no code and stays unattributed",
  );

  // Source-pin: the invariant above only protects a real forward if intake actually feeds the
  // filename into the extractor. Assert the wiring, not merely that the extractor CAN read a
  // filename — the filename is the one source a reader would forget, because it is held off
  // coverMessage on purpose, so a refactor that "tidied" the extraction call would silently drop it.
  const intakeSource = fs.readFileSync(
    fileURLToPath(new URL("../src/lib/recruitment/inbound/cv-intake-service.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    /extractChannelCode\(\[\s*input\.coverMessage,\s*input\.subject,\s*input\.attachment\?\.fileName\s*\]\)/.test(
      intakeSource,
    ),
    "intake reads the source code off coverMessage, subject AND the attachment filename",
  );

  // ── 9 · Attributing a code-less forward by its relay handset ───────────────
  //
  // A forward with no code on it anywhere still came from somewhere: one of a handful of dedicated
  // relay handsets, each tied to one advert channel. The tail match is what makes that survive the
  // three ways the SAME line reaches us — the +20 Meta reports, a bare 20, and the local 0-prefixed
  // number a human types — so a relay configured in one form still matches a CV that arrives in
  // another. A silently non-matching relay would send every forward down the "no channel" path,
  // which is the exact failure this whole fallback exists to remove, so the tolerance is the point.
  assert.equal(phoneDigitsTail("+201280955558"), "280955558", "the +20 international form yields the subscriber tail");
  assert.equal(phoneDigitsTail("201280955558"), "280955558", "a bare 20 country code collapses to the same tail");
  assert.equal(phoneDigitsTail("01280955558"), "280955558", "the local 0-prefixed form collapses to the same tail");
  assert.equal(phoneDigitsTail("0020 128 095 5558"), "280955558", "spaces and a 00 trunk do not change the tail");
  assert.equal(phoneDigitsTail("12345"), null, "too few digits to be a phone number is no tail, not a wrong one");
  assert.equal(phoneDigitsTail(null), null, "a missing sender is no tail");
  assert.equal(phoneDigitsTail("ahmed@example.com"), null, "an email sender has no phone tail at all");

  assert.equal(
    forwarderMatches(["+201280955558"], "01280955558"),
    true,
    "a relay stored international matches a CV that arrived local — same line",
  );
  assert.equal(
    forwarderMatches(["01280955558", "01159888247"], "+201159888247"),
    true,
    "any identifier in the list can match",
  );
  assert.equal(forwarderMatches(["+201280955558"], "+201159888247"), false, "a different handset does not match");
  assert.equal(forwarderMatches([], "+201280955558"), false, "a channel with no relay matches nothing");
  assert.equal(forwarderMatches(["+201280955558"], null), false, "no sender matches nothing, never the first relay");
  assert.equal(
    forwarderMatches([null, undefined, ""], "+201280955558"),
    false,
    "blank identifiers in the list are skipped, not treated as a wildcard",
  );

  // Resolving against the channel list is what intake actually calls: first channel whose relay owns
  // the sender wins, and a retired channel still attributes — a relay that fed a group months ago
  // keeps its history exactly as a tracking code does.
  const forwarderChannels = [
    { code: "PX-FORWARDED", forwarderIdentifiers: ["+201280955558", "+201159888247"] },
    { code: "PX-MRE", forwarderIdentifiers: ["+201001234567"] },
    { code: "PX-RETIRED", forwarderIdentifiers: ["+201119999999"] },
  ];
  assert.equal(
    resolveForwarderChannelFromList(forwarderChannels, "01280955558"),
    "PX-FORWARDED",
    "a code-less forward resolves to the channel its relay is tied to",
  );
  assert.equal(
    resolveForwarderChannelFromList(forwarderChannels, "+201001234567"),
    "PX-MRE",
    "a relay on a second channel resolves to that channel, not the first",
  );
  assert.equal(
    resolveForwarderChannelFromList(forwarderChannels, "+201230000000"),
    null,
    "a sender on no configured relay resolves to nothing — an unknown forward stays unattributed",
  );
  assert.equal(
    resolveForwarderChannelFromList(forwarderChannels, "careers@example.com"),
    null,
    "a caller with no phone tail is never run through the lookup",
  );

  // Source-pin: the relay fallback only reaches a code-less forward if intake runs it AFTER the
  // on-CV extractor, never before. The on-CV code always wins; the relay only fills the gap. A
  // refactor that resolved the relay unconditionally, or ordered it ahead of the code, would dump
  // ~95% of CVs — everything off the two big relay handsets — onto one channel, the systematically
  // wrong number this design exists to avoid. Assert the precedence in the source, not just that the
  // resolver CAN answer.
  assert.ok(
    /const\s+onCvCode\s*=\s*extractChannelCode\(/.test(intakeSource),
    "intake extracts the on-CV code into onCvCode first",
  );
  assert.ok(
    /onCvCode\s*\?\?\s*\(await\s+resolveForwarderChannelCode\(input\.senderIdentifier\)\)/.test(intakeSource),
    "the relay channel is only ever a ?? fallback behind the on-CV code — never resolved ahead of it",
  );

  // ── 10 · Which apply line a channel's tracked link points at ───────────────
  //
  // The company runs two WhatsApp apply lines. A channel may carry its own number, and its tracked
  // link must send applicants there instead of the one company-wide default — WITHOUT changing that
  // default, which every other channel still funnels to. Get the precedence wrong and either the
  // second line never receives anyone, or worse, every channel is silently repointed onto it and the
  // main line goes quiet. So the resolver is pinned in both directions.
  assert.equal(
    applyDestinationForChannel({
      channelApplyWhatsAppNumber: "01159888247",
      defaultWhatsAppNumber: "01098500699",
      email: "careers@example.com",
      kind: "whatsapp",
    }),
    "01159888247",
    "a channel's own WhatsApp apply number overrides the company default for that channel",
  );
  assert.equal(
    applyDestinationForChannel({
      channelApplyWhatsAppNumber: null,
      defaultWhatsAppNumber: "01098500699",
      email: "careers@example.com",
      kind: "whatsapp",
    }),
    "01098500699",
    "a channel with no override falls back to the company default — the other line is untouched",
  );
  assert.equal(
    applyDestinationForChannel({
      channelApplyWhatsAppNumber: "01159888247",
      defaultWhatsAppNumber: "01098500699",
      email: "careers@example.com",
      kind: "email",
    }),
    "careers@example.com",
    "email has one careers mailbox — the per-channel WhatsApp number never diverts it",
  );
  assert.equal(
    applyDestinationForChannel({
      channelApplyWhatsAppNumber: null,
      defaultWhatsAppNumber: null,
      email: null,
      kind: "whatsapp",
    }),
    null,
    "no channel number and no default means no destination — the caller copies without a dead link",
  );

  // The override only bites once the link builder is fed the resolved destination. Build a link the
  // way the panel does — resolve the destination, then buildApplyLink — and prove the channel's own
  // line, not the default, lands in the wa.me number.
  const overriddenDestination = applyDestinationForChannel({
    channelApplyWhatsAppNumber: "01159888247",
    defaultWhatsAppNumber: "01098500699",
    email: null,
    kind: "whatsapp",
  });
  const overriddenLink = buildApplyLink({
    code: "PX-WAL",
    destination: overriddenDestination as string,
    jobTitle: "Medical Representative",
    kind: "whatsapp",
    location: "Giza",
  });
  assert.ok(
    overriddenLink?.startsWith("https://wa.me/201159888247?text="),
    `the channel's own apply line is the wa.me number, not the default (got ${overriddenLink})`,
  );

  // Source-pin: the panel must route every channel's link through applyDestinationForChannel, not
  // read a single screen-wide destination. Without this, a channel's saved apply number would sit in
  // the database and never reach the link — the override would look configured and do nothing.
  const panelSource = fs.readFileSync(
    fileURLToPath(new URL("../src/components/recruitment/job-advert-panel.tsx", import.meta.url)),
    "utf8",
  );
  assert.ok(
    /applyDestinationForChannel\(\{[\s\S]*channelApplyWhatsAppNumber:\s*channel\.applyWhatsAppNumber/.test(panelSource),
    "the panel resolves each channel's link through applyDestinationForChannel with that channel's own number",
  );
}
