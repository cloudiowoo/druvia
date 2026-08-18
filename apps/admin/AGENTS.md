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
- 项目设置类 JSON 配置保存时，要先确认后端是顶层 merge 还是深合并。
- 当页面只编辑 `settings.rateLimits` 下某个子键时，提交前必须保留完整 `rateLimits` 对象。
- GraphQL Playground 是应用权限测试入口，只能使用组件内存中的项目 API Key 或 Project access token；不得读取平台登录 token、持久化测试凭证或直连 Hasura `/v1/graphql`。
- Realtime 连接测试同样只使用组件内存中的项目 API Key 或 Project access token，经 Druvia API 换取短期令牌后连接 Hasura；不得使用平台 token、持久化应用凭证或模拟连接成功。
- 非默认环境在缺少不可变 environment identity 前只能显示运行时不可用，不得让用户误以为 dev/test 环境已具备隔离的 Realtime actor。
- 已有项目数据访问升级必须通过预检、独立风险确认、持久阶段进度、恢复和回滚预检完成；界面不得提供直接切换 `data_access_mode`，也不得展示物理 role、原始 metadata 或 Hasura secret。

## 近期风险

- Functions 页面 `invokeAuthMode` 依赖后端字段和数据库迁移同时存在。
- 管理端构建若失败，先区分是否是当前改动还是仓库已有问题；不要默认回退无关文件。
- GraphQL 限流页面若只回传 `graphql` 子对象，会覆盖未来同级 `rateLimits.*` 配置。

## 参考入口

- `docs/agent/playbooks.md`
- `docs/plans/2026-08-14-project-update-direction-analysis.md`
- `docs/plans/2026-03-23-function-invoke-auth-ui-design.md`
