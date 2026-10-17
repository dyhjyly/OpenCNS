-- ============================================================================
-- OpenCNS v2 — 0008_llm_usage
-- ============================================================================
-- 每次调用模型都记一笔：哪个模型、哪个用途、多少 token、命中多少缓存。
-- 为什么要落库：工具页要显示日/周用量与趋势，而且得能回答"钱花在哪了"。
-- ============================================================================

create table if not exists llm_usage (
  id                bigserial primary key,
  at                timestamptz not null default now(),
  endpoint          text not null,              -- chat / cognitive
  model             text not null,
  label             text,                       -- reply / recall-judge / compress / timeline …
  prompt_tokens     integer not null default 0,
  completion_tokens integer not null default 0,
  cached_tokens     integer not null default 0,
  reasoning_tokens  integer not null default 0,
  estimated         boolean not null default false,  -- 流式没有精确 usage，用字数估的
  ms                integer
);

create index if not exists llm_usage_at_idx on llm_usage (at desc);
create index if not exists llm_usage_label_idx on llm_usage (label);

insert into schema_migrations (version) values ('0008_llm_usage')
on conflict (version) do nothing;
