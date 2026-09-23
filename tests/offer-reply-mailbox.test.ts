import assert from "node:assert/strict";

import { resolveOfferSender } from "../src/lib/offers/identity.ts";
import {
  receivingDomain,
  resolveReplyToAddress,
  sendingOnlyDomain,
  splitAddressList,
  toReceivableAddress,
  toReceivableHeader,
  toReceivableList,
} from "../src/lib/email/receivable-address.ts";

/**
 * A candidate who replied to a job offer got "this mailbox is not available", twice. The sending
 * subdomain owns no mailboxes (its only MX is Amazon SES's bounce collector), so an offer that
 * names it as From — or a Reply-To that a provider drops — sends the reply into a hole.
 *
 * These assertions pin the STRUCTURAL guarantee: whatever the environment holds, nothing a person
 * can answer ever points at the sending subdomain. They also pin the owner's 2026-09-23 rule that
 * an offer reply reaches BOTH the HR inbox and the owner's own mailbox — a two-address Reply-To.
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

  // 2b) The list mapper: a Reply-To that names SEVERAL mailboxes is split, each mapped off the
  //     sending subdomain independently, and rejoined — count and order preserved.
  assert.deepEqual(splitAddressList("a@x.com, b@y.com ; c@z.com"), ["a@x.com", "b@y.com", "c@z.com"]);
  assert.deepEqual(splitAddressList("  solo@x.com  "), ["solo@x.com"]);
  assert.deepEqual(splitAddressList(""), []);
  assert.equal(
    toReceivableList("hr@send.satopharma.com, omar.anwar@satopharma.com"),
    "hr@satopharma.com, omar.anwar@satopharma.com",
  );
  assert.equal(toReceivableList("hr@satopharma.com"), "hr@satopharma.com", "a lone address is unchanged in shape");

  // 3) THE HEADLINE: an offer's From and Reply-To never name the sending subdomain, for every way
  //    the environment can be set — including the exact value production holds today. The Reply-To
  //    is the DEFAULT two-mailbox list unless the environment names its own.
  const twoMailboxes = "hr@satopharma.com, omar.anwar@satopharma.com";
  const scenarios: Array<{ env: Record<string, string | undefined>; replyTo: string }> = [
    { env: { JOB_OFFER_EMAIL_FROM: undefined, JOB_OFFER_REPLY_TO: undefined }, replyTo: twoMailboxes },
    { env: { JOB_OFFER_EMAIL_FROM: "Sato Pharma HR <hr@send.satopharma.com>", JOB_OFFER_REPLY_TO: undefined }, replyTo: twoMailboxes },
    { env: { JOB_OFFER_EMAIL_FROM: "hr@send.satopharma.com", JOB_OFFER_REPLY_TO: undefined }, replyTo: twoMailboxes },
    // Production's exact value today: From on the sending subdomain, Reply-To unset → the default list.
    { env: { JOB_OFFER_EMAIL_FROM: "Sato Pharma HR <hr@send.satopharma.com>", JOB_OFFER_REPLY_TO: "hr@send.satopharma.com" }, replyTo: "hr@satopharma.com" },
    { env: { JOB_OFFER_EMAIL_FROM: "Sato Pharma HR <hr@satopharma.com>", JOB_OFFER_REPLY_TO: twoMailboxes }, replyTo: twoMailboxes },
    // A multi-address override on the sending subdomain maps EVERY address onto the apex.
    { env: { JOB_OFFER_EMAIL_FROM: undefined, JOB_OFFER_REPLY_TO: "hr@send.satopharma.com, omar.anwar@send.satopharma.com" }, replyTo: twoMailboxes },
  ];
  for (const { env, replyTo } of scenarios) {
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
      assert.equal(sender.replyTo, replyTo, `offer Reply-To (env ${JSON.stringify(env)})`);
    });
  }

  // 3b) The owner's rule, stated directly: with no override, a candidate's reply reaches BOTH the
  //     HR inbox and the owner's own mailbox.
  withEnv({ JOB_OFFER_EMAIL_FROM: undefined, JOB_OFFER_REPLY_TO: undefined }, () => {
    const addresses = splitAddressList(resolveOfferSender().replyTo);
    assert.ok(addresses.includes("hr@satopharma.com"), "the HR inbox must be a reply target");
    assert.ok(addresses.includes("omar.anwar@satopharma.com"), "the owner's mailbox must be a reply target too");
  });

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
