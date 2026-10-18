//! Session recording and offline replay.
//!
//! A recording is the collector's event stream written to disk verbatim. The file is newline
//! delimited JSON where every line carries a `kind` discriminator:
//!
//! ```text
//! {"kind":"header", ...}                       once, as the first line
//! {"kind":"message","envelope":{ ... }}        one per collector envelope
//! {"kind":"log","level":"debug","message":…}   one per collector stderr line
//! {"kind":"footer","endReason":"detached",…}   once, when the session ends cleanly
//! ```
//!
//! Three properties shape the design:
//!
//! *Recording is host-side only.* The collector knows nothing about files, so a new probe's
//! messages are recorded without touching its code. Everything that reaches the webview
//! passes through one place — the session's stdout pump — which is where the recorder sits.
//!
//! *Replay reuses the live path.* A player pushes the recorded envelopes through the same
//! [`EventSink`] as a live session, so every panel, chart and diagnosis rule works offline
//! with no idea that it is watching a file. There is no second, divergent rendering path to
//! keep in sync, which is why a replay is trustworthy evidence rather than a screenshot.
//!
//! *The timeline comes from the recording.* Messages keep their original `ts`, and the
//! frontend plots that instead of its own clock, so a two hour leak replayed at 64x still
//! reports the true "MB per minute". Anything else would make the headline number a
//! function of the playback speed.
//!
//! The file is deliberately boring: `jq`, `wc -l` and `grep` all work on it, which matters
//! when a recording is the only artifact you have from someone else's machine.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::collector::EventSink;

/// Playback state travels on its own channel: a replay is not a live session, and the shell
/// must be able to label it as such without guessing.
pub const EVENT_PLAYBACK: &str = "memoryspy://playback";

/// Version of the *file layout* (not of the collector protocol). A future reader can refuse
/// a newer layout instead of misinterpreting it.
pub const RECORDING_FORMAT_VERSION: u32 = 1;

pub const RECORDING_EXTENSION: &str = "jsonl";

const KIND_HEADER: &str = "header";
const KIND_MESSAGE: &str = "message";
const KIND_LOG: &str = "log";
const KIND_FOOTER: &str = "footer";

/// How often the buffered writer is flushed while recording. Bounds what a crash costs: at
/// most this much of the tail is missing, which is the difference between "lost the last
/// second" and "lost the leak I was trying to catch".
const RECORDING_FLUSH_INTERVAL: Duration = Duration::from_millis(250);

/// Progress reports are throttled so a fast replay cannot flood the IPC channel with updates
/// the UI cannot use.
const PLAYBACK_REPORT_INTERVAL: Duration = Duration::from_millis(400);

/// Envelopes are forwarded in batches, exactly like a live session would. At 64x a raw
/// stream would otherwise mean one IPC round trip per event.
const PLAYBACK_BATCH_MAX: usize = 250;
const PLAYBACK_BATCH_INTERVAL: Duration = Duration::from_millis(60);

/// A long quiet stretch is compressed to this much wall clock time. A service that idled for
/// ten minutes should not make a replay look hung; speed multiplies this, so 0.5x still
/// honours the pause faithfully.
const PLAYBACK_MAX_GAP: Duration = Duration::from_secs(20);

const SPEED_MIN: f64 = 0.1;
const SPEED_MAX: f64 = 1000.0;
const SPEED_DEFAULT: f64 = 1.0;

const MAX_TARGET_SLUG: usize = 40;
const MAX_LISTED_RECORDINGS: usize = 500;

/// Makes every replay's id unique, so the frontend can tell a fresh run from progress on the
/// one it is already showing.
static PLAYBACK_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        // The guarded state is plain bookkeeping (counters, paths) and stays consistent even
        // if a holder panicked, so poisoning must not take the feature down with it.
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}

// ---------------------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------------------

/// Who was being watched. Kept in the header so a recording is self-describing: a file
/// mailed from another machine still says which process produced it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingTarget {
    pub pid: i32,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub runtime_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingHeader {
    pub kind: String,
    pub format_version: u32,
    pub recorded_at_unix_ms: u64,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub target: Option<RecordingTarget>,
    /// The collector CLI options in force, so a replay can explain what it is showing.
    #[serde(default)]
    pub options: Value,
    /// True when recording began after attaching: the head of the session is simply not in
    /// the file, and a reader should not treat the first sample as t=0 of anything.
    #[serde(default)]
    pub started_mid_session: bool,
    #[serde(default)]
    pub host: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFooter {
    pub kind: String,
    pub ended_at_unix_ms: u64,
    pub end_reason: String,
    #[serde(default)]
    pub messages: u64,
    #[serde(default)]
    pub logs: u64,
    #[serde(default)]
    pub stats: Value,
}

/// Everything the recordings list needs, without loading a whole file into memory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSummary {
    pub path: String,
    pub file_name: String,
    pub target_name: Option<String>,
    pub target_pid: Option<i32>,
    pub runtime_version: Option<String>,
    pub started_at_unix_ms: u64,
    pub last_event_unix_ms: u64,
    pub duration_ms: u64,
    pub size_bytes: u64,
    pub line_count: u64,
    pub message_count: u64,
    pub log_count: u64,
    pub skipped_lines: u64,
    pub end_reason: Option<String>,
    /// A footer was written, i.e. the session ended through a clean shutdown.
    pub complete: bool,
    pub format_version: Option<u32>,
    pub started_mid_session: bool,
    /// Envelope type to count. This is what lets the UI decide which views a recording can
    /// actually feed, instead of guessing from the live collector's capabilities.
    pub message_types: BTreeMap<String, u64>,
    pub error: Option<String>,
}

