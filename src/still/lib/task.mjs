// PixelClock Desktop still: the Task Scheduler pieces, the launcher and the task.
//
// - runHiddenJs(): the wscript launcher, filled in from the run-hidden.js template with absolute paths.
// - taskXml() / taskXmlBytes(): the task definition you import with schtasks /Create /XML
//   (UTF-16LE with BOM, like Task Scheduler's own exports). This project never registers it.
// - parseXml(): a small strict XML parser used by the tests and the still validator.
// Used by tools/install.mjs at install time. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Task Scheduler path of the task (folder "PixelClock Desktop"). */
export const TASK_NAME = 'PixelClock Desktop\\Still wallpaper';
export const TASK_NS = 'http://schemas.microsoft.com/windows/2004/02/mit/task';
export const WSCRIPT = '%SystemRoot%\\System32\\wscript.exe';
export const LAUNCHER_FILE = 'run-hidden.js';
export const SCRIPT_FILE = 'pcd-still.mjs';
export const TASK_FILE = 'task.xml';
export const RUN_ARGS = ['--set'];
export const TASK_DESCRIPTION = 'PixelClock Desktop: renders the PixelClock scene as a still picture and sets it as the desktop '
  + 'background every 15 minutes, so the desktop follows the time of day and the season. It skips while a Lively '
  + 'wallpaper runs.';

/** The run-hidden.js template text (next to this lib folder: dist/still/run-hidden.js or src/still/run-hidden.js). */
export function launcherTemplate(file = path.join(HERE, '..', LAUNCHER_FILE)) {
  return fs.readFileSync(file, 'utf8');
}

