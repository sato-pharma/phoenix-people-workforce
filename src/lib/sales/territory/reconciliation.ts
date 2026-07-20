const RECONCILE_EPSILON = 0.01;

/**
 * The internal self-reconciliation check (v1 scope — see the module design doc for why
 * cross-system reconciliation against the legacy Sales Queue pipeline is explicitly deferred).
 * Pure and independently unit-tested: compares the service's own brick/pharmacy summation
 * against the RPC's SUM(...) OVER() scope total, computed in the same scan.
 */
export function isReconciled(
  computed: { units: number; value: number },
  scopeTotal: { units: number; value: number },
  epsilon: number = RECONCILE_EPSILON,
): boolean {
  return (
    Math.abs(computed.units - scopeTotal.units) < epsilon &&
    Math.abs(computed.value - scopeTotal.value) < epsilon
  );
}