/// Where recordings live by default. App *data* rather than app config: these are outputs,
/// not preferences, and a user should be able to point a colleague at the folder.
pub fn recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve the app data directory: {e}"))?;

    let dir = base.join("recordings");
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Resolves `candidate` and refuses anything that is not inside `dir`.
///
/// Deletion is the only irreversible action in the app, so this lives here as a plain
/// function instead of inline in a command, where no test could reach it.
pub fn resolve_inside(dir: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("Could not resolve {}: {e}", dir.display()))?;
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|e| format!("Could not resolve {}: {e}", candidate.display()))?;

    if !canonical_candidate.starts_with(&canonical_dir) {
        return Err(format!(
            "{} is outside the recordings folder; only MemorySpy's own recordings can be deleted.",
            candidate.display()
        ));
    }

    Ok(canonical_candidate)
}

/// Lists every recording in `dir`, newest first.
pub fn list_recordings(dir: &Path) -> Result<Vec<RecordingSummary>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // A missing directory simply means nothing has been recorded yet.
        Err(_) => return Ok(Vec::new()),
    };

    let mut summaries: Vec<RecordingSummary> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case(RECORDING_EXTENSION))
        })
        .take(MAX_LISTED_RECORDINGS)
        .map(|path| match read_summary(&path) {
            Ok(summary) => summary,
            Err(error) => RecordingSummary {
                path: path.display().to_string(),
                file_name: file_name_of(&path),
                target_name: None,
                target_pid: None,
                runtime_version: None,
                started_at_unix_ms: 0,
                last_event_unix_ms: 0,
                duration_ms: 0,
                size_bytes: fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
                line_count: 0,
                message_count: 0,
                log_count: 0,
                skipped_lines: 0,
                end_reason: None,
                complete: false,
                format_version: None,
                started_mid_session: false,
                message_types: BTreeMap::new(),
                error: Some(error),
            },
        })
        .collect();

    summaries.sort_by(|a, b| b.started_at_unix_ms.cmp(&a.started_at_unix_ms));
    Ok(summaries)
}

/// Reads a recording's metadata. Streaming rather than loading: a long recording is
/// hundreds of megabytes, and the list view only needs counts and the last timestamp.
pub fn read_summary(path: &Path) -> Result<RecordingSummary, String> {
    let size_bytes = fs::metadata(path)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?
        .len();

    let mut reader = RecordingReader::open(path)?;
    while reader.next_event().is_some() {}

    Ok(reader.into_summary(path, size_bytes, None))
}

// ---------------------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------------------

/// Appends collector output to a recording file.
///
/// One writer owns one file and is shared by the session's stdout and stderr pumps, so this
/// must be cheap: a message costs one buffered write plus a periodic flush.
pub struct RecordingWriter {
    path: PathBuf,
    file: Mutex<BufWriter<File>>,
    target: RecordingTarget,
    started_at_unix_ms: u64,
    started_mid_session: bool,
    bytes: AtomicU64,
    messages: AtomicU64,
    logs: AtomicU64,
    broken: AtomicBool,
    finished: AtomicBool,
    last_flush: Mutex<Instant>,
    error: Mutex<Option<String>>,
    end_reason: Mutex<Option<String>>,
}

impl RecordingWriter {
    /// Creates a recording in `dir`, naming the file after the target and the current time.
    pub fn create(
        dir: &Path,
        target: RecordingTarget,
        options: Value,
        started_mid_session: bool,
    ) -> Result<Arc<Self>, String> {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        Self::create_at(
            &unique_path(dir, &target),
            target,
            options,
            started_mid_session,
        )
    }

