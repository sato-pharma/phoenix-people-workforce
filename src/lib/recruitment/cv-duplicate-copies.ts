// Recruitment / ATS — one CV per candidate per distinct file, for the Drive cabinet.
//
// THE PROBLEM THIS SOLVES, MEASURED. On 2026-09-07 the Drive mirror held 1,156 files for 875
// candidates. 425 of those files sat in 161 byte-identical groups, and every single group belonged
// to ONE candidate — zero spanned two people, so nothing was mis-attributed and nothing needed
// merging. It was the same person sending the same file again. One candidate had THIRTEEN identical
// copies of `Amr Mohamed Rozza - 01004316664.docx` in one folder. That is 264 redundant copies,
// 23% of the cabinet, and it is the owner's second complaint after the layout: "many copies, and
// the CVs I can't reach everything."
//
// AND IT IS STILL GROWING. `content_md5` has existed since 2026-09-05, but the only thing that ever
// reads it is `findCandidateIdByContentFingerprint`, which uses it to attach a duplicate to the
// RIGHT PERSON — never to stop a second copy being stored and mirrored. 15 groups gained another
// copy after that column shipped, the newest at 11:54 Cairo on 2026-09-07. So this is a live
// behaviour, not a historical mess to sweep once.
//
// WHY THE FIX IS HERE AND NOT AT UPLOAD. The duplicate ROW is not the bug and must not be deleted:
// it is the record that the candidate sent the file again, it carries its own intake event, and the
// re-send is real information about how keen an applicant is. What is wrong is mirroring the same
// bytes into the owner's cabinet more than once. So the row stays and the COPY is suppressed, which
// is also why this module is a pure chooser over rows rather than a guard inside the uploader.
//
// PURE — no database, no network. Both callers hand it rows and read the answer: the one-off fill
// script that builds the cabinet, and `mirrorCvToDrive` on every live intake. One brain, so the
// backfill can never file a candidate differently from the running site.

/** The least a row must carry to be chosen between. Extra fields are preserved by the generic. */
export type DedupableCvRow = {
  content_md5: string | null;
  created_at: string | null;
  id: string;
};

/**
 * Split a candidate's CV rows into the ones to mirror and the ones to suppress.
 *
 * THE OLDEST WINS. `findCandidateIdByContentFingerprint` already resolves a fingerprint clash
 * oldest-first, "so the ORIGINAL record wins", and disagreeing with it here would mean the row that
 * owns the candidate and the row that owns the Drive copy could be two different rows. Ties are
 * broken on `id` so two rows written in the same millisecond still resolve the same way on every
 * run — a fill script that picks differently on a re-run would upload a second copy of the file it
 * is supposed to be de-duplicating.
 *
 * A ROW WITH NO FINGERPRINT IS ALWAYS KEPT. `content_md5` is nullable, and absence means "we never
 * computed it", not "this file is unique". Suppressing on a value we do not have would silently drop
 * a CV the owner never sees again, which is the one failure mode worse than a duplicate. Measured
 * 2026-09-07: zero CV rows are missing it, so this branch costs nothing today and is the reason the
 * module stays safe if that ever stops being true.
 */
