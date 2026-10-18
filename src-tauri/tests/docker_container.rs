//! Verification of the Docker transport against a real container.
//!
//! The transport is the part that cannot be tested by unit tests: it depends on `docker cp`
//! landing an executable that actually runs in the image, on the container's own diagnostics
//! sockets being visible to a collector started with `docker exec`, and on the NDJSON pipe
//! surviving the extra process hop.
//!
//! The tests provision their own target, so they need no manual setup: when a Docker daemon is
//! reachable they start a throwaway `dotnet/runtime` container, publish the leaking sample for
//! the daemon's architecture, copy it in, run it, and delete the container afterwards. When no
//! daemon is reachable they skip — and say so — instead of failing a machine that legitimately
//! has none. The one prerequisite a daemon alone cannot satisfy is the Linux collector:
//!
//! ```sh
//! npm run collector:docker
//! cargo test --manifest-path src-tauri/Cargo.toml --test docker_container -- --nocapture
//! ```
//!
//! `MEMORYSPY_TEST_CONTAINER` still works, and then nothing is created or removed: point it at a
//! running container and the tests use that target instead. `MEMORYSPY_TEST_IMAGE` overrides the
//! base image.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use memoryspy_lib::collector::{self, CollectorLocation, EventSink, SessionRequest, SessionState};
use memoryspy_lib::docker;
use serde_json::Value;

/// The image the managed container runs. The runtime (not the SDK) image is enough: the sample
/// is published framework-dependent on this machine and only needs a `dotnet` host to run.
const DEFAULT_IMAGE: &str = "mcr.microsoft.com/dotnet/runtime:10.0";

const SAMPLE_PROJECT: &str = "samples/LeakyCache";
const SAMPLE_NAME: &str = "MemorySpy.Samples.LeakyCache";

/// Staging the collector is an ~80 MB copy, and the sample needs a moment to publish its
/// diagnostics endpoint, so the first discovery call gets real head room.
const SETUP_TIMEOUT: Duration = Duration::from_secs(120);

// ---------------------------------------------------------------------------------------
// Talking to the Docker CLI
// ---------------------------------------------------------------------------------------

/// Runs the docker CLI, returning stdout or a readable error.
///
/// The library's own helper is private to the host crate, and a test that imported the host's
/// implementation would stop testing the thing it is meant to verify — the CLI contract and its
/// exit codes.
fn docker(arguments: &[&str]) -> Result<String, String> {
    let output = Command::new("docker")
        .args(arguments)
        .output()
        .map_err(|error| format!("could not run the Docker CLI: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "docker {} failed with {}",
                arguments.join(" "),
                output.status
            )
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri always has a parent")
        .to_path_buf()
}

/// The runtime identifier of the daemon, i.e. of the images `docker run` would pick by default.
fn daemon_rid() -> Result<&'static str, String> {
    match docker(&["version", "--format", "{{.Server.Arch}}"])?.trim() {
        "arm64" | "aarch64" => Ok("linux-arm64"),
        "amd64" | "x86_64" => Ok("linux-x64"),
        other => Err(format!("the Docker daemon reports architecture '{other}'")),
    }
}

