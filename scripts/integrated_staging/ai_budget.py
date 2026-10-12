"""Operator-controlled staging-only AI allowance status/refill.

Uses the existing disposable probe task and its private Valkey network access.
Never provisions a service, rebuilds an image, touches production or Terraform,
or prints documents/keys/tokens. No application task or infrastructure is replaced.
"""
import os
from pathlib import Path
import re
import sys
import time

import control
import fast_frontend
from guards import NAME

ALLOWED = frozenset(("status", "refill"))
STAGING_CAP = 10
RESULT = re.compile(
    r"^STAGING_AI_BUDGET remaining=(\d+) total_calls=(\d+) allowance=10$"
)
TASK_FAMILY = re.compile(
    r"^arn:aws:ecs:ca-central-1:[0-9]{12}:task-definition:"
    + re.escape(NAME) + r"-probe:[0-9]+$"
)

# The existing probe image already has Python and redis-py installed; a fixed
# script allows an in-place refill without rebuilding or recreating staging.
# Arguments come from the workflow's two-value allowlist, never user input.
# All checks and the SET execute atomically inside private Redis.
SCRIPT = r"""
import os
import sys
from redis import Redis

try:
    if len(sys.argv) != 2 or sys.argv[1] not in ("status", "refill"):
        raise ValueError("Invalid staging allowance action")
    url = os.environ["REDIS_URL"]
    if not url.startswith("rediss://"):
        raise ValueError("Staging cache must use TLS")
    cache = Redis.from_url(url, socket_connect_timeout=5, socket_timeout=5)
    result = cache.eval('''
local raw = redis.call('GET', KEYS[1])
local calls = redis.call('GET', KEYS[2]) or '0'
local remaining = tonumber(raw)
local used = tonumber(calls)
if not remaining or not used or remaining < 0 or remaining > 10
    or remaining ~= math.floor(remaining) or used < 0
    or used ~= math.floor(used) or redis.call('TTL', KEYS[1]) ~= -1 then
    return {-1, -1}
end
if ARGV[1] == 'refill' then
    redis.call('SET', KEYS[1], 10)
    remaining = 10
end
return {remaining, used}
''', 2, "integration:openai:remaining", "integration:openai:calls", sys.argv[1])
    cache.close()
    if not isinstance(result, list) or len(result) != 2 or result[0] < 0:
        raise ValueError("Invalid private staging budget state")
    print("STAGING_AI_BUDGET remaining=%d total_calls=%d allowance=10" %
          (result[0], result[1]), flush=True)
except Exception:
    print("STAGING_AI_BUDGET_ERROR=refused", flush=True)
    sys.exit(1)
"""


def require_trusted_manual_action(action, environ=None):
    env = environ if environ is not None else os.environ
    if (action not in ALLOWED or env.get("STAGING_AI_BUDGET_ACTION") != action
            or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or env.get("GITHUB_REF") != "refs/heads/main"
            or env.get("GITHUB_REPOSITORY") != "HamedGithubforwork/QuizForge-AI"):
        raise ValueError("Only a trusted manually dispatched staging action is allowed")


def command_for(action):
    if action not in ALLOWED:
        raise ValueError("Unknown staging budget action")
    return ["python", "-c", SCRIPT, action]


def parse_status(events):
    matches = []
    for event in events:
        message = event.get("message", "")
        m = RESULT.fullmatch(message.rstrip("\r\n"))
        if m:
            matches.append((int(m.group(1)), int(m.group(2))))
    if len(matches) != 1 or not 0 <= matches[0][0] <= STAGING_CAP:
        raise ValueError("Missing or invalid staging budget receipt")
    return matches[0]


def run(action):
    require_trusted_manual_action(action)
    # Verify the existing Terraform state, CloudFront, Cognito, RDS, TLS,
    # app services, cache and security boundaries BEFORE requesting a task.
    values, _ = fast_frontend.live()
    if not TASK_FAMILY.fullmatch(values["probe_task"]):
        raise ValueError("Unexpected staging probe task definition")
    ecs = control.client("ecs")
    response = ecs.run_task(
        cluster=values["cluster"],
        taskDefinition=values["probe_task"],
        launchType="FARGATE",
        startedBy=NAME,
        count=1,
        networkConfiguration={"awsvpcConfiguration": {
            "subnets": values["subnets"],
            "securityGroups": [values["security_group"]],
            "assignPublicIp": "ENABLED",
        }},
        overrides={"containerOverrides": [
            {"name": "probe", "command": command_for(action)}
        ]},
    )
    if response.get("failures") or len(response.get("tasks", [])) != 1:
        raise ValueError("Staging budget task was not started")
    arn = response["tasks"][0]["taskArn"]
    if not re.fullmatch(
        r"arn:aws:ecs:ca-central-1:[0-9]{12}:task/"
        r"(?:[a-zA-Z0-9_-]+/)?[a-f0-9]{32}", arn
    ):
        raise ValueError("Unexpected staging task ARN")
    try:
        stopped = False
        for _ in range(84):
            tasks = ecs.describe_tasks(
                cluster=values["cluster"], tasks=[arn]
            ).get("tasks", [])
            if len(tasks) != 1 or not control.owned_task(tasks[0]):
                raise ValueError("Unexpected staging task ownership")
            if tasks[0]["lastStatus"] == "STOPPED":
                stopped = True
                if tasks[0]["containers"][0].get("exitCode") != 0:
                    raise ValueError("Staging budget task failed")
                break
            time.sleep(5)
        if not stopped:
            raise ValueError("Staging budget task timed out")
        stream = "integration/probe/" + arn.rsplit("/", 1)[-1]
        for _ in range(12):
            try:
                events = control.client("logs").get_log_events(
                    logGroupName=values["log_group"],
                    logStreamName=stream,
                    startFromHead=True,
                )["events"]
                remaining, used = parse_status(events)
                break
            except (control.client("logs").exceptions.ResourceNotFoundException,
                    ValueError):
                time.sleep(3)
        else:
            raise ValueError("Staging budget receipt not available")
    finally:
        # Best-effort cleanup of the single disposable inspection task.
        # Never change running ECS services.
        try:
            ecs.stop_task(cluster=values["cluster"], task=arn,
                          reason="Staging AI budget operation completed")
        except Exception:
            pass

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a", encoding="utf-8") as out:
            out.write(
                "## Staging AI generation allowance\n\n"
                f"**Action:** {action}\n\n"
                f"**Requests remaining:** {remaining} / {STAGING_CAP}\n\n"
                f"**Total upstream attempts (including before refills):** {used}\n\n"
                "Only the existing staging Valkey counter was read/updated. "
                "No production resources or staging services changed.\n"
            )
    print(
        f"PASS: staging AI allowance {action}: "
        f"remaining={remaining}/{STAGING_CAP}; total_calls={used}",
        flush=True,
    )


if __name__ == "__main__":
    try:
        run(sys.argv[1])
    except Exception:
        # Never print cloud exception messages, Redis URLs, or secrets.
        print("Staging AI budget operation refused safely", flush=True)
        raise SystemExit(1)
