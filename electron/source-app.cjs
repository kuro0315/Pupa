'use strict';
// A best-effort foreground-app hint, NOT the owner of clipboard contents.
// Caller must opt in, invoke only on changed clipboard text, and discard stale results.
// No window titles, browser URLs, process arguments, clipboard data or network calls.
const { execFile: nodeExecFile } = require('node:child_process');
const path = require('node:path');

const TIMEOUT_MS = 1200;
const MAX_OUTPUT_BYTES = 48 * 1024;
const MAX_ICON_BYTES = 32 * 1024;
const MAX_NAME_LENGTH = 120;
const PNG_PREFIX = 'data:image/png;base64,';

// AppKit's frontmostApplication receives keyboard events; it does not identify the
// clipboard owner. NSRunningApplication.icon is the app icon, not a screen capture.
// https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication
// https://developer.apple.com/documentation/appkit/nsrunningapplication/icon
const MAC_SCRIPT = String.raw`
ObjC.import('AppKit');
function run() {
  try {
    var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!app || app.isNil()) return 'null';
    var result = { name: ObjC.unwrap(app.localizedName) || ObjC.unwrap(app.bundleIdentifier) || '' };
    result.name = String(result.name).slice(0, 240);
    try {
      var icon = app.icon;
      var small = $.NSImage.alloc.initWithSize($.NSMakeSize(64, 64));
      small.lockFocus;
      try {
        icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 64, 64), $.NSZeroRect, $.NSCompositingOperationCopy, 1);
      } finally { small.unlockFocus; }
      var bitmap = $.NSBitmapImageRep.imageRepWithData(small.TIFFRepresentation);
      var png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
      if (png.length > 0 && png.length <= 32768) {
        result.icon = 'data:image/png;base64,' + ObjC.unwrap(png.base64EncodedStringWithOptions(0));
      }
    } catch (_) {}
    return JSON.stringify(result);
  } catch (_) { return 'null'; }
}
`;

