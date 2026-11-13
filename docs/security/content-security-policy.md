# The page content security policy and its report-only twin

Every page Phoenix renders carries two policies, both set by `proxy.ts` from
`src/lib/security/content-security-policy.ts`:

- **`Content-Security-Policy`** is enforced. Scripts run only with the nonce minted for that one request
  (`'strict-dynamic'` lets them load what they need). Every other directive mirrors `next.config.ts`, which
  still covers API routes and files; `tests/csp-headers.test.ts` holds the two equal.
- **`Content-Security-Policy-Report-Only`** (13 Nov 2026, S01 F-PLT-011) blocks nothing. It asks the
  browser to report what a stricter policy would have stopped, so that the enforced one can be tightened
  from measurements rather than guesses.

## What the report-only policy measures

| Directive | Value | What it reports |
| --- | --- | --- |
| `style-src` | `'self' 'nonce-<this request>' https://fonts.googleapis.com` | a `<style>` element without the page nonce |
| `style-src-attr` | `'unsafe-inline'` | nothing — the 1,104 `style={…}` attributes are left out |
| `img-src` | `REPORT_ONLY_IMAGE_SOURCES` | a picture from any host not on the list |

The picture list, measured on 13 Nov 2026: the app itself, `data:` and `blob:` previews, signed
storage addresses (`*.supabase.co`), the Google Maps hosts
from Google's own CSP guide, and OneSignal's prompt. Employee photos are served from Phoenix itself.

## Where the reports go

`Reporting-Endpoints: csp-report="/api/security/csp-report"`, with `report-uri` for browsers that do not
read it. The route (`app/api/security/csp-report/route.ts`, logic in `src/lib/security/csp-report-intake.ts`):

- is public, like the page-timing beacon, because a browser sends reports without a session; it reads no
  cookie and writes nothing to the database;
- reads both report formats, keeps only a REPORT-disposition violation of a measured directive, and
  reduces it to three words: the directive, the blocked **origin** (or `inline`, `data`, `blob`), and
  the page **shape** (`/admin/employees/:id`, or `srcdoc` for a frame's written document);
- counts each shape in memory (at most 500 a process) and logs `csp_report_only_violation` the first
  time a shape is seen and at 10, 100, 1,000 and so on;
- refuses a body over 32 KB (413) and more than 120 reports a minute from one address (429), and
  otherwise answers 204.

Read it with `railway logs | grep csp_report_only_violation`. Railway keeps about 40 hours.

## What would be reported today

Measured in the code before this shipped:

- the toast library mounted on every page injects a `<style>` with no nonce;
- the .docx CV preview and the hiring-pack paper editor write `<style>` elements without one;
- 21 `<style>` elements in our own components (the root layout's script fonts among them) carry no nonce;
- a received email shown in the mailbox frames loads pictures from any host.

Enforcing either directive means dealing with each of these first: a nonce on our own elements, a
nonce or a replacement for each library, and a decision about remote pictures in received email.

Pinned by `tests/csp-report-only.test.ts`.
