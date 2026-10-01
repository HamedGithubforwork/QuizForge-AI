# Offline review synchronization contract

`POST /api/decks/{deck_id}/offline-review` accepts one authenticated review event.
It uses the same identity mapping, row-level security, FSRS scheduler and transaction
as online reviews. The existing online endpoint is unchanged. No schema migration
is required: the UUID event key occupies the existing immutable review-log ID.

The body contains `card_id`, `rating` (1–4), optional `review_duration_ms`, a random
UUID-v4 `event_id`, timezone-aware `reviewed_at` and `expected_updated_at`, and
`expected_study_intensity`. The expected values come from the saved card/deck.
The client must preserve the exact event across retries, including its timestamp.
No owner, scheduling result or authentication token belongs in the event.

The server serializes retries by verified owner/event and locks the card. A prior
matching event returns `replayed: true` and the current card without applying FSRS
again. Reusing an event ID for another card, rating, duration or timestamp fails.
A new event requires an unchanged card timestamp and study intensity, an
unsuspended card, and a card that was due at the recorded review time. Recorded
times must not precede the saved card state, exceed server time or be older than
90 days. Successful scheduling uses the recorded review time, not sync time.

The response includes `event_id`, `replayed`, `card`, `remaining_due_count` and
`next_due_at`. Duplicate responses deliberately return current state, preserving
later online edits and progress resets rather than restoring an old response.
Deleting/moving a card can make retries return 404; this must be reconciled, never
retargeted automatically. Review-log keys last as long as the associated card.

409 means reconciliation is needed, 422 means invalid event/clock data, and 404
means the card is unavailable in this account/deck. Preserve unresolved local
activity and explain it to the user; never silently rebase a rejected review onto
new server state. Retry transport/temporary failures with the same event. A lost
success response must not create a fresh event ID. Authentication expiry requires
sign-in to the same verified account before continuing.

Initial desktop integration should allow one queued review per saved card until
acknowledged or explicitly resolved. It must durably encrypt an event before
showing it as recorded, retain events across restart, and prevent saving a new
snapshot from discarding pending reviews. Multiple-device reviews may conflict;
conflict handling must not claim they all affected the schedule. Offline access
remains opt-in and purchase restrictions are deferred. This API does not itself
activate desktop recording, deploy production, or provide a local AI runtime.
