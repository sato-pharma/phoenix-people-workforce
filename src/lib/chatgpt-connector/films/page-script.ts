/**
 * The script a film adds to every page it opens, before the page's own code runs: the MASKING, and the
 * film's own OVERLAYS (the title card and the captions).
 *
 * Masking (owner, 20 Nov 2026: "Masked data" — real screens, names, phones, salaries and sales swapped for
 * made-up ones, safe to post). Every text the page shows is rewritten before it is painted, and again
 * whenever the page changes it (a MutationObserver), so no frame carries the real value:
 *   - NAMES — every person, doctor, customer and pharmacy name of two words or more Phoenix holds
 *     (connector_film_mask_names(), ~97,000) is swapped, whole words only, for a made-up name in the same
 *     script (Arabic for Arabic). The same real name always gets the same made-up one, so a film stays
 *     consistent from frame to frame, and a made-up name that happens to be a real one is skipped.
 *   - EMAILS — swapped for personNNNN@example.com.
 *   - NUMBERS — every run of three digits or more (salaries, sales, counts, phone numbers, national ids)
 *     gets new digits, the same way every time; dates, times and years (1900–2099) are left alone.
 *   - PHOTOS from Phoenix's file store are blurred. Input boxes are masked like text.
 * What it cannot reach: a picture drawn on a canvas, and text inside a picture. The tool's answer says so.
 *
 * Overlays live in a CLOSED shadow root on the document element, so the page's styles cannot touch them
 * and the masking observer never sees (or rewrites) the film's own words.
 *
 * MASK_CORE is plain JavaScript in a string, not a compiled function, so what runs in the page is exactly
 * what the tests run (tests/chatgpt-connector-films.test.ts evaluates the same string).
 */

