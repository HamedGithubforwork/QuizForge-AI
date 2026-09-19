import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from botocore.exceptions import ClientError
from control import inventory, missing


class ArtifactSafety(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "index.html").write_text('<div id="root"></div>')
        (self.root / "assets").mkdir()
        (self.root / "assets/app-hash.js").write_text("void 0;")

    def test_content_hash_detects_modified_build(self):
        original = inventory(self.root)
        (self.root / "assets/app-hash.js").write_text("void 1;")
        self.assertNotEqual(original, inventory(self.root))

    def test_rejects_unexpected_files(self):
        for key in (".env", "assets/app.js.map", "credentials.json", "assets/code.html"):
            path = self.root / key
            path.write_text("not deployable")
            with self.assertRaises(ValueError):
                inventory(self.root)
            path.unlink()

    def test_rejects_symlink_even_to_allowed_file(self):
        (self.root / "assets/link.js").symlink_to(self.root / "assets/app-hash.js")
        with self.assertRaises(ValueError):
            inventory(self.root)

    def test_rejects_missing_application(self):
        (self.root / "assets/app-hash.js").unlink()
        with self.assertRaises(ValueError):
            inventory(self.root)

    def test_rejects_oversized_artifact(self):
        (self.root / "assets/app-hash.js").write_bytes(b"x" * (20 * 1024 * 1024))
        with self.assertRaises(ValueError):
            inventory(self.root)

    def test_absence_requires_real_not_found(self):
        missing(Mock(side_effect=ClientError({"Error": {"Code": "404"}}, "HeadBucket")), {"404"})
        for code in ("403", "AccessDenied", "Throttling", "ServiceUnavailable"):
            with self.assertRaises(ClientError):
                missing(Mock(side_effect=ClientError({"Error": {"Code": code}}, "HeadBucket")), {"404"})
        with self.assertRaises(AssertionError):
            missing(Mock(return_value={}), {"404"})


if __name__ == "__main__":
    unittest.main()
