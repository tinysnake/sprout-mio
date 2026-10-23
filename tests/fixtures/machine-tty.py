import os
import pty
import select
import subprocess
import sys
import termios
import time

with open(sys.argv[1], "rb") as handle:
    ticket = handle.read().strip()
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
output = b""
sent = False
deadline = time.monotonic() + 20
try:
    while child.poll() is None and time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if not ready:
            continue
        try:
            chunk = os.read(master, 8192)
        except OSError:
            break
        output += chunk
        if not sent and b"(hidden):" in output:
            assert not termios.tcgetattr(slave)[3] & termios.ECHO, "ticket input disables terminal echo"
            os.write(master, ticket + b"\n")
            sent = True
    child.wait(timeout=3)
    assert child.returncode == 0, "hidden init exits successfully"
    assert sent and ticket not in output, "ticket never appears in PTY transcript"
    print("PASS hidden ticket input with terminal echo disabled")
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
    os.close(slave)
