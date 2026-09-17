from copy import deepcopy
import hashlib
import os
import unittest
from unittest.mock import patch

from pre_signup import handler


class SignupTests(unittest.TestCase):
    def event(self, email="dedicated@example.test", trigger="PreSignUp_SignUp"):
        return {"triggerSource": trigger, "request": {"userAttributes": {"email": email}}, "response": {}}

    def test_default_denies_public_signup(self):
        with patch.dict(os.environ, {"ALLOWED_EMAIL_SHA256": ""}):
            for email in ("dedicated@example.test", "qf-browser-mapped@example.invalid", None):
                with self.assertRaises(ValueError): handler(self.event(email), None)

    def test_allowed_inbox_still_requires_real_confirmation(self):
        digest = hashlib.sha256(b"dedicated@example.test").hexdigest()
        with patch.dict(os.environ, {"ALLOWED_EMAIL_SHA256": digest}):
            event = self.event(" Dedicated@Example.Test ")
            original = deepcopy(event)
            self.assertEqual(handler(event, None), original)
            self.assertNotIn("autoConfirmUser", event["response"])
            self.assertNotIn("autoVerifyEmail", event["response"])
            with self.assertRaises(ValueError): handler(self.event("other@example.test"), None)

    def test_admin_exception_is_only_for_synthetic_accounts(self):
        self.assertEqual(handler(self.event("qf-browser-mapped@example.invalid", "PreSignUp_AdminCreateUser"), None)["response"], {})
        for trigger in ("PreSignUp_AdminCreateUser", "PreSignUp_ExternalProvider", "anything"):
            with self.assertRaises(ValueError): handler(self.event(trigger=trigger), None)


if __name__ == "__main__": unittest.main()
