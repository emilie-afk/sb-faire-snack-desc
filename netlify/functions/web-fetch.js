// Netlify serverless function that fetches a public web page server-side.
// Used by the generator to read brand and product pages without browser CORS limits.
// Requires the ACCESS_PASSWORD env var to match the X-Access-Password header.
// Destinations are restricted to public https websites (see ../lib/public-fetch.js),
// including every redirect hop, with time and size limits.

const { checkAccess } = require('../lib/access');
const { fetchPublic, FetchPolicyError } = require('../lib/public-fetch');

function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchPublic || ((url) => fetchPublic(url, { env }));

  return async (event) => {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: cors(), body: '' };
    }
    if (event.httpMethod !== 'GET') {
      return reply(405, { error: 'Method not allowed' });
    }
    // Authorization comes first: nothing is fetched for unauthorized callers.
    const denied = checkAccess(event, env);
    if (denied) return reply(denied.statusCode, { error: denied.error });

    const url = event.queryStringParameters && event.queryStringParameters.url;
    if (!url || typeof url !== 'string' || url.length > 2048) {
      return reply(400, { error: 'Missing or invalid url query parameter.' });
    }

    try {
      const res = await fetchImpl(url);
      const isJson = res.contentType.includes('application/json') || res.contentType.includes('text/json');
      // JSON passes through untouched. Strip HTML for everything else.
      const text = (isJson ? res.body : stripHtml(res.body)).slice(0, 50000);
      return reply(200, { text, status: res.status, contentType: res.contentType });
    } catch (err) {
      if (err instanceof FetchPolicyError) {
        return reply(err.status, { error: 'Fetch not allowed or failed: ' + err.code });
      }
      return reply(502, { error: 'Fetch failed.' });
    }
  };
}

function reply(statusCode, body) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Password',
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
