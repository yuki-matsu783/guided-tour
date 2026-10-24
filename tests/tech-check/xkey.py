"""
Xvfb 上の Chrome に、X11 の XTEST で実際のキー入力を送る（技術検証 5 用）。
使い方: python3 -I xkey.py <x> <y> <keysym>...   先にポインタを (x, y) へ動かし、キーを順に押して逆順に離す。
"""
import ctypes
import sys
import time

x11 = ctypes.CDLL("libX11.so.6")
xtst = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]

dpy = x11.XOpenDisplay(None)
if not dpy:
    sys.exit("display を開けない")
x, y = int(sys.argv[1]), int(sys.argv[2])
codes = []
for name in sys.argv[3:]:
    sym = x11.XStringToKeysym(name.encode())
    code = x11.XKeysymToKeycode(dpy, sym)
    if code == 0:
        sys.exit("keysym が見つからない: " + name)
    codes.append(code)
xtst.XTestFakeMotionEvent(dpy, -1, x, y, 0)
x11.XFlush(dpy)
time.sleep(0.2)
for c in codes:
    xtst.XTestFakeKeyEvent(dpy, c, 1, 0)
    x11.XFlush(dpy)
    time.sleep(0.05)
for c in reversed(codes):
    xtst.XTestFakeKeyEvent(dpy, c, 0, 0)
    x11.XFlush(dpy)
    time.sleep(0.05)
x11.XFlush(dpy)
