// ============ 학생 클라이언트 ============
const RULE_LABEL = {
  "1line": "한 줄 완성", "2line": "두 줄 완성",
  "3line": "세 줄 완성", "full": "전체 채우기"
};

// 새로고침해도 유지되는 고유 ID (배치/색칠 보존)
function getClientId() {
  let id = localStorage.getItem("bingoClientId");
  if (!id) {
    id = "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("bingoClientId", id);
  }
  return id;
}
const clientId = getClientId();

let myName = localStorage.getItem("bingoName") || "";
let serverState = null;
let localBoard = [null, null, null, null, null, null, null, null, null]; // 배치중 임시 board
let pdrag = null;    // 진행 중인 포인터 드래그 상태 (터치/마우스 공용)
let lastPhase = null;

// 배치 단계 타이머 (모래시계)
let arrangeDeadline = null;   // 로컬 기준 종료 시각(ms)
let arrangeHasLimit = false;
let arrangeTotalMs = 0;
let wasExpired = false;

const $ = (id) => document.getElementById(id);

function fmtTime(ms) {
  const t = Math.ceil(ms / 1000);
  const m = Math.floor(t / 60), s = t % 60;
  return m + ":" + String(s).padStart(2, "0");
}
function arrangeRemainingMs() {
  if (!arrangeHasLimit || arrangeDeadline === null) return null;
  return Math.max(0, arrangeDeadline - Date.now());
}
function isArrangeLocked() {
  return arrangeHasLimit && arrangeRemainingMs() === 0;
}
// 서버 응답이 올 때만 호출 — 그 순간의 남은 시간으로 기준점을 다시 맞춘다
function syncTimerFromServer(s) {
  if (s.phase === "arrange" && s.arrangeRemainingMs !== null && s.arrangeRemainingMs !== undefined) {
    arrangeHasLimit = true;
    arrangeDeadline = Date.now() + s.arrangeRemainingMs;
    arrangeTotalMs = (s.arrangeSeconds || 0) * 1000;
  } else {
    arrangeHasLimit = false;
    arrangeDeadline = null;
    arrangeTotalMs = 0;
  }
}
function updateTimerUI() {
  const box = $("timerBox");
  const show = serverState && serverState.phase === "arrange" && arrangeHasLimit;
  box.classList.toggle("hidden", !show);
  if (!show) return;
  const rem = arrangeRemainingMs();
  const sec = rem / 1000;
  $("timerTime").textContent = rem <= 0 ? "시간 종료" : fmtTime(rem);
  const pct = arrangeTotalMs > 0 ? Math.max(0, Math.min(100, (rem / arrangeTotalMs) * 100)) : 0;
  $("timerBar").style.width = pct + "%";
  box.classList.toggle("warn-time", sec <= 30 && sec > 10);
  box.classList.toggle("danger-time", sec <= 10 && rem > 0);
  box.classList.toggle("ended", rem <= 0);
}

// 1초에 4번 똑딱 — 화면만 갱신하고, 시간이 끝나는 순간 한 번만 전체 렌더(잠금 적용)
setInterval(() => {
  if (!serverState) return;
  updateTimerUI();
  const exp = serverState.phase === "arrange" && isArrangeLocked();
  if (exp !== wasExpired) { wasExpired = exp; render(); }
}, 250);

// ---------- 입장 ----------
$("nameInput").value = myName;
$("nameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) doJoin();
});
$("joinBtn").addEventListener("click", doJoin);

async function doJoin() {
  const name = $("nameInput").value.trim();
  if (!name) { toast("이름을 입력하세요."); return; }
  myName = name;
  localStorage.setItem("bingoName", name);
  const res = await post("/api/student/join", { clientId, name });
  if (!res.ok) { toast(res.error || "입장 실패"); return; }
  $("loginScreen").classList.add("hidden");
  $("gameScreen").classList.remove("hidden");
  $("helloName").textContent = "🎯 " + name;
  startPolling();
}

// 이미 입장한 적이 있으면 자동 재입장
if (myName) { doJoin(); }

// ---------- 통신 ----------
async function post(url, body) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) { return { ok: false, error: "통신 오류" }; }
}

