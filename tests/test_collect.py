import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from scripts.collect import (
    collapse_channels,
    collect,
    collect_snap,
    merge_inventory,
    parse_upstream_payload,
    request_json,
    tracking_for_entry,
    validate_collection,
)


class CollapseChannelsTest(unittest.TestCase):
    def test_collapses_architectures_and_preserves_variants(self):
        channel_map = [
            {"channel": {"track": "latest", "risk": "stable", "architecture": "amd64"}, "version": "1.2.0"},
            {"channel": {"track": "latest", "risk": "stable", "architecture": "arm64"}, "version": "1.2.0"},
            {"channel": {"track": "latest", "risk": "stable", "architecture": "armhf"}, "version": "1.1.9"},
            {"channel": {"track": "2", "risk": "stable", "architecture": "amd64"}, "version": "2.0.0"},
            {"channel": {"track": "latest", "risk": "edge", "architecture": "amd64"}, "version": "1.3.0"},
        ]

        channels = collapse_channels(channel_map)

        self.assertEqual(channels["stable"]["version"], "1.2.0")
        self.assertEqual(channels["stable"]["versions"], ["1.2.0", "1.1.9"])
        self.assertEqual(channels["edge"]["version"], "1.3.0")
        self.assertIsNone(channels["candidate"]["version"])


class MergeInventoryTest(unittest.TestCase):
    def test_keeps_configured_unpublished_snaps_and_discovers_store_snaps(self):
        configured = [{"name": "tessl"}, {"name": "azimuth"}]
        discovered = ["azimuth", "mindustry"]

        self.assertEqual(
            [entry["name"] for entry in merge_inventory(configured, discovered)],
            ["azimuth", "mindustry", "tessl"],
        )


class UpstreamPayloadTest(unittest.TestCase):
    def test_parses_github_and_codeberg_release_tags(self):
        self.assertEqual(
            parse_upstream_payload("github", {"tag_name": "v2.4.1"}), "v2.4.1"
        )
        self.assertEqual(
            parse_upstream_payload("codeberg", {"tag_name": "v11.0.0"}), "v11.0.0"
        )

    def test_parses_npm_latest_version(self):
        self.assertEqual(parse_upstream_payload("npm", {"version": "0.92.0"}), "0.92.0")


    def test_rejects_non_version_tags(self):
        with self.assertRaises(ValueError):
            parse_upstream_payload("github", {"tag_name": "public"})


class TrackingMetadataTest(unittest.TestCase):
    def test_defaults_to_automatic_tracking(self):
        self.assertEqual(tracking_for_entry({"name": "example"}), {"mode": "automatic"})

    def test_preserves_explicit_tracking_metadata(self):
        tracking = {
            "mode": "static",
            "url": "https://example.com/story",
            "note": "Intentionally unchanged",
        }
        self.assertEqual(tracking_for_entry({"name": "example", "tracking": tracking}), tracking)

    def test_rejects_non_string_tracking_metadata(self):
        for key, value in (("url", None), ("note", 42)):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                tracking_for_entry({
                    "name": "example",
                    "tracking": {"mode": "manual", key: value},
                })
        with self.assertRaisesRegex(ValueError, "must be a string"):
            tracking_for_entry({
                "name": "example",
                "tracking": {"mode": "manual", 1: "unexpected key"},
            })

    def test_known_sources_and_null_are_explicitly_classified(self):
        config = json.loads(Path("config/snaps.json").read_text())
        entries = {entry["name"]: entry for entry in config["snaps"]}
        expected_manual = {
            "zx-pokemaster": "https://github.com/popey/zx-pokemaster-snap",
            "pwbm": "https://github.com/popey/pwbm",
            "add-flatpak": "https://github.com/popey/add-flatpak",
            "sfxr": "https://github.com/popey/sfxr-snap",
            "lapin": "https://github.com/popey/lapin-snap",
            "openboardview": "https://github.com/popey/openboardview-snap",
        }
        for name, url in expected_manual.items():
            self.assertEqual(entries[name]["tracking"]["mode"], "manual")
            self.assertEqual(entries[name]["tracking"]["url"], url)
        self.assertEqual(entries["null"]["tracking"]["mode"], "static")
        self.assertEqual(entries["null"]["tracking"]["url"], "https://popey.com/blog/2021/01/null/")


