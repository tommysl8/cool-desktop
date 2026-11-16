// Still setter, launcher and task template. Nothing here sets the wallpaper,
// runs wscript or schtasks, or registers a task: PowerShell runs only the setter's -DryRun path, the
// read-only screen query, and Task Scheduler's XML parser on an unregistered definition.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import zlib from 'node:zlib';
import {
  checkPicturePath, decodeCommand, DEFAULT_STYLE, encodeCommand, powershellPath, psQuote, runSetter, SETTER_SCRIPT, setterArgs, setterCommand,
} from '../src/still/lib/setter.mjs';
import {
  checkSid, decodeTaskXml, launcherTemplate, parseXml, runHiddenJs, schtasksCommands, stillFiles, TASK_NAME, taskXml, taskXmlBytes, xmlChild, xmlText,
} from '../src/still/lib/task.mjs';
import { DETECT_SCRIPT, parseDetect, runPowerShell } from '../src/still/lib/env.mjs';
import { rm, STILL, tempHome } from './still-helpers.mjs';

const WIN = process.platform === 'win32';
const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
const STILL_DIR = "C:\\Users\\Ann O'Neil & Co\\AppData\\Local\\PixelClockDesktop\\still";
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';

/** A valid 1x1 PNG. */
function tinyPng() {
  const chunk = (t, d) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t, 'latin1'), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([l, td, c]);
  };
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 20, 16, 22]))), chunk('IEND', Buffer.alloc(0))]);
}

test('setter: the EncodedCommand decodes (UTF-16LE base64) to the script with the right path, style and switch; never -ExecutionPolicy', () => {
  const pic = "C:\\Users\\Ann O'Neil\\AppData\\Local\\PixelClockDesktop\\still\\out\\wall-b.png";
  const args = setterArgs(pic);
  assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(args.length, 5);
  const text = decodeCommand(args[4]);
  assert.equal(Buffer.from(text, 'utf16le').toString('base64'), args[4], 'UTF-16LE round trip');
  assert.equal(text, setterCommand(pic));
  assert.ok(text.startsWith('& {\nparam('));
  assert.ok(text.includes(SETTER_SCRIPT));
  assert.ok(text.endsWith(`} -Path 'C:\\Users\\Ann O''Neil\\AppData\\Local\\PixelClockDesktop\\still\\out\\wall-b.png' -Style Fill\n`));
  assert.ok(!text.includes('-DryRun\n'), 'no -DryRun unless asked');
  assert.ok(decodeCommand(setterArgs(pic, { dryRun: true })[4]).endsWith(' -Style Fill -DryRun\n'));
  assert.ok(decodeCommand(setterArgs(pic, { style: 'Keep' })[4]).endsWith(' -Style Keep\n'));
  assert.equal(DEFAULT_STYLE, 'Fill');
  for (const s of [text, args.join(' ')]) {
    assert.doesNotMatch(s, /ExecutionPolicy|\.ps1\b|-File\b|Invoke-Expression|\biex\b/i);
  }
  assert.match(SETTER_SCRIPT, /SystemParametersInfoW\(20, 0, \$Path, 3\)/);
  assert.match(SETTER_SCRIPT, /Add-Type/);
  assert.match(SETTER_SCRIPT, /\[switch\] \$DryRun/);
  assert.match(powershellPath({ SystemRoot: 'C:\\Windows' }), /^C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.equal(psQuote("it's"), "'it''s'");
  assert.equal(encodeCommand('ab'), Buffer.from('ab', 'utf16le').toString('base64'));
  for (const bad of ['wall.png', '\\\\server\\share\\wall.png', 'C:\\x\\wall.jpg', 'C:\\x\\"wall".png', 'C:\\x\\wall\n.png']) {
    assert.throws(() => checkPicturePath(bad), /setter/, bad);
  }
  assert.throws(() => setterCommand('C:\\x\\wall.png', { style: 'Tile' }), /unknown style/);
});

test('setter: runSetter spawns hidden powershell.exe with those arguments (spawn stub) and reports failures', () => {
  const calls = [];
  const fake = (exe, args, opts) => { calls.push({ exe, args, opts }); return { status: 0, stdout: 'set: x\n', stderr: '' }; };
  const r = runSetter('C:\\x\\wall-a.png', { spawnSync: fake, env: { SystemRoot: 'C:\\Windows' } });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(calls[0].opts.windowsHide, true);
  assert.deepEqual(calls[0].args, setterArgs('C:\\x\\wall-a.png'));
  const failed = runSetter('C:\\x\\wall-a.png', { spawnSync: () => ({ status: 3, stdout: 'error: SystemParametersInfoW failed, Win32 error 5\n', stderr: '#< CLIXML\n<Objs/>' }) });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 3);
  assert.equal(failed.stderr, '');
  const crashed = runSetter('C:\\x\\wall-a.png', { spawnSync: () => ({ status: null, error: new Error('spawn ENOENT') }) });
  assert.equal(crashed.ok, false);
  assert.equal(crashed.error.message, 'spawn ENOENT');
});

