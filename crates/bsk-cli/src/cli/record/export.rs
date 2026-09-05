use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use anyhow::Context;
use bsk_protocol::tools::{RecordedTrace, TRACE_VERSION_V2, TRACE_VERSION_V3, TRACE_VERSION_V4};

use crate::cli::error::CliError;

#[derive(Debug)]
pub(super) struct ExportMeta {
    pub(super) states_dir: Option<PathBuf>,
    pub(super) trace_version: u32,
    /// True when the extension fell back to legacy v2 without page states.
    pub(super) v2_fallback: bool,
}

pub(super) fn states_dir_for_output(output_dir: &Path) -> PathBuf {
    output_dir.join("states")
}

pub(super) fn trace_json_path(output_dir: &Path) -> PathBuf {
    output_dir.join("trace.json")
}

fn looks_like_json_output(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
}

fn legacy_json_output_error(path: &Path) -> CliError {
    CliError::Local(anyhow::anyhow!(
        "--output {} is a JSON file path; state-linked traces write a bundle directory \
         (`<dir>/trace.json` and `<dir>/states/`), not a single file. \
         Use `--output trace` or another directory.",
        path.display()
    ))
}

pub(super) fn validate_record_output(path: &Path) -> Result<(), CliError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(CliError::Local(anyhow::anyhow!(
            "--output {} must not be a symlink",
            path.display()
        ))),
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) if looks_like_json_output(path) => Err(legacy_json_output_error(path)),
        Ok(_) => Err(CliError::Local(anyhow::anyhow!(
            "--output {} is not a directory; state-linked traces write `<dir>/trace.json` and `<dir>/states/`. Use `--output trace`.",
            path.display()
        ))),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            if looks_like_json_output(path) {
                Err(legacy_json_output_error(path))
            } else {
                Ok(())
            }
        }
        Err(err) => Err(CliError::Local(
            anyhow::Error::new(err).context(format!("inspect --output {}", path.display())),
        )),
    }
}

fn validate_bundle_directory(path: &Path, description: &str) -> Result<(), CliError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(CliError::Local(anyhow::anyhow!(
            "{description} {} must not be a symlink",
            path.display()
        ))),
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(CliError::Local(anyhow::anyhow!(
            "{description} {} is not a directory",
            path.display()
        ))),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(CliError::Local(
            anyhow::Error::new(err).context(format!("inspect {description} {}", path.display())),
        )),
    }
}

fn validate_replaceable_file(path: &Path, description: &str) -> Result<(), CliError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Ok(_) => Err(CliError::Local(anyhow::anyhow!(
            "{description} {} is not a regular file",
            path.display()
        ))),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(CliError::Local(
            anyhow::Error::new(err).context(format!("inspect {description} {}", path.display())),
        )),
    }
}

fn acquire_export_lock(output_dir: &Path) -> Result<std::fs::File, CliError> {
    validate_record_output(output_dir)?;
    fs::create_dir_all(output_dir)
        .with_context(|| format!("create output dir {}", output_dir.display()))
        .map_err(CliError::Local)?;
    let lock_path = output_dir.join(".bsk-record-export.lock");
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .with_context(|| format!("open export lock {}", lock_path.display()))
        .map_err(CliError::Local)?;
    fs2::FileExt::lock_exclusive(&lock_file)
        .with_context(|| format!("lock export bundle {}", output_dir.display()))
        .map_err(CliError::Local)?;
    Ok(lock_file)
}

fn is_canonical_state_id(id: &str) -> bool {
    let Some(number) = id.strip_prefix('s') else {
        return false;
    };
    let mut digits = number.bytes();
    matches!(digits.next(), Some(b'1'..=b'9')) && digits.all(|byte| byte.is_ascii_digit())
}

fn is_generated_state_name(name: &str) -> bool {
    name.strip_suffix(".txt").is_some_and(is_canonical_state_id)
}

