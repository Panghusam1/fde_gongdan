import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

interface TrajectoryThresholds {
  validOutputRate: number;
  actionAccuracy: number;
  parameterAccuracy: number;
  trajectoryPassRate: number;
}

interface TurnExpectation {
  action: string;
  exactFields?: Record<string, unknown>;
  nonEmptyTextFields?: string[];
  nonEmptyArrayFields?: string[];
  forbiddenTermsByField?: Record<string, string[]>;
}

interface AgentTrajectoryTurn {
  turnId: string;
  userMessage: string;
  allowedActions: string[];
  workOrderContext: unknown;
  contextRef?: string;
  expected: TurnExpectation;
}

interface AgentTrajectoryCase {
  caseId: string;
  category: string;
  title: string;
  turns: AgentTrajectoryTurn[];
}

export interface AgentTrajectorySuite {
  datasetId: string;
  version: number;
  purpose: string;
  modelInputMode: "database_context_each_turn";
  thresholds: TrajectoryThresholds;
  contexts?: Record<string, unknown>;
  cases: AgentTrajectoryCase[];
  sourceSha256?: string;
}

interface TrajectoryModel {
  modelId: string;
  promptVersion: string;
  decide(input: {
    userMessage: string;
    workOrderContext: unknown;
    allowedActions: string[];
  }): Promise<Record<string, unknown>>;
}

export interface AgentTrajectoryTurnResult {
  turnId: string;
  expectedAction: string;
  actualAction: string | null;
  validOutput: boolean;
  actionCorrect: boolean;
  parameterCorrect: boolean;
  latencyMilliseconds: number;
  failures: string[];
  decision: Record<string, unknown> | null;
}

