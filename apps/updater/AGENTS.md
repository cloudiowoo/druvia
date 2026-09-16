# Updater Agent Notes

适用于 `apps/updater` 目录及其子树。

## 模块职责

- 读取和校验 release manifest
- 拉取 digest 固定的镜像并写入 `.env.release`
- 编排备份、迁移、Compose apply、健康检查、回滚和 updater 自更新
- 将更新状态持久化到共享 update state volume

## 工作规则

- Updater 是唯一允许挂载 Docker socket 的应用服务；不要把该能力扩散到 API、Admin 或 Worker。
- 所有部署文件路径必须按宿主机视角解析。`DRUVIA_DEPLOY_DIR` 必须是目标主机 `docker/` 目录的绝对路径，并以相同路径挂入 updater。
- `.env.release` 中不得保留另一台机器的绝对路径。为空的路径覆盖项应由 `DRUVIA_DEPLOY_DIR` 推导。
- 镜像必须使用 manifest 中的 digest，不能以 `latest` 作为 OTA 应用依据。
- apply 成功不等于更新完成；必须经过服务健康检查和 finalizer 写回终态。
- 数据库自动回滚能力与镜像回滚分开声明。当前 dump 后的数据库恢复仍是人工流程，不得在 UI 中暗示为自动恢复。
- migration `027` 及后续版本执行发布文件回滚前，必须先停止 API/Admin/Worker，先持久启用 `file_rollback` gate，再在 gate 保持激活期间清理上次失败遗留的 holder，并在事务内取得 Data Access 全局排他 advisory lock 以排空已有 mutation、检查 Data Access v2 baseline/operation；存在 v2 状态时保留 gate 并拒绝 file-only rollback。检查通过后独立 PostgreSQL session 必须持有同一个全局 exclusive advisory lock，直到旧服务健康验证完成；pre-027 无 gate 表时 holder 不能自行退出，必须由 updater 显式释放。回滚各阶段及健康轮询持续核验具名 holder，holder 丢失时取消步骤并停止旧服务；gate 关闭时仍须验证 holder，释放确认也属于回滚保护范围。任一步失败必须再次停止旧 API/Admin/Worker，保留原始备份 operation ID 供恢复重试，不得在 `finally` 中无条件清除。updater 重启应根据持久 applyStage 判断：文件尚未切换可重试下载，文件可能已切换则先停服务再转为仅允许回滚的失败状态；手工回滚进程重启不得把新操作 ID 误当作备份 ID，恢复前须检查备份文件齐全。
- 回滚停止服务及 PostgreSQL gate/lock 探针必须直接使用 release Compose 固定的容器名执行 Docker 命令，不能要求刚切换的新 Compose 文件仍能解析；恢复旧文件后才能使用 Compose 启动旧服务。
- gate 关闭后的 holder 释放确认失败时，应尽力重新启用持久 gate，并在失败状态下保持旧 API/Admin/Worker 停止；不能误报为已完成回滚。
- 手工回滚应在写入 `rolling_back` 状态前选定实际备份目录并持久化其 operation ID；成功更新状态的 `operationId` 可能为 null，updater 重启后不能用新回滚操作 ID 代替备份 ID。
- 手工回滚的备份文件及版本完整性必须在进程内准入锁内、写入回滚阶段前预检；健康发布的备份丢失只能拒绝这次回滚，不能建立 `UPDATE_ROLLBACK_RECOVERY_REQUIRED` 阻断其他更新。只有实际进入回滚后失败才需要恢复围栏。具名服务的批量 Docker stop 若仅因某个容器不存在而失败，应继续确认其他服务停止；真实 stop 故障仍必须抛出。
- 成功 apply 需持久化独立的最近成功备份 ID 和目标版本；检查/下载/重启失败的通用 `operationId` 不得用于选备份。没有匹配当前已安装版本的备份记录时拒绝手工回滚，不按目录时间猜测。并发操作须在首次异步状态读写前占用进程内准入锁；回滚成功应按备份 env 更新 `currentVersion`。
- 持久 apply 状态的文件与父目录必须在切换发布文件前同步到磁盘；备份文件/目录应在 `backup_ready` 前同步，切换后的发布文件/目录应在迁移或服务启动前同步，回滚恢复的旧文件在启动旧服务前同步。早期阶段重启恢复也要核验活动发布文件是否仍匹配备份与原版本，缺文件或不一致时先停止服务并失败关闭。手工回滚在准入锁内按当前版本选定备份身份并与阶段一并持久化。
- 发布 `ready_to_apply` 前必须同步 staged manifest、Compose、release env 及目录；apply 前复验 manifest 与当前待应用版本/迁移、Compose SHA256、env 的版本与四个镜像 digest，任何漂移都不得进入备份或切换阶段。
- rollback gate 能力版本从 updater `0.2.0` 起提供，能力版本只能来自镜像内编译常量，不能由 Compose 环境变量声明。首次 migration `027` release 前必须先通过 updater-only bootstrap 发布不含 migration `027`、仍引用指定旧稳定 release 的不可变 Compose 与 API/Admin/Worker digest 的 manifest；bootstrap 必须在 Registry 写入前通过 PostgreSQL 17 rollback-gate 集成测试。bootstrap release 不得成为 GitHub latest，客户端必须临时使用显式版本 manifest URL。确认运行容器内的 updater 版本常量为 `0.2.0` 后，migration `027+` manifest 必须要求 `minUpdaterVersion >= 0.2.0`。
- 修改状态机时，同步检查 API 代理契约、Admin 轮询/按钮状态和 updater finalizer。

## Subagent Triggers

- Updater、API、Admin 与 Compose 间的更新状态协作使用 `explorer`。
- Docker socket、release manifest、迁移、回滚或 updater 自更新变更在最终验证前必须使用 `critical_reviewer`。

## Verification

- 至少覆盖无更新、下载、应用、健康检查失败、镜像回滚、持久 rollback gate 的并发排空/失败保留、finalizer 成功/失败和进程重启后的状态恢复。
- release-mode 本地演练使用 `docker-compose.release.yml --profile with-local-nginx`；生产使用 `with-nginx` 或外部反代，不混用 profile。

## 参考入口

- `docs/agent/design-decisions.md`
- `docs/plans/2026-07-28-compose-ota-update-implementation.md`
- `docs/plans/2026-08-14-project-update-direction-analysis.md`
