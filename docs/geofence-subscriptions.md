# 地理围栏订阅模块

用户保存关注的区域（圆形围栏：中心点 + 半径）、选择分类与提醒频率；当范围内出现新的**公开可见**内容时收到通知。本文档描述数据模型、匹配管线、范围变更重算、通知去重与可见权限边界。

## 需求与对应机制

| 需求 | 机制 |
|---|---|
| 保存区域 + 分类 + 频率 | `geofence_subscriptions` 表：`center`/`radius_m`、`category_keys[]`、`frequency` |
| 范围变更后重算旧订阅 | `scope_version`/`recomputed_version` 游标 + worker 重算 |
| 通知去重 | `geofence_matches` 主键 `(subscription_id, feature_id)` + 原子认领 |
| 不越过可见权限 | 匹配、发送、读取三处都强制 `status='published' AND deleted_at IS NULL` |

## 数据模型（迁移 0003）

### `geofence_subscriptions`

| 列 | 说明 |
|---|---|
| `user_id` | 所有者；订阅是私有资源，所有读写按 `user_id` 隔离 |
| `center` / `radius_m` | 圆形围栏，`geography(Point,4326)`，半径 100–50000 米，GiST 索引 |
| `category_keys` | 分类数组；空数组表示全部分类 |
| `frequency` | `instant`（即时）/ `daily`（每日摘要）/ `weekly`（每周摘要） |
| `is_active` | 暂停后不参与匹配；重新启用会触发重算 |
| `scope_version` | 范围版本：中心/半径/分类变化或重新启用时 +1 |
| `recomputed_version` | worker 已完成重算的版本；`recomputed_version < scope_version` 即待重算 |
| `last_digest_at` | 上次摘要发送时间，用于 daily/weekly 节流 |

每账号最多 20 个订阅（应用层强制，`GEOFENCE_LIMITS.maxActivePerUser`）。

### `geofence_matches`

命中的事实表与去重记忆：主键 `(subscription_id, feature_id)` 保证同一订阅对同一内容只存在一条记录。`notified_at IS NULL` 表示待通知；已通知的行永久保留——即使后来范围缩走，也不会因范围反复调整而重复通知。

### `geofence_scan_events`

内容发布的落地事件（与 outbox 同一哲学：**数据库是事实源**，BullMQ 队列只是低延迟优化）。审核通过、管理员恢复、举报处理恢复三条发布路径都在**同一事务**内写入该表；worker 维护节拍兜底扫描 `pending` 行，队列丢失不会漏匹配。

## 匹配管线

### 新内容发布（scan）

1. 审核通过/恢复发布 → 事务内 `INSERT geofence_scan_events`，提交后 best-effort 入队 `scan-feature`。
2. worker `processFeatureScan`：
   - 校验内容当前 `published` 且未删除（不可见则直接标记 done，不产生匹配）；
   - `INSERT ... SELECT ... ON CONFLICT DO NOTHING` 匹配所有启用中的订阅（`ST_DWithin` + 分类过滤 + 排除订阅者自己的投稿）；
   - **只有本事务实际插入的行**才会触发即时通知（`RETURNING` 收集），通知行、邮件 outbox、`notified_at` 在同一事务提交。

### 范围变更（recompute）

1. `PATCH /subscriptions/:id` 检测到范围字段变化（或从暂停重新启用）→ `scope_version + 1`，提交后 best-effort 入队 `recompute-subscription`。
2. worker `recomputeSubscription`（行锁串行化）：
   - 删除已不在新范围内、且**尚未通知**的匹配（待发的摘要永远反映当前范围）；
   - 补插当前可见、落入新范围的存量内容（`ON CONFLICT DO NOTHING`，已通知过的不会重发）；
   - 游标只推进到事务开始时捕获的版本——重算期间再次变更的范围留待下一轮，不丢不错。

### 周期摘要（digest）

