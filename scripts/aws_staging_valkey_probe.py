"""Runs inside an isolated Fargate task with the staging application's image.

No FLUSHDB, credential overrides, test doubles, or changes to live limits.
All synthetic lock/rate-limit keys are unique and removed in finally.
"""

import asyncio
import hashlib
import json
import os

from fastapi import HTTPException
from redis.asyncio import Redis

import redis_integration as integration
from quiz_service import Quiz
from source_page_cache import build_source_page_key, build_source_page_manifest_key


async def main():
    context = json.loads(os.environ["STAGING_PROBE_CONTEXT"])
    url = os.environ["REDIS_URL"]
    assert url.startswith("rediss://") and ".cache.amazonaws.com:" in url
    clients = [Redis.from_url(url, decode_responses=True, socket_connect_timeout=5,
                              socket_timeout=5) for _ in range(2)]
    first, second = clients
    cleanup = []
    try:
        assert await first.ping() is True
        user_id = context["user_id"]
        document_key = integration.build_document_cache_key_from_sha(
            user_id=user_id, pdf_sha256=context["pdf_sha256"])
        document = await integration.get_cached_document(document_key, client=first)
        assert document and document["pdf_sha256"] == context["pdf_sha256"]
        assert len(document["pages"]) == 1 and "Evaporation" in document["pages"][0]["text"]
        assert 0 < await second.ttl(document_key) <= integration.DOCUMENT_CACHE_TTL_SECONDS
        page_key = build_source_page_key(document_key, 1)
        assert "Evaporation" in (await second.get(page_key))
        assert 0 < await second.ttl(page_key) <= integration.DOCUMENT_CACHE_TTL_SECONDS
        manifest = json.loads(await second.get(build_source_page_manifest_key(document_key)))
        assert manifest["page_numbers"] == [1]
        quiz_key = integration.build_quiz_cache_key_from_sha(
            user_id=user_id, pdf_sha256=context["pdf_sha256"], question_count=5,
            difficulty="easy", question_type="multiple_choice", focus_pages="",
            focus_question_types="", avoid_questions="[]", content_type="application/pdf")
        quiz = await integration.get_cached_quiz(quiz_key, Quiz, client=second)
        assert quiz is not None
        digest = hashlib.sha256(json.dumps(quiz.model_dump(), sort_keys=True).encode()).hexdigest()
        assert digest == context["quiz_digest"]
        assert 0 < await second.ttl(quiz_key) <= integration.QUIZ_CACHE_TTL_SECONDS
        assert await first.get(f"quizforge:rate:{user_id}") == "11"
        assert await first.get(f"quizforge:rate:answer-review:{user_id}") == "1"
        print("PASS: application-created document, source-page and quiz caches are persisted in private Valkey")

        for metric, minimum in {"document_cache_hits_total": 1, "document_cache_misses_total": 1,
                                "quiz_cache_hits_total": 1, "quiz_cache_misses_total": 9,
                                "quiz_requests_total": 10}.items():
            count = int(await first.get("quizforge:metrics:" + metric) or 0)
            assert count >= minimum, metric
            # Eight invalid-settings requests are recorded as misses by the
            # application's rejection handler; the eleventh, limited request
            # is rejected before that handler. Only the first valid request
            # generates, and the second valid request must be a cache hit.
            if metric.startswith("quiz_"):
                assert count == minimum, f"Unexpected workload accounting: {metric}"
        for metric in ("http_latency_ms", "auth_latency_ms", "pdf_extraction_latency_ms",
                       "openai_generation_latency_ms", "quiz_cache_lookup_latency_ms"):
            samples = await second.lrange("quizforge:metrics:timing:" + metric, 0, -1)
            assert samples and len(samples) <= 200, metric
        print("PASS: distributed metrics and bounded timing samples")

        # Distinct connections share each limit. Local fallback would fail the
        # explicit Valkey counter assertion, even if it happened to return 429.
        for suffix, enforce, limit, window, prefix in (
            ("quiz", integration.enforce_quiz_rate_limit, integration.QUIZ_RATE_LIMIT,
             integration.QUIZ_RATE_WINDOW_SECONDS, "quizforge:rate:"),
            ("review", integration.enforce_answer_review_rate_limit, integration.ANSWER_REVIEW_RATE_LIMIT,
             integration.ANSWER_REVIEW_RATE_WINDOW_SECONDS, "quizforge:rate:answer-review:"),
        ):
            test_user = f"staging-{context['run_id']}-{suffix}"
            key = prefix + test_user
            cleanup.append(key)
            for number in range(limit):
                await enforce(test_user, client=clients[number % 2])
            try:
                await enforce(test_user, client=second)
            except HTTPException as error:
                assert error.status_code == 429
                assert 1 <= int(error.headers["Retry-After"]) <= window
            else:
                raise AssertionError("Distributed rate limit did not reject request")
            assert int(await first.get(key)) == limit + 1
            assert 0 < await first.ttl(key) <= window
        print("PASS: quiz and answer-review rate limits shared across independent connections")

        test_cache = "quizforge:quiz-cache:staging-lock-" + context["run_id"]
        lock_key = integration.build_quiz_generation_lock_key(test_cache)
        cleanup.append(lock_key)
        attempts = await asyncio.gather(*[
            integration.try_acquire_quiz_generation_lock(test_cache, client=clients[index % 2])
            for index in range(8)
        ])
        assert all(attempt.backend_available for attempt in attempts)
        owners = [attempt for attempt in attempts if attempt.acquired]
        assert len(owners) == 1
        token = owners[0].token
        assert await second.get(lock_key) == token
        assert 0 < await second.ttl(lock_key) <= integration.QUIZ_GENERATION_LOCK_TTL_SECONDS
        assert not await integration.release_quiz_generation_lock(test_cache, "wrong-owner", client=second)
        assert await first.get(lock_key) == token
        assert await integration.release_quiz_generation_lock(test_cache, token, client=second)
        assert not await first.exists(lock_key)
        reacquired = await integration.try_acquire_quiz_generation_lock(test_cache, client=first)
        assert reacquired.backend_available and reacquired.acquired
        assert await integration.release_quiz_generation_lock(test_cache, reacquired.token, client=second)
        print("PASS: concurrent generation lock exclusion, TTL, owner-safe Lua release and reacquisition")
    finally:
        if cleanup:
            await first.delete(*cleanup)
        for client in clients:
            await client.aclose()


asyncio.run(main())
