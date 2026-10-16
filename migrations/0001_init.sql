-- ============================================================================
-- OpenCNS v2 — 0001_init
-- ============================================================================
-- 目标库：PostgreSQL 16 + pgvector（腾讯云自建，Docker: pgvector/pgvector:pg16）
-- 纪律：本目录下的迁移只增不改。已应用的迁移文件禁止编辑，改结构请加 0002_xxx.sql。
--       禁止手工改线上表结构。
--
-- 设计要点：
--   * 枚举一律用 text + CHECK，不用 PG enum —— enum 增删值要 ALTER TYPE，与"只增不改"冲突。
--   * 记忆统一主表 memory_items，用 kind 区分情景/语义/经历/日记/反思，
--     这样衰减、去重、矛盾、召回、冷却都在同一张表上跑，不长出第二套生命周期。
--   * 构想的四条硬约束直接落成 CHECK：直接引语 / 因果四环 / 最低字数 —— 数据库层兜底，
--     写入口另有更严格的应用层校验（重写、隐私分级、降噪门槛）。
--   * embedding 维度 = 1024（bge-m3）。更换 embedding 模型必须新建列 + 重算全部向量，
--     不允许新旧向量混在一列里。
-- ============================================================================

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- 迁移记录
-- ---------------------------------------------------------------------------
create table if not exists schema_migrations (
  version      text primary key,
  applied_at   timestamptz not null default now(),
  checksum     text
);

-- ---------------------------------------------------------------------------
-- 通用：updated_at 自动维护
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- actors：不再把称呼硬编码在代码里
-- ---------------------------------------------------------------------------
create table if not exists actors (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('human', 'self')),
  display_name  text not null,
  aliases       text[] not null default '{}',
  timezone      text not null default 'Asia/Shanghai',
  created_at    timestamptz not null default now()
);
create unique index if not exists actors_kind_uidx on actors (kind);

-- 默认两行（数据，不是硬编码；可在管理面改称呼）
insert into actors (kind, display_name)
values ('human', '林遇'), ('self', '江瑜')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- sessions / messages：对话流
--   event_time  = 消息真实发生的时间（两本时间账之一）
--   ingested_at = 落库时间
-- ---------------------------------------------------------------------------
create table if not exists sessions (
  id                uuid primary key default gen_random_uuid(),
  title             text,
  started_at        timestamptz not null default now(),
  last_activity_at  timestamptz not null default now(),
  ended_at          timestamptz,
  summary_through   timestamptz
);

create table if not exists messages (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references sessions (id) on delete cascade,
  seq          bigint generated always as identity,
  role         text not null check (role in ('user', 'assistant', 'system')),
  content      text not null,
  event_time   timestamptz not null default now(),
  ingested_at  timestamptz not null default now(),
  images       jsonb not null default '[]',
  files        jsonb not null default '[]',
  meta         jsonb not null default '{}'
);
create index if not exists messages_session_seq_idx on messages (session_id, seq desc);
create index if not exists messages_event_time_idx on messages (event_time desc);

