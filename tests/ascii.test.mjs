// PCD.ascii (src/shared/pcd-ascii.js) against the clock's own engine (vendor/pixelclock): border lines and labels,
//   the big clock (bits equal PC.drawDigit, the colon equals drawTime's, 9:41 hides the leading zero), the shadow, the
//   calendar face, the weather icons, the sun strip and its labels, the derived clock colour (every theme at 3, 7, 12
//   and 19 h) and glyph safety of everything the kit emits. The weather's lines and block are the console's
//   (tests/console.test.mjs).
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadEngine, ROOT } from './engine-load.mjs';
import { isSafeChar, unsafeChars } from '../tools/lib/glyphs.mjs';

const { PC, PCD, R, require } = loadEngine();
const A = require(path.join(ROOT, 'src', 'shared', 'pcd-ascii.js'));
require(path.join(ROOT, 'src', 'shared', 'pcd-weather.js'));
require(path.join(ROOT, 'src', 'shared', 'pcd-greet.js'));

const text = (block) => A.plain(block);
const lit = (face) => face.lit.map((row) => row.map((v) => (v ? 1 : 0)));

test('border lines: exact widths, the corners, labels as " label " with one line char before each corner', () => {
  const title = [A.run('autumn forest', 'text', { bold: true })];
  for (const w of [44, 63, 3, 2, 1, 12, 48]) {
    const line = A.edge('╭', '╮', w, title, 'auto');
    assert.equal(A.width(line), w, `w ${w}`);
    const t = text([line])[0];
    assert.equal(t[0], '╭');
    if (w >= 2) assert.equal(t[w - 1], '╮');
  }
  assert.equal(text([A.edge('╭', '╮', 44, title, 'auto')])[0], '╭─ autumn forest ─────────────────── auto ─╮');
  const runs = A.edge('╭', '╮', 44, title, [A.run('pinned', 'muted')]);
  const t = runs.find((r) => r.text === 'autumn forest');
  assert.deepEqual([t.tone, t.bold], ['text', true], 'a label keeps its own tone');
  assert.equal(runs.find((r) => r.text === 'pinned').tone, 'muted');
  assert.equal(A.edge('╭', '╮', 44, null, 'x').find((r) => r.text === 'x').tone, 'muted', 'a string label is muted');
  assert.ok(runs.filter((r) => /[╭─╮]/.test(r.text)).every((r) => r.tone === 'frame'), 'lines are frame');
  assert.ok(A.edge('─', '─', 44, null, null, { lineTone: 'wood' }).every((r) => r.tone === 'wood'), 'lineTone');
  // the style tile's section rule: '── palette ─── design/tokens.json ──' across the board
  const rule = text([A.edge('─', '─', 60, [A.run('palette', 'text', { bold: true })], [A.run('design/tokens.json', 'faint')])])[0];
  assert.match(rule, /^── palette ─+ design\/tokens\.json ──$/);
  assert.equal(rule.length, 60);
});

test('labels are cut to fit narrow lines, never past the corners', () => {
  const left = [A.run('christmas cabin', 'text', { bold: true })];
  const right = [A.run('surprise', 'muted')];
  for (let w = 4; w <= 30; w++) {
    const t = text([A.edge('╭', '╮', w, left, right)])[0];
    assert.equal(t.length, w);
    assert.ok(t.startsWith('╭─') && t.endsWith('─╮'), JSON.stringify(t));
    assert.ok(/─/.test(t.slice(2, -2)) || w < 6, 'at least one line char between the labels: ' + t);
  }
  assert.equal(text([A.edge('╭', '╮', 20, left, right)])[0], '╭─ chr ─ surprise ─╮');
});

test('digits: the clock\'s own 3x5 bits (PC.drawDigit at scale 1 equals drawDigit at scale 2, downsampled)', () => {
  for (let d = 0; d <= 9; d++) {
    const bits = A.digitBits(d, PC);
    assert.equal(bits.length, 15);
    const cv = new PC.Canvas(6, 10);
    PC.drawDigit(cv, d, 0, 0, 0xffffff, 2);
    const down = [];
    for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) down.push(cv.px[(2 * y) * 6 + 2 * x] ? 1 : 0);
    assert.deepEqual(bits, down, 'digit ' + d);
  }
  // the clock's 3 has a full middle row (other big fonts differ here)
  assert.deepEqual(A.digitBits(3, PC).slice(6, 9), [1, 1, 1]);
});

