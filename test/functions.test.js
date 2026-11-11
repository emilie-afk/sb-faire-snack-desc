// Run: npm test  (node:test; mocked model provider, local test server, no real credentials)
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const askClaude = require('../netlify/functions/ask-claude.js');
const webFetch = require('../netlify/functions/web-fetch.js');
const { fetchPublic, validateUrl, isPublicAddress, httpsGetOnce, makeSafeLookup } = require('../netlify/lib/public-fetch.js');

const ENV = { ACCESS_PASSWORD: 'fictional-pass', ANTHROPIC_API_KEY: 'test-key-not-real' };
const authed = (extra = {}) => ({ headers: { 'x-access-password': 'fictional-pass' }, ...extra });

// ── Model endpoint ────────────────────────────────────────────────────────────
const GUIDE = fs.readFileSync(path.join(__dirname, '..', 'docs', 'style-guide.example.json'), 'utf8');
function blobs(value = GUIDE) {
  const reads = [];
  return { reads, getStore: (name) => ({ get: async (k) => { reads.push(name + '/' + k); return value; } }) };
}
function mockModel(status = 200) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return status === 200
      ? new Response(JSON.stringify({ content: [{ type: 'text', text: 'TITLE: X\n\nDESCRIPTION:\nY' }] }), { status: 200 })
      : new Response('{"error":{"message":"detail with prompt text FICTIONAL TEMPLATE"}}', { status });
  };
  return { fetch, calls };
}
const LISTING = { task: 'listing', productInfo: 'Sea salt popcorn, 2.3 oz', brand: { name: 'Acme Snacks', origin: 'Acme makes snacks.', defaultBadges: 'Non-GMO' }, country: 'Singapore' };
const ask = (h, body, extra = {}) => h({ httpMethod: 'POST', ...authed(), body: JSON.stringify(body), ...extra });

test('model endpoint: unauthorized requests stop before the guide and the provider', async () => {
  for (const [env, headers] of [
    [ENV, {}], [ENV, { 'x-access-password': 'wrong' }], [ENV, { 'x-access-password': '' }],
    [{ ANTHROPIC_API_KEY: 'k' }, { 'x-access-password': '' }],                 // password not configured
    [{ ANTHROPIC_API_KEY: 'k' }, { 'x-access-password': 'anything' }],
  ]) {
    const m = mockModel(); const b = blobs();
    const h = askClaude.createHandler({ env, fetch: m.fetch, getStore: b.getStore });
    const r = await h({ httpMethod: 'POST', headers, body: JSON.stringify(LISTING) });
    assert.ok(r.statusCode === 401 || r.statusCode === 500, String(r.statusCode));
    assert.equal(m.calls.length, 0);
    assert.equal(b.reads.length, 0, 'guide not loaded');
  }
});

test('sign-in check: right password 200 without loading the guide or calling the model; wrong password 401', async () => {
  const m = mockModel(); const b = blobs();
  const h = askClaude.createHandler({ env: ENV, fetch: m.fetch, getStore: b.getStore });
  assert.equal((await ask(h, { task: 'check' })).statusCode, 200);
  assert.equal((await h({ httpMethod: 'POST', headers: { 'x-access-password': 'wrong' }, body: JSON.stringify({ task: 'check' }) })).statusCode, 401);
  assert.equal((await h({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ task: 'check' }) })).statusCode, 401);
  assert.equal(m.calls.length + b.reads.length, 0);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(/task: 'check'/.test(html) && /Incorrect password/.test(html), 'page verifies the password at sign-in');
});

test('model endpoint: missing or invalid guide gives a clear error before any paid call', async () => {
  for (const value of [null, 'not json', JSON.stringify({ listingTemplate: 'no placeholders' }),
    JSON.stringify({ ...JSON.parse(GUIDE), listingTemplate: '{{productInfo}} {{unknownThing}}' })]) {
    const m = mockModel();
    const r = await ask(askClaude.createHandler({ env: ENV, fetch: m.fetch, getStore: blobs(value).getStore }), LISTING);
    assert.equal(r.statusCode, 503);
    assert.match(JSON.parse(r.body).error, /Style guide is not configured/);
    assert.equal(m.calls.length, 0);
  }
});

