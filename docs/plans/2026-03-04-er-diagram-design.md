# M7: ER 图可视化设计文档

**创建日期**: 2026-03-04
**状态**: 已批准

---

## 概述

在表列表页面新增"关系图" Tab，使用 ReactFlow + dagre 实现数据库表关系可视化。

## 技术选型

| 技术 | 用途 |
|------|------|
| reactflow | 流程图渲染 |
| @dagrejs/dagre | 自动层次布局 |

## 架构设计

```
┌─────────────────────────────────────────────────────────┐
│  /tables 页面                                            │
│  ┌──────────┬──────────┐                                │
│  │ 表列表   │  关系图  │  ← Tabs 切换                    │
│  └──────────┴──────────┘                                │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐│
│  │  ERDiagram 组件                                      ││
│  │  ┌─────────┐    ┌─────────┐    ┌─────────┐          ││
│  │  │ users   │───→│ posts   │───→│ comments│          ││
│  │  └─────────┘    └─────────┘    └─────────┘          ││
│  │                                                      ││
│  │  [MiniMap]  [Controls: 缩放/全屏]                    ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### 组件结构

- `ERDiagram.tsx` - 主组件，负责 ReactFlow 渲染
- `TableNode.tsx` - 自定义表节点，显示表名 + 字段列表
- `useERData.ts` - Hook，获取表/外键数据并转换为节点/边

### 后端新增

- `GET /api/v1/projects/:projectId/schema/relations` - 返回表和外键信息

## API 设计

### 响应格式

```typescript
interface SchemaRelationsResponse {
  tables: {
    name: string;
    columns: {
      name: string;
      type: string;
      isPrimaryKey: boolean;
    }[];
  }[];
  foreignKeys: {
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
  }[];
}
```

### 数据转换流程

```
API 响应 → useERData hook → dagre 布局计算 → ReactFlow 渲染
                ↓
         tables → nodes (TableNode)
         foreignKeys → edges (带箭头连线)
```

dagre 布局方向：从左到右（LR），被引用的表在左侧，引用方在右侧。

## UI 设计

### 表节点样式

```
┌──────────────────────┐
│  🗃️ users            │  ← 表名（深色背景）
├──────────────────────┤
│  🔑 id        uuid   │  ← 主键带钥匙图标
│     email    varchar │
│     name     varchar │
└──────────────────────┘
```

### 交互功能

| 操作 | 效果 |
|------|------|
| 点击表节点 | 跳转到表详情页 |
| 鼠标滚轮 | 缩放画布 |
| 拖拽画布 | 平移视图 |
| 拖拽节点 | 调整位置（不持久化） |

### 控件

- MiniMap（右下角小地图）
- Controls（缩放 +/-、适应画布）
- Background（点状网格背景）

## 边界情况处理

| 场景 | 处理方式 |
|------|----------|
| 无表 | 显示空状态提示 |
| 无外键关系 | 正常显示所有表节点，无连线 |
| 大量表（>50） | dagre 自动布局，MiniMap 辅助导航 |
| API 加载中 | 显示 Skeleton 加载状态 |
| API 错误 | 显示错误提示 + 重试按钮 |

## 不实现的功能

- 导出图片（可后续迭代）
- 布局持久化到服务器
- 自定义节点颜色

## 文件清单

### 新建文件

| 文件 | 说明 |
|------|------|
| `apps/admin/src/components/tables/ERDiagram.tsx` | ER 图主组件 |
| `apps/admin/src/components/tables/TableNode.tsx` | 自定义表节点 |
| `apps/admin/src/hooks/useERData.ts` | 数据获取与转换 Hook |
| `apps/api/src/modules/schema/schema.service.ts` | Schema 关系查询服务 |
| `apps/api/src/modules/schema/schema.routes.ts` | Schema 路由 |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/page.tsx` | 添加 Tabs 和 ER 图组件 |
| `apps/admin/src/lib/api.ts` | 添加 getSchemaRelations 方法 |
| `apps/api/src/routes.ts` | 注册 schema 路由 |

## 依赖安装

```bash
cd apps/admin && pnpm add reactflow @dagrejs/dagre @types/dagre
```