let polling = false;
async function startPolling() {
  if (polling) return;
  polling = true;
  let since = 0;
  while (true) {
    try {
      const r = await fetch(`/api/state?role=student&clientId=${encodeURIComponent(clientId)}&since=${since}`);
      const data = await r.json();
      since = data.version;
      serverState = data;
      syncTimerFromServer(data); // 서버 응답 순간에만 타이머 기준점 재설정
      render();
    } catch (e) {
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
}

// ---------- 렌더링 ----------
function render() {
  const s = serverState;
  if (!s) return;

  $("rulePill").textContent = "규칙: " + (RULE_LABEL[s.rule] || s.rule);

  // 빙고 제목 & 설명
  const title = (s.title || "").trim();
  const desc = (s.description || "").trim();
  $("gameTitle").textContent = title;
  $("gameTitle").classList.toggle("hidden", !title);
  $("gameDesc").textContent = desc;
  $("gameDesc").classList.toggle("hidden", !desc);
  $("titleBox").classList.toggle("hidden", !title && !desc);

  // 배치 단계: 트레이|빙고판 좌우 배치 + 순위표 숨김(한 화면에 트레이+빙고판만)
  $("playArea").classList.toggle("arranging", s.phase === "arrange");
  $("winnerCard").classList.toggle("hidden", s.phase === "arrange" || s.phase === "lobby");

  // 서버에 등록된 board 가 있으면 동기화 (배치 단계 진입 시 등)
  if (s.me && s.phase !== "arrange" && s.phase !== "lobby") {
    // playing/결과 단계에서는 서버 board 사용
    localBoard = s.me.board.slice();
  } else if (s.me && lastPhase !== s.phase && (s.phase === "arrange")) {
    // 배치 단계 진입 시 서버 board 로 초기화
    localBoard = s.me.board.slice();
  }
  lastPhase = s.phase;

  updateTimerUI();
  renderBanner(s);
  renderCall(s);
  renderTray(s);
  renderBoard(s);
  renderBingoButton(s);
  renderWinners(s);
  maybeCelebrate(s);
}

// 지금 불린 문제(단서)를 크게 표시 + 지나간 문제 목록
function renderCall(s) {
  const show = s.phase === "playing";
  $("callCard").classList.toggle("hidden", !show);
  if (!show) return;
  if (s.currentCall && s.currentCall.clue) {
    $("callMain").textContent = s.currentCall.clue;
  } else {
    $("callMain").textContent = "선생님이 문제를 부를 때까지 기다리세요";
  }
  const hist = (s.calledClues || []);
  $("calledHistory").textContent = hist.length > 1
    ? "지나간 문제: " + hist.slice(0, -1).join(", ")
    : "";
}

// 내가 빙고가 되는 순간 축하 연출
let prevMyRank = null, celebrateInit = false;
function maybeCelebrate(s) {
  const rank = s.me && s.me.bingoRank ? s.me.bingoRank : null;
  if (!celebrateInit) {
    // 첫 렌더는 기준점만 잡고 연출 생략 (도중 입장/새로고침 대비)
    celebrateInit = true;
    prevMyRank = rank;
    return;
  }
  if (rank && rank !== prevMyRank) {
    if (window.confettiBurst) confettiBurst();
    if (window.playFanfare) playFanfare();
    $("celebrateText").textContent = `🎉 ${rank}등 빙고!`;
    $("celebrate").classList.remove("hidden");
    setTimeout(() => $("celebrate").classList.add("hidden"), 3000);
  }
  prevMyRank = rank;
}

function renderBanner(s) {
  const b = $("banner");
  if (s.phase === "lobby") {
    b.className = "banner wait";
    b.textContent = "⏳ 선생님이 게임을 준비하고 있어요...";
  } else if (s.phase === "arrange") {
    if (isArrangeLocked()) {
      b.className = "banner win";
      b.textContent = "⏳ 빙고 게임이 시작될 때까지 기다려주세요.";
    } else {
      b.className = "banner wait";
      b.textContent = "📝 스티커를 빙고판에 붙이세요.";
    }
  } else if (s.phase === "playing") {
    if (s.me && s.me.bingoRank) {
      b.className = "banner win";
      b.textContent = `🎉 ${s.me.bingoRank}등으로 빙고 완성!`;
    } else if (s.me && s.me.reach) {
      b.className = "banner reach";
      b.textContent = "🔥 리치! 한 칸만 더 채우면 빙고!";
    } else {
      b.className = "banner go";
      b.textContent = "🟢 불린 문제에 해당하는 칸을 찾아 클릭하세요!";
    }
  }
}

function renderTray(s) {
  const show = s.phase === "arrange";
  $("trayCard").classList.toggle("hidden", !show);
  if (!show) return;
  const locked = isArrangeLocked();
  const used = new Set(localBoard.filter((x) => x !== null));
  const tray = $("tray");
  tray.innerHTML = "";
  s.chips.forEach((chip) => {
    const el = document.createElement("div");
    el.className = "chip" + (used.has(chip.id) || locked ? " used" : "");
    el.textContent = chip.text;
    if (!used.has(chip.id) && !locked) {
      el.classList.add("draggable-item");
      el.addEventListener("pointerdown", (e) =>
        beginPointerDrag(e, { type: "chip", chipId: chip.id, text: chip.text }));
    }
    tray.appendChild(el);
  });
  const placed = localBoard.filter((x) => x !== null).length;
  $("trayHint").textContent = locked
    ? "⏳ 시간이 종료되어 더 이상 붙이거나 옮길 수 없어요."
    : `${placed}/9 칸 배치됨. 스티커를 탭하거나 드래그해서 칸에 넣으세요.`;
}

function chipText(id) {
  if (!serverState) return "";
  const c = serverState.chips.find((c) => c.id === id);
  return c ? c.text : "";
}

function renderBoard(s) {
  const board = $("board");
  board.innerHTML = "";
  const arranging = s.phase === "arrange";
  const playing = s.phase === "playing";
  const cells = (playing && s.me) ? s.me.board : localBoard;
  const colored = (s.me && s.me.colored) ? s.me.colored : [];

  for (let i = 0; i < 9; i++) {
    const cell = document.createElement("div");
    const chipId = cells[i];
    const hasChip = chipId !== null && chipId !== undefined;
    const isMarked = playing && colored[i] && hasChip;

    cell.className = "cell";
    cell.dataset.index = i; // 드롭 위치 판정용
    if (!hasChip) cell.classList.add("empty");
    if (isMarked) cell.classList.add("marked");
    const label = hasChip ? chipText(chipId) : (arranging ? "여기에 놓기" : "");
    const span = document.createElement("span");
    span.className = "cell-text";
    span.textContent = label;
    span.title = label; // 잘린 글자는 마우스를 올리면 전체가 보임
    cell.appendChild(span);

    if (arranging && !isArrangeLocked()) {
      // 빈 칸은 드롭 대상(별도 리스너 불필요), 채워진 칸은 끌어서 이동/탭하면 빼기
      if (hasChip) {
        cell.classList.add("draggable-item");
        cell.addEventListener("pointerdown", (e) =>
          beginPointerDrag(e, { type: "cell", fromIndex: i, text: label }));
      }
    } else if (playing && hasChip && s.me && !s.me.bingoRank) {
      cell.classList.add("clickable");
      cell.addEventListener("click", () => toggleCell(i));
    } else {
      cell.classList.add("locked");
    }
    board.appendChild(cell);
  }

  $("boardTitle").textContent = arranging ? "내 빙고판 (배치중)" : "내 빙고판";
  if (playing && s.me) {
    $("boardHint").textContent = `완성된 줄: ${s.me.lines}줄`;
  } else if (arranging) {
    $("boardHint").textContent = isArrangeLocked()
      ? "⏳ 배치가 잠겼습니다."
      : "칸의 스티커를 탭하면 다시 스티커 목록으로 돌아갑니다.";
  } else {
    $("boardHint").textContent = "";
  }
  // '전체 비우기' 버튼: 배치 단계에서만, 시간 종료 시 비활성
  $("clearBoardBtn").classList.toggle("hidden", !arranging);
  $("clearBoardBtn").disabled = isArrangeLocked();
}

function renderBingoButton(s) {
  const btn = $("bingoBtn");
  const canShow = s.phase === "playing" && s.me && !s.me.bingoRank;
  btn.classList.toggle("hidden", !canShow);
  if (canShow) {
    btn.disabled = !s.me.canBingo;
    btn.textContent = s.me.canBingo ? "🎉 빙고!" : "아직 빙고 조건 미완성";
  }
  // 결과 카드
  const resultCard = $("resultCard");
  if (s.me && s.me.bingoRank) {
    resultCard.classList.remove("hidden");
    $("myRank").textContent = s.me.bingoRank + "등";
  } else {
    resultCard.classList.add("hidden");
  }
}

function renderWinners(s) {
  const list = $("winnerList");
  list.innerHTML = "";
  if (!s.winners.length) {
    $("noWinner").classList.remove("hidden");
    return;
  }
  $("noWinner").classList.add("hidden");
  s.winners.forEach((w) => {
    const li = document.createElement("li");
    li.className = "winner-item";
    const badge = document.createElement("span");
    badge.className = "rank-badge rank-" + w.rank;
    badge.textContent = w.rank;
    const name = document.createElement("span");
    name.textContent = w.name;
    li.appendChild(badge);
    li.appendChild(name);
    list.appendChild(li);
  });
}

// ---------- 터치/마우스 공용 드래그 ----------
const DRAG_THRESHOLD = 8; // 이 거리 이상 움직여야 '드래그', 아니면 '탭'으로 처리

function beginPointerDrag(e, source) {
  // source: {type:'chip'|'cell', chipId?, fromIndex?, text}
  if (isArrangeLocked()) return;
  if (e.button !== undefined && e.button !== 0) return; // 마우스 좌클릭만
  pdrag = {
    type: source.type, chipId: source.chipId, fromIndex: source.fromIndex, text: source.text,
    startX: e.clientX, startY: e.clientY, moved: false, ghost: null, lastCell: null,
  };
  window.addEventListener("pointermove", onPointerMove, { passive: false });
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

function onPointerMove(e) {
  if (!pdrag) return;
  const dx = e.clientX - pdrag.startX, dy = e.clientY - pdrag.startY;
  if (!pdrag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  if (!pdrag.moved) {
    pdrag.moved = true;
    const g = document.createElement("div");
    g.className = "chip drag-ghost";
    g.textContent = pdrag.text;
    document.body.appendChild(g);
    document.body.classList.add("dragging");
    pdrag.ghost = g;
  }
  e.preventDefault(); // 드래그 중 화면 스크롤 방지
  pdrag.ghost.style.left = e.clientX + "px";
  pdrag.ghost.style.top = e.clientY + "px";
  const cell = cellUnder(e.clientX, e.clientY);
  if (cell !== pdrag.lastCell) {
    if (pdrag.lastCell) pdrag.lastCell.classList.remove("dragover");
    if (cell) cell.classList.add("dragover");
    pdrag.lastCell = cell;
  }
}

function onPointerUp(e) {
  if (!pdrag) return;
  const d = pdrag;
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerUp);
  if (d.ghost) d.ghost.remove();
  document.body.classList.remove("dragging");
  if (d.lastCell) d.lastCell.classList.remove("dragover");
  pdrag = null;

  if (!d.moved) {
    // 움직이지 않았으면 '탭'으로 처리
    if (d.type === "chip") placeInFirstEmpty(d.chipId);
    else if (d.type === "cell") removeFromCell(d.fromIndex);
    return;
  }
  // 드롭 위치 판정
  const target = cellUnder(e.clientX, e.clientY);
  if (target && target.dataset.index !== undefined) {
    const toIndex = parseInt(target.dataset.index, 10);
    if (d.type === "chip") {
      setCell(toIndex, d.chipId);
    } else if (d.type === "cell" && toIndex !== d.fromIndex) {
      const tmp = localBoard[toIndex];
      localBoard[toIndex] = localBoard[d.fromIndex];
      localBoard[d.fromIndex] = tmp; // 칸끼리 교환
      saveBoard();
    }
  } else if (d.type === "cell") {
    removeFromCell(d.fromIndex); // 빙고판 밖으로 드롭 → 빼기
  }
}

function cellUnder(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest("#board .cell") : null;
}

function setCell(index, chipId) {
  // 같은 칩이 다른 칸에 있으면 제거
  const old = localBoard.indexOf(chipId);
  if (old !== -1) localBoard[old] = null;
  localBoard[index] = chipId;
  saveBoard();
}

function placeInFirstEmpty(chipId) {
  if (localBoard.includes(chipId)) return;
  const empty = localBoard.indexOf(null);
  if (empty === -1) { toast("빈 칸이 없습니다."); return; }
  localBoard[empty] = chipId;
  saveBoard();
}

function removeFromCell(index) {
  localBoard[index] = null;
  saveBoard();
}

$("clearBoardBtn").addEventListener("click", () => {
  if (isArrangeLocked()) return;
  localBoard = [null, null, null, null, null, null, null, null, null];
  saveBoard();
});

let saveTimer = null;
function saveBoard() {
  renderTray(serverState);
  renderBoard(serverState);
  // 서버에 배치 저장 (디바운스)
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    post("/api/student/board", { clientId, board: localBoard });
  }, 150);
}

// ---------- 게임 조작 ----------
async function toggleCell(index) {
  const res = await post("/api/student/toggle", { clientId, index });
  if (!res.ok) toast(res.error || "오류");
}

$("bingoBtn").addEventListener("click", async () => {
  const res = await post("/api/student/bingo", { clientId });
  if (!res.ok) { toast(res.error || "아직 빙고가 아니에요"); }
});

// ---------- 토스트 ----------
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}
