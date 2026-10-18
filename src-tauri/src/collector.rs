//! Host-side supervision of the MemorySpy.Collector sidecar.
//!
//! The collector is a separate .NET process, so this module owns three concerns:
//! *finding* it (it ships as build output, not as a linked library), *running* it, and
//! *streaming* its newline delimited JSON to the frontend without blocking the UI thread
//! or flooding the IPC channel.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::recording::{RecordingSummary, RecordingTarget, RecordingWriter};

/// Event names the frontend subscribes to. Kept in one place so the TypeScript side and
/// the Rust side cannot drift apart silently.
pub const EVENT_MESSAGES: &str = "memoryspy://messages";
pub const EVENT_LOG: &str = "memoryspy://log";
pub const EVENT_STATUS: &str = "memoryspy://status";

/// Where a session sends what it learns.
///
/// This trait exists so the supervision logic does not depend on Tauri. The desktop app
/// supplies [`TauriSink`], which forwards to the webview; tests supply a recorder, which is
/// how the host/collector contract is verified against a real .NET process without a GUI.
pub trait EventSink: Send + Sync + 'static {
    fn messages(&self, session_id: &str, messages: Vec<serde_json::Value>);
    fn log(&self, session_id: &str, level: &str, message: &str);
    fn status(
        &self,
        session_id: &str,
        pid: i32,
        state: SessionState,
        detail: Option<String>,
        stats: serde_json::Value,
    );

    /// Reports the state of a replay. Defaulted to a no-op because only the desktop sink has
    /// a channel to send it on, and a replay is the one thing a test sink never needs.
    fn playback(&self, _payload: serde_json::Value) {}
}

/// The production sink: emits Tauri events the React app listens for.
pub struct TauriSink {
    app: AppHandle,
}

impl TauriSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriSink {
    fn messages(&self, session_id: &str, messages: Vec<serde_json::Value>) {
        if messages.is_empty() {
            return;
        }

        let _ = self.app.emit(
            EVENT_MESSAGES,
            serde_json::json!({ "sessionId": session_id, "messages": messages }),
        );
    }

    fn log(&self, session_id: &str, level: &str, message: &str) {
        let _ = self.app.emit(
            EVENT_LOG,
            serde_json::json!({ "sessionId": session_id, "level": level, "message": message }),
        );
    }

    fn status(
        &self,
        session_id: &str,
        pid: i32,
        state: SessionState,
        detail: Option<String>,
        stats: serde_json::Value,
    ) {
        let _ = self.app.emit(
            EVENT_STATUS,
            serde_json::json!({
                "sessionId": session_id,
                "pid": pid,
                "state": state,
                "detail": detail,
                "stats": stats,
            }),
        );
    }

    fn playback(&self, payload: serde_json::Value) {
        let _ = self.app.emit(crate::recording::EVENT_PLAYBACK, payload);
    }
}

/// Name of the collector assembly inside the build output / bundled resources.
const COLLECTOR_ASSEMBLY: &str = "MemorySpy.Collector.dll";

/// How long to wait for a graceful stop before killing the child process.
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_millis(1500);

/// How long a session armed with a deep capture gets to finish its post-stop work.
///
/// Stopping a deep capture is not "detach and exit". The collector has to drain the event
/// stream the runtime still owes it (a capture-armed session requested a rundown, so on a big
/// service this is every module and method it loaded), close the capture file, convert it to
/// ETLX and fold the samples — and none of that can be skipped, because the call-site answer
/// is the reason the capture was armed in the first place.
///
/// Killing early is not neutral, which is what sets this number apart from the plain grace:
/// the kill lands mid-drain or mid-flush, the capture loses its tail, and the file is no
/// longer a trace at all — the 56 MB capture that motivated this constant failed conversion
/// with "Read past end of stream" and the user lost the entire analysis to a 1.5 s timeout.
///
/// Five minutes is measured headroom, not a guess: analysis took ~0.5 s for a 3 MB capture
/// here, so the 256 MB cap on a slower disk lands in the low minutes; add the one symbol
/// request that ignores its own timeout (measured 62 s against a silent server — the symbol
/// budget only stops *subsequent* lookups) and the drain of a large service, and there is no
/// realistic path through the stop in less. A collector that is genuinely wedged is still
/// killed — just after this deadline rather than after 1.5 s.
const DEEP_CAPTURE_STOP_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Maximum number of messages buffered before flushing to the frontend.
const MESSAGE_BATCH_SIZE: usize = 64;

/// Maximum time a message waits in the buffer before being flushed.
const MESSAGE_BATCH_INTERVAL: Duration = Duration::from_millis(80);

// ---------------------------------------------------------------------------------------
// Locating the collector
// ---------------------------------------------------------------------------------------

