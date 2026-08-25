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
- 修改状态机时，同步检查 API 代理契约、Admin 轮询/按钮状态和 updater finalizer。

## Subagent Triggers

- Updater、API、Admin 与 Compose 间的更新状态协作使用 `explorer`。
- Docker socket、release manifest、迁移、回滚或 updater 自更新变更在最终验证前必须使用 `critical_reviewer`。

## Verification

- 至少覆盖无更新、下载、应用、健康检查失败、镜像回滚、finalizer 成功/失败和进程重启后的状态恢复。
- release-mode 本地演练使用 `docker-compose.release.yml --profile with-local-nginx`；生产使用 `with-nginx` 或外部反代，不混用 profile。

## 参考入口

- `docs/agent/design-decisions.md`
- `docs/plans/2026-07-28-compose-ota-update-implementation.md`
- `docs/plans/2026-08-14-project-update-direction-analysis.md`
