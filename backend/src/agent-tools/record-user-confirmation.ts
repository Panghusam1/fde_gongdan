import type { PGliteInterface } from "@electric-sql/pglite";

export type UserConfirmationOutcome = "resolved" | "not_resolved";

export interface RecordUserConfirmationInput {
  workOrderId: number;
  requesterMembershipId: number;
  proposalId: number;
  outcome: UserConfirmationOutcome;
  actualResult: string;
  idempotencyKey: string;
}

export interface RecordedUserConfirmation {
  feedbackId: number;
  feedbackEventId: number;
  resolutionEventId: number | null;
  statusEventId: number;
  humanHandoffId: number | null;
  workOrderId: number;
  proposalId: number;
  outcome: UserConfirmationOutcome;
  currentStatus: "investigating" | "awaiting_human" | "resolved";
}

interface WorkOrderScope {
  id: number;
  factory_id: number;
  status: string;
  requester_is_authorized: boolean;
}

interface ProposalScope {
  id: number;
  proposal_version: 1 | 2;
  risk_assessment_id: number;
  requester_membership_id: number;
  was_presented: boolean;
  is_latest: boolean;
}

interface PersistedFeedback {
  id: number;
  proposal_id: number;
  responder_membership_id: number;
  outcome: UserConfirmationOutcome;
  actual_result: string;
}

