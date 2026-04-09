# Druvia Playbooks

常用操作手册。用于新会话快速恢复高频验证和排查动作。

## 运行常用验证

- API 定向构建：
  - `pnpm --filter @druvia/api build`
- Functions 相关单测：
  - `pnpm test tests/unit/functions-controller.test.ts tests/unit/functions-service.test.ts tests/unit/api-app.test.ts`
- Edge Function internal GraphQL 相关单测：
  - `pnpm test tests/unit/functions-internal-token.test.ts tests/unit/functions-internal-graphql.test.ts tests/unit/druvia-helper.test.ts`
- Admin 侧 invoke auth helper 单测：
  - `pnpm test tests/unit/admin/function-invoke-auth-mode.test.ts`

## 数据库迁移

- 执行全部未应用迁移：
  - `pnpm --filter @druvia/api exec node --import tsx/esm src/cli/migrate.ts up`

## SDK 发布

- SDK 包目录：
  - `cd /Users/cloudio/Developer/nodejs/Druvia/packages/sdk`
- 发版前最小验证：
  - `pnpm --filter @druvia/sdk build`
  - `pnpm test:sdk`
- 先检查当前版本与 npm 登录状态：
  - `npm pkg get version`
  - `npm whoami`
- 预发布版本如 `0.1.0-beta.3` 不能直接裸跑 `npm publish`：
  - npm 11 会要求显式指定 dist-tag
  - 发布到 beta 通道当前最新版本应使用 `npm publish --tag beta`
- 若 npm 账号开启 2FA：
  - `npm publish --tag beta --otp <一次性验证码>`
- 正式稳定版才使用默认 `latest`：
  - 先把 `packages/sdk/package.json` 改成不带 prerelease 后缀的版本，例如 `0.1.0`
  - 再执行 `npm publish`
- 发布后验证 dist-tag：
  - `npm dist-tag ls @druvia/sdk`
- 若需要把某个 beta 版本显式切成默认 `latest`：
  - 这不是常规 prerelease 发布步骤，默认不建议使用
  - 执行前应明确接受 `npm i @druvia/sdk` 将默认安装该 beta 版本
  - 示例：
  - `npm dist-tag add @druvia/sdk@0.1.0-beta.3 latest`
- 若只是测试分发，不想直接发 npm：
  - `npm pack`
  - 产物为 `druvia-sdk-<version>.tgz`
- 常见失败优先排查：
  - `You must specify a tag using --tag when publishing a prerelease version.`
  - 结论：当前版本是 prerelease，改用 `npm publish --tag beta`
  - `404 Scope not found`
  - 结论：当前账号缺少 `@druvia` scope 创建或发布权限

## 应用侧接 beta SDK

- beta 持续期内，应用侧不要把“是否跟进最新 beta”混同为“是否跟进默认 latest”
- taro-app 若当前使用 `pnpm-lock.yaml`，不要混用 `npm install`：
  - 优先使用 `pnpm add` / `pnpm up`
- 当前已知 taro-app 迁移仓库实际使用 `npm + package-lock.json`
- 该仓库在升级与 SDK 无关的依赖树时，可能触发既有 RN/Taro peer 冲突：
  - `@tarojs/components-rn@4.0.12` 要求 `@react-native-picker/picker@2.6.1`
  - `@ant-design/react-native@5.0.0` 要求 `@react-native-picker/picker@^1.9.10`
  - 因此仅升级 `@druvia/sdk` 时，允许使用 `--legacy-peer-deps` 跳过这类历史 peer 校验
- 对 taro-app / H5 这类迁移项目，推荐分两种模式：
  - 联调分支跟进 beta 通道最新版本：
  - `pnpm add @druvia/sdk@beta`
  - 后续更新：
  - `pnpm up @druvia/sdk@beta`
  - 主分支或待发布版本锁定具体 beta 版本：
  - `pnpm add @druvia/sdk@0.1.0-beta.3`
  - 后续人工切到下一版：
  - `pnpm up @druvia/sdk@0.1.0-beta.4`
