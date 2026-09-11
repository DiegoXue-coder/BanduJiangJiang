"""Temporary LAN API proxy for Android network rescue.

This does not create a second backend or copy data. It exposes the existing
Railway API on the local network so an Android device on the same Wi-Fi can
reach the service through this computer when it cannot reach Railway directly.
"""

from __future__ import annotations

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


DEFAULT_UPSTREAM = "https://bandujiangjiang-production.up.railway.app"
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
}


def _json_bytes(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _copy_headers(headers: Iterable[tuple[str, str]]) -> dict[str, str]:
    copied: dict[str, str] = {}
    for key, value in headers:
        if key.lower() in HOP_BY_HOP_HEADERS:
            continue
        copied[key] = value
    return copied


class ProxyHandler(BaseHTTPRequestHandler):
    upstream = DEFAULT_UPSTREAM
    timeout = 45

    def log_message(self, fmt: str, *args) -> None:
        print(f"[temporary-api-proxy] {self.address_string()} {fmt % args}")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization,Content-Type,x-extension-token")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] in {"/health", "/healthz"}:
            self._health()
            return
        self._forward()

    def do_POST(self) -> None:
        self._forward()

    def do_PUT(self) -> None:
        self._forward()

    def do_PATCH(self) -> None:
        self._forward()

    def do_DELETE(self) -> None:
        self._forward()

    def _health(self) -> None:
        started = time.perf_counter()
        upstream_url = urljoin(self.upstream.rstrip("/") + "/", "health")
        payload = {
            "status": "ok",
            "proxy": "temporary-lan",
            "upstream": self.upstream,
            "upstream_health_url": upstream_url,
        }
        status = 200
        try:
            with urlopen(upstream_url, timeout=10) as resp:
                body = resp.read(4096).decode("utf-8", errors="replace")
                payload.update(
                    upstream_reachable=True,
                    upstream_status=resp.status,
                    upstream_body=body[:500],
                )
        except Exception as exc:  # health should diagnose, not hide the proxy.
            status = 502
            payload.update(
                status="upstream_error",
                upstream_reachable=False,
                error=f"{type(exc).__name__}: {exc}",
            )
        payload["latency_ms"] = round((time.perf_counter() - started) * 1000)
        self._send_json(status, payload)

    def _forward(self) -> None:
        if self.path.startswith("http://") or self.path.startswith("https://"):
            self._send_json(400, {"detail": "absolute URLs are not accepted"})
            return

        content_length = int(self.headers.get("Content-Length") or "0")
        body = self.rfile.read(content_length) if content_length else None
        target = self.upstream.rstrip("/") + self.path
        headers = _copy_headers(self.headers.items())

        started = time.perf_counter()
        request = Request(target, data=body, headers=headers, method=self.command)
        try:
            with urlopen(request, timeout=self.timeout) as resp:
                response_body = resp.read()
                self.send_response(resp.status)
                for key, value in resp.headers.items():
                    if key.lower() in HOP_BY_HOP_HEADERS:
                        continue
                    self.send_header(key, value)
                self.send_header("X-Proxy-Upstream", self.upstream)
                self.send_header("X-Proxy-Latency-Ms", str(round((time.perf_counter() - started) * 1000)))
                self.end_headers()
                self.wfile.write(response_body)
        except HTTPError as exc:
            response_body = exc.read()
            self.send_response(exc.code)
            for key, value in exc.headers.items():
                if key.lower() in HOP_BY_HOP_HEADERS:
                    continue
                self.send_header(key, value)
            self.send_header("X-Proxy-Upstream", self.upstream)
            self.end_headers()
            self.wfile.write(response_body)
        except (TimeoutError, URLError, OSError) as exc:
            self._send_json(
                502,
                {
                    "detail": "temporary proxy could not reach upstream",
                    "upstream": self.upstream,
                    "path": self.path,
                    "error": f"{type(exc).__name__}: {exc}",
                },
            )

    def _send_json(self, status: int, payload: dict) -> None:
        body = _json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description="Expose the Railway API through a temporary LAN proxy.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--upstream", default=DEFAULT_UPSTREAM)
    parser.add_argument("--timeout", type=int, default=45)
    args = parser.parse_args()

    ProxyHandler.upstream = args.upstream.rstrip("/")
    ProxyHandler.timeout = args.timeout
    server = ThreadingHTTPServer((args.host, args.port), ProxyHandler)
    print(f"Temporary API proxy listening on http://{args.host}:{args.port}")
    print(f"Forwarding requests to {ProxyHandler.upstream}")
    server.serve_forever()


if __name__ == "__main__":
    main()
