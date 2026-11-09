import { z } from "zod";
import type { FollowupGateResult, FollowupInput } from "./followup.ts";
import { checkFollowupLeak } from "./followup-leak-check.ts";

export class FollowupEvidenceError extends Error {
  constructor() {
    super("追问证据校验失败");
    this.name = "FollowupEvidenceError";
  }
}

const bounded = (max: number) => z.string().refine((value) =>
  value.trim().length > 0 && [...value].length <= max,
);
const referenceSchema = z.object({
  source: z.enum(["question", "answer", "primary_rubric"]),
  quote: bounded(100).refine((value) => [...value].length >= 4),
}).strict();
const checkSchema = z.object({
  id: z.enum(["c1", "c2", "c3", "c4", "c5", "c6"]),
  group: z.enum(["deliverable", "core_claim"]),
  rule: z.number().int().min(1).max(5),
  status: z.enum(["met", "missing", "unsupported", "not_applicable"]),
  material: z.boolean(),
  finding: bounded(100),
  refs: z.array(referenceSchema).min(1).max(2),
}).strict();
const followupSchema = z.object({
  question: bounded(120),
  hint: bounded(80),
  check_ids: z.array(z.string()).min(1).max(2),
}).strict();
const outputSchema = z.object({
  should_followup: z.boolean(),
  reason: bounded(120),
  checks: z.array(checkSchema).min(2).max(6),
  followups: z.array(followupSchema).max(2),
}).strict();

type Check = z.infer<typeof checkSchema>;
type EvidenceOutput = z.infer<typeof outputSchema>;
const normalizeLines = (text: string) => text.replace(/\r\n/g, "\n");

export function assertEvidenceInput(input: FollowupInput): void {
  const dimension = input.primaryDimension;
  if (typeof dimension !== "string" || !dimension.trim()) throw new FollowupEvidenceError();
  const points = input.rubric.dimensions[dimension.trim()];
  if (!Array.isArray(points) || points.length === 0 || points.some((point) =>
    typeof point !== "string" || !point.trim(),
  )) throw new FollowupEvidenceError();
}

function validateCheck(check: Check, input: FollowupInput, v2: boolean): void {
  const allowedRules = check.group === "deliverable" ? [1, 3] : [2, 4, 5];
  const isDefect = check.status === "missing" || check.status === "unsupported";
  if (!allowedRules.includes(check.rule)) throw new Error();
  if (check.material && !isDefect) throw new Error();
  if (!v2 && check.rule <= 3 && isDefect && !check.material) throw new Error();
  if (check.status === "not_applicable" && check.group !== "core_claim") throw new Error();

  const requiredSources = check.status === "missing" ? ["question", "primary_rubric"] : ["answer"];
  if (!check.refs.some((ref) => requiredSources.includes(ref.source))) throw new Error();
  const primaryPoints = input.rubric.dimensions[input.primaryDimension!.trim()];
  for (const ref of check.refs) {
    const sources = ref.source === "answer" ? [input.firstAnswer]
      : ref.source === "question" ? [input.mainQuestion] : primaryPoints;
    if (!sources.some((source) => normalizeLines(source).includes(normalizeLines(ref.quote)))) {
      throw new Error();
    }
  }
}

function validateDecisions(data: EvidenceOutput, input: FollowupInput, v2: boolean): void {
  const ids = new Set<string>();
  const materials = new Set<string>();
  const groups = new Set<string>();
  for (const check of data.checks) {
    if (ids.has(check.id)) throw new Error();
    ids.add(check.id);
    validateCheck(check, input, v2);
    if (check.material) materials.add(check.id);
    if (v2 || check.status === "met" || check.status === "not_applicable") groups.add(check.group);
  }
  if (!data.should_followup && (
    materials.size > 0 || data.followups.length !== 0 ||
    !groups.has("deliverable") || !groups.has("core_claim")
  )) throw new Error();
  if (data.should_followup && (materials.size === 0 || data.followups.length === 0)) throw new Error();
  for (const followup of data.followups) {
    if (new Set(followup.check_ids).size !== followup.check_ids.length ||
      followup.check_ids.some((id) => !materials.has(id))) throw new Error();
  }
}

function validatePublicText(data: EvidenceOutput, input: FollowupInput): void {
  const items = [
    { role: "question" as const, text: data.reason },
    ...data.followups.flatMap((followup) => [
      { role: "question" as const, text: followup.question },
      { role: "hint" as const, text: followup.hint },
    ]),
  ];
  const rubricPoints = Object.values(input.rubric.dimensions).flat();
  if (checkFollowupLeak({ items, forbiddenLeaks: input.rubric.forbidden_leaks, rubricPoints }).length) {
    throw new Error();
  }
}

export function validateFollowupEvidence(content: string, input: FollowupInput, contract: "gate-evidence-v1" | "gate-evidence-v2" = "gate-evidence-v1"): FollowupGateResult {
  try {
    assertEvidenceInput(input);
    const data = outputSchema.parse(JSON.parse(content));
    validateDecisions(data, input, contract === "gate-evidence-v2");
    validatePublicText(data, input);
    return {
      shouldFollowup: data.should_followup,
      reason: data.reason,
      followups: data.followups.map(({ question, hint }) => ({ question, hint })),
    };
  } catch {
    throw new FollowupEvidenceError();
  }
}
