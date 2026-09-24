from __future__ import annotations

import copy
from pathlib import Path
import unittest

from scripts.lightsail_activation.repair_gate import (
    CONFIRMATION,
    Refused,
    review_final_plan,
    trusted,
)
from scripts.lightsail_activation.repair_review import FINAL, REPAIR_CREATES
from scripts.lightsail_activation.tests.test_repair_review import (
    CATALOG,
    SETTINGS,
    plan,
)

SHA = "a" * 40


def environment():
    return {
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_REPOSITORY": "HamedGithubforwork/QuizForge-AI",
        "GITHUB_WORKFLOW_REF":
            "HamedGithubforwork/QuizForge-AI/.github/workflows/lightsail-production-repair-activation.yml@refs/heads/main",
        "GITHUB_SHA": SHA,
        "GITHUB_WORKFLOW_SHA": SHA,
        "TF_WORKSPACE": "default",
        "QF_REPAIR_CONFIRMATION": CONFIRMATION,
    }


def live_contract():
    static_ip = "198.51.100.20"
    return {
        "summary": {
            "instance_exists": True,
            "static_ip_exists": True,
            "instance_blueprint_expected": True,
            "instance_bundle_expected": True,
            "instance_availability_zone_expected": True,
            "instance_reports_static_ip": True,
            "static_ip_attached_to_expected_instance": True,
            "instance_public_ip_matches_static_ip": True,
            "public_ports_contract_ok": True,
        },
        "_instance_public_ip": static_ip,
        "_static_public_ip": static_ip,
        "_instance_is_static_ip": True,
    }


def final_plan(with_refresh_drift=True):
    document = plan()

    after_by_address = {
        item["address"]: copy.deepcopy(item["change"]["after"])
        for item in document["resource_changes"]
        if item["mode"] == "managed"
    }

    document["prior_state"]["values"]["root_module"]["resources"] = [
        {
            "address": address,
            "mode": "managed",
            "type": address.split(".")[0],
            "name": address.split(".")[1],
            "values": copy.deepcopy(after_by_address[address]),
        }
        for address in sorted(FINAL)
    ]

    for item in document["resource_changes"]:
        if item["mode"] != "managed":
            continue
        value = copy.deepcopy(after_by_address[item["address"]])
        item["change"] = {
            "actions": ["no-op"],
            "before": copy.deepcopy(value),
            "after": copy.deepcopy(value),
            "after_unknown": {},
        }

    document["applyable"] = False
    if with_refresh_drift:
        document["resource_drift"] = [{
            "address": "aws_lightsail_instance.server",
            "mode": "managed",
            "provider_name": "registry.terraform.io/hashicorp/aws",
            "change": {
                "actions": ["update"],
                "before": {
                    "is_static_ip": False,
                    "public_ip_address": "198.51.100.10",
                    "tags": None,
                },
                "after": {
                    "is_static_ip": True,
                    "public_ip_address": "198.51.100.20",
                    "tags": {},
                },
            },
        }]
    else:
        document["resource_drift"] = []
    return document


