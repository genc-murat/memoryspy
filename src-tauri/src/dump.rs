//! Offline managed-heap analysis using the installed dotnet-dump tool.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::watch;

use crate::collector::without_console_window;
use crate::dump_file;

#[derive(Default)]
pub struct DumpAnalyzer {
    active: Mutex<Option<watch::Sender<()>>>,
}

struct ActiveAnalysis<'a>(&'a DumpAnalyzer);

impl Drop for ActiveAnalysis<'_> {
    fn drop(&mut self) {
        self.0.active.lock().unwrap().take();
    }
}

impl DumpAnalyzer {
    pub async fn analyze(
        &self,
        path: &Path,
        progress: &Channel<String>,
    ) -> Result<Option<DumpAnalysis>, String> {
        self.run(analyze_file(path.to_owned(), progress)).await
    }

    pub async fn objects(
        &self,
        path: &Path,
        dump_id: &str,
        method_table: &str,
        min_bytes: u64,
        progress: &Channel<String>,
    ) -> Result<Option<Vec<DumpObject>>, String> {
        let method_table = parse_address(method_table).ok_or("Invalid method table address.")?;
        self.run(async {
            let target = resolve_dump(path.to_owned(), Some(dump_id)).await?;
            let objects = sample_objects(
                &target.tool,
                &target.path,
                method_table,
                min_bytes,
                progress,
            )
            .await?;
            target.verify().await?;
            Ok(objects)
        })
        .await
    }

    pub async fn roots(
        &self,
        path: &Path,
        dump_id: &str,
        addresses: &[String],
        progress: &Channel<String>,
    ) -> Result<Option<DumpRoots>, String> {
        if addresses.is_empty() || addresses.len() > 3 {
            return Err("Select one to three objects.".into());
        }
        let samples = addresses
            .iter()
            .map(|address| parse_address(address))
            .collect::<Option<Vec<_>>>()
            .ok_or("Invalid object address.")?;
        if samples
            .iter()
            .enumerate()
            .any(|(index, address)| samples[..index].contains(address))
        {
            return Err("Select distinct objects.".into());
        }
        self.run(async {
            let target = resolve_dump(path.to_owned(), Some(dump_id)).await?;
            let roots = find_roots(&target, &samples, progress).await?;
            target.verify().await?;
            Ok(roots)
        })
        .await
    }

    pub async fn reference(
        &self,
        path: &Path,
        dump_id: &str,
        parent: &str,
        child: Option<&str>,
    ) -> Result<Option<DumpReference>, String> {
        let parent = parse_address(parent).ok_or("Invalid object address.")?;
        let child = child
            .map(|address| parse_address(address).ok_or("Invalid referenced address."))
            .transpose()?;
        self.run(async {
            let target = resolve_dump(path.to_owned(), Some(dump_id)).await?;
            let reference =
                inspect_reference_with_tool(&target.tool, &target.path, parent, child).await?;
            target.verify().await?;
            Ok(reference)
        })
        .await
    }

    async fn run<T>(
        &self,
        analysis: impl Future<Output = Result<T, String>>,
    ) -> Result<Option<T>, String> {
        let (cancel, mut cancelled) = watch::channel(());
        {
            let mut active = self.active.lock().unwrap();
            if active.is_some() {
                return Err("A dump analysis is already running.".into());
            }
            *active = Some(cancel);
        }
        let _active = ActiveAnalysis(self);

        tokio::select! {
            biased;
            _ = cancelled.changed() => Ok(None),
            result = analysis => result.map(Some),
        }
    }

