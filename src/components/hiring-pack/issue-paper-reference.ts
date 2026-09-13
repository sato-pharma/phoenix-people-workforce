"use client";

// Taking a paper's number from the browser, at the moment Print is pressed.
//
// NEVER THROWS AND NEVER BLOCKS. A number that could not be taken — no register yet, a network
// blip, a refused request — answers null, and the caller prints the paper unnumbered, exactly as it
// printed before numbering existed. A print that fails because of its own reference number would be
// the numbering costing HR the paper it exists to track.

export const PAPER_ISSUED_EVENT = "hiring-pack:paper-issued";

export type PaperReferenceRequest = {
  document: string;
  documentLabel?: string;
  hrId?: string | null;
  subjectName?: string | null;
  mode: "employee" | "manual";
  copies: number;
};

export async function issuePaperReference(request: PaperReferenceRequest): Promise<string | null> {
  try {
    const response = await fetch("/api/hiring-pack/paper-register", {
      body: JSON.stringify(request),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { reference?: unknown } | null;
    const reference = typeof body?.reference === "string" ? body.reference : null;
    // The register on screen reads itself again, so the row for this print appears beside it.
    if (reference) window.dispatchEvent(new Event(PAPER_ISSUED_EVENT));
    return reference;
  } catch {
    return null;
  }
}
