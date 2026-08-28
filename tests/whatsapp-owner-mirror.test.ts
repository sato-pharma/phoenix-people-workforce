import assert from "node:assert/strict";

import {
  buildWhatsAppMirrorMessage,
  formatWaId,
} from "../src/lib/recruitment/inbound/whatsapp-conversation-mirror.ts";

export function runWhatsAppOwnerMirrorTests() {
  // ── Numbers he has to be able to dial ─────────────────────────────────────────────────────────

  assert.equal(formatWaId("201001234567"), "+20 100 123 4567", "an Egyptian mobile must be grouped for dialling");
  assert.equal(formatWaId("+20 100 123 4567"), "+20 100 123 4567", "an already-formatted number must survive intact");
  // Anything that is not a 12-digit Egyptian mobile keeps its own shape rather than being forced
  // into one — a foreign applicant's number must not be silently regrouped into something wrong.
  assert.equal(formatWaId("447700900123"), "+447700900123", "a non-Egyptian number is not regrouped");
  assert.equal(formatWaId(""), "(unknown number)", "a missing number is stated, never blank");

  // ── A CV arriving ─────────────────────────────────────────────────────────────────────────────

  const withEverything = buildWhatsAppMirrorMessage({
    candidateName: "Ahmed Mohamed Saleh",
    contactName: "Ahmed",
    filename: "Ahmed_Mohamed_CV.pdf",
    kind: "cv_received",
    note: "Good morning, I would like to apply as a medical rep in Giza.",
    waId: "201001234567",
  });
  assert.equal(withEverything.title, "CV on the automated WhatsApp line");
  assert.ok(withEverything.message.includes("Ahmed Mohamed Saleh"), "the CV name leads the message");
  assert.ok(withEverything.message.includes("WhatsApp name: Ahmed"), "a differing profile name is worth showing");
  assert.ok(withEverything.message.includes("+20 100 123 4567"), "his number must be dialable from the message");
  assert.ok(withEverything.message.includes("Ahmed_Mohamed_CV.pdf"), "the file name must be shown");
  assert.ok(withEverything.message.includes("medical rep in Giza"), "the applicant's own words must reach him");

  // The profile name is dropped when it says nothing new — the same name twice reads as a bug.
  const sameName = buildWhatsAppMirrorMessage({
    candidateName: "Ahmed Mohamed Saleh",
    contactName: "Ahmed Mohamed Saleh",
    filename: "cv.pdf",
    kind: "cv_received",
    note: null,
    waId: "201001234567",
  });
  assert.ok(!sameName.message.includes("WhatsApp name"), "a profile name identical to the CV name is not repeated");

  // Extraction has not produced a name yet. That is a real state and must be said, not left blank —
  // an empty line where the person should be reads as a broken message.
  const noName = buildWhatsAppMirrorMessage({
    candidateName: null,
    contactName: null,
    filename: null,
    kind: "cv_received",
    note: null,
    waId: "201001234567",
  });
  assert.ok(noName.message.includes("Name not read from the CV yet"), "a missing name is stated");
  assert.ok(noName.message.includes("file name not given"), "a missing file name is stated");
  assert.ok(!/^\s*·/m.test(noName.message), "no line may start with a bare separator where a name should be");

  // ── A long message is cut at a word, and SAYS it was cut. Never an ellipsis. ───────────────────

  const longNote = `${"عايز اشتغل مندوب دعاية طبية في منطقة الجيزة ".repeat(40)}END`;
  const longMirror = buildWhatsAppMirrorMessage({
    candidateName: "Mona Adel",
    contactName: null,
    filename: "cv.pdf",
    kind: "cv_received",
    note: longNote,
    waId: "201001234567",
  });
  assert.ok(!longMirror.message.includes("…"), "text is never cut with an ellipsis — the owner's standing rule");
  assert.ok(!longMirror.message.includes("..."), "nor with three dots standing in for one");
  assert.ok(
    longMirror.message.includes("rest of the message is on the candidate's record"),
    "a cut message must say it was cut — a silent trim reads as the whole message",
  );
  assert.ok(!longMirror.message.includes("END"), "the tail really is cut, not merely labelled as cut");

  // ── The answers landing ───────────────────────────────────────────────────────────────────────

  const classified = buildWhatsAppMirrorMessage({
    areaName: "Haram - Faisal",
    candidateName: "Ahmed Mohamed Saleh",
    kind: "classified",
    regionLabel: "Giza",
    roleLabel: "Medical Representative",
    waId: "201001234567",
  });
  assert.equal(classified.title, "Applicant filed themselves");
  for (const expected of ["Ahmed Mohamed Saleh", "Medical Representative", "Giza", "Haram - Faisal"]) {
    assert.ok(classified.message.includes(expected), `the mirror must carry ${expected}`);
  }

  // A partly-answered session still reaches him, and names the part they did not reach — two of
  // three answers is far more than the free-text guess it replaces.
  const partial = buildWhatsAppMirrorMessage({
    areaName: null,
    candidateName: "Mona Adel",
    kind: "classified",
    regionLabel: "Giza",
    roleLabel: "Medical Representative",
    waId: "201001234567",
  });
  assert.ok(partial.message.includes("Area: not answered"), "an unanswered question is named, not omitted");
  assert.ok(partial.message.includes("Giza"), "the answers they did give must survive");
}
