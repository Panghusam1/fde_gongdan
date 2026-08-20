import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

import { createDraftWorkOrder } from "../src/work-orders/create-draft-work-order.ts";
import { transitionWorkOrder } from "../src/work-orders/transition-work-order.ts";

async function openMigratedDatabase(): Promise<PGlite> {
  const database = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const directory = new URL("../database/migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) {
    await database.exec(await readFile(new URL(migration, directory), "utf8"));
  }
  return database;
}

async function loadObservationTool() {
  try {
    const module = await import("../src/agent-tools/append-observation.ts");
    return module.appendObservation;
  } catch {
    assert.fail("append_observation窄工具尚未实现");
  }
}

async function createFixture(database: PGlite) {
  const factory = await database.query<{ id: number }>(
    `insert into factories (factory_code, name) values ('F-OBS', '观察测试厂') returning id`,
  );
  const user = await database.query<{ id: number }>(
    `insert into users (external_subject, display_name) values ('idp|obs-user', '观察测试用户') returning id`,
  );
  const membership = await database.query<{ id: number }>(
    `insert into factory_memberships (factory_id, user_id, role_code) values ($1, $2, 'operator') returning id`,
    [factory.rows[0].id, user.rows[0].id],
  );
  const productFamily = await database.query<{ id: number }>(
    `insert into product_families (manufacturer_name, family_code, display_name) values ('Schneider Electric', 'ATV320-OBS', 'ATV320观察测试系列') returning id`,
  );
  const equipmentModel = await database.query<{ id: number }>(
    `insert into equipment_models (product_family_id, model_code, display_name) values ($1, 'ATV320-OBS-MODEL', 'ATV320观察测试型号') returning id`,
    [productFamily.rows[0].id],
  );
  const equipment = await database.query<{ id: number }>(
    `insert into equipment (factory_id, asset_code, equipment_model_id) values ($1, 'INV-OBS-001', $2) returning id`,
    [factory.rows[0].id, equipmentModel.rows[0].id],
  );
  const workOrder = await createDraftWorkOrder(database, {
    workOrderNo: "WO-OBS-001",
    factoryId: factory.rows[0].id,
    equipmentId: equipment.rows[0].id,
    creatorMembershipId: membership.rows[0].id,
    reportedFaultCode: "OHF",
    initialObservation: "设备报告OHF。",
    idempotencyKey: "create-observation-work-order",
  });
  return {
    factoryId: factory.rows[0].id,
    userId: user.rows[0].id,
    membershipId: membership.rows[0].id,
    workOrderId: workOrder.workOrderId,
  };
}

test("R152：追加现场观察只能新增事件并使草稿工单进入排查中", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const appendObservation = await loadObservationTool();

  const result = await appendObservation(database, {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    observationType: "symptom",
    content: "冷却风扇不转，尚未拆检。",
    idempotencyKey: "observe-fan-stopped",
  });

  assert.equal(result.currentStatus, "investigating");
  const events = await database.query<{
    event_type: string;
    content: string;
    observation_type: string | null;
  }>(
    `
      select event_type, content, details->>'observationType' as observation_type
      from work_order_events
      where work_order_id = $1
      order by id
    `,
    [fixture.workOrderId],
  );
  assert.deepEqual(events.rows.slice(-2), [
    {
      event_type: "observation_added",
      content: "冷却风扇不转，尚未拆检。",
      observation_type: "symptom",
    },
    {
      event_type: "status_changed",
      content: "收到新的现场观察，工单进入排查中。",
      observation_type: null,
    },
  ]);
});

test("R153：相同观察请求只能重放，换内容复用同一幂等键必须拒绝", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const appendObservation = await loadObservationTool();
  const request = {
    workOrderId: fixture.workOrderId,
    requesterMembershipId: fixture.membershipId,
    observationType: "action_taken" as const,
    content: "仅从设备外部检查了通风口，没有拆机。",
    idempotencyKey: "observe-external-check",
  };

  const first = await appendObservation(database, request);
  const second = await appendObservation(database, request);
  assert.deepEqual(second, first);
  await assert.rejects(
    appendObservation(database, { ...request, content: "换成另一条观察。" }),
    /idempotency key was already used for a different observation/,
  );
  const count = await database.query<{ count: number }>(
    `select count(*)::integer as count from work_order_events where work_order_id = $1 and event_type = 'observation_added'`,
    [fixture.workOrderId],
  );
  assert.equal(count.rows[0].count, 1);
});

test("R154：其他厂区成员不能代写现场观察", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  const otherFactory = await database.query<{ id: number }>(
    `insert into factories (factory_code, name) values ('F-OBS-OTHER', '其他观察厂') returning id`,
  );
  const otherUser = await database.query<{ id: number }>(
    `insert into users (external_subject, display_name) values ('idp|obs-other', '其他观察用户') returning id`,
  );
  const otherMembership = await database.query<{ id: number }>(
    `insert into factory_memberships (factory_id, user_id, role_code) values ($1, $2, 'operator') returning id`,
    [otherFactory.rows[0].id, otherUser.rows[0].id],
  );
  const appendObservation = await loadObservationTool();

  await assert.rejects(
    appendObservation(database, {
      workOrderId: fixture.workOrderId,
      requesterMembershipId: otherMembership.rows[0].id,
      observationType: "symptom",
      content: "伪造现场观察。",
      idempotencyKey: "cross-factory-observation",
    }),
    /active membership for the work order factory is required/,
  );
});

test("R155：等待人工的工单不能继续由协调助手追加普通排查观察", async (context) => {
  const database = await openMigratedDatabase();
  context.after(async () => database.close());
  const fixture = await createFixture(database);
  await transitionWorkOrder(database, {
    workOrderId: fixture.workOrderId,
    toStatus: "investigating",
    actorKind: "user",
    actorMembershipId: fixture.membershipId,
    content: "开始排查。",
    idempotencyKey: "obs-start-investigation",
  });
  await transitionWorkOrder(database, {
    workOrderId: fixture.workOrderId,
    toStatus: "awaiting_human",
    actorKind: "user",
    actorMembershipId: fixture.membershipId,
    content: "等待人工。",
    idempotencyKey: "obs-await-human",
  });
  const appendObservation = await loadObservationTool();

  await assert.rejects(
    appendObservation(database, {
      workOrderId: fixture.workOrderId,
      requesterMembershipId: fixture.membershipId,
      observationType: "symptom",
      content: "继续自动排查。",
      idempotencyKey: "observe-after-handoff",
    }),
    /work order status does not allow observations/,
  );
});
