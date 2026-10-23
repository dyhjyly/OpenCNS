-- ============================================================================
-- OpenCNS v2 — 0016_mcp_servers
-- ============================================================================
-- 他能不能用外部的 MCP 工具，由她手动决定连不连。
--
-- 存的是连接信息 + 上一次探测到的工具清单。密码/token 放在 headers 里，
-- 这只在一台自己的服务器上，够用；要看的话在前端也能看到自己填了什么。
-- ============================================================================

create table if not exists mcp_servers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  url           text not null,
  /** 额外请求头，比如 { "Authorization": "Bearer xxx" } */
  headers       jsonb not null default '{}'::jsonb,
  enabled       boolean not null default true,
  /** idle | connected | error */
  status        text not null default 'idle' check (status in ('idle', 'connected', 'error')),
  /** tools/list 的结果 */
  tools         jsonb not null default '[]'::jsonb,
  error         text,
  session_id    text,
  connected_at  timestamptz,
  created_at    timestamptz not null default now()
);

insert into schema_migrations (version) values ('0016_mcp_servers')
on conflict (version) do nothing;
