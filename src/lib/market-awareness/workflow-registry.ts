import type { MarketAwarenessTransition } from "@/lib/market-awareness/workflow";
import { marketAwarenessWorkflowRegistryModuleKey } from "@/lib/market-awareness/workflow";
import {
  assertRegistryAgreesWithCodeTransition,
  type WorkflowRegistryModuleLoader,
} from "@/lib/workflow-registry/code-fallback";

/**
 * Market awareness in the workflow registry — module `market_awareness`, seeded as an exact copy of
 * MARKET_AWARENESS_TRANSITIONS by migration 20261113201813 (audit item REC-005).
 *
 * Asked where the service already consults the code table (the CEO step of decideActivity), after
 * findTransition has found the row and before anything is written, so a refusal leaves no trace.
 * The group step's approve is not in either table on purpose (workflow.ts explains why), so it is
 * never asked here. When the registry row is absent or unreadable the code table is the whole rule
 * (code-fallback.ts). Kept out of workflow.ts on purpose: the inbox screens import that file.
 */
export async function assertMarketAwarenessRegistryTransition(input: {
  transition: MarketAwarenessTransition;
  loadModules?: WorkflowRegistryModuleLoader;
}) {
  return assertRegistryAgreesWithCodeTransition({
    actionKey: input.transition.action,
    codeNextStatus: input.transition.to,
    loadModules: input.loadModules,
    moduleKey: marketAwarenessWorkflowRegistryModuleKey,
    status: input.transition.from,
  });
}
