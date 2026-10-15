//! The command surface exposed to the frontend.
//!
//! Every command is `async` and does its blocking work on a worker thread: process
//! enumeration, capability probing and spawning a child process all involve IO that would
//! otherwise stall the webview's message loop and make the window feel frozen.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, State};


use std::sync::Arc;

use crate::collector::{
    self, CollectorLocation, DotnetProcessInfo, EventSink, SessionHandle, SessionRequest, SessionState,
};
use crate::recording::{self, PlaybackHandle, RecordingSummary};
use crate::settings::{self, Settings};

/// Shared state: the resolved collector location, the event sink, every live session and
/// every replay.
pub struct AppState {
    pub location: Mutex<CollectorLocation>,
    pub sessions: Mutex<HashMap<String, SessionHandle>>,
    pub playbacks: Mutex<HashMap<String, PlaybackHandle>>,
    pub settings: Mutex<Settings>,
    pub sink: Arc<dyn EventSink>,
}

impl AppState {
    pub fn new(location: CollectorLocation, settings: Settings, sink: Arc<dyn EventSink>) -> Self {
        Self {
            location: Mutex::new(location),
            sessions: Mutex::new(HashMap::new()),
            playbacks: Mutex::new(HashMap::new()),
            settings: Mutex::new(settings),
            sink,
        }
    }

    pub fn location_snapshot(&self) -> CollectorLocation {
        self.location.lock().unwrap().clone()
    }

    /// The live session asked for, or a readable error.
    pub fn session(&self, session_id: &str) -> Result<SessionHandle, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("Unknown session '{session_id}'."))
    }

    /// The replay asked for, or a readable error naming the ones that exist.
    pub fn playback(&self, playback_id: &str) -> Result<PlaybackHandle, String> {
        self.playbacks
            .lock()
            .unwrap()
            .get(playback_id)
            .cloned()
            .ok_or_else(|| format!("Unknown replay '{playback_id}'."))
    }

    /// Stops every replay, e.g. before the window closes.
    pub fn stop_playbacks(&self) {
        let handles: Vec<PlaybackHandle> = self.playbacks.lock().unwrap().values().cloned().collect();
        for handle in handles {
            handle.stop();
        }
    }
}

/// Environment report shown in the app's settings screen.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    pub collector: CollectorLocation,
    pub settings: Settings,
    pub sessions: Vec<Value>,
    pub recordings_dir: String,
}

