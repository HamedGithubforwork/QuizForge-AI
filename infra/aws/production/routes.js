function handler(event) {
  var request = event.request;
  var host = request.headers.host && request.headers.host.value;
  if (host === 'www.quizfromnotes.com') {
    // Callback codes must never be forwarded from a non-canonical origin.
    return { statusCode: 308, statusDescription: 'Permanent Redirect', headers: {
      location: { value: 'https://quizfromnotes.com/' },
      'cache-control': { value: 'no-store' }
    } };
  }
  if (host !== 'quizfromnotes.com') {
    return { statusCode: 404, statusDescription: 'Not Found', headers: {
      'cache-control': { value: 'no-store' }
    } };
  }
  if (request.uri === '/' || request.uri === '/auth/callback') request.uri = '/index.html';
  return request;
}
