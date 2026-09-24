import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";

import {
  buildSourceOfHire,
  channelGroupForCoarseSource,
  channelGroupForKind,
  resolveEffectiveAdvert,
  type ChannelDirectoryEntry,
  type HiredApplicationInput,
} from "../src/lib/recruitment/source-of-hire.ts";
import { earliestCodePerCandidate } from "../src/lib/recruitment/hiring-analytics.ts";

/**
 * Source-of-hire attribution — the join nobody had done, and the honest coverage that comes with it.
 *
 * The whole point is answering "which advert produced this HIRE" without lying about the majority
 * that arrive with no advert at all. So these tests are mostly about the fallbacks: a manual tag
 * beating an absent code, a channel bucket that still counts a hire whose advert is unknown, and an
 * Unknown-advert figure that is one number, never spread across guesses.
 */
export function runSourceOfHireTests() {
  const hire = (over: Partial<HiredApplicationInput>): HiredApplicationInput => ({
    applicationId: "app",
    candidateId: "cand",
    employeeHrId: "B-99",
    hiredAt: "2026-09-01T00:00:00.000Z",
    manualChannelCode: null,
    coarseSource: null,
    autoChannelCode: null,
    ...over,
  });

  const directory: ChannelDirectoryEntry[] = [
    { code: "PX-MRE", name: "Medical Reps Egypt", kind: "facebook_group" },
    { code: "PX-WAG", name: "Cairo Reps WhatsApp", kind: "whatsapp_group" },
    { code: "PX-JOB", name: "Wuzzuf", kind: "job_board" },
  ];

  // ── manual beats auto beats none ─────────────────────────────────────────────────────────────
  {
    assert.deepEqual(
      resolveEffectiveAdvert(hire({ manualChannelCode: "PX-MRE", autoChannelCode: "PX-WAG" })),
      { code: "PX-MRE", basis: "manual" },
      "a person's tag overrides the tracked code — they know something the link could not carry",
    );
    assert.deepEqual(
      resolveEffectiveAdvert(hire({ autoChannelCode: "PX-WAG" })),
      { code: "PX-WAG", basis: "auto" },
      "with no tag, the surviving tracked code is used",
    );
    assert.deepEqual(
      resolveEffectiveAdvert(hire({})),
      { code: null, basis: "none" },
      "no tag and no code is `none`, not a failure — it is the honest majority",
    );
    // Applicants retype codes in lower case; a stored tag might too. It must still resolve.
    assert.equal(resolveEffectiveAdvert(hire({ manualChannelCode: "px-mre" })).code, "PX-MRE");
  }

  // ── channel groups coarsen kinds and sources the same way ────────────────────────────────────
  {
    assert.equal(channelGroupForKind("facebook_group"), "Facebook");
    assert.equal(channelGroupForKind("facebook_page"), "Facebook", "group and page are one channel");
    assert.equal(channelGroupForKind("whatsapp_channel"), "WhatsApp");
    assert.equal(channelGroupForKind("telegram_group"), "Telegram");
    assert.equal(channelGroupForKind("job_board"), "Job board");
    assert.equal(channelGroupForKind(null), "Other");

    assert.equal(channelGroupForCoarseSource("whatsapp"), "WhatsApp");
    assert.equal(channelGroupForCoarseSource(" Email "), "Email");
    assert.equal(channelGroupForCoarseSource("website"), "Website");
    assert.equal(channelGroupForCoarseSource(null), "Unrecorded", "a missing source is named, never dropped");
    assert.equal(channelGroupForCoarseSource("linkedin"), "Linkedin", "an unexpected source is shown, not hidden");
  }

  // ── channel level counts EVERY hire; advert level only the known ones ─────────────────────────
  {
    const result = buildSourceOfHire(
      [
        hire({ applicationId: "1", manualChannelCode: "PX-MRE", coarseSource: "email" }), // tagged → Facebook
        hire({ applicationId: "2", autoChannelCode: "PX-WAG", coarseSource: "whatsapp" }), // tracked → WhatsApp
        hire({ applicationId: "3", coarseSource: "whatsapp" }), // unknown advert, WhatsApp channel
        hire({ applicationId: "4", coarseSource: "email" }), // unknown advert, Email channel
      ],
      directory,
    );

    assert.equal(result.totalHires, 4);
    assert.equal(result.attributedToAdvert, 2, "two hires carry an advert");
    assert.equal(result.taggedByAPerson, 1, "one of those was tagged by a person");
    assert.equal(result.unknownAdvert, 2, "two hires have a channel but no advert");

    const channelTotal = result.channels.reduce((sum, row) => sum + row.hires, 0);
    assert.equal(channelTotal, 4, "the channel view always totals every hire — ~100% coverage is the point");
    const whatsapp = result.channels.find((row) => row.channel === "WhatsApp");
    assert.equal(whatsapp?.hires, 2, "the tracked-WhatsApp hire and the untagged-WhatsApp hire both land here");
    assert.ok(
      result.channels.some((row) => row.channel === "Facebook" && row.hires === 1),
      "the tagged hire's channel comes from its advert's kind, not its coarse email source",
    );

    assert.equal(result.adverts.length, 2);
    const mre = result.adverts.find((row) => row.code === "PX-MRE");
    assert.equal(mre?.name, "Medical Reps Egypt");
    assert.equal(mre?.manualHires, 1);
    assert.equal(mre?.autoHires, 0);
  }

  // ── a code with no directory row still counts, named after itself ────────────────────────────
  {
    const result = buildSourceOfHire([hire({ manualChannelCode: "PX-GONE" })], directory);
    assert.equal(result.attributedToAdvert, 1, "a since-purged code must not silently drop the hire");
    assert.equal(result.adverts[0].code, "PX-GONE");
    assert.equal(result.adverts[0].name, "PX-GONE", "with no directory row it names itself");
  }

  // ── no hires is a clean empty, not a divide or a crash ───────────────────────────────────────
  {
    const result = buildSourceOfHire([], directory);
    assert.equal(result.totalHires, 0);
    assert.equal(result.attributedToAdvert, 0);
    assert.equal(result.channels.length, 0);
    assert.equal(result.adverts.length, 0);
  }

  // ── the earliest surviving code wins, in BOTH arrival orders ─────────────────────────────────
  //
  // Both orders, for the same reason the analytics test checks both: a "keep the last write" bug
  // returns the right answer when events happen to arrive oldest-first, so asserting only that
  // order passes a broken implementation.
  {
    const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
    const oldestFirst = earliestCodePerCandidate([
      { candidateId: "c", code: "PX-MRE", createdAt: at(2) },
      { candidateId: "c", code: "PX-WAG", createdAt: at(5) },
    ]);
    assert.equal(oldestFirst.get("c"), "PX-MRE", "the covering message that first brought them wins");

    const newestFirst = earliestCodePerCandidate([
      { candidateId: "c", code: "PX-WAG", createdAt: at(5) },
      { candidateId: "c", code: "PX-MRE", createdAt: at(2) },
    ]);
    assert.equal(newestFirst.get("c"), "PX-MRE", "and still wins when the rows arrive newest-first");

    // A null or blank code never registers a candidate — the majority legitimately carry nothing.
    const none = earliestCodePerCandidate([{ candidateId: "d", code: null, createdAt: at(1) }]);
    assert.equal(none.has("d"), false, "a candidate with no code does not appear, and is not an error");
  }

  // ── the reader must actually join the hire side ───────────────────────────────────────────────
  //
  // The pure functions above cannot see which columns the query names. Reading the manual tag and
  // filtering to hired rows is the whole join; a report that never selected them would compute over
  // nothing and look empty rather than wrong.
  {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "lib", "recruitment", "hiring-analytics.ts"),
      "utf8",
    );
    assert.ok(
      source.includes("attributed_channel_code"),
      "the loader must read the manual source tag — it is the only route to advert-level attribution in practice",
    );
    assert.ok(
      source.includes('.eq("stage", "hired")'),
      "source-of-hire is about HIRES — the loader must filter to hired applications",
    );
    assert.ok(
      source.includes("buildSourceOfHire("),
      "the rollup must go through buildSourceOfHire, so the rule stays testable",
    );
  }
}
