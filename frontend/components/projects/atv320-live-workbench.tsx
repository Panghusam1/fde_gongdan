"use client";

import Image from "next/image";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";

import { ArrowLeft, ArrowUpRight } from "@/components/icons";

type DemoScenario =
  | "normal"
  | "high_risk"
  | "insufficient_evidence"
  | "unauthorized_factory"
  | "source_mismatch";
type HealthState = "unconfigured" | "checking" | "online" | "offline";
type RunState = "idle" | "running" | "success" | "error";
type CatalogState = "idle" | "loading" | "ready" | "error";
type QueueFilter = "all" | "active" | "human" | "finished" | "demo";
type WorkOrderStatus =
  | "draft"
  | "investigating"
  | "awaiting_information"
  | "awaiting_user_confirmation"
  | "awaiting_human"
  | "human_processing"
  | "resolved"
  | "closed";

type DatabaseCounts = {
  work_orders: number;
  knowledge_search_runs: number;
  evidence_assessments: number;
  risk_assessments: number;
  resolution_proposals: number;
  proposal_user_feedback: number;
  human_handoffs: number;
};

type EvidencePreview = {
  state:
    | "not_started"
    | "verified_manual"
    | "risk_blocked"
    | "insufficient_evidence"
    | "access_blocked"
    | "source_mismatch";
  visual: "manual_page" | "status_card";
  title: string;
  sourceLabel: string;
  pageNumber: number | null;
  excerpt: string | null;
  focusQuestion: string;
  explanation: string;
};

type DemoWorkOrder = {
  workOrderNo: string;
  caseId: string;
  factoryName: string;
  assetCode: string;
  equipmentModel: string;
  faultCode: "OHF";
  status: WorkOrderStatus;
  stage: 1 | 2 | 3 | 4 | 5 | 6;
  observation: string;
  query: string;
  branch: string;
  expectedFinalStatus: string;
  expectedHandoffReason: string | null;
  expectedDatabaseCounts: DatabaseCounts;
  manualSource: "NVE41300/05/zh-CN" | "NVE41300/04/zh-CN";
  evidencePreview: EvidencePreview;
  demoScenario: DemoScenario | null;
  sourceCaseId: string;
  productionRecord: false;
};

type WorkOrderCatalog = {
  datasetId: "work-order-end-to-end-holdout-v3";
  dataRole: "project_evaluation_cases_not_production_records";
  manualSource: "NVE41300/05/zh-CN";
  items: DemoWorkOrder[];
};

type DemoBranchResult = {
  scenario:
    | "confirmed_source_normal_resolution"
    | "input_high_risk_handoff"
    | "insufficient_evidence_handoff"
    | "unauthorized_factory_blocked"
    | "confirmed_source_missing_handoff";
  requestedSource: "NVE41300/05/zh-CN" | "NVE41300/04/zh-CN";
  evidenceVerdicts: Array<"directly_answerable" | "not_answerable" | null>;
  finalStatus: "investigating" | "resolved" | "awaiting_human";
  handoffReason:
    | null
    | "high_risk"
    | "insufficient_evidence"
    | "two_proposals_failed";
  contentModelCallCount: number;
  databaseCounts: DatabaseCounts;
};

type DemoApiResponse = {
  service: "atv320-workorder-demo";
  executionMode: "controlled_offline_real_database";
  scenario: DemoScenario;
  result: DemoBranchResult;
};

const processSteps = [
  ["01", "工单接入", "确认厂区、设备与故障事实"],
  ["02", "资料检索", "限定产品、资料编号、版本与语言"],
  ["03", "证据判断", "判断当前证据能否直接回答"],
  ["04", "风险判断", "固定规则先于模型执行"],
  ["05", "处置与流转", "生成方案或创建人工接管"],
  ["06", "结果留痕", "记录反馈、终态和数据库审计"],
] as const;

