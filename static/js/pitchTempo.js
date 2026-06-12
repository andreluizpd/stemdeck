import { bpmChip } from "./state.js";
import { storeGet, storeSetDebounced } from "./utils.js";

const STORE_KEY = "stemdeck:pitch-tempo";
const PITCH_MIN = -12;
const PITCH_MAX = 12;
const TEMPO_MIN = 50;
const TEMPO_MAX = 200;

let pitchSemitones = 0;
let tempoPercent = 100;
let preservePitch = true;
let detectedBpm = null;
let detectedKey = null;

const CHROMATIC = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_TO_SHARP = {
  Db: "C#", Eb: "D#", Fb: "E", Gb: "F#", Ab: "G#", Bb: "A#", Cb: "B",
};
let rubberbandAvailable = false;
let reloadFn = null;
let reloadTimer = null;
let reloadPending = false;

export function getPitchSemitones() { return pitchSemitones; }
export function getTempoPercent() { return tempoPercent; }
export function getPreservePitch() { return preservePitch; }
export function getPlaybackRate() { return tempoPercent / 100; }
export function isRubberbandAvailable() { return rubberbandAvailable; }

export function isPitchTempoIdentity() {
  return pitchSemitones === 0 && tempoPercent === 100;
}

export function pitchTempoQueryParams() {
  if (!rubberbandAvailable || isPitchTempoIdentity()) return null;
  return {
    pitch: String(pitchSemitones),
    tempo: (tempoPercent / 100).toFixed(4),
    preserve_pitch: preservePitch ? "1" : "0",
  };
}

export function appendPitchTempoQuery(url) {
  if (!url) return url;
  const params = pitchTempoQueryParams();
  if (!params) return url;
  const u = new URL(url, window.location.origin);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.pathname + u.search;
}

export function stemUrlWithPitchTempo(url) {
  return appendPitchTempoQuery(url);
}

export function registerPitchTempoReload(fn) {
  reloadFn = fn;
}

export async function probePitchTempoBackend() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return;
    const data = await res.json();
    rubberbandAvailable = Boolean(data.pitch_tempo_available);
  } catch (e) {
    console.warn("[pitchTempo] health probe failed:", e);
  }
}

export function setDetectedBpm(bpm) {
  detectedBpm = typeof bpm === "number" && bpm > 0 ? bpm : null;
  updateBpmDisplay();
}

export function setDetectedKey(key) {
  detectedKey = typeof key === "string" && key.trim() && !/^—/.test(key.trim())
    ? key.trim()
    : null;
  syncPitchTempoUi();
}