/** drawTime's own pixels at scale 2 (y = 0), downsampled to clock pixels and cropped to the face's columns. */
function drawTimeBits(h, m, hour12) {
  const cv = new PC.Canvas(64, 10);
  PC.drawTime(cv, h, m, { y: 0, color: 0xffffff, hour12, colon: true });
  const rows = [];
  let x0 = 64;
  let x1 = -1;
  for (let y = 0; y < 5; y++) {
    const row = [];
    for (let x = 0; x < 32; x++) {
      const on = cv.px[(2 * y) * 64 + 2 * x] ? 1 : 0;
      row.push(on);
      if (on) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    }
    rows.push(row);
  }
  return rows.map((r) => r.slice(x0, x1 + 1));
}

test('the big clock: HH:MM equals drawTime (digits and the colon), 9:41 hides the leading zero', () => {
  for (const [h, m] of [[9, 41], [20, 40], [0, 5], [12, 0], [23, 59], [10, 10], [1, 11]]) {
    for (const clock24 of [false, true]) {
      const f = A.clockFace(h, m, { clock24, PC });
      const want = drawTimeBits(h, m, !clock24);
      // drawTime's crop starts at the first lit column: a face starting with an unlit column (none here) would differ
      assert.deepEqual(lit(f).map((r) => r.slice(0, want[0].length)), want, `${h}:${m} ${clock24 ? '24' : '12'} h`);
      assert.equal(f.W, want[0].length);
      assert.equal(f.cols, (f.W + 1) * 2);
      assert.equal(f.rows, 6);
      assert.equal(f.lit[1][f.colon[0].x], 2, 'the colon is accent (2)');
      assert.equal(f.lit[3][f.colon[1].x], 2);
    }
  }
  assert.equal(A.clockFace(9, 41, { PC }).W, 13, '9:41: 4 + colon + 8 pixels');
  assert.equal(A.clockFace(9, 41, { PC, clock24: true }).W, 17, '09:41: 34 cells for four digits');
  assert.equal(A.clockFace(9, 41, { PC }).ampm, 'am');
  assert.equal(A.clockFace(21, 41, { PC }).ampm, 'pm');
  assert.equal(A.clockFace(12, 0, { PC }).ampm, 'pm');
  assert.equal(A.clockFace(0, 0, { PC }).ampm, 'am');
  assert.equal(A.clockFace(0, 0, { PC, clock24: true }).ampm, '');
  assert.deepEqual(A.clockFace(20, 40, { PC }).ampmAt, { c: 29, r: 4 }, 'one cell after the shadow, the digits\' last row');
  const dark = A.clockFace(20, 40, { PC, colon: false });
  assert.equal(dark.lit[1][dark.colon[0].x], 0, 'colon off: dark');
  assert.deepEqual(text(dark.shadow), text(A.clockFace(20, 40, { PC }).shadow), 'the blink never changes the shadow text');
});

test('the shadow: ░░ in wood exactly where the pixel up-left is lit and the pixel itself is not', () => {
  const f = A.clockFace(20, 40, { PC });
  const t = text(f.shadow);
  assert.equal(t.length, 6);
  for (const line of t) assert.equal(line.length, f.cols);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x <= f.W; x++) {
      const on = y < 5 && x < f.W ? f.lit[y][x] : 0;
      const up = y >= 1 && x >= 1 ? f.lit[y - 1][x - 1] : 0;
      assert.equal(t[y].slice(2 * x, 2 * x + 2), !on && up ? '░░' : '  ', `cell ${x},${y}`);
    }
  }
  assert.ok(f.shadow.flat().filter((r) => r.text.includes('░')).every((r) => r.tone === 'wood'));
});

