import { memoInFlight, type SingleFlightEntry } from "@/lib/crm/ttl-single-flight";

/**
 * The readiness probe's copy of the workflow-registry audit, kept for a minute.
 *
 * WHY. `/api/readyz` is Railway's deploy healthcheck and an unauthenticated public address, and the
 * audit is a full read of `workflow_registry_modules` plus a validation pass over every row. Railway
 * polls the probe through a whole deploy and anyone on the internet can call it in a loop, so each
 * call re-reading the table is load the probe never needed: a module row changes only when an admin
 * edits the registry. One read a minute answers every probe in between.
 *
 * The rules, pinned by `tests/readyz-probe-load.test.ts`:
 *   - a SUCCESSFUL audit is reused for `WORKFLOW_REGISTRY_AUDIT_TTL_MS` (from completion), then read again;
 *   - a FAILED audit is never kept (a cache never keeps a failed read, PR 6476): the next probe reads again;
 *   - callers arriving while the read is in flight share it instead of each starting their own.
 *
 * The rules themselves are `memoInFlight`'s (`src/lib/crm/ttl-single-flight.ts`); this only names the
 * key, the TTL and the one-entry store. `load`, `now` and `store` are injectable for the test.
 */
export const WORKFLOW_REGISTRY_AUDIT_TTL_MS = 60_000;

export type WorkflowRegistryAudit = {
  loaded: string[];
  skipped: Array<{ moduleKey: string; reason: string }>;
};

const auditStore = new Map<string, SingleFlightEntry<WorkflowRegistryAudit>>();

export function cachedWorkflowRegistryAudit(
  load: () => Promise<WorkflowRegistryAudit>,
  now: () => number = Date.now,
  store: Map<string, SingleFlightEntry<WorkflowRegistryAudit>> = auditStore,
): Promise<WorkflowRegistryAudit> {
  return memoInFlight(store, "workflow-registry-audit", WORKFLOW_REGISTRY_AUDIT_TTL_MS, 2, load, now);
}
