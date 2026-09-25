# 地理围栏订阅

用户可以保存关注的地图区域（圆形围栏：圆心 + 半径），选择感兴趣的分类与提醒频率；当范围内出现新发布的地点，或订阅范围本身发生变化时，系统会重新匹配合适的内容并通知用户。通知严格去重，且绝不越过内容的可见权限。

## 数据模型

迁移：`packages/db/migrations/0003_geofence_subscriptions.sql`。

### `geofence_subscriptions`

| 列 | 说明 |
|---|---|
| `user_id` | 订阅归属用户，`ON DELETE CASCADE` |
| `center` | `geography(Point, 4326)` 圆心，GiST 索引 |
| `radius_m` | 半径，100–20000 米（CHECK 约束，限制匹配成本） |
| `category_keys` | `text[]`，空数组表示全部分类 |
| `frequency` | `instant` / `daily` / `weekly` |
| `is_active` | 停用期间不参与匹配、不发送摘要 |
| `scope_version` | 范围（圆心/半径/分类）每次变更 +1，记录在匹配行上便于审计 |
| `next_digest_at` | 摘要频率的下一次发送时刻；即时频率为 NULL |

### `geofence_subscription_matches`

去重基座。每个 `(subscription_id, feature_id)` 至多一行（主键），记录"该订阅曾经命中过该要素"：

- `notified_at IS NULL`：已命中、等待进入下一次摘要；
- `notified_at` 已设置：已通知，终身不再重复通知；
- 行在范围编辑后保留，因此"缩小范围再扩大"不会让同一地点再次触发通知；
- 订阅删除时级联清除。

## 匹配触发点

1. **要素发布**（`POST /moderation/features/:id/approve`）：在同一事务内调用 `matchSubscriptionsForFeature`，对所有启用的订阅做增量匹配。修订再发布（位置可能移动）走同一路径。
2. **要素恢复可见**（审核恢复、举报处理恢复）：同样调用增量匹配；历史匹配行保证不重复通知。
3. **订阅创建**（`POST /me/subscriptions`）：对存量已发布要素全量重算（`recomputeSubscription`）。
4. **订阅范围变更 / 重新启用**（`PATCH /me/subscriptions/:id`）：仅当圆心、半径或分类集合实际变化（`isScopeChange`）时递增 `scope_version` 并重算；改名称、改频率不触发重算。

匹配 SQL 统一要求：`status = 'published'`、`deleted_at IS NULL`、`ST_DWithin(center, geom, radius_m)`、分类过滤（空数组放行全部）。

## 通知去重

- 所有匹配写入都是 `INSERT ... ON CONFLICT (subscription_id, feature_id) DO NOTHING`，只有真正插入的行（`RETURNING`）才会产生通知——数据库层面保证同一订阅对同一地点终身只通知一次，并发审批与重算也不会重复。
- 创建/重算命中多个存量地点时，即时频率合并为**一条**汇总通知（"新增 N 个地点"），不会刷屏；摘要频率则累积到下一期摘要。
- 频率从摘要切回即时时，先 `flushPendingDigest` 结清积压匹配，避免滞留永不符合发送条件的行。

## 提醒频率

- `instant`：匹配成功立即通知（站内通知 + outbox 邮件）。
- `daily` / `weekly`：匹配行保持 `notified_at IS NULL`，由 worker 的 `processGeofenceDigests`（maintenance tick 每分钟执行）在 `next_digest_at` 到期时聚合成一条摘要通知 + 一封邮件，随后推进日程（`+1 day` / `+7 days`）。
- 摘要发送使用行锁（`FOR UPDATE`）+ 到期条件复查，多实例 worker 不会重复发送同一期；无论本期是否有内容都推进日程，避免停机后追赶风暴。

## 可见权限边界

- **匹配源头**：只有 `published` 且未删除的要素参与匹配；待审核、被拒绝、被隐藏、已删除的内容永远不会进入任何人的通知。
- **发送时二次校验**：摘要发送前重新 JOIN 校验要素仍处于 `published`；匹配后被隐藏的地点从摘要中剔除（保持待发送，若恢复可见则进入下一期）。
- **不打扰作者**：订阅者不会收到关于自己投稿的匹配通知（`s.user_id <> mf.owner_id`）。
- **账号状态**：只向 `active` 用户发送；停用/删除账号在匹配与摘要两个环节都被排除，用户删除时订阅级联清除。
- **对象级权限**：订阅的查询、修改、删除全部按 `user_id` 限定在服务端校验，不依赖前端路由。
- **链接安全**：通知链接指向 `/features/:id`，该端点本身对非发布内容返回 404，即使通知过期也不会泄露私有内容。
- 创建/修改订阅要求邮箱已验证（通知会触发邮件）；每用户上限 20 个订阅（`GEOFENCE_MAX_PER_USER`）。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/me/subscriptions` | 创建订阅（名称、圆心、半径、分类、频率），创建即重算 |
| `GET` | `/me/subscriptions` | 我的订阅列表 |
| `PATCH` | `/me/subscriptions/:id` | 局部更新；范围变化自动重算，频率切换自动结清/重排摘要 |
| `DELETE` | `/me/subscriptions/:id` | 删除订阅（匹配记录级联清除） |

请求体契约见 `packages/shared/src/contracts.ts` 的 `geofenceSubscriptionSchema` / `geofenceSubscriptionUpdateSchema`；纯逻辑（范围比较、摘要日程、摘要文案）在 `packages/shared/src/geofence.ts`，API 与 worker 共用。

## 已知边界

- 单次摘要/结清最多纳入 50 个地点（半径上限 20km 已实际限制命中规模）；超出的行保持待发送，进入下一期。
- 围栏形状为圆形（圆心 + 半径），渲染与匹配都使用 PostGIS geography 米制计算；多边形围栏是后续扩展方向。