    /// Creates a recording at an exact path. Used for an explicit destination and by tests.
    pub fn create_at(
        path: &Path,
        target: RecordingTarget,
        options: Value,
        started_mid_session: bool,
    ) -> Result<Arc<Self>, String> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        }

        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)
            .map_err(|e| {
                format!(
                    "Could not create the recording file {}: {e}",
                    path.display()
                )
            })?;

        let started_at_unix_ms = now_unix_ms();

        let writer = Arc::new(Self {
            path: path.to_path_buf(),
            file: Mutex::new(BufWriter::with_capacity(64 * 1024, file)),
            target,
            started_at_unix_ms,
            started_mid_session,
            bytes: AtomicU64::new(0),
            messages: AtomicU64::new(0),
            logs: AtomicU64::new(0),
            broken: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            last_flush: Mutex::new(Instant::now()),
            error: Mutex::new(None),
            end_reason: Mutex::new(None),
        });

        // The header goes to disk immediately. A file whose first flush never happened would
        // be rejected as "not a recording" by every reader, including our own.
        writer.write_line(&json!({
            "kind": KIND_HEADER,
            "formatVersion": RECORDING_FORMAT_VERSION,
            "recordedAtUnixMs": started_at_unix_ms,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "host": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
            "target": writer.target,
            "options": options,
            "startedMidSession": started_mid_session,
        }));
        writer.flush();

        Ok(writer)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn error(&self) -> Option<String> {
        lock(&self.error).clone()
    }

    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::Relaxed)
    }

    pub fn message_count(&self) -> u64 {
        self.messages.load(Ordering::Relaxed)
    }

    /// Records one collector envelope, exactly as it was read from the collector.
    pub fn record_message(&self, envelope: &Value) {
        if self.write_line(&json!({ "kind": KIND_MESSAGE, "envelope": envelope })) {
            self.messages.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Records a collector stderr line. Kept because the diagnostics panel is often the only
    /// clue about *why* a recording is sparse.
    pub fn record_log(&self, level: &str, message: &str) {
        if self.write_line(&json!({
            "kind": KIND_LOG,
            "level": level,
            "message": message,
            "ts": now_unix_ms(),
        })) {
            self.logs.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Writes the footer and closes the file. Idempotent, and safe to call from a shutdown
    /// path that may race with a normal detach.
    pub fn finish(&self, reason: &str, stats: Value) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }

        *lock(&self.end_reason) = Some(reason.to_string());
        self.write_line(&json!({
            "kind": KIND_FOOTER,
            "endedAtUnixMs": now_unix_ms(),
            "endReason": reason,
            "messages": self.messages.load(Ordering::Relaxed),
            "logs": self.logs.load(Ordering::Relaxed),
            "stats": stats,
        }));
        self.flush();
    }

    /// A snapshot of the recording's current state, for the UI and for the command result.
    pub fn summary(&self) -> RecordingSummary {
        // A stat is more truthful than the write counter once a buffer is pending.
        let size_bytes = fs::metadata(&self.path)
            .map(|meta| meta.len())
            .unwrap_or_else(|_| self.bytes.load(Ordering::Relaxed));

        RecordingSummary {
            path: self.path.display().to_string(),
            file_name: file_name_of(&self.path),
            target_name: self.target.name.clone(),
            target_pid: Some(self.target.pid),
            runtime_version: self.target.runtime_version.clone(),
            started_at_unix_ms: self.started_at_unix_ms,
            last_event_unix_ms: now_unix_ms(),
            duration_ms: now_unix_ms().saturating_sub(self.started_at_unix_ms),
            size_bytes,
            line_count: self.messages.load(Ordering::Relaxed)
                + self.logs.load(Ordering::Relaxed)
                + 1,
            message_count: self.messages.load(Ordering::Relaxed),
            log_count: self.logs.load(Ordering::Relaxed),
            skipped_lines: 0,
            end_reason: lock(&self.end_reason).clone(),
            complete: self.finished.load(Ordering::Relaxed),
            format_version: Some(RECORDING_FORMAT_VERSION),
            started_mid_session: self.started_mid_session,
            // A live summary is built from counters, not by re-reading the file; the full
            // histogram belongs to whoever lists the finished recording.
            message_types: BTreeMap::new(),
            error: self.error(),
        }
    }

    fn write_line(&self, value: &Value) -> bool {
        if self.broken.load(Ordering::Relaxed) {
            return false;
        }

        let mut line = value.to_string();
        line.push('\n');

        {
            let mut guard = lock(&self.file);
            if let Err(error) = guard.write_all(line.as_bytes()) {
                // Record the failure once and stop trying: a full disk would otherwise turn
                // into a write attempt and an error string per message.
                self.broken.store(true, Ordering::Relaxed);
                *lock(&self.error) = Some(format!("Recording stopped writing: {error}"));
                return false;
            }
        }

        self.bytes.fetch_add(line.len() as u64, Ordering::Relaxed);

        let due = {
            let mut last = lock(&self.last_flush);
            if last.elapsed() >= RECORDING_FLUSH_INTERVAL {
                *last = Instant::now();
                true
            } else {
                false
            }
        };
        if due {
            self.flush();
        }

        true
    }

    fn flush(&self) {
        let _ = lock(&self.file).flush();
    }
}

/// A path that does not exist yet, derived from the target's name and the current time.
fn unique_path(dir: &Path, target: &RecordingTarget) -> PathBuf {
    let stamp = format_utc_compact(now_unix_ms());
    let stem = format!(
        "memoryspy-{}-{}-{stamp}",
        slugify(target.name.as_deref().unwrap_or("process")),
        target.pid
    );

    let candidate = dir.join(format!("{stem}.{RECORDING_EXTENSION}"));
    if !candidate.exists() {
        return candidate;
    }

    for suffix in 2..1_000 {
        let candidate = dir.join(format!("{stem}-{suffix}.{RECORDING_EXTENSION}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    dir.join(format!("{stem}-{}.{RECORDING_EXTENSION}", now_unix_ms()))
}

/// A file-name-safe fragment of a process name.
fn slugify(name: &str) -> String {
    let trimmed = name
        .trim_end_matches(".exe")
        .trim_end_matches(".dll")
        .trim_end_matches(".so");

    let mut slug = String::with_capacity(trimmed.len());
    let mut last_dash = false;

    for character in trimmed.chars() {
        if character.is_ascii_alphanumeric() || character == '.' || character == '_' {
            slug.push(character);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }

    let slug = slug.trim_matches('-').to_string();
    let slug = if slug.is_empty() {
        "process".to_string()
    } else {
        slug
    };

    slug.chars().take(MAX_TARGET_SLUG).collect()
}

/// `20261015-142530`, in UTC. Timestamps are sorted lexically in a directory listing, which
/// is why the order is year first.
fn format_utc_compact(unix_ms: u64) -> String {
    let seconds = unix_ms / 1000;
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);

    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        rest / 3_600,
        (rest % 3_600) / 60,
        rest % 60
    )
}

/// Days since the Unix epoch to a civil date (Howard Hinnant's algorithm). Avoids pulling a
/// date-time crate in for one file name.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };

    (if month <= 2 { year + 1 } else { year }, month, day)
}

// ---------------------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------------------

/// One replayable item from a recording.
#[derive(Debug, Clone)]
enum RecordedEvent {
    Message(Value),
    Log {
        level: String,
        message: String,
        ts: u64,
    },
}

impl RecordedEvent {
    fn ts(&self) -> u64 {
        match self {
            RecordedEvent::Message(envelope) => envelope_ts(envelope),
            RecordedEvent::Log { ts, .. } => *ts,
        }
    }

    /// Replay feeds the frontend the same envelopes a live session would. A recorded stderr
    /// line becomes a `log` envelope rather than a host log, because the store stamps host
    /// logs with the wall clock — which during a replay is not when it happened.
    fn into_envelope(self) -> Value {
        match self {
            RecordedEvent::Message(envelope) => envelope,
            RecordedEvent::Log { level, message, ts } => json!({
                "v": 1,
                "seq": 0,
                "ts": ts,
                "type": "log",
                "probe": null,
                "data": { "level": level, "message": message },
            }),
        }
    }
}

fn envelope_ts(envelope: &Value) -> u64 {
    envelope.get("ts").and_then(Value::as_u64).unwrap_or(0)
}

/// Streams a recording line by line.
///
/// The reader is deliberately tolerant. A file with no header (a plain envelope dump from
/// another tool), an unknown `kind`, or a truncated final line must all still replay: a
/// recording is often the only artifact that survived a crash on someone else's machine, so
/// refusing to open it would throw away the evidence.
struct RecordingReader {
    lines: std::io::Lines<BufReader<File>>,
    header: Option<RecordingHeader>,
    footer: Option<RecordingFooter>,
    message_types: BTreeMap<String, u64>,
    /// The first event, read while consuming the header. Held here because the header has to
    /// be seen before the caller can ask for the timeline's origin, and the first event must
    /// not be lost in the process.
    pending: Option<RecordedEvent>,
    first_event_ts: Option<u64>,
    last_event_ts: u64,
    line_count: u64,
    message_count: u64,
    log_count: u64,
    skipped: u64,
    done: bool,
}

impl RecordingReader {
    fn open(path: &Path) -> Result<Self, String> {
        let file =
            File::open(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;

        let mut reader = Self {
            lines: BufReader::with_capacity(128 * 1024, file).lines(),
            header: None,
            footer: None,
            message_types: BTreeMap::new(),
            pending: None,
            first_event_ts: None,
            last_event_ts: 0,
            line_count: 0,
            message_count: 0,
            log_count: 0,
            skipped: 0,
            done: false,
        };

        // Consume the leading header (or the first event, for a headerless dump) now: until
        // this has happened there is no timeline origin, and pacing the first gap against a
        // missing origin would make a replay wait for the whole age of the file.
        while reader.header.is_none() && reader.pending.is_none() && !reader.done {
            reader.pending = reader.parse_next();
        }

        Ok(reader)
    }

    /// The instant the recording's timeline starts. Falls back to the first event for files
    /// without a header.
    fn start_ts(&self) -> u64 {
        self.header
            .as_ref()
            .map(|header| header.recorded_at_unix_ms)
            .or(self.first_event_ts)
            .unwrap_or_else(|| self.last_event_ts)
    }

    fn last_event_ts(&self) -> u64 {
        self.last_event_ts
    }

    fn count_message(&mut self, envelope: &Value) {
        self.message_count += 1;
        self.note_event(envelope_ts(envelope));

        if let Some(message_type) = envelope.get("type").and_then(Value::as_str) {
            *self
                .message_types
                .entry(message_type.to_string())
                .or_insert(0) += 1;
        }
    }

    fn note_event(&mut self, ts: u64) {
        if self.first_event_ts.is_none() {
            self.first_event_ts = Some(ts);
        }
        self.last_event_ts = self.last_event_ts.max(ts);
    }

    fn next_event(&mut self) -> Option<RecordedEvent> {
        if let Some(event) = self.pending.take() {
            return Some(event);
        }

        self.parse_next()
    }

    fn parse_next(&mut self) -> Option<RecordedEvent> {
        while !self.done {
            let line = match self.lines.next() {
                Some(Ok(line)) => line,
                // A read error or EOF ends the stream; a truncated tail is exactly what an
                // interrupted recording looks like.
                Some(Err(_)) | None => {
                    self.done = true;
                    return None;
                }
            };

            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            self.line_count += 1;

            let value: Value = match serde_json::from_str(line) {
                Ok(value) => value,
                Err(_) => {
                    self.skipped += 1;
                    continue;
                }
            };

            match value.get("kind").and_then(Value::as_str) {
                Some(KIND_HEADER) => match serde_json::from_value::<RecordingHeader>(value) {
                    Ok(header) => {
                        self.last_event_ts = self.last_event_ts.max(header.recorded_at_unix_ms);
                        self.header = Some(header);
                    }
                    Err(_) => self.skipped += 1,
                },
                Some(KIND_FOOTER) => {
                    if let Ok(footer) = serde_json::from_value::<RecordingFooter>(value) {
                        self.last_event_ts = self.last_event_ts.max(footer.ended_at_unix_ms);
                        self.footer = Some(footer);
                    } else {
                        self.skipped += 1;
                    }
                    self.done = true;
                    return None;
                }
                Some(KIND_LOG) => {
                    let ts = value
                        .get("ts")
                        .and_then(Value::as_u64)
                        .unwrap_or(self.last_event_ts);
                    self.log_count += 1;
                    self.note_event(ts);
                    return Some(RecordedEvent::Log {
                        level: value
                            .get("level")
                            .and_then(Value::as_str)
                            .unwrap_or("info")
                            .to_string(),
                        message: value
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        ts,
                    });
                }
                Some(KIND_MESSAGE) => {
                    let Some(envelope) = value.get("envelope") else {
                        self.skipped += 1;
                        continue;
                    };
                    let envelope = envelope.clone();
                    self.count_message(&envelope);
                    return Some(RecordedEvent::Message(envelope));
                }
                _ => {
                    // An unwrapped envelope: the shape any other capture tool would produce.
                    if value.get("ts").is_some() && value.get("type").is_some() {
                        self.count_message(&value);
                        return Some(RecordedEvent::Message(value));
                    }
                    self.skipped += 1;
                }
            }
        }

        None
    }

    fn into_summary(self, path: &Path, size_bytes: u64, error: Option<String>) -> RecordingSummary {
        let started_at_unix_ms = self
            .header
            .as_ref()
            .map(|header| header.recorded_at_unix_ms)
            .or(self.first_event_ts)
            .unwrap_or(0);

        let last_event_unix_ms = self.last_event_ts.max(started_at_unix_ms);

        RecordingSummary {
            path: path.display().to_string(),
            file_name: file_name_of(path),
            target_name: self.header.as_ref().and_then(|header| {
                header
                    .target
                    .as_ref()
                    .and_then(|target| target.name.clone())
            }),
            target_pid: self
                .header
                .as_ref()
                .and_then(|header| header.target.as_ref())
                .map(|target| target.pid),
            runtime_version: self.header.as_ref().and_then(|header| {
                header
                    .target
                    .as_ref()
                    .and_then(|target| target.runtime_version.clone())
            }),
            started_at_unix_ms,
            last_event_unix_ms,
            duration_ms: last_event_unix_ms.saturating_sub(started_at_unix_ms),
            size_bytes,
            line_count: self.line_count,
            message_count: self.message_count,
            log_count: self.log_count,
            skipped_lines: self.skipped,
            end_reason: self.footer.as_ref().map(|footer| footer.end_reason.clone()),
            complete: self.footer.is_some(),
            format_version: self.header.as_ref().map(|header| header.format_version),
            started_mid_session: self
                .header
                .as_ref()
                .map(|header| header.started_mid_session)
                .unwrap_or(false),
            message_types: self.message_types,
            error,
        }
    }
}

// ---------------------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackState {
    Loading,
    Playing,
    Paused,
    Stopped,
    Finished,
    Failed,
}

impl PlaybackState {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            PlaybackState::Stopped | PlaybackState::Finished | PlaybackState::Failed
        )
    }
}