test('setter: the real PowerShell -DryRun prints the plan and changes nothing (registry read before and after)', { skip: !WIN && 'Windows only' }, () => {
  const dir = tempHome();
  try {
    const sub = path.join(dir, "it's a folder");
    fs.mkdirSync(sub);
    const pic = path.join(sub, 'wall-a.png');
    fs.writeFileSync(pic, tinyPng());
    const read = "$d = Get-ItemProperty -LiteralPath 'HKCU:\\Control Panel\\Desktop'; [pscustomobject]@{ w = [string]$d.Wallpaper; s = [string]$d.WallpaperStyle; t = [string]$d.TileWallpaper } | ConvertTo-Json -Compress";
    const before = runPowerShell(read);
    assert.equal(before.status, 0, before.stderr);
    const r = runSetter(pic, { dryRun: true });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.equal(lines[0], `dry-run: picture ${pic} (${fs.statSync(pic).size} bytes)`);
    assert.match(lines[1], /^dry-run: style \S*\/\S* -> 10\/0 \(Fill\)$/);
    assert.equal(lines[2], 'dry-run: would call SystemParametersInfoW(20, 0, path, 3)');
    assert.equal(lines[3], 'dry-run: nothing changed');
    const keep = runSetter(pic, { dryRun: true, style: 'Keep' });
    assert.equal(keep.status, 0);
    assert.match(keep.stdout, /dry-run: style left as it is/);
    const missing = runSetter(path.join(sub, 'nope.png'), { dryRun: true });
    assert.equal(missing.status, 2);
    assert.match(missing.stdout, /error: no such file/);
    const after = runPowerShell(read);
    assert.equal(after.stdout, before.stdout, 'desktop picture and style unchanged');
  } finally {
    rm(dir);
  }
});

