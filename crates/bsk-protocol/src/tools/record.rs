//! Semantic user-action recording (`tool.record_start` / `stop` / `await`).
//!
//! Wire traces are Trace v2 (`pages[]`), Trace v3 (`version: 3`,
//! `states[]`), or Trace v4 (`version: 4`, `states[]` + causal effects).
//! Version-specific models live in `record_v2` / `record_v3` / `record_v4`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub use super::record_common::TraceEntry;
pub use super::record_v2::{
    PageRefV2, SelectedOptionV2, StepCommonV2, StepEffectV2, StepV2, TargetDescriptorV2, TraceV2,
};
pub use super::record_v3::{
    FillCommit, NavigationCause, RecorderInfo, SelectedOptionV3, StepCommonV3, StepResultV3,
    StepV3, StopReason, TRACE_VERSION_V3, TargetDescriptorV3, TraceStateV3, TraceV3,
    VOM_FORMAT_VERSION,
};
pub use super::record_v4::{
    BrowserEffectV4, CAUSAL_FORMAT_VERSION, ChangeSignificanceV4, ConsoleEffectV4,
    DomChangeKindV4, DomChangeV4, DomEffectV4, ElementFingerprintV4, FingerprintAttributesV4,
    NavigationEffectV4, NetworkEffectV4, ObservationOutcomeV4, RecordDiagnosticsLevel,
    RecordEffectKind, RecorderInfoV4, SecurityEffectV4, SelectedOptionV4, SemanticAncestorV4,
    SettleReasonV4, SettleSummaryV4, StackFrameEvidenceV4, StepCommonV4, StepEffectsV4,
    StepResultV4, StepTimingV4, StepV4, TRACE_VERSION_V4, TargetDescriptorV4,
    TraceCaptureConfigV4, TraceStateCaptureV4, TraceStateV4, TraceV4,
};

/// Logical v2 identifier. Not a wire field — v2 envelopes omit `version`.
pub const TRACE_VERSION_V2: u32 = 2;

// ---------------------------------------------------------------------------
// RPC params / results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordStartParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_page_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redact_values: Option<bool>,
    /// Desired trace export format. Omitted means v2; `3` requests v3; `4` requests v4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_version: Option<u32>,
    /// Client can decode the v3/v4 `switch_tab` step variant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_tab_switch_steps: Option<bool>,
    /// V4 capture depth. Ignored by v2/v3 producers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<RecordDiagnosticsLevel>,
    /// Optional hard settle ceiling for v4 composite settling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settle_max_ms: Option<u32>,
    /// Optional v4 effect allow-list. Omitted uses the recorder default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_effects: Option<Vec<RecordEffectKind>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordStartResult {
    pub tab_id: i64,
    pub recording: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordStopParams {
    pub session_id: String,
}

/// Wire trace payload — v2, v3, or v4.
#[derive(Debug, Clone, PartialEq)]
pub enum RecordedTrace {
    V2(TraceV2),
    V3(TraceV3),
    V4(TraceV4),
}

impl RecordedTrace {
    pub fn classify_value(v: &serde_json::Value) -> Result<Self, String> {
        if let Some(ver) = v.get("version").and_then(|x| x.as_u64()) {
            if v.get("pages").is_some() {
                return Err(format!("trace v{ver} must not include legacy pages[]"));
            }
            return match ver {
                x if x == u64::from(TRACE_VERSION_V3) => serde_json::from_value(v.clone())
                    .map(RecordedTrace::V3)
                    .map_err(|e| e.to_string()),
                x if x == u64::from(TRACE_VERSION_V4) => serde_json::from_value(v.clone())
                    .map(RecordedTrace::V4)
                    .map_err(|e| e.to_string()),
                _ => Err(format!("unsupported trace version {ver}")),
            };
        }
        if v.get("states").is_some() {
            return Err("trace v2 must not include states[]; set version: 3 or 4".into());
        }
        if v.get("pages").is_some() {
            return serde_json::from_value(v.clone())
                .map(RecordedTrace::V2)
                .map_err(|e| e.to_string());
        }
        Err("ambiguous or unparseable trace".into())
    }
}

