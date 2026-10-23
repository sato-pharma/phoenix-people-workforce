// Measures, on every page, the gap between the lowest piece of content and the footer rule.
// Usage: node measure-foot.mjs <handbook.html> <chrome.exe> <profileDir>
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [html, chrome, profile] = process.argv.slice(2);
const probe = `<script>
addEventListener("load", () => {
  const mm = 96 / 25.4, out = [];
  document.querySelectorAll("section.page").forEach((page, i) => {
    const foot = page.querySelector(".foot").getBoundingClientRect().top;
    let low = 0, who = "";
    page.querySelectorAll("*").forEach((el) => {
      if (el.closest(".foot") || el.closest(".watermark")) return;
      let n = el, abs = false;
      while (n && n !== page) { if (getComputedStyle(n).position === "absolute" || getComputedStyle(n).position === "fixed") { abs = true; break; } n = n.parentElement; }
      if (abs) return;
      const b = el.getBoundingClientRect().bottom;
      if (b > low) { low = b; who = el.className || el.tagName; }
    });
    out.push("page " + (i + 1) + ": " + ((foot - low) / mm).toFixed(1) + " mm above the footer rule (lowest: " + who + ")");
  });
  const pre = document.createElement("pre"); pre.id = "measure"; pre.textContent = out.join("\\n"); document.body.append(pre);
});
</script>`;
const tmp = html.replace(/\.html$/, ".measure.html");
writeFileSync(tmp, readFileSync(html, "utf8").replace("</body>", probe + "</body>")); // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag — a fixed probe injected into a local copy the designer measures
const dom = execFileSync(chrome, ["--headless=new", "--disable-gpu", `--user-data-dir=${profile}`, "--window-size=794,1123",
  "--virtual-time-budget=5000", "--dump-dom", "file:///" + tmp.replace(/\\/g, "/")], { encoding: "utf8", maxBuffer: 1 << 30 });
console.log((dom.match(/<pre id="measure">([\s\S]*?)<\/pre>/) || [, "no measurement"])[1]);
