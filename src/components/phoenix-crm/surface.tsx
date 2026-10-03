"use client";

/**
 * Which surface a Phoenix CRM screen is drawn on — and so which controls it may use.
 *
 * 🔒 THE REP'S APP IS NOT TOUCHED BY ANYTHING THAT READS THIS (owner, 2026-10-03: *"i am talking now
 * on admin account … tailored for admins without touching the reps account"*). The module's screens
 * are ONE component tree: the admin shell renders it at /admin/field-crm and the employee portal at
 * /employee-portals/field-crm, so a change made for the admin lands in a medical rep's hands unless
 * something separates them. This context is that separator, and its DEFAULT IS `portal` on purpose —
 * a screen that forgets to declare itself keeps the rep's plain controls rather than quietly gaining
 * the admin's (Golden Rule #1: the rep's app is the simplest thing he touches, and adding any step to
 * his day needs the owner's word first).
 *
 * `portal` is not "the rep" — a district manager, a regional manager, the NSM and every rep open the
 * module there, and all of them keep exactly the controls they had. `admin` is the admin shell alone:
 * the Super Admin, the CEO, the SFE Manager and the Training Manager, plus the module's own admin
 * pages (Load a Customer List, Place Checks, Location Integrity, Duplicate Customers).
 */

import { createContext, useContext, type ReactNode } from "react";

export type CrmSurface = "admin" | "portal";

const CrmSurfaceContext = createContext<CrmSurface>("portal");

export function CrmSurfaceProvider({ children, surface }: { children: ReactNode; surface: CrmSurface }) {
  return <CrmSurfaceContext.Provider value={surface}>{children}</CrmSurfaceContext.Provider>;
}

export function useCrmSurface(): CrmSurface {
  return useContext(CrmSurfaceContext);
}

/**
 * Whether every dropdown on this screen is a COMBO BOX he can type into (owner, 2026-10-03: *"make
 * any droplist have a combo box not just droplist … i am talking now on admin account"*).
 *
 * An admin picks from lists the field force never sees the whole of — 74 rep seats, every line, every
 * month — where a native dropdown means scrolling for a name he already knows. A rep's own lists are
 * two or three items long, so the same control there would be a search box over nothing.
 */
export function useCrmComboBoxes(): boolean {
  return useCrmSurface() === "admin";
}
