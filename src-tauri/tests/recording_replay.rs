//! Verification of the recording format and of offline replay.
//!
//! Two kinds of test live here:
//!
//! *Format tests* are pure filesystem work. They pin down the promises a recording makes to
//! whoever opens it later — a header that identifies the target, a footer that says the
//! session ended, skipped lines counted rather than fatal, and a replay that reproduces the
//! recorded envelopes byte for byte. A tolerance regression here would silently corrupt
//! evidence, so it is worth an explicit test.
//!
//! *The end-to-end test* records a real leaking .NET process through the real supervisor and
//! then replays the file with no process attached at all. That is the actual feature: the
//! leak happened on a machine nobody can reach any more, and the analysis still works.
//!
//! Needs the collector and the sample built:
//!
//! ```sh
//! npm run collector:build && npm run sample:build
//! cargo test --manifest-path src-tauri/Cargo.toml
//! ```

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use memoryspy_lib::collector::{self, EventSink, SessionRequest, SessionState};
use memoryspy_lib::recording::{self, PlaybackHandle, PlaybackState, RecordingTarget, RecordingWriter};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// A per-test scratch directory, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "memoryspy-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn leaky_target() -> RecordingTarget {
    RecordingTarget {
        pid: 4242,
        name: Some("MemorySpy.Samples.LeakyCache".to_string()),
        runtime_version: Some("10.0.9".to_string()),
    }
}

/// Captures everything a sink is sent, including the playback channel.
#[derive(Default)]
struct CapturingSink {
    messages: Mutex<Vec<Value>>,
    playback: Mutex<Vec<Value>>,
    logs: Mutex<Vec<String>>,
}

impl EventSink for CapturingSink {
    fn messages(&self, _session_id: &str, messages: Vec<Value>) {
        self.messages.lock().unwrap().extend(messages);
    }

    fn log(&self, _session_id: &str, _level: &str, message: &str) {
        self.logs.lock().unwrap().push(message.to_string());
    }

    fn status(
        &self,
        _session_id: &str,
        _pid: i32,
        _state: SessionState,
        _detail: Option<String>,
        _stats: Value,
    ) {
    }

    fn playback(&self, payload: Value) {
        self.playback.lock().unwrap().push(payload);
    }
}

impl CapturingSink {
    fn envelopes(&self) -> Vec<Value> {
        self.messages.lock().unwrap().clone()
    }

    fn count(&self) -> usize {
        self.messages.lock().unwrap().len()
    }

    fn of_type(&self, message_type: &str) -> Vec<Value> {
        self.envelopes()
            .into_iter()
            .filter(|message| message["type"] == message_type)
            .collect()
    }

    fn occurrences_of_ts(&self, ts: u64) -> usize {
        self.envelopes()
            .iter()
            .filter(|message| message["ts"].as_u64() == Some(ts))
            .count()
    }

    fn playback_states(&self) -> Vec<PlaybackState> {
        self.playback
            .lock()
            .unwrap()
            .iter()
            .filter_map(|payload| serde_json::from_value::<PlaybackState>(payload["state"].clone()).ok())
            .collect()
    }

    fn last_playback(&self) -> Option<Value> {
        self.playback.lock().unwrap().last().cloned()
    }

    fn last_playback_state(&self) -> Option<PlaybackState> {
        self.playback_states().last().copied()
    }

    fn playback_generations(&self) -> Vec<u64> {
        self.playback
            .lock()
            .unwrap()
            .iter()
            .filter_map(|payload| payload["generation"].as_u64())
            .collect()
    }

