begin;

insert into product_families (
  manufacturer_name,
  family_code,
  display_name
)
values (
  'Schneider Electric',
  'ATV320',
  'Altivar Machine ATV320'
)
on conflict do nothing;

insert into source_documents (
  publisher,
  title,
  document_reference,
  product_family_id,
  raw_product_family,
  source_type,
  official_url
)
select
  'Schneider Electric',
  'ATV320 编程手册',
  'NVE41300',
  product_family.id,
  'ATV320',
  'official_manual',
  'https://www.schneider-electric.cn/zh/download/document/NVE41300/'
from product_families as product_family
where lower(btrim(product_family.manufacturer_name)) = 'schneider electric'
  and lower(btrim(product_family.family_code)) = 'atv320'
on conflict do nothing;

do $$
begin
  if not exists (
    select 1
    from source_documents as source_document
    join product_families as product_family
      on product_family.id = source_document.product_family_id
    where lower(btrim(source_document.publisher)) = 'schneider electric'
      and lower(btrim(source_document.document_reference)) = 'nve41300'
      and source_document.source_type = 'official_manual'
      and lower(btrim(product_family.manufacturer_name)) = 'schneider electric'
      and lower(btrim(product_family.family_code)) = 'atv320'
  ) then
    raise exception 'verified source document metadata conflict: NVE41300';
  end if;
end
$$;

insert into source_versions (
  source_document_id,
  version_label,
  language_code,
  publisher_page_date,
  document_issue_label,
  sha256,
  local_path,
  version_status
)
select
  source_document.id,
  '05',
  'zh-CN',
  date '2025-07-04',
  '07/2024',
  'a6a033d439ab3340bde3d062979aba8bd6014762d12e2fb39aafe34aef000e57',
  'data/raw/official/schneider/atv320/ATV320_Programming_manual_CN_NVE41300_05.pdf',
  'unreviewed'
from source_documents as source_document
where lower(btrim(source_document.publisher)) = 'schneider electric'
  and lower(btrim(source_document.document_reference)) = 'nve41300'
on conflict do nothing;

commit;
