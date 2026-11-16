// PCD.console's pure half (src/shared/pcd-console.js): the type ladder (portrait windows too), the column, the mirrored
// sides, the taskbar, the reserved status row, the drop order, every part's text, the links' rows and gaps, the weather
// credit, the strip, the still's calendar page, the column's helpers in PCD.ascii (statusLine, greetLine, wordsThatFit)
// and glyph safety. The DOM half is checked headless by tools/test-style-tile.mjs (the console sweep).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ROOT, lib, sandbox, engineScripts, tokensScript, plain } from './look-load.mjs';

const { isSafeChar } = await lib('tools/lib/glyphs.mjs');
const SCRIPTS = [...await engineScripts(), await tokensScript(), 'src/shared/pcd-core.js', 'src/shared/pcd-font.js',
  'src/shared/pcd-greet.js', 'src/shared/pcd-ascii.js', 'src/shared/pcd-layout.js', 'src/shared/pcd-console.js'];
const ctx = sandbox(SCRIPTS);
const PCD = ctx.PCD;
const K = PCD.console;
const A = PCD.ascii;

/** The sample city and five sample links (wikipedia, maps, weather, github, mdn): nothing personal. */
const LINKS = [['wikipedia', 'https://www.wikipedia.org'], ['maps', 'https://www.openstreetmap.org'], ['weather', 'https://open-meteo.com'],
  ['github', 'https://github.com'], ['mdn', 'https://developer.mozilla.org']].map(([label, url]) => ({ label, url }));
const WX = { data: { temp: 46, feels: 41, wind: 9, high: 49, low: 41, description: 'drizzle', kind: 'drizzle', isDay: false }, units: 'F', city: 'Berlin', ageMs: 0 };
const STATUS = { show: true, kind: 'next', parts: ['pixelclock', 'next alarm tomorrow 7:00 am', 'work'], time: '7:00 am', tone: 'muted' };
const NOW = new Date(2026, 10, 15, 20, 40);
const VIEW = { now: NOW, theme: 'autumn', name: 'Autumn Forest', tag: 'auto', phase: 'night', weather: WX, status: STATUS, links: LINKS, sun: { rise: 7.45, set: 16.25 } };

function lay(w, h, dpr, profile, view = VIEW, extra = {}) {
  const V = K.view(view, profile);
  const L = K.compute({ cssW: w, cssH: h, dpr, profile, parts: K.partsOf(V, profile), ...extra });
  return { V, L, C: K.content(V, L) };
}
const text = (part) => (part ? plain(A.plain(part.block)) : null);

test('pcd-console.js: UMD (require in Node) with the documented surface', () => {
  const require = createRequire(import.meta.url);
  const mod = require(path.join(ROOT, 'src', 'shared', 'pcd-console.js'));
  for (const k of ['compute', 'content', 'view', 'partsOf', 'regions', 'mount', 'mountScene', 'DROPS', 'SIDES', 'PROFILES', 'parts']) assert.ok(k in mod, k);
  for (const k of ['weatherLines', 'weatherBlock', 'linkItems', 'hintLine', 'captionLine', 'settingsLine', 'ruleLine', 'plan', 'fontStep', 'cellAt']) assert.equal(typeof mod.parts[k], 'function', k);
  assert.deepEqual(plain(K.DROPS), ['term-4', 'strip', 'rule', 'term-3', 'weather-compact', 'status', 'clock-compact', 'gaps', 'margin-1',
    'weather', 'date', 'term-2', 'clock', 'foot', 'head', 'links', 'margins', 'term-1']);
  assert.throws(() => K.mountScene({ appendChild() {} }, {}), /pcd-bleed/, 'mount needs the scene layer');
});

test('type: one size per screen from the ladders (new tab 18 px at 1280x800@2, 14 px at 1280x620@2; wallpaper and still div 48)', () => {
  const cases = [
    [1280, 800, 2, 'newtab', 18, 10.5, 20.5], [1280, 620, 2, 'newtab', 14, 8, 16.5], [1920, 1080, 1, 'newtab', 24, 14, 28],
    [1920, 1080, 1, 'wallpaper', 24, 14, 28], [2560, 1440, 1, 'wallpaper', 28, 16, 33], [3840, 2160, 1, 'wallpaper', 48, 28, 56],
    [1280, 800, 2, 'wallpaper', 16, 9, 19], [1280, 800, 2, 'still', 16, 9, 19], [800, 500, 2, 'newtab', 12, 7, 14],
  ];
  for (const [w, h, d, p, px, cw, ch] of cases) {
    const { L } = lay(w, h, d, p);
    assert.equal(L.font.px, px, `${p} ${w}x${h}@${d} font`);
    assert.deepEqual([L.cell.w, L.cell.h], [cw, ch], `${p} ${w}x${h}@${d} cell`);
    assert.equal(L.font.step, PCD.font.step(h, d, p === 'still' ? 'still' : p));
  }
});

