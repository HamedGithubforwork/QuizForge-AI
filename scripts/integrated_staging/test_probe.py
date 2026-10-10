"""Regression: generation quota identity is independent of the history UUID."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest

from redis import Redis

# The probe image copies this module under the same name.
spec = importlib.util.spec_from_file_location(
    "probe_fixtures", Path(__file__).resolve().parents[1] / "rds_rehearsal" / "probe.py")
fixtures = importlib.util.module_from_spec(spec)
sys.modules["probe_fixtures"] = fixtures
spec.loader.exec_module(fixtures)
from probe import verify_cache


@unittest.skipUnless(os.getenv("INTEGRATED_TEST_REDIS_URL"), "Requires disposable CI Valkey")
class CognitoRateIdentity(unittest.TestCase):
    def setUp(self):
        url = os.environ["INTEGRATED_TEST_REDIS_URL"]
        assert url == "redis://127.0.0.1:6379/15", "Only the disposable CI cache is allowed"
        self.cache = Redis.from_url(url, decode_responses=True)
        self.cache.flushdb()
        self.bundle = {
            "pool": "ca-central-1_ProbeTest",
            "users": {"mapped": {"subject": "11111111-1111-4111-8111-111111111111"}},
            "pdf": base64.b64encode(b"synthetic cache contract").decode(),
        }
        sha = hashlib.sha256(base64.b64decode(self.bundle["pdf"])).hexdigest()
        document = "quizforge:document-cache:synthetic"
        self.cache.set(document, json.dumps({"pdf_sha256": sha, "pages": [{}]}), ex=86400)
        self.cache.set(document + ":source-page:1", "Evaporation is the synthetic source.", ex=86400)
        self.cache.set(document + ":source-pages", json.dumps({"page_numbers": [1]}), ex=86400)
        self.cache.set("quizforge:quiz-cache:synthetic", json.dumps({
            "questions": [{"question_type": "multiple_choice", "source_pages": [1]} for _ in range(5)]
        }), ex=3600)
        metrics = {"quiz_cache_hits_total": 1, "quiz_cache_misses_total": 9,
                   "quiz_requests_total": 10, "document_cache_hits_total": 2,
                   "document_cache_misses_total": 1}
        for name, value in metrics.items():
            self.cache.set("quizforge:metrics:" + name, value)
        self.cache.set("integration:openai:calls", 1)
        self.cache.set("integration:openai:remaining", 1)
        self.cache.lpush("quizforge:metrics:timing:openai_generation_latency_ms", 1)
        # Exact identity format returned by the reviewed application's Cognito auth.
        self.rate = "quizforge:rate:cognito:ca-central-1_ProbeTest:11111111-1111-4111-8111-111111111111"
        self.cache.set(self.rate, 11, ex=600)

    def tearDown(self):
        self.cache.flushdb()
        self.cache.close()

    def test_cognito_rate_key_passes_complete_cache_verification(self):
        verify_cache(self.cache, self.bundle)

    def test_history_uuid_cannot_substitute_for_cognito_rate_key(self):
        self.cache.delete(self.rate)
        self.cache.set("quizforge:rate:00000000-0000-0000-0000-000000000003", 11, ex=600)
        with self.assertRaises(AssertionError):
            verify_cache(self.cache, self.bundle)

    def test_another_cognito_pool_cannot_satisfy_the_rate_check(self):
        self.cache.delete(self.rate)
        self.cache.set(self.rate.replace("_ProbeTest:", "_OtherPool:"), 11, ex=600)
        with self.assertRaises(AssertionError):
            verify_cache(self.cache, self.bundle)

    def test_rate_counter_without_expiry_is_rejected(self):
        self.cache.persist(self.rate)
        with self.assertRaises(AssertionError):
            verify_cache(self.cache, self.bundle)


if __name__ == "__main__":
    unittest.main()
