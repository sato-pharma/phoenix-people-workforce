# Job offers — picking CC and BCC from lists

**Owner, 10 Nov 2026:** "in the cc email field and bcc make them a droplist cascading as per area line
region". Asked what the lists should hold he chose **Managers + HR team**, and asked whether typing an
address by hand should stay he chose **Keep typing too**.

## What HR sees

Under the candidate's email address on the offer form there is a **Pick who to copy** panel:

- Three lists, one after the other: **Line**, then **Region**, then **Area**. Choosing a line fills the
  regions; choosing a region fills the areas. Changing a list clears the ones after it.
- **Area managers:** the chosen area's District Manager, then the Regional Manager and the National Sales
  Manager above it, nearest first. A seat nobody holds today says **Vacant**. Somebody with no work email
  on their employee record is listed, but cannot be added.
- **HR team:** always listed — the HR Manager first, then each HR seat by its job title (Talent
  Acquisition, HR Generalist, HR Operations Specialist).
- Each person has **Add to CC** and **Add to BCC**. Pressing one writes their work email onto the end of
  that box. Somebody already in the box shows **In CC** or **In BCC**; somebody already in CC cannot also
  be added to BCC, because CC wins (a person cannot be copied openly and secretly on one message).

The CC and BCC boxes are unchanged: anything can still be typed, and every existing check — the address
shape, the candidate's own address left off, a limit of 10 copies — applies to what the buttons write.

## Where the lists come from

`src/lib/offers/copy-directory-loader.ts` reads, with the service key, on the server:

| Read | For |
| --- | --- |
| `au_v_line_area_map` — rows in force today on Cairo's calendar | Line → Region → Area, and each area's District Manager seat |
| `au_v_org_tree` — manager seats only (DM, Acting DM, RSM, NSM, CEO) | Climbing from the District Manager to the National Sales Manager; the climb stops below the CEO |
| `au_v_regions`, `lines` | The region and line names |
| `app_auth_users` — active holders of the four HR team roles, test accounts left out | The HR team |
| `employees` | Names (nickname first) and **work** emails; a leaver's seat reads as vacant |

The "Others" pseudo-district is not a person's seat: it is skipped, and the climb carries on above it.

`src/lib/offers/copy-directory.ts` is the pure half that turns those rows into the lists, so the browser and
the test can import it without the database client.

**It never stops the screen.** A failed read is an empty panel (the panel then hides), and a failed HR
team read leaves the managers' lists in place. The lists decide nothing — they only fill the boxes.

Pinned by `tests/offer-copy-picker.test.ts`.