/// Where the collector was found, plus everything the UI needs to explain a failure.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorLocation {
    pub found: bool,
    /// Path to the `dotnet` host executable. Reported even for a self-contained layout, but
    /// only *needed* when [`Self::executable_path`] is absent.
    pub dotnet_path: Option<String>,
    /// Path to MemorySpy.Collector.dll.
    pub assembly_path: Option<String>,
    /// Path to a self-contained `MemorySpy.Collector` executable sitting beside the
    /// assembly. When set, the collector carries its own .NET runtime inside the publish
    /// output and is launched directly: the target machine needs no `dotnet` installed.
    pub executable_path: Option<String>,
    /// How the path was resolved: env | resource | build-output | missing.
    pub source: String,
    pub dotnet_version: Option<String>,
    pub searched: Vec<String>,
    pub error: Option<String>,
}

/// The native executable a self-contained publish leaves beside the assembly.
const COLLECTOR_EXECUTABLE: &str = if cfg!(windows) {
    "MemorySpy.Collector.exe"
} else {
    "MemorySpy.Collector"
};

/// The native executable beside the assembly, when the layout is self-contained.
fn sibling_executable(dir: &Path) -> Option<PathBuf> {
    let candidate = dir.join(COLLECTOR_EXECUTABLE);
    candidate.is_file().then_some(candidate)
}

/// What to launch to run the collector: the program and its leading arguments.
///
/// A self-contained publish ships a native executable that carries its own .NET runtime, so
/// when one sits beside the assembly the program is that executable and it needs no leading
/// argument; a framework-dependent layout launches through `dotnet` with the assembly as the
/// first argument. Either way the caller appends its subcommand (`list`, `capabilities`,
/// `watch`) exactly as before.
fn resolve_launch(location: &CollectorLocation) -> Result<(String, Vec<String>), String> {
    if let Some(executable) = &location.executable_path {
        return Ok((executable.clone(), Vec::new()));
    }

    let missing_dotnet = |assembly: &String| {
        format!(
            "The collector at {assembly} is framework-dependent, but no dotnet executable was \
             found. Install the .NET runtime, point MEMORYSPY_DOTNET at one, or publish the \
             collector self-contained."
        )
    };

    let dotnet = location.dotnet_path.clone().ok_or_else(|| {
        location
            .assembly_path
            .as_ref()
            .map(missing_dotnet)
            .unwrap_or_else(|| {
                location
                    .error
                    .clone()
                    .unwrap_or_else(|| "The collector is not available.".to_string())
            })
    })?;
    let assembly = location
        .assembly_path
        .clone()
        .ok_or_else(|| "The collector assembly was not recorded.".to_string())?;

    Ok((dotnet, vec![assembly]))
}

pub fn locate_collector() -> CollectorLocation {
    let mut searched = Vec::new();

    let dotnet = find_dotnet();
    let dotnet_version = dotnet.as_deref().and_then(probe_dotnet_version);

    // 1. Explicit override, for pointing the app at a custom build.
    if let Ok(explicit) = std::env::var("MEMORYSPY_COLLECTOR") {
        let path = PathBuf::from(&explicit);
        searched.push(explicit.clone());
        if path.is_file() {
            let executable = path
                .parent()
                .and_then(sibling_executable)
                .map(|p| p.to_string_lossy().into_owned());
            return CollectorLocation {
                found: true,
                dotnet_path: dotnet.map(|p| p.to_string_lossy().into_owned()),
                assembly_path: Some(path.to_string_lossy().into_owned()),
                executable_path: executable,
                source: "env".into(),
                dotnet_version,
                searched,
                error: None,
            };
        }
    }

    let mut candidates: Vec<(PathBuf, &str)> = Vec::new();

    // 2. Bundled resource directory, used by a packaged build.
    if let Ok(resource_dir) = std::env::var("MEMORYSPY_RESOURCE_DIR") {
        candidates.push((PathBuf::from(resource_dir).join("collector"), "resource"));
    }

    // 3. Development build output relative to the crate, so `npm run tauri dev` just works
    //    after `npm run collector:build`.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(manifest_dir);
    for config in ["Debug", "Release"] {
        candidates.push((
            repo_root
                .join("collector")
                .join("bin")
                .join(config)
                .join("net10.0"),
            "build-output",
        ));
    }

    // 4. A published collector staged for packaging.
    candidates.push((
        repo_root
            .join("src-tauri")
            .join("resources")
            .join("collector"),
        "resource",
    ));

    for (dir, source) in candidates {
        let candidate = dir.join(COLLECTOR_ASSEMBLY);
        searched.push(candidate.to_string_lossy().into_owned());
        if candidate.is_file() {
            let executable = sibling_executable(&dir).map(|p| p.to_string_lossy().into_owned());
            return CollectorLocation {
                found: true,
                dotnet_path: dotnet.map(|p| p.to_string_lossy().into_owned()),
                assembly_path: Some(candidate.to_string_lossy().into_owned()),
                executable_path: executable,
                source: source.into(),
                dotnet_version,
                searched,
                error: None,
            };
        }
    }

    CollectorLocation {
        found: false,
        dotnet_path: dotnet.map(|p| p.to_string_lossy().into_owned()),
        assembly_path: None,
        executable_path: None,
        source: "missing".into(),
        dotnet_version,
        searched,
        error: Some(format!(
            "Could not find {COLLECTOR_ASSEMBLY}. Build it with `npm run collector:build`, \
             or set MEMORYSPY_COLLECTOR to its full path."
        )),
    }
}