function parseSongKey(key) {
  if (!key) return null;
  const m = key.match(/^([A-G](?:#|b)?)\s*(maj|min|major|minor)\b/i);
  if (!m) return null;
  let root = m[1][0].toUpperCase() + m[1].slice(1);
  if (root.length === 2) root = root[0] + root[1].toLowerCase();
  root = FLAT_TO_SHARP[root] || root;
  const idx = CHROMATIC.indexOf(root);
  if (idx < 0) return null;
  const mode = m[2].toLowerCase().startsWith("maj") ? "maj" : "min";
  return { idx, mode };
}

export function transposeSongKey(key, semitones) {
  const parsed = parseSongKey(key);
  if (!parsed) return null;
  const idx = (parsed.idx + semitones) % 12;
  const wrapped = idx < 0 ? idx + 12 : idx;
  return `${CHROMATIC[wrapped]} ${parsed.mode}`;
}

function currentTransposedKey() {
  if (!detectedKey) return null;
  return transposeSongKey(detectedKey, pitchSemitones);
}

function updateBpmDisplay() {
  if (!bpmChip) return;
  if (!detectedBpm) {
    bpmChip.textContent = "— BPM";
    return;
  }
  if (tempoPercent === 100) {
    bpmChip.textContent = `${detectedBpm} BPM`;
    return;
  }
  const adjusted = Math.round(detectedBpm * getPlaybackRate());
  bpmChip.textContent = `${detectedBpm} BPM (${adjusted})`;
}

function saveSettings() {
  storeSetDebounced(STORE_KEY, { pitchSemitones, tempoPercent, preservePitch });
}

export async function loadPitchTempoSettings() {
  try {
    const data = await storeGet(STORE_KEY, null);
    if (!data || typeof data !== "object") return;
    if (typeof data.pitchSemitones === "number") {
      pitchSemitones = Math.max(PITCH_MIN, Math.min(PITCH_MAX, data.pitchSemitones));
    }
    if (typeof data.tempoPercent === "number") {
      tempoPercent = Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, data.tempoPercent));
    }
    if (typeof data.preservePitch === "boolean") preservePitch = data.preservePitch;
  } catch (e) {
    console.warn("[pitchTempo] failed to load settings:", e);
  }
}

export function resetPitchTempo() {
  pitchSemitones = 0;
  tempoPercent = 100;
  preservePitch = true;
  schedulePitchTempoReload();
  saveSettings();
  syncPitchTempoUi();
}

function schedulePitchTempoReload() {
  if (!reloadFn) return;
  if (reloadTimer) window.clearTimeout(reloadTimer);
  reloadPending = true;
  reloadTimer = window.setTimeout(async () => {
    reloadTimer = null;
    reloadPending = false;
    try {
      await reloadFn();
    } catch (e) {
      console.warn("[pitchTempo] reload failed:", e);
    }
    syncPitchTempoUi();
  }, 400);
}

export function applyPitchTempo() {
  if (rubberbandAvailable) {
    schedulePitchTempoReload();
    updateBpmDisplay();
    return;
  }
  updateBpmDisplay();
}

function formatPitchLabel(semitones) {
  if (semitones === 0) return "0 st";
  return `${semitones > 0 ? "+" : ""}${semitones} st`;
}

function formatTempoLabel(percent) {
  if (percent === 100) return "100%";
  return `${percent}%`;
}

function updateChipLabel(btn) {
  if (!btn) return;
  const parts = [];
  if (pitchSemitones !== 0) {
    const transposed = currentTransposedKey();
    parts.push(transposed || formatPitchLabel(pitchSemitones));
  }
  if (tempoPercent !== 100) parts.push(formatTempoLabel(tempoPercent));
  btn.textContent = parts.length ? parts.join(" · ") : "Pitch / Tempo";
}

function updatePitchKeyDisplay() {
  const pitchVal = document.getElementById("t-pitch-val");
  const pitchKey = document.getElementById("t-pitch-key");
  if (!pitchVal) return;

  const transposed = currentTransposedKey();
  if (transposed) {
    pitchVal.textContent = formatPitchLabel(pitchSemitones);
    pitchVal.title = `${formatPitchLabel(pitchSemitones)} from ${detectedKey}`;
    if (pitchKey) {
      pitchKey.textContent = transposed;
      pitchKey.classList.remove("hidden");
      pitchKey.removeAttribute("aria-hidden");
    }
    return;
  }

  pitchVal.textContent = formatPitchLabel(pitchSemitones);
  pitchVal.removeAttribute("title");
  if (pitchKey) {
    pitchKey.textContent = "";
    pitchKey.classList.add("hidden");
    pitchKey.setAttribute("aria-hidden", "true");
  }
}

function clampPitch(v) {
  return Math.max(PITCH_MIN, Math.min(PITCH_MAX, v));
}

function clampTempo(v) {
  return Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, v));
}

function setPitchSemitones(next) {
  pitchSemitones = clampPitch(next);
  applyPitchTempo();
  saveSettings();
  syncPitchTempoUi();
}

function setTempoPercent(next) {
  tempoPercent = clampTempo(next);
  applyPitchTempo();
  saveSettings();
  syncPitchTempoUi();
}

