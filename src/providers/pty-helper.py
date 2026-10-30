# Forewright's pseudo-terminal helper for macOS and Linux, used when the node-pty module cannot be loaded.
# Standard library only. Usage: pty-helper.py <cols> <rows> -- <program> [args...]
#
# It starts the program on a new pseudo-terminal, copies its own stdin to the terminal and the terminal's
# output to its own stdout, and applies resize requests read from file descriptor 3 as JSON lines
# ({"cols": 120, "rows": 40}). Its exit status is the program's.
#
# Forewright starts this helper as the leader of its own session and process group. The terminal becomes that
# session's controlling terminal and the program stays in the helper's process group, so ending the group ends
# the helper, the program and everything the program started in it.
import errno
import fcntl
import json
import os
import select
import signal
import struct
import sys
import termios

# Keys typed in the terminal (ctrl+c, ctrl+z) signal the foreground group, which includes this helper.
JOB_SIGNALS = (signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP, signal.SIGTTIN, signal.SIGTTOU)
# macOS value of TIOCSCTTY, for Pythons whose termios module does not export it.
DARWIN_TIOCSCTTY = 0x20007461


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    while data:
        n = os.write(fd, data)
        data = data[n:]


def has_fd(fd):
    try:
        os.fstat(fd)
        return True
    except OSError:
        return False


def main():
    if len(sys.argv) < 5 or sys.argv[3] != "--":
        sys.stderr.write("usage: pty-helper.py <cols> <rows> -- <program> [args...]\n")
        return 2
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[4:]

    master, slave = os.openpty()
    set_size(master, cols, rows)
    ctty = getattr(termios, "TIOCSCTTY", DARWIN_TIOCSCTTY if sys.platform == "darwin" else None)
    if ctty is None:
        sys.stderr.write("pty-helper: this system has no TIOCSCTTY\n")
        return 2
    fcntl.ioctl(slave, ctty, 0)
    for s in JOB_SIGNALS:
        signal.signal(s, signal.SIG_IGN)
    os.tcsetpgrp(slave, os.getpgrp())

    pid = os.fork()
    if pid == 0:
        try:
            for s in JOB_SIGNALS:
                signal.signal(s, signal.SIG_DFL)  # ignored signals survive exec: give the program the defaults
            os.close(master)
            for fd in (0, 1, 2):
                os.dup2(slave, fd)
            if slave > 2:
                os.close(slave)
            if has_fd(3):
                os.close(3)
            os.execvp(argv[0], argv)
        except OSError as e:
            os.write(2, ("Could not start %s: %s\r\n" % (argv[0], e.strerror)).encode("utf-8", "replace"))
        os._exit(127)
    os.close(slave)

    watched = [master, 0] + ([3] if has_fd(3) else [])
    control = b""
    status = None
    while True:
        try:
            ready, _, _ = select.select(watched, [], [], 0.05 if status is None else 0)
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as e:
                if e.errno != errno.EIO:
                    raise
                data = b""  # Linux: every copy of the terminal's other end is closed
            if data:
                write_all(1, data)
            else:
                watched.remove(master)
        if 0 in ready:
            data = os.read(0, 65536)
            if data:
                write_all(master, data)
            else:
                watched.remove(0)
        if 3 in ready:
            data = os.read(3, 65536)
            if not data:
                watched.remove(3)
            control += data
            while b"\n" in control:
                line, control = control.split(b"\n", 1)
                if not line.strip():
                    continue
                req = json.loads(line)
                set_size(master, int(req["cols"]), int(req["rows"]))
                if status is None:
                    os.kill(pid, signal.SIGWINCH)
        if status is None:
            done, st = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                status = st
        elif master not in watched or master not in ready:
            break  # the program ended and its last output has been copied

    if os.WIFSIGNALED(status):
        sig = os.WTERMSIG(status)
        signal.signal(sig, signal.SIG_DFL)
        os.kill(os.getpid(), sig)
        return 128 + sig
    return os.WEXITSTATUS(status)


if __name__ == "__main__":
    sys.exit(main())
