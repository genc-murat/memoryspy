//! Revealing a recorded artifact in the platform's file manager.
//!
//! The app is the only party that knows where a capture went: a deep capture is written to a
//! temp path chosen by the collector, and a container capture is copied into the app's
//! recordings folder. A path printed in the rail is therefore useful only if the user can get
//! from it to the file — which means the *host* has to ask the OS, because a webview cannot
//! launch an application.
//!
//! The same call is where "the file is gone" belongs. Opening the parent folder and letting the
//! user hunt for a name that is not there looks like the button failed; a one-sentence answer
//! that says the file was moved or deleted is the honest one.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// The three file-manager conventions this app has to speak.
///
/// A value rather than a `cfg!` chain inside [`reveal`] so the arguments for all three can be
/// asserted on any one machine: only the host's own variant is ever launched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Platform {
    MacOs,
    Windows,
    Linux,
}

/// How long to watch a launcher that may legitimately stay attached to its window.
///
/// `xdg-open` on some desktops stays in the foreground for as long as the file-manager window
/// is open, so waiting for it would park a thread until the user closed that window. A launcher
/// that fails — nothing registered for the file, no desktop session — exits at once with an
/// explanation, which is the case this window exists to catch.
const LAUNCH_GRACE: Duration = Duration::from_millis(1500);

/// How often the launcher is checked while it is inside that window.
const LAUNCH_POLL: Duration = Duration::from_millis(25);

fn host_platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::MacOs
    } else if cfg!(target_os = "windows") {
        Platform::Windows
    } else {
        Platform::Linux
    }
}

/// The program and arguments that show `path` in the host's file manager.
///
/// Only macOS and Windows can select the file itself. `xdg-open` takes a directory and nothing
/// else, so on Linux the folder opens and the user finds the file by the name the rail showed.
fn command_for(platform: Platform, path: &Path) -> (String, Vec<String>) {
    let shown = path.display().to_string();

    match platform {
        // `-R` is "reveal": open the enclosing folder with the file already selected.
        Platform::MacOs => ("open".to_string(), vec!["-R".to_string(), shown]),
        // The comma is part of the argument, not a separator: `explorer /select,<path>`.
        Platform::Windows => ("explorer".to_string(), vec![format!("/select,{shown}")]),
        Platform::Linux => {
            let folder = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."));
            ("xdg-open".to_string(), vec![folder.display().to_string()])
        }
    }
}

/// Shows `path` in the file manager, or explains why there is nothing to show.
pub fn reveal(path: &str) -> Result<(), String> {
    let path = Path::new(path);

    // Checked here rather than left to the launcher because the launcher's wording differs per
    // platform and per file manager, and the UI should not have to translate three of them.
    //
    // "The file" rather than "the capture": the same command serves captures, recordings and
    // whatever artifact a future panel grows, and the path underneath says which one it is.
    if !path.exists() {
        return Err(format!(
            "The file is no longer at {} — it has been moved or deleted.",
            path.display()
        ));
    }

    let platform = host_platform();
    let (program, arguments) = command_for(platform, path);

    let mut command = Command::new(&program);
    command
        .args(&arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null());
    crate::collector::without_console_window(&mut command);

    match platform {
        // `open` hands the request to Finder and exits, so its status is the only way to learn
        // that the file disappeared between the check above and this call.
        Platform::MacOs => {
            let output = command
                .stderr(Stdio::piped())
                .output()
                .map_err(|error| launch_error(&program, path, &error))?;

            if output.status.success() {
                return Ok(());
            }

            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if detail.is_empty() {
                format!("Could not show {} in Finder.", path.display())
            } else {
                detail
            })
        }
        // `xdg-open` gets one moment of attention: a launcher with nowhere to go fails at once
        // with a message more specific than anything this module could invent, and reporting
        // nothing while the user waits for a window is the worst of the three outcomes.
        Platform::Linux => {
            let mut child = command
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|error| launch_error(&program, path, &error))?;

            let deadline = Instant::now() + LAUNCH_GRACE;
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => return launcher_answer(&program, path, &mut child, status),
                    Ok(None) if Instant::now() < deadline => thread::sleep(LAUNCH_POLL),
                    Ok(None) => {
                        // Still running: the file manager is attached to it. Reaped on its own
                        // thread, because a child nobody waits for lingers as a zombie for as
                        // long as the app runs — one per click is a leak the user never sees.
                        thread::spawn(move || {
                            let _ = child.wait();
                        });
                        return Ok(());
                    }
                    Err(error) => {
                        return Err(format!(
                            "Could not check {program} ({error}). The file is still there."
                        ));
                    }
                }
            }
        }
        // `explorer.exe` exits with 1 even after it selected the file, so its status says
        // nothing. Nothing needs reaping on Windows either: dropping the handle closes it.
        Platform::Windows => command
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|error| launch_error(&program, path, &error)),
    }
}

/// Turns a launcher's exit status into the caller's answer.
///
/// The launcher's own stderr wins when it has one: `xdg-open` names the missing handler or the
/// file it could not open, which is more useful than anything this module could say about it.
fn launcher_answer(
    program: &str,
    path: &Path,
    child: &mut Child,
    status: ExitStatus,
) -> Result<(), String> {
    if status.success() {
        return Ok(());
    }

    let mut detail = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut detail);
    }
    let detail = detail.trim();

    Err(if detail.is_empty() {
        format!("{program} could not show {} ({status}).", path.display())
    } else {
        detail.to_string()
    })
}

