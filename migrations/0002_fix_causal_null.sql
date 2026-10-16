-- ============================================================================
-- OpenCNS v2 — 0002_fix_causal_null
-- ============================================================================
-- 问题：0001 里的 episode_requires_causal 用了
--         causal ?& array['happened','reaction','act','outcome']
--       当 causal 为 NULL 时，整个表达式求值为 NULL，而 CHECK 约束
--       **只在结果为 FALSE 时才算违规**，NULL 会被放行。
--       实测：一条没有 causal 的 episode 成功插入（M1 验收 T2 抓到）。
--
-- 修法：显式要求 causal 非 NULL。
-- 纪律：不改 0001（已应用的迁移只增不改），新增本文件。
-- ============================================================================

alter table memory_items drop constraint if exists episode_requires_causal;

alter table memory_items add constraint episode_requires_causal check (
  kind <> 'episode'
  or migrated_legacy
  or origin = 'self'
  or (
    causal is not null
    and causal ?& array['happened', 'reaction', 'act', 'outcome']
  )
);

-- 顺带加固引语约束：数组里的每个元素都必须是对象，且带非空的 said 字段。
-- （JSONB 路径表达式可以在 CHECK 里用；子查询不行。）
alter table memory_items drop constraint if exists episode_requires_quote;

alter table memory_items add constraint episode_requires_quote check (
  kind <> 'episode'
  or migrated_legacy
  or origin = 'self'
  or (
    jsonb_array_length(quotes) >= 1
    and not jsonb_path_exists(quotes, '$[*] ? (@.said.type() != "string" || @.said == "")')
  )
);

insert into schema_migrations (version) values ('0002_fix_causal_null')
on conflict (version) do nothing;
