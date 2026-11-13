"""Loopback-only fake SOCKS5 + IMAP server for tests/himalaya-wire-cases.sh.

The SOCKS side accepts one CONNECT per session and then plays the IMAP server itself, so
nothing ever leaves 127.0.0.1. Every IMAP command line is appended to the log (a SASL
payload is redacted), which is how the test sees exactly what himalaya sent.
Usage: python3 -I fake-imap.py <log-file> <ports-file>   (ports-file gets "socks imap")
"""
import re, socket, struct, sys, threading

log_path = sys.argv[1]
ports_path = sys.argv[2]
MSG = (b"From: Bob <bob@example.net>\r\nTo: alice@example.com\r\nSubject: hello probe\r\n"
       b"Date: Thu, 12 Nov 2026 10:00:00 +0000\r\nMessage-ID: <m1@example.net>\r\n\r\nbody text\r\n")
lock = threading.Lock()

def log(s):
    with lock, open(log_path, "a") as f:
        f.write(s + "\n")

def imap_session(c):
    f = c.makefile("rb")
    c.sendall(b"* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR UIDPLUS MOVE] fake ready\r\n")
    while True:
        line = f.readline()
        if not line:
            return
        text = line.decode(errors="replace").rstrip("\r\n")
        # never log the SASL payload
        log("IMAP> " + re.sub(r"(AUTHENTICATE PLAIN) \S+", r"\1 <redacted>", text, flags=re.I))
        parts = text.split(" ", 2)
        tag = parts[0]
        cmd = (parts[1] if len(parts) > 1 else "").upper()
        rest = parts[2] if len(parts) > 2 else ""
        if cmd == "UID" and rest:
            sub, _, rest2 = rest.partition(" ")
            cmd = "UID " + sub.upper()
            rest = rest2
        out = b""
        if cmd == "CAPABILITY":
            out += b"* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR UIDPLUS MOVE\r\n"
        elif cmd == "AUTHENTICATE":
            if "PLAIN" in rest.upper() and len(rest.split()) == 1:
                c.sendall(b"+ \r\n"); f.readline()
            out += b""
        elif cmd == "ID":
            out += b"* ID NIL\r\n"
        elif cmd in ("SELECT", "EXAMINE"):
            out += (b"* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n"
                    b"* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 2] ok\r\n")
        elif cmd == "LIST":
            out += b'* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Junk) "/" "[Gmail]/Spam"\r\n'
        elif cmd in ("UID SEARCH", "SEARCH"):
            out += b"* SEARCH 1\r\n"
        elif cmd in ("UID SORT", "SORT"):
            out += b"* SORT 1\r\n"
        elif cmd in ("FETCH", "UID FETCH"):
            items = rest.upper()
            parts_out = [b"UID 1", b"FLAGS ()"]
            if "ENVELOPE" in items:
                parts_out.append(b'ENVELOPE ("Thu, 12 Nov 2026 10:00:00 +0000" "hello probe" (("Bob" NIL "bob" "example.net")) NIL NIL (("Alice" NIL "alice" "example.com")) NIL NIL NIL "<m1@example.net>")')
            if "INTERNALDATE" in items:
                parts_out.append(b'INTERNALDATE "12-Nov-2026 10:00:00 +0000"')
            if "RFC822.SIZE" in items:
                parts_out.append(b"RFC822.SIZE %d" % len(MSG))
            if "BODYSTRUCTURE" in items:
                parts_out.append(b'BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 11 1)')
            m = re.search(r"(BODY(?:\.PEEK)?\[[^\]]*\]|RFC822(?:\.HEADER|\.TEXT)?)(?=[\s)]|$)", items)
            if m:
                name = m.group(1).replace(".PEEK", "")
                data = MSG.split(b"\r\n\r\n")[0] + b"\r\n\r\n" if "HEADER" in name else MSG
                parts_out.append(name.encode() + b" {%d}\r\n" % len(data) + data)
            out += b"* 1 FETCH (" + b" ".join(parts_out) + b")\r\n"
        elif cmd == "LOGOUT":
            c.sendall(b"* BYE bye\r\n" + tag.encode() + b" OK done\r\n"); return
        c.sendall(out + tag.encode() + b" OK done\r\n")

def socks_session(c, imap_port):
    g = c.recv(2); c.recv(g[1])
    c.sendall(b"\x05\x00")
    req = c.recv(262)
    atyp = req[3]
    if atyp == 3:
        n = req[4]; host = req[5:5 + n].decode(); port = struct.unpack(">H", req[5 + n:7 + n])[0]
    elif atyp == 1:
        host = socket.inet_ntoa(req[4:8]); port = struct.unpack(">H", req[8:10])[0]
    else:
        host = "v6"; port = 0
    log(f"SOCKS CONNECT {host}:{port} (atyp={atyp})")
    c.sendall(b"\x05\x00\x00\x01\x7f\x00\x00\x01" + struct.pack(">H", imap_port))
    imap_session(c)

def guarded(fn, c):
    # A bare connect-and-close (egress-check's port probe) must not crash the fake.
    try:
        fn(c)
    except (IndexError, OSError, struct.error):
        pass
    finally:
        c.close()

def serve(sock, fn):
    while True:
        c, _ = sock.accept()
        threading.Thread(target=guarded, args=(fn, c), daemon=True).start()

imap = socket.socket(); imap.bind(("127.0.0.1", 0)); imap.listen(8)
socks = socket.socket(); socks.bind(("127.0.0.1", 0)); socks.listen(8)
ip, sp = imap.getsockname()[1], socks.getsockname()[1]
threading.Thread(target=serve, args=(imap, imap_session), daemon=True).start()
open(ports_path, "w").write(f"{sp} {ip}\n")
serve(socks, lambda c: socks_session(c, ip))
