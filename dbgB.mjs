import { chromium } from "playwright";
const b = await chromium.launch();
const c = await b.newContext({ viewport:{width:1920,height:1080}, extraHTTPHeaders:{"x-phoenix-role":"Finance Manager","x-phoenix-hr-id":"B-185"} });
const p = await c.newPage();
await p.goto("http://127.0.0.1:3020/admin/automated-payroll/finance", { waitUntil:"load", timeout:180000 });
await p.waitForTimeout(2500);
const btn = p.getByRole("button", { name: /Check/ });
console.log("btn text before:", await btn.textContent());
await btn.click();
// read immediately, several times, in case it flips fast
for (let i = 0; i < 5; i++) {
  console.log(`  +${i*100}ms:`, await btn.textContent());
  await p.waitForTimeout(100);
}
