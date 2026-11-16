// Test helper (not a test file): a fake clock with timers and vsync-timed animation frames, a fake canvas and a fake
// document, so PCD.host runs in Node exactly as it schedules in a page.

/**
 * fakeTime({ wall, vsyncHz, jitterMs, seed }) -> env: perfNow(), now() (wall clock ms), setTimeout, clearTimeout,
 * requestAnimationFrame, cancelAnimationFrame, advance(ms), pending() -> { timers, rafs }, counts { timers, rafs }.
 * Animation frames fire at the next vsync (plus a deterministic jitter); timers fire at their due time.
 */
export function fakeTime({ wall = Date.UTC(2026, 10, 15, 12, 0, 0), vsyncHz = 120, jitterMs = 0, seed = 7 } = {}) {
  let t = 1000;
  let nextId = 1;
  const timers = new Map();
  const rafs = new Map();
  const counts = { timers: 0, rafs: 0, rafCallbacks: 0 };
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const vs = 1000 / vsyncHz;
  const env = {
    perfNow: () => t,
    now: () => wall + (t - 1000),
    setTimeout: (fn, ms) => {
      const id = nextId++;
      counts.timers++;
      timers.set(id, { fn, at: t + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    requestAnimationFrame: (fn) => {
      const id = nextId++;
      counts.rafs++;
      rafs.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id) => { rafs.delete(id); },
    pending: () => ({ timers: timers.size, rafs: rafs.size }),
    counts,
    setWall(ms) { wall = ms - (t - 1000); },
    /** The main thread was blocked for ms: time moves on, nothing fires until the next advance(). */
    stall(ms) { t += ms; },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let nextTimer = Infinity;
        let tid = null;
        for (const [id, tm] of timers) if (tm.at < nextTimer) { nextTimer = tm.at; tid = id; }
        let nextVsync = Infinity;
        if (rafs.size) {
          nextVsync = Math.floor(t / vs + 1e-9) * vs + vs;
          if (jitterMs) nextVsync += (rnd() - 0.5) * 2 * jitterMs;
          if (nextVsync <= t) nextVsync = t + 0.001;
        }
        const next = Math.min(nextTimer, nextVsync);
        if (next > end) break;
        t = Math.max(t, next);
        if (nextTimer <= nextVsync) {
          const tm = timers.get(tid);
          timers.delete(tid);
          tm.fn();
        } else {
          const list = [...rafs.values()];
          rafs.clear();
          for (const fn of list) { counts.rafCallbacks++; fn(t); }
        }
      }
      t = end;
    },
  };
  return env;
}

/** A canvas whose 2D context counts putImageData calls and keeps the last image. */
export function fakeCanvas() {
  const ctx = {
    puts: 0,
    last: null,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(imgData) { this.puts++; this.last = imgData; },
  };
  return {
    width: 0,
    height: 0,
    style: {},
    listeners: {},
    getContext: () => ctx,
    ctx,
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const l = this.listeners[type] || []; const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1); },
    fire(type, e) { for (const fn of [...(this.listeners[type] || [])]) fn(e || {}); },
  };
}

/** A document with visibility, keydown listeners and createElement for canvases. */
export function fakeDoc() {
  const listeners = {};
  const doc = {
    hidden: false,
    visibilityState: 'visible',
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const l = listeners[type] || []; const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1); },
    fire(type, e) { for (const fn of [...(listeners[type] || [])]) fn(e || {}); },
    setHidden(h) { doc.hidden = h; doc.visibilityState = h ? 'hidden' : 'visible'; doc.fire('visibilitychange'); },
    listeners,
    createElement: () => fakeCanvas(),
  };
  return doc;
}

/** A window with matchMedia (reduced motion), no battery by default. */
export function fakeWin({ reduce = false, battery = null } = {}) {
  const mqs = [];
  const win = {
    matchMedia(q) {
      const mq = { media: q, matches: /reduced-motion/.test(q) ? reduce : false, l: [],
        addEventListener(t, fn) { this.l.push(fn); }, removeEventListener(t, fn) { const i = this.l.indexOf(fn); if (i !== -1) this.l.splice(i, 1); } };
      mqs.push(mq);
      return mq;
    },
    setReduce(v) { reduce = v; for (const mq of mqs) if (/reduced-motion/.test(mq.media)) { mq.matches = v; for (const fn of [...mq.l]) fn(); } },
    navigator: battery ? { getBattery: () => Promise.resolve(battery) } : {},
    mqs,
  };
  return win;
}

/** A battery that can be plugged and unplugged. */
export function fakeBattery(charging = true) {
  const l = [];
  return {
    charging,
    addEventListener(t, fn) { if (t === 'chargingchange') l.push(fn); },
    removeEventListener(t, fn) { const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1); },
    set(c) { this.charging = c; for (const fn of [...l]) fn(); },
  };
}
