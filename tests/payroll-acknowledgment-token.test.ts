import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  acknowledgmentTokenAnswers,
  acknowledgmentTokenFromError,
  issueAcknowledgmentToken,
  PayrollAcknowledgmentRequiredError,
} from "../src/lib/automated-payroll/acknowledgment-token.ts";

/**
 * YOU CANNOT ACKNOWLEDGE A WARNING YOU WERE NEVER SHOWN (audit finding 53).
 *
 * Part 1 and Part 2 confirm behind three acknowledgeable gates — missing pay-determining data, a
 * Part 1 overpayment, and someone paid last month who has vanished with no resignation on file. By
 * the owner's rule none of them is a hard block: flag loudly, let HR accept on the record, never
 * stop the month.
 *
 * The acknowledgement was a BOOLEAN IN THE REQUEST BODY, so the gate only ever fired for a caller
 * that had not already said yes. `{ acknowledgeDataIssues: true }` on the FIRST request confirmed
 * the run with the warning never computed for a human — and the audit log then recorded
 * `payroll_data_issues_acknowledged`, which reads as *HR was shown this and accepted it*. A record
 * saying the opposite of what happened is the worst shape a gate can fail in.
 *
 * The acknowledgement is now a token the server mints only when a gate actually fires, bound to the
 * run, the gate, the actor, a digest of the exact warning text, and an expiry. These tests are the
 * proof that each of those bindings actually refuses.
 */

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

const RUN = "run-2026-09";
const ACTOR = "B-10";
const WARNING =
  "3 employees are missing pay-determining data: Mona Adel (B-7), Sara Hany (B-12), Ali Nabil (B-19).";

