// Runs ONE hook script inside a worker thread of hook-dispatch.mjs, so the script sees exactly what
// it saw as its own process: the tool payload on fd 0, its own path as argv[1] and its arguments
// after it, its stdout/stderr captured by the dispatcher, and process.exit() ending only this thread
// with that code. The hook file itself is imported UNCHANGED — nothing here knows what it guards.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { workerData } from 'node:worker_threads';

const { script, args, payload } = workerData;

// Every hook reads its payload with readFileSync(0). In a worker fd 0 is the dispatcher's own stdin,
// already drained, so fd 0 (and /dev/stdin) answer with the payload instead. syncBuiltinESMExports
// carries the patch into `import { readFileSync } from 'node:fs'` bindings as well.
const original = fs.readFileSync;
fs.readFileSync = function readFileSync(target, options) {
  if (target === 0 || target === '/dev/stdin') {
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? payload : Buffer.from(payload, 'utf8');
  }
  return original.apply(this, arguments);
};
syncBuiltinESMExports();

process.argv = [process.execPath, script, ...args];

await import(pathToFileURL(script).href);
