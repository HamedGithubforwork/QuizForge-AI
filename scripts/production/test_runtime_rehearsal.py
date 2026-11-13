"""Deterministic tests for direct-only synthetic runtime probes."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import sys
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).parent / 'lightsail'))
from runtime_http import open_loopback, post_loopback


class _Handler(BaseHTTPRequestHandler):
    paths = []
    post_headers = []
    post_body = None

    def do_GET(self):
        type(self).paths.append(self.path)
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', 'http://example.invalid/should-not-follow')
            self.end_headers()
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')

    def do_POST(self):
        type(self).post_headers = self.headers.get_all('Host')
        type(self).post_body = self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'accepted')

    def log_message(self, *_args):
        pass


class RuntimeRehearsalLoopbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), _Handler)
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        _Handler.paths.clear()
        _Handler.post_headers = []
        _Handler.post_body = None

    def test_loopback_request_ignores_environment_proxy(self):
        previous = {key: os.environ.get(key) for key in ('HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy')}
        try:
            os.environ['HTTP_PROXY'] = 'http://127.0.0.1:1'
            os.environ['http_proxy'] = 'http://127.0.0.1:1'
            os.environ['NO_PROXY'] = ''
            os.environ['no_proxy'] = ''
            with open_loopback(self.base_url + '/health', timeout=2) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b'ok')
            self.assertEqual(_Handler.paths, ['/health'])
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_loopback_redirect_is_returned_as_an_error_not_followed(self):
        with self.assertRaises(HTTPError) as caught:
            open_loopback(self.base_url + '/redirect', timeout=2)
        self.assertEqual(caught.exception.code, 302)
        self.assertEqual(_Handler.paths, ['/redirect'])

    def test_only_literal_http_loopback_is_accepted(self):
        for url in ('https://127.0.0.1/health', 'http://localhost/health',
                    'http://example.com/health'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                open_loopback(Request(url), timeout=1)

    def test_direct_post_sends_one_virtual_host_and_complete_body(self):
        status, response = post_loopback(
            '/api/answers/review', b'{"cases":[]}', 'api.quizfromnotes.com',
            timeout=2, port=self.server.server_port,
        )
        self.assertEqual(status, 200)
        self.assertEqual(response, b'accepted')
        self.assertEqual(_Handler.post_headers, ['api.quizfromnotes.com'])
        self.assertEqual(_Handler.post_body, b'{"cases":[]}')


if __name__ == '__main__':
    unittest.main()
