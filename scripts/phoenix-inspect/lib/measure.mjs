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
 *   tapTargets      on a mobile viewport, interactive elements under 44 x 44 px that a person can reach:
 *                   on screen, and not inside an `inert` or `aria-hidden="true"` subtree (a closed menu
 *                   drawer is both, slid off-screen; until 14 Nov 2026 its links were counted).
 *   contrast        text below WCAG AA against its first opaque ancestor background. Every colour is
 *                   first converted to sRGB by cssColourToRgba (this app's styles compute to lab() and
 *                   oklch(); until 14 Nov 2026 only rgb() was read, so every Tailwind colour was skipped
 *                   and a dark lab() band read as white). Text whose colour or ground cannot be read, or
 *                   sits over a background image, is counted in contrast.unmeasured, never guessed.
 *   scrollers       internal scroll containers (overflow auto/scroll with hidden content).
 *
 * explore.mjs calls it as `(${measurePage})(${cssColourToRgba}, options)` (see measurePageCall),
 * because a function handed to page.evaluate cannot reach anything outside its own source.
 */

/**
 * Any computed CSS colour to sRGB bytes and alpha: { r, g, b, a } with r, g, b in 0..255, or null when
 * the value is not a colour this reads. Self-contained (no outer references) so it can run in the page.
 * Covers rgb()/rgba(), hex, the named keywords a computed style can return, lab(), lch(), oklab(),
 * oklch() and color(srgb | srgb-linear | display-p3 | xyz | xyz-d50 | xyz-d65), per CSS Color 4.
 * Out-of-gamut values are clipped per channel.
 */