/// Publishes the leaking sample for the daemon's architecture, once per test run.
///
/// `UseAppHost=false` is deliberate: no native apphost is generated, so cross-publishing an
/// amd64 sample from an arm64 machine needs no runtime pack from the network. The container runs
/// it as `dotnet <dll>`, which is the one thing every .NET image can do.
fn publish_sample(rid: &str) -> Result<PathBuf, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Result<PathBuf, String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    // The two tests can run in parallel and would otherwise publish into the same intermediate
    // `obj/` directory at the same time.
    let mut guard = cache.lock().unwrap();
    if let Some(cached) = guard.get(rid) {
        return cached.clone();
    }

    let output_dir = std::env::temp_dir().join(format!("memoryspy-test-app-{rid}"));
    let _ = std::fs::remove_dir_all(&output_dir);

    let result = Command::new("dotnet")
        .args([
            "publish",
            &repo_root().join(SAMPLE_PROJECT).display().to_string(),
            "-c",
            "Debug",
            "-r",
            rid,
            "--self-contained",
            "false",
            "-p:UseAppHost=false",
            "-o",
            &output_dir.display().to_string(),
        ])
        .output()
        .map_err(|error| format!("could not run dotnet publish: {error}"))
        .and_then(|output| {
            if output.status.success() {
                Ok(output_dir.clone())
            } else {
                Err(format!(
                    "dotnet publish of the sample for {rid} failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ))
            }
        });

    guard.insert(rid.to_string(), result.clone());
    result
}

// ---------------------------------------------------------------------------------------
// The container under test
// ---------------------------------------------------------------------------------------

/// A target container, plus whether this test owns it.
///
/// Dropping it removes a container the test created; a container handed in through
/// `MEMORYSPY_TEST_CONTAINER` is never touched, because it belongs to whoever started it.
struct Fixture {
    container: String,
    owned: bool,
    /// The sample's pid inside the container, when this fixture started it.
    sample_pid: Option<i32>,
    /// Held for the duration of a test that uses a container somebody else started.
    ///
    /// Two sessions against the *same* target are not independent: a session that enables the
    /// allocation-sampling keyword makes the runtime report allocations as `AllocationSampling`
    /// for its collection, so a concurrent session waiting for `GC/AllocationTick` silently sees
    /// nothing — measured here as "no allocation samples arrived" when the two tests shared one
    /// container. Managed fixtures each get their own container and stay parallel.
    _provided_guard: Option<std::sync::MutexGuard<'static, ()>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if self.owned {
            let _ = docker(&["rm", "-f", &self.container]);
        }
    }
}

impl Fixture {
    /// A container to profile, or `None` when the environment cannot provide one.
    fn acquire() -> Option<Self> {
        if let Some(container) = std::env::var("MEMORYSPY_TEST_CONTAINER")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            static PROVIDED_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let guard = PROVIDED_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            return Some(Self {
                container,
                owned: false,
                sample_pid: None,
                _provided_guard: Some(guard),
            });
        }

        let status = docker::status();
        if !status.available {
            eprintln!(
                "skipping: Docker is not reachable ({}).",
                status.error.unwrap_or_else(|| "no error reported".into())
            );
            return None;
        }

        // Past this point the daemon is present, so a missing prerequisite is a failure rather
        // than a skip. Skipping here as well would make a CI run that never exercised Docker look
        // green — the one outcome these tests exist to prevent.
        let rid = daemon_rid().unwrap_or_else(|error| panic!("cannot pick a target: {error}"));

        let staged = docker::staged_rids();
        assert!(
            staged
                .iter()
                .any(|candidate| candidate == rid || candidate == "override"),
            "no {rid} collector has been published for this daemon (staged: {staged:?}). \
             Run `npm run collector:docker -- {rid}`."
        );

        let app_dir = publish_sample(rid).unwrap_or_else(|error| {
            panic!("could not prepare the sample for the container: {error}")
        });

        let image =
            std::env::var("MEMORYSPY_TEST_IMAGE").unwrap_or_else(|_| DEFAULT_IMAGE.to_string());
        // The two tests run in parallel, so a name built from the clock alone can collide —
        // measured: both fixtures picked the same millisecond and one lost the name race.
        static SEQUENCE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let name = format!(
            "memoryspy-test-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );

        // A leftover from an interrupted run would make `docker run` fail with a name conflict,
        // which is easy to mistake for a broken test.
        let _ = docker(&["rm", "-f", &name]);

        // A non-root user on purpose: production .NET images run as `app` (and many services set
        // `user:` in compose), so the transport has to work when the collector is copied in by the
        // daemon (root-owned, 0755) but executed by the image's own user. Running the fixture as
        // root would hide exactly the permission shape that breaks in a real deployment.
        docker(&[
            "run",
            "-d",
            "--name",
            &name,
            "--user",
            "1000:1000",
            "--platform",
            &format!(
                "linux/{}",
                if rid == "linux-arm64" {
                    "arm64"
                } else {
                    "amd64"
                }
            ),
            &image,
            "sleep",
            "infinity",
        ])
        .unwrap_or_else(|error| {
            panic!(
                "could not start {image} ({error}). Pull it once, or set MEMORYSPY_TEST_IMAGE to a \
                 .NET image this daemon already has."
            )
        });

        // From here on the fixture owns the container, so every failure path below still removes
        // it — including a panic in an assertion further down the test.
        let mut fixture = Self {
            container: name,
            owned: true,
            sample_pid: None,
            _provided_guard: None,
        };

        let source = format!("{}/.", app_dir.display());
        let destination = format!("{}:/app/", fixture.container);
        if let Err(error) = docker(&["cp", &source, &destination]) {
            panic!(
                "could not copy the sample into {}: {error}",
                fixture.container
            );
        }

        if let Err(error) = docker(&[
            "exec",
            "-d",
            &fixture.container,
            "dotnet",
            &format!("/app/{SAMPLE_NAME}.dll"),
            "cache",
        ]) {
            panic!(
                "could not start the sample inside {}: {error}",
                fixture.container
            );
        }

        let (pid, _name) = fixture.target();
        fixture.sample_pid = Some(pid);
        Some(fixture)
    }