#[derive(Debug, Clone)]
enum PlaybackCommand {
    Pause,
    Resume,
    SetSpeed(f64),
    Seek(u64),
    Stop,
}

/// Pacing state for one pass over a recording.
///
/// The timeline is driven by a deadline rather than by sleeping for each gap: that is what
/// lets a speed change, a pause or a seek take effect immediately instead of after the
/// current wait finishes.
struct Pacing {
    speed: f64,
    paused: bool,
    /// What was left of the current gap when the user paused.
    resume_delay: Duration,
    deadline: Instant,
    /// The recording-time gap being waited for, needed to re-pace after a speed change.
    gap_ms: u64,
}

impl Pacing {
    fn new(speed: f64) -> Self {
        Self {
            speed,
            paused: false,
            resume_delay: Duration::ZERO,
            deadline: Instant::now(),
            gap_ms: 0,
        }
    }

    fn schedule(&mut self, gap_ms: u64) {
        self.gap_ms = gap_ms;
        self.deadline = Instant::now() + scaled_gap(gap_ms, self.speed);
    }
}

/// Compresses a recording-time gap into wall clock time.
fn scaled_gap(gap_ms: u64, speed: f64) -> Duration {
    let speed = if speed.is_finite() && speed > 0.0 {
        speed
    } else {
        SPEED_DEFAULT
    };

    let scaled = (gap_ms as f64) / speed;
    let capped = scaled.min(PLAYBACK_MAX_GAP.as_millis() as f64);
    Duration::from_millis(capped.max(0.0) as u64)
}

