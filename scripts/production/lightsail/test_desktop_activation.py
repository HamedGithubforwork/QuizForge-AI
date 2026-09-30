import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from scripts.production.lightsail.desktop_activation import activation_client


class DesktopActivationTests(unittest.TestCase):
    def test_exact_candidate_matching_pool_and_verified_policy_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "pin.json"
            public = {"pool": "ca-central-1_Synthetic", "client": "webclient"}
            cognito = Mock()
            self.assertIsNone(activation_client(source, "a" * 40, public, root, cognito))
            source.write_text(json.dumps({"schema": 1, "application_candidate_sha": "a" * 40}))
            self.assertIsNone(activation_client(source, "b" * 40, public, root, cognito))
            cognito.describe_user_pool_client.assert_not_called()
            config = root / "desktop/src/native-runtime.json"
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps({"schema": 1, "poolId": public["pool"], "clientId": "desktopclient"}))
            cognito.describe_user_pool_client.return_value = {"UserPoolClient": {"ClientId": "desktopclient"}}
            with patch("scripts.production.lightsail.desktop_activation.subprocess.run") as run:
                run.return_value.returncode = 0
                self.assertEqual(activation_client(source, "a" * 40, public, root, cognito), "desktopclient")
                args = run.call_args.args[0]
                self.assertEqual(args[2:5], ["verify", public["pool"], public["client"]])
                self.assertTrue(run.call_args.kwargs["capture_output"])
                run.return_value.returncode = 1
                with self.assertRaises(ValueError):
                    activation_client(source, "a" * 40, public, root, cognito)
            for bad in ({"schema": 1, "poolId": "ca-central-1_Other", "clientId": "desktopclient"},
                        {"schema": 1, "poolId": public["pool"], "clientId": public["client"]}):
                config.write_text(json.dumps(bad))
                with self.assertRaises(ValueError):
                    activation_client(source, "a" * 40, public, root, cognito)
