# Claude Code Configuration

Druvia BaaS 平台的 Claude Code 配置目录。

---

## 渐进式披露架构

基于 Claude Code 官方标准实现三级加载：

```
Level 1: 元数据（始终加载）
  └─ Skill name + description (~100 词/skill)

Level 2: CLAUDE.md（始终加载）
  └─ 核心约束 + 操作默认值 (~120 行)

Level 3: SKILL.md 主体（触发时加载）
  └─ 详细指南 (~100-200 行/skill)
```

---

## 目录结构

```
druvia/
├── CLAUDE.md              # 核心约束 + 操作默认值 ⭐ (项目根目录)
│
└── .claude/
    ├── skills/            # 领域知识（按需加载）
    │   ├── docker-guide/      # Docker 环境
    │   ├── api-guide/         # API 开发模式
    │   ├── database-guide/    # 数据库设计
    │   ├── adapters-guide/    # 适配器开发
    │   ├── hasura-guide/      # Hasura 配置
    │   ├── doc-creation-guide/    # 文档创建规范
    │   └── documentation-guide/   # 文档研究指南
    │
    ├── commands/          # 斜杠命令（用户调用）
    │   └── commit.md
    │
    ├── memory/            # 项目记忆
    │   └── design-decisions.md
    │
    ├── settings.json
    └── README.md          # 本文件
```

---

## Skill 触发机制

| Skill | 触发词 | 内容 |
|-------|--------|------|
| **docker-guide** | docker, 容器, compose, postgres, redis | Docker 环境配置 |
| **api-guide** | API, 响应格式, 限流, Fastify, 路由 | API 开发模式 |
| **database-guide** | Schema, 租户表, 迁移, druvia_tenants | 数据库设计 |
| **adapters-guide** | Storage, Auth, R2, 微信, 钉钉, OIDC | 适配器开发 |
| **hasura-guide** | GraphQL, Subscriptions, Actions, 权限 | Hasura 配置 |
| **doc-creation-guide** | 创建文档, 写文档, 文档规范, docs目录 | 文档创建规范 |
| **documentation-guide** | Context7, 官方文档, resolve-library-id | 文档研究指南 |

**触发示例**：
- "docker-compose 怎么配置" → 加载 docker-guide
- "Storage 适配器怎么写" → 加载 adapters-guide
- "Hasura 权限怎么设置" → 加载 hasura-guide
- "创建一个技术文档" → 加载 doc-creation-guide
- "查一下 Fastify 官方文档" → 加载 documentation-guide

---

## Skill 文件结构

每个 skill 遵循官方标准：

```
skill-name/
└── SKILL.md              # 主文件（YAML frontmatter + 内容）
```

**SKILL.md frontmatter 格式**：

```yaml
---
name: Skill Name
description: This skill should be used when the user asks to "specific phrase 1", "specific phrase 2".
---
```

---

## 设计文档位置

详细设计文档位于 `docs/plans/`：

| 文档 | 内容 |
|------|------|
| `2026-02-24-druvia-design.md` | 主设计文档 |
| `2026-02-24-druvia-adapters.md` | Adapters 层设计 |
| `2026-02-24-druvia-database.md` | 数据库设计 |
| `2026-02-24-druvia-api.md` | API 设计 |
| `2026-02-24-druvia-structure.md` | 项目结构与部署 |
| `2026-02-24-druvia-phase1-plan.md` | Phase 1 实施计划 |

---

**Last Updated**: 2026-02-24
**Architecture**: 三级渐进式披露（元数据 → CLAUDE.md → Skills）
