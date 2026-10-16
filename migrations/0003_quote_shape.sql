-- ============================================================================
-- OpenCNS v2 — 0003_quote_shape
-- ============================================================================
-- 问题：0002 用 jsonb_path_exists(quotes, '$[*] ? (@.said.type() != "string" ...)')
--       想校验每条引语都带非空 said。实测无效：在 SQL/JSON 路径语义里，
--       成员**不存在**时条件求值为 unknown（而非 true），于是缺 said 的引语
--       照样通过（M1 验收 T3b 抓到）。
--
-- 修法：改用不可变函数逐元素判定，语义直白、可单测。
-- 纪律：0001、0002 保持原样，新增本文件。
-- ============================================================================

create or replace function episode_quotes_valid(q jsonb)
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(
    bool_and(
      jsonb_typeof(e) = 'object'
      and (e ? 'said')
      and coalesce(e->>'said', '') <> ''
    ),
    false
  )
  from jsonb_array_elements(coalesce(q, '[]'::jsonb)) as t(e);
$$;

alter table memory_items drop constraint if exists episode_requires_quote;

alter table memory_items add constraint episode_requires_quote check (
  kind <> 'episode'
  or migrated_legacy
  or origin = 'self'
  or (
    jsonb_array_length(quotes) >= 1
    and episode_quotes_valid(quotes)
  )
);

insert into schema_migrations (version) values ('0003_quote_shape')
on conflict (version) do nothing;
