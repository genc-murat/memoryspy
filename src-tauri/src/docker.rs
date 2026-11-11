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

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
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

/// The deadline for measuring or pruning one container's `/tmp`.
///
/// Shorter than [`CLI_TIMEOUT`] on purpose: this is an optional measurement of files that already
/// live inside the daemon, and the view that asks for it must not hold a spinner while one
/// unresponsive container waits out the deadline for an 80 MB copy.
const STAGING_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a `docker cp` may take.
///
/// Longer than [`CLI_TIMEOUT`] on purpose: a deep capture is capped at 256 MB and is copied out
/// of the container after the collector exits, and a slow (especially virtualised) filesystem can
/// make that take minutes. The deadline still exists — a wedged daemon must not hold the session
/// forever — but it is sized for the artifact rather than for a version probe.
const COPY_TIMEOUT: Duration = Duration::from_secs(600);

/// How often a running call is checked for completion.
const CLI_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// How long extracting the musl C++ runtime may take.
///
/// Much longer than a copy into a container on purpose: the first repair pulls
/// [`MUSL_RUNTIME_IMAGE`] — a few hundred megabytes — over the user's connection. The deadline
/// still exists so a stuck pull cannot hold the repair button in a permanent "repairing" state.
const RUNTIME_TIMEOUT: Duration = Duration::from_secs(900);

/// The image whose C++ runtime a musl collector runs against.
///
/// It must be the same image the publisher uses: the libraries are extracted from the runtime
/// pack the collector is published for, so they stay version-aligned with the .NET host instead
/// of drifting with whatever Alpine is current. Change one, change the other.
const MUSL_RUNTIME_IMAGE: &str = "mcr.microsoft.com/dotnet/runtime-deps:10.0-alpine";

/// The pair of libraries the musl apphost and `libcoreclr.so` link against.
const MUSL_RUNTIME_LIBRARIES: [&str; 2] = ["libstdc++.so.6", "libgcc_s.so.1"];

/// Where extracted runtimes wait to be attached to a republished variant.
///
/// A repair that had to publish the build too has nowhere to put the already-extracted runtime:
/// the publisher is a developer script, and the packaged app has no `dotnet` to run it with. The
/// libraries are therefore cached by RID and copied beside the variant then. Holding the copy
/// instead of the container is what lets the app *reuse* what it extracted: the ~2.8 MB pair is
/// a file copy, while the image pull that produced it is not.
static RUNTIME_CACHE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

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

/// The libc a published collector is built against.
///
/// The publisher chooses it explicitly; the image only decides which build is used when a
/// container is attached. The diagnostics view names the choice instead of making the reader
/// parse the runtime identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CollectorLibc {
    Glibc,
    Musl,
}

/// One Linux build the app can copy into a container.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorVariant {
    pub rid: String,
    pub libc: CollectorLibc,
    pub published: bool,
    /// A published musl build with no `libs/` directory beside it.
    ///
    /// Bare Alpine images do not ship `libstdc++.so.6` or `libgcc_s.so.1`, so that build cannot
    /// start there. It may still work in a .NET Alpine image, which installs the runtime itself;
    /// the app cannot know which image will be targeted, so the gap is reported rather than
    /// treated as fatal.
    pub runtime_missing: bool,
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
    /// Every supported variant, published or not, for the container-support diagnostics view.
    /// Empty when `MEMORYSPY_DOCKER_COLLECTOR` replaces variant selection with one binary.
    pub collectors: Vec<CollectorVariant>,
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
    let (staged_rids, collectors) = collector_inventory();

    // `--version` is answered by the client alone and never contacts the daemon. It is therefore
    // the only way to tell "Docker is not installed" from "Docker is installed and stopped",
    // which is the difference between staying quiet and explaining the problem.
    if let Err(error) = invoke(program, &["--version"], STATUS_TIMEOUT) {
        return DockerStatus {
            available: false,
            version: None,
            staged_rids,
            collectors,
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
            collectors,
            error: None,
            problem: None,
        },
        Err(error) => DockerStatus {
            available: false,
            version: None,
            staged_rids,
            collectors,
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
    list_containers_with(&cli())
}

fn list_containers_with(program: &str) -> Result<Vec<DockerContainer>, String> {
    // Tab separated fields, one container per line: the default table format wraps long image
    // names and would need a fragile column heuristic to parse back.
    let output = invoke(
        program,
        &[
            "ps",
            "--no-trunc",
            "--format",
            "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
        ],
        CLI_TIMEOUT,
    )?;

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
// Disk used by staged builds
// ---------------------------------------------------------------------------------------

/// One MemorySpy artifact left in a container's `/tmp` by an attach.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedCopy {
    /// Absolute path inside the container.
    pub path: String,
    /// `binary` for the executable, `runtime` for the musl C++ library directory.
    pub kind: StagedCopyKind,
    /// Disk usage as `du` reports it, i.e. allocated blocks rather than apparent size.
    pub bytes: u64,
    /// How long ago the copy was written. `None` when the image's tooling could not report it.
    pub age_seconds: Option<u64>,
    /// Content identity shared by an executable and its runtime directory.
    pub identity: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StagedCopyKind {
    Binary,
    Runtime,
}

/// What one running container holds, and what pruning it would free.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStaging {
    pub container: String,
    pub image: String,
    /// Bytes in every recognized staged copy.
    pub total_bytes: u64,
    /// Bytes a prune would remove: everything except the newest build. Shown on the button,
    /// because "Prune" alone gives no idea whether it is worth a click.
    pub prunable_bytes: u64,
    pub copies: Vec<StagedCopy>,
    /// Set when this container could not be measured, with the CLI's own wording. One
    /// unmeasurable container (an image with no shell) must not fail the whole list.
    pub error: Option<String>,
}

/// Lists `/tmp` entries in the container and reports each one's allocated size and mtime.
///
/// A shell is used because there is no shell-free way to ask Docker for the size of files inside
/// a container: `docker diff` names changed paths without sizes and `docker cp` would stream the
/// ~85 MB binary back over the socket. Images built without a shell cannot be measured this way,
/// which is reported per container rather than hidden.
///
/// `stat -c` and `date -r` are both tried because BusyBox and coreutils do not agree on either
/// spelling. A `0` mtime means neither worked; the host then reports an unknown age instead of
/// inventing one.
const STAGING_PROBE: &str = r#"cd /tmp 2>/dev/null || exit 0
for path in memoryspy-collector-*; do
  [ -e "$path" ] || continue
  size=$(du -sk "$path" 2>/dev/null | cut -f 1)
  [ -n "$size" ] || size=0
  mtime=$(stat -c %Y "$path" 2>/dev/null || date -r "$path" +%s 2>/dev/null || echo 0)
  printf '%s\t%s\t%s\n' "$path" "$size" "$mtime"
done
exit 0"#;

/// Measures the staged collector copies in every running container.
///
/// Failures are per container: a stopped daemon fails the call (there is nothing to list), while
/// a distroless container that cannot run `sh` is one row with an explanation.
pub fn staging_usage() -> Result<Vec<ContainerStaging>, String> {
    staging_usage_with(&cli())
}

fn staging_usage_with(program: &str) -> Result<Vec<ContainerStaging>, String> {
    let containers = list_containers_with(program)?;
    Ok(containers
        .iter()
        .map(|container| staging_for(program, container))
        .collect())
}

/// Removes every staged build in `container` except the newest one, then measures again.
///
/// The newest build is kept because that is the pair a warm attach reuses, and because a copy
/// that was staged moments ago may be about to be executed by another attach. Older builds are
/// rebuild leftovers by definition: the staged path is content-addressed, so a newer build is a
/// different path. Sessions already running are unaffected — Linux keeps mapped files alive
/// after their names are unlinked — and the next attach copies the current build if the kept one
/// is stale.
pub fn prune_staging(container: &str) -> Result<ContainerStaging, String> {
    prune_staging_with(&cli(), container)
}

fn prune_staging_with(program: &str, container: &str) -> Result<ContainerStaging, String> {
    let containers = list_containers_with(program)?;
    let target = containers
        .iter()
        .find(|candidate| candidate.name == container || candidate.id == container)
        .ok_or_else(|| {
            format!("{container} is not running any more, so there is nothing to prune.")
        })?;

    let before = staging_for(program, target);
    if let Some(error) = &before.error {
        return Err(error.clone());
    }

    let Some(keep) = newest_identity(&before.copies) else {
        return Ok(before);
    };

    // Paths are rebuilt from the validated basename instead of copied out of the probe, so a
    // doctored `/tmp` entry cannot turn `rm` into a path traversal.
    let mut arguments = vec![
        "exec".to_string(),
        target.name.clone(),
        "rm".to_string(),
        "-rf".to_string(),
        "--".to_string(),
    ];
    arguments.extend(
        before
            .copies
            .iter()
            .filter(|copy| copy.identity != keep)
            .map(|copy| copy.path.clone()),
    );

    if arguments.len() == 5 {
        return Ok(before);
    }

    let references: Vec<&str> = arguments.iter().map(String::as_str).collect();
    invoke(program, &references, STAGING_TIMEOUT).map_err(|error| {
        format!(
            "Could not remove the old staged builds in {}: {error}",
            target.name
        )
    })?;

    Ok(staging_for(program, target))
}

fn staging_for(program: &str, container: &DockerContainer) -> ContainerStaging {
    let measured = invoke(
        program,
        &["exec", container.name.as_str(), "sh", "-c", STAGING_PROBE],
        STAGING_TIMEOUT,
    );

    let copies = match measured {
        Ok(output) => parse_staged_copies(&output),
        Err(error) => {
            return ContainerStaging {
                container: container.name.clone(),
                image: container.image.clone(),
                total_bytes: 0,
                prunable_bytes: 0,
                copies: Vec::new(),
                error: Some(error),
            }
        }
    };

    let total_bytes = copies
        .iter()
        .fold(0_u64, |sum, copy| sum.saturating_add(copy.bytes));
    let prunable_bytes = newest_identity(&copies)
        .map(|keep| {
            copies
                .iter()
                .filter(|copy| copy.identity != keep)
                .fold(0_u64, |sum, copy| sum.saturating_add(copy.bytes))
        })
        .unwrap_or(0);

    ContainerStaging {
        container: container.name.clone(),
        image: container.image.clone(),
        total_bytes,
        prunable_bytes,
        copies,
        error: None,
    }
}

/// Parses the probe's `name<TAB>kibibytes<TAB>mtime` lines, dropping anything that is not a
/// staged collector this app wrote.
fn parse_staged_copies(output: &str) -> Vec<StagedCopy> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);

    let mut copies: Vec<StagedCopy> = output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let name = fields.next()?.trim();
            let kibibytes = fields.next()?.trim().parse::<u64>().ok()?;
            let mtime = fields.next()?.trim().parse::<u64>().unwrap_or(0);
            let (kind, identity) = parse_staged_name(name)?;

            Some(StagedCopy {
                path: format!("/tmp/{name}"),
                kind,
                bytes: kibibytes.saturating_mul(1024),
                age_seconds: (mtime != 0).then(|| now.saturating_sub(mtime)),
                identity,
            })
        })
        .collect();

    copies.sort_by(|left, right| left.path.cmp(&right.path));
    copies
}

