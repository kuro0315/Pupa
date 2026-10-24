//! Opt-in foreground application hints, not clipboard ownership.
//!
//! The caller must query only for changed text, off the UI thread, and reject
//! results whose capture/generation is stale after pause, clear, showing Pupa,
//! source-app disable, lock or suspend. Cancellation is optional; all queries
//! share one 1.2-second deadline and never read clipboard/window-title content.
use crate::history::{sanitize_source, EntrySource};
use std::{
    io::{self, Read},
    process::{Child, ChildStdout, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_millis(1200);
const MAX_OUTPUT_BYTES: usize = 48 * 1024;

// Fixed scripts; no application/clipboard data is interpolated into executable
// code. The Windows executable icon must be on a fixed local drive, never UNC.
// https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication
// https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow
const MAC_SCRIPT: &str = r###"
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
"###;
const WINDOWS_SCRIPT: &str = r###"
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
"###;

#[derive(Clone, Copy)]
enum Platform {
    Mac,
    Windows,
    Linux,
    Other,
}

pub fn detect_source_app(wayland: bool) -> Option<EntrySource> {
    detect_source_app_with_cancel(wayland, &AtomicBool::new(false))
}

/// Cancelling terminates the current subprocess and returns unknown. The caller
/// must still validate its generation after return: cancellation can race a
/// completed query, and an app hint is never proof of clipboard ownership.
pub fn detect_source_app_with_cancel(wayland: bool, cancelled: &AtomicBool) -> Option<EntrySource> {
    let platform = if cfg!(target_os = "macos") {
        Platform::Mac
    } else if cfg!(target_os = "windows") {
        Platform::Windows
    } else if cfg!(target_os = "linux") {
        Platform::Linux
    } else {
        Platform::Other
    };
    detect_with(
        platform,
        wayland,
        Instant::now() + TIMEOUT,
        cancelled,
        run_bounded,
    )
}

fn detect_with(
    platform: Platform,
    wayland: bool,
    deadline: Instant,
    cancelled: &AtomicBool,
    mut run: impl FnMut(&str, &[String], Instant, &AtomicBool) -> Option<String>,
) -> Option<EntrySource> {
    let current = || !cancelled.load(Ordering::Acquire) && Instant::now() < deadline;
    if !current() {
        return None;
    }
    let result = match platform {
        Platform::Mac => parse_source_output(&run(
            "/usr/bin/osascript",
            &[
                "-l".into(),
                "JavaScript".into(),
                "-e".into(),
                MAC_SCRIPT.into(),
            ],
            deadline,
            cancelled,
        )?),
        Platform::Windows => {
            use base64::{engine::general_purpose::STANDARD, Engine};
            let script: Vec<u8> = WINDOWS_SCRIPT
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect();
            let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
            let executable = std::path::PathBuf::from(root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            parse_source_output(&run(
                executable.to_str()?,
                &[
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-EncodedCommand".into(),
                    STANDARD.encode(script),
                ],
                deadline,
                cancelled,
            )?)
        }
        Platform::Linux if !wayland => {
            let id = parse_x11_window_id(&run(
                "/usr/bin/xprop",
                &["-root".into(), "_NET_ACTIVE_WINDOW".into()],
                deadline,
                cancelled,
            )?)?;
            if !current() {
                return None;
            }
            parse_x11_class(&run(
                "/usr/bin/xprop",
                &["-id".into(), id, "-notype".into(), "WM_CLASS".into()],
                deadline,
                cancelled,
            )?)
        }
        _ => None,
    };
    current().then_some(result).flatten()
}

fn clean_name(value: &str) -> String {
    let clean: String = value
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect();
    clean
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(120)
        .collect()
}

fn parse_source_output(output: &str) -> Option<EntrySource> {
    if output.len() > MAX_OUTPUT_BYTES {
        return None;
    }
    let value: serde_json::Value =
        serde_json::from_str(output.trim_start_matches('\u{feff}').trim()).ok()?;
    let object = value.as_object()?;
    sanitize_source(EntrySource {
        name: clean_name(object.get("name")?.as_str()?),
        kind: "foreground".into(),
        icon: object
            .get("icon")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    })
}

fn parse_x11_window_id(output: &str) -> Option<String> {
    if output.len() > 256 {
        return None;
    }
    let output = output.trim();
    let prefix = "_NET_ACTIVE_WINDOW(WINDOW): window id # ";
    let (head, value) = output.split_at_checked(prefix.len())?;
    if !head.eq_ignore_ascii_case(prefix)
        || !(3..=10).contains(&value.len())
        || !value.get(..2)?.eq_ignore_ascii_case("0x")
        || !value[2..].bytes().all(|c| c.is_ascii_hexdigit())
        || u32::from_str_radix(&value[2..], 16).ok()? == 0
    {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

fn consume_string(input: &str) -> Option<(String, &str)> {
    let mut stream = serde_json::Deserializer::from_str(input).into_iter::<String>();
    let value = stream.next()?.ok()?;
    Some((value, &input[stream.byte_offset()..]))
}

fn parse_x11_class(output: &str) -> Option<EntrySource> {
    if output.len() > MAX_OUTPUT_BYTES {
        return None;
    }
    let rest = output.trim().strip_prefix("WM_CLASS")?;
    let rest = rest.strip_prefix("(STRING)").unwrap_or(rest).trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let (_, rest) = consume_string(rest)?; // instance is intentionally discarded
    let rest = rest.trim_start().strip_prefix(',')?.trim_start();
    let (name, rest) = consume_string(rest)?;
    if !rest.trim().is_empty() {
        return None;
    }
    sanitize_source(EntrySource {
        name: clean_name(&name),
        kind: "foreground".into(),
        icon: None,
    })
}

// No shell, no stdin, no inherited stderr or command output logging. stdout is
// nonblocking, bounded and checked against the shared deadline on every read.
fn run_bounded(
    executable: &str,
    args: &[String],
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Option<String> {
    if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
        return None;
    }
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "linux")]
    command.env("XPROPFORMATS", "");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().ok()?;
    let result = read_child_output(&mut child, deadline, cancelled);
    if result.is_none() {
        let _ = child.kill();
        // Do not let process teardown extend the foreground-query deadline.
        let _ = thread::Builder::new()
            .name("pupa-source-reaper".into())
            .spawn(move || {
                let _ = child.wait();
            });
    }
    result
}

fn read_child_output(
    child: &mut Child,
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Option<String> {
    let mut stdout = child.stdout.take()?;
    make_nonblocking(&stdout).ok()?;
    let mut output = Vec::with_capacity(4096);
    let mut buffer = [0; 4096];
    let mut exited = false;
    let mut eof = false;
    loop {
        if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
            return None;
        }
        if !eof {
            match read_available(&mut stdout, &mut buffer) {
                Ok(0) => eof = true,
                Ok(count) => {
                    if output.len() + count > MAX_OUTPUT_BYTES {
                        return None;
                    }
                    output.extend_from_slice(&buffer[..count]);
                    continue;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return None,
            }
        }
        if !exited {
            if let Some(status) = child.try_wait().ok()? {
                if !status.success() {
                    return None;
                }
                exited = true;
            }
        }
        if exited && eof {
            return String::from_utf8(output).ok();
        }
        thread::sleep(
            Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

#[cfg(unix)]
fn make_nonblocking(stdout: &ChildStdout) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn fcntl(fd: i32, command: i32, ...) -> i32;
    }
    #[cfg(target_os = "macos")]
    const NONBLOCK: i32 = 0x0004;
    #[cfg(not(target_os = "macos"))]
    const NONBLOCK: i32 = 0x0800;
    // Owned pipe descriptor is valid, and fcntl arguments match F_GETFL/F_SETFL.
    let flags = unsafe { fcntl(stdout.as_raw_fd(), 3) };
    if flags < 0 || unsafe { fcntl(stdout.as_raw_fd(), 4, flags | NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(not(unix))]
fn make_nonblocking(_: &ChildStdout) -> io::Result<()> {
    Ok(())
}

#[cfg(not(windows))]
fn read_available(stdout: &mut ChildStdout, buffer: &mut [u8]) -> io::Result<usize> {
    stdout.read(buffer)
}
#[cfg(windows)]
fn read_available(stdout: &mut ChildStdout, buffer: &mut [u8]) -> io::Result<usize> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle, ptr};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn PeekNamedPipe(
            handle: *mut c_void,
            buffer: *mut c_void,
            size: u32,
            read: *mut u32,
            available: *mut u32,
            remaining: *mut u32,
        ) -> i32;
    }
    let mut available = 0;
    // Anonymous pipe handle belongs to stdout; null optional outputs are valid.
    let ok = unsafe {
        PeekNamedPipe(
            stdout.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            &mut available,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(109) {
            return Ok(0);
        } // ERROR_BROKEN_PIPE
        return Err(error);
    }
    if available == 0 {
        return Err(io::ErrorKind::WouldBlock.into());
    }
    let count = buffer.len().min(available as usize);
    stdout.read(&mut buffer[..count])
}

#[cfg(feature = "desktop")]
pub fn start_session_monitor(app: tauri::AppHandle) -> Result<(), String> {
    crate::power::start_session_monitor(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::collections::VecDeque;
    const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNuoAAAAASUVORK5CYII=";

    // All OS outputs below are synthetic. These tests never inspect the user's
    // clipboard, running applications, desktop, session or power state.
    fn query(
        platform: Platform,
        wayland: bool,
        output: &[&str],
    ) -> (Option<EntrySource>, Vec<(String, Vec<String>, Instant)>) {
        let mut output: VecDeque<_> = output.iter().map(|s| s.to_string()).collect();
        let mut calls = Vec::new();
        let result = detect_with(
            platform,
            wayland,
            Instant::now() + TIMEOUT,
            &AtomicBool::new(false),
            |file, args, deadline, _| {
                calls.push((file.to_string(), args.to_vec(), deadline));
                output.pop_front()
            },
        );
        (result, calls)
    }

    #[test]
    fn unsupported_wayland_cancelled_and_expired_queries_do_not_run() {
        assert!(query(Platform::Other, false, &[]).1.is_empty());
        assert!(query(Platform::Linux, true, &[]).1.is_empty());
        for (deadline, cancelled) in [
            (Instant::now() - Duration::from_secs(1), false),
            (Instant::now() + TIMEOUT, true),
        ] {
            assert!(detect_with(
                Platform::Mac,
                false,
                deadline,
                &AtomicBool::new(cancelled),
                |_, _, _, _| panic!("must not query OS")
            )
            .is_none());
        }
    }

    #[test]
    fn json_is_bounded_allowlisted_and_sanitized() {
        let source = parse_source_output(&format!(r#"{{"name":"  Synthetic\u0000 App\u202e  ","icon":"{PNG}","kind":"owner","title":"discard","url":"discard"}}"#)).unwrap();
        assert_eq!(source.name, "Synthetic App");
        assert_eq!(source.kind, "foreground");
        assert_eq!(source.icon.as_deref(), Some(PNG));
        assert_eq!(
            parse_source_output("\u{feff}{\"name\":\"Synthetic\"}\n")
                .unwrap()
                .name,
            "Synthetic"
        );
        for bad in [
            "null",
            "[]",
            "{}",
            "{\"name\":1}",
            "{\"name\":\"\"}",
            "console noise\n{\"name\":\"App\"}",
            "{\"name\":\"App\"};run()",
        ] {
            assert!(parse_source_output(bad).is_none());
        }
        assert!(parse_source_output(&"x".repeat(MAX_OUTPUT_BYTES + 1)).is_none());
    }

    #[test]
    fn mac_uses_fixed_local_script_without_sensitive_queries() {
        let (source, calls) = query(Platform::Mac, false, &[r#"{"name":"Synthetic"}"#]);
        assert_eq!(source.unwrap().name, "Synthetic");
        assert_eq!(calls[0].0, "/usr/bin/osascript");
        assert_eq!(&calls[0].1[..3], &["-l", "JavaScript", "-e"]);
        assert!(calls[0].1[3].contains("NSWorkspace.sharedWorkspace.frontmostApplication"));
        for forbidden in [
            "System Events",
            "AXUIElement",
            "CGWindow",
            "pasteboard",
            "clipboard",
            "window.title",
        ] {
            assert!(!calls[0].1[3].contains(forbidden));
        }
    }

    #[test]
    fn windows_uses_fixed_encoded_script_and_local_icons_only() {
        let (_, calls) = query(Platform::Windows, false, &[r#"{"name":"Synthetic"}"#]);
        assert_eq!(
            &calls[0].1[..4],
            &[
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand"
            ]
        );
        let decoded = STANDARD.decode(&calls[0].1[4]).unwrap();
        let units: Vec<_> = decoded
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        let script = String::from_utf16(&units).unwrap();
        assert_eq!(script, WINDOWS_SCRIPT);
        for required in [
            "GetForegroundWindow",
            "GetWindowThreadProcessId",
            ".ProcessName",
            "DriveType]::Fixed",
        ] {
            assert!(script.contains(required));
        }
        for forbidden in [
            "GetWindowText",
            "MainWindowTitle",
            "CommandLine",
            "Get-Clipboard",
            "Invoke-Expression",
            "ExecutionPolicy",
        ] {
            assert!(!script.contains(forbidden));
        }
    }

    #[test]
    fn x11_queries_only_allowlisted_id_and_class_under_one_deadline() {
        let (source, calls) = query(
            Platform::Linux,
            false,
            &[
                "_NET_ACTIVE_WINDOW(WINDOW): window id # 0xA1\n",
                "WM_CLASS = \"instance\", \"Synthetic Browser\"\n",
            ],
        );
        assert_eq!(source.unwrap().name, "Synthetic Browser");
        assert_eq!(calls[0].1, ["-root", "_NET_ACTIVE_WINDOW"]);
        assert_eq!(calls[1].1, ["-id", "0xa1", "-notype", "WM_CLASS"]);
        assert_eq!(calls[0].2, calls[1].2);
        assert!(calls.iter().all(|(file, _, _)| file == "/usr/bin/xprop"));
    }

    #[test]
    fn x11_rejects_injection_unrelated_properties_and_extra_output() {
        for value in [
            "0x123",
            "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0",
            "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1; touch /tmp/no",
            "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x123456789",
            "🦋",
        ] {
            assert!(parse_x11_window_id(value).is_none());
        }
        assert_eq!(
            parse_x11_class(r#"WM_CLASS(STRING) = "instance", "Synthetic \"Editor\"""#)
                .unwrap()
                .name,
            "Synthetic \"Editor\""
        );
        for value in [
            "WM_NAME = \"title\"",
            "WM_CLASS = \"only-instance\"",
            "WM_CLASS = \"instance\", \"\"",
            "WM_CLASS = \"instance\", \"App\"\nWM_NAME = \"title\"",
        ] {
            assert!(parse_x11_class(value).is_none());
        }
    }

    #[test]
    fn cancellation_while_running_discards_result_and_skips_second_query() {
        let cancelled = AtomicBool::new(false);
        let mut count = 0;
        let result = detect_with(
            Platform::Linux,
            false,
            Instant::now() + TIMEOUT,
            &cancelled,
            |_, _, _, token| {
                count += 1;
                token.store(true, Ordering::Release);
                Some("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1".into())
            },
        );
        assert!(result.is_none());
        assert_eq!(count, 1);
    }
}
