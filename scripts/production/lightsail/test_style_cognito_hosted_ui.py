from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts.production.lightsail import style_cognito_hosted_ui as style


class _Cognito:
    def list_user_pools(self, **kwargs):
        return {"UserPools": [{"Name": style.POOL_NAME, "Id": "ca-central-1_Abc123"}]}

    def list_user_pool_clients(self, **kwargs):
        return {"UserPoolClients": [{"ClientName": style.CLIENT_NAME, "ClientId": "abc123client"}]}


class HostedUiStyleTests(unittest.TestCase):
    def test_reviewed_css_is_small_and_matches_quizforge_brand(self):
        css = style.validate_css(style.CSS_PATH.read_text(encoding="utf-8"))
        self.assertLessEqual(len(css.encode("utf-8")), 3072)
        self.assertIn("#f5f7fb", css)
        self.assertIn("#6257e7", css)
        self.assertIn("#5549dc", css)
        self.assertIn(".submitButton-customizable", css)
        self.assertIn(".inputField-customizable:focus", css)
        self.assertIn("padding: 0px 0px 0px 0px", css)

    def test_css_rejects_unknown_selector_and_remote_content(self):
        with self.assertRaises(ValueError):
            style.validate_css(".unknown-customizable { color: #000000; }")
        with self.assertRaises(ValueError):
            style.validate_css(".background-customizable { background: url(https://example.com/a.png); }")
        with self.assertRaises(ValueError):
            style.validate_css("@media screen { .background-customizable { background-color: #ffffff; } }")

    def test_discovery_requires_exact_named_production_resources(self):
        self.assertEqual(style.discover(_Cognito()), ("ca-central-1_Abc123", "abc123client"))

        bad = _Cognito()
        bad.list_user_pools = lambda **kwargs: {"UserPools": []}
        with self.assertRaises(ValueError):
            style.discover(bad)

    def test_summary_rejects_private_pool_identifiers(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "summary.json"
            with mock.patch.object(style, "RESULT", output):
                style.write_report({"result": "ok", "css_changed": True})
                self.assertTrue(output.is_file())
                with self.assertRaises(ValueError):
                    style.write_report({"pool": "ca-central-1_Private123"})


if __name__ == "__main__":
    unittest.main()
