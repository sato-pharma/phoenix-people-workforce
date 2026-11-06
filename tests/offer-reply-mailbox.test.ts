import assert from "node:assert/strict";

import { resolveOfferSender } from "../src/lib/offers/identity.ts";
import { JOB_OFFER_SENDER_ADDRESSES } from "../src/lib/email/job-offer-sender.ts";
import { applySenderOverride, resolveEmailProviders, senderOverrideRefusal } from "../src/lib/email/email-providers.ts";
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
 * Section 6 pins his 2026-10-13 rule on the other half of the same header: a job offer fires from
 * `HR@satopharma.com` or `hr@send.satopharma.com`, and from no other mailbox — not from a value
 * somebody puts in `JOB_OFFER_EMAIL_FROM`, and not from the verified address of a backup provider
 * account.
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

/** `withEnv` for a body that awaits — the provider chain's `send` returns a promise. */
async function withEnvAsync(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function runOfferReplyMailboxTests() {
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
    { env: { JOB_OFFER_EMAIL_FROM: "Sato Pharma HR <hr@send.satopharma.com>", JOB_OFFER_REPLY_TO: "hr@send.satopharma.com" }, replyTo: twoMailboxes },
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

  // 3c) AND HE CANNOT BE CONFIGURED OFF IT (owner, 2026-10-13: "make sure if candidate replies the
  //     email reaches me"). The default named him, but a `JOB_OFFER_REPLY_TO` holding anything else
  //     used to replace the whole list — a one-address value took a candidate's reply away from him
  //     with nothing looking wrong anywhere. He is appended whenever the resolved list lacks him.
  const adminMailbox = "omar.anwar@satopharma.com";
  for (const configured of [
    "hr@satopharma.com",
    "careers@satopharma.com, hr@satopharma.com",
    "hr@send.satopharma.com",
    "",
  ]) {
    withEnv({ JOB_OFFER_EMAIL_FROM: undefined, JOB_OFFER_REPLY_TO: configured || undefined }, () => {
      const addresses = splitAddressList(resolveOfferSender().replyTo).map((address) => address.toLowerCase());
      assert.ok(
        addresses.includes(adminMailbox),
        `a candidate reply must reach the owner whatever JOB_OFFER_REPLY_TO holds (${configured || "unset"}): ${addresses.join(", ")}`,
      );
    });
  }
  // Named once, present once — he is never duplicated, in any case, and the order he set is kept.
  withEnv({ JOB_OFFER_EMAIL_FROM: undefined, JOB_OFFER_REPLY_TO: "OMAR.ANWAR@SATOPHARMA.COM, hr@satopharma.com" }, () => {
    const addresses = splitAddressList(resolveOfferSender().replyTo);
    assert.equal(addresses.length, 2, "the owner is not appended a second time");
    assert.equal(addresses[0].toLowerCase(), adminMailbox, "the configured order is kept");
  });

  // ── 6) THE OWNER'S RULE, 2026-10-13: "all job offers email must only fire from
  //       HR@satopharma.com or hr@send.satopharma.com" ──
  //
  // Two mailboxes, no third, and the rule has to hold in the two places an offer's From is
  // decided: the environment value, and the provider account that sends it.
  assert.deepEqual(
    [...JOB_OFFER_SENDER_ADDRESSES],
    ["hr@satopharma.com", "hr@send.satopharma.com"],
    "the allowed offer senders are exactly the owner's two mailboxes",
  );

  // 6a) A configured address outside the list is REFUSED, not sent from — and it is reported back
  //     rather than swallowed, so the Job Offers screen can show HR what the environment holds.
  for (const refused of [
    "careers@satopharma.com",
    "Phoenix Workforce <phoenix@send.satopharma.com>",
    "hr@satopharma.com.example.net",
    "hr@notsatopharma.com",
    "recruitment@send.satopharma.com",
  ]) {
    withEnv({ JOB_OFFER_EMAIL_FROM: refused, JOB_OFFER_REPLY_TO: undefined }, () => {
      const sender = resolveOfferSender();
      assert.equal(sender.from, "Sato Pharma <hr@satopharma.com>", `refused sender falls back to HR (${refused})`);
      assert.equal(sender.refusedFrom, refused, `the refused value is reported (${refused})`);
      assert.equal(sender.isConfigured, false, `a refused value is not a configured sender (${refused})`);
    });
  }

  // 6b) Both of his spellings are accepted, in any case, and nothing else is ever refused.
  for (const allowed of ["hr@satopharma.com", "HR@satopharma.com", "hr@send.satopharma.com", "Sato Pharma HR <HR@SEND.SATOPHARMA.COM>"]) {
    withEnv({ JOB_OFFER_EMAIL_FROM: allowed, JOB_OFFER_REPLY_TO: undefined }, () => {
      const sender = resolveOfferSender();
      assert.equal(sender.refusedFrom, null, `an allowed sender is never refused (${allowed})`);
      assert.equal(sender.isConfigured, true, `an allowed sender is configured (${allowed})`);
      assert.match(
        sender.from.toLowerCase(),
        /<hr@satopharma\.com>$/,
        `an allowed sender ends up on the apex HR mailbox (${allowed})`,
      );
    });
  }

  // 6c) THE HOLE THIS CLOSED. Every backup account rewrites the From, because a sending domain is
  //     verified in only one account — measured on production 2026-10-13: Resend account 1 holds
  //     satopharma.com AND send.satopharma.com, account 2 only send2.satopharma.com, and Brevo
  //     replaces the whole header with `Phoenix Workforce <phoenix@send.satopharma.com>`. So an
  //     offer sent while account 1 was capped went out as phoenix@send2 — or as *Phoenix
  //     Workforce*, the one brand an offer must never wear.
  const offerFrom = "Sato Pharma <hr@satopharma.com>";
  const notificationFrom = "Phoenix Workforce <phoenix@send.satopharma.com>";
  const offerEmail = (from: string) => ({
    from,
    html: "<p>Offer of Employment</p>",
    idempotencyKey: "offer-sender-lock-test",
    replyTo: "hr@satopharma.com",
    subject: "Offer of Employment",
    text: "Offer of Employment",
    to: ["candidate@example.com"],
  });

  // The pure decision: an override that would move an offer off HR is refused; one that would not
  // change the From, or that lands on the other allowed mailbox, is fine; and a Phoenix
  // notification keeps the override it has always had.
  assert.equal(senderOverrideRefusal(offerEmail(offerFrom), "", "Resend")?.outcome, undefined, "no override, nothing to refuse");
  assert.equal(
    senderOverrideRefusal(offerEmail(offerFrom), "phoenix@send2.satopharma.com", "Resend account 2")?.outcome,
    "failover",
    "an offer is never re-addressed to another account's own mailbox",
  );
  assert.equal(
    senderOverrideRefusal(offerEmail(offerFrom), notificationFrom, "Brevo")?.outcome,
    "failover",
    "an offer is never re-branded as Phoenix Workforce",
  );
  assert.equal(
    senderOverrideRefusal(offerEmail(offerFrom), "hr@send.satopharma.com", "Resend account 2"),
    null,
    "the owner's other mailbox is not a violation",
  );
  assert.equal(
    senderOverrideRefusal(offerEmail(notificationFrom), "phoenix@send2.satopharma.com", "Resend account 2"),
    null,
    "a Phoenix notification still takes the backup account's own sender",
  );
  assert.equal(
    applySenderOverride(notificationFrom, "phoenix@send3.satopharma.com"),
    "Phoenix Workforce <phoenix@send3.satopharma.com>",
    "the override itself is unchanged for everything that is not an offer",
  );

  // And the same decision made by the REAL provider objects, with the real production values: the
  // account declines the offer before it reaches the network, so `fetch` is never called.
  const savedFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("a provider must not reach the network for an offer it cannot send as HR");
  }) as typeof globalThis.fetch;
  try {
    await withEnvAsync(
      {
        BREVO_API_KEY: "test-brevo-key",
        BREVO_EMAIL_FROM: notificationFrom,
        EMAIL_FAILOVER_ENABLED: undefined,
      },
      async () => {
        const providers = resolveEmailProviders();
        // The only backup since 2026-11-06 is Brevo (one Resend, one Brevo — email-providers.ts).
        for (const name of ["brevo"]) {
          const provider = providers.find((candidate) => candidate.name === name);
          assert.ok(provider, `${name} must be in the chain for this assertion to mean anything`);
          const result = await provider.send(offerEmail(offerFrom));
          assert.equal(result.outcome, "failover", `${name} must decline a job offer it would have to re-address`);
        }
        assert.equal(fetchCalls, 0, "no backup account may put an offer on the wire under its own address");
      },
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
}
