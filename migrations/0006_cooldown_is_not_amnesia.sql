-- ============================================================================
-- OpenCNS v2 — 0006_cooldown_is_not_amnesia
-- ============================================================================
-- 实测问题：防复读冷却设成 6 小时起、最多 72 小时，结果她问"你还记得我上次
-- 复查的结果吗"，那三条记忆正在冷却里被直接丢弃 —— 系统回答"这个我没记住"。
--
-- 冷却的本意是"不要反复主动提起同一条"，不是"问起来也装作想不起来"。
-- 所以：
--   1) 冷却基准从 6 小时降到 1.5 小时，上限从 72 小时降到 8 小时；
--   2) 明确回忆（她就是在问过去的事）在应用层无视冷却（见 recall/index.ts）。
-- ============================================================================

create or replace function reinforce_memory(
  p_id               uuid,
  p_used             boolean default true,
  p_base_cooldown_h  numeric default 1.5
) returns void language sql as $$
  update memory_items
     set recall_count     = recall_count + 1,
         exposure_count   = exposure_count + 1,
         last_recalled_at = now(),
         decay_score      = 1.0,
         cooldown_until   = case
                              when p_used then now() + make_interval(
                                secs => least(8 * 3600, p_base_cooldown_h * 3600 * (1 + exposure_count))
                              )
                              else cooldown_until
                            end,
         updated_at       = now()
   where id = p_id;
$$;

-- 把已经积压的长冷却压回来（旧参数留下的最长 72 小时）
update memory_items
   set cooldown_until = now() + interval '1 hour'
 where cooldown_until > now() + interval '8 hours';

insert into schema_migrations (version) values ('0006_cooldown_is_not_amnesia')
on conflict (version) do nothing;