const WIN_ABS = /^[A-Za-z]:\\[^\u0000-\u001f"<>|?*]*$/;

/** Throws unless `p` is an absolute local Windows path without quotes, wildcards or control characters. */
export function checkWinPath(p, label = 'path') {
  const s = String(p ?? '');
  if (!WIN_ABS.test(s)) throw new Error(`${label} must be an absolute local Windows path (got ${JSON.stringify(s)})`);
  if (s.includes('%')) throw new Error(`${label} must not contain %: ${JSON.stringify(s)}`);
  // U+2028/U+2029 end a line inside a JScript string literal.
  if (s.includes(String.fromCharCode(0x2028)) || s.includes(String.fromCharCode(0x2029))) throw new Error(`${label} contains a line separator`);
  return s;
}

/** Throws unless `sid` looks like a Windows SID (S-1-...). */
export function checkSid(sid) {
  const s = String(sid ?? '');
  if (!/^S-1-\d+(-\d+){1,14}$/.test(s)) throw new Error(`not a Windows SID: ${JSON.stringify(s)}`);
  return s;
}

/** The absolute files of an installed still folder. */
export function stillFiles(stillDir) {
  const dir = checkWinPath(stillDir, 'still folder').replace(/\\+$/, '');
  return {
    dir,
    script: path.win32.join(dir, SCRIPT_FILE),
    launcher: path.win32.join(dir, LAUNCHER_FILE),
    task: path.win32.join(dir, TASK_FILE),
  };
}

/**
 * The launcher for wscript.exe with absolute paths filled in.
 * opts: { node (node.exe), stillDir, args = ['--set'], headless = false (start node through
 * `conhost.exe --headless`, for a machine where a console window still flashes, such as one with Windows Terminal as
 * the default terminal), template }.
 */
export function runHiddenJs({ node, stillDir, args = RUN_ARGS, headless = false, template } = {}) {
  const exe = checkWinPath(node, 'node');
  if (!/\.exe$/i.test(exe)) throw new Error(`node must be an .exe file: ${JSON.stringify(exe)}`);
  const files = stillFiles(stillDir);
  for (const a of args) if (!/^--[a-z][a-z0-9-]*$/.test(a)) throw new Error(`launcher argument not allowed: ${JSON.stringify(a)}`);
  let text = template ?? launcherTemplate();
  const fill = (key, value) => {
    const token = `"@${key}@"`;
    if (text.split(token).length !== 2) throw new Error(`run-hidden.js template must contain ${token} exactly once`);
    text = text.replace(token, () => JSON.stringify(value));
  };
  fill('NODE', exe);
  fill('SCRIPT', files.script);
  fill('ARGS', args.join(' '));
  fill('HEADLESS', headless ? 'yes' : 'no');
  return text;
}

/** XML text escaping for element content and attribute values. */
export function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function localIso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * The task definition as text. opts: { stillDir, userSid, date (registration date, default now),
 * author }. Triggers: daily at 00:00 repeating every 15 minutes for 1 day, at logon and on unlock of
 * this user; runs only while the user is logged on (InteractiveToken, LeastPrivilege); IgnoreNew; runs
 * on battery; StartWhenAvailable; 2-minute limit; priority 7; never wakes the computer.
 */
export function taskXml({ stillDir, userSid, date = new Date(), author = 'PixelClock Desktop' } = {}) {
  const files = stillFiles(stillDir);
  const sid = checkSid(userSid);
  const day = localIso(date).slice(0, 10);
  const e = xmlEscape;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    `<Task version="1.2" xmlns="${TASK_NS}">`,
    '  <RegistrationInfo>',
    `    <Date>${localIso(date)}</Date>`,
    `    <Author>${e(author)}</Author>`,
    `    <Description>${e(TASK_DESCRIPTION)}</Description>`,
    `    <URI>${e('\\' + TASK_NAME)}</URI>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <CalendarTrigger>',
    '      <Repetition>',
    '        <Interval>PT15M</Interval>',
    '        <Duration>P1D</Duration>',
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    `      <StartBoundary>${day}T00:00:00</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '      <ScheduleByDay>',
    '        <DaysInterval>1</DaysInterval>',
    '      </ScheduleByDay>',
    '    </CalendarTrigger>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${sid}</UserId>`,
    '    </LogonTrigger>',
    '    <SessionStateChangeTrigger>',
    '      <Enabled>true</Enabled>',
    '      <StateChange>SessionUnlock</StateChange>',
    `      <UserId>${sid}</UserId>`,
    '    </SessionStateChangeTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${sid}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${e(WSCRIPT)}</Command>`,
    `      <Arguments>${e(`//B //Nologo //E:jscript "${files.launcher}"`)}</Arguments>`,
    `      <WorkingDirectory>${e(files.dir)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
}

/** UTF-16LE bytes with a BOM (what schtasks /XML and Task Scheduler's own exports use). */
export function taskXmlBytes(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(text), 'utf16le')]);
}

/** Decode task.xml bytes: requires the UTF-16LE BOM. */
export function decodeTaskXml(buf) {
  if (!buf || buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xfe) throw new Error('task.xml must start with the UTF-16LE BOM (FF FE)');
  if ((buf.length - 2) % 2 !== 0) throw new Error('task.xml has an odd number of UTF-16 bytes');
  return buf.subarray(2).toString('utf16le');
}

/** The commands you type (INSTALL.md). Never run by this project. */
export function schtasksCommands(stillDir) {
  const files = stillFiles(stillDir);
  const tn = `"${TASK_NAME}"`;
  return {
    create: `schtasks /Create /TN ${tn} /XML "${files.task}"`,
    run: `schtasks /Run /TN ${tn}`,
    disable: `schtasks /Change /TN ${tn} /Disable`,
    enable: `schtasks /Change /TN ${tn} /Enable`,
    remove: `schtasks /Delete /TN ${tn} /F`,
    query: `schtasks /Query /TN ${tn} /V /FO LIST`,
  };
}

// ---------------------------------------------------------------------------------------------
// A small strict XML parser: elements, attributes, text, the five named entities and numeric
// character references, comments and the XML declaration. No DOCTYPE, CDATA or processing
// instructions after the declaration. Returns the root { name, attrs, children, text }.

const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;

function decodeEntities(s, where) {
  return s.replace(/&([^;&\s]*);?/g, (m, body) => {
    if (!m.endsWith(';')) throw new Error(`XML: bare & in ${where}`);
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    const num = /^#(x[0-9a-fA-F]+|[0-9]+)$/.exec(body);
    if (num) return String.fromCodePoint(num[1][0] === 'x' ? parseInt(num[1].slice(1), 16) : parseInt(num[1], 10));
    throw new Error(`XML: unknown entity &${body}; in ${where}`);
  });
}

export function parseXml(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  let i = 0;
  const fail = (msg) => { throw new Error(`XML: ${msg} at offset ${i}`); };
  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const skipMisc = () => {
    for (;;) {
      skipWs();
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        if (end < 0) fail('unterminated comment');
        i = end + 3;
      } else return;
    }
  };
  let declaration = null;
  if (s.startsWith('<?xml', i)) {
    const end = s.indexOf('?>', i);
    if (end < 0) fail('unterminated XML declaration');
    declaration = s.slice(i, end + 2);
    if (!/^<\?xml\s+version="1\.[0-9]"(\s+encoding="[A-Za-z0-9._-]+")?(\s+standalone="(yes|no)")?\s*\?>$/.test(declaration)) fail('bad XML declaration');
    i = end + 2;
  }
  skipMisc();
  if (s.startsWith('<!DOCTYPE', i)) fail('DOCTYPE is not allowed');
  function parseElement() {
    if (s[i] !== '<') fail('expected <');
    i++;
    const m = NAME.exec(s.slice(i));
    if (!m) fail('bad element name');
    const name = m[0];
    i += name.length;
    const attrs = {};
    for (;;) {
      const before = i;
      skipWs();
      if (s.startsWith('/>', i)) { i += 2; return { name, attrs, children: [], text: '' }; }
      if (s[i] === '>') { i++; break; }
      if (i === before) fail(`expected whitespace or > in <${name}>`);
      const am = NAME.exec(s.slice(i));
      if (!am) fail(`bad attribute name in <${name}>`);
      const an = am[0];
      i += an.length;
      skipWs();
      if (s[i] !== '=') fail(`expected = after ${an}`);
      i++;
      skipWs();
      const q = s[i];
      if (q !== '"' && q !== "'") fail(`attribute ${an} must be quoted`);
      const end = s.indexOf(q, i + 1);
      if (end < 0) fail(`unterminated attribute ${an}`);
      const raw = s.slice(i + 1, end);
      if (raw.includes('<')) fail(`< in attribute ${an}`);
      if (Object.prototype.hasOwnProperty.call(attrs, an)) fail(`duplicate attribute ${an}`);
      attrs[an] = decodeEntities(raw, `attribute ${an}`);
      i = end + 1;
    }
    const children = [];
    let text = '';
    for (;;) {
      if (i >= s.length) fail(`unclosed <${name}>`);
      if (s.startsWith('</', i)) {
        i += 2;
        if (!s.startsWith(name, i)) fail(`mismatched closing tag for <${name}>`);
        i += name.length;
        skipWs();
        if (s[i] !== '>') fail(`bad closing tag for <${name}>`);
        i++;
        return { name, attrs, children, text };
      }
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        if (end < 0) fail('unterminated comment');
        i = end + 3;
        continue;
      }
      if (s.startsWith('<![CDATA[', i) || s.startsWith('<?', i) || s.startsWith('<!', i)) fail('CDATA, DOCTYPE and processing instructions are not allowed');
      if (s[i] === '<') { children.push(parseElement()); continue; }
      const next = s.indexOf('<', i);
      const raw = s.slice(i, next < 0 ? s.length : next);
      if (raw.includes('>') && raw.includes(']]>')) fail(']]> in text');
      text += decodeEntities(raw, `<${name}>`);
      i += raw.length;
    }
  }
  const root = parseElement();
  skipMisc();
  if (i !== s.length) fail('content after the root element');
  root.declaration = declaration;
  return root;
}

/** First child element called `name` (optionally a path 'A/B/C'). */
export function xmlChild(node, pathText) {
  let cur = node;
  for (const part of String(pathText).split('/')) {
    cur = cur && cur.children.find((c) => c.name === part);
    if (!cur) return null;
  }
  return cur;
}

/** Trimmed text of the child at `pathText`, or null. */
export function xmlText(node, pathText) {
  const c = xmlChild(node, pathText);
  return c ? c.text.trim() : null;
}
