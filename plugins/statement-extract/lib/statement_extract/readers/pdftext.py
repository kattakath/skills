"""PDF text-layer reader: poppler's `pdftotext -layout`, as an external binary.

Behind this small interface so another backend (e.g. transtractor) can plug in later without
touching drivers. A `*.layout.txt` input is taken as already-extracted text: that is how the
synthetic fixtures are written, so the test suite needs no PDF and no poppler.
"""
import hashlib
import shutil
import subprocess
import tempfile
from pathlib import Path

from ..model import Exit, Refusal

LAYOUT_SUFFIX = ".layout.txt"
MIN_CHARS = 500  # below this a "PDF" is a scan with no text layer, not a statement
_cache: dict[str, str] = {}


def is_pdf(raw: bytes) -> bool:
    return raw[:5] == b"%PDF-"


def backend_version() -> str | None:
    exe = shutil.which("pdftotext")
    if not exe:
        return None
    p = subprocess.run([exe, "-v"], capture_output=True, text=True)
    first = (p.stderr or p.stdout).splitlines()[:1]
    return first[0].strip() if first else "pdftotext"


def text_of(path: Path | None, raw: bytes) -> str:
    """-> layout text. Raises Refusal if it cannot be read as a statement."""
    key = hashlib.sha256(raw).hexdigest()
    if key in _cache:
        return _cache[key]
    if is_pdf(raw):
        exe = shutil.which("pdftotext")
        if not exe:
            raise Refusal(Exit.USAGE, "pdftotext (poppler) is not on PATH; PDF adapters need it")
        # The exact invocation the legacy extractors used, so their keys see the same text.
        if path is not None:
            p = subprocess.run([exe, "-layout", str(path), "-"], capture_output=True)
        else:
            with tempfile.NamedTemporaryFile(suffix=".pdf") as tmp:
                tmp.write(raw)
                tmp.flush()
                p = subprocess.run([exe, "-layout", tmp.name, "-"], capture_output=True)
        if p.returncode != 0:
            raise Refusal(Exit.REFUSED, f"pdftotext failed (exit {p.returncode})")
        text = p.stdout.decode("utf-8", "replace")
    elif path is not None and path.name.endswith(LAYOUT_SUFFIX):
        text = raw.decode("utf-8")
    else:
        raise Refusal(Exit.UNIDENTIFIED, "not a PDF")
    if len(text.strip()) < MIN_CHARS:
        raise Refusal(Exit.REFUSED, f"only {len(text.strip())} chars of text: a scan, not a "
                      "statement with a text layer")
    _cache[key] = text
    return text


def maybe_text(path: Path | None, raw: bytes) -> str | None:
    """For identify: the text, or None when this is not a readable text-layer statement."""
    if not (is_pdf(raw) or (path is not None and path.name.endswith(LAYOUT_SUFFIX))):
        return None
    try:
        return text_of(path, raw)
    except Refusal:
        return None
