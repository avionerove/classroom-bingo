// ============ 선생님 클라이언트 ============
const PHASE_LABEL = {
  lobby: "준비 중", arrange: "배치 단계", playing: "게임 진행 중"
};
const RULE_LABEL = {
  "1line": "한 줄", "2line": "두 줄", "3line": "세 줄", "full": "풀하우스"
};

const $ = (id) => document.getElementById(id);
let serverState = null;
let chips = [];          // 로컬 편집중인 칩 텍스트 목록
let chipsDirty = false;  // 서버와 다를 수 있음

// 배치 단계 타이머 (모래시계)
let arrangeDeadline = null, arrangeHasLimit = false, arrangeTotalMs = 0;

function fmtTime(ms) {
  const t = Math.ceil(ms / 1000);
  const m = Math.floor(t / 60), s = t % 60;
  return m + ":" + String(s).padStart(2, "0");
}
function arrangeRemainingMs() {
  if (!arrangeHasLimit || arrangeDeadline === null) return null;
  return Math.max(0, arrangeDeadline - Date.now());
}
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
  const box = $("teacherTimer");
  const show = serverState && serverState.phase === "arrange" && arrangeHasLimit;
  box.classList.toggle("hidden", !show);
  if (!show) return;
  const rem = arrangeRemainingMs();
  const sec = rem / 1000;
  $("ttime").textContent = rem <= 0 ? "시간 종료" : fmtTime(rem);
  const pct = arrangeTotalMs > 0 ? Math.max(0, Math.min(100, (rem / arrangeTotalMs) * 100)) : 0;
  $("tbar").style.width = pct + "%";
  box.classList.toggle("warn-time", sec <= 30 && sec > 10);
  box.classList.toggle("danger-time", sec <= 10 && rem > 0);
  box.classList.toggle("ended", rem <= 0);
}
setInterval(() => { if (serverState) updateTimerUI(); }, 250);

// 학생 입장 주소 표시 + 복사 버튼
$("studentUrl").textContent = window.location.origin + "/";
$("copyUrlBtn").addEventListener("click", async () => {
  const url = window.location.origin + "/";
  try {
    await navigator.clipboard.writeText(url);
    toast("학생 주소가 복사되었어요!");
  } catch (e) {
    // 클립보드 권한이 없을 때: 임시 선택 방식으로 복사 시도
    const ta = document.createElement("textarea");
    ta.value = url; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("학생 주소가 복사되었어요!"); }
    catch (e2) { toast("복사 실패 — 주소를 길게 눌러 직접 복사하세요."); }
    ta.remove();
  }
});

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

async function startPolling() {
  let since = 0;
  while (true) {
    try {
      const r = await fetch(`/api/state?role=teacher&since=${since}`);
      const data = await r.json();
      since = data.version;
      serverState = data;
      syncTimerFromServer(data);
      render();
    } catch (e) {
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
}

// ---------- 빙고 방식 (simple: 답만 부르기 / quiz: 문제→답) ----------
function curMode() { return $("modeSelect").value; }
function applyModeUI() {
  const quiz = curMode() === "quiz";
  $("clueInput").classList.toggle("hidden", !quiz);
  $("chipInput").placeholder = quiz ? "칸에 들어갈 답 (예: 56)" : "부를 단어/숫자 (예: 사과)";
  $("modeHint").textContent = quiz
    ? "문제를 먼저 쓰고, 칸에 들어갈 답을 입력하세요. 학생은 문제를 보고 답 칸을 찾습니다."
    : "입력한 단어/숫자를 그대로 부릅니다.";
}
$("modeSelect").addEventListener("change", async () => {
  applyModeUI();
  renderChipTray();
  const res = await post("/api/teacher/mode", { mode: curMode() });
  if (!res.ok) toast(res.error || "방식 저장 실패");
});

// ---------- 스티커 편집 (chips: [{text(정답), clue(문제/단서)}]) ----------
// 학습 모드: 문제(clueInput) 먼저 → Enter로 답(chipInput)으로 이동 → Enter로 추가
$("clueInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) $("chipInput").focus();
});
$("chipInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) addChip();
});
$("addChipBtn").addEventListener("click", addChip);

function addChip() {
  const quiz = curMode() === "quiz";
  const answer = $("chipInput").value.trim();
  const clue = $("clueInput").value.trim();
  if (quiz && !clue) { $("clueInput").focus(); return; }  // 학습 모드: 문제 먼저
  if (!answer) { $("chipInput").focus(); return; }
  chips.push({ text: answer, clue: quiz ? clue : "" });
  $("chipInput").value = "";
  $("clueInput").value = "";
  (quiz ? $("clueInput") : $("chipInput")).focus();
  pushChips();
}

$("clearChipsBtn").addEventListener("click", () => {
  if (!confirm("모든 스티커를 삭제할까요? 학생들의 배치도 초기화됩니다.")) return;
  chips = [];
  pushChips();
});

function removeChip(idx) {
  chips.splice(idx, 1);
  pushChips();
}

async function pushChips() {
  renderChipTray();
  const res = await post("/api/teacher/chips", { chips });
  if (!res.ok) toast(res.error || "스티커 저장 실패");
}

