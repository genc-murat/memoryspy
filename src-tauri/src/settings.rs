//! Persisted application settings.
//!
//! Settings are stored as JSON in the platform's app config directory. Keeping them in a
//! plain file (rather than a database) means a user can inspect, diff and hand-edit them,
//! which matters for a diagnostic tool that people will want to configure per machine.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Which process the app last attached to, so a restart can offer to resume.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LastSession {
    pub pid: i32,
    pub name: String,
    #[serde(default)]
    pub at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Override the auto-discovered collector assembly path.
    #[serde(default)]
    pub collector_path: Option<String>,

    /// Probes enabled by default when a session starts. Empty means "all".
    #[serde(default)]
    pub default_probes: Vec<String>,

    #[serde(default = "default_interval")]
    pub interval_ms: u32,

    #[serde(default = "default_max_types")]
    pub max_allocation_types: u32,

    /// Seconds of history kept in the charts.
    #[serde(default = "default_history")]
    pub history_seconds: u32,

    /// Also show counters in the "other" category, which are hidden by default.
    #[serde(default)]
    pub show_all_counters: bool,

    #[serde(default)]
    pub verbose_collector: bool,

    #[serde(default)]
    pub last_session: Option<LastSession>,
}

fn default_interval() -> u32 {
    1000
}

fn default_max_types() -> u32 {
    150
}

fn default_history() -> u32 {
    300
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            collector_path: None,
            default_probes: Vec::new(),
            interval_ms: default_interval(),
            max_allocation_types: default_max_types(),
            history_seconds: default_history(),
            show_all_counters: false,
            verbose_collector: false,
            last_session: None,
        }
    }
}

impl Settings {
    /// Clamp values that would break the collector or the charts if a user hand-edited them.
    pub fn sanitize(&mut self) {
        self.interval_ms = self.interval_ms.clamp(200, 10_000);
        self.max_allocation_types = self.max_allocation_types.clamp(10, 2_000);
        self.history_seconds = self.history_seconds.clamp(30, 3_600);
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve the app config directory: {e}"))?;

    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };

    let mut settings = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default();

    settings.sanitize();
    settings
}

/// Writes settings, creating the config directory if needed.
///
/// Writes go to a temporary file first so a crash mid-write cannot leave a truncated
/// settings file behind — a corrupted config would make the app unusable until deleted.
pub fn save(app: &AppHandle, mut settings: Settings) -> Result<Settings, String> {
    settings.sanitize();

    let path = settings_path(app)?;
    let serialized = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;

    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serialized).map_err(|e| format!("Could not write {}: {e}", temp.display()))?;
    fs::rename(&temp, &path).map_err(|e| format!("Could not replace {}: {e}", path.display()))?;

    Ok(settings)
}