const statusLabels: Record<WorkOrderStatus, string> = {
  draft: "草稿待确认",
  investigating: "处理中",
  awaiting_information: "等待资料",
  awaiting_user_confirmation: "等待现场确认",
  awaiting_human: "等待人工",
  human_processing: "人工处理中",
  resolved: "已解决",
  closed: "已结束",
};

const filterOptions: Array<{ id: QueueFilter; label: string }> = [
  { id: "all", label: "全部工单" },
  { id: "active", label: "处理中" },
  { id: "human", label: "等待人工" },
  { id: "finished", label: "已结束" },
  { id: "demo", label: "主演示" },
];

const primaryDemoScenarios = [
  "normal",
  "high_risk",
  "source_mismatch",
] as const;

const primaryDemoRank = Object.fromEntries(
  primaryDemoScenarios.map((scenario, index) => [scenario, index]),
) as Partial<Record<DemoScenario, number>>;

function isPrimaryDemoScenario(
  scenario: DemoScenario | null,
): scenario is (typeof primaryDemoScenarios)[number] {
  return scenario !== null && primaryDemoRank[scenario] !== undefined;
}

const scenarioLabels: Record<DemoScenario, string> = {
  normal: "资料版本匹配",
  high_risk: "高危输入转人工",
  insufficient_evidence: "证据不足转人工",
  unauthorized_factory: "未授权厂区阻断",
  source_mismatch: "资料版本不匹配",
};

const evidenceStateLabels: Record<EvidencePreview["state"], string> = {
  not_started: "待检索",
  verified_manual: "已核验",
  risk_blocked: "高危阻断",
  insufficient_evidence: "证据缺口",
  access_blocked: "权限阻断",
  source_mismatch: "版本冲突",
};

const evidenceStateImages: Record<
  EvidencePreview["state"],
  { src: string; alt: string }
> = {
  verified_manual: {
    src: "/images/projects/atv320/atv320-evidence-provenance-v1.png",
    alt: "ATV320 设备与官方手册证据关系示意",
  },
  risk_blocked: {
    src: "/images/projects/atv320/atv320-evidence-high-risk-v1.png",
    alt: "过热设备被安全挡杆和急停装置隔离",
  },
  insufficient_evidence: {
    src: "/images/projects/atv320/atv320-evidence-insufficient-v1.png",
    alt: "官方产品资料与现场维修记录之间存在数据缺口",
  },
  source_mismatch: {
    src: "/images/projects/atv320/atv320-evidence-source-mismatch-v1.png",
    alt: "两个不同版本的设备资料无法互相替代",
  },
  access_blocked: {
    src: "/images/projects/atv320/atv320-evidence-access-blocked-v1.png",
    alt: "跨厂区数据访问被权限门阻断",
  },
  not_started: {
    src: "/images/projects/atv320/atv320-evidence-retrieval-pending-v1.png",
    alt: "设备已登记但知识检索尚未开始",
  },
};

const auditLabels: Array<[keyof DatabaseCounts, string]> = [
  ["work_orders", "工单"],
  ["knowledge_search_runs", "资料检索"],
  ["evidence_assessments", "证据判断"],
  ["risk_assessments", "风险判断"],
  ["resolution_proposals", "处置方案"],
  ["proposal_user_feedback", "现场反馈"],
  ["human_handoffs", "人工接管"],
];

const healthLabels: Record<HealthState, string> = {
  unconfigured: "后端未配置",
  checking: "正在连接",
  online: "后端已连接",
  offline: "后端不可用",
};

function errorMessage(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }
  return "后端没有返回可识别的错误信息。";
}

