import { strict as assert } from "node:assert";

import { nameFromAttachmentFilename } from "@/lib/recruitment/inbound/cv-import-shared";

/**
 * A CV forwarded out of a mail archive arrives with the whole envelope baked into its filename:
 *
 *   "Dalia S Mansour HR Resume From(Dalia Sameh Mansour (dsmansour@outlook com)) Subject(…) Date(…)"
 *
 * The 2026-08-18 WhatsApp bulk forward stored 220 production candidates under that raw stem —
 * "From(", "Subject(" and the date all sitting in ats_candidates.full_name — because the only
 * guard rejected short generic stems like "Document". Those 220 rows were repaired by hand on
 * 2026-08-23; this pins the parser so the next bulk forward cannot recreate them.
 */
export function runRecruitmentAttachmentFilenameNameTests() {
  // ── The regression: an archived-email filename never becomes the person's name ─────────────
  const archived =
    "Dalia S Mansour HR Resume From(Dalia Sameh Mansour (dsmansour@outlook com)) " +
    "Subject(Personnel & Recruitment Specialist HR Generalist) Date(Fri, 7 Aug 2026 11 00 08 +0000).pdf";
  const parsed = nameFromAttachmentFilename(archived);
  assert.equal(
    parsed,
    "Dalia Sameh Mansour",
    "an archived-email filename must yield the sender's display name, not the envelope",
  );

  // The three envelope markers must never survive into a stored name, whatever the shape.
  for (const filename of [
    archived,
    "file 754C9140 8AD3 404A 8339 AFC0892A9BFF From(Ayman Sabry (ayman sabry4207@gmail com)) Subject(Apply for Hr personal) Date(Fri, 14 Aug 2026 19 19 02 +0300).pdf",
    "From(Yara Mounir (yara@example com)) Subject(CV) Date(Tue, 5 Aug 2026).docx",
    "Some CV Subject(no sender here) Date(Tue, 5 Aug 2026).pdf",
  ]) {
    const name = nameFromAttachmentFilename(filename);
    if (name !== null) {
      for (const marker of ["From(", "Subject(", "Date(", "@", ".pdf", ".docx"]) {
        assert.ok(
          !name.includes(marker),
          `"${marker}" leaked into a candidate name from ${filename}`,
        );
      }
    }
  }

  // A filename that starts with the envelope still yields the sender.
  assert.equal(
    nameFromAttachmentFilename("From(Yara Mounir (yara@example com)) Subject(CV) Date(Tue, 5 Aug 2026).docx"),
    "Yara Mounir",
    "an envelope at the very start of the filename must still yield the sender",
  );

  // An envelope with no readable sender is a message description, not a person.
  assert.equal(
    nameFromAttachmentFilename("Some CV Subject(no sender here) Date(Tue, 5 Aug 2026).pdf"),
    null,
    "an envelope with no readable sender must not become a name",
  );

  // ── A shared mailbox forwards other people's CVs, so it is not the applicant ───────────────
  assert.equal(
    nameFromAttachmentFilename("Kareem CV From(Personnel Admin (personnel.desk@example.org)) Subject(CV).pdf"),
    null,
    "a shared-mailbox display name must not become a candidate name",
  );

  // ── A sentence or document heading is not a name ───────────────────────────────────────────
  assert.equal(
    nameFromAttachmentFilename("Motivated and analytical professional seeking a new role in Egypt.pdf"),
    null,
    "an eight-word sentence must not become a candidate name",
  );

  // ── Ordinary filenames keep working ────────────────────────────────────────────────────────
  assert.equal(
    nameFromAttachmentFilename("Hassan_Fathy_Mostafa.pdf"),
    "Hassan Fathy Mostafa",
    "a plain person-named attachment must still yield that name",
  );
  assert.equal(
    nameFromAttachmentFilename("محمد حواس.pdf"),
    "محمد حواس",
    "an Arabic-named attachment must still yield that name",
  );
  for (const generic of ["CV.pdf", "Document 2.pdf", "WhatsApp Image 2026.jpg", "20260818.pdf", null]) {
    assert.equal(
      nameFromAttachmentFilename(generic),
      null,
      `a generic attachment name (${generic}) must stay rejected`,
    );
  }
}
