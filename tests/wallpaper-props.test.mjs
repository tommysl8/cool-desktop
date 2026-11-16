// node --test "tests/wallpaper-props.test.mjs"
// The Lively Customise panel (src/wallpaper/js/wp-props.js, PCD.wpProps) over the one settings schema
// (src/newtab/js/ntp-settings.js) seen through P.schemaFor (the wallpaper-only "side" added):
// LivelyProperties.json validity by Lively's rules (8 control types, required and allowed keys, lower-case
// keys without dots, value kinds, strict JSON), the property table, defaults from the config, the theme
// dropdown in PCD.engine.menu order (the real synced engine), the mapper from livelyPropertyListener(name,
// value) to settings for every value type Lively sends, replayed saved values in any order, and the router
// (1.5 s textbox debounce, settle window, buttons).
// Privacy: configs here are neutral (Berlin, Portland); config/user.json is never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
const at = (...p) => path.join(ROOT, ...p);

// The engine the way Node loads it: vendor engine.js, the hook, then render.js (schedule and themes),
// then the adapter.
const ENGINE = ['vendor/pixelclock/simulator/engine.js', 'src/shared/pcd-hook.js', 'vendor/pixelclock/tools/render.js', 'src/shared/pcd-engine.js'];
for (const f of ENGINE) require(at(...f.split('/')));
const S = require(at('src', 'newtab', 'js', 'ntp-settings.js'));
const P = require(at('src', 'wallpaper', 'js', 'wp-props.js'));
const PCD = globalThis.PCD;
const MENU = PCD.engine.menu(globalThis.PixelClock);
const OPTS = { menu: MENU };
const idx = (id) => MENU.findIndex((t) => t.id === id);
/** The wallpaper's schema: the shared one plus "side". */
const W = P.schemaFor(S);

const BERLIN = Object.freeze({
  city: 'Berlin', units: 'C', clock: '24h', sunTimes: false, weather: true,
  shortcuts: [{ label: 'wiki', url: 'https://www.wikipedia.org' }], taskbarPx: 56,
});
const PORTLAND = Object.freeze({
  city: 'Portland, OR', units: 'F', clock: '12h', sunTimes: true, weather: true, shortcuts: [], taskbarPx: 56,
});

/** Fake named timers (like the app's), fired by advance(). */
function fakeTimers() {
  let t = 0;
  const timers = new Map();
  return {
    setTimer(name, fn, ms) { timers.set(name, { at: t + ms, fn }); return true; },
    clearTimer(name) { timers.delete(name); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        t = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      t = end;
    },
    active: () => [...timers.keys()],
  };
}

/** A small seeded PRNG for repeatable shuffles. */
function shuffle(list, seed) {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('LivelyProperties.json is loadable by Lively: known types, required and allowed keys, key names, values, strict JSON', () => {
  for (const cfg of [BERLIN, PORTLAND, {}]) {
    const props = P.buildProperties(cfg, OPTS);
    assert.deepEqual(P.checkProperties(props), [], JSON.stringify(cfg));
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(props))), JSON.stringify(props), 'strict JSON round trip');
    for (const [k, c] of Object.entries(props)) {
      assert.match(k, /^[a-z][A-Za-z0-9]*$/, `${k}: lower-case first, no dots`);
      assert.ok(['label', 'dropdown', 'button', 'checkbox', 'textbox'].includes(c.type), `${k}: one of the five types the panel uses`);
      if (c.type === 'label') assert.deepEqual(Object.keys(c), ['type', 'value'], `${k}: a label has no text`);
      if (c.type === 'button') assert.equal(typeof c.value, 'string', `${k}: a button shows its value as the caption`);
    }
    const text = JSON.stringify(props, null, 2);
    assert.ok([...text].every((c) => c.charCodeAt(0) < 127), 'plain ASCII (the theme names are ASCII)');
  }
});

