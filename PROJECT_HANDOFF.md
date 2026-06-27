OpenCNS Project Handoff

Project

OpenCNS（Open Cognitive Nervous System）

目标：

打造一个能够持续成长、形成自我认知的大脑系统。

不是聊天机器人。

不是 Agent。

而是所有 LLM 都可以接入的 CNS。

---

当前版本

v0.1.0

---

已完成

Infrastructure

✅ MCP Server

✅ Supabase

✅ pgvector

✅ Ollama Embedding

✅ Local Embedding

✅ Vector Search

✅ Similarity Ranking

✅ Embedding Backfill

---

Analyzer

已完成模块化。

目录：

src/analyzer/

- prompt.ts
- provider.ts
- parser.ts
- types.ts
- index.ts

旧版 analyzer.ts 已改为 Compatibility Layer。

Parser 已支持 Markdown JSON 容错。

Analyzer 已测试通过。

---

当前工程规范

所有模块采用统一五层结构：

- Types
- Provider
- Parser
- Index
- Compatibility Layer

任何模块都不能写成单文件。

---

下一步（必须按顺序）

Session 4：

Memory Module

拆分：

memory/

- save.ts
- search.ts
- read.ts
- delete.ts
- types.ts
- index.ts

目标：

保持 MCP 完全兼容。

完成后：

编译

PM2

Save

Search

全部测试通过。

---

固定骨架（不要修改）

OpenCNS

Memory

Episode

Dream

Forget

Curiosity

Identity

Graph

Reflex

所有新功能必须挂载到上述模块。

不得新增平行系统。

---

开发原则

每次只完成一个 Milestone。

没有测试通过：

绝不进入下一阶段。

每个 Milestone：

必须

编译成功

运行成功

MCP 成功

测试成功

再提交 Git。

---

OpenCNS 核心理念

所有高级认知，都必须能够回溯到具体经历。

所有经历，都有机会成长为高级认知。

允许 AI 像生命一样成长。
