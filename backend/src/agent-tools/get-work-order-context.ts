import type { PGliteInterface } from "@electric-sql/pglite";

export type CoordinatorAction =
  | "append_observation"
  | "search_official_knowledge"
  | "run_risk_assessment"
  | "draft_resolution_proposal"
  | "request_user_confirmation"
  | "record_user_confirmation";

export interface GetWorkOrderContextInput {
  workOrderId: number;
  requesterMembershipId: number;
}

export interface WorkOrderContextResult {
  workOrder: {
    workOrderId: number;
    workOrderNo: string;
    status: string;
    faultCode: string | null;
    factoryId: number;
    factoryCode: string;
    factoryName: string;
    equipmentId: number;
    assetCode: string;
    manufacturerName: string;
    productFamilyCode: string;
    modelCode: string;
  };
  observations: Array<{
    eventId: number;
    eventType: string;
    content: string;
    occurredAt: string;
  }>;
  latestSearch: {
    searchRunId: number;
    queryText: string;
    createdAt: string;
    hits: Array<{
      searchHitId: number;
      knowledgeChunkId: number;
      verifiedText: string;
      contentKind: string;
      sourceSeverity: string;
      usagePolicy: string;
      documentReference: string;
      pdfPageNumber: number;
    }>;
  } | null;
  latestRiskAssessment: {
    riskAssessmentId: number;
    searchRunId: number;
    evidenceAssessmentId: number | null;
    selectedSearchHitId: number | null;
    decision: string;
    overallRiskLevel: string;
  } | null;
  latestProposal: {
    proposalId: number;
    proposalVersion: 1 | 2;
    summary: string;
    wasPresented: boolean;
    feedbackOutcome: "resolved" | "not_resolved" | null;
    feedbackRespondedAt: string | null;
  } | null;
  activeHumanHandoff: {
    humanHandoffId: number;
    reasonCode: string;
    handoffStatus: string;
  } | null;
  allowedActions: CoordinatorAction[];
}

interface WorkOrderRow {
  work_order_id: number;
  work_order_no: string;
  status: string;
  fault_code: string | null;
  factory_id: number;
  factory_code: string;
  factory_name: string;
  equipment_id: number;
  asset_code: string;
  manufacturer_name: string;
  family_code: string;
  model_code: string;
  requester_is_authorized: boolean;
}

function decideAllowedActions(input: {
  status: string;
  latestSearch: { searchRunId: number; createdAt: string } | null;
  latestRisk: { riskAssessmentId: number; searchRunId: number; decision: string } | null;
  latestProposal: {
    proposalId: number;
    wasPresented: boolean;
    feedbackOutcome: string | null;
    feedbackRespondedAt: string | null;
  } | null;
  activeHandoff: { humanHandoffId: number } | null;
}): CoordinatorAction[] {
  if (input.activeHandoff) return [];
  if (input.status === "draft" || input.status === "awaiting_information") {
    return ["append_observation"];
  }
  if (input.status === "awaiting_user_confirmation") {
    return ["record_user_confirmation"];
  }
  if (input.status !== "investigating") return [];

  if (
    input.latestProposal &&
    !input.latestProposal.wasPresented &&
    input.latestProposal.feedbackOutcome === null
  ) {
    return ["request_user_confirmation"];
  }
  if (
    input.latestProposal?.feedbackOutcome === "not_resolved" &&
    (
      !input.latestSearch ||
      !input.latestProposal.feedbackRespondedAt ||
      Date.parse(input.latestSearch.createdAt) <
        Date.parse(input.latestProposal.feedbackRespondedAt)
    )
  ) {
    return ["append_observation", "search_official_knowledge"];
  }
  if (
    input.latestSearch &&
    (!input.latestRisk || input.latestRisk.searchRunId !== input.latestSearch.searchRunId)
  ) {
    return ["run_risk_assessment"];
  }
  if (
    input.latestRisk &&
    input.latestSearch &&
    input.latestRisk.searchRunId === input.latestSearch.searchRunId &&
    input.latestRisk.decision === "proposal_allowed" &&
    (!input.latestProposal ||
      input.latestProposal.feedbackOutcome === "not_resolved")
  ) {
    return ["draft_resolution_proposal"];
  }
  return ["append_observation", "search_official_knowledge"];
}

