"""An OS lease held until the owning worker closes its private stdin pipe.

No TTL, stale-PID deletion, or removal/replacement of the lease inode.
"""
from __future__ import annotations

import os
from pathlib import Path
import sys

lease = Path(sys.argv[1])
lease.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
descriptor = os.open(lease, os.O_RDWR | os.O_CREAT, 0o600)
try:
    if sys.platform == "win32":
        import msvcrt
        if os.fstat(descriptor).st_size == 0:
            os.write(descriptor, b"0")
        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("locked", flush=True)
    sys.stdin.buffer.read()
finally:
    os.close(descriptor)
