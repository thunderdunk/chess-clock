# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a single-file HTML chess clock app (`chess-clock-0.6.html`) designed for mobile use. It requires no build step, no dependencies, and no server — just open the HTML file in a browser.

## Development

Open `chess-clock-0.6.html` directly in a browser. There is no build, lint, or test toolchain.

## Architecture

The entire app lives in one self-contained HTML file with inline CSS and JavaScript. No frameworks, no external JS libraries, no asset files.

**Game state machine** — four states managed via `gameState`:
- `READY` → `RUNNING` (Start), `RUNNING` → `PAUSED` (Pause), `PAUSED` → `RUNNING` (Resume), any → `READY` (Reset), `RUNNING` → `FLAGGED` (time expires)

**Timing model** — uses `performance.now()` snapshots rather than decrementing a counter on a timer:
- `turnStart`: timestamp when the active player's turn began
- `timeAtTurnStart`: that player's remaining ms at turn start
- Live remaining time = `timeAtTurnStart - (performance.now() - turnStart)`
- `remaining[player]` is only written on turn handoff or pause

**Render loop** — a single `requestAnimationFrame` loop (`render()`) drives all DOM updates (time display, arc SVG, panel CSS classes). The loop runs only while `gameState === 'RUNNING'`.

**Arc ring** — SVG `stroke-dashoffset` on a circle with `r=52` (`CIRC ≈ 326.73`). Fraction shown = `remaining / presetMs`. The `--ring-size` CSS variable is set at runtime by `updateRingSize()` based on actual panel dimensions.

**Audio** — Web Audio API only, no audio files. `playTap()` on turn handoff, `playAlarm()` on flag fall. `AudioContext` is lazy-initialized on first use.

**Mobile considerations**:
- `touchstart` with `preventDefault()` used for clock panels (avoids 300ms delay)
- Landscape orientation is handled via CSS `rotate(90deg)` on `#app` rather than locking orientation
- Player 2's panel is `rotate(180deg)` so both players face their own clock
- Screen wake lock acquired while running, released on pause/flag/reset
