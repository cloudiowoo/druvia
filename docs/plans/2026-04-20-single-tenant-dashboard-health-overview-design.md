# 单租户运营首页 Dashboard 健康总览重构设计

## 背景

当前 `apps/admin/src/app/t/[tenantId]/page.tsx` 在单租户模式下承担首页职责，但它仍然复用平台级 `dashboard` 聚合接口，导致页面语义与数据层级不一致：

1. `/t/default` 作为当前实例首页，却展示了偏平台级的聚合统计
2. 第一屏优先展示的是数量和图表，而不是“系统是否健康、是否可继续使用”
3. 租户层与项目层的关系没有被真实表达：租户层只有少量属性卡片，项目层只有跳转入口，没有健康解释
4. 现有“系统状态”是静态式的展示，缺少与备份、能力配置、项目风险的联动

本次重构的目标不是再做一个“更好看的首页”，而是把 `/t/default` 变成 **单租户运营首页**：弱化“租户”概念，用“当前工作区 / 当前实例”的视角，先给运营结论，再给原因，再提供下钻入口。

---

## 目标

- 将 `/t/default` 重构为单租户模式下的运营首页
- 第一屏优先回答“系统现在是否健康可用”
- 用真实的租户层聚合数据，解释项目层问题来源
- 弱化租户概念，保留 workspace 上下文，不再把“租户属性”当首页主体
- 为未来多租户扩展保留数据与页面结构上的平滑升级路径

## 非目标

本次设计不包含以下内容：

- 不重构 `/dashboard` 平台级超级管理页
- 不重构 `/t/[tenantId]/p/[projectId]` 项目详情页的信息架构
- 不新增新的能力域，只围绕现有 `Database / Auth / Storage / Realtime / Functions / Backups` 做聚合
- 不在本次设计里处理商业化套餐、计费、账单等运营指标
- 不引入“装饰性大盘”或无法解释来源的黑盒分数

---

## 现状分析

### 现有页面结构

当前单租户首页主要包含以下模块：

- Header：`Druvia + 欢迎回来`
- 4 个基础统计卡：项目数、用户数、备份数、存储使用
- 7 日趋势图
- 存储分布图
- 我的项目列表
- 最近活动
- 系统状态（API / DB / Hasura / Redis）

实际代码位置：

- 页面：`apps/admin/src/app/t/[tenantId]/page.tsx`
- API client：`apps/admin/src/lib/api.ts`
- 后端聚合：`apps/api/src/modules/dashboard/dashboard.service.ts`

### 现有问题

#### 1. 数据层级不真实

`/t/default` 调用的是全局 `dashboard/stats`、`dashboard/trends`、`dashboard/activities`，这些接口没有 tenant/workspace 边界，导致单租户首页虽然“看起来可用”，但语义上仍然是平台聚合。

#### 2. 第一屏没有运营结论

当前第一屏告诉用户“有多少项目、多少用户、多少备份”，但没有回答最关键的问题：

- 现在是不是健康？
- 有没有明显风险？
- 需要立刻处理什么？

#### 3. 租户层与项目层没有形成解释关系

首页目前只在“我的项目”处列出项目名和状态，无法回答：

- 哪个项目最健康 / 最需要关注
- 问题来自能力没配置、运行不稳定，还是备份缺失
- 为什么首页整体健康分会下降

#### 4. 现有图表价值有限

当前趋势图和存储饼图更偏“展示”，不直接服务于健康判断。对于单租户运营首页，图表应该让位给健康判断、待处理事项和项目风险分布。

---

## 方案对比

### 方案 A：健康总览型（采用）

核心思路：

- 第一屏先给综合健康结论
- 再解释健康分由哪些因子组成
- 然后把问题落到项目列表和能力覆盖层

优点：

- 最符合“运营为主，先看是否健康”的目标
- 可以弱化租户，只保留 workspace 上下文
- 可自然扩展到未来多租户：把“当前工作区健康”提升为“单租户/租户健康”即可