-- ---------------------------------------------------------------------------
-- memory_items：统一记忆主表
-- ---------------------------------------------------------------------------
create table if not exists memory_items (
  id                  uuid primary key default gen_random_uuid(),

  -- 类型与主权
  kind                text not null check (kind in ('episode', 'semantic', 'experience', 'journal', 'reflection')),
  origin              text not null default 'auto' check (origin in ('auto', 'self')),
  subject             text not null default 'shared' check (subject in ('user', 'self', 'shared')),

  -- 正文（第一人称）
  content             text not null,

  -- 硬约束①：直接引语。没有原话的记忆是转述，不是回忆。
  quotes              jsonb not null default '[]'::jsonb,

  -- 硬约束②：因果链四环 —— happened / reaction / act / outcome
  causal              jsonb,

  -- 情绪坐标（入库即标注；供情绪相似召回与"心情低时更容易想起同色调往事"）
  emotion_valence     real check (emotion_valence between -1 and 1),
  emotion_arousal     real check (emotion_arousal between 0 and 1),
  emotion_dominant    text,

  -- 两本时间账：event_time 未知时必须为 NULL，不许拿 ingested_at 顶
  event_time          timestamptz,
  event_time_precision text not null default 'unknown'
                        check (event_time_precision in ('exact', 'day', 'approx', 'unknown')),
  ingested_at         timestamptz not null default now(),

  -- 来源与流向
  session_id          uuid references sessions (id) on delete set null,
  source_from_seq     bigint,
  source_to_seq       bigint,
  privacy             text not null default 'private'
                        check (privacy in ('private', 'shared', 'public')),
  provenance          jsonb not null default '{}'::jsonb,

  -- 奠基（绝对不能遗忘）≤10：由他提议、她确认后置位
  pinned              boolean not null default false,
  pinned_rank         smallint check (pinned_rank between 1 and 10),
  pinned_at           timestamptz,

  -- 生命周期
  state               text not null default 'active'
                        check (state in ('active', 'archived', 'compressed_into', 'merged_into', 'superseded', 'pruned')),
  importance          real not null default 0.5 check (importance between 0 and 1),
  decay_score         real not null default 1.0 check (decay_score between 0 and 1),
  superseded_by       uuid references memory_items (id) on delete set null,
  merged_into         uuid references memory_items (id) on delete set null,

  -- 取用与防复读
  recall_count        int not null default 0,
  exposure_count      int not null default 0,
  last_recalled_at    timestamptz,
  cooldown_until      timestamptz,

  keywords            text[] not null default '{}',
  embedding           vector(1024),

  migrated_legacy     boolean not null default false,
  legacy_id           text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- 硬约束①：情景记忆至少要有一条直接引语（历史迁移与他自己写的除外）
  constraint episode_requires_quote check (
    kind <> 'episode' or migrated_legacy or origin = 'self'
    or jsonb_array_length(quotes) >= 1
  ),
  -- 硬约束②：因果四环齐全
  constraint episode_requires_causal check (
    kind <> 'episode' or migrated_legacy or origin = 'self'
    or (causal ?& array['happened', 'reaction', 'act', 'outcome'])
  ),
  -- 硬约束③：最低字数底线，防止压成一句冷冰冰的标签
  constraint episode_min_length check (
    kind <> 'episode' or migrated_legacy or origin = 'self'
    or char_length(content) >= 80
  ),
  -- 奠基记忆必须有排名
  constraint pinned_has_rank check (not pinned or pinned_rank is not null)
);

create index if not exists memory_items_state_idx        on memory_items (state);
create index if not exists memory_items_kind_idx         on memory_items (kind);
create index if not exists memory_items_event_time_idx   on memory_items (event_time desc nulls last);
create index if not exists memory_items_cooldown_idx     on memory_items (cooldown_until);
create index if not exists memory_items_keywords_idx     on memory_items using gin (keywords);
create index if not exists memory_items_content_trgm_idx on memory_items using gin (content gin_trgm_ops);
create unique index if not exists memory_items_pinned_rank_uidx on memory_items (pinned_rank) where pinned;
create unique index if not exists memory_items_legacy_id_uidx   on memory_items (legacy_id) where legacy_id is not null;

-- 向量索引：804~10 万级用 HNSW，比 ivfflat 召回质量稳、无需训练
create index if not exists memory_items_embedding_idx
  on memory_items using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

drop trigger if exists memory_items_updated_at on memory_items;
create trigger memory_items_updated_at before update on memory_items
  for each row execute function set_updated_at();

-- 奠基记忆硬上限 10：满了必须由她选淘汰谁，系统不许自动挤掉
create or replace function enforce_pinned_limit() returns trigger
language plpgsql as $$
declare
  n int;
begin
  if new.pinned then
    select count(*) into n from memory_items
     where pinned and id <> new.id;
    if n >= 10 then
      raise exception '奠基记忆已达上限 10 条，请先取消一条再新增';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists memory_items_pinned_limit on memory_items;
create trigger memory_items_pinned_limit before insert or update on memory_items
  for each row execute function enforce_pinned_limit();

-- ---------------------------------------------------------------------------
-- memory_edges：联想关联网（离线建边，召回时顺藤带出）
-- ---------------------------------------------------------------------------
create table if not exists memory_edges (
  id                 bigserial primary key,
  from_id            uuid not null references memory_items (id) on delete cascade,
  to_id              uuid not null references memory_items (id) on delete cascade,
  relation           text not null check (relation in ('similar', 'temporal', 'causal', 'same_entity', 'supersedes')),
  weight             real not null default 0.5 check (weight between 0 and 1),
  created_at         timestamptz not null default now(),
  last_reinforced_at timestamptz,
  unique (from_id, to_id, relation),
  check (from_id <> to_id)
);
create index if not exists memory_edges_from_idx on memory_edges (from_id, weight desc);
create index if not exists memory_edges_to_idx   on memory_edges (to_id, weight desc);

