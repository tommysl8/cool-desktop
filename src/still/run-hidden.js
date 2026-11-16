// PixelClock Desktop: the still-wallpaper launcher (template).
// Task Scheduler runs this file through wscript.exe, a script host that has no window. It starts
// node with the still renderer at window style 0 (hidden), waits for it and quits with node's exit
// code, so no console window ever appears. The installer writes the real copy with absolute paths
// (src/still/lib/task.mjs runHiddenJs); this template only quits with code 64.
// JScript (ES3) for Windows Script Host: var only, no let/const/arrow functions.
var NODE = "@NODE@";
var SCRIPT = "@SCRIPT@";
var ARGS = "@ARGS@";
var HEADLESS = "@HEADLESS@";
var code = 70;
try {
  if (NODE.charAt(0) === "@" || SCRIPT.charAt(0) === "@") {
    code = 64;
  } else {
    var shell = WScript.CreateObject("WScript.Shell");
    var cmd = "\"" + NODE + "\" \"" + SCRIPT + "\"" + (ARGS ? " " + ARGS : "");
    if (HEADLESS === "yes") {
      cmd = "\"" + shell.ExpandEnvironmentStrings("%SystemRoot%") + "\\System32\\conhost.exe\" --headless " + cmd;
    }
    code = shell.Run(cmd, 0, true);
  }
} catch (e) {
  code = 70;
}
WScript.Quit(code);