/// Stops Windows from giving a child process a console window of its own.
///
/// The app is a GUI: `main.rs` sets `windows_subsystem = "windows"` for release builds, so it has
/// no console to pass down. Every `dotnet` child it starts is a *console* application, and Windows
/// responds by allocating a fresh console for it — a black window that flashes on each rescan and,
/// for the long-lived `watch` session, stays on screen for as long as the app is attached.
/// `CREATE_NO_WINDOW` tells the loader to run the child without one. Nothing is lost by it: stdout
/// and stderr are pipes here, not the console, and it is equally harmless for the short-lived
/// lookups (`where`, `dotnet --version`).
///
/// Deliberately not `CREATE_NEW_PROCESS_GROUP` or `DETACHED_PROCESS`: the session is stopped by
/// writing to its stdin and killing it if it does not comply, which needs an ordinary child, not a
/// detached one. A no-op off Windows.
pub(crate) fn without_console_window(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        /// `CREATE_NO_WINDOW` from `winbase.h`: run the process without inheriting or allocating a
        /// console.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}

fn find_dotnet() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("MEMORYSPY_DOTNET") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }

    let exe = if cfg!(windows) {
        "dotnet.exe"
    } else {
        "dotnet"
    };

    // DOTNET_ROOT is the conventional install location for a private .NET runtime.
    if let Ok(root) = std::env::var("DOTNET_ROOT") {
        let candidate = PathBuf::from(root).join(exe);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let lookup = if cfg!(windows) { "where" } else { "which" };
    let mut command = Command::new(lookup);
    command.arg(exe);
    without_console_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout.lines().next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(PathBuf::from(first))
    }
}

fn probe_dotnet_version(dotnet: &Path) -> Option<String> {
    let mut command = Command::new(dotnet);
    command.arg("--version");
    without_console_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// ---------------------------------------------------------------------------------------
// Process list
// ---------------------------------------------------------------------------------------

/// A .NET process the user can attach to. Mirrors `DotnetProcessInfo` in the collector.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotnetProcessInfo {
    pub pid: i32,
    pub name: String,
    pub command_line: Option<String>,
    pub executable_path: Option<String>,
    pub runtime_version: Option<String>,
    pub runtime_directory: Option<String>,
    pub working_set_bytes: Option<i64>,
    pub private_bytes: Option<i64>,
    pub start_time_unix_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ProcessListData {
    processes: Vec<DotnetProcessInfo>,
}

/// Runs the collector in its one-shot `list` mode and returns the parsed result.
pub fn list_processes(
    location: &CollectorLocation,
    fast: bool,
) -> Result<Vec<DotnetProcessInfo>, String> {
    let (dotnet, arguments) = resolve_launch(location)?;

    let mut command = Command::new(dotnet);
    command
        .args(arguments)
        .arg("list")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if fast {
        command.arg("--fast");
    }
    without_console_window(&mut command);

    let output = command
        .output()
        .map_err(|e| format!("Failed to run the collector: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_process_list(&stdout).map_err(|error| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.trim().is_empty() {
            format!("{error} No error output was produced.")
        } else {
            format!("{error} {}", stderr.trim())
        }
    })
}

/// Extracts the process list from a collector's stdout.
///
/// Shared with the Docker transport, which runs the same `list` command *inside* a container and
/// therefore has to read the same envelope.
pub(crate) fn parse_process_list(stdout: &str) -> Result<Vec<DotnetProcessInfo>, String> {
    // The collector emits the envelope on stdout; the first well formed line is the answer.
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            if value.get("type").and_then(|t| t.as_str()) == Some("process.list") {
                if let Some(data) = value.get("data") {
                    let parsed: ProcessListData =
                        serde_json::from_value(data.clone()).map_err(|e| {
                            format!("Collector returned an unexpected process list: {e}")
                        })?;
                    return Ok(parsed.processes);
                }
            }
        }
    }

    Err("The collector did not return a process list.".to_string())
}

