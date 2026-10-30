// Forewright desktop shell. It does not bundle Forewright: it runs the `forewright` command already installed on
// this machine (`forewright gui --print-url`), then shows the local GUI it prints in its own window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, SubmenuBuilder};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

const START_TIMEOUT: Duration = Duration::from_secs(60);
const STDERR_LIMIT: usize = 2048;

/// A page the app window may show: its own start page, or the GUI on this machine.
fn is_local(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("tauri.localhost" | "127.0.0.1" | "localhost")
        ),
        _ => false,
    }
}

/// Anything else goes to the default browser, never into the app window.
fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("could not open {url} in the browser: {e}");
        }
    }
}

/// The GUI link must be http on this machine with a port; anything else is refused.
fn parse_gui_url(line: &str) -> Result<Url, String> {
    let url = Url::parse(line).map_err(|e| {
        format!("The forewright command printed something that is not a link ({e}): {line}")
    })?;
    let local = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port().is_some();
    if !local {
        return Err(format!("Refusing to open {line}: the Forewright GUI must be an http link on 127.0.0.1 or localhost with a port."));
    }
    Ok(url)
}

/// How to run `forewright gui --print-url` on this system.
fn forewright_command() -> Command {
    if let Ok(bin) = std::env::var("FOREWRIGHT_BIN") {
        if !bin.is_empty() {
            let mut c = Command::new(bin);
            c.args(["gui", "--print-url"]);
            return c;
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // npm global installs create a forewright.cmd shim; no console window.
        let mut c = Command::new("cmd");
        c.args(["/d", "/c", "forewright.cmd", "gui", "--print-url"]);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    }
    #[cfg(not(windows))]
    {
        // GUI apps on macOS do not get the shell PATH, so go through the login shell.
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/zsh".to_string());
        let mut c = Command::new(shell);
        c.args(["-l", "-c", "forewright gui --print-url"]);
        c
    }
}

/// Copies everything a pipe produces into a shared buffer, so a timeout can still show what arrived.
fn drain<R: Read + Send + 'static>(mut pipe: R) -> (Arc<Mutex<Vec<u8>>>, thread::JoinHandle<()>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&buf);
    let handle = thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            sink.lock().unwrap().extend_from_slice(&chunk[..n]);
        }
    });
    (buf, handle)
}

fn text(buf: &Arc<Mutex<Vec<u8>>>) -> String {
    String::from_utf8_lossy(&buf.lock().unwrap()).into_owned()
}

/// The last 2 KB of stderr, so the start page can show why it failed.
fn trim_stderr(s: &str) -> String {
    let s = s.trim();
    if s.len() <= STDERR_LIMIT {
        return s.to_string();
    }
    let mut start = s.len() - STDERR_LIMIT;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

fn wait_for(child: &mut Child) -> Result<std::process::ExitStatus, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() > START_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "forewright gui did not answer within {} seconds.",
                    START_TIMEOUT.as_secs()
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("Could not wait for the forewright command: {e}")),
        }
    }
}

/// Runs `forewright gui --print-url` and returns the validated link (last non-empty stdout line).
fn find_gui_url() -> Result<Url, String> {
    let mut child = forewright_command()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Forewright is not installed, or it could not start. ({e})"))?;
    let (out, out_thread) = drain(child.stdout.take().expect("stdout is piped"));
    let (err, err_thread) = drain(child.stderr.take().expect("stderr is piped"));
    let status = wait_for(&mut child).map_err(|m| format!("{m}\n{}", trim_stderr(&text(&err))))?;
    let _ = out_thread.join();
    let _ = err_thread.join();
    if !status.success() {
        return Err(format!(
            "Forewright is not installed, or it could not start ({status}).\n{}",
            trim_stderr(&text(&err))
        ));
    }
    let stdout = text(&out);
    let line = stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .ok_or_else(|| {
            format!(
                "The forewright command printed no link.\n{}",
                trim_stderr(&text(&err))
            )
        })?;
    parse_gui_url(line)
}

/// Called by the start page on load and by its "Try again" button. On success the window moves to the GUI;
/// on failure the message goes back to the page.
#[tauri::command]
async fn start(app: AppHandle) -> Result<(), String> {
    let url = tauri::async_runtime::spawn_blocking(find_gui_url)
        .await
        .map_err(|e| format!("The start task failed: {e}"))??;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The app window is gone.".to_string())?;
    window
        .navigate(url)
        .map_err(|e| format!("Could not open the GUI: {e}"))
}

/// `macos_launcher` exists only in the macOS build of the plugin.
fn autostart_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let builder = tauri_plugin_autostart::Builder::new();
    #[cfg(target_os = "macos")]
    let builder = builder.macos_launcher(MacosLauncher::LaunchAgent);
    builder.build()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(autostart_plugin())
        .invoke_handler(tauri::generate_handler![start])
        .setup(|app| {
            let autostart = app.autolaunch();
            let login = CheckMenuItemBuilder::with_id("autostart", "Open at Login")
                .checked(autostart.is_enabled().unwrap_or(false))
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Forewright")
                .item(&login)
                .separator()
                .quit()
                .build()?;
            // Without an Edit menu macOS has no copy and paste shortcuts in the window.
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            app.set_menu(
                MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .build()?,
            )?;
            let toggle = login.clone();
            app.on_menu_event(move |app, event| {
                if event.id() != "autostart" {
                    return;
                }
                let manager = app.autolaunch();
                let result = match manager.is_enabled() {
                    Ok(true) => manager.disable(),
                    Ok(false) => manager.enable(),
                    Err(e) => Err(e),
                };
                if let Err(e) = result {
                    eprintln!("could not change Open at Login: {e}");
                }
                // Show the real state, whatever happened.
                let _ = toggle.set_checked(manager.is_enabled().unwrap_or(false));
            });

            let nav = app.handle().clone();
            let popup = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Forewright")
                .inner_size(1280.0, 800.0)
                .min_inner_size(400.0, 600.0)
                .on_navigation(move |url| {
                    if is_local(url) {
                        return true;
                    }
                    open_outside(&nav, url);
                    false
                })
                .on_new_window(move |url, _features| {
                    if is_local(&url) {
                        // Another page of the GUI: show it in this window instead of opening a second one.
                        if let Some(w) = popup.get_webview_window("main") {
                            let _ = w.navigate(url);
                        }
                    } else {
                        open_outside(&popup, &url);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Forewright desktop app");
}