缺点：

- 需要新增 tenant-scoped 聚合接口
- 需要定义一套可解释的健康评分模型

### 方案 B：项目驾驶舱型

核心思路：

- 首页直接围绕项目卡片展开
- 全局健康只做轻量摘要

优点：

- 适合项目数较多、需要频繁跨项目巡视

缺点：

- 第一屏容易失去全局结论
- 对当前单租户阶段来说，项目数量通常有限，首页过早进入项目粒度会显得分散

### 方案 C：能力成熟度型

核心思路：

- 首页围绕 `Auth / Database / Storage / Realtime / Functions` 展示能力成熟度
- 项目只是能力承载对象

优点：

- 适合对外演示或平台建设视角

缺点：

- 不够贴近真实运营动作
- 容易把“能力看板”误当成“运营首页”

### 结论

采用 **方案 A：健康总览型**，并吸收另外两套方案的局部优点：

- 从 B 中吸收“项目健康列表”
- 从 C 中吸收“能力覆盖概览”

这样首页结构会形成一条清晰的信息链：

```text
系统是否健康 → 为什么是这个状态 → 哪些项目导致了这个状态 → 哪些能力仍需补齐 → 去哪里处理
```

---

## 信息架构设计

### 1. 顶部 Hero：运营首页语义

首页标题建议调整为：

- 主标题：`运营概览`
- 副标题：`${workspaceLabel} · 单租户模式`（例如 `default workspace · 单租户模式`）

不再使用“租户概览”作为首页副标题。原因是：

- 在单租户主场景下，用户不是在管理多个租户，而是在管理“当前实例”
- 默认工作区 id 仍然保留在路由与上下文中，但不应成为接口层对“单租户模式”的硬编码判断依据

右上角展示轻量摘要：

- 项目数
- 能力域数量（固定为 5）
- 最近一次更新时间

### 2. 第一屏核心：综合健康区

第一屏由两个部分构成：

#### 左侧：综合健康卡

展示：

- 健康状态：`健康 / 关注 / 风险`
- 分数：`0 - 100`
- 一句解释型结论

示例：

> 82 / 100，核心服务可用，但 Functions 可用性与备份覆盖不足。

#### 右侧：健康因子拆解

拆分为 3 个可解释因子：

- `可用性`
- `稳定性`
- `配置风险`

目的：

- 避免黑盒分数
- 让用户一眼知道问题主要来自服务可用性、运行稳定性，还是能力配置不足

### 3. 第一屏右上：待处理事项

待处理事项是首页优先级最高的“行动区”，位置要高于“最近活动”。

只展示真正需要操作的事项，例如：

- 最近 7 天没有成功备份
- Functions Worker 不可用或未部署
- Storage 未配置
- 某项目处于 `disabled`
- 某项目最近 24 小时存在失败执行或失败备份
- 存储占用进入高水位

每条事项都必须带：

- 严重级别：`high / medium / low`
- 对应范围：`workspace / project`
- 目标跳转链接
- 可读的解释文案

### 4. 第二屏：经营面指标

四张核心卡足够：

1. `项目总数`
2. `活跃项目数`
3. `能力覆盖率`
4. `备份 / 存储覆盖`

这里不再把“用户数”放在首页最高优先级。理由：

- 对当前 Druvia 阶段，项目状态和能力覆盖比终端用户总量更能代表平台运营状态
- 用户数可以保留在下钻数据中，但不应挤占第一屏主指标位置

### 5. 项目健康列表

项目列表从当前的“项目入口”升级为“项目健康解释层”。

每行展示：

- 项目名称 / alias
- 项目状态（`active / disabled`）
- 项目健康分
- 5 个能力域状态标签
- 最近可识别运行信号时间
- 最近成功备份时间
- 风险标签
- 跳转入口：`进入项目`

列表目的：

- 把 workspace 健康结论解释到项目层
- 让首页成为运营视角的项目排序页，而不是纯导航页

### 6. 能力覆盖 + 时间线