struct PlaybackRuntime {
    state: PlaybackState,
    speed: f64,
    position_ms: u64,
    duration_ms: u64,
    /// Bumped whenever playback restarts, so the frontend knows to drop the buffers it has.
    generation: u64,
    emitted: u64,
    error: Option<String>,
    last_report: Instant,
}

pub struct PlaybackInner {
    id: String,
    path: PathBuf,
    sink: Arc<dyn EventSink>,
    summary: RecordingSummary,
    control: Mutex<Option<Sender<PlaybackCommand>>>,
    runtime: Mutex<PlaybackRuntime>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

impl PlaybackInner {
    fn update(&self, mutate: impl FnOnce(&mut PlaybackRuntime)) {
        mutate(&mut lock(&self.runtime));
    }

    /// Emits a playback status, throttled unless `force`. Progress updates at 60 frames per
    /// second would cost more than the messages themselves.
    fn report(&self, force: bool) {
        let payload = {
            let mut runtime = lock(&self.runtime);
            if !force && runtime.last_report.elapsed() < PLAYBACK_REPORT_INTERVAL {
                return;
            }
            runtime.last_report = Instant::now();

            json!({
                "playbackId": self.id,
                "state": runtime.state,
                "speed": runtime.speed,
                "positionMs": runtime.position_ms,
                "durationMs": runtime.duration_ms,
                "generation": runtime.generation,
                "emitted": runtime.emitted,
                "error": runtime.error,
                "recording": self.summary,
            })
        };

        self.sink.playback(payload);
    }