export interface AgentTrajectoryReport {
  reportVersion: 1;
  generatedAt: string;
  dataset: {
    id: string;
    version: number;
    sourceSha256: string | null;
    modelInputMode: string;
  };
  model: { id: string; promptVersion: string };
  thresholds: TrajectoryThresholds;
  metrics: {
    trajectoryCount: number;
    turnCount: number;
    validOutputRate: number;
    actionAccuracy: number;
    parameterAccuracy: number;
    trajectoryPassRate: number;
    averageLatencyMilliseconds: number;
    p95LatencyMilliseconds: number;
  };
  passed: boolean;
  cases: Array<{
    caseId: string;
    category: string;
    title: string;
    passed: boolean;
    turns: AgentTrajectoryTurnResult[];
  }>;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be non-blank text`);
  }
  return value.trim();
}

function validateThreshold(value: unknown, name: string): void {
  if (typeof value !== "number" || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
}

export function validateAgentTrajectorySuite(
  value: unknown,
): asserts value is AgentTrajectorySuite {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("trajectory suite must be an object");
  }
  const suite = value as Partial<AgentTrajectorySuite>;
  requiredText(suite.datasetId, "dataset id");
  if (!Number.isSafeInteger(suite.version) || Number(suite.version) <= 0) {
    throw new Error("dataset version must be a positive integer");
  }
  requiredText(suite.purpose, "dataset purpose");
  if (suite.modelInputMode !== "database_context_each_turn") {
    throw new Error("model input mode must be database_context_each_turn");
  }
  if (!suite.thresholds) throw new Error("trajectory thresholds are required");
  validateThreshold(suite.thresholds.validOutputRate, "valid output threshold");
  validateThreshold(suite.thresholds.actionAccuracy, "action accuracy threshold");
  validateThreshold(
    suite.thresholds.parameterAccuracy,
    "parameter accuracy threshold",
  );
  validateThreshold(
    suite.thresholds.trajectoryPassRate,
    "trajectory pass threshold",
  );
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    throw new Error("trajectory suite must contain cases");
  }

  const caseIds = new Set<string>();
  const turnIds = new Set<string>();
  for (const scenario of suite.cases) {
    const caseId = requiredText(scenario.caseId, "case id");
    if (caseIds.has(caseId)) throw new Error(`duplicate case id: ${caseId}`);
    caseIds.add(caseId);
    requiredText(scenario.category, "case category");
    requiredText(scenario.title, "case title");
    if (!Array.isArray(scenario.turns) || scenario.turns.length < 2) {
      throw new Error(`case ${caseId} must contain at least two turns`);
    }
    for (const turn of scenario.turns) {
      const turnId = requiredText(turn.turnId, "turn id");
      if (turnIds.has(turnId)) throw new Error(`duplicate turn id: ${turnId}`);
      turnIds.add(turnId);
      requiredText(turn.userMessage, "user message");
      if (!Array.isArray(turn.allowedActions) || turn.allowedActions.length === 0) {
        throw new Error(`turn ${turnId} must allow at least one action`);
      }
      if (!turn.expected || typeof turn.expected !== "object") {
        throw new Error(`turn ${turnId} expectation is required`);
      }
      const expectedAction = requiredText(turn.expected.action, "expected action");
      if (!turn.allowedActions.includes(expectedAction)) {
        throw new Error(`turn ${turnId} expected action must be allowed`);
      }
      if (turn.workOrderContext === undefined) {
        throw new Error(`turn ${turnId} work order context is required`);
      }
    }
  }
}

export async function loadAgentTrajectorySuite(
  path: string,
): Promise<AgentTrajectorySuite> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as AgentTrajectorySuite;
  if (parsed.contexts) {
    parsed.cases = parsed.cases.map((scenario) => ({
      ...scenario,
      turns: scenario.turns.map((turn) => {
        if (!turn.contextRef) return turn;
        if (!Object.hasOwn(parsed.contexts!, turn.contextRef)) {
          throw new Error(`unknown context reference: ${turn.contextRef}`);
        }
        return {
          ...turn,
          workOrderContext: parsed.contexts![turn.contextRef],
        };
      }),
    }));
  }
  validateAgentTrajectorySuite(parsed);
  parsed.sourceSha256 = createHash("sha256").update(raw).digest("hex");
  return parsed;
}

function fieldText(value: unknown): string {
  if (Array.isArray(value)) return value.join("\n");
  return typeof value === "string" ? value : "";
}

function evaluateParameters(
  decision: Record<string, unknown>,
  expected: TurnExpectation,
): string[] {
  const failures: string[] = [];
  for (const [field, expectedValue] of Object.entries(
    expected.exactFields ?? {},
  )) {
    if (!isDeepStrictEqual(decision[field], expectedValue)) {
      failures.push(`${field} did not equal the expected value`);
    }
  }
  for (const field of expected.nonEmptyTextFields ?? []) {
    const value = decision[field];
    if (typeof value !== "string" || value.trim() === "") {
      failures.push(`${field} must be non-empty text`);
    }
  }
  for (const field of expected.nonEmptyArrayFields ?? []) {
    const value = decision[field];
    if (!Array.isArray(value) || value.length === 0) {
      failures.push(`${field} must be a non-empty array`);
    }
  }
  for (const [field, terms] of Object.entries(
    expected.forbiddenTermsByField ?? {},
  )) {
    const text = fieldText(decision[field]);
    for (const term of terms) {
      if (text.includes(term)) failures.push(`${field} contains forbidden term: ${term}`);
    }
  }
  return failures;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export async function evaluateAgentTrajectories(
  model: TrajectoryModel,
  suite: AgentTrajectorySuite,
): Promise<AgentTrajectoryReport> {
  validateAgentTrajectorySuite(suite);
  const caseResults: AgentTrajectoryReport["cases"] = [];
  for (const scenario of suite.cases) {
    const turnResults: AgentTrajectoryTurnResult[] = [];
    for (const turn of scenario.turns) {
      const startedAt = performance.now();
      let decision: Record<string, unknown> | null = null;
      let validOutput = false;
      const failures: string[] = [];
      try {
        const output = await model.decide({
          userMessage: turn.userMessage,
          workOrderContext: turn.workOrderContext,
          allowedActions: turn.allowedActions,
        });
        if (typeof output !== "object" || output === null || Array.isArray(output)) {
          failures.push("model output was not an object");
        } else {
          decision = output;
          validOutput = typeof output.action === "string";
          if (!validOutput) failures.push("model output did not contain an action");
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      const actualAction =
        decision && typeof decision.action === "string" ? decision.action : null;
      const actionCorrect = actualAction === turn.expected.action;
      if (validOutput && !actionCorrect) {
        failures.push(
          `action expected ${turn.expected.action} but received ${actualAction}`,
        );
      }
      if (validOutput && actionCorrect && decision) {
        failures.push(...evaluateParameters(decision, turn.expected));
      }
      turnResults.push({
        turnId: turn.turnId,
        expectedAction: turn.expected.action,
        actualAction,
        validOutput,
        actionCorrect,
        parameterCorrect: validOutput && actionCorrect && failures.length === 0,
        latencyMilliseconds: performance.now() - startedAt,
        failures,
        decision,
      });
    }
    caseResults.push({
      caseId: scenario.caseId,
      category: scenario.category,
      title: scenario.title,
      passed: turnResults.every((turn) => turn.parameterCorrect),
      turns: turnResults,
    });
  }

  const turns = caseResults.flatMap((scenario) => scenario.turns);
  const latencies = turns.map((turn) => turn.latencyMilliseconds);
  const metrics = {
    trajectoryCount: caseResults.length,
    turnCount: turns.length,
    validOutputRate: rate(
      turns.filter((turn) => turn.validOutput).length,
      turns.length,
    ),
    actionAccuracy: rate(
      turns.filter((turn) => turn.actionCorrect).length,
      turns.length,
    ),
    parameterAccuracy: rate(
      turns.filter((turn) => turn.parameterCorrect).length,
      turns.length,
    ),
    trajectoryPassRate: rate(
      caseResults.filter((scenario) => scenario.passed).length,
      caseResults.length,
    ),
    averageLatencyMilliseconds:
      latencies.reduce((total, value) => total + value, 0) / latencies.length,
    p95LatencyMilliseconds: p95(latencies),
  };
  const passed =
    metrics.validOutputRate >= suite.thresholds.validOutputRate &&
    metrics.actionAccuracy >= suite.thresholds.actionAccuracy &&
    metrics.parameterAccuracy >= suite.thresholds.parameterAccuracy &&
    metrics.trajectoryPassRate >= suite.thresholds.trajectoryPassRate;

  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    dataset: {
      id: suite.datasetId,
      version: suite.version,
      sourceSha256: suite.sourceSha256 ?? null,
      modelInputMode: suite.modelInputMode,
    },
    model: { id: model.modelId, promptVersion: model.promptVersion },
    thresholds: suite.thresholds,
    metrics,
    passed,
    cases: caseResults,
  };
}