test('type in squarish and portrait windows: the width caps the size, so the column keeps to about half and the scene shows', () => {
  // [w, h, dpr, profile, font px, the column's reach in CSS px (from its own screen edge, margin included)]
  const cases = [
    [900, 1400, 1, 'newtab', 16, 432], [960, 969, 1, 'newtab', 16, 432], [640, 620, 2, 'newtab', 12, 329], [768, 1024, 1, 'newtab', 14, 376],
    [1000, 1000, 1, 'newtab', 20, 517], [1080, 1920, 1, 'wallpaper', 20, 517], [1440, 2560, 1, 'wallpaper', 28, 752], [1080, 1920, 1, 'still', 20, 517],
  ];
  for (const [w, h, d, p, px, reach] of cases) {
    const { L } = lay(w, h, d, p);
    const name = `${p} ${w}x${h}@${d}`;
    const r = L.side === 'left' ? L.edge.x : w - L.edge.x;
    assert.equal(L.font.px, px, name + ' font');
    assert.equal(r, reach, name + ' reach');
    assert.ok(r <= 0.55 * w, `${name}: the column takes ${r} of ${w}`);
    assert.equal(L.font.step, PCD.font.step(Math.min(h, w * (p === 'newtab' ? 0.8 : 0.9)), d, p));
    assert.deepEqual(plain(L.dropped), [], name + ' nothing dropped');
  }
  // landscape windows keep the height's size
  for (const [w, h, d, p, px] of [[1280, 620, 2, 'newtab', 14], [1280, 800, 2, 'newtab', 18], [800, 500, 1, 'newtab', 14], [1920, 969, 1, 'newtab', 24],
    [1024, 768, 1, 'newtab', 16], [1280, 1024, 1, 'newtab', 24], [1920, 1080, 1, 'wallpaper', 24], [1280, 800, 2, 'wallpaper', 16], [1280, 800, 2, 'still', 16], [2560, 1440, 1, 'still', 28]]) {
    const { L } = lay(w, h, d, p);
    assert.equal(L.font.px, px, `${p} ${w}x${h}@${d}`);
    assert.equal(L.font.step, PCD.font.step(h, d, p), `${p} ${w}x${h}@${d}: the height alone`);
  }
  // the wallpaper and the still share the rule, cell for cell
  for (const [w, h] of [[1080, 1920], [1200, 1200], [1440, 2560], [1920, 1080]]) {
    const a = lay(w, h, 1, 'wallpaper').L;
    const b = lay(w, h, 1, 'still').L;
    assert.deepEqual(plain([a.font, a.cell, a.col]), plain([b.font, b.cell, b.col]), `${w}x${h}`);
  }
  assert.equal(K.parts.fontStep(1400, 1, 'newtab', 900), PCD.font.step(720, 1, 'newtab'));
  assert.equal(K.parts.fontStep(1400, 1, 'newtab'), PCD.font.step(1400, 1, 'newtab'), 'without the width: the height alone');
});

test('the column at 1280x800@2 (new tab): grid, margin and width, the rows top down and every part\'s text', () => {
  const { L, C } = lay(1280, 800, 2, 'newtab');
  assert.deepEqual([L.grid.cols, L.grid.rows, L.mx, L.col.c, L.col.cols, L.edge.x], [121, 39, 4, 4, 44, 504]);
  const R = L.rows;
  assert.deepEqual([R.clock, R.greet, R.date, R.status, R.strip, R.weather, R.links, R.rule, R.term.r, R.term.rows, R.foot],
    [2, 9, 10, 11, 13, 15, 20, 23, 24, 12, 37]);
  assert.deepEqual(plain(L.dropped), []);
  assert.equal(C.clock.text, '8:40 pm');
  assert.deepEqual(text(C.greet), ['good evening.']);
  assert.deepEqual(text(C.date), ['sun nov 15']);
  assert.deepEqual(text(C.status), ['⌂ next alarm tomorrow 7:00 am · work']);
  assert.deepEqual(text(C.weather), ['    .--.     46°F drizzle · berlin', ' .-(    ).   feels 41° · wind 9 mph', '(___.__)__)  hi 49° · lo 41°', "  ' ' ' '    weather: open-meteo.com"]);
  assert.deepEqual(text(C.rule), ['── terminal ' + '─'.repeat(32)]);
  assert.equal(A.plain(C.rule.block)[0].length, 44);
  assert.deepEqual(plain(C.term), { c: 4, r: 24, cols: 44, rows: 12 });
  assert.deepEqual(text(C.hint), ['1-5 + enter opens a link · help lists commands']);
  assert.deepEqual(text(C.caption), ['autumn forest · night']);
  assert.deepEqual(text(C.settings), ['≡ settings']);
  // the caption and '≡ settings' end at the right margin, three cells apart
  assert.equal(C.settings.c + C.settings.cols, L.grid.cols - L.mx);
  assert.equal(C.caption.c + C.caption.cols + 3, C.settings.c);
  // the strip spans the column: [rise 5][2][bars][2][set 5], the times as PCD.ascii sets them
  assert.deepEqual(plain(C.strip.block), plain([A.stripLine(30, A.stripLabels({ rise: 7.45, set: 16.25 }, false))]));
  assert.equal(text(C.strip)[0].length, 44);
  assert.deepEqual(text(C.strip)[0].trim().split(/\s+/), ['7:27', '4:15']);
  assert.equal(C.strip.bars.n, 30);
  assert.equal(C.strip.bars.c, 4 + 7);
  assert.equal(C.strip.bars.rects.filter((q) => q.now).length, 1);
  // the clock: 3x5 digits, the amber colon as two rects, the wood shadow, am/pm one cell after the shadow
  assert.equal(C.clock.rects.filter((q) => q.colon).length, 2);
  assert.deepEqual(text(C.clock.side), ['pm']);
  assert.equal(C.clock.side.r, R.clock + 4);
});

