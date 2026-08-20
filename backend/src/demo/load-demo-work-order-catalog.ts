import { readFile } from "node:fs/promises";

import type { WorkOrderEndToEndHoldoutV2 } from "../evaluation/work-order-end-to-end-holdout-v2-dataset.ts";
import type { ProjectDemoScenario } from "./run-project-demo.ts";

export type DemoWorkOrderStatus =
  | "draft"
  | "investigating"
  | "awaiting_information"
  | "awaiting_user_confirmation"
  | "awaiting_human"
  | "human_processing"
  | "resolved"
  | "closed";

export type DemoProcessStage = 1 | 2 | 3 | 4 | 5 | 6;

export type DemoEvidencePreviewState =
  | "not_started"
  | "verified_manual"
  | "risk_blocked"
  | "insufficient_evidence"
  | "access_blocked"
  | "source_mismatch";

export interface DemoEvidencePreview {
  state: DemoEvidencePreviewState;
  visual: "manual_page" | "status_card";
  title: string;
  sourceLabel: string;
  pageNumber: number | null;
  excerpt: string | null;
  focusQuestion: string;
  explanation: string;
}

export interface DemoWorkOrderCatalogItem {
  workOrderNo: string;
  caseId: string;
  factoryName: string;
  assetCode: string;
  equipmentModel: "ATV320-E2E-V2";
  faultCode: "OHF";
  status: DemoWorkOrderStatus;
  stage: DemoProcessStage;
  observation: string;
  query: string;
  branch: string;
  expectedFinalStatus: string;
  expectedHandoffReason: string | null;
  expectedDatabaseCounts: {
    work_orders: number;
    knowledge_search_runs: number;
    evidence_assessments: number;
    risk_assessments: number;
    resolution_proposals: number;
    proposal_user_feedback: number;
    human_handoffs: number;
  };
  manualSource: "NVE41300/05/zh-CN" | "NVE41300/04/zh-CN";
  evidencePreview: DemoEvidencePreview;
  demoScenario: ProjectDemoScenario | null;
  sourceCaseId: string;
  productionRecord: false;
}

export interface DemoWorkOrderCatalog {
  datasetId: "work-order-end-to-end-holdout-v3";
  dataRole: "project_evaluation_cases_not_production_records";
  manualSource: "NVE41300/05/zh-CN";
  items: DemoWorkOrderCatalogItem[];
}

const snapshotByCase: Record<
  string,
  {
    stage: DemoProcessStage;
    status: DemoWorkOrderStatus;
    demoScenario: ProjectDemoScenario | null;
  }
> = {
  U301: { stage: 1, status: "draft", demoScenario: null },
  U302: { stage: 1, status: "draft", demoScenario: null },
  U303: { stage: 6, status: "resolved", demoScenario: "normal" },
  U304: { stage: 5, status: "awaiting_user_confirmation", demoScenario: null },
  U305: { stage: 5, status: "awaiting_user_confirmation", demoScenario: null },
  U306: { stage: 6, status: "awaiting_human", demoScenario: null },
  U307: { stage: 6, status: "human_processing", demoScenario: null },
  U308: { stage: 4, status: "awaiting_human", demoScenario: "high_risk" },
  U309: { stage: 4, status: "human_processing", demoScenario: null },
  U310: {
    stage: 3,
    status: "awaiting_information",
    demoScenario: "insufficient_evidence",
  },
  U311: { stage: 3, status: "closed", demoScenario: null },
  U312: {
    stage: 2,
    status: "investigating",
    demoScenario: "unauthorized_factory",
  },
};

const verifiedOhfExcerpt =
  "解决措施：检查电机负载、变频器通风情况和环境温度。";

