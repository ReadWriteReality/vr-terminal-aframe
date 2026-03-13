# Orbital Security Station - VR Terminal

An immersive VR workspace built with A-Frame. A real Linux terminal running in a space station, with hand-tracked keyboard input, multi-monitor HUD, full space environment, and a live hot-swap development pipeline.

Built for Apple Vision Pro. Works in any WebXR browser.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  VR HEADSET (visionOS Safari)                            │
│                                                          │
│  ┌─────────────┐  ┌──────────┐  ┌──────────────────┐    │
│  │  A-Frame     │  │  xterm.js │  │  Hot-Swap Client │    │
│  │  Scene       │  │  Terminal │  │  (SSE listener)  │    │
│  │             │  │          │  │                  │    │
│  │  • Starfield │  │  buffer   │──▶ mirror canvas    │    │
│  │  • Earth     │  │  reader   │  │  ▶ THREE texture │    │
│  │  • Station   │  │          │  │                  │    │
│  │  • Keyboard  │  └────┬─────┘  └────────┬─────────┘    │
│  │  • HUD panels│       │                 │              │
│  └─────────────┘       │ SSE/POST         │ SSE          │
│                         │                 │              │
└─────────────────────────┼─────────────────┼──────────────┘
                          │                 │
                ┌─────────▼─────────────────▼──────────┐
                │  NODE.JS SERVER (:8080 HTTPS)         │
                │                                       │
                │  Express + WebSocket + SSE             │
                │                                       │
                │  /pty         → WebSocket PTY bridge   │
                │  /pty/stream  → SSE PTY fallback       │
                │  /pty/input   → POST input for SSE     │
                │  /hot-swap/stream → SSE code injection │
                │  /hot-swap/push   → POST to broadcast  │
                │                                       │
                │  node-pty → spawns real /bin/bash       │
                └───────────────────────────────────────┘
```

## Features

### Real Terminal (PTY)
- **xterm.js** terminal emulator connected to a real shell via **node-pty**
- Dual transport: WebSocket primary, HTTP/SSE fallback (visionOS Safari blocks WSS to self-signed certs)
- Buffer-reader rendering: reads xterm's buffer directly and renders to canvas, bypassing DOM painting which stalls in WebXR immersive mode
- Full color support (256-color + truecolor), cursor, scrollback

### Hand-Tracked Keyboard
- Full QWERTY layout with mechanical key simulation
- Deliberate input model: dwell time (70ms) + velocity gating + lock-after-press prevents accidental keypresses
- Per-finger state tracking across 4 fingertips per hand
- Visual feedback via colored orbs: idle → hover → dwell → fired → locked
- Audio feedback: synthesized mechanical click sounds
- Shift, Caps Lock, Ctrl, Alt modifier support

### Multi-Monitor Workstation
- 5 monitors arranged in a wrap-around desk configuration
- **MAIN** (center): HUD status display with live clock
- **SEC-A** (left): Secondary HUD feed
- **SEC-B** (right): Secondary HUD feed
- **TTY-01** (upper right): Real PTY terminal
- **WEB-01** (upper left): HTML display panel (raw HTML, local files, or proxied URLs)
- All monitors use canvas-to-texture rendering with CRT scanline effect

### Space Environment
- **Starfield**: 3,000 stars on a sphere shell with color temperature variation (white, blue-white, warm-white), slow rotation
- **Earth**: Procedural planet with vertex-colored continents/oceans, atmosphere glow (additive backside sphere), cloud layer, slow rotation
- **Shooting Stars**: Randomized meteor streaks with fade-out trails, variable frequency
- **Station Structure**: Ceiling panels, cross beams, support pillars with blue accent lights, light strips, metal floor plating with detail lines
- **Ambient Particles**: 60 floating light motes drifting around the workstation
- **Distant Sun**: Bright star with layered glow spheres (additive blending)
- **Ambient Audio**: 4-layer generative audio — deep reactor drone (42Hz), sub-harmonic rumble (28Hz), filtered noise (air systems), random electronic chirps

### Hot-Swap Development Pipeline
Live code/entity injection into the running VR session without page reload:

```bash
# Push JavaScript to execute in the VR browser
curl -sk -X POST https://localhost:8080/hot-swap/push \
  -H 'Content-Type: application/json' \
  --data-raw '{"code":"console.log(123)"}'