    /// The process to attach to: the sample this fixture started, or the largest .NET process in
    /// a container the caller supplied.
    fn target(&self) -> (i32, String) {
        let deadline = Instant::now() + SETUP_TIMEOUT;
        let mut last_error;

        loop {
            match docker::list_processes(&self.container) {
                Ok(processes) => {
                    let candidates: Vec<_> = processes
                        .iter()
                        // Discovery lists the collector too: it publishes its own diagnostics
                        // endpoint, so "the first process" would be the tool itself.
                        .filter(|process| !process.name.contains("memoryspy-collector"))
                        .collect();

                    if let Some(target) = candidates
                        .iter()
                        .find(|process| {
                            process
                                .command_line
                                .as_deref()
                                .is_some_and(|line| line.contains(SAMPLE_NAME))
                        })
                        .or_else(|| {
                            candidates
                                .iter()
                                .max_by_key(|process| process.working_set_bytes.unwrap_or(0))
                        })
                    {
                        return (target.pid, target.name.clone());
                    }

                    last_error = "no .NET process other than the collector was listed".to_string();
                }
                Err(error) => last_error = error,
            }

            if Instant::now() > deadline {
                panic!(
                    "no attachable .NET process appeared in {} within {}s ({last_error})",
                    self.container,
                    SETUP_TIMEOUT.as_secs()
                );
            }

            thread::sleep(Duration::from_millis(500));
        }
    }
}

// ---------------------------------------------------------------------------------------
// Recording sink
// ---------------------------------------------------------------------------------------

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
        self.logs
            .lock()
            .unwrap()
            .push((level.to_string(), message.to_string()));
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

    fn all_logs(&self) -> Vec<(String, String)> {
        self.logs.lock().unwrap().clone()
    }
}

/// A session started against a container never launches the host collector, so the location is
/// a placeholder. It is still part of the signature because a local session needs it.
fn container_location() -> CollectorLocation {
    CollectorLocation {
        found: true,
        dotnet_path: None,
        assembly_path: None,
        executable_path: None,
        source: "docker".into(),
        dotnet_version: None,
        searched: vec![],
        error: None,
    }
}

fn session_request(container: &str, pid: i32) -> SessionRequest {
    SessionRequest {
        pid,
        probes: vec![],
        interval_ms: Some(500),
        max_types: Some(60),
        verbose: false,
        deep_capture: false,
        capture_max_mb: None,
        record: false,
        record_path: None,
        target_name: Some(format!("container:{container}")),
        target_runtime: None,
        container: Some(container.to_string()),
    }
}

// ---------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------

