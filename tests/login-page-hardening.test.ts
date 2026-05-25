import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runLoginPageHardeningTests() {
  const loginPage = readFileSync("src/components/auth/premium-login-page.tsx", "utf8");
  const loginRoute = readFileSync("app/api/auth/login/route.ts", "utf8");

  assert.match(loginPage, /const maxLoginIdLength = 120/);
  assert.match(loginPage, /const maxPasswordLength = 1024/);
  assert.match(loginPage, /required\s+type="text"/);
  assert.match(loginPage, /required\s+type=\{showPassword \? "text" : "password"\}/);
  assert.match(loginPage, /maxLength=\{maxLoginIdLength\}/);
  assert.match(loginPage, /maxLength=\{maxPasswordLength\}/);
  assert.match(loginPage, /safeLocalStorageGet/);
  assert.match(loginPage, /safeLocalStorageSet/);
  assert.match(loginPage, /safeLocalStorageRemove/);
  assert.match(loginPage, /type LoginErrorField = "form" \| "loginId" \| "password"/);
  assert.match(loginPage, /aria-invalid=\{loginInvalid\}/);
  assert.match(loginPage, /aria-invalid=\{passwordInvalid\}/);
  assert.match(loginPage, /Need a password link\? Ask your Phoenix admin/);
  assert.doesNotMatch(loginPage, /href="#"/);
  assert.doesNotMatch(loginPage, /onClick=\{\(event\) => event\.preventDefault\(\)\}/);

  assert.match(loginRoute, /parseJsonLoginPayload/);
  assert.match(loginRoute, /Login request body must be a JSON object/);
  assert.match(loginRoute, /Login request body has invalid fields/);
  assert.match(loginRoute, /remember !== undefined && typeof remember !== "boolean"/);
  assert.match(loginRoute, /error: "invalid_request"/);
}
