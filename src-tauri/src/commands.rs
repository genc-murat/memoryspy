//! The command surface exposed to the frontend.
//!
//! Every command is `async` and does its blocking work on a worker thread: process
//! enumeration, capability probing and spawning a child process all involve IO that would
//! otherwise stall the webview's message loop and make the window feel frozen.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use std::sync::Arc;

use crate::collector::{
    self, CollectorLocation, DotnetProcessInfo, EventSink, SessionHandle, SessionRequest,
    SessionState,
};
use crate::docker::{self, CollectorVariant, ContainerStaging, DockerContainer, DockerStatus};
use crate::dump::{DumpAnalysis, DumpAnalyzer, DumpObject, DumpReference, DumpRoots};
use crate::dump_source::{self, DumpSourceLocation, SourcePreview};
use crate::recording::{self, PlaybackHandle, RecordingSummary};
use crate::settings::{self, Settings};

/// Shared state: the resolved collector location, the event sink, every live session and
/// every replay.
pub struct AppState {
    pub location: Mutex<CollectorLocation>,
    pub sessions: Mutex<HashMap<String, SessionHandle>>,
    starting_sessions: Mutex<HashSet<SessionTarget>>,
    pub playbacks: Mutex<HashMap<String, PlaybackHandle>>,
    pub dump_analyzer: DumpAnalyzer,
    pub settings: Mutex<Settings>,
    pub sink: Arc<dyn EventSink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SessionTarget {
    pid: i32,
    container: Option<String>,
}

impl SessionTarget {
    fn description(&self) -> String {
        match &self.container {
            Some(container) => format!("process {} in container {container}", self.pid),
            None => format!("process {}", self.pid),
        }
    }
}

/// Reserves a target while its collector is being prepared and launched.
///
/// The reservation is deliberately separate from the live session map: Docker staging can take
/// minutes, and holding the map lock throughout would block detach, prune, and UI snapshots.
struct SessionStartReservation<'a> {
    starting_sessions: &'a Mutex<HashSet<SessionTarget>>,
    target: SessionTarget,
}

impl Drop for SessionStartReservation<'_> {
    fn drop(&mut self) {
        if let Ok(mut starting) = self.starting_sessions.lock() {
            starting.remove(&self.target);
        }
    }
}

fn reserve_target<'a>(
    starting_sessions: &'a Mutex<HashSet<SessionTarget>>,
    target: SessionTarget,
) -> Result<SessionStartReservation<'a>, String> {
    let mut starting = starting_sessions.lock().unwrap();
    if !starting.insert(target.clone()) {
        return Err(format!(
            "Already attaching to {}. Detach first.",
            target.description()
        ));
    }

    Ok(SessionStartReservation {
        starting_sessions,
        target,
    })
}

impl AppState {
    pub fn new(location: CollectorLocation, settings: Settings, sink: Arc<dyn EventSink>) -> Self {
        Self {
            location: Mutex::new(location),
            sessions: Mutex::new(HashMap::new()),
            starting_sessions: Mutex::new(HashSet::new()),
            playbacks: Mutex::new(HashMap::new()),
            dump_analyzer: DumpAnalyzer::default(),
            settings: Mutex::new(settings),
            sink,
        }
    }

    pub fn location_snapshot(&self) -> CollectorLocation {
        self.location.lock().unwrap().clone()
    }

    /// Reserves one process/container pair and rejects an already active or starting target.
    fn reserve_session_start(
        &self,
        target: SessionTarget,
    ) -> Result<SessionStartReservation<'_>, String> {
        let reservation = reserve_target(&self.starting_sessions, target.clone())?;
        let already_active = self.sessions.lock().unwrap().values().any(|session| {
            session.pid() == target.pid
                && session.container() == target.container.as_deref()
                && matches!(
                    session.state(),
                    SessionState::Starting | SessionState::Running | SessionState::Stopping
                )
        });

        if already_active {
            return Err(format!(
                "Already attached to {}. Detach first.",
                target.description()
            ));
        }

