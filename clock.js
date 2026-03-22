// ── Constants ─────────────────────────────────────────────
const CIRC = 2 * Math.PI * 52; // SVG arc circumference ≈ 326.73

const PRESETS = [
  { label: '1+0',  ms:  1 * 60000 },
  { label: '3+0',  ms:  3 * 60000 },
  { label: '5+0',  ms:  5 * 60000 },
  { label: '10+0', ms: 10 * 60000 },
  { label: '30+0', ms: 30 * 60000 },
  { label: '60+0', ms: 60 * 60000 },
];

// ── localStorage helpers ──────────────────────────────────
function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

// ── Persistent settings ───────────────────────────────────
let selectedPreset = lsGet('chess_clock_preset', '5+0');
let whiteBottom    = lsGet('chess_clock_white_bottom', true);
let soundOn        = lsGet('chess_clock_sound_on', true);
let boardSide      = lsGet('chess_clock_board_side', 'right');

let presetMs = (PRESETS.find(p => p.label === selectedPreset) || PRESETS[2]).ms;

// ── Game state ────────────────────────────────────────────
// States: START_SCREEN | READY | RUNNING | PAUSED | FLAGGED
let gameState    = 'START_SCREEN';
let activePlayer = 1; // 1 = bottom (White), 2 = top (Black)
let remaining    = { 1: presetMs, 2: presetMs };
let turnStart    = null;
let timeAtTurnStart = null;
let rafId        = null;
let wakeLock     = null;

// ── Audio (Web Audio API — no external files) ────────────
let audioCtx = null;

const ICON_SOUND_ON  = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';
const ICON_SOUND_OFF = 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z';

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

async function playTap() {
  if (!soundOn) return;
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(260, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.07);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.1);
  } catch (e) {}
}

async function playAlarm() {
  if (!soundOn) return;
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    [0, 0.28, 0.56].forEach(t => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'square';
      osc.frequency.setValueAtTime(440, ctx.currentTime + t);
      osc.frequency.setValueAtTime(330, ctx.currentTime + t + 0.1);
      gain.gain.setValueAtTime(0.18, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.24);
      osc.start(ctx.currentTime + t); osc.stop(ctx.currentTime + t + 0.24);
    });
  } catch (e) {}
}

// ── Haptic ───────────────────────────────────────────────
function vibrate() {
  try { if ('vibrate' in navigator) navigator.vibrate(30); } catch (e) {}
}

// ── Wake Lock ─────────────────────────────────────────────
async function grabWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {}
}
function dropWakeLock() {
  try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && gameState === 'RUNNING') grabWakeLock();
});

// ── Time formatting ───────────────────────────────────────
function formatTime(ms) {
  if (ms <= 0) return '0.0';
  if (ms >= 60000) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  const s = Math.floor(ms / 1000);
  const d = Math.floor((ms % 1000) / 100);
  return `${s}.${d}`;
}

// ── Arc update ────────────────────────────────────────────
function setArc(arcEl, fraction) {
  arcEl.style.strokeDashoffset = CIRC * (1 - Math.max(0, Math.min(1, fraction)));
}

// ── Live time computation ─────────────────────────────────
function getLive() {
  const live = { ...remaining };
  if (gameState === 'RUNNING' && turnStart !== null) {
    live[activePlayer] = Math.max(0, timeAtTurnStart - (performance.now() - turnStart));
  }
  return live;
}

// ── Render loop ───────────────────────────────────────────
function render() {
  const live = getLive();

  document.getElementById('time1').textContent = formatTime(live[1]);
  document.getElementById('time2').textContent = formatTime(live[2]);

  setArc(document.getElementById('arc1'), live[1] / presetMs);
  setArc(document.getElementById('arc2'), live[2] / presetMs);

  // Panel visual states
  [1, 2].forEach(p => {
    const el = document.getElementById(`p${p}`);
    el.classList.remove('active', 'critical', 'flagged');
    if (gameState === 'FLAGGED' && live[p] <= 0) {
      el.classList.add('flagged');
    } else if (gameState === 'RUNNING' && activePlayer === p) {
      el.classList.add('active');
      if (live[p] < 10000) el.classList.add('critical');
    }
  });

  // "Tap to begin" prompt on White's panel
  document.getElementById('tap-prompt').style.display = gameState === 'READY' ? '' : 'none';

  // Flag fall check
  if (gameState === 'RUNNING' && live[activePlayer] <= 0) {
    doFlagFall();
    return;
  }

  if (gameState === 'RUNNING') rafId = requestAnimationFrame(render);
}

// ── Flag fall ─────────────────────────────────────────────
function doFlagFall() {
  remaining[activePlayer] = 0;
  gameState = 'FLAGGED';
  cancelAnimationFrame(rafId);
  dropWakeLock();
  playAlarm();
  updateControlStrip();
  render();
}

// ── Panel tap ─────────────────────────────────────────────
function handleTap(player) {
  // In READY, only White's panel (p1) can start the game
  if (gameState === 'READY' && player === 1) {
    gameState = 'RUNNING';
    activePlayer = 1;
    turnStart = performance.now();
    timeAtTurnStart = remaining[1];
    grabWakeLock();
    updateControlStrip();
    rafId = requestAnimationFrame(render);
    return;
  }

  if (gameState !== 'RUNNING') return;
  if (player !== activePlayer) return;

  remaining[activePlayer] = Math.max(0, timeAtTurnStart - (performance.now() - turnStart));
  activePlayer = activePlayer === 1 ? 2 : 1;
  turnStart = performance.now();
  timeAtTurnStart = remaining[activePlayer];

  playTap();
  vibrate();
}

