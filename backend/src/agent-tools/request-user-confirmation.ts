import type { PGliteInterface } from "@electric-sql/pglite";

export interface RequestUserConfirmationInput {
  workOrderId: number;
  requesterMembershipId: number;
  proposalId: number;
  idempotencyKey: string;
}

export interface RequestedUserConfirmation {
  workOrderId: number;
  proposalId: number;
  requestEventId: number;
  statusEventId: number;
  currentStatus: "awaiting_user_confirmation";
}

interface WorkOrderScope {
  id: number;
  factory_id: number;
  status: string;
  requester_is_authorized: boolean;
}

interface ProposalScope {
  id: number;
  proposal_version: number;
  risk_assessment_id: number;
  evidence_count: number;
  is_latest: boolean;
  proposal_is_allowed: boolean;
}

function normalizeKey(value: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw new Error("confirmation request idempotency key must not be blank");
  }
  return normalized;
}

export async function requestUserConfirmation(
  database: PGliteInterface,
  input: RequestUserConfirmationInput,
): Promise<RequestedUserConfirmation> {
  const idempotencyKey = normalizeKey(input.idempotencyKey);
  const eventKey = `request_user_confirmation:${idempotencyKey}`;

  return database.transaction(async (transaction) => {
    const scope = await transaction.query<WorkOrderScope>(
      `
        select
          work_order.id,
          work_order.factory_id,
          work_order.status,
          (membership.id is not null and app_user.id is not null) as requester_is_authorized
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

    const existing = await transaction.query<{
      id: number;
      resolution_proposal_id: number;
    }>(
      `
        select id, resolution_proposal_id
        from work_order_events
        where work_order_id = $1 and idempotency_key = $2
      `,
      [input.workOrderId, eventKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].resolution_proposal_id !== input.proposalId) {
        throw new Error(
          "idempotency key was already used for a different confirmation request",
        );
      }
      const statusEvent = await transaction.query<{ id: number }>(
        `
          select id
          from work_order_events
          where work_order_id = $1 and idempotency_key = $2
        `,
        [input.workOrderId, `${eventKey}:status`],
      );
      return {
        workOrderId: input.workOrderId,
        proposalId: input.proposalId,
        requestEventId: existing.rows[0].id,
        statusEventId: statusEvent.rows[0].id,
        currentStatus: "awaiting_user_confirmation",
      };
    }

    const proposal = await transaction.query<ProposalScope>(
      `
        select
          proposal.id,
          proposal.proposal_version,
          proposal.risk_assessment_id,
          (
            select count(*)::integer
            from resolution_proposal_evidence as evidence
            where evidence.proposal_id = proposal.id
          ) as evidence_count,
          not exists (
            select 1
            from resolution_proposals as newer
            where newer.work_order_id = proposal.work_order_id
              and newer.proposal_version > proposal.proposal_version
          ) as is_latest,
          (
            assessment.decision = 'proposal_allowed'
            and assessment.blocked = false
            and assessment.evidence_sufficient = true
            and assessment.overall_risk_level = 'low'
          ) as proposal_is_allowed
        from resolution_proposals as proposal
        join risk_assessments as assessment
          on assessment.id = proposal.risk_assessment_id
         and assessment.search_run_id = proposal.search_run_id
        where proposal.id = $1
          and proposal.work_order_id = $2
          and proposal.factory_id = $3
      `,
      [input.proposalId, input.workOrderId, workOrder.factory_id],
    );
    if (
      proposal.rows.length !== 1 ||
      !proposal.rows[0].is_latest
    ) {
      throw new Error("resolution proposal is not the current work order proposal");
    }
    if (
      proposal.rows[0].evidence_count < 1 ||
      !proposal.rows[0].proposal_is_allowed
    ) {
      throw new Error("resolution proposal is not eligible for user confirmation");
    }
    if (workOrder.status !== "investigating") {
      throw new Error("work order status does not allow a confirmation request");
    }

    const requestEvent = await transaction.query<{ id: number }>(
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
          $1, $2, 'user_confirmation_requested', 'agent', null,
          '低风险处理方案已经通过程序校验，等待现场用户反馈实际结果。',
          $3::jsonb, $4, $5
        )
        returning id
      `,
      [
        input.workOrderId,
        workOrder.factory_id,
        JSON.stringify({
          proposalId: input.proposalId,
          proposalVersion: proposal.rows[0].proposal_version,
          riskAssessmentId: proposal.rows[0].risk_assessment_id,
        }),
        eventKey,
        input.proposalId,
      ],
    );

    const updated = await transaction.query<{ id: number }>(
      `
        update work_orders
        set status = 'awaiting_user_confirmation'
        where id = $1 and status = 'investigating'
        returning id
      `,
      [input.workOrderId],
    );
    if (updated.rows.length !== 1) {
      throw new Error("work order state changed while requesting confirmation");
    }
    const statusEvent = await transaction.query<{ id: number }>(
      `
        insert into work_order_events (
          work_order_id,
          factory_id,
          event_type,
          actor_kind,
          actor_membership_id,
          content,
          from_status,
          to_status,
          details,
          idempotency_key
        )
        values (
          $1, $2, 'status_changed', 'system', null,
          '低风险方案已提交，工单进入等待现场确认。',
          'investigating', 'awaiting_user_confirmation',
          $3::jsonb, $4
        )
        returning id
      `,
      [
        input.workOrderId,
        workOrder.factory_id,
        JSON.stringify({ proposalId: input.proposalId }),
        `${eventKey}:status`,
      ],
    );

    return {
      workOrderId: input.workOrderId,
      proposalId: input.proposalId,
      requestEventId: requestEvent.rows[0].id,
      statusEventId: statusEvent.rows[0].id,
      currentStatus: "awaiting_user_confirmation",
    };
  });
}
