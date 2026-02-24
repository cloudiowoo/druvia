---
name: doc-creation-guide
description: This skill should be used when the user asks about "创建文档", "写文档", "文档规范", "文档模板", "docs目录", "文档编号", "技术文档", or mentions creating new documentation files in the docs/ directory.
---

# 文档创建规范

## 文件位置与命名

**位置**: `docs/` 目录
**格式**: `docs/[number]-[title].md`

**示例**:
- `docs/001-architecture.md`
- `docs/002-database-schema.md`
- `docs/003-api-reference.md`

**编号规则**:
- 3 位数字 (001-999)
- 顺序编号，无间隔
- 创建前检查现有文档

**特殊目录**:
- `docs/plans/` - 设计文档，按日期命名 (`2026-02-24-feature-name.md`)
- `docs/adr/` - 架构决策记录 (`001-choose-hasura.md`)

---

## 文档结构模板

```markdown
# [标题]

## 背景 (Background)
为什么需要这个文档，解决什么问题。

## 目标 (Objectives)
文档要达成的目标。

## 方案设计 (Design)
架构、方法、关键决策。

### 系统架构
图表和组件描述。

### 技术栈
使用的技术和框架。

## 实施细节 (Implementation)
分步骤的实施详情。

### Phase 1: [名称]
详细步骤和代码示例。

## 测试验证 (Testing)
如何验证实施有效。

## 参考资料 (References)
相关文档和链接。
```

---

## 文档类型

| 类型 | 内容 |
|------|------|
| 架构设计 | 系统架构、组件设计、技术决策 |
| 功能说明 | 功能描述、用户场景、API 规范 |
| 实施总结 | 实施过程、挑战与解决方案、结果 |
| API 文档 | 端点规范、请求/响应格式、错误码 |
| 测试指南 | 测试流程、测试用例、验证清单 |

---

## 项目背景模板

```markdown
**项目背景**:
这是 Druvia，一个自托管 BaaS 平台，主要特点：
- 类 Supabase 架构，Schema-per-Tenant 多租户隔离
- 技术栈：Node.js 22 + Fastify 5 + TypeScript
- 数据库：PostgreSQL 17 + Hasura CE 2.40
- 缓存：Redis 7
- 存储：Cloudflare R2 / Local
- 认证：微信/钉钉/飞书/OIDC 适配器
```

---

## 质量要求

**必须包含**:
- ✅ 清晰的章节结构
- ✅ 带语法高亮的代码示例
- ✅ 具体实施细节
- ✅ 项目真实用例
- ✅ 正确的 Markdown 格式

**避免**:
- ❌ 过于通用，不针对项目
- ❌ 缺少代码示例
- ❌ 结构不清晰
- ❌ 过短 (<200 行) 或过长 (>2000 行)
- ❌ 缺少背景或目标
- ❌ 没有测试章节

---

## 更新流程

1. ✅ 创建文件 `docs/[number]-[title].md`
2. ✅ 验证 Markdown 语法
3. ✅ 提交: `docs: add [title]`

---

## 审查清单

- [ ] 文档编号唯一且顺序
- [ ] 标题符合命名规范
- [ ] 所有必需章节存在
- [ ] 代码示例正确且已测试
- [ ] 无占位文本 (TODO, TBD)
- [ ] 引用和链接有效
- [ ] Markdown 语法正确
- [ ] 长度合理 (500-1500 行)