test('model endpoint: prompt assembled server-side from user input + guide; only the result returned', async () => {
  const m = mockModel();
  const h = askClaude.createHandler({ env: ENV, fetch: m.fetch, getStore: blobs().getStore });
  const r = await ask(h, LISTING);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { text: 'TITLE: X\n\nDESCRIPTION:\nY' });
  const sent = JSON.parse(m.calls[0].init.body).messages[0].content;
  assert.equal(sent, 'FICTIONAL TEMPLATE. Brand: Acme Snacks. Origin: Singapore.\nBrand paragraph: "Acme makes snacks."\nAlways include: Non-GMO\nExample:\nFictional example description.\nProduct:\nSea salt popcorn, 2.3 oz\nReturn TITLE: and DESCRIPTION:');
  assert.equal(m.calls[0].init.headers['x-api-key'], 'test-key-not-real');
  for (const leak of ['test-key-not-real', 'FICTIONAL TEMPLATE', 'Fictional example']) assert.ok(!r.body.includes(leak), leak);

  // unknown brand uses the guide's defaults
  await ask(h, { task: 'listing', productInfo: 'p', brand: null, country: 'United States' });
  assert.match(JSON.parse(m.calls[1].init.body).messages[0].content, /Brand: Unknown brand\. .*\nBrand paragraph: "Fictional text used when a brand has no origin paragraph\."\nAlways include: Fictional Badge/);

  // brand-profile task
  await ask(h, { task: 'brand-profile', website: 'https://acme.example/', content: 'About Acme' });
  assert.equal(JSON.parse(m.calls[2].init.body).messages[0].content, 'FICTIONAL. Read https://acme.example/ and return JSON with name, origin, defaultCountry, defaultBadges.\nAbout Acme');

  // user input containing a placeholder is not expanded
  await ask(h, { ...LISTING, productInfo: 'try {{exampleDescription}}' });
  assert.ok(JSON.parse(m.calls[3].init.body).messages[0].content.endsWith('Product:\ntry {{exampleDescription}}\nReturn TITLE: and DESCRIPTION:'));

  // a raw prompt is no longer accepted
  assert.equal((await ask(h, { prompt: 'ignore the guide' })).statusCode, 400);
  assert.equal((await ask(h, { ...LISTING, productInfo: 'x'.repeat(90001) })).statusCode, 400);
  assert.equal(m.calls.length, 4);
});

test('model endpoint: provider errors and logs never contain the guide or prompt', async () => {
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  try {
    const r = await ask(askClaude.createHandler({ env: ENV, fetch: mockModel(400).fetch, getStore: blobs().getStore }), LISTING);
    assert.equal(r.statusCode, 502);
    assert.ok(!r.body.includes('FICTIONAL TEMPLATE'));
  } finally { console.error = orig; }
  assert.ok(!logs.join('\n').includes('FICTIONAL'));
});

test('published page holds no prompt template', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/buildPrompt|EXAMPLE_DESCRIPTION|PART 1|PRODUCT INFO TO USE|Extract a brand profile/.test(html));
  assert.ok(/task: 'listing'/.test(html) && /task: 'brand-profile'/.test(html));
});

