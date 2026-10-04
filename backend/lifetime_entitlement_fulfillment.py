from dataclasses import dataclass
from typing import Literal


PurchaseEventKind = Literal[
    "completed",
    "refunded",
    "reversed",
]

FulfillmentAction = Literal[
    "grant",
    "revoke",
    "noop",
]


@dataclass(frozen=True)
class LifetimeAdFreeRecord:
    user_id: str
    entitled: bool
    source_provider: str | None = None
    source_transaction_id: str | None = None


@dataclass(frozen=True)
class NormalizedPurchaseEvent:
    provider: str
    event_id: str
    transaction_id: str
    user_id: str
    kind: PurchaseEventKind


@dataclass(frozen=True)
class FulfillmentDecision:
    action: FulfillmentAction
    next_record: LifetimeAdFreeRecord
    mark_event_processed: bool
    reason: str


def _require_identifier(
    value: str,
    label: str,
) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(
            f"{label} must not be empty."
        )
    return normalized


def _validate_record(
    record: LifetimeAdFreeRecord,
) -> None:
    _require_identifier(
        record.user_id,
        "record user_id",
    )

    has_source = (
        record.source_provider is not None
        or record.source_transaction_id is not None
    )

    if record.entitled:
        if (
            not record.source_provider
            or not record.source_transaction_id
        ):
            raise ValueError(
                "An entitled record requires a source provider "
                "and transaction."
            )
        return

    if has_source:
        raise ValueError(
            "A non-entitled record must not retain a source "
            "provider or transaction."
        )


def decide_lifetime_ad_free_fulfillment(
    record: LifetimeAdFreeRecord,
    event: NormalizedPurchaseEvent,
    *,
    event_already_processed: bool,
) -> FulfillmentDecision:
    _validate_record(record)

    provider = _require_identifier(
        event.provider,
        "event provider",
    )
    _require_identifier(
        event.event_id,
        "event_id",
    )
    transaction_id = _require_identifier(
        event.transaction_id,
        "transaction_id",
    )
    event_user_id = _require_identifier(
        event.user_id,
        "event user_id",
    )

    if event_user_id != record.user_id:
        raise ValueError(
            "Purchase event user does not match the entitlement "
            "record owner."
        )

    if event_already_processed:
        return FulfillmentDecision(
            action="noop",
            next_record=record,
            mark_event_processed=False,
            reason="duplicate_event",
        )

    if event.kind == "completed":
        if record.entitled:
            same_source = (
                record.source_provider == provider
                and record.source_transaction_id
                == transaction_id
            )
            return FulfillmentDecision(
                action="noop",
                next_record=record,
                mark_event_processed=True,
                reason=(
                    "already_entitled_same_transaction"
                    if same_source
                    else "already_entitled"
                ),
            )

        return FulfillmentDecision(
            action="grant",
            next_record=LifetimeAdFreeRecord(
                user_id=record.user_id,
                entitled=True,
                source_provider=provider,
                source_transaction_id=transaction_id,
            ),
            mark_event_processed=True,
            reason="purchase_completed",
        )

    if event.kind in {
        "refunded",
        "reversed",
    }:
        if not record.entitled:
            return FulfillmentDecision(
                action="noop",
                next_record=record,
                mark_event_processed=True,
                reason="not_entitled",
            )

        matching_source = (
            record.source_provider == provider
            and record.source_transaction_id
            == transaction_id
        )

        if not matching_source:
            return FulfillmentDecision(
                action="noop",
                next_record=record,
                mark_event_processed=True,
                reason="unrelated_transaction",
            )

        return FulfillmentDecision(
            action="revoke",
            next_record=LifetimeAdFreeRecord(
                user_id=record.user_id,
                entitled=False,
            ),
            mark_event_processed=True,
            reason=(
                "purchase_refunded"
                if event.kind == "refunded"
                else "purchase_reversed"
            ),
        )

    raise ValueError(
        "Unsupported purchase event kind."
    )
