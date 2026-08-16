// Master Map — prove the feed the Google Sheet pulls actually reassembles.
//
//   pnpm run master-map:check-feed
//
// Read-only against Supabase, writes nothing anywhere. This exercises the same code path the Apps
// Script uses — stamp, plan, then slice by slice — and checks the one property that matters and
// that no unit test can cover: that the slices a tab is delivered in add back up to exactly the
// tab, with nothing dropped at a chunk boundary and nothing repeated.

import { getMasterMapPlan, getMasterMapSlice } from "@/lib/sales/master-map/payload";
import { readMasterMapStamp } from "@/lib/sales/master-map/fingerprint";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function collectTab(title: string, stamp: string) {
  const clear = await getMasterMapSlice({ chunk: 0, part: "clear", sheetId: 1, stamp, title });
  if (!clear || clear.part !== "clear") fail(`${title}: no clear slice`);

  const values: string[][] = [];
  for (let chunk = 0; ; chunk += 1) {
    const slice = await getMasterMapSlice({ chunk, part: "values", sheetId: 1, stamp, title });
    if (!slice || slice.part !== "values") fail(`${title}: values slice ${chunk} missing`);
    if (slice.restart) fail(`${title}: source moved mid-check`);
    if (slice.values.length === 0) break;
    if (slice.startRow !== values.length) {
      fail(`${title}: chunk ${chunk} starts at row ${slice.startRow}, expected ${values.length}`);
    }
    values.push(...slice.values);
  }

  const requests: unknown[] = [];
  for (let chunk = 0; ; chunk += 1) {
    const slice = await getMasterMapSlice({ chunk, part: "requests", sheetId: 1, stamp, title });
    if (!slice || slice.part !== "requests") fail(`${title}: requests slice ${chunk} missing`);
    if (slice.requests.length === 0) break;
    requests.push(...slice.requests);
  }

  return { clearCount: clear.requests.length, requests, values };
}

async function main(): Promise<void> {
  const started = Date.now();

  const stamp = await readMasterMapStamp();
  if (!stamp) fail("the change stamp came back empty");
  console.log(`stamp        : ${stamp}`);

  const plan = await getMasterMapPlan();
  console.log(`plan stamp   : ${plan.stamp}`);
  console.log(`tabs         : ${plan.tabs.length}`);
  console.log("");
  console.log("tab                        rows   value chunks   request chunks   hash");
  for (const tab of plan.tabs) {
    console.log(
      `${tab.title.padEnd(24)} ${String(tab.rows).padStart(6)} ${String(tab.valueChunks).padStart(14)} ` +
        `${String(tab.requestChunks).padStart(16)}   ${tab.hash}`,
    );
  }

  // The stamp must be stable while nothing changes, or the sheet would repaint on every tick.
  const second = await getMasterMapPlan();
  if (second.stamp !== plan.stamp) fail("two plans in a row disagreed about the stamp");
  for (const tab of plan.tabs) {
    const other = second.tabs.find((candidate) => candidate.title === tab.title);
    if (!other || other.hash !== tab.hash) fail(`${tab.title}: hash is not stable between plans`);
  }
  console.log("\nhashes are stable across two plans — an unchanged database repaints nothing");

  // Reassemble the biggest tab and the flat one; those are where a boundary bug would hide.
  for (const title of [plan.tabs[0].title, plan.tabs[1].title]) {
    const expected = plan.tabs.find((tab) => tab.title === title);
    if (!expected) fail(`${title}: not in the plan`);
    const collected = await collectTab(title, plan.stamp);
    if (collected.values.length !== expected.rows) {
      fail(`${title}: reassembled ${collected.values.length} rows, plan said ${expected.rows}`);
    }
    console.log(
      `\n${title}: ${collected.values.length} rows reassembled from ${expected.valueChunks} chunks, ` +
        `${collected.clearCount} clear + ${collected.requests.length} formatting requests`,
    );
    console.log(`  first row : ${collected.values[0].filter(Boolean).join(" | ")}`);
    console.log(`  last row  : ${collected.values[collected.values.length - 1].filter(Boolean).join(" | ")}`);
  }

  console.log(`\nOK — the feed reassembles exactly. ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
