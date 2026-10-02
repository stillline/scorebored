"""RFC 6455 conformance for the hand-rolled transport.

Python has no WebSocket client in the standard library, so `transport.py`
implements the client half itself. These tests drive it against a real
loopback server that speaks the server half — a genuine TCP connection, a
genuine handshake, genuine frames — because the rest of the suite injects a
fake socket and never touches this code.
"""

import base64
import hashlib
import socket
import struct
import threading
import unittest

from podium.transport import (
    OP_BINARY,
    OP_CLOSE,
    OP_CONT,
    OP_PING,
    OP_PONG,
    OP_TEXT,
    ConnectionClosed,
    WebSocket,
    WebSocketError,
)

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def server_frame(opcode: int, payload: bytes, fin: bool = True) -> bytes:
    """A server→client frame. Servers never mask (RFC 6455 §5.1)."""
    first = (0x80 if fin else 0x00) | opcode
    length = len(payload)
    if length < 126:
        header = bytes([first, length])
    elif length < 65536:
        header = bytes([first, 126]) + struct.pack("!H", length)
    else:
        header = bytes([first, 127]) + struct.pack("!Q", length)
    return header + payload


class Loopback:
    """A one-connection WebSocket server on 127.0.0.1.

    The reader thread parses whatever the client sends into `inbox`; tests
    push frames from their own thread with `send`.
    """

    def __init__(self, handshake: str = None, fail_accept: bool = False):
        self._listener = socket.socket()
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(1)
        self.port = self._listener.getsockname()[1]
        self.request = b""
        self.inbox = []
        self.inbox_ready = threading.Event()
        self.conn = None
        self._handshake = handshake
        self._fail_accept = fail_accept
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/api/v1/stream?key=pk_test"

    def _serve(self):
        try:
            conn, _ = self._listener.accept()
        except OSError:
            return
        self.conn = conn

        while b"\r\n\r\n" not in self.request:
            chunk = conn.recv(4096)
            if not chunk:
                return
            self.request += chunk

        if self._handshake is not None:
            conn.sendall(self._handshake.encode("ascii"))
            return

        key = ""
        for line in self.request.decode("iso-8859-1").split("\r\n"):
            name, _, value = line.partition(":")
            if name.strip().lower() == "sec-websocket-key":
                key = value.strip()
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        if self._fail_accept:
            accept = base64.b64encode(b"x" * 20).decode()
        conn.sendall(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            ).encode("ascii")
        )

        buf = b""
        while not self._stop.is_set():
            try:
                chunk = conn.recv(65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while True:
                parsed = self._parse(buf)
                if parsed is None:
                    break
                frame, buf = parsed
                self.inbox.append(frame)
                self.inbox_ready.set()

    @staticmethod
    def _parse(buf):
        """One client→server frame, or None if incomplete. Client frames must be masked."""
        if len(buf) < 2:
            return None
        fin = bool(buf[0] & 0x80)
        opcode = buf[0] & 0x0F
        masked = bool(buf[1] & 0x80)
        length = buf[1] & 0x7F
        offset = 2
        if length == 126:
            if len(buf) < 4:
                return None
            length = struct.unpack("!H", buf[2:4])[0]
            offset = 4
        elif length == 127:
            if len(buf) < 10:
                return None
            length = struct.unpack("!Q", buf[2:10])[0]
            offset = 10
        if not masked:
            raise AssertionError("client frame was not masked — RFC 6455 §5.1 requires it")
        if len(buf) < offset + 4 + length:
            return None
        mask = buf[offset : offset + 4]
        offset += 4
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(buf[offset : offset + length]))
        return (fin, opcode, payload), buf[offset + length :]

    def wait_for_frame(self, timeout=3.0):
        deadline = threading.Event()
        end = threading.Timer(timeout, deadline.set)
        end.start()
        try:
            while not self.inbox and not deadline.is_set():
                self.inbox_ready.wait(0.05)
                self.inbox_ready.clear()
            return self.inbox.pop(0) if self.inbox else None
        finally:
            end.cancel()

    def send(self, data: bytes):
        self.conn.sendall(data)

    def send_text(self, text: str, fin=True):
        self.send(server_frame(OP_TEXT, text.encode("utf-8"), fin))

    def hang_up(self):
        # Shut down before closing: the reader thread is blocked in recv() on
        # this socket, and on Linux close() alone neither wakes it nor sends
        # the FIN, so the client would never see the peer go away.
        try:
            self.conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.conn.close()
        except OSError:
            pass

    def stop(self):
        self._stop.set()
        try:
            self._listener.close()
        except OSError:
            pass
        self.hang_up()


