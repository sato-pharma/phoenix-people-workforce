import assert from "node:assert/strict";

import {
  findOverdueAcceptedOffers,
  type AcceptedOfferForHireCheck,
} from "@/lib/reconciliation/overdue-accepted-offers";

const TODAY = "2026-10-02"; // the day the real El Sayed Rady case was found

function offer(partial: Partial<AcceptedOfferForHireCheck> & { id: string }): AcceptedOfferForHireCheck {
  return {
    candidateName: partial.candidateName ?? `cand-${partial.id}`,
    territory: partial.territory ?? null,
    title: partial.title ?? null,
    startDate: partial.startDate ?? null,
    vacancyId: partial.vacancyId ?? null,
    id: partial.id,
  };
}

export function runOverdueAcceptedOffersTests() {
  // ── The headline: the real production case must be caught ──
  //
  // El Sayed Rady accepted, letter start "01 October 2026", seat (vacancy 375) still open on the
  // 2nd. This is exactly the chair the owner found empty by eye, and the whole reason the check
  // exists. Letter-format date, one day overdue.
  const elSayedRady = offer({
    id: "a78d792b",
    candidateName: "El Sayed Rady",
    title: "Medical Representative",
    territory: "Dakahlia (French Line)",
    startDate: "01 October 2026",
    vacancyId: 375,
  });
  const found = findOverdueAcceptedOffers({
    offers: [elSayedRady],
    openVacancyIds: new Set([375]),
    today: TODAY,
  });
  assert.equal(found.length, 1, "an accepted offer overdue with an open seat must be flagged");
  assert.equal(found[0]?.candidateName, "El Sayed Rady");
  assert.equal(found[0]?.startDateIso, "2026-10-01", "the letter date must parse to ISO");
  assert.equal(found[0]?.daysOverdue, 1, "started yesterday is one day overdue");

  // ── The one-day grace: a person whose first day is TODAY is not yet overdue ──
  //
  // HR may still add them during the day. Flagging a same-day start would page on every fresh hire,
  // which is how a check becomes wallpaper nobody reads on the night it is right.
  assert.equal(
    findOverdueAcceptedOffers({
      offers: [offer({ id: "today", startDate: "02 October 2026", vacancyId: 1 })],
      openVacancyIds: new Set([1]),
      today: TODAY,
    }).length,
    0,
    "a start date of today is not overdue",
  );

  // A future start (Asmaa Zaghloul's real 04 October) is never flagged.
  assert.equal(
    findOverdueAcceptedOffers({
      offers: [offer({ id: "future", startDate: "04 October 2026", vacancyId: 2 })],
      openVacancyIds: new Set([2]),
      today: TODAY,
    }).length,
    0,
    "a future start date is not overdue",
  );

  // ── A FILLED seat means the hire happened — the signal, never a name ──
  //
  // The vacancy is absent from the open set, so the person was added even though the offer date has
  // passed. This is the 13 real hires that a name match wrongly reported as missing; the vacancy
  // state is what keeps the check false-positive-proof.
  assert.equal(
    findOverdueAcceptedOffers({
      offers: [offer({ id: "hired", startDate: "01 October 2026", vacancyId: 99 })],
      openVacancyIds: new Set([1, 2, 3]), // 99 is NOT here → seat filled
      today: TODAY,
    }).length,
    0,
    "an overdue offer whose seat is already filled is not a gap",
  );

  // ── A letter with no seat pointer is skipped, not guessed at ──
  //
  // The pre-2026-09-29 letter era carried no vacancy_id; those people were all added, and there is
  // no reliable seat to check, so the check must not flag them (it would be a pure false positive).
  assert.equal(
    findOverdueAcceptedOffers({
      offers: [offer({ id: "no-seat", startDate: "01 October 2026", vacancyId: null })],
      openVacancyIds: new Set<number>(),
      today: TODAY,
    }).length,
    0,
    "an offer with no seat pointer is not machine-checkable and must be skipped",
  );

  // ── An unreadable date is skipped, never guessed into a breach ──
  for (const bad of ["", "soon", "2026-13-40", "next month"]) {
    assert.equal(
      findOverdueAcceptedOffers({
        offers: [offer({ id: `bad-${bad}`, startDate: bad, vacancyId: 5 })],
        openVacancyIds: new Set([5]),
        today: TODAY,
      }).length,
      0,
      `an unreadable start date ("${bad}") must be skipped, not treated as overdue`,
    );
  }

  // ── A long-overdue letter-format date, and ISO-format support ──
  const longOverdue = findOverdueAcceptedOffers({
    offers: [
      offer({ id: "sep13", candidateName: "Letter Person", startDate: "13 September 2026", vacancyId: 7 }),
      offer({ id: "iso", candidateName: "Iso Person", startDate: "2026-09-20", vacancyId: 8 }),
    ],
    openVacancyIds: new Set([7, 8]),
    today: TODAY,
  });
  assert.equal(longOverdue.length, 2, "both a letter-format and an ISO start date must be read");
  // ── Most overdue first ──
  assert.equal(longOverdue[0]?.candidateName, "Letter Person", "the longest-overdue offer sorts first");
  assert.equal(longOverdue[0]?.daysOverdue, 19, "13 Sep to 2 Oct is 19 days");
  assert.equal(longOverdue[1]?.daysOverdue, 12, "20 Sep to 2 Oct is 12 days");
}
