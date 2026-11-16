// Validator plugin: dist/still and the task template.
//
// Package: every file present and byte-identical to its source (src/still, src/shared, vendor/pixelclock,
// design/tokens.json, design/atlas); the launcher is the untouched template and compiles; no package code calls
// -ExecutionPolicy, writes a .ps1 or spawns schtasks or wscript. Behaviour: the packaged renderer runs from dist/still
// on its own (package layout, PCD_NO_WALLPAPER=1, --out into os.tmpdir(), no network, no setting) and writes a PNG of
// the requested size; the task.xml generator gives UTF-16LE XML with a BOM and the expected triggers, principal and
// action; the setter's EncodedCommand decodes to the setter script. Returns rows { name, pass, detail } (pass null =
// SKIP).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { INSTALL_ONLY, OWN_FILES, packageLibFiles, REQUIRED_SHARED, STILL_SHARED } from '../build/still.mjs';

export const piece = 'still';
const SMOKE_SIZE = '1280x800';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const row = (name, pass, detail = '') => ({ name: `still: ${name}`, pass, detail: String(detail) });

function listRel(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listRel(f, base));
    else out.push(path.relative(base, f).split(path.sep).join('/'));
  }
  return out.sort();
}

export async function validate(vctx = {}) {
  const root = vctx.root || path.resolve(HERE, '..', '..');
  const dist = vctx.dist || path.join(root, 'dist');
  const pkg = path.join(dist, 'still');
  const rows = [];
  if (!fs.existsSync(pkg)) {
    rows.push(row('package dist/still', null, 'not built (node tools/build.mjs --no-sync still)'));
    rows[0].skip = true;
    return rows;
  }

  // 1. files and byte identity
  const pairs = [];
  for (const f of OWN_FILES) pairs.push([path.join(root, 'src', 'still', f), path.join(pkg, f)]);
  for (const f of packageLibFiles(path.join(root, 'src', 'still', 'lib'))) pairs.push([path.join(root, 'src', 'still', 'lib', f), path.join(pkg, 'lib', f)]);
  for (const f of STILL_SHARED) {
    const src = path.join(root, 'src', 'shared', f);
    if (fs.existsSync(src) || REQUIRED_SHARED.includes(f)) pairs.push([src, path.join(pkg, 'shared', f)]);
  }
  const vendorDir = path.join(root, 'vendor', 'pixelclock');
  const vendorWanted = ['simulator/engine.js', 'simulator/schedule.js', 'simulator/screens.js', 'tools/render.js',
    ...listRel(path.join(vendorDir, 'simulator', 'themes')).map((f) => `simulator/themes/${f}`)];
  for (const rel of vendorWanted) pairs.push([path.join(vendorDir, ...rel.split('/')), path.join(pkg, 'pixelclock', ...rel.split('/'))]);
  // the look's inputs: the palette and the glyph atlas
  pairs.push([path.join(root, 'design', 'tokens.json'), path.join(pkg, 'tokens.json')]);
  for (const f of listRel(path.join(root, 'design', 'atlas'))) pairs.push([path.join(root, 'design', 'atlas', f), path.join(pkg, 'atlas', f)]);
  const missing = pairs.filter(([, d]) => !fs.existsSync(d)).map(([, d]) => path.relative(dist, d).split(path.sep).join('/'));
  const differ = pairs.filter(([s, d]) => fs.existsSync(d) && (!fs.existsSync(s) || sha(s) !== sha(d))).map(([, d]) => path.relative(dist, d).split(path.sep).join('/'));
  rows.push(row('package files present', missing.length === 0, missing.length ? missing.join(', ') : `${pairs.length} files`));
  rows.push(row('package copies equal their sources (src/still, src/shared, vendor, tokens, atlas)', differ.length === 0, differ.length ? differ.join(', ') : 'byte-identical'));
  const shippedInstallOnly = INSTALL_ONLY.filter((f) => fs.existsSync(path.join(pkg, 'lib', f)));
  rows.push(row('install-time modules stay out of the package', shippedInstallOnly.length === 0, shippedInstallOnly.length ? shippedInstallOnly.join(', ') : INSTALL_ONLY.map((f) => 'src/still/lib/' + f).join(', ') + ' (used by tools/install.mjs)'));

  // 2. launcher template and forbidden calls
  const launcher = path.join(pkg, 'run-hidden.js');
  let launcherOk = false;
  let launcherDetail = 'missing';
  if (fs.existsSync(launcher)) {
    try {
      const text = fs.readFileSync(launcher, 'utf8');
      new vm.Script(text, { filename: 'run-hidden.js' });
      const holders = ['NODE', 'SCRIPT', 'ARGS', 'HEADLESS'].filter((k) => text.split(`"@${k}@"`).length !== 2);
      launcherOk = holders.length === 0;
      launcherDetail = launcherOk ? 'compiles; placeholders intact (the install fills them in)' : `placeholders missing: ${holders.join(', ')}`;
    } catch (e) {
      launcherDetail = e.message;
    }
  }
  rows.push(row('run-hidden.js is the template and compiles', launcherOk, launcherDetail));
  const codeFiles = [path.join(pkg, 'pcd-still.mjs'), launcher, ...listRel(path.join(pkg, 'lib')).map((f) => path.join(pkg, 'lib', f))].filter((f) => fs.existsSync(f));
  const bad = [];
  for (const f of codeFiles) {
    const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
    if (/ExecutionPolicy/i.test(code)) bad.push(`${path.basename(f)}: ExecutionPolicy`);
    if (/\.ps1\b/i.test(code)) bad.push(`${path.basename(f)}: .ps1`);
    if (/spawn\w*\(\s*['"][^'"]*(?:schtasks|wscript)/i.test(code)) bad.push(`${path.basename(f)}: spawns schtasks or wscript`);
  }
  rows.push(row('no -ExecutionPolicy, .ps1, schtasks or wscript calls in package code', bad.length === 0, bad.join('; ') || `${codeFiles.length} files`));

  // 3. the packaged renderer runs on its own
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-still-validate-'));
  try {
    const out = path.join(tmp, 'smoke.png');
    const env = { ...process.env, PCD_NO_WALLPAPER: '1' };
    delete env.PCD_STILL_HOME;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(pkg, 'pcd-still.mjs'), '--out', out, '--size', SMOKE_SIZE, '--at', '2026-11-15T12:00'], { encoding: 'utf8', windowsHide: true, timeout: 60000, env, cwd: tmp });
    let ok = r.status === 0 && fs.existsSync(out);
    let detail = `exit ${r.status}${r.stderr ? ': ' + r.stderr.trim().split('\n')[0] : ''}`;
    if (ok) {
      const head = fs.readFileSync(out).subarray(0, 24);
      const size = `${head.readUInt32BE(16)}x${head.readUInt32BE(20)}`;
      // the summary line: the column on the right at the wallpaper's type size, rendered from the package
      const look = /\bk=(\d+) side right, type (\d+) px\b/.exec(r.stdout || '');
      ok = head.toString('latin1', 1, 4) === 'PNG' && size === SMOKE_SIZE && !!look;
      detail = `${size} PNG, ${fs.statSync(out).size} bytes, ${Date.now() - t0} ms${look ? `, k ${look[1]}, type ${look[2]} px, column right` : ', no summary line'} (package layout, no setting, no network)`;
    }
    rows.push(row('the packaged renderer runs from dist/still', ok, detail));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 4. the task template (install-time module from the repo) and the packaged setter's command
  try {
    const task = await import(pathToFileURL(path.join(root, 'src', 'still', 'lib', 'task.mjs')).href);
    const sample = 'C:\\Users\\Sample\\AppData\\Local\\PixelClockDesktop\\still';
    const bytes = task.taskXmlBytes(task.taskXml({ stillDir: sample, userSid: 'S-1-5-21-1-2-3-1001' }));
    const t = task.parseXml(task.decodeTaskXml(bytes));
    const triggers = task.xmlChild(t, 'Triggers').children.map((c) => c.name).join(', ');
    const ok = triggers === 'CalendarTrigger, LogonTrigger, SessionStateChangeTrigger'
      && task.xmlText(t, 'Triggers/CalendarTrigger/Repetition/Interval') === 'PT15M'
      && task.xmlText(t, 'Principals/Principal/LogonType') === 'InteractiveToken'
      && task.xmlText(t, 'Actions/Exec/Command') === '%SystemRoot%\\System32\\wscript.exe'
      && task.xmlText(t, 'Actions/Exec/Arguments') === `//B //Nologo //E:jscript "${sample}\\run-hidden.js"`;
    rows.push(row('task.xml template: UTF-16LE with BOM, triggers, principal and action', ok, `${triggers}; ${bytes.length} bytes`));
    const setter = await import(pathToFileURL(path.join(pkg, 'lib', 'setter.mjs')).href);
    const text = setter.decodeCommand(setter.setterArgs(`${sample}\\out\\wall-a.png`)[4]);
    const sok = text.includes(setter.SETTER_SCRIPT) && text.includes(`-Path '${sample}\\out\\wall-a.png'`) && !/ExecutionPolicy/i.test(text);
    rows.push(row('setter EncodedCommand decodes to the setter script', sok, `${text.length} characters, style ${setter.DEFAULT_STYLE}`));
  } catch (e) {
    rows.push(row('task.xml template and setter command', false, e.message));
  }

  // 5. anchors
  const anchorsFile = path.join(pkg, 'anchors.json');
  if (fs.existsSync(anchorsFile)) {
    let ok = false;
    let detail = '';
    try {
      const a = JSON.parse(fs.readFileSync(anchorsFile, 'utf8'));
      const ids = Object.keys(a);
      const themes = listRel(path.join(pkg, 'pixelclock', 'simulator', 'themes')).length;
      ok = ids.length === themes && ids.every((id) => typeof a[id].rise === 'number' && typeof a[id].set === 'number' && Array.isArray(a[id].curve) && a[id].curve.length === 48);
      detail = `${ids.length} themes (${themes} theme files)`;
    } catch (e) {
      detail = e.message;
    }
    rows.push(row('anchors.json covers every theme', ok, detail));
  } else {
    rows.push({ name: 'still: anchors.json', pass: null, skip: true, detail: 'not built: scenes keep their own hours' });
  }
  return rows;
}
