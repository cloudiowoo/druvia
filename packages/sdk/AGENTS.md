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
- `rpc/functions` 使用应用身份选择：有 Project Session 时发送 project token，否则仅保留项目 API Key；禁止回退 platform token。无效 Project Session 也不得重试降级为 API Key。
- 直接 Storage 使用 application fetch：有 Project Session 时发送 project token，并保留项目 API key；无 Project Session 时只发送 API key；禁止回退 Platform Session，无效 Project Session 不得降级重试。
- Storage trusted ticket 的签发/消费使用 raw fetch，只发送调用方显式提供的 trusted backend key 或 storage ticket，不得附带 application/platform 凭证。
- SDK fetch wrapper 的 JSON-only 方法必须支持没有全局 `FormData` 的 custom-fetch 运行时；只有实际二进制 Storage upload/download 才可要求标准 `FormData`、`Blob`、`File` 和 `Response.blob()`。
- 当前直接二进制 upload/download 只保证标准浏览器与 Node 运行时；Taro/微信小程序仍使用 Edge Function/runtime-native adapter 路径，不能因 custom fetch 单测宣称已兼容。
- Realtime 建连必须通过 Druvia API 换取短期 Hasura-verifiable token；不能把长期 Project JWT/API key 直接发送给 Hasura，也不能把空 `connection_init` 当作正式 actor 支持。
- Realtime 每次 token exchange 必须通过 `projectAuth` 读取当前 Project Session，并同时支持同步/异步 `StorageAdapter`；不能只依赖客户端构造阶段的同步 session 缓存。
- Realtime channel 必须维护 `connecting / connected / reconnecting / error / closed` 状态，短期令牌续期或身份变化时关闭旧 socket、重新交换并恢复现有订阅；重新连接只恢复快照，不承诺重放断线期间事件。
- Realtime 快照只处理 GraphQL JSON 数据；复制时必须兼容没有原生 `structuredClone` 的小程序运行时，不得要求应用侧注入全局 monkeypatch。
- Realtime URL 解析必须由 SDK 共享实现同时覆盖显式 override 与 token 响应；不得依赖全局 `URL`，并须兼容没有 `URL` 或只有受限 HTTP(S) `URL` 的小程序运行时，同时继续拒绝 credentials、query、fragment 和无效 authority，不得要求应用侧 URL monkeypatch。hostname 只接受 ASCII（含调用方预先转换的 punycode）；不在 SDK 内隐式转换 Unicode IDN。
- `unsubscribe()` / `removeChannel()` 必须终止自动重连；只有调用方再次显式 `subscribe()` 才能启动新连接。
- SDK 认证头或 session 选择顺序变化时，必须用 API 端真实中间件契约验证，不能只做客户端单测。
- Apple 原生登录只通过 `projectAuth.appleLogin()` 发送一次性 authorization code、identity token、raw nonce 和首次登录 profile；SDK 不接收或保存 Apple `.p8`、client secret、provider refresh token 或 subject。成功后继续复用现有 Project Session storage/refresh/logout 契约。
- SDK prerelease 发包必须显式带 dist-tag：
  - 例如 `0.1.0-beta.3` 应使用 `npm publish --tag beta`
  - 不要把 beta 版本直接当作默认 `latest` 发布

## Subagent Triggers

- SDK、API 与 taro-app 的公开契约或身份调用链使用 `explorer`，形成可审查成果后使用 `reviewer`。
- 身份选择、凭证降级、会话回退或迁移兼容边界变更在最终验证前必须使用 `critical_reviewer`。

## 参考入口

- `docs/agent/playbooks.md`
- `docs/plans/2026-08-14-project-update-direction-analysis.md`
- `docs/plans/2026-03-17-taro-app-migration-design.md`
- `docs/plans/2026-03-18-druvia-sdk-adapter-requirements.md`