    fn fail(&self, error: String) {
        self.update(|runtime| {
            runtime.state = PlaybackState::Failed;
            runtime.error = Some(error.clone());
        });
        self.report(true);
    }

    fn is_active(&self) -> bool {
        !lock(&self.runtime).state.is_terminal()
    }
}

/// A running replay. Cloning shares one player.
#[derive(Clone)]
pub struct PlaybackHandle(Arc<PlaybackInner>);

impl PlaybackHandle {
    /// Starts replaying `path`. The recording is parsed eagerly so an unreadable file fails
    /// the command instead of producing a replay that silently shows nothing.
    pub fn start(
        sink: Arc<dyn EventSink>,
        path: &Path,
        speed: Option<f64>,
    ) -> Result<Self, String> {
        let summary = read_summary(path)?;

        if summary.message_count == 0 && summary.log_count == 0 {
            return Err(format!(
                "{} contains no recorded events ({} lines skipped).",
                summary.file_name, summary.skipped_lines
            ));
        }

        let speed = speed
            .map(|value| value.clamp(SPEED_MIN, SPEED_MAX))
            .unwrap_or(SPEED_DEFAULT);

        // Unique per run, not per file: replaying the same recording twice must be two
        // distinct replays as far as the UI is concerned, so that its buffers are cleared
        // rather than replayed on top of the previous run's data.
        let sequence = PLAYBACK_SEQUENCE.fetch_add(1, Ordering::Relaxed);

        let inner = Arc::new(PlaybackInner {
            id: format!(
                "replay-{}-{sequence}",
                summary
                    .file_name
                    .trim_end_matches(&format!(".{RECORDING_EXTENSION}"))
            ),
            path: path.to_path_buf(),
            sink,
            summary: summary.clone(),
            control: Mutex::new(None),
            runtime: Mutex::new(PlaybackRuntime {
                state: PlaybackState::Loading,
                speed,
                position_ms: 0,
                duration_ms: summary.duration_ms,
                generation: 0,
                emitted: 0,
                error: None,
                last_report: Instant::now(),
            }),
            thread: Mutex::new(None),
        });

        let (sender, receiver) = mpsc::channel();
        *lock(&inner.control) = Some(sender);

        let thread = {
            let inner = inner.clone();
            thread::Builder::new()
                .name("memoryspy-playback".into())
                .spawn(move || run_playback(inner, receiver))
                .map_err(|e| format!("Could not start the replay thread: {e}"))?
        };
        *lock(&inner.thread) = Some(thread);

        let handle = Self(inner);
        handle.0.report(true);
        Ok(handle)
    }