test('the hint names the real link range: 1-3 with three links, 1 with one, no link half with none', () => {
  const nine = linksNamed('mail', 'news', 'music', 'notes', 'files', 'maps', 'docs', 'wiki', 'code');
  const hint = (n, w = 99) => A.plain([K.parts.hintLine(K.view({ ...VIEW, links: nine.slice(0, n) }, 'newtab'), w)])[0];
  assert.equal(hint(0), 'help lists commands');
  assert.equal(hint(1), '1 + enter opens a link · help lists commands');
  for (let n = 2; n <= 9; n++) assert.equal(hint(n), `1-${n} + enter opens a link · help lists commands`);
  const tones = K.parts.hintLine(K.view({ ...VIEW, links: nine.slice(0, 3) }, 'newtab'), 99).map((r) => [r.text, r.tone]);
  assert.deepEqual(plain(tones.slice(0, 2)), [['1-3', 'muted'], [' + enter opens a link', 'faint']]);
  // only whole parts fit: the link half alone, then nothing
  assert.equal(hint(3, 30), '1-3 + enter opens a link');
  assert.equal(hint(3, 10), '');
  // the new tab with three sample links
  const { C } = lay(1280, 800, 2, 'newtab', { ...VIEW, links: LINKS.slice(0, 3) });
  assert.deepEqual(text(C.hint), ['1-3 + enter opens a link · help lists commands']);
});

test('the strip without sun times: the bars alone, across the whole column (no blank label cells)', () => {
  for (const [p, w, h, d] of [['newtab', 1280, 800, 2], ['newtab', 1280, 620, 2], ['wallpaper', 1920, 1080, 1], ['still', 1280, 800, 2]]) {
    const name = `${p} ${w}x${h}@${d}`;
    const { L, C } = lay(w, h, d, p, { ...VIEW, sun: null });
    assert.equal(C.strip.bars.c, L.col.c, name + ': the bars start at the column');
    assert.equal(C.strip.bars.n, L.col.cols, name + ': and span it');
    assert.deepEqual(text(C.strip), [''], name + ': no labels');
    const right = Math.max(...C.strip.bars.rects.map((q) => q.x + q.w));
    assert.ok(right <= L.col.cols * L.cell.wDev && right > (L.col.cols - 1) * L.cell.wDev, `${name}: the last bar ends at the column's edge`);
    assert.equal(C.strip.bars.rects.filter((q) => q.now).length, 1, name + ': the now bar');
    // with sun times: the labels, the bars 7 cells in
    const sun = lay(w, h, d, p).C.strip;
    assert.deepEqual([sun.bars.c, sun.bars.n], [L.col.c + 7, L.col.cols - 14], name + ' with sun times');
  }
});

test('a 1280x620 Chrome window at 200 %: 14 px, the column a third of the width, nothing dropped', () => {
  const { L, C } = lay(1280, 620, 2, 'newtab');
  assert.deepEqual([L.font.px, L.grid.cols, L.grid.rows, L.col.cols], [14, 160, 37, 54]);
  assert.deepEqual(plain(L.dropped), []);
  assert.equal(L.rows.term.rows, 10);
  assert.ok(C.caption && C.settings && C.hint);
});

test('reserve: the new tab keeps a blank status row before the clock answers, so nothing moves when the line comes', () => {
  const noStatus = { ...VIEW, status: null };
  for (const [w, h, d] of [[1280, 800, 2], [1280, 620, 2], [1920, 969, 1], [800, 500, 1]]) {
    const name = `${w}x${h}@${d}`;
    const real = lay(w, h, d, 'newtab', VIEW);
    const reserved = lay(w, h, d, 'newtab', { ...noStatus, reserve: { status: true } });
    const gone = lay(w, h, d, 'newtab', noStatus);
    assert.deepEqual(plain(reserved.L.rows), plain(real.L.rows), name + ': the same rows as with the line');
    assert.deepEqual(plain(K.partsOf(reserved.V, 'newtab')), plain(K.partsOf(real.V, 'newtab')), name + ': the same parts (no new layout when it comes)');
    assert.equal(reserved.C.status, null, name + ': the reserved row stays blank');
    if (real.L.rows.status !== undefined) assert.equal(gone.L.rows.status, undefined, name + ': without the reserve the row is gone');
    assert.deepEqual(plain(lay(w, h, d, 'newtab', { ...VIEW, reserve: { status: true } }).L.rows), plain(real.L.rows), name + ': a line and a reserve');
  }
  // a status that does not show is no line; the wallpaper and the still never have the row
  assert.equal(lay(1280, 800, 2, 'newtab', { ...VIEW, status: { ...STATUS, show: false }, reserve: { status: true } }).C.status, null);
  for (const p of ['wallpaper', 'still']) {
    assert.equal(K.partsOf(K.view({ ...noStatus, reserve: { status: true } }, p), p).status, false, p);
    assert.equal(K.view({ reserve: { status: true } }, p).reserve.status, false, p);
  }
  assert.equal(K.view({}, 'newtab').reserve.status, false, 'no reserve by default');
});

