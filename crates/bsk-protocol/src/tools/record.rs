//! Semantic user-action recording (`tool.record_start` / `stop` / `await`).
//!
//! Wire traces are Trace v2 (`pages[]`), Trace v3 (`version: 3`, `states[]`),
//! or Trace v4 (`version: 4`, `states[]` + causal effects).

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
        // Preserve the legacy classifier contract: a numeric version selects a
        // state-linked trace; no version selects v2. The versioned arm is then
        // narrowed to strict TraceV3 or TraceV4 schemas.
        let mut version_props = schemars::Map::new();
        version_props.insert(
            "version".into(),
            schemars::schema::SchemaObject {
                instance_type: Some(schemars::schema::InstanceType::Integer.into()),
                ..Default::default()
            }
            .into(),
        );
        let mut required = schemars::Set::new();
        required.insert("version".into());
        let versioned = schemars::schema::SchemaObject {
            subschemas: Some(Box::new(schemars::schema::SubschemaValidation {
                one_of: Some(vec![
                    generator.subschema_for::<TraceV3>(),
                    generator.subschema_for::<TraceV4>(),
                ]),
                ..Default::default()
            })),
            ..Default::default()
        };

        schemars::schema::SchemaObject {
            subschemas: Some(Box::new(schemars::schema::SubschemaValidation {
                if_schema: Some(Box::new(
                    schemars::schema::SchemaObject {
                        object: Some(Box::new(schemars::schema::ObjectValidation {
                            properties: version_props,
                            required,
                            ..Default::default()
                        })),
                        ..Default::default()
                    }
                    .into(),
                )),
                then_schema: Some(Box::new(versioned.into())),
                else_schema: Some(Box::new(generator.subschema_for::<TraceV2>())),
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
        let mut required = schemars::Set::new();
        required.insert("state".into());
        let mut mixed_keys = schemars::Set::new();
        mixed_keys.insert("page".into());
        mixed_keys.insert("state".into());
        let versioned = schemars::schema::SchemaObject {
            subschemas: Some(Box::new(schemars::schema::SubschemaValidation {
                one_of: Some(vec![
                    generator.subschema_for::<StepV3>(),
                    generator.subschema_for::<StepV4>(),
                ]),
                ..Default::default()
            })),
            ..Default::default()
        };

        schemars::schema::SchemaObject {
            subschemas: Some(Box::new(schemars::schema::SubschemaValidation {
                if_schema: Some(Box::new(
                    schemars::schema::SchemaObject {
                        object: Some(Box::new(schemars::schema::ObjectValidation {
                            required,
                            ..Default::default()
                        })),
                        ..Default::default()
                    }
                    .into(),
                )),
                then_schema: Some(Box::new(versioned.into())),
                else_schema: Some(Box::new(generator.subschema_for::<StepV2>())),
                not: Some(Box::new(
                    schemars::schema::SchemaObject {
                        object: Some(Box::new(schemars::schema::ObjectValidation {
                            required: mixed_keys,
                            ..Default::default()
                        })),
                        ..Default::default()
                    }
                    .into(),
                )),
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
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordAwaitResult {
    pub trace: RecordedTrace,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_common(id: u32, state: &str, result_state: &str) -> StepCommonV3 {
        StepCommonV3 {
            id,
            state: state.into(),
            result: StepResultV3 { state: result_state.into() },
        }
    }

    fn sample_target() -> TargetDescriptorV3 {
        TargetDescriptorV3 {
            element_ref: Some("e21".into()),
            role: Some("button".into()),
            name: Some("发布".into()),
            ctx: Some("金桔柠檬 6 号".into()),
            unmatched: false,
        }
    }

    #[test]
    fn v3_step_round_trips_unchanged() {
        let step = StepV3::Click {
            common: sample_common(1, "s1", "s2"),
            target: sample_target(),
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["op"], "click");
        assert_eq!(v["state"], "s1");
        assert_eq!(v["result"]["state"], "s2");
        assert_eq!(v["target"]["ref"], "e21");
        assert_eq!(serde_json::from_value::<StepV3>(v).unwrap(), step);
    }

    #[test]
    fn v3_fill_redaction_contract_is_preserved() {
        let step = StepV3::Fill {
            common: sample_common(1, "s1", "s1"),
            target: TargetDescriptorV3 {
                element_ref: Some("e3".into()),
                role: Some("textbox".into()),
                name: Some("密码".into()),
                ctx: None,
                unmatched: false,
            },
            value: "***".into(),
            commit: FillCommit::Blur,
            redacted: true,
        };
        let v = serde_json::to_value(step).unwrap();
        assert_eq!(v["value"], "***");
        assert_eq!(v["redacted"], true);
    }

    #[test]
    fn record_start_v4_options_are_optional_without_changing_legacy_wire() {
        let legacy = RecordStartParams {
            session_id: "session".into(),
            tab_id: None,
            url: None,
            purpose: None,
            max_page_tokens: None,
            redact_values: None,
            trace_version: None,
            supports_tab_switch_steps: None,
            diagnostics: None,
            settle_max_ms: None,
            capture_effects: None,
        };
        let value = serde_json::to_value(legacy).unwrap();
        assert!(value.get("trace_version").is_none());
        assert!(value.get("diagnostics").is_none());
        assert!(value.get("settle_max_ms").is_none());
        assert!(value.get("capture_effects").is_none());
    }

    #[test]
    fn recorded_trace_classifies_v2_v3_and_v4() {
        let v2 = json!({
            "recorded_at": "2026-07-21T08:00:00Z",
            "entry": { "start_url": "https://example.com/" },
            "pages": [{ "id": "p1", "url": "https://example.com/" }],
            "steps": []
        });
        assert!(matches!(RecordedTrace::classify_value(&v2), Ok(RecordedTrace::V2(_))));

        let v3 = json!({
            "version": 3,
            "recorded_at": "2026-07-21T08:00:00Z",
            "stopped_by": "user_finish",
            "entry": { "start_url": "https://example.com/" },
            "recorder": { "bsk": "0.1.10", "vom": 1 },
            "states": [],
            "steps": []
        });
        assert!(matches!(RecordedTrace::classify_value(&v3), Ok(RecordedTrace::V3(_))));

        let v4 = json!({
            "version": 4,
            "recorded_at": "2026-09-05T00:00:01Z",
            "stopped_by": "cli_stop",
            "entry": { "start_url": "https://example.com" },
            "recorder": { "bsk": "0.2.0", "vom": 1, "causal": 1 },
            "capture": { "diagnostics": "standard", "effects": [] },
            "states": [],
            "steps": []
        });
        assert!(matches!(RecordedTrace::classify_value(&v4), Ok(RecordedTrace::V4(_))));
    }

    #[test]
    fn recorded_trace_rejects_mixed_and_unsupported_versions() {
        let mixed = json!({
            "version": 4,
            "recorded_at": "2026-09-05T00:00:01Z",
            "stopped_by": "cli_stop",
            "entry": { "start_url": "https://example.com" },
            "recorder": { "bsk": "0.2.0", "vom": 1, "causal": 1 },
            "capture": { "diagnostics": "standard", "effects": [] },
            "pages": [], "states": [], "steps": []
        });
        assert!(RecordedTrace::classify_value(&mixed).is_err());
        assert!(RecordedTrace::classify_value(&json!({"version": 5, "states": [], "steps": []})).is_err());
    }

    fn v2_click() -> serde_json::Value {
        json!({
            "op": "click", "id": 1, "page": "p1",
            "target": { "tag": "button", "role": "button", "name": "发布" }
        })
    }

    fn v3_click() -> serde_json::Value {
        json!({
            "op": "click", "id": 1, "state": "s1",
            "result": { "state": "s2" },
            "target": { "ref": "e1", "role": "button", "name": "发布" }
        })
    }

    fn v4_click() -> serde_json::Value {
        json!({
            "op": "click", "id": 1, "state": "s1",
            "timing": { "action_at_ms": 10.0 },
            "settle": { "reason": "quiet", "duration_ms": 20.0 },
            "effects": {},
            "result": { "state": "s2", "observation": "changed" },
            "target": { "ref": "e1", "role": "button", "name": "发布" }
        })
    }

    #[test]
    fn recorded_step_classifies_all_versions_and_rejects_mixed_page_state() {
        assert!(matches!(RecordedStep::classify_value(&v2_click()), Ok(RecordedStep::V2(_))));
        assert!(matches!(RecordedStep::classify_value(&v3_click()), Ok(RecordedStep::V3(_))));
        assert!(matches!(RecordedStep::classify_value(&v4_click()), Ok(RecordedStep::V4(_))));

        let mut mixed = v2_click();
        mixed["state"] = json!("s1");
        mixed["result"] = json!({ "state": "s2" });
        assert!(RecordedStep::classify_value(&mixed).is_err());
    }

    #[test]
    fn recorded_trace_schema_contains_all_versions() {
        let schema = serde_json::to_value(schemars::schema_for!(RecordedTrace)).unwrap();
        assert_eq!(schema["if"]["required"], json!(["version"]));
        assert_eq!(schema["else"]["$ref"], "#/definitions/TraceV2");
        let refs = schema["then"]["oneOf"].as_array().unwrap();
        assert!(refs.iter().any(|v| v["$ref"] == "#/definitions/TraceV3"));
        assert!(refs.iter().any(|v| v["$ref"] == "#/definitions/TraceV4"));
    }

    #[test]
    fn legacy_extension_v3_trace_still_deserializes() {
        let value = json!({
            "version": 3,
            "recorded_at": "2026-07-21T08:00:00Z",
            "started_at": "2026-07-21T07:59:00Z",
            "purpose": "demo",
            "stopped_by": "user_finish",
            "entry": { "start_url": "https://example.com/editor" },
            "recorder": { "bsk": "0.1.10", "vom": 1 },
            "states": [
                { "id": "s1", "url": "https://example.com/editor", "body": "@vom 1" },
                { "id": "s2", "url": "https://example.com/p/99", "body": "@vom 1" }
            ],
            "steps": [
                {
                    "op": "click", "id": 1, "state": "s1",
                    "result": { "state": "s2" },
                    "target": { "ref": "e2", "role": "button", "name": "发布" }
                }
            ]
        });
        let trace: RecordedTrace = serde_json::from_value(value).unwrap();
        assert!(matches!(trace, RecordedTrace::V3(_)));
    }
}