#### 能力覆盖概览

以 workspace 视角展示：

- Database
- Auth
- Storage
- Realtime
- Functions

每项显示：

- 当前状态
- 覆盖项目数 / 总项目数
- 未覆盖的项目数

#### 运维与异常时间线

时间线在 Phase 1 改为“可归因运维信号 + 异常事件混合流”，而不是假设平台已经存在一条完整的 project activity feed：

- 失败、异常、待处理项对应的事件高亮展示
- 只有能明确归因到 workspace / project 的信号才进入时间线
- `druvia_activity_logs` 仅在 `target_type / target_id` 能可靠映射到当前工作区时才作为辅助来源，不作为唯一来源

例如：

- `backup.create completed`
- `backup.create failed`
- `project disabled`
- `function execution error`

---

## 各层级真实数据映射

### 设计原则

首页必须“真实体现”能力状态和健康度，因此每个状态都要来自可验证的数据，而不是写死的“已支持”。

Phase 1 额外约束：

- 未实现探针的服务状态返回 `unknown` 或直接不参与该子项评分，不能写死为 `healthy`
- 首页允许“信号不完整”，但不允许“信号缺失时假装健康”
- `workspace` 是否处于单租户模式由前端现有部署配置判断，不通过 `tenantId === 'default'` 推断

### 层级划分

| 层级 | 角色 | 展示重点 |
|------|------|----------|
| Workspace / 租户层 | 聚合结论层 | 首页综合健康、待处理事项、总体指标、能力覆盖 |
| 项目层 | 原因解释层 | 项目健康、能力状态、最近可识别运行信号、最近备份、风险标签 |

### Workspace / 租户层数据

| 指标 | 数据来源 | 说明 |
|------|----------|------|
| 项目总数 | `druvia_projects` | 当前 tenant 下所有项目 |
| 活跃项目数 | `druvia_projects.status='active'` | 反映可继续运营的项目数量 |
| 项目 schema 覆盖 | `druvia_projects.schema_name` | 用于 Database 可用性判断 |
| 备份覆盖率 | `druvia_backups` | 最近 N 天内有成功备份的项目数 / 项目总数 |
| 存储使用 | `druvia_files.size_bytes` | 反映对象存储真实使用，不再把备份体积等同于存储体积 |
| 备份存储使用 | `druvia_backups.size_bytes` | 独立展示备份资源占用 |
| Functions 运行信号 | `druvia_functions` + `druvia_function_logs` + Worker `/health` | 同时看函数定义、失败记录和 Worker 探针 |
| 系统服务状态 | API `/health`、PostgreSQL `SELECT 1`、Redis `PING`、Hasura `/healthz`、Worker `/health` | 未实现探针返回 `unknown`，不能写死 `healthy` |

### 项目层数据

| 能力/指标 | 数据来源 | 状态语义 |
|-----------|----------|----------|
| Database | `druvia_projects.schema_name` | 有 schema 才算已创建 |
| Auth | `druvia_project_auth_config` / `druvia_project_auth_providers` | 有配置或启用 provider 才算已配置 |
| Storage | `druvia_tenant_storage_config` + `druvia_files` | workspace 配置存在，且项目可看到是否已有存储使用 |
| Realtime | Hasura 健康 + 项目 schema 存在 + 可选 `_meta_tables.realtime_enabled` 聚合 | 不把“产品支持”误写成“项目已启用” |
| Functions | `druvia_functions` + Worker `/health` + `druvia_function_logs` | 既要看定义数量，也要看是否可运行 |
| 最近可识别运行信号时间 | 最近成功/失败备份、最近函数日志、项目 `updated_at`、可归因的 `druvia_activity_logs` | v1 从真实信号推导，不强依赖统一 activity log |
| 最近成功备份 | `druvia_backups.status='completed'` | 用于稳定性与风险识别 |

### 状态表达规范

为避免“名义支持”和“真实可用”混淆，首页状态使用以下语义：

