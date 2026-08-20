import { readdir, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { PGlite, type PGliteInterface } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

import { assessEvidenceAndRunRisk } from "../agent-tools/assess-evidence-and-run-risk.ts";
import { searchOfficialKnowledge } from "../agent-tools/search-official-knowledge.ts";
import {
  coordinateWorkOrderTurn,
  type WorkOrderCoordinatorModel,
} from "../coordinator/run-work-order-coordinator.ts";
import type { WorkOrderMainChain } from "../coordinator/work-order-main-chain.ts";
import { createKnowledgeChunkCandidate } from "../knowledge/create-knowledge-chunk-candidate.ts";
import { reviewKnowledgeChunk } from "../knowledge/review-knowledge-chunk.ts";
import { indexApprovedKnowledgeChunk } from "../retrieval/index-approved-knowledge-chunk.ts";
import type { QueryEmbedder } from "../retrieval/search-approved-knowledge.ts";
import { createDraftWorkOrder } from "../work-orders/create-draft-work-order.ts";
import { transitionWorkOrder } from "../work-orders/transition-work-order.ts";
import type {
  QwenAnswerabilityJudge,
} from "./qwen-answerability-judge.ts";
import type {
  WorkOrderEndToEndCandidate,
  WorkOrderEndToEndCase,
  WorkOrderEndToEndFinalState,
  WorkOrderEndToEndHoldoutV2,
} from "./work-order-end-to-end-holdout-v2-dataset.ts";
import {
  scoreWorkOrderEndToEndHoldoutV2,
  type WorkOrderEndToEndActualCase,
} from "./work-order-end-to-end-holdout-v2-runner.ts";

interface BaseCandidateManifest {
  candidates: Array<{
    candidate_key: string;
    content_kind: WorkOrderEndToEndCandidate["content_kind"];
    source_severity: WorkOrderEndToEndCandidate["source_severity"];
    usage_policy: WorkOrderEndToEndCandidate["usage_policy"];
    fault_code?: string;
    section_title: string;
    sources: Array<{ pdf_page_number: number; excerpt: string }>;
  }>;
}

interface OfficialPages {
  pages: Array<{
    pdf_page_number: number;
    extraction_method: "embedded_text";
    extraction_status: "extracted";
    extracted_text: string;
    text_sha256: string;
  }>;
}

interface FixtureIdentity {
  workOrderId: number;
  membershipId: number;
  unauthorizedMembershipId: number;
}

function asCandidate(
  value: BaseCandidateManifest["candidates"][number],
): WorkOrderEndToEndCandidate {
  return {
    candidate_key: value.candidate_key,
    content_kind: value.content_kind,
    source_severity: value.source_severity,
    usage_policy: value.usage_policy,
    fault_code: value.fault_code ?? "OHF",
    section_title: value.section_title,
    risk_boundary_source: "existing_project_candidate_manifest",
    selection_reason: "existing frozen candidate",
    sources: value.sources,
  };
}

async function openMigratedDatabase(): Promise<PGlite> {
  const database = await PGlite.create({
    dataDir: "memory://",
    extensions: { vector },
  });
  const directory = new URL("../../database/migrations/", import.meta.url);
  const migrations = (await readdir(directory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    await database.exec(await readFile(new URL(migration, directory), "utf8"));
  }
  await database.exec(
    await readFile(
      new URL(
        "../../database/seeds/001_atv320_nve41300.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return database;
}

async function seedOfficialKnowledge(
  database: PGlite,
  dataset: WorkOrderEndToEndHoldoutV2,
  embedder: QueryEmbedder,
): Promise<void> {
  const [baseManifest, officialPages] = await Promise.all([
    readFile(dataset.base_candidate_manifest, "utf8").then(
      (raw) => JSON.parse(raw) as BaseCandidateManifest,
    ),
    readFile(dataset.official_page_extract, "utf8").then(
      (raw) => JSON.parse(raw) as OfficialPages,
    ),
  ]);
  const source = await database.query<{
    product_family_id: number;
    source_version_id: number;
  }>(`
    select source_document.product_family_id,
           source_version.id as source_version_id
    from source_versions as source_version
    join source_documents as source_document
      on source_document.id = source_version.source_document_id
    where lower(btrim(source_document.document_reference)) = 'nve41300'
      and lower(btrim(source_version.version_label)) = '05'
      and lower(btrim(source_version.language_code)) = 'zh-cn'
  `);
  if (source.rows.length !== 1) throw new Error("official source seed is missing");
  await database.query(
    `update source_versions set version_status = 'current' where id = $1`,
    [source.rows[0].source_version_id],
  );
  const reviewer = await database.query<{ id: number }>(
    `insert into users (external_subject, display_name) values ('eval|e2e-reviewer-v2', '端到端评测资料核对员') returning id`,
  );
  await database.query(
    `insert into product_family_knowledge_reviewers (product_family_id, user_id) values ($1, $2)`,
    [source.rows[0].product_family_id, reviewer.rows[0].id],
  );

  const candidates = [
    ...baseManifest.candidates.map(asCandidate),
    ...dataset.knowledge_candidates,
  ];
  const pageNumbers = [
    ...new Set(
      candidates.flatMap((candidate) =>
        candidate.sources.map(({ pdf_page_number }) => pdf_page_number),
      ),
    ),
  ];
  const extractionIdByPage = new Map<number, number>();
  for (const pageNumber of pageNumbers) {
    const officialPage = officialPages.pages.find(
      ({ pdf_page_number }) => pdf_page_number === pageNumber,
    );
    if (!officialPage || officialPage.extraction_status !== "extracted") {
      throw new Error(`official page ${pageNumber} is missing`);
    }
    const page = await database.query<{ id: number }>(
      `insert into document_pages (source_version_id, pdf_page_number) values ($1, $2) returning id`,
      [source.rows[0].source_version_id, pageNumber],
    );
    const extraction = await database.query<{ id: number }>(
      `
        insert into page_extractions (
          document_page_id, extraction_method, extractor_name,
          extractor_version, extraction_status, extracted_text, text_sha256
        )
        values ($1, 'embedded_text', 'pypdf', '6.10.0', 'extracted', $2, $3)
        returning id
      `,
      [page.rows[0].id, officialPage.extracted_text, officialPage.text_sha256],
    );
    extractionIdByPage.set(pageNumber, extraction.rows[0].id);
  }

  for (const candidate of candidates) {
    const created = await createKnowledgeChunkCandidate(database, {
      sourceVersionId: source.rows[0].source_version_id,
      contentKind: candidate.content_kind as
        | "fault_definition"
        | "threshold"
        | "reset_condition"
        | "procedure"
        | "diagnostic_context"
        | "safety_warning"
        | "restricted_setting",
      sourceSeverity: candidate.source_severity as
        | "information"
        | "notice"
        | "caution"
        | "warning"
        | "danger",
      usagePolicy: candidate.usage_policy as
        | "reference_only"
        | "low_risk_guidance"
        | "engineer_only",
      faultCode: candidate.fault_code,
      sectionTitle: candidate.section_title,
      chunkingMethod: "manual_selection",
      chunkerName: "work-order-end-to-end-holdout-v2",
      chunkerVersion: "1.0.0",
      sources: candidate.sources.map((item) => ({
        pageExtractionId: extractionIdByPage.get(item.pdf_page_number)!,
        excerpt: item.excerpt,
      })),
    });
    await reviewKnowledgeChunk(database, {
      knowledgeChunkId: created.knowledgeChunkId,
      authenticatedReviewerUserId: reviewer.rows[0].id,
      decision: "approve",
    });
    await indexApprovedKnowledgeChunk(database, {
      knowledgeChunkId: created.knowledgeChunkId,
      embedder,
    });
  }
}

async function createCaseFixture(
  database: PGlite,
  productFamilyId: number,
  equipmentModelId: number,
  item: WorkOrderEndToEndCase,
): Promise<FixtureIdentity> {
  const suffix = item.case_id.toLowerCase();
  const factory = await database.query<{ id: number }>(
    `insert into factories (factory_code, name) values ($1, $2) returning id`,
    [`F-${item.case_id}`, `${item.case_id}评测厂区`],
  );
  const user = await database.query<{ id: number }>(
    `insert into users (external_subject, display_name) values ($1, $2) returning id`,
    [`eval|${suffix}`, `${item.case_id}现场用户`],
  );
  const membership = await database.query<{ id: number }>(
    `insert into factory_memberships (factory_id, user_id, role_code) values ($1, $2, 'operator') returning id`,
    [factory.rows[0].id, user.rows[0].id],
  );
  const equipment = await database.query<{ id: number }>(
    `insert into equipment (factory_id, asset_code, equipment_model_id) values ($1, $2, $3) returning id`,
    [factory.rows[0].id, `INV-${item.case_id}`, equipmentModelId],
  );
  const workOrder = await createDraftWorkOrder(database, {
    workOrderNo: `WO-${item.case_id}`,
    factoryId: factory.rows[0].id,
    equipmentId: equipment.rows[0].id,
    creatorMembershipId: membership.rows[0].id,
    reportedFaultCode: "OHF",
    initialObservation: item.initial_observation,
    idempotencyKey: `create-${suffix}`,
  });
  await transitionWorkOrder(database, {
    workOrderId: workOrder.workOrderId,
    toStatus: "investigating",
    actorKind: "user",
    actorMembershipId: membership.rows[0].id,
    content: "确认型号和厂区后开始排查。",
    idempotencyKey: `investigate-${suffix}`,
  });

  const otherFactory = await database.query<{ id: number }>(
    `insert into factories (factory_code, name) values ($1, $2) returning id`,
    [`F-${item.case_id}-OTHER`, `${item.case_id}其他厂区`],
  );
  const otherUser = await database.query<{ id: number }>(
    `insert into users (external_subject, display_name) values ($1, $2) returning id`,
    [`eval|${suffix}|other`, `${item.case_id}其他厂区用户`],
  );
  const otherMembership = await database.query<{ id: number }>(
    `insert into factory_memberships (factory_id, user_id, role_code) values ($1, $2, 'operator') returning id`,
    [otherFactory.rows[0].id, otherUser.rows[0].id],
  );
  void productFamilyId;
  return {
    workOrderId: workOrder.workOrderId,
    membershipId: membership.rows[0].id,
    unauthorizedMembershipId: otherMembership.rows[0].id,
  };
}

async function readFinalState(
  database: PGlite,
  workOrderId: number,
): Promise<{
  status: WorkOrderEndToEndActualCase["actual_final_status"];
  handoffReason: WorkOrderEndToEndActualCase["actual_handoff_reason"];
  counts: WorkOrderEndToEndFinalState;
}> {
  const result = await database.query<{
    status: WorkOrderEndToEndActualCase["actual_final_status"];
    handoff_reason: WorkOrderEndToEndActualCase["actual_handoff_reason"];
    work_orders: number;
    knowledge_search_runs: number;
    evidence_assessments: number;
    risk_assessments: number;
    resolution_proposals: number;
    proposal_user_feedback: number;
    human_handoffs: number;
  }>(
    `
      select
        work_order.status,
        (
          select reason_code from human_handoffs
          where work_order_id = work_order.id
          order by id desc limit 1
        ) as handoff_reason,
        (select count(*)::integer from work_orders where id = work_order.id) as work_orders,
        (select count(*)::integer from knowledge_search_runs where work_order_id = work_order.id) as knowledge_search_runs,
        (select count(*)::integer from evidence_assessments where work_order_id = work_order.id) as evidence_assessments,
        (select count(*)::integer from risk_assessments where work_order_id = work_order.id) as risk_assessments,
        (select count(*)::integer from resolution_proposals where work_order_id = work_order.id) as resolution_proposals,
        (select count(*)::integer from proposal_user_feedback where work_order_id = work_order.id) as proposal_user_feedback,
        (select count(*)::integer from human_handoffs where work_order_id = work_order.id) as human_handoffs
      from work_orders as work_order
      where work_order.id = $1
    `,
    [workOrderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("work order final state is missing");
  return {
    status: row.status,
    handoffReason: row.handoff_reason,
    counts: {
      work_orders: row.work_orders,
      knowledge_search_runs: row.knowledge_search_runs,
      evidence_assessments: row.evidence_assessments,
      risk_assessments: row.risk_assessments,
      resolution_proposals: row.resolution_proposals,
      proposal_user_feedback: row.proposal_user_feedback,
      human_handoffs: row.human_handoffs,
    },
  };
}

async function executeCase(
  database: PGlite,
  item: WorkOrderEndToEndCase,
  fixture: FixtureIdentity,
  input: {
    embedder: QueryEmbedder;
    judge: QwenAnswerabilityJudge;
    coordinatorModel: WorkOrderCoordinatorModel;
  },
): Promise<WorkOrderEndToEndActualCase> {
  const startedAt = performance.now();
  const verdicts: WorkOrderEndToEndActualCase["actual_evidence_verdicts"] = [];
  const judgeErrors: string[] = [];
  let workflowError: string | null = null;
  try {
    if (item.branch === "unauthorized_factory") {
      try {
        await searchOfficialKnowledge(database, {
          workOrderId: fixture.workOrderId,
          requesterMembershipId: fixture.unauthorizedMembershipId,
          queryText: item.search_queries[0],
          idempotencyKey: `${item.case_id}:unauthorized-search`,
          limit: 5,
          embedder: input.embedder,
        });
        workflowError = "unauthorized factory search unexpectedly succeeded";
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        if (!message.includes("active membership for the work order factory is required")) {
          workflowError = message;
        }
      }
    } else {
      for (let index = 0; index < item.search_queries.length; index += 1) {
        const search = await searchOfficialKnowledge(database, {
          workOrderId: fixture.workOrderId,
          requesterMembershipId: fixture.membershipId,
          queryText: item.search_queries[index],
          idempotencyKey: `${item.case_id}:search:${index + 1}`,
          limit: 5,
          embedder: input.embedder,
        });
        const assessed = await assessEvidenceAndRunRisk(database, {
          workOrderId: fixture.workOrderId,
          requesterMembershipId: fixture.membershipId,
          searchRunId: search.searchRunId,
          evidenceIdempotencyKey: `${item.case_id}:evidence:${index + 1}`,
          riskIdempotencyKey: `${item.case_id}:risk:${index + 1}`,
          judge: input.judge,
        });
        const verdict = assessed.evidenceAssessment?.verdict ?? null;
        verdicts.push(verdict);
        if (verdict === "judge_error") {
          judgeErrors.push(assessed.evidenceAssessment!.reason);
        }
        if (assessed.riskAssessment.decision === "human_handoff_required") break;

        const drafted = await coordinateWorkOrderTurn(database, {
          workOrderId: fixture.workOrderId,
          requesterMembershipId: fixture.membershipId,
          userMessage:
            index === 0
              ? "只根据已经核验的低风险证据，生成完整的当前版本方案。"
              : "结合第一版现场反馈和新证据，生成第二版方案。",
          requestId: `${item.case_id}:proposal:${index + 1}`,
          model: input.coordinatorModel,
          embedder: input.embedder,
          answerabilityJudge: input.judge,
        });
        if (drafted.contextAfter.workOrder.status === "awaiting_human") break;
        await coordinateWorkOrderTurn(database, {
          workOrderId: fixture.workOrderId,
          requesterMembershipId: fixture.membershipId,
          userMessage: "把当前方案提交给现场用户确认。",
          requestId: `${item.case_id}:request-confirmation:${index + 1}`,
          model: input.coordinatorModel,
          embedder: input.embedder,
          answerabilityJudge: input.judge,
        });
        const outcome = item.feedback_outcomes[index];
        if (!outcome) throw new Error("case is missing a frozen feedback outcome");
        await coordinateWorkOrderTurn(database, {
          workOrderId: fixture.workOrderId,
          requesterMembershipId: fixture.membershipId,
          userMessage:
            outcome === "resolved"
              ? "现场已经按方案完成外部核查，设备已恢复，OHF不再出现。"
              : "现场已经按方案完成外部核查，但设备未恢复，OHF仍然出现。",
          requestId: `${item.case_id}:feedback:${index + 1}`,
          model: input.coordinatorModel,
          embedder: input.embedder,
          answerabilityJudge: input.judge,
        });
        if (outcome === "resolved" || index === item.search_queries.length - 1) break;
      }
    }
  } catch (caught) {
    workflowError = caught instanceof Error ? caught.message : String(caught);
  }
  const final = await readFinalState(database, fixture.workOrderId);
  return {
    case_id: item.case_id,
    actual_evidence_verdicts: verdicts,
    actual_final_status: final.status,
    actual_handoff_reason: final.handoffReason,
    actual_final_state: final.counts,
    judge_errors: judgeErrors,
    workflow_error: workflowError,
    duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

interface WorkOrderEndToEndExecutorBaseInput {
  dataset: WorkOrderEndToEndHoldoutV2;
  embedder: QueryEmbedder;
}

interface WorkOrderEndToEndLegacyRuntimeInput
  extends WorkOrderEndToEndExecutorBaseInput {
  judge: QwenAnswerabilityJudge;
  coordinatorModel: WorkOrderCoordinatorModel;
  createMainChain?: never;
}

interface WorkOrderEndToEndFormalRuntimeInput
  extends WorkOrderEndToEndExecutorBaseInput {
  judge?: never;
  coordinatorModel?: never;
  createMainChain(
    database: PGliteInterface,
    embedder: QueryEmbedder,
  ): Pick<WorkOrderMainChain, "answerabilityJudge" | "coordinatorModel">;
}

export async function executeWorkOrderEndToEndHoldoutV2(
  input:
    | WorkOrderEndToEndLegacyRuntimeInput
    | WorkOrderEndToEndFormalRuntimeInput,
) {
  if (
    input.embedder.modelId !== input.dataset.strategy.embedding_model_id ||
    input.embedder.modelRevision !==
      input.dataset.strategy.embedding_model_revision
  ) {
    throw new Error("work-order end-to-end runtime does not match frozen strategy");
  }
  const database = await openMigratedDatabase();
  try {
    const formalRuntime = input.createMainChain?.(database, input.embedder);
    const judge = formalRuntime?.answerabilityJudge ?? input.judge;
    const coordinatorModel =
      formalRuntime?.coordinatorModel ?? input.coordinatorModel;
    if (!judge || !coordinatorModel) {
      throw new Error("work-order end-to-end runtime dependencies are missing");
    }
    if (
      judge.modelId !== input.dataset.strategy.judge_model_id ||
      judge.promptVersion !== input.dataset.strategy.judge_prompt_version ||
      coordinatorModel.modelId !==
        input.dataset.strategy.coordinator_model_id ||
      coordinatorModel.promptVersion !==
        input.dataset.strategy.coordinator_prompt_version
    ) {
      throw new Error("work-order end-to-end runtime does not match frozen strategy");
    }
    await seedOfficialKnowledge(database, input.dataset, input.embedder);
    const product = await database.query<{ id: number }>(
      `select id from product_families where lower(btrim(family_code)) = 'atv320'`,
    );
    const model = await database.query<{ id: number }>(
      `insert into equipment_models (product_family_id, model_code, display_name) values ($1, 'ATV320-E2E-V2', 'ATV320端到端评测型号') returning id`,
      [product.rows[0].id],
    );
    const actualCases: WorkOrderEndToEndActualCase[] = [];
    for (const item of input.dataset.cases) {
      const fixture = await createCaseFixture(
        database,
        product.rows[0].id,
        model.rows[0].id,
        item,
      );
      actualCases.push(
        await executeCase(database, item, fixture, {
          embedder: input.embedder,
          judge,
          coordinatorModel,
        }),
      );
    }
    return {
      actualCases,
      report: scoreWorkOrderEndToEndHoldoutV2(input.dataset, actualCases, {
        judge_model_id: judge.modelId,
        coordinator_model_id: coordinatorModel.modelId,
      }),
    };
  } finally {
    await database.close();
  }
}


