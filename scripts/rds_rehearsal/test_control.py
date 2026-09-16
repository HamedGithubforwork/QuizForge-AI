import unittest
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
                return {"Parameters": [{"ParameterName": "rds.force_ssl", "ParameterValue": "1"}]}
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
            if args[1] in ("describe-db-instances", "describe-db-snapshots"): return None
            if args[1] == "list-tasks": return {"taskArns": []}
            counts[0] += 1
            return {"DBInstanceAutomatedBackups": [{"DBInstanceIdentifier": control.NAME}] if counts[0] == 1 else []}
        with patch.object(control, "aws", side_effect=aws), patch.object(control.time, "sleep") as sleep:
            control.confirm_absent()
        self.assertEqual(counts[0], 2)
        sleep.assert_called_once_with(30)

    def test_cleanup_does_not_pass_when_resource_remains(self):
        def aws(*args, **kwargs):
            if args[1] == "describe-db-instances": return {"DBInstances": [{}]}
            if args[1] == "describe-db-snapshots": return None
            if args[1] == "list-tasks": return {"taskArns": []}
            return {"DBInstanceAutomatedBackups": []}
        with patch.object(control, "aws", side_effect=aws), patch.object(control.time, "sleep"), \
             patch.object(control.time, "monotonic", side_effect=[0, 0, 901]):
            with self.assertRaises(RuntimeError): control.confirm_absent()


if __name__ == "__main__": unittest.main()
