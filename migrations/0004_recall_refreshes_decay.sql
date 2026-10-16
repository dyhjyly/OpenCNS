-- ============================================================================
-- OpenCNS v2 — 0004_recall_refreshes_decay
-- ============================================================================
-- 衰减模型定为"纯函数"：decay_score = exp(- 距上次想起的天数 / 半衰期)，
-- 半衰期随重要度变长。这样每天重算都不会复利式塌缩
-- （旧库那批 1e-201 的次正规浮点就是"反复对当前值再乘一次衰减"打出来的）。
--
-- 因此"被想起"必须把 last_recalled_at 归零，并把 decay_score 立刻置为 1：
-- 想起一次，就鲜活一次。
-- ============================================================================

create or replace function reinforce_memory(
  p_id               uuid,
  p_used             boolean default true,
  p_base_cooldown_h  int default 6
) returns void language sql as $$
  update memory_items
     set recall_count     = recall_count + 1,
         exposure_count   = exposure_count + 1,
         last_recalled_at = now(),
         -- 想起 = 重新鲜活（下次 decay 会按 last_recalled_at 重算，这里先给到满）
         decay_score      = 1.0,
         -- 曝光越多，冷却越长
         cooldown_until   = case
                              when p_used then now() + make_interval(
                                hours => least(72, p_base_cooldown_h * (1 + exposure_count))
                              )
                              else cooldown_until
                            end,
         updated_at       = now()
   where id = p_id;
$$;

insert into schema_migrations (version) values ('0004_recall_refreshes_decay')
on conflict (version) do nothing;
