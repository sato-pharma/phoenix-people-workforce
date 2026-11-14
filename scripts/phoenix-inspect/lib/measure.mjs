/**
 * Per-screenshot measurements for the visual audit. Each is a number read from the rendered page, so a
 * finding in KPI_REPORTS_VISUAL_AUDIT.md can say "measured", not "looks like".
 *
 * measurePage runs IN the page (serialized by explore.mjs) after masking, so the samples it returns
 * carry element paths and sizes, never text. The pure helpers below it are exported for the tests.
 *
 *   overflow        the fits-the-screen rule: document and <main> scrollWidth beyond clientWidth, and
 *                   the elements whose right edge passes the viewport.
 *   rounded         the square-edge rule: elements whose computed border-radius is not 0.
 *   ellipsis        the no-ellipsis rule: text actually cut by text-overflow: ellipsis or line-clamp.
 *   fontSizes       every computed font size carrying text, with how many elements use it.
 *   colours         text and background colours not equal to any custom-property colour on :root.
 *   tapTargets      on a mobile viewport, interactive elements under 44 x 44 px.
 *   contrast        text below WCAG AA against its first opaque ancestor background.
 *   scrollers       internal scroll containers (overflow auto/scroll with hidden content).
 */

export function measurePage(options) {
  const mobile = Boolean(options?.mobile);
  const SAMPLE = 8;
  const viewportWidth = document.documentElement.clientWidth;

  const pathOf = (element) => {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 4 && node !== document.body) {
      let part = node.tagName.toLowerCase();
      const testId = node.getAttribute("data-testid");
      if (testId) {
        parts.unshift(`${part}[data-testid="${testId}"]`);
        break;
      }
      if (node.id && /^[A-Za-z][\w-]{0,40}$/.test(node.id)) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }
      const role = node.getAttribute("role");
      if (role) part += `[role="${role}"]`;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  };
  const hasOwnText = (element) =>
    [...element.childNodes].some((child) => child.nodeType === 3 && child.nodeValue.trim() !== "");

  const parseColour = (value) => {
    const match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const [r, g, b, a = "1"] = match[1].split(/[\s,/]+/).filter(Boolean);
    return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
  };
  const luminance = ({ r, g, b }) => {
    const channel = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrastRatio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const backgroundOf = (element) => {
    let node = element;
    while (node && node.nodeType === 1) {
      const colour = parseColour(getComputedStyle(node).backgroundColor);
      if (colour && colour.a >= 0.99) return colour;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  // Colours the design tokens define: every custom property on :root that resolves to a colour.
  const tokenColours = new Set();
  const probe = document.createElement("span");
  document.body.appendChild(probe);
  const rootStyle = getComputedStyle(document.documentElement);
  for (const sheet of [...document.styleSheets]) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of [...rules]) {
      if (!rule.style || !/:root|html|\.dark|\[data-theme/.test(rule.selectorText ?? "")) continue;
      for (const name of [...rule.style]) {
        if (!name.startsWith("--")) continue;
        const raw = rootStyle.getPropertyValue(name).trim();
        if (!raw) continue;
        probe.style.color = "";
        probe.style.color = raw;
        if (!probe.style.color) continue;
        tokenColours.add(getComputedStyle(probe).color);
      }
    }
  }
  probe.remove();

  const all = [...document.body.querySelectorAll("*")].filter((element) => !["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName));
  const out = {
    viewport: { width: viewportWidth, height: window.innerHeight },
    documentHeight: document.documentElement.scrollHeight,
    overflow: { document: 0, main: 0, offenders: [] },
    rounded: { count: 0, samples: [] },
    ellipsis: { count: 0, samples: [] },
    fontSizes: {},
    colours: { tokenCount: tokenColours.size, nonTokenText: {}, nonTokenBackground: {} },
    tapTargets: { checked: mobile, count: 0, samples: [] },
    contrast: { count: 0, samples: [] },
    scrollers: [],
  };

  const scroller = document.scrollingElement ?? document.documentElement;
  out.overflow.document = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const main = document.querySelector("main");
  if (main) out.overflow.main = Math.max(0, main.scrollWidth - main.clientWidth);

  for (const element of all) {
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();

    if (box.right > viewportWidth + 1 && out.overflow.offenders.length < SAMPLE && style.position !== "fixed") {
      out.overflow.offenders.push({ path: pathOf(element), right: Math.round(box.right), width: Math.round(box.width) });
    }
    const radius = ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"]
      .map((key) => parseFloat(style[key]) || 0);
    if (radius.some((value) => value > 0)) {
      out.rounded.count += 1;
      if (out.rounded.samples.length < SAMPLE) out.rounded.samples.push({ path: pathOf(element), radius: Math.max(...radius) });
    }
    const clamped = style.webkitLineClamp && style.webkitLineClamp !== "none";
    if ((style.textOverflow === "ellipsis" && element.scrollWidth > element.clientWidth + 1) || (clamped && element.scrollHeight > element.clientHeight + 1)) {
      out.ellipsis.count += 1;
      if (out.ellipsis.samples.length < SAMPLE) out.ellipsis.samples.push({ path: pathOf(element), kind: clamped ? "line-clamp" : "text-overflow" });
    }
    if (hasOwnText(element)) {
      out.fontSizes[style.fontSize] = (out.fontSizes[style.fontSize] ?? 0) + 1;
      if (tokenColours.size > 0 && !tokenColours.has(style.color)) {
        out.colours.nonTokenText[style.color] = (out.colours.nonTokenText[style.color] ?? 0) + 1;
      }
      const fg = parseColour(style.color);
      if (fg && fg.a > 0) {
        const ratio = contrastRatio(fg, backgroundOf(element));
        const size = parseFloat(style.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5)) {
          out.contrast.count += 1;
          if (out.contrast.samples.length < SAMPLE) out.contrast.samples.push({ path: pathOf(element), ratio: Math.round(ratio * 100) / 100, fontSize: style.fontSize });
        }
      }
    }
    const bg = parseColour(style.backgroundColor);
    if (bg && bg.a > 0 && tokenColours.size > 0 && !tokenColours.has(style.backgroundColor)) {
      out.colours.nonTokenBackground[style.backgroundColor] = (out.colours.nonTokenBackground[style.backgroundColor] ?? 0) + 1;
    }
    if (mobile && element.matches("a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=link], summary")) {
      if (box.width < 44 || box.height < 44) {
        out.tapTargets.count += 1;
        if (out.tapTargets.samples.length < SAMPLE) out.tapTargets.samples.push({ path: pathOf(element), width: Math.round(box.width), height: Math.round(box.height) });
      }
    }
    const scrollsY = /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    const scrollsX = /(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
    if ((scrollsX || scrollsY) && element !== scroller && out.scrollers.length < 12) {
      out.scrollers.push({
        path: pathOf(element),
        axis: scrollsX && scrollsY ? "both" : scrollsX ? "x" : "y",
        client: { width: element.clientWidth, height: element.clientHeight },
        content: { width: element.scrollWidth, height: element.scrollHeight },
      });
    }
  }
  return out;
}

/** The headline numbers of one measurement, for the manifest and the audit table. */
export function summarizeMeasurements(m) {
  return {
    horizontalOverflowPx: Math.max(m.overflow.document, m.overflow.main),
    roundedElements: m.rounded.count,
    ellipsisCuts: m.ellipsis.count,
    distinctFontSizes: Object.keys(m.fontSizes).length,
    nonTokenTextColours: Object.keys(m.colours.nonTokenText).length,
    nonTokenBackgrounds: Object.keys(m.colours.nonTokenBackground).length,
    smallTapTargets: m.tapTargets.checked ? m.tapTargets.count : null,
    lowContrastText: m.contrast.count,
    internalScrollers: m.scrollers.length,
  };
}
