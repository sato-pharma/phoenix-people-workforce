import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { groupDeductionCommentThreads } from "../src/lib/deductions/portal.ts";
import type { DeductionsComment, DeductionsPortalLine } from "../src/lib/deductions/types.ts";

/**
 * The admin Disputes inbox (owner report, 2026-10-06: "I receive a comment on a deduction from
 * Dina Fadel, I can never reach it"). A deduction comment mailed HR a link to /admin/deductions,
 * but that workspace shows the current month's collection tabs and NO comment anywhere, so a
 * dispute was unreachable in-app. This pins the two load-bearing facts behind the fix:
 *
 *   1. groupDeductionCommentThreads turns newest-first comments into per-candidate threads,
 *      ordered by their newest comment, attaching each candidate's published line (null when the
 *      line was later withdrawn — the comment must still be reachable).
 *   2. the comment notification deep-links to the Disputes tab on the exact candidate, so the
 *      link opens on the dispute rather than the bare month workspace it used to.
 */

function comment(input: Partial<DeductionsComment> & { candidateId: string; createdAt: string; id: string }): DeductionsComment {
  return {
    authorHrId: "B-204",
    authorLoginId: "B-204",
    authorRole: "Medical Rep",
    body: "This deduction is wrong.",
    ...input,
  };
}

function line(candidateId: string, employeeName: string): DeductionsPortalLine {
  return {
    id: `line-${candidateId}`,
    summaryId: "pub-1",
    candidateId,
    decisionId: "dec-1",
    employeeCode: "B-204",
    employeeHrIdCompact: "b204",
    employeeName,
    monthKey: "2026-09",
    sourceModule: "DEDUCTIONS_MODULE",
    deductionType: "crm",
    payrollColumn: "crm",
    deductionUnit: "days",
    originalDeductionValue: 2,
    appliedDeductionValue: 2,
    appliedAmount: 480,
    dates: ["2026-09-03", "2026-09-04"],
    reason: null,
    hrNote: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

export function runDeductionsDisputeThreadsTests() {
  // 1. Threads sort by newest comment, and a candidate's comments stay grouped newest-first.
  {
    const comments: DeductionsComment[] = [
      // Newest-first as the query returns them.
      comment({ id: "c-new", candidateId: "cand-A", createdAt: "2026-10-05T10:00:00.000Z", body: "latest on A" }),
      comment({ id: "c-B", candidateId: "cand-B", createdAt: "2026-10-04T09:00:00.000Z", body: "only on B" }),
      comment({ id: "c-old", candidateId: "cand-A", createdAt: "2026-10-01T08:00:00.000Z", body: "older on A" }),
    ];
    const lines = new Map<string, DeductionsPortalLine>([
      ["cand-A", line("cand-A", "Dina Fadel")],
      ["cand-B", line("cand-B", "Someone Else")],
    ]);

    const threads = groupDeductionCommentThreads(comments, lines);

    assert.equal(threads.length, 2, "one thread per candidate");
    assert.equal(threads[0].candidateId, "cand-A", "the thread with the newest comment comes first");
    assert.equal(threads[0].latestCommentAt, "2026-10-05T10:00:00.000Z");
    assert.deepEqual(
      threads[0].comments.map((c) => c.id),
      ["c-new", "c-old"],
      "a candidate's comments stay grouped, newest first",
    );
    assert.equal(threads[0].line?.employeeName, "Dina Fadel", "the published line is attached to its thread");
    assert.equal(threads[1].candidateId, "cand-B");
  }

  // 2. A comment on a since-withdrawn deduction still produces a reachable thread, line = null.
  {
    const comments = [comment({ id: "c-x", candidateId: "cand-gone", createdAt: "2026-10-02T00:00:00.000Z" })];
    const threads = groupDeductionCommentThreads(comments, new Map());
    assert.equal(threads.length, 1, "a withdrawn-line comment is still shown");
    assert.equal(threads[0].line, null, "line is null when no active published line exists");
    assert.equal(threads[0].comments[0].id, "c-x");
  }

  // 3. The notification deep-links to the Disputes tab on the exact candidate — the whole point of
  //    the fix. A source-contract check: the string is what makes a dispute reachable in-app.
  {
    const source = readFileSync(new URL("../src/lib/deductions/comments.ts", import.meta.url), "utf8");
    assert.match(
      source,
      /tab=disputes&candidate=\$\{encodeURIComponent\(input\.candidateId\)\}/,
      "the deduction-comment notification must deep-link to the Disputes tab on the candidate",
    );
    assert.doesNotMatch(
      source,
      /actionUrl: "\/admin\/deductions",/,
      "the bare /admin/deductions link is what left the comment unreachable — it must not return",
    );
  }

  // 4. The admin page reads tab/candidate from the URL and feeds the workspace, so the deep link
  //    actually opens the tab rather than being ignored.
  {
    const source = readFileSync(
      new URL("../app/(admin)/admin/deductions/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(source, /tabParam === "disputes" \? "disputes" : undefined/, "page must pass initialTab from ?tab");
    assert.match(source, /highlightCandidateId=\{candidateParam\}/, "page must pass the candidate to highlight");
  }

  // 5. The HR reply path — the other side of the conversation (owner, 2026-10-06). Source-contract:
  //    the admin POST handler must be CSRF-guarded and call addDeductionsReply, which gates on the
  //    Super-Admin decision actor ("keep replies super-admin only"); the reply goes TO the employee.
  {
    const route = readFileSync(
      new URL("../app/api/admin/deductions/comments/route.ts", import.meta.url),
      "utf8",
    );
    assert.match(route, /export async function POST/, "the admin comments route must accept a reply (POST)");
    assert.match(route, /assertSameOriginMutation\(request\)/, "the reply POST must be CSRF-guarded");
    assert.match(route, /addDeductionsReply\(/, "the reply POST must call addDeductionsReply");

    const comments = readFileSync(new URL("../src/lib/deductions/comments.ts", import.meta.url), "utf8");
    assert.match(
      comments,
      /export async function addDeductionsReply[\s\S]*?assertDeductionsDecisionActor\(input\.access\)/,
      "addDeductionsReply must gate on the Super-Admin decision actor — replies are super-admin only",
    );
    assert.doesNotMatch(
      comments,
      /export async function addDeductionsReply[\s\S]*?assertDeductionsReadActor\(input\.access\)/,
      "a reply must NOT fall back to the company-wide read actor — CEO and HR Operations cannot reply",
    );
    assert.match(
      comments,
      /actionUrl: "\/employee-portals\/deductions"/,
      "an HR reply must be delivered to the employee's own portal deductions page",
    );
    assert.match(
      comments,
      /submitterHrId: employeeHrId/,
      "the reply's To is the employee — the thread owner — not HR",
    );
  }

  // 6. The reply box renders for the Super Admin only — the page passes canReply=canDecide, and the
  //    tab hides the form otherwise, matching the server gate.
  {
    const source = readFileSync(
      new URL("../src/components/admin/deductions-workspace.tsx", import.meta.url),
      "utf8",
    );
    assert.match(source, /<DisputesTab canReply=\{canDecide\}/, "the reply box must be gated on canDecide (Super Admin)");
  }
}