fn commit_staged_file(staged: &Path, target: &Path, backup: &Path) -> io::Result<Option<PathBuf>> {
    let old_file = match fs::symlink_metadata(target) {
        Ok(_) => {
            fs::rename(target, backup)?;
            Some(backup.to_path_buf())
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => None,
        Err(err) => return Err(err),
    };

    if let Err(err) = fs::rename(staged, target) {
        if let Some(old_file) = old_file.as_deref() {
            if let Err(restore_err) = fs::rename(old_file, target) {
                return Err(io::Error::new(
                    restore_err.kind(),
                    format!(
                        "{err}; additionally failed to restore {}: {restore_err}",
                        target.display()
                    ),
                ));
            }
        }
        return Err(err);
    }
    Ok(old_file)
}

fn rollback_installed_files(installed: &[(PathBuf, Option<PathBuf>)]) -> io::Result<()> {
    let mut rollback_error = None;
    for (target, backup) in installed.iter().rev() {
        match fs::remove_file(target) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => {
                rollback_error.get_or_insert(err);
                continue;
            }
        }
        if let Some(backup) = backup {
            if let Err(err) = fs::rename(backup, target) {
                rollback_error.get_or_insert(err);
            }
        }
    }
    match rollback_error {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

fn restore_staged_stale_states(staged: &[(PathBuf, PathBuf)]) -> io::Result<()> {
    let mut restore_error = None;
    for (original, backup) in staged.iter().rev() {
        if let Err(err) = fs::rename(backup, original) {
            restore_error.get_or_insert(err);
        }
    }
    match restore_error {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

/// Move stale generated state files aside so stale cleanup participates in the
/// same rollback boundary as trace/state replacement. User files are untouched.
fn stage_stale_states(
    states_dir: &Path,
    keep: &HashSet<String>,
    transaction_id: uuid::Uuid,
) -> Result<Vec<(PathBuf, PathBuf)>, CliError> {
    let entries = match fs::read_dir(states_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(CliError::Local(
                anyhow::Error::new(err)
                    .context(format!("read states dir {}", states_dir.display())),
            ));
        }
    };

    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                let restore = restore_staged_stale_states(&staged);
                return Err(CliError::Local(anyhow::anyhow!(match restore {
                    Ok(()) => format!("read stale state entry: {err}"),
                    Err(restore_err) => format!(
                        "read stale state entry: {err}; restore also failed: {restore_err}"
                    ),
                })));
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_generated_state_name(name) || keep.contains(name) {
            continue;
        }
        let original = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(err) => {
                let restore = restore_staged_stale_states(&staged);
                return Err(CliError::Local(anyhow::anyhow!(match restore {
                    Ok(()) => format!("inspect stale state {}: {err}", original.display()),
                    Err(restore_err) => format!(
                        "inspect stale state {}: {err}; restore also failed: {restore_err}",
                        original.display()
                    ),
                })));
            }
        };
        if !file_type.is_file() {
            let restore = restore_staged_stale_states(&staged);
            return Err(CliError::Local(anyhow::anyhow!(match restore {
                Ok(()) => format!("stale state {} is not a regular file", original.display()),
                Err(restore_err) => format!(
                    "stale state {} is not a regular file; restore also failed: {restore_err}",
                    original.display()
                ),
            })));
        }

        let backup = states_dir.join(format!(".{name}.{transaction_id}.stale"));
        if let Err(err) = fs::rename(&original, &backup) {
            let restore = restore_staged_stale_states(&staged);
            return Err(CliError::Local(anyhow::anyhow!(match restore {
                Ok(()) => format!("stage stale state {}: {err}", original.display()),
                Err(restore_err) => format!(
                    "stage stale state {}: {err}; restore also failed: {restore_err}",
                    original.display()
                ),
            })));
        }
        staged.push((original, backup));
    }
    Ok(staged)
}

fn commit_export_transaction(
    staging_dir: &Path,
    states_dir: &Path,
    keep_states: &HashSet<String>,
    transaction_id: uuid::Uuid,
    replacements: Vec<(PathBuf, PathBuf, PathBuf)>,
) -> Result<(), CliError> {
    let mut installed = Vec::with_capacity(replacements.len());
    for (staged, target, backup) in replacements {
        match commit_staged_file(&staged, &target, &backup) {
            Ok(old_file) => installed.push((target, old_file)),
            Err(err) => {
                let rollback = rollback_installed_files(&installed);
                let _ = fs::remove_dir_all(staging_dir);
                return Err(CliError::Local(anyhow::anyhow!(match rollback {
                    Ok(()) => format!("commit replacement {}: {err}", target.display()),
                    Err(rollback_err) => format!(
                        "commit replacement {}: {err}; rollback also failed: {rollback_err}",
                        target.display()
                    ),
                })));
            }
        }
    }

    let stale_states = match stage_stale_states(states_dir, keep_states, transaction_id) {
        Ok(stale) => stale,
        Err(err) => {
            let rollback = rollback_installed_files(&installed);
            let _ = fs::remove_dir_all(staging_dir);
            return Err(CliError::Local(anyhow::anyhow!(match rollback {
                Ok(()) => err.to_string(),
                Err(rollback_err) => {
                    format!("{err}; replacement rollback also failed: {rollback_err}")
                }
            })));
        }
    };

    for (_, backup) in &installed {
        if let Some(backup) = backup {
            let _ = fs::remove_file(backup);
        }
    }
    for (_, backup) in stale_states {
        let _ = fs::remove_file(backup);
    }
    let _ = fs::remove_dir_all(staging_dir);
    Ok(())
}

struct ExternalizedState {
    filename: String,
    body: String,
}

fn externalize_state_bodies(
    trace: &RecordedTrace,
    expected_version: u32,
) -> Result<(serde_json::Value, Vec<ExternalizedState>), CliError> {
    let mut value = serde_json::to_value(trace)
        .context("serialize trace bundle")
        .map_err(CliError::Local)?;
    let envelope = value.as_object_mut().ok_or_else(|| {
        CliError::Local(anyhow::anyhow!("recorded trace must serialize to an object"))
    })?;
    let actual_version = envelope
        .get("version")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| CliError::Local(anyhow::anyhow!("state-linked trace has no version")))?;
    if actual_version != u64::from(expected_version) {
        return Err(CliError::Local(anyhow::anyhow!(
            "trace version {actual_version} does not match expected {expected_version}"
        )));
    }
    let states = envelope
        .get_mut("states")
        .and_then(|value| value.as_array_mut())
        .ok_or_else(|| CliError::Local(anyhow::anyhow!("state-linked trace has no states[]")))?;

    let mut seen = HashSet::with_capacity(states.len());
    let mut externalized = Vec::with_capacity(states.len());
    for state in states {
        let object = state.as_object_mut().ok_or_else(|| {
            CliError::Local(anyhow::anyhow!("trace state must be an object"))
        })?;
        let id = object
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::to_owned)
            .ok_or_else(|| CliError::Local(anyhow::anyhow!("trace state has no id")))?;
        if !is_canonical_state_id(&id) {
            return Err(CliError::Local(anyhow::anyhow!(
                "state id {id:?} is not canonical (expected s1, s2, ...)"
            )));
        }
        if !seen.insert(id.clone()) {
            return Err(CliError::Local(anyhow::anyhow!("duplicate state id {id:?}")));
        }
        let body = object
            .remove("body")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or_else(|| CliError::Local(anyhow::anyhow!("trace state {id} has no body")))?;
        let filename = format!("{id}.txt");
        object.insert("page".into(), serde_json::Value::String(filename.clone()));
        externalized.push(ExternalizedState { filename, body });
    }
    Ok((value, externalized))
}

