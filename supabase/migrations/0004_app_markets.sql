-- Create app_markets table used by BFF /config
create table if not exists app_markets (
  id uuid primary key default gen_random_uuid(),
  market_code text not null unique,
  enabled boolean not null default true,
  show_langs text[] not null default '{en}',
  pretranslate_langs text[] not null default '{}',
  default_lang text not null default 'en',
  pivot_lang text not null default 'en',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists app_markets_enabled_idx on app_markets(enabled);
create index if not exists app_markets_code_idx on app_markets(market_code);

-- Seed an example market only if table is empty
insert into app_markets (market_code, enabled, show_langs, pretranslate_langs, default_lang, pivot_lang)
select 'CH', true, array['de','fr','it'], array['de','fr'], 'de', 'en'
where not exists (select 1 from app_markets);