class RepairActivationGateTests(unittest.TestCase):
    def test_exact_manual_main_confirmation_passes(self):
        trusted(environment())

    def test_wrong_confirmation_branch_debug_or_workflow_ref_are_refused(self):
        cases = [
            ("QF_REPAIR_CONFIRMATION", "yes"),
            ("GITHUB_REF", "refs/heads/feature"),
            ("ACTIONS_STEP_DEBUG", "true"),
            (
                "GITHUB_WORKFLOW_REF",
                "HamedGithubforwork/QuizForge-AI/.github/workflows/lightsail-production-activation.yml@refs/heads/main",
            ),
        ]
        for name, value in cases:
            with self.subTest(name=name):
                env = environment()
                env[name] = value
                with self.assertRaises(Refused):
                    trusted(env)

    def test_workflow_uses_activation_authorized_catalog_path(self):
        workflow = Path(
            ".github/workflows/lightsail-production-repair-activation.yml"
        ).read_text()
        self.assertIn(
            "python -m scripts.lightsail_activation.repair_gate catalog",
            workflow,
        )
        self.assertNotIn(
            "python -m scripts.lightsail_activation.repair_review catalog",
            workflow,
        )
        catalog_block = workflow.split(
            "- name: Verify current catalog and separately managed USD20 budget",
            1,
        )[1].split("- name: Initialize only the permanent Lightsail state", 1)[0]
        self.assertIn("QF_REPAIR_CONFIRMATION:", catalog_block)
        self.assertIn(
            "lightsail-repair-activation-results/catalog.json",
            workflow,
        )
        self.assertNotIn(
            '"lightsail-repair-results/catalog.json"',
            workflow,
        )

    def test_workflow_reviews_final_plan_json_for_exit_code_zero_or_two(self):
        workflow = Path(
            ".github/workflows/lightsail-production-repair-activation.yml"
        ).read_text()
        final_block = workflow.split(
            "- name: Require exact final state and a no-change live plan",
            1,
        )[1].split("- name: Record safe failure state", 1)[0]
        self.assertIn('if [ "$status" -eq 1 ]; then', final_block)
        self.assertIn(
            'if [ "$status" -ne 0 ] && [ "$status" -ne 2 ]; then',
            final_block,
        )
        self.assertIn(
            "python -m scripts.lightsail_activation.repair_gate verify-final-plan",
            final_block,
        )
        self.assertNotIn(
            'if [ "$status" -ne 0 ]; then',
            final_block,
        )

    def test_final_noop_plan_accepts_only_verified_post_attachment_refresh(self):
        manifest = review_final_plan(
            final_plan(),
            SETTINGS,
            CATALOG,
            live=live_contract(),
        )
        self.assertEqual(manifest["final_managed_resources"], len(FINAL))
        self.assertEqual(manifest["all_final_resources_noop"], len(FINAL))
        self.assertEqual(manifest["updates"], 0)
        self.assertEqual(manifest["deletes"], 0)
        self.assertEqual(manifest["replacements"], 0)
        self.assertEqual(manifest["approved_refresh_drift_entries"], 0)
        self.assertEqual(manifest["approved_final_refresh_drift_entries"], 1)
        self.assertTrue(manifest["live_lightsail_contract_verified"])
        self.assertTrue(manifest["repair_contract_reused"])

        clean = review_final_plan(
            final_plan(with_refresh_drift=False),
            SETTINGS,
            CATALOG,
            live=live_contract(),
        )
        self.assertEqual(clean["approved_final_refresh_drift_entries"], 0)

    def test_final_plan_refuses_missing_resource_update_replace_or_import(self):
        mutations = []

        def missing(document):
            document["resource_changes"].pop()
        mutations.append(missing)

        def update(document):
            document["resource_changes"][0]["change"]["actions"] = ["update"]
        mutations.append(update)

        def replace(document):
            document["resource_changes"][0]["change"]["actions"] = ["delete", "create"]
            document["resource_changes"][0]["change"]["replace_paths"] = [["tags"]]
        mutations.append(replace)

        def importing(document):
            target = next(
                item for item in document["resource_changes"]
                if item["address"] in REPAIR_CREATES
            )
            target["change"]["importing"] = {"id": "unexpected"}
        mutations.append(importing)

        for mutate in mutations:
            with self.subTest(mutate=mutate):
                document = final_plan()
                mutate(document)
                with self.assertRaises(Refused):
                    review_final_plan(document, SETTINGS, CATALOG, live=live_contract())

    def test_final_plan_refuses_any_unverified_refresh_variant(self):
        mutators = [
            lambda p: p["resource_drift"][0]["change"]["after"].update(
                tags={"Project": "unexpected"}
            ),
            lambda p: p["resource_drift"][0]["change"]["after"].update(
                is_static_ip=False
            ),
            lambda p: p["resource_drift"][0]["change"]["after"].update(
                public_ip_address="198.51.100.99"
            ),
            lambda p: p["resource_drift"][0]["change"]["before"].update(
                public_ip_address="198.51.100.20"
            ),
            lambda p: p["resource_drift"][0]["change"]["after"].update(
                unexpected_field="x"
            ),
            lambda p: p["resource_drift"].append(copy.deepcopy(p["resource_drift"][0])),
        ]
        for mutate in mutators:
            with self.subTest(mutate=mutate):
                document = final_plan()
                mutate(document)
                with self.assertRaises(Refused):
                    review_final_plan(
                        document,
                        SETTINGS,
                        CATALOG,
                        live=live_contract(),
                    )

    def test_final_plan_refuses_bad_live_lightsail_contract(self):
        for key in (
            "instance_blueprint_expected",
            "instance_bundle_expected",
            "instance_availability_zone_expected",
            "instance_reports_static_ip",
            "static_ip_attached_to_expected_instance",
            "instance_public_ip_matches_static_ip",
            "public_ports_contract_ok",
        ):
            with self.subTest(key=key):
                live = live_contract()
                live["summary"][key] = False
                with self.assertRaisesRegex(
                    Refused,
                    "FINAL_LIGHTSAIL_LIVE_CONTRACT_MISMATCH",
                ):
                    review_final_plan(final_plan(), SETTINGS, CATALOG, live=live)


if __name__ == "__main__":
    unittest.main()
