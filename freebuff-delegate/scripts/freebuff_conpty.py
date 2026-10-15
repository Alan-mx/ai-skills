#!/usr/bin/env python3
"""Control Freebuff through a detached Windows ConPTY session."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
STATE_ROOT = Path(
    os.environ.get(
        "FREEBUFF_CONPTY_HOME",
        str(Path(os.environ.get("LOCALAPPDATA", Path.home())) / "freebuff-conpty"),
    )
)
DEPS_DIR = Path(
    os.environ.get("FREEBUFF_CONPTY_DEPS", str(Path.home() / ".freebuff-conpty-deps"))
)
LATEST_PATH = STATE_ROOT / "latest.json"
COMMAND_TIMEOUT_SECONDS = 15.0
CSI_RE = re.compile(r"\x1b\[([0-?]*)([ -/]*)([@-~])")
AD_MARKER_RE = re.compile(r"(?:^|\s)Ad(?:\s|$)")

if DEPS_DIR.is_dir():
    sys.path.insert(0, str(DEPS_DIR))

try:
    import winpty  # type: ignore
except ImportError:
    winpty = None


for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


KEY_SEQUENCES = {
    "enter": "\r",
    "esc": "\x1b",
    "tab": "\t",
    "backspace": "\x7f",
    "up": "\x1b[A",
    "down": "\x1b[B",
    "right": "\x1b[C",
    "left": "\x1b[D",
    "ctrl-c": "\x03",
}


class CliError(RuntimeError):
    pass


def emit(value: Any, exit_code: int = 0) -> int:
    print(json.dumps(value, ensure_ascii=False, sort_keys=True))
    return exit_code


def atomic_json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temp.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(temp, path)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def require_winpty() -> None:
    if winpty is None:
        raise CliError(
            "pywinpty is not installed. Run the script's 'setup' command first "
            f"or set FREEBUFF_CONPTY_DEPS. Expected deps: {DEPS_DIR}"
        )


def resolve_binary(explicit: str | None) -> Path:
    candidates = [
        explicit,
        os.environ.get("FREEBUFF_BINARY"),
        str(Path.home() / ".config" / "manicode" / "freebuff.exe"),
        shutil.which("freebuff.exe"),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate).expanduser().resolve()
        if path.is_file():
            return path
    raise CliError(
        "freebuff.exe was not found. Pass --binary or set FREEBUFF_BINARY."
    )


def process_ids_by_name(image_name: str) -> list[int]:
    if os.name != "nt":
        return []
    completed = subprocess.run(
        ["tasklist", "/FI", f"IMAGENAME eq {image_name}", "/FO", "CSV", "/NH"],
        capture_output=True,
        text=True,
        check=False,
    )
    result: list[int] = []
    for line in completed.stdout.splitlines():
        fields = [field.strip('"') for field in line.split('","')]
        if len(fields) < 2 or fields[0].lower() != image_name.lower():
            continue
        try:
            result.append(int(fields[1]))
        except ValueError:
            continue
    return result


def pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    if os.name == "nt":
        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(
            process_query_limited_information,
            False,
            int(pid),
        )
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def terminate_tree(pid: int | None) -> None:
    if not pid:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            text=True,
            check=False,
        )
        return
    try:
        os.kill(pid, 15)
    except OSError:
        pass


def cell_width(char: str) -> int:
    if unicodedata.combining(char):
        return 0
    return 2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1


def render_screen(
    path: Path,
    rows: int,
    cols: int,
    max_bytes: int = 524288,
) -> list[str]:
    if not path.is_file() or rows <= 0 or cols <= 0:
        return []
    with path.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(max(0, size - max_bytes))
        raw = stream.read()
    text = raw.decode("utf-8", errors="replace")
    screen: list[list[str]] = [[" "] * cols for _ in range(rows)]
    row = 0
    col = 0
    saved_cursor = (0, 0)

    def scroll() -> None:
        screen.pop(0)
        screen.append([" "] * cols)

    def parse_params(value: str) -> list[int]:
        value = value.lstrip("?")
        if not value:
            return []
        result: list[int] = []
        for part in value.split(";"):
            if not part:
                result.append(0)
                continue
            try:
                result.append(int(part))
            except ValueError:
                result.append(0)
        return result

    index = 0
    while index < len(text):
        char = text[index]
        if char == "\x1b":
            if index + 1 >= len(text):
                break
            next_char = text[index + 1]
            if next_char == "]":
                terminator = text.find("\x07", index + 2)
                if terminator < 0:
                    terminator = text.find("\x1b\\", index + 2)
                    index = len(text) if terminator < 0 else terminator + 2
                else:
                    index = terminator + 1
                continue
            match = CSI_RE.match(text, index)
            if match:
                params = parse_params(match.group(1))
                final = match.group(3)
                first = params[0] if params and params[0] else 1
                if final in {"H", "f"}:
                    row = max(0, min(rows - 1, (params[0] if params and params[0] else 1) - 1))
                    col = max(
                        0,
                        min(
                            cols - 1,
                            (params[1] if len(params) > 1 and params[1] else 1) - 1,
                        ),
                    )
                elif final == "A":
                    row = max(0, row - first)
                elif final == "B":
                    row = min(rows - 1, row + first)
                elif final == "C":
                    col = min(cols - 1, col + first)
                elif final == "D":
                    col = max(0, col - first)
                elif final == "G":
                    col = max(0, min(cols - 1, first - 1))
                elif final == "d":
                    row = max(0, min(rows - 1, first - 1))
                elif final == "K":
                    mode = params[0] if params else 0
                    if mode == 1:
                        for position in range(0, col + 1):
                            screen[row][position] = " "
                    elif mode == 2:
                        screen[row] = [" "] * cols
                    else:
                        for position in range(col, cols):
                            screen[row][position] = " "
                elif final == "J":
                    mode = params[0] if params else 0
                    if mode == 2:
                        screen = [[" "] * cols for _ in range(rows)]
                    elif mode == 1:
                        for target_row in range(0, row + 1):
                            screen[target_row] = [" "] * cols
                    else:
                        for target_row in range(row, rows):
                            screen[target_row] = [" "] * cols
                elif final == "s":
                    saved_cursor = (row, col)
                elif final == "u":
                    row, col = saved_cursor
                index = match.end()
                continue
            index += 2 if next_char in {"(", ")"} else 1
            continue

        if char == "\r":
            col = 0
        elif char == "\n":
            row += 1
            if row >= rows:
                scroll()
                row = rows - 1
        elif char == "\b":
            col = max(0, col - 1)
        elif char >= " " and char != "\x7f":
            width = cell_width(char)
            if width == 0:
                index += 1
                continue
            if col >= cols:
                col = 0
                row += 1
                if row >= rows:
                    scroll()
                    row = rows - 1
            screen[row][col] = char
            if width == 2 and col + 1 < cols:
                screen[row][col + 1] = ""
                col += 1
            col += 1
        index += 1

    lines = ["".join(row_cells).rstrip() for row_cells in screen]
    return [line for line in lines if line.strip()]


def tail_lines(
    path: Path,
    count: int,
    rows: int,
    cols: int,
) -> list[str]:
    if count <= 0:
        return []
    lines = filter_ad_blocks(render_screen(path, rows, cols))
    return lines[-count:]


def filter_ad_blocks(lines: list[str]) -> list[str]:
    result: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if not AD_MARKER_RE.search(line):
            result.append(line)
            index += 1
            continue
        if result and ("╭" in result[-1] or "┌" in result[-1]):
            result.pop()
        end = index + 1
        while end < len(lines) and end <= index + 5:
            if "╰" in lines[end] or "└" in lines[end]:
                end += 1
                break
            end += 1
        index = end
    return result


def ensure_session_dir(path: Path) -> Path:
    path = path.expanduser().resolve()
    (path / "commands").mkdir(parents=True, exist_ok=True)
    (path / "processed").mkdir(parents=True, exist_ok=True)
    return path


def resolve_session(explicit: str | None) -> Path:
    if explicit:
        path = ensure_session_dir(Path(explicit))
        if not (path / "status.json").is_file():
            raise CliError(f"Session status not found: {path / 'status.json'}")
        return path
    if not LATEST_PATH.is_file():
        raise CliError("No latest Freebuff ConPTY session was found.")
    latest = read_json(LATEST_PATH)
    return ensure_session_dir(Path(latest["session_dir"]))


def read_status(session_dir: Path) -> dict[str, Any]:
    status_path = session_dir / "status.json"
    if not status_path.is_file():
        raise CliError(f"Session is not ready: {status_path}")
    return read_json(status_path)


def write_command(
    session_dir: Path,
    action: str,
    *,
    data: str | None = None,
    timeout: float = COMMAND_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    status = read_status(session_dir)
    if status.get("state") not in {"starting", "running"}:
        raise CliError(
            f"Session is {status.get('state')!r}; no command was sent."
        )

    command_id = uuid.uuid4().hex
    command = {"id": command_id, "action": action}
    if data is not None:
        command["data"] = data

    command_path = session_dir / "commands" / f"{time.time_ns()}-{command_id}.json"
    atomic_json_write(command_path, command)
    response_path = session_dir / "processed" / f"{command_id}.json"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if response_path.is_file():
            return read_json(response_path)
        if not pid_alive(status.get("server_pid")):
            raise CliError("ConPTY server exited before acknowledging the command.")
        time.sleep(0.05)
    raise CliError(f"Command timed out after {timeout:.1f}s: {action}")


def update_status(
    session_path: Path,
    lock: threading.Lock,
    **changes: Any,
) -> dict[str, Any]:
    status_path = session_path / "status.json"
    with lock:
        current = read_json(status_path) if status_path.is_file() else {}
        current.update(changes)
        atomic_json_write(status_path, current)
        return current


def serve(args: argparse.Namespace) -> int:
    require_winpty()
    session_dir = ensure_session_dir(Path(args.session_dir))
    raw_path = session_dir / "raw.log"
    status_lock = threading.Lock()
    stop_event = threading.Event()
    output_lock = threading.Lock()
    output_chars = 0
    last_output_at = time.time()

    update_status(
        session_dir,
        status_lock,
        session_id=args.session_id,
        state="starting",
        session_dir=str(session_dir),
        cwd=str(Path(args.cwd).resolve()),
        binary=str(Path(args.binary).resolve()),
        server_pid=os.getpid(),
        child_pid=None,
        started_at=time.time(),
        last_output_at=last_output_at,
        output_chars=0,
        last_error=None,
        rows=args.rows,
        cols=args.cols,
    )

    try:
        child = winpty.PtyProcess.spawn(
            [str(Path(args.binary).resolve()), "--cwd", str(Path(args.cwd).resolve())],
            cwd=str(Path(args.cwd).resolve()),
            dimensions=(args.rows, args.cols),
        )
    except Exception as error:
        update_status(
            session_dir,
            status_lock,
            state="error",
            last_error=f"{type(error).__name__}: {error}",
            stopped_at=time.time(),
        )
        raise

    update_status(
        session_dir,
        status_lock,
        state="running",
        child_pid=getattr(child, "pid", None),
    )

    def reader() -> None:
        nonlocal output_chars, last_output_at
        try:
            with raw_path.open("a", encoding="utf-8", errors="replace") as raw:
                while not stop_event.is_set():
                    try:
                        chunk = child.read(4096)
                    except EOFError:
                        break
                    except OSError as error:
                        update_status(
                            session_dir,
                            status_lock,
                            state="error",
                            last_error=f"ConPTY read failed: {error}",
                        )
                        break
                    if not chunk:
                        continue
                    raw.write(chunk)
                    raw.flush()
                    with output_lock:
                        output_chars += len(chunk)
                        last_output_at = time.time()
                    update_status(
                        session_dir,
                        status_lock,
                        last_output_at=last_output_at,
                        output_chars=output_chars,
                    )
        finally:
            if not stop_event.is_set():
                update_status(
                    session_dir,
                    status_lock,
                    state="stopped",
                    stopped_at=time.time(),
                    last_output_at=last_output_at,
                    output_chars=output_chars,
                )

    reader_thread = threading.Thread(target=reader, name="freebuff-conpty-reader")
    reader_thread.start()

    commands_dir = session_dir / "commands"
    processed_dir = session_dir / "processed"

    try:
        while not stop_event.is_set():
            for command_path in sorted(commands_dir.glob("*.json")):
                try:
                    command = read_json(command_path)
                except (OSError, json.JSONDecodeError) as error:
                    continue
                command_id = str(command.get("id") or command_path.stem)
                action = command.get("action")
                response: dict[str, Any] = {"id": command_id, "ok": True}
                try:
                    if action == "write":
                        child.write(str(command.get("data", "")))
                    elif action == "submit":
                        child.write(f"{command.get('data', '')}\r")
                    elif action == "key":
                        key = str(command.get("data", "")).lower()
                        if key not in KEY_SEQUENCES:
                            raise CliError(
                                f"Unsupported key {key!r}; expected one of "
                                f"{', '.join(sorted(KEY_SEQUENCES))}"
                            )
                        child.write(KEY_SEQUENCES[key])
                    elif action == "stop":
                        response["state"] = "stopping"
                        stop_event.set()
                    else:
                        raise CliError(f"Unsupported action: {action!r}")
                except Exception as error:
                    response.update(
                        ok=False,
                        error=f"{type(error).__name__}: {error}",
                    )
                atomic_json_write(processed_dir / f"{command_id}.json", response)
                command_path.unlink(missing_ok=True)
                if stop_event.is_set():
                    break

            if not child.isalive():
                stop_event.set()
                break
            time.sleep(0.05)
    finally:
        if child.isalive():
            child.terminate(force=True)
        stop_event.set()
        with output_lock:
            final_chars = output_chars
            final_output_at = last_output_at
        update_status(
            session_dir,
            status_lock,
            state="stopped",
            stopped_at=time.time(),
            last_output_at=final_output_at,
            output_chars=final_chars,
        )
    return 0


def command_setup(args: argparse.Namespace) -> int:
    deps_dir = Path(args.deps_dir).expanduser().resolve()
    deps_dir.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--upgrade",
            "--target",
            str(deps_dir),
            "pywinpty",
        ],
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        return emit(
            {
                "ok": False,
                "error": f"pip exited with code {completed.returncode}",
                "deps_dir": str(deps_dir),
            },
            completed.returncode,
        )
    return emit({"ok": True, "deps_dir": str(deps_dir)})


def command_start(args: argparse.Namespace) -> int:
    require_winpty()
    binary = resolve_binary(args.binary)
    existing = process_ids_by_name("freebuff.exe")
    if existing:
        raise CliError(
            "Refusing to start: freebuff.exe is already running "
            f"(PIDs: {', '.join(map(str, existing))})."
        )

    session_id = uuid.uuid4().hex
    session_dir = ensure_session_dir(
        Path(args.session_dir)
        if args.session_dir
        else STATE_ROOT / "sessions" / session_id
    )
    server_log = (session_dir / "server.log").open("ab")
    env = os.environ.copy()
    if DEPS_DIR.is_dir():
        current_pythonpath = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = (
            str(DEPS_DIR)
            if not current_pythonpath
            else str(DEPS_DIR) + os.pathsep + current_pythonpath
        )

    creationflags = 0
    if os.name == "nt":
        creationflags = (
            subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        )

    server = subprocess.Popen(
        [
            sys.executable,
            "-u",
            str(SCRIPT_PATH),
            "_serve",
            "--session-dir",
            str(session_dir),
            "--session-id",
            session_id,
            "--cwd",
            str(Path(args.cwd).resolve()),
            "--binary",
            str(binary),
            "--rows",
            str(args.rows),
            "--cols",
            str(args.cols),
        ],
        cwd=str(session_dir),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=server_log,
        stderr=server_log,
        close_fds=True,
        creationflags=creationflags,
    )
    server_log.close()
    atomic_json_write(
        LATEST_PATH,
        {
            "session_id": session_id,
            "session_dir": str(session_dir),
            "started_at": time.time(),
        },
    )

    deadline = time.monotonic() + args.timeout
    status: dict[str, Any] = {}
    while time.monotonic() < deadline:
        if server.poll() is not None:
            break
        status_path = session_dir / "status.json"
        if status_path.is_file():
            status = read_status(session_dir)
            if status.get("state") in {"running", "error"}:
                break
        time.sleep(0.1)

    if status.get("state") != "running":
        raise CliError(
            "ConPTY server did not start Freebuff. "
            f"Status: {status or 'missing'}; server log: {session_dir / 'server.log'}"
        )
    return emit(status)


def command_status(args: argparse.Namespace) -> int:
    session_dir = resolve_session(args.session)
    status = read_status(session_dir)
    status["session_dir"] = str(session_dir)
    status["tail"] = tail_lines(
        session_dir / "raw.log",
        args.tail,
        int(status.get("rows") or 40),
        int(status.get("cols") or 140),
    )
    return emit(status)


def command_send(args: argparse.Namespace) -> int:
    session_dir = resolve_session(args.session)
    if args.text_file:
        text = Path(args.text_file).read_text(encoding="utf-8").rstrip("\r\n")
    else:
        text = args.text or ""
    action = "submit" if args.enter else "write"
    response = write_command(session_dir, action, data=text)
    return emit(response, 0 if response.get("ok") else 1)


def command_key(args: argparse.Namespace) -> int:
    session_dir = resolve_session(args.session)
    for key in args.keys:
        response = write_command(session_dir, "key", data=key)
        if not response.get("ok"):
            return emit(response, 1)
        time.sleep(args.delay)
    return emit({"ok": True, "keys": args.keys})


def command_wait(args: argparse.Namespace) -> int:
    session_dir = resolve_session(args.session)
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        status = read_status(session_dir)
        state = status.get("state")
        last_output_at = float(status.get("last_output_at") or status.get("started_at") or 0)
        idle_ms = max(0.0, (time.time() - last_output_at) * 1000)
        if state in {"stopped", "error"} or idle_ms >= args.idle_ms:
            status["session_dir"] = str(session_dir)
            status["idle_ms"] = round(idle_ms)
            return emit(status)
        time.sleep(0.2)
    status = read_status(session_dir)
    status["session_dir"] = str(session_dir)
    status["wait_timed_out"] = True
    return emit(status, 1)


def command_stop(args: argparse.Namespace) -> int:
    session_dir = resolve_session(args.session)
    status = read_status(session_dir)
    server_pid = status.get("server_pid")
    try:
        write_command(session_dir, "stop", timeout=5)
    except CliError:
        pass

    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        status = read_status(session_dir)
        if status.get("state") in {"stopped", "error"}:
            status["session_dir"] = str(session_dir)
            return emit(status)
        time.sleep(0.1)

    terminate_tree(server_pid)
    time.sleep(0.3)
    status = read_status(session_dir)
    status["session_dir"] = str(session_dir)
    status["forced"] = True
    return emit(status)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Control Freebuff through a detached Windows ConPTY session."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    setup_parser = subparsers.add_parser("setup", help="Install pywinpty locally")
    setup_parser.add_argument("--deps-dir", default=str(DEPS_DIR))
    setup_parser.set_defaults(handler=command_setup)

    start_parser = subparsers.add_parser("start", help="Start a Freebuff session")
    start_parser.add_argument("--cwd", default=os.getcwd())
    start_parser.add_argument("--binary")
    start_parser.add_argument("--session-dir")
    start_parser.add_argument("--rows", type=int, default=40)
    start_parser.add_argument("--cols", type=int, default=140)
    start_parser.add_argument("--timeout", type=float, default=15)
    start_parser.set_defaults(handler=command_start)

    status_parser = subparsers.add_parser("status", help="Read session status")
    status_parser.add_argument("--session")
    status_parser.add_argument("--tail", type=int, default=0)
    status_parser.set_defaults(handler=command_status)

    send_parser = subparsers.add_parser("send", help="Send text to Freebuff")
    send_parser.add_argument("--session")
    send_parser.add_argument("--text")
    send_parser.add_argument("--text-file")
    send_parser.add_argument(
        "--enter",
        action="store_true",
        help="Append Enter; prefer send followed by 'key enter' for reliability",
    )
    send_parser.set_defaults(handler=command_send)

    key_parser = subparsers.add_parser("key", help="Send control keys")
    key_parser.add_argument("--session")
    key_parser.add_argument("keys", nargs="+", choices=sorted(KEY_SEQUENCES))
    key_parser.add_argument("--delay", type=float, default=0.1)
    key_parser.set_defaults(handler=command_key)

    wait_parser = subparsers.add_parser("wait", help="Wait for output to become idle")
    wait_parser.add_argument("--session")
    wait_parser.add_argument("--idle-ms", type=int, default=3000)
    wait_parser.add_argument("--timeout", type=float, default=3600)
    wait_parser.set_defaults(handler=command_wait)

    stop_parser = subparsers.add_parser("stop", help="Stop the session")
    stop_parser.add_argument("--session")
    stop_parser.add_argument("--timeout", type=float, default=10)
    stop_parser.set_defaults(handler=command_stop)

    serve_parser = subparsers.add_parser("_serve", help=argparse.SUPPRESS)
    serve_parser.add_argument("--session-dir", required=True)
    serve_parser.add_argument("--session-id", required=True)
    serve_parser.add_argument("--cwd", required=True)
    serve_parser.add_argument("--binary", required=True)
    serve_parser.add_argument("--rows", type=int, default=40)
    serve_parser.add_argument("--cols", type=int, default=140)
    serve_parser.set_defaults(handler=serve)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.handler(args))
    except CliError as error:
        return emit({"ok": False, "error": str(error)}, 2)
    except KeyboardInterrupt:
        return emit({"ok": False, "error": "Interrupted"}, 130)


if __name__ == "__main__":
    raise SystemExit(main())
