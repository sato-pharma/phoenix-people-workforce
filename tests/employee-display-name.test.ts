import { strict as assert } from "node:assert";

import { formatEmployeeDisplayName } from "../src/lib/utils.ts";

export function runEmployeeDisplayNameTests() {
  assert.equal(formatEmployeeDisplayName("Ali Mohamed Hassan", "Employee", 2), "Ali Mohamed Hassan");
  assert.equal(formatEmployeeDisplayName("Yehya Mohamed Kamal eldeeen Saad", "Employee", 3), "Yehya Mohamed Kamal eldeeen Saad");
  assert.equal(formatEmployeeDisplayName("  Mahmoud   Mohamed   Hassan Eltanany  ", "Employee", 2), "Mahmoud Mohamed Hassan Eltanany");
  assert.equal(formatEmployeeDisplayName("", "Employee", 2), "Employee");
  assert.equal(formatEmployeeDisplayName(null, "Not available", 3), "Not available");
}
