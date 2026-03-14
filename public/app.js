import { Terminal } from 'https://cdn.jsdelivr.net/npm/@xterm/xterm/+esm';
import { CanvasAddon } from 'https://cdn.jsdelivr.net/npm/@xterm/addon-canvas/+esm';
import { FitAddon } from 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit/+esm';
import { WebLinksAddon } from 'https://cdn.jsdelivr.net/npm/@xterm/addon-web-links/+esm';

const XTERM_ROOT = document.getElementById('xterm-root');

AFRAME.registerComponent('vr-terminal', {
  schema: {
    cols: { type: 'int', default: 120 },
    rows: { type: 'int', default: 34 },
    wsPath: { type: 'string', default: '/pty' },
    token: { type: 'string', default: '' },
    status: { type: 'selector' }
  },

  init() {
    this.isFocused = false;
    this.needsComposite = true;
    this.lastComposite = 0;
    this.socket = null;
    this.texture = null;
    this.material = null;
    this.textarea = null;
    this._boundKeyDown = (e) => this._handleKeyDown(e);

    this.term = new Terminal({
      cols: this.data.cols,
      rows: this.data.rows,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'block',
      allowTransparency: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 20,
      fontWeight: 400,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: '#020617',
        foreground: '#d1fae5',
        cursor: '#86efac',
        selectionBackground: '#1d4ed8',
        black: '#111827',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#d946ef',
        cyan: '#06b6d4',
        white: '#e5e7eb',
        brightBlack: '#475569',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#e879f9',
        brightCyan: '#22d3ee',
        brightWhite: '#f8fafc'
      }
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon());
    this.term.open(XTERM_ROOT);
    this.term.loadAddon(new CanvasAddon());
    this.fitAddon.fit();
    this.textarea = XTERM_ROOT.querySelector('textarea');

    this.mirrorCanvas = document.createElement('canvas');
    this.mirrorCanvas.width = 1280;
    this.mirrorCanvas.height = 720;
    this.mirrorCtx = this.mirrorCanvas.getContext('2d', { alpha: false });
    this.mirrorCtx.imageSmoothingEnabled = false;

    this.texture = new THREE.CanvasTexture(this.mirrorCanvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = 4;

    this.bindMesh();
    this.updateStatus('Connecting…', '#93c5fd');
    this.connect();

    this.term.onData((data) => {
      this.send({ type: 'input', data });
    });

    this.term.onResize(({ cols, rows }) => {
      this.send({ type: 'resize', cols, rows });
      this.needsComposite = true;
    });

    // Composite AFTER xterm finishes painting its canvases, not before
    this.term.onRender(() => {
      this.needsComposite = true;
    });

    this.el.addEventListener('click', () => this.focus());
    this.el.addEventListener('raycaster-intersected', () => this.highlight(true));
    this.el.addEventListener('raycaster-intersected-cleared', () => this.highlight(false));
    this.el.addEventListener('object3dset', () => this.bindMesh());

    this.onWindowResize = () => {
      this.fitAddon.fit();
      this.send({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
      this.needsComposite = true;
    };

    window.addEventListener('resize', this.onWindowResize);
    window.addEventListener('pointerdown', (event) => {
      if (this.el.contains?.(event.target)) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest || !target.closest('.a-canvas')) {
        return;
      }
      this.blur();
    });

    this.term.writeln('\x1b[1;32mVR terminal initialized.\x1b[0m');
    this.term.writeln('Waiting for PTY backend...');
  },

  remove() {
    document.removeEventListener('keydown', this._boundKeyDown, true);
    window.removeEventListener('resize', this.onWindowResize);
    this.socket?.close();
    this.term?.dispose();
    this.texture?.dispose();
    this.material?.dispose?.();
  },

  tick() {
    // Composite runs every frame — xterm's onRender sets needsComposite
    // after its canvases are painted, so this always copies fresh content.
    if (!this.texture) return;
    if (!this.needsComposite) return;
    this.compositeTerminal();
  },

  bindMesh() {
    const mesh = this.el.getObject3D('mesh');
    if (!mesh || !this.texture) return;

    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      side: THREE.DoubleSide,
      toneMapped: false
    });

    if (mesh.material) mesh.material.dispose?.();
    mesh.material = material;
    this.material = material;
    this.needsComposite = true;
  },

  connect() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(this.data.wsPath, `${proto}//${window.location.host}`);
    url.searchParams.set('cols', String(this.term.cols || this.data.cols));
    url.searchParams.set('rows', String(this.term.rows || this.data.rows));
    if (this.data.token) url.searchParams.set('token', this.data.token);

    this.socket = new WebSocket(url);

    this.socket.addEventListener('open', () => {
      this.updateStatus('Connected — click terminal to focus', '#86efac');
      this.needsComposite = true;
    });

    this.socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'hello':
          this.term.writeln(`\x1b[90mShell: ${msg.shell} | cwd: ${msg.cwd}\x1b[0m`);
          this.send({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
          break;
        case 'output':
          if (typeof msg.data === 'string') {
            this.term.write(msg.data);
            this.needsComposite = true;
          }
          break;
        case 'exit':
          this.term.writeln(`\r\n\x1b[31mPTY exited (${msg.exitCode ?? 'n/a'})\x1b[0m`);
          this.updateStatus('Shell exited', '#fca5a5');
          this.needsComposite = true;
          break;
        default:
          break;
      }
    });

    this.socket.addEventListener('close', () => {
      this.updateStatus('Disconnected', '#fca5a5');
    });

    this.socket.addEventListener('error', () => {
      this.updateStatus('Connection error', '#fca5a5');
    });
  },

  send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  },

  sendInput(data) {
    this.focus();
    this.send({ type: 'input', data });
    this.needsComposite = true;
  },

  sendSignal(signal) {
    this.send({ type: 'signal', signal });
  },

  focus() {
    this.isFocused = true;
    this.term.focus();

    // Disable A-Frame WASD so keys go to the terminal, not the camera
    const cam = document.querySelector('[wasd-controls]');
    if (cam) cam.setAttribute('wasd-controls', 'enabled', false);

    // Capture keyboard events before A-Frame can consume them
    document.addEventListener('keydown', this._boundKeyDown, true);

    this.updateStatus('Focused — typing goes to shell', '#86efac');
    this.highlight(true);
    this.needsComposite = true;
  },

  blur() {
    this.isFocused = false;

    const cam = document.querySelector('[wasd-controls]');
    if (cam) cam.setAttribute('wasd-controls', 'enabled', true);

    document.removeEventListener('keydown', this._boundKeyDown, true);

    this.updateStatus('Connected — click terminal to focus', '#93c5fd');
    this.highlight(false);
    this.needsComposite = true;
  },

  highlight(isHot) {
    if (!this.material) return;
    const tint = isHot || this.isFocused ? 1.0 : 0.92;
    this.material.color.setRGB(tint, tint, tint);
  },

  updateStatus(text, color = '#93c5fd') {
    if (!this.data.status) return;
    this.data.status.setAttribute('text', 'value', text);
    this.data.status.setAttribute('text', 'color', color);
  },

  _handleKeyDown(e) {
    if (!this.isFocused) return;

    // Let browser handle Meta/Cmd shortcuts (refresh, dev tools, etc.)
    if (e.metaKey) return;

    // Ignore bare modifier keys
    if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'NumLock'].includes(e.key)) return;

    e.preventDefault();
    e.stopPropagation();

    let data = '';

    if (e.ctrlKey && !e.altKey) {
      // Ctrl-V → paste from clipboard
      if (e.key === 'v' || e.key === 'V') {
        navigator.clipboard.readText().then((text) => {
          if (text) {
            this.send({ type: 'input', data: text });
            this.needsComposite = true;
          }
        }).catch(() => {});
        return;
      }
      // Ctrl+letter → control character (Ctrl-A=0x01 … Ctrl-Z=0x1A)
      const lower = e.key.toLowerCase();
      if (lower >= 'a' && lower <= 'z') {
        data = String.fromCharCode(lower.charCodeAt(0) - 96);
      } else if (e.key === '[') {
        data = '\x1b';
      } else if (e.key === '\\') {
        data = '\x1c';
      } else if (e.key === ']') {
        data = '\x1d';
      }
    } else if (e.altKey && !e.ctrlKey) {
      // Alt+key → ESC prefix
      if (e.key.length === 1) data = '\x1b' + e.key;
    } else if (e.key.length === 1) {
      // Normal printable character (handles Shift automatically)
      data = e.key;
    } else {
      // Special keys → ANSI escape sequences
      switch (e.key) {
        case 'Enter':     data = '\r'; break;
        case 'Backspace': data = '\x7f'; break;
        case 'Tab':       data = e.shiftKey ? '\x1b[Z' : '\t'; break;
        case 'Escape':    data = '\x1b'; break;
        case 'ArrowUp':   data = '\x1b[A'; break;
        case 'ArrowDown': data = '\x1b[B'; break;
        case 'ArrowRight':data = '\x1b[C'; break;
        case 'ArrowLeft': data = '\x1b[D'; break;
        case 'Home':      data = '\x1b[H'; break;
        case 'End':       data = '\x1b[F'; break;
        case 'Delete':    data = '\x1b[3~'; break;
        case 'PageUp':    data = '\x1b[5~'; break;
        case 'PageDown':  data = '\x1b[6~'; break;
        case 'Insert':    data = '\x1b[2~'; break;
        case 'F1': data = '\x1bOP'; break;
        case 'F2': data = '\x1bOQ'; break;
        case 'F3': data = '\x1bOR'; break;
        case 'F4': data = '\x1bOS'; break;
        case 'F5': data = '\x1b[15~'; break;
        case 'F6': data = '\x1b[17~'; break;
        case 'F7': data = '\x1b[18~'; break;
        case 'F8': data = '\x1b[19~'; break;
        case 'F9': data = '\x1b[20~'; break;
        case 'F10': data = '\x1b[21~'; break;
        case 'F11': data = '\x1b[23~'; break;
        case 'F12': data = '\x1b[24~'; break;
        default: break;
      }
    }

    if (data) {
      this.send({ type: 'input', data });
      this.needsComposite = true;
    }
  },

  compositeTerminal() {
    const canvases = [...XTERM_ROOT.querySelectorAll('canvas')];
    if (canvases.length === 0) return;

    // Use the largest canvas as the reference size
    let maxW = 0, maxH = 0;
    for (const c of canvases) {
      if (c.width > maxW) maxW = c.width;
      if (c.height > maxH) maxH = c.height;
    }
    if (!maxW || !maxH) return;

    if (this.mirrorCanvas.width !== maxW || this.mirrorCanvas.height !== maxH) {
      this.mirrorCanvas.width = maxW;
      this.mirrorCanvas.height = maxH;
    }

    this.mirrorCtx.fillStyle = '#020617';
    this.mirrorCtx.fillRect(0, 0, maxW, maxH);

    for (const canvas of canvases) {
      if (!canvas.width || !canvas.height) continue;
      this.mirrorCtx.drawImage(canvas, 0, 0);
    }

    this.texture.needsUpdate = true;
    this.needsComposite = false;
  }
});

AFRAME.registerComponent('terminal-softkey', {
  schema: {
    target: { type: 'selector' },
    label: { type: 'string' },
    seq: { type: 'string' }
  },

  init() {
    this.el.setAttribute('geometry', 'primitive: plane; width: 0.18; height: 0.075');
    this.el.setAttribute('material', 'color: #1f2937; shader: flat');
    this.el.setAttribute('text', `value: ${this.data.label}; align: center; color: #e5e7eb; width: 1.4; zOffset: 0.002`);

    const press = () => {
      this.el.setAttribute('material', 'color', '#334155');
      const seq = decodeEscapes(this.data.seq);
      const terminal = this.data.target?.components?.['vr-terminal'];
      terminal?.sendInput(seq);
    };

    const reset = () => this.el.setAttribute('material', 'color', '#1f2937');

    this.el.addEventListener('click', press);
    this.el.addEventListener('mouseup', reset);
    this.el.addEventListener('mouseleave', reset);
    this.el.addEventListener('raycaster-intersected', () => {
      this.el.setAttribute('material', 'color', '#334155');
    });
    this.el.addEventListener('raycaster-intersected-cleared', reset);
  }
});

function decodeEscapes(value) {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r");
}
