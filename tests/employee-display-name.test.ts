import { strict as assert } from "node:assert";

import { formatEmployeeDisplayName } from "../src/lib/utils.ts";

export function runEmployeeDisplayNameTests() {
  assert.equal(formatEmployeeDisplayName("Ali Mohamed Hassan", "Employee"), "Ali Mohamed Hassan");
  assert.equal(formatEmployeeDisplayName("Yehya Mohamed Kamal eldeeen Saad", "Employee"), "Yehya Mohamed Kamal eldeeen Saad");
  assert.equal(formatEmployeeDisplayName("  Mahmoud   Mohamed   Hassan Eltanany  ", "Employee"), "Mahmoud Mohamed Hassan Eltanany");
  assert.equal(formatEmployeeDisplayName("", "Employee"), "Employee");
  assert.equal(formatEmployeeDisplayName(null, "Not available"), "Not available");
}
