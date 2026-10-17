-- ============================================================================
-- OpenCNS v2 — 0005_drive_pulses
-- ============================================================================
-- 亲密之后有余波（构想）：
--   「20~44小时的窗口里有一次性'过夜脉冲'，有明确来源、只触发一次，错过不补发。」
--
-- 所以脉冲必须落库、带来源、带到期时间，并且 fired_at 一旦写上就不再触发。
-- 不能用"每次 tick 检查一下值大不大"这种写法 —— 那不是"只触发一次"。
-- ============================================================================

create table if not exists drive_pulses (
  id          uuid primary key default gen_random_uuid(),
  drive_key   text not null references drive_state (drive_key) on delete cascade,
  due_at      timestamptz not null,
  fired_at    timestamptz,
  -- 明确来源：因为什么起的脉冲
  source      text not null,
  evidence    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  -- 只触发一次
  unique (drive_key, due_at)
);

create index if not exists drive_pulses_due_idx
  on drive_pulses (due_at)
  where fired_at is null;

insert into schema_migrations (version) values ('0005_drive_pulses')
on conflict (version) do nothing;