/// Recognizes `memoryspy-collector[-libs]-<rid>-<64 hex digits>` and returns its kind and
/// identity. Anything else belongs to something else and is neither reported nor removed.
fn parse_staged_name(name: &str) -> Option<(StagedCopyKind, String)> {
    let (rest, kind) = if let Some(rest) = name.strip_prefix("memoryspy-collector-libs-") {
        (rest, StagedCopyKind::Runtime)
    } else {
        (
            name.strip_prefix("memoryspy-collector-")?,
            StagedCopyKind::Binary,
        )
    };

    let (rid, identity) = rest.rsplit_once('-')?;
    let valid_rid = !rid.is_empty()
        && rid
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-');
    let valid_identity = identity.len() == 64 && identity.chars().all(|c| c.is_ascii_hexdigit());

    (valid_rid && valid_identity).then(|| (kind, identity.to_string()))
}

/// The identity to keep: the newest copy, as the build a warm attach can reuse.
///
/// Copies whose age is unknown sort last. A tie is broken by the identity so the answer is
/// deterministic instead of depending on directory order.
fn newest_identity(copies: &[StagedCopy]) -> Option<String> {
    copies
        .iter()
        .min_by(|left, right| {
            left.age_seconds
                .unwrap_or(u64::MAX)
                .cmp(&right.age_seconds.unwrap_or(u64::MAX))
                .then_with(|| right.identity.cmp(&left.identity))
        })
        .map(|copy| copy.identity.clone())
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
    /// Directory inside the container that holds the C++ runtime the musl build needs.
    ///
    /// A self-contained .NET executable is only self-contained with respect to .NET: on musl the
    /// apphost and `libcoreclr.so` link against `libstdc++.so.6` and `libgcc_s.so.1`, which a bare
    /// Alpine image does not have. They are published beside the collector and staged here; images
    /// that already provide them simply find their own copies first.
    pub library_path: Option<String>,
}

impl StagedCollector {
    /// The `docker exec` arguments that start this collector in `container`.
    ///
    /// One place builds the command so the probe, the process listing and a live session cannot
    /// drift in how they pass the runtime library path.
    pub fn exec_arguments(&self, container: &str, interactive: bool) -> Vec<String> {
        exec_arguments(
            container,
            &self.path,
            self.library_path.as_deref(),
            interactive,
        )
    }
}

/// `docker exec` arguments for a collector at `path`.
///
/// `LD_LIBRARY_PATH` rather than `LD_PRELOAD`: musl resolves the executable's `DT_NEEDED` entries
/// before it loads preloaded objects, so a preloaded `libstdc++` cannot satisfy the apphost that
/// needs it. A library path is searched while those entries are resolved.
fn exec_arguments(
    container: &str,
    path: &str,
    library_path: Option<&str>,
    interactive: bool,
) -> Vec<String> {
    let mut arguments = vec!["exec".to_string()];
    if interactive {
        arguments.push("-i".to_string());
    }
    if let Some(library_path) = library_path {
        arguments.push("-e".to_string());
        arguments.push(format!("LD_LIBRARY_PATH={library_path}"));
    }
    arguments.push(container.to_string());
    arguments.push(path.to_string());
    arguments
}

/// A runtime library pair is only useful when both files are present.
fn has_musl_runtime(directory: &Path) -> bool {
    directory.join("libstdc++.so.6").is_file() && directory.join("libgcc_s.so.1").is_file()
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

/// The C++ runtime published beside a musl collector, if it is there.
///
/// Only musl builds need it, and a missing directory is not an error: the image may provide the
/// libraries itself (every .NET Alpine image does), in which case the collector runs unaided.
///
/// The lookup is anchored to the binary that will actually be staged. Searching the candidates
/// independently could pair a runtime from one build with a binary from another, which would make
/// the diagnostics claim a stale packaged collector was ready when its own `libs/` was gone.
fn staged_libraries(rid: &str) -> Option<PathBuf> {
    if !rid.contains("musl") {
        return None;
    }

    let binary = staged_binary(rid)?;
    let libraries = binary.parent()?.join("libs");
    runtime_matches(&libraries, &binary).then_some(libraries)
}

/// Whether `directory` holds a complete runtime that belongs to `binary`.
///
/// A directory with no identity marker was written by the publisher, which replaces the binary and
/// the libraries together, so presence is enough. A marked directory was written by a repair, and
/// the marker is the only thing that can tell whether the binary beside it is still the build the
/// libraries came from — republishing over a repaired variant leaves both in place.
fn runtime_matches(directory: &Path, binary: &Path) -> bool {
    if !has_musl_runtime(directory) {
        return false;
    }

    let Ok(recorded) = std::fs::read_to_string(directory.join(RUNTIME_IDENTITY)) else {
        return true;
    };
    file_identity(binary).is_ok_and(|current| recorded.trim() == current)
}

/// The RIDs that have a published collector, so the UI can say what is missing.
pub fn staged_rids() -> Vec<String> {
    collector_inventory().0
}

/// Every supported build plus the subset that is published.
///
/// The two answers are computed together so the rail and the diagnostics view cannot disagree
/// about which variants exist.
fn collector_inventory() -> (Vec<String>, Vec<CollectorVariant>) {
    if std::env::var_os("MEMORYSPY_DOCKER_COLLECTOR").is_some() {
        // The override makes the binary's own architecture irrelevant to the answer, and a table
        // of per-RID publication states would describe files the app is not going to use.
        return (vec!["override".to_string()], Vec::new());
    }

    let variants = collector_variants_with(|rid| staged_binary(rid).is_some(), runtime_present);
    let staged = variants
        .iter()
        .filter(|variant| variant.published)
        .map(|variant| variant.rid.clone())
        .collect();
    (staged, variants)
}

/// The four builds the publisher can produce, in the order the rail lists them.
const COLLECTOR_VARIANTS: [(&str, CollectorLibc); 4] = [
    ("linux-arm64", CollectorLibc::Glibc),
    ("linux-x64", CollectorLibc::Glibc),
    ("linux-musl-arm64", CollectorLibc::Musl),
    ("linux-musl-x64", CollectorLibc::Musl),
];

/// Builds the diagnostics table from two lookups, so every published/missing combination can be
/// exercised without touching the real resources directory.
fn collector_variants_with(
    published: impl Fn(&str) -> bool,
    has_runtime: impl Fn(&str) -> bool,
) -> Vec<CollectorVariant> {
    COLLECTOR_VARIANTS
        .into_iter()
        .map(|(rid, libc)| {
            let published = published(rid);
            CollectorVariant {
                rid: rid.to_string(),
                libc,
                published,
                runtime_missing: published && libc == CollectorLibc::Musl && !has_runtime(rid),
            }
        })
        .collect()
}

/// Whether a published musl build can find its C++ runtime where it will run.
///
/// Either the publisher bundled it beside the variant, or a repair extracted it into the cache and
/// the variant has not been republished since. The binary's own directory is checked first because
/// that is what `LD_LIBRARY_PATH` points at — and because a rebuilt binary would otherwise be
/// paired with libraries copied for the build it replaced.
fn runtime_present(rid: &str) -> bool {
    cached_runtime(rid).is_some() || staged_libraries(rid).is_some()
}

/// The runtime a repair extracted for `rid`, if one was and the variant is still that build.
fn cached_runtime(rid: &str) -> Option<PathBuf> {
    cached_runtime_with(
        cached_runtime_dir(rid).as_deref(),
        staged_binary(rid).as_deref(),
    )
}

/// Where a repair cached `rid`'s runtime, whether or not it still applies.
fn cached_runtime_dir(rid: &str) -> Option<PathBuf> {
    RUNTIME_CACHE.get()?.lock().ok()?.get(rid).cloned()
}

/// The pairing rule: a cached runtime is usable only for the binary it was extracted for.
///
/// Republishing replaces the binary under the same RID, so the cache is only good for the build
/// it was extracted for. The recorded identity is the binary's content hash; a different or
/// missing binary means the libraries may be older than the host that will load them, and a
/// directory with no marker was never written by a repair.
fn cached_runtime_with(directory: Option<&Path>, binary: Option<&Path>) -> Option<PathBuf> {
    let directory = directory?;
    let binary = binary?;
    if !has_musl_runtime(directory) {
        return None;
    }
    let recorded = std::fs::read_to_string(directory.join(RUNTIME_IDENTITY)).ok()?;
    let current = file_identity(binary).ok()?;
    (recorded.trim() == current).then(|| directory.to_path_buf())
}

/// The file that ties a cached runtime to the collector binary it was extracted for.
const RUNTIME_IDENTITY: &str = "collector-identity";

/// The repaired build's cache directory: a stable path, so a restart keeps what was extracted.
///
/// `root` is the app's data directory; the RID is part of the name so two architectures on one
/// machine cannot overwrite each other's libraries.
fn runtime_cache_dir(root: &Path, rid: &str) -> PathBuf {
    root.join("collector-runtime").join(rid)
}

/// Adopts runtimes extracted by an earlier run of the app.
///
/// Called once at startup. A cached runtime whose binary has since changed is ignored by
/// [`cached_runtime`] rather than deleted: the publisher may still be pointing the build it was
/// extracted for somewhere the app is not looking right now.
pub fn restore_runtime_cache(root: &Path) {
    let cache = RUNTIME_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut cache) = cache.lock() else {
        return;
    };

    for (rid, _) in COLLECTOR_VARIANTS {
        if !rid.contains("musl") {
            continue;
        }
        let directory = runtime_cache_dir(root, rid);
        if directory.is_dir() {
            cache.insert(rid.to_string(), directory);
        }
    }
}

