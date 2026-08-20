import { access, readFile } from "node:fs/promises";

export type ExplicitModelTestStatus = "passed" | "failed" | "blocked";

export interface ModelTestRegistryItem {
  rule_code: string;
  test_file: string;
  enable_variable: string;
  dependency_kind: string;
  default_skip_reason: string;
  explicit_command: string;
  accuracy_role: string;
  last_explicit_run: {
    date: string;
    status: ExplicitModelTestStatus;
    summary: string;
    evidence_paths: string[];
  };
}

export interface ModelTestRegistry {
  schema_version: 1;
  registry_id: string;
  purpose: string;
  tests: ModelTestRegistryItem[];
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must not be blank`);
  }
  return value.trim();
}

export async function loadModelTestRegistry(
  path: string,
): Promise<ModelTestRegistry> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.tests)) {
    throw new Error("model test registry has an unsupported schema");
  }
  const seen = new Set<string>();
  const tests = parsed.tests as Array<Record<string, unknown>>;
  for (const raw of tests) {
    const ruleCode = nonBlank(raw.rule_code, "rule code");
    const testFile = nonBlank(raw.test_file, `${ruleCode} test file`);
    const enableVariable = nonBlank(
      raw.enable_variable,
      `${ruleCode} enable variable`,
    );
    const command = nonBlank(raw.explicit_command, `${ruleCode} command`);
    nonBlank(raw.dependency_kind, `${ruleCode} dependency kind`);
    nonBlank(raw.default_skip_reason, `${ruleCode} skip reason`);
    nonBlank(raw.accuracy_role, `${ruleCode} accuracy role`);
    if (!/^R\d+$/.test(ruleCode) || seen.has(ruleCode)) {
      throw new Error(`invalid or duplicate model test rule: ${ruleCode}`);
    }
    seen.add(ruleCode);
    if (!command.includes(enableVariable) || !command.includes(testFile)) {
      throw new Error(`${ruleCode} explicit command cannot reproduce its test`);
    }
    await access(testFile);

    const run = raw.last_explicit_run as Record<string, unknown>;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nonBlank(run.date, `${ruleCode} run date`))) {
      throw new Error(`${ruleCode} explicit run date is invalid`);
    }
    if (!new Set(["passed", "failed", "blocked"]).has(run.status as string)) {
      throw new Error(`${ruleCode} explicit run status is invalid`);
    }
    nonBlank(run.summary, `${ruleCode} run summary`);
    if (!Array.isArray(run.evidence_paths) || run.evidence_paths.length === 0) {
      throw new Error(`${ruleCode} must link at least one evidence file`);
    }
    for (const evidencePath of run.evidence_paths) {
      await access(nonBlank(evidencePath, `${ruleCode} evidence path`));
    }
  }

  return {
    ...(parsed as unknown as ModelTestRegistry),
    tests: (tests as unknown as ModelTestRegistryItem[]).sort(
      (left, right) =>
        Number(left.rule_code.slice(1)) - Number(right.rule_code.slice(1)),
    ),
  };
}
