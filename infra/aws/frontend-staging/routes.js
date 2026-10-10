function handler(event) {
  var request = event.request;
  var deadline = Date.parse('__DEADLINE__');
  if (!isFinite(deadline) || Date.now() >= deadline) {
    return { statusCode: 410, statusDescription: 'Gone', headers: {
      'cache-control': { value: 'no-store' },
      'content-type': { value: 'text/plain' }
    }, body: 'Temporary hosting validation has ended.' };
  }
  // Do not turn API failures, unknown paths, or missing assets into HTML 200s.
  if (request.uri === '/' || request.uri === '/auth/callback') request.uri = '/index.html';
  return request;
}
