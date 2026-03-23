# Admin Agent Notes

适用于 `apps/admin` 目录及其子树。

## 模块职责

- Next.js 管理后台
- 项目配置、Functions、Storage、Tables、Auth、Realtime 等管理界面

## 当前高优先级

- 补齐迁移兼容所需的管理入口
- 权限相关配置必须显式、可见、默认安全
- 不为了操作速度牺牲安全敏感配置的可理解性

## 工作规则

- 安全敏感配置默认保守，优先默认值安全、显式编辑、带风险提示。
- 列表视图优先做状态展示；真正修改放到选中项编辑上下文中。
- 新增管理字段时，先确认后端迁移和 API 字段是否已经齐备。

## 近期风险

- Functions 页面 `invokeAuthMode` 依赖后端字段和数据库迁移同时存在。
- 管理端构建若失败，先区分是否是当前改动还是仓库已有问题；不要默认回退无关文件。

## 参考入口

- `docs/agent/project-memory.md`
- `docs/agent/playbooks.md`
- `docs/plans/2026-03-23-function-invoke-auth-ui-design.md`
