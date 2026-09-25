---
name: pgrst202-missing-function-reads-as-missing-schema
description: "A missing PostgREST FUNCTION (PGRST202) matches this repo's isCrmSchemaMissingError, so an unapplied RPC silently degrades to \"mirror not provisioned\" and returns empty"
metadata: 
  node_type: memory
  type: project
  originSessionId: 38eae9aa-ef0c-45e5-83a4-33adebd6fb63
  modified: 2026-08-08T21:27:34.923Z
---

PostgREST reports a missing RPC as **`PGRST202 "Could not find the function public.<fn>(<args>) in
the schema cache"`**. The phrase *schema cache* is one of the patterns
`isCrmSchemaMissingError` (`src/lib/crm/schema.ts`) matches — so a **missing FUNCTION is
indistinguishable from a missing MIRROR TABLE** to that detector, and every CRM read that degrades
gracefully on "not provisioned yet" will silently return **empty** instead.

Confirmed live 2026-08-09 while adding `phx_crm_agent_crm_ids_for_hr_ids`
([[crm-live-departed-agent-exclusion]]): the error string above really does satisfy
`isCrmSchemaMissingError`, and the regression test in `tests/crm-departed-agent-scan.test.ts`
asserts that collision on purpose so nobody "fixes" it later.

**Why:** the two failure modes want opposite handling. A missing table means the module genuinely
is not set up — empty is honest. A missing function means the migration has not been applied *here*
(fresh clone, staging before it lands, a rollback) while the data is fully present — empty is a
lie, and for the departed-agent exclusion it means **every departed rep reappears** across Double
Visit Analytics, Field Workforce Compliance, probation DV credit, and the FWC connector behind
automated payroll's no-activity deduction detector. Nothing throws; the list just gets shorter.
Compounded by [[railway-deploy-applies-no-migrations]] — the deploy applies nothing, so the
unapplied window is real, not hypothetical.

**How to apply:** whenever you add an RPC that a graceful-degradation path calls, test
**missing-function BEFORE missing-schema**, and fall back to the pre-RPC implementation rather than
to empty. Match on `code === "PGRST202"` (or `42883` direct-to-Postgres) first, not on the message
text. The shipped shape is `isMissingCrmRpcError` in `src/lib/crm/reads.ts`. Prove it by swapping
the two checks — the fallback test fails with `actual: []`, which is exactly what production would
have done. The same trap applies to any other module with its own `is<X>SchemaMissingError`-style
matcher that keys off "does not exist" / "schema cache".
