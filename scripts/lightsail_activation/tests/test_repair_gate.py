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
    approved_refresh_drift,
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


def final_plan():
    document = plan()
    document["resource_drift"] = approved_refresh_drift()

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

    def test_final_noop_plan_reuses_full_repair_safety_contract(self):
        manifest = review_final_plan(final_plan(), SETTINGS, CATALOG)
        self.assertEqual(manifest["final_managed_resources"], len(FINAL))
        self.assertEqual(manifest["all_final_resources_noop"], len(FINAL))
        self.assertEqual(manifest["updates"], 0)
        self.assertEqual(manifest["deletes"], 0)
        self.assertEqual(manifest["replacements"], 0)
        self.assertEqual(manifest["approved_refresh_drift_entries"], 8)
        self.assertTrue(manifest["repair_contract_reused"])

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
                    review_final_plan(document, SETTINGS, CATALOG)

    def test_final_plan_still_refuses_bad_refresh_drift(self):
        document = final_plan()
        document["resource_drift"][0]["change"]["after"]["tags"] = {
            "Project": "unexpected"
        }
        with self.assertRaisesRegex(Refused, "UNEXPECTED_PLAN_SIDE_EFFECTS"):
            review_final_plan(document, SETTINGS, CATALOG)


if __name__ == "__main__":
    unittest.main()
