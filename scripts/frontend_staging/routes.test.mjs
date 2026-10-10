import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const code = readFileSync(new URL('../../infra/aws/frontend-staging/routes.js', import.meta.url), 'utf8');
function route(uri, deadline) {
  const context = vm.createContext({});
  vm.runInContext(code.replace('__DEADLINE__', deadline), context);
  return context.handler({ request: { uri, method: 'GET' } });
}
test('only known SPA routes resolve to HTML', () => {
  for (const uri of ['/', '/auth/callback']) assert.equal(route(uri, '2099-01-01T00:00:00Z').uri, '/index.html');
  for (const uri of ['/api/health', '/identity/session', '/assets/missing.js', '/unknown', '/auth/callback.js']) {
    assert.equal(route(uri, '2099-01-01T00:00:00Z').uri, uri);
  }
});
test('expired hosting lease blocks HTML and cached assets', () => {
  for (const uri of ['/', '/assets/app-hash.js', '/auth/callback']) {
    const response = route(uri, '1970-01-01T00:00:00Z');
    assert.equal(response.statusCode, 410);
    assert.equal(response.headers['cache-control'].value, 'no-store');
  }
});
test('malformed lease fails closed', () => {
  assert.equal(route('/', 'invalid').statusCode, 410);
});
