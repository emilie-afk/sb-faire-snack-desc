// Netlify serverless function that proxies prompts to the Anthropic Claude API.
// Requires ANTHROPIC_API_KEY and ACCESS_PASSWORD env vars set in Netlify.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: 'Method not allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: cors(),
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY env var is not set in Netlify.' }),
    };
  }

  // Password gate: require ACCESS_PASSWORD env var to match the header sent by the client.
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

  let prompt;
  try {
    const body = JSON.parse(event.body || '{}');
    prompt = body.prompt;
  } catch {
    return {
      statusCode: 400,
      headers: cors(),
      body: JSON.stringify({ error: 'Invalid JSON body.' }),
    };
  }
  if (!prompt || typeof prompt !== 'string') {
    return {
      statusCode: 400,
      headers: cors(),
      body: JSON.stringify({ error: 'Missing "prompt" string in request body.' }),
    };
  }

  try {
    const res = await fetch(ANTHROPIC_URL, {
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
    });
    if (!res.ok) {
      const errText = await res.text();
      return {
        statusCode: res.status,
        headers: cors(),
        body: JSON.stringify({ error: 'Anthropic API error: ' + errText.slice(0, 500) }),
      };
    }
    const data = await res.json();
    const text = (data.content || [])
      .map((block) => block.text || '')
      .join('');
    return {
      statusCode: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors(),
      body: JSON.stringify({ error: 'Function error: ' + (err.message || String(err)) }),
    };
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Password',
  };
}
