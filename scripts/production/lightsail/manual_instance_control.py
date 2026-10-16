"""Manually start or stop the exact production Lightsail host.

This powers down the VM without deleting it. Lightsail continues charging for a
stopped instance; this control is for availability/testing, not cost removal.
"""
from __future__ import annotations

import json
import sys
import time
from typing import Any, Callable

try:
    import boto3
except ModuleNotFoundError:  # Allows credentialless unit tests.
    boto3 = None

REGION = "ca-central-1"
INSTANCE_NAME = "quizforge-production-lightsail-server"
STATIC_IP_NAME = "quizforge-production-lightsail"
EXPECTED_BLUEPRINT = "ubuntu_24_04"
EXPECTED_BUNDLE = "small_3_0"
TERMINAL_STATES = {"terminated", "shutting-down"}


def verify_target(client: Any) -> str:
    instance = client.get_instance(instanceName=INSTANCE_NAME).get("instance", {})
    static = client.get_static_ip(staticIpName=STATIC_IP_NAME).get("staticIp", {})
    if (
        instance.get("name") != INSTANCE_NAME
        or instance.get("blueprintId") != EXPECTED_BLUEPRINT
        or instance.get("bundleId") != EXPECTED_BUNDLE
        or instance.get("isStaticIp") is not True
        or static.get("name") != STATIC_IP_NAME
        or static.get("attachedTo") != INSTANCE_NAME
    ):
        raise ValueError("Production Lightsail target contract mismatch")
    state = instance.get("state", {}).get("name")
    if not isinstance(state, str):
        raise ValueError("Lightsail instance state unavailable")
    return state


def operate(
    client: Any,
    operation: str,
    *,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
    timeout_seconds: int = 900,
) -> dict[str, Any]:
    if operation not in {"start", "stop"}:
        raise ValueError("Operation must be start or stop")

    previous = verify_target(client)
    target = "running" if operation == "start" else "stopped"
    if previous == target:
        return {
            "operation": operation,
            "previous_state": previous,
            "final_state": previous,
            "changed": False,
        }

    allowed = {"stopped"} if operation == "start" else {"running"}
    if previous not in allowed:
        raise ValueError(f"Cannot {operation} instance from state {previous}")

    if operation == "start":
        client.start_instance(instanceName=INSTANCE_NAME)
    else:
        client.stop_instance(instanceName=INSTANCE_NAME)

    deadline = monotonic() + timeout_seconds
    while monotonic() < deadline:
        state = verify_target(client)
        if state == target:
            return {
                "operation": operation,
                "previous_state": previous,
                "final_state": state,
                "changed": True,
            }
        if state in TERMINAL_STATES:
            raise ValueError(f"Lightsail instance entered state {state}")
        sleep(10)

    raise TimeoutError(f"Lightsail instance did not reach {target} state")


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or args[0] not in {"start", "stop"}:
        print("Usage: manual_instance_control.py start|stop", file=sys.stderr)
        return 2
    if boto3 is None:
        print("AWS SDK missing", file=sys.stderr)
        return 1
    try:
        result = operate(boto3.client("lightsail", region_name=REGION), args[0])
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({"result": "failed", "error_type": type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
