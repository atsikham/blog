// ============================================================
//  Background canvas — static infrastructure watermark
//
//  Draws a fixed grid of platform/engineering symbols once on load
//  and on resize. No animation — just a quiet textured backdrop.
//
//  Symbol types:
//    k8s     — proper 7-spoke Kubernetes wheel with outer ring
//    cloud   — rounded cloud silhouette (filled, not outline)
//    server  — rack-mount server unit (rect + drive slots)
//    term    — terminal window chrome (title bar + prompt lines)
//    git     — git branch fork glyph
//    token   — monospace infrastructure keyword
// ============================================================

(function () {
  const canvas = document.getElementById("bgCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // Read --text CSS variable for the symbol colour so it respects the theme.
  function getFgColor() {
    return getComputedStyle(document.documentElement)
      .getPropertyValue("--text").trim() || "#18181b";
  }

  const TOKENS = [
    "kubectl apply -f",
    "helm upgrade",
    "terraform plan",
    "go build ./...",
    "make deploy",
    "kind: Deployment",
    "replicas: 3",
    "namespace: prod",
    "func main()",
    "err != nil",
    "chan struct{}",
    "apiVersion: v1",
    "goroutine",
    "defer wg.Done()",
    "argo sync",
    "docker build",
  ];

  // Types and their relative frequency weights
  const SYMBOL_TYPES = [
    { type: "k8s",    weight: 3 },
    { type: "cloud",  weight: 3 },
    { type: "server", weight: 3 },
    { type: "term",   weight: 2 },
    { type: "git",    weight: 2 },
    { type: "token",  weight: 5 },
  ];

  function weightedType() {
    const total = SYMBOL_TYPES.reduce((s, t) => s + t.weight, 0);
    let r = Math.random() * total;
    for (const t of SYMBOL_TYPES) { r -= t.weight; if (r <= 0) return t.type; }
    return "token";
  }

  function rand(min, max) { return min + Math.random() * (max - min); }

  // ── Kubernetes wheel ──────────────────────────────────────────
  // Faithful to the real logo: 7 spokes, filled blade tips, thick outer ring.
  function drawK8s(x, y, r) {
    const SPOKES = 7;
    ctx.save();
    ctx.translate(x, y);
    // Outer ring
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.lineWidth = r * 0.13;
    ctx.stroke();
    // Inner ring / hub
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.28, 0, Math.PI * 2);
    ctx.fill();
    // Spokes with rectangular blade tips
    for (let i = 0; i < SPOKES; i++) {
      const a = (i / SPOKES) * Math.PI * 2 - Math.PI / 2;
      // Spoke line from hub to inner edge of outer ring
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.28, Math.sin(a) * r * 0.28);
      ctx.lineTo(Math.cos(a) * r * 0.72, Math.sin(a) * r * 0.72);
      ctx.lineWidth = r * 0.12;
      ctx.lineCap = "round";
      ctx.stroke();
      // Blade tip — small rounded rectangle at spoke end
      ctx.save();
      ctx.translate(Math.cos(a) * r * 0.82, Math.sin(a) * r * 0.82);
      ctx.rotate(a + Math.PI / 2);
      const bw = r * 0.18, bh = r * 0.22;
      ctx.beginPath();
      ctx.roundRect(-bw / 2, -bh / 2, bw, bh, bw * 0.4);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // ── Cloud silhouette ──────────────────────────────────────────
  // Solid filled cloud built from overlapping circles — clearly a cloud.
  function drawCloud(x, y, s) {
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    // Bottom base
    ctx.arc(-s * 0.35, s * 0.1,  s * 0.30, 0, Math.PI * 2);
    ctx.arc( s * 0.35, s * 0.1,  s * 0.30, 0, Math.PI * 2);
    ctx.arc( 0,        s * 0.1,  s * 0.35, 0, Math.PI * 2);
    // Top bumps
    ctx.arc(-s * 0.22, -s * 0.12, s * 0.28, 0, Math.PI * 2);
    ctx.arc( s * 0.22, -s * 0.18, s * 0.32, 0, Math.PI * 2);
    ctx.arc( 0,        -s * 0.28, s * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ── Server rack unit ──────────────────────────────────────────
  // 1U rack server: outer chassis + drive bays + status LEDs.
  function drawServer(x, y, w, h) {
    ctx.save();
    ctx.translate(x, y);
    const r = h * 0.18;
    // Chassis
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, r);
    ctx.lineWidth = h * 0.07;
    ctx.stroke();
    // Drive bays — 4 small rectangles
    const bw = w * 0.1, bh = h * 0.45;
    const gap = w * 0.04;
    const totalW = 4 * bw + 3 * gap;
    const startX = -totalW / 2;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.roundRect(startX + i * (bw + gap), -bh / 2, bw, bh, bw * 0.2);
      ctx.lineWidth = h * 0.05;
      ctx.stroke();
    }
    // Status LEDs — 2 small dots on the right
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.arc(w * 0.38, -h * 0.15 + i * h * 0.3, h * 0.07, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ── Terminal window ───────────────────────────────────────────
  // Window chrome with title bar dots + 2–3 prompt lines.
  function drawTerm(x, y, w, h) {
    ctx.save();
    ctx.translate(x, y);
    const r = h * 0.08;
    // Window border
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, r);
    ctx.lineWidth = h * 0.05;
    ctx.stroke();
    // Title bar separator
    const barH = h * 0.22;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + h * 0.05, -h / 2 + barH);
    ctx.lineTo( w / 2 - h * 0.05, -h / 2 + barH);
    ctx.lineWidth = h * 0.04;
    ctx.stroke();
    // Three traffic-light dots
    const dotR = h * 0.07;
    const dotY = -h / 2 + barH * 0.5;
    [-0.28, -0.14, 0].forEach((dx) => {
      ctx.beginPath();
      ctx.arc(dx * w, dotY, dotR, 0, Math.PI * 2);
      ctx.fill();
    });
    // Prompt lines — 3 short horizontal bars simulating text
    const lineH = h * 0.05;
    const lineY = [-h / 2 + barH + h * 0.15, -h / 2 + barH + h * 0.33, -h / 2 + barH + h * 0.51];
    const lineW = [w * 0.65, w * 0.45, w * 0.55];
    lineY.forEach((ly, i) => {
      ctx.beginPath();
      ctx.roundRect(-w * 0.38, ly, lineW[i], lineH, lineH * 0.5);
      ctx.fill();
    });
    ctx.restore();
  }

  // ── Git branch glyph ──────────────────────────────────────────
  // Two circles (commits) connected by lines with a branch fork.
  function drawGit(x, y, s) {
    ctx.save();
    ctx.translate(x, y);
    ctx.lineWidth = s * 0.07;
    ctx.lineCap = "round";
    const cr = s * 0.14; // commit circle radius
    // Main branch: bottom → top
    const c1 = { x: 0,      y:  s * 0.55 };  // commit 1
    const c2 = { x: 0,      y:  0        };  // commit 2 (branch point)
    const c3 = { x: 0,      y: -s * 0.55 };  // commit 3 (main head)
    const c4 = { x: s * 0.5, y: -s * 0.2  };  // branch head
    // Lines
    ctx.beginPath();
    ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y);
    ctx.moveTo(c2.x, c2.y); ctx.lineTo(c3.x, c3.y);
    // Branch line (curve)
    ctx.moveTo(c2.x, c2.y);
    ctx.bezierCurveTo(c2.x, c2.y - s * 0.2, c4.x, c4.y + s * 0.2, c4.x, c4.y);
    ctx.stroke();
    // Commit dots
    [c1, c2, c3, c4].forEach((c) => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, cr, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  // ── Token text ────────────────────────────────────────────────
  function drawToken(text, x, y, size) {
    ctx.font = `${size}px 'JetBrains Mono','Fira Code',monospace`;
    ctx.fillText(text, x, y);
  }

  // ── Layout — place symbols on a soft randomised grid ─────────
  let symbols = [];

  function buildSymbols() {
    symbols = [];
    const W = canvas.width, H = canvas.height;
    // Grid cell size — roughly how far apart symbols are spaced
    const cellW = 220, cellH = 180;
    const cols = Math.ceil(W / cellW) + 1;
    const rows = Math.ceil(H / cellH) + 1;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        // Skip ~40% of cells to avoid uniform tiling
        if (Math.random() < 0.4) continue;
        const type = weightedType();
        // Jitter within the cell
        const x = col * cellW + rand(cellW * 0.1, cellW * 0.9);
        const y = row * cellH + rand(cellH * 0.1, cellH * 0.9);
        const alpha = rand(0.28, 0.55);
        const angle = rand(-0.25, 0.25); // slight tilt for variety
        let size;
        if (type === "k8s")    size = rand(22, 40);
        else if (type === "cloud")  size = rand(26, 46);
        else if (type === "server") size = rand(50, 80);
        else if (type === "term")   size = rand(50, 80);
        else if (type === "git")    size = rand(24, 40);
        else                        size = rand(10, 14);
        const text = (type === "token") ? TOKENS[Math.floor(Math.random() * TOKENS.length)] : null;
        symbols.push({ type, x, y, alpha, angle, size, text });
      }
    }
  }

  // ── Draw all symbols ──────────────────────────────────────────
  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const fgColor = getFgColor();

    for (const s of symbols) {
      ctx.save();
      ctx.globalAlpha = s.alpha;
      ctx.fillStyle   = fgColor;
      ctx.strokeStyle = fgColor;

      if (s.type !== "token") {
        ctx.translate(s.x, s.y);
        ctx.rotate(s.angle);
        ctx.translate(-s.x, -s.y);
      }

      switch (s.type) {
        case "k8s":    drawK8s(s.x, s.y, s.size); break;
        case "cloud":  drawCloud(s.x, s.y, s.size); break;
        case "server": drawServer(s.x, s.y, s.size * 2, s.size * 0.55); break;
        case "term":   drawTerm(s.x, s.y, s.size * 1.8, s.size * 1.3); break;
        case "git":    drawGit(s.x, s.y, s.size); break;
        case "token":  drawToken(s.text, s.x, s.y, s.size); break;
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ── Resize ────────────────────────────────────────────────────
  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    buildSymbols();
    draw();
  }

  window.addEventListener("resize", resize);

  // Redraw when theme changes so colour updates immediately.
  new MutationObserver(() => draw())
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", resize);
  } else {
    resize();
  }
})();