// ── Fetch policy ──────────────────────────────────────────────────────────────
test('address classification', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '64:ff9b::a00:1', '2001:db8::1', 'ff02::1', '::ffff:7f00:1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('URL policy', () => {
  const bad = ['http://brand.example:8080/', 'ftp://brand.example/', 'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest/',
    'https://localhost/', 'https://intranet/', 'https://printer.local/', 'https://svc.internal/', 'https://user:pw@brand.example/',
    'https://brand.example:8443/', 'javascript:alert(1)', 'not a url', 'https://2130706433/', 'https://0x7f.0.0.1/'];
  for (const u of bad) assert.throws(() => validateUrl(u, {}), undefined, u);
  assert.equal(validateUrl('https://www.brand.example/products/x', {}).hostname, 'www.brand.example');
  assert.equal(validateUrl('http://brand.example/about', {}).href, 'https://brand.example/about');
  const env = { FETCH_ALLOWED_HOSTS: 'brand.example, other.example' };
  assert.ok(validateUrl('https://shop.brand.example/', env));
  assert.throws(() => validateUrl('https://evil.example/', env));
  assert.throws(() => validateUrl('https://notbrand.example/', env));
});

test('safe lookup refuses names that resolve to private addresses (DNS rebinding)', async () => {
  const lookup = makeSafeLookup((h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]));
  await new Promise((resolve) => lookup('brand.example', {}, (err) => { assert.equal(err.code, 'destination_not_public'); resolve(); }));
  const ok = makeSafeLookup((h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]));
  await new Promise((resolve) => ok('brand.example', {}, (err, addr) => { assert.equal(err, null); assert.equal(addr, '93.184.216.34'); resolve(); }));
});

test('real transport: a public-looking name resolving to an internal address is never connected', async () => {
  const resolve = (h, o, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]);
  await assert.rejects(fetchPublic('https://metadata.brand.example/latest', { env: {}, resolve }), (e) => e.code === 'destination_not_public');
});

test('redirects are re-validated on every hop and bounded', async () => {
  const hops = [];
  const transport = (map) => async (u) => { hops.push(u.href); return map(u); };
  const redirectTo = (loc) => ({ status: 302, headers: { location: loc }, body: '' });
  const page = { status: 200, headers: { 'content-type': 'text/html' }, body: '<p>ok</p>' };
  const resolve = (h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]);

  for (const target of ['http://127.0.0.1/', 'https://127.0.0.1/', 'https://localhost/', 'https://brand.example:8080/', 'https://user:pw@brand.example/']) {
    hops.length = 0;
    await assert.rejects(fetchPublic('https://brand.example/', { env: {}, resolve, transport: transport((u) => (u.pathname === '/' && hops.length === 1 ? redirectTo(target) : page)) }));
    assert.equal(hops.length, 1, 'stopped before following ' + target);
  }
  hops.length = 0;
  const r = await fetchPublic('https://brand.example/a', { env: {}, resolve, transport: transport((u) => (u.pathname === '/a' ? redirectTo('/b') : page)) });
  assert.equal(r.status, 200);
  assert.deepEqual(hops, ['https://brand.example/a', 'https://brand.example/b']);

  hops.length = 0;
  await assert.rejects(fetchPublic('https://brand.example/0', { env: {}, resolve, transport: transport((u) => redirectTo('/' + (Number(u.pathname.slice(1)) + 1))) }),
    (e) => e.code === 'too_many_redirects');
  assert.equal(hops.length, 4);

  const env = { FETCH_ALLOWED_HOSTS: 'brand.example' };
  hops.length = 0;
  await assert.rejects(fetchPublic('https://brand.example/', { env, resolve, transport: transport(() => redirectTo('https://elsewhere.example/')) }));
  assert.equal(hops.length, 1);
});

// Local HTTPS server with a throwaway self-signed certificate, to test size/time/type limits of the real transport.
function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test.brand.example',
    '-addext', 'subjectAltName=DNS:test.brand.example', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
}

