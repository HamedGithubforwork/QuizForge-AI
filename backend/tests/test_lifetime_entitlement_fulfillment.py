import pytest

from lifetime_entitlement_fulfillment import (
    LifetimeAdFreeRecord,
    NormalizedPurchaseEvent,
    PurchaseSource,
    decide_lifetime_ad_free_fulfillment,
)


USER_ID = "cognito:pool:user-1"
SOURCE_1 = PurchaseSource(
    provider="provider-a",
    transaction_id="transaction-1",
)
SOURCE_2 = PurchaseSource(
    provider="provider-a",
    transaction_id="transaction-2",
)


def free_record():
    return LifetimeAdFreeRecord(
        user_id=USER_ID,
    )


def record_with(*sources):
    return LifetimeAdFreeRecord(
        user_id=USER_ID,
        active_sources=frozenset(sources),
    )


def event(
    *,
    kind="completed",
    provider="provider-a",
    event_id="event-1",
    transaction_id="transaction-1",
    user_id=USER_ID,
):
    return NormalizedPurchaseEvent(
        provider=provider,
        event_id=event_id,
        transaction_id=transaction_id,
        user_id=user_id,
        kind=kind,
    )


def test_completed_purchase_grants_lifetime_ad_free():
    decision = decide_lifetime_ad_free_fulfillment(
        free_record(),
        event(),
        event_already_processed=False,
    )

    assert decision.action == "grant"
    assert decision.mark_event_processed is True
    assert decision.reason == "purchase_completed"
    assert decision.next_record == record_with(
        SOURCE_1
    )
    assert decision.next_record.entitled is True


def test_duplicate_provider_event_is_strict_idempotent_noop():
    record = record_with(
        SOURCE_1
    )

    decision = decide_lifetime_ad_free_fulfillment(
        record,
        event(),
        event_already_processed=True,
    )

    assert decision.action == "noop"
    assert decision.next_record is record
    assert decision.mark_event_processed is False
    assert decision.reason == "duplicate_event"


def test_repeated_completed_transaction_is_safe_retain():
    record = record_with(
        SOURCE_1
    )

    decision = decide_lifetime_ad_free_fulfillment(
        record,
        event(
            event_id="event-2",
        ),
        event_already_processed=False,
    )

    assert decision.action == "retain"
    assert decision.next_record is record
    assert decision.mark_event_processed is True
    assert decision.reason == "source_already_active"


def test_second_completed_transaction_is_recorded_without_double_grant():
    record = record_with(
        SOURCE_1
    )

    decision = decide_lifetime_ad_free_fulfillment(
        record,
        event(
            event_id="event-2",
            transaction_id="transaction-2",
        ),
        event_already_processed=False,
    )

    assert decision.action == "retain"
    assert decision.reason == "additional_purchase"
    assert decision.next_record == record_with(
        SOURCE_1,
        SOURCE_2,
    )
    assert decision.next_record.entitled is True


@pytest.mark.parametrize(
    ("kind", "reason"),
    [
        ("refunded", "purchase_refunded"),
        ("reversed", "purchase_reversed"),
    ],
)
def test_last_active_source_refund_or_reversal_revokes_entitlement(
    kind,
    reason,
):
    decision = decide_lifetime_ad_free_fulfillment(
        record_with(
            SOURCE_1
        ),
        event(
            kind=kind,
            event_id=f"{kind}-event",
        ),
        event_already_processed=False,
    )

    assert decision.action == "revoke"
    assert decision.mark_event_processed is True
    assert decision.reason == reason
    assert decision.next_record == free_record()
    assert decision.next_record.entitled is False


@pytest.mark.parametrize(
    (
        "kind",
        "reason",
    ),
    [
        (
            "refunded",
            "purchase_refunded_entitlement_retained",
        ),
        (
            "reversed",
            "purchase_reversed_entitlement_retained",
        ),
    ],
)
def test_one_refund_cannot_remove_entitlement_backed_by_another_active_purchase(
    kind,
    reason,
):
    decision = decide_lifetime_ad_free_fulfillment(
        record_with(
            SOURCE_1,
            SOURCE_2,
        ),
        event(
            kind=kind,
            event_id=f"{kind}-event",
        ),
        event_already_processed=False,
    )

    assert decision.action == "retain"
    assert decision.reason == reason
    assert decision.next_record == record_with(
        SOURCE_2
    )
    assert decision.next_record.entitled is True


@pytest.mark.parametrize(
    (
        "provider",
        "transaction_id",
    ),
    [
        (
            "provider-b",
            "transaction-1",
        ),
        (
            "provider-a",
            "transaction-2",
        ),
    ],
)
def test_unrelated_refund_cannot_revoke_current_entitlement(
    provider,
    transaction_id,
):
    record = record_with(
        SOURCE_1
    )

    decision = decide_lifetime_ad_free_fulfillment(
        record,
        event(
            kind="refunded",
            provider=provider,
            event_id="refund-2",
            transaction_id=transaction_id,
        ),
        event_already_processed=False,
    )

    assert decision.action == "retain"
    assert decision.next_record is record
    assert decision.mark_event_processed is True
    assert decision.reason == "source_not_active"


def test_refund_for_free_account_is_safe_retain():
    record = free_record()

    decision = decide_lifetime_ad_free_fulfillment(
        record,
        event(
            kind="refunded",
            event_id="refund-1",
        ),
        event_already_processed=False,
    )

    assert decision.action == "retain"
    assert decision.next_record is record
    assert decision.reason == "source_not_active"


def test_cross_account_event_is_rejected():
    with pytest.raises(
        ValueError,
        match="record owner",
    ):
        decide_lifetime_ad_free_fulfillment(
            free_record(),
            event(
                user_id="cognito:pool:user-2",
            ),
            event_already_processed=False,
        )


@pytest.mark.parametrize(
    (
        "record",
        "purchase_event",
        "message",
    ),
    [
        (
            LifetimeAdFreeRecord(
                user_id="",
            ),
            event(),
            "record user_id",
        ),
        (
            free_record(),
            event(
                provider="  ",
            ),
            "event provider",
        ),
        (
            free_record(),
            event(
                event_id="",
            ),
            "event_id",
        ),
        (
            free_record(),
            event(
                transaction_id=" ",
            ),
            "transaction_id",
        ),
        (
            LifetimeAdFreeRecord(
                user_id=USER_ID,
                active_sources=frozenset({
                    PurchaseSource(
                        provider=" provider-a",
                        transaction_id="transaction-1",
                    )
                }),
            ),
            event(),
            "source provider",
        ),
    ],
)
def test_malformed_fulfillment_state_fails_closed(
    record,
    purchase_event,
    message,
):
    with pytest.raises(
        ValueError,
        match=message,
    ):
        decide_lifetime_ad_free_fulfillment(
            record,
            purchase_event,
            event_already_processed=False,
        )


def test_unsupported_event_kind_fails_closed():
    malformed = NormalizedPurchaseEvent(
        provider="provider-a",
        event_id="event-unsupported",
        transaction_id="transaction-1",
        user_id=USER_ID,
        kind="chargeback",  # type: ignore[arg-type]
    )

    with pytest.raises(
        ValueError,
        match="Unsupported",
    ):
        decide_lifetime_ad_free_fulfillment(
            free_record(),
            malformed,
            event_already_processed=False,
        )