export function chooseCvCopies<T extends DedupableCvRow>(rows: readonly T[]): { keep: T[]; suppress: T[] } {
  const ordered = [...rows].sort((left, right) => {
    const a = left.created_at ?? "";
    const b = right.created_at ?? "";
    if (a !== b) return a < b ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  const seen = new Set<string>();
  const keep: T[] = [];
  const suppress: T[] = [];
  for (const row of ordered) {
    const fingerprint = String(row.content_md5 ?? "").trim();
    if (!fingerprint) {
      keep.push(row);
      continue;
    }
    if (seen.has(fingerprint)) {
      suppress.push(row);
      continue;
    }
    seen.add(fingerprint);
    keep.push(row);
  }
  return { keep, suppress };
}

/**
 * Africa/Cairo, as `YYYY-MM-DD`.
 *
 * `en-CA` yields exactly that shape, which is the pattern the attendance modules already use for a
 * Cairo day key. Cairo rather than UTC because `created_at` is an instant WE stamped, and the owner
 * reads every date in his own working day — a CV that arrived at 01:30 Cairo is his yesterday in
 * UTC and his today here, and the folder is read by him.
 */
function cairoDay(iso: string | null | undefined): string {
  const at = new Date(String(iso ?? ""));
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(at);
}

/**
 * The label that tells one of a candidate's CVs from another, keyed by row id.
 *
 * WHY A LABEL AT ALL. The Drive file name is `<person> - <number>.<ext>` and nothing else, which is
 * right for the 860 candidates with one CV and ambiguous for the 15 who sent more than one. Those
 * are not duplicates — `chooseCvCopies` has already removed every byte-identical re-send — they are
 * genuinely DIFFERENT CVs from one person, usually an updated version. Both belong in the cabinet,
 * and until now both arrived wearing the same name in the same folder.
 *
 * WHY THE DATE IS NOT ENOUGH ON ITS OWN, which is the whole reason this is a function rather than a
 * one-line concatenation. The owner asked for "the date", and measured on production 2026-09-07 the
 * date separates only 5 of the 15: the other 10 sent both CVs on ONE day. Acheampong Augustine sent
 * three on 2026-08-14, and maisaa's two are TWENTY-ONE SECONDS apart — so a date, a date and hour,
 * even a date and minute all still collide. A counter is appended only where the date actually
 * repeats, so the common case stays clean ("(2026-08-15)") and the awkward one stays truthful
 * ("(2026-08-14 #1)") instead of being quietly wrong.
 *
 * A candidate with one CV gets an EMPTY label and keeps the plain name — a date on every file in the
 * cabinet would be 892 longer names to buy nothing.
 */
export function copyLabelsFor<T extends DedupableCvRow>(rows: readonly T[]): Map<string, string> {
  const { keep } = chooseCvCopies(rows);
  const labels = new Map<string, string>();
  if (keep.length <= 1) {
    for (const row of keep) labels.set(row.id, "");
    return labels;
  }

  // `chooseCvCopies` already returns oldest-first, so the counter below reads in arrival order.
  const perDay = new Map<string, T[]>();
  for (const row of keep) {
    const day = cairoDay(row.created_at);
    if (!perDay.has(day)) perDay.set(day, []);
    perDay.get(day)!.push(row);
  }
  for (const [day, sameDay] of perDay) {
    if (!day) {
      // No usable timestamp. Numbering alone still separates them, and inventing a date would be
      // worse than admitting there isn't one.
      sameDay.forEach((row, index) => labels.set(row.id, `#${index + 1}`));
      continue;
    }
    if (sameDay.length === 1) {
      labels.set(sameDay[0].id, day);
      continue;
    }
    sameDay.forEach((row, index) => labels.set(row.id, `${day} #${index + 1}`));
  }
  return labels;
}

/**
 * `Name - number.pdf` plus its label, inserted BEFORE the extension.
 *
 * Before the extension rather than after, because a name ending in ".pdf (2026-08-15)" stops looking
 * like a PDF to a phone — the one place these names are actually read.
 */
export function withCopyLabel(fileName: string, label: string): string {
  const trimmed = String(label ?? "").trim();
  if (!trimmed) return fileName;
  const dot = fileName.lastIndexOf(".");
  // Guard a leading dot: ".pdf" is an extension-only name, not a stem with an extension.
  if (dot <= 0) return `${fileName} (${trimmed})`;
  return `${fileName.slice(0, dot)} (${trimmed})${fileName.slice(dot)}`;
}

/**
 * Whether THIS row is the copy that should reach Drive, given every CV row its candidate has.
 *
 * The convenience shape for the live mirror, which is handed one file id and has to answer a
 * yes/no. It deliberately re-derives the whole choice rather than asking "does a sibling already
 * have a mirror id", because that question answers differently depending on the order rows happen
 * to be processed in — and the ordering is a cron tick, so it is not stable.
 */
export function shouldMirrorCopy<T extends DedupableCvRow>(fileId: string, siblings: readonly T[]): boolean {
  return chooseCvCopies(siblings).keep.some((row) => row.id === fileId);
}