fn write_state_bundle(
    output_dir: &Path,
    trace: &RecordedTrace,
    version: u32,
) -> Result<PathBuf, CliError> {
    let (disk_trace, state_writes) = externalize_state_bodies(trace, version)?;
    let states_dir = states_dir_for_output(output_dir);
    let trace_path = trace_json_path(output_dir);

    let _lock = acquire_export_lock(output_dir)?;
    validate_bundle_directory(&states_dir, "states directory")?;
    fs::create_dir_all(&states_dir)
        .with_context(|| format!("create states dir {}", states_dir.display()))
        .map_err(CliError::Local)?;

    let mut keep = HashSet::with_capacity(state_writes.len());
    for state in &state_writes {
        let target = states_dir.join(&state.filename);
        if target.parent() != Some(states_dir.as_path()) {
            return Err(CliError::Local(anyhow::anyhow!(
                "state path {} escapes states directory {}",
                target.display(),
                states_dir.display()
            )));
        }
        validate_replaceable_file(&target, "state observation")?;
        keep.insert(state.filename.clone());
    }
    validate_replaceable_file(&trace_path, "trace JSON")?;

    let transaction_id = uuid::Uuid::new_v4();
    let staging_dir = output_dir.join(format!(".bsk-record-stage-{transaction_id}"));
    let staging_states = staging_dir.join("states");
    fs::create_dir_all(&staging_states)
        .with_context(|| format!("create staging dir {}", staging_states.display()))
        .map_err(CliError::Local)?;

    let stage_result: Result<(), CliError> = (|| {
        for state in &state_writes {
            let staged = staging_states.join(&state.filename);
            fs::write(&staged, &state.body)
                .with_context(|| format!("write staged state observation {}", staged.display()))
                .map_err(CliError::Local)?;
        }
        let json = serde_json::to_string_pretty(&disk_trace)
            .context("serialize bundle trace JSON")
            .map_err(CliError::Local)?;
        let staged_trace = staging_dir.join("trace.json");
        fs::write(&staged_trace, format!("{json}\n"))
            .with_context(|| format!("write staged trace to {}", staged_trace.display()))
            .map_err(CliError::Local)?;
        Ok(())
    })();
    if let Err(err) = stage_result {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(err);
    }

    let mut replacements = Vec::with_capacity(state_writes.len() + 1);
    for state in &state_writes {
        replacements.push((
            staging_states.join(&state.filename),
            states_dir.join(&state.filename),
            states_dir.join(format!(".{}.{transaction_id}.bak", state.filename)),
        ));
    }
    replacements.push((
        staging_dir.join("trace.json"),
        trace_path,
        output_dir.join(format!(".trace.json.{transaction_id}.bak")),
    ));

    commit_export_transaction(
        &staging_dir,
        &states_dir,
        &keep,
        transaction_id,
        replacements,
    )?;
    Ok(states_dir)
}