#[tauri::command]
pub async fn get_environment(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<EnvironmentInfo, String> {
    let collector = state.location_snapshot();
    let settings = state.settings.lock().unwrap().clone();
    let sessions = state
        .sessions
        .lock()
        .unwrap()
        .values()
        .map(|s| s.snapshot())
        .collect();

    // Reported rather than created on demand: the recordings folder is a path the user will
    // want to paste into an email, so it must be stable and visible even when empty.
    let recordings_dir = recording::recordings_dir(&app)
        .map(|dir| dir.display().to_string())
        .unwrap_or_default();

    Ok(EnvironmentInfo {
        collector,
        settings,
        sessions,
        recordings_dir,
    })
}

/// Re-runs collector discovery. Used after the user edits the collector path.
#[tauri::command]
pub async fn refresh_collector(state: State<'_, AppState>) -> Result<CollectorLocation, String> {
    let settings = state.settings.lock().unwrap().clone();

    // The locator reads this override itself; keeping it in the environment means the
    // discovery path is identical for the CLI, the tests and the app.
    if let Some(override_path) = settings.collector_path.as_deref() {
        std::env::set_var("MEMORYSPY_COLLECTOR", override_path);
    }

    let location = tauri::async_runtime::spawn_blocking(collector::locate_collector)
        .await
        .map_err(|e| e.to_string())?;

    *state.location.lock().unwrap() = location.clone();
    Ok(location)
}

#[tauri::command]
pub async fn list_processes(state: State<'_, AppState>, fast: Option<bool>) -> Result<Vec<DotnetProcessInfo>, String> {
    let location = state.location_snapshot();

    tauri::async_runtime::spawn_blocking(move || collector::list_processes(&location, fast.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_capabilities(state: State<'_, AppState>) -> Result<Value, String> {
    let location = state.location_snapshot();

    tauri::async_runtime::spawn_blocking(move || collector::fetch_capabilities(&location))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<Value, String> {
    let location = state.location_snapshot();

    if !location.found {
        return Err(location
            .error
            .clone()
            .unwrap_or_else(|| "The collector is not available.".to_string()));
    }

    // A live session and a replay both feed the same store, so running one over the other
    // would splice two timelines into a single set of charts.
    if state.playbacks.lock().unwrap().values().any(|handle| handle.is_active()) {
        return Err("Stop the replay before attaching to a process.".to_string());
    }

    // One session per target process. Attaching twice would double the EventPipe load on
    // the target and produce two interleaved series for the same counters.
    {
        let sessions = state.sessions.lock().unwrap();
        if let Some(existing) = sessions.values().find(|s| s.pid() == request.pid) {
            let active = matches!(
                existing.state(),
                SessionState::Starting | SessionState::Running | SessionState::Stopping
            );
            if active {
                return Err(format!(
                    "Already attached to process {}. Detach first.",
                    request.pid
                ));
            }
        }
    }

    let pid = request.pid;
    let label = request.target_name.clone();

    // Only resolved when a recording or a deep capture is actually requested, so attaching does
    // not create an empty folder as a side effect. A deep capture writes its .nettrace here too:
    // it is the folder the app owns, shows, and lets the user clean up.
    let recordings_dir = if request.record || request.record_path.is_some() || request.deep_capture {
        Some(recording::recordings_dir(&app)?)
    } else {
        None
    };

    let handle = collector::start_session(state.sink.clone(), &location, request, recordings_dir)?;
    let snapshot = handle.snapshot();

    state
        .sessions
        .lock()
        .unwrap()
        .insert(handle.id().to_string(), handle.clone());

    // Remember the target so the app can offer to resume after a restart.
    {
        let mut settings = state.settings.lock().unwrap();
        settings.last_session = Some(settings::LastSession {
            pid,
            name: label.unwrap_or_else(|| format!("pid {pid}")),
            at_unix_ms: now_unix_ms(),
        });
    }

    Ok(snapshot)
}

#[tauri::command]
pub async fn stop_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.session(&session_id)?.stop();
    Ok(())
}

#[tauri::command]
pub async fn stop_all_sessions(state: State<'_, AppState>) -> Result<(), String> {
    let handles: Vec<SessionHandle> = state.sessions.lock().unwrap().values().cloned().collect();
    for handle in handles {
        handle.stop();
    }
    Ok(())
}

/// Sends a control command to the collector, e.g. `{"cmd":"reset"}`.
#[tauri::command]
pub async fn send_session_command(
    state: State<'_, AppState>,
    session_id: String,
    command: Value,
) -> Result<(), String> {
    state.session(&session_id)?.send_command(command)
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    Ok(state
        .sessions
        .lock()
        .unwrap()
        .values()
        .map(|s| s.snapshot())
        .collect())
}

/// Drops sessions and replays that have already finished, so neither map grows for the
/// lifetime of the app.
#[tauri::command]
pub async fn prune_sessions(state: State<'_, AppState>) -> Result<usize, String> {
    let mut sessions = state.sessions.lock().unwrap();
    let before = sessions.len();

    sessions.retain(|_, handle| {
        matches!(
            handle.state(),
            SessionState::Starting | SessionState::Running | SessionState::Stopping
        )
    });
    let removed = before - sessions.len();
    drop(sessions);

    let mut playbacks = state.playbacks.lock().unwrap();
    let before_playbacks = playbacks.len();
    playbacks.retain(|_, handle| handle.is_active());

    Ok(removed + before_playbacks - playbacks.len())
}

// ---------------------------------------------------------------------------------------
// Recording the live session
// ---------------------------------------------------------------------------------------

/// Starts writing the running session's event stream to disk.
///
/// Attaching with a recording pre-armed is the common case; this command exists for the more
/// useful one — noticing the leak first, then deciding to keep the evidence.
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: Option<String>,
    target_name: Option<String>,
    target_runtime: Option<String>,
) -> Result<RecordingSummary, String> {
    let handle = state.session(&session_id)?;
    let recordings_dir = if path.is_none() {
        Some(recording::recordings_dir(&app)?)
    } else {
        None
    };

    handle.start_recording(target_name, target_runtime, path, recordings_dir)
}

#[tauri::command]
pub async fn stop_recording(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<RecordingSummary>, String> {
    state.session(&session_id)?.stop_recording()
}

// ---------------------------------------------------------------------------------------
// Recordings on disk
// ---------------------------------------------------------------------------------------

#[tauri::command]
pub async fn list_recordings(app: AppHandle) -> Result<Vec<RecordingSummary>, String> {
    let dir = recording::recordings_dir(&app)?;

    // Metadata requires a pass over each file, which for a long recording is real work.
    tauri::async_runtime::spawn_blocking(move || recording::list_recordings(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let dir = recording::recordings_dir(&app)?;

    // Deletion is the one irreversible action in the app, so it is confined to the folder
    // MemorySpy owns rather than honouring any path the frontend happens to send.
    let canonical_file = recording::resolve_inside(&dir, Path::new(&path))?;

    // Refuse while the file is in use: a replay still reading it, or a session still writing
    // it, would either truncate the evidence or report nonsense.
    let is_open = |other: &str| {
        Path::new(other)
            .canonicalize()
            .map(|resolved| resolved == canonical_file)
            .unwrap_or(false)
    };

    if state
        .playbacks
        .lock()
        .unwrap()
        .values()
        .any(|handle| handle.is_active() && is_open(&handle.summary().path))
    {
        return Err("Stop the replay before deleting this recording.".into());
    }

    if state
        .sessions
        .lock()
        .unwrap()
        .values()
        .any(|handle| handle.recording().is_some_and(|recording| is_open(&recording.path)))
    {
        return Err("Stop recording before deleting this file.".into());
    }

    std::fs::remove_file(&canonical_file)
        .map_err(|e| format!("Could not delete {}: {e}", canonical_file.display()))
}

// ---------------------------------------------------------------------------------------
// Replaying a recording
// ---------------------------------------------------------------------------------------

/// Opens a recording and starts replaying it through the same event channel as a live
/// session, so every panel and diagnosis rule works on it unchanged.
#[tauri::command]
pub async fn start_playback(
    state: State<'_, AppState>,
    path: String,
    speed: Option<f64>,
) -> Result<Value, String> {
    {
        let sessions = state.sessions.lock().unwrap();
        if let Some(active) = sessions.values().find(|handle| {
            matches!(
                handle.state(),
                SessionState::Starting | SessionState::Running | SessionState::Stopping
            )
        }) {
            return Err(format!(
                "Detach from pid {} before replaying a recording.",
                active.pid()
            ));
        }
    }

    // Clicking Replay on another file should not require stopping the first one by hand.
    state.stop_playbacks();
    state.playbacks.lock().unwrap().retain(|_, handle| handle.is_active());

    let sink = state.sink.clone();
    let recording_path = Path::new(&path).to_path_buf();

    let handle = tauri::async_runtime::spawn_blocking(move || {
        PlaybackHandle::start(sink, &recording_path, speed)
    })
    .await
    .map_err(|e| e.to_string())??;

    let snapshot = handle.snapshot();
    state
        .playbacks
        .lock()
        .unwrap()
        .insert(handle.id().to_string(), handle);

    Ok(snapshot)
}

#[tauri::command]
pub async fn pause_playback(state: State<'_, AppState>, playback_id: String) -> Result<(), String> {
    state.playback(&playback_id)?.pause()
}

#[tauri::command]
pub async fn resume_playback(state: State<'_, AppState>, playback_id: String) -> Result<(), String> {
    state.playback(&playback_id)?.resume()
}

#[tauri::command]
pub async fn set_playback_speed(
    state: State<'_, AppState>,
    playback_id: String,
    speed: f64,
) -> Result<(), String> {
    state.playback(&playback_id)?.set_speed(speed)
}

#[tauri::command]
pub async fn seek_playback(
    state: State<'_, AppState>,
    playback_id: String,
    position_ms: u64,
) -> Result<(), String> {
    state.playback(&playback_id)?.seek(position_ms)
}

#[tauri::command]
pub async fn stop_playback(state: State<'_, AppState>, playback_id: String) -> Result<(), String> {
    state.playback(&playback_id)?.stop();
    Ok(())
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.lock().unwrap().clone())
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    let saved = settings::save(&app, settings)?;
    *state.settings.lock().unwrap() = saved.clone();
    Ok(saved)
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
