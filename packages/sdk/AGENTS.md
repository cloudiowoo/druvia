# SDK Agent Notes

适用于 `packages/sdk` 目录及其子树。

## 模块职责

- `@druvia/sdk`
- 对外封装 auth / database / storage / realtime / rpc / functions

## 当前高优先级

- 优先补齐真实迁移所需能力，而不是抽象完整性
- 优先对齐 taro-app / Supabase 的关键调用路径

## 工作规则

- 修改 API 形状时，先检查现有迁移项目是否依赖对应返回结构。
- 不要把“部分兼容”误写成“完全 Supabase 兼容”。
- 涉及 functions、auth、apikey 头时，必须联动检查 API 端实际认证路径。
- `database/graphql` 使用独立身份选择顺序：
  - 有 Project Session 时发送 project token，并保留项目 API key
  - 无 Project Session 时只发送项目 API key
  - 禁止回退 platform token
- `rpc/functions` 当前仍保留原有 project token -> platform token 回退，后续 actor cutover 前不要随 database 改动连带收紧。
- Realtime 建连必须通过 Druvia API 换取短期 Hasura-verifiable token；不能把长期 Project JWT/API key 直接发送给 Hasura，也不能把空 `connection_init` 当作正式 actor 支持。
- Realtime 每次 token exchange 必须通过 `projectAuth` 读取当前 Project Session，并同时支持同步/异步 `StorageAdapter`；不能只依赖客户端构造阶段的同步 session 缓存。
- Realtime channel 必须维护 `connecting / connected / reconnecting / error / closed` 状态，短期令牌续期或身份变化时关闭旧 socket、重新交换并恢复现有订阅；重新连接只恢复快照，不承诺重放断线期间事件。
- `unsubscribe()` / `removeChannel()` 必须终止自动重连；只有调用方再次显式 `subscribe()` 才能启动新连接。
- SDK 认证头或 session 选择顺序变化时，必须用 API 端真实中间件契约验证，不能只做客户端单测。
- SDK prerelease 发包必须显式带 dist-tag：
  - 例如 `0.1.0-beta.3` 应使用 `npm publish --tag beta`
  - 不要把 beta 版本直接当作默认 `latest` 发布

## 参考入口

- `docs/agent/playbooks.md`
- `docs/plans/2026-08-14-project-update-direction-analysis.md`
- `docs/plans/2026-03-17-taro-app-migration-design.md`
- `docs/plans/2026-03-18-druvia-sdk-adapter-requirements.md`
