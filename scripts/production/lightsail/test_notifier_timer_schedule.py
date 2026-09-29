"""Run the embedded controllers against systemctl's two clock domains."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from scripts.production.lightsail import enable_study_notifier as controller


class NotifierTimerScheduleTests(unittest.TestCase):
    def run_shell(self, script, monotonic='1h 15min', realtime='', started=''):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            systemctl = root / 'systemctl'
            systemctl.write_text('''#!/usr/bin/env python3
import os, sys
with open(os.environ['CALLS'], 'a') as log:
    log.write(' '.join(sys.argv[1:]) + '\\n')
if sys.argv[1] == 'show':
    prop = sys.argv[sys.argv.index('-p') + 1]
    values = os.environ['MONOTONIC'].split('|')
    with open(os.environ['CALLS']) as log:
        count = log.read().count('NextElapseUSecMonotonic')
    monotonic = values[min(max(count - 1, 0), len(values) - 1)]
    print({'NextElapseUSecRealtime': os.environ['REALTIME'],
           'NextElapseUSecMonotonic': monotonic,
           'ExecMainStartTimestamp': os.environ['STARTED'],
           'Result': 'success'}.get(prop, ''))
''')
            systemctl.chmod(0o700)
            calls = root / 'calls'
            env = dict(os.environ, PATH=directory + os.pathsep + os.environ['PATH'],
                       CALLS=str(calls), MONOTONIC=monotonic, REALTIME=realtime,
                       STARTED=started)
            completed = subprocess.run(['bash', '-s', '--', 'unused', 'unused'],
                                       input=script, text=True, capture_output=True,
                                       env=env, timeout=5, check=False)
            return completed, calls.read_text()

    def activation_tail(self):
        # Exercise the real enable/acceptance/rollback path without Docker,
        # network access, host files, or an actual systemd instance.
        start = controller.REMOTE.index('rollback() {')
        return 'set -euo pipefail\nsudo() { "$@"; }\nsleep() { :; }\n' + controller.REMOTE[start:]

    def test_monotonic_timer_is_accepted_without_calendar_deadline(self):
        result, calls = self.run_shell(self.activation_tail())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(controller.parse_result(result.stdout, False)['notifier_timer_has_next_run'])
        self.assertNotIn('disable --now', calls)

    def test_absent_monotonic_deadline_rolls_back_even_with_calendar_value(self):
        for value in ('', 'n/a', '0', 'infinity'):
            with self.subTest(value=value):
                result, calls = self.run_shell(self.activation_tail(), monotonic=value,
                                              realtime='Tue 2026-09-29 23:30:00 UTC')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('disable --now quizforge-study-notifier.timer', calls)
                self.assertNotIn('QF_RESULT=', result.stdout)
                self.assertEqual(calls.count('NextElapseUSecMonotonic'), 15)

    def test_activation_waits_for_service_to_settle(self):
        result, calls = self.run_shell(self.activation_tail(), monotonic='n/a|0|1h 15min')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls.count('NextElapseUSecMonotonic'), 3)
        self.assertNotIn('disable --now', calls)

    def test_inspection_reports_monotonic_schedule_and_actual_run(self):
        result, _ = self.run_shell(controller.REMOTE_INSPECT)
        self.assertEqual(result.returncode, 0, result.stderr)
        state = controller.parse_result(result.stdout, True)
        self.assertTrue(state['notifier_timer_has_next_run'])
        self.assertFalse(state['notifier_last_run_succeeded'])
        result, _ = self.run_shell(controller.REMOTE_INSPECT, started='Tue 2026-09-29 23:00:00 UTC')
        self.assertTrue(controller.parse_result(result.stdout, True)['notifier_last_run_succeeded'])

    def test_inspection_rejects_unset_monotonic_schedule(self):
        for value in ('', 'n/a', '0', 'infinity'):
            with self.subTest(value=value):
                result, _ = self.run_shell(controller.REMOTE_INSPECT, monotonic=value)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(controller.parse_result(result.stdout, True)['notifier_timer_has_next_run'])


if __name__ == '__main__':
    unittest.main()