test('the calendar face (the still): the day in the same digits and shadow, the labels two cells after it', () => {
  for (let day = 1; day <= 31; day++) {
    const f = A.dayFace(day, { PC });
    const n = day >= 10 ? 2 : 1;
    assert.equal(f.W, n * 4 - 1);
    assert.equal(f.cols, (f.W + 1) * 2);
    assert.deepEqual(f.labelsAt, { c: f.W * 2 + 4, monthRow: 1, weekdayRow: 4 });
    const bits = A.digitBits(day % 10, PC);
    const x0 = (n - 1) * 4;
    for (let i = 0; i < 15; i++) assert.equal(f.lit[Math.floor(i / 3)][x0 + (i % 3)], bits[i]);
  }
});

test('face rects: one device-px rect per lit pixel, 2 cells x 1 row (compact: 1 cell x half a row)', () => {
  const f = A.clockFace(20, 40, { PC });
  const r = A.faceRects(f, 21, 41);
  const n = f.lit.flat().filter(Boolean).length;
  assert.equal(r.length, n);
  assert.ok(r.every((x) => x.w === 42 && x.h === 41 && x.x % 42 === 0 && x.y % 41 === 0));
  assert.deepEqual(r.filter((x) => x.colon).map((x) => x.tone), ['accent', 'accent']);
  const c = A.faceRects(A.clockFace(20, 40, { PC, compact: true }), 21, 41);
  assert.ok(c.every((x) => x.w === 21 && x.h === 21));
  assert.equal(A.clockFace(20, 40, { PC, compact: true }).rows, 3);
  assert.deepEqual(A.clockFace(20, 40, { PC, compact: true }).shadow, []);
});

test('weather icons: exact rows, 11 x 4, every character in its role\'s tone', () => {
  const EXPECT = {
    'clear-day': ['   \\ | /   ', '  -- O --  ', '   / | \\   ', '           '],
    'clear-night': ['   .--.  · ', '  (    )   ', "   `--'  · ", '           '],
    'partly-day': ['  \\  /     ', ' -- .--.   ', ' .-(    ). ', '(___.__)__)'],
    'partly-night': [' ·  .--.   ', ' .-(    ). ', '(___.__)__)', '        ·  '],
    cloudy: ['    .--.   ', ' .-(    ). ', '(___.__)__)', '           '],
    fog: [' _ - _ - _ ', '  - _ - _ -', ' _ - _ - _ ', '           '],
    drizzle: ['    .--.   ', ' .-(    ). ', '(___.__)__)', "  ' ' ' '  "],
    rain: ['    .--.   ', ' .-(    ). ', '(___.__)__)', '  / / / /  '],
    freezing: ['    .--.   ', ' .-(    ). ', '(___.__)__)', '  * / * /  '],
    snow: ['    .--.   ', ' .-(    ). ', '(___.__)__)', '  *  *  *  '],
    thunder: ['    .--.   ', ' .-(    ). ', '(___.__)__)', '   _/  _/  '],
    unknown: ['           ', '   .---.   ', '   | ? |   ', "   '---'   "],
  };
  assert.deepEqual(Object.keys(A.ICONS).sort(), Object.keys(EXPECT).sort());
  const allowed = { c: 'muted', s: 'ring', m: 'text', p: 'text', d: 'faint', f: 'muted', b: 'ring', q: 'muted' };
  for (const [key, rows] of Object.entries(EXPECT)) {
    assert.deepEqual(text(A.icon(key)), rows, key);
    for (let r = 0; r < 4; r++) {
      assert.equal(A.ICON_KEYS[key][r].length, 11);
      for (let i = 0; i < 11; i++) {
        if (rows[r][i] !== ' ') assert.notEqual(A.ICON_KEYS[key][r][i], ' ', `${key} ${r}:${i} has a role`);
      }
    }
    for (const line of A.icon(key)) for (const run of line) if (run.text.trim()) assert.ok(Object.values(allowed).includes(run.tone));
  }
  assert.equal(A.icon('clear-day')[1].find((r) => r.text.includes('O')).tone, 'ring', 'the sun is ring');
  assert.equal(A.icon('thunder')[3].find((r) => r.text.includes('_/')).tone, 'ring', 'the bolt is ring');
  assert.equal(A.icon('clear-night')[0].find((r) => r.text === '·').tone, 'faint', 'stars are faint');
  // every kind PCD.weather knows maps to an icon; day and night variants
  for (const kind of PCD.weather.KINDS) assert.ok(A.ICONS[A.iconKey(kind, true)], kind);
  assert.equal(A.iconKey('clear', true), 'clear-day');
  assert.equal(A.iconKey('clear', false), 'clear-night');
  assert.equal(A.iconKey('partly', false), 'partly-night');
  assert.equal(A.iconKey('nonsense', true), 'unknown');
});

