# Phase 3 P2 功能设计文档

## 概述

Phase 2 已全部完成，本文档规划 Phase 3 P2 阶段的 4 个功能模块，聚焦数据编辑体验增强。

**创建日期**: 2026-03-05
**状态**: 已批准

### 相关文档

- [开发者体验设计](./2026-03-02-developer-experience-design.md) - 原始模块定义
- [战略设计文档](./2026-03-03-druvia-strategy-design.md) - 产品定位

---

## 实施顺序

采用依赖优先策略：

```
M11 外键关系配置 (高复杂度)
    ↓
M14 记录详情表单 (中复杂度，依赖 M11)
    ↓
M13 JSON 单元格编辑器 (中复杂度，集成到 M14)
    ↓
M12 侧边栏表列表 (低复杂度)
```

---

## M11: 外键关系配置

### 功能范围

| 功能点 | 说明 |
|--------|------|
| 建表时配置外键 | CreateTableDialog 新增外键配置区域 |
| 级联规则 | ON DELETE / ON UPDATE 配置 |
| 数据网格外键显示 | 外键列显示关联值，可点击跳转 |
| 编辑表时修改外键 | 支持添加/删除外键约束 |

### 技术方案

**后端扩展**:
- 修改 `createTable` API 支持外键定义
- 新增 `addForeignKey` / `dropForeignKey` API
- 复用 `getForeignKeys` API（已有，用于 ER 图）

**前端组件**:
```
apps/admin/src/components/tables/
└── ForeignKeyPopover.tsx      # 外键配置弹出框（建表时使用）
```

> 注：`ForeignKeyList.tsx` 和 `ForeignKeyCell.tsx` 移至后续迭代，当前版本聚焦建表时的外键配置。

**数据结构**:
```typescript
interface ForeignKeyConfig {
  column: string;
  targetTable: string;
  targetColumn: string;
  onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  onUpdate: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}
```

### API 设计

```
POST   /api/v1/schemas/:schema/tables/:table/foreign-keys
DELETE /api/v1/schemas/:schema/tables/:table/foreign-keys/:name
GET    /api/v1/schemas/:schema/tables/:table/foreign-keys  (已有)
```

### 验收标准

- [ ] 建表时可配置外键
- [ ] 支持 CASCADE/SET NULL/RESTRICT/NO ACTION 级联规则
- [ ] 可添加/删除现有表的外键约束

> 注：数据网格外键列显示关联值、点击跳转功能移至后续迭代。

---

## M14: 记录详情表单

### 功能范围

| 功能点 | 说明 |
|--------|------|
| 弹窗表单 | 完整字段编辑界面，替代行内编辑 |
| 字段类型适配 | 根据 PostgreSQL 类型渲染对应输入控件 |
| 外键下拉选择 | 外键字段显示关联表数据下拉 |
| 表单验证 | 必填、类型、长度等验证 |
| 新增/编辑模式 | 支持创建新记录和编辑现有记录 |

### 技术方案

**依赖**:
- `react-hook-form` - 表单状态管理
- `zod` - 表单验证

**前端组件**:
```
apps/admin/src/components/
├── data/
│   ├── RecordFormDialog.tsx       # 记录详情弹窗
│   ├── FieldRenderer.tsx          # 字段类型渲染器
│   └── ForeignKeySelect.tsx       # 外键下拉选择
└── editors/
    └── JsonEditorDialog.tsx       # JSON 弹窗编辑器（集成到 FieldRenderer）
```

**字段类型映射**:

| PostgreSQL 类型 | 输入控件 |
|----------------|---------|
| varchar/text | Input |
| integer/bigint | Input type="number" |
| boolean | Switch |
| timestamp/date | DatePicker |
| jsonb | JsonFieldEditor (M13) |
| uuid | Input + 自动生成按钮 |
| 外键列 | ForeignKeySelect 下拉 |

### 交互流程

```
数据网格行 → 双击或点击编辑按钮
    ↓
RecordFormDialog 弹出
    ↓
加载字段元数据 + 外键关联数据
    ↓
用户编辑 → 实时验证
    ↓
保存 → 调用 updateRow API
```

### 验收标准

- [ ] 双击行或点击编辑按钮打开弹窗
- [ ] 所有字段类型正确渲染对应控件
- [ ] 外键字段显示下拉选择
- [ ] 表单验证错误实时提示
- [ ] 支持新增和编辑两种模式
- [ ] 保存成功后刷新数据网格

---

## M13: JSON 单元格编辑器

### 功能范围

