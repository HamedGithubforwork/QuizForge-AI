# Current stack capacity acceptance

This test pins application `807a4084237f6db544620cdb8322108ebf52251c` and the
prepared configuration `62e39f33d715cc83928390cfd5ff1728008c4053`. It does not merge
or deploy either permanent candidate. The dedicated manual workflow runs only on
trusted main, with the existing temporary-host permissions and independent
2-hour deletion schedule verified before instance creation.

The six actual services retain the reviewed individual memory limits, restricted
users, TLS database connections, separate credentials, disabled AI gateway and
1536 MiB aggregate cgroup. A seventh temporary operations process has the planned
256 MiB backup limit. The workload uses the actual isolated PDF worker for 30
synthetic scanned pages, repeated real database exports and AES-GCM round trips,
plus health requests through Caddy. Four hundred synthetic history rows provide
several MiB of backup data. No customer records, real model key, Cognito users,
public DNS or certificate issuance are involved.

Acceptance requires all six services remaining up, no unexpected restart or OOM,
health p95 below 2 seconds, at least 128 MiB host memory remaining, and OCR token
precision/recall at least 95%. CI checks the real stack under these limits before
manual AWS dispatch. CI is labeled separately from a real Canadian 2 GB host.

This measures a single OCR job with concurrent backup and health traffic. It does
not establish arbitrary user concurrency, depleted CPU-credit behavior, final
production authentication, actual S3 delivery/restore or alert delivery. Those
remain separate acceptance gates. The local backup round trip must never be
reported as an AWS restore.

`host_control.py` preserves the reviewed temporary-host lifecycle in a dedicated
copy; the existing controller's 23 lifecycle tests also run against that copy.
This keeps the historical paired OCR test unchanged. Only source metadata and the
benchmark callback differ in its launch path. AWS credentials remain on the
runner; the host receives only synthetic sources and images, verified against the
artifact digest. Failed workload reports are retrieved before deletion.
