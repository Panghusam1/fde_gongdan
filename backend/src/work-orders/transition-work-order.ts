import type { PGliteInterface } from "@electric-sql/pglite";

export type WorkOrderStatus =
  | "draft"
  | "investigating"
  | "awaiting_information"
  | "awaiting_user_confirmation"
  | "awaiting_human"
  | "human_processing"
  | "resolved"
  | "closed"
  | "cancelled";

const allowedTransitions: Record<WorkOrderStatus, readonly WorkOrderStatus[]> = {
  draft: ["investigating", "cancelled"],
  investigating: ["awaiting_information", "awaiting_human", "cancelled"],
  awaiting_information: ["investigating", "awaiting_human", "cancelled"],
  awaiting_user_confirmation: ["investigating", "awaiting_human"],
  awaiting_human: ["human_processing", "cancelled"],
  human_processing: [],
  resolved: [],
  closed: [],
  cancelled: [],
};

export interface TransitionWorkOrderInput {
  workOrderId: number;
  toStatus: WorkOrderStatus;
  actorKind: "user";
  actorMembershipId: number;
  content: string;
  idempotencyKey: string;
}

export interface TransitionedWorkOrder {
  workOrderId: number;
  eventId: number;
  fromStatus: WorkOrderStatus;
  toStatus: WorkOrderStatus;
}

export async function transitionWorkOrder(
  database: PGliteInterface,
  input: TransitionWorkOrderInput,
): Promise<TransitionedWorkOrder> {
  return database.transaction(async (transaction) => {
    const workOrder = await transaction.query<{
      id: number;
      factory_id: number;
      status: WorkOrderStatus;
    }>(
      `
        select id, factory_id, status
        from work_orders
        where id = $1
        for update
      `,
      [input.workOrderId],
    );

    if (workOrder.rows.length === 0) {
      throw new Error("work order not found");
    }

    const current = workOrder.rows[0];
    if (!allowedTransitions[current.status].includes(input.toStatus)) {
      throw new Error(
        `invalid work order transition: ${current.status} -> ${input.toStatus}`,
      );
    }

    const activeMembership = await transaction.query<{ id: number }>(
      `
        select membership.id
        from factory_memberships membership
        join users app_user on app_user.id = membership.user_id
        where membership.id = $1
          and membership.factory_id = $2
          and membership.is_active = true
          and app_user.is_active = true
      `,
      [input.actorMembershipId, current.factory_id],
    );

    if (activeMembership.rows.length === 0) {
      throw new Error("active factory membership required");
    }

    const updated = await transaction.query<{ id: number }>(
      `
        update work_orders
        set status = $1
        where id = $2
          and status = $3
        returning id
      `,
      [input.toStatus, input.workOrderId, current.status],
    );

    if (updated.rows.length === 0) {
      throw new Error("work order state changed concurrently");
    }

    const event = await transaction.query<{ id: number }>(
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
          idempotency_key
        )
        values ($1, $2, 'status_changed', 'user', $3, $4, $5, $6, $7)
        returning id
      `,
      [
        input.workOrderId,
        current.factory_id,
        input.actorMembershipId,
        input.content,
        current.status,
        input.toStatus,
        input.idempotencyKey,
      ],
    );

    return {
      workOrderId: input.workOrderId,
      eventId: event.rows[0].id,
      fromStatus: current.status,
      toStatus: input.toStatus,
    };
  });
}