test('sides: the wallpaper mirrors the new tab (the column on the right, its reach the same, rows the same)', () => {
  for (const [w, h, d] of [[1920, 1080, 1], [1280, 800, 2], [3440, 1440, 1], [999, 777, 1]]) {
    const right = lay(w, h, d, 'wallpaper').L;
    const left = K.compute({ cssW: w, cssH: h, dpr: d, profile: 'wallpaper', side: 'left', parts: K.partsOf(K.view(VIEW, 'wallpaper'), 'wallpaper') });
    assert.equal(right.side, 'right');
    assert.equal(left.side, 'left');
    // the column's outer edge sits mx cells from its own screen edge, on whole device px
    assert.equal(right.grid.xDev + (right.col.c + right.col.cols) * right.cell.wDev, right.Wd - right.mx * right.cell.wDev, `${w}x${h} right edge`);
    assert.equal(left.grid.xDev + left.col.c * left.cell.wDev, left.mx * left.cell.wDev, `${w}x${h} left edge`);
    assert.equal(right.Wd - right.edge.xDev, left.edge.xDev, `${w}x${h}: the same reach on both sides`);
    assert.deepEqual(plain(right.rows), plain(left.rows));
    assert.ok(Number.isInteger(right.edge.xDev) && Number.isInteger(right.grid.xDev));
  }
  // the wallpaper caption sits in the column's bottom corner; there is no hint, links, status or terminal
  const { L, C } = lay(1920, 1080, 1, 'wallpaper');
  assert.deepEqual(text(C.caption), ['autumn forest · night']);
  assert.equal(C.caption.c + C.caption.cols, L.col.c + L.col.cols);
  assert.equal(C.hint, null);
  assert.equal(C.settings, null);
  assert.equal(C.status, null);
  assert.equal(C.term, null);
  assert.equal(C.rule, null);
  assert.deepEqual(plain(C.links), []);
});

test('the taskbar: the wallpaper column and its caption stay above it; the new tab has none', () => {
  for (const [w, h, d] of [[1920, 1080, 1], [1280, 800, 2], [800, 500, 1], [1600, 300, 1], [320, 200, 1]]) {
    for (const tb of [56, 48, 0]) {
      const { L } = lay(w, h, d, 'wallpaper', VIEW, { taskbar: tb });
      const limit = L.Hd - Math.round(tb * d);
      const rows = Object.entries(L.rows).filter(([k, v]) => typeof v === 'number' && v >= 0 && k !== 'end').map(([, v]) => v);
      for (const r of rows) assert.ok((r + 1) * L.cell.hDev <= limit, `${w}x${h}@${d} taskbar ${tb}: row ${r}`);
      assert.equal(L.taskbar.dev, Math.round(tb * d));
    }
  }
  const nt = lay(1920, 1080, 1, 'newtab', VIEW, { taskbar: 56 }).L;
  assert.equal(nt.taskbar.dev, 0);
  assert.equal(nt.grid.usable, nt.grid.rows);
});

test('the drop order: what drops is always a prefix of DROPS, and what is left fits the rows', () => {
  const DROPS = plain(K.DROPS);
  for (const profile of ['newtab', 'wallpaper', 'still']) {
    for (const w of [1280, 800, 420]) {
      for (let h = 900; h >= 60; h -= 6) {
        const { L } = lay(w, h, 1, profile, VIEW, { fontStep: 16 });
        const d = plain(L.dropped);
        assert.deepEqual(d, DROPS.slice(0, d.length), `${profile} ${w}x${h}`);
        // (the margins follow the rows: 2 at 34+, 1 at 18+, so a shorter screen may keep a part a taller one dropped)
        assert.ok(L.fits, `${profile} ${w}x${h}: the plan fits`);
        // every part that shows has its own rows, inside the usable rows, in order and apart
        const R = L.rows;
        const spans = [];
        if (R.clock !== undefined) spans.push([R.clock, L.plan.clock === 'full' ? 6 : 3]);
        for (const k of ['greet', 'date', 'status', 'strip']) if (R[k] !== undefined) spans.push([R[k], 1]);
        if (R.weather !== undefined) spans.push([R.weather, L.plan.weather === 'full' ? 4 : 2]);
        if (R.links !== undefined) spans.push([R.links, L.links.rows]);
        if (R.rule !== undefined) spans.push([R.rule, 1]);
        if (R.term) spans.push([R.term.r, R.term.rows]);
        if (R.foot >= 0) spans.push([R.foot, 1]);
        spans.sort((a, b) => a[0] - b[0]);
        for (let i = 0; i < spans.length; i++) {
          assert.ok(spans[i][0] >= 0 && spans[i][0] + spans[i][1] <= L.grid.usable || !L.fits, `${profile} ${w}x${h}: a part past the rows`);
          if (i) assert.ok(spans[i][0] >= spans[i - 1][0] + spans[i - 1][1], `${profile} ${w}x${h}: parts overlap`);
        }
      }
    }
  }
  // the named steps, in order
  const small = lay(800, 500, 1, 'newtab').L;
  assert.deepEqual(plain(small.dropped), ['term-4']);
  const tiny = lay(320, 200, 1, 'newtab').L;
  assert.deepEqual(plain(tiny.dropped), DROPS.slice(0, 10));
  assert.equal(tiny.plan.clock, 'compact');
  assert.equal(tiny.plan.weather, 'none');
  assert.ok(tiny.plan.links && tiny.rows.term.rows >= 1);
});

