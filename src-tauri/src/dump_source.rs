use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::collector::{resolve_launch, without_console_window, CollectorLocation};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpSourceLocation {
    source_file: String,
    source_line: u32,
    method_name: String,
    is_method_location: bool,
    sha256: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePreview {
    first_line: usize,
    lines: Vec<String>,
}

pub async fn resolve(
    collector: &CollectorLocation,
    assembly: &Path,
    module_identity: &str,
    type_name: &str,
    method_name: Option<&str>,
) -> Result<DumpSourceLocation, String> {
    if !assembly.is_absolute() {
        return Err("Select the local assembly built for this dump.".into());
    }

    let (program, arguments) = resolve_launch(collector)?;
    let mut command = Command::new(program);
    command
        .args(arguments)
        .arg("dump-source")
        .arg(assembly)
        .arg(module_identity)
        .arg(type_name)
        .stdin(Stdio::null());
    if let Some(method_name) = method_name {
        command.arg(method_name);
    }
    without_console_window(&mut command);
    let output = tokio::process::Command::from(command)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| format!("Could not run the source lookup. {error}"))?;

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Ok(message) = serde_json::from_str::<serde_json::Value>(line) {
            if message["type"] == "dump.source" && output.status.success() {
                return serde_json::from_value(message["data"].clone())
                    .map_err(|error| error.to_string());
            }
            if message["type"] == "error" {
                let message = &message["data"];
                let summary = message["message"]
                    .as_str()
                    .unwrap_or("Source lookup failed.");
                return Err(match message["detail"].as_str() {
                    Some(detail) => format!("{summary} {detail}"),
                    None => summary.to_string(),
                });
            }
        }
    }
    Err("The collector did not return a source location. Rebuild or update the collector.".into())
}

pub fn preview(path: &Path, line: u32, sha256: Option<&str>) -> Result<SourcePreview, String> {
    const MAX_SOURCE_BYTES: u64 = 8 * 1024 * 1024;
    let is_source = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["cs", "fs", "vb"]
                .iter()
                .any(|valid| valid.eq_ignore_ascii_case(extension))
        });
    if line == 0 || !path.is_absolute() || !is_source {
        return Err("Choose a local C#, F# or Visual Basic source file.".into());
    }

    let metadata = path
        .metadata()
        .map_err(|error| format!("Could not open the local source file. {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
        return Err("Choose a regular source file under 8 MiB.".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(MAX_SOURCE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("Could not read the local source file. {error}"))?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err("Choose a source file under 8 MiB.".into());
    }
    if let Some(expected) = sha256 {
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if !expected.eq_ignore_ascii_case(&actual) {
            return Err("This source file differs from the version recorded in the PDB. Choose the file from that build.".into());
        }
    }

    let source = std::str::from_utf8(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
        .map_err(|_| "Source preview requires a UTF-8 file.")?;
    let index = line as usize - 1;
    let start = index.saturating_sub(5);
    let lines: Vec<_> = source
        .lines()
        .skip(start)
        .take(index - start + 6)
        .map(str::to_owned)
        .collect();
    if lines.len() <= index - start {
        return Err("The source file does not contain the recorded line.".into());
    }
    Ok(SourcePreview {
        first_line: start + 1,
        lines,
    })
}