test('the property table: every property with its type, text and default', () => {
  const props = P.buildProperties(BERLIN, OPTS);
  assert.deepEqual(Object.keys(props), P.CONTROLS.map((c) => c.k));
  assert.deepEqual(props.side, { type: 'dropdown', text: 'Column side', items: ['Right', 'Left'], value: 0 }, 'right by default');
  assert.equal(props.theme.type, 'dropdown');
  assert.equal(props.theme.value, 0, 'Auto (by date)');
  assert.deepEqual(props.surprise, { type: 'button', text: 'Surprise me', value: 'Surprise' });
  assert.deepEqual(props.shakeNow, { type: 'button', text: 'Shake', value: 'Shake' });
  assert.deepEqual(props.shakeHourly, { type: 'checkbox', text: 'Surprise on the hour (10 am to midnight)', value: true });
  assert.deepEqual(props.clock24, { type: 'checkbox', text: '24-hour clock', value: true });
  assert.deepEqual(props.city, { type: 'textbox', text: 'City', value: 'Berlin' });
  assert.deepEqual(props.units, { type: 'dropdown', text: 'Units', items: ['Fahrenheit', 'Celsius'], value: 1 });
  assert.equal(props.sunTimes.value, false, 'from the config');
  assert.equal(props.weather.value, true);
  assert.equal(props.weatherFx.value, true);
  assert.deepEqual(props.refreshWeather, { type: 'button', text: 'Refresh weather', value: 'Refresh' });
  assert.deepEqual(props.reducedMotion, { type: 'checkbox', text: 'Reduced motion', value: false });
  assert.deepEqual(props.performance, { type: 'checkbox', text: 'Performance mode (15 fps)', value: false });
  assert.deepEqual(props.lowPowerOnBattery, { type: 'checkbox', text: 'Performance mode on battery', value: true });
  assert.deepEqual(props.taskbarSpace, { type: 'checkbox', text: 'Keep clear of the taskbar', value: true });
  assert.deepEqual(props.debugOverlay, { type: 'checkbox', text: 'Debug overlay', value: false });
  const us = P.buildProperties(PORTLAND, OPTS);
  assert.equal(us.clock24.value, false);
  assert.equal(us.units.value, 0);
  assert.equal(us.side.value, 0);
  assert.deepEqual(Object.keys(props).slice(Object.keys(props).indexOf('deskLabel')), ['deskLabel', 'side', 'taskbarSpace', 'debugOverlay'], 'the side heads the Desktop group');
  assert.equal(P.buildProperties({}, OPTS).city.value, '', 'no config city: an empty box');
  // labels head every group; the documented texts
  assert.deepEqual(Object.entries(props).filter(([, c]) => c.type === 'label').map(([k]) => k), ['sceneLabel', 'timeLabel', 'motionLabel', 'deskLabel']);
  for (const [k, text] of Object.entries(P.TEXTS)) assert.equal(props[k].text, text);
  assert.deepEqual(P.BUTTONS, ['surprise', 'shakeNow', 'refreshWeather']);
});

test('the theme dropdown lists PCD.engine.menu in order: Auto (by date), the seasons, the holidays', () => {
  const props = P.buildProperties(BERLIN);
  assert.deepEqual(props.theme.items, PCD.engine.menu(globalThis.PixelClock).map((t) => t.name), 'the menu comes from PCD.engine by default');
  assert.equal(props.theme.items[0], 'Auto (by date)');
  assert.deepEqual(MENU.slice(1, 5).map((t) => t.id), ['winter', 'spring', 'summer', 'autumn']);
  assert.equal(MENU.length, 1 + globalThis.PixelClock.themes.length, 'every theme of the synced engine');
  assert.deepEqual(P.themeMenu(), MENU.map((t) => ({ id: t.id, name: t.name })));
  assert.throws(() => P.buildProperties(BERLIN, { menu: [] }), /no theme menu/);
});

test('every wallpaper setting has a control; every state control drives a wallpaper setting', () => {
  const driven = new Set(P.CONTROLS.filter((c) => c.setting).map((c) => c.setting));
  assert.deepEqual([...driven].sort(), [...P.settingKeys(OPTS)].sort());
  for (const c of P.CONTROLS) if (c.setting) assert.ok(P.settingKeys(OPTS).includes(c.setting), c.k);
  assert.deepEqual(P.STATE_CONTROLS, P.CONTROLS.filter((c) => c.type !== 'label' && c.type !== 'button').map((c) => c.k));
  // the shared wallpaper scope plus the wallpaper's own side
  assert.deepEqual(P.settingKeys(OPTS), [...S.keys('wallpaper'), ...(S.spec('side') ? [] : ['side'])]);
  assert.ok(P.settingKeys(OPTS).includes('side'));
});

