create table product_families (
  id bigint generated always as identity primary key,
  manufacturer_name text not null,
  family_code text not null,
  display_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint product_families_manufacturer_not_blank
    check (btrim(manufacturer_name) <> ''),
  constraint product_families_family_code_not_blank
    check (btrim(family_code) <> ''),
  constraint product_families_display_name_not_blank
    check (btrim(display_name) <> '')
);

create unique index product_families_manufacturer_family_key
  on product_families (
    lower(btrim(manufacturer_name)),
    lower(btrim(family_code))
  );

create table equipment_models (
  id bigint generated always as identity primary key,
  product_family_id bigint not null,
  model_code text not null,
  display_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint equipment_models_product_family_fk
    foreign key (product_family_id) references product_families (id),
  constraint equipment_models_model_code_not_blank
    check (btrim(model_code) <> ''),
  constraint equipment_models_display_name_not_blank
    check (btrim(display_name) <> '')
);

create unique index equipment_models_family_model_key
  on equipment_models (
    product_family_id,
    lower(btrim(model_code))
  );
