import assert from "node:assert/strict";
import vm from "node:vm";

import { PDFJS_BROWSER_POLYFILL } from "../scripts/pdfjs-browser-polyfill.mjs";

/**
 * The polyfill prepended into both public/pdfjs files, executed for real.
 *
 * Reading the source proves nothing here — the failure being prevented is a runtime one on a
 * browser this machine does not have. So each case runs the actual polyfill text inside a fresh
 * V8 realm with the built-in DELETED, which is what an older phone browser looks like from the
 * code's point of view, and then uses the result.
 *
 * Node itself has both built-ins, so without the delete every case would pass on the native
 * implementation and the polyfill could be empty. `deletes the built-in first` below is what
 * stops this file quietly testing nothing.
 */
export async function runPdfjsBrowserPolyfillTests() {
  // ---------------------------------------------------------------- an OLD browser
  const old = vm.createContext({});
  const before = vm.runInContext(
    `delete Promise.withResolvers;
     delete Array.prototype.findLast;
     ({ withResolvers: typeof Promise.withResolvers, findLast: typeof Array.prototype.findLast })`,
    old,
  ) as { withResolvers: string; findLast: string };

  // The simulation is real: both are genuinely gone before the polyfill runs.
  assert.equal(before.withResolvers, "undefined", "the old-browser realm still had withResolvers");
  assert.equal(before.findLast, "undefined", "the old-browser realm still had findLast");

  vm.runInContext(PDFJS_BROWSER_POLYFILL, old);

  const installed = vm.runInContext(
    `({ withResolvers: typeof Promise.withResolvers, findLast: typeof Array.prototype.findLast })`,
    old,
  ) as { withResolvers: string; findLast: string };
  assert.equal(
    installed.withResolvers,
    "function",
    "the polyfill did not install Promise.withResolvers — every CV fails to open on an older phone browser",
  );
  assert.equal(installed.findLast, "function", "the polyfill did not install Array.prototype.findLast");

  // ---------------------------------------------------------------- Promise.withResolvers
  const promiseCase = (await vm.runInContext(
    `(async () => {
       const a = Promise.withResolvers();
       const shape = Object.keys(a).sort().join(",");
       a.resolve("resolved value");
       const resolved = await a.promise;

       const b = Promise.withResolvers();
       b.reject(new Error("rejected reason"));
       let rejected = "never rejected";
       try { await b.promise; } catch (error) { rejected = error.message; }

       // pdf.js calls this on its own Promise subclasses, so the spec's \`new this\` matters.
       class Sub extends Promise {}
       const sub = Sub.withResolvers();
       sub.resolve(1);
       await sub.promise;

       const descriptor = Object.getOwnPropertyDescriptor(Promise, "withResolvers");
       return {
         shape,
         resolved,
         rejected,
         subclassed: sub.promise instanceof Sub,
         enumerable: descriptor.enumerable,
         writable: descriptor.writable,
         configurable: descriptor.configurable,
         enumerableOnPromise: Object.keys(Promise).includes("withResolvers"),
       };
     })()`,
    old,
  )) as Record<string, unknown>;

  assert.equal(promiseCase.shape, "promise,reject,resolve", "withResolvers returned the wrong shape");
  assert.equal(promiseCase.resolved, "resolved value", "the returned resolve() did not settle the promise");
  assert.equal(promiseCase.rejected, "rejected reason", "the returned reject() did not reject the promise");
  assert.equal(
    promiseCase.subclassed,
    true,
    "withResolvers built a plain Promise for a subclass — it must use `new this`, as pdf.js's capability helpers rely on",
  );
  assert.equal(promiseCase.enumerable, false, "withResolvers must not be enumerable, like the native one");
  assert.equal(promiseCase.writable, true, "withResolvers must stay writable, like the native one");
  assert.equal(promiseCase.configurable, true, "withResolvers must stay configurable, like the native one");
  assert.equal(promiseCase.enumerableOnPromise, false, "withResolvers showed up in Object.keys(Promise)");

  // ---------------------------------------------------------------- Array.prototype.findLast
  const arrayCase = vm.runInContext(
    `(() => {
       const found = [1, 2, 3, 4].findLast((n) => n % 2 === 1);
       const missing = [2, 4].findLast((n) => n % 2 === 1);
       const args = [];
       ["a", "b"].findLast(function (value, index, array) { args.push([value, index, array.length]); return false; });
       const thisArg = [1, 2, 3].findLast(function (n) { return n === this.wanted; }, { wanted: 2 });

       // pdf.js's one call site is [...searchParams.values()].findLast(...) — a spread array.
       const spread = [...new Set(["a.pdf", "b.txt", "c.pdf"])].findLast((s) => s.endsWith(".pdf"));

       let threw = "did not throw";
       try { [1].findLast("not a function"); } catch (error) { threw = error.constructor.name; }

       const seen = [];
       const arr = [1];
       for (const key in arr) seen.push(key);

       const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "findLast");
       return {
         found, missing, args, thisArg, spread, threw,
         enumeratedKeys: seen.join(","),
         enumerable: descriptor.enumerable,
       };
     })()`,
    old,
  ) as Record<string, unknown>;

  assert.equal(arrayCase.found, 3, "findLast must return the LAST match, not the first");
  assert.equal(arrayCase.missing, undefined, "findLast must return undefined when nothing matches");
  assert.deepEqual(
    JSON.parse(JSON.stringify(arrayCase.args)),
    [
      ["b", 1, 2],
      ["a", 0, 2],
    ],
    "findLast must walk backwards and pass (value, index, array)",
  );
  assert.equal(arrayCase.thisArg, 2, "findLast must honour its thisArg");
  assert.equal(arrayCase.spread, "c.pdf", "findLast failed on the spread-array shape pdf.js actually calls");
  assert.equal(arrayCase.threw, "TypeError", "findLast must throw a TypeError on a non-callable predicate");
  assert.equal(arrayCase.enumerable, false, "findLast must not be enumerable");
  assert.equal(
    arrayCase.enumeratedKeys,
    "0",
    "findLast leaked into for...in over an array — an enumerable Array.prototype property breaks unrelated code",
  );

  // ---------------------------------------------------------------- a MODERN browser
  // Where the engine (or pdf.js's own core-js) already provides these, the polyfill must leave
  // them completely alone rather than shadowing a native implementation with ours.
  const modern = vm.createContext({});
  const native = vm.runInContext(
    `globalThis.__nativeWithResolvers = Promise.withResolvers;
     globalThis.__nativeFindLast = Array.prototype.findLast;
     typeof Promise.withResolvers === "function" && typeof Array.prototype.findLast === "function"`,
    modern,
  );
  assert.equal(native, true, "this Node build lacks the built-ins, so the no-op case proves nothing");

  vm.runInContext(PDFJS_BROWSER_POLYFILL, modern);
  const untouched = vm.runInContext(
    `({ promise: Promise.withResolvers === globalThis.__nativeWithResolvers,
        array: Array.prototype.findLast === globalThis.__nativeFindLast })`,
    modern,
  ) as { promise: boolean; array: boolean };

  assert.equal(untouched.promise, true, "the polyfill replaced a native Promise.withResolvers");
  assert.equal(untouched.array, true, "the polyfill replaced a native Array.prototype.findLast");
}
