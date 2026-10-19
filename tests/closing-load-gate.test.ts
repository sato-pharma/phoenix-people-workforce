import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createClosingLoadGate } from "../src/lib/sales/closing-load-gate.ts";
import { stripComments } from "./support/comment-strip.ts";

// A burst of closing loads must not reach the database all at once, and one reader's matrix must
// never be changed by another's. Production, 19 Oct 2026, 15:18:50 Cairo.

type Parts = { rows: number[] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((done) => setImmediate(done));

export async function runClosingLoadGateTests() {
  // 1. No more than maxConcurrent loads are ever in the database at once, and none is lost.
  {
    let active = 0;
    let peak = 0;
    let started = 0;
    const gates = Array.from({ length: 9 }, () => deferred());
    const gate = createClosingLoadGate<Parts>({
      maxConcurrent: 3,
      load: async (input) => {
        const at = started++;
        active += 1;
        peak = Math.max(peak, active);
        await gates[at].promise;
        active -= 1;
        return { rows: [Number(input?.period?.slice(-2))] };
      },
    });
    const results = Array.from({ length: 9 }, (_, i) => gate.load({ line: "CNS", period: `2026-0${i + 1}` }));
    await tick();
    assert.equal(active, 3, "nine different loads asked at once: only three may be reading");
    for (const g of gates) {
      g.resolve();
      await tick();
    }
    const done = await Promise.all(results);
    assert.equal(peak, 3, "the peak number of reads in flight must never pass the cap");
    assert.deepEqual(done.map((r) => r.rows[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9], "every waiting load gets its own answer");
    assert.equal(gate.pending(), 0, "nothing is left running or waiting");
  }

  // 2. The same line and month asked for while it loads is read once; the trimmed key matches.
  {
    let reads = 0;
    const hold = deferred();
    const gate = createClosingLoadGate<Parts>({
      maxConcurrent: 4,
      load: async () => {
        reads += 1;
        await hold.promise;
        return { rows: [1] };
      },
    });
    const asks = [
      gate.load({ line: "Pedia", period: "2026-09" }),
      gate.load({ line: " Pedia ", period: "2026-09" }),
      gate.load({ line: "Pedia", period: "2026-09" }),
    ];
    await tick();
    hold.resolve();
    await Promise.all(asks);
    assert.equal(reads, 1, "three people opening the same closing must cost one read");
    await gate.load({ line: "Pedia", period: "2026-08" });
    assert.equal(reads, 2, "another month is its own read");
  }

  // 3. Every caller gets its own copy: changing one never reaches another, nor the next reader.
  {
    const gate = createClosingLoadGate<Parts>({ maxConcurrent: 2, load: async () => ({ rows: [1, 2] }) });
    const [first, second] = await Promise.all([
      gate.load({ line: "CNS", period: "2026-09" }, { reuseMs: 5000 }),
      gate.load({ line: "CNS", period: "2026-09" }, { reuseMs: 5000 }),
    ]);
    first.rows.push(99);
    assert.deepEqual(second.rows, [1, 2], "a matrix one caller changed must not change another caller's");
    const later = await gate.load({ line: "CNS", period: "2026-09" }, { reuseMs: 5000 });
    assert.deepEqual(later.rows, [1, 2], "nor the copy kept for the next reader");
  }

  // 4. A settled read is reused only by a caller that asks, only within its window.
  {
    let reads = 0;
    let clock = 1_000;
    const gate = createClosingLoadGate<Parts>({
      maxConcurrent: 2,
      now: () => clock,
      load: async () => ({ rows: [++reads] }),
    });
    await gate.load({ line: "CNS", period: "2026-09" });
    const exported = await gate.load({ line: "CNS", period: "2026-09" });
    assert.equal(exported.rows[0], 2, "a caller that does not opt in always reads the database (exports, checks, publishing)");
    clock += 4_000;
    const screen = await gate.load({ line: "CNS", period: "2026-09" }, { reuseMs: 10_000 });
    assert.equal(screen.rows[0], 2, "a screen inside its window takes the settled read");
    clock += 7_000;
    const stale = await gate.load({ line: "CNS", period: "2026-09" }, { reuseMs: 10_000 });
    assert.equal(stale.rows[0], 3, "past the window the database is asked again");
    const fresh = await gate.load({ line: "CNS", period: "2026-09" }, { reuseMs: 0 });
    assert.equal(fresh.rows[0], 4, "Refresh (reuseMs 0) never takes a kept read");
  }

  // 5. A failed read is not kept, and the slot it held is given back.
  {
    let calls = 0;
    const gate = createClosingLoadGate<Parts>({
      maxConcurrent: 1,
      load: async () => {
        calls += 1;
        if (calls === 1) throw new Error("database timed out");
        return { rows: [7] };
      },
    });
    await assert.rejects(gate.load({ line: "CNS", period: "2026-09" }, { reuseMs: 10_000 }), /timed out/);
    const retry = await gate.load({ line: "CNS", period: "2026-09" }, { reuseMs: 10_000 });
    assert.deepEqual(retry.rows, [7], "the next caller asks again and a failure is never replayed");
    assert.equal(gate.pending(), 0, "the failed read gave its slot back");
  }

  // 6. The real loader is behind the gate, and only the screens opt in to reuse.
  {
    const loader = stripComments(readFileSync("src/lib/sales/monthly-closing-with-store-split.ts", "utf8"));
    assert.ok(
      /export function loadMonthlyClosingPartsWithStoreSplit\([\s\S]*?closingLoadGate\.load\(input, options\)/.test(loader),
      "loadMonthlyClosingPartsWithStoreSplit must go through the gate",
    );
    const route = stripComments(readFileSync("app/api/sales/monthly-closing/route.ts", "utf8"));
    assert.ok(
      /reuseMs: searchParams\.get\("fresh"\) === "1" \? 0 : CLOSING_SCREEN_REUSE_MS/.test(route),
      "the screen's feed reuses a recent read unless Refresh sent fresh=1",
    );
    for (const file of [
      "app/api/sales/monthly-closing/export/route.ts",
      "src/lib/sales/closing-export-payload.ts",
      "src/lib/sales/sales-truth-report.ts",
    ]) {
      assert.ok(!/reuseMs/.test(stripComments(readFileSync(file, "utf8"))), `${file} must always read the database`);
    }
  }
}
