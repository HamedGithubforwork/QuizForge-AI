import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock

from scripts.production.lightsail import (
    enable_study_notifier,
)


class StudyNotifierActivationTests(
    unittest.TestCase
):
    def test_result_parser_rejects_missing_duplicate_or_untrusted_fields(self):
        valid = dict.fromkeys(enable_study_notifier.ACTIVATION_FIELDS, True)
        line = 'QF_RESULT=' + json.dumps(valid)
        self.assertEqual(enable_study_notifier.parse_result(line, False), valid)
        for output in ('', line + '\n' + line, 'QF_RESULT=[]',
                       'QF_RESULT=' + json.dumps(valid | {'private': 'untrusted'}),
                       'QF_RESULT=' + json.dumps(valid | {'notifier_probe_succeeded': 1}),
                       'QF_RESULT=' + json.dumps(valid | {'notifier_probe_succeeded': False})):
            with self.subTest(output=output), self.assertRaises(ValueError):
                enable_study_notifier.parse_result(output, False)

    def test_inspection_observes_disabled_state_without_activation_or_copy(self):
        state = dict.fromkeys(enable_study_notifier.INSPECTION_FIELDS, False)
        state['application_active'] = True
        code, report, run = self.run_controller(state)
        self.assertEqual(code, 0)
        self.assertEqual(report['result'], 'study_notifier_inspected')
        self.assertFalse(report['notifier_timer_enabled'])
        self.assertTrue(report['baseline_firewall_restored'])
        run.assert_called_once()
        self.assertEqual(run.call_args.kwargs['input'], enable_study_notifier.REMOTE_INSPECT)
        self.assertEqual(run.call_args.args[0][0], 'ssh')
        self.assertIn('-n', run.call_args.args[0])
        for mutation in ('docker compose', 'systemctl enable', 'systemctl start', 'install -m'):
            self.assertNotIn(mutation, enable_study_notifier.REMOTE_INSPECT)

    def test_failure_stage_distinguishes_host_verification_from_host_mutation(self):
        code, report, run = self.run_controller({}, fail_scan=True)
        self.assertEqual(code, 1)
        self.assertEqual(report['stage'], 'verify_host_key')
        self.assertEqual(report['error_code'], 'ValueError')
        self.assertTrue(report['baseline_firewall_restored'])
        run.assert_not_called()
        self.assertNotIn('private diagnostic', json.dumps(report))

    def run_controller(self, state, fail_scan=False):
        module = enable_study_notifier
        client = Mock()
        client.get_instance.return_value = {'instance': {
            'blueprintId': 'ubuntu_24_04', 'bundleId': 'small_3_0', 'isStaticIp': True}}
        client.get_static_ip.return_value = {'staticIp': {
            'attachedTo': module.INSTANCE_NAME, 'ipAddress': '198.51.100.20'}}
        client.get_instance_port_states.return_value = {'portStates': []}
        client.get_instance_access_details.return_value = {'accessDetails': {
            'privateKey': 'SYNTHETIC_PRIVATE_KEY', 'certKey': 'SYNTHETIC_CERT', 'username': 'ubuntu'}}
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, {'LIGHTSAIL_ADMIN_IPV4_CIDR': '192.0.2.10/32',
                                     'QF_NOTIFIER_INSPECT_ONLY': 'true'}), \
             patch.object(module, 'RESULT', Path(directory) / 'summary.json'), \
             patch.object(module.boto3, 'client', return_value=client), \
             patch.object(module, 'normalized_ports', return_value=module.baseline_ports('192.0.2.10/32')), \
             patch.object(module, 'runner_ipv4', return_value='192.0.2.11'), \
             patch.object(module, 'scan_host', return_value='synthetic-known-host',
                          side_effect=ValueError('private diagnostic') if fail_scan else None), \
             patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess(
                 [], 0, 'QF_RESULT=' + json.dumps(state), '')) as run:
            code = module.main()
            report = json.loads(module.RESULT.read_text())
        return code, report, run

    def test_reviewed_units_are_exact_and_nonempty(self):
        for path in (
            enable_study_notifier.SERVICE,
            enable_study_notifier.TIMER,
        ):
            self.assertTrue(
                path.is_file()
            )
            self.assertGreater(
                path.stat().st_size,
                20,
            )
            self.assertRegex(
                enable_study_notifier.sha256(
                    path
                ),
                r"^[a-f0-9]{64}$",
            )

    def test_activation_requires_private_credentials_and_probe(self):
        remote = (
            enable_study_notifier
            .REMOTE
        )

        for value in (
            "/etc/quizforge/notifier.env",
            "/etc/quizforge/web-push-private.env",
            "/etc/quizforge/web-push-public.env",
            "quizforge_notifier",
            "--profile scheduled",
            "run --rm --no-deps notifier",
            "notifier_probe_succeeded",
            "systemctl enable --now quizforge-study-notifier.timer",
        ):
            self.assertIn(
                value,
                remote,
            )

        self.assertIn(
            "OPENAI_API_KEY",
            remote,
        )
        self.assertIn(
            "not in notifier",
            remote,
        )

    def test_units_keep_recurrence_bounded(self):
        service = (
            enable_study_notifier
            .SERVICE
            .read_text()
        )
        timer = (
            enable_study_notifier
            .TIMER
            .read_text()
        )

        self.assertIn(
            "Type=oneshot",
            service,
        )
        self.assertIn(
            "--profile scheduled run --rm --no-deps notifier",
            service,
        )
        self.assertIn(
            "OnUnitInactiveSec=15min",
            timer,
        )
        self.assertIn(
            "RandomizedDelaySec=30s",
            timer,
        )
        self.assertNotIn(
            "OnCalendar=*:*:00",
            timer,
        )


if __name__ == "__main__":
    unittest.main()
