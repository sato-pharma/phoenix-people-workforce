import assert from "node:assert/strict";

import { acceptExtractedAccount, normalizeAccountText } from "../src/lib/crm/campaign-account.ts";

// Campaign/Prospection visits reach Phoenix with NO account column — 0 of 30,367 production rows
// carry contact_name or customer_name — so the account is read out of the rep's own free-text
// note instead. That read is a model call, and this file pins the one property that makes putting
// it in front of a District Manager safe: the model may CHOOSE and DELIMIT a name that is already
// in the note, and may never AUTHOR one.
//
// The failure this prevents is not a crash. It is a plausible Egyptian hospital appearing on a
// compliance board as the account a rep visited this morning, when the rep's note said "Sales day".

export function runCrmCampaignAccountTests() {
  // ── A name genuinely present in the note is accepted, spelled as the rep wrote it ──
  {
    assert.equal(
      acceptExtractedAccount("زيارة مستشفى الهلال مع الفريق", "مستشفى الهلال"),
      "مستشفى الهلال",
      "a name that occurs in the note is the whole point of the feature",
    );
    assert.equal(acceptExtractedAccount("Visited Karma hospital today", "Karma hospital"), "Karma hospital");
  }

  // ── A name NOT in the note is refused, however plausible ────────────────────────
  {
    assert.equal(
      acceptExtractedAccount("Sales day", "مستشفى النور"),
      null,
      "the model must never author an account — an invented hospital on a compliance board reads as evidence that a rep was somewhere they never went",
    );
    assert.equal(
      acceptExtractedAccount("جواميسين و ايفيرونك", "صيدلية الشفاء"),
      null,
      "a note listing products names no customer; a confident answer here is a fabrication",
    );
    assert.equal(
      acceptExtractedAccount("prospiction", "Prospection Hospital"),
      null,
      "echoing the note back as a proper noun invents an institution out of a typo",
    );
  }

  // ── Handing the whole note back is a copy, not an extraction ────────────────────
  {
    assert.equal(
      acceptExtractedAccount("تابعت معاه ع الايفي واللاكتو وقالي تمام", "تابعت معاه ع الايفي واللاكتو وقالي تمام"),
      null,
      "returning the entire note would fill the account column with activity sentences",
    );
    // Same rejection when the echo differs only by the orthography the matcher folds.
    assert.equal(acceptExtractedAccount("مستشفي الهلال", "مستشفى الهلال "), null);
  }

  // ── Null-ish and out-of-range answers all collapse to null ──────────────────────
  {
    for (const answer of ["", "   ", "null", "NULL", "None", "n/a", "-", "unknown"]) {
      assert.equal(
        acceptExtractedAccount("زيارة مستشفى الهلال", answer),
        null,
        `"${answer}" is the model saying it found nothing, not an account name`,
      );
    }
    assert.equal(acceptExtractedAccount("مستشفى الهلال", "مس"), null, "two characters cannot identify a customer");
    const longNote = `visited ${"a".repeat(200)} today`;
    assert.equal(acceptExtractedAccount(longNote, "a".repeat(200)), null, "an 80+ character answer is the note back, not a name");
  }

  // ── An empty or missing note can never yield an account ─────────────────────────
  {
    assert.equal(acceptExtractedAccount(null, "مستشفى الهلال"), null);
    assert.equal(acceptExtractedAccount("   ", "مستشفى الهلال"), null);
    assert.equal(acceptExtractedAccount("زيارة مستشفى الهلال", null), null);
  }

  // ── Arabic orthography must not cause a false rejection ─────────────────────────
  {
    // The rep typed a bare alef and a dotless ya; the model returned the same name with hamza and
    // a dotted ya. Same hospital. A literal includes() would have thrown the real answer away.
    assert.equal(
      acceptExtractedAccount("رحت مستشفي الامراض النفسيه امبارح", "مستشفى الأمراض النفسية"),
      "مستشفى الأمراض النفسية",
      "harakat, alef/ya family and ta-marbuta differences are spelling noise, not a different customer",
    );
    assert.equal(
      acceptExtractedAccount("زيارة مـستشفى الهــلال", "مستشفى الهلال"),
      "مستشفى الهلال",
      "tatweel padding inside a word must not hide a genuine match",
    );
  }

  // ── Multi-line notes are the norm, not an edge case ─────────────────────────────
  {
    // Reps paste several lines into one comment. Real production example, 2026-08-06..08.
    const note = "Sales day \r\nمخزن الفرسان \r\nمخزن الهنا \r\nصيدليه الاتحاد";
    assert.equal(
      acceptExtractedAccount(note, "مخزن الفرسان"),
      "مخزن الفرسان",
      "a name on the second line of a note is still in the note — CRLF must not defeat containment",
    );
    assert.equal(acceptExtractedAccount(note, "مخزن الاتحاد"), null, "a name assembled from two different lines was never written");
  }

  // ── The normalizer folds exactly what the matcher relies on ─────────────────────
  {
    assert.equal(normalizeAccountText("مستشفى"), normalizeAccountText("مستشفي"), "alef-maqsura folds to ya");
    assert.equal(normalizeAccountText("النفسية"), normalizeAccountText("النفسيه"), "ta-marbuta folds to ha");
    assert.equal(normalizeAccountText("الأمراض"), normalizeAccountText("الامراض"), "hamza forms fold to bare alef");
    assert.equal(normalizeAccountText("  Karma   Hospital "), "karma hospital", "case and runs of whitespace collapse");
  }
}