/** Sample links of the given labels (public example URLs). */
const linksNamed = (...labels) => labels.map((label, i) => ({ label, url: 'https://example.com/' + i }));
/** linkItems' rows as the column shows them: each item's text at its x. */
const linkRows = (li) => {
  const rows = [];
  for (const it of li.items) {
    const t = A.plain(it.block)[0];
    const row = (rows[it.row] || '').padEnd(it.x, ' ');
    rows[it.row] = row.slice(0, it.x) + t + row.slice(it.x + t.length);
  }
  return rows;
};

test('links: [n] label, lower case, at most 24 code points and 9 links; bad ones dropped', () => {
  const items = (links, colW) => plain(K.parts.linkItems(K.parts.linksOf(links), colW));
  const five = items(LINKS, 44);
  assert.deepEqual(five.items.map((i) => A.plain(i.block)[0]), ['[1] wikipedia', '[2] maps', '[3] weather', '[4] github', '[5] mdn']);
  assert.deepEqual(plain(five.items[0].block[0].map((r) => r.tone)), ['faint', 'accent', 'faint', 'muted']);
  const many = Array.from({ length: 12 }, (_, i) => ({ label: 'Site ' + i, url: 'https://example.com/' + i }));
  const nine = items(many, 64);
  assert.equal(nine.n, 9);
  assert.equal(nine.items[0].label, 'site 0');
  const odd = K.parts.linksOf([{ label: 'x', url: 'javascript:alert(1)' }, { label: '', url: 'https://a.b' }, { name: 'Named', url: 'http://n.example' }, null]);
  assert.deepEqual(plain(odd), [{ label: 'named', url: 'http://n.example' }]);
  const long = items([{ label: 'A very long label for a link', url: 'https://example.com' }], 44);
  assert.equal(long.items[0].label, 'a very long label for a', '24 code points, then no trailing space');
  assert.deepEqual([long.rows, long.cols], [1, 27]);
  // no links: no row, and the hint drops its link half
  const none = lay(1280, 800, 2, 'newtab', { ...VIEW, links: [] });
  assert.equal(none.L.rows.links, undefined);
  assert.equal(none.L.links, null);
  assert.deepEqual(text(none.C.hint), ['help lists commands']);
});

test('links: one row with every gap 3 cells; on several rows each column as wide as its own longest label, 3 cells apart', () => {
  const li = (labels, colW) => plain(K.parts.linkItems(K.parts.linksOf(linksNamed(...labels)), colW));
  // sample links wikipedia, maps and weather: one row, 38 cells (the example's open-meteo gives 41)
  const ex = li(['wikipedia', 'maps', 'weather'], 44);
  assert.deepEqual(linkRows(ex), ['[1] wikipedia   [2] maps   [3] weather']);
  assert.deepEqual([ex.per, ex.rows, ex.cols], [3, 1, 38]);
  assert.deepEqual([li(['wikipedia', 'maps', 'open-meteo'], 44).cols, li(['wikipedia', 'maps', 'open-meteo'], 44).rows], [41, 1]);
  // five short labels: 3 + 2 in columns of 10 cells (36)
  const short = li(['mail', 'news', 'music', 'notes', 'files'], 44);
  assert.deepEqual(linkRows(short), ['[1] mail     [2] news     [3] music', '[4] notes    [5] files']);
  assert.deepEqual([short.per, short.cols, plain(short.x)], [3, 36, [0, 13, 26]]);
  // one long label widens only its own column: 3 + 2 (43), not one link alone on a third row
  const portal = li(['mail', 'course portal', 'music', 'notes', 'files'], 44);
  assert.deepEqual(linkRows(portal), ['[1] mail     [2] course portal   [3] music', '[4] notes    [5] files']);
  assert.deepEqual([portal.per, portal.rows, portal.cols], [3, 2, 43]);
  for (const colW of [44, 54]) assert.equal(li(['mail', 'course portal', 'music', 'notes', 'files'], colW).rows, 2, `${colW} cells`);
  // a 24-character label: 3 rows at 44 cells (2 + 2 + 1), 2 at 54 (3 + 2)
  const big = ['mail', 'abcdefghijklmnopqrstuvwx', 'music', 'notes', 'files'];
  assert.deepEqual([li(big, 44).per, li(big, 44).rows], [2, 3]);
  assert.deepEqual([li(big, 54).per, li(big, 54).rows], [3, 2]);
  assert.deepEqual(linkRows(li(big, 54)), ['[1] mail     [2] abcdefghijklmnopqrstuvwx   [3] music', '[4] notes    [5] files']);
  // 4 links: 2 + 2, never 3 + 1
  assert.equal(li(['wikipedia', 'maps', 'weather', 'github'], 44).per, 2);
  // one link a row only when two do not fit; a label is cut only when it is wider than the column
  const narrow = li(['abcdefghijklmnopqrst', 'abcdefghijklmnopqrstuvwx'], 30);
  assert.deepEqual([narrow.per, narrow.rows, narrow.items[1].label], [1, 2, 'abcdefghijklmnopqrstuvwx']);
  assert.equal(li(['abcdefghijklmnopqrstuvwx'], 20).items[0].label, 'abcdefghijklmnop');
  // the 1280x800@2 new tab places the five sample links at their columns' cells
  const { L, C } = lay(1280, 800, 2, 'newtab');
  assert.deepEqual(plain(C.links.map((l) => [l.n, l.c, l.r])), [[1, 4, 20], [2, 20, 20], [3, 33, 20], [4, 4, 21], [5, 20, 21]]);
  const { items, ...rest } = plain(K.parts.linkItems(K.view(VIEW, 'newtab').links, L.col.cols));
  assert.deepEqual(plain(L.links), rest, 'compute() has the same rows, widths and offsets');
  assert.ok(items.length === 5);
});

