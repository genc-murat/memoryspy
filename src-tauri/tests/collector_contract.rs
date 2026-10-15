//! End-to-end verification of the host/collector pipeline against a real .NET process.
//!
//! This test exists because the risky part of MemorySpy is not the UI — it is the contract
//! between the Rust supervisor and the .NET sidecar that talks to EventPipe. It drives that
//! exact path: locate the collector, ask for its capabilities, list processes, attach to a
//! real leaking process, and assert on the batches that come back over the pipe.
//!
//! It needs the collector and the sample built:
//!
//! ```sh
//! npm run collector:build && npm run sample:build
//! cargo test --manifest-path src-tauri/Cargo.toml
//! ```

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use memoryspy_lib::collector::{
    self, CollectorLocation, DotnetProcessInfo, EventSink, SessionRequest, SessionState,
};
use serde_json::Value;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri always has a parent")
        .to_path_buf()
}

fn sample_dll() -> PathBuf {
    repo_root()
        .join("samples")
        .join("LeakyCache")
        .join("bin")
        .join("Debug")
        .join("net10.0")
        .join("MemorySpy.Samples.LeakyCache.dll")
}

/// Records everything the supervisor reports, so assertions can run against the real stream.
#[derive(Default)]
struct RecordingSink {
    messages: Mutex<Vec<Value>>,
    logs: Mutex<Vec<(String, String)>>,
    statuses: Mutex<Vec<(SessionState, Option<String>)>>,
}

impl EventSink for RecordingSink {
    fn messages(&self, _session_id: &str, messages: Vec<Value>) {
        self.messages.lock().unwrap().extend(messages);
    }

    fn log(&self, _session_id: &str, level: &str, message: &str) {
        self.logs.lock().unwrap().push((level.to_string(), message.to_string()));
    }

    fn status(
        &self,
        _session_id: &str,
        _pid: i32,
        state: SessionState,
        detail: Option<String>,
        _stats: Value,
    ) {
        self.statuses.lock().unwrap().push((state, detail));
    }
}

impl RecordingSink {
    fn of_type(&self, message_type: &str) -> Vec<Value> {
        self.messages
            .lock()
            .unwrap()
            .iter()
            .filter(|message| message.get("type").and_then(|t| t.as_str()) == Some(message_type))
            .cloned()
            .collect()
    }

