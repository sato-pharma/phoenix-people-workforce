import assert from "node:assert/strict";

import { cronJobRegistry } from "../src/lib/cron-control/job-registry.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

// /api/notifications/process has two doors: the scheduler's GET (cron secret) and the admin's POST
// (session). Until 13 Nov 2026 the register held ONE session row for both, and this test stepped
// around it with a named exception. The register now holds a row per door (integration audit,
// ISS-028), so the exception list is empty and must stay empty: a scheduled route whose GET is not
// registered cron-secret is a wrong row, never a special case.
const KNOWN_DUAL_AUTH_EXCEPTIONS = new Set<string>();

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

    assert.equal(KNOWN_DUAL_AUTH_EXCEPTIONS.size, 0, "the dual-auth exception list stays empty — give the route a row per door instead");

    const registryEntry = findAccessRegistryEntry(entry.route, "GET");
    assert.ok(registryEntry, `${entry.route} (job "${entry.gcpJobName}") has no access-registry.ts entry at all`);
    assert.equal(
      registryEntry?.authMode,
      "cron-secret",
      `${entry.route} (job "${entry.gcpJobName}") is not registered as authMode:"cron-secret" — either the job registry drifted from the real route, or the route's own auth changed`,
    );
  }
}
