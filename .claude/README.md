# Claude Code Configuration

Druvia 项目的 Claude Code 配置目录。

---

## 渐进式披露架构

```
Level 1: 元数据（始终加载）
  └─ Skill name + description

Level 2: CLAUDE.md（始终加载）
  └─ ~100 行核心约束

Level 3: SKILL.md（触发时加载）
  └─ 详细指南
```

---

## 目录结构

```
.claude/
├── skills/           # 领域知识（按需加载）
│   ├── docker-guide/
│   ├── api-guide/
│   ├── database-guide/
│   ├── adapters-guide/
│   ├── hasura-guide/
│   ├── testing-guide/
│   ├── doc-creation-guide/
│   └── documentation-guide/
├── commands/         # 斜杠命令
├── memory/           # 项目记忆
└── settings.json
```

---

## Skill 触发词

| Skill | 触发词 |
|-------|--------|
| docker-guide | docker, 容器, compose |
| api-guide | API, Fastify, 限流 |
| database-guide | Schema, 迁移, JSONB |
| adapters-guide | Storage, Auth, R2, 微信 |
| hasura-guide | GraphQL, Subscriptions |
| testing-guide | 测试, vitest, TDD |
| doc-creation-guide | 创建文档, 写文档 |
| documentation-guide | Context7, 官方文档 |

---

*Last Updated: 2026-03-04*
