"""A minimal RFC 6455 WebSocket client on the standard library.

Python ships no WebSocket client, so this module hand-rolls the client side:
handshake, masking, framing, fragmentation, ping/pong and close. It is the
only module in the library that touches a socket; swapping in ``websockets``
later means replacing this file and nothing else.

The API is deliberately small and blocking. ``PodiumClient`` drives it from a
reader thread.
"""

from __future__ import annotations

import base64
import hashlib
import os
import socket
import ssl
import struct
from dataclasses import dataclass
from typing import Optional, Tuple
from urllib.parse import urlparse

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class WebSocketError(Exception):
    """The handshake failed or the peer sent something the protocol forbids."""


class ConnectionClosed(Exception):
    """The connection is gone. ``code`` is the close code when the peer sent one."""

    def __init__(self, code: Optional[int] = None, reason: str = ""):
        super().__init__(f"connection closed ({code}) {reason}".strip())
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class Message:
    """One complete data message, reassembled from fragments if needed."""

    opcode: int
    data: bytes

    @property
    def text(self) -> str:
        return self.data.decode("utf-8")


class WebSocket:
    """One client connection. Not thread-safe for concurrent sends; the
    client serialises writes with a lock."""

    def __init__(self, url: str, connect_timeout: float = 10.0, recv_timeout: float = 1.0):
        parsed = urlparse(url)
        if parsed.scheme not in ("ws", "wss"):
            raise ValueError(f"unsupported scheme {parsed.scheme!r}; use ws:// or wss://")
        self.url = url
        self.secure = parsed.scheme == "wss"
        self.host = parsed.hostname or "localhost"
        self.port = parsed.port or (443 if self.secure else 80)
        self.resource = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
        self.connect_timeout = connect_timeout
        self.recv_timeout = recv_timeout
        self._sock: Optional[socket.socket] = None
        self._buffer = b""
        self._fragments: list = []
        self._fragment_opcode: Optional[int] = None

    # --- lifecycle ---

    def connect(self) -> None:
        raw = socket.create_connection((self.host, self.port), timeout=self.connect_timeout)
        raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        if self.secure:
            context = ssl.create_default_context()
            raw = context.wrap_socket(raw, server_hostname=self.host)
        self._sock = raw
        try:
            self._handshake()
        except Exception:
            self._close_socket()
            raise
        raw.settimeout(self.recv_timeout)

    def _handshake(self) -> None:
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_header = self.host if self.port in (80, 443) else f"{self.host}:{self.port}"
        request = (
            f"GET {self.resource} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "User-Agent: podium-python-client/1\r\n"
            "\r\n"
        )
        self._send_all(request.encode("ascii"))

        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self._sock.recv(4096)  # type: ignore[union-attr]
            if not chunk:
                raise WebSocketError("connection closed during handshake")
            head += chunk
            if len(head) > 65536:
                raise WebSocketError("handshake response too large")
        head, _, rest = head.partition(b"\r\n\r\n")
        self._buffer = rest

        lines = head.decode("iso-8859-1").split("\r\n")
        status = lines[0].split(" ", 2)
        if len(status) < 2 or status[1] != "101":
            raise WebSocketError(f"handshake refused: {lines[0]}")
        headers = {}
        for line in lines[1:]:
            name, _, value = line.partition(":")
            headers[name.strip().lower()] = value.strip()
        expected = base64.b64encode(hashlib.sha1((key + _GUID).encode("ascii")).digest()).decode("ascii")
        if headers.get("sec-websocket-accept") != expected:
            raise WebSocketError("handshake accept key mismatch")

    def close(self, code: int = 1000, reason: str = "") -> None:
        if self._sock is None:
            return
        try:
            payload = struct.pack("!H", code) + reason.encode("utf-8")
            self._send_frame(OP_CLOSE, payload)
        except OSError:
            pass
        self._close_socket()

    def _close_socket(self) -> None:
        sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    @property
    def connected(self) -> bool:
        return self._sock is not None

    # --- sending ---

    def send_text(self, text: str) -> None:
        self._send_frame(OP_TEXT, text.encode("utf-8"))

    def ping(self, payload: bytes = b"") -> None:
        self._send_frame(OP_PING, payload)

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self._sock is None:
            raise ConnectionClosed(None, "not connected")
        header = bytes([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header += bytes([0x80 | length])
        elif length < 65536:
            header += bytes([0x80 | 126]) + struct.pack("!H", length)
        else:
            header += bytes([0x80 | 127]) + struct.pack("!Q", length)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self._send_all(header + mask + masked)

    def _send_all(self, data: bytes) -> None:
        if self._sock is None:
            raise ConnectionClosed(None, "not connected")
        try:
            self._sock.sendall(data)
        except OSError as exc:
            self._close_socket()
            raise ConnectionClosed(None, str(exc)) from exc

    # --- receiving ---

    def recv(self) -> Optional[Message]:
        """The next complete data message, or ``None`` if nothing arrived
        within ``recv_timeout``. Control frames are handled here: pings are
        answered, pongs dropped, a close is echoed and raised."""
        while True:
            frame = self._take_frame()
            if frame is None:
                # Nothing complete buffered yet. Reading is the only place a
                # timeout may surface, because `_take_frame` never consumes a
                # partial frame — a message split across the timeout must
                # resume mid-buffer, not restart mid-frame.
                if not self._fill():
                    return None
                continue
            fin, opcode, payload = frame
            if opcode == OP_PING:
                self._send_frame(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else None
                reason = payload[2:].decode("utf-8", "replace")
                try:
                    self._send_frame(OP_CLOSE, payload[:2])
                except (OSError, ConnectionClosed):
                    pass
                self._close_socket()
                raise ConnectionClosed(code, reason)
            if opcode in (OP_TEXT, OP_BINARY):
                if not fin:
                    self._fragment_opcode = opcode
                    self._fragments = [payload]
                    continue
                return Message(opcode, payload)
            if opcode == OP_CONT:
                if self._fragment_opcode is None:
                    raise WebSocketError("continuation frame without a start")
                self._fragments.append(payload)
                if fin:
                    message = Message(self._fragment_opcode, b"".join(self._fragments))
                    self._fragments = []
                    self._fragment_opcode = None
                    return message
                continue
            raise WebSocketError(f"unknown opcode {opcode:#x}")

    def _take_frame(self) -> Optional[Tuple[bool, int, bytes]]:
        """One whole frame off the front of the buffer, or ``None`` when the
        buffer doesn't hold a complete one yet.

        Nothing is consumed unless a full frame is there, so a frame that
        arrives in pieces — across TCP segments or across a recv timeout —
        is picked up where it left off instead of being re-parsed from its
        own payload.
        """
        buf = self._buffer
        if len(buf) < 2:
            return None
        fin = bool(buf[0] & 0x80)
        opcode = buf[0] & 0x0F
        masked = bool(buf[1] & 0x80)
        length = buf[1] & 0x7F
        offset = 2

        if length == 126:
            if len(buf) < offset + 2:
                return None
            length = struct.unpack("!H", buf[offset : offset + 2])[0]
            offset += 2
        elif length == 127:
            if len(buf) < offset + 8:
                return None
            length = struct.unpack("!Q", buf[offset : offset + 8])[0]
            offset += 8

        mask = None
        if masked:
            if len(buf) < offset + 4:
                return None
            mask = buf[offset : offset + 4]
            offset += 4

        if len(buf) < offset + length:
            return None

        payload = buf[offset : offset + length]
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self._buffer = buf[offset + length :]
        return fin, opcode, payload

    def _fill(self) -> bool:
        """Read once into the buffer. False on timeout (nothing arrived)."""
        if self._sock is None:
            raise ConnectionClosed(None, "not connected")
        try:
            chunk = self._sock.recv(65536)
        except socket.timeout:
            return False
        except OSError as exc:
            self._close_socket()
            raise ConnectionClosed(None, str(exc)) from exc
        if not chunk:
            self._close_socket()
            raise ConnectionClosed(None, "peer went away")
        self._buffer += chunk
        return True

