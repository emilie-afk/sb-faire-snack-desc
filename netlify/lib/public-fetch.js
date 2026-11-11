// public-fetch.js — fetches a page from a PUBLIC website only.
//
// The generator reads brand and product pages on the open web, so the set of
// sites can't be a fixed list. Instead every request (and every redirect hop)
// must be:
//   - https on the default port (http links are upgraded), no user:password in the URL;
//   - a domain name (no IP literals, no localhost/.local/.internal names);
//   - resolved, at connection time, only to public IP addresses (blocks
//     private, loopback, link-local/cloud-metadata, CGNAT, multicast and
//     reserved ranges, including IPv4-mapped IPv6), so DNS tricks can't reach
//     internal services;
//   - optionally limited to FETCH_ALLOWED_HOSTS (comma-separated domains;
//     subdomains included) when that variable is set.
// Responses are bounded in time and size, and only text/HTML/JSON is read.

const https = require('https');
const dns = require('dns');
const net = require('net');

// Dedicated agent: always connects directly, never through an environment
// proxy (HTTP(S)_PROXY with NODE_USE_ENV_PROXY). Through a proxy the checked
// lookup would only resolve the proxy host, so the destination check would not
// apply. No keep-alive, so every request runs a fresh checked lookup.
const directAgent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10000;
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = ['text/html', 'application/xhtml+xml', 'application/json', 'text/json', 'text/plain'];

class FetchPolicyError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0);
}
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits]);

function isPublicIPv4(ip) {
  const n = ipv4ToInt(ip);
  return !V4_BLOCKS.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    return n >= base && n < base + size;
  });
}

function expandIPv6(ip) {
  let [head, tail] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  // embedded IPv4 at the end
  const last = (tail !== undefined ? t : h);
  if (last.length && last[last.length - 1].includes('.')) {
    const v4 = last.pop().split('.').map(Number);
    last.push(((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16));
  }
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  return [...h, ...Array(fill).fill('0'), ...t].map((x) => parseInt(x || '0', 16));
}

function isPublicIPv6(ip) {
  const w = expandIPv6(ip);
  if (w.length !== 8 || w.some((x) => Number.isNaN(x))) return false;
  if (w.every((x) => x === 0)) return false;                                   // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return false;          // ::1
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) {  // v4-mapped / compatible
    const v4 = `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`;
    return isPublicIPv4(v4);
  }
  if (w[0] === 0x64 && w[1] === 0xff9b) return false;                            // NAT64
  if ((w[0] & 0xfe00) === 0xfc00) return false;                                  // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return false;                                  // fe80::/10 link-local
  if ((w[0] & 0xffc0) === 0xfec0) return false;                                  // site-local
  if ((w[0] & 0xff00) === 0xff00) return false;                                  // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return false;                          // documentation
  if (w[0] === 0x2002) return false;                                             // 6to4 (embeds v4)
  if (w[0] === 0x2001 && w[1] === 0) return false;                               // Teredo
  return true;
}

function isPublicAddress(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return isPublicIPv4(ip);
  if (fam === 6) return isPublicIPv6(ip);
  return false;
}

function allowedHosts(env) {
  return String(env.FETCH_ALLOWED_HOSTS || '')
    .split(',').map((s) => s.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
}

// Validates a URL string against the policy; returns a URL object.
function validateUrl(raw, env = process.env) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new FetchPolicyError('invalid_url'); }
  // Plain http is upgraded to https (same host, default port) rather than refused,
  // so pasted http:// brand links keep working; nothing is ever sent unencrypted.
  if (u.protocol === 'http:' && (!u.port || u.port === '80')) { u.protocol = 'https:'; u.port = ''; }
  if (u.protocol !== 'https:') throw new FetchPolicyError('https_only');
  if (u.username || u.password) throw new FetchPolicyError('credentials_in_url');
  if (u.port && u.port !== '443') throw new FetchPolicyError('port_not_allowed');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || net.isIP(host.replace(/^\[|\]$/g, ''))) throw new FetchPolicyError('ip_literal_not_allowed');
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|arpa)$/.test(host)) {
    throw new FetchPolicyError('host_not_allowed');
  }
  const list = allowedHosts(env);
  if (list.length && !list.some((d) => host === d || host.endsWith('.' + d))) {
    throw new FetchPolicyError('host_not_allowed');
  }
  return u;
}

// dns.lookup-compatible function that only ever yields public addresses.
function makeSafeLookup(resolve = dns.lookup) {
  return function safeLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    resolve(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }];
      if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
        const e = new FetchPolicyError('destination_not_public');
        return cb(e);
      }
      if (options && options.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

// One HTTPS GET with manual redirects off; resolves { status, headers, body }.
function httpsGetOnce(u, { lookup, signal, headers, ca, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES }) {
  return new Promise((resolve, reject) => {
    const req = https.request(u, { method: 'GET', headers, lookup, signal, agent: directAgent, timeout: timeoutMs, ...(ca ? { ca } : {}) }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return resolve({ status, headers: res.headers, body: '' });
      }
      const type = String(res.headers['content-type'] || '').toLowerCase();
      if (!ALLOWED_TYPES.some((t) => type.startsWith(t))) {
        res.destroy();
        return reject(new FetchPolicyError('content_type_not_allowed', 415));
      }
      const len = Number(res.headers['content-length'] || 0);
      if (len > maxBytes) { res.destroy(); return reject(new FetchPolicyError('response_too_large', 413)); }
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { res.destroy(); reject(new FetchPolicyError('response_too_large', 413)); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new FetchPolicyError('timeout', 504)));
    req.on('error', reject);
    req.end();
  });
}

// Follows up to MAX_REDIRECTS redirects, re-validating every hop.
async function fetchPublic(raw, { env = process.env, transport = httpsGetOnce, resolve = dns.lookup } = {}) {
  let u = validateUrl(raw, env);
  const lookup = makeSafeLookup(resolve);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; FaireDescGen/1.0)',
    Accept: 'application/json, text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8',
  };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let r;
    try {
      r = await transport(u, { lookup, signal, headers });
    } catch (e) {
      if (e instanceof FetchPolicyError) throw e;
      if (signal.aborted) throw new FetchPolicyError('timeout', 504);
      if (e && e.code === 'destination_not_public') throw new FetchPolicyError('destination_not_public');
      throw new FetchPolicyError('upstream_unreachable', 502);
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers && r.headers.location;
      if (!loc) throw new FetchPolicyError('bad_redirect', 502);
      if (hop === MAX_REDIRECTS) throw new FetchPolicyError('too_many_redirects', 502);
      u = validateUrl(new URL(loc, u).toString(), env);
      continue;
    }
    return { status: r.status, contentType: String((r.headers && r.headers['content-type']) || '').toLowerCase(), body: r.body };
  }
  throw new FetchPolicyError('too_many_redirects', 502);
}

module.exports = {
  fetchPublic, validateUrl, isPublicAddress, makeSafeLookup, httpsGetOnce, FetchPolicyError,
  MAX_BYTES, MAX_REDIRECTS, TIMEOUT_MS, directAgent,
};
