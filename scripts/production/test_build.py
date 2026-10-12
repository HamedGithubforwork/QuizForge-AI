from pathlib import Path
import tempfile
import unittest

from scripts.production import build as production_build


class ProductionBuildTests(unittest.TestCase):
    def fixture(self, root: str) -> Path:
        frontend = Path(root) / "frontend"
        lib = frontend / "src" / "lib"
        lib.mkdir(parents=True)
        (frontend / "src" / "CognitoAuthGate.tsx").write_text(
            "import { createClient } from '@supabase/supabase-js'\n"
            "export default function CognitoAuthGate() { return null }\n",
            encoding="utf-8",
        )
        (frontend / "src" / "SupabaseAuthGate.tsx").write_text(
            "import { supabase } from './lib/supabase'\n"
            "export default function SupabaseAuthGate() { return null }\n",
            encoding="utf-8",
        )
        (frontend / "src" / "AuthGate.tsx").write_text(
            "export { default } from './SupabaseAuthGate'\n",
            encoding="utf-8",
        )
        (lib / "authSession.ts").write_text(
            "import { supabase } from './supabase'\n"
            "export async function authSession() { return supabase.auth.getSession() }\n",
            encoding="utf-8",
        )
        (lib / "cognitoBrowser.ts").write_text(
            "export async function session() { return null }\n",
            encoding="utf-8",
        )
        (lib / "supabase.ts").write_text(
            "export const supabase = {}\n",
            encoding="utf-8",
        )
        return frontend

    def test_narrows_production_auth_to_cognito_and_keeps_link_sdk_usage(self):
        with tempfile.TemporaryDirectory() as root:
            frontend = self.fixture(root)

            production_build.narrow_production_auth_source(frontend)

            self.assertEqual(
                (frontend / "src" / "AuthGate.tsx").read_text(),
                production_build.COGNITO_GATE_SOURCE,
            )
            session = (
                frontend / "src" / "lib" / "authSession.ts"
            ).read_text()
            self.assertIn(
                "from './cognitoBrowser'",
                session,
            )
            self.assertNotIn(
                "supabase",
                session.lower(),
            )
            self.assertFalse(
                (
                    frontend / "src" / "SupabaseAuthGate.tsx"
                ).exists()
            )
            self.assertFalse(
                (
                    frontend / "src" / "lib" / "supabase.ts"
                ).exists()
            )

            # The SDK remains available to the Cognito gate's explicit
            # non-persistent legacy-account proof.
            self.assertIn(
                "@supabase/supabase-js",
                (
                    frontend / "src" / "CognitoAuthGate.tsx"
                ).read_text(),
            )

    def test_refuses_unknown_runtime_dependency_on_local_supabase_adapter(self):
        with tempfile.TemporaryDirectory() as root:
            frontend = self.fixture(root)
            (
                frontend / "src" / "Unexpected.ts"
            ).write_text(
                "import { supabase } from './lib/supabase'\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                ValueError,
                "Unexpected production dependency",
            ):
                production_build.narrow_production_auth_source(
                    frontend
                )

    def test_preserves_complete_desktop_gate_without_restoring_legacy_auth(self):
        with tempfile.TemporaryDirectory() as root:
            frontend = self.fixture(root)
            (frontend / "src" / "DesktopAuthGate.tsx").write_text("export default function DesktopAuthGate() {return null}")
            (frontend / "src" / "lib" / "desktop.ts").write_text("export function desktopBridge() {return undefined}")
            production_build.narrow_production_auth_source(frontend)
            self.assertEqual((frontend / "src" / "AuthGate.tsx").read_text(), production_build.COGNITO_DESKTOP_GATE_SOURCE)
            session = (frontend / "src" / "lib" / "authSession.ts").read_text()
            self.assertIn("desktop.status()", session)
            self.assertNotIn("supabase", session.lower())
            self.assertFalse((frontend / "src" / "lib" / "supabase.ts").exists())

    def test_google_requires_explicit_verified_public_production_flag(self):
        config = {
            "pool": "ca-central-1_SyntheticPool",
            "client": "syntheticclient123",
            "auth_origin": "https://quizforge-123456789012.auth.ca-central-1.amazoncognito.com",
            "frontend_url": "https://quizfromnotes.com",
            "api_url": "https://api.quizfromnotes.com",
            "legacy_url": "https://vfxmsvphgcaizqnbyjip.supabase.co",
            "legacy_publishable_key": "sb_publishable_synthetic_public_key_123456789",
            "sms_mfa_enabled": False,
            "google_signin_enabled": False,
        }
        self.assertFalse(production_build.public_config(config)["google_signin_enabled"])
        self.assertTrue(production_build.public_config({
            **config, "google_signin_enabled": True
        })["google_signin_enabled"])
        for invalid in (None, "true", "false", 1, 0):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                production_build.public_config({
                    **config, "google_signin_enabled": invalid
                })
        with self.assertRaises(ValueError):
            production_build.public_config({
                k: v for k, v in config.items() if k != "google_signin_enabled"
            })

    def test_incomplete_desktop_source_fails(self):
        with tempfile.TemporaryDirectory() as root:
            frontend = self.fixture(root)
            (frontend / "src" / "DesktopAuthGate.tsx").write_text("export default function DesktopAuthGate() {return null}")
            with self.assertRaisesRegex(ValueError, "Incomplete desktop"):
                production_build.narrow_production_auth_source(frontend)

    def test_requires_reviewed_candidate_auth_files(self):
        with tempfile.TemporaryDirectory() as root:
            frontend = self.fixture(root)
            (
                frontend / "src" / "CognitoAuthGate.tsx"
            ).unlink()

            with self.assertRaisesRegex(
                ValueError,
                "lacks reviewed auth source",
            ):
                production_build.narrow_production_auth_source(
                    frontend
                )


if __name__ == "__main__":
    unittest.main()
