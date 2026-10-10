# Project Email/Password Auth 设计与实施方案

状态：设计与实施计划，尚未实施
日期：2026-10-07
Owner：Druvia Project Auth

## 1. 背景和事实基线

PITCHETCH 需要不依赖 Apple Developer 资格的正式 Project User 登录。平台 `/auth/register`、`/auth/login` 操作的是平台用户，不能交给应用终端用户使用。项目认证页已有 `Email/Password` provider 开关、`passwordMinLength`、`requireEmailVerification` 和 `allowSignup`，但前两项与 email provider 目前只有配置读写，没有项目级邮箱凭证、注册、登录或验证运行链路。`allowSignup` 已用于现有 WeChat/Apple 首次登录创建用户，不是邮箱专用配置。当前数据库默认最小密码长度 8、允许注册、无需邮箱验证；UI 显示的 6-128 范围也不是正式 Email/Password 安全合同。

现有 Project Session、Project User、Hasura actor、refresh、账户删除和项目 Schema restore 是本功能必须复用的边界；不能新增另一种平台身份或将密码放进项目业务表。本文只定义实现方案，不代表能力已经上线。主线依赖 [Apple Project Auth](2026-08-28-apple-project-auth-provider.md) 和 [Project Account Self-Deletion](2026-09-09-project-account-self-deletion.md)。

## 2. 目标、范围与方案选择

目标：项目级 Email/Password 注册、登录和 Project Session 生命周期；复用现有两个配置开关；SMTP 可选；邮箱验证开启时真实生效；无 SMTP 时可运行未验证邮箱模式；支持密码更改、受控重置和项目账户删除；SDK、Admin 与本地/发布部署一致。

不做：平台用户邮箱登录改造、基于 email 自动合并 Apple/WeChat 身份、项目 Schema 存储密码、任意客户端指定 Project User、全局邮件服务或营销邮件、首次版本的通用多 provider 账号绑定、绕开已有账户删除 fence。PITCHETCH 不需修改商业 Schema 来实现认证。

方案比较：

| 方案 | 结果 |
| --- | --- |
| 在项目 `users` 表新增密码列 | 各项目 Schema 异构，容易暴露于业务 GraphQL/备份，不采用。 |
| 委托外部 OIDC/邮箱服务 | 可作为部署者未来替代方案，但不满足管理页“内置 Email/Password”的语义，不作为本功能实现。 |
| `public` 项目身份绑定 + 独立邮箱凭证 | 复用 Project Session、按项目隔离，凭证不进入 Hasura；采用。 |

首版不自动绑定已有同邮箱 Project User。碰到业务表的唯一邮箱冲突时，不向公开注册请求暴露“邮箱已存在”差异；由平台受控审计和管理员处理，且不能因为邮箱相同就把未验证账号接到 Apple 身份上。

## 3. 配置与 SMTP 模式

继续使用 `druvia_project_auth_providers(provider='email', enabled)`、`druvia_project_auth_config.allow_signup`、`require_email_verification` 和 `password_min_length`，不增加第二组同义开关。`allowSignup=false` 只阻止新邮箱自助注册，不影响已有用户邮箱登录；现有 Apple/WeChat 的首次创建行为保持不变。旧版本 Email 开关只是占位，迁移 `030` 必须将所有既存 `provider='email'` 记录显式置为 `enabled=false`，并在 `druvia_activity_logs` 记录项目 ID 和此前状态供管理员检查；新版本需由具备 `auth:manage` 权限的管理员再次手动启用，不能因升级自动开放公开注册。新项目默认关闭 Email provider。

Email provider `enabled=false` 对该 provider 采用明确的紧急停用语义：拒绝新注册、登录、验证、密码重置/修改、Email refresh 和后续受管 Email access 请求；禁用写入与当前 Email 会话撤销在同一项目锁下完成。已经签发的短期 Realtime token/已建立的 WebSocket 的限制见第 4 节。这与当前 Apple “禁用仅阻止新登录”的行为不同，不改变 Apple 语义；管理页应准确说明差异。