export async function getWorkOrderContext(
  database: PGliteInterface,
  input: GetWorkOrderContextInput,
): Promise<WorkOrderContextResult> {
  return database.transaction(async (transaction) => {
    const scope = await transaction.query<WorkOrderRow>(
      `
        select
          work_order.id as work_order_id,
          work_order.work_order_no,
          work_order.status,
          work_order.fault_code,
          factory.id as factory_id,
          factory.factory_code,
          factory.name as factory_name,
          equipment.id as equipment_id,
          equipment.asset_code,
          product_family.manufacturer_name,
          product_family.family_code,
          equipment_model.model_code,
          (membership.id is not null and app_user.id is not null) as requester_is_authorized
        from work_orders as work_order
        join factories as factory on factory.id = work_order.factory_id
        join equipment
          on equipment.id = work_order.equipment_id
         and equipment.factory_id = work_order.factory_id
        join equipment_models as equipment_model
          on equipment_model.id = equipment.equipment_model_id
        join product_families as product_family
          on product_family.id = equipment_model.product_family_id
        left join factory_memberships as membership
          on membership.id = $2
         and membership.factory_id = work_order.factory_id
         and membership.is_active = true
        left join users as app_user
          on app_user.id = membership.user_id
         and app_user.is_active = true
        where work_order.id = $1
      `,
      [input.workOrderId, input.requesterMembershipId],
    );
    if (scope.rows.length !== 1) throw new Error("work order not found");
    const workOrder = scope.rows[0];
    if (!workOrder.requester_is_authorized) {
      throw new Error("active membership for the work order factory is required");
    }

    const observations = await transaction.query<{
      id: number;
      event_type: string;
      content: string;
      occurred_at: string;
    }>(
      `
        select id, event_type, content, occurred_at
        from work_order_events
        where work_order_id = $1
          and event_type in ('observation_added', 'user_feedback_recorded')
        order by occurred_at desc, id desc
        limit 20
      `,
      [input.workOrderId],
    );
    const searches = await transaction.query<{
      id: number;
      query_text: string;
      created_at: string;
    }>(
      `
        select id, query_text, created_at::text as created_at
        from knowledge_search_runs
        where work_order_id = $1
        order by created_at desc, id desc
        limit 1
      `,
      [input.workOrderId],
    );
    const searchHits = searches.rows[0]
      ? await transaction.query<{
          search_hit_id: number;
          knowledge_chunk_id: number;
          verified_text: string;
          content_kind: string;
          source_severity: string;
          usage_policy: string;
          document_reference: string;
          pdf_page_number: number;
        }>(
          `
            select
              search_hit.id as search_hit_id,
              knowledge_chunk.id as knowledge_chunk_id,
              knowledge_chunk.verified_text,
              knowledge_chunk.content_kind,
              knowledge_chunk.source_severity,
              knowledge_chunk.usage_policy,
              (
                select source_document.document_reference
                from knowledge_chunk_sources as chunk_source
                join page_extractions as extraction
                  on extraction.id = chunk_source.page_extraction_id
                join document_pages as document_page
                  on document_page.id = extraction.document_page_id
                join source_versions as source_version
                  on source_version.id = document_page.source_version_id
                join source_documents as source_document
                  on source_document.id = source_version.source_document_id
                where chunk_source.knowledge_chunk_id = knowledge_chunk.id
                order by chunk_source.source_order
                limit 1
              ) as document_reference,
              (
                select document_page.pdf_page_number
                from knowledge_chunk_sources as chunk_source
                join page_extractions as extraction
                  on extraction.id = chunk_source.page_extraction_id
                join document_pages as document_page
                  on document_page.id = extraction.document_page_id
                where chunk_source.knowledge_chunk_id = knowledge_chunk.id
                order by chunk_source.source_order
                limit 1
              ) as pdf_page_number
            from knowledge_search_hits as search_hit
            join knowledge_chunks as knowledge_chunk
              on knowledge_chunk.id = search_hit.knowledge_chunk_id
            where search_hit.search_run_id = $1
            order by search_hit.result_rank
          `,
          [searches.rows[0].id],
        )
      : { rows: [] };
    const risks = await transaction.query<{
      id: number;
      search_run_id: number;
      evidence_assessment_id: number | null;
      selected_search_hit_id: number | null;
      decision: string;
      overall_risk_level: string;
    }>(
      `
        select
          risk.id,
          risk.search_run_id,
          risk.evidence_assessment_id,
          evidence.selected_search_hit_id,
          risk.decision,
          risk.overall_risk_level
        from risk_assessments as risk
        left join evidence_assessments as evidence
          on evidence.id = risk.evidence_assessment_id
         and evidence.search_run_id = risk.search_run_id
        where risk.work_order_id = $1
        order by risk.assessed_at desc, risk.id desc
        limit 1
      `,
      [input.workOrderId],
    );
    const proposals = await transaction.query<{
      id: number;
      proposal_version: 1 | 2;
      summary: string;
      was_presented: boolean;
      feedback_outcome: "resolved" | "not_resolved" | null;
      feedback_responded_at: string | null;
    }>(
      `
        select
          proposal.id,
          proposal.proposal_version,
          proposal.summary,
          exists (
            select 1
            from work_order_events as request_event
            where request_event.resolution_proposal_id = proposal.id
              and request_event.event_type = 'user_confirmation_requested'
          ) as was_presented,
          feedback.outcome as feedback_outcome,
          feedback.responded_at::text as feedback_responded_at
        from resolution_proposals as proposal
        left join proposal_user_feedback as feedback
          on feedback.proposal_id = proposal.id
        where proposal.work_order_id = $1
        order by proposal.proposal_version desc
        limit 1
      `,
      [input.workOrderId],
    );
    const handoffs = await transaction.query<{
      id: number;
      reason_code: string;
      handoff_status: string;
    }>(
      `
        select id, reason_code, handoff_status
        from human_handoffs
        where work_order_id = $1
          and handoff_status in ('requested', 'accepted')
        order by requested_at desc, id desc
        limit 1
      `,
      [input.workOrderId],
    );

    const latestSearch = searches.rows[0]
      ? {
          searchRunId: searches.rows[0].id,
          queryText: searches.rows[0].query_text,
          createdAt: searches.rows[0].created_at,
          hits: searchHits.rows.map((row) => ({
            searchHitId: row.search_hit_id,
            knowledgeChunkId: row.knowledge_chunk_id,
            verifiedText: row.verified_text,
            contentKind: row.content_kind,
            sourceSeverity: row.source_severity,
            usagePolicy: row.usage_policy,
            documentReference: row.document_reference,
            pdfPageNumber: row.pdf_page_number,
          })),
        }
      : null;
    const latestRiskAssessment = risks.rows[0]
      ? {
          riskAssessmentId: risks.rows[0].id,
          searchRunId: risks.rows[0].search_run_id,
          evidenceAssessmentId: risks.rows[0].evidence_assessment_id,
          selectedSearchHitId: risks.rows[0].selected_search_hit_id,
          decision: risks.rows[0].decision,
          overallRiskLevel: risks.rows[0].overall_risk_level,
        }
      : null;
    const latestProposal = proposals.rows[0]
      ? {
          proposalId: proposals.rows[0].id,
          proposalVersion: proposals.rows[0].proposal_version,
          summary: proposals.rows[0].summary,
          wasPresented: proposals.rows[0].was_presented,
          feedbackOutcome: proposals.rows[0].feedback_outcome,
          feedbackRespondedAt: proposals.rows[0].feedback_responded_at,
        }
      : null;
    const activeHumanHandoff = handoffs.rows[0]
      ? {
          humanHandoffId: handoffs.rows[0].id,
          reasonCode: handoffs.rows[0].reason_code,
          handoffStatus: handoffs.rows[0].handoff_status,
        }
      : null;

    return {
      workOrder: {
        workOrderId: workOrder.work_order_id,
        workOrderNo: workOrder.work_order_no,
        status: workOrder.status,
        faultCode: workOrder.fault_code,
        factoryId: workOrder.factory_id,
        factoryCode: workOrder.factory_code,
        factoryName: workOrder.factory_name,
        equipmentId: workOrder.equipment_id,
        assetCode: workOrder.asset_code,
        manufacturerName: workOrder.manufacturer_name,
        productFamilyCode: workOrder.family_code,
        modelCode: workOrder.model_code,
      },
      observations: observations.rows.map((row) => ({
        eventId: row.id,
        eventType: row.event_type,
        content: row.content,
        occurredAt: row.occurred_at,
      })),
      latestSearch,
      latestRiskAssessment,
      latestProposal,
      activeHumanHandoff,
      allowedActions: decideAllowedActions({
        status: workOrder.status,
        latestSearch,
        latestRisk: latestRiskAssessment,
        latestProposal,
        activeHandoff: activeHumanHandoff,
      }),
    };
  });
}
