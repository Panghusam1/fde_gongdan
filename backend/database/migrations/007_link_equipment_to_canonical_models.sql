alter table equipment
  add column equipment_model_id bigint;

insert into product_families (
  manufacturer_name,
  family_code,
  display_name
)
select
  min(btrim(manufacturer)),
  min(btrim(product_family)),
  min(btrim(product_family))
from equipment
group by
  lower(btrim(manufacturer)),
  lower(btrim(product_family))
on conflict do nothing;

insert into equipment_models (
  product_family_id,
  model_code,
  display_name
)
select
  pf.id,
  min(btrim(e.model_code)),
  min(btrim(e.model_code))
from equipment e
join product_families pf
  on lower(btrim(pf.manufacturer_name)) = lower(btrim(e.manufacturer))
 and lower(btrim(pf.family_code)) = lower(btrim(e.product_family))
group by
  pf.id,
  lower(btrim(e.model_code))
on conflict do nothing;

update equipment e
set equipment_model_id = em.id
from equipment_models em
join product_families pf
  on pf.id = em.product_family_id
where lower(btrim(pf.manufacturer_name)) = lower(btrim(e.manufacturer))
  and lower(btrim(pf.family_code)) = lower(btrim(e.product_family))
  and lower(btrim(em.model_code)) = lower(btrim(e.model_code))
  and e.equipment_model_id is null;

alter table equipment
  alter column equipment_model_id set not null;

alter table equipment
  add constraint equipment_equipment_model_fk
  foreign key (equipment_model_id) references equipment_models (id);

create index equipment_equipment_model_id_idx
  on equipment (equipment_model_id);

alter table equipment
  rename column manufacturer to raw_manufacturer;

alter table equipment
  rename column product_family to raw_product_family;

alter table equipment
  rename column model_code to raw_model_code;

alter table equipment
  alter column raw_manufacturer drop not null;

alter table equipment
  alter column raw_product_family drop not null;

alter table equipment
  alter column raw_model_code drop not null;