| 功能点 | 说明 |
|--------|------|
| 语法高亮 | JSON 语法着色 |
| 自动格式化 | 一键格式化 JSON |
| 实时验证 | 语法错误提示 |
| 弹窗编辑 | 大文本使用弹窗编辑器 |
| 行内预览 | 数据网格中显示 JSON 预览 |

### 技术方案

**复用现有依赖**:
- `@uiw/react-codemirror` - 已安装（SQL 编辑器）
- `@codemirror/lang-json` - 需新增

**前端组件**:
```
apps/admin/src/components/editors/
├── JsonEditorDialog.tsx       # JSON 弹窗编辑器
└── JsonPreview.tsx            # JSON 预览组件
```

> 注：`JsonCellEditor.tsx` 移至后续迭代，当前版本通过 RecordFormDialog 编辑 JSON 字段。

**集成点**:
1. SVAR DataGrid 自定义编辑器
2. M14 RecordFormDialog 的 jsonb 字段

### 交互设计

```
数据网格 jsonb 列
    ↓
单击 → 显示 JsonPreview（折叠显示）
    ↓
双击 → 打开 JsonEditorDialog
    ↓
编辑 → 实时语法验证
    ↓
保存 → 格式化后写入
```

### 验收标准

- [ ] JSON 语法高亮显示
- [ ] 支持一键格式化
- [ ] 语法错误实时提示
- [ ] 数据网格中显示 JSON 预览
- [ ] 弹窗编辑器支持大文本
- [ ] 集成到 M14 记录详情表单

---

## M12: 侧边栏表列表

### 功能范围

| 功能点 | 说明 |
|--------|------|
| 表列表显示 | 左侧边栏显示所有表 |
| 搜索过滤 | 支持表名搜索 |
| 快速切换 | 点击切换当前查看的表 |
| 表数量统计 | 显示表总数 |
| 当前表高亮 | 高亮当前选中的表 |

### 技术方案

**前端组件**:
```
apps/admin/src/components/tables/
└── TableSidebar.tsx           # 表列表侧边栏
```

**页面布局调整**:
```
/tables/[tableName]/data 页面
┌─────────────────────────────────────────┐
│ TableSidebar │     DataGrid            │
│ (200px)      │     (flex-1)            │
│              │                          │
│ 🔍 搜索      │                          │
│ ─────────    │                          │
│ ✓ users      │                          │
│   posts      │                          │
│   comments   │                          │
│   ...        │                          │
│              │                          │
│ 共 12 张表   │                          │
└─────────────────────────────────────────┘
```

### 交互设计

- 点击表名 → 路由跳转到 `/tables/{tableName}/data`
- 搜索框实时过滤
- 当前表高亮显示
- 可折叠侧边栏（响应式）

### 验收标准

- [ ] 左侧边栏显示表列表
- [ ] 支持表名搜索过滤
- [ ] 点击表名快速切换
- [ ] 当前表高亮显示
- [ ] 显示表总数统计
- [ ] 响应式折叠支持

---

## 依赖清单

| 功能 | 包 | 版本 | 状态 |
|------|-----|------|------|
| JSON 编辑器 | @codemirror/lang-json | ^6.0.0 | 待安装 |
| 表单管理 | react-hook-form | ^7.54.0 | 待安装 |
| 表单验证 | zod | ^3.23.0 | 待安装 |

---

## 文件清单

### 新增文件

```
apps/admin/src/components/
├── tables/
│   ├── ForeignKeyPopover.tsx
│   └── TableSidebar.tsx
├── data/
│   ├── RecordFormDialog.tsx
│   ├── FieldRenderer.tsx
│   └── ForeignKeySelect.tsx
└── editors/
    ├── JsonEditorDialog.tsx
    └── JsonPreview.tsx
```

> 注：`ForeignKeyList.tsx`、`ForeignKeyCell.tsx`、`JsonCellEditor.tsx` 移至后续迭代。

### 修改文件

```
apps/admin/src/components/tables/CreateTableDialog.tsx  # 添加外键配置
apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/[tableName]/data/page.tsx  # 添加侧边栏
apps/api/src/modules/table/table.routes.ts  # 添加外键 API 路由
```

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 外键下拉数据量大 | 性能问题 | 分页加载 + 搜索过滤 |
| JSON 编辑器包体积 | 首屏加载慢 | 动态导入 |
| 表单验证复杂 | 开发周期长 | 先实现基础验证，后续迭代 |

---

**更新日期**: 2026-03-05 (审查修订)
**下一步**: 按实施计划执行