- 若使用 npm 而不是 pnpm：
  - 跟进 beta 通道：`npm install @druvia/sdk@beta`
  - 锁定具体版本：`npm install @druvia/sdk@0.1.0-beta.3`
  - 若命中既有 peer 冲突，但本次只是在升级 SDK：
  - `npm install @druvia/sdk@beta --legacy-peer-deps`
  - 或锁定具体版本：
  - `npm install @druvia/sdk@0.1.0-beta.3 --legacy-peer-deps`
- 若应用和 Druvia 仓库本地联调：
  - 优先使用 workspace 或 link，而不是反复发 npm 包
  - 现有迁移文档示例为 `pnpm add @druvia/sdk@workspace:*`
- 应用侧升级前，先检查“当前声明版本 / 当前已安装版本 / beta 通道目标版本”：
  - 当前 `package.json` 声明：
  - `npm pkg get dependencies.@druvia/sdk`
  - 当前本地已安装版本：
  - `npm ls @druvia/sdk`
  - 当前 beta 通道指向版本：
  - `npm view @druvia/sdk@beta version`
  - 当前所有 dist-tag：
  - `npm dist-tag ls @druvia/sdk`
- 若 taro-app 实际用 `pnpm` 管理依赖，可用对应命令：
  - 当前本地已安装版本：
  - `pnpm list @druvia/sdk`
  - 升级到 beta 通道当前最新版本：
  - `pnpm up @druvia/sdk@beta`
- 实际安装行为要区分：
  - `package.json` 写 `@druvia/sdk: beta` 代表“跟 beta 通道”
  - 但 lockfile 仍会锁住当前解析到的具体版本，不会每次安装都自动漂到最新
  - 需要显式执行 `pnpm up @druvia/sdk@beta` 或 `npm install @druvia/sdk@beta` 才会真正更新到新 beta
- `--legacy-peer-deps` 只适合“本次仅变更 SDK、且已知冲突来自项目既有 RN/Taro 依赖”的场景：
  - 它不会修复根因
  - 若后续要调整 React Native / Taro 相关依赖，仍应回到正常 peer 约束下处理
- 推荐默认约定：
  - SDK 发布侧持续维护 `beta` dist-tag 指向最新 beta
  - 应用侧默认使用 `@beta` 安装或升级
  - 不建议把 beta 强行切到默认 `latest`，否则未显式声明 beta 通道的应用也可能被动吃到预发布版本

## Functions invoke 配置排查

如果在 Admin UI 更新函数时报 500，并带有：

- `column "invoke_auth_mode" of relation "druvia_functions" does not exist`

优先结论：

- 后端字段已接入
- 数据库缺少 `015_function_invoke_auth_mode` 迁移

先执行迁移，再重试页面保存。

## Edge Function Internal GraphQL 排查

如果新函数使用 `druvia.graphql()` 失败，优先检查：

- API 是否已注册 `/api/internal/functions/graphql`
- 函数 invoke 是否向 Worker 注入了 `internalToken`
- 若未显式注入 `apiBaseUrl`，确认 Deno Worker 进程已配置 `DRUVIA_API_URL`
- 函数代码是否仍在依赖 `DRUVIA_GRAPHQL_URL` / `HASURA_ADMIN_SECRET`
- Hasura admin secret 是否仅保留在 API 服务端，而不是项目函数 secrets 中

## 文档回填手册

发生下列情况后，记得同步文档：

- 权限模型变化：更新 `docs/agent/project-memory.md`
- 长期架构决策变化：更新 `docs/agent/design-decisions.md`
- 新模块局部规则变化：更新对应子目录 `AGENTS.md`
- 完整设计或实施过程：新增 `docs/plans/YYYY-MM-DD-*.md`
