# Next.js 16 + Turbopack 升级设计

## 概述

将 Druvia Admin 从 Next.js 14.2 升级到 Next.js 16，采用 Turbopack 作为默认构建工具，同时升级 React 到 19.2。

## 目标

- 修复早期版本的安全漏洞
- 采用 Turbopack 提升构建性能
- 为后续 Docker 化部署做准备

## 依赖版本变更

| 包 | 当前 | Phase 1 (→15) | Phase 2 (→16) |
|---|------|---------------|---------------|
| next | 14.2.x | 15.x | 16.x |
| react | 18.3.x | 19.x | 19.2.x |
| react-dom | 18.3.x | 19.x | 19.2.x |
| @types/react | 18.3.x | 19.x | 19.x |
| @types/react-dom | 18.3.x | 19.x | 19.x |

### 移除的依赖

| 包 | 原因 |
|---|------|
| graphiql | 替换为 CodeMirror 方案 |
| @graphiql/react | 同上 |
| null-loader | webpack 专用，Turbopack 不需要 |

### 新增的依赖

| 包 | 用途 |
|---|------|
| cm6-graphql | CodeMirror 6 GraphQL 语法支持 |
| eslint | 独立 ESLint CLI |

## 配置变更

### next.config.js

从 webpack 配置迁移到 Turbopack：

```javascript
// 目标配置
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  turbopack: {
    resolveAlias: {
      // 按需配置
    },
  },
};
```

### ESLint

从 `next lint` 迁移到独立 ESLint CLI：

```javascript
// eslint.config.js (Flat Config)
import nextPlugin from '@next/eslint-plugin-next';

export default [
  {
    plugins: { '@next/next': nextPlugin },
    rules: { ...nextPlugin.configs.recommended.rules },
  },
];
```

## GraphQL Playground 替换

### 原方案
- GraphiQL + Monaco Editor
- 需要 webpack worker 配置
- 与 Turbopack 不兼容

### 新方案
- CodeMirror + cm6-graphql
- 复用现有 @uiw/react-codemirror
- 保留 @graphiql/toolkit 的 fetcher

### 功能对比

| 功能 | GraphiQL | 新方案 |
|------|----------|--------|
| 语法高亮 | ✅ | ✅ |
| 自动补全 | ✅ | ✅ |
| 执行查询 | ✅ | ✅ |
| 历史记录 | ✅ | ❌ |
| 文档浏览 | ✅ | ❌ |

## 实施阶段

### Phase 1: Next.js 14 → 15

1. 运行 `pnpm dlx @next/codemod@canary upgrade 15`
2. 更新 React 到 19.x
3. 修复 breaking changes
4. 验证功能

**验收标准：**
- `pnpm dev` 正常启动
- 所有页面可访问

### Phase 2: Next.js 15 → 16

1. 运行 `pnpm dlx @next/codemod@canary upgrade latest`
2. 迁移 next.config.js 到 Turbopack
3. 替换 GraphiQL 为 CodeMirror 方案
4. 迁移 ESLint 配置
5. 清理废弃依赖

**验收标准：**
- `pnpm dev` 使用 Turbopack 正常启动
- `pnpm build` 成功
- GraphQL Playground 功能正常
- `pnpm lint` 正常工作

## 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| 第三方库不兼容 React 19 | 检查 @radix-ui, zustand 等兼容性 |
| Turbopack 构建失败 | 可用 `--webpack` flag 回退 |
| cm6-graphql 功能不足 | 可考虑其他替代方案 |

## 分支策略

```
main
  └── feature/nextjs-upgrade
        ├── Phase 1 commits (14→15)
        └── Phase 2 commits (15→16)
```

---

*Created: 2026-03-10*
