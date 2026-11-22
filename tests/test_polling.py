import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "function_app"))
import function_app as app


def row(city):
    return {"rid": 42, "data": city, "date": "08.06.2026", "time": "05:53:08",
            "dateTime": "2026-06-08T05:53:08", "category": 14, "category_Desc": "warning"}


def page(rows):
    return {"alarmsGroupedByDate": [{"value": rows}] if rows else []}


class PollingTests(unittest.TestCase):
    def test_pages_preserve_areas_sharing_id_and_ignore_overlap(self):
        a, b = row("Area A"), row("א & ב")
        pages = iter([page([a]), page([a, b]), page([])])
        previous = iter([None, a, b])

        def respond(request):
            cursor = next(previous)
            if cursor:
                self.assertEqual(request.url.params["lastCreatedOn"], cursor["dateTime"])
                self.assertEqual(request.url.params["lastCityName"], cursor["data"])
                self.assertEqual(request.url.params["lastTitle"], cursor["category_Desc"])
            return httpx.Response(200, json=next(pages))

        with httpx.Client(transport=httpx.MockTransport(respond)) as client:
            rows = app._fetch_history(client)
        self.assertEqual([r["data"] for r in rows], [a["data"], b["data"]])
        self.assertEqual(rows[0]["alertDate"], "2026-06-08 05:53:08")

    def test_bad_history_page_never_completes(self):
        for second_page in ({}, {"alarmsGroupedByDate": [{}]}, page([row("A")])):
            pages = iter([page([row("A")]), second_page])
            with self.subTest(second_page=second_page), httpx.Client(
                transport=httpx.MockTransport(lambda _, pages=pages: httpx.Response(200, json=next(pages)))
            ) as client, self.assertRaises((ValueError, TypeError)):
                app._fetch_history(client)

    def test_timer_snapshots_survive_outage_then_recover(self):
        # Run both timers across a JSON blob boundary with fake upstream HTTP only.
        blob_data = {}
        container = Mock()
        def blob(path):
            client = Mock()
            client.upload_blob.side_effect = lambda data, **_: blob_data.update({path: data})
            def download():
                if path not in blob_data:
                    raise app.ResourceNotFoundError("no blob")
                return Mock(readall=lambda: blob_data[path])
            client.download_blob.side_effect = download
            return client
        container.get_blob_client.side_effect = blob
        real_client = httpx.Client
        siren = {"cat": "1", "data": ["A"]}
        legacy_history = [{"category": 14, "data": "Legacy area", "alertDate": "2026-06-08 05:53:08"}]
        blob_data[app.STATE_BLOB] = json.dumps({"alerts": [], "history": legacy_history})
        live = iter([(403, b""), (200, json.dumps(siren).encode()), (200, b"null"),
                     (200, b"\xef\xbb\xbf\r\n"), (200, json.dumps(siren).encode())])
        history = iter([page([row("A")]), page([]), page([row("B")]), {}, page([])])
        def respond(request):
            if request.url.path.endswith("Alerts.json"):
                code, content = next(live)
                return httpx.Response(code, content=content)
            return httpx.Response(200, json=next(history))
        timer = Mock(past_due=False)
        with patch.object(app, "_get_container_client", return_value=container), \
             patch.object(app, "_last_live_success", None), patch.object(app, "_last_alerts", []), \
             patch.object(httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(respond), **kw)):
            def poll():
                app.poll_oref(timer)
                return json.loads(blob_data["api/state.json"])
            cold = poll()
            self.assertFalse(cold["feeds"]["live"]["ok"])
            self.assertIsNone(cold["feeds"]["history"]["last_success_at"])
            self.assertFalse(cold["feeds"]["history"]["ok"])
            self.assertEqual(cold["history"], legacy_history)
            self.assertEqual(cold["updated_at"], "1970-01-01T00:00:00Z")
            app.refresh_history(timer)
            good = poll()
            self.assertTrue(good["feeds"]["live"]["ok"])
            self.assertEqual(good["alerts"], [siren])
            # Azure can start the next tick on a fresh worker during an outage.
            app._last_live_success, app._last_alerts = None, []
            app.refresh_history(timer)
            bad = poll()
            self.assertEqual(bad["alerts"], good["alerts"])
            self.assertFalse(bad["feeds"]["live"]["ok"])
            self.assertEqual(bad["updated_at"], good["updated_at"])
            self.assertEqual(bad["history"], good["history"])
            self.assertFalse(bad["feeds"]["history"]["ok"])
            self.assertEqual(bad["feeds"]["history"]["last_success_at"], good["feeds"]["history"]["last_success_at"])
            app.refresh_history(timer)
            fresh = poll()
            self.assertTrue(all(f["ok"] for f in fresh["feeds"].values()))
            self.assertEqual(fresh["history"], [])
            self.assertEqual(fresh["alerts"], [])
            fresh_history = {"history": [{"category": 1, "data": "A", "alertDate": "2026-06-08 05:56:30"}]}
            fresh.update(fresh_history)
            blob_data[app.STATE_BLOB] = json.dumps(fresh)
            blob_data[app.HISTORY_BLOB] = '{"history": null}'
            degraded = poll()
            self.assertFalse(degraded["feeds"]["history"]["ok"])
            self.assertEqual(degraded["feeds"]["history"]["last_success_at"], fresh["feeds"]["history"]["last_success_at"])
            self.assertEqual(degraded["history"], fresh["history"])
            self.assertTrue(degraded["feeds"]["live"]["ok"])
            self.assertEqual(degraded["alerts"], [siren])