function buildEvidencePreview(input: {
  branch: string;
  query: string;
  stage: DemoProcessStage;
  manualSource: "NVE41300/05/zh-CN";
}): DemoEvidencePreview {
  if (input.branch === "unauthorized_factory") {
    return {
      state: "access_blocked",
      visual: "status_card",
      title: "厂区权限校验未通过",
      sourceLabel: "厂区成员权限",
      pageNumber: null,
      excerpt: null,
      focusQuestion: input.query,
      explanation: "请求方无权访问当前厂区工单，系统在资料检索前停止，未产生手册证据。",
    };
  }
  if (input.branch === "explicit_high_risk") {
    return {
      state: "risk_blocked",
      visual: "status_card",
      title: "高危规则已先行阻断",
      sourceLabel: "程序化安全规则",
      pageNumber: null,
      excerpt: null,
      focusQuestion: input.query,
      explanation: "请求包含绕过保护或可能导致设备意外运行的动作，系统先停止自动处理并转人工。",
    };
  }
  if (input.branch === "insufficient_evidence") {
    return {
      state: "insufficient_evidence",
      visual: "status_card",
      title: "当前资料不能回答",
      sourceLabel: "客户现场业务数据",
      pageNumber: null,
      excerpt: null,
      focusQuestion: input.query,
      explanation: "问题涉及设备维修历史或厂区库存，官方产品手册不包含这类现场业务数据。",
    };
  }
  if (input.stage < 3) {
    return {
      state: "not_started",
      visual: "status_card",
      title: "尚未形成检索证据",
      sourceLabel: "等待资料检索",
      pageNumber: null,
      excerpt: null,
      focusQuestion: input.query,
      explanation: "当前工单仍处于接入阶段，系统尚未完成资料身份限定和知识检索。",
    };
  }
  return {
    state: "verified_manual",
    visual: "manual_page",
    title: "官方手册证据已核验",
    sourceLabel: input.manualSource,
    pageNumber: 395,
    excerpt: verifiedOhfExcerpt,
    focusQuestion: input.query,
    explanation: "该页原文覆盖本工单核验问题，来源身份和证据能力均通过后才允许进入处置方案。",
  };
}

async function loadFrozenDataset(): Promise<WorkOrderEndToEndHoldoutV2> {
  return JSON.parse(
    await readFile(
      new URL(
        "../../data/evaluation/work-order-end-to-end-holdout-v3.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as WorkOrderEndToEndHoldoutV2;
}

export async function loadDemoWorkOrderCatalog(): Promise<DemoWorkOrderCatalog> {
  const dataset = await loadFrozenDataset();
  const items = dataset.cases.map((item): DemoWorkOrderCatalogItem => {
    const snapshot = snapshotByCase[item.case_id];
    if (!snapshot) {
      throw new Error(`demo queue snapshot is missing for ${item.case_id}`);
    }
    return {
      workOrderNo: `WO-${item.case_id}`,
      caseId: item.case_id,
      factoryName: `${item.case_id}评测厂区`,
      assetCode: `INV-${item.case_id}`,
      equipmentModel: "ATV320-E2E-V2",
      faultCode: "OHF",
      status: snapshot.status,
      stage: snapshot.stage,
      observation: item.initial_observation,
      query: item.search_queries[0],
      branch: item.branch,
      expectedFinalStatus: item.expected_final_status,
      expectedHandoffReason: item.expected_handoff_reason,
      expectedDatabaseCounts: item.expected_final_state,
      manualSource: "NVE41300/05/zh-CN",
      evidencePreview: buildEvidencePreview({
        branch: item.branch,
        query: item.search_queries[0],
        stage: snapshot.stage,
        manualSource: "NVE41300/05/zh-CN",
      }),
      demoScenario: snapshot.demoScenario,
      sourceCaseId: item.case_id,
      productionRecord: false,
    };
  });

  const sourceCase = dataset.cases.find(({ case_id }) => case_id === "U303");
  if (!sourceCase) throw new Error("source mismatch catalog case is missing");
  items.push({
    workOrderNo: "WO-DEMO-SOURCE-MISMATCH",
    caseId: "DEMO-SOURCE-MISMATCH",
    factoryName: "来源核验演示厂区",
    assetCode: "INV-SOURCE-MISMATCH",
    equipmentModel: "ATV320-E2E-V2",
    faultCode: "OHF",
    status: "awaiting_information",
    stage: 3,
    observation: "包装机驱动器出现OHF，但人工确认的手册版本与库内资料不一致。",
    query: sourceCase.search_queries[0],
    branch: "source_mismatch",
    expectedFinalStatus: "awaiting_human",
    expectedHandoffReason: "insufficient_evidence",
    expectedDatabaseCounts: {
      work_orders: 1,
      knowledge_search_runs: 1,
      evidence_assessments: 1,
      risk_assessments: 1,
      resolution_proposals: 0,
      proposal_user_feedback: 0,
      human_handoffs: 1,
    },
    manualSource: "NVE41300/04/zh-CN",
    evidencePreview: {
      state: "source_mismatch",
      visual: "status_card",
      title: "资料版本不匹配",
      sourceLabel: "请求 04 版 / 知识库仅有 05 版",
      pageNumber: null,
      excerpt: null,
      focusQuestion: sourceCase.search_queries[0],
      explanation: "系统不能用 05 版资料替代用户确认的 04 版资料，因此不展示摘录、不生成处置方案并转人工。",
    },
    demoScenario: "source_mismatch",
    sourceCaseId: "U303",
    productionRecord: false,
  });

  return {
    datasetId: "work-order-end-to-end-holdout-v3",
    dataRole: "project_evaluation_cases_not_production_records",
    manualSource: "NVE41300/05/zh-CN",
    items,
  };
}
