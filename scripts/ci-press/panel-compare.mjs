// One-off, never merged: the panel's answers from the old read against the new one. Prints counts and hr ids only, never a name.
import { readFileSync } from "node:fs";

const [oldPath, newPath] = process.argv.slice(2);
const before = JSON.parse(readFileSync(oldPath, "utf8"));
const after = JSON.parse(readFileSync(newPath, "utf8"));
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const blocksDiffering = (left, right) => {
  if (!left || !right) return ["whole answer"];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
};

const ids = Object.keys(before);
const different = [];
const secondOpenDifferent = [];
let withAnswer = 0;
let withOwnVisits = 0;
let withProbation = 0;
let threw = 0;
for (const hrId of ids) {
  const old = before[hrId]?.first.answer;
  const fresh = after[hrId]?.first.answer;
  if (old?.threw || fresh?.threw) threw += 1;
  if (old) withAnswer += 1;
  if (old?.trend?.some((point) => point.count > 0)) withOwnVisits += 1;
  if (old?.probation?.length) withProbation += 1;
  if (JSON.stringify(old) !== JSON.stringify(fresh)) different.push(`${hrId}: ${blocksDiffering(old, fresh).join(", ")}`);
  if (JSON.stringify(fresh) !== JSON.stringify(after[hrId]?.second.answer)) secondOpenDifferent.push(hrId);
}
const missing = Object.keys(after).filter((hrId) => !before[hrId]);
const stats = (source, open) => {
  const opens = Object.values(source).filter((entry) => entry[open].answer && !entry[open].answer.threw);
  return `median ${median(opens.map((entry) => entry[open].requests))} requests, ${median(opens.map((entry) => entry[open].ms))} ms`;
};

console.log(`managers ${ids.length}; a panel for ${withAnswer}; with their own visits ${withOwnVisits}; with probationers ${withProbation}; threw ${threw}; only in the new run ${missing.length}`);
console.log(`old read, first open: ${stats(before, "first")}`);
console.log(`new read, first open (the first manager fills the copy): ${stats(after, "first")}`);
console.log(`new read, second open: ${stats(after, "second")}`);
console.log(`DIFFERENT old against new: ${different.length}${different.length ? `\n  ${different.slice(0, 25).join("\n  ")}` : ""}`);
console.log(`DIFFERENT new first open against new second open: ${secondOpenDifferent.length}${secondOpenDifferent.length ? ` ${secondOpenDifferent.slice(0, 25).join(", ")}` : ""}`);
process.exit(different.length || secondOpenDifferent.length || threw || missing.length || withOwnVisits === 0 ? 1 : 0);