| Email provider | 允许注册 | 要求验证 | SMTP | 行为 |
| --- | --- | --- | --- | --- |
| 关 | 任意 | 任意 | 任意 | 邮箱注册、登录均不可用。 |
| 开 | 关 | 关 | 任意 | 已有邮箱账号可登录；自助注册拒绝。 |
| 开 | 关 | 开 | 已配置且可用 | 仅已验证邮箱可登录；自助注册拒绝。 |
| 开 | 开 | 关 | 未配置 | 允许自助注册和登录；`email_verified=false`，无邮件找回。 |
| 开 | 开 | 关 | 已配置 | 与无 SMTP 相同；未验证邮箱不能仅凭邮件找回，不能悄悄把未验证邮箱变成已验证。 |
| 开 | 开 | 开 | 已配置且可用 | 注册先发送验证邮件，验证成功前不签发 Project Session。 |
| 开 | 开 | 开 | 未配置 | 注册/重发拒绝且不创建账号；已有已验证账号仍可登录。 |
| 开 | 开 | 开 | 已配置、投递暂时失败 | 只保留不可登录的 pending signup 与持久 outbox，后台重试；邮件未验证前不签发 Session。 |

SMTP 是**部署级可选适配器**，从服务端环境变量读取 host、port、TLS、发件人和凭证；不保存到项目配置或客户端。没有 SMTP 时 UI 仍允许启用 Email provider，但开启“要求邮箱验证”必须被 Admin/API 拒绝，或在历史配置已开启时由注册运行时失败关闭。已配置不等于保证投递成功：受理注册须将 pending signup、challenge 和 outbox 原子持久化，`202` 仅表示请求已受理；发送失败由后台重试，超过 challenge 有效期后清除并允许重发。SMTP 一时不可用不能降级为免验证注册。要求验证从关变开时，已有未验证账号停止登录，须通过真实邮件验证流程提升状态；不能静默把历史账号标记为已验证。关闭开关不清除已保存的 verified 状态，也不自动验证其他邮箱。`verification/resend` 同时支持未完成注册与历史未验证账号，两者使用不同 challenge purpose，验证后分别创建账号或更新 verified 状态。

无 SMTP 时允许自助注册仅表示“以邮箱字符串作为登录名”，**不证明邮箱归属**。项目可以在 `allowSignup=true` 下使用该模式；管理页需明确提示抢注邮箱、无法邮件找回和不能自动关联身份的风险。生产推荐按项目评估是否关闭自助注册；不是代码强制禁用。

