# migrations

OpenCNS v2 的数据库迁移。**只增不改**：已应用的迁移文件禁止编辑，改结构请新增 `000N_xxx.sql`。**禁止手工改线上表结构。**

执行器：`server/src/db/migrate.ts`（`npm run migrate`）
- 按文件名排序执行，文件名即版本号
- **已应用的文件如果内容变了会直接报错**（校验和不匹配）——这是防止"悄悄改历史"的闸门
- 执行期间持 advisory lock；每个文件单独事务，失败整体回滚

**启动迁移前，先用 `docker compose up -d postgres` 起库**（`docker-compose.yml` 已带好 4GB 机器该有的内存参数）。

---

## M1 验收（在服务器上执行）

```bash
# 0) 准备：仓库根目录建 .env，只要一行
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" > .env

# 1) 起库（只绑 127.0.0.1，不对外暴露）
docker compose up -d postgres
docker compose ps

# 2) 跑迁移（ON_ERROR_STOP：任何一句失败立刻停）
docker compose exec -T postgres psql -U opencns -d opencns -v ON_ERROR_STOP=1 \
  < migrations/0001_init.sql

# 3) 自检
docker compose exec -T postgres psql -U opencns -d opencns -c "\dt"
docker compose exec -T postgres psql -U opencns -d opencns -c "select count(*) as drives from drive_state;"   # 期望 12
docker compose exec -T postgres psql -U opencns -d opencns -c "select * from schema_migrations;"              # 期望 0001_init

# 4) 验收重点：三条硬约束必须被数据库拦下（这三条都应该报错）
docker compose exec -T postgres psql -U opencns -d opencns -c \
  "insert into memory_items (kind, content) values ('episode', repeat('字', 100));"
docker compose exec -T postgres psql -U opencns -d opencns -c \
  "insert into memory_items (kind, content, quotes) values ('episode', repeat('字', 100), '[{\"who\":\"她\",\"said\":\"你好\"}]'::jsonb);"
docker compose exec -T postgres psql -U opencns -d opencns -c \
  "insert into memory_items (kind, content, quotes) values ('episode', '太短', '[{\"who\":\"她\",\"said\":\"你好\"}]'::jsonb);"
```

第 4 步是最重要的验收点：**「必须有直接引语 / 因果四环齐全 / 不低于字数底线」这三条，现在是数据库自己在拦**，不依赖任何一处代码写对。

预期报错依次为：`episode_requires_quote`、`episode_requires_causal`、`episode_min_length`。

> 这一步只新建一个容器和一个新库，**不碰 Supabase、不碰正在跑的服务**。清理：`docker compose down`（数据在 `./data/pgdata`，加 `-v` 不要随意用）。

---

## 备份

```bash
# 每日 03:00（crontab -e），保留 14 天
mkdir -p data/backups
docker compose exec -T postgres pg_dump -U opencns -d opencns -Fc \
  > data/backups/opencns-$(date +\%F).dump
find data/backups -name 'opencns-*.dump' -mtime +14 -delete
```

本地电脑拉取留档：`scripts/pull-backup.ps1`（M2 交付，含 sha256 校验）。

---

## 迁移旧数据的顺序（M1 第二阶段）

1. 先在 Supabase 侧导出：`memories`（804 条）、`bond_memories`、`open_loops`、`reflections`、`conversation_summaries`、`recent_chat`。
2. 用 `server/scripts/migrate-legacy.ts`（待写）把它们映射进 v2：
   - `memories` → `memory_items`（`importance / memory_type / valence / arousal / unresolved / keywords` 从**列**与 **metadata** 两处取值，列优先）
   - `bond_memories` → `foundational_events` + `memory_items(pinned)`
   - `open_loops` → `notes`（`kind='todo'`）与"记挂"维的初始信号
   - `reflections` → `memory_items(kind='reflection')`
   - `conversation_summaries / recent_chat` → `sessions` / `messages`
3. 单一 `legacy_id` 列做幂等键（已在 0001 里建好唯一索引），迁移脚本可安全重跑。
4. **向量全部重算**（换 bge-m3 后旧向量不可比）：迁移时先留空，再跑一次 backfill。
