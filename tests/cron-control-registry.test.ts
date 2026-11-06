import assert from "node:assert/strict";

import { cronJobRegistry } from "../src/lib/cron-control/job-registry.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

// /api/notifications/process is genuinely cron-secret-gated on GET (see its route.ts), but is
// registered in access-registry.ts as a plain sessionApi entry because the registry has no way
// to express "cron-secret on GET, session on POST" for a dual-auth route. Documented exception
// so this cross-reference test doesn't false-fail on it — see access-registry.ts's own entry
// for /api/notifications/process.
const KNOWN_DUAL_AUTH_EXCEPTIONS = new Set(["/api/notifications/process"]);

export function runCronControlRegistryTests() {
  assert.equal(cronJobRegistry.length, 6, "expected exactly the 6 registered cron routes (the three iReports360 routes were retired with the vendor on 6 November 2026)");

  const seenJobNames = new Set<string>();
  const seenRoutes = new Set<string>();

  for (const entry of cronJobRegistry) {
    assert.ok(!seenJobNames.has(entry.gcpJobName), `duplicate gcpJobName in registry: ${entry.gcpJobName}`);
    seenJobNames.add(entry.gcpJobName);

    assert.ok(!seenRoutes.has(entry.route), `duplicate route in registry: ${entry.route}`);
    seenRoutes.add(entry.route);

    assert.ok(entry.label.length > 0, `${entry.gcpJobName} is missing a label`);
    assert.ok(entry.description.length > 0, `${entry.gcpJobName} is missing a description`);

    if (KNOWN_DUAL_AUTH_EXCEPTIONS.has(entry.route)) continue;

    const registryEntry = findAccessRegistryEntry(entry.route, "GET");
    assert.ok(registryEntry, `${entry.route} (job "${entry.gcpJobName}") has no access-registry.ts entry at all`);
    assert.equal(
      registryEntry?.authMode,
      "cron-secret",
      `${entry.route} (job "${entry.gcpJobName}") is not registered as authMode:"cron-secret" — either the job registry drifted from the real route, or the route's own auth changed`,
    );
  }
}
