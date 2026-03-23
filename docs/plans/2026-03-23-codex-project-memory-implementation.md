# Codex 项目记忆管理体系实施计划

## 范围

本次实施只创建 Codex 结构与首批内容，不整理全部历史文档。

## 任务

### 1. 根入口增强

- 更新 `AGENTS.md`
- 明确双体系并存：
  - `.claude/*`
  - Codex 的 `AGENTS.md` / `docs/agent/*` / `.codex/*`
- 增加新文档索引与项目记忆更新规则

### 2. 建立共享记忆目录

创建：

- `docs/agent/project-memory.md`
- `docs/agent/design-decisions.md`
- `docs/agent/playbooks.md`

写入当前最关键的权限、安全、迁移、验证信息。

### 3. 建立模块级 AGENTS

创建：

- `apps/api/AGENTS.md`
- `apps/admin/AGENTS.md`
- `packages/sdk/AGENTS.md`

分别沉淀模块边界、优先级、测试入口、近期风险。

### 4. 建立项目 rules

创建：

- `.codex/rules/project.rules.md`
- `.codex/rules/docs.rules.md`

用于承载不会频繁变化、但值得在开发时反复遵循的项目规则。

### 5. 建立项目 skills

创建：

- `.codex/skills/druvia-doc-update/SKILL.md`
- `.codex/skills/taro-migration-memory/SKILL.md`

保持技能内容简洁，聚焦高频工作流。

### 6. 首批项目记忆回填

把以下近期学习结果写入新体系：

- taro-app / Supabase 迁移是高优先级牵引场景
- Functions invoke 不再允许“同项目 anon key 调任意函数”
- 上传类函数不能默认开放匿名调用
- `invoke_auth_mode` 管理依赖数据库迁移

## 验证

- 检查新增文件是否都可在仓库内直接打开
- 检查根 `AGENTS.md` 是否能索引到新文档
- 检查模块目录下是否存在对应 `AGENTS.md`
- 检查 `.codex/skills/*/SKILL.md` 与 `.codex/rules/*` 结构完整

## 后续维护规则

- 重要功能改动后，先更新代码，再同步 `docs/agent/project-memory.md`
- 如果是长期架构/权限决策，再同步 `docs/agent/design-decisions.md`
- 如果仅与某个子模块有关，优先更新对应子目录 `AGENTS.md`
- 如需形成可复用流程，再补充 `.codex/skills/*`
