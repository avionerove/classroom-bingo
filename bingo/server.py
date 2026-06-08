#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
3x3 빙고 교실 앱 - 순수 파이썬 표준 라이브러리 서버 (설치 불필요)

실행:  python3 server.py
- 선생님: http://<선생님컴퓨터IP>:8000/teacher
- 학생:   http://<선생님컴퓨터IP>:8000/  (이름 입력 후 입장)

실시간 동기화는 long-polling(/api/state) 으로 처리한다.
"""

import json
import os
import random
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT_ENV = os.environ.get("PORT")          # 클라우드(Render 등)는 PORT를 지정해줌
PORT = int(PORT_ENV) if PORT_ENV else 8000  # 로컬 기본값 8000
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")

# 3x3 빙고에서 가능한 모든 줄 (가로3 + 세로3 + 대각선2)
LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],   # 가로
    [0, 3, 6], [1, 4, 7], [2, 5, 8],   # 세로
    [0, 4, 8], [2, 4, 6],              # 대각선
]

RULE_NEED = {"1line": 1, "2line": 2, "3line": 3}

# ---------------------------------------------------------------------------
# 전역 상태 (교실 1개)
# ---------------------------------------------------------------------------
COND = threading.Condition()          # 상태 보호 + long-poll 알림용
state = {
    "phase": "lobby",                 # lobby -> arrange -> playing -> (replay)
    "title": "",                      # 빙고 제목 (선택)
    "rule": "1line",                  # 1line / 2line / 3line / full
    "mode": "simple",                 # simple(답만 부르기) / quiz(문제→답)
    "chips": [],                      # [{"id": int, "text": str(정답), "clue": str(부를 때 보여줄 단서)}]
    "students": {},                   # clientId -> student dict
    "winners": [],                    # [{"clientId","name","rank"}]
    "called": [],                     # 호출된 chip id 목록 (부른 순서)
    "currentCall": None,              # 마지막으로 호출된 chip id
    "arrangeSeconds": 120,            # 배치 단계 제한시간(초). 0이면 제한 없음
    "arrangeEndsAt": None,            # 배치 종료 시각(epoch). None이면 제한 없음
    "version": 1,                     # 변경마다 +1 (long-poll 기준)
}
_chip_seq = [0]


def bump():
    """상태가 바뀌었음을 알린다. 반드시 COND 잠금 안에서 호출."""
    state["version"] += 1
    COND.notify_all()


def now():
    return time.time()


def new_student(name):
    return {
        "name": name,
        "board": [None] * 9,      # 각 칸에 놓인 chip id (없으면 None)
        "colored": [False] * 9,   # 각 칸 색칠 여부
        "bingoRank": None,
        "lastSeen": now(),
        "onlineCache": True,
    }


def completed_lines(colored, board):
    cnt = 0
    for line in LINES:
        if all(colored[i] and board[i] is not None for i in line):
            cnt += 1
    return cnt


def meets_rule(colored, board, rule):
    if rule == "full":
        return all(colored[i] and board[i] is not None for i in range(9))
    need = RULE_NEED.get(rule, 1)
    return completed_lines(colored, board) >= need


def is_reach(colored, board, rule):
    """한 칸만 더 색칠하면 빙고가 되는 '리치' 상태인지."""
    if meets_rule(colored, board, rule):
        return False
    for i in range(9):
        if board[i] is not None and not colored[i]:
            trial = colored[:]
            trial[i] = True
            if meets_rule(trial, board, rule):
                return True
    return False


def chip_by_id(cid):
    for c in state["chips"]:
        if c["id"] == cid:
            return c
    return None


def eff_clue(chip):
    """현재 모드에서 학생에게 '불러줄' 내용. 일반 모드면 답을 그대로 부른다."""
    return chip["text"] if state["mode"] == "simple" else chip["clue"]


def is_online(st):
    return (now() - st["lastSeen"]) < 12


def arrange_remaining_ms():
    """배치 단계의 남은 시간(ms). 제한 없음/다른 단계이면 None."""
    limit = state["arrangeSeconds"]
    ends = state["arrangeEndsAt"]
    if state["phase"] == "arrange" and limit > 0 and ends is not None:
        return max(0, int((ends - now()) * 1000))
    return None


# ---------------------------------------------------------------------------
# 뷰 생성 (역할별로 필요한 정보만)
# ---------------------------------------------------------------------------
def teacher_view():
    students = []
    for cid, st in state["students"].items():
        placed = sum(1 for x in st["board"] if x is not None)
        colored = sum(1 for i in range(9) if st["colored"][i] and st["board"][i] is not None)
        students.append({
            "clientId": cid,
            "name": st["name"],
            "online": is_online(st),
            "placed": placed,
            "colored": colored,
            "lines": completed_lines(st["colored"], st["board"]),
            "reach": state["phase"] == "playing" and st["bingoRank"] is None
                     and is_reach(st["colored"], st["board"], state["rule"]),
            "bingoRank": st["bingoRank"],
        })
    students.sort(key=lambda s: (not s["online"], s["name"]))
    cur = chip_by_id(state["currentCall"]) if state["currentCall"] is not None else None
    return {
        "role": "teacher",
        "phase": state["phase"],
        "title": state["title"],
        "rule": state["rule"],
        "mode": state["mode"],
        "chips": state["chips"],
        "students": students,
        "winners": sorted(state["winners"], key=lambda w: w["rank"]),
        "called": state["called"],
        "currentCall": ({"id": cur["id"], "text": cur["text"], "clue": eff_clue(cur)} if cur else None),
        "arrangeSeconds": state["arrangeSeconds"],
        "arrangeRemainingMs": arrange_remaining_ms(),
        "version": state["version"],
    }


def student_view(cid):
    st = state["students"].get(cid)
    me = None
    if st:
        me = {
            "name": st["name"],
            "board": st["board"],
            "colored": st["colored"],
            "bingoRank": st["bingoRank"],
            "lines": completed_lines(st["colored"], st["board"]),
            "canBingo": meets_rule(st["colored"], st["board"], state["rule"]) and st["bingoRank"] is None,
            "reach": state["phase"] == "playing" and st["bingoRank"] is None
                     and is_reach(st["colored"], st["board"], state["rule"]),
        }
    # 학생에게는 정답이 아니라 '단서'만 보여준다 (스스로 찾게)
    cur = chip_by_id(state["currentCall"]) if state["currentCall"] is not None else None
    called_clues = [eff_clue(chip_by_id(c)) for c in state["called"] if chip_by_id(c)]
    return {
        "role": "student",
        "phase": state["phase"],
        "title": state["title"],
        "rule": state["rule"],
        "chips": state["chips"],
        "registered": st is not None,
        "me": me,
        "winners": sorted(state["winners"], key=lambda w: w["rank"]),
        "currentCall": ({"clue": eff_clue(cur)} if cur else None),
        "calledClues": called_clues,
        "calledCount": len(state["called"]),
        "totalChips": len(state["chips"]),
        "arrangeSeconds": state["arrangeSeconds"],
        "arrangeRemainingMs": arrange_remaining_ms(),
        "version": state["version"],
    }


# ---------------------------------------------------------------------------
# 액션 처리 (모두 COND 잠금 안에서 실행)
# ---------------------------------------------------------------------------
def act_teacher_chips(body):
    chips = []
    for item in body.get("chips", []):
        if isinstance(item, dict):
            text = str(item.get("text", "")).strip()
            clue = str(item.get("clue", "")).strip()
        else:
            text = str(item).strip()
            clue = ""
        if not text:
            continue
        _chip_seq[0] += 1
        chips.append({"id": _chip_seq[0], "text": text, "clue": clue or text})
    state["chips"] = chips
    # 칩이 바뀌면 학생 배치/호출은 무효 → 초기화
    for st in state["students"].values():
        st["board"] = [None] * 9
        st["colored"] = [False] * 9
        st["bingoRank"] = None
    state["winners"] = []
    state["called"] = []
    state["currentCall"] = None
    bump()


def act_teacher_rule(body):
    rule = body.get("rule")
    if rule in ("1line", "2line", "3line", "full"):
        state["rule"] = rule
        bump()


def act_teacher_mode(body):
    m = body.get("mode")
    if m in ("simple", "quiz"):
        state["mode"] = m
        bump()
    return {"ok": True}


def act_teacher_title(body):
    state["title"] = str(body.get("title", "")).strip()[:60]
    bump()
    return {"ok": True}


def act_teacher_control(body):
    action = body.get("action")
    if action == "arrange":
        state["phase"] = "arrange"
        # 제한시간이 설정돼 있으면 지금부터 카운트다운 시작
        state["arrangeEndsAt"] = (now() + state["arrangeSeconds"]) if state["arrangeSeconds"] > 0 else None
    elif action == "play":
        state["phase"] = "playing"
        state["arrangeEndsAt"] = None
        state["called"] = []
        state["currentCall"] = None
    elif action == "replay":
        # 색칠/빙고/호출 초기화, 배치는 유지
        for st in state["students"].values():
            st["colored"] = [False] * 9
            st["bingoRank"] = None
        state["winners"] = []
        state["phase"] = "playing"
        state["arrangeEndsAt"] = None
        state["called"] = []
        state["currentCall"] = None
    elif action == "reset":
        for st in state["students"].values():
            st["board"] = [None] * 9
            st["colored"] = [False] * 9
            st["bingoRank"] = None
        state["winners"] = []
        state["phase"] = "lobby"
        state["arrangeEndsAt"] = None
        state["called"] = []
        state["currentCall"] = None
    else:
        return
    bump()


def act_teacher_arrange_time(body):
    try:
        seconds = int(body.get("seconds", 0))
    except (TypeError, ValueError):
        return {"ok": False, "error": "잘못된 시간"}
    seconds = max(0, min(seconds, 3600))
    state["arrangeSeconds"] = seconds
    # 배치 단계 진행 중이면 즉시 반영
    if state["phase"] == "arrange":
        state["arrangeEndsAt"] = (now() + seconds) if seconds > 0 else None
    bump()
    return {"ok": True}


def act_teacher_extend(body):
    try:
        seconds = int(body.get("seconds", 30))
    except (TypeError, ValueError):
        seconds = 30
    if state["phase"] != "arrange":
        return {"ok": False, "error": "배치 단계에서만 연장할 수 있습니다."}
    base = state["arrangeEndsAt"]
    if base is None or base < now():
        base = now()  # 이미 끝났거나 제한 없던 경우 지금부터 다시 시작
    state["arrangeEndsAt"] = base + seconds
    if state["arrangeSeconds"] == 0:
        state["arrangeSeconds"] = seconds
    bump()
    return {"ok": True}


def act_teacher_kick(body):
    cid = body.get("clientId")
    if cid in state["students"]:
        del state["students"][cid]
        state["winners"] = [w for w in state["winners"] if w["clientId"] != cid]
        bump()


def act_student_join(body):
    cid = body.get("clientId")
    name = str(body.get("name", "")).strip()
    if not cid or not name:
        return {"ok": False, "error": "이름을 입력하세요."}
    st = state["students"].get(cid)
    if st:
        st["name"] = name
    else:
        state["students"][cid] = new_student(name)
    state["students"][cid]["lastSeen"] = now()
    bump()
    return {"ok": True}


def act_student_board(body):
    cid = body.get("clientId")
    board = body.get("board")
    st = state["students"].get(cid)
    if not st:
        return {"ok": False, "error": "먼저 입장하세요."}
    if state["phase"] not in ("arrange", "lobby"):
        return {"ok": False, "error": "지금은 배치를 바꿀 수 없습니다."}
    if state["phase"] == "arrange" and state["arrangeEndsAt"] is not None and now() > state["arrangeEndsAt"]:
        return {"ok": False, "error": "배치 시간이 종료되었습니다."}
    if not isinstance(board, list) or len(board) != 9:
        return {"ok": False, "error": "잘못된 배치입니다."}
    valid_ids = {c["id"] for c in state["chips"]}
    cleaned = []
    used = set()
    for v in board:
        if v in valid_ids and v not in used:
            cleaned.append(v)
            used.add(v)
        else:
            cleaned.append(None)
    st["board"] = cleaned
    st["colored"] = [False] * 9
    st["bingoRank"] = None
    bump()
    return {"ok": True}


def act_student_toggle(body):
    cid = body.get("clientId")
    idx = body.get("index")
    st = state["students"].get(cid)
    if not st:
        return {"ok": False, "error": "먼저 입장하세요."}
    if state["phase"] != "playing":
        return {"ok": False, "error": "아직 게임이 시작되지 않았습니다."}
    if not isinstance(idx, int) or not (0 <= idx < 9):
        return {"ok": False, "error": "잘못된 칸입니다."}
    if st["board"][idx] is None:
        return {"ok": False, "error": "빈 칸은 색칠할 수 없습니다."}
    # 켤 때는 '호출된' 칸만 가능 (끄는 건 언제든 허용)
    turning_on = not st["colored"][idx]
    if turning_on and st["board"][idx] not in state["called"]:
        return {"ok": False, "error": "아직 불리지 않은 칸이에요."}
    st["colored"][idx] = not st["colored"][idx]
    bump()
    return {"ok": True}


def act_teacher_call(body):
    """다음 항목을 호출한다. chipId가 있으면 그 항목, 없으면 무작위."""
    if state["phase"] != "playing":
        return {"ok": False, "error": "게임 시작 후에 호출할 수 있어요."}
    called = set(state["called"])
    pool = [c for c in state["chips"] if c["id"] not in called]
    if not pool:
        return {"ok": False, "error": "더 부를 항목이 없어요."}
    cid = body.get("chipId")
    if cid is not None:
        item = chip_by_id(cid)
        if item is None or item["id"] in called:
            return {"ok": False, "error": "부를 수 없는 항목이에요."}
    else:
        item = random.choice(pool)
    state["called"].append(item["id"])
    state["currentCall"] = item["id"]
    bump()
    return {"ok": True, "id": item["id"], "text": item["text"], "clue": item["clue"]}


def act_student_bingo(body):
    cid = body.get("clientId")
    st = state["students"].get(cid)
    if not st:
        return {"ok": False, "error": "먼저 입장하세요."}
    if state["phase"] != "playing":
        return {"ok": False, "error": "아직 게임이 시작되지 않았습니다."}
    if st["bingoRank"] is not None:
        return {"ok": True, "rank": st["bingoRank"]}
    if not meets_rule(st["colored"], st["board"], state["rule"]):
        return {"ok": False, "error": "아직 빙고 조건을 채우지 못했습니다."}
    rank = len(state["winners"]) + 1
    st["bingoRank"] = rank
    state["winners"].append({"clientId": cid, "name": st["name"], "rank": rank})
    bump()
    return {"ok": True, "rank": rank}


ACTIONS = {
    "/api/teacher/chips": act_teacher_chips,
    "/api/teacher/rule": act_teacher_rule,
    "/api/teacher/mode": act_teacher_mode,
    "/api/teacher/title": act_teacher_title,
    "/api/teacher/control": act_teacher_control,
    "/api/teacher/arrange-time": act_teacher_arrange_time,
    "/api/teacher/extend": act_teacher_extend,
    "/api/teacher/call": act_teacher_call,
    "/api/teacher/kick": act_teacher_kick,
    "/api/student/join": act_student_join,
    "/api/student/board": act_student_board,
    "/api/student/toggle": act_student_toggle,
    "/api/student/bingo": act_student_bingo,
}


# ---------------------------------------------------------------------------
# HTTP 핸들러
# ---------------------------------------------------------------------------
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/teacher": ("teacher.html", "text/html; charset=utf-8"),
    "/student": ("index.html", "text/html; charset=utf-8"),
    "/present": ("present.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/teacher.js": ("teacher.js", "application/javascript; charset=utf-8"),
    "/student.js": ("student.js", "application/javascript; charset=utf-8"),
    "/present.js": ("present.js", "application/javascript; charset=utf-8"),
    "/celebrate.js": ("celebrate.js", "application/javascript; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass  # 콘솔 조용히

    def _send(self, code, body_bytes, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body_bytes)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body_bytes)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/state":
            self.handle_state(parse_qs(parsed.query))
            return

        if path in STATIC_FILES:
            fname, ctype = STATIC_FILES[path]
            self.serve_static(fname, ctype)
            return

        self._send(404, b"Not Found", "text/plain; charset=utf-8")

    def serve_static(self, fname, ctype):
        fpath = os.path.join(PUBLIC_DIR, fname)
        try:
            with open(fpath, "rb") as f:
                data = f.read()
            self._send(200, data, ctype)
        except FileNotFoundError:
            self._send(404, b"Not Found", "text/plain; charset=utf-8")

    def handle_state(self, qs):
        role = (qs.get("role", ["student"])[0])
        cid = qs.get("clientId", [None])[0]
        try:
            since = int(qs.get("since", ["0"])[0])
        except ValueError:
            since = 0

        with COND:
            st = state["students"].get(cid) if cid else None
            became_online = False
            if st:
                if not is_online(st):
                    became_online = True
                st["lastSeen"] = now()
            if became_online:
                bump()  # 오프라인->온라인 전환은 선생님 화면에 즉시 반영

            deadline = now() + 25
            while state["version"] <= since:
                remaining = deadline - now()
                if remaining <= 0:
                    break
                COND.wait(remaining)

            view = teacher_view() if role == "teacher" else student_view(cid)

        self._send_json(view)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path not in ACTIONS:
            self._send(404, b"Not Found", "text/plain; charset=utf-8")
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            self._send_json({"ok": False, "error": "잘못된 요청"}, 400)
            return

        with COND:
            result = ACTIONS[path](body)

        self._send_json(result if result is not None else {"ok": True})


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def make_server():
    """클라우드(PORT 지정)에서는 그 포트만, 로컬에서는 빈 포트를 자동 탐색."""
    candidates = [PORT] if PORT_ENV else range(PORT, PORT + 20)
    last_err = None
    for p in candidates:
        try:
            srv = ThreadingHTTPServer(("0.0.0.0", p), Handler)
            return srv, p
        except OSError as e:
            last_err = e
            continue
    raise last_err


def main():
    ip = lan_ip()
    server, port = make_server()
    bar = "=" * 56
    print(bar)
    print("  🎉 3x3 빙고 교실 서버가 시작되었습니다!")
    print(bar)
    print(f"  선생님 화면 :  http://{ip}:{port}/teacher")
    print(f"  학생 입장   :  http://{ip}:{port}/")
    print()
    print(f"  (이 컴퓨터에서 테스트) http://localhost:{port}/teacher")
    print()
    print("  같은 WiFi에 연결된 학생들에게 위 '학생 입장' 주소를 알려주세요.")
    print("  종료하려면 Ctrl+C 를 누르세요.")
    print(bar, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")
        server.shutdown()


if __name__ == "__main__":
    main()
