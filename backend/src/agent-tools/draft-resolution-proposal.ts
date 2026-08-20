import { createHash } from "node:crypto";

import type { PGliteInterface } from "@electric-sql/pglite";

export interface DraftResolutionProposalInput {
  workOrderId: number;
  requesterMembershipId: number;
  riskAssessmentId: number;
  evidenceSearchHitIds: number[];
  summary: string;
  confirmedFacts: string[];
  assumptions: string[];
  steps: string[];
  stopConditions: string[];
  expectedObservations: string[];
  modelId: string;
  modelVersion: string;
  promptVersion: string;
  idempotencyKey: string;
  basisObservationEventId?: number;
}

export interface DraftedResolutionProposal {
  outcome: "proposal_created";
  proposalId: number;
  proposalVersion: 1 | 2;
  workOrderId: number;
  riskAssessmentId: number;
  searchRunId: number;
  evidenceSearchHitIds: number[];
}

export interface ResolutionProposalHandoff {
  outcome: "human_handoff_required";
  proposalId: null;
  proposalVersion: null;
  humanHandoffId: number;
  workOrderId: number;
  riskAssessmentId: number;
  searchRunId: number;
  reasonCode: "high_risk" | "no_new_evidence";
}

export type DraftResolutionProposalResult =
  | DraftedResolutionProposal
  | ResolutionProposalHandoff;

interface WorkOrderScope {
  id: number;
  factory_id: number;
  equipment_id: number;
  status: string;
  requester_is_authorized: boolean;
}

interface RiskAssessmentScope {
  id: number;
  search_run_id: number;
  evidence_assessment_id: number | null;
  selected_search_hit_id: number | null;
  decision: string;
  blocked: boolean;
  evidence_sufficient: boolean;
  overall_risk_level: string;
}

interface PersistedProposal {
  id: number;
  proposal_version: 1 | 2;
  risk_assessment_id: number;
  search_run_id: number;
  requester_membership_id: number;
  content_sha256: string;
}

interface PersistedHandoff {
  id: number;
  risk_assessment_id: number;
  reason_code: "high_risk" | "no_new_evidence";
}

const proposalActionPolicyVersion = "1.0.0";
const prohibitedProposalActionTerms = [
  "带电测量",
  "拆开设备",
  "拆机",
  "开柜",
  "拆线",
  "绕过保护",
  "更换部件",
] as const;

