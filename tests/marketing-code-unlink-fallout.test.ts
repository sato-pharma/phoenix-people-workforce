import assert from "node:assert/strict";
import {
  describeUnlinkFallout,
  unlinkStrandingRefusal,
  type StrandedLink,
} from "../src/lib/marketing-requests/code-unlink-fallout.ts";

function link(overrides: Partial<StrandedLink> = {}): StrandedLink {
  return {
    code: "444420",
    customer: "احمد السقا",
    emptied: false,
    venue: "سيدى رافع",
    venue_owner: "Saad Mohamed Saad Salama",
    ...overrides,
  };
}

export function runMarketingCodeUnlinkFalloutTests() {
  assert.equal(
    unlinkStrandingRefusal([]),
    null,
    "a run that strands nobody must proceed — this guard exists to catch a specific harm, not to make unlinking hard",
  );

  assert.equal(
    unlinkStrandingRefusal([link(), link({ customer: "د احمد خليل" })]),
    null,
    "losing one of several targets still leaves the customer usable, so it is reported and applied rather than blocking a 79-row apply",
  );

  const refusal = unlinkStrandingRefusal([link({ emptied: true })]);
  assert.ok(refusal, "a customer left with no selectable target must stop the run");
  assert.match(
    refusal,
    /احمد السقا/,
    "the refusal names the customer, because the operator has to know which venue needs a code before he can retry",
  );
  assert.match(
    refusal,
    /Saad Mohamed Saad Salama/,
    "and names who captured the venue — that is the person sitting in front of the dead Save button",
  );
  assert.match(
    refusal,
    /Nothing was written/,
    "the message must settle the only question that matters at a failed apply: whether the database changed",
  );

  const twice = unlinkStrandingRefusal([
    link({ emptied: true }),
    link({ emptied: true, code: "0001522852", venue: "محمد جمال رضوان" }),
  ]);
  assert.ok(twice, "two emptied links still refuse");
  assert.equal(
    twice.match(/احمد السقا/g)?.length,
    1,
    "a customer stranded by two of its own links is named once — the operator needs the count of PEOPLE stuck, not of rows",
  );
  assert.match(
    twice,
    /2 validated link\(s\) would leave 1 customer\(s\)/,
    "rows and people are counted separately, so a single stranded manager never reads as two",
  );

  assert.deepEqual(
    describeUnlinkFallout([], []),
    [],
    "a clean run prints nothing at all — a heading that appears every time stops being read",
  );

  const report = describeUnlinkFallout([link({ emptied: true }), link({ customer: "انجي جاد" })], []);
  assert.equal(
    report.filter((line) => line.includes("NO TARGET AT ALL")).length,
    1,
    "only the emptied row carries the flag; flagging every affected row would bury the one that blocks somebody",
  );
  assert.ok(
    report.some((line) => line.includes("silently")),
    "the report has to say the loss is silent, because that is the whole reason nobody noticed on 2026-09-06",
  );
}
