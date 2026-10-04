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
    "retain",
    "noop",
]


@dataclass(frozen=True)
class PurchaseSource:
    provider: str
    transaction_id: str


@dataclass(frozen=True)
class LifetimeAdFreeRecord:
    user_id: str
    active_sources: frozenset[PurchaseSource] = frozenset()

    @property
    def entitled(self) -> bool:
        return bool(self.active_sources)


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
    if normalized != value:
        raise ValueError(
            f"{label} must already be normalized."
        )
    return normalized


def _validate_record(
    record: LifetimeAdFreeRecord,
) -> None:
    _require_identifier(
        record.user_id,
        "record user_id",
    )

    for source in record.active_sources:
        _require_identifier(
            source.provider,
            "source provider",
        )
        _require_identifier(
            source.transaction_id,
            "source transaction_id",
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

    source = PurchaseSource(
        provider=provider,
        transaction_id=transaction_id,
    )

    if event.kind == "completed":
        if source in record.active_sources:
            return FulfillmentDecision(
                action="retain",
                next_record=record,
                mark_event_processed=True,
                reason="source_already_active",
            )

        next_record = LifetimeAdFreeRecord(
            user_id=record.user_id,
            active_sources=(
                record.active_sources
                | frozenset({source})
            ),
        )

        return FulfillmentDecision(
            action=(
                "retain"
                if record.entitled
                else "grant"
            ),
            next_record=next_record,
            mark_event_processed=True,
            reason=(
                "additional_purchase"
                if record.entitled
                else "purchase_completed"
            ),
        )

    if event.kind in {
        "refunded",
        "reversed",
    }:
        if source not in record.active_sources:
            return FulfillmentDecision(
                action="retain",
                next_record=record,
                mark_event_processed=True,
                reason="source_not_active",
            )

        next_record = LifetimeAdFreeRecord(
            user_id=record.user_id,
            active_sources=(
                record.active_sources
                - frozenset({source})
            ),
        )

        if next_record.entitled:
            return FulfillmentDecision(
                action="retain",
                next_record=next_record,
                mark_event_processed=True,
                reason=(
                    "purchase_refunded_entitlement_retained"
                    if event.kind == "refunded"
                    else "purchase_reversed_entitlement_retained"
                ),
            )

        return FulfillmentDecision(
            action="revoke",
            next_record=next_record,
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
