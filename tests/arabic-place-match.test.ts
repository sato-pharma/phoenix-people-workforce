import assert from "node:assert/strict";

import {
  addressNamesPlace,
  addressWords,
  compileArabicPlace,
} from "../src/lib/geo/arabic-place-match.ts";

/**
 * "Post office box is not Bacchus. Eddie A George is not Gerga. Motorella is not the airport."
 *
 * The owner, 2026-08-28, on the first version of this bridge — which matched Arabic to English by
 * consonants alone and therefore could not tell any of those pairs apart. Every case in section 1
 * is one of the wrong answers he named or one measured beside them on the real 448 CVs, and they
 * are the reason this module exists in its present form.
 *
 * Pinned as BEHAVIOUR, not as source text. The consonant table and the gap expression will be
 * tightened again; what must not come back is "Box" resolving to an Alexandria seat.
 */

/** True when the address names the place. Fails loudly when the place will not compile at all. */
function names(arabic: string, address: string): boolean {
  const place = compileArabicPlace(arabic);
  assert.ok(place, `"${arabic}" must compile — this case is about matching, not about refusal`);
  return addressNamesPlace(place, addressWords(address));
}

export async function runArabicPlaceMatchTests(): Promise<void> {
  // ── 1. The five wrong answers the owner named ──────────────────────────────
  // Each of these was a CONFIDENT pre-fill on a real CV, sending a candidate to a manager in a
  // governorate they have never lived in. Three of the five addresses are not even in Egypt.
  {
    const wrong: Array<[string, string, string]> = [
      ["باكوس", "Post Office Box 5, Suma - Ahenkro", "Bacos, an Alexandria seat, from the word BOX"],
      ["جرجا", "No 20, Off Elioparanwo Road, By Ada George Road", "Girga, a Sohag seat, from the name GEORGE"],
      ["القرشية", "House R-397 Sector 15A/5 Bufferzone Karachi 75850", "a Gharbia seat, from KARACHI"],
      ["المطار", "Matarya", "the AIRPORT, an Alexandria seat, from Matarya in Cairo"],
      ["الناصرية", "Nasser, Beni Suef, Egypt", "a Gharbia seat, from the name NASSER"],
      ["القرين", "A 2160, UGF, Green fields colony, Faridabad, Haryana 121002.", "a Sharkia seat, from GREEN"],
      ["ابو يوسف", "50 Youssef Ibn-AyoubStreet, Shoba, Cairo, Egypt.", "an Alexandria seat, from a man's name"],
      ["سخا", "10 El seha St , Ezbet El Nakhl, Cairo", "a Kafr El-Sheikh seat, from Health Street in Cairo"],
      ["بحرى", "27 OMAR MAKRAM St. from ALGALAA ALBAHARY St., SHEBIN EL KOM", "an Alexandria seat, from 'northern'"],
      ["المنشاة", "Manshet elsadr hadayk elkoba", "a Port Said seat, from Manshiet El Sadr in Cairo"],
    ];
    for (const [arabic, address, damage] of wrong) {
      const place = compileArabicPlace(arabic);
      // Some are refused outright now (a bare direction, a name whose first word will not compile);
      // the rest compile and simply do not match. Either answer is correct — what is forbidden is
      // the match.
      const matched = place !== null && addressNamesPlace(place, addressWords(address));
      assert.equal(matched, false, `"${address}" must not resolve to ${damage}`);
    }
  }

  // ── 2. Real Egyptian spellings still resolve ───────────────────────────────
  // Precision is worthless if it is bought by matching nothing. Every pair here is a brick name
  // from the production table beside an address a candidate actually wrote.
  {
    const right: Array<[string, string]> = [
      ["باكوس", "Bacos, Alexandria"],
      ["المطار", "El Matar Road"],
      ["المطريه", "Matarya"],
      ["المطريه", "Matareya"],
      ["عابدين", "Abdeen"],
      ["المرج", "El Marg"],
      ["الزيتون", "Helmeyet El-Zeitoun"],
      ["الزيتون", "Zaytoun"],
      ["المعادى", "Maadi"],
      ["المعادى", "Zahra Almaadi"],
      ["الهرم", "El Haram, Giza"],
      ["كرداسه", "Kerdasa"],
      ["العمرانيه", "Omraneya"],
      ["الطالبيه", "Talbeya"],
      ["شبرا", "Shoubra Masr"],
      ["منشية البكرى", "Manshiyet El Bakry"],
      ["حدائق المعادى", "Hadayek El Maadi"],
      ["مصر الجديدة", "Masr El Gedida"],
      ["البساتين", "Basateen"],
      ["حلوان", "Helwan"],
      ["المعصره", "El Masara, Helwan"],
      ["فيصل", "Faisal Street"],
      ["الظاهر", "El Zaher"],
      ["جرجا", "Girga, Sohag"],
      ["القرشية", "Qurashiya"],
      ["الناصرية", "Nasriya"],
      ["المنشاة", "El Manshaa, Port Said"],
      ["دار السلام", "Dar El Salam"],
      ["الزقازيق", "Zagazig, Sharkia"],
      ["شبين الكوم", "SHEBIN EL KOM, Menoufia"],
      ["عزبة النخل", "10 El seha St , Ezbet El Nakhl, Cairo"],
    ];
    for (const [arabic, address] of right) {
      assert.equal(names(arabic, address), true, `"${address}" names ${arabic} and must resolve to it`);
    }
  }

  // ── 3. A long vowel of the wrong colour is not a match ─────────────────────
  // The whole scheme rests on this. Arabic does not write short vowels, so they are free; it DOES
  // write ا و ي, so those are fixed. باكوس is b-A-k-OU-s: "bacos" fits, "box" cannot, and the only
  // thing standing between them is that the O of "box" is where the A must be.
  {
    assert.equal(names("باكوس", "bacos"), true, "bacos is Bacos");
    assert.equal(names("باكوس", "box"), false, "box has no A where Bacos writes one");
    assert.equal(names("باكوس", "bakous"), true, "the same name spelled with a k and an ou");
    assert.equal(names("المطار", "matar"), true, "El Matar ends on its R");
    assert.equal(names("المطار", "matarya"), false, "Matarya has a syllable the airport does not");
    assert.equal(names("المطريه", "matarya"), true, "and Matarya is its own place");
    assert.equal(names("المطريه", "matar"), false, "which the airport is not");
  }

  // ── 4. Arabic writes the vowel a name ends on ──────────────────────────────
  // A name ending in a consonant matches only a word ending in a consonant. Without this, الظاهر
  // (El Zaher, a Cairo district) answered to "Zahra Almaadi", which is a different district
  // entirely — and both are in Cairo, so no governorate check would ever have caught it.
  {
    assert.equal(names("الظاهر", "zaher"), true, "El Zaher ends on its R, and so does Zaher");
    assert.equal(names("الظاهر", "zahra"), false, "Zahra ends on a vowel El Zaher does not write");
    assert.equal(names("الظاهرية", "zahra"), false, "and El Zahereya needs its ي as well");
    assert.equal(names("جرجا", "girga"), true, "Girga ends on its ا, so the final a is required");
    assert.equal(names("كرداسه", "kerdasa"), true, "and a final ه is never silent in English");
    assert.equal(names("المعصره", "masr"), false, "El Masara is not Masr");
  }

  // ── 5. A word that will not compile fails its whole place ──────────────────
  // It used to be dropped, which silently turned the two-word "أبو يوسف" into the one-word "يوسف"
  // and matched anybody with Youssef in their street name. A name is all of its words or none.
  {
    assert.equal(names("ابو يوسف", "Abu Youssef"), true, "both words present, so the place is named");
    assert.equal(names("ابو يوسف", "Youssef Ibn-Ayoub Street"), false, "half a name is not the name");
    assert.equal(names("شبين الكوم", "Shebin El Kom"), true, "both words present");
    assert.equal(names("شبين الكوم", "El Kom"), false, "one word of two is not enough");
  }

  // ── 6. What is refused outright, and why ───────────────────────────────────
  // Refusing is a precision decision. A street belongs to one area, but Saad Zaghloul has a street
  // in most Egyptian cities, so matching one would place a candidate in Haram for living in Tanta.
  {
    for (const street of ["ش زغلول", "شارع الميرغنى", "ميدان رمسيس", "ش الجيش"]) {
      assert.equal(compileArabicPlace(street), null, `a street or a square identifies nowhere: ${street}`);
    }
    assert.equal(compileArabicPlace("بحرى"), null, "a bare direction — 'northern' — identifies nowhere");
    assert.notEqual(compileArabicPlace("الساحل الشمالي"), null, "but a direction INSIDE a name is kept");
    assert.notEqual(compileArabicPlace("المعادى"), null, "two consonants pinned by two long vowels is an identity");
  }

  // ── 7. English address vocabulary is never an Egyptian place ───────────────
  // The matcher's question is "is this English word an Egyptian name in Latin letters", and for
  // these the answer is no before any phonetics are consulted. القرين is legitimately spelled with
  // a g — الزقازيق is Zagazig — so "green" cannot be excluded by the consonant table without also
  // breaking Zagazig.
  {
    const words = addressWords("Post Office Box 5, Green fields colony, New Cairo City, Gate 2");
    for (const english of ["post", "office", "box", "green", "fields", "colony", "new", "city", "gate"]) {
      assert.ok(!words.includes(english), `an ordinary English address word is not a place name: ${english}`);
    }
    assert.ok(words.includes("cairo"), "but a real place in the same address survives");
  }

  // ── 8. The article is not part of the name ─────────────────────────────────
  // El Haram, Al Haram and Haram are one place, on both sides of the comparison, and "Almaadi"
  // written as one word is El Maadi.
  {
    assert.equal(names("الهرم", "El Haram"), true, "written with the article");
    assert.equal(names("الهرم", "Haram"), true, "and without it");
    assert.equal(names("المعادى", "Almaadi"), true, "article glued to the front of the English word");
  }

  // ── 9. English spells one short vowel with two letters ─────────────────────
  // Arabic writes no vowel at all between the ش and the ب of شبرا, and English writes "ou" there.
  // A gap of a single letter would refuse every one of these.
  {
    assert.equal(names("شبرا", "Shoubra Masr"), true, "the OU of Shoubra stands for no Arabic letter");
    assert.equal(names("البساتين", "Basateen"), true, "and the EE of Basateen for a short one");
    assert.equal(names("الطالبيه", "Talbeya"), true, "and the EYA of Talbeya carries the ي and the ة");
    assert.equal(names("العمرانيه", "Omraneya"), true, "same ending, and an O for the ع that opens it");
  }
}
