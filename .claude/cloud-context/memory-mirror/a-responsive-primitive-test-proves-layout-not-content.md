---
name: a-responsive-primitive-test-proves-layout-not-content
description: "A mobile card can use PortalResponsiveDataList and still be missing half the columns its desktop table shows — the primitive check proves the LAYOUT, never the CONTENT, so audit every card against its own table."
metadata:
  node_type: memory
  type: project
  originSessionId: ef45b053-0c83-4e60-94b7-2083401c5d8b
  modified: 2026-08-21T10:40:59.496Z
---

The usual mobile-card test asserts two things: the rows go through
`<PortalResponsiveDataList>`, and no `<table>` is hand-rolled. **Both can pass while the card shows
strictly less information than the table beside it.** The assertion is about layout. Nobody was
checking content.

Pharmacy Search shipped with **two** such gaps, in one module, and the primitive test was green
throughout:

| Section | Desktop columns | What the card actually had |
| --- | --- | --- |
| Results | Pharmacy, Brick, Area, Region, **Distributor**, Code, Address | Distributor missing → a bare `0001559807` with no owner |
| Distributor codes | Distributor, Code, Brick, **Area**, Source | Area missing → two thirds of "brick, area and region" |
| Doctors nearby | Doctor, Speciality, Distance, Visits, Last seen | complete |
| Hospitals | Hospital, Distance, Located by, Source, Address | complete |

The owner found the first one himself, by asking *"where is distributor name and code?"* — the
honest answer being "on desktop, not on your phone". The second was found only by then auditing
**every** card in the module against its own table, which is the move to reach for straight away.

**Two things that make this easy to miss:**

- A card legitimately carries some fields **outside** `PortalRecordFields` — distance and
  speciality ride in the card's `status` and `meta` slots. So a field-list diff alone reports false
  gaps. Compare against title/meta/status/fields *together*.
- Not every column belongs on a card. Region is deliberately absent from the distributor-codes
  table AND card: it is derived from the area, and the pharmacy's own region already sits in the
  header. **Parity is the default, not the rule** — say why in a comment when you omit one.

**How to apply:** when a test pins the responsive primitive, write a second assertion that pins the
*fields*, sliced to that one renderer — `source.slice(indexOf("renderCard="), indexOf("renderTable="))`
— so the desktop table below it cannot be what satisfies the check. That slicing is the whole trick;
without it the assertion passes on the table's own markup and proves nothing.

Contrast [[crm-mobile-cards-are-module-wide-and-ci-enforced]], where `src/components/crm` has a
whole-directory test — stronger, but still a layout check, so the same content drift is possible
there and has never been audited.

Related: [[portal-grid-items-need-min-w-0-for-nowrap-cards]],
[[verify-a-mobile-layout-without-a-dev-server]],
[[prove-it-fails-verify-which-assertion-fired]].