# Push A-Frame entities into the scene (auto-replace by tag)
curl -sk -X POST https://localhost:8080/hot-swap/push \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "type": "entities",
    "tag": "my-feature",
    "html": "<a-entity position=\"0 2 -3\" geometry=\"primitive:sphere\" material=\"color:red\"></a-entity>"
  }'

# Remove entities by CSS selector
curl -sk -X POST https://localhost:8080/hot-swap/push \
  -H 'Content-Type: application/json' \
  --data-raw '{"type":"remove","selector":"[data-hotswap=my-feature]"}'
```

Uses SSE (Server-Sent Events) instead of WebSocket because visionOS Safari blocks WSS connections to self-signed certificates.

## Quick Start

```bash
npm install
npm start
```

Open on your headset:
```
https://<your-local-ip>:8080/keyboard_terminal
```

Accept the self-signed certificate warning. The server auto-detects certs in `certs/` — HTTPS if present, HTTP fallback if not.

### Generate Self-Signed Certs

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem \
  -days 365 -nodes -subj '/CN=localhost'
```

### Environment Variables

```bash
PORT=8080              # Server port
HOST=0.0.0.0           # Bind address
SHELL_CMD=/bin/bash    # Shell to spawn
WORKDIR=/path/to/dir   # PTY working directory
TERMINAL_TOKEN=secret  # Auth token (optional)
ALLOW_ORIGIN=https://… # CORS origin lock (optional)
TLS_CERT=/path/to/cert # Custom cert path (optional)
TLS_KEY=/path/to/key   # Custom key path (optional)
```

## File Structure

```
├── server/
│   └── server.js              # Express + PTY + SSE + hot-swap server
├── public/
│   ├── keyboard_terminal.html  # Main VR experience (all components inline)
│   ├── app.js                  # Standalone vr-terminal component (alt entry)
│   ├── index.html              # Alt entry point
│   └── styles.css
├── certs/                      # TLS certificates (gitignored)
├── keyboard_terminal.html      # Original standalone prototype
└── package.json
```

## A-Frame Components Reference

### Scene Components

| Component | Description |
|---|---|
| `vr-terminal` | Full PTY terminal — xterm.js buffer reader, dual-transport connection, canvas texture |
| `virtual-keyboard` | QWERTY keyboard layout generator with mechanical key entities |
| `mechanical-key` | Individual key with press/release animation, glow, and audio |
| `hand-typer` | Hand tracking fingertip-to-key collision with dwell, velocity gating, and lock |
| `hud-draw` | Canvas-rendered HUD status display |
| `crt-display` | Canvas-to-texture bridge with scanline effect |
| `html-display` | Renders HTML content (raw/local/proxied) to canvas via hidden iframe |

### Environment Components

| Component | Description |
|---|---|
| `starfield` | Procedural star sphere (count, radius, size) |
| `orbital-earth` | Planet with continents, atmosphere, clouds |
| `shooting-stars` | Randomized meteor streaks (interval, speed) |
| `station-structure` | Ceiling, beams, pillars, floor, light strips |
| `ambient-particles` | Floating dust motes (count, spread, color) |
| `distant-sun` | Bright star with layered glow |
| `station-ambience` | Generative 4-layer ambient audio |

### System

| System | Description |
|---|---|
| `virtual-keyboard` | Routes key events from hand tracking or physical keyboard to the active terminal |

## visionOS Safari Compatibility

Key issues solved:
1. **WSS blocked for self-signed certs** → HTTP/SSE fallback transport for PTY and hot-swap
2. **DOM canvas painting stalls in WebXR** → Direct xterm buffer reader bypasses DOM rendering
3. **AudioContext requires user interaction** → Ambient audio starts on first click/keypress

## Security

This spawns a real shell. Do **not** expose publicly without:
- Setting `TERMINAL_TOKEN` for auth
- Setting `ALLOW_ORIGIN` to lock CORS
- Using proper TLS certificates (not self-signed)
- Network-level access controls

## Development Workflow

1. Start the server: `npm start`
2. Open the VR page on your headset
3. Use hot-swap to iterate live:
   - Register new components via `{"code": "AFRAME.registerComponent(...)"}`
   - Add entities via `{"type": "entities", "tag": "...", "html": "..."}`
   - Remove entities via `{"type": "remove", "selector": "..."}`
4. No page reload needed — the WebXR session stays active

This is the seed. Build on it.