- `已创建`：资源已建立（例如 schema 存在）
- `已配置`：相关配置或 provider 已存在
- `可用`：运行链路可正常工作
- `未覆盖`：该能力未配置到该项目
- `需关注`：有配置但存在风险，例如最近失败或长时间未执行

---

## 健康分模型

### 总体模型

健康分 = `可用性 40` + `稳定性 35` + `配置风险 25`

```text
score = availabilityScore + stabilityScore + riskScore
```

每个因子独立计分，最后合并成 100 分制。

Phase 1 归一化规则：

- 某个子项探针结果为 `unknown` 时，不记正分，也不直接记负分
- `unknown` 子项从该因子的“可计分上限”中剔除，再按剩余已知信号归一化到该因子的满分
- 首页摘要应额外提示“部分信号缺失”，避免用户把归一化后的分数误读为“所有链路都已验证”

### 阈值定义

| 分数 | 状态 | 含义 |
|------|------|------|
| 85 - 100 | 健康 | 核心服务与关键能力均可正常使用 |
| 60 - 84 | 关注 | 可继续使用，但有明显短板或待处理项 |
| 0 - 59 | 风险 | 已有影响运营的缺失、失败或配置风险 |

### 1. 可用性（40 分）

建议拆分如下：

| 子项 | 分值 | 判定 |
|------|------|------|
| API | 5 | 当前请求可达即可视为通过 |
| PostgreSQL | 10 | `SELECT 1` 成功 |
| Redis | 5 | `PING` 成功 |
| Hasura | 10 | `/healthz` 成功 |
| 活跃项目存在 | 10 | 至少有 1 个 `active` 项目 |

### 2. 稳定性（35 分）

建议拆分如下：

| 子项 | 分值 | 判定 |
|------|------|------|
| 备份覆盖 | 15 | 最近 7 天内有成功备份的项目覆盖率 |
| 失败事件控制 | 10 | 最近 24h 没有失败备份 / 失败函数执行 |
| 近期运行信号 | 10 | 近期有可识别运行或运维信号，不是“完全空白” |

### 3. 配置风险（25 分）

建议拆分如下：

| 子项 | 分值 | 判定 |
|------|------|------|
| Storage 配置 | 5 | tenant storage 配置存在且有效 |
| Auth 覆盖 | 5 | 至少一个项目具备可识别 auth 配置 |
| Functions 可运行 | 5 | worker 可用，且存在项目可用函数能力 |
| 项目禁用风险 | 5 | 无 `disabled` 项目，或 disabled 项目数在容忍范围内 |
| 容量风险 | 5 | 存储占用未进入高水位 |

### 解释规则

首页不直接展示公式，只展示：

- 当前总分
- 3 个因子分
- 影响最大的 2-3 个原因

例如：

> 72 / 100：API、数据库与 Hasura 可用，但最近 7 天没有项目级成功备份，Functions Worker 也未形成可用覆盖。

---

## 待处理事项生成规则

待处理事项由规则生成，而不是手工编写。建议先覆盖以下规则：

| 规则 | 严重级别 | 跳转 |
|------|----------|------|
| 7 天内无成功备份 | high | `/t/[tenantId]/backups` |
| 存在 disabled 项目 | high | 对应项目页 |
| Functions Worker 不可用 | high | 对应 Functions 页面或工作区设置 |
| Storage 未配置 | medium | `/t/[tenantId]/settings` |
| 最近 24h 存在函数失败 | medium | 对应项目 Functions 页 |
| 存储占用 > 80% | medium | 备份/存储相关页 |
| Auth 未配置项目数 > 0 | low | 对应项目 Auth 页 |

返回结果建议包含结构：

```json
{
  "severity": "high",
  "scope": "workspace",
  "title": "最近 7 天没有成功备份",
  "description": "当前工作区缺少可用于恢复的最新备份。",
  "href": "/t/default/backups"
}
```

---

## API 设计

### 设计原则

