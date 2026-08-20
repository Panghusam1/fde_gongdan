import type { PGliteInterface } from "@electric-sql/pglite";

export interface CreateDraftWorkOrderInput {
  workOrderNo: string;
  factoryId: number;
  equipmentId: number;
  creatorMembershipId: number;
  reportedFaultCode?: string | null;
  initialObservation: string;
  idempotencyKey: string;
  isDemo?: boolean;
}

export interface CreatedDraftWorkOrder {
  workOrderId: number;
  eventId: number;
  status: "draft";
}

export async function createDraftWorkOrder(
  database: PGliteInterface,
  input: CreateDraftWorkOrderInput,
): Promise<CreatedDraftWorkOrder> {
  return database.transaction(async (transaction) => {
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
      [input.creatorMembershipId, input.factoryId],
    );

    if (activeMembership.rows.length === 0) {
      throw new Error("active factory membership required");
    }

    const workOrder = await transaction.query<{ id: number; status: "draft" }>(
      `
        insert into work_orders (
          work_order_no,
          factory_id,
          equipment_id,
          created_by_membership_id,
          fault_code,
          status,
          is_demo
        )
        values ($1, $2, $3, $4, $5, 'draft', $6)
        returning id, status
      `,
      [
        input.workOrderNo,
        input.factoryId,
        input.equipmentId,
        input.creatorMembershipId,
        input.reportedFaultCode ?? null,
        input.isDemo ?? true,
      ],
    );

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
        values (
          $1,
          $2,
          'work_order_created',
          'user',
          $3,
          $4,
          null,
          'draft',
          $5
        )
        returning id
      `,
      [
        workOrder.rows[0].id,
        input.factoryId,
        input.creatorMembershipId,
        input.initialObservation,
        input.idempotencyKey,
      ],
    );

    return {
      workOrderId: workOrder.rows[0].id,
      eventId: event.rows[0].id,
      status: workOrder.rows[0].status,
    };
  });
}