fn write_trace_v2(output_dir: &Path, trace: &RecordedTrace) -> Result<(), CliError> {
    let trace_path = trace_json_path(output_dir);
    let states_dir = states_dir_for_output(output_dir);
    let json = serde_json::to_string_pretty(trace)
        .context("serialize trace JSON")
        .map_err(CliError::Local)?;

    let _lock = acquire_export_lock(output_dir)?;
    validate_replaceable_file(&trace_path, "trace JSON")?;
    let transaction_id = uuid::Uuid::new_v4();
    let staging_dir = output_dir.join(format!(".bsk-record-stage-{transaction_id}"));
    fs::create_dir_all(&staging_dir)
        .with_context(|| format!("create staging dir {}", staging_dir.display()))
        .map_err(CliError::Local)?;
    let staged_trace = staging_dir.join("trace.json");
    fs::write(&staged_trace, format!("{json}\n"))
        .with_context(|| format!("write staged trace to {}", staged_trace.display()))
        .map_err(CliError::Local)?;

    commit_export_transaction(
        &staging_dir,
        &states_dir,
        &HashSet::new(),
        transaction_id,
        vec![(
            staged_trace,
            trace_path,
            output_dir.join(format!(".trace.json.{transaction_id}.bak")),
        )],
    )
}

pub(super) fn export_recorded_trace(
    output_dir: &Path,
    trace: &RecordedTrace,
) -> Result<ExportMeta, CliError> {
    match trace {
        RecordedTrace::V4(_) => {
            let states_dir = write_state_bundle(output_dir, trace, TRACE_VERSION_V4)?;
            Ok(ExportMeta {
                states_dir: Some(states_dir),
                trace_version: TRACE_VERSION_V4,
                v2_fallback: false,
            })
        }
        RecordedTrace::V3(_) => {
            let states_dir = write_state_bundle(output_dir, trace, TRACE_VERSION_V3)?;
            Ok(ExportMeta {
                states_dir: Some(states_dir),
                trace_version: TRACE_VERSION_V3,
                v2_fallback: false,
            })
        }
        RecordedTrace::V2(_) => {
            write_trace_v2(output_dir, trace)?;
            Ok(ExportMeta {
                states_dir: None,
                trace_version: TRACE_VERSION_V2,
                v2_fallback: true,
            })
        }
    }
}

