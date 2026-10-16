import unittest

from scripts.production.lightsail.manual_instance_control import (
    INSTANCE_NAME,
    STATIC_IP_NAME,
    operate,
)


class FakeLightsail:
    def __init__(self, state="running"):
        self.state = state
        self.calls = []

    def get_instance(self, *, instanceName):
        self.calls.append(("get_instance", instanceName))
        return {"instance": {
            "name": INSTANCE_NAME,
            "blueprintId": "ubuntu_24_04",
            "bundleId": "small_3_0",
            "isStaticIp": True,
            "state": {"name": self.state},
        }}

    def get_static_ip(self, *, staticIpName):
        self.calls.append(("get_static_ip", staticIpName))
        return {"staticIp": {
            "name": STATIC_IP_NAME,
            "attachedTo": INSTANCE_NAME,
        }}

    def stop_instance(self, *, instanceName):
        self.calls.append(("stop_instance", instanceName))
        self.state = "stopped"

    def start_instance(self, *, instanceName):
        self.calls.append(("start_instance", instanceName))
        self.state = "running"


class ManualInstanceControlTests(unittest.TestCase):
    def test_stop_changes_only_the_named_instance(self):
        client = FakeLightsail()
        result = operate(client, "stop", sleep=lambda _: None)
        self.assertEqual(result["final_state"], "stopped")
        self.assertTrue(result["changed"])
        self.assertIn(("stop_instance", INSTANCE_NAME), client.calls)
        self.assertNotIn(("start_instance", INSTANCE_NAME), client.calls)

    def test_start_is_idempotent_when_already_running(self):
        client = FakeLightsail("running")
        result = operate(client, "start", sleep=lambda _: None)
        self.assertFalse(result["changed"])
        self.assertNotIn(("start_instance", INSTANCE_NAME), client.calls)

    def test_stop_is_idempotent_when_already_stopped(self):
        client = FakeLightsail("stopped")
        result = operate(client, "stop", sleep=lambda _: None)
        self.assertFalse(result["changed"])
        self.assertNotIn(("stop_instance", INSTANCE_NAME), client.calls)

    def test_refuses_unexpected_static_ip_attachment(self):
        client = FakeLightsail()
        original = client.get_static_ip
        client.get_static_ip = lambda **kwargs: {
            "staticIp": {"name": STATIC_IP_NAME, "attachedTo": "other-instance"}
        }
        with self.assertRaisesRegex(ValueError, "contract mismatch"):
            operate(client, "stop", sleep=lambda _: None)
        self.assertNotIn(("stop_instance", INSTANCE_NAME), client.calls)
        client.get_static_ip = original


if __name__ == "__main__":
    unittest.main()
