// node --test tests/ps.test.mjs
// tools/lib/ps.mjs: Windows PowerShell 5.1 through -NoProfile -NonInteractive -EncodedCommand. Only read-only
// scripts run here (a version query and an echo); nothing is written, no -ExecutionPolicy, no .ps1 file.
import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { encodeCommand, powershellPath, psQuote, runPowerShell } from '../tools/lib/ps.mjs';

const IS_WIN = process.platform === 'win32';

test('powershellPath, psQuote and encodeCommand', () => {
  assert.match(powershellPath({ SystemRoot: 'C:\\Windows' }), /^C:\\Windows[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.equal(psQuote("it's"), "'it''s'");
  assert.equal(psQuote('$env:HOME `n'), "'$env:HOME `n'", 'single quotes keep $ and backticks literal');
  const enc = encodeCommand('Write-Output \u00b0');
  assert.equal(Buffer.from(enc, 'base64').toString('utf16le'), 'Write-Output \u00b0');
});

test('runPowerShell: Windows PowerShell 5.1, the literal survives, the arguments never weaken the policy', { skip: !IS_WIN && 'Windows only', timeout: 120000 }, () => {
  const calls = [];
  const original = cp.spawnSync;
  cp.spawnSync = function (cmd, args, opts) {
    calls.push({ cmd, args, opts });
    return original.apply(this, arguments);
  };
  syncBuiltinESMExports();
  try {
    const text = "it's a 'test' $HOME `n \u00b0";
    const r = runPowerShell(`[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n$PSVersionTable.PSVersion.Major\nWrite-Output ${psQuote(text)}`);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.equal(lines[0], '5');
    assert.equal(lines[1], text);
  } finally {
    cp.spawnSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(calls.length, 1);
  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, powershellPath());
  assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.ok(!args.some((a) => /executionpolicy|^-file$/i.test(a)));
  assert.equal(opts.windowsHide, true);
});
