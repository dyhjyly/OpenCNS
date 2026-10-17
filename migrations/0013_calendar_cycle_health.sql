-- ============================================================================
-- OpenCNS v2 — 0013_calendar_cycle_health
-- ============================================================================
-- 三块东西，都是"她自己记，他想看时才问"的数据。
--
--   daily_states   日历里她手动添加的每日状态（心情 / 精力 / 一句话）
--   cycle_entries  经期开始与结束（她自己点，系统据此推算周期）
--   health_metrics 每日步数 / 消耗 / 喝水 —— **只存近两周**，超过 15 天自动删
--
-- 为什么健康数据要定期删：这类数字越攒越多、价值随时间掉得很快，
-- 留着只会让查询变慢、让上下文变脏。留两周够看出趋势了。
-- ============================================================================

create table if not exists daily_states (
  id          uuid primary key default gen_random_uuid(),
  day         date not null unique,
  mood        text,                          -- 开心 / 累 / 低落 …
  energy      int check (energy is null or (energy between 1 and 5)),
  note        text,                          -- 她自己写的一句话
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists daily_states_day_idx on daily_states (day desc);

create table if not exists cycle_entries (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('start', 'end')),
  day         date not null,
  note        text,
  created_at  timestamptz not null default now(),
  unique (kind, day)
);
create index if not exists cycle_entries_day_idx on cycle_entries (day desc);

create table if not exists health_metrics (
  id          uuid primary key default gen_random_uuid(),
  day         date not null unique,
  steps       int,
  calories    int,
  water_ml    int,
  active_min  int,
  note        text,
  source      text not null default 'manual' check (source in ('manual', 'import')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists health_metrics_day_idx on health_metrics (day desc);

insert into schema_migrations (version) values ('0013_calendar_cycle_health')
on conflict (version) do nothing;
