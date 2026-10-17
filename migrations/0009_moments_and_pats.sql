-- ============================================================================
-- OpenCNS v2 — 0009_moments_and_pats
-- ============================================================================
-- 两个人的朋友圈 + 拍一拍。
--
-- 朋友圈不是社交产品，是"两个人一起看的时间流"：江瑜发动态，林遇点赞评论；
-- 也可以反过来。所以 author 只有两个值，不需要关注、不需要隐私分组。
-- ============================================================================

create table if not exists moments (
  id          uuid primary key default gen_random_uuid(),
  author      text not null check (author in ('self', 'human')),   -- self=江瑜 human=林遇
  content     text not null,
  images      jsonb not null default '[]'::jsonb,                   -- [{id,name,mime}]
  mood        text,                                                 -- 深夜 / 清晨 这类小标签
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists moments_created_idx on moments (created_at desc) where deleted_at is null;

create table if not exists moment_likes (
  moment_id   uuid not null references moments (id) on delete cascade,
  by_who      text not null check (by_who in ('self', 'human')),
  created_at  timestamptz not null default now(),
  primary key (moment_id, by_who)
);

create table if not exists moment_comments (
  id          uuid primary key default gen_random_uuid(),
  moment_id   uuid not null references moments (id) on delete cascade,
  author      text not null check (author in ('self', 'human')),
  content     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists moment_comments_idx on moment_comments (moment_id, created_at);

-- 拍一拍：一行系统小字，不参与记忆，但让模型知道"她刚才拍了拍你"
create table if not exists pats (
  id          bigserial primary key,
  from_who    text not null check (from_who in ('self', 'human')),
  to_who      text not null check (to_who in ('self', 'human')),
  suffix      text,                       -- 例如"说：在的"
  session_id  uuid references sessions (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists pats_created_idx on pats (created_at desc);

insert into schema_migrations (version) values ('0009_moments_and_pats')
on conflict (version) do nothing;
