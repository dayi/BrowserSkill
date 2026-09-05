//! Trace v4 — causal state/action/effects/state recording.
//!
//! Wire format with top-level `version: 4`. V4 keeps the semantic state
//! dictionary from trace v3 and adds durable target fingerprints, timing,
//! settle diagnostics, and compact action effects.

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

use super::interaction::KeyModifier;
use super::record_common::TraceEntry;
use super::record_v3::{FillCommit, NavigationCause, StopReason};

pub const TRACE_VERSION_V4: u32 = 4;
pub const CAUSAL_FORMAT_VERSION: u32 = 1;

fn deserialize_trace_v4_version<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let version = u32::deserialize(deserializer)?;
    if version != TRACE_VERSION_V4 {
        return Err(serde::de::Error::custom(format!(
            "unsupported trace version {version} (expected {TRACE_VERSION_V4})"
        )));
    }
    Ok(version)
}

fn trace_v4_version_schema(_: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
    schemars::schema::SchemaObject {
        instance_type: Some(schemars::schema::InstanceType::Integer.into()),
        const_value: Some(serde_json::json!(TRACE_VERSION_V4)),
        ..Default::default()
    }
    .into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecorderInfoV4 {
    pub bsk: String,
    pub vom: u32,
    pub causal: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecordDiagnosticsLevel {
    Minimal,
    Standard,
    Deep,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecordEffectKind {
    Dom,
    Network,
    Console,
    Navigation,
    Security,
    Javascript,
    Browser,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TraceCaptureConfigV4 {
    pub diagnostics: RecordDiagnosticsLevel,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<RecordEffectKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settle_max_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redact_values: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TraceStateCaptureV4 {
    pub recording_offset_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dom_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_count: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TraceStateV4 {
    pub id: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub body: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture: Option<TraceStateCaptureV4>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FingerprintAttributesV4 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_test: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_cy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aria_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aria_controls: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aria_haspopup: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SemanticAncestorV4 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ElementFingerprintV4 {
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attributes: Option<FingerprintAttributesV4>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nearby_text: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ancestors: Vec<SemanticAncestorV4>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TargetDescriptorV4 {
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "ref")]
    pub element_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctx: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unmatched: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<ElementFingerprintV4>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StepTimingV4 {
    pub action_at_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub received_at_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_at_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettleReasonV4 {
    Quiet,
    Timeout,
    Cancelled,
    SupersededByNextAction,
    Navigation,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SettleSummaryV4 {
    pub reason: SettleReasonV4,
    pub duration_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dom_quiet_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_quiet_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_relevant_requests: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChangeSignificanceV4 {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DomChangeKindV4 {
    Appeared,
    Disappeared,
    TextChanged,
    StateChanged,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DomChangeV4 {
    pub kind: DomChangeKindV4,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    pub significance: ChangeSignificanceV4,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DomEffectV4 {
    pub mutation_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<DomChangeV4>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StackFrameEvidenceV4 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NetworkEffectV4 {
    pub method: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub initiator: Vec<StackFrameEvidenceV4>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ConsoleEffectV4 {
    pub level: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stack_trace: Vec<StackFrameEvidenceV4>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NavigationEffectV4 {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<NavigationCause>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redirect_count: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SecurityEffectV4 {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub source: String,
    pub confidence: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BrowserEffectV4 {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Default)]
pub struct StepEffectsV4 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dom: Option<DomEffectV4>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub network: Vec<NetworkEffectV4>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub navigation: Vec<NavigationEffectV4>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub console: Vec<ConsoleEffectV4>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub security: Vec<SecurityEffectV4>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub browser: Vec<BrowserEffectV4>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ObservationOutcomeV4 {
    Changed,
    Unchanged,
    Navigation,
    Blocked,
    Error,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StepResultV4 {
    pub state: String,
    pub observation: ObservationOutcomeV4,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StepCommonV4 {
    pub id: u32,
    pub state: String,
    pub timing: StepTimingV4,
    pub settle: SettleSummaryV4,
    #[serde(default)]
    pub effects: StepEffectsV4,
    pub result: StepResultV4,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SelectedOptionV4 {
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum StepV4 {
    Navigate {
        #[serde(flatten)]
        common: StepCommonV4,
        to: String,
        cause: NavigationCause,
    },
    SwitchTab {
        #[serde(flatten)]
        common: StepCommonV4,
    },
    Click {
        #[serde(flatten)]
        common: StepCommonV4,
        target: TargetDescriptorV4,
    },
    Hover {
        #[serde(flatten)]
        common: StepCommonV4,
        target: TargetDescriptorV4,
    },
    Fill {
        #[serde(flatten)]
        common: StepCommonV4,
        target: TargetDescriptorV4,
        value: String,
        commit: FillCommit,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        redacted: bool,
    },
    Select {
        #[serde(flatten)]
        common: StepCommonV4,
        target: TargetDescriptorV4,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        selection: Vec<SelectedOptionV4>,
    },
    Press {
        #[serde(flatten)]
        common: StepCommonV4,
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modifiers: Option<Vec<KeyModifier>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<TargetDescriptorV4>,
    },
    Scroll {
        #[serde(flatten)]
        common: StepCommonV4,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TraceV4 {
    #[serde(deserialize_with = "deserialize_trace_v4_version")]
    #[schemars(schema_with = "trace_v4_version_schema")]
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    pub recorded_at: String,
    pub stopped_by: StopReason,
    pub entry: TraceEntry,
    pub recorder: RecorderInfoV4,
    pub capture: TraceCaptureConfigV4,
    pub states: Vec<TraceStateV4>,
    pub steps: Vec<StepV4>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v4_version_is_strict() {
        let value = serde_json::json!({
            "version": 3,
            "recorded_at": "2026-09-05T00:00:00Z",
            "stopped_by": "cli_stop",
            "entry": { "start_url": "https://example.com" },
            "recorder": { "bsk": "0.1.0", "vom": 1, "causal": 1 },
            "capture": { "diagnostics": "standard", "effects": [] },
            "states": [],
            "steps": []
        });
        assert!(serde_json::from_value::<TraceV4>(value).is_err());
    }

    #[test]
    fn v4_round_trips_compact_effects() {
        let trace = TraceV4 {
            version: TRACE_VERSION_V4,
            purpose: Some("approve request".into()),
            started_at: Some("2026-09-05T00:00:00Z".into()),
            recorded_at: "2026-09-05T00:00:01Z".into(),
            stopped_by: StopReason::CliStop,
            entry: TraceEntry { start_url: "https://example.com".into() },
            recorder: RecorderInfoV4 { bsk: "0.1.0".into(), vom: 1, causal: 1 },
            capture: TraceCaptureConfigV4 {
                diagnostics: RecordDiagnosticsLevel::Standard,
                effects: vec![RecordEffectKind::Dom, RecordEffectKind::Network],
                settle_max_ms: Some(8000),
                redact_values: Some(true),
            },
            states: vec![TraceStateV4 {
                id: "s1".into(),
                url: "https://example.com".into(),
                title: None,
                body: "@vom 1".into(),
                truncated: false,
                capture: None,
            }],
            steps: vec![],
        };
        let encoded = serde_json::to_value(&trace).unwrap();
        let decoded: TraceV4 = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded, trace);
    }
}