/// Runs the collector's `capabilities` command so the UI can build panels dynamically.
pub fn fetch_capabilities(location: &CollectorLocation) -> Result<serde_json::Value, String> {
    let (dotnet, arguments) = resolve_launch(location)?;

    let mut command = Command::new(dotnet);
    command
        .args(arguments)
        .arg("capabilities")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    without_console_window(&mut command);

    let output = command
        .output()
        .map_err(|e| format!("Failed to run the collector: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            if value.get("type").and_then(|t| t.as_str()) == Some("hello") {
                return Ok(value
                    .get("data")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null));
            }
        }
    }

    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

// ---------------------------------------------------------------------------------------
// Live sessions
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

/// Live counters shown in the status bar without having to inspect the event stream.
#[derive(Debug, Default)]
pub struct SessionStats {
    pub messages: AtomicU64,
    pub dropped: AtomicU64,
    pub counters: AtomicU64,
    pub allocation_samples: AtomicU64,
    pub gc_events: AtomicU64,
}

struct SessionInner {
    sink: Arc<dyn EventSink>,
    id: String,
    pid: i32,
    /// The container this session's target runs in, when it is not a host process.
    container: Option<String>,
    /// A capture written inside a container, waiting to be copied out after the collector exits.
    capture_copy: Option<CaptureCopy>,
    state: Mutex<SessionState>,
    // The child handle is shared with the stop and reader threads, so it needs its own
    // `Arc` on top of the `Mutex`: the session itself is cloned into those threads.
    child: Arc<Mutex<Option<Child>>>,
    stdin: Mutex<Option<ChildStdin>>,
    stop_requested: AtomicBool,
    /// What `stop()` waits before killing: the plain grace, or the much longer one for a
    /// session whose collector still has capture analysis ahead of it. See
    /// [`DEEP_CAPTURE_STOP_TIMEOUT`] for why the two differ by two orders of magnitude.
    graceful_stop_timeout: Duration,
    stats: SessionStats,
    started_at_unix_ms: u64,
    message_counts: Mutex<HashMap<String, u64>>,
    /// Present while this session is being written to disk. Shared rather than owned so the
    /// stdout and stderr pumps can both append to one file.
    recorder: Mutex<Option<Arc<RecordingWriter>>>,
}

impl SessionInner {
    fn set_state(&self, state: SessionState, detail: Option<String>) {
        {
            let mut guard = self.state.lock().unwrap();
            *guard = state;
        }

        self.sink
            .status(&self.id, self.pid, state, detail, self.stats_snapshot());
    }

    /// The active recorder, if this session is being written to disk.
    fn recorder(&self) -> Option<Arc<RecordingWriter>> {
        self.recorder
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().cloned())
    }

    fn stats_snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "messages": self.stats.messages.load(Ordering::Relaxed),
            "dropped": self.stats.dropped.load(Ordering::Relaxed),
            "counters": self.stats.counters.load(Ordering::Relaxed),
            "allocationSamples": self.stats.allocation_samples.load(Ordering::Relaxed),
            "gcEvents": self.stats.gc_events.load(Ordering::Relaxed),
            "uptimeMs": now_unix_ms().saturating_sub(self.started_at_unix_ms),
            "messageCounts": self.message_counts.lock().ok().map(|m| m.clone()).unwrap_or_default(),
        })
    }
}

#[derive(Clone)]
pub struct SessionHandle(Arc<SessionInner>);

impl SessionHandle {
    pub fn id(&self) -> &str {
        &self.0.id
    }

    pub fn pid(&self) -> i32 {
        self.0.pid
    }

    /// The container this session's target runs in, if any.
    pub fn container(&self) -> Option<&str> {
        self.0.container.as_deref()
    }