/// A repair the environment or the artifacts make impossible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepairProblem {
    /// No Docker daemon, so the runtime image cannot be pulled.
    DockerUnavailable,
    /// A glibc build has no musl runtime to repair.
    NotMusl,
    /// Nothing was published for this RID, and the app cannot build one.
    NotPublished,
    /// `MEMORYSPY_DOCKER_COLLECTOR` replaces variant selection with one binary.
    OverrideActive,
}

/// What a repair needs before it can start, answered without touching the network.
///
/// The UI asks this rather than reasoning about the variant table itself: the rule (musl only,
/// published, daemon reachable) is part of the repair and lives next to it.
pub fn repair_blocker(rid: &str) -> Option<RepairProblem> {
    if std::env::var_os("MEMORYSPY_DOCKER_COLLECTOR").is_some() {
        return Some(RepairProblem::OverrideActive);
    }
    let Some((_, libc)) = COLLECTOR_VARIANTS.iter().find(|(known, _)| *known == rid) else {
        return Some(RepairProblem::NotPublished);
    };
    if staged_binary(rid).is_none() {
        return Some(RepairProblem::NotPublished);
    }
    if *libc != CollectorLibc::Musl {
        return Some(RepairProblem::NotMusl);
    }
    if status().available {
        None
    } else {
        Some(RepairProblem::DockerUnavailable)
    }
}

/// Makes a published musl build startable again by bundling its C++ runtime.
///
/// Two situations look the same in the variant table and are fixed differently:
///
/// * The binary exists but the publisher never bundled `libs/` (an old publish, or a script run
///   without a daemon). The runtime is extracted from [`MUSL_RUNTIME_IMAGE`] and copied beside the
///   binary, which is exactly the layout the publisher writes.
/// * The runtime is gone from a binary the app itself published and cached earlier (the resources
///   directory was rebuilt). Nothing to pull: the cached pair is copied back and re-attached.
///
/// A missing *binary* is refused rather than repaired. Republishing it needs `dotnet` and the
/// repository, which an installed app does not have; pretending otherwise would turn a clear
/// "publish it in your checkout" into a failed download.
pub fn repair_variant(rid: &str, root: &Path) -> Result<CollectorVariant, String> {
    if let Some(problem) = repair_blocker(rid) {
        return Err(repair_problem_message(problem, rid));
    }

    let binary = staged_binary(rid)
        .ok_or_else(|| repair_problem_message(RepairProblem::NotPublished, rid))?;

    repair_with(&cli(), rid, &binary, root)?;
    variant_for(rid)
}

/// The repair itself, with the CLI, the binary and the cache root handed in.
///
/// Split from [`repair_variant`] so the whole flow — reuse, extraction, the copy beside the
/// binary, and the identity that ties them — can be exercised against a fake CLI without a
/// daemon and without touching the resources directory a packaged app would ship.
///
/// Returns the directory the runtime was taken from: the cache when one applied, otherwise the
/// freshly extracted copy.
fn repair_with(program: &str, rid: &str, binary: &Path, root: &Path) -> Result<PathBuf, String> {
    let directory = binary
        .parent()
        .ok_or_else(|| format!("The {rid} collector has no parent directory to publish into."))?
        .to_path_buf();
    let libraries = directory.join("libs");

    if runtime_matches(&libraries, binary) {
        // Already whole: the table said otherwise when the page was loaded, so report the state
        // instead of extracting a runtime that nobody needs.
        return Ok(libraries);
    }

    let cache = RUNTIME_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let cached = cache.lock().ok().and_then(|cache| cache.get(rid).cloned());
    // A cached runtime is reused only for the build it was extracted for; a republished binary
    // sends the repair back to the image, which is what keeps the libraries version-aligned.
    let extracted = match cached_runtime_with(cached.as_deref(), Some(binary)) {
        Some(cached) => cached,
        None => extract_runtime(program, rid, binary, &runtime_cache_dir(root, rid))?,
    };

    copy_runtime(&extracted, &libraries)?;

    if let Ok(mut cache) = cache.lock() {
        cache.insert(rid.to_string(), extracted.clone());
    }

    Ok(extracted)
}

/// The variant row for `rid` after a repair, so the UI can render what actually happened.
fn variant_for(rid: &str) -> Result<CollectorVariant, String> {
    collector_variants_with(
        |candidate| staged_binary(candidate).is_some(),
        runtime_present,
    )
    .into_iter()
    .find(|variant| variant.rid == rid)
    .ok_or_else(|| format!("'{rid}' is not a collector variant this app knows about."))
}

fn repair_problem_message(problem: RepairProblem, rid: &str) -> String {
    match problem {
        RepairProblem::DockerUnavailable => format!(
            "Repairing {rid} means extracting its C++ runtime from {MUSL_RUNTIME_IMAGE}, which \
             needs a reachable Docker daemon. Start Docker, then try again."
        ),
        RepairProblem::NotMusl => format!(
            "{rid} is a glibc build; only musl builds have a separate C++ runtime to bundle."
        ),
        RepairProblem::NotPublished => format!(
            "No {rid} collector has been published, so there is nothing to repair. Publish it \
             first with `npm run collector:docker -- {rid} musl`."
        ),
        RepairProblem::OverrideActive => format!(
            "MEMORYSPY_DOCKER_COLLECTOR is set, so {rid} is not the binary this app uses; its \
             runtime is not something the app can repair."
        ),
    }
}

