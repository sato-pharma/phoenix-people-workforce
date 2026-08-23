/**
 * What a document-status write should do with the `notes` cell.
 *
 * `notes` is optional on the status payload, and the checklist UI never sends it: Mark submitted,
 * Mark missing and the deadline box all post `{documentId, dueDate, employeeHrId, status}` with no
 * notes key at all. Writing the incoming value unconditionally therefore read every one of those
 * clicks as "clear the note", so anything typed into that cell would be gone at the next click.
 *
 * The rule is the ordinary PATCH one: an ABSENT key means "leave it alone", and only a key that is
 * actually present changes anything. `null` and `""` are present, and both mean clear it.
 */
export function resolveHiringDocumentNotes(
  previous: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  if (incoming === undefined) return trimToNull(previous);
  return trimToNull(incoming);
}

function trimToNull(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}
