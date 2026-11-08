# Checkpoint history archive protocol

The orchestrator keeps the task backlog inline (maximum 1,000 tasks) and keeps
the most recent 500 events, 100 audits, and 25 pilot summaries in the active
checkpoint. Older event, audit, and pilot-summary records move to immutable
canonical JSON chunks in `docs/autonomy/history-archives/`. Each chunk is named
by its SHA-256 digest and referenced by byte size and per-stream record counts.
Load verifies the path, file type, size, digest, canonical encoding, counts,
and then reconstructs the complete ordered history before schema and event
cross-link validation. Exhaustion reports keep the two audits establishing the
consecutive-clean rule; the complete audit stream remains in the archive.

The archive has a finite capacity of 512 chunks and 32 MiB total, and the
referenced plus inline streams have a 50,000-record aggregate ceiling. The
loader checks reference byte totals and record totals before opening archives,
then iterates the directory through a bounded `opendir` scan. It inspects at
most 545 entries: 512 content-addressed files, 32 recognized temporary files,
and one capacity lock. Unknown artifacts or additional entries fail closed
without being removed. It checks file count and aggregate inventoried bytes
before opening any referenced archive. Each individual read is
limited to the referenced byte count plus one and rechecks file identity and
size after the read. The writer
uses a directory capacity lock, inventories orphaned content-addressed files,
preflights space before writing, and rejects stale checkpoint revisions. A
reserve of one maximum-size chunk records a durable
`checkpoint.historyCapacity` blocker when a save succeeds. For an active gate,
this also sets `optimizationGate` to `BLOCKED/history_capacity`; existing
`STOPPED` reasons and approval blockers are preserved. If preflight finds the
cap already full (including orphan files), the save fails before accepting any
archive reference or checkpoint update; the prior checkpoint and caller state
remain intact, and the caller must recover storage capacity before retrying.
That rejected save does not claim a durable blocker record. No history is
silently truncated or deleted. Unreferenced artifacts from interrupted writes
remain immutable and count against capacity; identical content is safely
deduplicated.

After a crash, only a capacity lock with a parseable local dead-process owner
record and a temporary file matching the content-addressed writer's exact
name, regular-file type, bounded size, and 24-hour stale age can be reclaimed.
Unknown, malformed, recent, or foreign-host artifacts are preserved and cause
the archive operation to stop for manual inspection.

Schema v1 and v2 checkpoints without archive references are migrated in
memory by initializing an empty reference list. Their inline history remains
untouched; subsequent saves externalize only records older than the active
windows. The v1 regression test copies the checked-in v1 pilot snapshot to a
temporary file and reads preservation artifacts from the repository; it never
writes to the version-controlled snapshot. There is no separately preserved
historical v2 snapshot in the repository, so the v2 migration test uses the
canonical v2 state constructor with the new additive reference field removed.

For GitHub handoff or cross-checkout recovery, commit or copy the checkpoint
JSON and every archive file it references together. The orchestrator does not
stage or commit files automatically. `.gitattributes` disables text/EOL
normalization for content-addressed archive JSON, preserving the canonical LF
bytes and SHA-256 digest across Windows checkouts configured with
`core.autocrlf=true` and Unix checkouts.
