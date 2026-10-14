/**
 * The way from a PERSON's box on the organogram to that same person's record in Employee Master.
 *
 * `vacancy-hire-link.ts` already carries an OPEN SEAT across to the Add Employee form. This is its
 * sibling for a FILLED seat: pressing Edit on a tile opens that employee's edit form, and pressing
 * Resign opens the resignation dialog for them — both on the real Employee Master screen, so the
 * chart never grows a second copy of either form.
 *
 * It carries ONLY the HR id. Nothing about the person travels in the URL, because everything the
 * edit form needs is read from the directory the master page loads for the viewer — which is also
 * what keeps this safe: an id for somebody outside the viewer's scope simply finds no row there, and
 * the master says so instead of opening anything.
 */

export type EmployeeMasterAction = "edit" | "resign";

const ACTION_PARAMS: Record<EmployeeMasterAction, string> = {
  edit: "edit",
  resign: "resign",
};

/**
 * Employee Master lives at two routes, one per shell. The chart renders in both, so the base is
 * derived from where we already are (the same trick the seat popup uses for its own way out).
 */
export function employeeMasterBasePath(pathname: string | null | undefined) {
  return pathname?.startsWith("/employee-portals") ? "/employee-portals/employees" : "/employees";
}

/** `/employees?edit=<hr id>` or `/employees?resign=<hr id>` — basePath decides the shell. */
export function buildEmployeeMasterHref(
  basePath: string,
  action: EmployeeMasterAction,
  hrId: string,
) {
  return `${basePath}?${ACTION_PARAMS[action]}=${encodeURIComponent(hrId.trim())}`;
}

export type EmployeeMasterArrival = {
  action: EmployeeMasterAction;
  hrId: string;
};

/**
 * Read the arrival back out. Takes a getter rather than a URLSearchParams so it serves a plain
 * URLSearchParams and Next's ReadonlyURLSearchParams without a cast.
 *
 * Returns null when neither param is present, so an unrelated visit to Employee Master is left
 * completely alone. `edit` wins if both are somehow present: it opens a form, while `resign` is the
 * one that leads towards ending somebody's employment, and an ambiguous link should never pick that.
 */
export function readEmployeeMasterArrival(
  get: (key: string) => string | null,
): EmployeeMasterArrival | null {
  for (const action of ["edit", "resign"] as const) {
    const hrId = String(get(ACTION_PARAMS[action]) ?? "").trim();
    if (hrId) return { action, hrId };
  }
  return null;
}

/** Stable identity for one arrival — used to apply it exactly once per visit. */
export function employeeMasterArrivalKey(arrival: EmployeeMasterArrival) {
  return `${arrival.action}|${arrival.hrId.toLowerCase()}`;
}
