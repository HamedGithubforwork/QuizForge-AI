import io
import json
import os
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import control


class LifecycleTests(unittest.TestCase):
    def test_pending_parameters_reboot_once_and_wait_for_active(self):
        states = iter([("available", "pending-reboot"), ("rebooting", "pending-reboot"), ("available", "in-sync")])
        reboots = []
        def aws(*args, **kwargs):
            if args[1] == "reboot-db-instance":
                reboots.append(args)
                return {}
            if args[1] == "describe-db-parameters":
                parameters = [{"ParameterName": "rds.force_ssl", "ParameterValue": "1", "Source": "engine-default"}]
                if "--source" in args:
                    parameters = [p for p in parameters if p["Source"] == args[args.index("--source") + 1]]
                return {"Parameters": parameters}
            status, applied = next(states)
            return {"DBInstances": [{"DBInstanceStatus": status, "DBParameterGroups": [
                {"ParameterApplyStatus": applied, "DBParameterGroupName": control.NAME}]}]}
        with patch.object(control, "aws", side_effect=aws), patch.object(control.time, "sleep"):
            control.ensure_parameters_active(control.NAME)
        self.assertEqual(len(reboots), 1)

    def test_ready_database_rejects_disabled_or_missing_forced_tls(self):
        for parameters in ([], [{"ParameterName": "rds.force_ssl", "ParameterValue": "0"}]):
            with self.subTest(parameters=parameters):
                def aws(*args, **kwargs):
                    if args[1] == "describe-db-parameters": return {"Parameters": parameters}
                    return {"DBInstances": [{"DBInstanceStatus": "available", "DBParameterGroups": [
                        {"ParameterApplyStatus": "in-sync", "DBParameterGroupName": control.NAME}]}]}
                with patch.object(control, "aws", side_effect=aws):
                    with self.assertRaisesRegex(AssertionError, "RDS must require TLS"):
                        control.ensure_parameters_active(control.NAME)

    def test_cleanup_waits_for_automated_backup_metadata(self):
        counts = [0]
        def aws(*args, **kwargs):
            if args[1] in ("describe-db-instances", "describe-db-snapshots", "describe-secret"): return None
            if args[1] == "list-tasks": return {"taskArns": []}
            if args[1] == "list-user-pools": return {"UserPools": []}
            counts[0] += 1
            return {"DBInstanceAutomatedBackups": [{"DBInstanceIdentifier": control.NAME}] if counts[0] == 1 else []}
        with patch.object(control, "aws", side_effect=aws), patch.object(control.time, "sleep") as sleep:
            control.confirm_absent()
        self.assertEqual(counts[0], 2)
        sleep.assert_called_once_with(30)

    def test_cleanup_does_not_pass_when_resource_remains(self):
        def aws(*args, **kwargs):
            if args[1] == "describe-db-instances": return {"DBInstances": [{}]}
            if args[1] in ("describe-db-snapshots", "describe-secret"): return None
            if args[1] == "list-tasks": return {"taskArns": []}
            if args[1] == "list-user-pools": return {"UserPools": []}
            return {"DBInstanceAutomatedBackups": []}
        with patch.object(control, "aws", side_effect=aws), patch.object(control.time, "sleep"), \
             patch.object(control.time, "monotonic", side_effect=[0, 0, 901]):
            with self.assertRaises(RuntimeError): control.confirm_absent()

    def test_cleanup_does_not_pass_when_session_secret_remains(self):
        def aws(*args, **kwargs):
            if args[1] in ("describe-db-instances", "describe-db-snapshots"): return None
            if args[1] == "describe-secret": return {"ARN": "still-present"}
            if args[1] == "list-tasks": return {"taskArns": []}
            if args[1] == "list-user-pools": return {"UserPools": []}
            return {"DBInstanceAutomatedBackups": []}
        with patch.object(control, "aws", side_effect=aws), patch.object(control.time, "sleep"), \
             patch.object(control.time, "monotonic", side_effect=[0, 0, 901]):
            with self.assertRaises(RuntimeError): control.confirm_absent()

    def test_api_result_uses_canary_exit_and_always_stops_task(self):
        values = {"cluster": "test", "subnets": ["subnet"], "security_group": "sg", "log_group": "logs"}
        for canary_exit, api_exit in ((0, 143), (1, 0)):
            with self.subTest(canary_exit=canary_exit):
                stopped = []
                def aws(*args, **kwargs):
                    if args[1] == "run-task": return {"tasks": [{"taskArn": "test/task/123"}]}
                    if args[1] == "describe-tasks": return {"tasks": [{"lastStatus": "STOPPED", "containers": [
                        {"name": "api", "exitCode": api_exit}, {"name": "canary", "exitCode": canary_exit}]}]}
                    if args[1] == "get-log-events": return {"events": []}
                    if args[1] == "stop-task": stopped.append(args); return {}
                    raise AssertionError("Unexpected AWS operation")
                with patch.object(control, "aws", side_effect=aws):
                    if canary_exit:
                        with self.assertRaises(AssertionError):
                            control.run_task(values, "task-definition", {}, container="canary", prefix="rds-api")
                    else:
                        control.run_task(values, "task-definition", {}, container="canary", prefix="rds-api")
                self.assertEqual(len(stopped), 1)

    def test_cleanup_does_not_pass_when_cognito_pool_remains(self):
        def aws(*args, **kwargs):
            if args[1] in ("describe-db-instances", "describe-db-snapshots", "describe-secret"): return None
            if args[1] == "list-tasks": return {"taskArns": []}
            if args[1] == "list-user-pools": return {"UserPools": [{"Name": "quizforge-cognito-rehearsal"}]}
            return {"DBInstanceAutomatedBackups": []}
        with patch.object(control, "aws", side_effect=aws), patch.object(control.time, "sleep"), \
             patch.object(control.time, "monotonic", side_effect=[0, 0, 901]):
            with self.assertRaises(RuntimeError): control.confirm_absent()

    def test_canary_session_uses_private_temporary_file_without_logging_token(self):
        token, paths = "test-token-never-log", []
        def aws(*args, **kwargs):
            if args[1] == "get-parameter":
                return {"Parameter": {"Value": "https://auth.example.test" if args[3].endswith("SUPABASE_URL") else "publishable"}}
            self.assertEqual(args[:3], ("secretsmanager", "put-secret-value", "--cli-input-json"))
            path = args[3].removeprefix("file://")
            paths.append(path)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            with open(path) as source: payload = json.load(source)
            self.assertEqual(json.loads(payload["SecretString"])["access_token"], token)
            self.assertNotIn(token, str(args))
            return {}
        responses = [io.BytesIO(json.dumps({"access_token": token}).encode()),
                     io.BytesIO(b'{"id":"00000000-0000-0000-0000-000000000099"}')]
        output = io.StringIO()
        with patch.object(control, "outputs", return_value={"session_secret": "temporary-session"}), \
             patch.object(control, "aws", side_effect=aws), patch.object(control, "urlopen", side_effect=responses), \
             patch.dict(os.environ, {"QUIZFORGE_CANARY_EMAIL": "test@example.test", "QUIZFORGE_CANARY_PASSWORD": "secret"}), \
             redirect_stdout(output):
            control.prepare_session()
        self.assertNotIn(token, output.getvalue())
        self.assertTrue(paths and all(not os.path.exists(path) for path in paths))


if __name__ == "__main__": unittest.main()