/** The masking functions, self-contained. Defines foldText, buildNameIndex, makeMasker. */
export const MASK_CORE = String.raw`
function foldText(s) {
  return String(s).toLowerCase()
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}
var FILM_TOKEN = /[\p{L}\p{M}\p{N}]+/gu;
function tokensOf(s) { return foldText(s).match(FILM_TOKEN) || []; }
function filmHash(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
var FAKE_EN_FIRST = ["Liam","Nora","Adam","Lina","Omar","Maya","Karim","Hana","Sami","Dina","Yusuf","Rana","Ziad","Laila","Tarek","Mira","Nadim","Salma","Rami","Jana","Fadi","Noor","Hadi","Rita"];
var FAKE_EN_LAST = ["Carter","Haddad","Morgan","Fares","Bennett","Saleh","Hayes","Nassar","Brooks","Khoury","Ellis","Mansour","Reed","Azar","Porter","Darwish","Shaw","Rizk","Hale","Tawfik","Lane","Barakat","Wells","Sabri"];
var FAKE_AR_FIRST = ["لينا","آدم","نورا","زياد","ميا","كريم","هنا","سامي","دينا","يوسف","رنا","طارق","ميرا","نديم","جنى","فادي","نور","هادي","ريتا","رامي"];
var FAKE_AR_LAST = ["الحداد","فارس","صالح","نصار","الخوري","منصور","عازر","درويش","رزق","توفيق","بركات","صبري","الشامي","نعيم","سليم","شاكر"];
function buildNameIndex(names) {
  var index = new Map();
  var known = new Set();
  for (var i = 0; i < names.length; i++) {
    var toks = tokensOf(names[i]);
    if (toks.length < 2) continue;
    known.add(toks.join(" "));
    var list = index.get(toks[0]);
    if (!list) { list = []; index.set(toks[0], list); }
    list.push(toks);
  }
  index.forEach(function (list) { list.sort(function (a, b) { return b.length - a.length; }); });
  return { index: index, known: known };
}
function fakeName(original, tokenCount, known) {
  var arabic = /[؀-ۿ]/.test(original);
  var first = arabic ? FAKE_AR_FIRST : FAKE_EN_FIRST;
  var last = arabic ? FAKE_AR_LAST : FAKE_EN_LAST;
  var seed = filmHash(foldText(original));
  for (var attempt = 0; attempt < 12; attempt++) {
    var h = filmHash(seed + ":" + attempt);
    var parts = [first[h % first.length]];
    if (tokenCount >= 3) parts.push(first[(h >>> 8) % first.length]);
    parts.push(last[(h >>> 16) % last.length]);
    var fake = parts.join(" ");
    if (!known.has(tokensOf(fake).join(" "))) return fake;
  }
  return arabic ? "اسم مخفي" : "Name Hidden";
}
function makeMasker(nameIndex) {
  var index = nameIndex.index, known = nameIndex.known;
  function maskNames(text) {
    if (!index.size) return text;
    var spans = [];
    var re = new RegExp(FILM_TOKEN.source, "gu");
    var m;
    while ((m = re.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length, tok: foldText(m[0]) });
    if (spans.length < 2) return text;
    var out = "", cursor = 0, i = 0;
    while (i < spans.length) {
      var list = index.get(spans[i].tok);
      var hit = null;
      if (list) {
        for (var c = 0; c < list.length && !hit; c++) {
          var name = list[c];
          if (i + name.length > spans.length) continue;
          var ok = true;
          for (var k = 1; k < name.length && ok; k++) {
            var gap = text.slice(spans[i + k - 1].end, spans[i + k].start);
            if (spans[i + k].tok !== name[k] || gap.length > 3 || /[\p{L}\p{N}]/u.test(gap)) ok = false;
          }
          if (ok) hit = name;
        }
      }
      if (hit) {
        var start = spans[i].start, end = spans[i + hit.length - 1].end;
        out += text.slice(cursor, start) + fakeName(text.slice(start, end), hit.length, known);
        cursor = end;
        i += hit.length;
      } else {
        i += 1;
      }
    }
    return out + text.slice(cursor);
  }
  function maskEmails(text) {
    return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, function (m) {
      return "person" + (1000 + (filmHash(m.toLowerCase()) % 9000)) + "@example.com";
    });
  }
  function maskNumbers(text) {
    return text.replace(/\d[\d,.]*\d/g, function (m, offset, whole) {
      if (m.replace(/\D/g, "").length < 3) return m;
      var before = whole.charAt(offset - 1), after = whole.charAt(offset + m.length);
      if (/[\/:\-]/.test(before) || /[\/:\-]/.test(after)) return m;
      if (/^(19|20)\d\d$/.test(m)) return m;
      var h = filmHash(m), first = true;
      return m.replace(/\d/g, function (d) {
        h = (Math.imul(h, 1103515245) + 12345) >>> 0;
        var n = (h >>> 16) % 10;
        if (first && d !== "0" && n === 0) n = 1 + (h % 9);
        first = false;
        return String(n);
      });
    });
  }
  return function maskText(text) {
    if (!text || !/\S/.test(text)) return text;
    return maskNumbers(maskNames(maskEmails(text)));
  };
}
`;

const OVERLAY_CSS = `
:host { all: initial; }
.film-title { position: fixed; inset: 0; z-index: 2147483646; display: none; background: #000000; color: #fafafa;
  font-family: "Noto Sans", "Noto Sans Arabic", "Segoe UI", Arial, sans-serif; }
.film-title.on { display: flex; flex-direction: column; justify-content: center; padding: 0 9vw; }
.film-title img { width: min(260px, 34vw); height: auto; margin-bottom: 5vh; }
.film-title .rule { width: 72px; height: 4px; background: #f97316; margin-bottom: 3.2vh; }
.film-title h1 { font-size: clamp(30px, 5.2vw, 76px); line-height: 1.08; font-weight: 700; margin: 0; letter-spacing: -0.01em; max-width: 18ch; }
.film-title p { font-size: clamp(14px, 1.5vw, 22px); color: #a1a1aa; margin: 2.6vh 0 0; letter-spacing: 0.08em; text-transform: uppercase; }
.film-cap { position: fixed; left: 50%; bottom: 5.5vh; transform: translateX(-50%); z-index: 2147483647; display: none;
  max-width: min(1100px, 86vw); background: rgba(11, 11, 12, 0.86); color: #fafafa; padding: 14px 26px 16px;
  font-family: "Noto Sans", "Noto Sans Arabic", "Segoe UI", Arial, sans-serif; text-align: center; border-top: 3px solid #f97316; }
.film-cap.on { display: block; }
.film-cap .label { display: block; font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; color: #fdba74; margin-bottom: 6px; }
.film-cap .label:empty { display: none; }
.film-cap .text { font-size: clamp(18px, 1.9vw, 28px); line-height: 1.35; font-weight: 500; }
.film-cap .text:empty { display: none; }
`;

