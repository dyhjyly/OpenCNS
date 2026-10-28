-- ============================================================================
-- OpenCNS v2 — 0017_memory_merge_and_resolve
-- ============================================================================
-- P1：写入合并 / 检索不算强化 / 结案 / 衰减分段
--
-- 参照 Ombre-Brain（P0luz/Ombre-Brain）的三条做法：
--   1. 写入先去重合并 —— 同一件事不要变成三条记忆
--   2. **检索不强化** —— "我去找它"不等于"它重要"；
--      强化只能是找到之后明确的判断（他们踩过坑：旧桶权重积到 51，新桶再也排不进浮现区）
--   3. resolved（结案）—— 事情过去了就沉底，但绝不删除
-- ============================================================================

-- 1) 新字段
alter table memory_items
  add column if not exists activation_count int not null default 0,
  add column if not exists resolved_at      timestamptz,
  add column if not exists merge_count      int not null default 0,
  add column if not exists merged_into      uuid references memory_items (id) on delete set null;

comment on column memory_items.activation_count is '被**明确认定**重要的次数。检索不加，只有他调用 mark_important 或她在审核时收下才加';
comment on column memory_items.resolved_at is '结案时间。事情过去了就沉底，但记忆仍在库里';
comment on column memory_items.merged_into is '如果这条被并进别的记忆，指向目标';

-- 2) 合并记录：她要"合并了告诉我"，所以每次合并都留一条，可回看
create table if not exists memory_merges (
  id            uuid primary key default gen_random_uuid(),
  target_id     uuid not null references memory_items (id) on delete cascade,
  similarity    real not null,
  /** 并进去的那段原文（快照，源条目要是被删了也还看得见） */
  merged_text   text not null,
  merged_quotes jsonb not null default '[]'::jsonb,
  /** 谁触发的：save_memory / nightly / approve */
  via           text not null default 'unknown',
  seen          boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists memory_merges_created_idx on memory_merges (created_at desc);
create index if not exists memory_merges_unseen_idx on memory_merges (seen) where not seen;

-- 3) 曝光：只记"这条被取出来过"和冷却，**不动任何权重**
create or replace function touch_exposure(
  p_id             uuid,
  p_base_cooldown_h int default 6
) returns void language sql as $$
  update memory_items
     set exposure_count = exposure_count + 1,
         cooldown_until = now() + make_interval(
           hours => least(72, p_base_cooldown_h * (1 + exposure_count))
         ),
         updated_at     = now()
   where id = p_id;
$$;

-- 4) 显式强化：只有"这条确实要紧"才调
create or replace function reinforce_memory(
  p_id   uuid,
  p_used boolean default true,
  p_base_cooldown_h int default 6
) returns void language sql as $$
  update memory_items
     set activation_count = activation_count + 1,
         last_recalled_at = now(),
         updated_at       = now()
   where id = p_id;
$$;

-- 5) 结案
create or replace function resolve_memory(p_id uuid) returns void language sql as $$
  update memory_items set resolved_at = now(), updated_at = now() where id = p_id;
$$;

insert into schema_migrations (version) values ('0017_memory_merge_and_resolve')
on conflict (version) do nothing;
