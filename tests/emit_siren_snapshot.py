"""Emit the real poller's JSON for the cross-runtime browser smoke test."""
import json
import sys
from unittest.mock import Mock, patch

import httpx
from test_polling import app


def main():
    city = sys.argv[1]
    container = Mock()
    storage = {}

    def get_blob(path):
        def download():
            if path not in storage:
                raise app.ResourceNotFoundError("no blob")
            return Mock(readall=lambda: storage[path])

        return Mock(download_blob=download, upload_blob=lambda data, **_: storage.update({path: data}))

    def upstream(request):
        if request.url.path.endswith("Alerts.json"):
            return httpx.Response(200, json={"cat": "1", "id": "123", "data": [city]})
        return httpx.Response(403)

    container.get_blob_client.side_effect = get_blob
    client = httpx.Client
    with patch.object(app, "_get_container_client", return_value=container), patch.object(
        httpx, "Client", lambda **kw: client(transport=httpx.MockTransport(upstream), **kw)
    ):
        timer = Mock(past_due=False)
        app.refresh_history(timer)
        app.poll_oref(timer)
    print(json.dumps(json.loads(storage[app.STATE_BLOB])))


if __name__ == "__main__":
    main()
