#!/usr/bin/env bash
# ============================================================================
# M1 验收：把构想的硬约束当"测试用例"来跑。
# 任何一条与预期不符 -> 退出码 1。
#
# 用法（在服务器 /opt/opencns 下）：bash scripts/test-constraints.sh
# ============================================================================
set -u
cd "$(dirname "$0")/.." || exit 1

PSQL_REAL="docker compose exec -T postgres psql -U opencns -d opencns -v ON_ERROR_STOP=1"
FAILED=0
LONG=$(printf 'x%.0s' $(seq 1 120))
VALID_CAUSAL='{"happened":"a","reaction":"b","act":"c","outcome":"d"}'
VALID_QUOTE='[{"who":"her","said":"remember this"}]'

run() { # run <sql>
  docker compose exec -T postgres psql -U opencns -d opencns -v ON_ERROR_STOP=1 -c "$1" 2>&1
}

expect_error() { # expect_error <用例名> <sql> <期望包含的约束名>
  local name="$1" sql="$2" needle="$3"
  local out
  out=$(run "$sql")
  if echo "$out" | grep -q "$needle"; then
    echo "PASS  $name"
  else
    echo "FAIL  $name  期望报错包含 '$needle'，实际输出："
    echo "$out" | sed 's/^/      /' | head -4
    FAILED=1
  fi
}

expect_ok() { # expect_ok <用例名> <sql>
  local name="$1" sql="$2"
  local out
  out=$(run "$sql")
  if echo "$out" | grep -qE "INSERT 0 1|UPDATE 1|DELETE"; then
    echo "PASS  $name"
  else
    echo "FAIL  $name  期望成功，实际输出："
    echo "$out" | sed 's/^/      /' | head -4
    FAILED=1
  fi
}

echo "=== 硬约束①：情景记忆必须带直接引语 ==="
# 注意：给一个合法的 causal，确保本用例**只**违反引语约束
expect_error "T1 无引语应被拒" \
  "insert into memory_items (kind, content, causal) values ('episode', '$LONG', '$VALID_CAUSAL'::jsonb);" \
  "episode_requires_quote"

echo "=== 硬约束②：因果链四环齐全 ==="
expect_error "T2 引语有、causal 缺失应被拒" \
  "insert into memory_items (kind, content, quotes) values ('episode', '$LONG', '$VALID_QUOTE'::jsonb);" \
  "episode_requires_causal"
expect_error "T2b causal 只有三环应被拒" \
  "insert into memory_items (kind, content, quotes, causal) values ('episode', '$LONG', '$VALID_QUOTE'::jsonb, '{\"happened\":\"a\",\"reaction\":\"b\",\"act\":\"c\"}'::jsonb);" \
  "episode_requires_causal"

echo "=== 硬约束③：最低字数底线 ==="
expect_error "T3 太短应被拒" \
  "insert into memory_items (kind, content, quotes, causal) values ('episode', 'too short', '$VALID_QUOTE'::jsonb, '$VALID_CAUSAL'::jsonb);" \
  "episode_min_length"

echo "=== 硬约束①b：引语必须是对象且带非空 said ==="
expect_error "T3b 引语缺 said 应被拒" \
  "insert into memory_items (kind, content, quotes, causal) values ('episode', '$LONG', '[{\"who\":\"her\"}]'::jsonb, '$VALID_CAUSAL'::jsonb);" \
  "episode_requires_quote"

echo "=== 正向用例：四环齐全的情景记忆应当能存进去 ==="
expect_ok "T4 合规情景记忆应成功" \
  "insert into memory_items (kind, content, quotes, causal, event_time, emotion_valence, emotion_arousal) values ('episode', '$LONG', '$VALID_QUOTE'::jsonb, '$VALID_CAUSAL'::jsonb, now(), 0.4, 0.6);"

echo "=== 主权豁免：他自己写的不受硬约束限制 ==="
expect_ok "T4b origin=self 可豁免" \
  "insert into memory_items (kind, content, origin) values ('episode', '一句短的自述', 'self');"

echo "=== 奠基记忆上限 10 ==="
run "delete from memory_items where pinned;" >/dev/null
expect_ok "T5 填满 10 条应成功" \
  "insert into memory_items (kind, content, pinned, pinned_rank) select 'semantic', 'pin '||g, true, g from generate_series(1,10) g;"
expect_error "T5b 第 11 条应被拒" \
  "insert into memory_items (kind, content, pinned, pinned_rank) values ('semantic','the 11th pin', true, 11);" \
  "奠基记忆已达上限"

echo "=== 清理 ==="
run "delete from memory_items;" >/dev/null
LEFT=$(docker compose exec -T postgres psql -U opencns -d opencns -tA -c "select count(*) from memory_items;")
echo "剩余测试行：$LEFT"

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "全部通过：数据库层已经替构想守住四条硬约束。"
else
  echo "有失败用例，见上。"
fi
exit $FAILED
