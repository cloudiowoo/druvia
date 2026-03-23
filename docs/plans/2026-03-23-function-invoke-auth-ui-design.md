# Functions 页面 Invoke Auth Mode 管理设计

## 背景

第二轮 Edge Functions 权限收敛后，函数调用不再是“同项目 anon key 可调用任意 function”，而是引入了函数级别的 `invoke_auth_mode`：

- `jwt_required`
- `anon_allowed`

后端、迁移、Worker caller context 已支持该字段，但当前 Admin UI 还没有可视化管理入口。这样会带来两个问题：

1. 管理员无法在控制台明确看到某个函数是否对匿名访问开放
2. 新增或调整函数权限时，只能依赖迁移默认值或手工调用管理 API

因此需要在 Druvia Admin 的 Functions 管理页补齐该字段的展示与配置能力。

## 目标

在现有 Functions 管理页中补充 `Invoke Auth Mode` 的查看和编辑能力，满足以下约束：

- 创建函数时不暴露该字段，默认固定为 `JWT Required`
- 只有选中某个函数后，才可在右侧编辑区修改该字段
- 左侧列表仅做只读状态展示，不提供直接切换
- `Anonymous Allowed` 必须有明确风险提示，避免误把上传类、用户态函数暴露给匿名调用

## 非目标

本次不做以下内容：

- 不新增独立的 Functions Settings 页面
- 不在左侧列表提供直接切换开关
- 不修改函数运行、日志、Secrets 的交互模式
- 不增加新的函数权限模式，仅支持已有的两种枚举值

## 现状分析

### 页面结构

当前 Functions 页面由以下部分组成：

- 左侧列表：`apps/admin/src/components/functions/FunctionList.tsx`
- 右侧编辑器：`apps/admin/src/components/functions/FunctionEditor.tsx`
- 页面容器与数据流：`apps/admin/src/app/t/[tenantId]/p/[projectId]/functions/page.tsx`

### 已有数据能力

Admin API client 已支持 `invokeAuthMode`：

- `createFunction(projectId, data)`
- `updateFunction(projectId, name, data)`

后端返回的 `EdgeFunction` 也已经包含 `invokeAuthMode`。

因此本次 UI 改动不需要新增接口，只需补齐前端字段绑定与展示。

## 方案对比

### 方案 A：在右侧编辑区增加配置区

做法：

- 选中函数后，在 `FunctionEditor` 中增加 `Invoke Auth Mode` 配置
- 与代码、描述共用现有保存按钮
- 左侧列表只展示只读 badge

优点：

- 与单函数编辑上下文一致，修改前能明确知道自己在编辑哪个函数
- 安全敏感配置不会出现在高频列表操作区，误触风险低
- 不需要新增 tab 或新页面，改动最小

缺点：

- 需要先选中函数，不能在列表中批量快速修改

### 方案 B：左侧列表直接切换

做法：

- 在每行 function 上直接放 switch 或菜单项切换 `invokeAuthMode`

优点：

- 操作更快

缺点：

- 对安全敏感配置过于激进，容易误触
- 风险提示难以放清楚
- 列表空间有限，信息密度已经较高

### 方案 C：新增 Settings Tab

做法：

- 在 `编辑器 / 日志 / Secrets` 之外新增 `设置` tab，集中放函数元数据

优点：

- 信息架构更清晰

缺点：

- 对单个字段来说过重
- 会拉长操作路径，降低常用配置效率

## 结论

采用方案 A：

- 在右侧 `FunctionEditor` 中管理 `Invoke Auth Mode`
- 左侧 `FunctionList` 只展示只读 badge
- 创建函数时该字段隐藏，默认固定为 `JWT Required`

这是当前页面结构下改动最小、风险最低、可理解性最好的方案。

## 详细设计

### 1. 创建函数

创建函数弹窗维持现状：

- 不增加 `Invoke Auth Mode` 字段
- 后端默认值保持 `jwt_required`
- 创建成功后，右侧编辑区显示该函数的默认权限模式

