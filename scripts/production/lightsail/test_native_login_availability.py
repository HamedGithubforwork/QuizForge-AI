import unittest
from scripts.production.lightsail.native_login_availability import probe, public_runtime_config

ORIGIN = 'https://login.example.test'
HTML = b'<form method="post" action="/login"><input name="username"><input type="password" name="password"></form>'

class LoginAvailabilityTests(unittest.TestCase):
    def test_redirect_to_exact_origin_login_form(self):
        calls = []
        def request(url):
            calls.append(url)
            return (302, {'Location': '/login?client_id=synthetic'}, b'') if len(calls) == 1 else (200, {'Content-Type': 'text/html'}, HTML)
        self.assertTrue(probe(ORIGIN + '/oauth2/authorize', ORIGIN, request))
        self.assertEqual(len(calls), 2)

    def test_redirects_never_leave_reviewed_origin_or_login_paths(self):
        for destination in ('https://evil.test/login', 'http://login.example.test/login', '/signup',
                            'com.quizfromnotes.desktop.preview:/oauth/callback?code=secret',
                            'https://user:pass@login.example.test/login', '/login#fragment'):
            calls = []
            def request(url):
                calls.append(url)
                return 302, {'Location': destination}, b''
            with self.subTest(destination=destination), self.assertRaises(ValueError):
                probe(ORIGIN + '/oauth2/authorize', ORIGIN, request)
            self.assertEqual(len(calls), 1)

    def test_error_pages_and_foreign_forms_do_not_pass(self):
        cases = [(400, {'Content-Type': 'text/html'}, HTML),
                 (200, {'Content-Type': 'application/json'}, HTML),
                 (200, {'Content-Type': 'text/html'}, b'<p>Login unavailable</p>'),
                 (200, {'Content-Type': 'text/html'}, HTML.replace(b'/login', b'https://evil.test/login')),
                 (200, {'Content-Type': 'text/html'}, HTML.replace(b'post', b'get'))]
        for response in cases:
            with self.subTest(response=response), self.assertRaises(ValueError):
                probe(ORIGIN + '/login', ORIGIN, lambda url: response)

    def test_redirect_loop_is_bounded(self):
        calls = []
        def request(url):
            calls.append(url)
            return 302, {'Location': '/login'}, b''
        with self.assertRaises(ValueError): probe(ORIGIN + '/login', ORIGIN, request)
        self.assertEqual(len(calls), 4)

class PublicRuntimeConfigTests(unittest.TestCase):
    def test_exports_only_verified_public_routing_fields(self):
        calls = []
        description = {'UserPoolClient': {'ClientId': 'nativeclient', 'ExtraMetadata': 'not exported'}}
        config = public_runtime_config(description, 'ca-central-1_Synthetic', 'webclient',
                                       lambda *args: calls.append(args))
        self.assertEqual(calls, [(description, 'ca-central-1_Synthetic', 'webclient')])
        self.assertEqual(config, {'schema': 1, 'poolId': 'ca-central-1_Synthetic', 'clientId': 'nativeclient'})

    def test_policy_failure_or_web_client_cannot_be_exported(self):
        def reject(*args): raise ValueError('policy rejected')
        with self.assertRaises(ValueError):
            public_runtime_config({'UserPoolClient': {'ClientSecret': 'synthetic'}}, 'pool', 'web', reject)
        for client_id in ('web', 'invalid client', ''):
            with self.assertRaises(ValueError):
                public_runtime_config({'UserPoolClient': {'ClientId': client_id}}, 'pool', 'web', lambda *args: None)

if __name__ == '__main__': unittest.main()
