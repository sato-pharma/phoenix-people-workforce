import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_NOTIFICATION_ROLE_POLICIES,
  notificationRoleKeys,
} from "../src/lib/notifications/role-recipients.ts";
import {
  ACCEPTED_OFFER_AUDIENCE,
  ACCEPTED_OFFER_CHANNELS,
  acceptedOfferDetails,
  acceptedOfferMessage,
  acceptedOfferTitle,
} from "../src/lib/offers/accepted-offer-alert.ts";

/**
 * A job offer flipping to accepted used to tell nobody, so an accepted offer could sit on a vacant
 * seat unseen. This pins the alert the owner asked for on 2026-10-02: in-app + push + Telegram, to
 * Super Admin and HR Operations, the moment an offer is accepted.
 */
export function runAcceptedOfferAlertTests() {
  // 1 · The audience is registered and defaults to the owner's chosen recipients.
  assert.ok(
    (notificationRoleKeys as readonly string[]).includes("accepted_offer_alert"),
    "accepted_offer_alert must be a registered notification role key",
  );
  const policy = DEFAULT_NOTIFICATION_ROLE_POLICIES.accepted_offer_alert;
  assert.deepEqual(
    policy.roles,
    ["Super Admin", "HR Operations"],
    "the owner's recipients (2026-10-02): Super Admin and HR Operations",
  );
  assert.equal(policy.enabled, true, "the alert ships enabled");
  assert.equal(ACCEPTED_OFFER_AUDIENCE, "accepted_offer_alert", "the helper reads the same audience key");

  // 2 · Channels — in-app, push and Telegram (the owner added Telegram); never email.
  assert.deepEqual(
    [...ACCEPTED_OFFER_CHANNELS],
    ["in_app", "push", "telegram"],
    "in-app + push + Telegram, in that order",
  );
  assert.ok(!(ACCEPTED_OFFER_CHANNELS as readonly string[]).includes("email"), "never email");

  // 3 · The notice names the candidate, the role, the start date, and what to do.
  const offer = {
    candidateName: "El Sayed Rady",
    reference: "SP-HR-MR-2026-031",
    startDate: "01 October 2026",
    title: "Medical Representative",
  };
  assert.equal(acceptedOfferTitle(offer), "Offer accepted — ready to hire: El Sayed Rady");
  const message = acceptedOfferMessage(offer);
  assert.ok(message.includes("El Sayed Rady"), "the body names the candidate");
  assert.ok(message.includes("Medical Representative"), "and the role");
  assert.ok(message.includes("01 October 2026"), "and the start date");
  assert.ok(message.includes("organogram"), "and says where to seat them");
  assert.deepEqual(
    acceptedOfferDetails(offer).map((d) => d.label),
    ["Candidate", "Role", "Start date", "Offer reference"],
    "the detail rows a reader scans",
  );
  // A missing start date drops the clause rather than printing a dangling comma.
  assert.ok(
    !acceptedOfferMessage({ ...offer, startDate: "" }).includes(", starting"),
    "no start date, no 'starting' clause",
  );

  // 4 · It is wired into the one accept chokepoint, and swallows its own failures.
  const service = readFileSync("src/lib/offers/service.ts", "utf8");
  assert.ok(
    /if \(offer\.status === "accepted"\)\s*\{\s*await announceAcceptedOffer\(offer\);/.test(service),
    "setOfferStatus must fire the alert when (and only when) the new status is accepted",
  );
  const alert = readFileSync("src/lib/offers/accepted-offer-alert.ts", "utf8");
  assert.ok(/logNotificationSendFailure/.test(alert), "the announce helper swallows its own send failures");
  assert.ok(
    /idempotencyKey: `accepted-offer:\$\{offerId\}`/.test(alert),
    "one alert per offer — the idempotency key carries no date, so a re-save is not a second alert",
  );

  // 5 · The migration that makes the policy editable lists the new key and seeds the recipients.
  const migration = readFileSync(
    "supabase/migrations/20261002220322_notification_role_policies_accepted_offer_key.sql",
    "utf8",
  );
  assert.ok(migration.includes("'accepted_offer_alert'"), "the CHECK rebuild carries the new key");
  assert.ok(
    /array\['Super Admin', 'HR Operations'\], true/.test(migration),
    "and seeds the owner's recipients, matching the code default",
  );
}