test('links: compute() lays out exactly the rows content() draws (0-9 links of mixed lengths at several sizes)', () => {
  const LENS = [9, 24, 3, 13, 1, 6, 17, 4, 11, 8, 20, 2];
  const AZ = 'abcdefghijklmnopqrstuvwxyz';
  let layouts = 0;
  let several = 0;
  for (let n = 0; n <= 9; n++) {
    for (let s = 0; s < 6; s++) {
      const links = Array.from({ length: n }, (_, i) => ({ label: AZ.slice(i, i + 26).padEnd(26, 'z').slice(0, LENS[(i + 5 * s) % LENS.length]), url: 'https://example.com/' + i }));
      for (const [w, h, d] of [[1280, 800, 2], [1280, 620, 2], [1920, 969, 1], [800, 500, 1], [900, 1400, 1], [3440, 1440, 1], [640, 620, 2]]) {
        const name = `${n} links (set ${s}) at ${w}x${h}@${d}`;
        const { L, C } = lay(w, h, d, 'newtab', { ...VIEW, links });
        if (!n || !L.plan.links) {
          assert.equal(C.links.length, 0, name);
          continue;
        }
        const li = L.links;
        const rows = Math.max(...C.links.map((l) => l.r)) - L.rows.links + 1;
        assert.equal(rows, li.rows, name + ': rows');
        assert.equal(li.rows, Math.ceil(n / li.per), name);
        const colW = L.col.cols;
        for (const l of C.links) assert.ok(l.c >= L.col.c && l.c + l.cols <= L.col.c + colW, `${name}: link ${l.n} inside the column`);
        if (li.per === n) {
          // one row: every gap is 3 cells
          for (let i = 1; i < n; i++) assert.equal(C.links[i].c, C.links[i - 1].c + C.links[i - 1].cols + 3, `${name}: gap ${i}`);
        } else {
          several++;
          assert.ok(li.per === 1 || li.per === 2 || n % li.per !== 1, `${name}: one link alone after ${li.per} a row`);
          // each column as wide as its longest item (10 at least), 3 cells apart, and they fit
          for (let j = 0; j < li.per; j++) {
            const col = C.links.filter((l) => (l.n - 1) % li.per === j);
            assert.ok(col.every((l) => l.c === L.col.c + li.x[j]), `${name}: column ${j} lines up`);
            if (li.per > 1) assert.equal(li.widths[j], Math.max(10, ...col.map((l) => l.cols)), `${name}: column ${j} width`);
            if (j) assert.equal(li.x[j], li.x[j - 1] + li.widths[j - 1] + 3, `${name}: column ${j} offset`);
          }
          assert.ok(li.cols <= colW, `${name}: ${li.cols} cells`);
          // and no more links a row would fit
          const need = C.links.map((l) => l.cols);
          assert.ok(need.reduce((a, b) => a + b, 0) + 3 * (n - 1) > colW, `${name}: one row would fit`);
          for (let p = li.per + 1; p < n; p++) {
            if (p > 2 && n % p === 1) continue;
            const ws = Array.from({ length: p }, (_, j) => Math.max(10, ...need.filter((_, i) => i % p === j)));
            assert.ok(ws.reduce((a, b) => a + b, 0) + 3 * (p - 1) > colW, `${name}: ${p} a row would fit`);
          }
        }
        layouts++;
      }
    }
  }
  assert.ok(layouts > 300 && several > 100, `${layouts} layouts, ${several} on several rows`);
});

test('links: labels are counted and cut on whole code points (an emoji stays whole, never half a pair)', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const emoji = 'abcdefghijklmnopqrstuvw\u{1F600}'; // 24 code points, 25 UTF-16 units
  const [one] = K.parts.linksOf([{ label: emoji, url: 'https://example.com' }]);
  assert.equal(one.label, emoji, 'the 24th code point stays');
  const li = K.parts.linkItems([one], 44);
  assert.deepEqual([li.items[0].label, li.items[0].cols, li.cols], [emoji, 28, 28]);
  const wide = K.parts.linksOf([{ label: '\u{1F600}'.repeat(30), url: 'https://example.com' }]);
  assert.equal(Array.from(wide[0].label).length, 24, 'cut to 24 code points');
  for (const colW of [44, 20, 9, 5]) {
    for (const it of K.parts.linkItems(wide, colW).items) {
      assert.ok(!lone.test(it.label), `${colW} cells: a lone surrogate`);
      assert.equal(it.cols, Math.min(28, Math.max(5, colW)), `${colW} cells`);
    }
  }
  // the layout counts code points too, so its rows are the content's
  const view = { ...VIEW, links: [{ label: emoji, url: 'https://example.com' }, ...LINKS] };
  assert.deepEqual(plain(K.partsOf(K.view(view, 'newtab'), 'newtab').linkLens), [24, 9, 4, 7, 6, 3]);
  const { L, C } = lay(1280, 800, 2, 'newtab', view);
  assert.equal(Math.max(...C.links.map((l) => l.r)) - L.rows.links + 1, L.links.rows);
  for (const l of C.links) for (const line of A.plain(l.block)) assert.ok(!lone.test(line), line);
});

