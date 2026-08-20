import type { PGliteInterface } from "@electric-sql/pglite";

export type ObservationType =
  | "symptom"
  | "action_taken"
  | "measurement"
  | "environment"
  | "user_feedback";

export interface AppendObservationInput {
  workOrderId: number;
  requesterMembershipId: number;
  observationType: ObservationType;
  content: string;
  idempotencyKey: string;
}

export interface AppendedObservation {
  workOrderId: number;
  observationEventId: number;
  statusEventId: number | null;
  currentStatus: "investigating";
}

const allowedObservationTypes = new Set<ObservationType>([
  "symptom",
  "action_taken",
  "measurement",
  "environment",
  "user_feedback",
]);

const allowedStatuses = new Set([
  "draft",
  "investigating",
  "awaiting_information",
]);

interface WorkOrderScope {
  id: number;
  factory_id: number;
  status: string;
}

interface PersistedObservation {
  id: number;
  actor_membership_id: number;
  content: string;
  observation_type: string;
  resulting_status: "investigating";
}

export async function appendObservation(
  database: PGliteInterface,
  input: AppendObservationInput,
): Promise<AppendedObservation> {
  const content = input.content.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (content === "") throw new Error("observation content must not be blank");
  if (idempotencyKey === "") {
    throw new Error("observation idempotency key must not be blank");
  }
  if (!allowedObservationTypes.has(input.observationType)) {
    throw new Error("observation type is invalid");
  }

  return database.transaction(async (transaction) => {
    const workOrder = await transaction.query<WorkOrderScope>(
      `select id, factory_id, status from work_orders where id = $1 for update`,
      [input.workOrderId],
    );
    if (workOrder.rows.length !== 1) throw new Error("work order not found");
    const current = workOrder.rows[0];

    const authorized = await transaction.query<{ id: number }>(
      `
        select membership.id
        from factory_memberships as membership
        join users as app_user on app_user.id = membership.user_id
        where membership.id = $1
          and membership.factory_id = $2
          and membership.is_active = true
          and app_user.is_active = true
      `,
      [input.requesterMembershipId, current.factory_id],
    );
    if (authorized.rows.length !== 1) {
      throw new Error("active membership for the work order factory is required");
    }

    const eventKey = `append_observation:${idempotencyKey}`;
    const existing = await transaction.query<PersistedObservation>(
      `
        select
          id,
          actor_membership_id,
          content,
          details->>'observationType' as observation_type,
          details->>'resultingStatus' as resulting_status
        from work_order_events
        where work_order_id = $1 and idempotency_key = $2
      `,
      [input.workOrderId, eventKey],
    );
    if (existing.rows[0]) {
      const persisted = existing.rows[0];
      if (
        persisted.actor_membership_id !== input.requesterMembershipId ||
        persisted.content !== content ||
        persisted.observation_type !== input.observationType
      ) {
        throw new Error("idempotency key was already used for a different observation");
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
        observationEventId: persisted.id,
        statusEventId: statusEvent.rows[0]?.id ?? null,
        currentStatus: persisted.resulting_status,
      };
    }

    if (!allowedStatuses.has(current.status)) {
      throw new Error("work order status does not allow observations");
    }
    const shouldEnterInvestigation = current.status !== "investigating";
    const observation = await transaction.query<{ id: number }>(
      `
        insert into work_order_events (
          work_order_id, factory_id, event_type, actor_kind,
          actor_membership_id, content, details, idempotency_key
        )
        values (
          $1, $2, 'observation_added', 'user', $3, $4, $5::jsonb, $6
        )
        returning id
      `,
      [
        input.workOrderId,
        current.factory_id,
        input.requesterMembershipId,
        content,
        JSON.stringify({
          observationType: input.observationType,
          resultingStatus: "investigating",
        }),
        eventKey,
      ],
    );

    let statusEventId: number | null = null;
    if (shouldEnterInvestigation) {
      const updated = await transaction.query<{ id: number }>(
        `
          update work_orders
          set status = 'investigating'
          where id = $1 and status = $2
          returning id
        `,
        [input.workOrderId, current.status],
      );
      if (updated.rows.length !== 1) {
        throw new Error("work order state changed while adding observation");
      }
      const statusEvent = await transaction.query<{ id: number }>(
        `
          insert into work_order_events (
            work_order_id, factory_id, event_type, actor_kind,
            actor_membership_id, content, from_status, to_status,
            details, idempotency_key
          )
          values (
            $1, $2, 'status_changed', 'system', null,
            '收到新的现场观察，工单进入排查中。', $3, 'investigating',
            $4::jsonb, $5
          )
          returning id
        `,
        [
          input.workOrderId,
          current.factory_id,
          current.status,
          JSON.stringify({ observationEventId: observation.rows[0].id }),
          `${eventKey}:status`,
        ],
      );
      statusEventId = statusEvent.rows[0].id;
    }

    return {
      workOrderId: input.workOrderId,
      observationEventId: observation.rows[0].id,
      statusEventId,
      currentStatus: "investigating",
    };
  });
}