test('defaults: what Lively replays from a fresh LivelyProperties.json equals the page defaults from the same config', () => {
  const configs = [BERLIN, PORTLAND, {}, { ...PORTLAND, nope: 1 },
    { ...BERLIN, theme: 'halloween', reducedMotion: 'on', performance: 'on' },
    { ...BERLIN, reducedMotion: 'off', performance: 'off', shakeHourly: false, taskbarSpace: false, weatherFx: false, debugOverlay: true }];
  for (const cfg of configs) {
    const props = P.buildProperties(cfg, OPTS);
    const want = P.defaults(cfg, OPTS);
    assert.deepEqual(want, W.defaults(cfg, { scope: 'wallpaper', themes: MENU }), 'the schema defaults, scope wallpaper');
    assert.deepEqual(want, { ...S.defaults(cfg, { scope: 'wallpaper', themes: MENU }), side: 'right' }, 'the shared defaults plus side right');
    assert.deepEqual(P.stateFromProperties(props, { ...OPTS, config: cfg }), want, JSON.stringify(cfg));
    assert.deepEqual(P.checkPropertiesContent(props, { ...OPTS, config: cfg }), []);
  }
  // a config field no setting reads changes neither the panel nor the page defaults
  assert.deepEqual(P.buildProperties({ ...PORTLAND, nope: 1 }, OPTS), P.buildProperties(PORTLAND, OPTS));
  assert.deepEqual(P.defaults({ ...PORTLAND, nope: 1 }, OPTS), P.defaults(PORTLAND, OPTS));
  // an old saved copy that lacks newer keys: those keep their defaults
  const props = P.buildProperties(BERLIN, OPTS);
  const old = { ...props };
  delete old.shakeHourly;
  delete old.weatherFx;
  delete old.taskbarSpace;
  const s = P.stateFromProperties(old, { ...OPTS, config: PORTLAND });
  const d = P.defaults(PORTLAND, OPTS);
  assert.equal(s.shakeHourly, d.shakeHourly);
  assert.equal(s.weatherFx, d.weatherFx);
  assert.equal(s.taskbarSpace, d.taskbarSpace);
  assert.equal(s.city, 'Berlin', 'the saved values that are there apply');
  // a saved copy with a property no control has: its value is ignored
  const extra = { ...props, nope: { type: 'checkbox', text: 'Nope', value: true } };
  assert.deepEqual(P.stateFromProperties(extra, { ...OPTS, config: BERLIN }), P.stateFromProperties(props, { ...OPTS, config: BERLIN }));
});