test('the sun strip: n bars sampled at their centres, one "now" bar, eighth steps drawn as touching rects', () => {
  const curve = Array.from({ length: 48 }, (_, i) => Math.round(Math.max(0, Math.min(1, Math.min((i / 2 - 5.5) / 3, (18.5 - i / 2) / 3))) * 100) / 100);
  for (const n of [28, 39, 43, 47, 53]) {
    for (const h of [0, 0.01, 7.3, 12, 20.67, 23.99]) {
      const bars = A.strip(curve, n, h);
      assert.equal(bars.length, n);
      assert.equal(bars.filter((b) => b.now).length, 1);
      assert.equal(bars.findIndex((b) => b.now), Math.min(n - 1, Math.floor(h / 24 * n)));
      bars.forEach((b, i) => {
        const j = Math.min(47, Math.floor((i + 0.5) / n * 24 * 2));
        assert.equal(b.v, curve[j]);
        assert.equal(b.level, Math.round(curve[j] * 7));
      });
    }
  }
  const rects = A.stripRects(A.strip(curve, 47, 20.67), 21, 41);
  const bottom = Math.round(41 * 0.8);
  const maxH = Math.round(41 * 0.66);
  rects.forEach((r, i) => {
    assert.equal(r.x, i * 21, 'bars touch');
    assert.equal(r.w, 21);
    assert.equal(r.y + r.h, bottom, 'bottom at 0.8 of the cell');
    assert.ok(r.h >= 1 && r.h <= maxH);
  });
  const now = rects.find((r) => r.now);
  assert.deepEqual([now.h, now.color], [maxH, A.TOKENS.accent], 'now: full height, accent');
  const dark = rects.find((r) => !r.now && r.h === Math.max(1, Math.round(maxH / 8)));
  assert.equal(dark.color, A.TOKENS.line, 'the darkest bar keeps a 1/8 baseline in line');
  assert.equal(A.barColor(1), A.TOKENS.wood);
  assert.equal(A.barColor(0.5), A.mix(A.TOKENS.line, A.TOKENS.wood, 0.7));
  // the labels: 12 h without am/pm, 24 h with a leading zero; blank without real sun times
  assert.deepEqual(A.stripLabels({ rise: 7.45, set: 16.25 }, false), { rise: '7:27', set: '4:15' });
  assert.deepEqual(A.stripLabels({ rise: 7.45, set: 16.25 }, true), { rise: '07:27', set: '16:15' });
  assert.deepEqual(A.stripLabels(null, false), { rise: '', set: '' });
  // the row: the rise time from the first cell, the set time up to the last, in 12 h as in 24 h (flush with the column)
  const line = A.stripLine(47, { rise: '7:27', set: '4:15' });
  assert.equal(A.width(line), 47 + 14);
  assert.equal(text([line])[0], '7:27' + ' '.repeat(1 + 2 + 47 + 2 + 1) + '4:15');
  const line24 = A.stripLine(47, { rise: '07:27', set: '16:15' });
  assert.equal(A.width(line24), 47 + 14);
  assert.equal(text([line24])[0], '07:27' + ' '.repeat(2 + 47 + 2) + '16:15');
  const mixed = text([A.stripLine(30, { rise: '7:27', set: '16:15' })])[0];
  assert.ok(mixed.startsWith('7:27 ') && mixed.endsWith(' 16:15') && mixed.length === 44, mixed);
  assert.equal(text([A.stripLine(28, { rise: '', set: '' })])[0], ' '.repeat(42), 'no labels: the bars keep their place');
  assert.equal(text([A.stripLine(28, {})])[0], ' '.repeat(42));
  assert.ok(line.filter((r) => r.text.trim()).every((r) => r.tone === 'faint'));
});

