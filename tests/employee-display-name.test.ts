import { strict as assert } from "node:assert";

import { formatEmployeeDisplayName } from "../src/lib/utils";

export function runEmployeeDisplayNameTests() {
  assert.equal(formatEmployeeDisplayName("Ali Mohamed Hassan", "Employee", 2), "Ali Mohamed");
  assert.equal(formatEmployeeDisplayName("Yehya Mohamed Kamal eldeeen Saad", "Employee", 3), "Yehya Mohamed Kamal");
  assert.equal(formatEmployeeDisplayName("", "Employee", 2), "Employee");
  assert.equal(formatEmployeeDisplayName(null, "Not available", 3), "Not available");
}
