/**
 * Workflow Control Center — Phase 3C feature flags.
 *
 * Every persistence-related capability is OFF until the Phase 3B migration is
 * explicitly applied via the staged approval pipeline.
 */

export const WORKFLOW_CONTROL_PERSISTENCE_ENABLED = false;
export const WORKFLOW_CONTROL_PUBLISH_ENABLED = false;
export const WORKFLOW_CONTROL_ROLLBACK_ENABLED = false;

export const WORKFLOW_CONTROL_DISABLED_MESSAGE =
  "Workflow persistence is disabled until Phase 3 migration is applied.";

export const WORKFLOW_CONTROL_PUBLISH_DISABLED_MESSAGE =
  "Workflow publish is disabled until Phase 3 versioning and approval are enabled.";

export const WORKFLOW_CONTROL_ROLLBACK_DISABLED_MESSAGE =
  "Workflow rollback is disabled until Phase 3 versioning and approval are enabled.";
