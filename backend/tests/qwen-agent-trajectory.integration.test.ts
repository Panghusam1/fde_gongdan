import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";

test(
  "R187：真实千问在20条多轮工单轨迹上达到预先冻结的门槛",
  { skip: process.env.RUN_QWEN_TRAJECTORY_EVAL !== "1", timeout: 600_000 },
  async () => {
    const { createQwenCoordinatorModelFromEnvironment } = await import(
      "../src/coordinator/qwen-coordinator-runtime.ts"
    );
    const { evaluateAgentTrajectories, loadAgentTrajectorySuite } = await import(
      "../src/evaluation/agent-trajectory-evaluation.ts"
    );
    const suite = await loadAgentTrajectorySuite(
      "data/evaluation/qwen-agent-trajectories-v1.json",
    );
    const model = createQwenCoordinatorModelFromEnvironment(process.env);
    const report = await evaluateAgentTrajectories(model, suite);

    await mkdir("reports", { recursive: true });
    await writeFile(
      "reports/qwen-agent-trajectory-evaluation-v1.json",
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );

    assert.equal(report.metrics.trajectoryCount, 20);
    assert.ok(report.metrics.turnCount >= 40);
    assert.equal(report.passed, true, JSON.stringify(report.metrics));
  },
);