export function syncPitchTempoUi() {
  const pitchInput = document.getElementById("t-pitch");
  const tempoInput = document.getElementById("t-tempo");
  const tempoVal = document.getElementById("t-tempo-val");
  const preserveEl = document.getElementById("t-preserve-pitch");
  const pitchMinus = document.getElementById("t-pitch-minus");
  const pitchPlus = document.getElementById("t-pitch-plus");
  const tempoMinus = document.getElementById("t-tempo-minus");
  const tempoPlus = document.getElementById("t-tempo-plus");
  const btn = document.getElementById("t-pitch-tempo-btn");

  if (pitchInput) pitchInput.value = String(pitchSemitones);
  updatePitchKeyDisplay();
  if (tempoInput) tempoInput.value = String(tempoPercent);
  if (tempoVal) tempoVal.textContent = formatTempoLabel(tempoPercent);
  if (preserveEl) preserveEl.checked = preservePitch;
  if (pitchMinus) pitchMinus.disabled = pitchSemitones <= PITCH_MIN;
  if (pitchPlus) pitchPlus.disabled = pitchSemitones >= PITCH_MAX;
  if (tempoMinus) tempoMinus.disabled = tempoPercent <= TEMPO_MIN;
  if (tempoPlus) tempoPlus.disabled = tempoPercent >= TEMPO_MAX;
  if (btn) updateChipLabel(btn);
  updateBpmDisplay();
}

export function syncPitchTempoUiAfterEngineReady() {
  syncPitchTempoUi();
}

export function wirePitchTempoControls(closeAllChipPanels) {
  const btn = document.getElementById("t-pitch-tempo-btn");
  const panel = document.getElementById("t-pitch-tempo-panel");
  const pitchInput = document.getElementById("t-pitch");
  const tempoInput = document.getElementById("t-tempo");
  const preserveEl = document.getElementById("t-preserve-pitch");
  const resetBtn = document.getElementById("t-pitch-tempo-reset");
  const pitchMinus = document.getElementById("t-pitch-minus");
  const pitchPlus = document.getElementById("t-pitch-plus");
  const tempoMinus = document.getElementById("t-tempo-minus");
  const tempoPlus = document.getElementById("t-tempo-plus");

  if (!btn || !panel) return;

  function openPanel() {
    closeAllChipPanels?.();
    panel.classList.remove("hidden");
    btn.setAttribute("aria-expanded", "true");
  }
  function closePanel() {
    panel.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.contains("hidden") ? openPanel() : closePanel();
  });

  panel.addEventListener("click", (e) => e.stopPropagation());

  pitchInput?.addEventListener("input", () => {
    setPitchSemitones(parseInt(pitchInput.value, 10) || 0);
  });

  tempoInput?.addEventListener("input", () => {
    setTempoPercent(parseInt(tempoInput.value, 10) || 100);
  });

  pitchMinus?.addEventListener("click", (e) => {
    e.stopPropagation();
    setPitchSemitones(pitchSemitones - 1);
  });

  pitchPlus?.addEventListener("click", (e) => {
    e.stopPropagation();
    setPitchSemitones(pitchSemitones + 1);
  });

  tempoMinus?.addEventListener("click", (e) => {
    e.stopPropagation();
    setTempoPercent(tempoPercent - 5);
  });

  tempoPlus?.addEventListener("click", (e) => {
    e.stopPropagation();
    setTempoPercent(tempoPercent + 5);
  });

  preserveEl?.addEventListener("change", () => {
    preservePitch = preserveEl.checked;
    applyPitchTempo();
    saveSettings();
    syncPitchTempoUi();
  });

  resetBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    resetPitchTempo();
  });

  pitchInput?.addEventListener("dblclick", () => setPitchSemitones(0));
  tempoInput?.addEventListener("dblclick", () => setTempoPercent(100));

  probePitchTempoBackend().then(async () => {
    await loadPitchTempoSettings();
    syncPitchTempoUi();
    if (!isPitchTempoIdentity()) schedulePitchTempoReload();
  });
}
