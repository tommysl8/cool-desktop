// node --test tests/smoke.test.mjs
// The headless engine smoke (tools/smoke.mjs --quick) into a temp folder: the synced engine loads in a plain page
// with no build step, four themes at four times of day plus the 200 % and 125 % screens are crisp and exact.
// The full run (node tools/smoke.mjs) writes dist/screens/smoke-*.png.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findBrowser } from '../tools/lib/chrome.mjs';
import { makeTempDir, rmrf } from '../tools/lib/fsx.mjs';
import { pngSize } from '../tools/lib/png.mjs';
import { runSmoke } from '../tools/smoke.mjs';

const SKIP = findBrowser() ? false : 'no Chrome or Edge installed';

test('engine smoke (quick): 4 themes x 4 times of day, hook modes, shake, 200 % and 125 % screens, file://', { skip: SKIP, timeout: 300000 }, async (t) => {
  const out = makeTempDir('pcd-smoketest-');
  try {
    const lines = [];
    const r = await runSmoke({ out, quick: true, log: (m) => lines.push(m) });
    const failed = r.rows.filter((row) => row.pass === false);
    assert.deepEqual(failed.map((f) => `${f.name}: ${f.detail}`), [], lines.join('\n'));
    assert.equal(r.code, 0);
    const shots = fs.readdirSync(out).filter((f) => f.endsWith('.png')).sort();
    for (const theme of ['winter', 'summer', 'autumn', 'christmas']) {
      for (const time of ['dawn', 'day', 'sunset', 'night']) assert.ok(shots.includes(`smoke-${theme}-${time}.png`), `${theme}-${time}`);
    }
    assert.deepEqual([pngSize(path.join(out, 'smoke-screen-laptop-200pct.png')).width, pngSize(path.join(out, 'smoke-screen-laptop-200pct.png')).height], [2560, 1600]);
    assert.deepEqual([pngSize(path.join(out, 'smoke-screen-1080p-125pct.png')).width, pngSize(path.join(out, 'smoke-screen-1080p-125pct.png')).height], [1920, 1080]);
    assert.equal(r.results['screen-laptop-200pct'].k, 25);
    assert.equal(r.results['screen-1080p-125pct'].k, 16);
    assert.ok(shots.includes('smoke-sheet.png') && shots.includes('smoke-file-url.png'));
    t.diagnostic(`${r.rows.length} checks, ${shots.length} screenshots`);
  } finally {
    await rmrf(out);
  }
});