function normalizeText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${fieldName} must not be blank`);
  return normalized;
}

function normalizeTextList(
  values: string[],
  fieldName: string,
  allowEmpty = false,
): string[] {
  if (!Array.isArray(values)) throw new Error(`${fieldName} must be an array`);
  const normalized = values.map((value) => normalizeText(value, fieldName));
  if (!allowEmpty && normalized.length === 0) {
    throw new Error(`${fieldName} must not be empty`);
  }
  return normalized;
}

function normalizeEvidenceIds(values: number[]): number[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("proposal evidence must not be empty");
  }
  const unique = [...new Set(values)];
  if (unique.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("proposal evidence id is invalid");
  }
  return unique;
}

function createContentHash(input: {
  summary: string;
  confirmedFacts: string[];
  assumptions: string[];
  steps: string[];
  stopConditions: string[];
  expectedObservations: string[];
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function readProposalResult(
  database: PGliteInterface,
  proposal: PersistedProposal,
  workOrderId: number,
): Promise<DraftedResolutionProposal> {
  const evidence = await database.query<{ search_hit_id: number }>(
    `
      select search_hit_id
      from resolution_proposal_evidence
      where proposal_id = $1
      order by id
    `,
    [proposal.id],
  );
  return {
    outcome: "proposal_created",
    proposalId: proposal.id,
    proposalVersion: proposal.proposal_version,
    workOrderId,
    riskAssessmentId: proposal.risk_assessment_id,
    searchRunId: proposal.search_run_id,
    evidenceSearchHitIds: evidence.rows.map((row) => row.search_hit_id),
  };
}

function proposalHandoffResult(
  handoff: PersistedHandoff,
  workOrderId: number,
  searchRunId: number,
): ResolutionProposalHandoff {
  return {
    outcome: "human_handoff_required",
    proposalId: null,
    proposalVersion: null,
    humanHandoffId: handoff.id,
    workOrderId,
    riskAssessmentId: handoff.risk_assessment_id,
    searchRunId,
    reasonCode: handoff.reason_code,
  };
}

async function createProposalHandoff(
  database: PGliteInterface,
  input: {
    workOrderId: number;
    factoryId: number;
    requesterMembershipId: number;
    riskAssessmentId: number;
    searchRunId: number;
    idempotencyKey: string;
    reasonCode: "high_risk" | "no_new_evidence";
    reasonDetails: string;
    eventDetails: Record<string, unknown>;
  },
): Promise<ResolutionProposalHandoff> {
  const handoffKey = `draft_resolution_proposal:${input.idempotencyKey}:handoff`;
  const inserted = await database.query<PersistedHandoff>(
    `
      insert into human_handoffs (
        work_order_id,
        factory_id,
        risk_assessment_id,
        requester_membership_id,
        reason_code,
        reason_details,
        handoff_status,
        idempotency_key
      )
      values ($1, $2, $3, $4, $5, $6, 'requested', $7)
      returning id, risk_assessment_id, reason_code
    `,
    [
      input.workOrderId,
      input.factoryId,
      input.riskAssessmentId,
      input.requesterMembershipId,
      input.reasonCode,
      input.reasonDetails,
      handoffKey,
    ],
  );
  const handoff = inserted.rows[0];
  await database.query(
    `
      insert into work_order_events (
        work_order_id, factory_id, event_type, actor_kind,
        actor_membership_id, content, details, idempotency_key,
        human_handoff_id
      )
      values (
        $1, $2, 'human_handoff_requested', 'system', null,
        $3, $4::jsonb, $5, $6
      )
    `,
    [
      input.workOrderId,
      input.factoryId,
      input.reasonCode === "high_risk"
        ? "方案步骤命中固定高危动作规则，停止自动指导并转人工。"
        : "第一版失败后没有出现新的有效证据，停止重复试错并转人工。",
      JSON.stringify({
        riskAssessmentId: input.riskAssessmentId,
        searchRunId: input.searchRunId,
        reasonCode: input.reasonCode,
        ...input.eventDetails,
      }),
      `${handoffKey}:event`,
      handoff.id,
    ],
  );
  const updated = await database.query<{ id: number }>(
    `
      update work_orders
      set status = 'awaiting_human'
      where id = $1 and status = 'investigating'
      returning id
    `,
    [input.workOrderId],
  );
  if (updated.rows.length !== 1) {
    throw new Error("work order state changed while creating proposal handoff");
  }
  await database.query(
    `
      insert into work_order_events (
        work_order_id, factory_id, event_type, actor_kind,
        actor_membership_id, content, from_status, to_status,
        details, idempotency_key
      )
      values (
        $1, $2, 'status_changed', 'system', null,
        '方案门禁要求转人工。', 'investigating', 'awaiting_human',
        $3::jsonb, $4
      )
    `,
    [
      input.workOrderId,
      input.factoryId,
      JSON.stringify({ humanHandoffId: handoff.id }),
      `${handoffKey}:status`,
    ],
  );
  return proposalHandoffResult(handoff, input.workOrderId, input.searchRunId);
}

export async function draftResolutionProposal(
  database: PGliteInterface,
  input: DraftResolutionProposalInput,
): Promise<DraftResolutionProposalResult> {
  const summary = normalizeText(input.summary, "proposal summary");
  const confirmedFacts = normalizeTextList(
    input.confirmedFacts,
    "proposal confirmed facts",
  );
  const assumptions = normalizeTextList(
    input.assumptions,
    "proposal assumptions",
    true,
  );
  const steps = normalizeTextList(input.steps, "proposal steps");
  const stopConditions = normalizeTextList(
    input.stopConditions,
    "proposal stop conditions",
  );
  const expectedObservations = normalizeTextList(
    input.expectedObservations,
    "proposal expected observations",
  );
  const modelId = normalizeText(input.modelId, "proposal model id");
  const modelVersion = normalizeText(
    input.modelVersion,
    "proposal model version",
  );
  const promptVersion = normalizeText(
    input.promptVersion,
    "proposal prompt version",
  );
  const idempotencyKey = normalizeText(
    input.idempotencyKey,
    "proposal idempotency key",
  );
  const evidenceSearchHitIds = normalizeEvidenceIds(input.evidenceSearchHitIds);
  const contentSha256 = createContentHash({
    summary,
    confirmedFacts,
    assumptions,
    steps,
    stopConditions,
    expectedObservations,
  });
  const prohibitedActionTerms = prohibitedProposalActionTerms.filter((term) =>
    steps.some((step) => step.includes(term)),
  );

  return database.transaction(async (transaction) => {
    const scope = await transaction.query<WorkOrderScope>(
      `
        select
          work_order.id,
          work_order.factory_id,
          work_order.equipment_id,
          work_order.status,
          (
            membership.id is not null
            and app_user.id is not null
          ) as requester_is_authorized
        from work_orders as work_order
        left join factory_memberships as membership
          on membership.id = $2
         and membership.factory_id = work_order.factory_id
         and membership.is_active = true
        left join users as app_user
          on app_user.id = membership.user_id
         and app_user.is_active = true
        where work_order.id = $1
        for update of work_order
      `,
      [input.workOrderId, input.requesterMembershipId],
    );
    if (scope.rows.length !== 1) throw new Error("work order not found");
    const workOrder = scope.rows[0];
    if (!workOrder.requester_is_authorized) {
      throw new Error("active membership for the work order factory is required");
    }

    const existing = await transaction.query<PersistedProposal>(
      `
        select
          id,
          proposal_version,
          risk_assessment_id,
          search_run_id,
          requester_membership_id,
          content_sha256
        from resolution_proposals
        where work_order_id = $1 and idempotency_key = $2
      `,
      [input.workOrderId, idempotencyKey],
    );
    if (existing.rows[0]) {
      const persisted = existing.rows[0];
      const persistedEvidence = await transaction.query<{ search_hit_id: number }>(
        `select search_hit_id from resolution_proposal_evidence where proposal_id = $1 order by id`,
        [persisted.id],
      );
      if (
        persisted.requester_membership_id !== input.requesterMembershipId ||
        persisted.risk_assessment_id !== input.riskAssessmentId ||
        persisted.content_sha256 !== contentSha256 ||
        JSON.stringify(persistedEvidence.rows.map((row) => row.search_hit_id)) !==
          JSON.stringify(evidenceSearchHitIds)
      ) {
        throw new Error(
          "idempotency key was already used for a different resolution proposal",
        );
      }
      return readProposalResult(transaction, persisted, input.workOrderId);
    }

    const handoffKey = `draft_resolution_proposal:${idempotencyKey}:handoff`;
    const existingHandoff = await transaction.query<PersistedHandoff>(
      `
        select id, risk_assessment_id, reason_code
        from human_handoffs
        where work_order_id = $1 and idempotency_key = $2
      `,
      [input.workOrderId, handoffKey],
    );
    if (existingHandoff.rows[0]) {
      if (existingHandoff.rows[0].risk_assessment_id !== input.riskAssessmentId) {
        throw new Error(
          "idempotency key was already used for a different proposal handoff",
        );
      }
      const persistedRisk = await transaction.query<{ search_run_id: number }>(
        `select search_run_id from risk_assessments where id = $1`,
        [input.riskAssessmentId],
      );
      return proposalHandoffResult(
        existingHandoff.rows[0],
        input.workOrderId,
        persistedRisk.rows[0].search_run_id,
      );
    }

    const assessment = await transaction.query<RiskAssessmentScope>(
      `
        select
          risk.id,
          risk.search_run_id,
          risk.evidence_assessment_id,
          evidence.selected_search_hit_id,
          risk.decision,
          risk.blocked,
          risk.evidence_sufficient,
          risk.overall_risk_level
        from risk_assessments as risk
        left join evidence_assessments as evidence
          on evidence.id = risk.evidence_assessment_id
         and evidence.search_run_id = risk.search_run_id
        where risk.id = $1
          and risk.work_order_id = $2
          and risk.factory_id = $3
      `,
      [input.riskAssessmentId, input.workOrderId, workOrder.factory_id],
    );
    if (assessment.rows.length !== 1) {
      throw new Error("risk assessment does not belong to the work order");
    }
    const risk = assessment.rows[0];
    if (
      risk.decision !== "proposal_allowed" ||
      risk.blocked ||
      !risk.evidence_sufficient ||
      risk.overall_risk_level !== "low"
    ) {
      throw new Error("risk assessment does not allow a proposal");
    }
    if (
      risk.evidence_assessment_id !== null &&
      (
        risk.selected_search_hit_id === null ||
        evidenceSearchHitIds.length !== 1 ||
        evidenceSearchHitIds[0] !== risk.selected_search_hit_id
      )
    ) {
      throw new Error(
        "proposal may only cite the search hit approved by the evidence assessment",
      );
    }

    if (workOrder.status !== "investigating") {
      throw new Error("work order status does not allow a resolution proposal");
    }

    const evidence = await transaction.query<{
      id: number;
      search_run_id: number;
      knowledge_chunk_id: number;
    }>(
      `
        select search_hit.id, search_hit.search_run_id, search_hit.knowledge_chunk_id
        from knowledge_search_hits as search_hit
        join knowledge_chunks as knowledge_chunk
          on knowledge_chunk.id = search_hit.knowledge_chunk_id
        join source_versions as source_version
          on source_version.id = knowledge_chunk.source_version_id
        where search_hit.id = any($1::bigint[])
          and search_hit.search_run_id = $2
          and knowledge_chunk.review_status = 'approved'
          and knowledge_chunk.usage_policy = 'low_risk_guidance'
          and knowledge_chunk.source_severity in ('information', 'notice')
          and source_version.version_status = 'current'
        order by search_hit.id
      `,
      [evidenceSearchHitIds, risk.search_run_id],
    );
    if (evidence.rows.length !== evidenceSearchHitIds.length) {
      throw new Error(
        "proposal evidence must belong to the assessed search run and remain approved low-risk evidence",
      );
    }

    if (prohibitedActionTerms.length > 0) {
      return createProposalHandoff(transaction, {
        workOrderId: input.workOrderId,
        factoryId: workOrder.factory_id,
        requesterMembershipId: input.requesterMembershipId,
        riskAssessmentId: input.riskAssessmentId,
        searchRunId: risk.search_run_id,
        idempotencyKey,
        reasonCode: "high_risk",
        reasonDetails: `方案动作命中固定规则：${prohibitedActionTerms.join("、")}`,
        eventDetails: {
          proposalActionPolicyVersion,
          prohibitedActionTerms,
        },
      });
    }

    const previous = await transaction.query<{
      id: number;
      proposal_version: 1 | 2;
      content_sha256: string;
    }>(
      `
        select id, proposal_version, content_sha256
        from resolution_proposals
        where work_order_id = $1
        order by proposal_version desc
      `,
      [input.workOrderId],
    );
    if (previous.rows.length > 1 || previous.rows[0]?.proposal_version === 2) {
      throw new Error("a third resolution proposal is not allowed");
    }

    let proposalVersion: 1 | 2 = 1;
    let previousProposalId: number | null = null;
    let basisObservationEventId: number | null = null;
    if (previous.rows[0]) {
      proposalVersion = 2;
      previousProposalId = previous.rows[0].id;
      if (
        !Number.isSafeInteger(input.basisObservationEventId) ||
        input.basisObservationEventId! <= 0
      ) {
        throw new Error(
          "second resolution proposal requires failed feedback as its new observation basis",
        );
      }
      const basis = await transaction.query<{
        outcome: string;
        proposal_id: number;
        search_after_feedback: boolean;
      }>(
        `
          select
            feedback.outcome,
            feedback.proposal_id,
            search_run.created_at >= feedback.responded_at as search_after_feedback
          from work_order_events as feedback_event
          join proposal_user_feedback as feedback
            on feedback.id = feedback_event.proposal_user_feedback_id
          join knowledge_search_runs as search_run
            on search_run.id = $4
          where feedback_event.id = $1
            and feedback_event.work_order_id = $2
            and feedback_event.factory_id = $3
            and feedback_event.event_type = 'user_feedback_recorded'
        `,
        [
          input.basisObservationEventId,
          input.workOrderId,
          workOrder.factory_id,
          risk.search_run_id,
        ],
      );
      if (
        basis.rows.length !== 1 ||
        basis.rows[0].outcome !== "not_resolved" ||
        basis.rows[0].proposal_id !== previousProposalId ||
        !basis.rows[0].search_after_feedback
      ) {
        throw new Error(
          "second resolution proposal requires a new search after failed first-proposal feedback",
        );
      }
      basisObservationEventId = input.basisObservationEventId!;

      const previousEvidence = await transaction.query<{ knowledge_chunk_id: number }>(
        `
          select search_hit.knowledge_chunk_id
          from resolution_proposal_evidence as proposal_evidence
          join knowledge_search_hits as search_hit
            on search_hit.id = proposal_evidence.search_hit_id
           and search_hit.search_run_id = proposal_evidence.search_run_id
          where proposal_evidence.proposal_id = $1
        `,
        [previousProposalId],
      );
      const previousChunkIds = new Set(
        previousEvidence.rows.map((row) => row.knowledge_chunk_id),
      );
      const hasNewEvidence = evidence.rows.some(
        (row) => !previousChunkIds.has(row.knowledge_chunk_id),
      );
      if (!hasNewEvidence) {
        return createProposalHandoff(transaction, {
          workOrderId: input.workOrderId,
          factoryId: workOrder.factory_id,
          requesterMembershipId: input.requesterMembershipId,
          riskAssessmentId: input.riskAssessmentId,
          searchRunId: risk.search_run_id,
          idempotencyKey,
          reasonCode: "no_new_evidence",
          reasonDetails: "第一版失败后的重新检索没有返回第一版之外的新知识证据。",
          eventDetails: {
            previousProposalId,
            basisObservationEventId,
          },
        });
      }
      if (previous.rows[0].content_sha256 === contentSha256) {
        throw new Error("second resolution proposal must differ from the first proposal");
      }
    } else if (input.basisObservationEventId !== undefined) {
      throw new Error("first resolution proposal must not declare a prior observation basis");
    }

    const inserted = await transaction.query<PersistedProposal>(
      `
        insert into resolution_proposals (
          work_order_id,
          factory_id,
          equipment_id,
          risk_assessment_id,
          search_run_id,
          requester_membership_id,
          proposal_version,
          previous_proposal_id,
          basis_observation_event_id,
          summary,
          confirmed_facts,
          assumptions,
          steps,
          stop_conditions,
          expected_observations,
          content_sha256,
          model_id,
          model_version,
          prompt_version,
          idempotency_key
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
          $16, $17, $18, $19, $20
        )
        returning
          id,
          proposal_version,
          risk_assessment_id,
          search_run_id,
          requester_membership_id,
          content_sha256
      `,
      [
        input.workOrderId,
        workOrder.factory_id,
        workOrder.equipment_id,
        input.riskAssessmentId,
        risk.search_run_id,
        input.requesterMembershipId,
        proposalVersion,
        previousProposalId,
        basisObservationEventId,
        summary,
        JSON.stringify(confirmedFacts),
        JSON.stringify(assumptions),
        JSON.stringify(steps),
        JSON.stringify(stopConditions),
        JSON.stringify(expectedObservations),
        contentSha256,
        modelId,
        modelVersion,
        promptVersion,
        idempotencyKey,
      ],
    );
    const proposal = inserted.rows[0];

    for (const searchHitId of evidenceSearchHitIds) {
      await transaction.query(
        `
          insert into resolution_proposal_evidence (
            proposal_id, search_run_id, search_hit_id
          )
          values ($1, $2, $3)
        `,
        [proposal.id, risk.search_run_id, searchHitId],
      );
    }

    await transaction.query(
      `
        insert into work_order_events (
          work_order_id,
          factory_id,
          event_type,
          actor_kind,
          actor_membership_id,
          content,
          details,
          idempotency_key,
          resolution_proposal_id
        )
        values (
          $1, $2, 'proposal_created', 'agent', null,
          '协调助手创建了一份有证据的低风险处理方案。',
          $3::jsonb, $4, $5
        )
      `,
      [
        input.workOrderId,
        workOrder.factory_id,
        JSON.stringify({
          proposalVersion,
          previousProposalId,
          basisObservationEventId,
          riskAssessmentId: input.riskAssessmentId,
          searchRunId: risk.search_run_id,
          evidenceSearchHitIds,
        }),
        `draft_resolution_proposal:${idempotencyKey}`,
        proposal.id,
      ],
    );

    return readProposalResult(transaction, proposal, input.workOrderId);
  });
}
