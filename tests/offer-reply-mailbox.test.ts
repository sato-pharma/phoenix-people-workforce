import assert from "node:assert/strict";

import { resolveOfferSender } from "../src/lib/offers/identity.ts";
import {
  receivingDomain,
  resolveReplyToAddress,
  sendingOnlyDomain,
  toReceivableAddress,
  toReceivableHeader,
} from "../src/lib/email/receivable-address.ts";

/**
 * A candidate who replied to a job offer got "this mailbox is not available", twice. The sending
 * subdomain owns no mailboxes (its only MX is Amazon SES's bounce collector), so an offer that
 * names it as From — or a Reply-To that a provider drops — sends the reply into a hole.
 *
 * These assertions pin the STRUCTURAL guarantee: whatever the environment holds, nothing a person
 * can answer ever points at the sending subdomain.
 */
function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function runOfferReplyMailboxTests() {
  // The domains are derived, not retyped: the sending host is the one that cannot receive.
  assert.equal(sendingOnlyDomain, "send.satopharma.com");
  assert.equal(receivingDomain, "satopharma.com");

  // 1) The address mapper.
  assert.equal(toReceivableAddress("hr@send.satopharma.com"), "hr@satopharma.com");
  assert.equal(toReceivableAddress("  HR@SEND.SATOPHARMA.COM "), "HR@satopharma.com");
  assert.equal(toReceivableAddress("hr@satopharma.com"), "hr@satopharma.com", "apex is left alone");
  assert.equal(toReceivableAddress("someone@gmail.com"), "someone@gmail.com", "an outside domain is left alone");
  assert.equal(toReceivableAddress("not-an-address"), "not-an-address");
  assert.equal(toReceivableAddress("x@notsend.satopharma.com"), "x@notsend.satopharma.com", "only the exact sending host is mapped");

  // 2) A full header keeps its display name.
  assert.equal(
    toReceivableHeader("Sato Pharma HR <hr@send.satopharma.com>"),
    "Sato Pharma HR <hr@satopharma.com>",
  );
  assert.equal(toReceivableHeader("hr@send.satopharma.com"), "hr@satopharma.com");

  // 3) THE HEADLINE: an offer's From and Reply-To never name the sending subdomain, for every way
  //    the environment can be set — including the exact value production holds today.
  const scenarios: Array<Record<string, string | undefined>> = [
    { JOB_OFFER_EMAIL_FROM: undefined, JOB_OFFER_REPLY_TO: undefined },
    { JOB_OFFER_EMAIL_FROM: "Sato Pharma HR <hr@send.satopharma.com>", JOB_OFFER_REPLY_TO: undefined },
    { JOB_OFFER_EMAIL_FROM: "hr@send.satopharma.com", JOB_OFFER_REPLY_TO: undefined },
    { JOB_OFFER_EMAIL_FROM: "Sato Pharma HR <hr@send.satopharma.com>", JOB_OFFER_REPLY_TO: "hr@send.satopharma.com" },
    { JOB_OFFER_EMAIL_FROM: "Sato Pharma HR <hr@satopharma.com>", JOB_OFFER_REPLY_TO: "hr@satopharma.com" },
  ];
  for (const env of scenarios) {
    withEnv(env, () => {
      const sender = resolveOfferSender();
      assert.ok(
        !sender.from.toLowerCase().includes(sendingOnlyDomain),
        `offer From must not name the sending subdomain (env ${JSON.stringify(env)}): ${sender.from}`,
      );
      assert.ok(
        !sender.replyTo.toLowerCase().includes(sendingOnlyDomain),
        `offer Reply-To must not name the sending subdomain (env ${JSON.stringify(env)}): ${sender.replyTo}`,
      );
      assert.match(sender.from, /^Sato Pharma[^<]*<hr@satopharma\.com>$/);
      assert.equal(sender.replyTo, "hr@satopharma.com");
    });
  }

  // 4) `isConfigured` still means "the environment named an address", not "we rewrote it".
  withEnv({ JOB_OFFER_EMAIL_FROM: "Sato Pharma HR <hr@send.satopharma.com>", JOB_OFFER_REPLY_TO: undefined }, () => {
    assert.equal(resolveOfferSender().isConfigured, true);
  });
  withEnv({ JOB_OFFER_EMAIL_FROM: undefined, JOB_OFFER_REPLY_TO: undefined }, () => {
    assert.equal(resolveOfferSender().isConfigured, false);
  });

  // 5) Every other outbound mail: a Reply-To on the sending subdomain is mapped too.
  withEnv({ NOTIFICATION_REPLY_TO: undefined }, () => {
    assert.equal(resolveReplyToAddress("hr@send.satopharma.com"), "hr@satopharma.com");
    assert.equal(resolveReplyToAddress("hrbp@satopharma.com"), "hrbp@satopharma.com");
    assert.equal(resolveReplyToAddress(undefined), "care.phx@satopharma.com", "the system default is untouched");
  });
  withEnv({ NOTIFICATION_REPLY_TO: "phoenix@send.satopharma.com" }, () => {
    assert.equal(resolveReplyToAddress(undefined), "phoenix@satopharma.com");
  });
}