    pub fn cancel(&self) {
        if let Some(active) = self.active.lock().unwrap().as_ref() {
            let _ = active.send(());
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpAnalysis {
    id: String,
    path: PathBuf,
    duration_ms: u64,
    #[serde(flatten)]
    heap: DumpHeap,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DumpHeap {
    object_count: u64,
    total_bytes: u64,
    free_bytes: u64,
    types: Vec<DumpType>,
    notices: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DumpType {
    method_table: String,
    type_name: String,
    object_count: u64,
    total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpRoots {
    samples_checked: usize,
    paths: Vec<DumpRootPath>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpObject {
    address: String,
    size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DumpRootPath {
    address: String,
    frames: Vec<DumpRootFrame>,
    application_frame_index: Option<usize>,
    stack_method: Option<String>,
    reference: Option<DumpReference>,
    trace: String,
    trace_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DumpRootFrame {
    address: String,
    type_name: String,
    static_field: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpReference {
    method_table: String,
    type_name: String,
    assembly_path: Option<String>,
    fields: Vec<String>,
}

async fn analyze_file(path: PathBuf, progress: &Channel<String>) -> Result<DumpAnalysis, String> {
    let started = Instant::now();
    let target = resolve_dump(path, None).await?;
    let output = run_sos(&target.tool, &target.path, "dumpheap -stat", Some(progress)).await?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut heap = if output.status.success() {
        parse_heap(&stdout)
    } else {
        Err(format!("dotnet-dump exited with {}.", output.status))
    }
    .map_err(|error| analysis_error(&error, &stdout, &stderr))?;
    heap.notices.extend(
        stderr
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned),
    );

    target.verify().await?;
    Ok(DumpAnalysis {
        id: target.id,
        path: target.path,
        duration_ms: started.elapsed().as_millis() as u64,
        heap,
    })
}

struct DumpTarget {
    id: String,
    path: PathBuf,
    tool: PathBuf,
}

impl DumpTarget {
    async fn verify(&self) -> Result<(), String> {
        let path = self.path.clone();
        let actual = tauri::async_runtime::spawn_blocking(move || dump_file::fingerprint(&path))
            .await
            .map_err(|error| error.to_string())?;
        if actual.as_deref().ok() == Some(self.id.as_str()) {
            Ok(())
        } else {
            Err(dump_changed())
        }
    }
}

fn dump_changed() -> String {
    "The dump file changed or is unavailable. Analyze the current file before inspecting it.".into()
}

async fn resolve_dump(path: PathBuf, expected_id: Option<&str>) -> Result<DumpTarget, String> {
    let expected_id = expected_id.map(str::to_owned);
    tauri::async_runtime::spawn_blocking(move || prepare_dump(&path, expected_id.as_deref()))
        .await
        .map_err(|error| error.to_string())?
}

fn prepare_dump(path: &Path, expected_id: Option<&str>) -> Result<DumpTarget, String> {
    // An absolute path keeps even a file named like a command-line option in the path position.
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        path.canonicalize().map_err(|error| error.to_string())?
    };
    let id = dump_file::fingerprint(&path).map_err(|error| {
        if expected_id.is_some() {
            dump_changed()
        } else {
            format!("Could not open {}. {error}", path.display())
        }
    })?;
    if expected_id.is_some_and(|expected| expected != id) {
        return Err(dump_changed());
    }
    let tool = find_dotnet_dump().ok_or_else(|| {
        "dotnet-dump was not found. Install it with `dotnet tool install --global dotnet-dump`, or put an existing installation on PATH.".to_string()
    })?;

    Ok(DumpTarget { id, path, tool })
}

fn sos_command(tool: &Path, path: &Path, sos: &str) -> tokio::process::Command {
    let mut command = Command::new(tool);
    command
        .arg("analyze")
        .arg(path)
        .args(["-c", sos, "-c", "exit"])
        .env("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT", "1")
        .stdin(Stdio::null());
    without_console_window(&mut command);
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    command
}

async fn run_sos(
    tool: &Path,
    path: &Path,
    sos: &str,
    progress: Option<&Channel<String>>,
) -> Result<SosOutput, String> {
    run_sos_with_limit(tool, path, sos, progress, None).await
}

struct SosOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
}

async fn run_sos_with_limit(
    tool: &Path,
    path: &Path,
    sos: &str,
    progress: Option<&Channel<String>>,
    limit: Option<usize>,
) -> Result<SosOutput, String> {
    let mut child = sos_command(tool, path, sos)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not run dotnet-dump. {error}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (status, stdout, stderr) = tokio::try_join!(
        child.wait(),
        read_sos_output(stdout, progress, limit),
        read_sos_output(stderr, progress, limit),
    )
    .map_err(|error| format!("Could not read dotnet-dump output. {error}"))?;
    Ok(SosOutput {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        stdout_truncated: stdout.truncated,
    })
}

struct SosCapture {
    bytes: Vec<u8>,
    truncated: bool,
}

async fn read_sos_output(
    pipe: impl tokio::io::AsyncRead + Unpin,
    progress: Option<&Channel<String>>,
    limit: Option<usize>,
) -> std::io::Result<SosCapture> {
    let mut reader = BufReader::new(pipe);
    let mut output = SosCapture {
        bytes: Vec::new(),
        truncated: false,
    };
    let mut line = Vec::new();
    let mut line_clipped = false;
    let mut footer = None;
    loop {
        let buffer = reader.fill_buf().await?;
        let eof = buffer.is_empty();
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let length = newline.map_or(buffer.len(), |position| position + 1);
        if limit.is_some_and(|limit| length > limit.saturating_sub(line.len())) {
            line_clipped = true;
        }
        if !line_clipped {
            line.extend_from_slice(&buffer[..length]);
        }
        reader.consume(length);
        if newline.is_none() && !eof {
            continue;
        }
        if line_clipped {
            output.truncated = true;
        } else {
            let decoded = String::from_utf8_lossy(&line);
            if !send_progress(&decoded, progress) {
                if !output.truncated
                    && limit.map_or(true, |limit| line.len() <= limit - output.bytes.len())
                {
                    output.bytes.extend_from_slice(&line);
                } else if !line.is_empty() {
                    output.truncated = true;
                    // Preserve the root count even if the remainder of a legacy trace is discarded.
                    footer = root_count(&decoded).or(footer);
                }
            }
        }
        if eof {
            break;
        }
        line.clear();
        line_clipped = false;
    }
    if let Some(count) = footer {
        output
            .bytes
            .extend_from_slice(format!("\nFound {count} roots.\n").as_bytes());
    }
    Ok(output)
}

fn send_progress(line: &str, progress: Option<&Channel<String>>) -> bool {
    let message = line.trim();
    let lower = message.to_ascii_lowercase();
    if lower.starts_with("scanning heap")
        || lower.starts_with("walking heap")
        || lower.starts_with("caching gc roots")
        || lower.starts_with("scanned ")
    {
        if let Some(progress) = progress {
            let _ = progress.send(message.to_string());
        }
        return true;
    }
    false
}

async fn find_roots(
    target: &DumpTarget,
    samples: &[u64],
    progress: &Channel<String>,
) -> Result<DumpRoots, String> {
    const ROOT_OUTPUT_LIMIT: usize = 256 * 1024;
    let (path, tool) = (&target.path, &target.tool);
    let mut paths = Vec::new();
    let mut use_root_limit = true;
    for (index, address) in samples.iter().enumerate() {
        let _ = progress.send(format!(
            "Tracing object {} of {} (0x{address:x})…",
            index + 1,
            samples.len()
        ));
        let plain_command = format!("gcroot {address:x}");
        let command = if use_root_limit {
            format!("gcroot -limit 1 {address:x}")
        } else {
            plain_command.clone()
        };
        let mut output = run_sos_with_limit(
            tool,
            path,
            &command,
            Some(progress),
            Some(ROOT_OUTPUT_LIMIT),
        )
        .await?;
        // Some SOS parsers consume an unsupported option as the target and flag its operands.
        if use_root_limit
            && (gcroot_rejected_arguments(&output.stdout)
                || gcroot_rejected_arguments(&output.stderr))
        {
            use_root_limit = false;
            let _ = progress.send("Retrying the GC root search without the SOS root limit…".into());
            output = run_sos_with_limit(
                tool,
                path,
                &plain_command,
                Some(progress),
                Some(ROOT_OUTPUT_LIMIT),
            )
            .await?;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let count = output
            .status
            .success()
            .then(|| root_count(&stdout))
            .flatten();
        let count = count.ok_or_else(|| {
            analysis_error(
                "dotnet-dump could not complete the GC root search.",
                &stdout,
                &stderr,
            )
        })?;
        if count > 0 {
            let mut lines = stdout.lines().skip_while(|line| {
                let line = line.trim();
                line.is_empty()
                    || line.starts_with("Loading core dump:")
                    || line.starts_with("Caching GC roots")
                    || line.starts_with("Subsequent runs of this command")
            });
            let trace = lines.by_ref().take(160).collect::<Vec<_>>().join("\n");
            let (frames, stack_method) = root_frames(&stdout, *address);
            let application_frame_index =
                frames[..frames.len().saturating_sub(1)]
                    .iter()
                    .position(|frame| {
                        !["System.", "Microsoft.", "Internal.", "<"]
                            .iter()
                            .any(|prefix| frame.type_name.starts_with(prefix))
                    });
            let reference = if let Some(index) = application_frame_index {
                let parent = parse_address(&frames[index].address).unwrap();
                let child = parse_address(&frames[index + 1].address);
                inspect_reference_with_tool(tool, path, parent, child)
                    .await
                    .ok()
            } else {
                None
            };
            paths.push(DumpRootPath {
                address: format!("0x{address:x}"),
                frames,
                application_frame_index,
                stack_method,
                reference,
                trace: trace.trim_end().to_string(),
                trace_truncated: output.stdout_truncated || lines.next().is_some(),
            });
        }
    }
    Ok(DumpRoots {
        samples_checked: samples.len(),
        paths,
    })
}

fn gcroot_rejected_arguments(output: &[u8]) -> bool {
    String::from_utf8_lossy(output).lines().any(|line| {
        let line = line.trim().to_ascii_lowercase();
        let line = line.strip_prefix("error:").unwrap_or(&line).trim_start();
        line.starts_with("unrecognized command or argument ")
            || (line.contains("-limit")
                && (line.contains("unknown") || line.contains("unrecognized")))
    })
}

async fn sample_objects(
    tool: &Path,
    path: &Path,
    method_table: u64,
    min_bytes: u64,
    progress: &Channel<String>,
) -> Result<Vec<DumpObject>, String> {
    const SAMPLE_LIMIT: usize = 12;
    let mut child = sos_command(
        tool,
        path,
        &format!("dumpheap -mt {method_table:x} -min {min_bytes}"),
    )
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|error| format!("Could not run dotnet-dump. {error}"))?;
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut stderr = child.stderr.take().unwrap();
    let mut error_output = Vec::new();
    let mut preamble = Vec::new();
    let mut samples = Vec::with_capacity(SAMPLE_LIMIT);
    let mut table_seen = false;

    // Stream the addresses. A single type such as System.String may have millions of instances.
    let collect = async {
        while let Some(line) = stdout.next_line().await? {
            if send_progress(&line, Some(progress)) {
                continue;
            }
            if line.split_whitespace().eq(["Address", "MT", "Size"]) || line.trim() == "Statistics:"
            {
                table_seen = true;
            }
            if let Some(sample) = parse_object_row(&line, method_table) {
                samples.push(sample);
                if samples.len() == SAMPLE_LIMIT {
                    if child.try_wait()?.is_none() {
                        child.kill().await?;
                    }
                    return Ok::<_, std::io::Error>(true);
                }
            } else if preamble.len() < 8 {
                preamble.push(line);
            }
        }
        Ok(child.wait().await?.success())
    };
    let read_error = async {
        let output = read_sos_output(&mut stderr, Some(progress), Some(64 * 1024)).await?;
        error_output = output.bytes;
        Ok::<_, std::io::Error>(())
    };
    let (success, _) = tokio::try_join!(collect, read_error)
        .map_err(|error| format!("Could not read object addresses from dotnet-dump. {error}"))?;
    let empty_walk = error_output.iter().all(u8::is_ascii_whitespace)
        && preamble
            .iter()
            .any(|line| line.starts_with("Loading core dump:"))
        && preamble.iter().all(|line| {
            let line = line.trim();
            line.is_empty() || line.starts_with("Loading core dump:") || line == "No objects found."
        });
    if !success || (samples.is_empty() && !table_seen && !empty_walk) {
        return Err(analysis_error(
            "dotnet-dump returned no object addresses for this method table.",
            &preamble.join("\n"),
            &String::from_utf8_lossy(&error_output),
        ));
    }
    Ok(samples)
}

fn parse_object_row(line: &str, method_table: u64) -> Option<DumpObject> {
    let mut fields = line.split_whitespace();
    let address = parse_address(fields.next()?)?;
    if parse_address(fields.next()?)? != method_table {
        return None;
    }
    Some(DumpObject {
        address: format!("0x{address:x}"),
        size_bytes: parse_count(fields.next()?)?,
    })
}

fn root_frames(stdout: &str, target: u64) -> (Vec<DumpRootFrame>, Option<String>) {
    let mut frames = Vec::new();
    let mut thread_root = false;
    let mut stack_method = None;
    for line in stdout.lines() {
        let line = line.trim();
        if line.starts_with("Thread ") || line == "HandleTable:" {
            thread_root = line.starts_with("Thread ");
            stack_method = None;
        }
        if let Some(edge) = line.strip_prefix("->") {
            let Some((address, label)) = edge.trim_start().split_once(char::is_whitespace) else {
                continue;
            };
            let Some(address) = parse_address(address) else {
                continue;
            };
            let label = label.trim();
            let (type_name, static_field) = label
                .split_once(" (static variable: ")
                .map_or((label, None), |(name, field)| {
                    (name, Some(field.trim_end_matches(')').to_string()))
                });
            frames.push(DumpRootFrame {
                address: format!("0x{address:x}"),
                type_name: type_name.to_string(),
                static_field,
            });
            if address == target {
                return (frames, stack_method);
            }
        } else {
            frames.clear();
            if thread_root {
                stack_method = parse_stack_method(line).or(stack_method);
            }
        }
    }
    (Vec::new(), None)
}

fn parse_stack_method(line: &str) -> Option<String> {
    let (stack_pointer, rest) = line.split_once(char::is_whitespace)?;
    let (instruction_pointer, method) = rest.trim_start().split_once(char::is_whitespace)?;
    parse_address(stack_pointer)?;
    parse_address(instruction_pointer)?;
    let method = method.trim();
    method.contains('(').then(|| method.to_string())
}

async fn inspect_reference_with_tool(
    tool: &Path,
    path: &Path,
    parent: u64,
    child: Option<u64>,
) -> Result<DumpReference, String> {
    let output = run_sos(tool, path, &format!("dumpobj {parent:x}"), None).await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let type_name = stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix("Name:"))
        .map(str::trim);
    let Some(type_name) = type_name.filter(|_| output.status.success()) else {
        return Err(analysis_error(
            "Could not inspect this object.",
            &stdout,
            &String::from_utf8_lossy(&output.stderr),
        ));
    };
    let method_table = sos_address(&stdout, "MethodTable")
        .ok_or("SOS did not report the object's method table.")?;
    let assembly_path = stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix("File:"))
        .map(str::trim)
        .filter(|file| !file.is_empty())
        .map(str::to_owned);
    let fields = child.map_or_else(Vec::new, |child| {
        stdout
            .lines()
            .skip_while(|line| line.trim() != "Fields:")
            .skip(1)
            .filter_map(|line| {
                let mut columns = line.split_whitespace().rev();
                let name = columns.next()?;
                let value = parse_address(columns.next()?)?;
                let attribute = columns.next()?;
                let value_type = columns.next()?;
                (value == child
                    && matches!(value_type, "No" | "0")
                    && matches!(attribute, "instance" | "static" | "TLstatic"))
                .then(|| name.to_string())
            })
            .collect()
    });
    Ok(DumpReference {
        method_table: format!("0x{method_table:x}"),
        type_name: type_name.to_string(),
        assembly_path,
        fields,
    })
}

pub async fn module_identity(
    path: &Path,
    dump_id: &str,
    method_table: &str,
) -> Result<String, String> {
    let method_table = parse_address(method_table).ok_or("Invalid method table address.")?;
    let target = resolve_dump(path.to_owned(), Some(dump_id)).await?;
    let info = run_sos(
        &target.tool,
        &target.path,
        &format!("dumpmt {method_table:x}"),
        None,
    )
    .await?;
    let module = sos_address(&String::from_utf8_lossy(&info.stdout), "Module")
        .filter(|_| info.status.success())
        .ok_or("SOS could not identify the managed module in this dump.")?;
    let info = run_sos(
        &target.tool,
        &target.path,
        &format!("dumpmodule {module:x}"),
        None,
    )
    .await?;
    let stdout = String::from_utf8_lossy(&info.stdout);
    let metadata = stdout.lines().find_map(|line| {
        let (label, value) = line.trim().split_once(':')?;
        if !label.eq_ignore_ascii_case("Metadata start address") {
            return None;
        }
        let (address, size) = value.split_once('(')?;
        let (size, _) = size.split_once(' ')?;
        Some((
            parse_address(address.trim())?,
            size.replace(',', "").parse::<u64>().ok()?,
        ))
    });
    let mut identity = Err("Module metadata is unavailable in the dump.".to_string());
    if let Some((address, size)) = metadata.filter(|_| info.status.success()) {
        let path = target.path.clone();
        identity = tauri::async_runtime::spawn_blocking(move || {
            dump_file::module_mvid(&path, address, size)
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string());
    }
    if identity.is_err() && cfg!(windows) {
        let info = run_sos(&target.tool, &target.path, "clrmodules -v", None).await?;
        let address = module_image_base(&String::from_utf8_lossy(&info.stdout), module)
            .filter(|_| info.status.success());
        if let Some(address) = address {
            let path = target.path.clone();
            identity =
                tauri::async_runtime::spawn_blocking(move || dump_file::codeview(&path, address))
                    .await
                    .map_err(|error| error.to_string())?
                    .map_err(|error| error.to_string());
        }
    }
    target.verify().await?;
    identity.map_err(|error| format!("Could not verify the assembly against this dump. {error}"))
}

fn module_image_base(stdout: &str, module: u64) -> Option<u64> {
    let mut image_base = None;
    let mut module_address = None;
    for (field, value) in stdout
        .lines()
        .filter_map(|line| line.trim().split_once(':'))
    {
        match field {
            "AssemblyName" => {
                if module_address == Some(module) {
                    return image_base;
                }
                image_base = None;
                module_address = None;
            }
            "ImageBase" => image_base = parse_address(value.trim()),
            "ModuleAddress" => module_address = parse_address(value.trim()),
            _ => {}
        }
    }
    image_base.filter(|_| module_address == Some(module))
}

fn sos_address(stdout: &str, field: &str) -> Option<u64> {
    stdout.lines().find_map(|line| {
        let (label, value) = line.trim().split_once(':')?;
        (label == field)
            .then(|| parse_address(value.trim()))
            .flatten()
    })
}

fn parse_address(text: &str) -> Option<u64> {
    let hex = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .unwrap_or(text);
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(hex, 16)
        .ok()
        .filter(|&address| address != 0)
}

fn root_count(stdout: &str) -> Option<u64> {
    stdout.lines().rev().find_map(|line| {
        let mut fields = line.trim().strip_prefix("Found ")?.split_whitespace();
        let count = parse_count(fields.next()?)?;
        let label = fields.next()?;
        let noun = if label == "unique" {
            fields.next()?
        } else {
            label
        };
        matches!(noun.trim_end_matches('.'), "root" | "roots").then_some(count)
    })
}

fn find_dotnet_dump() -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        "dotnet-dump.exe"
    } else {
        "dotnet-dump"
    };
    let path = std::env::var_os("PATH").unwrap_or_default();
    // Global .NET tools may be absent from PATH when the app is launched from the desktop.
    let profile = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    let tools = profile.map(|home| PathBuf::from(home).join(".dotnet").join("tools"));
    std::env::split_paths(&path)
        .chain(tools)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(exe))
        .find(|candidate| candidate.is_file())
}

fn analysis_error(error: &str, stdout: &str, stderr: &str) -> String {
    let detail = stderr
        .lines()
        .chain(
            stdout
                .lines()
                .take_while(|line| line.trim() != "Statistics:"),
        )
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("Loading core dump:"))
        .take(8)
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{error}\nUse a Full or Heap dump and a dotnet-dump installation compatible with its OS and architecture.{}",
        if detail.is_empty() {
            String::new()
        } else {
            format!("\n\n{detail}")
        }
    )
}

fn parse_heap(stdout: &str) -> Result<DumpHeap, String> {
    let mut lines = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let mut heap = DumpHeap {
        object_count: 0,
        total_bytes: 0,
        free_bytes: 0,
        types: Vec::new(),
        notices: Vec::new(),
    };

    // SOS can fail a debugger command and still exit successfully after the following "exit".
    // Require the statistics header and a footer that agrees with the parsed rows.
    let header = ["MT", "Count", "TotalSize", "Class", "Name"];
    loop {
        match lines.next() {
            Some(line) if line.split_whitespace().eq(header) => break,
            Some(line) if line != "Statistics:" && !line.starts_with("Loading core dump:") => {
                heap.notices.push(line.to_string());
            }
            Some(_) => {}
            None => return Err("dotnet-dump returned no managed heap statistics.".into()),
        }
    }

    let mut walked_objects = 0u64;
    let mut walked_bytes = 0u64;
    let overflow = || "The heap statistics exceed the supported numeric range.".to_string();
    for line in lines {
        if let Some(footer) = line.strip_prefix("Total ") {
            let mut fields = footer.split_whitespace();
            let count = fields.next().and_then(parse_count);
            let label = fields.next();
            let bytes_match = match label {
                Some("objects") => fields.next().is_none(),
                Some("objects,") => {
                    fields.next().and_then(parse_count) == Some(walked_bytes)
                        && fields.next() == Some("bytes")
                        && fields.next().is_none()
                }
                _ => false,
            };
            if count != Some(walked_objects) || !bytes_match {
                return Err("The heap totals did not match the type statistics.".into());
            }

            heap.types.sort_by(|a, b| {
                b.total_bytes
                    .cmp(&a.total_bytes)
                    .then_with(|| a.type_name.cmp(&b.type_name))
            });
            return Ok(heap);
        }

        let row = parse_type(line)
            .ok_or_else(|| format!("Could not read a heap statistics row. {line}"))?;
        walked_objects = walked_objects
            .checked_add(row.object_count)
            .ok_or_else(overflow)?;
        walked_bytes = walked_bytes
            .checked_add(row.total_bytes)
            .ok_or_else(overflow)?;
        if row.type_name == "Free" {
            heap.free_bytes += row.total_bytes;
        } else {
            heap.object_count += row.object_count;
            heap.total_bytes += row.total_bytes;
            heap.types.push(row);
        }
    }

    Err("dotnet-dump returned incomplete managed heap statistics.".into())
}

fn parse_type(line: &str) -> Option<DumpType> {
    let (method_table, rest) = line.split_once(char::is_whitespace)?;
    let (count, rest) = rest.trim_start().split_once(char::is_whitespace)?;
    let (bytes, name) = rest.trim_start().split_once(char::is_whitespace)?;
    let type_name = name.trim();
    if type_name.is_empty()
        || u64::from_str_radix(method_table.trim_start_matches("0x"), 16).is_err()
    {
        return None;
    }

    Some(DumpType {
        method_table: method_table.to_string(),
        type_name: type_name.to_string(),
        object_count: parse_count(count)?,
        total_bytes: parse_count(bytes)?,
    })
}

fn parse_count(value: &str) -> Option<u64> {
    if value.contains(',') {
        value.replace(',', "").parse().ok()
    } else {
        value.parse().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_address, parse_heap, parse_object_row, read_sos_output, root_count, root_frames,
    };
    use tauri::ipc::Channel;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn streams_progress_before_the_heap_summary_is_available() {
        tauri::async_runtime::block_on(async {
            let (reader, mut writer) = tokio::io::duplex(1024);
            let (send, receive) = std::sync::mpsc::channel();
            let progress = Channel::<String>::new(move |message| {
                send.send(message.deserialize::<String>().unwrap()).unwrap();
                Ok(())
            });
            let result =
                tokio::spawn(async move { read_sos_output(reader, Some(&progress), None).await });

            writer
                .write_all(b"Scanning heap: 2,000 MB / 20,000 MB (10%)...\n")
                .await
                .unwrap();
            let received = tauri::async_runtime::spawn_blocking(move || {
                receive.recv_timeout(std::time::Duration::from_secs(2))
            })
            .await
            .unwrap()
            .unwrap();
            assert_eq!(received, "Scanning heap: 2,000 MB / 20,000 MB (10%)...");

            writer.write_all(b"Statistics:\nMT Count TotalSize Class Name\nabc 2 48 SessionRecord\nTotal 2 objects\n")
                .await.unwrap();
            drop(writer);
            let output = result.await.unwrap().unwrap();
            assert_eq!(
                parse_heap(&String::from_utf8(output.bytes).unwrap())
                    .unwrap()
                    .object_count,
                2
            );
        });
    }

    #[test]
    fn retains_the_first_root_and_summary_from_a_large_legacy_trace() {
        tauri::async_runtime::block_on(async {
            let mut stdout =
                b"HandleTable:\n    -> 0000000123 Example.Cache\n    -> 0000000abc Example.Item\n"
                    .to_vec();
            // Include both a large line and many subsequent paths.
            stdout.extend(std::iter::repeat(b'x').take(100_000));
            stdout.push(b'\n');
            for _ in 0..20_000 {
                stdout.extend_from_slice(b"    -> 0000000abc Example.Item\n");
            }
            stdout.extend_from_slice(b"Found 20,001 unique roots.");
            let capture = read_sos_output(stdout.as_slice(), None, Some(128))
                .await
                .unwrap();
            assert!(capture.truncated);
            assert!(capture.bytes.len() <= 128 + 32);
            let text = String::from_utf8(capture.bytes).unwrap();
            assert_eq!(root_count(&text), Some(20_001));
            assert_eq!(root_frames(&text, 0xabc).0.len(), 2);
        });
    }

    #[test]
    fn parses_a_sampled_object_and_its_stack_root() {
        let object = parse_object_row("0000000abc 0000000def 131,096", 0xdef).unwrap();
        assert_eq!(object.address, "0xabc");
        assert_eq!(object.size_bytes, 131096);
        assert!(parse_object_row("0000000abc 0000000def 131,096", 0xfff).is_none());
        let (frames, method) = root_frames(
            "Thread 42:\n 001010 001040 Example.CachedService.Process()\n   rbx:\n   -> 0000000123 Example.CachedService\n   -> 0000000abc System.Byte[]",
            0xabc,
        );
        assert_eq!(method.as_deref(), Some("Example.CachedService.Process()"));
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].address, "0x123");
    }

    #[test]
    fn distinguishes_an_unrooted_object_from_an_unsuccessful_root_search() {
        assert_eq!(root_count("Found 0 unique roots."), Some(0));
        assert_eq!(
            root_count("Found 1 unique roots (run 'GCRoot -all' to see all roots)."),
            Some(1)
        );
        assert_eq!(
            root_count("Found 1 reference.\nCould not walk the heap."),
            None
        );
        assert_eq!(parse_address("0xABC"), Some(0xabc));
        assert_eq!(parse_address("abcd; exit"), None);
    }

    #[cfg(unix)]
    #[test]
    fn retries_gcroot_without_the_limit_when_sos_rejects_its_operands() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("memoryspy-gcroot-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let tool = dir.join("dotnet-dump");
        fs::write(
            &tool,
            r#"#!/bin/sh
case "$4" in
    'gcroot -limit 1 1dacfc00de8')
        printf '%s\n' "Unrecognized command or argument '1'" \
            "Unrecognized command or argument '1dacfc00de8'" \
            'gcroot:' 'Usage:' '  > gcroot [options] [<target>]' >&2
        ;;
    'gcroot 1dacfc00de8')
        printf '%s\n' 'HandleTable:' '  -> 000001dacfc00de8 System.Byte[]' 'Found 1 unique roots.'
        ;;
    'gcroot 2dacfc00de8')
        printf '%s\n' 'Found 0 unique roots.'
        ;;
    *) exit 1 ;;
