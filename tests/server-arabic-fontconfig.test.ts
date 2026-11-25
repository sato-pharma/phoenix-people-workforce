import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Arabic in every server-printed PDF and picture must join.
 *
 * The server prints with the image's own Chromium (src/lib/pdf/chromium.ts and its ~25 callers).
 * A page whose font list names no Arabic face falls back through fontconfig, and fontconfig chose
 * Noto Sans Math (installed by font-noto) for regular-weight Arabic. That font carries the Arabic
 * letters but cannot join them, so the expense trip PDF of 25 Nov 2026 printed the trip's start and
 * the employee's note letter by letter, reversed, while the bold destination beside them read fine.
 * Nothing was red: the HTML was right and only the printed page showed it.
 *
 * The cure is infra/fontconfig/50-phoenix-arabic.conf, copied into the runner image. If the file
 * stops refusing the maths font, or the Dockerfile stops copying it, or the copy lands before the
 * fonts are installed, the PDFs come apart again — so all three are pinned here.
 */

const CONF = "infra/fontconfig/50-phoenix-arabic.conf";
const DOCKERFILE = "Dockerfile";

function withoutXmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/gu, "");
}

function testTheRuleRefusesTheMathsFont() {
  const conf = withoutXmlComments(readFileSync(CONF, "utf8"));
  const reject = /<selectfont>\s*<rejectfont>([\s\S]*?)<\/rejectfont>\s*<\/selectfont>/u.exec(conf);
  assert.ok(reject, `${CONF} must carry a <selectfont><rejectfont> rule — that is what keeps Noto Sans Math out of the Arabic fallback`);
  assert.match(reject[1], /<glob>\*\/NotoSansMath-\*<\/glob>/u, `${CONF} must refuse every Noto Sans Math file by its path`);
  // Refusing a font that DOES shape Arabic would break the very text this protects.
  assert.doesNotMatch(reject[1], /Arabic/iu, `${CONF} must never refuse an Arabic face`);
}

function testTheImageInstallsTheRuleAfterTheFonts() {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  const runner = dockerfile.slice(dockerfile.search(/^FROM\s+\S+\s+AS\s+runner\s*$/imu));
  assert.ok(runner.length < dockerfile.length, "the Dockerfile must still have a runner stage");

  const fonts = runner.search(/font-noto-arabic/u);
  const copy = runner.search(/^COPY\s+infra\/fontconfig\/50-phoenix-arabic\.conf\s+\/etc\/fonts\/conf\.d\/50-phoenix-arabic\.conf\s*$/mu);
  const cache = runner.search(/^RUN\s+fc-cache\s+-f\s*$/mu);
  assert.ok(fonts >= 0, "the runner stage must install font-noto-arabic — it is the face the fallback must land on");
  assert.ok(copy >= 0, "the runner stage must copy the Arabic font rule into /etc/fonts/conf.d");
  assert.ok(copy > fonts, "the font rule must be copied after the fonts are installed");
  assert.ok(cache > copy, "fc-cache must run after the rule is copied, so the cache is built under it");
}

function testTheBuildContextCarriesTheRule() {
  const ignored = readFileSync(".dockerignore", "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const pattern of ["infra", "infra/", "infra/fontconfig", "infra/fontconfig/", "*.conf"]) {
    assert.ok(!ignored.includes(pattern), `.dockerignore must not drop ${CONF} from the build — it names "${pattern}"`);
  }
}

export function runServerArabicFontconfigTests() {
  testTheRuleRefusesTheMathsFont();
  testTheImageInstallsTheRuleAfterTheFonts();
  testTheBuildContextCarriesTheRule();
}