test('the derived clock colour for all 13 themes at 3, 7, 12 and 19 h', () => {
  const hook = PCD.hook;
  const saved = hook.mode;
  hook.mode = 'none';
  let minClock = 99;
  try {
    for (const theme of PC.themes) {
      for (const hour of [3, 7, 12, 19]) {
        const inst = theme.create(new PC.Rng(12345));
        const ctx = { ...R.ctxAt({ hour, year: 2026, month: 11, day: 15 }), showDate: true };
        for (let i = 0; i < 30; i++) inst.update(1 / 30, ctx);
        inst.draw(new PC.Canvas(), ctx);
        const clock = A.clockColor(hook.colors.clock);
        minClock = Math.min(minClock, A.contrast(clock, A.TOKENS.bg));
        assert.equal(clock, A.mix(hook.colors.clock, A.TOKENS.text, 0.25), `${theme.id} ${hour} h needs no fallback`);
      }
    }
  } finally {
    hook.mode = saved;
  }
  assert.ok(minClock >= 9.3 - 0.05, 'the clock colour: at least 9.3:1 on bg (haunted hill), got ' + minClock.toFixed(2));
  assert.equal(A.clockColor(0x101010), A.TOKENS.text, 'under 4.5:1: text');
  // the weather's lines and block are PCD.console's
  for (const k of ['weatherLines', 'weatherBlock']) assert.equal(A[k], undefined, k);
  PCD.TOKENS = { text: '#ffffff' };
  try {
    assert.equal(A.token('text'), 0xffffff, 'the generated tokens win when loaded');
    assert.equal(A.token('frame'), A.TOKENS.frame);
  } finally {
    delete PCD.TOKENS;
  }
});

test('glyph safety: every character the kit emits is in the safe set', () => {
  const blocks = [
    [A.edge('╭', '╮', 40, 'christmas cabin', 'surprise'), A.edge('├', '┤', 40, 'berlin', 'open-meteo.com'), A.edge('╰', '╯', 40, null, 'sunset')],
    A.clockFace(23, 59, { PC }).shadow, A.dayFace(28, { PC }).shadow,
    [A.stripLine(40, { rise: '7:27', set: '4:15' })],
  ];
  for (const k of Object.keys(A.ICONS)) blocks.push(A.icon(k));
  const status = { show: true, kind: 'next', parts: ['pixelclock', 'next alarm tomorrow 7:00 am', 'work'], time: '7:00 am' };
  blocks.push([A.statusLine(status, 44)], [A.greetLine(PCD.greet.parts(new Date(2026, 9, 31, 21, 10), PC), 44)]);
  for (const b of blocks) assert.deepEqual(unsafeChars(text(b).join('\n')), []);
  for (const ch of A.CHARS) assert.ok(isSafeChar(ch), ch);
  for (const ch of Object.values(A.GLYPHS)) assert.ok(isSafeChar(ch), ch);
});

test('fill(): text nodes and spans with the tone classes, links for href, textContent only', () => {
  const made = [];
  const doc = {
    createTextNode: (t) => ({ nodeType: 3, text: t }),
    createElement: (tag) => { const e = { tag, className: '', attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v; } }; made.push(e); return e; },
  };
  const el = { children: [], firstChild: null, appendChild(c) { this.children.push(c); }, removeChild() {} };
  A.fill(el, [[A.run('a', 'frame'), A.run(' b '), A.run('c', 'text', { bold: true })], [A.run('x', 'faint', { href: 'https://open-meteo.com/' })]], { doc });
  assert.deepEqual(el.children.map((c) => (c.nodeType === 3 ? 'T:' + c.text : c.tag + '.' + c.className + ':' + c.textContent)),
    ['span.fr:a', 'T: b ', 'span.tx tt:c', 'T:\n', 'a.fa:x']);
  assert.equal(made.find((e) => e.tag === 'a').attrs.href, 'https://open-meteo.com/');
});
