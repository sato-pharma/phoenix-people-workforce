import assert from "node:assert/strict";

import {
  applyAssist,
  campaignHeadline,
  campaignSpecialitiesAreKnownToTaxonomy,
  readCampaignNote,
  resolveSpeciality,
  CAMPAIGN_SPECIALITY_CANONICALS,
} from "../src/lib/crm/campaign-note.ts";
import { acceptAssistedValue, acceptAssistRow } from "../src/lib/crm/campaign-note-assist.ts";
import { KNOWN_SP_SPECIALITIES } from "../src/lib/crm/contact-taxonomy.ts";

/**
 * Every note below is a REAL campaign comment from production, copied character for character
 * (2026-08-28). An invented note would let the parser pass on Egyptian Arabic it has never actually
 * had to read — and the two examples the owner named himself are the first two blocks.
 */
export function runCrmCampaignNoteTests() {
  // ── The owner's first example: "it is NOT a doctor, it is a hospital, and its address is in its name" ──
  {
    const reading = readCampaignNote("مستشفي كهرباء ٢٦ يوليو  عيادة جمال عبد الناصر");
    assert.equal(reading.people.length, 0, "a hospital is not a person — nobody may be invented here");
    assert.ok(reading.accounts.length >= 1, "the hospital must be read as an account");
    assert.equal(reading.accounts[0].kind, "hospital");
    assert.ok(
      reading.accounts[0].name.includes("٢٦ يوليو"),
      "the address inside the name stays part of the name — it is how the rep identifies the building",
    );
  }

  // ── The owner's second example: "a doctor whose speciality is mentioned in his name, which is GB" ──
  {
    const reading = readCampaignNote("احمد سمير خطاب GB");
    assert.equal(reading.people.length, 1, "GB written after a name makes that name a person");
    assert.equal(reading.people[0].name, "احمد سمير خطاب", "the speciality is not part of the doctor's name");
    assert.equal(reading.people[0].speciality?.written, "GB", "and it is shown exactly as he typed it");
    assert.equal(
      reading.people[0].speciality?.canonical,
      null,
      "GB is identified as a speciality but NEVER guessed at — contact-taxonomy has no such value",
    );
  }

  // ── Doctor + speciality + hospital, all on one line, twice over ──
  {
    const reading = readCampaignNote("د/محمد ابوالعنين IM مستشفى التيسير\nد/احمد علي مرسي neouro مستشفى التيسير");
    assert.equal(reading.people.length, 2, "two doctors, two lines");
    assert.equal(reading.people[0].name, "محمد ابوالعنين", "the د/ marker is not part of the name");
    assert.equal(reading.people[0].speciality?.canonical, "internal medicine", "IM resolves to the taxonomy value");
    assert.equal(reading.people[1].speciality?.canonical, "neurology", "'neouro' is how a rep spells it");
    assert.equal(reading.accounts.length, 2, "and each names the hospital he was in");
    assert.equal(reading.accounts[0].kind, "hospital");
  }

  // ── A place, a doctor and a remark, split across lines ──
  {
    const reading = readCampaignNote(
      "مستشفي تبارك المريوطيه\nدكتور محمد عبد الباقي\nعرفته ان اللاكتو بقا متوفر في الصيدليه من جديد",
    );
    assert.equal(reading.accounts[0].kind, "hospital");
    assert.equal(reading.people[0].name, "محمد عبد الباقي");
    assert.ok(reading.remark?.includes("اللاكتو"), "the rep's own sentence survives, whole");
    assert.equal(reading.remark?.includes("…"), false, "nothing is ever truncated (owner's standing rule)");
  }

  // ── Not a doctor: a company, and then the remark ──
  {
    const reading = readCampaignNote("شركة المياة بالمنيل\nتم تسليم عرض السعر و الموافقة عليه ستكون علي اول شهر سبتمبر القادم");
    assert.equal(reading.people.length, 0, "a water company is nobody");
    assert.equal(reading.accounts[0].kind, "company");
    assert.ok(reading.accounts[0].name.includes("بالمنيل"), "the place stays inside the company's name");
    assert.ok(reading.remark?.includes("عرض السعر"));
  }

  // ── معملش is a verb, not a laboratory ──
  {
    const reading = readCampaignNote("دكتور محمود برنجي\nكان في مشكلة في الشبكة في المكان معملش check in");
    assert.equal(
      reading.accounts.some((account) => account.kind === "laboratory"),
      false,
      "'معملش check in' is an apology for a network failure, not a visit to a lab",
    );
    assert.equal(reading.people[0].name, "محمود برنجي");
  }

  // ── The Arabic speciality written straight after a bare name ──
  {
    assert.equal(readCampaignNote("بهاء سليم باطنا").people[0].speciality?.canonical, "internal medicine");
    assert.equal(readCampaignNote("محمد عبدالصادق باطني").people[0].name, "محمد عبدالصادق");
    // A speciality on its own line belongs to the doctor on the line above, not to nobody.
    const ownLine = readCampaignNote("د/فتحي حتحوت\nانف و أذن");
    assert.equal(ownLine.people[0].name, "فتحي حتحوت");
    assert.equal(ownLine.people[0].speciality?.canonical, "ent", "the next line is his speciality, not a stray word");
    assert.equal(readCampaignNote("د/ هاني حنا  | ENT").people[0].speciality?.canonical, "ent");
  }

  // ── Latin, with the remark trailing the speciality ──
  {
    const reading = readCampaignNote("Dr Ibrahim omara GP about royafloxacin and saginkgo");
    assert.equal(reading.people[0].name, "Ibrahim omara");
    assert.equal(reading.people[0].speciality?.canonical, "general practitioner");
  }

  // ── One note, three doctors and a centre — a whole morning in one comment ──
  {
    const reading = readCampaignNote(
      "مركز الطبي - مصنع السكر ف الحوامديه\nد حسام نصرالدين انف واذن\nد احمد فواد صدر\nد ايهاب مسالك",
    );
    assert.equal(reading.people.length, 3, "all three doctors are read, not just the first");
    assert.deepEqual(
      reading.people.map((person) => person.speciality?.canonical),
      ["ent", "chest", "urology"],
      "each keeps his own speciality",
    );
    assert.ok(reading.accounts.some((account) => account.name.includes("الحوامديه")), "the centre keeps its place");
  }

  // ── The headline is what the drill-down shows where "Contact 0" used to be ──
  {
    assert.equal(campaignHeadline(readCampaignNote("احمد سمير خطاب GB")), "احمد سمير خطاب");
    assert.equal(campaignHeadline(readCampaignNote("شركة الكهرباء")), "شركة الكهرباء", "a place when there is no person");
    assert.equal(campaignHeadline(readCampaignNote("")), null, "an empty note names nobody");
    assert.equal(campaignHeadline(readCampaignNote("prospiction")), null, "an activity remark names nobody");
  }

  // ── Nothing is invented: every name must be characters the rep actually typed ──
  {
    for (const note of [
      "د/محمد ابوالعنين IM مستشفى التيسير",
      "مستشفي تبارك المريوطيه\nدكتور محمد عبد الباقي",
      "شركه ابن سينا للادويه فرع الزقازيق",
      "Semad Contract  | Dr sayed Gp | Dr Abdelkarem Gp",
    ]) {
      const reading = readCampaignNote(note);
      for (const person of reading.people) {
        assert.ok(note.includes(person.name), `invented a person: ${person.name}`);
        if (person.speciality) assert.ok(note.includes(person.speciality.written), "invented a speciality");
      }
      for (const account of reading.accounts) {
        assert.ok(note.includes(account.name), `invented an account: ${account.name}`);
      }
    }
  }

  // ── The assist may CHOOSE from the rep's words; it may never author them ──
  {
    const fragment = "محمد الحويزي";
    assert.equal(acceptAssistedValue(fragment, "محمد الحويزي"), "محمد الحويزي", "a real slice is accepted");
    assert.equal(
      acceptAssistedValue(fragment, "د. أحمد السيد"),
      null,
      "a plausible invented doctor is refused — an invented doctor on a manager's board looks like evidence",
    );
    assert.equal(acceptAssistedValue(fragment, "null"), null, "a spelled-out null is a null");
    assert.equal(acceptAssistedValue(fragment, "ا"), null, "too short to identify anyone");
    assert.equal(acceptAssistedValue("", "محمد"), null, "no fragment, no answer");

    // Arabic spelled with a different hamza is the SAME name, and must not be refused for it.
    assert.equal(acceptAssistedValue("د/ احمد على", "أحمد علي"), "أحمد علي");
  }

  // ── One raw model row in, one reading out — or nothing ──
  {
    const fragment = "م. طنطا العام";
    assert.deepEqual(acceptAssistRow(fragment, { index: 0, kind: "place", name: "طنطا العام", placeKind: "hospital", speciality: null }), {
      kind: "place",
      name: "طنطا العام",
      placeKind: "hospital",
    });
    assert.deepEqual(acceptAssistRow(fragment, { index: 0, kind: "remark", name: null, placeKind: null, speciality: null }), {
      kind: "remark",
    });
    assert.equal(
      acceptAssistRow(fragment, { index: 0, kind: "place", name: "مستشفى المنصورة", placeKind: "hospital", speciality: null }),
      null,
      "a hospital in another city is not in this fragment",
    );
    const unknownKind = acceptAssistRow(fragment, { index: 0, kind: "place", name: "طنطا العام", placeKind: "castle", speciality: null });
    assert.equal(unknownKind?.kind === "place" && unknownKind.placeKind, "clinic", "an unnamed kind is still a place");
  }

  // ── Folding the assist back in keeps the rep's order and canonicalises through ONE table ──
  {
    const reading = readCampaignNote("محمد الحويزي\nص ثروت\nوعد بكتابه الايفي رونك");
    assert.ok(reading.unread.length >= 2, "these are exactly the fragments the rules cannot read");

    const merged = applyAssist(
      reading,
      new Map([
        ["محمد الحويزي", { kind: "person", name: "محمد الحويزي", speciality: null } as const],
        ["ص ثروت", { kind: "place", name: "ثروت", placeKind: "pharmacy" } as const],
        ["وعد بكتابه الايفي رونك", { kind: "remark" } as const],
      ]),
    );
    assert.equal(merged.people[0].name, "محمد الحويزي");
    assert.equal(merged.accounts[0].kind, "pharmacy");
    assert.ok(merged.remark?.includes("وعد بكتابه"), "a remark stays a remark, in the rep's own words");
    assert.equal(merged.unread.length, 0, "nothing the assist explained is still unread");

    // A fragment the assist did NOT answer stays exactly as the rep wrote it.
    assert.equal(applyAssist(reading, new Map()).unread.length, reading.unread.length);
  }

  // ── A speciality the assist spots is canonicalised by the rules' table, never by the model ──
  {
    assert.equal(resolveSpeciality("باطنه")?.canonical, "internal medicine");
    assert.equal(resolveSpeciality("IM")?.canonical, "internal medicine");
    assert.equal(resolveSpeciality("GB")?.canonical, null, "an unknown token comes back as written, not guessed");
    assert.equal(resolveSpeciality("GB")?.written, "GB");
    assert.equal(resolveSpeciality("  "), null);
    assert.equal(resolveSpeciality("GIT")?.canonical, "gastroenterologist", "GIT is a value the taxonomy DOES hold");

    // Gynaecology: identified, never invented. The SP list has no such value, so mapping it anywhere
    // would store a speciality the CRM cannot hold — and "general practitioner" would be plain wrong.
    for (const written of ["gyna", "gynae", "Gyn"]) {
      assert.equal(resolveSpeciality(written)?.canonical, null, `${written} has no taxonomy value to map onto`);
      assert.equal(resolveSpeciality(written)?.written, written, "so it is shown exactly as the rep typed it");
    }
    // And it comes off the NAME, which is the whole point — this row is live on production.
    const gyna = readCampaignNote("Manal hamza gyna");
    assert.equal(gyna.people[0].name, "Manal hamza", "the speciality is not part of her name");
    assert.equal(gyna.people[0].speciality?.written, "gyna");
  }

  // ── One unreadable thing is ONE fragment ──
  {
    // Two paths inside readCampaignNote record an unread segment and they overlap: the flush of
    // words nothing claimed, and the fallback for a segment where nothing at all was recognised.
    // For a short unreadable segment both fired on the same text, so it was listed twice.
    //
    // Harmless while nothing consumed `unread` — the reading is flattened into three columns and
    // the leftovers were dropped. Wiring the cheap-model assist on 2026-09-02 gave it a consumer,
    // and there a duplicate is not cosmetic: applyAssist folds one answer back per fragment, so the
    // same doctor would be filed as two separate people on one row, and the model billed twice for
    // reading him once.
    for (const note of ["م. طنطا العام", "ص ثروت", "أ.د محمد الحويزي", "GB ahmed"]) {
      assert.deepEqual(
        readCampaignNote(note).unread,
        [note],
        `"${note}" is one thing the rules could not read — it must be listed once, not once per path that noticed it`,
      );
    }
  }

  // ── This file must never become a second speciality vocabulary ──
  {
    assert.equal(
      campaignSpecialitiesAreKnownToTaxonomy(),
      true,
      "every canonical value here must already exist in contact-taxonomy — one authority, not two",
    );
    const known = new Set(KNOWN_SP_SPECIALITIES);
    for (const canonical of CAMPAIGN_SPECIALITY_CANONICALS) {
      assert.ok(known.has(canonical), `${canonical} is not a contact-taxonomy speciality`);
    }
  }
}