// Fixed script only: no clipboard or application data is interpolated into code.
// ProcessName is an executable name, not MainWindowTitle or a command line.
// Only a fixed local drive is allowed for icon extraction (never a UNC share).
// https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow
// https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid
// https://learn.microsoft.com/en-us/dotnet/api/system.drawing.icon.extractassociatedicon
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PupaForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
}
'@
  $handle = [PupaForeground]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) { 'null'; exit }
  [uint32]$foregroundProcessId = 0
  $threadId = [PupaForeground]::GetWindowThreadProcessId($handle, [ref]$foregroundProcessId)
  if ($threadId -eq 0 -or $foregroundProcessId -eq 0) { 'null'; exit }
  $foregroundProcess = [System.Diagnostics.Process]::GetProcessById($foregroundProcessId)
  try {
    $name = $foregroundProcess.ProcessName
    if ($name.Length -gt 240) { $name = $name.Substring(0, 240) }
    $result = @{ name = $name }
    try {
      $file = $foregroundProcess.MainModule.FileName
      if ($file -match '^[A-Za-z]:\\' -and ([System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($file))).DriveType -eq [System.IO.DriveType]::Fixed) {
        Add-Type -AssemblyName System.Drawing
        $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($file)
        if ($null -ne $icon) {
          try {
            $original = $icon.ToBitmap()
            try {
              $small = [System.Drawing.Bitmap]::new($original, 64, 64)
              try {
                $stream = [System.IO.MemoryStream]::new()
                try {
                  $small.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                  if ($stream.Length -gt 0 -and $stream.Length -le 32768) {
                    $result.icon = 'data:image/png;base64,' + [Convert]::ToBase64String($stream.ToArray())
                  }
                } finally { $stream.Dispose() }
              } finally { $small.Dispose() }
            } finally { $original.Dispose() }
          } finally { $icon.Dispose() }
        }
      }
    } catch {}
    $result | ConvertTo-Json -Compress
  } finally { $foregroundProcess.Dispose() }
} catch { 'null' }
`;

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim())
    .slice(0, MAX_NAME_LENGTH).join('');
}

function sanitizeIcon(value) {
  if (typeof value !== 'string' || !value.startsWith(PNG_PREFIX)) return undefined;
  const encoded = value.slice(PNG_PREFIX.length);
  if (!encoded || encoded.length > Math.ceil(MAX_ICON_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, 'base64');
  // A strict PNG-only allowlist with bounded decoded size/dimensions; never URLs,
  // SVG, file paths or HTML. A browser still decides whether the PNG is decodable.
  if (bytes.length < 33 || bytes.length > MAX_ICON_BYTES || bytes.toString('base64') !== encoded
      || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 256 || height > 256) return undefined;
  return value;
}

function sanitizeSourceApp(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = cleanName(value.name);
  if (!name) return null;
  const icon = sanitizeIcon(value.icon);
  return { name, ...(icon ? { icon } : {}), kind: 'foreground' };
}

function parseSourceOutput(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_OUTPUT_BYTES) return null;
  try { return sanitizeSourceApp(JSON.parse(output.replace(/^\uFEFF/, '').trim())); } catch { return null; }
}

function parseX11WindowId(output) {
  if (typeof output !== 'string' || output.length > 256) return null;
  const match = /^_NET_ACTIVE_WINDOW\(WINDOW\): window id # (0x[\da-f]{1,8})\s*$/i.exec(output.trim());
  return match && Number.parseInt(match[1], 16) !== 0 ? match[1].toLowerCase() : null;
}

function parseX11Class(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_OUTPUT_BYTES) return null;
  // Use only res_class (second string), not the customizable instance name.
  const match = /^WM_CLASS(?:\(STRING\))?\s*=\s*"(?:[^"\\\r\n]|\\.)*",\s*("(?:[^"\\\r\n]|\\.)*")\s*$/.exec(output.trim());
  if (!match) return null;
  try { return sanitizeSourceApp({ name: JSON.parse(match[1]) }); } catch { return null; }
}

/** execFile injection has Node's callback signature; tests never query a real OS.
 * signal is optional and allows callers to cancel enrichment after pause/clear.
 * Linux X11 currently returns a WM_CLASS label only. Wayland is unknown rather
 * than bypassing compositor permissions or querying a partial XWayland view.
 */
async function detectSourceApp({ platform = process.platform, wayland = false,
  execFile = nodeExecFile, now = Date.now, signal } = {}) {
  if (signal?.aborted || !['darwin', 'win32', 'linux'].includes(platform) || (platform === 'linux' && wayland)) return null;
  const deadline = now() + TIMEOUT_MS;
  const run = (executable, args) => new Promise(resolve => {
    const remaining = Math.min(TIMEOUT_MS, Math.floor(deadline - now()));
    if (remaining <= 0 || signal?.aborted) { resolve(null); return; }
    try {
      execFile(executable, args, { encoding: 'utf8', timeout: remaining,
        maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell: false,
        killSignal: 'SIGKILL', ...(signal ? { signal } : {}),
        ...(platform === 'linux' ? { env: { ...process.env, XPROPFORMATS: '' } } : {}),
      }, (error, stdout) => {
        resolve(error || signal?.aborted || now() > deadline || typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES ? null : stdout);
      });
    } catch { resolve(null); }
  });
  try {
    if (platform === 'darwin') return parseSourceOutput(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT]));
    if (platform === 'win32') {
      const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return parseSourceOutput(await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')]));
    }
    // https://specifications.freedesktop.org/wm/latest-single/#id-1.3.9
    const windowId = parseX11WindowId(await run('/usr/bin/xprop', ['-root', '_NET_ACTIVE_WINDOW']));
    if (!windowId) return null;
    return parseX11Class(await run('/usr/bin/xprop', ['-id', windowId, '-notype', 'WM_CLASS']));
  } catch { return null; }
}

module.exports = { detectSourceApp, sanitizeSourceApp, sanitizeIcon, parseSourceOutput,
  parseX11WindowId, parseX11Class, TIMEOUT_MS, MAX_OUTPUT_BYTES, MAX_ICON_BYTES, MAX_NAME_LENGTH };
