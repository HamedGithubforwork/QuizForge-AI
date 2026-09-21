"""Conservative standard-tier model costs, in integer nano-USD (1 USD = 1e9).

Reviewed 2026-09-21 against the official model/pricing pages; see the cost-control
runbook. Reserve the entire documented context window: no tokenizer heuristic
or extra remote token-count call can under-reserve input/schema/hidden overhead.
Settlement still uses the higher cache-write rate, even for uncached/cache-hit
tokens. This deliberately overcounts, rather than depending on cache discounts.
"""
from decimal import Decimal, InvalidOperation
import json

MODEL = "gpt-5.6-luna"
PRICING_KEY = "gpt-5.6-luna-standard-2026-09-21"
PRICING_VALID_UNTIL = "2026-10-21"
CONTEXT_TOKENS = 1_050_000
LONG_CONTEXT_THRESHOLD = 272_000
MAX_OUTPUT_TOKENS = 8192
NANO_USD = 1_000_000_000
APPROVED_MONTHLY_NANO_USD = 5 * NANO_USD


def usd_nano(value):
    if type(value) not in (int, float):
        raise ValueError("AI allowance must be a USD amount")
    try:
        dollars = Decimal(str(value))
        if (not dollars.is_finite() or not 0 <= dollars <= 5
                or dollars * 100 != (dollars * 100).to_integral_value()):
            raise ValueError("Choose whole cents within the approved USD5 allowance")
        return int(dollars * NANO_USD)
    except InvalidOperation as error:
        raise ValueError("Invalid USD allowance") from error


def maximum_cost(output_tokens):
    if type(output_tokens) is not int or not 1 <= output_tokens <= MAX_OUTPUT_TOKENS:
        raise ValueError("Invalid output token limit")
    # Long-context standard cache-write input: $0.50/M; output: $1.80/M.
    return CONTEXT_TOKENS * 500 + output_tokens * 1800


def accounted_cost(raw, output_limit):
    """Return a conservative cost only for complete, plausible provider usage.

    None means keep the full reservation (including errors or ambiguous replies).
    output_tokens includes reasoning; never count only visible output text.
    """
    try:
        response = json.loads(raw)
        if (response.get("model") != MODEL or response.get("service_tier") != "default"
                or response.get("status") not in ("completed", "incomplete")):
            return None
        usage = response["usage"]
        inp, out, total = (usage[k] for k in ("input_tokens", "output_tokens", "total_tokens"))
        if (any(type(v) is not int for v in (inp, out, total))
                or not 1 <= inp <= CONTEXT_TOKENS or not 0 <= out <= output_limit
                or total != inp + out or total > CONTEXT_TOKENS):
            return None
        input_rate, output_rate = (500, 1800) if inp > LONG_CONTEXT_THRESHOLD else (250, 1200)
        cost = inp * input_rate + out * output_rate
        return cost if cost <= maximum_cost(output_limit) else None
    except (KeyError, TypeError, AttributeError, ValueError):
        return None
