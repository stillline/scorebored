#!/usr/bin/env python3
"""Relay UDP port 9910 broadcasts between wlan0 (10.42.0.1) and end0 (10.42.0.2).
Allows WiFi clients to discover and control the ATEM Mini Pro ISO without a bridge.
"""
import socket, threading, time

WLAN_IP = "10.42.0.1"   # Pi IP on wlan0 (WiFi AP)
END_IP  = "10.42.0.2"   # Pi IP on end0 (ATEM ethernet)
BCAST   = "10.42.0.255"
PORT    = 9910

def make_recv_sock(bind_ip):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.bind((bind_ip, PORT))
    return s

def make_send_sock(src_ip):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.bind((src_ip, 0))  # bind to specific interface, random port
    return s

def relay(recv_ip, send_ip, name):
    recv = make_recv_sock(recv_ip)
    send = make_send_sock(send_ip)
    print(f"[{name}] recv={recv_ip}:{PORT} fwd={send_ip}->{BCAST}:{PORT}")
    while True:
        try:
            data, (src_ip, _) = recv.recvfrom(65535)
            if src_ip == send_ip:   # drop our own relayed packets (loop prevention)
                continue
            send.sendto(data, (BCAST, PORT))
        except Exception as e:
            print(f"[{name}] error: {e}")
            time.sleep(1)

if __name__ == "__main__":
    threading.Thread(target=relay, args=(WLAN_IP, END_IP, "wifi->atem"), daemon=True).start()
    threading.Thread(target=relay, args=(END_IP, WLAN_IP, "atem->wifi"), daemon=True).start()
    print("ATEM discovery relay running (wifi<->atem)")
    threading.Event().wait()
