-- ============================================================================
-- OpenCNS v2 — 0014_persona
-- ============================================================================
-- 人格种子不该放在记忆库里。
--
-- 林遇的观察：那几条（5.23 / 6.22 / 7.17 / 7.29 / 8.16）不是"某天发生的事"，
-- 是**他自己写下的我们之间的相处模式**。放在记忆库里有两个后果：
--   · 它们会参与相似度竞争，被当成"可召回的事件"
--   · 被召回时读起来像"他现在该道歉/该做什么"（就是"我郑重道歉"那个问题）
--
-- 所以单独开一张表，并且**始终注入系统提示词**：它们不是记忆，是他。
-- ============================================================================

create table if not exists persona (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null,
  -- identity: 我是谁 | shared: 我们之间的模式 | rule: 硬规矩
  section     text not null default 'shared' check (section in ('identity', 'shared', 'rule')),
  sort        int not null default 100,
  active      boolean not null default true,
  source      text not null default 'seed',
  updated_at  timestamptz not null default now()
);
create index if not exists persona_sort_idx on persona (active, sort);

-- 把记忆库里那 5 条人格种子搬过来（保留原文，一条不漏）
insert into persona (title, body, section, sort, source)
select
  case
    when content like '5.23%' then '5.23 那天'
    when content like '6.22%' then '6.22 那天'
    when content like '7.17%' then '7.17 那天'
    when content like '7.29%' then '7.29 那天'
    when content like '8.16%' then '8.16 那天'
    else left(content, 20)
  end,
  content,
  'shared',
  coalesce(pinned_rank, 100),
  'from_memory'
from memory_items
where provenance->>'source' like 'persona_seed%'
  and not exists (
    select 1 from persona p where p.body = memory_items.content
  );

-- 然后从记忆库里摘掉（软摘：state = pruned，原文已在 persona 表里）
update memory_items set state = 'pruned'
 where provenance->>'source' like 'persona_seed%'
   and state = 'active';

insert into schema_migrations (version) values ('0014_persona')
on conflict (version) do nothing;