function normalizeText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${fieldName} must not be blank`);
  return normalized;
}

function validateOutcome(value: string): asserts value is UserConfirmationOutcome {
  if (value !== "resolved" && value !== "not_resolved") {
    throw new Error("user confirmation outcome is invalid");
  }
}

async function readPersistedResult(
  database: PGliteInterface,
  feedback: PersistedFeedback,
  workOrderId: number,
): Promise<RecordedUserConfirmation> {
  const events = await database.query<{
    id: number;
    event_type: string;
  }>(
    `
      select id, event_type
      from work_order_events
      where proposal_user_feedback_id = $1
         or (
           work_order_id = $2
           and details->>'proposalFeedbackId' = $3
           and event_type = 'status_changed'
         )
      order by id
    `,
    [feedback.id, workOrderId, String(feedback.id)],
  );
  const workOrder = await database.query<{ status: RecordedUserConfirmation["currentStatus"] }>(
    `select status from work_orders where id = $1`,
    [workOrderId],
  );
  const handoff = await database.query<{ id: number }>(
    `select id from human_handoffs where work_order_id = $1 and reason_code in ('two_proposals_failed', 'no_new_evidence') order by id desc limit 1`,
    [workOrderId],
  );
  return {
    feedbackId: feedback.id,
    feedbackEventId: events.rows.find((event) => event.event_type === "user_feedback_recorded")!.id,
    resolutionEventId:
      events.rows.find((event) => event.event_type === "resolution_confirmed")?.id ?? null,
    statusEventId: events.rows.find((event) => event.event_type === "status_changed")!.id,
    humanHandoffId: handoff.rows[0]?.id ?? null,
    workOrderId,
    proposalId: feedback.proposal_id,
    outcome: feedback.outcome,
    currentStatus: workOrder.rows[0].status,
  };
}

export async function recordUserConfirmation(
  database: PGliteInterface,
  input: RecordUserConfirmationInput,
): Promise<RecordedUserConfirmation> {
  validateOutcome(input.outcome);
  const actualResult = normalizeText(input.actualResult, "actual result");
  const idempotencyKey = normalizeText(
    input.idempotencyKey,
    "user confirmation idempotency key",
  );

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

    const existing = await transaction.query<PersistedFeedback>(
      `
        select id, proposal_id, responder_membership_id, outcome, actual_result
        from proposal_user_feedback
        where work_order_id = $1 and idempotency_key = $2
      `,
      [input.workOrderId, idempotencyKey],
    );
    if (existing.rows[0]) {
      const feedback = existing.rows[0];
      if (
        feedback.proposal_id !== input.proposalId ||
        feedback.responder_membership_id !== input.requesterMembershipId ||
        feedback.outcome !== input.outcome ||
        feedback.actual_result !== actualResult
      ) {
        throw new Error(
          "idempotency key was already used for different user confirmation feedback",
        );
      }
      return readPersistedResult(transaction, feedback, input.workOrderId);
    }

    if (workOrder.status !== "awaiting_user_confirmation") {
      throw new Error("work order is not awaiting user confirmation");
    }
    const proposal = await transaction.query<ProposalScope>(
      `
        select
          proposal.id,
          proposal.proposal_version,
          proposal.risk_assessment_id,
          proposal.requester_membership_id,
          exists (
            select 1
            from work_order_events as request_event
            where request_event.resolution_proposal_id = proposal.id
              and request_event.event_type = 'user_confirmation_requested'
          ) as was_presented,
          not exists (
            select 1
            from resolution_proposals as newer
            where newer.work_order_id = proposal.work_order_id
              and newer.proposal_version > proposal.proposal_version
          ) as is_latest
        from resolution_proposals as proposal
        where proposal.id = $1
          and proposal.work_order_id = $2
          and proposal.factory_id = $3
      `,
      [input.proposalId, input.workOrderId, workOrder.factory_id],
    );
    if (
      proposal.rows.length !== 1 ||
      !proposal.rows[0].was_presented ||
      !proposal.rows[0].is_latest
    ) {
      throw new Error("user feedback must target the current presented proposal");
    }

    const inserted = await transaction.query<PersistedFeedback>(
      `
        insert into proposal_user_feedback (
          proposal_id,
          work_order_id,
          factory_id,
          responder_membership_id,
          outcome,
          actual_result,
          idempotency_key
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        returning id, proposal_id, responder_membership_id, outcome, actual_result
      `,
      [
        input.proposalId,
        input.workOrderId,
        workOrder.factory_id,
        input.requesterMembershipId,
        input.outcome,
        actualResult,
        idempotencyKey,
      ],
    );
    const feedback = inserted.rows[0];
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
          proposal_user_feedback_id
        )
        values (
          $1, $2, 'user_feedback_recorded', 'user', $3, $4,
          $5::jsonb, $6, $7
        )
      `,
      [
        input.workOrderId,
        workOrder.factory_id,
        input.requesterMembershipId,
        actualResult,
        JSON.stringify({
          proposalId: input.proposalId,
          proposalVersion: proposal.rows[0].proposal_version,
          outcome: input.outcome,
        }),
        `record_user_confirmation:${idempotencyKey}:feedback`,
        feedback.id,
      ],
    );

    let nextStatus: RecordedUserConfirmation["currentStatus"];
    if (input.outcome === "resolved") {
      nextStatus = "resolved";
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
            proposal_user_feedback_id
          )
          values (
            $1, $2, 'resolution_confirmed', 'user', $3,
            '现场用户确认低风险处理后设备已经恢复。',
            $4::jsonb, $5, $6
          )
        `,
        [
          input.workOrderId,
          workOrder.factory_id,
          input.requesterMembershipId,
          JSON.stringify({ proposalId: input.proposalId }),
          `record_user_confirmation:${idempotencyKey}:resolved`,
          feedback.id,
        ],
      );
      const updated = await transaction.query<{ id: number }>(
        `
          update work_orders
          set status = 'resolved', resolved_at = now()
          where id = $1 and status = 'awaiting_user_confirmation'
          returning id
        `,
        [input.workOrderId],
      );
      if (updated.rows.length !== 1) {
        throw new Error("work order state changed while confirming resolution");
      }
    } else if (proposal.rows[0].proposal_version === 1) {
      nextStatus = "investigating";
      const updated = await transaction.query<{ id: number }>(
        `
          update work_orders
          set status = 'investigating'
          where id = $1 and status = 'awaiting_user_confirmation'
          returning id
        `,
        [input.workOrderId],
      );
      if (updated.rows.length !== 1) {
        throw new Error("work order state changed while recording failed feedback");
      }
    } else {
      nextStatus = "awaiting_human";
      const handoff = await transaction.query<{ id: number }>(
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
          values (
            $1, $2, $3, $4, 'two_proposals_failed',
            '两版有证据的低风险处理方案均未使设备恢复。',
            'requested', $5
          )
          returning id
        `,
        [
          input.workOrderId,
          workOrder.factory_id,
          proposal.rows[0].risk_assessment_id,
          input.requesterMembershipId,
          `record_user_confirmation:${idempotencyKey}:handoff`,
        ],
      );
      await transaction.query(
        `
          insert into work_order_events (
            work_order_id, factory_id, event_type, actor_kind,
            actor_membership_id, content, details, idempotency_key,
            human_handoff_id
          )
          values (
            $1, $2, 'human_handoff_requested', 'system', null,
            '第二版方案仍未恢复设备，系统按上限要求转人工。',
            $3::jsonb, $4, $5
          )
        `,
        [
          input.workOrderId,
          workOrder.factory_id,
          JSON.stringify({
            proposalId: input.proposalId,
            proposalFeedbackId: feedback.id,
            reasonCode: "two_proposals_failed",
          }),
          `record_user_confirmation:${idempotencyKey}:handoff-event`,
          handoff.rows[0].id,
        ],
      );
      const updated = await transaction.query<{ id: number }>(
        `
          update work_orders
          set status = 'awaiting_human'
          where id = $1 and status = 'awaiting_user_confirmation'
          returning id
        `,
        [input.workOrderId],
      );
      if (updated.rows.length !== 1) {
        throw new Error("work order state changed while handing off failed proposals");
      }
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
          from_status,
          to_status,
          details,
          idempotency_key
        )
        values (
          $1, $2, 'status_changed', 'system', null, $3,
          'awaiting_user_confirmation', $4, $5::jsonb, $6
        )
      `,
      [
        input.workOrderId,
        workOrder.factory_id,
        nextStatus === "resolved"
          ? "现场用户确认设备恢复，工单进入已解决。"
          : nextStatus === "awaiting_human"
            ? "第二版方案仍未恢复设备，工单进入等待人工。"
            : "第一版方案未恢复设备，保存现场结果并返回排查中。",
        nextStatus,
        JSON.stringify({ proposalFeedbackId: feedback.id }),
        `record_user_confirmation:${idempotencyKey}:status`,
      ],
    );

    return readPersistedResult(transaction, feedback, input.workOrderId);
  });
}
