-- ============================================================================
-- OpenCNS v2 — 0012_sleep_records
-- ============================================================================
-- 睡眠记录。
--
-- 现状：手环 Health Connect 在国行版 + OPPO 上不支持，所以她每天发手环截图。
-- 模型能直接读图（实测能读出 23:41 / 09:12 / 7:31 / 1:15），所以流程是：
--   截图 → 模型提取结构化数据 → 落库 → 趋势
-- 识别不准时允许手动改。
-- ============================================================================

create table if not exists sleep_records (
  id             uuid primary key default gen_random_uuid(),
  -- 哪一晚（用醒来的日期当键，一天一条）
  night          date not null unique,
  bedtime        text,                -- '23:41'
  wake_time      text,                -- '09:12'
  total_minutes  int,
  awake_count    int,
  deep_minutes   int,
  light_minutes  int,
  rem_minutes    int,
  awake_minutes  int,
  /** 模型从截图里读出来的置信度，0~1 */
  confidence     numeric(3,2),
  source         text not null default 'screenshot' check (source in ('screenshot', 'manual')),
  upload_id      text,                -- 对应 data/uploads 里的图
  raw            jsonb not null default '{}'::jsonb,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists sleep_night_idx on sleep_records (night desc);

insert into schema_migrations (version) values ('0012_sleep_records')
on conflict (version) do nothing;
