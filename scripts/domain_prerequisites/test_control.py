import copy
import unittest

import control


def plan():
    values = {
        "aws_route53_zone.domain": {"name": control.DOMAIN, "force_destroy": False, "vpc": []},
        "aws_acm_certificate.staging_api": {
            "domain_name": control.HOSTNAME, "validation_method": "DNS", "key_algorithm": "RSA_2048",
            "options": [{"export": "DISABLED"}], "subject_alternative_names": [control.HOSTNAME],
        },
        "aws_route53_record.validation": {
            "name": "_token." + control.HOSTNAME + ".", "type": "CNAME", "ttl": 300, "allow_overwrite": False,
        },
    }
    return {"resource_changes": [{"mode": "managed", "address": key,
                                  "change": {"actions": ["create"], "after": value, "after_unknown": {}}}
                                 for key, value in values.items()]}


class Boundaries(unittest.TestCase):
    def test_creation_and_repeat_noop_are_allowed(self):
        value = plan()
        control.check_plan(value)
        for item in value["resource_changes"]:
            item["change"]["actions"] = ["no-op"]
        control.check_plan(value)

    def test_acm_generated_unknown_record_is_allowed(self):
        value = plan()
        record = value["resource_changes"][2]["change"]
        record["after"]["name"] = None
        record["after_unknown"] = {"name": True}
        control.check_plan(value)

    def test_deletion_replacement_and_update_are_rejected(self):
        for actions in (["delete"], ["delete", "create"], ["update"]):
            with self.subTest(actions=actions), self.assertRaises(ValueError):
                value = plan()
                value["resource_changes"][0]["change"]["actions"] = actions
                control.check_plan(value)

    def test_application_or_missing_resources_are_rejected(self):
        value = plan()
        value["resource_changes"][0]["address"] = "aws_lb.production"
        with self.assertRaises(ValueError):
            control.check_plan(value)
        with self.assertRaises(ValueError):
            control.check_plan({"resource_changes": []})

    def test_private_wrong_or_force_destroy_zone_is_rejected(self):
        for patch in ({"name": "unrelated.com"}, {"vpc": [{"vpc_id": "vpc-1"}]}, {"force_destroy": True}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                value = plan()
                value["resource_changes"][0]["change"]["after"].update(patch)
                control.check_plan(value)

    def test_export_private_ca_production_san_and_email_are_rejected(self):
        for patch in ({"options": [{"export": "ENABLED"}]}, {"certificate_authority_arn": "private-ca"},
                      {"domain_name": "api." + control.DOMAIN}, {"subject_alternative_names": [control.DOMAIN]},
                      {"validation_method": "EMAIL"}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                value = plan()
                value["resource_changes"][1]["change"]["after"].update(patch)
                control.check_plan(value)

    def test_dns_overwrite_and_nonvalidation_record_are_rejected(self):
        for patch in ({"allow_overwrite": True}, {"type": "A"}, {"name": "www." + control.DOMAIN}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                value = plan()
                value["resource_changes"][2]["change"]["after"].update(patch)
                control.check_plan(value)

    def test_unmanaged_duplicate_is_rejected_but_owned_zone_is_allowed(self):
        zone = {"Name": control.DOMAIN + ".", "Id": "/hostedzone/ZOWNED", "Config": {"PrivateZone": False}}
        control.check_existing_zones([], None)
        control.check_existing_zones([zone], "ZOWNED")
        with self.assertRaises(ValueError):
            control.check_existing_zones([zone], None)
        duplicate = copy.deepcopy(zone)
        duplicate["Id"] = "/hostedzone/ZOTHER"
        with self.assertRaises(ValueError):
            control.check_existing_zones([zone, duplicate], "ZOWNED")
        zone["Config"]["PrivateZone"] = True
        with self.assertRaises(ValueError):
            control.check_existing_zones([zone], "ZOWNED")


if __name__ == "__main__":
    unittest.main()