/**
 * The whole init script: masking on, overlays ready, and `window.__phoenixFilm` for the renderer —
 * title(heading, subtitle), untitle(), caption(label, text).
 */
export function buildFilmPageScript(input: { names: string[]; lockupDataUri: string | null; rtl: boolean }): string {
  const names = JSON.stringify(input.names);
  const lockup = JSON.stringify(input.lockupDataUri ?? "");
  const css = JSON.stringify(OVERLAY_CSS);
  return `(() => {
  if (window.__phoenixFilm) return;
  ${MASK_CORE}
  var maskText = makeMasker(buildNameIndex(${names}));
  var done = new WeakMap();
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  function maskNode(node) {
    var v = node.nodeValue;
    if (!v || done.get(node) === v) return;
    var p = node.parentNode;
    if (p && SKIP[p.nodeName]) return;
    var masked = maskText(v);
    done.set(node, masked);
    if (masked !== v) node.nodeValue = masked;
  }
  function maskField(el) {
    try {
      var v = el.value;
      if (!v || done.get(el) === v) return;
      var masked = maskText(v);
      done.set(el, masked);
      if (masked !== v) el.value = masked;
    } catch (e) {}
  }
  function maskTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { maskNode(root); return; }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = walker.nextNode())) maskNode(n);
    if (root.querySelectorAll) {
      var fields = root.querySelectorAll("input, textarea");
      for (var i = 0; i < fields.length; i++) maskField(fields[i]);
    }
  }
  var observer = new MutationObserver(function (records) {
    for (var r = 0; r < records.length; r++) {
      var rec = records[r];
      if (rec.type === "characterData") maskNode(rec.target);
      else if (rec.type === "attributes") maskField(rec.target);
      else for (var a = 0; a < rec.addedNodes.length; a++) maskTree(rec.addedNodes[a]);
    }
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["value"] });
  document.addEventListener("input", function (e) { maskField(e.target); }, true);
  function addBlur() {
    var style = document.createElement("style");
    style.textContent = 'img[src*="supabase"], img[src*="/storage/v1/"], img[src*="photo"], img[src*="avatar"] { filter: blur(18px) saturate(0.6) !important; }';
    (document.head || document.documentElement).appendChild(style);
  }
  var host = null, titleEl = null, capEl = null;
  function overlays() {
    if (host && host.isConnected) return true;
    if (!document.documentElement) return false;
    host = document.createElement("phoenix-film-overlay");
    var root = host.attachShadow({ mode: "closed" });
    var style = document.createElement("style");
    style.textContent = ${css};
    root.appendChild(style);
    titleEl = document.createElement("div");
    titleEl.className = "film-title";
    titleEl.dir = ${input.rtl ? '"rtl"' : '"ltr"'};
    titleEl.innerHTML = (${lockup} ? '<img alt="">' : "") + '<div class="rule"></div><h1></h1><p></p>';
    if (${lockup}) titleEl.querySelector("img").src = ${lockup};
    capEl = document.createElement("div");
    capEl.className = "film-cap";
    capEl.dir = ${input.rtl ? '"rtl"' : '"ltr"'};
    capEl.innerHTML = '<span class="label"></span><div class="text"></div>';
    root.appendChild(titleEl);
    root.appendChild(capEl);
    document.documentElement.appendChild(host);
    return true;
  }
  function ready() {
    maskTree(document.documentElement);
    addBlur();
    overlays();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
  Object.defineProperty(window, "__phoenixFilm", {
    configurable: false,
    value: {
      title: function (heading, subtitle) {
        if (!overlays()) return false;
        titleEl.querySelector("h1").textContent = heading || "";
        titleEl.querySelector("p").textContent = subtitle || "";
        titleEl.classList.add("on");
        return true;
      },
      untitle: function () { if (titleEl) titleEl.classList.remove("on"); return true; },
      caption: function (label, text) {
        if (!overlays()) return false;
        capEl.querySelector(".label").textContent = label || "";
        capEl.querySelector(".text").textContent = text || "";
        if (label || text) capEl.classList.add("on"); else capEl.classList.remove("on");
        return true;
      },
      remask: function () { maskTree(document.documentElement); return true; }
    }
  });
})();`;
}
