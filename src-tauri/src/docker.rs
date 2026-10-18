//! Attaching to .NET processes that run inside a Docker container.
//!
//! A container has its own mount and PID namespaces, and .NET publishes its diagnostics
//! endpoint as a Unix socket at `$TMPDIR/dotnet-diagnostic-<pid>-<key>-socket` (and resolves it
//! again by pid). So from the host:
//!
//! * `DiagnosticsClient.GetPublishedProcesses()` sees only the *host's* sockets — a container
//!   process never appears in the process list;
//! * `new DiagnosticsClient(pid)` cannot be pointed at a socket path (the package exposes only
//!   `DiagnosticsClient(int processId)`), and even the host-visible pid would not match the pid
//!   in the socket's name.
//!
//! Docker Desktop makes the first problem permanent: containers run in a Linux VM, so their
//! pids do not exist in the host namespace at all.
//!
//! The transport used here therefore runs the collector *inside the container*: the Linux build
//! published by `npm run collector:docker` is copied in with `docker cp` once per collector build,
//! then started with `docker exec -i`. The NDJSON protocol is unchanged — stdout and stdin of the exec are the same
//! pipes the host already reads and writes — so no probe, panel or analysis knows the difference.
//! Two consequences worth naming: the collector runs as the container's user (which is normally
//! the target's user, the requirement .NET puts on diagnostics), and a deep capture is written
//! inside the container, then copied out when the session ends.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;

use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::collector::{parse_process_list, DotnetProcessInfo};

/// How long any single Docker CLI call may take before it is killed.
///
/// The number is deliberately far above the slowest legitimate call: copying the ~80 MB collector
/// into a container takes under a second on a local daemon, so two minutes is already generous
/// head room for a slow disk. What it is not is a performance budget — it is the difference
/// between a hung daemon and an app that waits forever: Docker Desktop's VM can stop answering
/// while the CLI sits in a read, and without a deadline the Containers section would keep saying
/// "Listing…" for the rest of the session with no way out except restarting the app.
const CLI_TIMEOUT: Duration = Duration::from_secs(120);

/// The deadline for the daemon probe behind [`status`], which is shorter on purpose.
///
/// Nobody is waiting on an artifact here: the answer decides whether the Containers section is
/// shown, and its two outcomes are "usable" and "not usable". Twenty seconds is long enough for
/// Docker Desktop to finish booting, and short enough that a wedged daemon leaves the rail
/// usable instead of holding a spinner for the length of a file copy's deadline.
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a `docker cp` may take.
///
/// Longer than [`CLI_TIMEOUT`] on purpose: a deep capture is capped at 256 MB and is copied out
/// of the container after the collector exits, and a slow (especially virtualised) filesystem can
/// make that take minutes. The deadline still exists — a wedged daemon must not hold the session
/// forever — but it is sized for the artifact rather than for a version probe.
const COPY_TIMEOUT: Duration = Duration::from_secs(600);

/// How often a running call is checked for completion.
const CLI_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The Docker CLI. Overridable for an unusual install (a wrapper, a remote context).
pub(crate) fn cli() -> String {
    std::env::var("MEMORYSPY_DOCKER").unwrap_or_else(|_| "docker".to_string())
}

/// Runs the docker CLI and returns its stdout.
///
/// stdin is closed on purpose: nothing here reads input, and a `docker exec` without `-i` would
/// otherwise inherit the app's stdin and keep the dialogue open.
fn run(arguments: &[&str]) -> Result<String, String> {
    invoke(&cli(), arguments, CLI_TIMEOUT)
}

/// Runs a command to completion, or kills it at `timeout`.
///
/// stdout and stderr are drained on their own threads rather than through `Command::output`,
/// because a blocking `output()` has no deadline to check: a daemon that stops answering leaves
/// the caller parked on a pipe read with no child status to poll. Draining concurrently also
/// keeps a chatty command from filling the pipe buffer and deadlocking against its own wait.
fn invoke(program: &str, arguments: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::collector::without_console_window(&mut command);

    let mut child = command.spawn().map_err(|error| {
        format!(
            "Could not start {program} ({error}). If that is the Docker CLI, install Docker or \
             point MEMORYSPY_DOCKER at the docker executable."
        )
    })?;

    let stdout_reader = spawn_reader(child.stdout.take());
    let stderr_reader = spawn_reader(child.stderr.take());
    let deadline = Instant::now() + timeout;

    let status = match wait_with_deadline(&mut child, deadline, timeout) {
        Ok(status) => status,
        Err(error) => {
            // A killed process can leave descendants holding its pipes open. Dropping the
            // receivers detaches the readers so they cannot reintroduce the hang we're avoiding.
            drop(stdout_reader);
            drop(stderr_reader);
            return Err(error);
        }
    };

    // The direct CLI can exit while a wrapper's descendant still holds stdout/stderr open.
    // Receiving each stream against the original deadline bounds the *whole* operation, not just
    // the direct child process wait.
    let stdout = match read_until_deadline(stdout_reader, deadline, timeout, "stdout") {
        Ok(stdout) => stdout,
        Err(error) => {
            drop(stderr_reader);
            return Err(error);
        }
    };
    let stderr = read_until_deadline(stderr_reader, deadline, timeout, "stderr")?;

    if !status.success() {
        let message = stderr.trim();
        return Err(if message.is_empty() {
            format!("docker {} failed with {status}.", arguments.join(" "))
        } else {
            message.to_string()
        });
    }

    Ok(stdout)
}

