import copy
import unittest
from unittest.mock import MagicMock
from botocore.exceptions import ClientError

from control import COST_TYPES, NAME, NOTIFICATIONS, execute, expected

ACCOUNT = "123456789012"
EMAIL = "synthetic@example.com"


def absent():
    return ClientError({"Error": {"Code": "NotFoundException", "Message": "private"}}, "DescribeBudget")


def configured():
    client = MagicMock()
    client.describe_budget.return_value = {"Budget": expected()}
    client.describe_notifications_for_budget.return_value = {"Notifications": copy.deepcopy(NOTIFICATIONS)}
    client.describe_subscribers_for_notification.return_value = {"Subscribers": [{"SubscriptionType": "EMAIL", "Address": EMAIL}]}
    return client


class Controls(unittest.TestCase):
    def test_aws_omitted_percentage_type_is_default_but_absolute_and_null_refuse(self):
        client = configured()
        notices = [dict(n) for n in NOTIFICATIONS]
        for notice in notices:
            del notice["ThresholdType"]
        client.describe_notifications_for_budget.return_value = {"Notifications": notices}
        execute(client, ACCOUNT, EMAIL, "inspect")
        for bad in ("ABSOLUTE_VALUE", None, "unknown"):
            notices[0]["ThresholdType"] = bad
            with self.assertRaises(ValueError):
                execute(client, ACCOUNT, EMAIL, "inspect")


    def test_read_only_absent_never_creates(self):
        client = configured(); client.describe_budget.side_effect = absent()
        self.assertFalse(execute(client, ACCOUNT, EMAIL, "inspect")["budget_present"])
        client.create_budget.assert_not_called()

    def test_create_once_and_read_back_all_four_private_recipients(self):
        client = configured(); client.describe_budget.side_effect = [absent(), {"Budget": expected()}]
        report = execute(client, ACCOUNT, EMAIL, "activate")
        self.assertTrue(report["created"]); self.assertTrue(report["recipient_verified"])
        self.assertFalse(report["delivery_verified"])
        self.assertNotIn(EMAIL, str(report)); self.assertNotIn(ACCOUNT, str(report))
        client.create_budget.assert_called_once()
        args = client.create_budget.call_args.kwargs
        self.assertEqual(args["Budget"], expected())
        self.assertEqual(len(args["NotificationsWithSubscribers"]), 4)
        self.assertEqual(client.describe_subscribers_for_notification.call_count, 4)

    def test_idempotent_existing_budget_never_writes(self):
        client = configured()
        self.assertFalse(execute(client, ACCOUNT, EMAIL, "activate")["created"])
        client.create_budget.assert_not_called()

    def test_existing_wrong_scope_amount_cost_types_or_recipient_refuses(self):
        for field, value in (("BudgetLimit", {"Amount": "100", "Unit": "USD"}),
                ("CostFilters", {"Service": ["Amazon EC2"]}), ("AutoAdjustData", {"AutoAdjustType": "HISTORICAL"}),
                ("CostTypes", COST_TYPES | {"IncludeCredit": True})):
            client = configured(); client.describe_budget.return_value["Budget"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): execute(client, ACCOUNT, EMAIL, "activate")
            client.create_budget.assert_not_called()
        client = configured(); client.describe_subscribers_for_notification.return_value["Subscribers"][0]["Address"] = "wrong@example.com"
        with self.assertRaises(ValueError): execute(client, ACCOUNT, EMAIL, "activate")
        client.create_budget.assert_not_called()

    def test_extra_missing_duplicate_or_paged_notifications_refuse(self):
        for response in ({"Notifications": NOTIFICATIONS[:3]}, {"Notifications": NOTIFICATIONS + NOTIFICATIONS[:1]},
                         {"Notifications": NOTIFICATIONS, "NextToken": "more"}):
            client = configured(); client.describe_notifications_for_budget.return_value = response
            with self.assertRaises(ValueError): execute(client, ACCOUNT, EMAIL, "activate")
            client.create_budget.assert_not_called()

    def test_missing_email_read_denial_and_ambiguous_create_do_not_retry(self):
        client = configured()
        with self.assertRaises(ValueError): execute(client, ACCOUNT, "", "activate")
        client.describe_budget.assert_not_called()
        client.describe_budget.side_effect = ClientError({"Error": {"Code": "AccessDeniedException"}}, "DescribeBudget")
        with self.assertRaises(ClientError): execute(client, ACCOUNT, EMAIL, "activate")
        client.create_budget.assert_not_called()
        client.describe_budget.side_effect = absent(); client.create_budget.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError): execute(client, ACCOUNT, EMAIL, "activate")
        client.create_budget.assert_called_once()


if __name__ == "__main__": unittest.main()