class CollectionFallbackTest(unittest.TestCase):
    @patch("scripts.collect.fetch_upstream", return_value={"version": "2.0", "url": "https://example.com", "error": None})
    @patch("scripts.collect.fetch_store_snap", side_effect=HTTPError("url", 429, "Too Many Requests", {}, None))
    def test_store_failure_does_not_erase_upstream_mapping(self, _store, _upstream):
        snap = collect_snap({
            "name": "example",
            "upstream": {"provider": "github", "repo": "owner/example"},
        })

        self.assertIn("429", snap["storeError"])
        self.assertEqual(snap["upstream"]["version"], "2.0")

    @patch("scripts.collect.discover_store_snaps", return_value=[])
    @patch("scripts.collect.collect_snap", side_effect=RuntimeError("store unavailable"))
    def test_preserves_manual_tracking_when_collection_fails(self, _collect_snap, _discover):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "snaps.json"
            config_path.write_text(json.dumps({
                "publisher": "example",
                "snaps": [{
                    "name": "manual-snap",
                    "tracking": {
                        "mode": "manual",
                        "url": "https://example.com/source",
                        "note": "Reviewed manually",
                    },
                }],
            }))

            snap = collect(config_path)["snaps"][0]

        self.assertEqual(snap["tracking"], {
            "mode": "manual",
            "url": "https://example.com/source",
            "note": "Reviewed manually",
        })
        self.assertEqual(snap["upstream"]["url"], "https://example.com/source")
        self.assertIsNone(snap["upstream"]["error"])


class RequestRetryTest(unittest.TestCase):
    @patch("scripts.collect.time.sleep")
    @patch("scripts.collect.random.uniform", return_value=0)
    @patch("scripts.collect.urlopen")
    def test_retries_429_using_retry_after(self, urlopen, _random, sleep):
        error = HTTPError("url", 429, "Too Many Requests", {"Retry-After": "3"}, None)
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{"ok": true}'
        urlopen.side_effect = [error, response]

        self.assertEqual(request_json("https://example.com"), {"ok": True})
        sleep.assert_called_once_with(3.0)


class CollectionQualityGateTest(unittest.TestCase):
    def test_rejects_broad_store_failure(self):
        payload = {
            "snaps": [
                {"name": f"snap-{index}", "storeError": "HTTP 429" if index < 3 else None}
                for index in range(10)
            ]
        }
        with self.assertRaisesRegex(RuntimeError, "3/10"):
            validate_collection(payload)

    def test_tolerates_small_number_of_isolated_failures(self):
        payload = {
            "snaps": [
                {"name": f"snap-{index}", "storeError": "timeout" if index == 0 else None}
                for index in range(10)
            ]
        }
        validate_collection(payload)

    @patch("scripts.collect.discover_store_snaps", return_value=[])
    @patch("scripts.collect.collect_snap", side_effect=RuntimeError("store unavailable"))
    def test_preserves_static_tracking_when_collection_fails(self, _collect_snap, _discover):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "snaps.json"
            config_path.write_text(json.dumps({
                "publisher": "example",
                "snaps": [{
                    "name": "static-snap",
                    "tracking": {
                        "mode": "static",
                        "url": "https://example.com/story",
                        "note": "Intentionally unchanged",
                    },
                }],
            }))

            snap = collect(config_path)["snaps"][0]

        self.assertEqual(snap["tracking"]["mode"], "static")
        self.assertEqual(snap["upstream"]["url"], "https://example.com/story")
        self.assertIsNone(snap["upstream"]["error"])


if __name__ == "__main__":
    unittest.main()