/// Pulls the C++ runtime out of the .NET Alpine runtime image into `destination`.
///
/// `readlink -f` first, because `libstdc++.so.6` is a symlink in that image and `docker cp`
/// copies the link rather than its target. The container is created rather than run: nothing has
/// to execute to copy a file out, and a created container also works where the image's entrypoint
/// would not.
fn extract_runtime(
    program: &str,
    rid: &str,
    binary: &Path,
    destination: &Path,
) -> Result<PathBuf, String> {
    let platform = if rid.ends_with("arm64") {
        "linux/arm64"
    } else {
        "linux/amd64"
    };
    let container = format!("memoryspy-collector-libs-{}-{}", std::process::id(), rid);
    let _ = invoke(program, &["rm", "-f", &container], CLI_TIMEOUT);

    // A half-extracted directory must not be mistaken for a usable one: `has_musl_runtime` needs
    // both files, but an old pair would survive a failed refresh and be copied as if it were new.
    let _ = std::fs::remove_dir_all(destination);
    std::fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Could not create the runtime cache at {}: {error}",
            destination.display()
        )
    })?;

    let extraction = (|| {
        let libstdcxx = invoke(
            program,
            &[
                "run",
                "--rm",
                "--platform",
                platform,
                "--entrypoint",
                "sh",
                MUSL_RUNTIME_IMAGE,
                "-c",
                "readlink -f /usr/lib/libstdc++.so.6",
            ],
            RUNTIME_TIMEOUT,
        )?;
        let libstdcxx = libstdcxx.trim();
        if libstdcxx.is_empty() {
            return Err(format!(
                "{MUSL_RUNTIME_IMAGE} did not report where libstdc++.so.6 lives."
            ));
        }

        invoke(
            program,
            &[
                "create",
                "--name",
                &container,
                "--platform",
                platform,
                MUSL_RUNTIME_IMAGE,
            ],
            RUNTIME_TIMEOUT,
        )?;
        invoke(
            program,
            &[
                "cp",
                &format!("{container}:{libstdcxx}"),
                &destination.join("libstdc++.so.6").to_string_lossy(),
            ],
            RUNTIME_TIMEOUT,
        )?;
        invoke(
            program,
            &[
                "cp",
                &format!("{container}:/usr/lib/libgcc_s.so.1"),
                &destination.join("libgcc_s.so.1").to_string_lossy(),
            ],
            RUNTIME_TIMEOUT,
        )?;

        if has_musl_runtime(destination) {
            Ok(())
        } else {
            Err(format!(
                "{MUSL_RUNTIME_IMAGE} did not yield both {} and {}.",
                MUSL_RUNTIME_LIBRARIES[0], MUSL_RUNTIME_LIBRARIES[1]
            ))
        }
    })();

    let _ = invoke(program, &["rm", "-f", &container], CLI_TIMEOUT);

    if let Err(error) = extraction {
        // The half-filled directory is worse than none: the next attempt would copy whatever was
        // there before failing, and the diagnostics would call it a runtime.
        let _ = std::fs::remove_dir_all(destination);
        return Err(format!(
            "Could not extract the musl C++ runtime for {rid} from {MUSL_RUNTIME_IMAGE}: {error}"
        ));
    }

    // Ties the cache to this exact binary, so a later rebuild cannot silently reuse libraries its
    // new .NET host was not built against.
    let identity = file_identity(binary)?;
    std::fs::write(destination.join(RUNTIME_IDENTITY), identity).map_err(|error| {
        format!(
            "Could not record the runtime's collector identity at {}: {error}",
            destination.display()
        )
    })?;

    Ok(destination.to_path_buf())
}

/// Copies the two libraries (and the identity that goes with them) into a variant directory.
fn copy_runtime(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Could not create {}: {error}. Is the app bundle read-only?",
            destination.display()
        )
    })?;

    for name in MUSL_RUNTIME_LIBRARIES {
        std::fs::copy(source.join(name), destination.join(name)).map_err(|error| {
            format!(
                "Could not write {}: {error}",
                destination.join(name).display()
            )
        })?;
    }

    // The identity travels too: a runtime copied beside a binary is bundled by definition, and the
    // usual layout has no marker file, so a missing one simply means "bundled with the build".
    if let Ok(identity) = std::fs::read_to_string(source.join(RUNTIME_IDENTITY)) {
        let _ = std::fs::write(destination.join(RUNTIME_IDENTITY), identity);
    }

    if !has_musl_runtime(destination) {
        return Err(format!(
            "The runtime copy into {} is incomplete.",
            destination.display()
        ));
    }
    Ok(())
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
///
/// The image id is returned as well because the libc answer is cached by it: an image id is
/// content-addressed, so a rebuilt tag is a different id and cannot inherit a stale answer.
fn container_target(program: &str, container: &str) -> Result<(String, ContainerTarget), String> {
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
    let target = parse_image_target(container, &details)?;
    Ok((image_id.to_string(), target))
}

/// The musl dynamic loader for the image's architecture.
///
/// The loader is a regular file in Alpine (`libc.musl-*.so.1` is the symlink), which matters for
/// `docker cp` on hosts where creating a symlink needs extra privileges.
fn musl_loader(target: ContainerTarget) -> &'static str {
    if target.musl_rid.ends_with("arm64") {
        "/lib/ld-musl-aarch64.so.1"
    } else {
        "/lib/ld-musl-x86_64.so.1"
    }
}

/// Whether the daemon reports that error because the requested path is absent.
///
/// Docker's message for a missing source is specific, and matching only that keeps an unrelated
/// "no such file or directory" (a broken mount, a missing destination) from being cached as
/// "this image is glibc".
fn is_missing_path(error: &str) -> bool {
    error
        .to_ascii_lowercase()
        .contains("could not find the file")
}

