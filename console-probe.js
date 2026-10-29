// console-probe.js
// Paste into DevTools console. Syntax-error-free v3 — the previous version had
// a stray backtick in the WASM harvest block that threw on parse.
// Lightweight probe: canvas ESP + WS capture + WASM memory hook + defineProperty
// trap + draggable Shadow-DOM-free panel. Everything under window.VECK.

(function () {
    'use strict';

    if (window.__veck_probe_loaded) {
        console.warn('[VECK-PROBE] already loaded');
        return;
    }
    window.__veck_probe_loaded = true;

    // ---------- native toString shield ----------
    const NTS = Function.prototype.toString;
    const nativeMap = new WeakMap();

    function markNative(fn, name) {
        nativeMap.set(fn, name ? 'function ' + name + '() { [native code] }'
                              : 'function () { [native code] }');
        return fn;
    }

    Function.prototype.toString = markNative(function () {
        if (nativeMap.has(this)) return nativeMap.get(this);
        return NTS.call(this);
    }, 'toString');

    const RA = Reflect.apply;

    // ---------- compact state ----------
    const st = {
        esp: true,
        espMinR: 6,
        espMaxR: 120,
        aim: false,
        aimFov: 400,
        aimSmooth: 0.7,
        autoFire: false,
        autoFireRate: 100,
        autoFireRange: 400,
        speed: false,
        speedMult: 3,
        god: false,
        godLock: 100,
        godKey: 'h',
        godInterval: 400,
    };

    // ---------- WASM memory hook ----------
    const wasmMem = { memory: null };

    (function hookWasm() {
        if (typeof WebAssembly === 'undefined') return;

        function harvest(result) {
            if (!result) return result;
            const inst = result.instance || result;
            if (inst && inst.exports) {
                for (const k in inst.exports) {
                    let v;
                    try { v = inst.exports[k]; } catch (e) { continue; }
                    if (v instanceof WebAssembly.Memory) {
                        wasmMem.memory = v;
                    }
                }
            }
            return result;
        }

        const nativeInst = WebAssembly.instantiate;
        const nativeStr  = WebAssembly.instantiateStreaming;
        const NativeInstance = WebAssembly.Instance;

        WebAssembly.instantiate = markNative(function () {
            const p = RA(nativeInst, this, arguments);
            if (p && typeof p.then === 'function') return p.then(harvest);
            return harvest(p);
        }, 'instantiate');

        if (nativeStr) {
            WebAssembly.instantiateStreaming = markNative(function () {
                const p = RA(nativeStr, this, arguments);
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
    })();

    function f32() { return wasmMem.memory ? new Float32Array(wasmMem.memory.buffer)  : null; }
    function f64() { return wasmMem.memory ? new Float64Array(wasmMem.memory.buffer)  : null; }
    function i32() { return wasmMem.memory ? new Int32Array(wasmMem.memory.buffer)    : null; }
    function u8()  { return wasmMem.memory ? new Uint8Array(wasmMem.memory.buffer)    : null; }

    // ---------- canvas 2D hook ----------
    const arcs = [];

    (function hookCanvas() {
        if (typeof CanvasRenderingContext2D === 'undefined') return;
        const proto = CanvasRenderingContext2D.prototype;

        function gameCtx(ctx) {
            const c = ctx && ctx.canvas;
            if (!c || c.id === '__veck_probe_overlay') return false;
            const r = c.getBoundingClientRect ? c.getBoundingClientRect() : null;
            if (!r) return true;
            return (r.width * r.height) >= (window.innerWidth * window.innerHeight) * 0.20;
        }

        const origArc = proto.arc;
        proto.arc = markNative(function (x, y, r, a, b, c) {
            if (gameCtx(this)
                && typeof x === 'number' && typeof y === 'number' && typeof r === 'number'
                && isFinite(x) && isFinite(y) && isFinite(r)
                && r >= st.espMinR && r <= st.espMaxR) {
                arcs.push({ x: x, y: y, r: r, t: performance.now() });
            }
            return RA(origArc, this, arguments);
        }, 'arc');
    })();

    // ---------- websocket hook ----------
    const wsLog = [];
    let lastSocket = null;
    const netEntities = new Map();

    (function hookWS() {
        if (typeof WebSocket === 'undefined') return;
        const Native = WebSocket;

        function Wrapped(url, protocols) {
            const s = protocols !== undefined
                ? new Native(url, protocols)
                : new Native(url);

            s.addEventListener('message', function (ev) {
                const d = ev.data;
                let preview;
                if (typeof d === 'string') preview = d.slice(0, 220);
                else if (d && d.byteLength) preview = '[bin ' + d.byteLength + 'B]';
                else preview = '[other]';

                wsLog.push({ t: Date.now(), dir: 'in', preview: preview });
                if (wsLog.length > 600) wsLog.shift();

                try {
                    let msg = d;
                    if (typeof d === 'string') msg = JSON.parse(d);
                    else if (typeof ArrayBuffer !== 'undefined' && d instanceof ArrayBuffer)
                        msg = JSON.parse(new TextDecoder().decode(d));
                    else return;
                    walkEntities(msg);
                } catch (e) {}
            }, true);

            const nativeSend = s.send;
            s.send = markNative(function (payload) {
                return RA(nativeSend, s, arguments);
            }, 'send');

            lastSocket = s;
            return s;
        }

        Wrapped.prototype = Native.prototype;
        try { Object.setPrototypeOf(Wrapped, Native); } catch (e) {}
        Wrapped.CONNECTING = Native.CONNECTING;
        Wrapped.OPEN       = Native.OPEN;
        Wrapped.CLOSING    = Native.CLOSING;
        Wrapped.CLOSED     = Native.CLOSED;

        window.WebSocket = markNative(Wrapped, 'WebSocket');
    })();

    function num(o, keys) {
        for (let i = 0; i < keys.length; ++i) {
            const v = o[keys[i]];
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

            const x  = num(node, ['x', 'px', 'posX', 'positionX']);
            const y  = num(node, ['y', 'py', 'posY', 'positionY']);
            const id = node.id !== undefined ? node.id
                     : node.pid !== undefined ? node.pid
                     : node.uid !== undefined ? node.uid
                     : node.eid !== undefined ? node.eid
                     : node.playerId;

            if (x !== null && y !== null && id !== undefined && id !== null) {
                netEntities.set(String(id), {
                    id: id, x: x, y: y,
                    hp:    num(node, ['hp', 'health', 'life']),
                    maxHp: num(node, ['maxHp', 'maxHealth', 'hpMax']),
                    name:  node.name !== undefined ? node.name
                         : node.nick !== undefined ? node.nick
                         : node.username,
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

    // ---------- defineProperty trap ----------
    const playerCandidates = new Set();
    const PK = ['hp', 'health', 'x', 'y', 'speed', 'vel', 'alive', 'dead', 'id', 'name', 'team'];

    (function hookDefine() {
        const native = Object.defineProperty;
        Object.defineProperty = markNative(function (obj, prop, desc) {
            if (obj && typeof obj === 'object'
                && typeof prop === 'string'
                && PK.indexOf(prop) >= 0) {
                obj.__veck_hits = (obj.__veck_hits || 0) + 1;
                if (obj.__veck_hits >= 3) playerCandidates.add(obj);
            }
            return RA(native, this, arguments);
        }, 'defineProperty');
    })();

    // ---------- overlay canvas ----------
    const ov = document.createElement('canvas');
    ov.id = '__veck_probe_overlay';
    ov.width  = window.innerWidth;
    ov.height = window.innerHeight;
    ov.style.cssText = [
        'position:fixed', 'top:0', 'left:0',
        'width:100vw', 'height:100vh',
        'pointer-events:none', 'z-index:2147483600', 'background:transparent',
    ].join(';');
    const octx = ov.getContext('2d');

    function attachOverlay() {
        const parent = document.body || document.documentElement;
        if (!parent) { setTimeout(attachOverlay, 30); return; }
        if (!document.getElementById('__veck_probe_overlay')) parent.appendChild(ov);
    }
    attachOverlay();

    window.addEventListener('resize', function () {
        ov.width  = window.innerWidth;
        ov.height = window.innerHeight;
    });

    // ---------- mouse tracking ----------
    let mx = window.innerWidth / 2;
    let my = window.innerHeight / 2;
    document.addEventListener('mousemove', function (e) {
        mx = e.clientX; my = e.clientY;
    }, { capture: true, passive: true });
    document.addEventListener('pointermove', function (e) {
        mx = e.clientX; my = e.clientY;
    }, { capture: true, passive: true });

    // ---------- utilities ----------
    function findCanvas() {
        const list = document.querySelectorAll('canvas');
        let best = null, bestArea = 0;
        for (let i = 0; i < list.length; ++i) {
            const c = list[i];
            if (c.id === '__veck_probe_overlay') continue;
            const r = c.getBoundingClientRect();
            const a = r.width * r.height;
            if (a > bestArea) { bestArea = a; best = c; }
        }
        return best;
    }

    function canvasRect() {
        const g = findCanvas();
        if (!g) return { left: 0, top: 0, width: ov.width, height: ov.height };
        const r = g.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    }

    function pruneArcs() {
        const now = performance.now();
        for (let i = arcs.length - 1; i >= 0; --i) {
            if (now - arcs[i].t > 120) arcs.splice(i, 1);
        }
    }

    // ---------- aim ----------
    function aimTarget() {
        let best = null, bestD = st.aimFov;
        const rect = canvasRect();
        for (let i = 0; i < arcs.length; ++i) {
            const a = arcs[i];
            const sx = rect.left + a.x, sy = rect.top + a.y;
            const dx = sx - mx, dy = sy - my;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < bestD) { bestD = d; best = { sx: sx, sy: sy, r: a.r }; }
        }
        return best;
    }

    // ---------- autofire ----------
    let lastFire = 0;

    // ---------- god mode ----------
    let lastHeal = 0;

    // ---------- HUD ----------
    const hud = document.createElement('div');
    hud.id = '__veck_probe_hud';
    hud.style.cssText = [
        'position:fixed', 'bottom:12px', 'left:12px',
        'z-index:2147483647',
        'background:rgba(12,12,18,0.9)', 'color:#00e5ff',
        'font:12px ui-monospace,monospace',
        'padding:6px 10px', 'border:1px solid #2a2a3a', 'border-radius:6px',
        'pointer-events:none', 'user-select:none',
    ].join(';');
    hud.textContent = 'VECK-PROBE';
    function attachHud() {
        const parent = document.body || document.documentElement;
        if (!parent) { setTimeout(attachHud, 30); return; }
        if (!document.getElementById('__veck_probe_hud')) parent.appendChild(hud);
    }
    attachHud();

    // ---------- main loop ----------
    function loop() {
        pruneArcs();
        octx.clearRect(0, 0, ov.width, ov.height);

        const rect = canvasRect();
        const g = findCanvas();

        if (st.esp) {
            octx.strokeStyle = '#ff2d55';
            octx.lineWidth = 2;
            for (let i = 0; i < arcs.length; ++i) {
                const a = arcs[i];
                octx.beginPath();
                octx.arc(rect.left + a.x, rect.top + a.y, a.r + 3, 0, Math.PI * 2);
                octx.stroke();
            }

            octx.strokeStyle = '#00e5ff';
            octx.lineWidth = 1.5;
            for (const e of netEntities.values()) {
                octx.beginPath();
                octx.arc(rect.left + e.x, rect.top + e.y, 20, 0, Math.PI * 2);
                octx.stroke();
            }
        }

        if (st.aim && g) {
            const t = aimTarget();
            if (t) {
                const nx = mx + (t.sx - mx) * (1 - st.aimSmooth);
                const ny = my + (t.sy - my) * (1 - st.aimSmooth);
                try {
                    g.dispatchEvent(new MouseEvent('mousemove', {
                        clientX: nx, clientY: ny,
                        bubbles: true, cancelable: true, view: window,
                    }));
                    if (typeof PointerEvent !== 'undefined') {
                        g.dispatchEvent(new PointerEvent('pointermove', {
                            clientX: nx, clientY: ny,
                            bubbles: true, cancelable: true,
                            view: window, pointerType: 'mouse',
                        }));
                    }
                } catch (e) {}
                mx = nx; my = ny;
            }
        }

        if (st.autoFire && g) {
            const now = performance.now();
            if (now - lastFire >= st.autoFireRate) {
                const t = aimTarget();
                if (t) {
                    const dx = t.sx - mx, dy = t.sy - my;
                    if (Math.sqrt(dx * dx + dy * dy) <= st.autoFireRange) {
                        lastFire = now;
                        try {
                            g.dispatchEvent(new MouseEvent('mousedown', {
                                clientX: t.sx, clientY: t.sy, button: 0,
                                bubbles: true, cancelable: true, view: window,
                            }));
                            g.dispatchEvent(new MouseEvent('mouseup', {
                                clientX: t.sx, clientY: t.sy, button: 0,
                                bubbles: true, cancelable: true, view: window,
                            }));
                        } catch (e) {}
                    }
                }
            }
        }

        if (st.god && g) {
            const now = performance.now();
            if (now - lastHeal >= st.godInterval) {
                lastHeal = now;
                const raw = st.godKey || 'h';
                const upper = raw.charAt(0).toUpperCase();
                try {
                    g.dispatchEvent(new KeyboardEvent('keydown', {
                        key: upper, code: 'Key' + upper,
                        bubbles: true, cancelable: true, view: window,
                    }));
                    g.dispatchEvent(new KeyboardEvent('keyup', {
                        key: upper, code: 'Key' + upper,
                        bubbles: true, cancelable: true, view: window,
                    }));
                } catch (e) {}
            }
        }

        // HUD refresh
        hud.textContent =
            'VECK-PROBE  arcs:' + arcs.length +
            ' net:' + netEntities.size +
            ' pc:' + playerCandidates.size +
            ' wasm:' + (wasmMem.memory ? (wasmMem.memory.buffer.byteLength + 'B') : '—');

        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    // ---------- public API ----------
    window.VECK = {
        version: '3.0.0-probe',
        state: st,
        wasmMem: wasmMem,
        netEntities: netEntities,
        arcs: arcs,
        playerCandidates: playerCandidates,
        f32: f32, f64: f64, i32: i32, u8: u8,

        aim: function (on, fov, smooth) {
            st.aim = !!on;
            if (typeof fov === 'number')    st.aimFov    = fov;
            if (typeof smooth === 'number') st.aimSmooth = smooth;
        },

        esp: function (on) { st.esp = !!on; },
        espRange: function (minR, maxR) {
            if (typeof minR === 'number') st.espMinR = minR;
            if (typeof maxR === 'number') st.espMaxR = maxR;
        },

        autoFire: function (on, rate, range) {
            st.autoFire = !!on;
            if (typeof rate === 'number')  st.autoFireRate  = rate;
            if (typeof range === 'number') st.autoFireRange = range;
        },

        god: function (on, lock, key, interval) {
            st.god = !!on;
            if (typeof lock === 'number')     st.godLock     = lock;
            if (typeof key === 'string')      st.godKey      = key;
            if (typeof interval === 'number') st.godInterval = interval;
        },

        speed: function (on, mult) {
            st.speed = !!on;
            if (typeof mult === 'number') st.speedMult = mult;
        },

        wasmReady: function () {
            return !!(wasmMem.memory && wasmMem.memory.buffer &&
                      wasmMem.memory.buffer.byteLength > 0);
        },

        wasmSize: function () {
            return wasmMem.memory ? wasmMem.memory.buffer.byteLength : 0;
        },

        scan: function (type, value, maxHits) {
            maxHits = maxHits || 256;
            const view = type === 'f32' ? f32()
                       : type === 'f64' ? f64()
                       : type === 'i32' ? i32()
                       : null;
            if (!view) return [];
            const eps = type === 'f32' ? 0.001 : (type === 'f64' ? 0.00001 : 0);
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
            this._lastHits = hits;
            return hits;
        },

        refine: function (type, value) {
            const view = type === 'f32' ? f32()
                       : type === 'f64' ? f64()
                       : type === 'i32' ? i32()
                       : null;
            if (!view) return [];
            const eps = type === 'f32' ? 0.001 : (type === 'f64' ? 0.00001 : 0);
            const kept = [];
            const prev = this._lastHits || [];
            for (let i = 0; i < prev.length; ++i) {
                const h = prev[i];
                const idx = h.addr / view.BYTES_PER_ELEMENT;
                if (idx < 0 || idx >= view.length) continue;
                const v = view[idx];
                const m = (type === 'f32' || type === 'f64')
                    ? Math.abs(v - value) <= eps
                    : v === value;
                if (m) kept.push({ addr: h.addr, value: v });
            }
            this._lastHits = kept;
            return kept;
        },

        write: function (type, addr, value) {
            if (type === 'f32') {
                const v = f32(); if (!v) return false;
                const i = addr >>> 2;
                if (i < 0 || i >= v.length) return false;
                v[i] = value; return true;
            }
            if (type === 'i32') {
                const v = i32(); if (!v) return false;
                const i = addr >>> 2;
                if (i < 0 || i >= v.length) return false;
                v[i] = value | 0; return true;
            }
            return false;
        },

        read: function (type, addr) {
            if (type === 'f32') { const v = f32(); return v ? v[addr >>> 2] : null; }
            if (type === 'i32') { const v = i32(); return v ? v[addr >>> 2] : null; }
            return null;
        },

        freeze: function (type, addr, value) {
            const key = addr + ':' + type;
            if (this._freezes[key]) return;
            const self = this;
            this._freezes[key] = setInterval(function () {
                self.write(type, addr, value);
            }, 16);
        },

        unfreezeAll: function () {
            for (const k in this._freezes) {
                clearInterval(this._freezes[k]);
                delete this._freezes[k];
            }
        },

        _freezes: {},
        _lastHits: [],

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
                canvasEntities: arcs.length,
                netEntities: netEntities.size,
                playerCandidates: playerCandidates.size,
                wasmBytes: wasmMem.memory ? wasmMem.memory.buffer.byteLength : 0,
                hudMounted: !!document.getElementById('__veck_probe_hud'),
                overlayMounted: !!document.getElementById('__veck_probe_overlay'),
            };
        },
    };

    try {
        console.log(
            '%c[VECK-PROBE] v3.0.0%c ready. All state under window.VECK.\n' +
            '  VECK.snapshot()\n' +
            '  VECK.aim(true, 500, 0.6)\n' +
            '  VECK.autoFire(true, 100, 400)\n' +
            '  VECK.god(true, 100, "h", 400)\n' +
            '  VECK.speed(true, 3)\n' +
            '  VECK.dumpWsLog()\n' +
            '  VECK.scan("f32", 3.5)',
            'color:#00e5ff;font-weight:bold', 'color:#aaa'
        );
    } catch (e) {}
})();