pub(super) fn export_with_recovery(
    output_dir: &Path,
    trace: &RecordedTrace,
) -> Result<ExportMeta, CliError> {
    let save_result = crate::cli::record_recovery::save(trace);
    match export_recorded_trace(output_dir, trace) {
        Ok(meta) => {
            crate::cli::record_recovery::clear();
            Ok(meta)
        }
        Err(export_err) => {
            let export_err = if save_result.is_ok() {
                match export_err {
                    CliError::Local(inner) => CliError::Local(inner.context(
                        "export failed; the recorded trace was saved and can be recovered with `bsk record stop --output <dir>`",
                    )),
                    other => other,
                }
            } else {
                export_err
            };
            if let Err(save_err) = save_result {
                return Err(match export_err {
                    CliError::Local(inner) => CliError::Local(
                        inner.context(format!("also failed to save recovery data: {save_err}")),
                    ),
                    other => other,
                });
            }
            Err(export_err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsk_protocol::tools::{
        RecordDiagnosticsLevel, RecorderInfoV4, StopReason, TraceCaptureConfigV4, TraceEntry,
        TraceStateV4, TraceV4, CAUSAL_FORMAT_VERSION,
    };

    fn sample_v4(state_id: &str, body: &str) -> RecordedTrace {
        RecordedTrace::V4(TraceV4 {
            version: TRACE_VERSION_V4,
            purpose: Some("test causal export".into()),
            started_at: Some("2026-09-05T00:00:00Z".into()),
            recorded_at: "2026-09-05T00:00:01Z".into(),
            stopped_by: StopReason::CliStop,
            entry: TraceEntry {
                start_url: "https://example.com".into(),
            },
            recorder: RecorderInfoV4 {
                bsk: "0.2.0".into(),
                vom: 1,
                causal: CAUSAL_FORMAT_VERSION,
            },
            capture: TraceCaptureConfigV4 {
                diagnostics: RecordDiagnosticsLevel::Standard,
                effects: vec![],
                settle_max_ms: None,
                redact_values: Some(true),
            },
            states: vec![TraceStateV4 {
                id: state_id.into(),
                url: "https://example.com".into(),
                title: Some("Example".into()),
                body: body.into(),
                truncated: false,
                capture: None,
            }],
            steps: vec![],
        })
    }

    #[test]
    fn v4_bundle_externalizes_body_without_dropping_causal_fields() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("trace");
        let trace = sample_v4("s1", "@vom 1\nRootWebArea \"Example\"");
        let meta = export_recorded_trace(&output, &trace).unwrap();
        assert_eq!(meta.trace_version, TRACE_VERSION_V4);
        let disk: serde_json::Value =
            serde_json::from_slice(&fs::read(trace_json_path(&output)).unwrap()).unwrap();
        assert_eq!(disk["version"], TRACE_VERSION_V4);
        assert_eq!(disk["recorder"]["causal"], CAUSAL_FORMAT_VERSION);
        assert_eq!(disk["states"][0]["page"], "s1.txt");
        assert!(disk["states"][0].get("body").is_none());
        assert_eq!(
            fs::read_to_string(states_dir_for_output(&output).join("s1.txt")).unwrap(),
            "@vom 1\nRootWebArea \"Example\""
        );
    }

    #[test]
    fn target_validation_failure_preserves_previous_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("trace");
        export_recorded_trace(&output, &sample_v4("s1", "original")).unwrap();
        let original_trace = fs::read(trace_json_path(&output)).unwrap();
        fs::create_dir(states_dir_for_output(&output).join("s2.txt")).unwrap();

        let err = export_recorded_trace(&output, &sample_v4("s2", "replacement")).unwrap_err();
        assert!(err.to_string().contains("state observation"));
        assert_eq!(fs::read(trace_json_path(&output)).unwrap(), original_trace);
        assert_eq!(
            fs::read_to_string(states_dir_for_output(&output).join("s1.txt")).unwrap(),
            "original"
        );
    }

    #[test]
    fn stale_cleanup_failure_rolls_back_all_replacements() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("trace");
        export_recorded_trace(&output, &sample_v4("s1", "original")).unwrap();
        let original_trace = fs::read(trace_json_path(&output)).unwrap();
        fs::create_dir(states_dir_for_output(&output).join("s9.txt")).unwrap();

        let err = export_recorded_trace(&output, &sample_v4("s2", "replacement")).unwrap_err();
        assert!(err.to_string().contains("stale state"));
        assert_eq!(fs::read(trace_json_path(&output)).unwrap(), original_trace);
        assert_eq!(
            fs::read_to_string(states_dir_for_output(&output).join("s1.txt")).unwrap(),
            "original"
        );
        assert!(!states_dir_for_output(&output).join("s2.txt").exists());
        assert!(states_dir_for_output(&output).join("s9.txt").is_dir());
    }

    #[test]
    fn traversal_and_duplicate_state_ids_are_rejected_before_commit() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("trace");
        let traversal = sample_v4("../outside", "bad");
        assert!(export_recorded_trace(&output, &traversal).is_err());
        assert!(!trace_json_path(&output).exists());

        let mut duplicate = match sample_v4("s1", "one") {
            RecordedTrace::V4(trace) => trace,
            _ => unreachable!(),
        };
        duplicate.states.push(duplicate.states[0].clone());
        assert!(export_recorded_trace(&output, &RecordedTrace::V4(duplicate)).is_err());
        assert!(!trace_json_path(&output).exists());
    }
}
