// Netlify serverless function that fetches a URL server-side.
// Used by the artifact to avoid browser CORS restrictions.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  // Password gate: same as ask-claude.
  const required = process.env.ACCESS_PASSWORD;
  if (!required) {
    return {
      statusCode: 500,
      headers: cors(),
      body: JSON.stringify({ error: 'ACCESS_PASSWORD env var is not set in Netlify.' }),
    };
  }
  const headers = event.headers || {};
  const provided = headers['x-access-password'] || headers['X-Access-Password'] || '';
  if (provided !== required) {
    return {
      statusCode: 401,
      headers: cors(),
      body: JSON.stringify({ error: 'Invalid or missing access password.' }),
    };
  }
  const url = event.queryStringParameters && event.queryStringParameters.url;
  if (!url) {
    return {
      statusCode: 400,
      headers: cors(),
      body: JSON.stringify({ error: 'Missing url query parameter.' }),
    };
  }
  // Basic safety: only allow http(s) URLs
  if (!/^https?:\/\//i.test(url)) {
    return {
      statusCode: 400,
      headers: cors(),
      body: JSON.stringify({ error: 'URL must start with http:// or https://' }),
    };
  }
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FaireDescGen/1.0)',
        Accept: 'application/json, text/html, application/xhtml+xml;q=0.9, */*;q=0.8',
      },
      redirect: 'follow',
    });
    const raw = await res.text();
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const isJson = contentType.includes('application/json') || contentType.includes('text/json');
    // Pass JSON through untouched. Strip HTML for everything else so the model gets readable text.
    const text = (isJson ? raw : stripHtml(raw)).slice(0, 50000);
    return {
      statusCode: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, status: res.status, contentType }),
    };
  } catch (err) {
    retu