impl Serialize for RecordedTrace {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            RecordedTrace::V2(t) => t.serialize(serializer),
            RecordedTrace::V3(t) => t.serialize(serializer),
            RecordedTrace::V4(t) => t.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for RecordedTrace {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        Self::classify_value(&value).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for RecordedTrace {
    fn schema_name() -> String {
        "RecordedTrace".into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::schema::Schema {
        schemars::schema::SchemaObject {
            subschemas: Some(Box::new(schemars::schema::SubschemaValidation {
                one_of: Some(vec![
                    generator.subschema_for::<TraceV2>(),
                    generator.subschema_for::<TraceV3>(),
                    generator.subschema_for::<TraceV4>(),
                ]),
                ..Default::default()
            })),
            ..Default::default()
        }
        .into()
    }
}

/// One recorded step — v2 (`page`), v3, or v4 (`state` / `result.state`).
#[derive(Debug, Clone, PartialEq)]
pub enum RecordedStep {
    V2(StepV2),
    V3(StepV3),
    V4(StepV4),
}

impl RecordedStep {
    pub fn classify_value(v: &serde_json::Value) -> Result<Self, String> {
        if v.get("state").is_some() {
            if v.get("page").is_some() {
                return Err("state-linked step must not include legacy page".into());
            }
            if v.get("timing").is_some() || v.get("effects").is_some() || v.get("settle").is_some() {
                return serde_json::from_value(v.clone())
                    .map(RecordedStep::V4)
                    .map_err(|e| e.to_string());
            }
            return serde_json::from_value(v.clone())
                .map(RecordedStep::V3)
                .map_err(|e| e.to_string());
        }
        if v.get("page").is_some() {
            return serde_json::from_value(v.clone())
                .map(RecordedStep::V2)
                .map_err(|e| e.to_string());
        }
        Err("ambiguous or unparseable step".into())
    }
}

impl Serialize for RecordedStep {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            RecordedStep::V2(s) => s.serialize(serializer),
            RecordedStep::V3(s) => s.serialize(serializer),
            RecordedStep::V4(s) => s.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for RecordedStep {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        Self::classify_value(&value).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for RecordedStep {
    fn schema_name() -> String {
        "RecordedStep".into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::schema::Schema {
        schemars::schema::SchemaObject {
            subschemas: Some(Box::new(schemars::schema::SubschemaValidation {
                one_of: Some(vec![
                    generator.subschema_for::<StepV2>(),
                    generator.subschema_for::<StepV3>(),
                    generator.subschema_for::<StepV4>(),
                ]),
                ..Default::default()
            })),
            ..Default::default()
        }
        .into()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordStopResult {
    pub trace: RecordedTrace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordAwaitParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordAwaitResult {
    pub trace: RecordedTrace,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorded_trace_classifies_v4() {
        let value = serde_json::json!({
            "version": 4,
            "recorded_at": "2026-09-05T00:00:01Z",
            "stopped_by": "cli_stop",
            "entry": { "start_url": "https://example.com" },
            "recorder": { "bsk": "0.1.0", "vom": 1, "causal": 1 },
            "capture": { "diagnostics": "standard", "effects": [] },
            "states": [],
            "steps": []
        });
        assert!(matches!(RecordedTrace::classify_value(&value), Ok(RecordedTrace::V4(_))));
    }

    #[test]
    fn recorded_trace_keeps_v3_classification() {
        let value = serde_json::json!({
            "version": 3,
            "recorded_at": "2026-09-05T00:00:01Z",
            "stopped_by": "cli_stop",
            "entry": { "start_url": "https://example.com" },
            "recorder": { "bsk": "0.1.0", "vom": 1 },
            "states": [],
            "steps": []
        });
        assert!(matches!(RecordedTrace::classify_value(&value), Ok(RecordedTrace::V3(_))));
    }
}
