"""Prevent staging's CI build from silently selecting production auth rules."""
import ast
from pathlib import Path
import unittest

BUILD = Path(__file__).with_name("build.py")

class StagingBuildEnvironment(unittest.TestCase):
    def test_frontend_build_explicitly_selects_staging_auth(self):
        source = ast.parse(BUILD.read_text(encoding="utf-8"))
        calls = [
            node for node in ast.walk(source)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name) and node.func.value.id == "env"
            and node.func.attr == "update"
        ]
        self.assertEqual(len(calls), 1)
        values = {
            field.arg: field.value.value
            for field in calls[0].keywords
            if field.arg is not None and isinstance(field.value, ast.Constant)
        }
        self.assertEqual(values.get("VITE_AUTH_PROVIDER"), "cognito")
        self.assertEqual(values.get("VITE_COGNITO_STAGING"), "true")
        self.assertEqual(values.get("VITE_COGNITO_ENVIRONMENT"), "staging")
        self.assertNotIn("VITE_SUPABASE_SERVICE_ROLE_KEY", values)
        self.assertNotIn("OPENAI_API_KEY", values)

if __name__ == "__main__":
    unittest.main()
