// access.js — shared password check for the functions.
// ACCESS_PASSWORD lives only in Netlify environment variables.
const crypto = require('crypto');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Returns null when authorized, otherwise { statusCode, error }.
// Missing configuration denies every request.
function checkAccess(event, env = process.env) {
  const required = env.ACCESS_PASSWORD;
  if (!required) return { statusCode: 500, error: 'Server not configured.' };
  const h = (event && event.headers) || {};
  const provided = h['x-access-password'] || h['X-Access-Password'] || '';
  if (!provided || !safeEqual(String(provided), required)) {
    return { statusCode: 401, error: 'Invalid or missing access password.' };
  }
  return null;
}

module.exports = { checkAccess, safeEqual };