export function Atv320LiveWorkbench({ apiBaseUrl }: { apiBaseUrl: string }) {
  const normalizedApiBaseUrl = apiBaseUrl.replace(/\/$/u, "");
  const [healthState, setHealthState] = useState<HealthState>(
    normalizedApiBaseUrl ? "checking" : "unconfigured",
  );
  const [catalogState, setCatalogState] = useState<CatalogState>(
    normalizedApiBaseUrl ? "idle" : "error",
  );
  const [catalog, setCatalog] = useState<WorkOrderCatalog | null>(null);
  const [selectedWorkOrderNo, setSelectedWorkOrderNo] = useState("");
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all");
  const [runState, setRunState] = useState<RunState>("idle");
  const [response, setResponse] = useState<DemoApiResponse | null>(null);
  const [runError, setRunError] = useState("");

  useEffect(() => {
    if (!normalizedApiBaseUrl) return;
    const controller = new AbortController();

    async function loadWorkbench() {
      setHealthState("checking");
      setCatalogState("loading");
      const [healthResult, catalogResult] = await Promise.allSettled([
        fetch(`${normalizedApiBaseUrl}/health`, {
          cache: "no-store",
          signal: controller.signal,
        }),
        fetch(`${normalizedApiBaseUrl}/api/work-orders`, {
          cache: "no-store",
          signal: controller.signal,
        }),
      ]);
      if (controller.signal.aborted) return;
      setHealthState(
        healthResult.status === "fulfilled" && healthResult.value.ok
          ? "online"
          : "offline",
      );
      if (catalogResult.status !== "fulfilled" || !catalogResult.value.ok) {
        setCatalogState("error");
        return;
      }
      const payload: unknown = await catalogResult.value.json().catch(() => null);
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("items" in payload) ||
        !Array.isArray(payload.items) ||
        payload.items.length === 0
      ) {
        setCatalogState("error");
        return;
      }
      const nextCatalog = payload as WorkOrderCatalog;
      setCatalog(nextCatalog);
      setSelectedWorkOrderNo((current) =>
        current ||
        nextCatalog.items.find(({ demoScenario }) => demoScenario === "normal")
          ?.workOrderNo ||
        nextCatalog.items[0].workOrderNo,
      );
      setCatalogState("ready");
    }

    void loadWorkbench();
    return () => controller.abort();
  }, [normalizedApiBaseUrl]);

  const selectedWorkOrder =
    catalog?.items.find(({ workOrderNo }) => workOrderNo === selectedWorkOrderNo) ??
    catalog?.items[0] ??
    null;

  function selectWorkOrder(workOrder: DemoWorkOrder) {
    if (runState === "running") return;
    setSelectedWorkOrderNo(workOrder.workOrderNo);
    setResponse(null);
    setRunState("idle");
    setRunError("");
  }

  async function runDemo() {
    if (
      !normalizedApiBaseUrl ||
      !selectedWorkOrder?.demoScenario ||
      runState === "running"
    ) {
      return;
    }
    setRunState("running");
    setRunError("");
    setResponse(null);

    try {
      const demoResponse = await fetch(`${normalizedApiBaseUrl}/api/demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: selectedWorkOrder.demoScenario }),
      });
      const payload: unknown = await demoResponse.json().catch(() => null);
      if (!demoResponse.ok) throw new Error(errorMessage(payload));
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("result" in payload)
      ) {
        throw new Error("后端返回结构不完整。请检查前后端版本是否一致。");
      }
      setResponse(payload as DemoApiResponse);
      setHealthState("online");
      setRunState("success");
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "未知网络错误");
      setHealthState("offline");
      setRunState("error");
    }
  }

  const filteredWorkOrders =
    catalog?.items.filter((item) => {
      if (queueFilter === "all") return true;
      if (queueFilter === "demo") {
        return isPrimaryDemoScenario(item.demoScenario);
      }
      if (queueFilter === "human") {
        return ["awaiting_human", "human_processing"].includes(item.status);
      }
      if (queueFilter === "finished") {
        return ["resolved", "closed"].includes(item.status);
      }
      return [
        "draft",
        "investigating",
        "awaiting_information",
        "awaiting_user_confirmation",
      ].includes(item.status);
    }) ?? [];
  const orderedWorkOrders = filteredWorkOrders.toSorted((left, right) => {
    const leftRank = left.demoScenario
      ? (primaryDemoRank[left.demoScenario] ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    const rightRank = right.demoScenario
      ? (primaryDemoRank[right.demoScenario] ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
  const visiblePrimaryDemoCount = orderedWorkOrders.filter(({ demoScenario }) =>
    isPrimaryDemoScenario(demoScenario),
  ).length;
  const result = response?.result ?? null;
  const evidencePreview = selectedWorkOrder
    ? selectedWorkOrder.evidencePreview
    : null;
  const evidenceImage = evidencePreview
    ? evidenceStateImages[evidencePreview.state]
    : null;
  const displayCounts =
    result?.databaseCounts ?? selectedWorkOrder?.expectedDatabaseCounts ?? null;
  const resolvedCount =
    catalog?.items.filter(({ status }) => ["resolved", "closed"].includes(status))
      .length ?? 0;
  const humanCount =
    catalog?.items.filter(({ status }) =>
      ["awaiting_human", "human_processing"].includes(status),
    ).length ?? 0;
  const primaryDemoCount =
    catalog?.items.filter(({ demoScenario }) =>
      isPrimaryDemoScenario(demoScenario),
    ).length ?? 0;
  const finalStatus = result?.finalStatus ?? selectedWorkOrder?.status ?? "draft";
  const finalStatusLabel =
    finalStatus in statusLabels
      ? statusLabels[finalStatus as WorkOrderStatus]
      : finalStatus;
  const evidenceLabel = !result
    ? "等待运行"
    : result.evidenceVerdicts.length === 0
      ? "权限校验前已阻断"
      : result.evidenceVerdicts[0] === null
        ? "高危输入，跳过内容判断"
        : result.evidenceVerdicts[0] === "directly_answerable"
          ? "证据可以直接回答"
          : "当前证据不能回答";
  const handoffLabel = !result?.handoffReason
    ? "无"
    : result.handoffReason === "high_risk"
      ? "高危输入"
      : result.handoffReason === "insufficient_evidence"
        ? "证据不足"
        : "两版方案均未解决";
  const processState = processSteps.map((_, index) => {
    const stage = index + 1;
    if (!result) {
      if (!selectedWorkOrder) return "pending";
      if (["resolved", "closed"].includes(selectedWorkOrder.status)) {
        return stage <= selectedWorkOrder.stage ? "complete" : "pending";
      }
      return stage < selectedWorkOrder.stage
        ? "complete"
        : stage === selectedWorkOrder.stage
          ? "current"
          : "pending";
    }
    if (stage === 1) return result.databaseCounts.work_orders ? "complete" : "pending";
    if (stage === 2) {
      return result.databaseCounts.knowledge_search_runs
        ? "complete"
        : result.finalStatus === "investigating"
          ? "current"
          : "pending";
    }
    if (stage === 3) {
      if (result.databaseCounts.evidence_assessments) return "complete";
      return result.databaseCounts.risk_assessments ? "skipped" : "pending";
    }
    if (stage === 4) return result.databaseCounts.risk_assessments ? "complete" : "pending";
    if (stage === 5) {
      return result.databaseCounts.resolution_proposals || result.databaseCounts.human_handoffs
        ? "complete"
        : "pending";
    }
    return result.finalStatus === "resolved"
      ? "complete"
      : result.finalStatus === "awaiting_human"
        ? "current"
        : "pending";
  });

  return (
    <main id="main-content" className="atv-ops-workbench">
      <header className="atv-ops-toolbar">
        <Link href="/" aria-label="返回工单演示台首页">
          <ArrowLeft />
        </Link>
        <div className="atv-ops-brand">
          <strong>ATV320 维修工单运营台</strong>
          <span>多工单监控、证据核验与安全流转</span>
        </div>
        <div className="atv-ops-source-chip">
          <span>数据来源</span>
          <strong>冻结评测集 v3 · 官方手册 05</strong>
        </div>
        <div className="atv-ops-toolbar__spacer" />
        <div className="atv-ops-health" data-state={healthState} aria-live="polite">
          <b aria-hidden="true" />
          {healthLabels[healthState]}
        </div>
        <button
          type="button"
          className="atv-ops-toolbar__run"
          onClick={runDemo}
          disabled={
            !selectedWorkOrder?.demoScenario ||
            !normalizedApiBaseUrl ||
            runState === "running"
          }
        >
          <span aria-hidden="true">▶</span>
          {runState === "running" ? "正在运行" : "运行当前案例"}
        </button>
      </header>

      <div className="atv-ops-console">
        <aside className="atv-ops-queue" aria-labelledby="atv-queue-title">
          <div className="atv-ops-queue__header">
            <div>
              <span>WORK ORDERS</span>
              <h1 id="atv-queue-title">工单队列</h1>
            </div>
            <strong>{catalog?.items.length ?? "—"}</strong>
          </div>

          <div className="atv-ops-queue__source">
            <strong>项目真实评测数据</strong>
            <p>本队列来自项目冻结评测集，关联官方手册原文；非客户生产记录。</p>
          </div>

          <div className="atv-ops-filters" aria-label="工单筛选">
            {filterOptions.map((option) => (
              <button
                type="button"
                key={option.id}
                data-active={queueFilter === option.id}
                onClick={() => setQueueFilter(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="atv-ops-queue__list" aria-live="polite">
            {catalogState === "loading" ? (
              <p className="atv-ops-queue__message">正在从后端读取工单目录……</p>
            ) : null}
            {catalogState === "error" ? (
              <p className="atv-ops-queue__message">工单目录读取失败，请检查本地后端。</p>
            ) : null}
            {orderedWorkOrders.map((item, index) => {
              const isPrimaryDemo = isPrimaryDemoScenario(item.demoScenario);
              return (
                <Fragment key={item.workOrderNo}>
                  {index === 0 && visiblePrimaryDemoCount > 0 ? (
                    <div className="atv-ops-queue__group" data-tone="primary">
                      <strong>现场演示案例</strong>
                      <span>{visiblePrimaryDemoCount} 条</span>
                    </div>
                  ) : null}
                  {index === visiblePrimaryDemoCount &&
                  orderedWorkOrders.length > visiblePrimaryDemoCount ? (
                    <div className="atv-ops-queue__group">
                      <strong>其他阶段记录</strong>
                      <span>{orderedWorkOrders.length - visiblePrimaryDemoCount} 条</span>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="atv-ops-ticket"
                    data-active={selectedWorkOrder?.workOrderNo === item.workOrderNo}
                    data-status={item.status}
                    data-demo={isPrimaryDemo ? "primary" : item.demoScenario ? "extended" : "none"}
                    aria-pressed={selectedWorkOrder?.workOrderNo === item.workOrderNo}
                    onClick={() => selectWorkOrder(item)}
                    disabled={runState === "running"}
                  >
                    <span className="atv-ops-ticket__rail" aria-hidden="true" />
                    <div className="atv-ops-ticket__topline">
                      <code>{item.workOrderNo}</code>
                      <span>{statusLabels[item.status]}</span>
                    </div>
                    <strong>{item.observation}</strong>
                    <div className="atv-ops-ticket__meta">
                      <span>{item.factoryName}</span>
                      <span>阶段 {item.stage}/6</span>
                      {isPrimaryDemo && item.demoScenario ? (
                        <em>现场演示 · {scenarioLabels[item.demoScenario]}</em>
                      ) : item.demoScenario ? (
                        <em>扩展验证</em>
                      ) : null}
                    </div>
                  </button>
                </Fragment>
              );
            })}
          </div>
        </aside>

        <section className="atv-ops-workspace" aria-label="工单工作区">
          <div className="atv-ops-summary" aria-label="队列统计">
            <article><span>全部工单</span><strong>{catalog?.items.length ?? "—"}</strong></article>
            <article><span>主演示案例</span><strong>{primaryDemoCount || "—"}</strong></article>
            <article><span>等待人工</span><strong>{humanCount || "—"}</strong></article>
            <article><span>已结束</span><strong>{resolvedCount || "—"}</strong></article>
            <p>模拟工单 · 真实手册｜模拟厂区与工单 · 真实官方手册 · 受控离线模型 · 真实数据库执行链。</p>
          </div>

          {selectedWorkOrder ? (
            <>
              <header className="atv-ops-case-header">
                <div>
                  <span>当前工单 / {selectedWorkOrder.caseId}</span>
                  <h2>{selectedWorkOrder.observation}</h2>
                  <p>{selectedWorkOrder.query}</p>
                </div>
                <div className="atv-ops-case-header__actions">
                  <span data-status={finalStatus}>{finalStatusLabel}</span>
                  {selectedWorkOrder.demoScenario ? (
                    <button
                      type="button"
                      onClick={runDemo}
                      disabled={runState === "running" || !normalizedApiBaseUrl}
                    >
                      {runState === "running" ? "正在运行完整链路" : "现场运行此案例"}
                      <ArrowUpRight />
                    </button>
                  ) : (
                    <small>阶段展示记录 · 不执行</small>
                  )}
                </div>
              </header>

              <ol className="atv-ops-stepper" aria-label="工单处理流程">
                {processSteps.map(([code, label], index) => (
                  <li key={code} data-state={processState[index]}>
                    <span>{processState[index] === "complete" ? "✓" : code}</span>
                    <div>
                      <strong>{label}</strong>
                      <small>
                        {processState[index] === "complete"
                          ? "已完成"
                          : processState[index] === "current"
                            ? "当前阶段"
                            : processState[index] === "skipped"
                              ? "规则跳过"
                              : "待处理"}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>

              <div className="atv-ops-workspace__body">
                <div className="atv-ops-primary-column">
                  <section className="atv-ops-panel atv-ops-facts">
                    <div className="atv-ops-panel__heading">
                      <h2>设备与故障事实</h2>
                      <span>来自冻结案例记录</span>
                    </div>
                    <dl>
                      <div><dt>工单编号</dt><dd>{selectedWorkOrder.workOrderNo}</dd></div>
                      <div><dt>评测厂区</dt><dd>{selectedWorkOrder.factoryName}</dd></div>
                      <div><dt>设备资产</dt><dd>{selectedWorkOrder.assetCode}</dd></div>
                      <div><dt>设备模型</dt><dd>{selectedWorkOrder.equipmentModel}</dd></div>
                      <div><dt>故障代码</dt><dd>{selectedWorkOrder.faultCode}</dd></div>
                      <div><dt>当前阶段</dt><dd>{processSteps[selectedWorkOrder.stage - 1][1]}</dd></div>
                      <div><dt>资料来源</dt><dd>{selectedWorkOrder.manualSource}</dd></div>
                      <div><dt>来源案例</dt><dd>{selectedWorkOrder.sourceCaseId}</dd></div>
                    </dl>
                    <div className="atv-ops-observation">
                      <span>现场证据摘要</span>
                      <p>{selectedWorkOrder.observation}</p>
                    </div>
                  </section>

                  {evidencePreview && evidenceImage ? (
                    <figure
                      className="atv-ops-panel atv-ops-evidence-preview"
                      data-state={evidencePreview.state}
                    >
                      <div className="atv-ops-panel__heading">
                        <h2>当前工单证据</h2>
                        <span>
                          {evidencePreview.pageNumber
                            ? `${evidencePreview.sourceLabel} · 第 ${evidencePreview.pageNumber} 页`
                            : evidencePreview.sourceLabel}
                        </span>
                      </div>
                      <div className="atv-ops-evidence-preview__content">
                        <div className="atv-ops-evidence-preview__image">
                          <Image
                            src={evidenceImage.src}
                            alt={evidenceImage.alt}
                            fill
                            sizes="(max-width: 820px) 100vw, 42vw"
                            priority={evidencePreview.state === "verified_manual"}
                          />
                          <span>
                            <b>
                              {evidencePreview.state === "verified_manual" ? "来源示意" : "状态示意"}
                            </b>
                            {` · ${evidenceStateLabels[evidencePreview.state]}`}
                          </span>
                        </div>
                        <figcaption>
                          <span>{evidencePreview.title}</span>
                          {evidencePreview.excerpt ? (
                            <blockquote>{evidencePreview.excerpt}</blockquote>
                          ) : null}
                          <strong>本工单核验问题</strong>
                          <p>{evidencePreview.focusQuestion}</p>
                          <small>{evidencePreview.explanation}</small>
                        </figcaption>
                      </div>
                    </figure>
                  ) : null}
                </div>

                <div className="atv-ops-control-column">
                  <section className="atv-ops-panel atv-ops-decision-log">
                    <div className="atv-ops-panel__heading">
                      <h2>系统判断记录</h2>
                      <span>{result ? "本次实际结果" : "运行前预期"}</span>
                    </div>
                    <dl>
                      <div><dt>资料身份</dt><dd>{result?.requestedSource ?? selectedWorkOrder.manualSource}</dd></div>
                      <div><dt>证据判断</dt><dd>{evidenceLabel}</dd></div>
                      <div><dt>最终状态</dt><dd>{finalStatusLabel}</dd></div>
                      <div><dt>人工原因</dt><dd>{handoffLabel}</dd></div>
                      <div><dt>内容模型调用</dt><dd>{result ? result.contentModelCallCount : "—"}</dd></div>
                    </dl>
                    {runState === "error" ? (
                      <p className="atv-ops-error" role="alert"><strong>运行失败</strong>{runError}</p>
                    ) : null}
                  </section>

                  <section className="atv-ops-panel atv-ops-safety">
                    <div className="atv-ops-panel__heading">
                      <h2>安全与审批</h2>
                      <span>程序规则优先</span>
                    </div>
                    <div className="atv-ops-safety__result" data-state={result?.finalStatus ?? selectedWorkOrder.status}>
                      <span>当前流转</span>
                      <strong>{finalStatusLabel}</strong>
                      <p>
                        {result?.handoffReason
                          ? `系统已停止自动处理，转人工原因：${handoffLabel}。`
                          : result?.finalStatus === "resolved"
                            ? "现场确认已经写入，工单形成完整闭环。"
                            : "运行案例后显示真实后端流转结果。"}
                      </p>
                    </div>
                  </section>

                  <section className="atv-ops-panel atv-ops-db-trace">
                    <div className="atv-ops-panel__heading">
                      <h2>数据库留痕</h2>
                      <span>{result ? "本次实际" : "冻结预期"}</span>
                    </div>
                    <dl>
                      {auditLabels.map(([key, label]) => (
                        <div key={key}>
                          <dt>{label}</dt>
                          <dd>{displayCounts ? displayCounts[key] : "—"}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                </div>
              </div>

              <section className="atv-ops-timeline" aria-labelledby="atv-timeline-title">
                <div>
                  <h2 id="atv-timeline-title">审计时间线</h2>
                  <span>六个节点对应数据库中的执行记录</span>
                </div>
                <ol>
                  {processSteps.map(([code, label, note], index) => (
                    <li key={code} data-state={processState[index]}>
                      <span>{code}</span>
                      <i aria-hidden="true" />
                      <strong>{label}</strong>
                      <small>{note}</small>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          ) : (
            <div className="atv-ops-empty">正在准备多工单工作区……</div>
          )}
        </section>
      </div>
    </main>
  );
}
