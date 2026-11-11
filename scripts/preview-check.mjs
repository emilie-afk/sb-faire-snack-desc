// Preview check — run against a Netlify deploy preview (or production) after the
// private configuration is in place. Makes NO paid model call.
//
//   PREVIEW_PASSWORD='<the tool password>' node scripts/preview-check.mjs https://deploy-preview-N--<site>.netlify.app [--guide /path/outside/repo/guide.json]
//
// Checks: unauthenticated requests are refused; sign-in works; the function can
// read the private style guide (a deliberately incomplete request answers 400,
// while 503 means the guide is missing or unreadable); with --guide, the
// published page and its same-origin scripts contain no fragment of the real guide
// (only counts are printed).
import { readFileSync } from 'node:fs';

const base = (process.argv[2] || '').replace(/\/+$/, '');
const gi = process.argv.indexOf('--guide');
const guideFile = gi > 0 ? process.argv[gi + 1] : null;
const password = process.env.PREVIEW_PASSWORD || '';
if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(base + '/') || !password) {
  console.error('Usage: PREVIEW_PASSWORD=... node scripts/preview-check.mjs https://<preview-url> [--guide file]');
  process.exit(2);
}
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed++; };
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body), redirect: 'manual' });
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

async function scanPublished() {
  if (!guideFile) return;
  const strings = (o) => (typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(strings) : []);
  const needles = [...new Set(strings(JSON.parse(readFileSync(guideFile, 'utf8'))).flatMap((s) => s.split(/\n|(?<=[.!?])\s+/)).map((x) => x.replace(/\{\{\w+\}\}/g, '').trim()).filter((x) => x.length >= 30))];
  const html = await (await fetch(base + '/')).text();
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => new URL(m[1], base + '/')).filter((u) => u.origin === new URL(base).origin);
  let text = html;
  for (const u of srcs) text += await (await fetch(u)).text();
  // The brand library holds public brand facts (e.g. a brand's own origin paragraph),
  // which the guide's example may quote. Matches there are expected, not leaks.
  const lib = (html.match(/const DEFAULT_BRANDS = \[[\s\S]*?\n\];/) || [''])[0];
  const found = needles.filter((n) => text.includes(n));
  const publicBrand = found.filter((n) => lib.includes(n)).length;
  const hits = found.length - publicBrand;
  check('published page holds no guide text', hits === 0, `${needles.length} fragments checked, ${hits} found outside the brand library, ${publicBrand} public brand-library match(es), ${1 + srcs.length} file(s)`);
}

const fn = '/.netlify/functions/ask-claude';
let r = await post(fn, { task: 'none' });
check('unauthenticated request refused', r.status === 401, `status ${r.status}`);
r = await post(fn, { task: 'none' }, { 'x-access-password': password });
check('signed in; private guide readable', r.status === 400, r.status === 503 ? 'guide missing or unreadable (503)' : r.status === 401 ? 'password rejected' : `status ${r.status}`);
await scanPublished();

console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
process.exit(failed ? 1 : 0);
