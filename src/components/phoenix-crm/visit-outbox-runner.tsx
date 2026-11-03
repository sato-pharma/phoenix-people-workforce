"use client";

/**
 * Phoenix CRM — keeps a held visit moving wherever the rep is in Phoenix.
 *
 * 🔴 IT SITS IN THE SHELLS, BESIDE THE PUSH PROVIDER, BECAUSE AN INACTIVE TAB UNMOUNTS. Inside the Visits tab it
 * would stop the moment the rep looked at anything else. So it is on every page, and it stays small: one storage
 * read, and nothing else at all for the person with nothing held. The sending code is its own chunk, loaded
 * only once a phone holds a visit.
 *
 * `ownerHrId` is the shell's push identity (`pushIdentityOf`): null for a seat view and a test login, which
 * therefore have no queue and behave as they always did.
 */

import { useEffect } from "react";

import { browserLocalStorage, ownerScopedStorageKey, VISIT_OUTBOX_CHANGED_EVENT, VISIT_OUTBOX_KEY_BASE } from "@/lib/browser-storage/owner-scoped";

function holdsAnything(ownerHrId: string): boolean {
  const key = ownerScopedStorageKey(VISIT_OUTBOX_KEY_BASE, ownerHrId);
  try {
    return key !== null && browserLocalStorage()?.getItem(key) != null;
  } catch {
    return false;
  }
}

export function VisitOutboxRunner({ ownerHrId }: { ownerHrId?: string | null }) {
  useEffect(() => {
    if (!ownerHrId) return;
    let unmounted = false;
    let starting = false;
    let engine: { wake: () => void; stop: () => void } | null = null;

    const look = () => {
      if (engine || starting || !holdsAnything(ownerHrId)) return;
      starting = true;
      void import("@/components/phoenix-crm/visit-outbox-engine")
        .then(({ startVisitOutbox }) => {
          if (!unmounted) engine = startVisitOutbox(ownerHrId);
        })
        .catch(() => undefined)
        .finally(() => {
          starting = false;
        });
    };

    look();
    window.addEventListener(VISIT_OUTBOX_CHANGED_EVENT, look);
    return () => {
      unmounted = true;
      window.removeEventListener(VISIT_OUTBOX_CHANGED_EVENT, look);
      engine?.stop();
    };
  }, [ownerHrId]);

  return null;
}
