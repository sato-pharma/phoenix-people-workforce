/**
 * The initials square shared by the report's header and the Employee 360 cards, so the same person
 * wears the same colour on both screens. Flat grounds only: the earlier two-stop gradients were the
 * one ornament left on a page that is otherwise flat colour and hairlines.
 */
export function employeeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const joined = parts.map((part) => part[0] ?? "").join("");
  return joined ? joined.toUpperCase() : "—";
}

const AVATAR_GROUNDS = [
  "bg-orange-600",
  "bg-sky-700",
  "bg-emerald-700",
  "bg-violet-700",
  "bg-rose-700",
  "bg-slate-800",
];

/** A stable ground for one person, picked from their HR ID. */
export function employeeAvatarGround(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_GROUNDS[hash % AVATAR_GROUNDS.length];
}
