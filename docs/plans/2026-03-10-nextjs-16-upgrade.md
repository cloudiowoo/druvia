# Next.js 16 + Turbopack 升级实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 Druvia Admin 从 Next.js 14.2 升级到 Next.js 16 + Turbopack，同时升级 React 到 19.2

**Architecture:** 分两阶段升级（14→15→16），使用官方 codemod 自动迁移，手动替换 GraphiQL 为 CodeMirror 方案

**Tech Stack:** Next.js 16, React 19.2, Turbopack, CodeMirror 6, cm6-graphql

---

## Phase 1: Next.js 14 → 15

### Task 1: 创建升级分支

**Files:**
- None (git operation)

**Step 1: 创建并切换到升级分支**

```bash
git checkout -b feature/nextjs-upgrade
```

**Step 2: 确认分支创建成功**

Run: `git branch --show-current`
Expected: `feature/nextjs-upgrade`

---

### Task 2: 运行 Next.js 15 升级 codemod

**Files:**
- Modify: `apps/admin/package.json`
- Modify: `apps/admin/next.config.js` (可能)

**Step 1: 进入 admin 目录并运行 codemod**

```bash
cd apps/admin && pnpm dlx @next/codemod@canary upgrade 15
```

Expected: codemod 自动更新 package.json 中的 next 版本

**Step 2: 查看变更**

Run: `git diff apps/admin/package.json`
Expected: next 版本更新到 15.x

---

### Task 3: 更新 React 到 19.x

**Files:**
- Modify: `apps/admin/package.json`

**Step 1: 更新 React 相关依赖**

```bash
cd apps/admin && pnpm add react@^19 react-dom@^19
```

**Step 2: 更新类型定义**

```bash
cd apps/admin && pnpm add -D @types/react@^19 @types/react-dom@^19
```

**Step 3: 验证 package.json**

Run: `cat apps/admin/package.json | grep -E '"react|"@types/react'`
Expected: 版本号为 19.x

---

### Task 4: 安装依赖并验证构建

**Files:**
- None

**Step 1: 重新安装依赖**

```bash
pnpm install
```

**Step 2: 构建 shared 包**

```bash
pnpm --filter @druvia/shared build
```

**Step 3: 尝试构建 admin**

```bash
pnpm --filter @druvia/admin build
```

Expected: 构建成功或显示需要修复的错误

---

### Task 5: 修复 React 19 兼容性问题（如有）

**Files:**
- Modify: 根据错误信息确定

**Step 1: 检查构建错误**

如果 Task 4 构建失败，根据错误信息修复。常见问题：
- `ref` 作为 prop 的变更
- `useFormStatus` 等 hook 变更

**Step 2: 重新构建验证**

```bash
pnpm --filter @druvia/admin build
```

Expected: 构建成功

---

### Task 6: 暂存 Phase 1 变更

**Files:**
- All modified files

**Step 1: 查看所有变更**

```bash
git status
```

**Step 2: 暂存变更（用户手动提交）**

```bash
git add -A
```

用户手动执行提交：
```bash
git commit -m "feat: upgrade to Next.js 15 + React 19

- Update next to 15.x
- Update react and react-dom to 19.x
- Update @types/react and @types/react-dom to 19.x"
```

---

## Phase 2: Next.js 15 → 16 + Turbopack

### Task 7: 运行 Next.js 16 升级 codemod

**Files:**
- Modify: `apps/admin/package.json`
- Modify: `apps/admin/next.config.js`

**Step 1: 运行 codemod**

```bash
cd apps/admin && pnpm dlx @next/codemod@canary upgrade latest
```

**Step 2: 查看 next.config.js 变更**

Run: `cat apps/admin/next.config.js`
Expected: 可能已自动迁移部分配置

---

### Task 8: 迁移 next.config.js 到 Turbopack

**Files:**
- Modify: `apps/admin/next.config.js`

**Step 1: 更新配置文件**

将 `apps/admin/next.config.js` 替换为：

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',

  // Turbopack 配置
  turbopack: {
    resolveAlias: {
      // 如果有 Node.js 模块在浏览器端被引用，在此配置
    },
  },

  // 保留 onDemandEntries 配置
  onDemandEntries: {
    maxInactiveAge: 60 * 1000,
    pagesBufferLength: 5,
  },
};

