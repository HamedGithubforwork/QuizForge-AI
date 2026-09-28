import unittest
from datetime import datetime, time, timezone

from study_notification_sender import (
    _local_date_due,
    _payload,
    send_one,
)


class FakeResponse:
    def __init__(self, status):
        self.status = status
        self.released = False

    def release_conn(self):
        self.released = True


class FakeHttp:
    def __init__(self, status=201):
        self.status = status
        self.calls = []
        self.response = None

    def request(self, method, endpoint, **kwargs):
        self.calls.append(
            (
                method,
                endpoint,
                kwargs,
            )
        )
        self.response = FakeResponse(
            self.status
        )
        return self.response


class StudyNotificationSenderTests(unittest.TestCase):
    def test_local_window_uses_user_timezone_and_two_hour_grace(self):
        now = datetime(
            2026,
            9,
            28,
            0,
            15,
            tzinfo=timezone.utc,
        )
        eligible, local_date = (
            _local_date_due(
                now=now,
                reminder_time=time(
                    20,
                    0,
                ),
                timezone_name=
                    "America/Toronto",
            )
        )
        self.assertTrue(
            eligible
        )
        self.assertEqual(
            str(local_date),
            "2026-09-27",
        )

        too_late, _ = (
            _local_date_due(
                now=datetime(
                    2026,
                    9,
                    28,
                    3,
                    0,
                    tzinfo=timezone.utc,
                ),
                reminder_time=time(
                    20,
                    0,
                ),
                timezone_name=
                    "America/Toronto",
            )
        )
        self.assertFalse(
            too_late
        )

        invalid, date = (
            _local_date_due(
                now=now,
                reminder_time=time(
                    20,
                    0,
                ),
                timezone_name=
                    "Invalid/Zone",
            )
        )
        self.assertFalse(
            invalid
        )
        self.assertIsNone(date)

    def test_payload_is_bounded_and_pluralized(self):
        singular = _payload(1)
        plural = _payload(3)

        self.assertLess(
            len(plural),
            500,
        )
        self.assertIn(
            b"1 card ",
            singular,
        )
        self.assertIn(
            b"3 cards ",
            plural,
        )
        self.assertIn(
            b'"/decks"',
            plural,
        )

    def test_send_one_posts_encrypted_payload_and_releases_response(self):
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.serialization import (
            Encoding,
            PublicFormat,
        )
        from study_push_crypto import b64url_encode

        receiver = (
            ec.generate_private_key(
                ec.SECP256R1()
            )
        )
        receiver_public = (
            receiver.public_key()
            .public_bytes(
                Encoding.X962,
                PublicFormat.UncompressedPoint,
            )
        )
        vapid = (
            ec.derive_private_key(
                17,
                ec.SECP256R1(),
            )
        )
        http = FakeHttp(201)

        status = send_one(
            http,
            endpoint=(
                "https://fcm.googleapis.com/"
                "fcm/send/synthetic"
            ),
            p256dh=
                b64url_encode(
                    receiver_public
                ),
            auth=
                b64url_encode(
                    b"0123456789abcdef"
                ),
            payload=_payload(4),
            vapid_private=vapid,
            vapid_subject=(
                "https://quizfromnotes.com"
            ),
        )

        self.assertEqual(
            status,
            201,
        )
        self.assertEqual(
            len(http.calls),
            1,
        )
        method, endpoint, kwargs = (
            http.calls[0]
        )
        self.assertEqual(
            method,
            "POST",
        )
        self.assertEqual(
            endpoint,
            "https://fcm.googleapis.com/fcm/send/synthetic",
        )
        self.assertEqual(
            kwargs["headers"][
                "Content-Encoding"
            ],
            "aes128gcm",
        )
        self.assertTrue(
            kwargs["headers"][
                "Authorization"
            ].startswith(
                "vapid t="
            )
        )
        self.assertIsInstance(
            kwargs["body"],
            bytes,
        )
        self.assertTrue(
            http.response.released
        )

    def test_send_one_refuses_unapproved_endpoint_before_network(self):
        from cryptography.hazmat.primitives.asymmetric import ec

        http = FakeHttp(201)
        status = send_one(
            http,
            endpoint=(
                "https://example.com/push"
            ),
            p256dh="unused",
            auth="unused",
            payload=_payload(1),
            vapid_private=
                ec.generate_private_key(
                    ec.SECP256R1()
                ),
            vapid_subject=(
                "https://quizfromnotes.com"
            ),
        )
        self.assertEqual(
            status,
            400,
        )
        self.assertEqual(
            http.calls,
            [],
        )


if __name__ == "__main__":
    unittest.main()
