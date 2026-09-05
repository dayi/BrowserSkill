import type { RecordedStateEntry } from "./state-registry";
import type { ChangeSignificanceV4, DomChangeV4 } from "./trace-v4-types";

const MAX_FOCUS_CHANGES = 12;
const HIGH_SIGNAL_ROLES = new Set(["alert", "dialog", "status", "alertdialog"]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "option",
  "menuitem",
  "tab",
]);

interface SemanticLine {
  identity: string;
  role?: string;
  name?: string;
  text: string;
}

function normalizeLine(line: string): string {
  return line
    .replace(/@e\d+/g, "@e")
    .replace(/\s+/g, " ")
    .trim();
}

function parseLine(line: string): SemanticLine | null {
  const text = normalizeLine(line);
  if (!text || text.startsWith("@vom ")) return null;
  // VOM is deliberately text-oriented. Keep the parser tolerant: strip common
  // tree glyphs/refs, take the first semantic token as role, and the first
  // quoted value as its accessible name when present.
  const cleaned = text
    .replace(/^[│├└─+\-\s]+/, "")
    .replace(/^@e\s+/, "")
    .trim();
  if (!cleaned) return null;
  const quoted = cleaned.match(/"([^"]{1,160})"/);
  const firstToken = cleaned.match(/^([A-Za-z][A-Za-z0-9_-]*)\b/);
  const role = firstToken?.[1]?.toLowerCase();
  const name = quoted?.[1]?.replace(/\s+/g, " ").trim();
  // Ignore volatile generated refs so the same semantic node compares equal
  // across observations even though its @eN changed.
  const identity = cleaned.replace(/@e\d+/g, "@e");
  return {
    identity,
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    text: cleaned,
  };
}

function lines(entry: RecordedStateEntry | undefined): SemanticLine[] {
  if (!entry) return [];
  return entry.vomText.split(/\r?\n/).flatMap((line) => {
    const parsed = parseLine(line);
    return parsed ? [parsed] : [];
  });
}

function significance(node: SemanticLine): ChangeSignificanceV4 {
  if (node.role && HIGH_SIGNAL_ROLES.has(node.role)) return "high";
  if (node.role && INTERACTIVE_ROLES.has(node.role)) return "medium";
  if (node.name && /成功|失败|错误|完成|已提交|approved|success|failed|error|complete/i.test(node.name)) {
    return "high";
  }
  return "low";
}

function weight(change: DomChangeV4): number {
  const significanceWeight = change.significance === "high" ? 100 : change.significance === "medium" ? 50 : 10;
  const appearedWeight = change.kind === "appeared" ? 8 : change.kind === "disappeared" ? 5 : 0;
  return significanceWeight + appearedWeight;
}

/**
 * Compact semantic delta between two VOM states. It intentionally does not
 * expose raw MutationRecords or HTML; those are too noisy and brittle for
 * replay. The DOM activity probe supplies volume/timing while this supplies
 * the human/business-significant focus points.
 */
export function semanticStateDiff(
  before: RecordedStateEntry | undefined,
  after: RecordedStateEntry | undefined,
): DomChangeV4[] {
  if (!before || !after || before.id === after.id) return [];
  const pre = lines(before);
  const post = lines(after);
  const preCounts = new Map<string, number>();
  const postCounts = new Map<string, number>();
  const preByIdentity = new Map<string, SemanticLine>();
  const postByIdentity = new Map<string, SemanticLine>();

  for (const node of pre) {
    preCounts.set(node.identity, (preCounts.get(node.identity) ?? 0) + 1);
    preByIdentity.set(node.identity, node);
  }
  for (const node of post) {
    postCounts.set(node.identity, (postCounts.get(node.identity) ?? 0) + 1);
    postByIdentity.set(node.identity, node);
  }

  const changes: DomChangeV4[] = [];
  for (const [identity, count] of postCounts) {
    const delta = count - (preCounts.get(identity) ?? 0);
    if (delta <= 0) continue;
    const node = postByIdentity.get(identity)!;
    changes.push({
      kind: "appeared",
      ...(node.role ? { role: node.role } : {}),
      ...(node.name ? { name: node.name } : {}),
      significance: significance(node),
    });
  }
  for (const [identity, count] of preCounts) {
    const delta = count - (postCounts.get(identity) ?? 0);
    if (delta <= 0) continue;
    const node = preByIdentity.get(identity)!;
    changes.push({
      kind: "disappeared",
      ...(node.role ? { role: node.role } : {}),
      ...(node.name ? { name: node.name } : {}),
      significance: significance(node),
    });
  }

  return changes
    .sort((a, b) => weight(b) - weight(a))
    .slice(0, MAX_FOCUS_CHANGES);
}