/// Asks the image's filesystem whether it carries musl's loader.
///
/// `docker cp` rather than `docker exec`: a distroless image has no shell or `test`, and copying
/// one small file asks the daemon about the filesystem without running anything from the image.
/// A missing loader is the glibc answer, not an error; any other failure is `None` so the caller
/// falls back to trying both builds in the original order.
fn detect_musl(program: &str, container: &str, target: ContainerTarget) -> Option<bool> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    let source = format!("{container}:{}", musl_loader(target));
    let destination = std::env::temp_dir().join(format!(
        "memoryspy-libc-probe-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let destination_text = destination.to_string_lossy().into_owned();

    let result = invoke(program, &["cp", &source, &destination_text], CLI_TIMEOUT);
    let _ = std::fs::remove_file(&destination);

    match result {
        Ok(_) => Some(true),
        Err(error) if is_missing_path(&error) => Some(false),
        Err(_) => None,
    }
}

/// The image's libc, cached by image id.
///
/// Staging runs on every refresh of the container rail, so the one-time copy that answers this
/// question must not repeat. The answer is a property of the image, not of the container.
fn uses_musl(program: &str, container: &str, image: &str, target: ContainerTarget) -> Option<bool> {
    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    if let Some(known) = cache
        .lock()
        .ok()
        .and_then(|cache| cache.get(image).copied())
    {
        return Some(known);
    }

    let detected = detect_musl(program, container, target)?;
    if let Ok(mut cache) = cache.lock() {
        cache.insert(image.to_string(), detected);
    }
    Some(detected)
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
/// binary needs Alpine's dynamic loader. The image's libc decides which build is tried first
/// (when the probe could answer); the other published variant remains the fallback when the
/// first one cannot start.
fn stage_collector_for_target(
    program: &str,
    container: &str,
    target: ContainerTarget,
    explicit_override: bool,
    musl_first: bool,
) -> Result<StagedCollector, String> {
    if explicit_override {
        let source = staged_binary(target.glibc_rid).ok_or_else(|| {
            format!(
                "No collector has been published for this image. Build `{}` with `npm run collector:docker -- {}`.",
                target.glibc_rid, target.glibc_rid
            )
        })?;
        return stage_collector(program, container, target.glibc_rid, &source, None);
    }

    let mut attempted = Vec::new();
    let mut last_libc_error = None;
    for rid in collector_order(target, musl_first) {
        let Some(source) = staged_binary(rid) else {
            continue;
        };
        attempted.push(rid);
        let libraries = staged_libraries(rid);
        match stage_collector(program, container, rid, &source, libraries.as_deref()) {
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
    // A musl binary published before the runtime was bundled cannot start in a bare Alpine image,
    // and telling the user to publish it again without saying why would repeat the dead end.
    let missing_runtime =
        attempted.contains(&target.musl_rid) && staged_libraries(target.musl_rid).is_none();
    let runtime_note = if missing_runtime {
        " The musl collector has no bundled C++ runtime, so a bare Alpine image cannot start it: \
         repair it from the Container Support view, or republish it with `npm run \
         collector:docker -- <rid> musl` (the publisher extracts libstdc++ and libgcc_s with \
         Docker)."
    } else {
        ""
    };
    Err(format!(
        "No published collector could run in this image (tried {}). If it uses Alpine/musl, publish the musl variant with `npm run collector:docker -- {} musl`.{runtime_note}{detail}",
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
        match stage_collector(program, container, rid, source, None) {
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
/// destination whose parent directory does not exist, and there is no portable way to create one:
/// `docker exec mkdir` is unavailable in a distroless image, which is exactly the kind of image
/// that has no shell to run it in. `/tmp` always exists and is writable by the image's user. The
/// musl C++ runtime is the exception: it is a directory of its own, which `docker cp` creates
/// while copying, and it needs a directory of its own so `LD_LIBRARY_PATH` stays narrow.
///
/// The copy is skipped when *this build* already answers `capabilities`, which makes the check
/// the cost of a warm container (~200 ms) instead of an 80 MB copy. The content-addressed staged
/// path keeps an active older session isolated from a newer build; old copies are pruned after a
/// successful stage (the collector retains recent copies to avoid races with concurrent sessions).
pub fn ensure_collector(container: &str) -> Result<StagedCollector, String> {
    let program = cli();
    let (image, target) = container_target(&program, container)?;
    let explicit_override = std::env::var_os("MEMORYSPY_DOCKER_COLLECTOR").is_some();
    // An override is a user-supplied binary and keeps the existing glibc-labelled path; only the
    // published variants are ordered by the image's libc. With no musl build there is nothing to
    // order, so a glibc-only setup never pays for the probe.
    let musl_first = !explicit_override
        && staged_binary(target.musl_rid).is_some()
        && uses_musl(&program, container, &image, target) == Some(true);
    stage_collector_for_target(&program, container, target, explicit_override, musl_first)
}

/// The order the published builds are tried in.
///
/// Getting this wrong is expensive rather than fatal: a musl image given the glibc build first
/// copies ~85 MB into the container only for `exec` to fail, then copies the musl build anyway.
/// The fallback stays in place because the detection is a hint, not a guarantee.
fn collector_order(target: ContainerTarget, musl_first: bool) -> [&'static str; 2] {
    if musl_first {
        [target.musl_rid, target.glibc_rid]
    } else {
        [target.glibc_rid, target.musl_rid]
    }
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
    libraries: Option<&Path>,
) -> Result<StagedCollector, String> {
    // Content-addressed paths prevent a rebuild from replacing a binary used by an active
    // session. Obsolete copies are pruned after the new executable has been verified.
    let identity = file_identity(source)?;
    let filename = format!("memoryspy-collector-{rid}-{identity}");
    let path = format!("/tmp/{filename}");
    let library_path = libraries.map(|_| format!("/tmp/memoryspy-collector-libs-{rid}-{identity}"));

    if probe(
        program,
        container,
        &path,
        &identity,
        library_path.as_deref(),
    )
    .is_ok()
    {
        return Ok(StagedCollector {
            rid: rid.to_string(),
            path,
            library_path,
        });
    }

    let source = source.to_string_lossy().into_owned();
    let destination = format!("{container}:{path}");
    invoke(program, &["cp", &source, &destination], CLI_TIMEOUT).map_err(|error| {
        format!(
            "Could not copy the collector into {container} (is its filesystem read-only?): {error}"
        )
    })?;

    // The runtime travels beside the binary and in its own directory, so `LD_LIBRARY_PATH`
    // cannot accidentally resolve some unrelated library from `/tmp`. The trailing `/.` copies
    // the *contents* into the destination: a plain directory copy nests a second `libs` under the
    // first when an interrupted copy left the destination behind, and the collector would keep
    // failing forever. Copying contents creates the directory and overwrites files, so a retry
    // repairs it.
    if let (Some(libraries), Some(library_path)) = (libraries, library_path.as_deref()) {
        let source = format!("{}/.", libraries.to_string_lossy());
        let destination = format!("{container}:{library_path}");
        invoke(program, &["cp", &source, &destination], CLI_TIMEOUT).map_err(|error| {
            format!(
                "Could not copy the musl C++ runtime into {container} at {library_path} \
                 (is its filesystem read-only?): {error}"
            )
        })?;
    }

    // Verify both the content identity and execution before any session relies on this copy.
    probe(
        program,
        container,
        &path,
        &identity,
        library_path.as_deref(),
    )
    .map_err(|error| {
        format!(
            "The collector was copied into {container} at {path} but does not run there: {error}"
        )
    })?;

    // Prune older content-addressed copies after this one is proven runnable. Linux keeps
    // already-running older sessions alive when their executable is unlinked.
    //
    // The runtime directories are a second prefix, not a second match: they are named
    // `memoryspy-collector-libs-<rid>-<identity>`, so the executable prefix never sees them and
    // a long-lived container would keep ~2.8 MB of libraries per rebuild. The collector removes
    // both kinds, keeping the pair this session is about to use.
    prune_staged_copies(program, container, &path, library_path.as_deref(), rid);

    Ok(StagedCollector {
        rid: rid.to_string(),
        path,
        library_path,
    })
}

/// Asks the staged collector to remove superseded builds, tolerating one that predates the
/// runtime-directory prefix.
///
/// Cleanup is best effort: the new copy has already been verified, so a failure here must never
/// fail staging. It must not silently prune *nothing* either. A `MEMORYSPY_DOCKER_COLLECTOR`
/// override can be an older build whose `cleanup` accepts exactly one prefix and exits non-zero
/// when given a second; retrying with the one-argument form still removes every superseded
/// executable (the ~80 MB part), leaving only runtime directories behind for the manual prune in
/// Container Support. Both failures stay silent here because there is nothing actionable to show
/// a session that is otherwise starting correctly.
fn prune_staged_copies(
    program: &str,
    container: &str,
    path: &str,
    library_path: Option<&str>,
    rid: &str,
) {
    let prefix = format!("memoryspy-collector-{rid}-");
    let libraries_prefix = format!("memoryspy-collector-libs-{rid}-");
    let cleanup = exec_arguments(container, path, library_path, false);
    let base: Vec<&str> = cleanup.iter().map(String::as_str).collect();

    let mut current = base.clone();
    current.extend(["cleanup", &prefix, &libraries_prefix]);
    if invoke(program, &current, CLI_TIMEOUT).is_ok() {
        return;
    }

    let mut legacy = base;
    legacy.extend(["cleanup", &prefix]);
    let _ = invoke(program, &legacy, CLI_TIMEOUT);
}

fn probe(
    program: &str,
    container: &str,
    path: &str,
    expected_identity: &str,
    library_path: Option<&str>,
) -> Result<(), String> {
    let version = exec_arguments(container, path, library_path, false);
    let version: Vec<&str> = version.iter().map(String::as_str).collect();
    let mut version = version;
    version.push("version");
    let actual_identity = invoke(program, &version, CLI_TIMEOUT)?;
    if actual_identity.trim() != expected_identity {
        return Err(format!(
            "collector identity mismatch: expected {expected_identity}, got {}",
            actual_identity.trim()
        ));
    }

    let capabilities = exec_arguments(container, path, library_path, false);
    let capabilities: Vec<&str> = capabilities.iter().map(String::as_str).collect();
    let mut capabilities = capabilities;
    capabilities.push("capabilities");
    invoke(program, &capabilities, CLI_TIMEOUT).map(|_| ())
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
///
/// `fast` skips the collector's OS-level enrichment (a `ps` and an `lsof` per .NET process,
/// *inside* the container). The rail's periodic refresh passes it: a listing that exists to
/// notice "the service restarted, here is its new pid" must not pay for the command line and
/// runtime version of every process on every tick. Interactive listings — expanding a
/// container, a rescan — pass `fast: false` and get the full detail.
pub fn list_processes(container: &str, fast: bool) -> Result<Vec<DotnetProcessInfo>, String> {
    let staged = ensure_collector(container)?;
    let mut arguments = staged.exec_arguments(container, false);
    arguments.push("list".to_string());
    if fast {
        arguments.push("--fast".to_string());
    }
    let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
    let output = run(&arguments)?;
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

    /// A musl collector only gets `LD_LIBRARY_PATH` when the runtime was published beside it.
    ///
    /// The path must be passed to *every* exec of that collector. A session that forgot it would
    /// start and then die with the same missing-library error the probe had already ruled out.
    #[test]
    fn a_musl_collector_carries_its_cpp_runtime_into_every_exec() {
        let staged = StagedCollector {
            rid: "linux-musl-arm64".into(),
            path: "/tmp/memoryspy-collector-linux-musl-arm64-abc".into(),
            library_path: Some("/tmp/memoryspy-collector-libs-linux-musl-arm64-abc".into()),
        };

        let interactive = staged.exec_arguments("svc", true);
        assert_eq!(
            interactive.iter().map(String::as_str).collect::<Vec<_>>(),
            [
                "exec",
                "-i",
                "-e",
                "LD_LIBRARY_PATH=/tmp/memoryspy-collector-libs-linux-musl-arm64-abc",
                "svc",
                "/tmp/memoryspy-collector-linux-musl-arm64-abc",
            ]
        );
        let batch = staged.exec_arguments("svc", false);
        assert_eq!(
            batch.iter().map(String::as_str).collect::<Vec<_>>(),
            [
                "exec",
                "-e",
                "LD_LIBRARY_PATH=/tmp/memoryspy-collector-libs-linux-musl-arm64-abc",
                "svc",
                "/tmp/memoryspy-collector-linux-musl-arm64-abc",
            ]
        );

        // A glibc collector has no bundled runtime, and its command must stay unchanged.
        let glibc = StagedCollector {
            rid: "linux-arm64".into(),
            path: "/tmp/memoryspy-collector-linux-arm64-abc".into(),
            library_path: None,
        };
        let glibc = glibc.exec_arguments("svc", false);
        assert_eq!(
            glibc.iter().map(String::as_str).collect::<Vec<_>>(),
            ["exec", "svc", "/tmp/memoryspy-collector-linux-arm64-abc"]
        );
    }

    /// The loader probe answers from the image's filesystem without executing anything in it.
    #[test]
    fn musl_is_detected_from_the_images_loader() {
        let musl = fake_cli(
            "detect-musl",
            "#!/bin/sh\n\
             case \"$1\" in\n\
               cp) printf loader > \"$3\"; exit 0 ;;\n\
             esac\n\
             exit 1\n",
        );
        let glibc = fake_cli(
            "detect-glibc",
            "#!/bin/sh\n\
             case \"$1\" in\n\
               cp) echo 'Error response from daemon: Could not find the file /lib/ld-musl-aarch64.so.1 in container svc' >&2; exit 1 ;;\n\
             esac\n\
             exit 1\n",
        );
        let broken = fake_cli(
            "detect-broken",
            "#!/bin/sh\n\
             case \"$1\" in\n\
               cp) echo 'permission denied' >&2; exit 1 ;;\n\
             esac\n\
             exit 1\n",
        );
        let target = parse_image_target("svc", "linux|arm64").unwrap();

        assert_eq!(
            detect_musl(musl.to_str().unwrap(), "svc", target),
            Some(true),
            "an image whose loader copies out must be detected as musl"
        );
        assert_eq!(
            detect_musl(glibc.to_str().unwrap(), "svc", target),
            Some(false),
            "a missing loader is the glibc answer, not an error"
        );
        assert_eq!(
            detect_musl(broken.to_str().unwrap(), "svc", target),
            None,
            "an unrelated copy failure must leave the answer unknown"
        );

        for script in [musl, glibc, broken] {
            let _ = std::fs::remove_dir_all(script.parent().unwrap());
        }
    }

    /// The libc question must not cost a file copy on every refresh of the container rail.
    #[test]
    fn the_libc_answer_is_cached_per_image() {
        let dir = staging_area("libc-cache");
        let log = dir.join("calls.log");
        let script = fake_cli(
            "libc-cache",
            &format!(
                "#!/bin/sh\n\
                 case \"$1\" in\n\
                   cp) echo x >> '{}'; printf loader > \"$3\"; exit 0 ;;\n\
                 esac\n\
                 exit 1\n",
                log.display()
            ),
        );
        let target = parse_image_target("svc", "linux|arm64").unwrap();
        let image = format!("sha256:libc-cache-{}", std::process::id());

        assert_eq!(
            uses_musl(script.to_str().unwrap(), "svc", &image, target),
            Some(true)
        );
        assert_eq!(
            uses_musl(script.to_str().unwrap(), "svc", &image, target),
            Some(true)
        );
        assert_eq!(
            std::fs::read_to_string(&log)
                .expect("the fake CLI must log its calls")
                .lines()
                .count(),
            1,
            "the image's libc was probed again instead of being cached"
        );

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(script.parent().unwrap());
    }

    /// The matching build is tried first, and the other one remains the fallback.
    #[test]
    fn collector_order_puts_the_matching_libc_first() {
        let arm = parse_image_target("svc", "linux|arm64").unwrap();
        assert_eq!(
            collector_order(arm, true),
            ["linux-musl-arm64", "linux-arm64"]
        );
        assert_eq!(
            collector_order(arm, false),
            ["linux-arm64", "linux-musl-arm64"]
        );

        let x64 = parse_image_target("svc", "linux|amd64").unwrap();
        assert_eq!(collector_order(x64, true), ["linux-musl-x64", "linux-x64"]);
    }

    /// A runtime directory is only usable when both libraries are actually there.
    #[test]
    fn the_musl_runtime_requires_both_shared_libraries() {
        let dir =
            std::env::temp_dir().join(format!("memoryspy-musl-runtime-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a temp dir for the runtime layout");

        assert!(
            !has_musl_runtime(&dir),
            "an empty directory is not a runtime"
        );

        std::fs::write(dir.join("libstdc++.so.6"), b"c++").expect("libstdc++");
        assert!(
            !has_musl_runtime(&dir),
            "libstdc++ without libgcc_s cannot resolve its own dependencies"
        );

        std::fs::write(dir.join("libgcc_s.so.1"), b"unwind").expect("libgcc_s");
        assert!(has_musl_runtime(&dir), "both libraries must make a runtime");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The diagnostics view must describe every variant, not only the ones that are published.
    #[test]
    fn the_collector_table_flags_published_musl_builds_without_a_runtime() {
        let variants = collector_variants_with(
            |rid| rid == "linux-arm64" || rid == "linux-musl-arm64",
            |_| false,
        );

        assert_eq!(variants.len(), COLLECTOR_VARIANTS.len());

        let glibc = variants
            .iter()
            .find(|variant| variant.rid == "linux-arm64")
            .expect("the arm64 glibc build must be listed");
        assert!(glibc.published);
        assert_eq!(glibc.libc, CollectorLibc::Glibc);
        assert!(
            !glibc.runtime_missing,
            "a glibc build must not be asked for a musl runtime"
        );

        let musl = variants
            .iter()
            .find(|variant| variant.rid == "linux-musl-arm64")
            .expect("the arm64 musl build must be listed");
        assert!(musl.published);
        assert_eq!(musl.libc, CollectorLibc::Musl);
        assert!(
            musl.runtime_missing,
            "a published musl build without libs/ must be reported as missing its runtime"
        );

        let unpublished = variants
            .iter()
            .find(|variant| variant.rid == "linux-musl-x64")
            .expect("an unpublished variant must still be listed");
        assert!(!unpublished.published);
        assert!(
            !unpublished.runtime_missing,
            "a variant that was never published has no runtime to be missing"
        );

        let complete = collector_variants_with(|_| true, |_| true);
        assert!(
            complete
                .iter()
                .all(|variant| variant.published && !variant.runtime_missing),
            "every variant with its runtime must be reported as ready"
        );
    }

    /// A repair is only possible where it is possible; the reasons are named, not inferred.
    ///
    /// `repair_blocker` reads the process environment (the override) and the daemon, so this test
    /// only covers the two answers that come from the RID itself.
    #[test]
    fn only_a_published_musl_variant_is_repairable() {
        assert_eq!(
            repair_blocker("linux-x64"),
            Some(RepairProblem::NotMusl),
            "a glibc build has no separate runtime to repair"
        );
        assert_eq!(
            repair_blocker("windows-x64"),
            Some(RepairProblem::NotPublished),
            "an unknown RID must not be treated as a variant"
        );
    }

    /// A repair extracts the runtime once and then reuses it for the same build.
    ///
    /// The second half is the point: the first repair may pull a few hundred megabytes, and a
    /// resources directory that is rebuilt would otherwise make every repair pay for the image
    /// again. The third call changes the binary, which must invalidate the cache even though the
    /// files are still there.
    #[test]
    fn a_repair_extracts_once_and_reuses_its_runtime_until_the_build_changes() {
        let dir = staging_area("repair");
        let stage = dir.join("stage");
        std::fs::create_dir_all(&stage).expect("the fake container's staging dir");
        let log = dir.join("calls.log");

        // The fake CLI answers the three calls an extraction makes, and writes the libraries
        // where the real one does: a `cp` target on the host, plus the path printed by the
        // `sh -c readlink -f` step. Every invocation is logged so "extracted again" is observable.
        let script = format!(
            "#!/bin/sh\n\
             case \"$1\" in\n\
               cp) echo \"cp $2 $3\" >> '{}'\n\
                   case \"$2\" in\n\
                     *libstdc++) printf cxx > \"$3\" ;;\n\
                     *libgcc_s*) printf unwind > \"$3\" ;;\n\
                     *) printf collector > \"$3\" ;;\n\
                   esac\n\
                   exit 0 ;;\n\
               run) echo \"run\" >> '{}'; echo /usr/lib/libstdc++.so.6.0.34; exit 0 ;;\n\
               create|inspect|rm) echo \"$1\" >> '{}'; exit 0 ;;\n\
             esac\n\
             echo 1\n",
            log.display(),
            log.display(),
            log.display(),
        );
        let program = fake_cli("repair", &script);

        let variant = dir.join("linux-musl-arm64");
        std::fs::create_dir_all(&variant).expect("the variant directory");
        let binary = variant.join("MemorySpy.Collector");
        std::fs::write(&binary, b"collector").expect("the published binary");
        let root = dir.join("data");

        let extracted = repair_with(
            program.to_str().unwrap(),
            "linux-musl-arm64",
            &binary,
            &root,
        )
        .expect("a published musl build must be repairable");
        for name in MUSL_RUNTIME_LIBRARIES {
            assert!(
                variant.join("libs").join(name).is_file(),
                "{name} was not copied beside the binary"
            );
            assert!(
                extracted.join(name).is_file(),
                "{name} was not kept in the runtime cache"
            );
        }

        // A rebuilt resources directory: the binary is back without its libs, the cache is not.
        std::fs::remove_dir_all(variant.join("libs")).expect("drop the bundled runtime");
        let reuse = repair_with(
            program.to_str().unwrap(),
            "linux-musl-arm64",
            &binary,
            &root,
        )
        .expect("the cached runtime must repair the same build again");
        assert_eq!(reuse, extracted);

        let calls = std::fs::read_to_string(&log).expect("the fake CLI's log");
        assert_eq!(
            calls.lines().filter(|line| *line == "run").count(),
            1,
            "the runtime image was extracted again for an unchanged build: {calls}"
        );

        // A republished binary no longer matches the cached identity.
        std::fs::write(&binary, b"rebuilt collector").expect("a rebuilt binary");
        repair_with(
            program.to_str().unwrap(),
            "linux-musl-arm64",
            &binary,
            &root,
        )
        .expect("a changed build must be repairable from the image");
        let calls = std::fs::read_to_string(&log).expect("the fake CLI's log");
        assert_eq!(
            calls.lines().filter(|line| *line == "run").count(),
            2,
            "a rebuilt binary reused the runtime of the build it replaced: {calls}"
        );

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(program.parent().unwrap());
        RUNTIME_CACHE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .remove("linux-musl-arm64");
    }

    /// A cached runtime only belongs to the build it was extracted for.
    ///
    /// The binary's content hash is the marker. Without it a rebuild would silently run new .NET
    /// code against libraries pulled for the previous host, which is the drift the bundled layout
    /// exists to avoid.
    ///
    /// The decision is pinned through [`cached_runtime_with`] rather than the real cache: the
    /// function under test is the pairing rule, and staging two real collector variants would make
    /// the test depend on which builds this machine happens to have published.
    #[test]
    fn a_cached_runtime_is_ignored_once_its_binary_is_rebuilt() {
        let dir = staging_area("runtime-cache");
        let cache = runtime_cache_dir(&dir, "linux-musl-arm64");
        std::fs::create_dir_all(&cache).expect("the cache directory");
        std::fs::write(cache.join("libstdc++.so.6"), b"c++").expect("libstdc++");
        std::fs::write(cache.join("libgcc_s.so.1"), b"unwind").expect("libgcc_s");

        let binary = dir.join("linux-musl-arm64").join("MemorySpy.Collector");
        std::fs::create_dir_all(binary.parent().unwrap()).expect("the variant directory");
        std::fs::write(&binary, b"first build").expect("the collector");
        let first = file_identity(&binary).expect("the first identity");
        std::fs::write(cache.join(RUNTIME_IDENTITY), &first).expect("the cached identity");

        assert_eq!(
            cached_runtime_with(Some(&cache), Some(&binary)),
            Some(cache.clone()),
            "a runtime recorded for this exact binary must be usable"
        );

        std::fs::write(&binary, b"second build").expect("a rebuilt collector");
        assert_eq!(
            cached_runtime_with(Some(&cache), Some(&binary)),
            None,
            "a rebuild must not inherit the libraries of the build it replaced"
        );

        // The same rule covers a cache with no marker at all: it was not written by a repair, so
        // nothing ties it to the binary that would load it.
        std::fs::remove_file(cache.join(RUNTIME_IDENTITY)).expect("drop the marker");
        assert_eq!(
            cached_runtime_with(Some(&cache), Some(&binary)),
            None,
            "an unmarked cache directory must not be trusted"
        );

        // And a missing cache entry is not an error, just no answer.
        assert_eq!(cached_runtime_with(None, Some(&binary)), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The diagnostics view reads these names directly, so the JSON contract is pinned here.
    #[test]
    fn a_variant_serializes_with_the_names_the_ui_reads() {
        let variant = CollectorVariant {
            rid: "linux-musl-arm64".into(),
            libc: CollectorLibc::Musl,
            published: true,
            runtime_missing: true,
        };

        let json = serde_json::to_value(variant).expect("a variant must serialize");
        assert_eq!(json["rid"], "linux-musl-arm64");
        assert_eq!(json["libc"], "musl");
        assert_eq!(json["published"], true);
        assert_eq!(json["runtimeMissing"], true);
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
        // A collector built before `cleanup` learned the runtime-directory prefix. It accepts
        // exactly one argument, so any second one is an error — the shape an old
        // MEMORYSPY_DOCKER_COLLECTOR override has.
        let legacy_cleanup = if name == "legacy-cleanup" {
            "if [ -n \"$6\" ]; then echo 'cleanup requires a MemorySpy collector filename prefix.' >&2; exit 1; fi; "
        } else {
            ""
        };
        // Every cleanup attempt fails, to pin that cleanup is best effort rather than a
        // postcondition of staging.
        let cleanup_failure = if name == "cleanup-fails" {
            "exit 1; "
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
                 if [ \"$4\" = cleanup ]; then printf 'cleanup\t%s\t%s\\n' \"$5\" \"${{6-}}\" >> '{log}'; {cleanup_failure}{legacy_cleanup}for file in '{stage}'/*; do case \"$file\" in *memoryspy-collector-linux-x64-*) [ \"$file\" = \"$marker\" ] || rm -f \"$file\" ;; esac; done; exit 0; fi\n\
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
            legacy_cleanup = legacy_cleanup,
            cleanup_failure = cleanup_failure,
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

        let first = stage_collector(docker.to_str().unwrap(), "svc", "linux-x64", &binary, None)
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
            calls.lines().filter(|line| line.contains('|')).count(),
            1,
            "the first attach must copy once: {calls}"
        );
        assert!(
            calls.contains(&format!("svc:{}", first.path)),
            "the collector was not copied to {}: {calls}",
            first.path
        );

        let second = stage_collector(docker.to_str().unwrap(), "svc", "linux-x64", &binary, None)
            .expect("a warm container must be usable");
        assert_eq!(second.path, first.path);
        assert_eq!(
            std::fs::read_to_string(&log)
                .unwrap()
                .lines()
                .filter(|line| line.contains('|'))
                .count(),
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
        let first = stage_collector(docker.to_str().unwrap(), "svc", "linux-x64", &binary, None)
            .expect("the first build must stage");

        std::fs::write(&binary, b"collector build two, a different length")
            .expect("the rebuilt local collector");
        let second = stage_collector(docker.to_str().unwrap(), "svc", "linux-x64", &binary, None)
            .expect("the rebuilt collector must stage");

        assert_ne!(
            first.path, second.path,
            "different collector contents must never alias an active staged executable"
        );

        let calls = std::fs::read_to_string(&log).unwrap();
        assert_eq!(
            calls.lines().filter(|line| line.contains('|')).count(),
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
                .rfind(|line| line.contains('|'))
                .is_some_and(|line| line.contains(&format!("svc:{}", second.path))),
            "the last copy did not target the new staged path: {calls}"
        );

        // The collector receives both prefixes: its own files and the runtime directories, which
        // the executable prefix does not match. Without the second one every rebuild leaves the
        // previous ~2.8 MB runtime behind for the life of the container.
        assert!(
            calls.lines().any(|line| line
                == "cleanup\tmemoryspy-collector-linux-x64-\tmemoryspy-collector-libs-linux-x64-"),
            "cleanup was not given the runtime directory prefix: {calls}"
        );
        assert_eq!(
            calls
                .lines()
                .filter(|line| line.starts_with("cleanup\t"))
                .count(),
            2,
            "the two-argument fallback ran even though the collector accepted both prefixes: {calls}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An override collector built before cleanup learned the second prefix rejects it.
    ///
    /// Staging must still succeed, and the failure must not skip pruning entirely: the host
    /// retries with the one-argument form, which still removes the superseded executables. The
    /// runtime directories it cannot understand are left for the manual prune in Container
    /// Support.
    #[test]
    fn a_collector_that_rejects_the_runtime_prefix_still_prunes_binaries() {
        let dir = staging_area("legacy-cleanup");
        let stage = dir.join("stage");
        std::fs::create_dir_all(&stage).expect("the fake container's staging dir");
        let log = dir.join("calls.log");
        let docker = staging_cli("legacy-cleanup", "amd64", &stage, &log);

        let binary = dir.join("MemorySpy.Collector");
        std::fs::write(&binary, b"override build one").expect("the first local collector");
        let first = stage_collector(docker.to_str().unwrap(), "svc", "linux-x64", &binary, None)
            .expect("a rejected second prefix must not fail staging");

        std::fs::write(&binary, b"override build two, rebuilt")
            .expect("the rebuilt local collector");
        let second = stage_collector(docker.to_str().unwrap(), "svc", "linux-x64", &binary, None)
            .expect("the fallback must keep staging usable");
        assert_ne!(first.path, second.path);

        let calls = std::fs::read_to_string(&log).unwrap();
        let three_argument =
            "cleanup\tmemoryspy-collector-linux-x64-\tmemoryspy-collector-libs-linux-x64-";
        let one_argument = "cleanup\tmemoryspy-collector-linux-x64-\t";
        assert_eq!(
            calls.lines().filter(|line| *line == three_argument).count(),
            2,
            "the collector was not offered the runtime directories first: {calls}"
        );
        assert_eq!(
            calls.lines().filter(|line| *line == one_argument).count(),
            2,
            "the fallback never ran, so pruning was skipped: {calls}"
        );

        let staged: Vec<String> = std::fs::read_dir(&stage)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("memoryspy-collector-linux-x64-"))
            .collect();
        assert_eq!(
            staged.len(),
            1,
            "the obsolete executable survived the fallback: {staged:?}"
        );
        let current_identity = second.path.rsplit('-').next().unwrap();
        assert!(
            staged[0].contains(current_identity),
            "the fallback removed the build that was just staged: {staged:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Cleanup is best effort: a verified stage must not be undone by either attempt failing.
    #[test]
    fn a_failing_cleanup_never_fails_a_verified_stage() {
        let dir = staging_area("cleanup-fails");
        let stage = dir.join("stage");
        std::fs::create_dir_all(&stage).expect("the fake container's staging dir");
        let log = dir.join("calls.log");
        let docker = staging_cli("cleanup-fails", "amd64", &stage, &log);

        let binary = dir.join("MemorySpy.Collector");
        std::fs::write(&binary, b"collector that stages fine").expect("the local collector");
        let staged = stage_collector(docker.to_str().unwrap(), "svc", "linux-x64", &binary, None)
            .expect("cleanup must not fail a collector that was copied and verified");

        assert!(staged
            .path
            .starts_with("/tmp/memoryspy-collector-linux-x64-"));
        let calls = std::fs::read_to_string(&log).unwrap();
        assert_eq!(
            calls
                .lines()
                .filter(|line| line.starts_with("cleanup\t"))
                .count(),
            2,
            "both the two-argument and the fallback attempt must run: {calls}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fake CLI with two containers: `svc` reports the `state` fixture, `broken` has no shell.
    ///
    /// `exec … rm` deletes the named copies from the same fixture, so a prune is observed by
    /// measuring again rather than by trusting what the function returns.
    fn staging_usage_cli(name: &str, state: &Path, log: &Path) -> PathBuf {
        let body = format!(
            "#!/bin/sh\n\
             case \"$1\" in\n\
               ps) printf 'id-svc\tsvc\torders:1\tUp 2 minutes\nid-broken\tbroken\tbare:1\tUp 1 minute\n'; exit 0 ;;\n\
               exec)\n\
                 if [ \"$3\" = sh ]; then\n\
                   if [ \"$2\" = broken ]; then echo 'exec: \"sh\": executable file not found in $PATH' >&2; exit 126; fi\n\
                   cat '{state}'; exit 0\n\
                 fi\n\
                 if [ \"$3\" = rm ]; then\n\
                   echo \"$*\" >> '{log}'\n\
                   shift 5\n\
                   while IFS= read -r line; do\n\
                     name=$(printf '%s' \"$line\" | cut -f 1)\n\
                     keep=1\n\
                     for path in \"$@\"; do\n\
                       [ \"$path\" = \"/tmp/$name\" ] && keep=0\n\
                     done\n\
                     [ \"$keep\" = 1 ] && printf '%s\\n' \"$line\"\n\
                   done < '{state}' > '{state}.next'\n\
                   mv '{state}.next' '{state}'\n\
                   exit 0\n\
                 fi\n\
                 exit 1 ;;\n\
             esac\n\
             exit 1\n",
            state = state.display(),
            log = log.display(),
        );
        fake_cli(name, &body)
    }

    /// Two builds in one container: one current, one two hours old, plus a foreign file that
    /// happens to share the prefix.
    fn staging_fixture(state: &Path) -> (String, String) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("the clock is after the epoch")
            .as_secs();
        let current = "a".repeat(64);
        let previous = "b".repeat(64);
        let lines = [
            format!(
                "memoryspy-collector-libs-linux-x64-{current}\t2048\t{}",
                now - 60
            ),
            format!(
                "memoryspy-collector-linux-x64-{current}\t4096\t{}",
                now - 60
            ),
            format!(
                "memoryspy-collector-libs-linux-x64-{previous}\t2048\t{}",
                now - 7_200
            ),
            format!(
                "memoryspy-collector-linux-x64-{previous}\t4096\t{}",
                now - 7_200
            ),
            format!("memoryspy-collector-not-ours.txt\t4096\t{now}"),
        ]
        .join("\n");

        std::fs::write(state, lines).expect("the fake container's /tmp listing");
        (current, previous)
    }

    /// Usage is per container, and an image without a shell is one explained row, not a failed
    /// command: the other containers' answers stay usable.
    #[test]
    fn staging_usage_reports_sizes_ages_and_ignores_foreign_files() {
        let dir = staging_area("staging-usage");
        let state = dir.join("state");
        let log = dir.join("calls.log");
        let (current, _) = staging_fixture(&state);
        let docker = staging_usage_cli("usage", &state, &log);

        let rows = staging_usage_with(docker.to_str().unwrap())
            .expect("a reachable daemon must be measurable");
        assert_eq!(rows.len(), 2, "one row per running container: {rows:#?}");

        let svc = rows
            .iter()
            .find(|row| row.container == "svc")
            .expect("the measurable container");
        assert_eq!(svc.image, "orders:1");
        assert!(svc.error.is_none(), "{svc:#?}");
        assert_eq!(svc.copies.len(), 4, "the foreign file must be ignored");
        assert_eq!(svc.total_bytes, 12_288 * 1024);
        assert_eq!(
            svc.prunable_bytes,
            6_144 * 1024,
            "only the older build's pair is prunable"
        );

        let current_runtime = svc
            .copies
            .iter()
            .find(|copy| copy.kind == StagedCopyKind::Runtime && copy.identity == current)
            .expect("the current runtime directory");
        assert_eq!(
            current_runtime.path,
            format!("/tmp/memoryspy-collector-libs-linux-x64-{current}")
        );
        assert!(
            current_runtime.age_seconds.is_some_and(|age| age >= 60),
            "the probe's mtime must become an age: {current_runtime:#?}"
        );

        let broken = rows
            .iter()
            .find(|row| row.container == "broken")
            .expect("the container without a shell");
        assert!(
            broken
                .error
                .as_deref()
                .is_some_and(|error| error.contains("executable file not found")),
            "the CLI's own reason must survive: {broken:#?}"
        );
        assert!(broken.copies.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Pruning removes the previous build's executable *and* runtime directory, keeps the
    /// current pair, and is idempotent.
    #[test]
    fn pruning_keeps_the_newest_build_and_frees_the_rest() {
        let dir = staging_area("staging-prune");
        let state = dir.join("state");
        let log = dir.join("calls.log");
        let (current, previous) = staging_fixture(&state);
        let docker = staging_usage_cli("prune", &state, &log);

        let after = prune_staging_with(docker.to_str().unwrap(), "svc")
            .expect("the old build must be removable");

        let calls = std::fs::read_to_string(&log).expect("the fake CLI logs its removals");
        let expected = format!(
            "exec svc rm -rf -- /tmp/memoryspy-collector-libs-linux-x64-{previous} \
             /tmp/memoryspy-collector-linux-x64-{previous}"
        );
        assert_eq!(
            calls.lines().collect::<Vec<_>>(),
            vec![expected.as_str()],
            "the wrong copies were removed"
        );

        assert_eq!(after.copies.len(), 2, "{after:#?}");
        assert!(
            after.copies.iter().all(|copy| copy.identity == current),
            "the newest build must stay: {after:#?}"
        );
        assert_eq!(after.total_bytes, 6_144 * 1024);
        assert_eq!(after.prunable_bytes, 0);

        let again = prune_staging_with(docker.to_str().unwrap(), "svc")
            .expect("nothing left to prune is a success");
        assert_eq!(again.total_bytes, after.total_bytes);
        assert_eq!(
            std::fs::read_to_string(&log).unwrap().lines().count(),
            1,
            "a second prune must not run rm again"
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
        assert_eq!(
            std::fs::read_to_string(&log)
                .unwrap()
                .lines()
                .filter(|line| line.contains('|'))
                .count(),
            2
        );
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

        let error = stage_collector(script.to_str().unwrap(), "svc", "linux-x64", &binary, None)
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

        let error = stage_collector(script.to_str().unwrap(), "svc", "linux-x64", &binary, None)
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