class HandshakeTest(unittest.TestCase):
    def test_sends_a_conforming_upgrade_request(self):
        server = Loopback()
        self.addCleanup(server.stop)
        ws = WebSocket(server.url, recv_timeout=0.2)
        ws.connect()
        self.addCleanup(ws.close)

        request = server.request.decode("iso-8859-1")
        head = request.split("\r\n")[0]
        headers = {}
        for line in request.split("\r\n")[1:]:
            name, _, value = line.partition(":")
            if name:
                headers[name.strip().lower()] = value.strip()

        # The path and query must survive intact — the API key rides in the query.
        self.assertEqual(head, "GET /api/v1/stream?key=pk_test HTTP/1.1")
        self.assertEqual(headers["upgrade"], "websocket")
        self.assertEqual(headers["connection"], "Upgrade")
        self.assertEqual(headers["sec-websocket-version"], "13")
        self.assertEqual(headers["host"], f"127.0.0.1:{server.port}")
        self.assertEqual(len(base64.b64decode(headers["sec-websocket-key"])), 16)
        self.assertTrue(ws.connected)

    def test_a_fresh_key_per_connection(self):
        keys = set()
        for _ in range(2):
            server = Loopback()
            self.addCleanup(server.stop)
            ws = WebSocket(server.url, recv_timeout=0.2)
            ws.connect()
            self.addCleanup(ws.close)
            for line in server.request.decode("iso-8859-1").split("\r\n"):
                name, _, value = line.partition(":")
                if name.strip().lower() == "sec-websocket-key":
                    keys.add(value.strip())
        self.assertEqual(len(keys), 2, "each connection must use a fresh nonce")

    def test_rejects_a_bad_accept_key(self):
        server = Loopback(fail_accept=True)
        self.addCleanup(server.stop)
        ws = WebSocket(server.url, recv_timeout=0.2)
        with self.assertRaises(WebSocketError) as raised:
            ws.connect()
        self.assertIn("accept key", str(raised.exception))
        self.assertFalse(ws.connected)

    def test_rejects_a_non_101_response(self):
        server = Loopback(handshake="HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
        self.addCleanup(server.stop)
        ws = WebSocket(server.url, recv_timeout=0.2)
        with self.assertRaises(WebSocketError) as raised:
            ws.connect()
        self.assertIn("403", str(raised.exception))

    def test_rejects_a_bad_scheme(self):
        with self.assertRaises(ValueError):
            WebSocket("http://example.test/stream")


class FramingTest(unittest.TestCase):
    def setUp(self):
        self.server = Loopback()
        self.addCleanup(self.server.stop)
        self.ws = WebSocket(self.server.url, recv_timeout=0.25)
        self.ws.connect()
        self.addCleanup(self.ws.close)

    def test_client_frames_are_masked(self):
        self.ws.send_text("hello")
        fin, opcode, payload = self.server.wait_for_frame()
        # Loopback._parse raises if the MASK bit is clear, so arriving here
        # already proves masking; check the payload survived unmasking.
        self.assertTrue(fin)
        self.assertEqual(opcode, OP_TEXT)
        self.assertEqual(payload, b"hello")

    def test_round_trip_text(self):
        self.server.send_text('{"ok":true}')
        message = self.ws.recv()
        self.assertEqual(message.opcode, OP_TEXT)
        self.assertEqual(message.text, '{"ok":true}')

    def test_utf8_payloads_survive(self):
        self.server.send_text('{"name":"Sasquatch — 7:42 ▶"}')
        self.assertEqual(self.ws.recv().text, '{"name":"Sasquatch — 7:42 ▶"}')

    def test_recv_returns_none_when_nothing_arrives(self):
        self.assertIsNone(self.ws.recv())

    def test_reassembles_a_fragmented_message(self):
        self.server.send(server_frame(OP_TEXT, b'{"pu', fin=False))
        self.server.send(server_frame(OP_CONT, b'sh":"ga', fin=False))
        self.server.send(server_frame(OP_CONT, b'me"}', fin=True))
        self.assertEqual(self.ws.recv().text, '{"push":"game"}')

    def test_control_frames_interleaved_in_a_fragmented_message(self):
        # RFC 6455 §5.4: control frames may appear between fragments. The
        # reassembly buffer must survive them, and the ping must be answered.
        self.server.send(server_frame(OP_TEXT, b"frag-", fin=False))
        self.server.send(server_frame(OP_PING, b"beat"))
        self.server.send(server_frame(OP_CONT, b"mented", fin=True))

        self.assertEqual(self.ws.recv().text, "frag-mented")
        fin, opcode, payload = self.server.wait_for_frame()
        self.assertEqual((opcode, payload), (OP_PONG, b"beat"))

    def test_answers_a_ping_with_a_matching_pong(self):
        self.server.send(server_frame(OP_PING, b"ka"))
        self.assertIsNone(self.ws.recv())  # control frames aren't data
        fin, opcode, payload = self.server.wait_for_frame()
        self.assertEqual((opcode, payload), (OP_PONG, b"ka"))

    def test_ignores_an_unsolicited_pong(self):
        self.server.send(server_frame(OP_PONG, b"whatever"))
        self.assertIsNone(self.ws.recv())
        self.assertTrue(self.ws.connected)

    def test_sends_a_ping(self):
        self.ws.ping(b"hi")
        fin, opcode, payload = self.server.wait_for_frame()
        self.assertEqual((opcode, payload), (OP_PING, b"hi"))

    def test_extended_16_bit_length(self):
        payload = "x" * 1000
        self.server.send_text(payload)
        self.assertEqual(self.ws.recv().text, payload)

        self.ws.send_text(payload)
        _fin, _opcode, received = self.server.wait_for_frame()
        self.assertEqual(received.decode(), payload)

    def test_extended_64_bit_length(self):
        payload = "y" * 70000
        self.server.send_text(payload)
        self.assertEqual(self.ws.recv().text, payload)

        self.ws.send_text(payload)
        _fin, _opcode, received = self.server.wait_for_frame()
        self.assertEqual(len(received), 70000)

    def test_binary_frames_come_through(self):
        self.server.send(server_frame(OP_BINARY, b"\x00\x01\x02"))
        message = self.ws.recv()
        self.assertEqual((message.opcode, message.data), (OP_BINARY, b"\x00\x01\x02"))

    def test_a_message_split_across_tcp_reads(self):
        # Nagle and MTU mean a frame can arrive in pieces; the reader must wait.
        frame = server_frame(OP_TEXT, b"split-across-packets")
        self.server.send(frame[:3])
        self.assertIsNone(self.ws.recv())
        self.server.send(frame[3:])
        self.assertEqual(self.ws.recv().text, "split-across-packets")


class ClosingTest(unittest.TestCase):
    def setUp(self):
        self.server = Loopback()
        self.addCleanup(self.server.stop)
        self.ws = WebSocket(self.server.url, recv_timeout=0.25)
        self.ws.connect()
        self.addCleanup(self.ws.close)

    def test_a_close_frame_raises_and_is_echoed(self):
        self.server.send(server_frame(OP_CLOSE, struct.pack("!H", 1001) + b"going away"))

        with self.assertRaises(ConnectionClosed) as raised:
            self.ws.recv()
        self.assertEqual(raised.exception.code, 1001)
        self.assertEqual(raised.exception.reason, "going away")
        self.assertFalse(self.ws.connected)

        _fin, opcode, payload = self.server.wait_for_frame()
        self.assertEqual(opcode, OP_CLOSE)
        self.assertEqual(struct.unpack("!H", payload[:2])[0], 1001)

    def test_a_close_frame_with_no_payload(self):
        self.server.send(server_frame(OP_CLOSE, b""))
        with self.assertRaises(ConnectionClosed) as raised:
            self.ws.recv()
        self.assertIsNone(raised.exception.code)

    def test_a_peer_that_vanishes_raises(self):
        self.server.hang_up()
        with self.assertRaises(ConnectionClosed):
            for _ in range(20):
                self.ws.recv()
        self.assertFalse(self.ws.connected)

    def test_close_sends_a_close_frame(self):
        self.ws.close(1000, "done")
        _fin, opcode, payload = self.server.wait_for_frame()
        self.assertEqual(opcode, OP_CLOSE)
        self.assertEqual(struct.unpack("!H", payload[:2])[0], 1000)
        self.assertFalse(self.ws.connected)

    def test_close_is_idempotent(self):
        self.ws.close()
        self.ws.close()
        self.assertFalse(self.ws.connected)

    def test_sending_after_close_raises(self):
        self.ws.close()
        with self.assertRaises(ConnectionClosed):
            self.ws.send_text("too late")

    def test_sending_to_a_vanished_peer_raises(self):
        self.server.hang_up()
        with self.assertRaises(ConnectionClosed):
            for _ in range(50):
                self.ws.send_text("x" * 1000)


if __name__ == "__main__":
    unittest.main()
