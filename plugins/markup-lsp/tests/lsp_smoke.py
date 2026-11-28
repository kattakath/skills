#!/usr/bin/env python3
"""Start every server in .lsp.json the way Claude Code does, and require an LSP `initialize` reply.

usage: lsp_smoke.py <plugin-dir> <bin-dir>

Each server is spawned as `<bin-dir>/<command> <args...>` over stdio, sent `initialize`,
and must answer with a `result` carrying `capabilities` within the timeout. It is then sent
`shutdown` + `exit`. A server that starts but speaks no LSP fails here, which a PATH check
alone would miss.
"""

import json
import os
import select
import subprocess
import sys
import time

TIMEOUT = 60.0


def frame(msg: dict) -> bytes:
    body = json.dumps(msg).encode()
    return b"Content-Length: %d\r\n\r\n" % len(body) + body


def read_message(proc: subprocess.Popen, deadline: float) -> dict | None:
    buf = b""
    assert proc.stdout is not None
    fd = proc.stdout.fileno()

    def read_some() -> bool:
        nonlocal buf
        left = deadline - time.monotonic()
        if left <= 0:
            return False
        ready, _, _ = select.select([fd], [], [], left)
        if not ready:
            return False
        chunk = os.read(fd, 65536)
        if not chunk:
            return False
        buf += chunk
        return True

    while True:
        while b"\r\n\r\n" not in buf:
            if not read_some():
                return None
        head, rest = buf.split(b"\r\n\r\n", 1)
        length = None
        for line in head.decode("ascii", "replace").split("\r\n"):
            if line.lower().startswith("content-length:"):
                length = int(line.split(":", 1)[1].strip())
        if length is None:
            return None
        while len(rest) < length:
            buf = rest
            if not read_some():
                return None
            rest = buf
        body, buf = rest[:length], rest[length:]
        return json.loads(body)


def smoke(name: str, spec: dict, bin_dir: str, root_uri: str) -> str | None:
    cmd = [os.path.join(bin_dir, spec["command"]), *spec.get("args", [])]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError as e:
        return f"cannot start {cmd[0]}: {e}"
    assert proc.stdin is not None and proc.stdout is not None
    try:
        proc.stdin.write(frame({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"processId": os.getpid(), "rootUri": root_uri, "capabilities": {}},
        }))
        proc.stdin.flush()
        deadline = time.monotonic() + TIMEOUT
        while True:
            msg = read_message(proc, deadline)
            if msg is None:
                return f"no initialize reply within {TIMEOUT:.0f}s (exit={proc.poll()})"
            if msg.get("id") == 1:
                if "capabilities" not in (msg.get("result") or {}):
                    return f"initialize reply has no result.capabilities: {json.dumps(msg)[:200]}"
                break
            # server-to-client requests/notifications (window/logMessage, etc.) are skipped
        proc.stdin.write(frame({"jsonrpc": "2.0", "id": 2, "method": "shutdown"}))
        proc.stdin.write(frame({"jsonrpc": "2.0", "method": "exit"}))
        proc.stdin.flush()
        return None
    finally:
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def main() -> int:
    plugin_dir, bin_dir = sys.argv[1], sys.argv[2]
    with open(os.path.join(plugin_dir, ".lsp.json")) as f:
        lsp = json.load(f)
    root_uri = "file://" + os.path.abspath(plugin_dir)
    failed = 0
    for name, spec in lsp.items():
        t0 = time.monotonic()
        err = smoke(name, spec, bin_dir, root_uri)
        dt = time.monotonic() - t0
        if err:
            failed += 1
            print(f"FAIL {name:9} {spec['command']}: {err}")
        else:
            print(f"ok   {name:9} {spec['command']} ({dt:.1f}s)")
    print(f"{len(lsp) - failed}/{len(lsp)} servers answered initialize")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