export async function runPayrollAcknowledgmentTokenTests() {
  const previousSecret = process.env.PHOENIX_AUTH_SECRET;
  process.env.PHOENIX_AUTH_SECRET = "acknowledgment-token-test-secret";
  try {
    const base = { runId: RUN, gate: "data-quality" as const, actorHrId: ACTOR, warning: WARNING };
    const token = issueAcknowledgmentToken(base);

    // ==== The first request cannot acknowledge anything ==========================================
    // This is the whole defect. There is no value a caller can invent — no flag, no "true", no
    // guessed string — that answers a gate before the server has shown it the warning.
    for (const forged of [null, undefined, "", "true", "yes", "1", "acknowledged", `${RUN}.true`]) {
      assert.equal(
        acknowledgmentTokenAnswers({ ...base, token: forged }),
        false,
        `HEADLINE: a caller-invented acknowledgment (${JSON.stringify(forged)}) must never pass the gate — a yes on the first request is exactly the bug`,
      );
    }

    // ==== The token the server minted does answer its own warning ================================
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, token }),
      true,
      "HEADLINE: the token the fired gate minted answers that gate, or HR could never confirm at all",
    );

    // ==== Signed, so it cannot be written by the caller ==========================================
    const [encoded, signature] = token.split(".");
    assert.ok(encoded && signature, "the token is payload.signature");
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, token: `${encoded}.${signature.slice(0, -1)}x` }),
      false,
      "HEADLINE: a tampered signature is refused",
    );
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, token: `${encoded}.` }),
      false,
      "and so is a stripped one — an empty signature is not 'no signature required'",
    );

    // A payload rewritten to claim another gate, carrying the signature of the original.
    const claim = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    claim.gate = "overpaid";
    const rewritten = Buffer.from(JSON.stringify(claim), "utf8").toString("base64url");
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, gate: "overpaid", token: `${rewritten}.${signature}` }),
      false,
      "HEADLINE: the payload cannot be rewritten — the signature covers it",
    );

    // ==== Bound to THIS run, THIS gate, THIS person ==============================================
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, runId: "run-2026-10", token }),
      false,
      "HEADLINE: an acknowledgment from one month can never answer another month",
    );
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, gate: "overpaid", token }),
      false,
      "HEADLINE: accepting missing data does not also wave through an overpayment",
    );
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, actorHrId: "B-22", token }),
      false,
      "HEADLINE: one person's decision is not another person's permission",
    );
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, actorHrId: "b-10", token }),
      true,
      "but the same person in another letter case is still the same person — HR ids are stored mixed-case",
    );

    // ==== Bound to the WARNING, which is what makes it more than a nonce =========================
    const moved =
      "4 employees are missing pay-determining data: Mona Adel (B-7), Sara Hany (B-12), Ali Nabil (B-19), Nour Samy (B-31).";
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, warning: moved, token }),
      false,
      "HEADLINE: if the data moves between the warning and the retry, the token no longer answers it — HR is asked again, with the new names",
    );
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, warning: WARNING.replace(/ /g, "\n  "), token }),
      true,
      "a purely cosmetic re-wrap is not a change of fact, so a decision already made still stands",
    );

    // ==== And it goes stale ======================================================================
    const issuedAt = 1_800_000_000;
    const dated = issueAcknowledgmentToken({ ...base, nowSeconds: issuedAt });
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, token: dated, nowSeconds: issuedAt + 14 * 60 }),
      true,
      "a decision taken a minute ago still holds",
    );
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, token: dated, nowSeconds: issuedAt + 16 * 60 }),
      false,
      "HEADLINE: a token left in a tab cannot answer a later run — it expires",
    );

    // ==== Another deployment's secret cannot mint one ============================================
    process.env.PHOENIX_AUTH_SECRET = "a-different-secret";
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, token }),
      false,
      "HEADLINE: a token minted elsewhere is refused — the signature is keyed on this deployment's secret",
    );
    delete process.env.PHOENIX_AUTH_SECRET;
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, token }),
      false,
      "with no secret at all nothing verifies, so nothing is acknowledged — the gate fails CLOSED",
    );
    assert.throws(
      () => issueAcknowledgmentToken(base),
      /PHOENIX_AUTH_SECRET/,
      "and nothing mints either, loudly",
    );
    process.env.PHOENIX_AUTH_SECRET = "acknowledgment-token-test-secret";

    // ==== The round trip a fired gate actually performs ==========================================
    const error = new PayrollAcknowledgmentRequiredError({
      marker: "[PAYROLL_DATA_ACK_REQUIRED]",
      gate: "data-quality",
      warning: WARNING,
      token: issueAcknowledgmentToken(base),
    });
    assert.equal(
      error.message,
      `Conflict: [PAYROLL_DATA_ACK_REQUIRED] ${WARNING}`,
      "the message the API routes match on is unchanged, so the prompt still renders",
    );
    const returned = acknowledgmentTokenFromError(error);
    assert.ok(returned, "HEADLINE: the fired gate hands the route a token to give the client");
    assert.equal(
      acknowledgmentTokenAnswers({ ...base, token: returned }),
      true,
      "HEADLINE: and that token, sent back, is what lets the same person confirm the same warning",
    );
    assert.equal(acknowledgmentTokenFromError(new Error("Conflict: something else")), null);
    assert.equal(acknowledgmentTokenFromError(null), null, "and it never throws on a non-error");
    assert.equal(acknowledgmentTokenFromError(undefined), null);

    // ==== No boolean acknowledgement survives anywhere on the path ================================
    // The token is only a fix while there is no second door. A single surviving `=== true` flag on
    // any of these four files restores the whole defect.
    const service = stripComments(source("src/lib/automated-payroll/run-service.ts"));
    const part1 = stripComments(source("app/api/automated-payroll/runs/[runId]/part1/confirm/route.ts"));
    const part2 = stripComments(source("app/api/automated-payroll/runs/[runId]/part2/confirm/route.ts"));
    const wizard = stripComments(source("src/components/automated-payroll/automated-payroll-wizard.tsx"));

    for (const [name, text] of [
      ["run-service.ts", service],
      ["part1 confirm route", part1],
      ["part2 confirm route", part2],
      ["the wizard", wizard],
    ] as const) {
      assert.doesNotMatch(
        text,
        /acknowledge(Overpaid|DataIssues|PopulationDiff)\b(?!Token)/,
        `HEADLINE: no boolean acknowledgement flag may survive in ${name} — a flag in the request body is the defect itself`,
      );
    }

    assert.match(
      service,
      /function requireAcknowledgment\(input: \{/,
      "HEADLINE: one place decides whether a warning has been answered, so the three gates cannot drift apart",
    );
    for (const gate of ["data-quality", "overpaid", "population-diff"]) {
      assert.match(
        service,
        new RegExp(`gate: "${gate}"`),
        `and the ${gate} gate goes through it, with its own gate name`,
      );
    }
    assert.match(
      part1,
      /acknowledgmentToken: acknowledgmentTokenFromError\(error\)/,
      "HEADLINE: the Part 1 409 hands back the token it just minted, or the prompt would have nothing to send",
    );
    assert.match(
      part2,
      /const acknowledgmentToken = acknowledgmentTokenFromError\(error\);/,
      "HEADLINE: and so does Part 2, for all three of its gates",
    );
    assert.equal(
      part2.match(/\n\s+acknowledgmentToken,\n/g)?.length,
      3,
      "one for each gate the route can raise — a missing one is a prompt that can never be answered",
    );
    assert.match(
      wizard,
      /acknowledgeOverpaidToken: acks\.overpaid \?\? null/,
      "HEADLINE: the wizard sends back the token it was given, never a flag it decided on its own",
    );
    assert.match(
      wizard,
      /const token = typeof data\.acknowledgmentToken === "string" \? data\.acknowledgmentToken : null;/,
      "and it takes that token from the 409 that raised the gate",
    );
  } finally {
    if (previousSecret === undefined) delete process.env.PHOENIX_AUTH_SECRET;
    else process.env.PHOENIX_AUTH_SECRET = previousSecret;
  }
}
