import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildCvDigestForManager,
  buildCcList,
  cvDigestEmailBody,
  cvDigestTitle,
  type CvDigestCandidateRow,
} from "../src/lib/recruitment/inbound/cv-intake-digest-6h.ts";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function candidateRow(overrides: Partial<CvDigestCandidateRow> = {}): CvDigestCandidateRow {
  return {
    candidateId: "c-1",
    candidateName: "Test Candidate",
    channel: "email",
    senderDisplayName: "Ahmed Recruiter",
    senderIdentifier: "ahmed@example.com",
    sourceChannelCode: null,
    ...overrides,
  };
}

export async function runCvIntakeDigest6hTests() {
  // --- pure buildCvDigestForManager ---

  const rows: CvDigestCandidateRow[] = [
    candidateRow({ candidateId: "c-1", senderDisplayName: "B-10 Branch", senderIdentifier: "b10@mail.com" }),
    candidateRow({ candidateId: "c-2", senderDisplayName: "B-10 Branch", senderIdentifier: "b10@mail.com" }),
    candidateRow({ candidateId: "c-3", senderDisplayName: "B-10 Branch", senderIdentifier: "b10@mail.com" }),
    candidateRow({ candidateId: "c-4", senderDisplayName: "Sara HR", senderIdentifier: "sara@mail.com", channel: "whatsapp" }),
    candidateRow({ candidateId: "c-5", senderDisplayName: "Sara HR", senderIdentifier: "sara@mail.com", channel: "whatsapp" }),
    candidateRow({ candidateId: "c-6", senderDisplayName: "Mona Ali", senderIdentifier: "mona@mail.com" }),
  ];

  const digest = buildCvDigestForManager(rows);

  assert.equal(digest.total, 6, "total counts every row");

  assert.equal(digest.bySender.length, 3, "three distinct senders");
  assert.equal(digest.bySender[0].label, "B-10 Branch", "biggest sender is first");
  assert.equal(digest.bySender[0].count, 3);
  assert.equal(digest.bySender[1].count, 2, "Sara HR sent 2");
  assert.equal(digest.bySender[2].count, 1, "Mona Ali sent 1");

  // --- title ---
  assert.equal(cvDigestTitle(digest), "You received 6 CVs in the past 6 hours");
  assert.equal(
    cvDigestTitle(buildCvDigestForManager([candidateRow()])),
    "You received 1 CV in the past 6 hours",
  );

  // --- body ---
  const body = cvDigestEmailBody(digest);
  assert.ok(body.includes("6 CVs"), "body mentions total");
  assert.ok(body.includes("B-10 Branch"), "body names the biggest sender");
  assert.ok(body.includes("Sara HR"), "body names Sara");
  assert.ok(body.includes("Mona Ali"), "body names Mona");

  // --- empty digest sends no email ---
  const emptyDigest = buildCvDigestForManager([]);
  assert.equal(emptyDigest.total, 0, "empty digest has total 0");
  assert.equal(cvDigestEmailBody(emptyDigest), "", "empty digest yields empty body");

  // --- sender fallbacks ---
  const noDisplayName = buildCvDigestForManager([
    candidateRow({ senderDisplayName: null, senderIdentifier: "fallback@mail.com" }),
  ]);
  assert.equal(noDisplayName.bySender[0].label, "fallback@mail.com", "falls back to identifier");

  const noIdentifier = buildCvDigestForManager([
    candidateRow({ senderDisplayName: null, senderIdentifier: null, sourceChannelCode: "PX-ABC" }),
  ]);
  assert.equal(noIdentifier.bySender[0].label, "PX-ABC", "falls back to channel code");

  const noAnything = buildCvDigestForManager([
    candidateRow({ senderDisplayName: null, senderIdentifier: null, sourceChannelCode: null }),
  ]);
  assert.equal(noAnything.bySender[0].label, "Unknown sender", "falls back to Unknown sender");

  // --- CC logic ---
  const dmCc = buildCcList("District Manager", "rm@satopharma.com");
  assert.ok(dmCc.includes("omar.anwar@satopharma.com"), "DM always CCs omar.anwar");
  assert.ok(dmCc.includes("rm@satopharma.com"), "DM CCs their manager");

  const rmCc = buildCcList("Regional Manager", "nsm@satopharma.com");
  assert.ok(rmCc.includes("omar.anwar@satopharma.com"), "RM always CCs omar.anwar");
  assert.ok(rmCc.includes("nsm@satopharma.com"), "RM CCs their manager");

  const nsmCc = buildCcList("National Sales Manager", "ceo@satopharma.com");
  assert.ok(nsmCc.includes("omar.anwar@satopharma.com"), "NSM always CCs omar.anwar");
  assert.ok(!nsmCc.includes("ceo@satopharma.com"), "NSM does NOT CC their manager");

  const hrCc = buildCcList("HR Advisory", "hr.manager@satopharma.com");
  assert.ok(hrCc.includes("omar.anwar@satopharma.com"), "HR Advisory always CCs omar.anwar");
  assert.ok(!hrCc.includes("hr.manager@satopharma.com"), "HR Advisory does not CC their manager (not DM/RM)");

  const superAdminCc = buildCcList("Super Admin", null);
  assert.ok(superAdminCc.includes("omar.anwar@satopharma.com"), "Super Admin always CCs omar.anwar");
  assert.equal(superAdminCc.length, 1, "Super Admin only has omar.anwar in CC");

  // --- source code contract: the cron route exists and gates with CRON_SECRET ---
  const routeSource = read("app/api/cron/recruitment-cv-digest/route.ts");
  assert.match(routeSource, /bearerSecretMatches/, "route gates with bearerSecretMatches");
  assert.match(routeSource, /sendCvIntakeDigest6h/, "route calls the service");

  // --- source code contract: the access registry includes the route ---
  const accessRegistrySource = read("src/lib/security/access-registry.ts");
  assert.match(
    accessRegistrySource,
    /\/api\/cron\/recruitment-cv-digest/,
    "access registry includes the digest route",
  );

  // --- source code contract: the job registry includes the entry ---
  const jobRegistrySource = read("src/lib/cron-control/job-registry.ts");
  assert.match(
    jobRegistrySource,
    /phoenix-recruitment-cv-digest/,
    "job registry includes the digest entry",
  );

  // --- source code contract: the service sends email, not in-app/telegram/push ---
  const serviceSource = read("src/lib/recruitment/inbound/cv-intake-digest-6h.ts");
  assert.match(serviceSource, /sendPhoenixEmail/, "service sends via sendPhoenixEmail (email channel)");
  assert.ok(!serviceSource.includes("createSystemNotification"), "service does NOT use the in-app notification system");

  // --- source code contract: the recipient is the manager who received the CV push ---
  assert.match(serviceSource, /manager_notified_hr_id/, "service queries by manager_notified_hr_id");
  assert.match(serviceSource, /manager_notified_at/, "service filters by manager_notified_at timestamp");

  // --- source code contract: omar.anwar is always in CC ---
  assert.match(serviceSource, /omar\.anwar@satopharma\.com/, "omar.anwar@satopharma.com is the always-CC address");

  // --- source code contract: silent when no managers received CVs ---
  assert.match(
    serviceSource,
    /if \(batches\.length === 0\) return \{ total: 0, recipientCount: 0 \}/,
    "service returns early when no managers received CVs — no email sent",
  );
}