- 维护节拍每分钟检查到期的 daily/weekly 订阅：存在至少一条**当前可见**的未通知匹配才发送，避免空摘要。
- 认领是原子 `UPDATE ... SET notified_at = now() ... WHERE notified_at IS NULL`，并发下同一匹配只会被一个摘要认领；认领时再次 join 校验可见性。
- 一条站内通知 + 一封聚合邮件（复用现有 `notifications` + `outbox_events` 通道），正文最多列 5 条，其余汇总计数。
- 首次摘要立即发送（`last_digest_at IS NULL` 即到期），之后按 1 天/7 天节奏。

## 去重语义

- 去重键 = `(subscription_id, feature_id)`，在订阅的整个生命周期内有效，跨范围变更不重置。
- 三条可能产生通知的路径（即时 scan、重算即时补发、周期摘要）都遵循同一规则：**只有新插入的匹配行**或**原子认领成功的行**才会生成通知。
- 即时匹配与通知在同一事务提交，因此不存在“已插入匹配但未通知”的中间态；摘要认领与通知写入也在同一事务。

## 可见权限边界

通知绝不能泄露用户无权看到的内容。本项目内容的公开可见规则是 `status='published' AND deleted_at IS NULL`，模块在四个时点强制执行：

1. **匹配时**：scan 与 recompute 的 `INSERT ... SELECT` 只匹配当前可见内容；
2. **发送时**：即时通知与摘要认领都重新 join 校验状态——匹配后、发送前被隐藏/删除的内容不会发出；
3. **后台清理**：`purgeInvisibleMatches` 删除不再可见内容的未通知匹配（已通知的是历史与去重记忆，保留）；
4. **读取时**：`GET /subscriptions/:id/matches` 预览只返回当前可见内容，与地图查询规则一致。

此外：

- 订阅者不会收到自己投稿的匹配（`s.user_id <> f.owner_id`）；
- 只有 `users.status = 'active'` 的账号会收到通知（停用账号在发送处被过滤）；
- 通知正文只包含公开字段（标题、分类名、链接）；
- 订阅 CRUD 全部在服务端按 `user_id` 重新校验归属，不依赖前端隐藏。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/subscriptions` | 创建（需已验证邮箱）；每账号上限 20 |
| `GET` | `/subscriptions` | 我的订阅列表，含 `recomputePending` 同步状态 |
| `PATCH` | `/subscriptions/:id` | 更新；范围字段变化触发重算 |
| `DELETE` | `/subscriptions/:id` | 软删除，匹配与通知随之停止 |
| `GET` | `/subscriptions/:id/matches` | 命中预览（仅当前可见内容） |

请求体由共享 Zod 合约校验（`geofenceSubscriptionSchema` / `updateGeofenceSubscriptionSchema`）：半径 100–50000 米、分类键属于已知枚举且去重、经纬度必须成对更新。

## 故障与并发

- **队列丢失**：scan 事件与重算游标都在数据库里，worker 维护节拍（60 秒）兜底，队列仅降低延迟。
- **重算与编辑并发**：订阅行 `FOR UPDATE` 串行化；游标只推进到捕获版本，变更不丢。
- **scan 与 recompute 交错**：匹配插入幂等（主键冲突即忽略）；recompute 的删除只针对未通知行，已提交事务的 `notified_at` 会阻止误删（行锁等待后在 READ COMMITTED 下重检谓词）。
- **worker 崩溃**：所有多步写都在单事务内，失败整体回滚，下一节拍重试。

## 明确的产品取舍

- 围栏形状为圆形（中心 + 半径），`ST_DWithin` 走 GiST 索引；多边形围栏可在此基础上扩展。
- 即时频率不做额外节流——选择即时即接受每条命中一条通知；需要安静请选每日/每周摘要。
- 已发出的通知不撤回：内容事后被隐藏时，历史通知保留，但链接目标会按现有规则对无权限用户返回 404。
- 首次摘要在有可见新动态时立即发送，让新建/重算订阅有即时反馈，之后进入固定节奏。
