use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use anyhow::Context;
use bsk_protocol::tools::{RecordedTrace, TRACE_VERSION_V2, TRACE_VERSION_V3, TRACE_VERSION_V4};

use crate::cli::error::CliError;

#[derive(Debug)]
pub(super) struct ExportMeta {
    pub(super) states_dir: Option<PathBuf>,
    pub(super) trace_version: u32,
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
            "--output {} is not a directory; use `--output trace`",
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

fn is_canonical_state_id(id: &str) -> bool {
    let Some(number) = id.strip_prefix('s') else {
        return false;
    };
    let mut digits = number.bytes();
    matches!(digits.next(), Some(b'1'..=b'9')) && digits.all(|byte| byte.is_ascii_digit())
}

fn validate_directory(path: &Path, description: &str) -> Result<(), CliError> {
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

fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), CliError> {
    let parent = path.parent().ok_or_else(|| {
        CliError::Local(anyhow::anyhow!("output path {} has no parent", path.display()))
    })?;
    let id = uuid::Uuid::new_v4();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("record-output");
    let tmp = parent.join(format!(".{file_name}.{id}.tmp"));
    let backup = parent.join(format!(".{file_name}.{id}.bak"));

    let write_result: Result<(), CliError> = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .with_context(|| format!("create staged file {}", tmp.display()))
            .map_err(CliError::Local)?;
        file.write_all(bytes)
            .with_context(|| format!("write staged file {}", tmp.display()))
            .map_err(CliError::Local)?;
        file.sync_all()
            .with_context(|| format!("sync staged file {}", tmp.display()))
            .map_err(CliError::Local)?;
        Ok(())
    })();
    if let Err(err) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }

    let had_old = match fs::rename(path, &backup) {
        Ok(()) => true,
        Err(err) if err.kind() == io::ErrorKind::NotFound => false,
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            return Err(CliError::Local(
                anyhow::Error::new(err).context(format!("stage existing {}", path.display())),
            ));
        }
    };

    if let Err(err) = fs::rename(&tmp, path) {
        if had_old {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&tmp);
        return Err(CliError::Local(
            anyhow::Error::new(err).context(format!("install {}", path.display())),
        ));
    }
    if had_old {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn write_v2(output_dir: &Path, trace: &RecordedTrace) -> Result<(), CliError> {
    validate_record_output(output_dir)?;
    fs::create_dir_all(output_dir)
        .with_context(|| format!("create output dir {}", output_dir.display()))
        .map_err(CliError::Local)?;
    let path = trace_json_path(output_dir);
    validate_replaceable_file(&path, "trace JSON")?;
    let mut json = serde_json::to_vec_pretty(trace)
        .context("serialize trace JSON")
        .map_err(CliError::Local)?;
    json.push(b'\n');
    atomic_replace(&path, &json)
}

fn write_state_bundle(
    output_dir: &Path,
    trace: &RecordedTrace,
    version: u32,
) -> Result<PathBuf, CliError> {
    validate_record_output(output_dir)?;
    fs::create_dir_all(output_dir)
        .with_context(|| format!("create output dir {}", output_dir.display()))
        .map_err(CliError::Local)?;
    let states_dir = states_dir_for_output(output_dir);
    validate_directory(&states_dir, "states directory")?;
    fs::create_dir_all(&states_dir)
        .with_context(|| format!("create states dir {}", states_dir.display()))
        .map_err(CliError::Local)?;

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
    if actual_version != u64::from(version) {
        return Err(CliError::Local(anyhow::anyhow!(
            "trace version {actual_version} does not match expected {version}"
        )));
    }
    let states = envelope
        .get_mut("states")
        .and_then(|value| value.as_array_mut())
        .ok_or_else(|| CliError::Local(anyhow::anyhow!("state-linked trace has no states[]")))?;

    let mut keep = HashSet::new();
    for state in states.iter_mut() {
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
        let filename = format!("{id}.txt");
        if !keep.insert(filename.clone()) {
            return Err(CliError::Local(anyhow::anyhow!("duplicate state id {id:?}")));
        }
        let body = object
            .remove("body")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or_else(|| CliError::Local(anyhow::anyhow!("trace state {id} has no body")))?;
        let state_path = states_dir.join(&filename);
        if state_path.parent() != Some(states_dir.as_path()) {
            return Err(CliError::Local(anyhow::anyhow!(
                "state path {} escapes states directory {}",
                state_path.display(),
                states_dir.display()
            )));
        }
        validate_replaceable_file(&state_path, "state observation")?;
        atomic_replace(&state_path, body.as_bytes())?;
        object.insert("page".into(), serde_json::Value::String(filename));
    }

    // Only remove files generated by an older BrowserSkill export. User files
    // and non-canonical names are preserved.
    if let Ok(entries) = fs::read_dir(&states_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let generated = name
                .strip_suffix(".txt")
                .is_some_and(is_canonical_state_id);
            if generated && !keep.contains(name) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    let trace_path = trace_json_path(output_dir);
    validate_replaceable_file(&trace_path, "trace JSON")?;
    let mut json = serde_json::to_vec_pretty(&value)
        .context("serialize bundle trace JSON")
        .map_err(CliError::Local)?;
    json.push(b'\n');
    atomic_replace(&trace_path, &json)?;
    Ok(states_dir)
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
            write_v2(output_dir, trace)?;
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

    fn sample_v4() -> RecordedTrace {
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
                bsk: "0.1.0".into(),
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
                id: "s1".into(),
                url: "https://example.com".into(),
                title: Some("Example".into()),
                body: "@vom 1\nRootWebArea \"Example\"".into(),
                truncated: false,
                capture: None,
            }],
            steps: vec![],
        })
    }

    #[test]
    fn v4_bundle_keeps_causal_envelope_and_externalizes_state_body() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("trace");
        let trace = sample_v4();
        let meta = export_recorded_trace(&output, &trace).unwrap();
        assert_eq!(meta.trace_version, TRACE_VERSION_V4);
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(trace_json_path(&output)).unwrap()).unwrap();
        assert_eq!(json["version"], TRACE_VERSION_V4);
        assert_eq!(json["recorder"]["causal"], CAUSAL_FORMAT_VERSION);
        assert_eq!(json["states"][0]["page"], "s1.txt");
        assert!(json["states"][0].get("body").is_none());
        assert!(states_dir_for_output(&output).join("s1.txt").is_file());
    }

    #[test]
    fn json_file_output_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("trace.json");
        assert!(validate_record_output(&output).is_err());
    }
}