// Touch/click handlers for clock panels
['p1', 'p2'].forEach(id => {
  const el = document.getElementById(id);
  const player = id === 'p1' ? 1 : 2;
  el.addEventListener('touchstart', e => {
    e.preventDefault();
    handleTap(player);
  }, { passive: false });
  el.addEventListener('click', () => handleTap(player));
});

// ── Clock view control handlers ───────────────────────────
function handlePause() {
  if (gameState === 'RUNNING') {
    remaining[activePlayer] = Math.max(0, timeAtTurnStart - (performance.now() - turnStart));
    cancelAnimationFrame(rafId);
    gameState = 'PAUSED';
    dropWakeLock();
    updateControlStrip();
    render();
  } else if (gameState === 'PAUSED') {
    gameState = 'RUNNING';
    turnStart = performance.now();
    timeAtTurnStart = remaining[activePlayer];
    grabWakeLock();
    updateControlStrip();
    rafId = requestAnimationFrame(render);
  }
}

function handleEndGame() {
  cancelAnimationFrame(rafId);
  dropWakeLock();
  gameState = 'START_SCREEN';
  showStartScreen();
}

function handleSoundToggle() {
  soundOn = !soundOn;
  lsSet('chess_clock_sound_on', soundOn);
  updateSoundBtn();
}

function handleBoardSideToggle() {
  boardSide = boardSide === 'right' ? 'left' : 'right';
  lsSet('chess_clock_board_side', boardSide);
  applyBoardSide();
}

// ── Start screen handlers ─────────────────────────────────
function handleSwap() {
  whiteBottom = !whiteBottom;
  updateStartZoneLabels();
}

function handleRandomize() {
  whiteBottom = Math.random() < 0.5;
  updateStartZoneLabels();
}

function handlePresetSelect(label) {
  selectedPreset = label;
  presetMs = PRESETS.find(p => p.label === label).ms;
  document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.preset === label);
  });
}

function handleStartGame() {
  lsSet('chess_clock_preset', selectedPreset);
  lsSet('chess_clock_white_bottom', whiteBottom);

  remaining = { 1: presetMs, 2: presetMs };
  activePlayer = 1;
  turnStart = null;
  timeAtTurnStart = null;
  gameState = 'READY';

  showClockView();
  updateControlStrip();
  render();
}

// ── View switching ────────────────────────────────────────
function showStartScreen() {
  document.getElementById('start-screen').style.display = '';
  document.getElementById('clock-view').style.display = 'none';
  updateStartZoneLabels();
  document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.preset === selectedPreset);
  });
}

function showClockView() {
  document.getElementById('start-screen').style.display = 'none';
  document.getElementById('clock-view').style.display = '';
  updateRingSize();
}

const ICON_PAUSE  = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';
const ICON_PLAY   = 'M8 5v14l11-7z';

// ── Control strip state ───────────────────────────────────
function updateControlStrip() {
  const running = gameState === 'RUNNING';
  const paused  = gameState === 'PAUSED';

  const btnPause  = document.getElementById('btn-pause');
  const lblPause  = document.getElementById('pause-label');
  const iconPause = btnPause.querySelector('path');

  // Pause visible only while game is in progress
  const showPause = running || paused;
  btnPause.style.display = showPause ? '' : 'none';
  lblPause.textContent = paused ? 'Resume' : 'Pause';
  iconPause.setAttribute('d', paused ? ICON_PLAY : ICON_PAUSE);

  updateSoundBtn();
}

function updateSoundBtn() {
  const btn  = document.getElementById('btn-sound');
  const path = document.querySelector('.sound-icon-path');
  if (path) path.setAttribute('d', soundOn ? ICON_SOUND_ON : ICON_SOUND_OFF);
  btn.classList.toggle('muted', !soundOn);
  btn.querySelector('.btn-label').textContent = soundOn ? 'Sound' : 'Muted';
}

function updateStartZoneLabels() {
  document.getElementById('bottom-color-label').textContent = whiteBottom ? 'White' : 'Black';
  document.getElementById('top-color-label').textContent    = whiteBottom ? 'Black' : 'White';
}

// ── Board-side ────────────────────────────────────────────
function applyBoardSide() {
  document.querySelectorAll('.board-side-target').forEach(el => {
    el.classList.toggle('board-left',  boardSide === 'left');
    el.classList.toggle('board-right', boardSide === 'right');
  });
}

// ── Ring sizing ───────────────────────────────────────────
function updateRingSize() {
  const panel = document.getElementById('p1');
  if (!panel || !panel.offsetHeight) return;
  const size = Math.floor(Math.min(panel.offsetHeight, panel.offsetWidth) * 0.90);
  document.documentElement.style.setProperty('--ring-size', size + 'px');
}

window.addEventListener('resize', updateRingSize);
window.addEventListener('orientationchange', () => setTimeout(updateRingSize, 350));

// ── Init ──────────────────────────────────────────────────
applyBoardSide();
showStartScreen();
