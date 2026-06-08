// ===== 축하 연출: 색종이(confetti) + 효과음 (외부 파일 없이 합성) =====
(function () {
  let canvas, ctx, parts = [], raf = null;
  const COLORS = ["#ef4444", "#f59e0b", "#fde047", "#22c55e", "#38bdf8", "#a78bfa", "#f472b6"];

  function ensure() {
    if (canvas) return;
    canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:90";
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
  }
  function resize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  window.confettiBurst = function (count) {
    ensure();
    count = count || 150;
    const W = window.innerWidth;
    for (let i = 0; i < count; i++) {
      parts.push({
        x: W / 2 + (Math.random() - 0.5) * 240,
        y: window.innerHeight * 0.28,
        vx: (Math.random() - 0.5) * 13,
        vy: Math.random() * -13 - 4,
        g: 0.28 + Math.random() * 0.22,
        size: 6 + Math.random() * 7,
        rot: Math.random() * 6,
        vr: (Math.random() - 0.5) * 0.45,
        color: COLORS[i % COLORS.length],
        life: 0,
      });
    }
    if (!raf) loop();
  };

  function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    parts = parts.filter((p) => p.y < canvas.height + 40 && p.life < 280);
    for (const p of parts) {
      p.life++; p.vy += p.g; p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (parts.length) {
      raf = requestAnimationFrame(loop);
    } else {
      raf = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // 효과음 (WebAudio 합성) — 브라우저 정책상 사용자 클릭 이후에 소리가 납니다
  let actx = null;
  window.playFanfare = function () {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
      const notes = [523.25, 659.25, 783.99, 1046.5]; // 도 미 솔 높은도
      notes.forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = "triangle";
        o.frequency.value = f;
        const t = actx.currentTime + i * 0.12;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
        o.connect(g); g.connect(actx.destination);
        o.start(t); o.stop(t + 0.42);
      });
    } catch (e) { /* 무음 무시 */ }
  };

  // 호출 시 짧은 '딩' 소리
  window.playDing = function () {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = "sine"; o.frequency.value = 880;
      const t = actx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g); g.connect(actx.destination);
      o.start(t); o.stop(t + 0.28);
    } catch (e) {}
  };
})();
