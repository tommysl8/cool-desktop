// PixelClock Desktop still: the desktop-picture setter.
//
// A small Windows PowerShell 5.1 script, run as `powershell.exe -NoLogo -NoProfile -NonInteractive
// -EncodedCommand <UTF-16LE base64>` with windowsHide: no .ps1 file, never -ExecutionPolicy, no window.
// The script takes -Path, -Style (Fill, Fit or Keep) and a -DryRun switch that checks everything,
// compiles the SystemParametersInfoW signature, prints what it would do and changes nothing.
// Without -DryRun it sets HKCU\Control Panel\Desktop WallpaperStyle/TileWallpaper (only when they
// differ) and calls SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, path, SPIF_UPDATEINIFILE |
// SPIF_SENDCHANGE). Node built-ins only.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const SPI_SETDESKWALLPAPER = 20;
export const SPIF_UPDATEINIFILE = 1;
export const SPIF_SENDCHANGE = 2;
/** The picture is rendered at the screen's exact size, so Fill shows it 1:1 and still covers the screen after a resolution change. */
export const DEFAULT_STYLE = 'Fill';
/** Registry values per style: [WallpaperStyle, TileWallpaper]. Keep leaves them alone. */
export const STYLES = { Fill: ['10', '0'], Fit: ['6', '0'], Keep: null };

/** Exit codes of the setter script. */
export const SETTER_EXIT = { ok: 0, badInput: 2, apiFailed: 3, error: 4 };

/** The setter script body (a PowerShell script block with a param block). */
export const SETTER_SCRIPT = [
  'param(',
  '  [Parameter(Mandatory = $true)] [string] $Path,',
  "  [ValidateSet('Fill', 'Fit', 'Keep')] [string] $Style = 'Fill',",
  '  [switch] $DryRun',
  ')',
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }',
  'try {',
  "  if (-not [System.IO.Path]::IsPathRooted($Path) -or $Path.StartsWith('\\\\')) { 'error: the picture path must be a local absolute path'; exit 2 }",
  "  if ([System.IO.Path]::GetExtension($Path).ToLowerInvariant() -ne '.png') { 'error: the picture must be a .png file'; exit 2 }",
  "  if (-not [System.IO.File]::Exists($Path)) { 'error: no such file: ' + $Path; exit 2 }",
  "  $key = 'HKCU:\\Control Panel\\Desktop'",
  '  $now = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue',
  "  $styles = @{ Fill = @('10', '0'); Fit = @('6', '0') }",
  "  Add-Type -Namespace PixelClockDesktop -Name Desktop -MemberDefinition '[DllImport(\"user32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SystemParametersInfoW(uint uiAction, uint uiParam, string pvParam, uint fWinIni);'",
  '  $bytes = (Get-Item -LiteralPath $Path).Length',
  '  if ($DryRun) {',
  "    'dry-run: picture ' + $Path + ' (' + $bytes + ' bytes)'",
  "    if ($Style -eq 'Keep') { 'dry-run: style left as it is (' + $now.WallpaperStyle + '/' + $now.TileWallpaper + ')' }",
  "    else { 'dry-run: style ' + $now.WallpaperStyle + '/' + $now.TileWallpaper + ' -> ' + $styles[$Style][0] + '/' + $styles[$Style][1] + ' (' + $Style + ')' }",
  "    'dry-run: would call SystemParametersInfoW(20, 0, path, 3)'",
  "    'dry-run: nothing changed'",
  '    exit 0',
  '  }',
  "  if ($Style -ne 'Keep') {",
  '    $want = $styles[$Style]',
  '    if ([string]$now.WallpaperStyle -ne $want[0]) { Set-ItemProperty -LiteralPath $key -Name WallpaperStyle -Value $want[0] }',
  '    if ([string]$now.TileWallpaper -ne $want[1]) { Set-ItemProperty -LiteralPath $key -Name TileWallpaper -Value $want[1] }',
  '  }',
  '  if (-not [PixelClockDesktop.Desktop]::SystemParametersInfoW(20, 0, $Path, 3)) {',
  "    'error: SystemParametersInfoW failed, Win32 error ' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()",
  '    exit 3',
  '  }',
  "  'set: ' + $Path",
  '  exit 0',
  '} catch {',
  "  'error: ' + $_.Exception.Message",
  '  exit 4',
  '}',
].join('\n');

/** Windows PowerShell 5.1 (not pwsh): %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe. */
export function powershellPath(env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** PowerShell single-quoted literal. */
export function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** Throws unless `file` is an absolute local Windows path to a .png file with no control characters. */
export function checkPicturePath(file) {
  const s = String(file || '');
  if (!/^[A-Za-z]:\\/.test(s)) throw new Error(`setter: the picture path must be an absolute local path (got ${JSON.stringify(s)})`);
  if (/[\u0000-\u001f"<>|?*]/.test(s.slice(2))) throw new Error('setter: the picture path contains characters Windows does not allow');
  if (path.win32.extname(s).toLowerCase() !== '.png') throw new Error('setter: the picture must be a .png file');
  return s;
}

/** The full command text: the script block invoked with its parameters. */
export function setterCommand(file, { style = DEFAULT_STYLE, dryRun = false } = {}) {
  const pic = checkPicturePath(file);
  if (!Object.prototype.hasOwnProperty.call(STYLES, style)) throw new Error(`setter: unknown style ${JSON.stringify(style)} (Fill, Fit or Keep)`);
  return `& {\n${SETTER_SCRIPT}\n} -Path ${psQuote(pic)} -Style ${style}${dryRun ? ' -DryRun' : ''}\n`;
}

/** Base64 of the UTF-16LE text, as -EncodedCommand expects. */
export function encodeCommand(text) {
  return Buffer.from(String(text), 'utf16le').toString('base64');
}

/** The inverse of encodeCommand (for tests and --dry-run reports). */
export function decodeCommand(b64) {
  return Buffer.from(String(b64), 'base64').toString('utf16le');
}

/** powershell.exe arguments for the setter. */
export function setterArgs(file, opts = {}) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(setterCommand(file, opts))];
}

/**
 * Run the setter (spawnSync, hidden, 60 s timeout). opts: { style, dryRun, env, timeoutMs, spawnSync }.
 * Resolves to { status, ok, stdout, stderr, error, command, args }; never throws for a failed run.
 */
export function runSetter(file, opts = {}) {
  const { style = DEFAULT_STYLE, dryRun = false, env = process.env, timeoutMs = 60000 } = opts;
  const spawn = opts.spawnSync || spawnSync;
  const exe = powershellPath(env);
  const args = setterArgs(file, { style, dryRun });
  const r = spawn(exe, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = String((r && r.stdout) || '');
  const stderr = String((r && r.stderr) || '').replace(/#< CLIXML[\s\S]*$/, '').trim();
  const status = r && typeof r.status === 'number' ? r.status : null;
  return { status, ok: status === 0, stdout, stderr, error: (r && r.error) || null, command: exe, args };
}