test('the checks reject Lively mistakes and drift from the generated file', () => {
  const props = P.buildProperties(BERLIN, OPTS);
  const bad = (mutate) => {
    const p = JSON.parse(JSON.stringify(props));
    mutate(p);
    return P.checkProperties(p).join('\n');
  };
  assert.match(bad((p) => { p.weather.type = 'toggle'; }), /unknown type "toggle".*NO properties/);
  assert.match(bad((p) => { delete p.weather.text; }), /needs "text"/);
  assert.match(bad((p) => { p['weather.fx'] = { type: 'checkbox', text: 'x', value: true }; }), /lower-case letter.*no dots/);
  assert.match(bad((p) => { p.Weather2 = { type: 'checkbox', text: 'x', value: true }; }), /lower-case letter/);
  assert.match(bad((p) => { p.weather.color = '#ffffff'; }), /"color" is not allowed on a checkbox/);
  assert.match(bad((p) => { p.sceneLabel.text = 'Scene'; }), /"text" is not allowed on a label/);
  // Lively's slider rules apply to a hand-edited copy (the panel itself has no slider)
  const slider = { type: 'slider', text: 'Size', min: 0, max: 600, step: 10, value: 300 };
  assert.deepEqual(P.checkProperties({ ...props, size: slider }), []);
  assert.match(bad((p) => { p.size = { ...slider, value: 601 }; }), /outside 0-600/);
  assert.match(bad((p) => { p.size = { ...slider }; delete p.size.step; }), /needs "step"/);
  assert.match(bad((p) => { p.size = { ...slider, min: 700 }; }), /min must be below max/);
  assert.match(bad((p) => { p.side.value = 2; }), /item index 0-1/);
  assert.match(bad((p) => { p.side.items = []; }), /non-empty list/);
  assert.match(bad((p) => { p.weather.value = 'true'; }), /true or false/);
  assert.match(bad((p) => { p.city.value = 5; }), /must be a string/);
  assert.match(bad((p) => { p.city.text = '  '; }), /non-empty string/);
  assert.match(bad((p) => { p.refreshWeather.value = true; }), /must be a string/);
  assert.match(P.checkProperties({}).join(), /non-empty object/);
  assert.match(P.checkProperties([]).join(), /non-empty object/);
  const content = (mutate) => {
    const p = JSON.parse(JSON.stringify(props));
    mutate(p);
    return P.checkPropertiesContent(p, { ...OPTS, config: BERLIN }).join('\n');
  };
  assert.match(content((p) => { p.clock24.text = '24h clock'; }), /clock24: /);
  assert.match(content((p) => { delete p.debugOverlay; }), /debugOverlay: missing/);
  assert.match(content((p) => { p.extra = { type: 'label', value: 'x' }; }), /extra: not a control/);
  assert.match(content((p) => { p.theme.items = p.theme.items.slice().reverse(); }), /theme: /);
  assert.match(content((p) => {
    const { side, ...rest } = p;
    for (const k of Object.keys(p)) delete p[k];
    Object.assign(p, rest, { side });
  }), /Customise order/);
});

test('coerce: every value type Lively sends, plus forgiving variants (Livelycu setprop, hand-edited copies)', () => {
  const ok = (k, v) => {
    const r = P.coerce(k, v, OPTS);
    assert.ok(r.ok, `${k}=${JSON.stringify(v)}: ${r.reason}`);
    return r.value;
  };
  const no = (k, v) => {
    const r = P.coerce(k, v, OPTS);
    assert.equal(r.ok, false, `${k}=${JSON.stringify(v)} must be refused`);
    return r.reason;
  };
  // dropdowns: the index (number or numeric string), or a value or label by name
  assert.equal(ok('side', 1), 1);
  assert.equal(ok('side', '0'), 0);
  assert.equal(ok('side', 'Left'), 1);
  assert.equal(ok('side', 'right'), 0);
  no('side', 2);
  no('side', -1);
  no('side', 1.5);
  no('side', NaN);
  no('side', 'middle');
  no('side', true);
  assert.equal(ok('units', 'Celsius'), 1);
  assert.equal(ok('units', 'f'), 0);
  assert.equal(ok('theme', 0), 0);
  assert.equal(ok('theme', MENU.length - 1), MENU.length - 1);
  no('theme', MENU.length);
  assert.equal(ok('theme', 'Haunted hill'), idx('halloween'));
  assert.equal(ok('theme', 'halloween'), idx('halloween'));
  // checkboxes: booleans, also 0 or 1 and the strings 'true', 'false', '1' and '0'; anything else is refused
  assert.equal(ok('weather', false), false);
  assert.equal(ok('weather', 'true'), true);
  assert.equal(ok('weather', 0), false);
  assert.equal(ok('weather', '1'), true);
  no('weather', 'yes');
  no('weather', null);
  // textbox: a string on every keystroke; one clean line; cut to 80 characters
  assert.equal(ok('city', '  Berlin,   Germany  '), 'Berlin, Germany');
  assert.equal(ok('city', 'a\tb\nc'), 'a b c');
  assert.equal(ok('city', 'x'.repeat(85)), 'x'.repeat(80));
  assert.equal(ok('city', ''), '');
  assert.equal(ok('city', 12345), '12345');
  no('city', null);
  no('city', { name: 'Berlin' });
  // buttons arrive as true (or their own caption)
  assert.equal(ok('refreshWeather', true), true);
  assert.equal(ok('refreshWeather', 'Refresh'), true);
  assert.equal(P.coerce('surprise', true, OPTS).kind, 'action');
  no('refreshWeather', false);
  no('shakeNow', 'Surprise');
  // labels never carry a value; unknown names are refused, Object.prototype members too
  assert.match(no('sceneLabel', '-- Scene --'), /labels/);
  for (const k of ['nope', 'toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf', undefined, null, 42]) {
    assert.equal(no(k, 0), 'unknown property', String(k));
  }
});

