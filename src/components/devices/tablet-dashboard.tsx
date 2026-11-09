"use client";

/**
 * The Tablet Dashboard body: the overview strip and the fleet map on top, the full fleet list with
 * every tablet's drill-down beneath.
 *
 * 🔴 ONE EXTRA READ, AND ONLY FOR THE HEADER. The overview tiles and the map need the fleet as a
 * whole, so this reads it once; the list below is `HeadwindFleet`, which owns its own read and all the
 * interaction (it refreshes itself after every action). If this header read fails, the tiles and the
 * map simply do not show — `HeadwindFleet` still renders and reports the failure in its own words, so
 * the page never shows two red boxes for one problem.
 */

import { useEffect, useState } from "react";

import { HeadwindFleet } from "@/components/devices/headwind-fleet";
import { TabletFleetMap } from "@/components/devices/tablet-fleet-map";
import { TabletFleetOverview } from "@/components/devices/tablet-fleet-overview";
import { fleetRowsToPoints } from "@/lib/devices/headwind/dashboard";
import { TABLET_NO_FIX_LIMIT_HOURS } from "@/lib/devices/headwind/fleet-watch";
import type { RepHeadwindRow } from "@/lib/devices/headwind/fleet";

type FleetHead = { rows: RepHeadwindRow[]; registerError: boolean };

export function TabletDashboard() {
  const [head, setHead] = useState<FleetHead | null>(null);

  useEffect(() => {
    let current = true;
    void fetch("/api/devices/headwind", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (!current || !data || typeof data !== "object") return;
        const body = data as { rows?: unknown; registerError?: unknown };
        if (Array.isArray(body.rows)) {
          setHead({ registerError: body.registerError === true, rows: body.rows as RepHeadwindRow[] });
        }
      })
      .catch(() => {
        // The header stays hidden; HeadwindFleet below surfaces the failure.
      });
    return () => {
      current = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      {head ? (
        <>
          <TabletFleetOverview registerError={head.registerError} rows={head.rows} />
          <TabletFleetMap
            caption={`Each pin is a tablet's last-known position; hover one for the tablet, who holds it and when the position was taken. A faded pin is older than ${TABLET_NO_FIX_LIMIT_HOURS} hours or carries no time — it is where the tablet was, not where it is. A tablet with no pin has not reported a position.`}
            kind="fleet"
            points={fleetRowsToPoints(head.rows)}
            title="Where the tablets are"
          />
        </>
      ) : null}
      <HeadwindFleet />
    </div>
  );
}
