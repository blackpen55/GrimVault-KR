import ctypes
from ctypes import wintypes

import mss
import numpy as np

user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi

DWMWA_EXTENDED_FRAME_BOUNDS = 9


def _find_game_window():
    candidates = []

    def callback(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True

        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True

        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)

        if "Dark and Darker" in title.value:
            candidates.append(hwnd)
            return False

        return True

    enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(callback)
    user32.EnumWindows(enum_proc, 0)
    return candidates[0] if candidates else None


def _window_rect(hwnd):
    rect = wintypes.RECT()

    try:
        result = dwmapi.DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            ctypes.byref(rect),
            ctypes.sizeof(rect),
        )
        if result == 0:
            return rect.left, rect.top, rect.right, rect.bottom
    except Exception:
        pass

    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None

    return rect.left, rect.top, rect.right, rect.bottom


def capture_game_window():
    hwnd = _find_game_window()

    if not hwnd:
        return None, None

    rect = _window_rect(hwnd)
    if not rect:
        return None, None

    left, top, right, bottom = rect
    width = max(0, right - left)
    height = max(0, bottom - top)

    if width <= 0 or height <= 0:
        return None, None

    with mss.mss() as sct:
        image = sct.grab({
            "left": left,
            "top": top,
            "width": width,
            "height": height,
        })

    frame = np.array(image)[:, :, :3]

    return frame, {
        "x": left,
        "y": top,
        "width": width,
        "height": height,
    }