module.exports = nextConfig;
```

**Step 2: 验证配置语法**

```bash
node -e "require('./apps/admin/next.config.js')"
```

Expected: 无错误输出

---

### Task 9: 安装 cm6-graphql 依赖

**Files:**
- Modify: `apps/admin/package.json`

**Step 1: 安装 GraphQL CodeMirror 扩展**

```bash
cd apps/admin && pnpm add cm6-graphql
```

**Step 2: 验证安装**

Run: `cat apps/admin/package.json | grep cm6-graphql`
Expected: 显示 cm6-graphql 版本

---

### Task 10: 创建新的 GraphQL Playground 组件

**Files:**
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/api/components/GraphQLEditor.tsx`

**Step 1: 创建新组件**

```typescript
'use client';

import { useState, useCallback, useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { graphql } from 'cm6-graphql';
import { json } from '@codemirror/lang-json';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { createGraphiQLFetcher } from '@graphiql/toolkit';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Play, Loader2 } from 'lucide-react';

interface GraphQLEditorProps {
  projectId: string;
}

export function GraphQLEditor({ projectId }: GraphQLEditorProps) {
  const [query, setQuery] = useState(`query {

}`);
  const [variables, setVariables] = useState('{}');
  const [result, setResult] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetcher = useMemo(() => createGraphiQLFetcher({
    url: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/v1/projects/${projectId}/graphql`,
    headers: {
      'Authorization': `Bearer ${api.getToken()}`,
    },
  }), [projectId]);

  const executeQuery = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let vars = {};
      try {
        vars = JSON.parse(variables);
      } catch {
        // 忽略变量解析错误
      }

      const response = await fetcher({
        query,
        variables: vars,
      });

      // Handle async iterator (subscriptions) or direct result
      if (Symbol.asyncIterator in response) {
        const iterator = response[Symbol.asyncIterator]();
        const { value } = await iterator.next();
        setResult(JSON.stringify(value, null, 2));
      } else {
        setResult(JSON.stringify(response, null, 2));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Query failed');
      setResult('');
    } finally {
      setLoading(false);
    }
  }, [query, variables, fetcher]);

  // 快捷键
  const customKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              executeQuery();
              return true;
            },
            preventDefault: true,
          },
        ])
      ),
    [executeQuery]
  );

  const queryExtensions = useMemo(() => [
    graphql(),
    customKeymap,
  ], [customKeymap]);

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <span className="text-sm font-medium">GraphQL Playground</span>
        <Button
          size="sm"
          onClick={executeQuery}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Play className="h-4 w-4 mr-1" />
          )}
          执行
        </Button>
      </div>

      {/* 编辑器区域 */}
      <div className="flex-1 flex">
        {/* 左侧：查询和变量 */}
        <div className="w-1/2 flex flex-col border-r">
          {/* 查询编辑器 */}
          <div className="flex-1 overflow-hidden">
            <div className="px-3 py-1.5 text-xs text-muted-foreground border-b bg-muted/20">
              Query
            </div>
            <CodeMirror
              value={query}
              onChange={setQuery}
              extensions={queryExtensions}
              height="100%"
              className="h-full"
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
              }}
              theme="light"
            />
          </div>

          {/* 变量编辑器 */}
          <div className="h-32 border-t">
            <div className="px-3 py-1.5 text-xs text-muted-foreground border-b bg-muted/20">
              Variables (JSON)
            </div>
            <CodeMirror
              value={variables}
              onChange={setVariables}
              extensions={[json()]}
              height="calc(100% - 28px)"
              basicSetup={{
                lineNumbers: true,
                bracketMatching: true,
                closeBrackets: true,
              }}
              theme="light"
            />
          </div>
        </div>

        {/* 右侧：结果 */}
        <div className="w-1/2 flex flex-col">
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-b bg-muted/20">
            Response
          </div>
          {error ? (
            <div className="flex-1 p-4 text-red-500 text-sm">
              {error}
            </div>
          ) : (
            <CodeMirror
              value={result}
              extensions={[json()]}
              height="100%"
              className="h-full"
              readOnly
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
              }}
              theme="light"
            />
          )}
        </div>
      </div>

      {/* 底部提示 */}
      <div className="px-3 py-1.5 text-xs text-muted-foreground border-t bg-muted/20 flex justify-end">
        <span>
          <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">⌘</kbd>
          <span className="mx-0.5">+</span>
          <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">Enter</kbd>
          <span className="ml-1">执行查询</span>
        </span>
      </div>
    </div>
  );
}
```

---

### Task 11: 更新 GraphQL Playground 页面引用

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/api/components/GraphQLPlayground.tsx`

**Step 1: 替换组件内容**