test('weather: the four lines, the credit link, units, old data and a long city', () => {
  const W = (o, w) => plain(K.parts.weatherLines({ ...WX, ...o }, w).map((l) => l.map((r) => r.text).join('')));
  assert.deepEqual(W({}, { width: 31 }), ['46°F drizzle · berlin', 'feels 41° · wind 9 mph', 'hi 49° · lo 41°', 'weather: open-meteo.com']);
  assert.deepEqual(W({ units: 'C', data: { ...WX.data, temp: 8, feels: 5, wind: 14, high: 9, low: 5 } }, { width: 31 }),
    ['8°C drizzle · berlin', 'feels 5° · wind 14 km/h', 'hi 9° · lo 5°', 'weather: open-meteo.com']);
  // 'hi' and 'lo' keep the shortest line: the block's width does not move (frosty and hot extremes too)
  for (const [high, low, feels, wind] of [[49, 41, 41, 9], [-12, -20, -15, 45], [104, 88, 110, 3]]) {
    const ls = W({ data: { ...WX.data, high, low, feels, wind } }, { width: 31 });
    assert.ok(ls[2].length < ls[1].length, `${ls[2]} | ${ls[1]}`);
  }
  // two hours old: the prefix gives way so the age fits
  assert.deepEqual(W({ ageMs: 2 * 3600000 }, { width: 31 }).slice(3), ['open-meteo.com · 2 h ago']);
  assert.deepEqual(W({ ageMs: 2 * 3600000 }, { width: 40 }).slice(3), ['weather: open-meteo.com · 2 h ago']);
  // the city in whole words, or not at all
  assert.deepEqual(W({ city: 'san francisco de campeche' }, { width: 31 }).slice(0, 1), ['46°F drizzle · san francisco de']);
  assert.deepEqual(W({ city: 'llanfairpwllgwyngyllgogerychwyrndrobwll' }, { width: 31 }).slice(0, 1), ['46°F drizzle']);
  // the domain links to open-meteo.com on the new tab only
  const nt = K.parts.weatherLines(WX, { width: 31, link: true })[3];
  assert.equal(nt.find((r) => r.text === 'open-meteo.com').href, 'https://open-meteo.com/');
  assert.ok(!K.parts.weatherLines(WX, { width: 31 })[3].some((r) => r.href));
  // tones: temperature text 600, condition text, the rest muted, separators frame, the credit faint
  const [l1, l2, , l4] = K.parts.weatherLines(WX, { width: 31 });
  assert.deepEqual(plain(l1.map((r) => [r.tone, r.bold])), [['text', true], ['text', false], ['frame', false], ['muted', false]]);
  assert.deepEqual(plain(l2.map((r) => r.tone)), ['muted', 'frame', 'muted']);
  assert.deepEqual(plain(l4.map((r) => r.tone)), ['faint', 'faint']);
  // compact: two lines without the icon; no data: no block
  assert.equal(K.parts.weatherLines(WX, { width: 31, compact: true }).length, 2);
  assert.deepEqual(plain(K.parts.weatherLines(null, {})), []);
  const off = lay(1280, 800, 2, 'newtab', { ...VIEW, weather: null });
  assert.equal(off.C.weather, null);
  assert.equal(off.L.rows.weather, undefined);
});

test('the still: the calendar page instead of the clock, no date line, the wallpaper ladder and caption', () => {
  const { L, C } = lay(2560, 1600, 2, 'still');
  assert.equal(L.side, 'right');
  assert.equal(C.clock.face.kind, 'day');
  assert.deepEqual(plain(A.plain(C.clock.side.block).filter(Boolean)), ['november', 'sunday']);
  assert.equal(C.clock.side.block[0][0].bold, true);
  assert.equal(C.date, null);
  assert.deepEqual(text(C.greet), ['good evening.']);
  assert.ok(C.clock.rects.length > 0 && C.clock.rects.every((q) => !q.colon));
  assert.deepEqual(text(C.caption), ['autumn forest · night']);
});

