/** Live FFT spectrum display fed by Web Audio AnalyserNode data. */

const BAR_COUNT = 96;
const STORAGE_KEY = "stemdeck.spectrum";
const FREQ_BUF = new Uint8Array(2048);

let rafId = null;
let idleRafId = null;
let resizeObs = null;
let canvasEl = null;
let readBins = null;
let sampleRateFn = () => 44100;
/** Live FFT reader kept across panel hide/show (toggle off must not discard it). */
let savedReader = null;
let savedSampleRateFn = () => 44100;
let phase = 0;

function spectrumEnabled() {
  try {
    const pref = localStorage.getItem(STORAGE_KEY);
    if (pref === "0") return false;
    if (pref === "1") return true;
  } catch { /* noop */ }
  return true;
}

function setSpectrumBarVisible(visible) {
  const bar = document.getElementById("footer-spectrum-bar");
  bar?.classList.toggle("hidden", !visible);
}

export function isSpectrumVisible() {
  return spectrumEnabled() && !document.getElementById("footer-spectrum-bar")?.classList.contains("hidden");
}

export function syncSpectrumToggleUi() {
  const btn = document.getElementById("t-spectrum-btn");
  if (!btn) return;
  const on = spectrumEnabled();
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", String(on));
  setSpectrumBarVisible(on);
}

export function wireSpectrumToggle() {
  const btn = document.getElementById("t-spectrum-btn");
  if (!btn || btn.dataset.wired === "1") return;
  btn.dataset.wired = "1";
  syncSpectrumToggleUi();
  btn.addEventListener("click", () => {
    const next = !spectrumEnabled();
    try {
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch { /* noop */ }
    syncSpectrumToggleUi();
    const canvas = document.getElementById("footer-spectrum");
    if (next && canvas) {
      if (savedReader) startSpectrumAnalyzer(canvas);
      else initSpectrumPlaceholder();
    } else {
      pauseSpectrumAnalyzer();
    }
  });
}

function logIndex(bar, total, binCount) {
  const minHz = 40;
  const maxHz = Math.min(16000, sampleRateFn() * 0.45);
  const t0 = bar / total;
  const t1 = (bar + 1) / total;
  const hz0 = minHz * ((maxHz / minHz) ** t0);
  const hz1 = minHz * ((maxHz / minHz) ** t1);
  const fftSize = Math.max(2, binCount * 2);
  const binHz = sampleRateFn() / fftSize;
  const maxBin = Math.max(0, binCount - 1);
  return {
    start: Math.max(0, Math.floor(hz0 / binHz)),
    end: Math.min(maxBin, Math.ceil(hz1 / binHz)),
  };
}

function resizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return false;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  return true;
}

export function drawSpectrumPlaceholder(canvas) {
  if (!canvas || !resizeCanvas(canvas)) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  phase += 0.04;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const gap = 2 * (window.devicePixelRatio || 1);
  const barW = (canvas.width - gap * (BAR_COUNT - 1)) / BAR_COUNT;
  const h = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  for (let i = 0; i < BAR_COUNT; i++) {
    const t = i / BAR_COUNT;
    const idle = 0.06 + 0.05 * Math.abs(Math.sin(phase + t * 9.5));
    const barH = Math.max(2 * dpr, idle * h * 0.65);
    const x = i * (barW + gap);
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(x, h - barH, barW, barH);
  }
}

function drawSpectrum(canvas, bins, binCount) {
  if (!resizeCanvas(canvas)) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const dpr = window.devicePixelRatio || 1;
  const gap = 2 * dpr;
  const barW = (canvas.width - gap * (BAR_COUNT - 1)) / BAR_COUNT;
  const h = canvas.height;

  for (let i = 0; i < BAR_COUNT; i++) {
    const { start, end } = logIndex(i, BAR_COUNT, binCount);
    let peak = 0;
    for (let b = start; b <= end && b < binCount; b++) {
      if (bins[b] > peak) peak = bins[b];
    }
    const norm = peak / 255;
    const barH = Math.max(2 * dpr, norm * h * 0.92);
    const x = i * (barW + gap);
    const y = h - barH;

    const grad = ctx.createLinearGradient(0, y, 0, h);
    grad.addColorStop(0, `rgba(244, 183, 64, ${0.35 + norm * 0.65})`);
    grad.addColorStop(0.55, `rgba(244, 183, 64, ${0.15 + norm * 0.45})`);
    grad.addColorStop(1, `rgba(214, 90, 74, ${0.08 + norm * 0.35})`);
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, barW, barH);
  }
}

function tick() {
  if (!canvasEl) return;
  if (!spectrumEnabled()) {
    pauseSpectrumAnalyzer();
    return;
  }
  let drew = false;
  if (readBins) {
    FREQ_BUF.fill(0);
    const binCount = readBins(FREQ_BUF);
    if (binCount > 0) {
      drawSpectrum(canvasEl, FREQ_BUF, binCount);
      drew = true;
    }
  }
  if (!drew) drawSpectrumPlaceholder(canvasEl);
  rafId = requestAnimationFrame(tick);
}

function stopIdleLoop() {
  if (idleRafId) {
    cancelAnimationFrame(idleRafId);
    idleRafId = null;
  }
}

function startIdleLoop(canvas) {
  stopIdleLoop();
  const frame = () => {
    if (readBins || !spectrumEnabled()) {
      idleRafId = null;
      return;
    }
    drawSpectrumPlaceholder(canvas);
    idleRafId = requestAnimationFrame(frame);
  };
  idleRafId = requestAnimationFrame(frame);
}

export function startSpectrumAnalyzer(canvas, { readBins: reader, sampleRate } = {}) {
  pauseSpectrumAnalyzer();
  stopIdleLoop();
  if (reader) {
    savedReader = reader;
    savedSampleRateFn = typeof sampleRate === "function" ? sampleRate : () => 44100;
  }
  const useReader = reader ?? savedReader;
  if (!canvas || !useReader || !spectrumEnabled()) return;
  canvasEl = canvas;
  readBins = useReader;
  sampleRateFn = savedSampleRateFn;
  syncSpectrumToggleUi();
  resizeObs?.disconnect();
  resizeObs = new ResizeObserver(() => {
    if (!canvasEl || !readBins) return;
    FREQ_BUF.fill(0);
    const binCount = readBins(FREQ_BUF);
    if (binCount > 0) drawSpectrum(canvasEl, FREQ_BUF, binCount);
    else drawSpectrumPlaceholder(canvasEl);
  });
  const bar = canvas.closest(".footer-spectrum-bar");
  if (bar) resizeObs.observe(bar);
  rafId = requestAnimationFrame(tick);
}

/** Stop the draw loop but keep the FFT reader for panel toggle / resume. */
export function pauseSpectrumAnalyzer() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  resizeObs?.disconnect();
  resizeObs = null;
  canvasEl = null;
  readBins = null;
}

/** Full teardown — e.g. switching tracks or destroying the player. */
export function stopSpectrumAnalyzer() {
  pauseSpectrumAnalyzer();
  stopIdleLoop();
  savedReader = null;
  savedSampleRateFn = () => 44100;
}

export function kickSpectrum(audioContext) {
  if (audioContext?.state === "suspended") audioContext.resume().catch(() => {});
}

export function initSpectrumPlaceholder() {
  const canvas = document.getElementById("footer-spectrum");
  if (!canvas) return;
  syncSpectrumToggleUi();
  if (!spectrumEnabled()) return;
  drawSpectrumPlaceholder(canvas);
  startIdleLoop(canvas);
}