`passwordMinLength` 保留原字段，但正式单因素密码下限设为 15，接受 15-128 个 Unicode code point 且最多 1024 UTF-8 bytes；现有小于 15 的配置在迁移中调整为 15，API/UI 禁止再写小于 15。该变更不影响 Apple/WeChat 的无密码登录。密码支持空格和 Unicode，哈希前稳定使用 NFC 规范化，不设组成规则，不截断，使用常见/泄露密码阻断与 Argon2id 参数基准测试。安全依据：[NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/)、[OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。

## 4. 身份与数据合同

新增迁移 `030_project_email_password_auth`：

- `public.druvia_project_email_credentials`：`project_id`、`identity_id`、规范化登录邮箱、Argon2id 参数化 hash、`email_verified_at`、`credential_version`、`disabled_at`、时间戳；`UNIQUE(project_id, canonical_email)` 和 `UNIQUE(identity_id)`。`identity_id` 外键指向现有 identity 表并使用 `ON DELETE CASCADE`；在同一事务确认对应 identity 是同项目、`provider='email'` 且 active，不能借外键存在就接受跨项目 identity。不向 Hasura track，也不返回 hash。
- `public.druvia_project_auth_identities` 新增 `provider='email'` 记录，`issuer='druvia:email'`，`subject` 为不可猜测、与邮箱无关的稳定随机 ID；`project_user_id` 指向当前项目 Schema 的 `users.id`。Core 凭证表中的邮箱才是登录/重置事实源；项目 `users.email` 只是 profile/显示快照，业务侧修改它不能改变登录邮箱或 verified 状态。邮箱变更不会改变 subject 或 Project User ID；首版不提供邮箱变更 API，Admin 必须分开显示 profile 邮箱与认证邮箱，不能把前者当作已验证联系地址。
- 邮件模式使用短期、单用途验证/重置 challenge 表、pending signup 表以及持久 outbox。pending signup 只保存规范化邮箱与 Argon2id 密码 hash，不保存明文密码；challenge 只保存带服务端密钥的 code 摘要、过期时间、尝试次数和消费时间；outbox 的邮件材料以现有 `SECRETS_ENCRYPTION_KEY` 的专用用途加密并在完成/过期后清除。重置凭据摘要密钥使用该稳定密钥的独立用途派生值，不与 Apple、账户删除或设备擦除密钥混用。启用 Email provider 前必须校验该密钥有效且不是开发回退值，即使未配置 SMTP 也一样。重复注册同邮箱不能覆盖尚未验证的密码 hash，以免攻击者抢占验证流程。不能把原始验证码、密码、邮件链接或完整邮箱写到日志/Redis key。无 SMTP 不建立无法交付的邮件 challenge。
- 项目凭证不允许跨项目查询、绑定或复用；项目 Schema 无法建立外键，创建/删除/restore 通过项目锁和同一 PostgreSQL 事务检查关联。邮箱规范化采用确定性、版本固定的解析规则：首版仅支持 ASCII local part，域名转 ASCII/小写，local part 按产品规则小写；不做 Gmail 风格点号、加号别名折叠。迁移前用测试固定大小写碰撞和非法地址行为。

注册不因一个未经验证的邮箱而自动绑定已有 Project User。无验证模式可在锁/事务内直接创建用户、email identity 和凭证；验证模式先建立不具登录能力的 pending signup/challenge，验证成功后才在锁/事务内原子创建用户、identity、凭证并消费 challenge。并发注册/验证只产生一个用户，已有邮箱或项目 profile 邮箱冲突一律用防枚举响应处理，冲突的真实原因仅留给受控管理审计。项目表如要求非空 `provider_id` 等不兼容列，应明确返回 `PROJECT_USER_SCHEMA_UNSUPPORTED`，不得写假 provider ID 绕过；实现前须检验 PITCHETCH 与 taro-app 当前 users Schema 能力。Email 登录、refresh 和身份敏感写入还必须检查项目用户当前为 active，不能只校验凭证表。

Email 登录签发**现有标准 Project Session**，JWT `sub` 始终是 Project User ID，`provider='email'`；SDK 仍走现有 session 存储与 refresh/logout。Email access token 增加 `credentialVersion` claim，Email refresh token 行保存 `identity_id` 和签发时版本，缺任一项或当前数据库凭证/identity/provider 状态不可读时失败关闭。修改/重置密码、管理员禁用凭证或账户删除时，增加版本并撤销该 Email 身份的 refresh token；refresh 校验、轮换和版本比较必须在同一项目/identity 锁保护的事务内完成，不能在比较后允许并发重置生成新 token。所有受管 API/GraphQL/Realtime token exchange/RPC/Functions/Storage 入口检查版本；Functions 内部调用的短期 token/actor 还须携带原始 Email 凭证版本或等效不可变引用，并在每次访问前复验，不能只凭 `projectUserId` 重建旧权限。凭证状态存储不可用时失败关闭，旧 Email access token 在下一次受管请求失效；已建立的 WebSocket 连接和先前交换的短期 Realtime token 是否可立即断开需要独立验收，未解决前不得承诺“所有已建连接实时撤销”。非 Email Project Session 不因本表缺失而改变行为。账户删除另以已有权威 operation/fence 为事实源。

## 5. API、SDK 与错误语义

所有公开地址均位于 `/api/v1/projects/:projectId/auth/email/*`；公网入口必须使用 HTTPS，本地 loopback 可走 HTTP，不能在反向代理内部 HTTP 链路上错误拒绝请求。JSON 字段用项目 SDK 的 camelCase；成功签发会话沿用当前 `ProjectSession` 形状。

| 接口 | 主要输入 / 结果 |
| --- | --- |
| `POST register` | `{ email, password }`；不论验证模式或邮箱是否已存在，成功受理统一返回 `202` 且不签发 Session；无验证模式由用户随后单独 `login`。 |
| `POST verify` | `{ email, code }`；pending signup 验证后原子创建身份并返回标准 Project Session；历史未验证账号仅标记 verified，不自动签发 Session；过期、错误、重复使用统一受控失败。 |
| `POST login` | `{ email, password }`；成功返回标准 Project Session；错误邮箱/密码、未验证或禁用凭证不泄露账号存在性。 |
| `POST verification/resend` | `{ email }`；有 SMTP 且满足状态时重发；对外统一 `202`。 |
| `POST password-reset/request` | `{ email }`；仅 SMTP 可用且邮箱已经验证时发送，其他邮箱同样返回 `202`；无 SMTP 返回不含邮箱存在性的 `503 EMAIL_DELIVERY_NOT_CONFIGURED`。 |
| `POST password-reset/confirm` | `{ email, code, newPassword }`；单次消费 challenge，递增凭证版本，撤销旧 Email refresh；不自动登录。 |
| `POST password/change` | 当前 Email Project Session + `{ currentPassword, newPassword }`；密码验证后换代并要求客户端重新登录。 |

无 SMTP 的遗忘密码不提供“固定验证码”或开发后门。首版提供项目管理员可审计的**一次性重置凭据**：管理端 `POST /api/v1/projects/:projectId/auth/email/admin/password-reset` 接收项目内 `projectUserId`，只在管理员完成线下身份核验后通过现有 project capability guard 受理，返回短时有效、只展示一次的 reset code；管理员通过独立渠道交付给本人，用户仍用公开 `password-reset/confirm` 设置自己的新密码。管理端不得通过邮箱字符串查找或重定向到其他 Project User。管理员重置凭据只能重置密码，不得同时把未验证邮箱标记为已验证；不能由管理端直接设定可知晓的用户密码。管理员重置和邮件重置复用同一消费/换代流程，凭据 purpose 必须区分且不能跨项目使用。平台 `admin` 登录本身不构成管理权限。

`login` 的失败响应、`register` 已存在邮箱和 `reset/request` 均使用防枚举文案和接近一致的处理时延；按项目、IP 与邮箱摘要限流，challenge 还有持久尝试上限。过期、重放、跨项目、服务配置缺失和数据库故障要分类，但不得把原始数据库/SMTP错误、邮箱、token 或密码返回客户端。参考 [OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)。

`packages/sdk/src/modules/project-auth.ts` 增加 `emailRegister`、`emailVerify`、`emailLogin`、`emailResendVerification`、`requestPasswordReset`、`confirmPasswordReset`、`changeEmailPassword`；只有签发 session 的方法更新 SDK session storage。`packages/sdk/src/modules/auth.ts` 的平台登录方法保持不变，不隐式回退 Platform Session；Taro/微信无全局 URL 等既有兼容回归必须通过。

## 6. 账户删除、数据恢复与运维边界

现有自助删除 intent/confirm 仅支持 Apple 身份和新鲜 Apple credential。正式 Email provider 的生产闭环需扩展该状态机：Email Project Session 可发起 intent；confirm 使用当前密码重新认证、短期 intent 绑定和 identity generation；接受后沿用项目 cleanup Hook、Storage 清理、恢复 fence 和设备擦除 obligation，Email 分支不执行 Apple revoke，`provider_revocation_status='not_required'`。目标始终来自当前 Project Session，不能由请求体传入。`assertProjectSessionUsable` 对 Email `deletion_pending` identity 也要失败关闭，不能只识别 Apple。相同 Project User 如未来绑定多身份，需先另行定义多身份删除合同；本版本禁止 Email/Apple 自动绑定。

管理端直接删除用户/项目仍受 active Email identity 阻挡，不能跳过业务清理与 fence；当前“Apple provider authorization must be revoked”固定错误需要按身份类型改为准确的 `ACCOUNT_DELETION_REQUIRED` 等受控错误，不能提示去执行不存在的 Email revoke。用户状态被管理员设为 disabled 后，Email 登录、refresh 和受管 access 均拒绝，不仅阻止下一次密码登录。

删除 accepted 后，原 Email 凭证和身份在清理完成前不得再次登录，也不得以相同规范化邮箱创建第二个用户。现有清理执行器删除 identity 后，凭证经外键级联消失；清理完成后允许将该邮箱注册为**全新**身份，必须生成新的 subject/Project User ID，不能复用旧 identity generation 或旧 Project Session。原删除 fence 继续按旧 subject/Project User ID 防止旧账号在项目 Schema restore 后复活。restore 前后若平台 Email identity 与恢复的项目用户不一致，保持 runtime gate 并进入人工恢复，不能靠邮箱匹配重绑，也不能让新账号继承旧账号数据。

为了不阻塞开发，邮箱注册/登录可先在非生产项目验收；**在启用了账户删除能力的项目上，Email 自助删除通过真实联调之前，不得启用面向正式用户的 Email provider**。不得关闭项目账户删除开关来绕开该门禁。项目 Schema restore 后须按既有操作重放已接受删除 fence，再允许 Email 登录/注册；整库灾难恢复的外部删除账本仍未实现，不宣称可抵御整库旧备份复活。

迁移 down 只能在无 Email 凭证、identity、pending challenge/outbox 和相关删除记录时允许；已有数据时拒绝，以免旧 Email 会话与身份映射失配。未升级数据库时新 API 因 migration floor 失败启动，旧 API 因 ceiling 不能读取新库；因此需要受控停写、备份、迁移、再启动匹配镜像，不能混跑旧/新 API。SMTP 密钥与凭证只在服务端环境，`.env.example`、`docker/.env.example` 只放占位；生产备份需包含凭证表和邮箱 challenge/outbox 加密密钥，密钥丢失应有明确失败处理。

## 7. 实施顺序

以下每批均先写失败测试、再实现、最后复核；一批完成不代表整个功能可发布。

1. **迁移与配置合同**：新增 `migrations/030_project_email_password_auth.{up,down}.sql`，同步 `apps/api/src/db/migration-compatibility.ts`、release manifest target、测试和迁移文档；迁移修正小于 15 的密码最小长度，为账户删除增加 Email 分支所需的约束/状态，将旧占位 Email provider 统一禁用并记录旧状态。检查现有项目 schema、Apple identity、删除表与 restore 锁的兼容；验证空库、旧库升级和 down 拒绝条件。
2. **邮箱凭证与无 SMTP 基线**：在 `apps/api/src/modules/project-auth/` 增加独立 Email repository/service/controller，复用项目锁、schema capability、Project Session 和 actor 检查；实现无验证模式注册/登录、provider 开关、allowSignup、Argon2id、凭证版本与限流。将 Email token 版本校验穿透所有受管入口及 Functions 内部 token，而不只在普通 HTTP middleware 检查；并发重置/refresh 必须由事务测试证明不会生成旧版本新 token。为 `/auth/email/login` 配置明确静态路由，并测试其不会落入现有 `/:provider/login` OAuth code exchange。
3. **SMTP 与验证**：加入可选 SMTP 配置/发送适配器、持久 outbox/投递执行器及 verification challenge；Admin/API 在验证要求开启而 SMTP 未就绪时拒绝开启，运行时再次 fail closed；实现验证/重发、过期、重试、重放与进程重启恢复。
4. **密码生命周期**：实现当前密码修改、邮件重置和无 SMTP 的管理员一次性重置；全部递增 credential version，撤销旧 Email refresh，验证受管访问入口拒绝旧 access；未知邮箱响应一致。
5. **账户删除闭环**：复用现有删除 operation/fence/Hook/恢复路径，增设 Email 新鲜密码确认分支、`deletion_pending` 与 disabled 用户的全链路拒绝、管理端直接删除保护及测试；不改变 Apple revoke 语义。验证旧 token、重新登录、跨项目、重复确认及 restore 后不复活。
6. **Admin 与 SDK**：认证页显示 Email provider 的真实可用状态、SMTP 未配置提示、无验证风险、可编辑的注册/验证开关和有效密码下限；SDK 加 Email 方法与 Project Session 存储测试。修正文案，不在上线前继续把占位开关当成功能完成。
7. **联调与发布**：真实 PostgreSQL + Hasura 验证 Project Session 的 GraphQL、Realtime、RPC、Functions、Storage 身份传播；跑 taro-app/H5/小程序兼容回归和 PITCHETCH 非生产双用户矩阵。更新本地 Compose、PostGIS、`docker-compose.release.yml`、GHCR/自建 Registry manifest 与 OTA migration 门禁；stable 生产由运维独立批准，不因本文合并自动发布。

建议主要改动文件：`apps/api/src/modules/project-auth/*`、`apps/api/src/modules/auth-admin/*`、`apps/api/src/middleware/auth.ts`、`apps/api/src/db/migration-compatibility.ts`、`migrations/030_*`、`apps/admin/src/app/t/[tenantId]/p/[projectId]/auth/page.tsx`、`packages/sdk/src/modules/project-auth.ts`、`scripts/release/generate-manifest.mjs`、`docker/.env.example` 和相邻测试。依赖增加前验证 Node 22 Alpine 以及 amd64/arm64 镜像构建，不引入仅适用于本机的 native binary。

建议新增 `tests/integration/project-email-auth.test.ts`、`tests/integration/project-email-auth-hasura.test.ts`，并扩展现有 `tests/sdk/project-auth.test.ts`、`tests/integration/auth-admin.test.ts`、`tests/unit/project-auth.routes.test.ts`、`tests/unit/project-account-deletion-service.test.ts`。本地先用 `pnpm vitest run <测试文件>` 跑失败/成功闭环，再运行 `pnpm test`、构建和真实 PostgreSQL + Hasura 联调；外部 SMTP 使用隔离测试收件服务，不发送真实用户邮件。

## 8. 验收门禁

- 无 SMTP：Email provider 开 + allowSignup 开 + 验证关时，两名用户可注册、登录、刷新、退出，邮箱始终为未验证；allowSignup 关时新用户不能注册，旧用户仍能登录；忘记密码只能由受授权管理员发起一次性重置。
- 有 SMTP：要求验证时注册前不签发 session，验证后才可登录；历史未验证账号在切换开关后先拒绝登录、再可通过邮件验证；配置缺失、SMTP 故障、过期/错误/重放 code 都不能创建已验证可登录身份；重复请求和并发验证无重复 Project User。
- 同邮箱在不同项目隔离；已存在 Apple/WeChat 相同邮箱不自动合并；非法项目 Schema 和跨项目 token 均失败关闭。未知邮箱、未验证邮箱、错误密码响应不泄露身份状态。
- 密码修改/重置或禁用 Email provider 后旧 Email refresh 和受管 HTTP access 失效；GraphQL、Realtime token 兑换、RPC、Functions 内部 GraphQL/Storage、直接 Storage 走同一检查。已建立 WebSocket 的撤销行为单列证据，不以 HTTP 测试代替。
- 升级前已经打开的 Email 占位开关在 migration `030` 后保持关闭，管理员重新授权启用之前公开注册不生效；删除清理中同邮箱不能重注册，完成后新注册不能继承旧 Project User/数据，restore 若身份不一致仍保持 gate。
- Email 自助删除通过 PITCHETCH cleanup Hook、账户 fence 和 restore 回放；`deletion_pending`/disabled 的 Email access、refresh 均不能继续；管理端不能直接删除 active Email 用户或绕过 fence，错误提示不误称 Apple revoke；Apple 删除路径与 taro-app 现有登录不回归。
- 迁移 030、manifest、API floor/ceiling、本地/Global/生产 Compose、GHCR/自建 Registry release 两路一致；数据库备份和关键密钥可恢复。文档中逐项记录测试命令、环境、结果和未闭环项后，才可改为“已实施”。

## 9. 实施记录

尚未开始实现。本文不修改数据库、运行服务或项目认证配置。