fn launch_error(program: &str, path: &Path, error: &std::io::Error) -> String {
    format!(
        "Could not open {program} to show {} ({error}). The file is still there.",
        path.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The message the UI puts next to the path: it has to name both facts, because "could not
    /// reveal" alone leaves the user unsure whether the file is gone or the button is broken.
    #[test]
    fn a_missing_file_says_it_was_moved_or_deleted() {
        let path = std::env::temp_dir().join("memoryspy-reveal-does-not-exist.nettrace");
        let _ = std::fs::remove_file(&path);

        let error = reveal(path.to_str().unwrap())
            .expect_err("a path with no file behind it must not be reported as revealed");

        assert!(
            error.contains("moved or deleted"),
            "the message must say why nothing opened, got: {error}"
        );
        assert!(
            error.contains(&path.display().to_string()),
            "the message must name the file the user is looking for, got: {error}"
        );
    }

    /// Each platform's file manager takes its own flag, and Windows folds the path into the
    /// flag itself. Getting this wrong opens a folder with nothing selected, which looks like
    /// the feature is half-working.
    fn arguments(values: &[String]) -> Vec<&str> {
        values.iter().map(String::as_str).collect()
    }

    #[test]
    fn each_platform_reveals_the_file_the_way_its_manager_expects() {
        let path = Path::new("/tmp/capture-4242.nettrace");

        let (program, args) = command_for(Platform::MacOs, path);
        assert_eq!(program, "open");
        assert_eq!(arguments(&args), vec!["-R", "/tmp/capture-4242.nettrace"]);

        let (program, args) = command_for(Platform::Windows, path);
        assert_eq!(program, "explorer");
        assert_eq!(arguments(&args), vec!["/select,/tmp/capture-4242.nettrace"]);

        // xdg-open cannot select, but it can be pointed at the folder that contains the file.
        let (program, args) = command_for(Platform::Linux, path);
        assert_eq!(program, "xdg-open");
        assert_eq!(arguments(&args), vec!["/tmp"]);
    }

    /// A bare file name has no parent to open; the current directory is the useful answer.
    #[test]
    fn a_bare_file_name_opens_the_current_directory() {
        let (_, args) = command_for(Platform::Linux, Path::new("capture-4242.nettrace"));
        assert_eq!(arguments(&args), vec!["."]);
    }

    /// A launcher that finishes inside the grace window is judged by its status, and its own
    /// stderr is what the user gets — `xdg-open` names the real problem (no handler, no
    /// session), where a generic "could not show" would leave them guessing.
    #[cfg(unix)]
    #[test]
    fn a_finished_launcher_is_judged_by_its_status_and_message() {
        fn finish(body: &str) -> (Child, ExitStatus) {
            let mut child = Command::new("/bin/sh")
                .args(["-c", body])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .expect("the test's own launcher must start");
            let status = child.wait().expect("the test's launcher must finish");
            (child, status)
        }

        let path = Path::new("/tmp/capture-4242.nettrace");

        let (mut ok, status) = finish("exit 0");
        assert!(
            launcher_answer("xdg-open", path, &mut ok, status).is_ok(),
            "a launcher that exited cleanly must not be an error"
        );

        let (mut failed, status) = finish("echo 'no handler registered for this file' >&2; exit 3");
        let error = launcher_answer("xdg-open", path, &mut failed, status)
            .expect_err("a non-zero exit must not be reported as a success");
        assert!(
            error.contains("no handler registered for this file"),
            "the launcher's own message was lost: {error}"
        );

        // A launcher that fails without a word still has to say which file it was asked about.
        let (mut silent, status) = finish("exit 4");
        let error = launcher_answer("xdg-open", path, &mut silent, status)
            .expect_err("a non-zero exit must not be reported as a success");
        assert!(
            error.contains("xdg-open") && error.contains("/tmp/capture-4242.nettrace"),
            "the fallback must name the launcher and the file: {error}"
        );
    }

    /// The live check: hand a real artifact to the real file manager.
    ///
    /// Ignored by default because it opens a window on the machine running it, which no CI
    /// should do. The interesting artifact is one the app actually produced — a capture copied
    /// out of a container is the best case, because that file's path is exactly what the rail
    /// shows and what used to be unreachable:
    ///
    /// ```text
    /// MEMORYSPY_REVEAL_LIVE=/path/to/capture.nettrace \
    ///   cargo test --lib -- --ignored --exact reveal::tests::live_reveal_hands_a_real_file_to_the_file_manager
    /// ```
    #[test]
    #[ignore = "opens a file manager window on the machine running it"]
    fn live_reveal_hands_a_real_file_to_the_file_manager() {
        let path = std::env::var("MEMORYSPY_REVEAL_LIVE")
            .expect("point MEMORYSPY_REVEAL_LIVE at a file that exists");
        assert!(Path::new(&path).exists(), "nothing to reveal at {path}");

        reveal(&path).expect("an existing file must be handed to the file manager");

        // The open window is the assertion; nothing in this process can observe it. The pause
        // makes that explicit: without it the test would report success before the file manager
        // has drawn anything, which reads as a pass even when the window never appears.
        std::thread::sleep(Duration::from_secs(2));
    }
}