### 2. 函数编辑区

在 `FunctionEditor` 的描述输入框下方增加一个轻量配置区：

- Label：`Invoke Auth Mode`
- 控件：`select`
- 选项：
  - `JWT Required`
  - `Anonymous Allowed`

交互规则：

- 初始值取自 `func.invokeAuthMode`
- 切换该值会触发 `hasChanges = true`
- 点击现有“保存”按钮时，与 `code`、`description` 一起提交
- 不做自动保存

### 3. 风险提示

当选中 `Anonymous Allowed` 时，在配置区下方显示一条 amber 警示信息：

- 明确说明该模式只适用于登录前函数
- 明确举例 `wx-silent-login`、`wx-login-register`
- 明确提示上传类、用户态、后台函数不应开启

建议文案：

> 仅对登录前函数开放匿名调用，例如 `wx-silent-login`、`wx-login-register`。上传、用户态和后台函数应保持 `JWT Required`。

### 4. 左侧列表

在 `FunctionList` 每个函数项中增加只读 badge：

- `ANON`：amber 风格，对应 `anon_allowed`
- `JWT`：gray 风格，对应 `jwt_required`

要求：

- 不增加点击能力
- 不占用菜单项
- 不改变现有状态切换与删除操作位置

目的：

- 便于管理员快速扫出哪些函数暴露给匿名调用

### 5. 页面数据流

`FunctionsPage` 中的数据流调整如下：

- `handleSave()` 扩展为同时接收 `invokeAuthMode`
- 保存成功后，同时更新：
  - `selectedFunction`
  - `functions` 列表中的对应项

不需要新增页面级状态管理机制，沿用当前模式即可。

## 数据契约

前端使用字段：

```typescript
type InvokeAuthMode = 'jwt_required' | 'anon_allowed'
```

`EdgeFunction` 需要至少包含：

```typescript
interface EdgeFunction {
  id: string
  name: string
  status: 'active' | 'disabled'
  invokeAuthMode: InvokeAuthMode
  code: string
  description: string | null
}
```

更新请求：

```typescript
api.updateFunction(projectId, functionName, {
  code,
  description,
  invokeAuthMode,
})
```

## 测试策略

前端至少补充以下验证：

1. `FunctionEditor` 能正确显示当前 `invokeAuthMode`
2. 修改 `invokeAuthMode` 会触发未保存状态
3. 点击保存时会把 `invokeAuthMode` 一并提交
4. `FunctionList` 能根据不同模式显示 `ANON` / `JWT` badge

额外验证：

- 不影响现有保存代码、运行函数、查看日志、管理 Secrets 的交互

## 风险与回避

### 风险 1：误把敏感函数开放为匿名可调用

回避：

- 默认值固定为 `JWT Required`
- 创建时不暴露该字段
- 编辑时对 `Anonymous Allowed` 显示显式风险提示

### 风险 2：用户无法意识到某函数当前是匿名开放

回避：

- 左侧列表补充只读 badge
- 编辑区明确显示当前模式

### 风险 3：保存逻辑影响现有代码编辑

回避：

- 复用现有保存按钮与更新接口
- 不引入新的保存通道

## 实现范围

本次预计改动文件：

- `apps/admin/src/app/t/[tenantId]/p/[projectId]/functions/page.tsx`
- `apps/admin/src/components/functions/FunctionEditor.tsx`
- `apps/admin/src/components/functions/FunctionList.tsx`
- 如需要，补充对应单元测试文件

## 验收标准

- 管理员可在 Functions 页面直观看到每个函数是 `JWT` 还是 `ANON`
- 选中函数后，可在右侧编辑区切换 `Invoke Auth Mode`
- 创建函数时该字段默认不显示，函数默认以 `JWT Required` 创建
- `Anonymous Allowed` 显示风险提示
- 保存后页面状态与列表展示同步更新
