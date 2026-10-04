import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { asyncPool } from "../src/lib/utils/async-pool.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * PERF-020 (2026-10-04) — the Business Review's customer-grain load runs at most FOUR
 * `phx_closing_customers` calls at once.
 *
 * It used to start one call per (line, month) all together: a three-line pack over six months opened
 * eighteen pooler connections in one go, so a few managers exporting at once could exhaust Supavisor.
 * The fix bounds it with asyncPool. Two properties make that safe and are pinned here as behaviour,
 * because the swap is only correct if they hold: the results come back in INPUT order (the rows are
 * labelled with the line and month they were read for), and a single failed month still fails the
 * whole load, exactly as the unbounded Promise.all did — a pack must never ship missing a month.
 */

const SOURCE = "src/lib/business-review/sources/closing-detail.ts";

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in ${SOURCE}`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

export async function runBusinessReviewClosingDetailBoundedFanoutTests() {
  // ── 1. The loader goes through asyncPool with a constant of at most 4 ─────────────
  {
    const source = stripComments(readFileSync(SOURCE, "utf8"));
    const body = functionBody(source, "loadClosingDetailFacts");

    assert.ok(
      !/Promise\.all\(\s*jobs\.map\(/.test(body),
      "loadClosingDetailFacts must not fan every (line, month) out at once with Promise.all(jobs.map(...)) — that is the unbounded read PERF-020 removed",
    );
    const call = /asyncPool\(\s*([A-Z_][A-Z0-9_]*)\s*,\s*jobs\s*,/.exec(body);
    assert.ok(call, "loadClosingDetailFacts must read the jobs through asyncPool(<CONSTANT>, jobs, ...)");
    const constantName = call![1];
    const declared = new RegExp(`const ${constantName}\\s*=\\s*(\\d+)\\s*;`).exec(source);
    assert.ok(declared, `the concurrency ${constantName} must be a plain numeric constant in ${SOURCE}`);
    const limit = Number(declared![1]);
    assert.ok(
      limit >= 1 && limit <= 4,
      `the closing-detail fan-out must hold at most 4 calls in flight (the vs-target budget), found ${limit}`,
    );
    assert.match(
      source,
      /import \{ asyncPool \} from "@\/lib\/utils\/async-pool";/,
      "the bound must be the shared asyncPool, not a hand-rolled one",
    );
  }

  // ── 2. asyncPool keeps input order and never exceeds its bound ────────────────────
  {
    let inFlight = 0;
    let peak = 0;
    const delays = [30, 5, 20, 1, 15, 2, 10, 3];
    const results = await asyncPool(4, delays, async (delay, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delay));
      inFlight -= 1;
      return `job-${index}`;
    });
    assert.deepEqual(
      results,
      delays.map((_delay, index) => `job-${index}`),
      "asyncPool must hand results back in INPUT order whatever order they finish in — the rows are labelled by position",
    );
    assert.ok(peak <= 4, `asyncPool(4, ...) must never run more than 4 at once (peak ${peak})`);
  }

  // ── 3. One failed month rejects the whole load, and nothing new starts after it ───
  {
    const started: number[] = [];
    let rejected: unknown = null;
    try {
      await asyncPool(1, [0, 1, 2, 3], async (item) => {
        started.push(item);
        if (item === 1) throw new Error("month 1 failed");
        return item;
      });
    } catch (error) {
      rejected = error;
    }
    assert.ok(
      rejected instanceof Error && rejected.message === "month 1 failed",
      "a failed phx_closing_customers call must still reject the whole load, as Promise.all did",
    );
    assert.deepEqual(started, [0, 1], "asyncPool must start no new call once one has failed");
  }
}