    pub fn state(&self) -> SessionState {
        *self.0.state.lock().unwrap()
    }

    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "sessionId": self.0.id,
            "pid": self.0.pid,
            "container": self.0.container,
            "state": self.state(),
            "stats": self.0.stats_snapshot(),
            "recording": self.0.recorder().map(|recorder| recorder.summary()),
        })
    }

    /// The recording in progress, if any.
    pub fn recording(&self) -> Option<RecordingSummary> {
        self.0.recorder().map(|recorder| recorder.summary())
    }

    /// Starts recording a session that is already running.
    ///
    /// Attaching with a recording pre-armed is the common case, but the more useful one is
    /// noticing the leak first and then deciding to keep the evidence.
    pub fn start_recording(
        &self,
        target_name: Option<String>,
        target_runtime: Option<String>,
        path: Option<String>,
        recordings_dir: Option<PathBuf>,
    ) -> Result<RecordingSummary, String> {
        let mut guard = self
            .0
            .recorder
            .lock()
            .map_err(|_| "The recording state is unavailable.".to_string())?;

        if let Some(existing) = guard.as_ref() {
            return Err(format!(
                "Already recording to {}.",
                existing.path().display()
            ));
        }

        let request = SessionRequest {
            pid: self.0.pid,
            probes: Vec::new(),
            interval_ms: None,
            max_types: None,
            verbose: false,
            // A mid-session recording keeps the live stream; call sites need a capture that was
            // armed before the stream started, so it cannot be bolted onto a running session.
            deep_capture: false,
            capture_max_mb: None,
            record: true,
            record_path: path,
            target_name,
            target_runtime,
            container: self.0.container.clone(),
        };

        // Flagged as mid-session so no reader mistakes the first message for the start of the
        // process's life.
        let writer = open_recording(&request, recordings_dir.as_deref(), true)?;
        let summary = writer.summary();
        *guard = Some(writer);

        Ok(summary)
    }

    /// Finishes the recording in progress. Returns `None` when nothing was being recorded.
    pub fn stop_recording(&self) -> Result<Option<RecordingSummary>, String> {
        let writer = {
            let mut guard = self
                .0
                .recorder
                .lock()
                .map_err(|_| "The recording state is unavailable.".to_string())?;
            guard.take()
        };

        match writer {
            Some(writer) => {
                writer.finish("recording-stopped", self.0.stats_snapshot());
                Ok(Some(writer.summary()))
            }
            None => Ok(None),
        }
    }

    /// Sends a command object to the collector's stdin.
    pub fn send_command(&self, command: serde_json::Value) -> Result<(), String> {
        let mut guard = self.0.stdin.lock().unwrap();
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "The session has no open stdin.".to_string())?;

        let line = serde_json::to_string(&command).map_err(|e| e.to_string())?;
        writeln!(stdin, "{line}").map_err(|e| format!("Could not write to the collector: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("Could not flush the collector command: {e}"))
    }

    /// Asks the collector to stop cleanly, then force kills it if it does not comply.
    ///
    /// The graceful path matters twice over: it lets the collector detach its EventPipe
    /// session, which leaves the target process in a clean state, and it is the only window
    /// in which a deep capture's analysis can run — the answer the session was armed for.
    /// The kill remains the safety net for a collector that is wedged inside the runtime's
    /// tracing code, on the deadline the session was started with.
    pub fn stop(&self) {
        self.0.stop_requested.store(true, Ordering::SeqCst);
        self.0
            .set_state(SessionState::Stopping, Some("Stop requested.".into()));

        let _ = self.send_command(serde_json::json!({ "cmd": "stop" }));

        let child_slot = self.0.child.clone();
        let id = self.0.id.clone();
        let sink = self.0.sink.clone();
        let deadline = Instant::now() + self.0.graceful_stop_timeout;

        thread::spawn(move || {
            loop {
                if Instant::now() > deadline {
                    break;
                }

                {
                    let mut guard = child_slot.lock().unwrap();
                    match guard.as_mut() {
                        Some(child) => match child.try_wait() {
                            Ok(Some(_)) => return,
                            Ok(None) => {}
                            Err(_) => return,
                        },
                        None => return,
                    }
                }

                thread::sleep(Duration::from_millis(50));
            }

            let mut guard = child_slot.lock().unwrap();
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            drop(guard);

            sink.log(
                &id,
                "warn",
                "The collector did not stop within the timeout and was terminated.",
            );
        });
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Wraps a message the *host* contributes in the collector's envelope.
///
/// Copying a container capture out is a host concern, but the webview already ingests one
/// message channel, so the answer travels on that channel instead of a second event the UI
/// would have to learn. `seq` is 0 because host messages are outside the collector's sequence,
/// which only orders its own output.
fn host_message(message_type: &str, data: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "v": 1,
        "seq": 0,
        "ts": now_unix_ms(),
        "type": message_type,
        "data": data,
    })
}

/// Publishes a host-originated message on the channel the UI already reads, and records it.
///
/// The recorder in the stdout pump only sees the collector's own output, so without this a
/// replayed container session would present the in-container `/tmp/…` path as a file on whatever
/// machine plays the recording — and never name the copy that was made beside the recordings.
fn emit_host_message(inner: &SessionInner, message_type: &str, data: serde_json::Value) {
    let message = host_message(message_type, data);

    if let Some(recorder) = inner.recorder() {
        recorder.record_message(&message);
    }

    inner.sink.messages(&inner.id, vec![message]);
}

