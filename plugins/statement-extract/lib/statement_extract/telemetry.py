"""Run log: OTel Logs Data Model records as JSONL, plus an optional OTLP/HTTP-JSON push.

Stdlib only. The local JSONL is always written (to --log, $STATEMENT_EXTRACT_LOG, or
$XDG_STATE_HOME/statement-extract/runs.jsonl). When OTEL_EXPORTER_OTLP_LOGS_ENDPOINT or
OTEL_EXPORTER_OTLP_ENDPOINT is http(s), the same records are POSTed as OTLP/JSON. Telemetry
never fails an extraction: a failed write or push is recorded locally (or dropped) and the run
goes on. Attribute values are masked values only; callers never pass raw statement text.
"""
import json
import os
import secrets
import sys
import time
import urllib.request
from pathlib import Path

SERVICE = "statement-extract"
SEVERITY = {"DEBUG": 5, "INFO": 9, "WARN": 13, "ERROR": 17}


def default_log_path() -> Path:
    if os.environ.get("STATEMENT_EXTRACT_LOG"):
        return Path(os.environ["STATEMENT_EXTRACT_LOG"])
    state = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(state) / SERVICE / "runs.jsonl"


def otlp_url() -> str | None:
    """Signal-specific endpoint is used as-is; the generic one gets /v1/logs (OTLP spec)."""
    url = os.environ.get("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")
    if not url:
        base = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
        url = base.rstrip("/") + "/v1/logs" if base else None
    return url if url and url.startswith(("http://", "https://")) else None


def otlp_headers() -> dict[str, str]:
    out = {}
    raw = os.environ.get("OTEL_EXPORTER_OTLP_LOGS_HEADERS") or \
        os.environ.get("OTEL_EXPORTER_OTLP_HEADERS") or ""
    for part in raw.split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = urllib.request.unquote(v.strip())
    return out


def _any(v) -> dict:
    if isinstance(v, bool):
        return {"boolValue": v}
    if isinstance(v, int):
        return {"intValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [_any(x) for x in v]}}
    return {"stringValue": str(v)}


def to_otlp(records: list[dict], scope_version: str) -> dict:
    """Logs Data Model records -> an OTLP/JSON ExportLogsServiceRequest."""
    return {"resourceLogs": [{
        "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": SERVICE}}]},
        "scopeLogs": [{
            "scope": {"name": SERVICE, "version": scope_version},
            "logRecords": [{
                "timeUnixNano": r["Timestamp"],
                "observedTimeUnixNano": r["ObservedTimestamp"],
                "severityNumber": r["SeverityNumber"],
                "severityText": r["SeverityText"],
                "body": {"stringValue": r["Body"]},
                "attributes": [{"key": k, "value": _any(v)}
                               for k, v in sorted(r["Attributes"].items())],
                "traceId": r["TraceId"],
                "spanId": r["SpanId"],
            } for r in records],
        }],
    }]}


class RunLog:
    def __init__(self, path: Path | None, version: str, timeout: float = 2.0):
        self.path = path or default_log_path()
        self.version = version
        self.timeout = timeout
        self.trace_id = secrets.token_hex(16)
        self.span_id = secrets.token_hex(8)
        self.records: list[dict] = []

    def emit(self, event: str, severity: str = "INFO", **attrs) -> None:
        now = str(time.time_ns())
        attrs = {"event.name": event, **{k: v for k, v in attrs.items() if v is not None}}
        self.records.append({
            "Timestamp": now, "ObservedTimestamp": now,
            "SeverityText": severity, "SeverityNumber": SEVERITY[severity],
            "Body": event, "Attributes": attrs,
            "TraceId": self.trace_id, "SpanId": self.span_id,
            "Resource": {"service.name": SERVICE, "service.version": self.version},
        })

    def close(self) -> None:
        url = otlp_url()
        if url and self.records:
            try:
                body = json.dumps(to_otlp(self.records, self.version)).encode()
                req = urllib.request.Request(
                    url, data=body, method="POST",
                    headers={"Content-Type": "application/json", **otlp_headers()})
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    resp.read()
            except Exception as e:  # a failed push never fails extraction
                self.emit("telemetry.push_failed", "WARN", **{"error.type": type(e).__name__})
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                for r in self.records:
                    f.write(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n")
        except OSError as e:
            print(f"statement-extract: run log not written ({e.strerror})", file=sys.stderr)
