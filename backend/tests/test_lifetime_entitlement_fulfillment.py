import pytest

from lifetime_entitlement_fulfillment import (
    LifetimeAdFreeRecord,
    NormalizedPurchaseEvent,
    decide_lifetime_ad_free_fulfillment,
)


USER_ID = "cognito:pool:user-1"


def free_record():
    return LifetimeAdFreeRecord(
        user_id=USER_ID,
        entitled=False,
    )


def completed_event(
    *,
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
        kind="completed",
    )


def entitled_record():
    return LifetimeAdFreeRecord(
        user_id=USER_ID,
        entitled=True,
        source_provider="provider-a",
        source_transaction_id="transaction-1",
    )


def test_completed_purchase_grants_lifetime_ad_free():
    decision = decide_lifetime_ad_free_fulfillment(
        free_record(),
        completed_event(),
        event_already_processed=False,
    )

    assert decision.action == "grant"
    assert decision.mark_event_processed is True
    assert decision.reason == "purchase_completed"
    assert decision.next_record == LifetimeAdFreeRecord(
        user_id=USER_ID,
        entitled=True,
        source_provider="provider-a",
        source_transaction_id="transaction-1",
    )


def test_duplicate_event_is_idempotent():
    record = entitled_record()

    decision = decide_lifetime_ad_free_fulfillment(
        record,
        completed_event(),
        event_already_processed=True,
    )

    assert decision.action == "noop"
    assert decision.next_record is record
    assert decision.mark_event_processed is False
    assert decision.reason == "duplicate_event"


def test_repeated_completed_transaction_does_not_regrant():
    record = entitled_record()

    decision = decide_lifetime_ad_free_fulfillment(
        record,
        completed_event(
            event_id="event-2",
        ),
        event_already_processed=False,
    )

    assert decision.action == "noop"
    assert decision.next_record is record
    assert decision.mark_event_processed is True
    assert decision.reason == (
        "already_entitled_same_transaction"
    )


def test_second_transaction_does_not_replace_existing_ownership_source():
    record = entitled_record()

    decision = decide_lifetime_ad_free_fulfillment(
        record,
        completed_event(
            event_id="event-2",
            transaction_id="transaction-2",
        ),
        event_already_processed=False,
    )

    assert decision.action == "noop"
    assert decision.next_record is record
    assert decision.reason == "already_entitled"


@pytest.mark.parametrize(
    ("kind", "reason"),
    [
        ("refunded", "purchase_refunded"),
        ("reversed", "purchase_reversed"),
    ],
)
def test_matching_refund_or_reversal_revokes_entitlement(
    kind,
    reason,
):
    decision = decide_lifetime_ad_free_fulfillment(
        entitled_record(),
        NormalizedPurchaseEvent(
            provider="provider-a",
            event_id=f"{kind}-event",
            transaction_id="transaction-1",
            user_id=USER_ID,
            kind=kind,
        ),
        event_already_processed=False,
    )

    assert decision.action == "revoke"
    assert decision.mark_event_processed is True
    assert decision.reason == reason
    assert decision.next_record == free_record()


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
def test_unrelated_refund_cannot_revoke_another_purchase(
    provider,
    transaction_id,
):
    record = entitled_record()

    decision = decide_lifetime_ad_free_fulfillment(
        record,
        NormalizedPurchaseEvent(
            provider=provider,
            event_id="refund-2",
            transaction_id=transaction_id,
            user_id=USER_ID,
            kind="refunded",
        ),
        event_already_processed=False,
    )

    assert decision.action == "noop"
    assert decision.next_record is record
    assert decision.mark_event_processed is True
    assert decision.reason == "unrelated_transaction"


def test_refund_for_free_account_is_safe_noop():
    record = free_record()

    decision = decide_lifetime_ad_free_fulfillment(
        record,
        NormalizedPurchaseEvent(
            provider="provider-a",
            event_id="refund-1",
            transaction_id="transaction-1",
            user_id=USER_ID,
            kind="refunded",
        ),
        event_already_processed=False,
    )

    assert decision.action == "noop"
    assert decision.next_record is record
    assert decision.reason == "not_entitled"


def test_cross_account_event_is_rejected():
    with pytest.raises(
        ValueError,
        match="record owner",
    ):
        decide_lifetime_ad_free_fulfillment(
            free_record(),
            completed_event(
                user_id="cognito:pool:user-2",
            ),
            event_already_processed=False,
        )


@pytest.mark.parametrize(
    (
        "record",
        "event",
        "message",
    ),
    [
        (
            LifetimeAdFreeRecord(
                user_id="",
                entitled=False,
            ),
            completed_event(),
            "record user_id",
        ),
        (
            free_record(),
            completed_event(
                provider="  ",
            ),
            "event provider",
        ),
        (
            free_record(),
            completed_event(
                event_id="",
            ),
            "event_id",
        ),
        (
            free_record(),
            completed_event(
                transaction_id=" ",
            ),
            "transaction_id",
        ),
        (
            LifetimeAdFreeRecord(
                user_id=USER_ID,
                entitled=True,
            ),
            completed_event(),
            "requires a source",
        ),
    ],
)
def test_malformed_fulfillment_state_fails_closed(
    record,
    event,
    message,
):
    with pytest.raises(
        ValueError,
        match=message,
    ):
        decide_lifetime_ad_free_fulfillment(
            record,
            event,
            event_already_processed=False,
        )
