"""No API key or network: exercise the real handler with a fake provider."""
import io
import json
from types import SimpleNamespace
from email.message import Message
import unittest
from unittest.mock import MagicMock, patch

import generation_costs as costs
import generation_guard as guard


def response(**updates):
    return {"model": costs.MODEL, "service_tier": "default", "status": "completed",
            "usage": {"input_tokens": 1000, "output_tokens": 200, "total_tokens": 1200}} | updates


class CostAccounting(unittest.TestCase):
    def test_reservation_covers_long_context_cache_writes_and_all_output(self):
        self.assertEqual(costs.maximum_cost(8192), 539745600)
        self.assertEqual(costs.accounted_cost(json.dumps(response()),8192),490000)
        usage={"input_tokens":300000,"output_tokens":8192,"total_tokens":308192}
        self.assertEqual(costs.accounted_cost(json.dumps(response(usage=usage)),8192),164745600)
        # Cache discounts are never assumed; hidden reasoning is in output_tokens.
        usage.update(output_tokens_details={"reasoning_tokens":8000},input_tokens_details={"cached_tokens":299000})
        self.assertEqual(costs.accounted_cost(json.dumps(response(usage=usage)),8192),164745600)

    def test_ambiguous_or_unbounded_usage_never_releases_money(self):
        invalid=[b"broken",b"[]",json.dumps(response(model="other")),json.dumps(response(service_tier="fast")),
                 json.dumps(response(status="failed")),json.dumps(response(usage=None))]
        for usage in ({}, {"input_tokens":True,"output_tokens":0,"total_tokens":1},
                      {"input_tokens":0,"output_tokens":0,"total_tokens":0},
                      {"input_tokens":1,"output_tokens":8193,"total_tokens":8194},
                      {"input_tokens":100,"output_tokens":200,"total_tokens":301},
                      {"input_tokens":1050001,"output_tokens":0,"total_tokens":1050001}):
            invalid.append(json.dumps(response(usage=usage)))
        for raw in invalid:
            with self.subTest(raw=raw): self.assertIsNone(costs.accounted_cost(raw,8192))

    def test_money_uses_exact_integers_with_no_budget_increase(self):
        self.assertEqual(costs.usd_nano(5),5000000000)
        self.assertEqual(costs.usd_nano(4.99),4990000000)
        for bad in (True,None,"5",5.01,-1,float("nan"),float("inf"),0.001):
            with self.subTest(bad=bad),self.assertRaises(ValueError): costs.usd_nano(bad)


class GatewayFlow(unittest.TestCase):
    def call(self, *, permitted=True, reserve_error=None, status=200, payload=None,
             provider_error=None, settlement_error=None):
        raw=json.dumps({"model":costs.MODEL,"input":[{"role":"user","content":"Synthetic notes"}]}).encode()
        handler=guard.Handler.__new__(guard.Handler)
        handler.path="/v1/responses"
        handler.headers=Message()
        handler.headers["Authorization"]="Bearer production-budget-guard"
        handler.headers["Content-Length"]=str(len(raw))
        handler.rfile=io.BytesIO(raw)
        handler.connection=MagicMock()
        handler.server=SimpleNamespace(slots=MagicMock(),database={"synthetic":True})
        handler.server.slots.acquire.return_value=True
        handler.reply=MagicMock()
        with patch.object(guard,"reserve",return_value=permitted,side_effect=reserve_error) as reserve, \
             patch.object(guard,"settle",return_value=True,side_effect=settlement_error) as settle, \
             patch.object(guard,"HTTPSConnection") as upstream, \
             patch.dict(guard.os.environ,{"OPENAI_API_KEY":"synthetic-not-a-key"}):
            upstream.return_value.getresponse.side_effect=provider_error
            upstream.return_value.getresponse.return_value.status=status
            upstream.return_value.getresponse.return_value.read.return_value=(
                json.dumps(response()).encode() if payload is None else payload)
            handler.do_POST()
        handler.server.slots.release.assert_called_once()
        return handler,reserve,settle,upstream

    def test_exhausted_budget_or_database_failure_never_contacts_provider(self):
        for error,expected in ((None,429),(OSError("database offline"),503)):
            handler,reserve,settle,upstream=self.call(permitted=False,reserve_error=error)
            self.assertEqual(handler.reply.call_args.args[0],expected)
            upstream.assert_not_called()
            settle.assert_not_called()

    def test_valid_response_settles_same_durable_attempt_and_forces_standard_tier(self):
        handler,reserve,settle,upstream=self.call()
        self.assertEqual(handler.reply.call_args.args[0],200)
        self.assertEqual(reserve.call_args.args[2],539745600)
        self.assertEqual(settle.call_args.args,(handler.server.database,reserve.call_args.args[1],490000))
        sent=json.loads(upstream.return_value.request.call_args.kwargs["body"])
        self.assertEqual(sent["service_tier"],"default")
        self.assertEqual(sent["max_output_tokens"],8192)

    def test_timeout_error_malformed_or_missing_usage_retains_full_reservation(self):
        for args in ({"provider_error":TimeoutError()}, {"status":500}, {"payload":b'{}'},
                     {"payload":b'invalid'}, {"payload":json.dumps(response(usage=None)).encode()}):
            handler,reserve,settle,upstream=self.call(**args)
            reserve.assert_called_once()
            upstream.assert_called_once()
            settle.assert_not_called()

    def test_settlement_database_failure_and_client_retry_never_reuse_a_reservation(self):
        first,reserve1,settle1,_=self.call(settlement_error=OSError("database offline"))
        second,reserve2,_,_=self.call()
        self.assertEqual(first.reply.call_args.args[0],503)
        self.assertEqual(second.reply.call_args.args[0],200)
        self.assertNotEqual(reserve1.call_args.args[1],reserve2.call_args.args[1])


if __name__ == "__main__": unittest.main()