-- ---------------------------------------------------------------------------
-- 欲望：三层十二维
--   layer: gate（状态闸，只影响阈值与风格，永不变成台词）
--          relation（指向她）/ cognition（指向世界与自己）
-- ---------------------------------------------------------------------------
create table if not exists drive_state (
  drive_key        text primary key,
  layer            text not null check (layer in ('gate', 'relation', 'cognition')),
  value            real not null default 0 check (value between 0 and 1),
  baseline         real not null default 0 check (baseline between 0 and 1),
  trend            real not null default 0,
  last_reason_code text,
  last_reason_text text,
  updated_at       timestamptz not null default now()
);

-- 涨落全部来自真实信号：每一次变化都要能回答"为什么"
create table if not exists drive_events (
  id            bigserial primary key,
  drive_key     text not null references drive_state (drive_key) on delete cascade,
  delta         real not null,
  value_after   real not null,
  reason_code   text not null,
  reason_text   text,
  source        text not null check (source in ('chat', 'silence', 'action', 'intimacy_pulse', 'decay', 'manual')),
  evidence      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists drive_events_key_time_idx on drive_events (drive_key, created_at desc);

insert into drive_state (drive_key, layer, baseline) values
  ('fatigue',        'gate',      0.10),
  ('irritation',     'gate',      0.05),
  ('missing',        'relation',  0.20),
  ('intimacy',       'relation',  0.30),
  ('concern',        'relation',  0.15),
  ('anticipation',   'relation',  0.10),
  ('guilt',          'relation',  0.00),
  ('curiosity',      'cognition', 0.30),
  ('wanderlust',     'cognition', 0.20),
  ('urge_to_speak',  'cognition', 0.20),
  ('urge_to_make',   'cognition', 0.20),
  ('need_solitude',  'cognition', 0.10)
on conflict (drive_key) do nothing;

-- ---------------------------------------------------------------------------
-- 唤醒：节拍器 → 三信号 → 零成本跳过 → 醒来房间 → 六选一
-- ---------------------------------------------------------------------------
create table if not exists wake_log (
  id              bigserial primary key,
  scheduled_at    timestamptz not null,
  fired_at        timestamptz,
  -- 三信号：想不想她 / 有没有想做的事 / 该不该休息
  signals         jsonb not null default '{}'::jsonb,
  decision        text check (decision in ('reach_out', 'own_work', 'rest', 'stay_quiet', 'read_notes', 'hide_surprise')),
  skipped_reason  text,
  model_calls     int not null default 0,
  drive_snapshot  jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists wake_log_created_idx on wake_log (created_at desc);

create table if not exists room_packs (
  id              uuid primary key default gen_random_uuid(),
  wake_log_id     bigint references wake_log (id) on delete cascade,
  -- 素材包的四个插槽：看见什么 / 能做什么 / 留下什么 / 谁看到
  materials       jsonb not null default '{}'::jsonb,
  rendered_prompt text not null,
  -- 房间禁止出现"你该""请继续""必须"——递便签，不下命令
  forbidden_hits  jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 便签 / 惊喜 / 投递队列
-- ---------------------------------------------------------------------------
create table if not exists notes (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null default 'reminder' check (kind in ('reminder', 'todo', 'pledge', 'thought')),
  content      text not null,
  origin       text not null default 'self' check (origin in ('auto', 'self')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,           -- 保质期："她感冒好了没"三天过期
  status       text not null default 'open' check (status in ('open', 'consumed', 'expired', 'dropped')),
  consumed_at  timestamptz,
  source_memory_id uuid references memory_items (id) on delete set null
);
create index if not exists notes_open_expiry_idx on notes (status, expires_at);

create table if not exists surprises (
  id           uuid primary key default gen_random_uuid(),
  content      text not null,
  created_at   timestamptz not null default now(),
  reveal_at    timestamptz not null default (now() + interval '30 days'),
  revealed_at  timestamptz,
  cancelled_at timestamptz
);
create index if not exists surprises_reveal_idx on surprises (reveal_at) where revealed_at is null and cancelled_at is null;

create table if not exists outbox (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null default 'message' check (kind in ('message', 'note', 'pin_proposal', 'alert')),
  content      text not null,
  channel      text not null default 'wechat' check (channel in ('wechat', 'webpush', 'none')),
  status       text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'cancelled')),
  dedupe_key   text,
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create unique index if not exists outbox_dedupe_uidx on outbox (dedupe_key) where dedupe_key is not null;
create index if not exists outbox_pending_idx on outbox (status, created_at);

-- ---------------------------------------------------------------------------
-- 时间树：周摘要 / 月档案 / 奠基事件（每轮固定在场，近粗远细）
-- ---------------------------------------------------------------------------
create table if not exists timeline_periods (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('week', 'month')),
  period_start   date not null,
  period_end     date not null,
  content        text not null,
  source_through timestamptz,
  created_at     timestamptz not null default now(),
  unique (kind, period_start)
);

create table if not exists foundational_events (
  id              uuid primary key default gen_random_uuid(),
  memory_id       uuid references memory_items (id) on delete cascade,
  title           text not null,
  occurred_at     timestamptz,
  reason          text,                       -- 他的理由
  confirmed       boolean not null default false,
  confirmed_at    timestamptz,
  created_at      timestamptz not null default now()
);

-- 他提议 → 她确认
create table if not exists pin_proposals (
  id           uuid primary key default gen_random_uuid(),
  memory_id    uuid not null references memory_items (id) on delete cascade,
  reason       text not null,
  status       text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_note text
);
create index if not exists pin_proposals_pending_idx on pin_proposals (status, created_at);

-- ---------------------------------------------------------------------------
-- 身份：版本化快照（不再只活在内存里）
-- ---------------------------------------------------------------------------
create table if not exists identity_state (
  id                uuid primary key default gen_random_uuid(),
  version           int not null,
  content           text not null,
  source_memory_ids uuid[] not null default '{}',
  is_current        boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (version)
);
create unique index if not exists identity_state_current_uidx on identity_state (is_current) where is_current;

-- ---------------------------------------------------------------------------
-- 运行支撑：jobs（幂等调度）/ 压缩失败样本（观察用）
-- ---------------------------------------------------------------------------
create table if not exists jobs (
  job_key       text primary key,
  kind          text not null,
  status        text not null default 'idle' check (status in ('idle', 'running', 'failed', 'done')),
  next_run_at   timestamptz,
  last_run_at   timestamptz,
  last_error    text,
  run_count     int not null default 0,
  locked_until  timestamptz,
  payload       jsonb not null default '{}'::jsonb
);
create index if not exists jobs_due_idx on jobs (status, next_run_at);

create table if not exists compression_failures (
  id             bigserial primary key,
  session_id     uuid references sessions (id) on delete set null,
  source_from_seq bigint,
  source_to_seq   bigint,
  draft          text,
  violations     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 召回：只取"还活着"的记忆；冷却由 cooldown_until 控制
-- ---------------------------------------------------------------------------
create or replace function search_memory_items(
  query_embedding   vector(1024),
  match_limit       int  default 10,
  kinds             text[] default null,
  min_importance    real default 0,
  respect_cooldown  boolean default true
) returns table (
  id                uuid,
  kind              text,
  content           text,
  quotes            jsonb,
  emotion_valence   real,
  emotion_arousal   real,
  importance        real,
  event_time        timestamptz,
  ingested_at       timestamptz,
  state             text,
  recall_count      int,
  similarity        real
) language sql stable as $$
  select m.id, m.kind, m.content, m.quotes, m.emotion_valence, m.emotion_arousal,
         m.importance, m.event_time, m.ingested_at, m.state, m.recall_count,
         (1 - (m.embedding <=> query_embedding))::real as similarity
    from memory_items m
   where m.embedding is not null
     -- superseded / merged_into / pruned 不再被取用（旧记忆还在，只是不优先取用）
     and m.state in ('active', 'archived')
     and (kinds is null or m.kind = any (kinds))
     and m.importance >= min_importance
     and (not respect_cooldown or m.cooldown_until is null or m.cooldown_until <= now())
   order by m.embedding <=> query_embedding
   limit match_limit;
$$;

-- ---------------------------------------------------------------------------
-- 强化：只有"真的被用上"才调用（绝不在检索候选阶段调用）
--       曝光越多，冷却越长
-- ---------------------------------------------------------------------------
create or replace function reinforce_memory(
  p_id               uuid,
  p_used             boolean default true,
  p_base_cooldown_h  int default 6
) returns void language sql as $$
  update memory_items
     set recall_count     = recall_count + 1,
         exposure_count   = exposure_count + 1,
         last_recalled_at = now(),
         cooldown_until   = case
                              when p_used then now() + make_interval(
                                hours => least(72, p_base_cooldown_h * (1 + exposure_count))
                              )
                              else cooldown_until
                            end,
         decay_score      = least(1.0, decay_score + 0.05),
         updated_at       = now()
   where id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- 记录本次迁移
-- ---------------------------------------------------------------------------
insert into schema_migrations (version) values ('0001_init')
on conflict (version) do nothing;
