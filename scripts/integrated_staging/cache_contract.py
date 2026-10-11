"""Reviewed staging cache policy and a credentialless real-backend contract check."""
import asyncio
import json
import os
from pathlib import Path
import sys
from uuid import uuid4


QUIZ_CACHE_TTL_SECONDS = 86400
DISPOSABLE_REDIS_URL = "redis://127.0.0.1:6379/15"


def verify_quiz_ttl(cache, key):
    ttl = cache.ttl(key)
    if not 0 < ttl <= QUIZ_CACHE_TTL_SECONDS:
        # Numeric lifetime only: never expose cache keys, quiz contents or tokens.
        message = f"quiz cache TTL invalid: observed_seconds={ttl}, maximum_seconds={QUIZ_CACHE_TTL_SECONDS}"
        print("ERROR: " + message)
        raise AssertionError(message)
    return ttl


async def check_backend_writer():
    """Run inside the exact API image before AWS authentication/provisioning."""
    if os.environ.get("INTEGRATED_TEST_REDIS_URL") != DISPOSABLE_REDIS_URL:
        raise ValueError("Only the disposable CI cache is allowed")
    # The trusted script is mounted separately; /app is the selected API image.
    sys.path.insert(0, str(Path.cwd()))
    import redis_integration as backend
    from redis import Redis
    from redis.asyncio import Redis as AsyncRedis

    assert backend.QUIZ_CACHE_TTL_SECONDS == QUIZ_CACHE_TTL_SECONDS, "Backend and staging quiz TTL policies differ"
    payload = json.dumps({"questions": [{"question_type": "multiple_choice", "source_pages": [1]} for _ in range(5)]})

    class SyntheticQuiz:
        def model_dump_json(self):
            return payload

    key = "integration:cache-contract:" + uuid4().hex
    cache = Redis.from_url(DISPOSABLE_REDIS_URL, decode_responses=True)
    writer = AsyncRedis.from_url(DISPOSABLE_REDIS_URL)
    try:
        await backend.cache_quiz(key, SyntheticQuiz(), client=writer)
        assert cache.get(key) == payload, "Backend quiz cache write did not persist the payload"
        ttl = verify_quiz_ttl(cache, key)
        assert ttl >= QUIZ_CACHE_TTL_SECONDS - 10, "Backend cache write used an unexpected lifetime"
        print(f"PASS: selected backend cache writer and staging verifier agree; quiz TTL={ttl} seconds")
    finally:
        try:
            cache.delete(key)
        finally:
            cache.close()
            await writer.aclose()


if __name__ == "__main__":
    asyncio.run(check_backend_writer())