function renderChipTray() {
  const quiz = curMode() === "quiz";
  const tray = $("chipTray");
  tray.innerHTML = "";
  chips.forEach((item, idx) => {
    const el = document.createElement("div");
    el.className = "chip";
    el.style.cursor = "pointer";
    const label = (quiz && item.clue)
      ? `${escapeHtml(item.clue)} <span style="opacity:.6;">→</span> ${escapeHtml(item.text)}`
      : escapeHtml(item.text);
    el.innerHTML = `<span>${label}</span> <span style="opacity:.6;margin-left:6px;">✕</span>`;
    el.title = "클릭하면 삭제";
    el.addEventListener("click", () => removeChip(idx));
    tray.appendChild(el);
  });
  $("chipCount").textContent = `${chips.length}개` + (chips.length < 9 ? " (9개 이상 권장)" : "");
}

// ---------- 제목 & 설명 ----------
let titleSaveTimer = null;
$("titleInput").addEventListener("input", () => {
  clearTimeout(titleSaveTimer);
  titleSaveTimer = setTimeout(() => post("/api/teacher/title", { title: $("titleInput").value }), 300);
});
let descSaveTimer = null;
$("descInput").addEventListener("input", () => {
  clearTimeout(descSaveTimer);
  descSaveTimer = setTimeout(() => post("/api/teacher/desc", { description: $("descInput").value }), 300);
});

// ---------- 규칙 ----------
$("ruleSelect").addEventListener("change", async () => {
  const res = await post("/api/teacher/rule", { rule: $("ruleSelect").value });
  if (!res.ok) toast(res.error || "규칙 저장 실패");
});

// ---------- 제한시간 ----------
$("timeSelect").addEventListener("change", async () => {
  const res = await post("/api/teacher/arrange-time", { seconds: parseInt($("timeSelect").value, 10) });
  if (!res.ok) toast(res.error || "제한시간 저장 실패");
});

$("extendBtn").addEventListener("click", async () => {
  const res = await post("/api/teacher/extend", { seconds: 30 });
  if (!res.ok) toast(res.error || "연장 실패");
});

// ---------- 진행 컨트롤 ----------
$("arrangeBtn").addEventListener("click", () => {
  if (chips.length < 1) { toast("먼저 스티커를 만들어주세요."); return; }
  control("arrange");
});
$("playBtn").addEventListener("click", () => control("play"));
$("replayBtn").addEventListener("click", () => {
  if (confirm("학생들의 색칠과 빙고 순위를 초기화하고 다시 시작할까요? (배치는 유지)")) control("replay");
});
$("resetBtn").addEventListener("click", () => {
  if (confirm("전체 초기화: 배치·색칠·순위가 모두 사라지고 준비 단계로 돌아갑니다. 진행할까요?")) control("reset");
});

async function control(action) {
  const res = await post("/api/teacher/control", { action });
  if (!res.ok) toast(res.error || "오류");
}

async function kick(clientId, name) {
  if (!confirm(`'${name}' 학생을 내보낼까요?`)) return;
  await post("/api/teacher/kick", { clientId });
}

// ---------- 전자칠판(프로젝션) 창 ----------
$("presentBtn").addEventListener("click", () => {
  window.open("/present", "bingoPresent", "width=1280,height=800");
});

// ---------- 문제 부르기 ----------
$("callBtn").addEventListener("click", () => callNow(null));
async function callNow(chipId) {
  const res = await post("/api/teacher/call", chipId == null ? {} : { chipId });
  if (!res.ok) { toast(res.error || "호출 실패"); return; }
  if (window.playDing) playDing();
}

function renderCall(s) {
  const show = s.phase === "playing";
  $("callCard").classList.toggle("hidden", !show);
  if (!show) return;
  const total = s.chips.length;
  const calledSet = new Set(s.called || []);
  $("callProgress").textContent = `${calledSet.size} / ${total}`;
  if (s.currentCall) {
    $("callMain").textContent = s.currentCall.clue;
    $("callAnswer").textContent =
      (s.currentCall.clue !== s.currentCall.text) ? `정답: ${s.currentCall.text}` : "";
  } else {
    $("callMain").textContent = "아래 버튼을 눌러 시작하세요";
    $("callAnswer").textContent = "";
  }
  const done = calledSet.size >= total;
  $("callBtn").disabled = done;
  $("callBtn").textContent = done ? "모든 문제를 다 불렀어요" : "🎲 랜덤 선택";
  const pool = $("callPool");
  pool.innerHTML = "";
  s.chips.forEach((c) => {
    const el = document.createElement("div");
    const used = calledSet.has(c.id);
    el.className = "chip" + (used ? " used" : "");
    el.textContent = (c.clue && c.clue !== c.text) ? `${c.clue} → ${c.text}` : c.text;
    if (!used) el.addEventListener("click", () => callNow(c.id));
    pool.appendChild(el);
  });
}