#[test]
fn a_container_target_is_listed_and_profiled() {
    let Some(fixture) = Fixture::acquire() else {
        return;
    };

    // The container has to be in the list the UI shows, or the rail would not offer it.
    let containers = docker::list_containers().expect("running containers must be listable");
    assert!(
        containers
            .iter()
            .any(|candidate| candidate.name == fixture.container
                || candidate.id == fixture.container),
        "{} was not listed. Saw: {:?}",
        fixture.container,
        containers
            .iter()
            .map(|candidate| candidate.name.clone())
            .collect::<Vec<_>>()
    );

    // Staging is what proves the published binary runs in this image: `ensure_collector` copies
    // it and only returns success once `capabilities` answers from inside the container.
    let staged =
        docker::ensure_collector(&fixture.container).expect("the collector must be stageable");
    assert!(
        staged.path.starts_with("/tmp/"),
        "the collector is staged at an unexpected path: {}",
        staged.path
    );

    let (pid, name) = fixture.target();

    let sink = Arc::new(RecordingSink::default());
    let handle = collector::start_session(
        sink.clone(),
        &container_location(),
        session_request(&fixture.container, pid),
        None,
    )
    .expect("a container session must start");

    assert_eq!(handle.pid(), pid);
    assert_eq!(handle.container(), Some(fixture.container.as_str()));

    assert!(
        sink.wait_for("session.started", 1, Duration::from_secs(15)),
        "no session.started message arrived; logs: {:?}",
        sink.all_logs()
    );

    assert!(
        sink.wait_for("counter.sample", 2, Duration::from_secs(30)),
        "no counter samples arrived from {name} in {}; logs: {:?}",
        fixture.container,
        sink.all_logs()
    );

    // Counters are normalised by the collector, not by the transport, but a container session
    // that lost the unit would mean the pipe, not the analysis, was the problem.
    let counters = sink.of_type("counter.sample");
    let last = &counters[counters.len() - 1];
    let readings = last["data"]["counters"]
        .as_array()
        .expect("counter.sample must carry a counters array");
    assert!(!readings.is_empty(), "the counter batch was empty");

    let heap = readings
        .iter()
        .find(|reading| reading["name"] == "gc-heap-size")
        .unwrap_or_else(|| panic!("gc-heap-size was not reported: {readings:?}"));
    assert_eq!(heap["unit"], "bytes");
    assert!(
        heap["value"].as_f64().is_some_and(|value| value > 0.0),
        "the target's heap was reported as empty: {heap}"
    );

    // Per-type allocation is the reason this tool exists, so the container path has to deliver
    // it too — the sampler events and the transport are independent failure modes.
    assert!(
        sink.wait_for("allocation.sample", 2, Duration::from_secs(30)),
        "no allocation samples arrived; logs: {:?}",
        sink.all_logs()
    );

    let allocations = sink.of_type("allocation.sample");
    let types = allocations[allocations.len() - 1]["data"]["types"]
        .as_array()
        .expect("allocation.sample must carry a types array");
    assert!(
        types
            .iter()
            .any(|entry| entry["intervalBytes"].as_f64().unwrap_or(0.0) > 0.0),
        "no allocated type reported volume: {types:?}"
    );

    // When this test started the sample itself, the answer can be checked against the code that
    // is leaking: a transport that delivered counters but no per-type detail would fail here.
    if fixture.sample_pid.is_some() {
        assert!(
            types.iter().any(|entry| entry["typeName"] == "SessionRecord"),
            "the leaking type was not among the types reported through the container transport: {:?}",
            types
                .iter()
                .filter_map(|entry| entry["typeName"].as_str())
                .collect::<Vec<_>>()
        );
    }

    handle.stop();

    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if matches!(handle.state(), SessionState::Stopped | SessionState::Failed) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }

    assert!(
        handle.state() == SessionState::Stopped,
        "the container session did not stop cleanly (state {:?}); logs: {:?}",
        handle.state(),
        sink.all_logs()
    );

    // The kill is the failure this pins: a `docker exec` client that dies without the collector
    // noticing used to leave an EventPipe session attached inside the container. The warning is
    // printed by the host when it has to kill the child, so its absence is the proof that the
    // collector shut itself down.
    assert!(
        sink.all_logs()
            .iter()
            .all(|(_, message)| !message.contains("did not stop within the timeout")),
        "the collector had to be killed on stop; logs: {:?}",
        sink.all_logs()
    );
}