    pub fn id(&self) -> &str {
        &self.0.id
    }

    pub fn summary(&self) -> &RecordingSummary {
        &self.0.summary
    }

    pub fn is_active(&self) -> bool {
        self.0.is_active()
    }

    pub fn snapshot(&self) -> Value {
        let runtime = lock(&self.0.runtime);
        json!({
            "playbackId": self.0.id,
            "state": runtime.state,
            "speed": runtime.speed,
            "positionMs": runtime.position_ms,
            "durationMs": runtime.duration_ms,
            "generation": runtime.generation,
            "emitted": runtime.emitted,
            "error": runtime.error,
            "recording": self.0.summary,
        })
    }

    pub fn pause(&self) -> Result<(), String> {
        self.send(PlaybackCommand::Pause)
    }

    pub fn resume(&self) -> Result<(), String> {
        self.send(PlaybackCommand::Resume)
    }

    pub fn set_speed(&self, speed: f64) -> Result<(), String> {
        self.send(PlaybackCommand::SetSpeed(speed.clamp(SPEED_MIN, SPEED_MAX)))
    }

    pub fn seek(&self, position_ms: u64) -> Result<(), String> {
        let duration = lock(&self.0.runtime).duration_ms;
        self.send(PlaybackCommand::Seek(position_ms.min(duration.max(1))))
    }

