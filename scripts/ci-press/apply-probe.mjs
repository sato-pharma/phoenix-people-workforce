// One-off, never merged: applied on the runner after the break step, so the committed code stays the fix itself.
// It logs each decision, and adds `window.__phxNoMark`, which turns the provider's marking off for the control scenario.
import { readFileSync, writeFileSync } from "node:fs";

const edit = (file, pairs) => {
  let text = readFileSync(file, "utf8");
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`${file}: not found: ${from.slice(0, 70)}`);
    text = text.replace(from, () => to);
  }
  writeFileSync(file, text);
};

edit("src/lib/phoenix-crm/first-read.ts", [
  [
    `  if (now - firstRead.startedAt > FIRST_READ_LIFETIME_MS) return null;
  const met = firstMet.get(firstRead) ?? now;`,
    `  const probeHad = firstMet.get(firstRead);
  console.info(\`[first-read-probe] for read@\${firstRead.startedAt % 1000000} known=\${probeHad !== undefined} spent=\${probeHad === Number.NEGATIVE_INFINITY} sinceStartedMs=\${now - firstRead.startedAt}\`);
  if (now - firstRead.startedAt > FIRST_READ_LIFETIME_MS) return null;
  const met = firstMet.get(firstRead) ?? now;`,
  ],
]);

edit("src/components/phoenix-crm/first-read.ts", [
  [
    `  useEffect(() => {
    firstReadArrived(held, firstRead);`,
    `  useEffect(() => {
    const noMark = Boolean((window as unknown as { __phxNoMark?: boolean }).__phxNoMark);
    console.info(\`[first-read-probe] provider prop=\${firstRead ? firstRead.startedAt % 1000000 : "null"} held=\${held ? held.startedAt % 1000000 : "null"} noMark=\${noMark}\`);
    if (noMark) return;
    firstReadArrived(held, firstRead);`,
  ],
]);
console.log("probe applied");