/// A deep capture made in a container has to come back to this machine.
///
/// The file is written where the *container* can write, so the interesting part is not that the
/// analysis ran — it is that the artifact the analysis was made from ends up beside the
/// recordings, with bytes in it, after the session has ended.
#[test]
fn a_container_capture_is_copied_out() {
    let Some(fixture) = Fixture::acquire() else {
        return;
    };

    let (pid, _name) = fixture.target();

    let capture_dir = std::env::temp_dir().join(format!(
        "memoryspy-docker-capture-{}-{}",
        std::process::id(),
        pid
    ));
    let _ = std::fs::remove_dir_all(&capture_dir);

    // Recorded as well, because the copy-out answer is host-originated: a replay has to carry
    // the local path, not the in-container one it was copied from.
    let recording_path = std::env::temp_dir().join(format!(
        "memoryspy-docker-recording-{}-{}.jsonl",
        std::process::id(),
        pid
    ));
    let _ = std::fs::remove_file(&recording_path);

    let mut request = session_request(&fixture.container, pid);
    request.deep_capture = true;
    request.probes = vec!["allocations".to_string(), "allocation-sites".to_string()];
    request.record = true;
    request.record_path = Some(recording_path.display().to_string());

    let sink = Arc::new(RecordingSink::default());
    let handle = collector::start_session(
        sink.clone(),
        &container_location(),
        request,
        Some(capture_dir.clone()),
    )
    .expect("a capturing container session must start");

    assert!(
        sink.wait_for("session.started", 1, Duration::from_secs(15)),
        "no session.started message arrived; logs: {:?}",
        sink.all_logs()
    );

    // The handshake must name the *collector's* path, because that is where the file is while
    // the session runs. The copy-out is what turns it into a host path.
    let started = sink.of_type("session.started");
    let reported = started[0]["data"]["deepCapture"]["path"]
        .as_str()
        .expect("session.started must report where the capture is going")
        .to_string();
    assert!(
        reported.starts_with("/tmp/"),
        "a container capture must be written to a path inside the container, got {reported}"
    );

    thread::sleep(Duration::from_secs(6));
    handle.stop();

    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if matches!(handle.state(), SessionState::Stopped | SessionState::Failed) {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    assert!(
        handle.state() == SessionState::Stopped,
        "the capturing session did not stop cleanly (state {:?}); logs: {:?}",
        handle.state(),
        sink.all_logs()
    );

    let file_name = reported.rsplit('/').next().unwrap();
    let local = capture_dir.join(file_name);
    let size = std::fs::metadata(&local)
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    assert!(
        size > 0,
        "the capture was not copied out to {} (size {size}); logs: {:?}",
        local.display(),
        sink.all_logs()
    );

    // The collector's path points inside a container that may not outlive the session, so the
    // host has to publish the path the UI should show from now on. Without this message the rail
    // would keep naming `/tmp/…` in a container nobody can open.
    assert!(
        sink.wait_for("capture.copied", 1, Duration::from_secs(10)),
        "the host did not report the capture as copied; logs: {:?}",
        sink.all_logs()
    );

    let copied = sink.of_type("capture.copied");
    let expected = local.display().to_string();
    assert_eq!(
        copied[0]["data"]["path"].as_str(),
        Some(expected.as_str()),
        "the UI would be pointed at {} instead of {}: {}",
        reported,
        expected,
        copied[0]
    );
    assert_eq!(
        copied[0]["data"]["bytes"].as_u64(),
        Some(size),
        "the reported capture size does not match the file on disk: {}",
        copied[0]
    );

    // And it has to be the real trace, not an empty file: the collector's own analysis of it is
    // the strongest available proof that the bytes survived the copy.
    assert!(
        sink.wait_for("allocation.site", 1, Duration::from_secs(120)),
        "no call-site analysis came out of the container capture; logs: {:?}",
        sink.all_logs()
    );

    let analysis = sink.of_type("allocation.site");
    assert!(
        analysis[0]["data"]["sampledEvents"].as_u64().unwrap_or(0) > 0,
        "the analysis of the copied capture held no samples: {}",
        analysis[0]["data"]
    );

    // The copy-out is the host's own message. It only survives into a replay if the host records
    // it, so the recording is checked here rather than assumed from the live sink.
    let recording = std::fs::read_to_string(&recording_path).expect("the recording must exist");
    assert!(
        recording.contains("\"capture.copied\""),
        "the copy-out answer was not recorded, so a replay would name the container path"
    );
    assert!(
        recording.contains(&expected),
        "the recording does not name the copied-out capture at {expected}"
    );
    let _ = std::fs::remove_file(&recording_path);

    // The artifact is removed by default because it is a multi-megabyte temp file nothing reads
    // after the assertions. `MEMORYSPY_KEEP_CAPTURE=1` leaves it in place and prints the path,
    // which is how the live reveal check in `reveal.rs` gets a capture that a real container
    // session actually produced:
    //
    // ```text
    // MEMORYSPY_KEEP_CAPTURE=1 cargo test --test docker_container a_container_capture_is_copied_out
    // MEMORYSPY_REVEAL_LIVE=<printed path> cargo test --lib -- --ignored live_reveal
    // ```
    if std::env::var_os("MEMORYSPY_KEEP_CAPTURE").is_some() {
        println!("capture kept at {}", local.display());
    } else {
        let _ = std::fs::remove_dir_all(&capture_dir);
    }
}

/// A copy that fails has to reach the UI, not just the log.
///
/// The path the collector reported is inside the container, and when the copy cannot land there is
/// no local file to point at. A rail that silently kept showing `/tmp/…` would invite the user to
/// open a container path on their desktop, so the failure is published as a message of its own.
/// A directory the test's user cannot write into is the cheapest faithful failure: the collector
/// wrote and analysed the file inside the container, and only `docker cp` cannot complete.
#[cfg(unix)]
#[test]
fn a_failed_capture_copy_is_reported_to_the_ui() {
    use std::os::unix::fs::PermissionsExt;

    let Some(fixture) = Fixture::acquire() else {
        return;
    };

    let (pid, _name) = fixture.target();

    let capture_dir = std::env::temp_dir().join(format!(
        "memoryspy-docker-capture-denied-{}-{}",
        std::process::id(),
        pid
    ));
    let _ = std::fs::remove_dir_all(&capture_dir);
    std::fs::create_dir_all(&capture_dir).expect("the capture directory must be creatable");
    std::fs::set_permissions(&capture_dir, std::fs::Permissions::from_mode(0o555))
        .expect("the capture directory must become read-only");

    // Restored on every exit path, including a panic: a 0555 directory is otherwise a nuisance
    // for whoever cleans the temp folder next.
    struct ReadOnlyDir(PathBuf);
    impl Drop for ReadOnlyDir {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _guard = ReadOnlyDir(capture_dir.clone());

    let mut request = session_request(&fixture.container, pid);
    request.deep_capture = true;
    request.probes = vec!["allocations".to_string(), "allocation-sites".to_string()];

    let sink = Arc::new(RecordingSink::default());
    let handle = collector::start_session(
        sink.clone(),
        &container_location(),
        request,
        Some(capture_dir.clone()),
    )
    .expect("a capturing container session must start");

    assert!(
        sink.wait_for("session.started", 1, Duration::from_secs(15)),
        "no session.started message arrived; logs: {:?}",
        sink.all_logs()
    );

    thread::sleep(Duration::from_secs(6));
    handle.stop();

    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if matches!(handle.state(), SessionState::Stopped | SessionState::Failed) {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    assert!(
        handle.state() == SessionState::Stopped,
        "the capturing session did not stop cleanly (state {:?}); logs: {:?}",
        handle.state(),
        sink.all_logs()
    );

    assert!(
        sink.wait_for("capture.copyFailed", 1, Duration::from_secs(10)),
        "the failed copy-out was not reported to the UI; logs: {:?}",
        sink.all_logs()
    );

    let failed = sink.of_type("capture.copyFailed");
    let data = &failed[0]["data"];
    assert_eq!(
        data["container"].as_str(),
        Some(fixture.container.as_str()),
        "the failure must name the container that still holds the file: {}",
        failed[0]
    );
    assert!(
        data["remote"]
            .as_str()
            .is_some_and(|path| path.starts_with("/tmp/")),
        "the failure must carry the path inside the container: {}",
        failed[0]
    );
    assert!(
        data["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty()),
        "the failure must carry the CLI's reason: {}",
        failed[0]
    );
    assert!(
        sink.of_type("capture.copied").is_empty(),
        "the host reported a copy it did not make"
    );
    assert!(
        std::fs::read_dir(&capture_dir)
            .expect("the capture directory must still exist")
            .next()
            .is_none(),
        "a file landed in the read-only directory despite the reported failure"
    );
}
