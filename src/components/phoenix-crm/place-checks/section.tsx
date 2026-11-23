/**
 * Phoenix CRM — Place checks: the titled card every panel of the board sets its lists in.
 *
 * It is the admin shell's own titled card, under the board's name for it, so the board keeps the look of
 * its sibling pages (Same place, Same customer, Camera reviews).
 *
 * 🔴 A LANE'S CARD HAS A ONE-ROW HEAD (owner, 23 Nov 2026: "Fix them", after the re-score). The shell's
 * head is a title over a sentence, 81 px tall, and above it stood a 38 px line of why the rows are his.
 * On the Super Admin's two lanes the title, that line and the "Pick rows" slot stand in ONE row, about
 * 43 px: the first waiting place moved from 546 px to 376 px on a 1440 page and from 637 px to 326 px on
 * his own screen, with the page top (measured on the live page's own elements, 23 Nov 2026). A panel
 * that hands no `lane` keeps the shell's head exactly.
 *
 * 🔴 A PANEL DRAWS NO TABLE. Each list a panel holds owns its table AND its phone cards (`CrmCardsOnPhone`):
 * the waiting queue, the buildings, the places in use, the sent-back customers, the scorecard. The
 * fits-the-screen rule is therefore proven where the table is, not where its title is:
 * `tests/phoenix-crm-place-check-lanes.test.ts` reads every list a panel draws for its phone cards, and
 * `tests/table-structure-ratchet.test.ts` reads each of those list files as the table file it is.
 */

import type { ReactNode } from "react";

// 🔴 Imported as a TITLED CARD, because that is all it is here: this file draws no table. The list a
// panel holds owns its table AND its phone cards, and the lanes test reads each list for both, so the
// table ratchet must keep reading the lists and never this file.
import { AdminTableShell as TitledCard } from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";

export function PlaceCheckSection({
  action,
  children,
  description,
  lane,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  description: string;
  /** What a lane says beside its title. Handed in, the head is one row; left out, it is the shell's own. */
  lane?: ReactNode;
  title: string;
}) {
  if (lane === undefined) {
    return (
      <TitledCard action={action} description={description} title={title}>
        {children}
      </TitledCard>
    );
  }
  return (
    <Card className="overflow-hidden border border-slate-200/90 bg-white p-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200/80 bg-white px-4 py-2 sm:px-5" data-lane-head>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="h-2 w-2 shrink-0 bg-phx-accent" />
          <h2 className="min-w-0 break-words text-base font-black tracking-tight text-slate-900">{title}</h2>
        </div>
        {/* A lane's plain sentence is a desktop's: on a phone the row's own buttons say it, and it stood three lines above the first place. A lane's fold ("Why these are your call") is one row there and stays. */}
        <div className={typeof lane === "string" ? "min-w-0 flex-1 basis-60 break-words text-sm text-slate-600 max-sm:hidden" : "min-w-0 flex-1 basis-60 break-words text-sm text-slate-600"}>{lane}</div>
        {action ? <div className="w-full min-w-0 sm:w-auto">{action}</div> : null}
      </div>
      {children}
    </Card>
  );
}
