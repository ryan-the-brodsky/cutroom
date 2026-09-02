"""Per-shot reference images — "make it look like THIS one".

The style register (cutroom/style.py) answers "what does the film look like".
It cannot answer "who is this person", "which mug is on the desk", or "what
room is this". Those are per-shot facts, and until now there was nowhere to
put them: `override.refs` existed as a list of bare paths that nothing read.

A reference is now `{path, role, note?}` where role is one of

    character | prop | setting | style

and each role carries the sentence that goes in front of the image when the
request is built. The sentence matters as much as the picture: a bare image
attached to a chat-completion image model is read as "content to copy", which
is right for a setting and wrong for a face.

Plain strings from the old shape migrate to `{path, role: "character"}` at
read time, so nothing has to be rewritten in the database first.
"""
from __future__ import annotations

import ipaddress
import re
import socket
from pathlib import Path
from urllib.parse import urlparse

ROLES = ("character", "prop", "setting", "style")
DEFAULT_ROLE = "character"

#: What each role asks the model to take from the image. Attached as a text
#: part immediately before the image itself.
ROLE_SENTENCE = {
    "character": ("Reference for the CHARACTER: match this face, hair, build "
                  "and costume exactly."),
    "prop": ("Reference for the PROP: match this object's shape, colour and "
             "markings."),
    "setting": ("Reference for the SETTING: match this place's architecture, "
                "layout and light."),
    "style": ("Reference for the STYLE: match line, shading and palette; do "
              "not copy content."),
}

#: Four is the cap the style register already uses, and the point past which
#: Gemini-class models start averaging the references instead of reading them.
MAX_REFS = 4

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")

#: Where a fetched reference lands, project-relative.
REF_DIR = "refs"

MAX_FETCH_BYTES = 10 * 1024 * 1024
FETCH_TIMEOUT = 10.0


class RefError(ValueError):
    """A reference could not be accepted (bad url, bad host, bad content)."""


def role_of(raw) -> str:
    r = str(raw or "").strip().lower()
    if r in ("place", "location", "background", "environment"):
        r = "setting"
    if r in ("object", "item"):
        r = "prop"
    if r in ("person", "face", "costume", "cast"):
        r = "character"
    return r if r in ROLES else DEFAULT_ROLE


def normalize_one(raw) -> dict | None:
    """One entry, in either shape, as `{path, role, note?}`. None if unusable."""
    if isinstance(raw, str):
        path = raw.strip().lstrip("/")
        return {"path": path, "role": DEFAULT_ROLE} if path else None
    if isinstance(raw, dict):
        path = str(raw.get("path") or raw.get("image") or "").strip().lstrip("/")
        if not path or ".." in path:
            return None
        out = {"path": path, "role": role_of(raw.get("role"))}
        note = str(raw.get("note") or "").strip()
        if note:
            out["note"] = note[:200]
        return out
    return None


def normalize(raw) -> list[dict]:
    """A whole refs list, migrated and de-duplicated, newest wins, capped."""
    rows: list[dict] = []
    seen: set[str] = set()
    for item in (raw or []) if isinstance(raw, (list, tuple)) else []:
        row = normalize_one(item)
        if not row or row["path"] in seen:
            continue
        seen.add(row["path"])
        rows.append(row)
    return rows[:MAX_REFS]


def resolve_rows(store, references) -> list[tuple[Path, dict]]:
    """`[(absolute path, row)]` for the references that actually exist.

    Missing files are skipped, never fatal: a reference the director deleted
    must not be able to stop a render, exactly as with style frames.
    """
    out: list[tuple[Path, dict]] = []
    for row in normalize(references):
        try:
            p = Path(store.resolve(row["path"]))
        except Exception:
            continue
        if p.exists() and p.is_file():
            out.append((p, row))
        if len(out) >= MAX_REFS:
            break
    return out


def resolve(store, references) -> list[tuple[Path, str]]:
    """`[(absolute path, role)]` — what an adapter attaches."""
    return [(p, row["role"]) for p, row in resolve_rows(store, references)]


def merge(existing, extra) -> list[dict]:
    """Shot references first, then a call's one-off ones, capped at MAX_REFS."""
    return normalize([*normalize(existing), *normalize(extra)])


def summary(references) -> list[dict]:
    """What goes on the Take as `references_used`: path + role, nothing else."""
    return [{"path": r["path"], "role": r["role"]} for r in normalize(references)]


# ------------------------------------------------------------------- fetching

def _is_private(host: str) -> bool:
    """True when a hostname resolves anywhere we must not fetch from.

    The threat is a caller handing the server a url that points back at the
    box it runs on (169.254.169.254, 127.0.0.1, a 10.x neighbour). Resolve
    first, judge the addresses, and refuse if ANY of them is private.
    """
    if not host:
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return True
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr.split("%")[0])
        except ValueError:
            return True
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return True
    return False


def check_url(url: str) -> str:
    """Validate a reference url before any bytes move. Raises RefError."""
    u = str(url or "").strip()
    if not u:
        raise RefError("need a url")
    parsed = urlparse(u)
    if parsed.scheme not in ("http", "https"):
        raise RefError("only http(s) urls can be fetched")
    if not parsed.hostname:
        raise RefError("that url has no host")
    if _is_private(parsed.hostname):
        raise RefError("that host is on a private network — upload the file "
                       "instead")
    return u


def filename_for(url: str, content_type: str = "") -> str:
    """A safe, extensioned file name for a fetched reference."""
    tail = Path(urlparse(url).path).name
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", tail)[:60].strip("._-")
    ext = Path(safe).suffix.lower()
    if ext not in IMAGE_EXTS:
        sub = (content_type or "").split(";")[0].strip().lower()
        ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg",
               "image/webp": ".webp", "image/gif": ".gif"}.get(sub, ".png")
        safe = (Path(safe).stem or "reference") + ext
    return safe


def check_response(content_type: str, length: int | None) -> None:
    """Content-type and size, judged before the body is written anywhere."""
    sub = (content_type or "").split(";")[0].strip().lower()
    if not sub.startswith("image/"):
        raise RefError(f"that url is {sub or 'not an image'}, not an image")
    if sub in ("image/svg+xml",):
        raise RefError("svg cannot be used as a reference — send a raster image")
    if length is not None and length > MAX_FETCH_BYTES:
        raise RefError("that image is over 10 MB")


async def fetch(url: str) -> tuple[bytes, str]:
    """Download an http(s) image. Returns (bytes, filename). Raises RefError."""
    import httpx

    u = check_url(url)
    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT,
                                     follow_redirects=True) as c:
            async with c.stream("GET", u) as r:
                if r.status_code != 200:
                    raise RefError(f"fetch failed [{r.status_code}]")
                ctype = r.headers.get("content-type", "")
                declared = r.headers.get("content-length")
                check_response(ctype, int(declared) if declared and
                               declared.isdigit() else None)
                # Redirects can land somewhere private; judge the final host too.
                final = str(r.url)
                if _is_private(urlparse(final).hostname or ""):
                    raise RefError("that url redirects onto a private network")
                buf = bytearray()
                async for chunk in r.aiter_bytes():
                    buf.extend(chunk)
                    if len(buf) > MAX_FETCH_BYTES:
                        raise RefError("that image is over 10 MB")
    except RefError:
        raise
    except Exception as e:                      # network, dns, timeout
        raise RefError(f"could not fetch that url: {str(e)[:120]}") from e
    if len(buf) < 100:
        raise RefError("that url returned an empty image")
    return bytes(buf), filename_for(u, ctype)