    fn wait_for(&self, message_type: &str, count: usize, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.of_type(message_type).len() >= count {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        false
    }
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

/// Number of lines in a file, used to check that a resolved line number lands inside it.
fn line_count(path: &str) -> u64 {
    std::fs::read_to_string(path)
        .map(|text| text.lines().count() as u64)
        .unwrap_or(0)
}

/// Runs the sample from a copy of its build output with the symbol files left behind.
///
/// This is the cheapest honest way to reproduce a stripped deployment: the assembly is byte for
/// byte the one the other tests profile, only the PDB beside it is gone, which is the state that
/// forces the collector's method-name fallback.
fn spawn_sample_without_symbols() -> Option<(SampleGuard, PathBuf)> {
    let dll = sample_dll();
    if !dll.is_file() {
        return None;
    }

    let source_dir = dll.parent()?;
    let target_dir = std::env::temp_dir().join(format!("memoryspy-nopdb-sample-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&target_dir);
    std::fs::create_dir_all(&target_dir).ok()?;

    for entry in std::fs::read_dir(source_dir).ok()? {
        let entry = entry.ok()?;
        if !entry.path().is_file() {
            continue;
        }
        if entry.path().extension().is_some_and(|extension| extension == "pdb") {
            continue;
        }
        std::fs::copy(entry.path(), target_dir.join(entry.file_name())).ok()?;
    }

    let copied = target_dir.join(dll.file_name()?);
    let child = Command::new("dotnet")
        .arg(&copied)
        .arg("cache")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    Some((SampleGuard(child), target_dir))
}

fn assert_located(location: &CollectorLocation) {
    assert!(
        location.found,
        "collector not found: {}\nsearched:\n{}",
        location.error.clone().unwrap_or_default(),
        location.searched.join("\n")
    );
    assert!(location.dotnet_path.is_some(), "no dotnet host was found");
}

#[test]
fn capabilities_describe_the_expected_probes() {
    let location = collector::locate_collector();
    assert_located(&location);

    let capabilities = collector::fetch_capabilities(&location).expect("capabilities must be readable");

    assert_eq!(capabilities["protocolVersion"], 1, "protocol version changed");
    assert_eq!(capabilities["tool"], "MemorySpy.Collector");

    let probes: Vec<&str> = capabilities["probes"]
        .as_array()
        .expect("probes must be an array")
        .iter()
        .filter_map(|probe| probe["id"].as_str())
        .collect();

    for expected in ["runtime-counters", "allocations", "gc-stats"] {
        assert!(probes.contains(&expected), "capability list is missing '{expected}': {probes:?}");
    }

    // The UI builds its panels from this handshake, so every probe must describe its events.
    for probe in capabilities["probes"].as_array().unwrap() {
        assert!(
            probe["eventTypes"].as_array().is_some_and(|events| !events.is_empty()),
            "probe {} declares no event types; the UI cannot route it",
            probe["id"]
        );
    }
}

#[test]
fn process_listing_finds_the_leaking_sample() {
    let Some(_guard) = spawn_sample() else {
        panic!(
            "sample not built. Run `npm run sample:build` first (expected {})",
            sample_dll().display()
        );
    };

    // Give the runtime a moment to publish its diagnostics endpoint.
    thread::sleep(Duration::from_millis(1500));

    let location = collector::locate_collector();
    assert_located(&location);

    let processes: Vec<DotnetProcessInfo> =
        collector::list_processes(&location, false).expect("process listing must succeed");

    let sample_pid = _guard.0.id() as i32;
    let found = processes
        .iter()
        .find(|process| process.pid == sample_pid)
        .unwrap_or_else(|| {
            panic!(
                "the sample (pid {sample_pid}) was not listed. Saw: {:?}",
                processes.iter().map(|p| (p.pid, p.name.clone())).collect::<Vec<_>>()
            )
        });

    // Enrichment is what lets a user pick the right process out of a list, so it is part of
    // the contract rather than a nice-to-have.
    assert!(
        found.command_line.as_deref().is_some_and(|line| line.contains("LeakyCache")),
        "command line was not enriched: {:?}",
        found.command_line
    );
    assert!(
        found.runtime_version.as_deref().is_some_and(|version| version.starts_with("10.")),
        "runtime version was not resolved from the target: {:?}",
        found.runtime_version
    );
    assert!(
        found.working_set_bytes.is_some_and(|bytes| bytes > 0),
        "working set was not reported"
    );
}

#[test]
fn a_live_session_streams_counters_allocations_and_gc_data() {
    let Some(guard) = spawn_sample() else {
        panic!("sample not built. Run `npm run sample:build` first");
    };

    thread::sleep(Duration::from_millis(1500));

    let location = collector::locate_collector();
    assert_located(&location);

    let pid = guard.0.id() as i32;
    let sink = Arc::new(RecordingSink::default());

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
            record: false,
            record_path: None,
            target_name: None,
            target_runtime: None,
        },
        None,
    )
    .expect("session must start");

    assert_eq!(handle.pid(), pid);
    assert_eq!(handle.state(), SessionState::Running);

    // The first interval can land late, so allow generous head room before failing.
    assert!(
        sink.wait_for("session.started", 1, Duration::from_secs(10)),
        "no session.started message arrived"
    );

    assert!(
        sink.wait_for("counter.sample", 2, Duration::from_secs(20)),
        "no counter samples arrived; logs: {:?}",
        sink.logs.lock().unwrap()
    );

    let counters = sink.of_type("counter.sample");
    let last_counters = &counters[counters.len() - 1];
    let readings = last_counters["data"]["counters"]
        .as_array()
        .expect("counter.sample must carry a counters array");

    assert!(!readings.is_empty(), "counter batch was empty");

    let find = |name: &str| {
        readings
            .iter()
            .find(|reading| reading["name"] == name)
            .unwrap_or_else(|| panic!("counter '{name}' was not reported"))
    };

    // Values must be normalised to bytes regardless of the unit the runtime used, otherwise
    // the charts would mix megabytes and bytes on one axis.
    for name in ["gc-heap-size", "working-set", "gen-2-size", "loh-size"] {
        let reading = find(name);
        assert_eq!(reading["unit"], "bytes", "{name} is not normalised to bytes");
        assert!(
            reading["value"].as_f64().is_some_and(|value| value > 0.0),
            "{name} reported a non-positive value: {}",
            reading["value"]
        );
    }

    let heap_size = find("gc-heap-size")["value"].as_f64().unwrap();
    let working_set = find("working-set")["value"].as_f64().unwrap();
    let gen2_size = find("gen-2-size")["value"].as_f64().unwrap();

    // Deliberately *not* asserting working set >= GC heap. A managed heap can legitimately be
    // far larger than the resident set: the runtime commits zeroed pages lazily, so pages it
    // never writes are never faulted in, and a process that has been leaking for a while can
    // have most of its heap compressed or swapped out by the OS. Verified against `ps`:
    // a 17 GB reported heap with a 4.2 GB resident set is real.
    assert!(working_set > 0.0, "working set must be positive");

    // gen-2-size is a post-collection snapshot while gc-heap-size is the live total, so they
    // are not required to match exactly — only to be mutually plausible.
    assert!(
        gen2_size > 0.0,
        "a process that has been accumulating a cache for seconds must have something in Gen 2"
    );
    assert!(
        heap_size >= gen2_size * 0.75,
        "the live heap ({heap_size}) cannot be much smaller than its own Gen 2 ({gen2_size})"
    );

    // Per-type allocation is the feature the whole app is built around.
    assert!(
        sink.wait_for("allocation.sample", 2, Duration::from_secs(20)),
        "no allocation samples arrived; logs: {:?}",
        sink.logs.lock().unwrap()
    );

    let allocations = sink.of_type("allocation.sample");
    let types = allocations[allocations.len() - 1]["data"]["types"]
        .as_array()
        .expect("allocation.sample must carry a types array");

    assert!(!types.is_empty(), "allocation types array was empty");

    let busiest = types
        .iter()
        .max_by(|a, b| {
            a["intervalBytes"]
                .as_f64()
                .unwrap_or(0.0)
                .partial_cmp(&b["intervalBytes"].as_f64().unwrap_or(0.0))
                .unwrap()
        })
        .unwrap();

    assert!(
        busiest["typeName"].as_str().is_some_and(|name| !name.is_empty()),
        "allocation type had no name"
    );
    assert!(
        busiest["intervalBytes"].as_f64().is_some_and(|bytes| bytes > 0.0),
        "the busiest type reported no allocation volume"
    );

    // The leaking sample stores records in a Dictionary<Guid, SessionRecord>, so its own type
    // must show up as a meaningful allocator. This is the assertion that proves the tool
    // answers "which class is growing?" rather than just "something allocates".
    let named = |name: &str| types.iter().any(|entry| entry["typeName"] == name);
    assert!(
        named("SessionRecord"),
        "the leaking type SessionRecord was not among the reported types: {:?}",
        types
            .iter()
            .filter_map(|entry| entry["typeName"].as_str())
            .collect::<Vec<_>>()
    );

    // GC and heap data come from a different provider than the counters, so verify that path
    // independently: either heap statistics or collection events must have arrived.
    let has_gc_pressure = sink.wait_for("heap.stats", 1, Duration::from_secs(20))
        || sink.wait_for("gc.event", 1, Duration::from_secs(5));
    assert!(
        has_gc_pressure,
        "neither heap.stats nor gc.event arrived; logs: {:?}",
        sink.logs.lock().unwrap()
    );

    if let Some(heap) = sink.of_type("heap.stats").last() {
        assert!(
            heap["data"]["totalHeapBytes"].as_f64().is_some_and(|bytes| bytes > 0.0),
            "heap statistics reported an empty heap while the target is allocating"
        );
    }

    // ---- Shutdown -------------------------------------------------------------------
    // `stop()` only *requests* the stop, so the test must wait for a terminal state. Stopping
    // takes as long as the runtime needs to tear down its EventPipe session, which is why the
    // UI drives its "detached" indicator from status events rather than from the call return.
    handle.stop();

    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if matches!(handle.state(), SessionState::Stopped | SessionState::Failed) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }

    assert!(
        matches!(handle.state(), SessionState::Stopped | SessionState::Failed),
        "the session never reached a terminal state (stuck at {:?}); the collector process would leak",
        handle.state()
    );

    let statuses = sink.statuses.lock().unwrap().clone();
    assert!(
        statuses.iter().any(|(state, _)| *state == SessionState::Stopped),
        "no terminal status was reported: {statuses:?}"
    );

    // A clean stop must not be reported as a failure.
    assert!(
        !statuses.iter().any(|(state, _)| *state == SessionState::Failed),
        "the session ended as failed: {statuses:?}"
    );
}

#[test]
fn attaching_to_a_nonexistent_process_fails_with_a_useful_message() {
    let location = collector::locate_collector();
    assert_located(&location);

    let sink = Arc::new(RecordingSink::default());
    let result = collector::start_session(
        sink.clone(),
        &location,
        SessionRequest {
            pid: 999_999,
            probes: vec![],
            interval_ms: Some(1000),
            max_types: Some(50),
            verbose: false,
            deep_capture: false,
            record: false,
            record_path: None,
            target_name: None,
            target_runtime: None,
        },
        None,
    );

    // Starting is allowed to succeed — the collector process exists even if the target does
    // not — but the failure has to reach the user rather than being swallowed.
    if let Ok(handle) = result {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let failed = sink
                .statuses
                .lock()
                .unwrap()
                .iter()
                .any(|(state, _)| *state == SessionState::Failed || *state == SessionState::Stopped);
            if failed {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        handle.stop();
        panic!("attaching to a missing process produced no terminal status and no error");
    }
}

#[test]
fn unknown_probe_ids_are_rejected() {
    let location = collector::locate_collector();
    assert_located(&location);

    let sink = Arc::new(RecordingSink::default());
    let result = collector::start_session(
        sink.clone(),
        &location,
        SessionRequest {
            pid: std::process::id() as i32,
            probes: vec!["not-a-real-probe".to_string()],
            interval_ms: Some(1000),
            max_types: Some(50),
            verbose: false,
            deep_capture: false,
            record: false,
            record_path: None,
            target_name: None,
            target_runtime: None,
        },
        None,
    );

    if let Ok(handle) = result {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let terminal = sink
                .statuses
                .lock()
                .unwrap()
                .iter()
                .any(|(state, _)| *state == SessionState::Failed || *state == SessionState::Stopped);
            if terminal {
                let logs = sink.logs.lock().unwrap().clone();
                let messages = sink.of_type("error");
                assert!(
                    !logs.is_empty() || !messages.is_empty(),
                    "an invalid probe id was rejected silently"
                );
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        handle.stop();
        panic!("an invalid probe id did not terminate the session");
    }
}

/// The claim the call-site feature makes, verified against a real leaking process: the code that
/// allocates is named, and it is named even when the allocated type belongs to the runtime —
/// which is the only case where a type leaderboard is useless.
///
/// It also pins the properties that make the answer trustworthy and that a future change could
/// quietly break: the stack really is resolved (a runtime frame appears below the user's frame,
/// so the chain came from the runtime, not from a guess), the statement really is located (a file
/// and line that exist on disk, which means the symbol reader was consulted and the PDB beside
/// the assembly was accepted rather than refused), and the capture really is on disk afterwards
/// (so the evidence can be reopened in PerfView).
#[test]
fn a_deep_capture_resolves_allocation_call_sites() {
    let Some(guard) = spawn_sample() else {
        panic!("sample not built. Run `npm run sample:build` first");
    };

    thread::sleep(Duration::from_millis(1500));

    let location = collector::locate_collector();
    assert_located(&location);

    let pid = guard.0.id() as i32;
    let sink = Arc::new(RecordingSink::default());
    let capture_dir = std::env::temp_dir().join(format!("memoryspy-capture-test-{pid}"));
    let _ = std::fs::remove_dir_all(&capture_dir);

    let handle = collector::start_session(
        sink.clone(),
        &location,
        SessionRequest {
            pid,
            // The sampler *and* the live per-type probe, because that is the combination a user
            // actually arms to find a leaking line and the two share one EventPipe session. This
            // test used to run the sampler alone, and that blind spot hid a real defect: with the
            // capture's keywords merged in, the runtime stops raising the `GC/AllocationTick`
            // events the live probe matched on, so it reported nothing while the capture file
            // beside it held thousands of samples.
            probes: vec!["allocations".to_string(), "allocation-sites".to_string()],
            interval_ms: Some(500),
            max_types: Some(60),
            verbose: false,
            deep_capture: true,
            record: false,
            record_path: None,
            target_name: Some("MemorySpy.Samples.LeakyCache".to_string()),
            target_runtime: None,
        },
        Some(capture_dir.clone()),
    )
    .expect("session must start");

    assert!(
        sink.wait_for("session.started", 1, Duration::from_secs(10)),
        "no session.started message arrived"
    );

    // The handshake has to say the capture is armed, because that is what the rail and the
    // call-site view use to explain themselves while the session is still running.
    let started = sink.of_type("session.started");
    let capture_path = started[0]["data"]["deepCapture"]["path"]
        .as_str()
        .expect("session.started must report where a deep capture is going")
        .to_string();

    // Long enough for the sampler to see a few hundred thousand allocations in `cache` mode.
    thread::sleep(Duration::from_secs(8));

    // While the capture is still running, the live per-type data has to be arriving too. The
    // basis is asserted only to be one of the two known values rather than the measured
    // `allocationSampling`, so a future runtime that goes back to ticks fails nothing here —
    // what must never come back is the empty payload.
    assert!(
        sink.wait_for("allocation.sample", 2, Duration::from_secs(10)),
        "a capture-armed session reported no live allocation samples; logs: {:?}",
        sink.logs.lock().unwrap()
    );

    let live_samples = sink.of_type("allocation.sample");
    let live = &live_samples[live_samples.len() - 1]["data"];

    let basis = live["samplingBasis"].as_str().unwrap_or("");
    assert!(
        basis == "tick" || basis == "allocationSampling",
        "allocation samples must name which event kind produced them, got {basis:?}"
    );

    let live_types = live["types"]
        .as_array()
        .expect("allocation.sample must carry a types array");
    assert!(
        !live_types.is_empty(),
        "the live type list was empty in a capturing session: {live}"
    );
    assert!(
        live_types
            .iter()
            .any(|entry| entry["intervalBytes"].as_f64().unwrap_or(0.0) > 0.0),
        "no live type reported any allocation volume: {live}"
    );

    handle.stop();

    assert!(
        sink.wait_for("allocation.site", 1, Duration::from_secs(90)),
        "no call-site analysis arrived; logs: {:?}",
        sink.logs.lock().unwrap()
    );

    let analysis = sink.of_type("allocation.site");
    let data = &analysis[0]["data"];

    assert!(
        data["sampledEvents"].as_u64().unwrap_or(0) > 0,
        "the analysis scanned no sampled allocations: {data}"
    );
    assert!(
        data["totalSampledBytes"].as_u64().unwrap_or(0) > 0,
        "the analysis attributed no bytes"
    );
    assert!(
        data["unresolvedFrames"].as_u64().unwrap_or(1) == 0,
        "method names could not be resolved, so rundown or the ETLX conversion is broken"
    );
    assert!(
        data["conversionMs"].as_u64().is_some() && data["analysisMs"].as_u64().is_some(),
        "the analysis did not report how long it took"
    );

    let sites = data["sites"].as_array().expect("sites must be an array");
    assert!(!sites.is_empty(), "no call sites were reported: {data}");

    // The sample is a single top-level Program, so every allocation in it resolves to a method
    // whose name carries that type name. That is the assertion that would have failed before
    // this feature existed, for every type it reports.
    let user_site = sites
        .iter()
        .find(|site| {
            site["userCode"].as_bool().unwrap_or(false)
                && site["site"].as_str().is_some_and(|name| name.contains("Program"))
        })
        .unwrap_or_else(|| panic!("no site in the sample's own code was reported: {data}"));

    let frames = user_site["frames"].as_array().expect("a site must carry its call chain");
    assert!(!frames.is_empty(), "the site carried no frames");
    assert!(
        frames.len() > 1,
        "the chain should continue past the allocating method into the runtime: {frames:?}"
    );
    assert!(
        frames
            .iter()
            .skip(1)
            .filter_map(|frame| frame["method"].as_str())
            .any(|name| name.starts_with("System.")),
        "no runtime frame followed the user frame, so the chain is not a real stack: {frames:?}"
    );

    // The statement, not merely the method. The runtime's stacks carry an IL offset and only the
    // PDB turns that into a file and line, so a line that exists on disk is what proves the
    // symbol reader ran — and that the PDB next to the assembly was accepted, since TraceEvent
    // refuses a PDB found by probing unless a callback approves it.
    assert!(
        data["sitesWithSource"].as_u64().unwrap_or(0) > 0,
        "no call site resolved to a source line: {data}"
    );
    assert!(
        data["symbolMs"].as_u64().is_some(),
        "the analysis did not report how long PDB lookups took"
    );

    let source_file = user_site["sourceFile"]
        .as_str()
        .unwrap_or_else(|| panic!("the sample's own site resolved no source file: {user_site}"));
    let source_line = user_site["sourceLine"]
        .as_u64()
        .unwrap_or_else(|| panic!("the site resolved no line number: {user_site}"));

    assert!(
        source_file.ends_with("Program.cs"),
        "the resolved source file is not the sample's own source: {source_file}"
    );
    assert!(
        Path::new(source_file).is_file(),
        "the resolved source file does not exist on disk: {source_file}"
    );
    let lines = line_count(source_file);
    assert!(
        source_line > 0 && source_line <= lines,
        "the resolved line {source_line} is outside the {lines} lines of {source_file}"
    );

    // The row and the chain have to agree about where the allocation happens, otherwise one of
    // them is showing a different statement than the other.
    assert_eq!(
        frames[0]["sourceLine"].as_u64(),
        Some(source_line),
        "the site and its allocating frame disagree about the line: {frames:?}"
    );
    assert_eq!(
        frames[0]["sourceFile"].as_str(),
        Some(source_file),
        "the site and its allocating frame disagree about the file: {frames:?}"
    );

    // The whole point: a runtime type, attributed to code.
    let framework_type = data["types"]
        .as_array()
        .expect("types must be an array")
        .iter()
        .find(|entry| {
            entry["typeName"]
                .as_str()
                .is_some_and(|name| name.starts_with("System."))
        })
        .unwrap_or_else(|| panic!("no runtime type was attributed: {data}"));

    assert!(
        framework_type["dominantSite"]
            .as_str()
            .is_some_and(|site| site.contains("Program")),
        "a runtime type was not attributed to the sample's own code: {framework_type}"
    );

    // The capture is kept deliberately: it is the artifact PerfView or dotnet-trace can reopen.
    assert!(
        Path::new(&capture_path).is_file(),
        "the raw capture was not kept at {capture_path}"
    );

    // The ETLX is an intermediate, several times the size of the capture, so it must not survive.
    let etlx = Path::new(&capture_path).with_extension("etlx");
    assert!(
        !etlx.exists(),
        "the intermediate ETLX was left behind at {}",
        etlx.display()
    );

    let _ = std::fs::remove_dir_all(&capture_dir);
}

/// The other half of the contract: when no PDB can be read, the call sites must still be named by
/// method, and the analysis must say which modules it could not read instead of leaving the user
/// to wonder why every row lost its line.
///
/// The symbol path is checked first because a machine with a symbol server configured can
/// legitimately resolve a PDB that has been deleted locally; the fallback only has to hold when
/// there is nowhere else to look.
#[test]
fn call_sites_fall_back_to_method_names_without_pdbs() {
    if std::env::var_os("_NT_SYMBOL_PATH").is_some() {
        eprintln!(
            "skipping the PDB-less fallback check: _NT_SYMBOL_PATH is set, so symbols may come \
             from a server and a missing local PDB is not conclusive"
        );
        return;
    }

    let Some((guard, app_dir)) = spawn_sample_without_symbols() else {
        panic!("sample not built. Run `npm run sample:build` first");
    };

    thread::sleep(Duration::from_millis(1500));

    let location = collector::locate_collector();
    assert_located(&location);

    let pid = guard.0.id() as i32;
    let sink = Arc::new(RecordingSink::default());
    let capture_dir = std::env::temp_dir().join(format!("memoryspy-nopdb-capture-{pid}"));
    let _ = std::fs::remove_dir_all(&capture_dir);

    let handle = collector::start_session(
        sink.clone(),
        &location,
        SessionRequest {
            pid,
            probes: vec!["allocation-sites".to_string()],
            interval_ms: Some(500),
            max_types: Some(60),
            verbose: false,
            deep_capture: true,
            record: false,
            record_path: None,
            target_name: Some("MemorySpy.Samples.LeakyCache".to_string()),
            target_runtime: None,
        },
        Some(capture_dir.clone()),
    )
    .expect("session must start");

    assert!(
        sink.wait_for("session.started", 1, Duration::from_secs(10)),
        "no session.started message arrived"
    );

    thread::sleep(Duration::from_secs(8));
    handle.stop();

    assert!(
        sink.wait_for("allocation.site", 1, Duration::from_secs(90)),
        "no call-site analysis arrived; logs: {:?}",
        sink.logs.lock().unwrap()
    );

    let analysis = sink.of_type("allocation.site");
    let data = &analysis[0]["data"];

    assert!(
        data["sampledEvents"].as_u64().unwrap_or(0) > 0,
        "the analysis scanned no sampled allocations: {data}"
    );
    assert_eq!(
        data["sitesWithSource"].as_u64().unwrap_or(1),
        0,
        "a build with no PDBs still reported a source line: {data}"
    );
    assert!(
        data["sitesWithoutSource"].as_u64().unwrap_or(0) > 0,
        "no sites were reported at all: {data}"
    );

    let sites = data["sites"].as_array().expect("sites must be an array");
    assert!(!sites.is_empty(), "no call sites were reported: {data}");
    assert!(
        sites
            .iter()
            .any(|site| site["site"].as_str().is_some_and(|name| name.contains("Program"))),
        "the sample's own code was not named without a PDB: {data}"
    );

    // Every row keeps a usable name and admits that it has no location, which is the difference
    // between an honest fallback and a silently degraded one.
    //
    // Read through `as_str`/`as_u64` rather than `is_null`: the protocol omits null properties,
    // so a missing location arrives as an absent key just as often as an explicit null, and both
    // must count as "no location claimed".
    for site in sites {
        assert!(
            site["site"].as_str().is_some_and(|name| !name.is_empty()),
            "a site lost its method name: {site}"
        );
        assert!(
            site["sourceFile"].as_str().is_none() && site["sourceLine"].as_u64().is_none(),
            "a site claimed a source location without a PDB: {site}"
        );
        for frame in site["frames"].as_array().expect("frames must be an array") {
            assert!(
                frame["method"].as_str().is_some_and(|name| !name.is_empty()),
                "a frame lost its method name: {frame}"
            );
            assert!(
                frame["sourceFile"].as_str().is_none() && frame["sourceLine"].as_u64().is_none(),
                "a frame claimed a source location without a PDB: {frame}"
            );
        }
    }

    // Naming the module is what makes the fallback actionable: it says where to put a PDB.
    let modules = data["modulesWithoutSource"]
        .as_array()
        .expect("modulesWithoutSource must be an array");
    assert!(
        modules.iter().any(|module| module
            .as_str()
            .is_some_and(|name| name == "MemorySpy.Samples.LeakyCache.dll")),
        "the module whose PDB was missing was not reported: {modules:?}"
    );

    let _ = std::fs::remove_dir_all(&capture_dir);
    let _ = std::fs::remove_dir_all(&app_dir);
}

/// The heap snapshot, which is the one probe whose answer is a graph rather than a number.
///
/// The property under test is not "some bytes came back". It is the claim the panel makes to the
/// user: for the sample's leaking cache, the walk names the objects that survive and the chain of
/// references that keeps them alive — so the assertions follow one type all the way from a root to
/// an instance, and check the walk's own completeness accounting while doing it.
///
/// The session deliberately enables *only* this probe. That is the case where the shared session
/// needs no providers at all, because the walk brings its own.
#[test]
fn a_heap_snapshot_names_the_chain_that_keeps_the_leaking_cache_alive() {
    let Some(guard) = spawn_sample() else {
        panic!("sample not built. Run `npm run sample:build` first");
    };

    thread::sleep(Duration::from_millis(1500));

    let location = collector::locate_collector();
    assert_located(&location);

    let pid = guard.0.id() as i32;
    let sink = Arc::new(RecordingSink::default());

    let handle = collector::start_session(
        sink.clone(),
        &location,
        SessionRequest {
            pid,
            probes: vec!["heap-snapshot".to_string()],
            interval_ms: Some(1000),
            max_types: Some(60),
            verbose: false,
            deep_capture: false,
            record: false,
            record_path: None,
            target_name: None,
            target_runtime: None,
        },
        None,
    )
    .expect("session must start");

    assert!(
        sink.wait_for("session.started", 1, Duration::from_secs(10)),
        "no session.started message arrived; logs: {:?}",
        sink.logs.lock().unwrap()
    );

    handle
        .send_command(serde_json::json!({ "cmd": "snapshot" }))
        .expect("the snapshot command must reach the collector");

    assert!(
        sink.wait_for("command.result", 1, Duration::from_secs(10)),
        "the snapshot request was never acknowledged; logs: {:?}",
        sink.logs.lock().unwrap()
    );

    // A walk of a heap that has been leaking for a couple of seconds is quick, but the collector
    // allows two minutes before it gives up, so the test waits past the collector's own deadline
    // only when something is genuinely wrong.
    assert!(
        sink.wait_for("heap.snapshot", 1, Duration::from_secs(150)),
        "no heap snapshot arrived; logs: {:?}",
        sink.logs.lock().unwrap()
    );

    let snapshots = sink.of_type("heap.snapshot");
    let data = &snapshots[0]["data"];

    let object_count = data["objectCount"].as_u64().expect("objectCount must be a number");
    let total_bytes = data["totalBytes"].as_u64().expect("totalBytes must be a number");
    let reachable = data["reachableObjects"].as_u64().expect("reachableObjects must be a number");
    let edge_count = data["edgeCount"].as_u64().expect("edgeCount must be a number");

    assert!(object_count > 1_000, "the sample holds far more than {object_count} objects");
    assert!(total_bytes > 0, "a snapshot with no live bytes is not a snapshot");
    assert!(edge_count > 0, "a graph with no references cannot answer what holds what");
    assert!(
        data["pauseMs"].as_u64().is_some_and(|pause| pause > 0),
        "the walk must report the pause it cost the target, not hide it"
    );
    assert!(
        data["note"].as_str().is_some_and(|note| !note.is_empty()),
        "the snapshot must carry the caveat the UI shows verbatim"
    );

    // The walk is checked against itself here rather than taken on trust. A graph the runtime
    // truncated looks exactly like a small heap from the inside, so the two fields that disagree
    // with it — how many objects a root reaches, and how the byte total compares with the size the
    // runtime reported for the same collection — are what the panel warns on, and what this test
    // pins down.
    if let Some(note) = data["coverageNote"].as_str() {
        // A partial walk must say so *and* withhold its paths: a chain drawn through a graph with
        // references missing is a guess, which is the one thing this payload must never be.
        assert!(
            data["retention"].as_array().is_some_and(|paths| paths.is_empty()),
            "a partial walk must not also report retention paths, but {note} came with paths"
        );
        panic!("the walk of a freshly started sample came back partial: {note}");
    }

    assert!(
        reachable * 100 / object_count > 95,
        "only {reachable} of {object_count} walked objects were reachable from a root"
    );

    let types = data["types"].as_array().expect("types must be an array");
    let session_record = types
        .iter()
        .find(|entry| entry["typeName"] == "SessionRecord")
        .unwrap_or_else(|| panic!("the leaking cache's element type was not reported: {types:?}"));

    assert!(
        session_record["objectCount"].as_u64().is_some_and(|count| count > 1_000),
        "the sample's cache should hold thousands of records by the time it is walked: {session_record}"
    );
    assert!(
        session_record["liveBytes"].as_u64().is_some_and(|bytes| bytes > 0),
        "SessionRecord must account for live bytes: {session_record}"
    );

    // "What would be freed" is a different number from "what it occupies", and the sample is the
    // case where the two must differ: every record holds a 256-byte payload, so removing the records
    // frees far more than the records themselves. If the retained measure were ever accidentally
    // wired to the live one, this is what would catch it.
    let live = session_record["liveBytes"].as_u64().expect("liveBytes must be a number");
    let retained = session_record["retainedBytes"]
        .as_u64()
        .unwrap_or_else(|| panic!("SessionRecord has no retained size: {session_record}"));

    assert!(
        retained > live,
        "removing the sample's records must free more than the records themselves \
         (live {live} bytes, freed {retained} bytes)"
    );
    assert!(
        retained <= total_bytes,
        "a type cannot free more than the whole heap ({retained} > {total_bytes})"
    );

    // The answer the panel exists to give: the chain from a root to one live instance.
    let retention = data["retention"].as_array().expect("retention must be an array");
    let path = retention
        .iter()
        .find(|path| path["typeName"] == "SessionRecord")
        .unwrap_or_else(|| {
            panic!("no retention path to the leakiest type was reported: {retention:?}")
        });

    assert!(
        path["truncated"].as_bool() == Some(false),
        "the path to the cache's records is short enough to reach the root: {path}"
    );

    let frames = path["frames"].as_array().expect("a path must carry its frames");
    assert!(frames.len() >= 2, "a one-frame path names nothing: {path}");

    // Root first, object last — the order the panel renders and the order the answer is read in.
    let last = frames.last().unwrap();
    assert_eq!(last["typeName"], "SessionRecord", "the chain must end at the type it explains");

    for frame in frames {
        assert!(
            frame["typeName"].as_str().is_some_and(|name| !name.is_empty())
                && frame["label"].as_str().is_some_and(|label| !label.is_empty())
                && frame["size"].as_u64().is_some(),
            "every frame must name what it is, what points at it and how big it is: {frame}"
        );

        // Each frame carries what it alone holds, which is what makes a chain readable: the small
        // dictionary above the entry array is the frame that explains the leak, and only this number
        // says so. It can never be less than the object's own size.
        let size = frame["size"].as_u64().expect("frame size must be a number");
        let frame_retained = frame["retainedBytes"]
            .as_u64()
            .unwrap_or_else(|| panic!("frame has no retained size: {frame}"));

        assert!(
            frame_retained >= size,
            "an object always frees at least itself ({frame_retained} < {size}): {frame}"
        );
        assert!(
            frame_retained <= total_bytes,
            "a frame cannot hold more than the whole heap ({frame_retained} > {total_bytes}): {frame}"
        );
    }

    // The dictionary that holds the records has to appear in the chain, because it is the reason
    // the records are alive at all. A path that skipped it would be a path through nothing.
    assert!(
        frames.iter().any(|frame| frame["typeName"]
            .as_str()
            .is_some_and(|name| name.contains("Dictionary"))),
        "the chain does not pass through the cache that holds the records: {path}"
    );
    assert!(
        frames.iter().any(|frame| frame["typeName"]
            .as_str()
            .is_some_and(|name| name.contains("Entry"))),
        "the chain does not pass through the dictionary's entry array, which is what holds every \
         record in one object: {path}"
    );

    // The root frame is the reference that has to be cut, so it is asserted to be a real one.
    let root = &frames[0];
    assert!(
        root["label"]
            .as_str()
            .is_some_and(|label| label.starts_with("static ") || label.starts_with("GC root (")),
        "the first frame must be a root the runtime named, not a guessed one: {root}"
    );
    assert_eq!(
        path["rootLabel"], root["label"],
        "rootLabel must agree with the first frame, or the summary and the chain disagree"
    );

    // Which events actually arrived, so a graph built from a partial stream is visible rather
    // than inferred from numbers that look plausible.
    assert!(
        data["inventory"]
            .as_array()
            .is_some_and(|entries| entries.iter().any(|entry| entry
                .as_str()
                .is_some_and(|name| name.starts_with("GC/BulkNode")))),
        "the snapshot must report the heap-graph events it saw: {:?}",
        data["inventory"]
    );

    handle.stop();
}

/// Guards against the collector silently disappearing from the expected build locations.
#[test]
fn collector_is_located_from_build_output_during_development() {
    let location = collector::locate_collector();
    assert_located(&location);

    let assembly = Path::new(location.assembly_path.as_deref().unwrap());
    assert!(assembly.is_file(), "located assembly does not exist: {}", assembly.display());
    assert_eq!(assembly.file_name().unwrap(), "MemorySpy.Collector.dll");
}
