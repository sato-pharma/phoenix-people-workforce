import assert from "node:assert/strict";
import { computeNewlyArrivedIds } from "../src/lib/error-monitor/new-issue-diff.ts";

export function runErrorMonitorNewIssueDiffTests() {
  // No baseline yet (e.g. before the first poll response) — never treat this as "all new".
  assert.deepEqual(computeNewlyArrivedIds(null, ["a", "b", "c"]), []);
  assert.deepEqual(computeNewlyArrivedIds(null, []), []);

  // Baseline present, nothing new.
  assert.deepEqual(computeNewlyArrivedIds(new Set(["a", "b"]), ["a", "b"]), []);
  assert.deepEqual(computeNewlyArrivedIds(new Set(["a", "b"]), ["b", "a"]), []);

  // Baseline present, some new ids.
  assert.deepEqual(computeNewlyArrivedIds(new Set(["a"]), ["a", "b"]), ["b"]);
  assert.deepEqual(computeNewlyArrivedIds(new Set([]), ["a", "b", "c"]), ["a", "b", "c"]);

  // Ids that disappeared from the current set are simply absent from the result, not an error.
  assert.deepEqual(computeNewlyArrivedIds(new Set(["a", "b", "c"]), ["b"]), []);
}