test('mapper: each control drives its setting; Reduced motion and the two performance checkboxes', () => {
  const m = P.createMapper({ ...OPTS, config: BERLIN });
  const set = (name, raw) => {
    const r = m.property(name, raw);
    assert.ok(r.ok, `${name}: ${r.reason}`);
    return [r.key, r.setting];
  };
  assert.deepEqual(set('units', 0), ['units', 'F']);
  assert.deepEqual(set('side', 1), ['side', 'left']);
  assert.deepEqual(set('side', 'Right'), ['side', 'right']);
  assert.deepEqual(set('theme', 0), ['theme', 'auto']);
  assert.deepEqual(set('theme', idx('autumn')), ['theme', 'autumn']);
  assert.deepEqual(set('clock24', false), ['clock24', false]);
  assert.deepEqual(set('city', ' Oslo '), ['city', 'Oslo']);
  assert.deepEqual(set('taskbarSpace', false), ['taskbarSpace', false]);
  assert.deepEqual(set('shakeHourly', false), ['shakeHourly', false]);
  assert.deepEqual(set('debugOverlay', true), ['debugOverlay', true]);
  // performance: "Performance mode" wins; else "on battery" decides auto or off
  assert.deepEqual(set('performance', true), ['performance', 'on']);
  assert.deepEqual(set('lowPowerOnBattery', false), ['performance', 'on'], 'forced on stays on');
  assert.deepEqual(set('performance', false), ['performance', 'off']);
  assert.deepEqual(set('lowPowerOnBattery', true), ['performance', 'auto']);
  // reduced motion: checked = on; unchecked = the system decides
  assert.deepEqual(set('reducedMotion', true), ['reducedMotion', 'on']);
  assert.deepEqual(set('reducedMotion', false), ['reducedMotion', 'auto']);
  const off = P.createMapper({ ...OPTS, config: { reducedMotion: 'off' } });
  assert.equal(off.property('reducedMotion', false).setting, 'off', 'unless the config says off');
  // buttons are actions and change nothing
  const before = m.state();
  assert.equal(m.property('surprise', true).kind, 'action');
  assert.deepEqual(m.state(), before);
  // refused values change nothing
  assert.equal(m.property('side', 7).ok, false);
  assert.equal(m.property('nope', 1).ok, false, 'a name no control has');
  assert.deepEqual(m.state(), before);
  assert.deepEqual(Object.keys(m.state()).sort(), [...P.settingKeys(OPTS)].sort());
  // the panel values after all that
  assert.equal(m.controls().performance, false);
  assert.equal(m.controls().lowPowerOnBattery, true);
});

test('replay: Lively\'s saved values in any order give the same state', () => {
  // you changed things in Customise; Lively replays them after load in whatever order
  const saved = P.buildProperties({ ...PORTLAND, performance: 'off', theme: 'halloween' }, OPTS);
  saved.reducedMotion.value = true;
  saved.city.value = 'Oslo';
  saved.weatherFx.value = false;
  saved.side.value = 1;
  const entries = P.STATE_CONTROLS.map((k) => [k, saved[k].value]);
  const want = (() => {
    const m = P.createMapper({ ...OPTS, config: BERLIN });
    for (const [k, v] of entries) m.property(k, v);
    return m.state();
  })();
  assert.equal(want.performance, 'off');
  assert.equal(want.reducedMotion, 'on');
  assert.equal(want.side, 'left');
  assert.equal(want.theme, 'halloween');
  for (let seed = 1; seed <= 40; seed++) {
    const m = P.createMapper({ ...OPTS, config: BERLIN });
    for (const [k, v] of shuffle(entries, seed)) m.property(k, v);
    assert.deepEqual(m.state(), want, `order ${seed}`);
  }
  // the same through the router during the settle window (textboxes apply at once)
  const state = P.defaults(BERLIN, OPTS);
  const r = P.createRouter({ ...OPTS, config: BERLIN, apply: (k, v) => { state[k] = v; }, setTimer: () => assert.fail('no timer during the replay'), clearTimer: () => {}, immediate: () => true });
  for (const [k, v] of shuffle(entries, 99)) r.property(k, v);
  assert.deepEqual(state, want);
});