    /// Stops the replay and waits briefly for the thread to unwind.
    ///
    /// The wait exists because the caller usually stops a replay in order to delete or
    /// re-read the file, which is exactly when an actor still holding the reader is a
    /// problem. It is bounded rather than a `join`: a replay wedged in a long fast-forward
    /// must not be able to freeze the command that asked it to stop. The thread's own
    /// ownership of the file is what actually releases it, and the wait covers that.
    pub fn stop(&self) {
        let _ = self.send(PlaybackCommand::Stop);

        let deadline = Instant::now() + Duration::from_millis(750);
        while Instant::now() < deadline && self.0.is_active() {
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn send(&self, command: PlaybackCommand) -> Result<(), String> {
        let guard = lock(&self.0.control);
        match guard.as_ref() {
            Some(sender) => sender
                .send(command)
                .map_err(|_| "The replay has already finished.".to_string()),
            None => Err("The replay has already finished.".to_string()),
        }
    }
}

/// What a control command asked the stream loop to do.
enum CommandEffect {
    /// Applied; keep waiting for the next event.
    Applied,
    /// Restart the file and fast-forward to this recording-time position.
    Restart(u64),
    Stop,
}

fn apply_command(
    command: PlaybackCommand,
    pacing: &mut Pacing,
    inner: &PlaybackInner,
) -> CommandEffect {
    match command {
        PlaybackCommand::Pause => {
            if !pacing.paused {
                pacing.resume_delay = pacing.deadline.saturating_duration_since(Instant::now());
                pacing.paused = true;
                inner.update(|runtime| runtime.state = PlaybackState::Paused);
                inner.report(true);
            }
            CommandEffect::Applied
        }
        PlaybackCommand::Resume => {
            if pacing.paused {
                pacing.paused = false;
                pacing.deadline = Instant::now() + pacing.resume_delay;
                inner.update(|runtime| runtime.state = PlaybackState::Playing);
                inner.report(true);
            }
            CommandEffect::Applied
        }
        PlaybackCommand::SetSpeed(speed) => {
            pacing.speed = speed;
            // Re-pace the gap in flight from now, so the user sees the change immediately
            // instead of after the old wait completes.
            pacing.deadline = Instant::now() + scaled_gap(pacing.gap_ms, speed);
            inner.update(|runtime| runtime.speed = speed);
            inner.report(true);
            CommandEffect::Applied
        }
        PlaybackCommand::Seek(position) => CommandEffect::Restart(position),
        PlaybackCommand::Stop => CommandEffect::Stop,
    }
}

/// Replays a recording, honouring its original timing.
///
/// The structure is: open the file, walk the events, wait out each gap while staying
/// responsive to control commands, and restart from the top when asked to seek. Seeking
/// re-reads from the beginning and forwards everything up to the target as fast as the
/// buffer allows, so the frontend's accumulated state is genuinely the state at that
/// position — a silent jump would leave charts showing the future and the past at once.
fn run_playback(inner: Arc<PlaybackInner>, receiver: Receiver<PlaybackCommand>) {
    let mut pacing = Pacing::new(lock(&inner.runtime).speed);
    let mut pending_seek: Option<u64> = None;
    let mut generation: u64 = 0;

    'outer: loop {
        generation += 1;

        let mut reader = match RecordingReader::open(&inner.path) {
            Ok(reader) => reader,
            Err(error) => {
                inner.fail(error);
                return;
            }
        };

        let base_ts = reader.start_ts();
        let mut last_ts = base_ts;
        // A seek is a fast-forward until the target, then normal pacing resumes.
        let mut fast_forward_until = pending_seek
            .take()
            .map(|position| base_ts.saturating_add(position));
        let mut batch: Vec<Value> = Vec::new();
        let mut last_batch_flush = Instant::now();

        inner.update(|runtime| {
            runtime.state = PlaybackState::Playing;
            runtime.generation = generation;
            runtime.position_ms = 0;
            runtime.emitted = 0;
            runtime.error = None;
            runtime.speed = pacing.speed;
        });
        inner.report(true);

        loop {
            let Some(event) = reader.next_event() else {
                flush_batch(&inner, &mut batch);
                let position = reader.last_event_ts().saturating_sub(base_ts);
                inner.update(|runtime| {
                    runtime.state = PlaybackState::Finished;
                    runtime.position_ms = position;
                });
                inner.report(true);
                break 'outer;
            };

            let ts = event.ts();

            // Still inside a seek's fast-forward: forward without waiting.
            let skipping = fast_forward_until.is_some_and(|until| ts < until);

            if !skipping {
                if fast_forward_until.take().is_some() {
                    // This event is the one the seek asked for, so it is due now. Normal
                    // pacing resumes from here — and any pause left over from before the
                    // seek must not carry its stale in-flight delay into the new run.
                    pacing.deadline = Instant::now();
                    pacing.resume_delay = Duration::ZERO;
                    inner.update(|runtime| runtime.position_ms = ts.saturating_sub(base_ts));
                    inner.report(true);
                } else {
                    pacing.schedule(ts.saturating_sub(last_ts));
                }

                let mut restart: Option<u64> = None;
                let mut stop = false;

                loop {
                    if pacing.paused {
                        // While paused there is no deadline to wait for, so block for a
                        // command rather than spinning.
                        match receiver.recv() {
                            Ok(command) => match apply_command(command, &mut pacing, &inner) {
                                CommandEffect::Restart(position) => {
                                    restart = Some(position);
                                    break;
                                }
                                CommandEffect::Stop => {
                                    stop = true;
                                    break;
                                }
                                CommandEffect::Applied => continue,
                            },
                            Err(_) => {
                                stop = true;
                                break;
                            }
                        }
                    }

                    let remaining = pacing.deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }

                    match receiver.recv_timeout(remaining) {
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => {
                            stop = true;
                            break;
                        }
                        Ok(command) => match apply_command(command, &mut pacing, &inner) {
                            CommandEffect::Restart(position) => {
                                restart = Some(position);
                                break;
                            }
                            CommandEffect::Stop => {
                                stop = true;
                                break;
                            }
                            CommandEffect::Applied => continue,
                        },
                    }
                }

                if stop {
                    flush_batch(&inner, &mut batch);
                    let position = last_ts.saturating_sub(base_ts);
                    inner.update(|runtime| {
                        runtime.state = PlaybackState::Stopped;
                        runtime.position_ms = position;
                    });
                    inner.report(true);
                    break 'outer;
                }

                if let Some(position) = restart {
                    flush_batch(&inner, &mut batch);
                    pending_seek = Some(position);
                    continue 'outer;
                }
            }

            batch.push(event.into_envelope());
            last_ts = ts;
            inner.update(|runtime| runtime.emitted += 1);

            if batch.len() >= PLAYBACK_BATCH_MAX
                || last_batch_flush.elapsed() >= PLAYBACK_BATCH_INTERVAL
            {
                flush_batch(&inner, &mut batch);
                last_batch_flush = Instant::now();
            }

            inner.update(|runtime| runtime.position_ms = ts.saturating_sub(base_ts));
            inner.report(false);
        }
    }
}

fn flush_batch(inner: &PlaybackInner, batch: &mut Vec<Value>) {
    if batch.is_empty() {
        return;
    }
    inner.sink.messages(&inner.id, std::mem::take(batch));
}
