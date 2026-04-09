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
- `database/graphql` 应与 `rpc/functions` 共用项目侧 token 选择顺序：
  - 有 project session 时优先带 project token
  - 否则再回退 platform token
- SDK prerelease 发包必须显式带 dist-tag：
  - 例如 `0.1.0-beta.3` 应使用 `npm publish --tag beta`
  - 不要把 beta 版本直接当作默认 `latest` 发布

## 参考入口

- `docs/agent/project-memory.md`
- `docs/agent/playbooks.md`
- `docs/plans/2026-03-17-taro-app-migration-design.md`
- `docs/plans/2026-03-18-druvia-sdk-adapter-requirements.md`