test('router: textboxes apply once, 1.5 s after the last keystroke, with the last value', () => {
  const ft = fakeTimers();
  const applied = [];
  const r = P.createRouter({ ...OPTS, config: BERLIN, apply: (k, v, name) => applied.push([k, v, name]), action: () => {}, setTimer: ft.setTimer, clearTimer: ft.clearTimer });
  assert.equal(P.DEBOUNCE_MS, 1500);
  for (const s of ['O', 'Os', 'Osl', 'Oslo']) {
    assert.equal(r.property('city', s).pending, true);
    ft.advance(200);
  }
  assert.deepEqual(applied, [], 'nothing while typing');
  ft.advance(1299);
  assert.deepEqual(applied, []);
  ft.advance(1);
  assert.deepEqual(applied, [['city', 'Oslo', 'city']]);
  assert.deepEqual(ft.active(), []);
  // everything else applies at once, as settings
  r.property('units', 0);
  r.property('lowPowerOnBattery', false);
  r.property('side', 'Left');
  assert.deepEqual(applied.slice(1), [['units', 'F', 'units'], ['performance', 'off', 'lowPowerOnBattery'], ['side', 'left', 'side']]);
  r.property('side', 9);
  r.property('nope', 1);
  r.property('toString', 1);
  assert.equal(r.counts.ignored, 3);
  assert.equal(applied.length, 4);
  assert.equal(r.mapper.state().city, 'Oslo');
});

test('router: the settle window after load applies replayed textboxes at once; an immediate value drops a waiting one', () => {
  const ft = fakeTimers();
  const applied = [];
  let settling = true;
  const r = P.createRouter({ ...OPTS, config: BERLIN, apply: (k, v) => applied.push([k, v]), setTimer: ft.setTimer, clearTimer: ft.clearTimer, immediate: () => settling });
  assert.ok(P.SETTLE_MS >= 2000);
  const res = r.property('city', 'Oslo');
  assert.equal(res.pending, undefined);
  assert.deepEqual(applied, [['city', 'Oslo']], 'a replayed City applies at once, not after the 1.5 s debounce');
  assert.deepEqual(ft.active(), []);
  settling = false;
  r.property('city', 'Rome');
  assert.equal(applied.length, 1);
  assert.deepEqual(ft.active(), ['deb:city']);
  settling = true;
  r.property('city', 'Paris');
  assert.deepEqual(applied[applied.length - 1], ['city', 'Paris']);
  assert.deepEqual(ft.active(), [], 'the waiting value is dropped');
  ft.advance(5000);
  assert.deepEqual(applied.map((a) => a[1]), ['Oslo', 'Paris'], 'Rome never applies after Paris');
});

test('router: buttons arrive as true and run their action; suspend keeps typed text, resume re-arms, flush applies', () => {
  const ft = fakeTimers();
  const actions = [];
  const applied = [];
  const r = P.createRouter({ ...OPTS, config: BERLIN, apply: (k, v) => applied.push([k, v]), action: (k) => actions.push(k), setTimer: ft.setTimer, clearTimer: ft.clearTimer });
  r.property('surprise', true);
  r.property('shakeNow', true);
  r.property('refreshWeather', 'Refresh');
  r.property('refreshWeather', false);
  r.property('timeLabel', '-- Time and weather --');
  assert.deepEqual(actions, ['surprise', 'shakeNow', 'refreshWeather']);
  assert.equal(r.counts.actions, 3);
  assert.equal(r.counts.ignored, 2);
  assert.deepEqual(applied, [], 'a button is never a setting');
  r.property('city', 'Os');
  r.property('city', 'Oslo');
  r.suspend(); // Lively paused the wallpaper: no timers at all
  assert.deepEqual(ft.active(), []);
  r.property('city', 'Oslo, NO');
  assert.deepEqual(ft.active(), [], 'keystrokes while suspended arm nothing');
  ft.advance(5000);
  assert.deepEqual(applied, []);
  assert.deepEqual(r.pending(), { city: 'Oslo, NO' });
  r.resume();
  assert.deepEqual(ft.active(), ['deb:city']);
  ft.advance(1500);
  assert.deepEqual(applied, [['city', 'Oslo, NO']]);
  r.property('city', 'Rome');
  r.flush();
  assert.deepEqual(applied[applied.length - 1], ['city', 'Rome']);
  assert.deepEqual(ft.active(), []);
  assert.equal(r.counts.received, 9);
});

