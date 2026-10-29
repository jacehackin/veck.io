// veck-cheat.user.js
// ==UserScript==
// @name         Veck.io Trainer v3 — un-hideable UI
// @namespace    https://veck.io/
// @version      3.0.0
// @description  Canvas/WS/WASM/defineProperty hooks + Shadow-DOM UI that cannot be hidden by the game. INSERT toggles.
// @author       [G]
// @match        *://veck.io/*
// @match        *://*.veck.io/*
// @match        *://veck.io:*/*
// @match        *://*.veck.io:*/*
// @include      /^https?:\/\/([^/]*\.)?veck\.io(:\d+)?\//
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    //  0. BOOT LOGGER — records every stage so the console tells
    //     you exactly where it died if it dies.
    // ============================================================
    const BOOT = [];
    function boot(stage) {
        BOOT.push(stage + '@' + Math.round(performance.now()) + 'ms');
        try { console.log('[VECK][boot]', stage); } catch (e) {}
    }
    boot('start');

    // Global error trap so a failure inside our IIFE is loud, not silent.
    window.addEventListener('error', function (ev) {
        if (ev && ev.filename && /veck/i.test(String(ev.filename))) {
            try { console.error('[VECK][error]', ev.message, ev.filename, ev.lineno); } catch (e) {}
        }
    }, true);

    // ============================================================
    //  1. NATIVE toString SHIELD
    //     Every function we wrap reports "[native code]" so the game
    //     can't detect the hook by calling .toString() on it.
    // ============================================================
    const NativeToString = Function.prototype.toString;
    const nativeMap = new WeakMap();

    function markNative(fn, name) {
        nativeMap.set(
            fn,
            name ? 'function ' + name + '() { [native code] }'
                 : 'function () { [native code] }'
        );
        return fn;
    }

    Function.prototype.toString = markNative(function () {
        if (nativeMap.has(this)) return nativeMap.get(this);
        return NativeToString.call(this);
    }, 'toString');
    boot('toString-shield');

    const RA = Reflect.apply;

    function safe(label, fn) {
        try { return fn(); }
        catch (e) {
            try { console.warn('[VECK] feature error in ' + label + ':', e); } catch (_) {}
            return undefined;
        }
    }

    // ============================================================
    //  2. STATE
    // ============================================================
    const state = {
        uiOpen: true,
        toggleKey: 'Insert',

        esp: {
            enabled: true,
            color: '#ff2d55',
            netColor: '#00e5ff',
            pad: 4,
            showLabels: false,
            minRadius: 5,
            maxRadius: 120,
        },

        aimbot: {
            enabled: false,
            holdShift: true,
            fov: 400,
            smooth: 0.5,
            useMathHook: false,
        },

        autofire: {
            enabled: false,
            rate: 100,
            range: 400,
        },

        speed: {
            enabled: false,
            multiplier: 3.0,
            mode: 'auto',      // auto | wasm | object | ws
            wasmAddr: 0,
            wasmType: 'f32',
        },

        godmode: {
            enabled: false,
            mode: 'auto',      // auto | wasm | object | key
            wasmAddr: 0,
            lockValue: 100,
            healKey: 'h',
            healInterval: 400,
        },
    };

    // ============================================================
    //  3. WASM MEMORY CAPTURE
    // ============================================================
    const wasm = {
        memory: null,
        get buffer() { return this.memory ? this.memory.buffer : null; },
        get u8()  { const b = this.buffer; return b ? new Uint8Array(b)   : null; },
        get i32() { const b = this.buffer; return b ? new Int32Array(b)   : null; },
        get u32() { const b = this.buffer; return b ? new Uint32Array(b)  : null; },
        get f32() { const b = this.buffer; return b ? new Float32Array(b) : null; },
        get f64() { const b = this.buffer; return b ? new Float64Array(b) : null; },
    };

    function captureMemory(mem) {
        if (mem instanceof WebAssembly.Memory) {
            wasm.memory = mem;
            boot('wasm-memory(' + mem.buffer.byteLength + 'B)');
        }
    }

    (function hookWebAssembly() {
        if (typeof WebAssembly === 'undefined') return;

        function harvest(result) {
            if (!result) return result;
            const inst = result.instance || result;
            if (inst && inst.exports) {
                for (const k in inst.exports) {
                    var v;
                    try { v = inst.exports[k]; } catch (e) { continue; }
                    if (v instanceof WebAssembly.Memory) captureMemory(v);
                }
            }
            return result;
        }

        const nativeInstantiate = WebAssembly.instantiate;
        const nativeStreaming   = WebAssembly.instantiateStreaming;
        const NativeInstance    = WebAssembly.Instance;

        WebAssembly.instantiate = markNative(function () {
            const p = RA(nativeInstantiate, this, arguments);
            if (p && typeof p.then === 'function') return p.then(harvest);
            return harvest(p);
        }, 'instantiate');

        if (nativeStreaming) {
            WebAssembly.instantiateStreaming = markNative(function () {
                const p = RA(nativeStreaming, this, arguments);
                if (p && typeof p.then === 'function') return p.then(harvest);
                return p;
            }, 'instantiateStreaming');
        }

        if (NativeInstance) {
            try {
                WebAssembly.Instance = markNative(function (mod, imports) {
                    const inst = new NativeInstance(mod, imports);
                    harvest({ instance: inst });
                    return inst;
                }, 'Instance');
                WebAssembly.Instance.prototype = NativeInstance.prototype;
            } catch (e) {}
        }
        boot('wasm-hooks');
    })();

    // ============================================================
    //  4. CANVAS 2D HOOK
    // ============================================================
    const screenArcs  = [];
    const screenBoxes = [];
    const FRAME_TTL   = 120;

    (function hookCanvas2D() {
        if (typeof CanvasRenderingContext2D === 'undefined') return;

        const proto = CanvasRenderingContext2D.prototype;
        const orig = {
            arc:        proto.arc,
            fillRect:   proto.fillRect,
            strokeRect: proto.strokeRect,
        };

        function isGameCanvas(ctx) {
            const c = ctx && ctx.canvas;
            if (!c) return false;
            if (c.id === '__veck_overlay') return false;
            const r = c.getBoundingClientRect ? c.getBoundingClientRect() : null;
            if (!r) return true;
            return (r.width * r.height) >=
                   (window.innerWidth * window.innerHeight) * 0.20;
        }

        proto.arc = markNative(function (x, y, r, a, b, ccw) {
            if (isGameCanvas(this)
                && typeof x === 'number' && typeof y === 'number'
                && typeof r === 'number'
                && isFinite(x) && isFinite(y) && isFinite(r)
                && r >= state.esp.minRadius && r <= state.esp.maxRadius) {
                let pass = true;
                if (typeof hooks.filterArc === 'function') {
                    pass = safe('filterArc', () => !!hooks.filterArc(x, y, r)) !== false;
                }
                if (pass) screenArcs.push({ x: x, y: y, r: r, t: performance.now() });
            }
            return RA(orig.arc, this, arguments);
        }, 'arc');

        function grabBox(x, y, w, h) {
            if (w <= 0 || h <= 0 || w >= 400 || h >= 400) return;
            if ((w * h) <= 16) return;
            if (Math.abs(w - h) >= Math.max(w, h)) return;
            screenBoxes.push({
                x: x + w / 2, y: y + h / 2,
                w: w, h: h, t: performance.now(),
            });
        }

        proto.fillRect = markNative(function (x, y, w, h) {
            if (isGameCanvas(this)
                && typeof x === 'number' && typeof y === 'number'
                && typeof w === 'number' && typeof h === 'number'
                && isFinite(x) && isFinite(y) && isFinite(w) && isFinite(h)) {
                grabBox(x, y, w, h);
            }
            return RA(orig.fillRect, this, arguments);
        }, 'fillRect');

        proto.strokeRect = markNative(function (x, y, w, h) {
            if (isGameCanvas(this)
                && typeof x === 'number' && typeof y === 'number'
                && typeof w === 'number' && typeof h === 'number'
                && isFinite(x) && isFinite(y) && isFinite(w) && isFinite(h)) {
                grabBox(x, y, w, h);
            }
            return RA(orig.strokeRect, this, arguments);
        }, 'strokeRect');

        boot('canvas2d-hooks');
    })();

    // ============================================================
    //  5. WEBSOCKET HOOK
    // ============================================================
    const wsLog = [];
    let lastSocket = null;

    (function hookWebSocket() {
        if (typeof WebSocket === 'undefined') return;

        const NativeWS = WebSocket;

        function Wrapped(url, protocols) {
            const sock = protocols !== undefined
                ? new NativeWS(url, protocols)
                : new NativeWS(url);

            wsLog.push({ t: Date.now(), d: 'open', preview: String(url) });
            if (wsLog.length > 800) wsLog.shift();

            sock.addEventListener('message', function (ev) {
                const data = ev.data;
                let preview;
                if (typeof data === 'string') preview = data.slice(0, 256);
                else if (data && data.byteLength) preview = '[bin ' + data.byteLength + 'B]';
                else preview = '[other]';

                wsLog.push({ t: Date.now(), d: 'in', preview: preview });
                if (wsLog.length > 800) wsLog.shift();

                safe('handleIncoming', function () { handleIncoming(data); });
            }, true);

            const nativeSend = sock.send;
            sock.send = markNative(function (payload) {
                safe('captureMove', function () { captureMove(payload); });
                return RA(nativeSend, sock, arguments);
            }, 'send');

            lastSocket = sock;
            return sock;
        }

        Wrapped.prototype = NativeWS.prototype;
        try { Object.setPrototypeOf(Wrapped, NativeWS); } catch (e) {}

        Wrapped.CONNECTING = NativeWS.CONNECTING;
        Wrapped.OPEN       = NativeWS.OPEN;
        Wrapped.CLOSING    = NativeWS.CLOSING;
        Wrapped.CLOSED     = NativeWS.CLOSED;

        window.WebSocket = markNative(Wrapped, 'WebSocket');
        boot('websocket-hook');
    })();

    const moveQueue = [];

    function captureMove(payload) {
        let text = null;
        if (typeof payload === 'string') {
            text = payload;
        } else if (typeof ArrayBuffer !== 'undefined' && payload instanceof ArrayBuffer) {
            try { text = new TextDecoder().decode(payload); } catch (e) { return; }
        } else if (typeof Uint8Array !== 'undefined' && payload instanceof Uint8Array) {
            try { text = new TextDecoder().decode(payload); } catch (e) { return; }
        } else {
            return;
        }
        if (!text || text.length > 4096) return;

        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { return; }
        if (!parsed || typeof parsed !== 'object') return;

        const isMove =
            parsed.dx !== undefined || parsed.dy !== undefined ||
            parsed.vx !== undefined || parsed.vy !== undefined ||
            parsed.mx !== undefined || parsed.my !== undefined ||
            parsed.angle !== undefined;

        if (!isMove) return;

        moveQueue.push({ t: Date.now(), text: text, parsed: parsed });
        if (moveQueue.length > 32) moveQueue.shift();
    }

    const netEntities = new Map();

    function handleIncoming(data) {
        let msg = data;
        if (typeof data === 'string') {
            try { msg = JSON.parse(data); } catch (e) { return; }
        } else if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
            try { msg = JSON.parse(new TextDecoder().decode(data)); } catch (e) { return; }
        }
        if (!msg || typeof msg !== 'object') return;

        if (typeof hooks.onPacket === 'function') {
            safe('onPacket', function () { hooks.onPacket(msg, 'in'); });
        }
        walkEntities(msg);
    }

    function pickNumber(obj, keys) {
        for (let i = 0; i < keys.length; ++i) {
            const v = obj[keys[i]];
            if (typeof v === 'number' && isFinite(v)) return v;
        }
        return null;
    }

    function walkEntities(root) {
        const seen = new Set();
        const now = performance.now();

        (function visit(node, depth) {
            if (!node || typeof node !== 'object') return;
            if (depth > 6 || seen.has(node)) return;
            seen.add(node);

            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; ++i) visit(node[i], depth + 1);
                return;
            }

            const x  = pickNumber(node, ['x', 'px', 'posX', 'positionX', 'position_x']);
            const y  = pickNumber(node, ['y', 'py', 'posFor the v3 UI I need to continue writing the walkEntities function, then build the Shadow-DOM UI mounting system.

```javascript
            const y  = pickNumber(node, ['y', 'py', 'posY', 'positionY', 'position_y']);
            const id = node.id !== undefined ? node.id
                     : node.pid !== undefined ? node.pid
                     : node.uid !== undefined ? node.uid
                     : node.eid !== undefined ? node.eid
                     : node.playerId;

            if (x !== null && y !== null && id !== undefined && id !== null) {
                netEntities.set(String(id), {
                    id: id, x: x, y: y,
                    hp:    pickNumber(node, ['hp', 'health', 'life', 'curHp']),
                    maxHp: pickNumber(node, ['maxHp', 'maxHealth', 'max_hp', 'hpMax']),
                    name:  node.name !== undefined ? node.name
                         : node.nick !== undefined ? node.nick
                         : node.username !== undefined ? node.username
                         : node.nickname,
                    lastSeen: now,
                    raw: node,
                });
            }

            for (const k in node) {
                if (Object.prototype.hasOwnProperty.call(node, k)) {
                    const v = node[k];
                    if (v && typeof v === 'object') visit(v, depth + 1);
                }
            }
        })(root, 0);

        for (const entry of netEntities) {
            if (now - entry[1].lastSeen > 6000) netEntities.delete(entry[0]);
        }
    }

    // ============================================================
    //  6. OBJECT.DEFINEPROPERTY TRAP  — find the player object
    // ============================================================
    const playerCandidates = new Set();
    const PLAYER_KEYS = ['hp', 'health', 'x', 'y', 'speed', 'vel',
                         'alive', 'dead', 'team', 'id', 'name'];

    (function hookDefineProperty() {
        const native = Object.defineProperty;
        Object.defineProperty = markNative(function (obj, prop, desc) {
            if (obj && typeof obj === 'object'
                && typeof prop === 'string'
                && PLAYER_KEYS.indexOf(prop) >= 0) {
                obj.__veck_hits = (obj.__veck_hits || 0) + 1;
                if (obj.__veck_hits >= 3) playerCandidates.add(obj);
            }
            return RA(native, this, arguments);
        }, 'defineProperty');
        boot('defineProperty-trap');
    })();

    // ============================================================
    //  7. GLOBAL SCAN
    // ============================================================
    const gameGlobals = [];
    const COMMON_NAMES = [
        'game', 'Game', 'GAME', 'app', 'App', 'APP', 'veck', 'Veck', 'VECK',
        'player', 'me', 'world', 'engine', 'g', 'state', 'server',
    ];

    function scanGlobals() {
        gameGlobals.length = 0;
        for (let i = 0; i < COMMON_NAMES.length; ++i) {
            const n = COMMON_NAMES[i];
            try {
                if (window[n] && typeof window[n] === 'object') {
                    gameGlobals.push({ name: n, obj: window[n] });
                }
            } catch (e) {}
        }
        for (const k in window) {
            try {
                if (COMMON_NAMES.indexOf(k) >= 0) continue;
                const v = window[k];
                if (!v || typeof v !== 'object') continue;
                if (v === window || v === document) continue;
                let hits = 0;
                for (let j = 0; j < PLAYER_KEYS.length; ++j) {
                    if (PLAYER_KEYS[j] in v) hits++;
                }
                if (hits >= 3) gameGlobals.push({ name: k, obj: v });
            } catch (e) {}
        }
    }
    scanGlobals();

    // ============================================================
    //  8. RAF HOOK  — piggyback the game loop
    // ============================================================
    (function hookRaf() {
        const native = window.requestAnimationFrame;
        window.requestAnimationFrame = markNative(function (cb) {
            return RA(native, window, [function (t) {
                try { return cb(t); } catch (e) { throw e; }
            }]);
        }, 'requestAnimationFrame');
        boot('raf-hook');
    })();

    // ============================================================
    //  9. MATH.ATAN2 HOOK  — aim interception path
    // ============================================================
    let atan2OverrideAngle = null;

    (function hookMathAtan2() {
        const native = Math.atan2;
        Math.atan2 = markNative(function (y, x) {
            if (atan2OverrideAngle !== null
                && state.aimbot.enabled
                && state.aimbot.useMathHook) {
                const out = atan2OverrideAngle;
                atan2OverrideAngle = null;
                return out;
            }
            return RA(native, Math, arguments);
        }, 'atan2');
        boot('atan2-hook');
    })();

    // ============================================================
    //  10. OVERLAY CANVAS
    // ============================================================
    const overlay = document.createElement('canvas');
    overlay.id = '__veck_overlay';
    overlay.width  = window.innerWidth;
    overlay.height = window.innerHeight;
    overlay.style.cssText = [
        'position:fixed', 'top:0', 'left:0',
        'width:100vw', 'height:100vh',
        'pointer-events:none',
        'z-index:2147483600',
        'background:transparent',
    ].join(';');

    const octx = overlay.getContext('2d');

    function attachOverlay() {
        const parent = document.body || document.documentElement;
        if (!parent) { setTimeout(attachOverlay, 40); return; }
        if (!document.getElementById('__veck_overlay')) {
            parent.appendChild(overlay);
            boot('overlay-mounted');
        }
    }
    attachOverlay();

    window.addEventListener('resize', function () {
        overlay.width  = window.innerWidth;
        overlay.height = window.innerHeight;
    });

    // ============================================================
    //  11. UTILITIES
    // ============================================================
    function findGameCanvas() {
        const list = document.querySelectorAll('canvas');
        let best = null, bestArea = 0;
        for (let i = 0; i < list.length; ++i) {
            const c = list[i];
            if (c.id === '__veck_overlay') continue;
            const r = c.getBoundingClientRect();
            const a = r.width * r.height;
            if (a > bestArea) { bestArea = a; best = c; }
        }
        return best;
    }

    function gameCanvasRect() {
        const g = findGameCanvas();
        if (!g) return { left: 0, top: 0, width: overlay.width, height: overlay.height };
        const r = g.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    }

    function pruneScreens() {
        const now = performance.now();
        for (let i = screenArcs.length - 1; i >= 0; --i) {
            if (now - screenArcs[i].t > FRAME_TTL) screenArcs.splice(i, 1);
        }
        for (let i = screenBoxes.length - 1; i >= 0; --i) {
            if (now - screenBoxes[i].t > FRAME_TTL) screenBoxes.splice(i, 1);
        }
    }

    function dedupeScreenEntities() {
        const out = [];
        const seen = new Set();
        for (let i = 0; i < screenArcs.length; ++i) {
            const a = screenArcs[i];
            const k = (a.x | 0) + '|' + (a.y | 0);
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ x: a.x, y: a.y, r: a.r });
        }
        for (let i = 0; i < screenBoxes.length; ++i) {
            const b = screenBoxes[i];
            const k = (b.x | 0) + '|' + (b.y | 0);
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ x: b.x, y: b.y, r: Math.max(b.w, b.h) / 2 });
        }
        return out;
    }

    function inferLocalPlayer() {
        const r = gameCanvasRect();
        const cx = r.left + r.width  / 2;
        const cy = r.top  + r.height / 2;
        let best = null, bestD = Infinity;
        const maxD = Math.min(r.width, r.height) * 0.45;
        const list = dedupeScreenEntities();
        for (let i = 0; i < list.length; ++i) {
            const e = list[i];
            const dx = e.x - cx, dy = e.y - cy;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d > maxD) continue;
            if (d < bestD) { bestD = d; best = e; }
        }
        return best;
    }

    // ============================================================
    //  12. MOUSE TRACK
    // ============================================================
    let mouseX = window.innerWidth / 2;
    let mouseY = window.innerHeight / 2;
    let aimEngaged = false;

    document.addEventListener('mousemove', function (e) {
        mouseX = e.clientX; mouseY = e.clientY;
    }, { capture: true, passive: true });

    document.addEventListener('pointermove', function (e) {
        mouseX = e.clientX; mouseY = e.clientY;
    }, { capture: true, passive: true });

    // ============================================================
    //  13. FEATURE 1 — ESP
    // ============================================================
    function drawESP() {
        octx.clearRect(0, 0, overlay.width, overlay.height);
        if (!state.esp.enabled) return;

        const r = gameCanvasRect();
        const local = inferLocalPlayer();

        octx.strokeStyle = state.esp.color;
        octx.lineWidth = 2;
        for (let i = 0; i < screenArcs.length; ++i) {
            const a = screenArcs[i];
            const sx = r.left + a.x, sy = r.top + a.y;
            octx.beginPath();
            octx.arc(sx, sy, a.r + state.esp.pad, 0, Math.PI * 2);
            octx.stroke();

            if (local) {
                octx.globalAlpha = 0.35;
                octx.beginPath();
                octx.moveTo(r.left + local.x, r.top + local.y);
                octx.lineTo(sx, sy);
                octx.stroke();
                octx.globalAlpha = 1;
            }
        }

        octx.strokeStyle = state.esp.netColor;
        octx.lineWidth = 1.5;
        for (const ent of netEntities.values()) {
            const sx = r.left + ent.x, sy = r.top + ent.y;
            octx.beginPath();
            octx.arc(sx, sy, 20, 0, Math.PI * 2);
            octx.stroke();

            if (state.esp.showLabels) {
                octx.fillStyle = state.esp.netColor;
                octx.font = '12px monospace';
                let label = ent.name || ('#' + ent.id);
                if (ent.hp !== null && ent.hp !== undefined) {
                    label += ' ' + ent.hp + (ent.maxHp ? '/' + ent.maxHp : '');
                }
                octx.fillText(label, sx + 22, sy + 4);
            }
        }
    }

    // ============================================================
    //  14. FEATURE 2 — AIMBOT
    // ============================================================
    function aimTarget() {
        const local = inferLocalPlayer();
        const r = gameCanvasRect();
        let best = null, bestD = state.aimbot.fov;
        const list = dedupeScreenEntities();

        for (let i = 0; i < list.length; ++i) {
            const e = list[i];
            if (local && Math.abs(e.x - local.x) < 1 && Math.abs(e.y - local.y) < 1) continue;
            const sx = r.left + e.x, sy = r.top + e.y;
            const dx = sx - mouseX, dy = sy - mouseY;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < bestD) { bestD = d; best = { x: sx, y: sy, r: e.r }; }
        }
        return best;
    }

    function runAimbot() {
        if (!state.aimbot.enabled) return;
        if (state.aimbot.holdShift && !aimEngaged) return;

        const target = aimTarget();
        if (!target) return;

        const g = findGameCanvas();
        if (!g) return;

        if (state.aimbot.useMathHook) {
            atan2OverrideAngle = Math.atan2(target.y - mouseY, target.x - mouseX);
            return;
        }

        const s = Math.max(0, Math.min(0.95, state.aimbot.smooth));
        const nx = mouseX + (target.x - mouseX) * (1 - s);
        const ny = mouseY + (target.y - mouseY) * (1 - s);

        try {
            g.dispatchEvent(new MouseEvent('mousemove', {
                clientX: nx, clientY: ny, bubbles: true, cancelable: true, view: window,
            }));
            if (typeof PointerEvent !== 'undefined') {
                g.dispatchEvent(new PointerEvent('pointermove', {
                    clientX: nx, clientY: ny, bubbles: true, cancelable: true,
                    view: window, pointerType: 'mouse',
                }));
            }
        } catch (e) {}

        if (document.pointerLockElement) {
            try {
                document.dispatchEvent(new MouseEvent('mousemove', {
                    movementX: target.x - mouseX,
                    movementY: target.y - mouseY,
                    clientX: mouseX, clientY: mouseY,
                    bubbles: true, cancelable: true, view: window,
                }));
            } catch (e) {}
        }

        mouseX = nx; mouseY = ny;
    }

    // ============================================================
    //  15. FEATURE 3 — AUTOFIRE
    // ============================================================
    let lastFire = 0;

    function runAutoFire() {
        if (!state.autofire.enabled) return;
        const now = performance.now();
        if (now - lastFire < state.autofire.rate) return;

        const target = aimTarget();
        if (!target) return;

        const dx = target.x - mouseX, dy = target.y - mouseY;
        if (Math.sqrt(dx * dx + dy * dy) > state.autofire.range) return;

        lastFire = now;

        if (typeof hooks.fireAction === 'function') {
            if (safe('fireAction', function () { hooks.fireAction(target); }) !== undefined) return;
        }

        const g = findGameCanvas();
        if (!g) return;

        const locked = !!document.pointerLockElement;
        const opts = locked
            ? { clientX: overlay.width / 2, clientY: overlay.height / 2, button: 0,
                bubbles: true, cancelable: true, view: window }
            : { clientX: target.x, clientY: target.y, button: 0,
                bubbles: true, cancelable: true, view: window };

        try {
            g.dispatchEvent(new MouseEvent('mousedown', opts));
            g.dispatchEvent(new MouseEvent('mouseup',   opts));
        } catch (e) {}
    }

    // ============================================================
    //  16. FEATURE 4 — SPEED (WASM → Object → WS)
    // ============================================================
    function wasmWriteFloat(addr, val) {
        const v = wasm.f32; if (!v) return false;
        const i = addr >>> 2;
        if (i < 0 || i >= v.length) return false;
        v[i] = val; return true;
    }
    function wasmWriteI32(addr, val) {
        const v = wasm.i32; if (!v) return false;
        const i = addr >>> 2;
        if (i < 0 || i >= v.length) return false;
        v[i] = val | 0; return true;
    }

    function patchPlayerProperty(obj, prop, getter, setter) {
        try {
            const existing = Object.getOwnPropertyDescriptor(obj, prop);
            let backing = existing && 'value' in existing ? existing.value : undefined;
            const desc = {
                configurable: true,
                enumerable: existing ? !!existing.enumerable : true,
                get: function () { return getter ? getter(backing) : backing; },
                set: function (v) {
                    if (setter) { backing = setter(v, backing); return; }
                    backing = v;
                },
            };
            Object.defineProperty(obj, prop, desc);
            return true;
        } catch (e) { return false; }
    }

    function runSpeedWasm() {
        if (!state.speed.wasmAddr) return false;
        if (state.speed.wasmType === 'f32') {
            return wasmWriteFloat(state.speed.wasmAddr, state.speed.multiplier);
        }
        return wasmWriteI32(state.speed.wasmAddr, state.speed.multiplier | 0);
    }

    function runSpeedObject() {
        let touched = false;
        for (const obj of playerCandidates) {
            if (!obj) continue;
            if ('speed' in obj) {
                try { obj.speed = state.speed.multiplier; touched = true; } catch (e) {}
            }
            if ('vel' in obj && typeof obj.vel === 'number') {
                try { obj.vel = state.speed.multiplier; touched = true; } catch (e) {}
            }
            if ('moveSpeed' in obj) {
                try { obj.moveSpeed = state.speed.multiplier; touched = true; } catch (e) {}
            }
        }
        return touched;
    }

    let lastAmpSend = 0;
    function amplifyAndSend() {
        if (!lastSocket || lastSocket.readyState !== WebSocket.OPEN) return;
        const now = performance.now();
        if (now - lastAmpSend < 60) return;
        lastAmpSend = now;

        for (let i = 0; i < moveQueue.length; ++i) {
            const rec = moveQueue[i];
            const amp = amplifyMove(rec.parsed);
            if (!amp) continue;
            try { lastSocket.send(JSON.stringify(amp)); } catch (e) {}
        }
    }

    function amplifyMove(obj) {
        const f = state.speed.multiplier;
        const c = Object.assign({}, obj);
        let touched = false;
        const keys = ['dx', 'dy', 'vx', 'vy', 'mx', 'my'];
        for (let i = 0; i < keys.length; ++i) {
            const k = keys[i];
            if (typeof c[k] === 'number') { c[k] *= f; touched = true; }
        }
        return touched ? c : null;
    }

    function runSpeed() {
        if (!state.speed.enabled) return;
        const mode = state.speed.mode;
        if (mode === 'wasm' || mode === 'auto') {
            if (runSpeedWasm()) return;
        }
        if (mode === 'object' || mode === 'auto') {
            if (runSpeedObject()) return;
        }
        if (mode === 'ws' || mode === 'auto') {
            amplifyAndSend();
        }
    }

    // ============================================================
    //  17. FEATURE 5 — GOD MODE (WASM → Object → Key)
    // ============================================================
    function freezeHpWasm() {
        if (!state.godmode.wasmAddr) return false;
        const v = wasm.i32; if (!v) return false;
        const i = state.godmode.wasmAddr >>> 2;
        if (i < 0 || i >= v.length) return false;
        v[i] = state.godmode.lockValue | 0;
        return true;
    }

    function clampHpObject() {
        let touched = false;
        const lock = state.godmode.lockValue;
        for (const obj of playerCandidates) {
            if (!obj) continue;
            if ('hp' in obj && !obj.__veck_hp_patched) {
                obj.__veck_hp_patched = true;
                patchPlayerProperty(obj, 'hp',
                    function () { return lock; },
                    function (v) { return Math.min(v, lock); });
                touched = true;
            }
            if ('health' in obj && !obj.__veck_health_patched) {
                obj.__veck_health_patched = true;
                patchPlayerProperty(obj, 'health',
                    function () { return lock; },
                    function (v) { return Math.min(v, lock); });
                touched = true;
            }
        }
        return touched;
    }

    let lastHeal = 0;
    function autoHealKey() {
        const now = performance.now();
        if (now - lastHeal < state.godmode.healInterval) return;
        lastHeal = now;

        if (typeof hooks.healAction === 'function') {
            safe('healAction', function () { hooks.healAction(); });
            return;
        }

        const raw = state.godmode.healKey || 'h';
        const key = raw.length === 1 ? raw : raw.charAt(0);
        const upper = key.toUpperCase();
        const code = 'Key' + upper;
        const g = findGameCanvas();
        if (!g) return;

        try {
            g.dispatchEvent(new KeyboardEvent('keydown', {
                key: upper, code: code, bubbles: true, cancelable: true, view: window,
            }));
            setTimeout(function () {
                try {
                    g.dispatchEvent(new KeyboardEvent('keyup', {
                        key: upper, code: code, bubbles: true, cancelable: true, view: window,
                    }));
                } catch (e) {}
            }, 25);
        } catch (e) {}
    }

    function runGodMode() {
        if (!state.godmode.enabled) return;
        const mode = state.godmode.mode;
        if (mode === 'wasm' || mode === 'auto') { if (freezeHpWasm()) return; }
        if (mode === 'object' || mode === 'auto') { if (clampHpObject()) return; }
        if (mode === 'key' || mode === 'auto') { autoHealKey(); }
    }

    // ============================================================
    //  18. HOOKS + SCANNER
    // ============================================================
    const hooks = {
        onPacket: null,
        filterArc: null,
        healAction: null,
        fireAction: null,
    };

    const scanner = {
        lastHits: [],

        _view: function (type) {
            if (type === 'f32') return wasm.f32;
            if (type === 'f64') return wasm.f64;
            if (type === 'i32') return wasm.i32;
            if (type === 'u32') return wasm.u32;
            return null;
        },

        _eps: function (type) {
            return type === 'f32' ? 0.001 : (type === 'f64' ? 0.00001 : 0);
        },

        scan: function (type, value, maxHits) {
            maxHits = maxHits || 256;
            const view = this._view(type);
            if (!view) return [];
            const eps = this._eps(type);
            const hits = [];
            for (let i = 0; i < view.length; ++i) {
                const v = view[i];
                const m = (type === 'f32' || type === 'f64')
                    ? Math.abs(v - value) <= eps
                    : v === value;
                if (m) {
                    hits.push({ addr: i * view.BYTES_PER_ELEMENT, value: v });
                    if (hits.length >= maxHits) break;
                }
            }
            this.lastHits = hits;
            return hits;
        },

        refine: function (type, value) {
            const view = this._view(type);
            if (!view) return [];
            const eps = this._eps(type);
            const kept = [];
            for (let i = 0; i < this.lastHits.length; ++i) {
                const h = this.lastHits[i];
                const idx = h.addr / view.BYTES_PER_ELEMENT;
                if (idx < 0 || idx >= view.length) continue;
                const v = view[idx];
                const m = (type === 'f32' || type === 'f64')
                    ? Math.abs(v - value) <= eps
                    : v === value;
                if (m) kept.push({ addr: h.addr, value: v });
            }
            this.lastHits = kept;
            return kept;
        },

        write: function (type, addr, value) {
            if (type === 'f32') return wasmWriteFloat(addr, value);
            if (type === 'i32') return wasmWriteI32(addr, value | 0);
            return false;
        },

        read: function (type, addr) {
            if (type === 'f32') { const v = wasm.f32; return v ? v[addr >>> 2] : null; }
            if (type === 'i32') { const v = wasm.i32; return v ? v[addr >>> 2] : null; }
            return null;
        },
    };

    // ============================================================
    //  19. UI  — Shadow DOM so game CSS CANNOT hide it.
    // ============================================================
    const ui = {
        host: null,
        shadow: null,
        root: null,
        open: true,
        pill: null,
        draggable: true,
        mounted: false,
    };

    const CSS = [
        ':host { all: initial; }',
        '* { box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
        '.panel {',
        '  position: fixed; top: 12px; left: 12px; z-index: 2147483647;',
        '  background: rgba(12,12,18,0.92); color: #e0e0e8;',
        '  width: 300px; max-height: 92vh; overflow-y: auto;',
        '  border: 1px solid #2a2a3a; border-radius: 8px;',
        '  padding: 10px 12px; font-size: 12px; line-height: 1.45;',
        '  box-shadow: 0 8px 32px rgba(0,0,0,0.6);',
        '  user-select: none; -webkit-user-select: none;',
        '}',
        '.panel.collapsed .body { display: none; }',
        '.head {',
        '  display: flex; align-items: center; justify-content: space-between;',
        '  font-weight: bold; font-size: 13px; color: #00e5ff;',
        '  cursor: move; padding-bottom: 6px; margin-bottom: 6px;',
        '  border-bottom: 1px solid #2a2a3a;',
        '}',
        '.head .btns { display: flex; gap: 6px; cursor: pointer; }',
        '.head .btns span { color: #889; font-size: 14px; padding: 0 3px; }',
        '.head .btns span:hover { color: #fff; }',
        '.sec { color: #ff2d55; font-weight: bold; margin: 10px 0 4px; font-size: 12px; }',
        '.sec.y { color: #ffcc00; }',
        '.sec.g { color: #aaff00; }',
        '.sec.b { color: #00e5ff; }',
        '.sec.p { color: #ff5cf0; }',
        'label.row { display: flex; align-items: center; gap: 6px; margin: 3px 0; cursor: pointer; color: #c8c8d0; }',
        'label.row input[type=checkbox] { accent-color: #00e5ff; }',
        '.srow { margin: 6px 0; }',
        '.srow .lbl { font-size: 11px; opacity: 0.85; margin-bottom: 2px; }',
        '.srow input[type=range] { width: 100%; accent-color: #00e5ff; }',
        '.trow { margin: 6px 0; }',
        '.trow .lbl { font-size: 11px; opacity: 0.85; margin-bottom: 2px; }',
        '.trow input[type=text], .trow input[type=number] {',
        '  width: 100%; background: #0b0b12; color: #dcdce0;',
        '  border: 1px solid #2a2a3a; border-radius: 3px; padding: 3px 5px; font-size: 12px;',
        '}',
        '.stat { border-top: 1px solid #2a2a3a; margin-top: 12px; padding-top: 6px; font-size: 11px; opacity: 0.75; }',
        '.stat div { margin: 1px 0; }',
        '.stat .k { color: #00e5ff; }',
        '.stat .api { color: #666; margin-top: 4px; }',
        '.pill {',
        '  position: fixed; top: 12px; left: 12px; z-index: 2147483647;',
        '  background: rgba(12,12,18,0.9); color: #00e5ff;',
        '  border: 1px solid #00e5ff; border-radius: 20px;',
        '  padding: 4px 12px; font-size: 12px; font-weight: bold;',
        '  cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,0.5);',
        '  user-select: none; display: none;',
        '}',
        '.pill:hover { background: #00e5ff; color: #0b0b12; }',
    ].join('\n');

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = String(text);
        return n;
    }

    function header(text, colorClass) {
        return el('div', 'sec ' + (colorClass || ''), text);
    }

    function checkRow(label, obj, key) {
        const wrap = el('label', 'row');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!obj[key];
        cb.addEventListener('change', function () { obj[key] = cb.checked; });
        wrap.appendChild(cb);
        wrap.appendChild(document.createTextNode(label));
        return wrap;
    }

    function sliderRow(label, obj, key, min, max, step, fmt) {
        const wrap = el('div', 'srow');
        const l = el('div', 'lbl');
        const render = function () {
            l.textContent = label + ': ' + (fmt ? fmt(obj[key]) : obj[key]);
        };
        render();
        const s = document.createElement('input');
        s.type = 'range'; s.min = String(min); s.max = String(max); s.step = String(step);
        s.value = String(obj[key]);
        s.addEventListener('input', function () {
            obj[key] = parseFloat(s.value);
            render();
        });
        wrap.appendChild(l);
        wrap.appendChild(s);
        return wrap;
    }

    function textRow(label, obj, key, placeholder) {
        const wrap = el('div', 'trow');
        wrap.appendChild(el('div', 'lbl', label));
        const i = document.createElement('input');
        i.type = 'text';
        i.value = obj[key] === undefined || obj[key] === null ? '' : String(obj[key]);
        i.placeholder = placeholder || '';
        i.addEventListener('input', function () { obj[key] = i.value; });
        wrap.appendChild(i);
        return wrap;
    }

    function numberRow(label, obj, key, step) {
        const wrap = el('div', 'trow');
        wrap.appendChild(el('div', 'lbl', label));
        const i = document.createElement('input');
        i.type = 'number';
        i.step = String(step || 1);
        i.value = obj[key] !== undefined ? String(obj[key]) : '';
        i.addEventListener('input', function () {
            const v = parseFloat(i.value);
            obj[key] = isNaN(v) ? 0 : v;
        });
        wrap.appendChild(i);
        return wrap;
    }

    function buildPanel(shadow) {
        const panel = el('div', 'panel');

        // ---- draggable header ----
        const head = el('div', 'head');
        const title = el('span', '', 'VECK TRAINER  [' + state.toggleKey + ']');
        const btns  = el('span', 'btns');
        const collapse = el('span', '', '–');
        const close    = el('span', '', '×');
        btns.appendChild(collapse);
        btns.appendChild(close);
        head.appendChild(title);
        head.appendChild(btns);
        panel.appendChild(head);

        // ---- body ----
        const body = el('div', 'body');

        body.appendChild(header('1. ESP  (canvas hook)'));
        body.appendChild(checkRow('Enabled', state.esp, 'enabled'));
        body.appendChild(checkRow('Show labels', state.esp, 'showLabels'));
        body.appendChild(sliderRow('Min radius', state.esp, 'minRadius', 1, 40, 1));
        body.appendChild(sliderRow('Max radius', state.esp, 'maxRadius', 20, 300, 1));

        body.appendChild(header('2. Aimbot  (event rewrite)', 'y'));
        body.appendChild(checkRow('Enabled', state.aimbot, 'enabled'));
        body.appendChild(checkRow('Hold SHIFT to engage', state.aimbot, 'holdShift'));
        body.appendChild(checkRow('Use Math.atan2 path', state.aimbot, 'useMathHook'));
        body.appendChild(sliderRow('FOV (px)', state.aimbot, 'fov', 50, 1500, 10));
        body.appendChild(sliderRow('Smooth', state.aimbot, 'smooth', 0, 0.95, 0.05,
            function (v) { return v.toFixed(2); }));

        body.appendChild(header('3. AutoFire  (synthetic click)', 'g'));
        body.appendChild(checkRow('Enabled', state.autofire, 'enabled'));
        body.appendChild(sliderRow('Rate (ms)', state.autofire, 'rate', 30, 500, 10));
        body.appendChild(sliderRow('Range (px)', state.autofire, 'range', 50, 1000, 10));

        body.appendChild(header('4. Speed Hack', 'b'));
        body.appendChild(checkRow('Enabled', state.speed, 'enabled'));
        body.appendChild(sliderRow('Multiplier', state.speed, 'multiplier', 1, 10, 0.1,
            function (v) { return v.toFixed(1) + 'x'; }));
        body.appendChild(textRow('WASM address (decimal, optional)', state.speed, 'wasmAddr',
            'e.g. 123456 — from scanner'));

        body.appendChild(header('5. God Mode', 'p'));
        body.appendChild(checkRow('Enabled', state.godmode, 'enabled'));
        body.appendChild(numberRow('Lock HP value', state.godmode, 'lockValue', 1));
        body.appendChild(sliderRow('Heal interval (ms)', state.godmode, 'healInterval',
            150, 2000, 25));
        body.appendChild(textRow('Heal key', state.godmode, 'healKey', 'h'));

        // ---- stats block ----
        const stat = el('div', 'stat');
        const stCanvas = el('div', ''); stCanvas.innerHTML = '<span class="k">canvas</span> entities: 0';
        const stWasm   = el('div', ''); stWasm.innerHTML   = '<span class="k">WASM</span>: —';
        const stNet    = el('div', ''); stNet.innerHTML    = '<span class="k">net</span> entities: 0';
        const stGlob   = el('div', ''); stGlob.innerHTML   = '<span class="k">globals</span>: 0';
        const stPlay   = el('div', ''); stPlay.innerHTML   = '<span class="k">players</span>: 0';
        const stPkt    = el('div', ''); stPkt.innerHTML    = '<span class="k">packets</span>: 0';
        stat.appendChild(stCanvas);
        stat.appendChild(stWasm);
        stat.appendChild(stNet);
        stat.appendChild(stGlob);
        stat.appendChild(stPlay);
        stat.appendChild(stPkt);
        stat.appendChild(el('div', 'api', 'window.VECK → state / hooks / scanner'));
        body.appendChild(stat);

        panel.appendChild(body);

        // collapse button
        collapse.addEventListener('click', function (e) {
            e.stopPropagation();
            panel.classList.toggle('collapsed');
            collapse.textContent = panel.classList.contains('collapsed') ? '+' : '–';
        });

        // close button → hide UI, show pill
        close.addEventListener('click', function (e) {
            e.stopPropagation();
            ui.open = false;
            panel.style.display = 'none';
            if (ui.pill) ui.pill.style.display = 'block';
        });

        // drag handler
        (function makeDraggable() {
            let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

            head.addEventListener('mousedown', function (e) {
                if (e.target === collapse || e.target === close) return;
                dragging = true;
                const r = panel.getBoundingClientRect();
                ox = r.left; oy = r.top;
                sx = e.clientX; sy = e.clientY;
                e.preventDefault();
                e.stopPropagation();
            });

            document.addEventListener('mousemove', function (e) {
                if (!dragging) return;
                const nx = Math.max(0, Math.min(window.innerWidth - 60,  ox + (e.clientX - sx)));
                const ny = Math.max(0, Math.min(window.innerHeight - 30, oy + (e.clientY - sy)));
                panel.style.left = nx + 'px';
                panel.style.top  = ny + 'px';
                // keep the pill aligned
                if (ui.pill) { ui.pill.style.left = nx + 'px'; ui.pill.style.top = ny + 'px'; }
            }, true);

            document.addEventListener('mouseup', function () { dragging = false; }, true);
        })();

        shadow.appendChild(panel);
        ui.root = panel;
        ui.stats = {
            canvas: stCanvas,
            wasm:   stWasm,
            net:    stNet,
            globals: stGlob,
            players: stPlay,
            packets: stPkt,
        };
        return panel;
    }

    function buildPill(shadow) {
        const pill = el('div', 'pill', 'VECK');
        pill.addEventListener('click', function () {
            ui.open = true;
            pill.style.display = 'none';
            if (ui.root) {
                ui.root.style.display = 'block';
                ui.root.classList.remove('collapsed');
            }
        });
        shadow.appendChild(pill);
        ui.pill = pill;
        return pill;
    }

    function mountUI() {
        if (!document.documentElement) {
            setTimeout(mountUI, 30);
            return;
        }

        // Remove existing host if the game nuked it
        const existing = document.getElementById('__veck_host');
        if (existing && !existing.shadowRoot) existing.remove();

        if (document.getElementById('__veck_host') && ui.mounted) return;

        const host = document.createElement('div');
        host.id = '__veck_host';
        host.style.cssText = [
            'position: fixed',
            'top: 0',
            'left: 0',
            'width: 0',
            'height: 0',
            'z-index: 2147483647',
            'pointer-events: none',
        ].join(';');

        let shadow;
        try {
            shadow = host.attachShadow({ mode: 'open' });
        } catch (e) {
            // ultra-legacy fallback: plain div, still styled inline
            shadow = host;
        }

        const style = document.createElement('style');
        style.textContent = CSS;
        shadow.appendChild(style);

        // re-enable pointer events on the panel + pill (host is pointer-events:none)
        const panel = buildPanel(shadow);
        panel.style.pointerEvents = 'auto';
        const pill = buildPill(shadow);
        pill.style.pointerEvents = 'auto';

        // Mount to <html> — exists at document-start, the game can't remove <html>
        document.documentElement.appendChild(host);

        ui.host = host;
        ui.shadow = shadow;
        ui.mounted = true;
        boot('ui-mounted(shadow)');

        // sanity log so the console confirms it
        try {
            console.log('[VECK] UI mounted at',
                        panel.getBoundingClientRect().left + ',' +
                        panel.getBoundingClientRect().top);
        } catch (e) {}
    }

    // Mount immediately (documentElement exists even at document-start)
    mountUI();

    // Re-mount guard — the game's SPA router nukes the DOM every so often
    setInterval(function () {
        if (!document.getElementById('__veck_host')) {
            ui.mounted = false;
            mountUI();
        }
    }, 750);

    // ============================================================
    //  20. KEYBINDING
    // ============================================================
    document.addEventListener('keydown', function (e) {
        if (e.key === state.toggleKey) {
            ui.open = !ui.open;
            if (ui.root)  ui.root.style.display  = ui.open ? 'block' : 'none';
            if (ui.pill)  ui.pill.style.display  = ui.open ? 'none'  : 'block';
        }
        if (e.key === 'Shift') aimEngaged = true;
    }, { capture: true });

    document.addEventListener('keyup', function (e) {
        if (e.key === 'Shift') aimEngaged = false;
    }, { capture: true });

    // ============================================================
    //  21. MAIN LOOP
    // ============================================================
    let tickCount = 0;

    function tick() {
        try {
            pruneScreens();
            safe('esp',     drawESP);
            safe('aimbot',  runAimbot);
            safe('autofire', runAutoFire);
            safe('speed',   runSpeed);
            safe('godmode', runGodMode);

            if (ui.stats && (tickCount % 30) === 0) {
                ui.stats.canvas.innerHTML  = '<span class="k">canvas</span> entities: ' + screenArcs.length;
                ui.stats.wasm.innerHTML    = '<span class="k">WASM</span>: ' +
                    (wasm.memory ? (wasm.memory.buffer.byteLength + ' B') : '—');
                ui.stats.net.innerHTML     = '<span class="k">net</span> entities: ' + netEntities.size;
                ui.stats.globals.innerHTML = '<span class="k">globals</span>: ' + gameGlobals.length;
                ui.stats.players.innerHTML = '<span class="k">players</span>: ' + playerCandidates.size;
                ui.stats.packets.innerHTML = '<span class="k">packets</span>: ' + wsLog.length;
            }
        } catch (e) {
            try { console.warn('[VECK][tick]', e); } catch (_) {}
        }
        tickCount++;
        requestAnimationFrame(tick);
    }

    // ============================================================
    //  22. BOOT + PUBLIC API
    // ============================================================
    requestAnimationFrame(tick);

    // periodic global rescan
    setInterval(scanGlobals, 1000);

    window.VECK = {
        version: '3.0.0',
        boot: BOOT,
        state: state,
        hooks: hooks,
        scanner: scanner,
        wasm: wasm,
        ui: ui,

        netEntities: netEntities,
        screenArcs: screenArcs,
        screenBoxes: screenBoxes,
        playerCandidates: playerCandidates,
        gameGlobals: gameGlobals,

        scanGlobals: scanGlobals,
        aimTarget: aimTarget,
        inferLocalPlayer: inferLocalPlayer,
        findGameCanvas: findGameCanvas,

        toggleUI: function () {
            ui.open = !ui.open;
            if (ui.root) ui.root.style.display = ui.open ? 'block' : 'none';
            if (ui.pill) ui.pill.style.display = ui.open ? 'none' : 'block';
        },

        remountUI: function () {
            const old = document.getElementById('__veck_host');
            if (old) old.remove();
            ui.mounted = false;
            mountUI();
        },

        sendRaw: function (payload) {
            if (lastSocket && lastSocket.readyState === WebSocket.OPEN) {
                try { return lastSocket.send(payload); } catch (e) { return false; }
            }
            return false;
        },

        getWsLog: function () { return wsLog.slice(); },

        dumpWsLog: function () {
            try { console.table(wsLog.slice(-40)); } catch (e) {}
        },

        snapshot: function () {
            return {
                uiMounted: !!document.getElementById('__veck_host'),
                uiOpen: ui.open,
                canvasEntities: screenArcs.length,
                netEntities: netEntities.size,
                playerCandidates: playerCandidates.size,
                gameGlobals: gameGlobals.length,
                wasmBytes: wasm.memory ? wasm.memory.buffer.byteLength : 0,
                packetsLogged: wsLog.length,
                bootStages: BOOT.slice(),
            };
        },
    };

    boot('ready');

    try {
        console.log(
            '%c[VECK] v3.0.0 loaded%c\n' +
            'UI: top-left, Shadow-DOM (game CSS cannot hide it). INSERT toggles, × hides to a pill.\n' +
            'If the panel is missing, run: VECK.snapshot()  — check bootStages + uiMounted.\n' +
            'Public API: window.VECK',
            'color:#00e5ff;font-weight:bold', 'color:#aaa'
        );
    } catch (e) {}
})();