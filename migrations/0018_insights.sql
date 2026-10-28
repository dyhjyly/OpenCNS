-- ============================================================================
-- OpenCNS v2 — 0018_insights
-- ============================================================================
-- P3：自省沉淀（参照 Ombre-Brain 的 feel 桶 + I 条目）
--
-- 他们的规矩（rule.md 13.1）：
--   "I 是沉淀物，不是日记。一个『我觉得……』先以普通记忆的形式活着，
--    被若干次**不同日期**的 dream 见证之后还站得住的，才由模型显式升级成 I 条目。
--    系统只把相关材料摆在一起，不判断谁支持谁、谁与谁矛盾（那是认知层）。"
--
-- 所以这里只做两件事：记下他说的话、数它被证见了几天。
-- **不判断对错，不自动合并，不替他升级。**
-- ============================================================================

create table if not exists insights (
  id               uuid primary key default gen_random_uuid(),
  content          text not null,
  /** candidate=还站不稳，established=立住了，dropped=他自己收回 */
  status           text not null default 'candidate'
                   check (status in ('candidate', 'established', 'dropped')),
  /** 被证见的日期（YYYY-MM-DD），跨日才计数 */
  witness_days     jsonb not null default '[]'::jsonb,
  last_witnessed_at timestamptz,
  /** 当时撞上的是哪几条记忆 */
  source_ids       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists insights_status_idx on insights (status, created_at desc);

insert into schema_migrations (version) values ('0018_insights')
on conflict (version) do nothing;
