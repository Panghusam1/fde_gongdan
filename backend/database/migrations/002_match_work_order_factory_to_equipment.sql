alter table equipment
  add constraint equipment_id_factory_unique
  unique (id, factory_id);

alter table work_orders
  drop constraint work_orders_equipment_fk;

alter table work_orders
  add constraint work_orders_equipment_factory_fk
  foreign key (equipment_id, factory_id)
  references equipment (id, factory_id);

drop index work_orders_equipment_id_idx;

create index work_orders_equipment_factory_idx
  on work_orders (equipment_id, factory_id);
