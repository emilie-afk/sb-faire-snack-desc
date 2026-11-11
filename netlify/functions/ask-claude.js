// Netlify serverless function that writes Faire listings with the Anthropic Claude API.
// Requires ANTHROPIC_API_KEY and ACCESS_PASSWORD env vars and the private style
// guide in Netlify Blobs (see README / scripts/upload-style-guide.mjs).
//
// The browser sends only the user's input and selected options:
//   { task: "listing", productInfo, brand: { name, origin, defaultBadges } | null, country }
//   { task: "brand-profile", website, content }
//   { task: "check" }   → 200 when the password is right (sign-in screen; free)
// The prompt is assembled here from the private guide. Order: password →
// configuration → input → model call. Only the generated text is returned.

const { checkAccess } = require('../lib/access');
const { loadGuide, listingPrompt, brandProfilePrompt } = require('../lib/style-guide');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;
const MAX_PROMPT_CHARS = 100000;  // guide + fetched text or CSV rows (1,200 chars per column)
const UPSTREAM_TIMEOUT_MS = 25000;

const str = (v, max) => typeof v === 'string' && v.length <= max;

function buildPrompt(guide, body) {
  if (!body || typeof body !== 'object') return null;
  if (body.task === 'listing') {
    const { productInfo, brand, country } = body;
    if (!str(productInfo, 90000) || !str(country, 200)) return null;
    if (brand != null) {
      if (typeof brand !== 'object' || Array.isArray(brand)) return null;
      for (const k of ['name', 'origin', 'defaultBadges']) if (brand[k] != null && !str(brand[k], 5000)) return null;
    }
    return listingPrompt(guide, { productInfo, brand: brand || null, country });
  }
  if (body.task === 'brand-profile') {
    const { website, content } = body;
    if (!str(website, 2048) || !str(content, 20000)) return null;
    return brandProfilePrompt(guide, { website, content });
  }
  return null;
}

function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || fetch;

  return async (event) => {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: cors(), body: '' };
    }
    if (event.httpMethod !== 'POST') {
      return reply(405, { error: 'Method not allowed' });
    }

    // 1. Authorization first. Missing ACCESS_PASSWORD denies every request.
    const denied = checkAccess(event, env);
    if (denied) return reply(denied.statusCode, { error: denied.error });

    // Sign-in check: the password is valid. No guide load, no model call.
    try { if (JSON.parse(event.body || '{}').task === 'check') return reply(200, { ok: true }); } catch { /* handled below */ }

    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return reply(500, { error: 'Server not configured.' });

    // 2. Private style guide. Missing or invalid → clear error, no model call.
    const guide = await loadGuide(event, deps);
    if (!guide) return reply(503, { error: 'Style guide is not configured on the server. Ask an admin to upload it.' });

    // 3. User input → prompt (assembled server-side only).
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return reply(400, { error: 'Invalid JSON body.' });
    }
    const prompt = buildPrompt(guide, body);
    if (!prompt) return reply(400, { error: 'Invalid request.' });
    if (prompt.length > MAX_PROMPT_CHARS) return reply(413, { error: 'Input too long.' });

    // 4. Model call. Errors never echo the prompt or provider response.
    try {
      const res = await fetchImpl(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error('Anthropic API error status', res.status);
        return reply(502, { error: 'Model request failed (status ' + res.status + '). Try again.' });
      }
      const data = await res.json();
      const text = (data.content || [])
        .map((block) => block.text || '')
        .join('');
      return reply(200, { text });
    } catch {
      return reply(502, { error: 'Model request failed. Try again.' });
    }
  };
}

function reply(statusCode, body) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Password',
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
