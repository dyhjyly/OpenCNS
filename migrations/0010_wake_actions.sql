-- ============================================================================
-- OpenCNS v2 — 0010_wake_actions
-- ============================================================================
-- 醒来不再"只能做一件事"。
--
-- 原本是六选一（发消息 / 做自己的事 / 回去睡 / 安静待着 / 翻便签 / 藏惊喜）。
-- 但人醒过来常常连着做几件小事：先看看留言，回一句，再发一条，顺手拍拍她。
-- 所以改成**动作列表**，有上限（最多 4 件），避免一口气干太多。
--
-- decision 列继续保留，存"最主要的那一件"，方便列表和统计；
-- actions 存这一轮实际做了哪几件。
-- ============================================================================

alter table wake_log add column if not exists actions jsonb not null default '[]'::jsonb;

-- 放宽 decision 的取值：加 social（只做了社交动作）与 mixed（多件事凑不出主次）
alter table wake_log drop constraint if exists wake_log_decision_check;
alter table wake_log add constraint wake_log_decision_check
  check (
    decision is null
    or decision in ('reach_out', 'own_work', 'rest', 'stay_quiet', 'read_notes', 'hide_surprise', 'social', 'mixed')
  );

insert into schema_migrations (version) values ('0010_wake_actions')
on conflict (version) do nothing;