// ---------- 빙고 축하 연출 ----------
let prevWinners = null, celebrateTimer = null;
function maybeCelebrate(s) {
  const n = s.winners.length;
  if (prevWinners === null) { prevWinners = n; return; } // 첫 로드는 연출 안 함
  if (n > prevWinners) {
    const w = s.winners[n - 1];
    if (w) showCelebrate(`🎉 ${w.rank}등  ${escapeHtml(w.name)}!`);
  }
  prevWinners = n;
}
function showCelebrate(html) {
  if (window.confettiBurst) confettiBurst();
  if (window.playFanfare) playFanfare();
  $("celebrateText").innerHTML = html;
  $("celebrate").classList.remove("hidden");
  clearTimeout(celebrateTimer);
  celebrateTimer = setTimeout(() => $("celebrate").classList.add("hidden"), 3500);
}

// ---------- 렌더 ----------
function render() {
  const s = serverState;
  if (!s) return;

  // 서버 스티커를 로컬 편집 목록과 동기화 (입력 중이 아닐 때만)
  const editing = document.activeElement === $("chipInput") || document.activeElement === $("clueInput");
  const serverItems = s.chips.map((c) => ({ text: c.text, clue: c.clue === c.text ? "" : c.clue }));
  if (!editing && JSON.stringify(serverItems) !== JSON.stringify(chips)) {
    chips = serverItems;
    renderChipTray();
  }

  // 방식 셀렉트 (다른 곳에서 바뀌었을 때 동기화)
  if (document.activeElement !== $("modeSelect") && $("modeSelect").value !== s.mode) {
    $("modeSelect").value = s.mode;
    applyModeUI();
    renderChipTray();
  }
  // 제목·설명 (입력 중이 아닐 때만 동기화)
  if (document.activeElement !== $("titleInput") && $("titleInput").value !== (s.title || "")) {
    $("titleInput").value = s.title || "";
  }
  if (document.activeElement !== $("descInput") && $("descInput").value !== (s.description || "")) {
    $("descInput").value = s.description || "";
  }
  // 규칙 셀렉트
  if ($("ruleSelect").value !== s.rule) $("ruleSelect").value = s.rule;
  // 제한시간 셀렉트
  if (document.activeElement !== $("timeSelect") && $("timeSelect").value !== String(s.arrangeSeconds)) {
    $("timeSelect").value = String(s.arrangeSeconds);
  }
  updateTimerUI();

  // 단계 표시
  $("phasePill").textContent = PHASE_LABEL[s.phase] || s.phase;
  $("phaseHint").textContent = phaseHint(s);

  renderCall(s);
  renderWinners(s);
  renderStudents(s);
  maybeCelebrate(s);
}

function phaseHint(s) {
  if (s.phase === "lobby") return "스티커와 규칙을 정한 뒤 '배치 단계 시작'을 누르세요.";
  if (s.phase === "arrange") return "학생들이 스티커를 배치하는 중입니다. 모두 배치되면 '게임 시작'을 누르세요.";
  if (s.phase === "playing") return `게임 진행 중 — 규칙: ${RULE_LABEL[s.rule]} 완성. '랜덤 선택'이나 스티커를 눌러 문제를 부르세요!`;
  return "";
}

function renderWinners(s) {
  const list = $("winnerList");
  list.innerHTML = "";
  if (!s.winners.length) { $("noWinner").classList.remove("hidden"); return; }
  $("noWinner").classList.add("hidden");
  s.winners.forEach((w) => {
    const li = document.createElement("li");
    li.className = "winner-item";
    li.innerHTML = `<span class="rank-badge rank-${w.rank}">${w.rank}</span><span>${escapeHtml(w.name)}</span>`;
    list.appendChild(li);
  });
}

function renderStudents(s) {
  const tbody = $("studentRows");
  tbody.innerHTML = "";
  const online = s.students.filter((x) => x.online).length;
  $("studentCount").textContent = `${online}명 접속 / 총 ${s.students.length}명`;
  if (!s.students.length) { $("noStudent").classList.remove("hidden"); return; }
  $("noStudent").classList.add("hidden");

  s.students.forEach((st) => {
    const tr = document.createElement("tr");
    const statusPill = st.online
      ? '<span class="pill on">접속</span>'
      : '<span class="pill off">나감</span>';
    const bingo = st.bingoRank
      ? `<span class="rank-badge rank-${st.bingoRank}">${st.bingoRank}</span>`
      : '<span class="muted">-</span>';
    const reach = st.reach ? '<span class="reach-badge">리치!</span>' : '<span class="muted">-</span>';
    if (st.reach) tr.classList.add("is-reach");
    tr.innerHTML = `
      <td><b>${escapeHtml(st.name)}</b></td>
      <td>${statusPill}</td>
      <td>${st.placed}/9</td>
      <td>${st.colored}/9</td>
      <td>${st.lines}</td>
      <td>${reach}</td>
      <td>${bingo}</td>
      <td><button class="small secondary danger" data-kick="${st.clientId}" data-name="${escapeHtml(st.name)}">내보내기</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll("[data-kick]").forEach((btn) => {
    btn.addEventListener("click", () => kick(btn.getAttribute("data-kick"), btn.getAttribute("data-name")));
  });
}

// ---------- 유틸 ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

applyModeUI();
renderChipTray();
startPolling();