esac
"#,
        )
        .unwrap();
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o700)).unwrap();
        let target = super::DumpTarget {
            id: String::new(),
            path: dir.join("sample.dmp"),
            tool,
        };
        let progress = Channel::new(|_| Ok(()));
        let result = tauri::async_runtime::block_on(super::find_roots(
            &target,
            &[0x1dacfc00de8, 0x2dacfc00de8],
            &progress,
        ));
        fs::remove_dir_all(dir).unwrap();

        let roots = result.unwrap();
        assert_eq!(roots.samples_checked, 2);
        assert_eq!(roots.paths.len(), 1);
        assert_eq!(roots.paths[0].frames[0].address, "0x1dacfc00de8");
    }

    #[test]
    fn reads_sos_heap_statistics_without_counting_free_space_as_objects() {
        let output = "\
Loading core dump: C:\\dumps\\common 1.dmp ...
Statistics:
          MT  Count TotalSize Class Name
00000000abcd      3       120 SessionRecord
00000000abce      1       300 Free
00000000abcf  1,000    40,000 System.Collections.Generic.Dictionary<System.Guid, SessionRecord>
Total 1,004 objects, 40,420 bytes";
        let heap = parse_heap(output).unwrap();
        assert_eq!(heap.object_count, 1003);
        assert_eq!(heap.total_bytes, 40120);
        assert_eq!(heap.free_bytes, 300);
        assert_eq!(heap.types.len(), 2);
        assert_eq!(
            heap.types[0].type_name,
            "System.Collections.Generic.Dictionary<System.Guid, SessionRecord>"
        );
        assert_eq!(heap.types[1].method_table, "00000000abcd");
    }

    #[test]
    fn requires_a_complete_sos_statistics_table() {
        assert!(
            parse_heap("Loading core dump: test.dmp ...\nFailed to load data access module.")
                .is_err()
        );
        let table = "Statistics:\nMT Count TotalSize Class Name\nabcd 4 96 SessionRecord\n";
        assert!(parse_heap(table).is_err());
        assert!(parse_heap(&format!("{table}Total 5 objects")).is_err());
        assert!(parse_heap(&format!("{table}Total 4 objects, 120 bytes")).is_err());
        assert!(parse_heap(&format!("{table}Total 4 objects")).is_ok());
    }
}