- 保留现有 `/api/v1/dashboard/*` 平台级接口，不重载其语义
- 新增 tenant-scoped dashboard 接口，服务 `/t/[tenantId]` 首页
- 首页使用的所有健康、风险、项目解释数据都必须来自 tenant-scoped 接口
- tenant dashboard 属于管理面工作区接口，默认只接受 `platform_user` JWT
- 接口在读取 tenant 聚合数据前，必须显式校验当前 platform user 是否拥有该 tenant
- `project_user` 与匿名 `apikey` 不得访问工作区级 dashboard 接口
- 单/多租户展示模式由 Admin 现有 `tenant-config` 推导，接口不通过 `tenantId` 猜测部署模式

### 新增接口

#### 1. 获取工作区首页概览

```http
GET /api/v1/tenants/:tenantId/dashboard/overview
```

响应示例：

```json
{
  "success": true,
  "data": {
    "workspace": {
      "tenantId": "default",
      "label": "default workspace"
    },
    "health": {
      "score": 82,
      "status": "attention",
      "summary": "核心服务可用，但 Functions 与备份覆盖不足。",
      "factors": {
        "availability": 30,
        "stability": 27,
        "risk": 25
      }
    },
    "actionItems": [
      {
        "severity": "high",
        "scope": "workspace",
        "title": "最近 7 天没有成功备份",
        "description": "至少一个 active 项目没有恢复点。",
        "href": "/t/default/backups"
      }
    ],
    "metrics": {
      "totalProjects": 3,
      "activeProjects": 2,
      "capabilityCoverage": 60,
      "backupCoverage": 33,
      "storageUsageBytes": 10485760,
      "backupUsageBytes": 5242880
    },
    "capabilities": [
      { "key": "database", "label": "Database", "coveredProjects": 3, "totalProjects": 3, "status": "healthy" },
      { "key": "functions", "label": "Functions", "coveredProjects": 1, "totalProjects": 3, "status": "attention" }
    ],
    "serviceStatus": {
      "api": "healthy",
      "database": "healthy",
      "redis": "healthy",
      "hasura": "healthy",
      "worker": "unknown"
    },
    "updatedAt": "2026-04-20T14:00:00.000Z"
  }
}
```

说明：

- `workspace` 仅返回工作区标识与展示标签；单/多租户模式由前端已有部署配置判断
- `serviceStatus` 建议支持 `healthy / risk / unknown`，其中 `unknown` 表示当前实例尚未具备可靠探针，不能等价成 `healthy`

#### 2. 获取项目健康列表

```http
GET /api/v1/tenants/:tenantId/dashboard/projects
```

响应示例：

```json
{
  "success": true,
  "data": [
    {
      "projectId": "proj_xxx",
      "name": "Taro 小程序",
      "alias": "taroapp",
      "status": "active",
      "healthScore": 78,
      "healthStatus": "attention",
      "capabilities": {
        "database": "ready",
        "auth": "configured",
        "storage": "ready",
        "realtime": "ready",
        "functions": "missing"
      },
      "latestSignalAt": "2026-04-20T10:20:00.000Z",
      "latestBackupAt": null,
      "riskTags": ["缺少备份", "Functions 未覆盖"]
    }
  ]
}
```

#### 3. 获取首页时间线

```http
GET /api/v1/tenants/:tenantId/dashboard/timeline?limit=20
```

说明：

- 时间线由可归因运维信号与异常事件统一组织
- 普通信号与异常事件共用一条时间线，但异常需要明确 `kind=incident`

---

## 前端设计

### 页面结构

建议将 `apps/admin/src/app/t/[tenantId]/page.tsx` 从“大而全页面”改为“页面容器 + 领域组件”结构，避免继续堆叠。

建议拆分组件：

