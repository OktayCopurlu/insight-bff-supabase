-- Core ingestion schema required for local Edge Function testing.
create extension if not exists pgcrypto;

create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  homepage text
);

create table if not exists articles (
  id uuid primary key default gen_random_uuid(),
  title text,
  snippet text,
  url text,
  canonical_url text,
  published_at timestamptz,
  language text,
  source_id uuid references sources(id) on delete set null,
  fetched_at timestamptz default now()
);

-- legacy per-article AI table removed (cluster-first)

create table if not exists categories (
  id serial primary key,
  path text unique not null
);

create table if not exists article_categories (
  article_id uuid references articles(id) on delete cascade,
  category_id int references categories(id) on delete cascade,
  primary key (article_id, category_id)
);

create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(),
  url text
);

create table if not exists article_media (
  article_id uuid references articles(id) on delete cascade,
  media_id uuid references media_assets(id) on delete cascade,
  role text,
  primary key (article_id, media_id, role)
);

-- Seed minimal data for tests
insert into sources (id, name, homepage)
select gen_random_uuid(), 'Demo Source', 'https://example.com'
where not exists (select 1 from sources);

insert into categories (path)
select 'world'
where not exists (select 1 from categories where path='world');

do $$
declare src uuid; art uuid; cat_id int; med uuid;
begin
  select id into src from sources limit 1;
  select id into cat_id from categories where path='world';
  if not exists (select 1 from articles) then
    insert into articles (id,title,snippet,url,canonical_url,published_at,language,source_id)
      values (gen_random_uuid(),'Demo Article','This is a demo snippet for local testing.','https://example.com/demo','https://example.com/demo', now() - interval '1 hour','en',src)
      returning id into art;
    insert into article_categories(article_id,category_id) values (art,cat_id);
    insert into media_assets(id,url) values (gen_random_uuid(),'https://placehold.co/600x400');
    select id into med from media_assets limit 1;
    insert into article_media(article_id,media_id,role) values (art,med,'thumbnail');
  -- no per-article AI seed
  end if;
end $$;
