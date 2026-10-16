// Recruitment — what typing on the Job Posts picture means.
//
// PURE, no React, no DOM: the builder screen calls these, and tests/recruitment-job-posts.test.ts runs
// them directly. The picture is a sandboxed frame that reports, after a pause in typing, which passages
// changed and what each duty or requirement now reads; these functions decide where each goes — a list
// line is written back into the draft's own row, every other word becomes a per-post edit.

import type { JobPostLine } from "@/lib/recruitment/job-posts/templates";

/** What the editable picture reports after a pause in typing — see EDIT_SCRIPT in templates.ts. */
export type PictureEdit = { edits: Record<string, string>; bound: Record<string, JobPostLine>; unmapped: boolean };

/** The frame is sandboxed, so its message is believed only after its shape is checked. */
export function readPictureEdit(value: unknown): PictureEdit | null {
  if (!value || typeof value !== "object") return null;
  const { edits, bound, unmapped } = value as { edits?: unknown; bound?: unknown; unmapped?: unknown };
  if (!edits || typeof edits !== "object" || !bound || typeof bound !== "object" || typeof unmapped !== "boolean") return null;
  const cleanEdits: Record<string, string> = {};
  for (const [key, next] of Object.entries(edits as Record<string, unknown>).slice(0, 200)) {
    if (typeof next === "string") cleanEdits[key] = next;
  }
  const cleanBound: Record<string, JobPostLine> = {};
  for (const [key, line] of Object.entries(bound as Record<string, unknown>).slice(0, 200)) {
    const { lead, rest } = (line ?? {}) as { lead?: unknown; rest?: unknown };
    if (typeof lead === "string" && typeof rest === "string") cleanBound[key] = { lead, rest };
  }
  return { bound: cleanBound, edits: cleanEdits, unmapped };
}

/**
 * The picture's typed words, laid over what it already carried. `baked` is what the frame was loaded
 * with; `typed` is the frame's whole difference from that, so a word typed back to what it was drops
 * out instead of lingering. A passage typed over twice in different loads chains (A to B, then B to C
 * is A to C) rather than leaving two entries the renderer would only half apply.
 */
export function layerEdits(baked: Record<string, string>, typed: Record<string, string>): Record<string, string> {
  const out = { ...baked };
  for (const [key, value] of Object.entries(typed)) {
    const earlier = Object.keys(out).find((k) => k !== key && out[k] === key);
    if (earlier !== undefined) {
      if (value === earlier) delete out[earlier];
      else out[earlier] = value;
    } else if (value === key) {
      delete out[key];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The draft rows the picture's lines stand for: the picture prints only rows with words, in order. */
export function printedRows(lines: JobPostLine[]): number[] {
  return lines.flatMap((l, i) => (l.lead.trim() || l.rest.trim() ? [i] : []));
}

/** One list, with the picture's typed lines written back into the rows they came from. */
export function writeBack(lines: JobPostLine[], kind: "d" | "n", bound: Record<string, JobPostLine>): JobPostLine[] {
  const rows = printedRows(lines);
  let changed = false;
  const next = lines.map((l) => ({ ...l }));
  rows.forEach((row, printed) => {
    const typed = bound[`${kind}${printed}`];
    if (!typed) return;
    if (typed.lead !== lines[row]!.lead.trim() || typed.rest !== lines[row]!.rest.trim()) {
      next[row] = { lead: typed.lead, rest: typed.rest };
      changed = true;
    }
  });
  return changed ? next : lines;
}
