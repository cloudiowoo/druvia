# Codex 项目记忆管理体系设计

## 背景

Druvia 现有仓库已经保留 `CLAUDE.md` 与 `.claude/memory/*`，能够服务 Claude 系工作流，但缺少一套面向 Codex 的项目级上下文组织方式。随着 taro-app / Supabase 迁移、Functions 权限模型、安全规则持续演进，仅依赖单一根文档已不足以支撑新会话快速恢复上下文。

因此需要在不破坏现有 `.claude` 体系的前提下，为 Codex 补齐独立、可扩展、可按目录收敛的项目记忆结构。

## 目标

- 保留现有 `.claude` 体系，不做迁移或删除
- 以根 `AGENTS.md` 作为 Codex 总入口
- 为 Codex 增加项目记忆、长期决策、操作手册三类共享文档
- 为核心子模块增加局部 `AGENTS.md`
- 增加项目内 rules / skills 目录，沉淀高频约束与工作流

## 非目标

- 不尝试让 `.codex/skills` 替代全局技能系统
- 不重写现有全部历史文档
- 不把所有设计文档重新归档
- 不删除或覆盖 `.claude/*`

## 设计原则

### 1. 双体系并存，职责分离

- `.claude/*` 保持现状，兼容既有使用方式
- Codex 新体系以 `AGENTS.md + docs/agent/*` 为主
- 共享事实允许同时存在于两侧，但 Codex 的新沉淀优先写入 `docs/agent/*`

### 2. 入口尽量少，细节按目录收窄

- 根 `AGENTS.md` 只保留稳定事实、优先级规则、文档索引
- 模块特有信息下沉到：
  - `apps/api/AGENTS.md`
  - `apps/admin/AGENTS.md`
  - `packages/sdk/AGENTS.md`

### 3. 区分“项目事实”和“执行工作流”

- `docs/agent/*` 存项目事实
- `.codex/rules/*` 存项目约束
- `.codex/skills/*` 存可复用工作流
- `docs/plans/*` 继续存完整方案与实施记录

## 目录设计

### 根入口

- `AGENTS.md`
  - 项目概况
  - 高优先级规则
  - 新体系文档索引

### 共享记忆

- `docs/agent/project-memory.md`
  - 最近高价值事实
  - 迁移兼容约束
  - 易错点与前置条件
- `docs/agent/design-decisions.md`
  - 长期有效的权限、产品、架构决策摘要
- `docs/agent/playbooks.md`
  - 常用操作手册、验证命令、故障排查入口

### 模块入口

- `apps/api/AGENTS.md`
- `apps/admin/AGENTS.md`
- `packages/sdk/AGENTS.md`

这些文件只描述本子树工作的特殊约束，避免根文档膨胀。

### 规则

- `.codex/rules/project.rules.md`
  - 项目通用开发约束
- `.codex/rules/docs.rules.md`
  - 文档命名、何时更新记忆、文档归档规范

### 技能

- `.codex/skills/druvia-doc-update/SKILL.md`
  - 功能改动后同步更新记忆与设计文档
- `.codex/skills/taro-migration-memory/SKILL.md`
  - 涉及 Supabase / taro-app 兼容时的检查流程

## 首批应沉淀的事实

本次需要先写入 Codex 项目记忆的高优先级内容包括：

- 当前产品叙事默认按“单租户 + 多项目”
- `apikey` 匿名访问已支持，但 Functions invoke 采用函数级 `invoke_auth_mode`
- `invoke_auth_mode` 默认 `jwt_required`
- 仅登录前函数如 `wx-login-register`、`wx-silent-login` 才应考虑 `anon_allowed`
- Admin 保存 `invokeAuthMode` 前，数据库必须已执行 `015_function_invoke_auth_mode`

## 结论

采用“根入口 + 共享记忆 + 模块入口 + rules + skills”的平衡方案。它能够在不干扰 `.claude` 的前提下，为 Codex 提供一套更清晰、可持续维护的项目上下文组织方式。
