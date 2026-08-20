create table factories (
  id bigint generated always as identity primary key,
  factory_code text not null,
  name text not null,
  is_demo boolean not null default true,
  created_at timestamptz not null default now(),

  constraint factories_factory_code_not_blank
    check (btrim(factory_code) <> ''),
  constraint factories_name_not_blank
    check (btrim(name) <> ''),
  constraint factories_factory_code_unique
    unique (factory_code)
);

create table equipment (
  id bigint generated always as identity primary key,
  factory_id bigint not null,
  asset_code text not null,
  manufacturer text not null,
  product_family text not null,
  model_code text not null,
  is_demo boolean not null default true,
  created_at timestamptz not null default now(),

  constraint equipment_factory_fk
    foreign key (factory_id) references factories (id),
  constraint equipment_asset_code_not_blank
    check (btrim(asset_code) <> ''),
  constraint equipment_manufacturer_not_blank
    check (btrim(manufacturer) <> ''),
  constraint equipment_product_family_not_blank
    check (btrim(product_family) <> ''),
  constraint equipment_model_code_not_blank
    check (btrim(model_code) <> ''),
  constraint equipment_factory_asset_unique
    unique (factory_id, asset_code)
);

create index equipment_factory_id_idx on equipment (factory_id);

create table work_orders (
  id bigint generated always as identity primary key,
  work_order_no text not null,
  factory_id bigint not null,
  equipment_id bigint not null,
  fault_code text,
  status text not null,
  is_demo boolean not null default true,
  created_at timestamptz not null default now(),

  constraint work_orders_work_order_no_not_blank
    check (btrim(work_order_no) <> ''),
  constraint work_orders_work_order_no_unique
    unique (work_order_no),
  constraint work_orders_factory_fk
    foreign key (factory_id) references factories (id),
  constraint work_orders_equipment_fk
    foreign key (equipment_id) references equipment (id)
);

create index work_orders_factory_id_idx on work_orders (factory_id);
create index work_orders_equipment_id_idx on work_orders (equipment_id);
