#!/usr/bin/env python3
"""
black-cover.py
Fullscreen always-on-top black window used to hide the desktop
during scoreboard startup. Kill this process once Chromium has painted.
"""
import tkinter as tk
import os

root = tk.Tk()
root.configure(bg='black')
root.attributes('-fullscreen', True)
root.attributes('-topmost', True)
root.overrideredirect(True)
root.title('cover')

# Write PID so launch-display.sh can kill us cleanly
with open('/tmp/cover-window.pid', 'w') as f:
    f.write(str(os.getpid()))

root.mainloop()
