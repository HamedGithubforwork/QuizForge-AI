"""Exercise the shell/child stdin boundary used by the SSH controllers."""

import subprocess
import tempfile
from pathlib import Path
import unittest

from scripts.production.lightsail import apply_database_migrations, promote_release


def shell_function(script: str, name: str) -> str:
    """Use the actual embedded function without executing host operations."""
    start = script.index(name + "() {")
    end = script.index("\n}", start) + 2
    return script[start:end]


class RemoteStdinTests(unittest.TestCase):
    def test_queries_preserve_following_checks_and_propagate_failures(self):
        for remote in (
            apply_database_migrations.REMOTE,
            promote_release.REMOTE_PROMOTE,
        ):
            for query_status, postcondition_status in ((0, 0), (47, 0), (0, 49)):
                with self.subTest(
                    controller=remote.splitlines()[1],
                    query_status=query_status,
                    postcondition_status=postcondition_status,
                ):
                    # Simulate Compose eagerly reading its inherited stdin.
                    # Without isolation this drains bash -s, skips every line
                    # after the query, and can return zero without a marker.
                    script = "\n".join((
                        "set -euo pipefail",
                        "compose=unused; compose_current=unused",
                        "sudo() { cat >/dev/null; printf '1\\n'; "
                        f"return {query_status}; }}",
                        shell_function(remote, "dbq"),
                        'value="$(dbq "SELECT 1")"',
                        'test "$value" = "1"',
                        f"(exit {postcondition_status})",
                        "printf 'QF_RESULT={\"verified\":true}\\n'",
                        "",
                    ))
                    completed = subprocess.run(
                        ["bash", "-s"], input=script, text=True,
                        capture_output=True, timeout=5, check=False,
                    )
                    self.assertEqual(
                        completed.returncode,
                        query_status or postcondition_status,
                        completed.stderr,
                    )
                    self.assertEqual(
                        completed.stdout,
                        '' if query_status or postcondition_status
                        else 'QF_RESULT={"verified":true}\n',
                    )

    def test_migration_sql_still_receives_its_explicit_file_input(self):
        with tempfile.TemporaryDirectory() as directory:
            sql = Path(directory) / "migration.sql"
            sql.write_text("SELECT 'reviewed migration';\n")
            script = "\n".join((
                "set -euo pipefail",
                "compose=unused",
                "sudo() { cat; }",
                shell_function(apply_database_migrations.REMOTE, "apply_sql"),
                'apply_sql "$1"',
                "printf 'POSTCONDITIONS_RAN\\n'",
                "",
            ))
            completed = subprocess.run(
                ["bash", "-s", "--", str(sql)], input=script, text=True,
                capture_output=True, timeout=5, check=True,
            )
            self.assertEqual(
                completed.stdout, sql.read_text() + "POSTCONDITIONS_RAN\n",
            )


if __name__ == "__main__":
    unittest.main()