test('launcher: run-hidden.js compiles (node:vm), holds only absolute install paths and runs node hidden with --set', () => {
  const tpl = launcherTemplate();
  for (const key of ['NODE', 'SCRIPT', 'ARGS', 'HEADLESS']) assert.equal(tpl.split(`"@${key}@"`).length, 2, `placeholder ${key}`);
  for (const src of [tpl, runHiddenJs({ node: NODE_EXE, stillDir: STILL_DIR })]) {
    new vm.Script(src, { filename: 'run-hidden.js' });
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /\blet\b|\bconst\b|=>|`|\bclass\b/, 'JScript (ES3) only');
  }
  const js = runHiddenJs({ node: NODE_EXE, stillDir: STILL_DIR });
  assert.ok(!js.includes('@NODE@') && !js.includes('@SCRIPT@'));
  const literals = [...js.matchAll(/^var (NODE|SCRIPT) = (".*");$/gm)].map((m) => [m[1], JSON.parse(m[2])]);
  assert.deepEqual(literals, [['NODE', NODE_EXE], ['SCRIPT', `${STILL_DIR}\\pcd-still.mjs`]]);
  for (const [, p] of literals) assert.match(p, /^[A-Za-z]:\\/, 'absolute');

  /** Run the launcher with a fake Windows Script Host; returns what it asked the shell to do. */
  function simulate(src, exitCode = 0) {
    const runs = [];
    let quit = null;
    const shell = {
      Run(cmd, style, wait) { runs.push({ cmd, style, wait }); return exitCode; },
      ExpandEnvironmentStrings(s) { return s.replace('%SystemRoot%', 'C:\\Windows'); },
    };
    const WScript = { CreateObject(name) { assert.equal(name, 'WScript.Shell'); return shell; }, Quit(c) { quit = c; } };
    vm.runInNewContext(src, { WScript });
    return { runs, quit };
  }
  const run = simulate(js, 7);
  assert.deepEqual(run.runs, [{ cmd: `"${NODE_EXE}" "${STILL_DIR}\\pcd-still.mjs" --set`, style: 0, wait: true }]);
  assert.equal(run.quit, 7, 'quits with node\'s exit code');
  const unfilled = simulate(tpl);
  assert.deepEqual(unfilled.runs, [], 'the template itself runs nothing');
  assert.equal(unfilled.quit, 64);
  const headless = simulate(runHiddenJs({ node: NODE_EXE, stillDir: STILL_DIR, headless: true }));
  assert.equal(headless.runs[0].cmd, `"C:\\Windows\\System32\\conhost.exe" --headless "${NODE_EXE}" "${STILL_DIR}\\pcd-still.mjs" --set`);
  assert.equal(headless.runs[0].style, 0);
  for (const bad of [{ node: 'node.exe', stillDir: STILL_DIR }, { node: NODE_EXE, stillDir: 'still' }, { node: 'C:\\node\\node', stillDir: STILL_DIR }, { node: NODE_EXE, stillDir: 'C:\\a"b' }, { node: NODE_EXE, stillDir: 'C:\\%TEMP%\\x' }, { node: NODE_EXE, stillDir: STILL_DIR, args: ['--set', '& calc'] }]) {
    assert.throws(() => runHiddenJs(bad), Error, JSON.stringify(bad));
  }
});

test('task.xml: UTF-16LE with BOM, well formed, with the exact triggers, principal, settings and action', () => {
  const xml = taskXml({ stillDir: STILL_DIR, userSid: SID, date: new Date(2026, 10, 15, 16, 30, 5) });
  const bytes = taskXmlBytes(xml);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(bytes.subarray(2).toString('utf16le'), xml);
  assert.equal(decodeTaskXml(bytes), xml);
  assert.throws(() => decodeTaskXml(Buffer.from(xml, 'utf8')), /BOM/);
  const t = parseXml(decodeTaskXml(bytes));
  assert.equal(t.declaration, '<?xml version="1.0" encoding="UTF-16"?>');
  assert.equal(t.name, 'Task');
  assert.deepEqual(t.attrs, { version: '1.2', xmlns: 'http://schemas.microsoft.com/windows/2004/02/mit/task' });
  assert.deepEqual(t.children.map((c) => c.name), ['RegistrationInfo', 'Triggers', 'Principals', 'Settings', 'Actions']);
  assert.equal(xmlText(t, 'RegistrationInfo/Date'), '2026-11-15T16:30:05');
  assert.equal(xmlText(t, 'RegistrationInfo/URI'), '\\PixelClock Desktop\\Still wallpaper');
  const triggers = xmlChild(t, 'Triggers').children;
  assert.deepEqual(triggers.map((c) => c.name), ['CalendarTrigger', 'LogonTrigger', 'SessionStateChangeTrigger']);
  assert.equal(xmlText(triggers[0], 'Repetition/Interval'), 'PT15M');
  assert.equal(xmlText(triggers[0], 'Repetition/Duration'), 'P1D');
  assert.equal(xmlText(triggers[0], 'Repetition/StopAtDurationEnd'), 'false');
  assert.equal(xmlText(triggers[0], 'StartBoundary'), '2026-11-15T00:00:00');
  assert.equal(xmlText(triggers[0], 'ScheduleByDay/DaysInterval'), '1');
  assert.equal(xmlText(triggers[1], 'UserId'), SID);
  assert.equal(xmlText(triggers[2], 'StateChange'), 'SessionUnlock');
  assert.equal(xmlText(triggers[2], 'UserId'), SID);
  for (const tr of triggers) assert.equal(xmlText(tr, 'Enabled'), 'true');
  const p = xmlChild(t, 'Principals/Principal');
  assert.equal(p.attrs.id, 'Author');
  assert.deepEqual([xmlText(p, 'UserId'), xmlText(p, 'LogonType'), xmlText(p, 'RunLevel')], [SID, 'InteractiveToken', 'LeastPrivilege']);
  const s = xmlChild(t, 'Settings');
  const want = {
    MultipleInstancesPolicy: 'IgnoreNew', DisallowStartIfOnBatteries: 'false', StopIfGoingOnBatteries: 'false', StartWhenAvailable: 'true',
    ExecutionTimeLimit: 'PT2M', Priority: '7', WakeToRun: 'false', Enabled: 'true', Hidden: 'false', RunOnlyIfNetworkAvailable: 'false', RunOnlyIfIdle: 'false',
  };
  for (const [k, v] of Object.entries(want)) assert.equal(xmlText(s, k), v, k);
  const a = xmlChild(t, 'Actions');
  assert.equal(a.attrs.Context, 'Author');
  assert.equal(xmlText(a, 'Exec/Command'), '%SystemRoot%\\System32\\wscript.exe');
  assert.equal(xmlText(a, 'Exec/Arguments'), `//B //Nologo //E:jscript "${STILL_DIR}\\run-hidden.js"`);
  assert.equal(xmlText(a, 'Exec/WorkingDirectory'), STILL_DIR);
  assert.ok(xml.includes("Ann O&apos;Neil &amp; Co"), 'paths are escaped');
  assert.throws(() => taskXml({ stillDir: STILL_DIR, userSid: 'someone' }), /not a Windows SID/);
  assert.throws(() => taskXml({ stillDir: '.\\still', userSid: SID }), /absolute/);
  assert.equal(checkSid(SID), SID);
});

test('task.xml: the small XML parser rejects malformed input', () => {
  for (const bad of ['<a><b></a>', '<a>x & y</a>', '<a x="1" x="2"/>', '<!DOCTYPE a><a/>', '<a/><b/>', '<a x=1/>', '<a>&bogus;</a>', '<a>']) {
    assert.throws(() => parseXml(bad), /XML/, bad);
  }
  const ok = parseXml('<?xml version="1.0"?>\n<!-- c --><a k=\'v &amp; w\'><b>1 &lt; 2 &#65;&#x42;</b><c/></a>\n');
  assert.equal(ok.attrs.k, 'v & w');
  assert.equal(xmlText(ok, 'b'), '1 < 2 AB');
  assert.ok(xmlChild(ok, 'c'));
});

test('task.xml: Task Scheduler\'s own parser accepts it (an unregistered definition; nothing is registered)', { skip: !WIN && 'Windows only' }, () => {
  const dir = tempHome();
  try {
    const file = path.join(dir, 'task.xml');
    fs.writeFileSync(file, taskXmlBytes(taskXml({ stillDir: STILL_DIR, userSid: SID })));
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$f = ${psQuote(file)}`,
      '$svc = New-Object -ComObject Schedule.Service',
      '$svc.Connect()',
      '$def = $svc.NewTask(0)',
      '$def.XmlText = [System.IO.File]::ReadAllText($f)',
      '$t = @($def.Triggers | ForEach-Object { [pscustomobject]@{ type = $_.Type; start = $_.StartBoundary; interval = $_.Repetition.Interval; duration = $_.Repetition.Duration; user = $_.UserId } })',
      '$sc = @($def.Triggers | Where-Object { $_.Type -eq 11 } | ForEach-Object { $_.StateChange })',
      '$a = @($def.Actions | ForEach-Object { [pscustomobject]@{ type = $_.Type; path = $_.Path; args = $_.Arguments; wd = $_.WorkingDirectory } })',
      '$s = $def.Settings',
      '[pscustomobject]@{ triggers = $t; stateChange = $sc; actions = $a; logon = $def.Principal.LogonType; runLevel = $def.Principal.RunLevel; user = $def.Principal.UserId; multi = $s.MultipleInstances; battery = $s.DisallowStartIfOnBatteries; stopBattery = $s.StopIfGoingOnBatteries; available = $s.StartWhenAvailable; limit = $s.ExecutionTimeLimit; priority = $s.Priority; wake = $s.WakeToRun } | ConvertTo-Json -Depth 5 -Compress',
    ].join('\n');
    assert.doesNotMatch(script, /Register|schtasks/i, 'the check never registers anything');
    const r = runPowerShell(script);
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout.trim());
    assert.deepEqual(d.triggers.map((x) => x.type), [2, 9, 11], 'daily, logon, session state change');
    assert.deepEqual([d.triggers[0].interval, d.triggers[0].duration], ['PT15M', 'P1D']);
    assert.deepEqual(d.stateChange, [8], 'TASK_SESSION_UNLOCK');
    assert.equal(d.triggers[1].user, SID);
    assert.deepEqual([d.logon, d.runLevel, d.user], [3, 0, SID], 'InteractiveToken, LeastPrivilege');
    assert.deepEqual([d.multi, d.battery, d.stopBattery, d.available, d.limit, d.priority, d.wake], [2, false, false, true, 'PT2M', 7, false]);
    assert.deepEqual(d.actions, [{ type: 0, path: '%SystemRoot%\\System32\\wscript.exe', args: `//B //Nologo //E:jscript "${STILL_DIR}\\run-hidden.js"`, wd: STILL_DIR }]);
  } finally {
    rm(dir);
  }
});

test('schtasks commands for INSTALL.md (strings only) and the installed file names', () => {
  const c = schtasksCommands(STILL_DIR);
  assert.equal(TASK_NAME, 'PixelClock Desktop\\Still wallpaper');
  assert.equal(c.create, `schtasks /Create /TN "PixelClock Desktop\\Still wallpaper" /XML "${STILL_DIR}\\task.xml"`);
  assert.equal(c.run, 'schtasks /Run /TN "PixelClock Desktop\\Still wallpaper"');
  assert.equal(c.disable, 'schtasks /Change /TN "PixelClock Desktop\\Still wallpaper" /Disable');
  assert.equal(c.remove, 'schtasks /Delete /TN "PixelClock Desktop\\Still wallpaper" /F');
  assert.deepEqual(stillFiles(STILL_DIR + '\\'), { dir: STILL_DIR, script: `${STILL_DIR}\\pcd-still.mjs`, launcher: `${STILL_DIR}\\run-hidden.js`, task: `${STILL_DIR}\\task.xml` });
});

test('the real screen query is read-only and finds a resolution (Win32_VideoController + AppliedDPI)', { skip: !WIN && 'Windows only' }, () => {
  const r = runPowerShell(DETECT_SCRIPT);
  assert.equal(r.status, 0, r.stderr);
  const d = parseDetect(r.stdout);
  console.log(`  screen: ${d.width}x${d.height}, scale ${d.scale} (${d.dpi} dpi), adapters: ${d.adapters.map((a) => `${a.name} ${a.width}x${a.height}`).join('; ')}`);
  assert.ok(d.width >= 640 && d.height >= 480, `${d.width}x${d.height}`);
  assert.ok(d.scale >= 1 && d.scale <= 4);
});

test('nothing in the still package calls -ExecutionPolicy, writes a .ps1, runs schtasks or wscript', () => {
  const dir = STILL;
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(f); } };
  walk(dir);
  assert.ok(files.length >= 7);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    // code only: full-line // comments and /* */ comment lines are prose that may name what is forbidden
    const code = text.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /ExecutionPolicy/i, f);
    assert.doesNotMatch(code, /\.ps1\b/i, f);
    assert.doesNotMatch(code, /spawn\w*\(\s*['"][^'"]*(?:schtasks|wscript)/i, f);
    assert.ok(!text.startsWith('\uFEFF') && !text.includes('\r\n'), `${f}: UTF-8 without BOM, LF`);
  }
  assert.ok(os.EOL);
});