/// Description of what a session should collect. Mirrors the collector's CLI options.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    pub pid: i32,
    #[serde(default)]
    pub probes: Vec<String>,
    #[serde(default)]
    pub interval_ms: Option<u32>,
    #[serde(default)]
    pub max_types: Option<u32>,
    #[serde(default)]
    pub verbose: bool,
    ///
    /// Copy the raw EventPipe stream to a `.nettrace` beside the recordings, so the collector
    /// can resolve allocation call sites from it once the session stops.
    ///
    /// This is the one capability that cannot be served live: turning an instruction pointer
    /// into a method name needs the module and method maps from a complete stream, which is why
    /// the answer arrives after detaching rather than while the session runs.
    #[serde(default)]
    pub deep_capture: bool,
    /// Size limit for the deep capture, in megabytes. Omitted means the collector's default
    /// (256 MB). Reaching the limit ends the session early — the alternative, cutting the
    /// file mid-stream, produces a trace no parser can open.
    #[serde(default)]
    pub capture_max_mb: Option<u32>,
    /// Write this session's event stream to disk as it arrives.
    #[serde(default)]
    pub record: bool,
    /// An explicit destination. Omitted means an auto-named file in the recordings directory.
    #[serde(default)]
    pub record_path: Option<String>,
    /// Target metadata for the recording's header and file name. The host cannot look it up
    /// itself without spawning the collector a second time, and the UI already has it.
    #[serde(default)]
    pub target_name: Option<String>,
    #[serde(default)]
    pub target_runtime: Option<String>,
    /// Name or id of a Docker container the target runs in. Omitted means a process on this
    /// machine, launched directly.
    #[serde(default)]
    pub container: Option<String>,
}

/// A capture that has to be retrieved from a container once the collector exits.
struct CaptureCopy {
    container: String,
    remote: String,
    local: PathBuf,
}

/// Makes a container name or id safe to embed in a session id.
fn session_key(container: &str) -> String {
    let key: String = container
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect();

    // A name made entirely of characters a session id cannot carry still has to produce an id
    // that can be read in a log.
    if key.is_empty() {
        "container".to_string()
    } else {
        key
    }
}

