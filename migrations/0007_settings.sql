-- ============================================================================
-- OpenCNS v2 — 0007_settings
-- ============================================================================
-- 运行时可改的设置（模型 / effort / 温度 / 输出上限）。
-- 为什么要落库而不是只放 .env：前端做好之后要有一个"方便修改的入口"，
-- 改完立刻生效、不用登服务器改文件重启。
--
-- 只存叶子级配置；敏感信息（API key）永远不进来。
-- ============================================================================

create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into settings (key, value) values
  -- 对话模型：默认 DeepSeek-V4.1-Flash（省钱、够用；要更深可以在前端切 pro）
  ('llm.chat_model',       '"deepseek-flash"'::jsonb),
  -- 认知任务（召回裁决 / 记忆压缩 / 时间树 / 欲望信号）
  ('llm.cognitive_model',  '"deepseek-flash"'::jsonb),
  -- 推理强度：low / high / max。认知任务用 low 换速度
  ('llm.chat_effort',      '"high"'::jsonb),
  ('llm.cognitive_effort', '"low"'::jsonb),
  ('llm.chat_max_tokens',  '4000'::jsonb),
  ('chat.temperature',     '0.9'::jsonb)
on conflict (key) do nothing;

insert into schema_migrations (version) values ('0007_settings')
on conflict (version) do nothing;