test('schemaFor: the shared schema plus the wallpaper-only side; a shared side would win', () => {
  assert.equal(P.schemaFor(W), W, 'idempotent');
  assert.equal(W.base, S);
  assert.deepEqual(P.SIDES, ['right', 'left']);
  // side: an enum of its own, 'right' unless saved otherwise (no config field feeds it)
  assert.deepEqual(W.spec('side').values, ['right', 'left']);
  assert.deepEqual(W.validate('side', ' Left '), { ok: true, value: 'left' });
  assert.equal(W.validate('side', 'up').ok, false);
  assert.equal(W.validate('side', 1).ok, false);
  assert.equal(W.defaults(BERLIN, { scope: 'wallpaper' }).side, 'right');
  assert.equal(W.normalize({ side: 'left' }, { scope: 'wallpaper' }).side, 'left');
  assert.equal(W.normalize({ side: 'middle' }, { scope: 'wallpaper' }).side, 'right', 'a bad value falls back to the default');
  // a key neither schema has: no spec, refused, dropped; the rest is the shared schema's
  assert.equal(W.spec('nope'), null);
  assert.equal(W.validate('nope', 1).ok, false);
  assert.ok(!('nope' in W.defaults({ ...BERLIN, nope: 1 }, { scope: 'wallpaper' })));
  assert.ok(!('nope' in W.normalize({ nope: 1 }, { scope: 'wallpaper' })));
  assert.ok(W.KEYS.some((d) => d.key === 'side'));
  assert.deepEqual(W.KEYS.map((d) => d.key), [...S.KEYS.map((d) => d.key), 'side']);
  assert.deepEqual(W.validate('units', 'celsius'), S.validate('units', 'celsius'));
  assert.equal(W.clone, S.clone);
  assert.equal(W.equal, S.equal);
  // the new tab's scope is untouched by the wallpaper's view
  assert.deepEqual(W.keys('newtab'), S.keys('newtab'));
  // a shared schema that defines side itself wins over the local one
  const sharedSide = { ...S, spec: (k) => (k === 'side' ? { key: 'side', kind: 'enum', values: ['left', 'right'], fallback: 'left', config: [], scopes: ['wallpaper'] } : S.spec(k)) };
  assert.equal(P.schemaFor(sharedSide).spec('side').fallback, 'left');
});

test('wp-props.js needs the schema: a clear error without it; opts.schema works without globals', () => {
  const saved = PCD.settings;
  try {
    delete PCD.settings;
    assert.throws(() => P.defaults({}, OPTS), /ntp-settings\.js/);
    assert.deepEqual(P.defaults(BERLIN, { ...OPTS, schema: saved }), P.schemaFor(saved).defaults(BERLIN, { scope: 'wallpaper', themes: MENU }));
  } finally {
    PCD.settings = saved;
  }
  // the menu needs 'auto' first; a menu without it gets it
  assert.deepEqual(P.themeMenu({ menu: [{ id: 'winter', name: 'Snowy hills' }] }).map((t) => t.id), ['auto', 'winter']);
  assert.deepEqual(P.themeMenu({ menu: [{ id: 'winter' }, { id: 'auto', name: 'Auto' }, { id: 'winter' }, 'junk'] }).map((t) => t.id), ['auto', 'winter']);
});