/// Starts a collector session and wires its output to the sink.
///
/// `recordings_dir` is where an auto-named recording is created; it is only consulted when
/// the request asks for one, which keeps the tests free of filesystem setup.
pub fn start_session(
    sink: Arc<dyn EventSink>,
    location: &CollectorLocation,
    request: SessionRequest,
    recordings_dir: Option<PathBuf>,
) -> Result<SessionHandle, String> {
    if request.pid <= 0 {
        return Err("A valid process id is required.".into());
    }

    let container = request
        .container
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    // Two transports, one protocol. Locally the collector is launched directly; inside a
    // container it is launched through `docker exec -i`, because the diagnostics socket it has to
    // open lives in the container's own filesystem and PID namespaces. Either way stdout and
    // stdin are the NDJSON channel this module already pumps, so nothing downstream of here
    // knows which one it got.
    let (program, launcher_arguments) = match container {
        Some(container) => {
            let staged = crate::docker::ensure_collector(container)?;
            (
                crate::docker::cli(),
                vec![
                    "exec".to_string(),
                    "-i".to_string(),
                    container.to_string(),
                    staged.path,
                ],
            )
        }
        None => resolve_launch(location)?,
    };

    let interval = request.interval_ms.unwrap_or(1000).max(100);
    let max_types = request.max_types.unwrap_or(150).max(10);

    let recorder = if request.record || request.record_path.is_some() {
        Some(open_recording(&request, recordings_dir.as_deref(), false)?)
    } else {
        None
    };

    // The capture is the collector's own artifact: the host only decides where it goes, and it
    // goes next to the recordings because that is the folder the app already owns and shows.
    let file_name = format!("capture-{}-{}.nettrace", request.pid, now_unix_ms());
    let mut capture_copy: Option<CaptureCopy> = None;
    let capture_path = if request.deep_capture {
        let dir = recordings_dir
            .as_deref()
            .ok_or_else(|| "No capture directory is available for a deep capture.".to_string())?;
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

        match container {
            // The in-container collector can only write where the container can: `/tmp` exists in
            // every image and needs nothing created first. The finished file is copied out after
            // the collector exits, so the evidence outlives the container.
            Some(container) => {
                let remote = format!("/tmp/{file_name}");
                capture_copy = Some(CaptureCopy {
                    container: container.to_string(),
                    remote: remote.clone(),
                    local: dir.join(&file_name),
                });
                Some(remote)
            }
            None => Some(dir.join(file_name).display().to_string()),
        }
    } else {
        None
    };

    let mut command = Command::new(program);
    command
        .args(launcher_arguments)
        .arg("watch")
        .arg("--pid")
        .arg(request.pid.to_string())
        .arg("--interval")
        .arg(interval.to_string())
        .arg("--max-types")
        .arg(max_types.to_string());

    if !request.probes.is_empty() {
        command.arg("--probes").arg(request.probes.join(","));
    }

    if request.verbose {
        command.arg("--verbose");
    }

    if let Some(path) = &capture_path {
        command.arg("--capture").arg(path);
    }

    if let Some(max_mb) = request.capture_max_mb {
        command.arg("--capture-max-mb").arg(max_mb.to_string());
    }

    without_console_window(&mut command);

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start the collector process: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("The collector produced no stdout.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("The collector produced no stderr.")?;
    let stdin = child.stdin.take();

    let session_id = match container {
        Some(container) => format!(
            "docker-{}-pid{}-{}",
            session_key(container),
            request.pid,
            now_unix_ms()
        ),
        None => format!("pid{}-{}", request.pid, now_unix_ms()),
    };

    let inner = Arc::new(SessionInner {
        sink: sink.clone(),
        id: session_id.clone(),
        pid: request.pid,
        container: container.map(str::to_string),
        capture_copy,
        state: Mutex::new(SessionState::Starting),
        child: Arc::new(Mutex::new(Some(child))),
        stdin: Mutex::new(stdin),
        stop_requested: AtomicBool::new(false),
        // A capture-armed collector has minutes of post-stop work (drain, close, convert,
        // analyse), so it earns the long grace; a plain one only has to detach and exit.
        graceful_stop_timeout: if capture_path.is_some() {
            DEEP_CAPTURE_STOP_TIMEOUT
        } else {
            GRACEFUL_STOP_TIMEOUT
        },
        stats: SessionStats::default(),
        started_at_unix_ms: now_unix_ms(),
        message_counts: Mutex::new(HashMap::new()),
        recorder: Mutex::new(recorder),
    });

    let handle = SessionHandle(inner.clone());
    handle.0.set_state(SessionState::Running, None);

    spawn_stdout_pump(sink.clone(), inner.clone(), stdout);
    spawn_stderr_pump(sink, inner.clone(), stderr);

    Ok(handle)
}

/// Opens a recording for a session: at an explicit path if one was given, otherwise as an
/// auto-named file in the recordings directory.
fn open_recording(
    request: &SessionRequest,
    recordings_dir: Option<&Path>,
    started_mid_session: bool,
) -> Result<Arc<RecordingWriter>, String> {
    let target = RecordingTarget {
        pid: request.pid,
        name: request.target_name.clone(),
        runtime_version: request.target_runtime.clone(),
    };

    // Recorded as given, including the tunables: a replay should be able to say why there is
    // a sample every two seconds instead of every one.
    let options = serde_json::json!({
        "probes": request.probes,
        "intervalMs": request.interval_ms,
        "maxTypes": request.max_types,
        "verbose": request.verbose,
        "deepCapture": request.deep_capture,
        "captureMaxMb": request.capture_max_mb,
    });

    match request.record_path.as_deref() {
        Some(path) => {
            RecordingWriter::create_at(Path::new(path), target, options, started_mid_session)
        }
        None => {
            let dir = recordings_dir.ok_or_else(|| {
                "No recordings directory is available; pass an explicit recording path.".to_string()
            })?;
            RecordingWriter::create(dir, target, options, started_mid_session)
        }
    }
}

/// Reads the collector's stdout, batches messages and forwards them to the frontend.
///
/// Batching is not cosmetic: a heavily collecting runtime emits hundreds of GC and
/// allocation events per second, and one IPC round trip per event would saturate the webview
/// while adding nothing the UI can render (it repaints at most once per frame).
fn spawn_stdout_pump(
    sink: Arc<dyn EventSink>,
    inner: Arc<SessionInner>,
    stdout: std::process::ChildStdout,
) {
    // A dedicated reader thread feeds lines into a channel so this thread can flush a stale
    // batch on a deadline. Reading stdout directly would block, and a blocking read holds the
    // first messages of a quiet session hostage until the *next* line arrives: a probe set
    // whose only member reports at the end — a deep capture, say — would show nothing at all
    // until it finished.
    let (lines_tx, lines_rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if lines_tx.send(line).is_err() {
                break;
            }
        }
        // Dropping the sender ends the loop below.
    });

    thread::spawn(move || {
        let mut batch: Vec<serde_json::Value> = Vec::with_capacity(MESSAGE_BATCH_SIZE);
        let mut last_flush = Instant::now();

        loop {
            let line = match lines_rx.recv_timeout(MESSAGE_BATCH_INTERVAL) {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => {
                    // Nothing arrived within the batch window: send what is buffered anyway.
                    if !batch.is_empty() {
                        sink.messages(&inner.id, std::mem::take(&mut batch));
                        last_flush = Instant::now();
                    }
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            };

            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            let value: serde_json::Value = match serde_json::from_str(line) {
                Ok(value) => value,
                Err(_) => {
                    // Unparseable output is a collector bug, not a reason to stop.
                    inner.stats.dropped.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            };

            // Recorded before dispatch, and independently of it: a recording is the raw
            // evidence, so it must not depend on which message types this build of the host
            // happens to understand.
            if let Some(recorder) = inner.recorder() {
                recorder.record_message(&value);
            }

            inner.stats.messages.fetch_add(1, Ordering::Relaxed);

            let message_type = value
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("unknown");
            if let Ok(mut counts) = inner.message_counts.lock() {
                *counts.entry(message_type.to_string()).or_insert(0) += 1;
            }

            match message_type {
                "counter.sample" => {
                    inner.stats.counters.fetch_add(1, Ordering::Relaxed);
                }
                "allocation.sample" => {
                    inner
                        .stats
                        .allocation_samples
                        .fetch_add(1, Ordering::Relaxed);
                }
                "gc.event" => {
                    inner.stats.gc_events.fetch_add(1, Ordering::Relaxed);
                }
                "target.exited" => {
                    inner.set_state(
                        SessionState::Stopping,
                        Some("The target process exited.".into()),
                    );
                }
                _ => {}
            }

            batch.push(value);

            if batch.len() >= MESSAGE_BATCH_SIZE || last_flush.elapsed() >= MESSAGE_BATCH_INTERVAL {
                sink.messages(&inner.id, std::mem::take(&mut batch));
                last_flush = Instant::now();
            }
        }

        sink.messages(&inner.id, std::mem::take(&mut batch));

        let mut exit_detail = None;
        if let Ok(mut guard) = inner.child.lock() {
            if let Some(child) = guard.as_mut() {
                match child.wait() {
                    Ok(status) => {
                        exit_detail = Some(match status.code() {
                            Some(0) => "The collector stopped cleanly.".to_string(),
                            Some(code) => format!("The collector exited with code {code}."),
                            None => "The collector was terminated by a signal.".to_string(),
                        });
                    }
                    Err(e) => {
                        exit_detail = Some(format!("Could not read the collector exit status: {e}"))
                    }
                }
            }
        }

        // A capture written inside a container is only evidence once it is on this machine. The
        // collector closed and analysed the file before exiting, so this is the first moment the
        // copy can be complete. Its failure is reported rather than fatal: every other message
        // the session produced is already in the UI, and the file is still in the container.
        if let Some(copy) = &inner.capture_copy {
            match crate::docker::copy_out(&copy.container, &copy.remote, &copy.local) {
                Ok(()) => {
                    let bytes = fs::metadata(&copy.local)
                        .map(|metadata| metadata.len())
                        .unwrap_or(0);

                    // Until now the only path the UI has is the collector's, and that one exists
                    // inside the container. Once the copy has landed, keeping it would answer
                    // "where is the capture?" with a file the user cannot open, so the host
                    // corrects the record.
                    emit_host_message(
                        &inner,
                        "capture.copied",
                        serde_json::json!({
                            "path": copy.local.display().to_string(),
                            "bytes": bytes,
                            "container": copy.container,
                            "remote": copy.remote,
                        }),
                    );

                    inner.sink.log(
                        &inner.id,
                        "info",
                        &format!(
                            "Capture copied out of {} to {}.",
                            copy.container,
                            copy.local.display()
                        ),
                    );
                }
                Err(error) => {
                    // The file is still inside the container, and the path the collector reported
                    // stays the only path there is. Saying so on the same channel is what stops
                    // the rail from presenting `/tmp/…` as a file on this machine.
                    emit_host_message(
                        &inner,
                        "capture.copyFailed",
                        serde_json::json!({
                            "container": copy.container,
                            "remote": copy.remote,
                            "error": error,
                        }),
                    );

                    inner.sink.log(
                        &inner.id,
                        "warn",
                        &format!(
                            "The capture stayed inside {} at {}: {error}",
                            copy.container, copy.remote
                        ),
                    );
                }
            }
        }

        let failed = !inner.stop_requested.load(Ordering::SeqCst)
            && exit_detail
                .as_deref()
                .is_some_and(|d| !d.contains("cleanly"));

        // The footer is written before the final status is reported, so that by the time the
        // UI believes the session has ended the file on disk is already complete.
        let end_reason = if failed {
            "collector-failed"
        } else if inner.stop_requested.load(Ordering::SeqCst) {
            "detached"
        } else if inner
            .message_counts
            .lock()
            .map(|counts| counts.contains_key("target.exited"))
            .unwrap_or(false)
        {
            "target-exited"
        } else {
            "collector-exited"
        };

        if let Some(recorder) = inner.recorder() {
            recorder.finish(end_reason, inner.stats_snapshot());
        }

        inner.set_state(
            if failed {
                SessionState::Failed
            } else {
                SessionState::Stopped
            },
            exit_detail,
        );
    });
}

fn spawn_stderr_pump(
    sink: Arc<dyn EventSink>,
    inner: Arc<SessionInner>,
    stderr: std::process::ChildStderr,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            // Collector stderr is diagnostics, not metrics, but it is often the only clue
            // about why a recording is sparse, so it goes into the file too.
            if let Some(recorder) = inner.recorder() {
                recorder.record_log("debug", line);
            }

            sink.log(&inner.id, "debug", line);
        }
    });
}
