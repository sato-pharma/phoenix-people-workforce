import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { PDFJS_BROWSER_POLYFILL, PDFJS_POLYFILLED_BUILTINS } from "../scripts/pdfjs-browser-polyfill.mjs";

/**
 * "e is not async iterable."
 *
 * Five rows in app_error_events, 2026-09-24 → 26, on /employee-portals/recruitment-candidates:
 * District and Regional Managers on iPhones (Safari and Chrome, iOS 18.7 and 26.6) and on Samsung
 * Internet 20 / Android 12, every one of them from PDFPageProxy.getTextContent — the CV preview's
 * phone-redaction pass. Same message on WebKit, "undefined is not a function (near '...t of e...')"
 * where the engine words it differently. It began with #4318, the move to pdfjs-dist 6.3.289.
 *
 * WHY THE EXISTING GUARDS COULD NOT SEE IT. pdf.js 6 drains its own text stream with
 * `for await (const chunk of readableStream)`, and ReadableStream async iteration
 * (ReadableStream.prototype[Symbol.asyncIterator]) is missing from every Safari and from Chromium
 * before 124. core-js has never polyfilled it, so the 2026-09-23 "every risky built-in the vendor
 * CALLS is defined by somebody" check — which reads method-call patterns — had nothing to match:
 * the call site is a language construct, not a method name.
 *
 * TWO THINGS ARE HELD HERE.
 *
 * 1 · THE POLYFILL REALLY MAKES `for await` OVER A STREAM WORK, run for real in a realm where the
 *     iterator is genuinely absent — which is what those phones are, from the code's point of view.
 *     Node has it natively, so the deletion below is what stops this file testing nothing.
 *
 * 2 · AND THE REDACTION PASS FAILS TOWARDS HIDING. The polyfill is the fix, but the pass that broke
 *     is the one that paints over phone numbers, and it reads the text AFTER the page is drawn. A
 *     text read that throws means the numbers were never found while the canvas already carries
 *     them, so the page must be covered whole rather than shown. Before this it threw out of the
 *     loop; a future one must not be allowed to fall through and show the page instead.
 */
