// style-guide.js — the private Faire listing guide (title/description rules,
// example output, default texts and the brand-profile extraction prompt).
// Stored in Netlify Blobs (store "private-config", key "faire-style-guide");
// never in Git or the published page. Shape: docs/style-guide.example.json.

const { readPrivateConfig } = require('./private-config');
const { validTemplate, fill } = require('./template');

const KEY = 'faire-style-guide';
const LISTING_VARS = ['productInfo', 'brandName', 'origin', 'badges', 'country', 'exampleDescription'];
const PROFILE_VARS = ['website', 'content'];

function parseGuide(raw) {
  let g;
  try { g = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!g || typeof g !== 'object') return null;
  for (const k of ['exampleDescription', 'noOriginText', 'defaultBadges', 'unknownBrandName']) {
    if (typeof g[k] !== 'string' || !g[k]) return null;
  }
  if (!validTemplate(g.listingTemplate, LISTING_VARS, ['productInfo'])) return null;
  if (!validTemplate(g.brandProfileTemplate, PROFILE_VARS, ['content'])) return null;
  return g;
}

async function loadGuide(event, deps) {
  const raw = await readPrivateConfig(event, KEY, deps);
  return raw == null ? null : parseGuide(raw);
}

// Same choices the page used to make: brand origin, badges and name fall back to the guide's defaults.
function listingPrompt(g, { productInfo, brand, country }) {
  return fill(g.listingTemplate, {
    productInfo,
    brandName: brand ? String(brand.name) : g.unknownBrandName,
    origin: (brand && brand.origin) || g.noOriginText,
    badges: (brand && brand.defaultBadges) || g.defaultBadges,
    country,
    exampleDescription: g.exampleDescription,
  });
}

function brandProfilePrompt(g, { website, content }) {
  return fill(g.brandProfileTemplate, { website, content });
}

module.exports = { loadGuide, parseGuide, listingPrompt, brandProfilePrompt, KEY };
