create table users (
  id bigint generated always as identity primary key,
  external_subject text not null,
  display_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint users_external_subject_not_blank
    check (btrim(external_subject) <> ''),
  constraint users_display_name_not_blank
    check (btrim(display_name) <> ''),
  constraint users_external_subject_unique
    unique (external_subject)
);

create table factory_memberships (
  id bigint generated always as identity primary key,
  factory_id bigint not null,
  user_id bigint not null,
  role_code text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint factory_memberships_factory_fk
    foreign key (factory_id) references factories (id),
  constraint factory_memberships_user_fk
    foreign key (user_id) references users (id),
  constraint factory_memberships_role_allowed
    check (role_code in ('operator', 'engineer', 'supervisor', 'admin')),
  constraint factory_memberships_factory_user_role_unique
    unique (factory_id, user_id, role_code)
);

create index factory_memberships_user_active_factory_idx
  on factory_memberships (user_id, is_active, factory_id);