test('the column\'s helpers in PCD.ascii: statusLine, greetLine and wordsThatFit, cut to whole words at every width', () => {
  const runs = (line) => plain(line && line.map((r) => [r.text, r.tone]));
  const head = (word, time) => [['⌂ ', 'frame'], [word, 'muted'], [time, 'text']];
  const label = (s) => [[' · ', 'frame'], [s, 'muted']];
  const cases = [
    [STATUS, { undefined: [...head('next alarm tomorrow ', '7:00 am'), ...label('work')], 36: [...head('next alarm tomorrow ', '7:00 am'), ...label('work')], 20: head('next alarm tomorrow ', '7:00 am') }],
    [{ show: true, kind: 'snoozed', parts: ['pixelclock', 'snoozed until 8:09 am', 'work'], time: '8:09 am', tone: 'text' },
      { 44: [...head('snoozed until ', '8:09 am'), ...label('work')], 20: head('snoozed until ', '8:09 am') }],
    [{ show: true, kind: 'ringing', parts: ['pixelclock', 'ringing', 'work'], time: null, tone: 'accent' },
      { 44: [['⌂ ', 'accent'], ['ringing', 'accent'], [' · ', 'frame'], ['work', 'accent']], 20: [['⌂ ', 'accent'], ['ringing', 'accent'], [' · ', 'frame'], ['work', 'accent']] }],
    [{ show: true, kind: 'next', parts: ['pixelclock', 'next alarm tomorrow 7:00 am', 'my long alarm label for mondays'], time: '7:00 am' },
      { undefined: [...head('next alarm tomorrow ', '7:00 am'), ...label('my long alarm label for mondays')], 44: [...head('next alarm tomorrow ', '7:00 am'), ...label('my long')],
        40: [...head('next alarm tomorrow ', '7:00 am'), ...label('my long')], 36: [...head('next alarm tomorrow ', '7:00 am'), ...label('my')], 20: head('next alarm tomorrow ', '7:00 am') }],
    [{ show: true, kind: 'none', parts: ['pixelclock', 'no alarm set'], time: null }, { 44: [['⌂ ', 'frame'], ['no alarm set', 'muted']] }],
    [{ show: false, parts: ['x'] }, { 44: null }], [null, { 44: null }],
  ];
  for (const [st, byWidth] of cases) {
    for (const [w, want] of Object.entries(byWidth)) {
      assert.deepEqual(runs(A.statusLine(st, w === 'undefined' ? undefined : Number(w))), want, JSON.stringify([st && st.parts, w]));
    }
  }
  const greet = (d, w) => plain(A.greetLine(PCD.greet.parts(d, ctx.PixelClock), w).map((r) => [r.text, r.tone, r.bold]));
  // the holiday line is text: amber is kept for live things (the colon, the prompt, the link digits)
  assert.deepEqual(greet(new Date(2026, 9, 31, 21, 10), 44), [['good evening', 'text', true], [' · ', 'frame', false], ['happy halloween', 'text', false]]);
  assert.deepEqual(greet(new Date(2026, 9, 31, 21, 10), 20), [['good evening.', 'text', true]], 'a holiday line too long for the column falls back');
  assert.deepEqual(greet(new Date(2027, 2, 17, 13, 0), 39), [['good afternoon.', 'text', true]]);
  assert.deepEqual(greet(new Date(2026, 10, 15, 8, 0), 40), [['good morning.', 'text', true]]);
  for (const [t, n, want] of [['san francisco de campeche', 20, 'san francisco de'], ['berlin', 3, ''], ['a, b; c', 4, 'a'], ['', 5, ''], [null, 5, '']]) {
    assert.equal(A.wordsThatFit(t, n), want, JSON.stringify([t, n]));
  }
});

test('every part stays in its cells, and every glyph is in the safe set (a sweep of sizes, sides and weathers)', () => {
  const kinds = ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'freezing', 'snow', 'thunder', 'unknown'];
  let n = 0;
  for (const profile of ['newtab', 'wallpaper', 'still']) {
    for (const [w, h, d] of [[1280, 800, 2], [1280, 620, 2], [1920, 1080, 1], [3440, 1440, 1], [800, 500, 1], [1080, 1920, 1], [320, 200, 1], [1600, 300, 1], [420, 760, 2]]) {
      for (const kind of kinds) {
        const view = { ...VIEW, now: new Date(2026, 9, 31, 21 - kinds.indexOf(kind), 10), weather: { ...WX, ageMs: kind === 'fog' ? 3 * 3600000 : 0, data: { ...WX.data, kind, description: kind === 'thunder' ? 'thunderstorm with hail' : kind } } };
        const { L, C } = lay(w, h, d, profile, view);
        const col = L.col.c + L.col.cols;
        for (const name of ['greet', 'date', 'status', 'weather', 'rule', 'strip']) {
          const p = C[name];
          if (!p) continue;
          for (const line of A.plain(p.block)) {
            assert.ok(p.c + line.length <= col, `${profile} ${w}x${h} ${name} past the column: "${line}"`);
            for (const ch of line) assert.ok(isSafeChar(ch), `${name}: ${ch}`);
            n++;
          }
        }
        for (const p of [C.hint, C.caption, C.settings, ...(C.links || [])]) {
          if (!p) continue;
          const line = A.plain(p.block)[0];
          assert.ok(p.c >= 0 && p.c + line.length <= L.grid.cols, `${profile} ${w}x${h}: "${line}" off the screen`);
          for (const ch of line) assert.ok(isSafeChar(ch), ch);
        }
        if (C.hint && C.caption) assert.ok(C.hint.c + A.plain(C.hint.block)[0].length + 4 <= C.caption.c, `${w}x${h}: the hint runs into the caption`);
      }
    }
  }
  assert.ok(n > 1000);
});
