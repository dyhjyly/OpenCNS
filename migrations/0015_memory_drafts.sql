-- ============================================================================
-- OpenCNS v2 — 0015_memory_drafts
-- ============================================================================
-- 他存记忆，先不直接进记忆库，进"待审"。
--
-- 林遇的原话："我不知道他是不是每次记忆都没存进去，我查不到，
-- 在记忆库模块中另加一个记忆审核，他存的记忆都交给我看一遍，我再存进去。"
--
-- 单独一张表而不是给 memory_items 加状态，原因有两个：
--   1. 待审的东西不该参与召回/星图/衰减，隔离干净
--   2. 她要能改（改完再批），改了再插进正式表
-- ============================================================================

create table if not exists memory_drafts (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'semantic',
  content       text not null,
  quotes        jsonb not null default '[]'::jsonb,
  causal        text,
  event_time    timestamptz,
  importance    real not null default 0.5,
  /** 哪条路写进来的：save_memory（聊天）/ nightly（凌晨） */
  via           text not null default 'save_memory',
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected')),
  note          text,                     -- 她的备注
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz,
  /** 批准后插进 memory_items 的那条 id */
  memory_id     uuid references memory_items (id) on delete set null
);
create index if not exists memory_drafts_status_idx on memory_drafts (status, created_at desc);

insert into schema_migrations (version) values ('0015_memory_drafts')
on conflict (version) do nothing;