    fn wait_for_type(&self, message_type: &str, count: usize, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.of_type(message_type).len() >= count {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        false
    }

    fn wait_for_state(&self, want: PlaybackState, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.playback_states().contains(&want) {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        false
    }

    fn wait_for_occurrences(&self, ts: u64, count: usize, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.occurrences_of_ts(ts) >= count {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

// ---------------------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------------------

#[test]
fn a_recording_round_trips_through_disk() {
    let dir = TempDir::new("roundtrip");
    let writer = RecordingWriter::create(dir.path(), leaky_target(), json!({ "intervalMs": 500 }), false)
        .expect("the recording must be created");

    let base = now_ms();
    writer.record_message(&json!({
        "v": 1, "seq": 1, "ts": base, "type": "counter.sample",
        "data": { "counters": [{ "name": "gc-heap-size", "value": 1 }] },
    }));
    writer.record_message(&json!({
        "v": 1, "seq": 2, "ts": base + 500, "type": "counter.sample",
        "data": { "counters": [{ "name": "gc-heap-size", "value": 2 }] },
    }));
    writer.record_log("debug", "collector said something");
    writer.finish("detached", json!({ "messages": 2 }));

    let summary = recording::read_summary(writer.path()).expect("the recording must be readable");
    assert_eq!(summary.message_count, 2);
    assert_eq!(summary.log_count, 1);
    assert_eq!(summary.skipped_lines, 0);
    assert!(summary.complete, "a finished recording must carry a footer");
    assert_eq!(summary.end_reason.as_deref(), Some("detached"));
    assert_eq!(summary.target_pid, Some(4242));
    assert_eq!(
        summary.target_name.as_deref(),
        Some("MemorySpy.Samples.LeakyCache")
    );
    assert_eq!(summary.format_version, Some(recording::RECORDING_FORMAT_VERSION));
    assert!(!summary.started_mid_session);
    assert!(summary.size_bytes > 0);
    assert!(
        summary.duration_ms >= 500,
        "the duration must span the recorded timeline: {}",
        summary.duration_ms
    );
    assert!(
        summary.file_name.starts_with("memoryspy-MemorySpy.Samples.LeakyCache-4242-")
            && summary.file_name.ends_with(".jsonl"),
        "unexpected file name: {}",
        summary.file_name
    );

    // The histogram is what a replay uses to decide which views it can fill, so it must
    // describe the file's real contents.
    assert_eq!(summary.message_types.get("counter.sample"), Some(&2));
    assert_eq!(summary.message_types.len(), 1, "{:?}", summary.message_types);

    // Replaying must reproduce the recorded envelopes exactly, timestamps included. The
    // frontend plots message.ts rather than its own clock, so a rewritten or dropped
    // timestamp would silently corrupt every rate the analysis reports.
    let expected: Vec<Value> = std::fs::read_to_string(writer.path())
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|line| line["kind"] == "message")
        .map(|line| line["envelope"].clone())
        .collect();

    let sink = Arc::new(CapturingSink::default());
    let playback =
        PlaybackHandle::start(sink.clone(), writer.path(), Some(1000.0)).expect("the replay must start");

    assert!(
        sink.wait_for_state(PlaybackState::Finished, Duration::from_secs(10)),
        "the replay never finished: {:?}",
        sink.playback_states()
    );

    let replayed: Vec<Value> = sink
        .envelopes()
        .into_iter()
        .filter(|message| message["type"] != "log")
        .collect();

    assert_eq!(replayed, expected, "the replay must reproduce the recorded stream");

    // The recorded stderr line survives too, as a log envelope carrying the original time
    // rather than the time the replay happened to reach it.
    let logs: Vec<Value> = sink.of_type("log");
    assert_eq!(logs.len(), 1, "the recorded log line was lost: {:?}", sink.envelopes());
    assert_eq!(logs[0]["data"]["message"], "collector said something");
    assert_eq!(logs[0]["data"]["level"], "debug");

    let finished = sink.last_playback().expect("playback status was never reported");
    assert_eq!(finished["state"], "finished");
    assert!(finished["durationMs"].as_u64().unwrap() >= 500);
    assert!(finished["emitted"].as_u64().unwrap() >= 3);
    assert!(finished["generation"].as_u64().unwrap() >= 1);
    assert_eq!(finished["recording"]["fileName"], summary.file_name);
    assert!(!playback.is_active());
}

#[test]
fn a_recording_without_a_header_still_replays() {
    // A bare envelope dump from any other capture tool must still be usable. Losing the
    // ability to open a file would throw away the only evidence there is.
    let dir = TempDir::new("bare");
    let path = dir.path().join("dump.jsonl");
    std::fs::write(
        &path,
        concat!(
            "{\"v\":1,\"seq\":1,\"ts\":1000,\"type\":\"counter.sample\",\"data\":{}}\n",
            "this line is not json at all\n",
            "{\"kind\":\"message\",\"envelope\":{\"v\":1,\"seq\":2,\"ts\":1500,\"type\":\"gc.event\",\"data\":{}}}\n",
        ),
    )
    .unwrap();

    let summary = recording::read_summary(&path).expect("a headerless dump must still summarize");
    assert_eq!(summary.message_count, 2);
    assert_eq!(summary.skipped_lines, 1, "a corrupt line must be counted, not fatal");
    assert_eq!(summary.line_count, 3);
    assert!(!summary.complete, "no footer was written, so the recording is incomplete");
    assert_eq!(summary.format_version, None);
    assert_eq!(summary.duration_ms, 500, "the timeline must come from the first event");

    let sink = Arc::new(CapturingSink::default());
    PlaybackHandle::start(sink.clone(), &path, Some(1000.0)).expect("the replay must start");

    assert!(
        sink.wait_for_state(PlaybackState::Finished, Duration::from_secs(10)),
        "the headerless replay never finished"
    );

    let replayed = sink.envelopes();
    assert_eq!(replayed.len(), 2);
    assert_eq!(replayed[0]["ts"], 1000);
    assert_eq!(replayed[1]["ts"], 1500);
}

#[test]
fn an_empty_recording_is_rejected_with_an_explanation() {
    let dir = TempDir::new("empty");
    let path = dir.path().join("empty.jsonl");
    std::fs::write(&path, "").unwrap();

    let error = PlaybackHandle::start(Arc::new(CapturingSink::default()), &path, None)
        .err()
        .expect("a file with no events must not start a replay");
    assert!(error.contains("no recorded events"), "unhelpful error: {error}");
}

#[test]
fn deletion_is_confined_to_the_recordings_folder() {
    let dir = TempDir::new("guard");
    let recordings = dir.path().join("recordings");
    std::fs::create_dir_all(&recordings).unwrap();

    let inside = recordings.join("memoryspy-x-1-20260101-000000.jsonl");
    std::fs::write(&inside, "{}").unwrap();
    let outside = dir.path().join("precious.jsonl");
    std::fs::write(&outside, "{}").unwrap();

    assert!(
        recording::resolve_inside(&recordings, &inside).is_ok(),
        "a recording inside the folder must be deletable"
    );

    let error = recording::resolve_inside(&recordings, &outside)
        .err()
        .expect("a path outside the recordings folder must be refused");
    assert!(error.contains("outside the recordings folder"), "{error}");

    // Traversal is refused for the same reason, and is caught by resolving the real path
    // rather than by comparing strings.
    let escaped = recordings.join("..").join("precious.jsonl");
    assert!(recording::resolve_inside(&recordings, &escaped).is_err());
    assert!(outside.is_file(), "the guard must not delete anything on its own");
}

// ---------------------------------------------------------------------------------------
// Playback control
// ---------------------------------------------------------------------------------------

#[test]
fn pause_seek_and_speed_control_a_replay() {
    let dir = TempDir::new("control");
    let writer = RecordingWriter::create(dir.path(), leaky_target(), json!({}), false).unwrap();

    // A known timeline: samples 400 ms apart, long enough that the controls can be exercised
    // without racing the end of the recording.
    let base = now_ms();
    for index in 0..40u64 {
        writer.record_message(&json!({
            "v": 1,
            "seq": index,
            "ts": base + index * 400,
            "type": "counter.sample",
            "data": { "counters": [], "sampleIndex": index },
        }));
    }
    writer.finish("detached", json!({}));

    let sink = Arc::new(CapturingSink::default());
    // Half speed, so a gap is 800 ms of wall clock and the timing assertions are decisive.
    let playback = PlaybackHandle::start(sink.clone(), writer.path(), Some(0.5)).expect("the replay must start");

    assert!(
        sink.wait_for_type("counter.sample", 1, Duration::from_secs(5)),
        "the replay emitted nothing"
    );

    playback.pause().unwrap();
    // Let an event that was already due land, then check that nothing follows it.
    thread::sleep(Duration::from_millis(150));
    let paused_at = sink.count();
    thread::sleep(Duration::from_millis(1600));
    assert_eq!(
        sink.count(),
        paused_at,
        "a paused replay kept emitting messages"
    );
    assert_eq!(
        sink.last_playback_state(),
        Some(PlaybackState::Paused),
        "the pause was not reported to the UI: {:?}",
        sink.playback_states()
    );

    playback.resume().unwrap();
    assert!(
        sink.wait_for_type("counter.sample", paused_at + 2, Duration::from_secs(5)),
        "the replay did not continue after resume"
    );

    // A seek replays from the beginning and forwards everything up to the target, so the
    // frontend's accumulated buffers really are the state at that position instead of a
    // splice of the old and new timelines.
    playback.seek(1200).unwrap();
    assert!(
        sink.wait_for_occurrences(base, 2, Duration::from_secs(10)),
        "the seek did not replay from the start"
    );
    assert!(
        sink.playback_generations().iter().any(|generation| *generation >= 2),
        "the seek did not bump the generation, so the UI could not know to clear: {:?}",
        sink.playback_generations()
    );

    // Faster is still forward, and the change takes effect on the gap already in flight
    // rather than after the old pace finishes.
    playback.set_speed(20.0).unwrap();
    let after_seek = sink.count();
    assert!(
        sink.wait_for_type("counter.sample", after_seek + 3, Duration::from_secs(5)),
        "raising the speed did not accelerate the replay: {} messages",
        sink.count()
    );

    // Slower is still forward too, and leaves the replay with enough runway to stop it
    // deliberately rather than racing the end of the file.
    playback.set_speed(0.25).unwrap();
    thread::sleep(Duration::from_millis(50));
    playback.stop();
    assert!(!playback.is_active(), "the replay did not stop");
    assert_eq!(
        sink.last_playback_state(),
        Some(PlaybackState::Stopped),
        "a stopped replay must say so, otherwise the UI would keep showing it as live"
    );
}

// ---------------------------------------------------------------------------------------
// The real thing
// ---------------------------------------------------------------------------------------

fn sample_dll() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri always has a parent")
        .join("samples/LeakyCache/bin/Debug/net10.0/MemorySpy.Samples.LeakyCache.dll")
}

struct SampleGuard(Child);

impl Drop for SampleGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_sample() -> Option<SampleGuard> {
    let dll = sample_dll();
    if !dll.is_file() {
        return None;
    }

    let child = Command::new("dotnet")
        .arg(&dll)
        .arg("cache")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    Some(SampleGuard(child))
}

/// Records a real leaking process, then analyses the file with no process attached.
#[test]
fn a_live_session_can_be_recorded_and_replayed_offline() {
    let Some(guard) = spawn_sample() else {
        panic!(
            "sample not built. Run `npm run sample:build` first (expected {})",
            sample_dll().display()
        );
    };

    thread::sleep(Duration::from_millis(1500));

    let location = collector::locate_collector();
    assert!(
        location.found,
        "collector not found: {}",
        location.error.clone().unwrap_or_default()
    );

    let dir = TempDir::new("live");
    let path = dir.path().join("session.jsonl");
    let pid = guard.0.id() as i32;
    let sink = Arc::new(CapturingSink::default());

    let handle = collector::start_session(
        sink.clone(),
        &location,
        SessionRequest {
            pid,
            probes: vec![],
            interval_ms: Some(500),
            max_types: Some(60),
            verbose: false,
            deep_capture: false,
            capture_max_mb: None,
            record: true,
            record_path: Some(path.display().to_string()),
            target_name: Some("MemorySpy.Samples.LeakyCache".to_string()),
            target_runtime: Some("10.0.9".to_string()),
        },
        None,
    )
    .expect("session must start");

    // Both probes must have produced something before the stop, otherwise the comparisons
    // below would pass by comparing two empty lists. The counters probe is the slower of the
    // two: it needs a full interval before it has a value to report.
    assert!(
        sink.wait_for_type("counter.sample", 3, Duration::from_secs(30)),
        "the recorded session produced no counter samples"
    );
    assert!(
        sink.wait_for_type("allocation.sample", 3, Duration::from_secs(30)),
        "the recorded session produced no allocation samples"
    );
    assert!(
        sink.wait_for_type("heap.stats", 1, Duration::from_secs(30)),
        "the recorded session produced no heap statistics"
    );

    handle.stop();

    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline
        && !matches!(handle.state(), SessionState::Stopped | SessionState::Failed)
    {
        thread::sleep(Duration::from_millis(100));
    }

    assert!(
        matches!(handle.state(), SessionState::Stopped | SessionState::Failed),
        "the session never reached a terminal state"
    );

    // ---- The file is left in a state someone else could pick up ----------------------
    let summary = recording::read_summary(&path).expect("the recording must be readable");
    assert!(
        summary.complete,
        "a detached session must write a footer; without one the recording looks like a crash"
    );
    assert_eq!(summary.end_reason.as_deref(), Some("detached"));
    assert!(
        summary.message_count >= 5,
        "too few messages were recorded: {}",
        summary.message_count
    );
    assert_eq!(
        summary.target_name.as_deref(),
        Some("MemorySpy.Samples.LeakyCache"),
        "the recording does not say which process it came from"
    );
    assert_eq!(summary.target_pid, Some(pid));
    assert!(!summary.started_mid_session);
    assert!(summary.duration_ms >= 1000, "the timeline is too short: {}", summary.duration_ms);
    assert!(
        summary.message_types.contains_key("allocation.sample")
            && summary.message_types.contains_key("counter.sample"),
        "the histogram does not describe the recorded stream: {:?}",
        summary.message_types
    );

    // Listing must find it too — that is how the UI offers it back.
    let listed = recording::list_recordings(dir.path()).expect("listing must succeed");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].path, summary.path);

    // ---- Replay it with nothing attached ---------------------------------------------
    let replay_sink = Arc::new(CapturingSink::default());
    let playback = PlaybackHandle::start(replay_sink.clone(), &path, Some(1000.0))
        .expect("the replay must start");

    assert!(
        replay_sink.wait_for_state(PlaybackState::Finished, Duration::from_secs(30)),
        "the offline replay never finished: {:?}",
        replay_sink.playback_states()
    );

    // The replayed stream must be identical to the live one, timestamps included. Anything
    // else and the offline analysis would answer a different question than the live view.
    let live: Vec<Value> = sink.of_type("allocation.sample");
    let replayed: Vec<Value> = replay_sink.of_type("allocation.sample");
    assert!(!replayed.is_empty(), "the replay delivered no allocation samples");
    assert_eq!(replayed, live, "the replay does not match what was recorded live");

    let live_counters = sink.of_type("counter.sample");
    assert!(!live_counters.is_empty(), "nothing was recorded to compare against");
    assert_eq!(
        sink.of_type("counter.sample"),
        replay_sink.of_type("counter.sample"),
        "the replayed counters differ from the recorded ones"
    );
    assert_eq!(sink.of_type("heap.stats"), replay_sink.of_type("heap.stats"));

    // And the question the whole app exists to answer still has an answer offline.
    let types = replayed
        .last()
        .unwrap()["data"]["types"]
        .as_array()
        .expect("allocation.sample must carry types");
    assert!(
        types.iter().any(|entry| entry["typeName"] == "SessionRecord"),
        "the leaking type is not visible in the replay: {:?}",
        types.iter().filter_map(|e| e["typeName"].as_str()).collect::<Vec<_>>()
    );

    let finished = replay_sink.last_playback().unwrap();
    assert_eq!(finished["state"], "finished");
    assert!(
        finished["durationMs"].as_u64().unwrap() >= 1000,
        "the replay reported no usable timeline"
    );
    assert!(
        finished["emitted"].as_u64().unwrap() >= replayed.len() as u64,
        "the progress counter does not match what was delivered"
    );
    assert_eq!(finished["recording"]["targetPid"], pid);

    assert!(!playback.is_active());
}
