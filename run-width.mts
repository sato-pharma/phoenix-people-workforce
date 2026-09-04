import { runSidebarLabelWidthTests } from "./tests/sidebar-label-width.test.ts";
import { runSidebarLabelFontSyncTests } from "./tests/sidebar-label-font-sync.test.ts";
await runSidebarLabelWidthTests();
console.log("PASS  sidebar-label-width");
await runSidebarLabelFontSyncTests();
console.log("PASS  sidebar-label-font-sync");
