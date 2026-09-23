import unittest

from scripts.lightsail_activation.reconcile import _not_found, classify, state_addresses
from scripts.lightsail_activation.review import EXPECTED


class StateTests(unittest.TestCase):
    def test_common_missing_resource_codes_are_not_fatal(self):
        class FakeError:
            def __init__(self, code):
                self.response = {"Error": {"Code": code}}
        for code in ("NoSuchEntity", "NoSuchEntityException", "NotFound",
                     "NotFoundException", "ResourceNotFound",
                     "ResourceNotFoundException", "404"):
            with self.subTest(code=code):
                self.assertTrue(_not_found(FakeError(code)))

    def test_state_addresses_uses_only_instanced_managed_resources(self):
        document = {
            "resources": [
                {"mode": "managed", "type": "aws_x", "name": "a", "instances": [{}]},
                {"mode": "managed", "type": "aws_y", "name": "b", "instances": []},
                {"mode": "data", "type": "aws_z", "name": "c", "instances": [{}]},
                {"module": "module.example", "mode": "managed", "type": "aws_q",
                 "name": "d", "instances": [{}]},
            ]
        }
        self.assertEqual(
            state_addresses(document),
            {"aws_x.a", "module.example.aws_q.d"},
        )

    def test_classification(self):
        expected = set(EXPECTED)
        self.assertEqual(classify(set(), set()), "no_resources_found")
        self.assertEqual(
            classify(expected, expected), "state_and_live_complete"
        )
        partial = set(sorted(expected)[:3])
        self.assertEqual(
            classify(partial, partial), "matching_partial_state_and_live_resources"
        )
        self.assertEqual(
            classify(partial, set(sorted(expected)[:4])),
            "state_live_mismatch_partial_resources",
        )


class WorkflowTests(unittest.TestCase):
    def test_reconciliation_workflow_has_no_write_paths(self):
        from pathlib import Path
        workflow = Path(
            ".github/workflows/lightsail-production-reconcile.yml"
        ).read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn("id-token: write", workflow)
        for forbidden in (
            "terraform apply", "terraform destroy", "terraform import",
            "put-object", "delete-object", "create-", "update-", "attach-",
            "route53", "public_signup=true",
        ):
            self.assertNotIn(forbidden, workflow.lower())
        validation = workflow.split("  validate:\n", 1)[1].split("  reconcile:\n", 1)[0]
        self.assertNotIn("secrets.", validation)
        self.assertNotIn("configure-aws-credentials", validation)


if __name__ == "__main__":
    unittest.main()
