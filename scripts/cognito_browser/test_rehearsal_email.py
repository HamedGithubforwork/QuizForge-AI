import contextlib
import hashlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import control


class RehearsalEmailTests(unittest.TestCase):
    def test_missing_recipient_does_not_fall_back_to_supabase_canary(self):
        with patch.dict(os.environ, {
            "OPERATION": "email-start",
            "QUIZFORGE_CANARY_EMAIL": "existing-canary@example.test",
        }, clear=True), patch.object(control, "values") as state:
            with self.assertRaisesRegex(RuntimeError, "COGNITO_REHEARSAL_EMAIL"):
                control.configure()
            state.assert_not_called()

    def test_invalid_recipient_is_rejected_without_echoing_it(self):
        for value in ("", "missing-at", "inbox@example.test\nOTHER=value"):
            with self.subTest(value=value), patch.dict(os.environ, {
                "COGNITO_REHEARSAL_EMAIL": value,
            }, clear=True):
                with self.assertRaises(RuntimeError) as raised:
                    control.rehearsal_email()
                self.assertEqual(str(raised.exception),
                    "Configure COGNITO_REHEARSAL_EMAIL with an accessible verification inbox")

    def test_email_mode_hashes_only_the_selected_inbox(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / "environment"
            output = io.StringIO()
            with patch.dict(os.environ, {
                "OPERATION": "email-start",
                "GITHUB_ENV": str(env_file),
                "COGNITO_REHEARSAL_EMAIL": " Accessible@Example.Test ",
                "QUIZFORGE_CANARY_EMAIL": "existing-canary@example.test",
            }, clear=True), patch.object(control, "values", return_value=None), contextlib.redirect_stdout(output):
                control.configure()
                self.assertEqual(control.rehearsal_email(), "accessible@example.test")
            written = env_file.read_text()
            digest = hashlib.sha256(b"accessible@example.test").hexdigest()
            self.assertIn("TF_VAR_email_sha256=" + digest + "\n", written)
            self.assertNotIn("@", written + output.getvalue())

    def test_automated_run_keeps_public_signup_disabled_without_an_inbox(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / "environment"
            with patch.dict(os.environ, {
                "OPERATION": "run", "GITHUB_ENV": str(env_file),
            }, clear=True), patch.object(control, "values", return_value=None), contextlib.redirect_stdout(io.StringIO()):
                control.configure()
            self.assertIn("TF_VAR_email_sha256=\n", env_file.read_text())


if __name__ == "__main__":
    unittest.main()