将 `GraphQLPlayground.tsx` 替换为兼容包装：

```typescript
'use client';

import { GraphQLEditor } from './GraphQLEditor';

interface GraphQLPlaygroundProps {
  hasuraUrl: string;  // 保留接口兼容，但不再使用
  projectId: string;
}

// 包装组件，保持向后兼容
export function GraphQLPlayground({ projectId }: GraphQLPlaygroundProps) {
  return <GraphQLEditor projectId={projectId} />;
}
```

---

### Task 12: 删除 MonacoSetup 组件

**Files:**
- Delete: `apps/admin/src/components/MonacoSetup.tsx`

**Step 1: 删除文件**

```bash
rm apps/admin/src/components/MonacoSetup.tsx
```

**Step 2: 搜索并移除引用**

```bash
grep -r "MonacoSetup" apps/admin/src/
```

如果有引用，移除相关 import 和使用。

---

### Task 13: 移除废弃依赖

**Files:**
- Modify: `apps/admin/package.json`

**Step 1: 移除 GraphiQL 相关依赖**

```bash
cd apps/admin && pnpm remove graphiql @graphiql/react null-loader
```

注意：保留 `@graphiql/toolkit`（fetcher 仍在使用）

**Step 2: 验证 package.json**

```bash
cat apps/admin/package.json | grep -E "graphiql|null-loader"
```

Expected: 只显示 @graphiql/toolkit

---

### Task 14: 配置 ESLint CLI

**Files:**
- Create: `apps/admin/eslint.config.mjs`
- Modify: `apps/admin/package.json`

**Step 1: 安装 ESLint**

```bash
cd apps/admin && pnpm add -D eslint @next/eslint-plugin-next eslint-config-next eslint-plugin-react eslint-plugin-react-hooks
```

**Step 2: 创建 ESLint 配置**

创建 `apps/admin/eslint.config.mjs`：

```javascript
import nextPlugin from '@next/eslint-plugin-next';
import reactPlugin from 'eslint-plugin-react';
import hooksPlugin from 'eslint-plugin-react-hooks';

export default [
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: {
      '@next/next': nextPlugin,
      'react': reactPlugin,
      'react-hooks': hooksPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  {
    ignores: ['.next/**', 'node_modules/**'],
  },
];
```

**Step 3: 更新 package.json scripts**

在 `apps/admin/package.json` 中，将 `"lint": "next lint"` 改为 `"lint": "eslint ."`

---

### Task 15: 验证构建

**Files:**
- None

**Step 1: 重新安装依赖**

```bash
pnpm install
```

**Step 2: 构建 shared**

```bash
pnpm --filter @druvia/shared build
```

**Step 3: 构建 admin**

```bash
pnpm --filter @druvia/admin build
```

Expected: 构建成功

**Step 4: 启动开发服务器测试**

```bash
cd apps/admin && pnpm dev
```

Expected: Turbopack 启动，无错误

---

### Task 16: 暂存 Phase 2 变更

**Files:**
- All modified files

**Step 1: 查看变更**

```bash
git status
```

**Step 2: 暂存变更（用户手动提交）**

```bash
git add -A
```

用户手动执行提交：
```bash
git commit -m "feat: upgrade to Next.js 16 + Turbopack

- Update next to 16.x with Turbopack as default bundler
- Replace GraphiQL with CodeMirror-based GraphQL editor
- Migrate to ESLint CLI (next lint removed in v16)
- Remove Monaco/GraphiQL dependencies
- Update next.config.js for Turbopack"
```

---

## Phase 3: 验证与清理

### Task 17: 功能验证

**Files:**
- None

**Step 1: 启动完整开发环境**

```bash
make dev-up  # 启动 Docker 服务
pnpm dev     # 启动应用
```

**Step 2: 验证关键功能**

- [ ] 登录页面正常
- [ ] 租户列表正常
- [ ] 项目列表正常
- [ ] GraphQL Playground 可执行查询
- [ ] SQL 编辑器正常
- [ ] 数据表管理正常

**Step 3: 运行 lint**

```bash
pnpm --filter @druvia/admin lint
```

Expected: 无错误或仅有警告

---

### Task 18: 合并到 main

**Files:**
- None

**Step 1: 确认所有测试通过**

```bash
pnpm test
```

**Step 2: 合并分支**

```bash
git checkout main
git merge feature/nextjs-upgrade
```

**Step 3: 推送（可选）**

```bash
git push origin main
```

---

*Created: 2026-03-10*