/// Waits for the child, killing it once `timeout` has elapsed.
fn wait_with_deadline(
    child: &mut Child,
    deadline: Instant,
    timeout: Duration,
) -> Result<std::process::ExitStatus, String> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Could not wait for the Docker CLI: {error}"));
            }
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "The Docker CLI did not answer within {}s and was stopped. A wedged or paused \
                 Docker daemon is the usual cause; restart Docker and try again.",
                timeout.as_secs()
            ));
        }

        thread::sleep(CLI_POLL_INTERVAL);
    }
}

/// Reads a child pipe to a string on its own thread, so waiting and reading cannot deadlock.
fn spawn_reader<R: Read + Send + 'static>(pipe: Option<R>) -> mpsc::Receiver<String> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_string(&mut text);
        }
        let _ = sender.send(text);
    });
    receiver
}

/// Receives a completed pipe drain without extending the command's original deadline.
fn read_until_deadline(
    reader: mpsc::Receiver<String>,
    deadline: Instant,
    timeout: Duration,
    stream: &str,
) -> Result<String, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    reader.recv_timeout(remaining).map_err(|error| match error {
        mpsc::RecvTimeoutError::Timeout => format!(
            "The Docker CLI {stream} pipe did not close within {}s; a child process may still be running.",
            timeout.as_secs()
        ),
        mpsc::RecvTimeoutError::Disconnected => {
            format!("Could not read the Docker CLI {stream} output.")
        }
    })
}

// ---------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------

/// Why containers cannot be listed, when they cannot.
///
/// The two cases deserve different answers in the UI: a machine without Docker is not a
/// container setup and should not grow a section explaining itself, while a machine *with* Docker
/// and a stopped daemon is one command away from working — and hiding the section there is what
/// makes a user think the app does not support containers at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DockerProblem {
    /// The CLI is not on PATH (or cannot be started), so this is not a Docker machine.
    CliMissing,
    /// The CLI is there, the daemon is not answering. Includes a daemon that stopped answering
    /// mid-call: its own error text (`did not answer within …`) says which.
    DaemonUnreachable,
}

/// What the UI needs to know before it offers the Docker section at all.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatus {
    pub available: bool,
    pub version: Option<String>,
    /// Which Linux collectors have been published into the app's resources. An empty list is
    /// actionable rather than merely sad: it tells the user to run `npm run collector:docker`.
    pub staged_rids: Vec<String>,
    pub error: Option<String>,
    /// Set whenever `available` is false; absent when the daemon answered.
    pub problem: Option<DockerProblem>,
}

pub fn status() -> DockerStatus {
    status_with(&cli())
}

/// The probe behind [`status`], separated from the CLI's path so the two answers it has to tell
/// apart — "no Docker here" and "Docker is here, daemon is not" — can be tested without mutating
/// the process environment.
fn status_with(program: &str) -> DockerStatus {
    let staged_rids = staged_rids();

    // `--version` is answered by the client alone and never contacts the daemon. It is therefore
    // the only way to tell "Docker is not installed" from "Docker is installed and stopped",
    // which is the difference between staying quiet and explaining the problem.
    if let Err(error) = invoke(program, &["--version"], STATUS_TIMEOUT) {
        return DockerStatus {
            available: false,
            version: None,
            staged_rids,
            error: Some(error),
            problem: Some(DockerProblem::CliMissing),
        };
    }

    match invoke(
        program,
        &["version", "--format", "{{.Server.Version}}"],
        STATUS_TIMEOUT,
    ) {
        Ok(version) => DockerStatus {
            available: true,
            version: Some(version.trim().to_string()),
            staged_rids,
            error: None,
            problem: None,
        },
        Err(error) => DockerStatus {
            available: false,
            version: None,
            staged_rids,
            error: Some(error),
            problem: Some(DockerProblem::DaemonUnreachable),
        },
    }
}

/// A running container the user can inspect.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
}

