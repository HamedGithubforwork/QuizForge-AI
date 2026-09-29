from datetime import date, timedelta

from study_analytics_postgres import (
    RECENT_ACTIVITY_DAYS,
    WEEKLY_GOAL_DAYS,
    build_streak_metrics,
)


def row(
    local_date,
    reviews=1,
    milliseconds=1000,
):
    return {
        "local_date": local_date,
        "review_count": reviews,
        "study_time_ms": milliseconds,
    }


def test_current_streak_counts_consecutive_days_through_today():
    today = date(
        2026,
        10,
        2,
    )
    result = build_streak_metrics(
        [
            row(today),
            row(today - timedelta(days=1)),
            row(today - timedelta(days=2)),
            row(today - timedelta(days=5)),
            row(today - timedelta(days=6)),
        ],
        today=today,
    )

    assert (
        result[
            "current_streak_days"
        ]
        == 3
    )
    assert (
        result[
            "longest_streak_days"
        ]
        == 3
    )


def test_streak_stays_alive_until_end_of_today_when_yesterday_was_active():
    today = date(
        2026,
        10,
        2,
    )
    result = build_streak_metrics(
        [
            row(
                today
                - timedelta(days=1)
            ),
            row(
                today
                - timedelta(days=2)
            ),
            row(
                today
                - timedelta(days=3)
            ),
        ],
        today=today,
    )

    assert (
        result[
            "current_streak_days"
        ]
        == 3
    )


def test_broken_streak_is_zero_but_longest_history_is_retained():
    today = date(
        2026,
        10,
        10,
    )
    result = build_streak_metrics(
        [
            row(
                today
                - timedelta(days=4)
            ),
            row(
                today
                - timedelta(days=5)
            ),
            row(
                today
                - timedelta(days=6)
            ),
            row(
                today
                - timedelta(days=7)
            ),
        ],
        today=today,
    )

    assert (
        result[
            "current_streak_days"
        ]
        == 0
    )
    assert (
        result[
            "longest_streak_days"
        ]
        == 4
    )


def test_weekly_goal_counts_unique_active_days_in_current_monday_week():
    today = date(
        2026,
        10,
        2,
    )  # Friday.
    monday = (
        today
        - timedelta(
            days=today.weekday()
        )
    )
    result = build_streak_metrics(
        [
            row(
                monday
                + timedelta(days=offset)
            )
            for offset in range(5)
        ],
        today=today,
    )

    assert (
        result[
            "active_days_this_week"
        ]
        == 5
    )
    assert (
        result[
            "weekly_goal_days"
        ]
        == WEEKLY_GOAL_DAYS
        == 5
    )
    assert (
        result[
            "weekly_goal_met"
        ]
        is True
    )


def test_recent_activity_is_zero_filled_and_bounded_to_28_days():
    today = date(
        2026,
        10,
        2,
    )
    active = (
        today
        - timedelta(days=3)
    )
    result = build_streak_metrics(
        [
            row(
                active,
                reviews=4,
                milliseconds=9000,
            ),
            row(
                today
                - timedelta(days=40),
                reviews=10,
                milliseconds=50000,
            ),
        ],
        today=today,
    )

    recent = result[
        "recent_activity"
    ]
    assert (
        len(recent)
        == RECENT_ACTIVITY_DAYS
        == 28
    )
    assert (
        recent[0][
            "local_date"
        ]
        == today
        - timedelta(days=27)
    )
    assert (
        recent[-1][
            "local_date"
        ]
        == today
    )
    matching = [
        item
        for item in recent
        if item[
            "local_date"
        ]
        == active
    ]
    assert matching == [
        {
            "local_date": active,
            "review_count": 4,
            "study_time_ms": 9000,
        }
    ]
    assert sum(
        item["review_count"]
        for item in recent
    ) == 4