export async function runCvPreviewAsyncIterationTests() {
  // ── 1 · The polyfill, on a browser that cannot iterate a stream ───────────────────────────────
  //
  // Node's own ReadableStream is handed to the realm rather than a stand-in, so what runs is the
  // real Streams implementation with only the iterator taken away. That means deleting the iterator
  // from the SHARED prototype (well-known symbols are the same across realms), so the native
  // descriptor is captured first and put back in the `finally` below — the rest of the suite runs
  // after this file.
  const nativeIterator = Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator);
  assert.ok(
    nativeIterator && typeof nativeIterator.value === "function",
    "this Node build has no ReadableStream async iterator, so deleting it proves nothing",
  );

  try {
    const old = vm.createContext({ ReadableStream });
    // A stream of three chunks, exactly the shape pdf.js's getTextContent drains.
    const makeStream = `(() => { let n = 0; return new ReadableStream({ pull(controller) {
         n += 1;
         if (n > 3) { controller.close(); return; }
         controller.enqueue("chunk " + n);
       } }); })()`;

    delete (ReadableStream.prototype as unknown as Record<symbol, unknown>)[Symbol.asyncIterator];
    const before = vm.runInContext(
      `typeof ReadableStream.prototype[Symbol.asyncIterator]`,
      old,
    ) as string;
    assert.equal(before, "undefined", "the old-browser realm still had the stream async iterator");

    // The failure itself, reproduced: this is the production row, in this process.
    const withoutPolyfill = (await vm.runInContext(
      `(async () => {
         try {
           for await (const chunk of ${makeStream}) { void chunk; }
           return "iterated";
         } catch (error) { return error.constructor.name + ": " + error.message; }
       })()`,
      old,
    )) as string;
    assert.ok(
      withoutPolyfill.startsWith("TypeError"),
      `an un-polyfilled realm must fail to iterate a stream — that failure is the defect being fixed, got: ${withoutPolyfill}`,
    );

    vm.runInContext(PDFJS_BROWSER_POLYFILL, old);

    // Caught inside the realm, so a missing iterator reads as this file's own assertion rather than
    // as a raw TypeError out of the harness.
    const iterated = (await vm.runInContext(
      `(async () => {
         try {
           const seen = [];
           for await (const chunk of ${makeStream}) seen.push(chunk);
           return seen.join(",");
         } catch (error) { return "threw: " + error.message; }
       })()`,
      old,
    )) as string;
    assert.equal(
      iterated,
      "chunk 1,chunk 2,chunk 3",
      "the polyfill did not make `for await` over a ReadableStream work — getTextContent still throws and every redacted CV fails on an iPhone",
    );

    // The lock is released at the end, so the same stream can be read again afterwards. pdf.js reads
    // a page's text and then hands the page on; a stream left locked breaks the next reader.
    const released = (await vm.runInContext(
      `(async () => {
         const stream = ${makeStream};
         for await (const chunk of stream) { void chunk; }
         try { stream.getReader(); return "released"; } catch (error) { return "still locked"; }
       })()`,
      old,
    )) as string;
    assert.equal(released, "released", "the iterator must release its reader when the stream ends");

    // An early exit CANCELS, as the specification says — otherwise a `break` (or a throw inside the
    // loop) leaves the producer running and the stream locked forever.
    const cancelled = (await vm.runInContext(
      `(async () => {
         let cancelledWith = "not cancelled";
         const stream = new ReadableStream({
           pull(controller) { controller.enqueue("x"); },
           cancel(reason) { cancelledWith = "cancelled: " + reason; },
         });
         for await (const chunk of stream) { void chunk; break; }
         let locked = "unlocked";
         try { stream.getReader(); } catch (error) { locked = "locked"; }
         return cancelledWith + " / " + locked;
       })()`,
      old,
    )) as string;
    assert.equal(
      cancelled,
      "cancelled: undefined / unlocked",
      "breaking out of the loop must cancel the stream and release the reader",
    );

    // `.values({ preventCancel: true })` is the other half of the specification's surface, and the
    // one a caller uses to keep reading a stream it stopped iterating.
    const prevented = (await vm.runInContext(
      `(async () => {
         let cancelled = false;
         const stream = new ReadableStream({
           pull(controller) { controller.enqueue("y"); },
           cancel() { cancelled = true; },
         });
         for await (const chunk of stream.values({ preventCancel: true })) { void chunk; break; }
         return cancelled ? "cancelled" : "kept";
       })()`,
      old,
    )) as string;
    assert.equal(prevented, "kept", "values({ preventCancel: true }) must not cancel the stream");

    const descriptor = vm.runInContext(
      `(() => {
         const d = Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator);
         return { enumerable: d.enumerable, writable: d.writable, configurable: d.configurable,
                  values: typeof ReadableStream.prototype.values };
       })()`,
      old,
    ) as Record<string, unknown>;
    assert.equal(descriptor.enumerable, false, "the stream iterator must not be enumerable, like the native one");
    assert.equal(descriptor.writable, true, "the stream iterator must stay writable");
    assert.equal(descriptor.configurable, true, "the stream iterator must stay configurable");
    assert.equal(descriptor.values, "function", "the polyfill must install .values() beside the symbol");

    // ── A MODERN BROWSER IS LEFT ALONE ──────────────────────────────────────────────────────────
    Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, nativeIterator);
    const modern = vm.createContext({ ReadableStream });
    vm.runInContext(`globalThis.__native = ReadableStream.prototype[Symbol.asyncIterator];`, modern);
    vm.runInContext(PDFJS_BROWSER_POLYFILL, modern);
    assert.equal(
      vm.runInContext(`ReadableStream.prototype[Symbol.asyncIterator] === globalThis.__native`, modern),
      true,
      "the polyfill replaced a native ReadableStream async iterator instead of standing aside",
    );
  } finally {
    // Whatever happened above, this process gets its own iterator back.
    Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, nativeIterator);
  }
  assert.equal(
    typeof (ReadableStream.prototype as unknown as Record<symbol, unknown>)[Symbol.asyncIterator],
    "function",
    "the native stream iterator was not restored — every later test in this suite would run on the polyfill",
  );

  // And the coverage list names it, so tests/pdfjs-legacy-browser-assets.test.ts accepts a vendor
  // build that uses `for await` as covered rather than as a fresh gap.
  assert.ok(
    PDFJS_POLYFILLED_BUILTINS.includes("ReadableStream.prototype[Symbol.asyncIterator]"),
    "the polyfill's declared coverage must name the stream iterator",
  );

  // ── 2 · The redaction pass fails towards hiding ────────────────────────────────────────────────
  //
  // Read as source, because what is being pinned is the SHAPE of a failure path inside a React
  // effect: that a throw from the text read cannot end with the page on screen. The pure redaction
  // logic is covered by tests/cv-phone-redaction.test.ts; this is the branch that has no logic.
  const viewer = readFileSync(
    fileURLToPath(new URL("../src/components/recruitment/cv-preview-modal.tsx", import.meta.url)),
    "utf8",
  );

  const guarded = /try \{\s*content = await page\.getTextContent\(\);\s*\} catch \([A-Za-z]+\) \{/.exec(viewer);
  assert.ok(
    guarded,
    "the redaction pass must wrap page.getTextContent() in its own try — an unguarded throw took the whole CV down on every iPhone, and a later pdf.js could do it again",
  );
  // The handler is everything between that catch and the loop that does the ordinary covering.
  const loopAt = viewer.indexOf("if (context && content) {", guarded.index);
  assert.ok(loopAt > guarded.index, "the covering loop must follow the guarded read");
  const handler = viewer.slice(guarded.index + guarded[0].length, loopAt);
  assert.ok(
    /context\.fillRect\(0, 0, canvas\.width, canvas\.height\)/.test(handler),
    "a failed text read must cover the WHOLE page: the canvas is already painted with the numbers on it, and nothing found them",
  );
  assert.ok(
    /stage: "redaction"/.test(handler),
    "and must be reported under its own stage, or a page silently going blank looks like a rendering quirk",
  );
  assert.ok(
    viewer.includes("if (context && content) {"),
    "the redaction loop must require the text it reads — a null content falling through would skip the covering entirely",
  );
  // The order matters: covering the canvas after it is in the document would show the numbers first.
  const coverAt = viewer.indexOf("context.fillRect(0, 0, canvas.width, canvas.height)");
  const appendAt = viewer.indexOf("pageBox.appendChild(canvas)");
  assert.ok(
    coverAt > 0 && appendAt > coverAt,
    "the page must be covered BEFORE it is put in the document, never after the reader can already see it",
  );
}