        Ok(reservation)
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
        let handles: Vec<PlaybackHandle> =
            self.playbacks.lock().unwrap().values().cloned().collect();
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
pub async fn list_processes(
    state: State<'_, AppState>,
    fast: Option<bool>,
) -> Result<Vec<DotnetProcessInfo>, String> {
    let location = state.location_snapshot();

    tauri::async_runtime::spawn_blocking(move || {
        collector::list_processes(&location, fast.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether containerised targets can be inspected at all, and why not when they cannot.
#[tauri::command]
pub async fn get_docker_status() -> Result<DockerStatus, String> {
    tauri::async_runtime::spawn_blocking(docker::status)
        .await
        .map_err(|e| e.to_string())
}

/// Bundles a published musl collector's C++ runtime so bare Alpine images can run it.
///
/// The repair needs a place to keep the extracted libraries: they are cached under the app's data
/// directory, so a resources directory that is rebuilt (or read-only) does not force the runtime
/// image to be pulled again.
#[tauri::command]
pub async fn repair_collector_variant(
    app: AppHandle,
    rid: String,
) -> Result<CollectorVariant, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve the app data directory: {e}"))?;

    tauri::async_runtime::spawn_blocking(move || docker::repair_variant(&rid, &root))
        .await
        .map_err(|e| e.to_string())?
}

/// Running containers, which are the only targets the Docker transport can attach to.
#[tauri::command]
pub async fn list_docker_containers() -> Result<Vec<DockerContainer>, String> {
    tauri::async_runtime::spawn_blocking(docker::list_containers)
        .await
        .map_err(|e| e.to_string())?
}

/// Disk used by collector builds staged inside every running container.
///
/// A separate command from [`get_docker_status`] on purpose: measuring means one `docker exec`
/// per container, while the status probe is called at startup and must stay cheap. The
/// container-support view asks for this when it is opened.
#[tauri::command]
pub async fn get_docker_staging() -> Result<Vec<ContainerStaging>, String> {
    tauri::async_runtime::spawn_blocking(docker::staging_usage)
        .await
        .map_err(|e| e.to_string())?
}

/// Removes every staged collector build in `container` except the newest.
///
/// Kept separate from the automatic cleanup because the user may want the space back now: the
/// collector only prunes after a rebuild, and only copies older than a day.
#[tauri::command]
pub async fn prune_docker_staging(container: String) -> Result<ContainerStaging, String> {
    tauri::async_runtime::spawn_blocking(move || docker::prune_staging(&container))
        .await
        .map_err(|e| e.to_string())?
}

/// The attachable .NET processes inside one container.
///
/// This stages the Linux collector into the container on first use, which is why it is a
/// command of its own rather than part of the process list the rail refreshes every few seconds.
/// `fast` skips the OS-level enrichment inside the container; see [`docker::list_processes`].
#[tauri::command]
pub async fn list_container_processes(
    container: String,
    fast: Option<bool>,
) -> Result<Vec<DotnetProcessInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        docker::list_processes(&container, fast.unwrap_or(false))
    })
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

    // Normalised once: an empty string is not a container, and every later decision (the host
    // collector check, the session identity, the capture location) has to agree on that.
    let request_container = request
        .container
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    // A container session runs the Linux collector *inside* the container, so it does not need
    // the host build at all: a machine whose host collector is missing can still profile one.
    if !location.found && request_container.is_none() {
        return Err(location
            .error
            .clone()
            .unwrap_or_else(|| "The collector is not available.".to_string()));
    }

    // A live session and a replay both feed the same store, so running one over the other
    // would splice two timelines into a single set of charts.
    if state
        .playbacks
        .lock()
        .unwrap()
        .values()
        .any(|handle| handle.is_active())
    {
        return Err("Stop the replay before attaching to a process.".to_string());
    }

    // One session per target process. Reserve before staging or launching: those operations can
    // block long enough for a second invocation to race through a plain sessions-map check.
    // A pid is only unique within its process namespace, so the container is part of the key.
    let _reservation = state.reserve_session_start(SessionTarget {
        pid: request.pid,
        container: request_container.clone(),
    })?;

    let pid = request.pid;
    let label = request.target_name.clone();

    // Only resolved when a recording or a deep capture is actually requested, so attaching does
    // not create an empty folder as a side effect. A deep capture writes its .nettrace here too:
    // it is the folder the app owns, shows, and lets the user clean up.
    let recordings_dir = if request.record || request.record_path.is_some() || request.deep_capture
    {
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

/// Shows a recording or capture in Finder, Explorer or the desktop's file manager.
///
/// The webview cannot launch applications, so a path it prints is a dead end without this.
/// The missing-file case is answered here rather than by the launcher: only the host can say
/// "the capture was moved or deleted" in wording the rail can put next to the path.
#[tauri::command]
pub async fn reveal_in_folder(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::reveal::reveal(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pick_dump(window: tauri::WebviewWindow, kind: Option<String>) -> Result<Option<String>, String> {
    let dialog = window.dialog().file().set_parent(&window);
    let dialog = match kind.as_deref() {
        Some("assembly") => dialog.set_title("Open the assembly from the dump build")
            .add_filter(".NET assemblies", &["dll", "exe"]),
        Some("source") => dialog.set_title("Choose the local source file")
            .add_filter("Source files", &["cs", "fs", "vb"]),
        _ => dialog.set_title("Open a .NET memory dump")
            .add_filter("Memory dumps", &["dmp", "dump", "core"])
            .add_filter("All files", &["*"]),
    };
    tauri::async_runtime::spawn_blocking(move || {
        dialog
            .blocking_pick_file()
            .map(|file| file.into_path().map_err(|error| error.to_string()))
            .transpose()?
            .map(|path| {
                path.into_os_string()
                    .into_string()
                    .map_err(|_| "This file path cannot be represented as text.".to_string())
            })
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn pick_dumps(window: tauri::WebviewWindow) -> Result<Option<Vec<String>>, String> {
    let dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Open .NET memory dumps")
        .add_filter("Memory dumps", &["dmp", "dump", "core"])
        .add_filter("All files", &["*"]);
    tauri::async_runtime::spawn_blocking(move || {
        dialog
            .blocking_pick_files()
            .map(|files| {
                files
                    .into_iter()
                    .map(|file| {
                        file.into_path()
                            .map_err(|error| error.to_string())?
                            .into_os_string()
                            .into_string()
                            .map_err(|_| "This file path cannot be represented as text.".to_string())
                    })
                    .collect::<Result<Vec<_>, String>>()
            })
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_dump_report(
    window: tauri::WebviewWindow,
    file_name: String,
    markdown: String,
) -> Result<Option<String>, String> {
    let dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Save investigation report")
        .set_file_name(file_name)
        .add_filter("Markdown report", &["md"]);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|error| error.to_string())?;
        if !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("md")) {
            return Err("Choose a file ending in .md for the investigation report.".to_string());
        }
        std::fs::write(&path, markdown)
            .map_err(|error| format!("Could not save report to {}: {error}", path.display()))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn analyze_dump(
    state: State<'_, AppState>,
    path: String,
    reachable_only: Option<bool>,
    progress: tauri::ipc::Channel<String>,
) -> Result<Option<DumpAnalysis>, String> {
    state
        .dump_analyzer
        .analyze(Path::new(&path), reachable_only.unwrap_or(false), &progress)
        .await
}

#[tauri::command]
pub async fn sample_dump_objects(
    state: State<'_, AppState>,
    path: String,
    dump_id: String,
    method_table: String,
    min_bytes: u64,
    reachable_only: Option<bool>,
    progress: tauri::ipc::Channel<String>,
) -> Result<Option<Vec<DumpObject>>, String> {
    state
        .dump_analyzer
        .objects(
            Path::new(&path),
            &dump_id,
            &method_table,
            min_bytes,
            reachable_only.unwrap_or(false),
            &progress,
        )
        .await
}

#[tauri::command]
pub async fn inspect_dump_roots(
    state: State<'_, AppState>,
    path: String,
    dump_id: String,
    addresses: Vec<String>,
    skip_stacks: Option<bool>,
    progress: tauri::ipc::Channel<String>,
) -> Result<Option<DumpRoots>, String> {
    state
        .dump_analyzer
        .roots(
            Path::new(&path),
            &dump_id,
            &addresses,
            skip_stacks.unwrap_or(false),
            &progress,
        )
        .await
}

#[tauri::command]
pub async fn inspect_dump_reference(
    state: State<'_, AppState>,
    path: String,
    dump_id: String,
    parent: String,
    child: Option<String>,
) -> Result<Option<DumpReference>, String> {
    state.dump_analyzer.reference(Path::new(&path), &dump_id, &parent, child.as_deref()).await
}

#[tauri::command]
pub async fn resolve_dump_source(
    state: State<'_, AppState>,
    path: String,
    dump_id: String,
    assembly: String,
    method_table: String,
    type_name: String,
    method_name: Option<String>,
) -> Result<Option<DumpSourceLocation>, String> {
    state
        .dump_analyzer
        .run(async {
            let identity =
                crate::dump::module_identity(Path::new(&path), &dump_id, &method_table).await?;
            dump_source::resolve(
                &state.location_snapshot(),
                Path::new(&assembly),
                &identity,
                &type_name,
                method_name.as_deref(),
            )
            .await
        })
        .await
}

#[tauri::command]
pub async fn preview_dump_source(
    path: String,
    line: u32,
    sha256: Option<String>,
) -> Result<SourcePreview, String> {
    tauri::async_runtime::spawn_blocking(move || dump_source::preview(Path::new(&path), line, sha256.as_deref()))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn cancel_dump_analysis(state: State<'_, AppState>) {
    state.dump_analyzer.cancel();
}

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

    if state.sessions.lock().unwrap().values().any(|handle| {
        handle
            .recording()
            .is_some_and(|recording| is_open(&recording.path))
    }) {
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
    state
        .playbacks
        .lock()
        .unwrap()
        .retain(|_, handle| handle.is_active());

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
pub async fn resume_playback(
    state: State<'_, AppState>,
    playback_id: String,
) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;

    #[test]
    fn concurrent_starts_cannot_reserve_the_same_target() {
        let starts = Arc::new(Mutex::new(HashSet::new()));
        let barrier = Arc::new(Barrier::new(3));
        let target = SessionTarget {
            pid: 4242,
            container: Some("service".to_string()),
        };

        let results = thread::scope(|scope| {
            let mut workers = Vec::new();
            for _ in 0..2 {
                let starts = Arc::clone(&starts);
                let barrier = Arc::clone(&barrier);
                let target = target.clone();
                workers.push(scope.spawn(move || {
                    let reservation = reserve_target(&starts, target);
                    barrier.wait();
                    reservation.is_ok()
                }));
            }

            barrier.wait();
            workers
                .into_iter()
                .map(|worker| worker.join().expect("reservation worker must not panic"))
                .collect::<Vec<_>>()
        });

        assert_eq!(
            results.iter().filter(|reserved| **reserved).count(),
            1,
            "exactly one concurrent attach should reserve a target"
        );
        assert!(
            starts.lock().unwrap().is_empty(),
            "the reservation must be released after the start attempt finishes"
        );
    }
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