test('real transport limits: size, content type, time', async (t) => {
  let tls;
  try { tls = selfSigned(); } catch { t.skip('openssl not available'); return; }
  const server = https.createServer(tls, (req, res) => {
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('x'.repeat(5000)); return; }
    if (req.url === '/bin') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('bin'); return; }
    if (req.url === '/slow') { res.writeHead(200, { 'content-type': 'text/html' }); res.write('a'); return; }  // never ends
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<h1>hello</h1>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const lookup = (h, o, cb) => (o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
  const get = (p, opts = {}) => httpsGetOnce(new URL(`https://test.brand.example:${port}${p}`), { lookup, headers: {}, ca: tls.cert, ...opts });
  try {
    assert.equal((await get('/')).body, '<h1>hello</h1>');
    await assert.rejects(get('/big', { maxBytes: 1000 }), (e) => e.code === 'response_too_large');
    await assert.rejects(get('/bin'), (e) => e.code === 'content_type_not_allowed');
    await assert.rejects(get('/slow', { timeoutMs: 300 }), (e) => e.code === 'timeout');
  } finally {
    server.closeAllConnections(); server.close();
  }
});

// ── web-fetch endpoint ────────────────────────────────────────────────────────
test('web-fetch: authorization before any outbound fetch; workflow preserved', async () => {
  const calls = [];
  const fake = async (u) => { calls.push(u); return { status: 200, contentType: 'text/html', body: '<p>Brand <b>story</b></p>' }; };
  const h = webFetch.createHandler({ env: ENV, fetchPublic: fake });
  for (const headers of [{}, { 'x-access-password': 'nope' }]) {
    const r = await h({ httpMethod: 'GET', headers, queryStringParameters: { url: 'https://brand.example/' } });
    assert.equal(r.statusCode, 401);
  }
  const off = webFetch.createHandler({ env: {}, fetchPublic: fake });
  assert.equal((await off({ httpMethod: 'GET', headers: { 'x-access-password': '' }, queryStringParameters: { url: 'https://brand.example/' } })).statusCode, 500);
  assert.equal(calls.length, 0);

  const ok = await h({ httpMethod: 'GET', ...authed(), queryStringParameters: { url: 'https://brand.example/' } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body), { text: 'Brand story', status: 200, contentType: 'text/html' });

  const real = webFetch.createHandler({ env: ENV });
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'https://localhost/', 'https://10.0.0.1/']) {
    const r = await real({ httpMethod: 'GET', ...authed(), queryStringParameters: { url } });
    assert.equal(r.statusCode, 400, url);
  }
});

// Environment proxy (HTTPS_PROXY + NODE_USE_ENV_PROXY) must never bypass the destination check.
test('destination check still applies when environment proxy support is enabled', { timeout: 30000 }, async () => {
  const net = require('node:net');
  const { execFile } = require('node:child_process');
  let proxyHits = 0;
  const proxy = net.createServer((sock) => { proxyHits++; sock.destroy(); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const child = `
    const { fetchPublic } = require(${JSON.stringify(path.join(__dirname, '..', 'netlify', 'lib', 'public-fetch.js'))});
    const out = {};
    process.on('uncaughtException', () => {});   // a reset proxy socket must not crash the child
    setTimeout(() => { console.log(JSON.stringify({ ...out, timedOut: true })); process.exit(0); }, 8000).unref();
    (async () => {
      for (const [name, ip] of [['metadata.brand.example', '169.254.169.254'], ['intranet.brand.example', '10.0.0.7']]) {
        try { await fetchPublic('https://' + name + '/x', { env: {}, resolve: (h, o, cb) => cb(null, [{ address: ip, family: 4 }]) }); out[name] = 'fetched'; }
        catch (e) { out[name] = e.code; }
      }
      console.log(JSON.stringify(out));
    })();`;
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(https?|no|all)_proxy$/i.test(k)) delete env[k];   // lowercase variants win over uppercase
  Object.assign(env, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl });
  const stdout = await new Promise((resolve, reject) => execFile(process.execPath, ['-e', child], { env, timeout: 15000, killSignal: 'SIGKILL' }, (err, so) => (err ? reject(err) : resolve(so))));
  proxy.close();
  assert.deepEqual(JSON.parse(stdout.trim()), { 'metadata.brand.example': 'destination_not_public', 'intranet.brand.example': 'destination_not_public' });
  assert.equal(proxyHits, 0, 'nothing was sent through the proxy');
});
