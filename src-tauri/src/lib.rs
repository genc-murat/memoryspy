//! MemorySpy — a desktop memory profiler for .NET processes.
//!
//! Architecture in one paragraph: this crate is a *supervisor*. It locates and launches
//! `MemorySpy.Collector` (a .NET sidecar that talks to the target process over EventPipe),
//! streams the collector's newline delimited JSON to the webview in batches, and owns
//! session lifecycle plus settings. All protocol knowledge lives in [`collector`]; all
//! user-facing behaviour lives in the React app. Nothing in this layer knows what a
//! "counter" or a "GC generation" is, which is what lets a new probe appear in the UI
//! without a single line change here.

// `collector` and `recording` are public for the same reason: the integration tests in
// `tests/` drive the real supervisor and the real recording format against a real .NET
// process, with no GUI in the loop.
pub mod collector;
mod commands;
pub mod recording;
mod settings;

use std::sync::Arc;

use tauri::Manager;

use collector::TauriSink;
use commands::AppState;

/// `--check` runs discovery, prints a report and exits without opening a window.
///
/// This exists because the most common failure of this app is "the collector was not found",
/// and the person seeing it is looking at an installed bundle with no terminal attached. A
/// one-flag self-check turns that into an answer they can paste into a bug report.
pub fn run() {
    let check_mode = std::env::args().any(|argument| argument == "--check");

    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();

            // Discovery and the settings read both touch the filesystem, so they run before
            // the window exists and are cheap enough to do synchronously here.
            let user_settings = settings::load(&handle);

            if let Some(override_path) = user_settings.collector_path.as_deref() {
                std::env::set_var("MEMORYSPY_COLLECTOR", override_path);
            }

            // In a packaged build the collector ships as a bundled resource; telling the
            // locator where that directory is keeps one code path for dev and release.
            if let Ok(resource_dir) = app.path().resource_dir() {
                std::env::set_var("MEMORYSPY_RESOURCE_DIR", resource_dir);
            }

            let location = collector::locate_collector();

            if check_mode {
                let capabilities = if location.found {
                    collector::fetch_capabilities(&location).ok()
                } else {
                    None
                };

                let report = serde_json::json!({
                    "app": "MemorySpy",
                    "version": app.package_info().version.to_string(),
                    "resourceDir": app.path().resource_dir().ok().map(|p| p.display().to_string()),
                    // Reported here because "where did my recording go?" is the first question
                    // after an incident, and the answer has to be reachable from a terminal on
                    // a machine where the app's UI may not even open.
                    "recordingsDir": recording::recordings_dir(&handle)
                        .ok()
                        .map(|dir| dir.display().to_string()),
                    "collector": location,
                    "capabilities": capabilities,
                    "settings": user_settings,
                });

                // stdout because this is meant to be piped into a report.
                println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
                std::process::exit(if location.found { 0 } else { 3 });
            }

            let sink: Arc<dyn collector::EventSink> = Arc::new(TauriSink::new(handle));
            app.manage(AppState::new(location, user_settings, sink));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_environment,
            commands::refresh_collector,
            commands::list_processes,
            commands::get_capabilities,
            commands::start_session,
            commands::stop_session,
            commands::stop_all_sessions,
            commands::send_session_command,
            commands::list_sessions,
            commands::prune_sessions,
            commands::start_recording,
            commands::stop_recording,
            commands::list_recordings,
            commands::delete_recording,
            commands::start_playback,
            commands::pause_playback,
            commands::resume_playback,
            commands::set_playback_speed,
            commands::seek_playback,
            commands::stop_playback,
            commands::get_settings,
            commands::save_settings,
        ])
        .on_window_event(|window, event| {
            // Detaching from the target on close is deliberate: leaving an EventPipe session
            // attached would keep the target process paying for tracing after the user
            // believes they stopped measuring it.
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                if let Some(state) = app.try_state::<AppState>() {
                    // Live sessions first: their stop path writes the recording footer, so it
                    // has to run before anything else claims the shutdown.
                    let handles: Vec<_> = state.sessions.lock().unwrap().values().cloned().collect();
                    for handle in handles {
                        handle.stop();
                    }
                    state.stop_playbacks();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running MemorySpy");
}