export function cssColourToRgba(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const named = { black: [0, 0, 0], white: [255, 255, 255] };
  if (named[text]) return { r: named[text][0], g: named[text][1], b: named[text][2], a: 1 };
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const toByte = (v) => Math.round(clamp01(v) * 255);
  const encode = (v) => (Math.abs(v) <= 0.0031308 ? 12.92 * v : Math.sign(v) * (1.055 * Math.abs(v) ** (1 / 2.4) - 0.055));
  const decode = (v) => (Math.abs(v) <= 0.04045 ? v / 12.92 : Math.sign(v) * ((Math.abs(v) + 0.055) / 1.055) ** 2.4);
  const mul = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  const XYZ65_TO_LRGB = [
    [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
    [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
    [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
  ];
  const D50_TO_D65 = [
    [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
    [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
    [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
  ];
  const P3_TO_XYZ65 = [
    [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
    [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
    [0, 0.04511338185890264, 1.043944368900976],
  ];
  const fromLinear = ([r, g, b], a) => ({ r: toByte(encode(r)), g: toByte(encode(g)), b: toByte(encode(b)), a: clamp01(a) });
  const labToLinear = (L, A, B) => {
    const k = 24389 / 27;
    const e = 216 / 24389;
    const f1 = (L + 16) / 116;
    const f0 = A / 500 + f1;
    const f2 = f1 - B / 200;
    const x = f0 ** 3 > e ? f0 ** 3 : (116 * f0 - 16) / k;
    const y = L > k * e ? ((L + 16) / 116) ** 3 : L / k;
    const z = f2 ** 3 > e ? f2 ** 3 : (116 * f2 - 16) / k;
    const xyz50 = [x * (0.3457 / 0.3585), y, z * ((1 - 0.3457 - 0.3585) / 0.3585)];
    return mul(XYZ65_TO_LRGB, mul(D50_TO_D65, xyz50));
  };
  const oklabToLinear = (L, A, B) => {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  };

  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (!/^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) return null;
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const n = (i) => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
  }
  const match = text.match(/^([a-z-]+)\((.*)\)$/);
  if (!match) return null;
  const [, fn, body] = match;
  const [channelText, alphaText] = body.includes("/") ? body.split("/") : [body, null];
  const parts = channelText.split(/[\s,]+/).filter(Boolean);
  const num = (token, percentScale = 1) => {
    if (token === undefined) return NaN;
    if (token === "none") return 0;
    if (token.endsWith("%")) return (parseFloat(token) / 100) * percentScale;
    if (token.endsWith("deg")) return parseFloat(token);
    return parseFloat(token);
  };
  let alpha = 1;
  const alphaToken = alphaText !== null ? alphaText.trim() : fn === "rgba" || (fn === "rgb" && parts.length === 4) ? parts[3] : undefined;
  if (alphaToken !== undefined) alpha = num(alphaToken, 1);
  const ok = (...values) => values.every((v) => Number.isFinite(v)) && Number.isFinite(alpha);

  if (fn === "rgb" || fn === "rgba") {
    const [r, g, b] = [0, 1, 2].map((i) => num(parts[i], 255));
    if (!ok(r, g, b)) return null;
    return { r: Math.round(Math.min(255, Math.max(0, r))), g: Math.round(Math.min(255, Math.max(0, g))), b: Math.round(Math.min(255, Math.max(0, b))), a: clamp01(alpha) };
  }
  if (fn === "lab" || fn === "lch") {
    const L = num(parts[0], 100);
    let A = num(parts[1], fn === "lab" ? 125 : 150);
    let B = num(parts[2], 125);
    if (fn === "lch") {
      const hue = (num(parts[2]) * Math.PI) / 180;
      [A, B] = [A * Math.cos(hue), A * Math.sin(hue)];
    }
    if (!ok(L, A, B)) return null;
    return fromLinear(labToLinear(L, A, B), alpha);
  }
  if (fn === "oklab" || fn === "oklch") {
    const L = num(parts[0], 1);
    let A = num(parts[1], 0.4);
    let B = num(parts[2], 0.4);
    if (fn === "oklch") {
      const hue = (num(parts[2]) * Math.PI) / 180;
      [A, B] = [A * Math.cos(hue), A * Math.sin(hue)];
    }
    if (!ok(L, A, B)) return null;
    return fromLinear(oklabToLinear(L, A, B), alpha);
  }
  if (fn === "color") {
    const [space, ...rest] = parts;
    const [x, y, z] = [0, 1, 2].map((i) => num(rest[i], 1));
    if (!ok(x, y, z)) return null;
    if (space === "srgb") return fromLinear([decode(x), decode(y), decode(z)], alpha);
    if (space === "srgb-linear") return fromLinear([x, y, z], alpha);
    if (space === "display-p3") return fromLinear(mul(XYZ65_TO_LRGB, mul(P3_TO_XYZ65, [decode(x), decode(y), decode(z)])), alpha);
    if (space === "xyz" || space === "xyz-d65") return fromLinear(mul(XYZ65_TO_LRGB, [x, y, z]), alpha);
    if (space === "xyz-d50") return fromLinear(mul(XYZ65_TO_LRGB, mul(D50_TO_D65, [x, y, z])), alpha);
    return null;
  }
  return null;
}

/** The expression page.evaluate runs: measurePage with the colour converter handed in. */
export function measurePageCall(options) {
  return `(${measurePage.toString()})(${cssColourToRgba.toString()}, ${JSON.stringify(options ?? {})})`;
}

export function measurePage(toRgba, options) {
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

  const colourCache = new Map();
  const parseColour = (value) => {
    const key = String(value);
    if (!colourCache.has(key)) colourCache.set(key, toRgba(key));
    return colourCache.get(key);
  };
  // Two colours are the same when their sRGB value is, however the engine happened to write them.
  const colourKey = (value) => {
    const c = parseColour(value);
    return c ? `${c.r},${c.g},${c.b},${Math.round(c.a * 100)}` : `unread:${value}`;
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
  // The first opaque ground behind an element, or null when it cannot be known: a colour this cannot
  // read, or a background image (gradient, picture) met before any opaque colour.
  const backgroundOf = (element) => {
    let node = element;
    while (node && node.nodeType === 1) {
      const nodeStyle = getComputedStyle(node);
      if (nodeStyle.backgroundImage && nodeStyle.backgroundImage !== "none") return null;
      const colour = parseColour(nodeStyle.backgroundColor);
      if (!colour) return null;
      if (colour.a >= 0.99) return colour;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  // Reachable by a person: on screen across, and not inside an inert or aria-hidden subtree (a closed
  // menu drawer is both, and slid off-screen).
  const reachable = (element, box) =>
    box.right > 0 && box.left < viewportWidth && !element.closest('[inert], [aria-hidden="true"]');

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
        tokenColours.add(colourKey(getComputedStyle(probe).color));
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
    contrast: { count: 0, measured: 0, unmeasured: 0, samples: [] },
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
      if (tokenColours.size > 0 && !tokenColours.has(colourKey(style.color))) {
        out.colours.nonTokenText[style.color] = (out.colours.nonTokenText[style.color] ?? 0) + 1;
      }
      // Contrast only for text a person can reach; text whose colour or ground cannot be read is
      // counted as unmeasured, never scored against a guessed white.
      const fg = reachable(element, box) ? parseColour(style.color) : undefined;
      const ground = fg ? backgroundOf(element) : undefined;
      if (fg === null || ground === null) out.contrast.unmeasured += 1;
      if (fg && fg.a > 0 && ground) {
        out.contrast.measured += 1;
        const ratio = contrastRatio(fg, ground);
        const size = parseFloat(style.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5)) {
          out.contrast.count += 1;
          if (out.contrast.samples.length < SAMPLE) out.contrast.samples.push({ path: pathOf(element), ratio: Math.round(ratio * 100) / 100, fontSize: style.fontSize });
        }
      }
    }
    const bg = parseColour(style.backgroundColor);
    if (bg && bg.a > 0 && tokenColours.size > 0 && !tokenColours.has(colourKey(style.backgroundColor))) {
      out.colours.nonTokenBackground[style.backgroundColor] = (out.colours.nonTokenBackground[style.backgroundColor] ?? 0) + 1;
    }
    if (mobile && reachable(element, box) && element.matches("a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=link], summary")) {
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
    contrastUnmeasured: m.contrast.unmeasured ?? null,
    internalScrollers: m.scrollers.length,
  };
}
