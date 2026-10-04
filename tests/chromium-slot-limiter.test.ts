import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ChromiumBusyError,
  ChromiumUnavailableError,
  createSlotLimiter,
  withChromiumSlot,
} from "@/lib/pdf/chromium";
import { stripComments } from "./support/comment-strip.ts";

/**
 * PERF-005 — at most two headless Chromium browsers render documents at once.
 *
 * Every `withChromiumPage` call launches a whole browser, and nothing bounded how many ran at
 * once, so a burst of exports launched one per click on the single production container until it
 * ran out of memory. `createSlotLimiter` is the bound: FIFO waiters, a slot always given back even
 * when the render throws, and a waiter that gives up is removed before it rejects with
 * ChromiumBusyError — which IS a ChromiumUnavailableError, so every caller's existing "no PDF"
 * degradation covers "the renderer is busy" too.
 */
export async function runChromiumSlotLimiterTests() {
  const tick = () => new Promise<void>((done) => setTimeout(done, 0));
  // Far shorter than any waitMs below, so a missing grant reads as null rather than as a busy timeout.
  const settleSoon = () => new Promise<null>((done) => setTimeout(() => done(null), 5));

  // 1. Two slots: the first two acquire at once, the third WAITS until one is released.
  {
    const limiter = createSlotLimiter(2, 5_000);
    const releaseA = await limiter.acquire();
    const releaseB = await limiter.acquire();
    let thirdStarted = false;
    const third = limiter.acquire().then((release) => {
      thirdStarted = true;
      return release;
    });
    await tick();
    assert.equal(thirdStarted, false, "a third acquire must WAIT while both slots are held");
    releaseA();
    const releaseC = await third;
    assert.equal(thirdStarted, true, "the third acquire must start as soon as a slot is released");
    releaseB();
    releaseC();
  }

  // 2. FIFO: waiters are served in arrival order, one per released slot.
  {
    const limiter = createSlotLimiter(1, 5_000);
    const first = await limiter.acquire();
    const order: string[] = [];
    const second = limiter.acquire().then((release) => {
      order.push("second");
      return release;
    });
    const third = limiter.acquire().then((release) => {
      order.push("third");
      return release;
    });
    await tick();
    assert.deepEqual(order, [], "no waiter may start while the only slot is held");
    first();
    // Raced, so a slot handed to the wrong waiter fails HERE with a message instead of waiting out the timeout.
    const releaseSecond = await Promise.race([second, settleSoon()]);
    await tick();
    assert.deepEqual(order, ["second"], "the OLDEST waiter must get the freed slot, and only it");
    assert.ok(releaseSecond !== null, "the oldest waiter must have been granted the freed slot");
    releaseSecond();
    const releaseThird = await third;
    assert.deepEqual(order, ["second", "third"], "waiters must be served first-in, first-out");
    releaseThird();
    // A double release must not mint an extra slot.
    releaseThird();
    const again = await limiter.acquire();
    let extraStarted = false;
    void limiter.acquire().then((release) => {
      extraStarted = true;
      release();
    });
    await tick();
    assert.equal(extraStarted, false, "releasing the same slot twice must not create a second slot");
    again();
    await tick();
    assert.equal(extraStarted, true, "the waiter behind it must still start once the real holder releases");
  }

  // 3. A throwing callback still gives its slot back (withChromiumSlot's finally).
  {
    const holders = await Promise.allSettled([
      withChromiumSlot(async () => {
        throw new Error("render blew up");
      }),
      withChromiumSlot(async () => {
        throw new Error("render blew up too");
      }),
    ]);
    assert.deepEqual(
      holders.map((outcome) => outcome.status),
      ["rejected", "rejected"],
      "the callbacks' own errors must reach their callers",
    );
    // Both process-wide slots must be free again: two more holders start immediately, side by side.
    let running = 0;
    let peak = 0;
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      openGate = done;
    });
    const both = Promise.all([0, 1].map(() =>
      withChromiumSlot(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate;
        running -= 1;
      }),
    ));
    await tick();
    assert.equal(peak, 2, "a callback that throws must still release its slot — both slots must be free afterwards");
    openGate();
    await both;
  }

  // 4. A wait that outlasts waitMs rejects with ChromiumBusyError, a ChromiumUnavailableError, and
  //    is removed from the queue — the slot freed later goes to the NEXT waiter, never to it.
  {
    const limiter = createSlotLimiter(1, 30);
    const held = await limiter.acquire();
    const gaveUp = limiter.acquire();
    const error = await gaveUp.then(
      () => null,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof ChromiumBusyError, "a timed-out wait must reject with ChromiumBusyError");
    assert.ok(
      error instanceof ChromiumUnavailableError,
      "ChromiumBusyError must BE a ChromiumUnavailableError so callers degrade exactly as before",
    );
    assert.equal((error as Error).name, "ChromiumBusyError", "the busy error must name itself");

    let laterStarted = false;
    const later = limiter.acquire().then((release) => {
      laterStarted = true;
      return release;
    });
    held();
    // Raced, so a slot handed to the abandoned waiter fails HERE with a message instead of hanging.
    const releaseLater = await Promise.race([
      later,
      settleSoon(),
    ]);
    assert.ok(
      releaseLater !== null && laterStarted,
      "the slot must go to the waiter still waiting, not to the one that timed out",
    );
    releaseLater();
    const fresh = await Promise.race([
      limiter.acquire(),
      new Promise<null>((done) => setTimeout(() => done(null), 20)),
    ]);
    assert.ok(fresh !== null, "after everyone released, the single slot must be free — a timed-out waiter must not leak it");
    if (fresh) fresh();
  }

  // 5. Source pins: both launch paths go through the limiter, with the close INSIDE the slot.
  const root = process.cwd();
  const chromiumSource = stripComments(readFileSync(resolve(root, "src/lib/pdf/chromium.ts"), "utf8"));
  const pageAt = chromiumSource.indexOf("export async function withChromiumPage");
  assert.notEqual(pageAt, -1, "withChromiumPage must still exist — this pin cannot silently stop checking anything");
  const pageBody = chromiumSource.slice(pageAt);
  assert.match(
    pageBody,
    /return withChromiumSlot\(async \(\) => \{[\s\S]*?puppeteer\.launch\([\s\S]*?finally \{\s*if \(browser\) await browser\.close\(\)/,
    "withChromiumPage must launch AND close its browser inside withChromiumSlot, so the slot is released only after browser.close()",
  );
  assert.match(
    chromiumSource,
    /export const chromiumSlots = createSlotLimiter\(2, 60_000\);/,
    "the process-wide limit must stay at two concurrent browsers with a 60 s wait",
  );

  const offerSource = stripComments(readFileSync(resolve(root, "src/lib/offers/pdf.ts"), "utf8"));
  const offerAt = offerSource.indexOf("export async function renderOfferPdf");
  assert.notEqual(offerAt, -1, "renderOfferPdf must still exist — this pin cannot silently stop checking anything");
  const offerBody = offerSource.slice(offerAt, offerSource.indexOf("export function offerPdfFilename"));
  assert.match(
    offerBody,
    /try \{\s*return await withChromiumSlot\(async \(\) => \{[\s\S]*?puppeteer\.launch\([\s\S]*?finally \{\s*if \(browser\) await browser\.close\(\)[\s\S]*?\} catch \(error\) \{\s*if \(error instanceof OfferPdfUnavailableError\) throw error;\s*throw new OfferPdfUnavailableError/,
    "renderOfferPdf must launch and close inside withChromiumSlot, within the try whose catch turns a busy timeout into OfferPdfUnavailableError",
  );
}