- `apps/admin/src/components/dashboard/WorkspaceHealthSummary.tsx`
- `apps/admin/src/components/dashboard/WorkspaceActionItems.tsx`
- `apps/admin/src/components/dashboard/WorkspaceMetricsRow.tsx`
- `apps/admin/src/components/dashboard/ProjectHealthList.tsx`
- `apps/admin/src/components/dashboard/CapabilityCoverageCard.tsx`
- `apps/admin/src/components/dashboard/ActivityTimelineCard.tsx`
- `apps/admin/src/components/dashboard/health-score.ts`

### 交互原则

- 第一屏只回答结论
- 第二屏解释原因
- 所有高风险项都必须可点击下钻
- 颜色表达风险，但不要只靠颜色表达风险
- 不保留“租户别名 / 套餐 / 状态”卡片作为首页主体

### 文案原则

- 少说“租户”，多说“工作区 / 当前实例”
- 不使用“已支持”来表达状态，只使用“已配置 / 可用 / 未覆盖 / 需关注”
- 每个分数或状态旁边都能给出一句解释，而不是只给图形和数字

---

## 测试与验证

### 后端验证

至少覆盖：

1. tenant overview 接口能返回健康分、待处理事项、经营面指标
2. tenant projects 接口能返回项目健康列表与能力状态
3. tenant timeline 接口能返回按时间倒序排列的数据
4. 空数据场景下接口仍能返回稳定结构，而不是缺字段

### 前端验证

至少覆盖：

1. 第一屏能正确显示健康状态、分数和 3 个因子
2. 待处理事项为空时展示空态，有事项时展示跳转入口
3. 项目健康列表能正确渲染能力标签、风险标签和最近可识别运行信号时间
4. 单租户模式仍展示新首页，多租户模式继续保留原租户概览

### 手工验收

使用项目内测试账号：

- `admin@druvia.local`
- `88888888`

在浏览器验证：

1. 登录后访问 `http://localhost:3000/t/default`
2. 第一屏可直接读出健康结论
3. 待处理事项能跳到正确页面
4. 项目列表不再只是导航，而能解释健康原因
5. 将多租户开关切回 `true` 并重启 Admin 后，原租户概览不受影响

---

## 文件改动范围

### 后端

- `apps/api/src/lib/access.ts`
- `apps/api/src/modules/dashboard/dashboard.routes.ts`
- `apps/api/src/modules/dashboard/dashboard.controller.ts`
- `apps/api/src/modules/dashboard/dashboard.service.ts`
- `apps/api/src/modules/dashboard/` 下新增健康评分或聚合 helper（如拆分需要）

### 前端

- `apps/admin/src/lib/api.ts`
- `apps/admin/src/app/t/[tenantId]/page.tsx`
- `apps/admin/src/components/dashboard/*`

### 测试

- `tests/integration/dashboard.test.ts`
- `tests/unit/dashboard-controller.test.ts`
- `tests/unit/dashboard-health.test.ts`
- `tests/unit/admin/jsdom-smoke.test.tsx`
- `tests/unit/admin/*dashboard*.test.tsx`
- `package.json`
- `vitest.config.ts`
- `tests/setup.ts`

---

## 验收标准

- [ ] `/t/default` 第一屏改为综合健康结论，而不是数字卡片优先
- [ ] 首页待处理事项高于最近活动展示
- [ ] 首页指标以项目运营、能力覆盖、备份/存储覆盖为核心
- [ ] 项目列表可解释项目健康和能力状态
- [ ] 首页数据全部来自 tenant-scoped dashboard 接口
- [ ] tenant dashboard 仍保持管理面访问边界，不向 `project_user` / `apikey` 开放
- [ ] 缺失探针不会被写死成 `healthy`，且首页会提示“部分信号缺失”
- [ ] 单租户模式保留 workspace 语义，多租户模式不被破坏

---

## 参考

- `apps/admin/src/app/t/[tenantId]/page.tsx`
- `apps/admin/src/lib/api.ts`
- `apps/api/src/modules/dashboard/dashboard.service.ts`
- `docs/plans/2026-03-08-single-tenant-ui-design.md`
- `docs/plans/2026-03-23-function-invoke-auth-ui-design.md`
