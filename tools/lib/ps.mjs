// Windows PowerShell 5.1 helpers.
// Build- and test-time module, never shipped. Node built-ins only. Never uses -File, .ps1 files or
// -ExecutionPolicy; no window is ever shown (windowsHide). Callers decide what a script may do: tests only
// run read-only scripts or dry runs.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** Windows PowerShell 5.1 (not pwsh): %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe. */
export function powershellPath(env = process.env) {
  return path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** PowerShell single-quoted literal. */
export function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** A script as the base64 of its UTF-16LE bytes, the form -EncodedCommand expects. */
export function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * Run a script with -NoProfile -NonInteractive -EncodedCommand (no quoting problems, no profile).
 * Resolves { status, stdout, stderr, error }.
 */
export function runPowerShell(script, { timeoutMs = 60000, env = process.env } = {}) {
  const r = spawnSync(powershellPath(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}