pub fn list_containers() -> Result<Vec<DockerContainer>, String> {
    // Tab separated fields, one container per line: the default table format wraps long image
    // names and would need a fragile column heuristic to parse back.
    let output = run(&[
        "ps",
        "--no-trunc",
        "--format",
        "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
    ])?;

    Ok(output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let id = fields.next()?.trim();
            let name = fields.next()?.trim();
            let image = fields.next().unwrap_or("").trim();
            let status = fields.next().unwrap_or("").trim();
            if id.is_empty() {
                return None;
            }
            Some(DockerContainer {
                id: id.to_string(),
                name: name.to_string(),
                image: image.to_string(),
                status: status.to_string(),
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------------------
// Staging the collector inside the container
// ---------------------------------------------------------------------------------------

/// The collector binary as it exists inside a container, plus which build it is.
#[derive(Debug, Clone)]
pub struct StagedCollector {
    pub rid: String,
    /// Absolute path inside the container's namespace.
    pub path: String,
}

/// Where a published Linux collector may live, in priority order.
fn collector_candidates(rid: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    // A packaged build: the resource directory is handed over by the Tauri host at startup.
    if let Ok(resource_dir) = std::env::var("MEMORYSPY_RESOURCE_DIR") {
        candidates.push(
            PathBuf::from(resource_dir)
                .join("collector-docker")
                .join(rid),
        );
    }

    // A development tree, so `npm run collector:docker` is the only setup step.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(
        manifest_dir
            .join("resources")
            .join("collector-docker")
            .join(rid),
    );

    candidates
}

fn staged_binary(rid: &str) -> Option<PathBuf> {
    // An explicit override wins, and is trusted for any architecture: someone pointing at a
    // binary knows which image they built it for.
    if let Ok(explicit) = std::env::var("MEMORYSPY_DOCKER_COLLECTOR") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }

    collector_candidates(rid)
        .into_iter()
        .map(|dir| dir.join("MemorySpy.Collector"))
        .find(|candidate| candidate.is_file())
}

/// The RIDs that have a published collector, so the UI can say what is missing.
pub fn staged_rids() -> Vec<String> {
    if std::env::var_os("MEMORYSPY_DOCKER_COLLECTOR").is_some() {
        // The override makes the binary's own architecture irrelevant to the answer.
        return vec!["override".to_string()];
    }

    [
        "linux-arm64",
        "linux-x64",
        "linux-musl-arm64",
        "linux-musl-x64",
    ]
    .into_iter()
    .filter(|rid| staged_binary(rid).is_some())
    .map(str::to_string)
    .collect()
}

/// The OS and architecture of the image a container was created from.
///
/// OS is validated before selecting the architecture-specific and libc-specific collector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ContainerTarget {
    glibc_rid: &'static str,
    musl_rid: &'static str,
}

/// Parses the operating system and architecture reported for an image.
fn parse_image_target(container: &str, details: &str) -> Result<ContainerTarget, String> {
    let mut fields = details.trim().split('|');
    let os = fields.next().unwrap_or_default().trim();
    let architecture = fields.next().unwrap_or_default().trim();

    if os != "linux" {
        return Err(format!(
            "The image behind {container} uses the '{os}' operating system. Only Linux containers can be profiled."
        ));
    }

    match architecture {
        "arm64" | "aarch64" => Ok(ContainerTarget {
            glibc_rid: "linux-arm64",
            musl_rid: "linux-musl-arm64",
        }),
        "amd64" | "x86_64" => Ok(ContainerTarget {
            glibc_rid: "linux-x64",
            musl_rid: "linux-musl-x64",
        }),
        other => Err(format!(
            "The image behind {container} targets '{other}', which MemorySpy cannot profile. \
             Only linux/arm64 and linux/amd64 images are supported."
        )),
    }
}

/// Reads OS and architecture from the immutable image referenced by this container.
fn container_target(program: &str, container: &str) -> Result<ContainerTarget, String> {
    let image_id = invoke(
        program,
        &["inspect", "--format", "{{.Image}}", container],
        CLI_TIMEOUT,
    )?;
    let image_id = image_id.trim();
    if image_id.is_empty() {
        return Err(format!(
            "Docker reported no image for container {container}."
        ));
    }

    let details = invoke(
        program,
        &[
            "image",
            "inspect",
            "--format",
            "{{.Os}}|{{.Architecture}}",
            image_id,
        ],
        CLI_TIMEOUT,
    )?;
    parse_image_target(container, &details)
}

fn is_libc_mismatch(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    [
        "no such file or directory",
        "not found",
        "error loading shared library",
        "ld-linux",
        "libc.so",
        "symbol not found",
    ]
    .iter()
    .any(|detail| error.contains(detail))
}

/// Gets the host runtime version required to run a copied container collector.
///
/// A glibc binary runs on Alpine only when its compatibility package is present, and a musl
/// binary needs Alpine's dynamic loader. Try the image's natural variant first, then try the
/// other published libc build when the first one cannot start.
fn stage_collector_for_target(
    program: &str,
    container: &str,
    target: ContainerTarget,
    explicit_override: bool,
) -> Result<StagedCollector, String> {
    if explicit_override {
        let source = staged_binary(target.glibc_rid).ok_or_else(|| {
            format!(
                "No collector has been published for this image. Build `{}` with `npm run collector:docker -- {}`.",
                target.glibc_rid, target.glibc_rid
            )
        })?;
        return stage_collector(program, container, target.glibc_rid, &source);
    }

    let mut attempted = Vec::new();
    let mut last_libc_error = None;
    for rid in [target.glibc_rid, target.musl_rid] {
        let Some(source) = staged_binary(rid) else {
            continue;
        };
        attempted.push(rid);
        match stage_collector(program, container, rid, &source) {
            Ok(staged) => return Ok(staged),
            Err(error) if is_libc_mismatch(&error) => last_libc_error = Some(error),
            Err(error) => return Err(error),
        }
    }

    if attempted.is_empty() {
        return Err(format!(
            "No collector has been published for this image. Build `{}` for glibc or `{}` for musl with `npm run collector:docker -- <linux-rid> [glibc|musl]`.",
            target.glibc_rid, target.musl_rid
        ));
    }

    let detail = last_libc_error
        .map(|error| format!(" Last error: {error}"))
        .unwrap_or_default();
    Err(format!(
        "No published collector could run in this image (tried {}). If it uses Alpine/musl, publish the musl variant with `npm run collector:docker -- {} musl`.{detail}",
        attempted.join(", "), target.glibc_rid
    ))
}

#[cfg(test)]
fn stage_collector_with_binaries(
    program: &str,
    container: &str,
    target: ContainerTarget,
    binaries: &[(&str, &Path)],
) -> Result<StagedCollector, String> {
    let mut attempted = Vec::new();
    for rid in [target.glibc_rid, target.musl_rid] {
        let Some((_, source)) = binaries.iter().find(|(candidate, _)| *candidate == rid) else {
            continue;
        };
        attempted.push(rid);
        match stage_collector(program, container, rid, source) {
            Ok(staged) => return Ok(staged),
            Err(error) if is_libc_mismatch(&error) => continue,
            Err(error) => return Err(error),
        }
    }
    Err(format!(
        "No published collector could run in this image (tried {}).",
        attempted.join(", ")
    ))
}

/// Makes sure the container has a runnable collector, and returns where it is.
///
/// The binary is copied to `/tmp` rather than into a subdirectory because `docker cp` refuses a
/// destination whose parent directory does not exist and there is no portable way to create one:
/// `docker exec mkdir` is unavailable in a distroless image, which is exactly the kind of image
/// that has no shell to run it in. `/tmp` always exists and is writable by the image's user.
///
/// The copy is skipped when *this build* already answers `capabilities`, which makes the check
/// the cost of a warm container (~200 ms) instead of an 80 MB copy. The content-addressed staged
/// path keeps an active older session isolated from a newer build; old copies are pruned after a
/// successful stage (the collector retains recent copies to avoid races with concurrent sessions).
pub fn ensure_collector(container: &str) -> Result<StagedCollector, String> {
    let program = cli();
    let target = container_target(&program, container)?;
    let explicit_override = std::env::var_os("MEMORYSPY_DOCKER_COLLECTOR").is_some();
    stage_collector_for_target(&program, container, target, explicit_override)
}

/// The staging decision, with the CLI and the local binary handed in.
///
/// Split from [`ensure_collector`] so the copy / probe / skip logic can be exercised against a
/// fake Docker CLI: the interesting failure modes (a stale copy, an unwritable filesystem, a
/// binary that lands but cannot run) are all answers the CLI gives, not things a daemon has to
/// provide.
fn stage_collector(
    program: &str,
    container: &str,
    rid: &str,
    source: &Path,
) -> Result<StagedCollector, String> {
    // Content-addressed paths prevent a rebuild from replacing a binary used by an active
    // session. Obsolete copies are pruned after the new executable has been verified.
    let identity = file_identity(source)?;
    let filename = format!("memoryspy-collector-{rid}-{identity}");
    let path = format!("/tmp/{filename}");

    if probe(program, container, &path, &identity).is_ok() {
        return Ok(StagedCollector {
            rid: rid.to_string(),
            path,
        });
    }

    let source = source.to_string_lossy().into_owned();
    let destination = format!("{container}:{path}");
    invoke(program, &["cp", &source, &destination], CLI_TIMEOUT).map_err(|error| {
        format!(
            "Could not copy the collector into {container} (is its filesystem read-only?): {error}"
        )
    })?;

    // Verify both the content identity and execution before any session relies on this copy.
    probe(program, container, &path, &identity).map_err(|error| {
        format!(
            "The collector was copied into {container} at {path} but does not run there: {error}"
        )
    })?;

    // Prune older content-addressed copies after this one is proven runnable. Linux keeps
    // already-running older sessions alive when their executable is unlinked.
    let prefix = format!("memoryspy-collector-{rid}-");
    let _ = invoke(
        program,
        &["exec", container, &path, "cleanup", &prefix],
        CLI_TIMEOUT,
    );

    Ok(StagedCollector {
        rid: rid.to_string(),
        path,
    })
}

fn probe(
    program: &str,
    container: &str,
    path: &str,
    expected_identity: &str,
) -> Result<(), String> {
    let actual_identity = invoke(program, &["exec", container, path, "version"], CLI_TIMEOUT)?;
    if actual_identity.trim() != expected_identity {
        return Err(format!(
            "collector identity mismatch: expected {expected_identity}, got {}",
            actual_identity.trim()
        ));
    }

    invoke(
        program,
        &["exec", container, path, "capabilities"],
        CLI_TIMEOUT,
    )
    .map(|_| ())
}

/// The SHA-256 identity of a collector executable's contents.
fn file_identity(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Could not read collector {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)
        .map_err(|error| format!("Could not hash collector {}: {error}", path.display()))?;
    Ok(format!("{:x}", hasher.finalize()))
}

// ---------------------------------------------------------------------------------------
// Inside-container discovery and sessions
// ---------------------------------------------------------------------------------------

/// Lists the attachable .NET processes inside one container.
///
/// The collector does this from inside, so `GetPublishedProcesses` reads the container's own
/// diagnostics sockets and the pids are the ones `docker exec ... --pid` expects.
pub fn list_processes(container: &str) -> Result<Vec<DotnetProcessInfo>, String> {
    let staged = ensure_collector(container)?;
    let output = run(&["exec", container, &staged.path, "list"])?;
    parse_process_list(&output).map_err(|error| format!("{error} (container {container})"))
}

/// Copies a file out of a container, used for a deep capture written in-container.
pub fn copy_out(container: &str, remote: &str, local: &std::path::Path) -> Result<(), String> {
    copy_out_with(&cli(), container, remote, local)
}

/// The copy-out itself, separated from the CLI's path so the failure path can be tested.
fn copy_out_with(program: &str, container: &str, remote: &str, local: &Path) -> Result<(), String> {
    let source = format!("{container}:{remote}");
    let destination = local.to_string_lossy().into_owned();

    invoke(program, &["cp", &source, &destination], COPY_TIMEOUT).map_err(|error| {
        // A killed or failed `docker cp` can leave a partial file at the destination. Keeping it
        // would make the host announce a capture that the analysis never produced, so the
        // failure path removes it; the real artifact is still inside the container.
        let _ = std::fs::remove_file(local);
        error
    })?;

    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// The failure this deadline exists for: a CLI that never answers.
    ///
    /// `sleep` is the cheapest stand-in for a wedged daemon — it is a child that produces no
    /// output and no status, which is exactly what `Command::output()` used to wait on forever.
    #[test]
    fn a_command_that_never_answers_is_killed_at_the_deadline() {
        let started = Instant::now();
        let error = invoke(
            "/bin/sh",
            &["-c", "exec sleep 30"],
            Duration::from_millis(300),
        )
        .expect_err("a command that never exits must not be reported as a success");
        let elapsed = started.elapsed();

        assert!(
            error.contains("did not answer"),
            "the timeout must say what happened, got: {error}"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "the deadline was not enforced: the call took {elapsed:?}"
        );
    }

    /// An exited wrapper cannot extend the command deadline by leaving descendants holding pipes.
    #[test]
    fn inherited_pipes_do_not_outlive_the_command_deadline() {
        let dir = staging_area("inherited-pipes");
        let pid_file = dir.join("child.pid");
        let script = format!("sleep 30 & echo $! > '{}'; exit 0", pid_file.display());
        let started = Instant::now();
        let error = invoke("/bin/sh", &["-c", &script], Duration::from_millis(300))
            .expect_err("inherited pipes must not make an exited command wait forever");
        let elapsed = started.elapsed();

        let child_pid = std::fs::read_to_string(&pid_file).expect("the child pid");
        let _ = Command::new("kill")
            .args(["-TERM", child_pid.trim()])
            .status();
        assert!(
            error.contains("pipe did not close"),
            "the reader deadline should identify the open pipe, got: {error}"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "a descendant holding a pipe defeated the deadline: {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Draining stdout on a thread must not lose or reorder the output of a normal call.
    #[test]
    fn stdout_is_returned_by_the_deadline_wrapper() {
        let stdout = invoke("/bin/sh", &["-c", "printf hello"], Duration::from_secs(5))
            .expect("a fast command must succeed");
        assert_eq!(stdout, "hello");
    }

    /// A rebuilt collector has to get a new staged name, or a long-lived container would keep
    /// answering `capabilities` from the old binary and silently miss every new probe.
    #[test]
    fn content_identity_detects_same_length_rebuilds() {
        let dir = std::env::temp_dir().join(format!(
            "memoryspy-collector-identity-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a temp dir for the identity test");

        let binary = dir.join("MemorySpy.Collector");
        std::fs::write(&binary, b"first build").expect("the first build");
        let first = file_identity(&binary).expect("hash the first collector");

        assert_eq!(
            file_identity(&binary).expect("hash the same collector again"),
            first,
            "the same file must keep its content identity across probes"
        );

        std::fs::write(&binary, b"other build").expect("a same-length rebuilt binary");
        let second = file_identity(&binary).expect("hash the rebuilt collector");
        assert_ne!(
            first, second,
            "same-length changed bytes reused a collector identity"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A non-zero exit must still carry the tool's own explanation, because that text is what the
    /// UI shows the user (`No such container`, `Cannot connect to the Docker daemon`, ...).
    #[test]
    fn a_failing_command_reports_its_stderr() {
        let error = invoke(
            "/bin/sh",
            &["-c", "echo boom >&2; exit 3"],
            Duration::from_secs(5),
        )
        .expect_err("a non-zero exit must be an error");
        assert!(error.contains("boom"), "stderr was not reported: {error}");
    }

    /// Writes a stand-in for the Docker CLI and makes it executable.
    fn fake_cli(name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "memoryspy-fake-docker-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a temp dir for the fake CLI");

        let path = dir.join("docker");
        std::fs::write(&path, body).expect("the fake CLI script");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("an executable fake CLI");
        path
    }

    /// A fresh directory for one test's fake CLI, staged paths and local binary.
    fn staging_area(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("memoryspy-staging-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a temp dir for the staging test");
        dir
    }

    /// A fake CLI that models exactly what `ensure_collector` asks a container.
    ///
    /// `stage_dir` holds one marker per path the container is *supposed* to have, so
    /// `exec … capabilities` answers yes only for a path that was actually copied in — the same
    /// signal the real probe gets from the binary running. Every `cp` is logged, which is how the
    /// tests prove a warm container is not copied into twice.
    fn staging_cli(name: &str, architecture: &str, stage_dir: &Path, log: &Path) -> PathBuf {
        let glibc_failure = if name == "musl-fallback" {
            "case \\\"$3\\\" in *linux-x64-*) echo 'No such file or directory' >&2; exit 127 ;; esac;"
        } else {
            ""
        };
        let body = format!(
            "#!/bin/sh\n\
             case \"$1\" in\n\
               inspect) echo sha256:image; exit 0 ;;\n\
               image) echo 'linux|{architecture}'; exit 0 ;;\n\
               exec)\n\
                 marker=\"{stage}/$(echo \"$3\" | tr '/' '_')\"\n\
                 [ -f \"$marker\" ] || {{ echo 'no such file or directory' >&2; exit 1; }}\n\
                 if [ \"$4\" = version ]; then {glibc_failure} sha256sum \"$marker\" | cut -d' ' -f1; exit 0; fi\n\
                 if [ \"$4\" = cleanup ]; then for file in '{stage}'/*; do case \"$file\" in *memoryspy-collector-linux-x64-*) [ \"$file\" = \"$marker\" ] || rm -f \"$file\" ;; esac; done; exit 0; fi\n\
                 exit 0 ;;\n\
               cp)\n\
                 echo \"$2|$3\" >> '{log}'\n\
                 path=$(echo \"$3\" | cut -d: -f2-)\n\
                 marker=\"{stage}/$(echo \"$path\" | tr '/' '_')\"\n\
                 cp \"$2\" \"$marker\"\n\
                 exit 0 ;;\n\
             esac\n\
             exit 1\n",
            architecture = architecture,
            stage = stage_dir.display(),
            log = log.display(),
        );
        fake_cli(name, &body)
    }

    /// The first attach copies an 80 MB binary, so every later one must not.
    #[test]
    fn a_warm_container_reuses_the_collector_of_this_build() {
        let dir = staging_area("warm");
        let stage = dir.join("stage");
        std::fs::create_dir_all(&stage).expect("the fake container's staging dir");
        let log = dir.join("calls.log");
        let docker = staging_cli("warm", "amd64", &stage, &log);

        let binary = dir.join("MemorySpy.Collector");
        std::fs::write(&binary, b"collector build one").expect("the local collector");

        let first = stage_collector(docker.to_str().unwrap(), "svc", "linux-x64", &binary)
            .expect("the first attach must stage the collector");
        assert!(
            first
                .path
                .starts_with("/tmp/memoryspy-collector-linux-x64-"),
            "staging path should include the RID and content hash: {}",
            first.path
        );

        let calls = std::fs::read_to_string(&log).expect("the fake CLI must log its calls");
        assert_eq!(
            calls.lines().count(),
            1,
            "the first attach must copy once: {calls}"
        );
        assert!(
            calls.contains(&format!("svc:{}", first.path)),
            "the collector was not copied to {}: {calls}",
            first.path
        );

        let second = stage_collector(docker.to_str().unwrap(), "svc", "linux-x64", &binary)
            .expect("a warm container must be usable");
        assert_eq!(second.path, first.path);
        assert_eq!(
            std::fs::read_to_string(&log).unwrap().lines().count(),
            1,
            "a warm container was copied into again instead of reusing the staged build"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A rebuild gets a new content address; after staging, obsolete copies are pruned.
    #[test]
    fn a_rebuilt_collector_replaces_the_one_already_staged() {
        let dir = staging_area("rebuilt");
        let stage = dir.join("stage");
        std::fs::create_dir_all(&stage).expect("the fake container's staging dir");
        let log = dir.join("calls.log");
        let docker = staging_cli("rebuilt", "amd64", &stage, &log);

        let binary = dir.join("MemorySpy.Collector");
        std::fs::write(&binary, b"collector build one").expect("the first local collector");
        let first = stage_collector(docker.to_str().unwrap(), "svc", "linux-x64", &binary)
            .expect("the first build must stage");

        std::fs::write(&binary, b"collector build two, a different length")
            .expect("the rebuilt local collector");
        let second = stage_collector(docker.to_str().unwrap(), "svc", "linux-x64", &binary)
            .expect("the rebuilt collector must stage");

        assert_ne!(
            first.path, second.path,
            "different collector contents must never alias an active staged executable"
        );

        let calls = std::fs::read_to_string(&log).unwrap();
        assert_eq!(
            calls.lines().count(),
            2,
            "the rebuilt collector was not copied to its content-addressed path: {calls}"
        );
        let staged_files = std::fs::read_dir(&stage)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| {
                name.to_string_lossy()
                    .contains("memoryspy-collector-linux-x64-")
            })
            .count();
        assert_eq!(
            staged_files, 1,
            "obsolete staged copies were not pruned after a rebuild"
        );
        assert!(
            calls
                .lines()
                .last()
                .is_some_and(|line| line.contains(&format!("svc:{}", second.path))),
            "the last copy did not target the new staged path: {calls}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A musl-only image tries the glibc binary first, then succeeds with the musl binary.
    #[test]
    fn glibc_collector_failure_falls_back_to_a_published_musl_binary() {
        let dir = staging_area("musl-fallback");
        let stage = dir.join("stage");
        std::fs::create_dir_all(&stage).expect("the fake container's staging dir");
        let log = dir.join("calls.log");
        let docker = staging_cli("musl-fallback", "amd64", &stage, &log);
        let glibc = dir.join("glibc-collector");
        let musl = dir.join("musl-collector");
        std::fs::write(&glibc, b"glibc executable").expect("the glibc collector");
        std::fs::write(&musl, b"musl executable").expect("the musl collector");

        let target = parse_image_target("svc", "linux|amd64").unwrap();
        let staged = stage_collector_with_binaries(
            docker.to_str().unwrap(),
            "svc",
            target,
            &[("linux-x64", &glibc), ("linux-musl-x64", &musl)],
        )
        .expect("a published musl binary must be tried after glibc cannot start");
        assert!(staged.path.contains("linux-musl-x64-"));
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The image OS and architecture are validated before choosing any collector.
    #[test]
    fn image_os_and_architecture_must_be_supported() {
        let windows = parse_image_target("svc", "windows|amd64")
            .expect_err("a Windows image must not select a Linux collector");
        assert!(windows.contains("windows"));

        let unsupported_arch = parse_image_target("svc", "linux|s390x")
            .expect_err("an unsupported architecture must not select a collector");
        assert!(unsupported_arch.contains("s390x"));

        assert_eq!(
            parse_image_target("svc", "linux|amd64").unwrap().glibc_rid,
            "linux-x64"
        );
        assert_eq!(
            parse_image_target("svc", "linux|arm64").unwrap().musl_rid,
            "linux-musl-arm64"
        );
        assert!(is_libc_mismatch(
            "exec /tmp/collector: no such file or directory"
        ));
        assert!(is_libc_mismatch(
            "Error loading shared library libc.musl-aarch64.so.1"
        ));
        assert!(!is_libc_mismatch("permission denied"));
    }

    /// A read-only root filesystem is the most common reason a copy fails, and the CLI's own text
    /// is what makes the message actionable.
    #[test]
    fn a_container_that_cannot_be_written_to_explains_the_copy_failure() {
        let dir = staging_area("readonly");
        let binary = dir.join("MemorySpy.Collector");
        std::fs::write(&binary, b"collector").expect("the local collector");

        let script = fake_cli(
            "readonly",
            "#!/bin/sh\n\
             case \"$1\" in\n\
               exec) exit 1 ;;\n\
               cp) echo 'read-only file system' >&2; exit 1 ;;\n\
             esac\n\
             exit 1\n",
        );

        let error = stage_collector(script.to_str().unwrap(), "svc", "linux-x64", &binary)
            .expect_err("a copy into a read-only filesystem must not be reported as staged");
        assert!(
            error.contains("Could not copy the collector into svc"),
            "the message does not say what failed: {error}"
        );
        assert!(
            error.contains("read-only file system"),
            "the CLI's own reason was lost: {error}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file that lands but cannot execute (wrong architecture, `noexec` /tmp) used to surface as
    /// a session that produced nothing, so the probe after the copy is part of the contract.
    #[test]
    fn a_copied_collector_that_does_not_run_is_reported() {
        let dir = staging_area("unrunnable");
        let binary = dir.join("MemorySpy.Collector");
        std::fs::write(&binary, b"collector").expect("the local collector");

        let script = fake_cli(
            "unrunnable",
            "#!/bin/sh\n\
             case \"$1\" in\n\
               exec) echo 'exec format error' >&2; exit 126 ;;\n\
               cp) exit 0 ;;\n\
             esac\n\
             exit 1\n",
        );

        let error = stage_collector(script.to_str().unwrap(), "svc", "linux-x64", &binary)
            .expect_err("a copied binary that cannot run must not be reported as staged");
        assert!(
            error.contains("does not run there"),
            "the message does not say the copy is unusable: {error}"
        );
        assert!(
            error.contains("exec format error"),
            "the probe's own reason was lost: {error}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The happy path of the copy-out, which is only interesting against a fake CLI because the
    /// real one needs a container to copy *from*.
    #[test]
    fn a_working_copy_out_lands_the_capture() {
        let dir = staging_area("copy-out");
        let local = dir.join("capture-1.nettrace");

        let script = fake_cli(
            "copy-out-ok",
            "#!/bin/sh\n\
             case \"$1\" in\n\
               cp) echo trace-bytes > \"$3\"; exit 0 ;;\n\
             esac\n\
             exit 1\n",
        );

        copy_out_with(
            script.to_str().unwrap(),
            "svc",
            "/tmp/capture-1.nettrace",
            &local,
        )
        .expect("a successful copy must land the file");
        assert_eq!(
            std::fs::read_to_string(&local).expect("the copied file"),
            "trace-bytes\n"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A killed or failed `docker cp` can leave a partial file; keeping it would make the host
    /// announce a capture nothing can open, while the real artifact is still in the container.
    #[test]
    fn a_failed_copy_out_does_not_leave_a_partial_capture() {
        let dir = staging_area("copy-out-fail");
        let local = dir.join("capture-1.nettrace");
        std::fs::write(&local, b"partial").expect("a partial copy to clean up");

        let script = fake_cli(
            "copy-out-fail",
            "#!/bin/sh\n\
             case \"$1\" in\n\
               cp) echo partial > \"$3\"; echo 'no space left on device' >&2; exit 1 ;;\n\
             esac\n\
             exit 1\n",
        );

        let error = copy_out_with(
            script.to_str().unwrap(),
            "svc",
            "/tmp/capture-1.nettrace",
            &local,
        )
        .expect_err("a failed copy must not be reported as success");
        assert!(
            error.contains("no space left on device"),
            "the CLI's own reason was lost: {error}"
        );
        assert!(
            !local.exists(),
            "the partial capture was left behind at {}",
            local.display()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The case the rail has to explain: Docker is installed, the daemon is not running.
    ///
    /// The distinction matters because the alternative — treating it as "no Docker here" — is
    /// what made the section disappear with no explanation at all.
    #[test]
    fn a_stopped_daemon_is_reported_as_unreachable() {
        let script = fake_cli(
            "stopped",
            "#!/bin/sh\n\
             case \"$1\" in\n\
               --version) echo 'Docker version 29.8.1, build test'; exit 0 ;;\n\
               version) echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2; exit 1 ;;\n\
             esac\n\
             exit 1\n",
        );
        let status = status_with(script.to_str().unwrap());

        assert!(!status.available);
        assert_eq!(status.problem, Some(DockerProblem::DaemonUnreachable));
        let error = status
            .error
            .expect("the daemon's own message must reach the UI");
        assert!(
            error.contains("Cannot connect to the Docker daemon"),
            "the daemon message was lost: {error}"
        );

        let _ = std::fs::remove_dir_all(script.parent().unwrap());
    }

    /// A machine without Docker must not be told that its daemon is broken.
    #[test]
    fn a_missing_cli_is_not_reported_as_a_daemon_problem() {
        let status = status_with("/nonexistent/memoryspy-docker-cli");

        assert!(!status.available);
        assert_eq!(status.problem, Some(DockerProblem::CliMissing));
    }

    #[test]
    fn a_reachable_daemon_reports_its_version() {
        let script = fake_cli(
            "ready",
            "#!/bin/sh\n\
             if [ \"$1\" = \"--version\" ]; then echo 'Docker version 29.8.1, build test'; exit 0; fi\n\
             echo 29.8.1\n\
             exit 0\n",
        );
        let status = status_with(script.to_str().unwrap());

        assert!(
            status.available,
            "a working daemon must be reported as available"
        );
        assert_eq!(status.version.as_deref(), Some("29.8.1"));
        assert_eq!(status.problem, None);

        let _ = std::fs::remove_dir_all(script.parent().unwrap());
    }
}
