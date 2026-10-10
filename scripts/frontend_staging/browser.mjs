// Trusted driver. Runs separately from deployment, without AWS credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../e2e/package.json', import.meta.url));
const { chromium, request } = require('@playwright/test');
const base = process.env.HOSTING_URL;
const origin = process.env.ORIGIN_URL;
assert.match(base, /^https:\/\/[a-z0-9]+\.cloudfront\.net$/);
assert.match(origin, /^https:\/\/quizforge-frontend-staging-[0-9]{12}\.s3\.ca-central-1\.amazonaws\.com$/);
const csp = (await readFile(new URL('../../infra/aws/frontend-staging/csp.txt', import.meta.url), 'utf8')).trim();
const manifest = JSON.parse(await readFile('hosting-manifest.json', 'utf8'));
const client = await request.newContext({ timeout: 30000 });
const browser = await chromium.launch({ headless: true });
try {
  const direct = await client.get(origin + '/index.html');
  assert.equal(direct.status(), 403, 'Private S3 must deny anonymous object reads');
  const redirect = await client.get(base.replace('https:', 'http:') + '/', { maxRedirects: 0 });
  assert.equal(redirect.status(), 301);
  assert.equal(redirect.headers().location, base + '/');
  let index;
  // Bound propagation retries; every final assertion remains strict.
  for (let attempt = 0; attempt < 18; attempt++) {
    index = await client.get(base + '/');
    if (index.status() === 200) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  assert.equal(index.status(), 200);
  assert.equal(index.headers()['content-security-policy'], csp);
  assert.equal(index.headers()['x-frame-options'], 'DENY');
  assert.equal(index.headers()['x-content-type-options'], 'nosniff');
  assert.equal(index.headers()['referrer-policy'], 'no-referrer');
  assert.match(index.headers()['strict-transport-security'], /max-age=31536000/);
  assert.match(index.headers()['x-robots-tag'], /noindex/);
  assert.equal(index.headers()['cache-control'], 'no-store');
  const callback = await client.get(base + '/auth/callback?error=access_denied');
  assert.equal(callback.status(), 200);
  assert.equal(await callback.text(), await index.text());
  for (const path of ['/api/health', '/assets/missing.js', '/missing-route']) {
    const denied = await client.get(base + path);
    assert.ok([403, 404].includes(denied.status()), 'Missing resources must not become HTML success');
    assert.notEqual(await denied.text(), await index.text());
  }
  const asset = Object.keys(manifest).find(key => key.endsWith('.js'));
  const crypto = await import('node:crypto');
  for (const path of ['index.html', asset]) {
    const response = await client.get(base + '/' + path);
    assert.equal(response.status(), 200);
    assert.equal(crypto.createHash('sha256').update(await response.body()).digest('hex'), manifest[path].sha256);
  }
  let cached;
  for (let attempt = 0; attempt < 4; attempt++) {
    cached = await client.get(base + '/' + asset);
    if (cached.headers()['x-cache'] === 'Hit from cloudfront') break;
  }
  assert.equal(cached.headers()['x-cache'], 'Hit from cloudfront');
  assert.equal(cached.headers()['cache-control'], 'public, max-age=31536000, immutable');
  assert.match(cached.headers()['content-type'], /javascript/);
  console.log('PASS: HTTPS redirect, headers/CSP, exact SPA callback, real 403/404s, byte hashes and CloudFront cache hit');
  for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', () => failures.push('browser exception'));
    page.on('request', req => { if (new URL(req.url()).origin !== base) failures.push('unexpected external request'); });
    await page.addInitScript(() => {
      window.hostingViolations = [];
      document.addEventListener('securitypolicyviolation', event => window.hostingViolations.push(event.violatedDirective));
    });
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'QuizForge staging', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Sign in or create account', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(await page.evaluate(() => window.hostingViolations), []);
    // A callback without a valid PKCE transaction must fail closed and scrub its URL.
    await page.goto(base + '/auth/callback?error=access_denied', { waitUntil: 'networkidle' });
    await page.getByRole('alert').waitFor();
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(new URL(page.url()).search, '');
    assert.deepEqual(failures, []);
    assert.deepEqual(await page.evaluate(() => window.hostingViolations), []);
    await context.close();
  }
  console.log('PASS: desktop/mobile reviewed React build, no external requests, no CSP violations, callback failure closed');
} finally {
  await browser.close();
  await client.dispose();
}
