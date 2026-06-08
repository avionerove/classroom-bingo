// ============ 전자칠판(프로젝션) 화면 — 교실 TV에서 직접 진행 ============
const RULE_LABEL = { "1line": "한 줄", "2line": "두 줄", "3line": "세 줄", "full": "풀하우스" };
const $ = (id) => document.getElementById(id);
let serverState = null;
let lastCall = null;
let prevWinners = null, celebrateInit = false;

// 배치 타이머
let arrangeDeadline = null, arrangeHasLimit = false, arrangeTotalMs = 0;

function fmtTime(ms) {
  const t = Math.ceil(ms / 1000);
  const m = Math.floor(t / 60), s = t % 60;
  return m + ":" + String(s).padStart(2, "0");
}
function remainingMs() {
  if (!arrangeHasLimit || arrangeDeadline === null) return null;
  return Math.max(0, arrangeDeadline - Date.now());
}
function syncTimer(s) {
  if (s.phase === "arrange" && s.arrangeRemainingMs !== null && s.arrangeRemainingMs !== undefined) {
    arrangeHasLimit = true;
    arrangeDeadline = Date.now() + s.arrangeRemainingMs;
    arrangeTotalMs = (s.arrangeSeconds || 0) * 1000;
  } else {
    arrangeHasLimit = false; arrangeDeadline = null; arrangeTotalMs = 0;
  }
}

// 부를 때 학생에게 보이는 라벨(=서버 호출 내용). 일반=단어, 학습=문제. (정답은 칠판에 노출 안 함)
function callLabel(chip) { return chip ? chip.clue : ""; }

// ---------- 통신 ----------
async function post(url, body) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    return await r.json();
  } catch (e) { return { ok: false, error: "통신 오류" }; }
}
async function startPolling() {
  let since = 0;
  while (true) {
    try {
      const r = await fetch(`/api/state?role=teacher&since=${since}`);
      const data = await r.json();
      since = data.version;
      serverState = data;
      syncTimer(data);
      render();
    } catch (e) {
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
}

// ---------- 버튼 동작 ----------
$("presentExtendBtn").addEventListener("click", () => post("/api/teacher/extend", { seconds: 30 }));
$("presentStartBtn").addEventListener("click", () => post("/api/teacher/control", { action: "play" }));
$("presentRandomBtn").addEventListener("click", () => callNow(null));
async function callNow(chipId) {
  const res = await post("/api/teacher/call", chipId == null ? {} : { chipId });
  if (!res.ok) return;
  if (window.playDing) playDing();
}

// ---------- 렌더 ----------
function render() {
  const s = serverState;
  if (!s) return;
  $("presentRule").textContent = "규칙: " + (RULE_LABEL[s.rule] || s.rule) + " 완성";
  const total = (s.chips || []).length;
  const calledCount = (s.called || []).length;
  $("presentProgress").textContent = `${calledCount} / ${total}`;

  $("presentLobby").classList.toggle("hidden", s.phase !== "lobby");
  $("presentArrange").classList.toggle("hidden", s.phase !== "arrange");
  $("presentPlay").classList.toggle("hidden", s.phase !== "playing");

  if (s.phase === "arrange") renderArrange(s);
  if (s.phase === "playing") renderPlay(s);

  maybeCelebrate(s);
}

function renderArrange(s) {
  updateTimerUI();
  // 붙일 스티커들 (읽기 전용)
  const box = $("presentArrangeStickers");
  box.innerHTML = "";
  (s.chips || []).forEach((c) => {
    const el = document.createElement("div");
    el.className = "p-sticker";
    el.textContent = callLabel(c);
    box.appendChild(el);
  });
}

function updateTimerUI() {
  const box = $("presentTimerBox"), bar = $("presentBar").parentElement;
  if (!arrangeHasLimit) {
    box.classList.add("hidden"); bar.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden"); bar.classList.remove("hidden");
  const rem = remainingMs(), sec = rem / 1000;
  $("presentTime").textContent = rem <= 0 ? "시간 종료" : fmtTime(rem);
  $("presentBar").style.width = (arrangeTotalMs > 0 ? Math.max(0, Math.min(100, rem / arrangeTotalMs * 100)) : 0) + "%";
  box.classList.toggle("warn-time", sec <= 30 && sec > 10);
  box.classList.toggle("danger-time", sec <= 10 && rem > 0);
  box.classList.toggle("ended", rem <= 0);
}

function renderPlay(s) {
  // 가운데 큰 문제
  if (s.currentCall && s.currentCall.clue) {
    $("presentLabel").textContent = "이번 문제";
    $("presentCall").classList.remove("hint-mode");
    setCall(s.currentCall.clue);
  } else {
    $("presentLabel").textContent = "";
    $("presentCall").classList.add("hint-mode");
    $("presentCall").textContent = "🎲 랜덤 선택 또는 스티커를 누르세요";
    lastCall = null;
  }
  // 누를 수 있는 스티커들
  const calledSet = new Set(s.called || []);
  const total = (s.chips || []).length;
  const box = $("presentCallStickers");
  box.innerHTML = "";
  (s.chips || []).forEach((c) => {
    const used = calledSet.has(c.id);
    const el = document.createElement("button");
    el.className = "p-sticker clickable" + (used ? " used" : "");
    el.textContent = callLabel(c);
    if (!used) el.addEventListener("click", () => callNow(c.id));
    box.appendChild(el);
  });
  const done = calledSet.size >= total && total > 0;
  $("presentRandomBtn").disabled = done;
  $("presentRandomBtn").textContent = done ? "모든 문제를 다 불렀어요" : "🎲 랜덤 선택";

  renderHistory(s);
  renderWinners(s);
}

function setCall(text) {
  $("presentCall").textContent = text;
  if (text !== lastCall) {
    lastCall = text;
    const el = $("presentCall");
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
  }
}

function renderHistory(s) {
  const ids = s.called || [];
  $("presentHistoryTitle").style.visibility = ids.length ? "visible" : "hidden";
  const box = $("presentHistory");
  box.innerHTML = "";
  ids.forEach((id, i) => {
    const chip = (s.chips || []).find((c) => c.id === id);
    const el = document.createElement("div");
    el.className = "h-chip" + (i === ids.length - 1 ? " current" : "");
    el.textContent = callLabel(chip);
    box.appendChild(el);
  });
}

function renderWinners(s) {
  const box = $("presentWinners");
  box.innerHTML = "";
  (s.winners || []).forEach((w) => {
    const el = document.createElement("div");
    el.className = "pw rank-bg-" + w.rank;
    el.textContent = `${medal(w.rank)} ${w.name}`;
    box.appendChild(el);
  });
}
function medal(rank) {
  return rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}등`;
}

function maybeCelebrate(s) {
  const n = (s.winners || []).length;
  if (!celebrateInit) { celebrateInit = true; prevWinners = n; return; }
  if (n > prevWinners) {
    const w = s.winners[n - 1];
    if (w) {
      if (window.confettiBurst) confettiBurst(220);
      if (window.playFanfare) playFanfare();
      $("celebrateText").textContent = `${medal(w.rank)} ${w.name} 빙고!`;
      $("celebrate").classList.remove("hidden");
      setTimeout(() => $("celebrate").classList.add("hidden"), 3500);
    }
  }
  prevWinners = n;
}

// 타이머 똑딱 (시간 종료 순간 한 번 더 렌더)
let wasEnded = false;
setInterval(() => {
  if (!serverState || serverState.phase !== "arrange") return;
  updateTimerUI();
}, 250);

startPolling();
