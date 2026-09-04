import { adminNavigationSections } from "./src/config/system-navigation.ts";
const out = adminNavigationSections.map((s) => ({
  id: s.id, label: s.label,
  items: s.items.map((i) => ({ label: i.label, href: i.href })),
}));
console.log(JSON.stringify(out, null, 1));
