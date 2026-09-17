from copy import deepcopy
import json
import secrets
import unittest
from unittest.mock import patch
from uuid import UUID

import history_transfer as transfer
from probe import fixtures


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = {"version": 1, "issuer": "https://synthetic-auth.invalid/auth/v1",
                         "users": [str(UUID(int=i)) for i in (1, 2, 3)],
                         "rows": [json.dumps(row, default=str) for row in fixtures()]}
        self.key = secrets.token_bytes(32)

    def test_manifest_includes_zero_history_users_and_every_column(self):
        report = transfer.validate(self.snapshot)
        self.assertEqual((report["users"], report["rows"]), (3, 8))
        self.assertEqual(list(report["per_user"].values()), [4, 4, 0])
        changed = deepcopy(self.snapshot)
        row = json.loads(changed["rows"][0])
        row["quiz_data"] = {"nested": [None, "é", True]}
        changed["rows"][0] = json.dumps(row)
        self.assertNotEqual(transfer.validate(changed)["sha256"], report["sha256"])

    def test_encrypted_roundtrip_preserves_json_numeric_text(self):
        raw = self.snapshot["rows"][0].replace('"questions": []', '"questions": [], "precise": 0.123456789012345678901234567890')
        self.snapshot["rows"][0] = raw
        encrypted = transfer.seal(self.snapshot, self.key)
        self.assertNotIn(raw.encode(), encrypted)
        self.assertEqual(transfer.unseal(encrypted, self.key), self.snapshot)
        self.assertNotEqual(encrypted, transfer.seal(self.snapshot, self.key))

    def test_wrong_key_header_nonce_and_ciphertext_are_rejected(self):
        encrypted = transfer.seal(self.snapshot, self.key)
        for damaged in (encrypted[1:], encrypted[:-1], b"wrong" + encrypted[5:],
                        encrypted[:len(transfer.HEADER)] + b"0" * 12 + encrypted[len(transfer.HEADER) + 12:],
                        encrypted[:-1] + bytes([encrypted[-1] ^ 1])):
            with self.subTest(length=len(damaged)), self.assertRaises(transfer.TransferError):
                transfer.unseal(damaged, self.key)
        with self.assertRaises(transfer.TransferError):
            transfer.unseal(encrypted, secrets.token_bytes(32))

    def test_duplicate_or_orphaned_history_and_unknown_fields_fail(self):
        for change in ("duplicate", "orphan", "field", "version", "identity"):
            bad = deepcopy(self.snapshot)
            if change == "duplicate": bad["rows"].append(bad["rows"][0])
            elif change == "orphan": bad["users"].pop(0)
            elif change == "version": bad["version"] = 2
            elif change == "identity": bad["users"].append(bad["users"][0])
            else:
                row = json.loads(bad["rows"][0]); row["password"] = "never-export"
                bad["rows"][0] = json.dumps(row)
            with self.subTest(change=change), self.assertRaises(transfer.TransferError):
                transfer.seal(bad, self.key)

    def test_size_limits_fail_instead_of_truncating(self):
        with patch.object(transfer, "MAX_RECORDS", 1), self.assertRaises(transfer.TransferError):
            transfer.seal(self.snapshot, self.key)
        with patch.object(transfer, "MAX_BYTES", 50), self.assertRaises(transfer.TransferError):
            transfer.seal(self.snapshot, self.key)

    def test_unmapped_new_identity_blocks_rollback_before_database_access(self):
        desired = deepcopy(self.snapshot)
        desired["users"].append(str(UUID(int=4)))
        with self.assertRaisesRegex(transfer.TransferError, "unchanged, mapped"):
            transfer.rollback_history(None, self.snapshot, desired, dry_run=False)


if __name__ == "__main__": unittest.main()
