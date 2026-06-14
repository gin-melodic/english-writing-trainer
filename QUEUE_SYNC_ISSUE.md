# Queue / Notification / Sync Issue

Date: 2026-06-13

## Current Status

The queue / notification / synchronization problem is still unresolved.

Observed symptoms from today's session:

- `/api/state?assessmentPage=1&assessmentPageSize=10` returned 500 while the app was running locally.
- `/api/llm/events` can keep an SSE connection open for a long time.
- Queue/status tests and local runtime behavior are not giving enough confidence that users see fresh, consistent queue state.
- A SQLite `database is locked (5)` error was reproduced during local diagnosis when another process was using `data/trainer.db`.

Today's mitigation:

- Added a SQLite CLI timeout for DB calls in `lib/db.ts`.
- Avoid repeated full DB initialization in the same Node process.

This does not fully solve the broader queue / notification / synchronization design problem.

## Current Implementation Shape

Relevant files:

- `lib/llmQueue.ts`
- `app/api/llm/events/route.ts`
- `app/api/llm/status/route.ts`
- `app/page.tsx`

Current queue design:

- Queue state is persisted in SQLite table `llm_queue`.
- LLM concurrency is effectively 1.
- `enqueue()` inserts a queued row, then the same Node process polls and tries to acquire the front task.
- In-process listeners are notified through a local `Set<Listener>`.
- SSE endpoint `/api/llm/events` subscribes to those in-process listeners and also polls `snapshot(user.id)` every second.
- Frontend uses `EventSource("/api/llm/events")`; on SSE error it falls back to `/api/llm/status` polling every 5 seconds.

Important limitation:

- The listener set in `lib/llmQueue.ts` is process-local. It does not notify other Node processes, future serverless instances, or another runtime after reload.
- SQLite stores state, but it is not a notification bus.

## Risks / Suspected Failure Modes

1. SQLite contention

   Frequent status reads, queue writes, heartbeats, and app state reads can contend on `data/trainer.db`.

2. In-process notification does not scale

   `subscribe()` only works inside the same Node process. If the SSE request and queue worker are not in the same process, notifications depend on interval polling only.

3. SSE lifecycle edge cases

   `/api/llm/events` keeps a stream open. Abort/cleanup behavior may not always match browser reconnect behavior, especially during hot reload or transient network failures.

4. Snapshot cleanup has write side effects

   `snapshot()` calls `cleanupStaleRunning()`, so read-only status endpoints can perform writes. This increases lock pressure and makes status reads less predictable.

5. Queue tests may not cover multi-process behavior

   Current queue tests exercise the module in one Node process. They do not prove notification correctness across processes or multiple app instances.

## RabbitMQ Question

RabbitMQ may be useful, but it should not be introduced just because the current implementation is uncomfortable.

RabbitMQ is worth considering if we need:

- Durable jobs independent of the Next.js process.
- A real worker process separate from the web server.
- Cross-process or cross-instance queue coordination.
- Acknowledgement / retry / dead-letter behavior.
- Reliable event delivery beyond periodic polling.

RabbitMQ may be overkill if:

- This app stays as a single local Node process.
- LLM concurrency remains fixed at 1.
- Best-effort status updates are acceptable.
- A simple DB-backed queue plus polling is enough.

Middle-ground options to evaluate first:

- Keep SQLite as queue storage, but make status polling explicit and remove reliance on in-process listener notification.
- Split queue cleanup from `snapshot()` so status reads do not write.
- Add a dedicated worker loop that owns queue acquisition and heartbeats.
- Use SQLite only for durable state and SSE only as a UI convenience.
- If deploying beyond one process, consider Redis or RabbitMQ as the coordination layer.

## Tomorrow's Investigation Plan

1. Reproduce the user-visible issue with clear steps:

   - Start app manually with `npm run dev`.
   - Log in as a real user.
   - Open one or more tabs.
   - Trigger LLM operations that enqueue work.
   - Watch `/api/llm/events`, `/api/llm/status`, `/api/state`, and SQLite lock errors.

2. Add targeted logging temporarily:

   - Queue row id, user id, status transitions.
   - SSE connection open/close/error.
   - Snapshot return values.
   - SQLite lock failures and long-running calls.

3. Decide architecture:

   - Single-process local app: simplify current SQLite queue and polling.
   - Multi-process/deployable app: introduce a real queue/broker plan.

4. If considering RabbitMQ, define the minimum design:

   - Producer: API route enqueues LLM job.
   - Worker: separate Node process consumes one job at a time.
   - Status store: SQLite/Postgres table records queued/running/completed/failed.
   - Notifications: SSE polls status store or subscribes to broker/pub-sub.
   - Failure handling: ack only after job completes; failed jobs record error and optionally retry.

## Open Questions

- Is production/deployment expected to run more than one Node process?
- Should queued LLM tasks survive a dev server restart?
- Does the UI need exact real-time status, or is 1-5 second polling acceptable?
- Are per-user personal model calls supposed to bypass the platform queue completely?
- Should queue state be global, per-user, or per-provider?

## Next Decision

Before adding RabbitMQ, first decide whether the project needs multi-process durable queue semantics. If yes, RabbitMQ is a reasonable candidate. If no, fix the SQLite queue by reducing write pressure, making polling the source of truth, and removing assumptions about in-process notifications.


## 来自 Claude Sonnet 4.6 的独立建议

你的问题诊断和解法方向已经非常清晰，文档里的分析也相当准确。结论先说：**暂时不需要 RabbitMQ，但当前 SQLite 实现有几个根本性的结构问题，修复它们比换方案更高效。**

***

## 根本原因分析

当前实现有两个互相叠加的问题：

**问题一：通知机制依赖进程内 `Set<Listener>`**，而 Next.js dev server 在热重载或多路由 handler 场景下，SSE 连接的 handler 和队列 worker 未必在同一进程上下文中执行 。一旦不同进程，`subscribe()` 永远不会触发，UI 状态只能靠轮询，但轮询的间隔又是 5 秒兜底，导致用户感知到的延迟很大。 

**问题二：`snapshot()` 内部调用了 `cleanupStaleRunning()` 写操作**，而这个函数被 status 只读端点频繁触发 。所有用户每秒轮询 + SSE 每秒拉取 + 队列写入，全部竞争同一个 SQLite 文件锁，这是 `database is locked (5)` 的直接来源，不是 SQLite 本身的问题。 

***

## 推荐修复方案（仍用 SQLite）

### 核心原则：让 SQLite 只做状态存储，轮询做唯一通知源，彻底移除进程内 listener

**第一步：拆分读写，消除 snapshot 的副作用**

```typescript
// lib/llmQueue.ts

// 原来 snapshot() 里混有 cleanupStaleRunning()，拆开
export function getQueueSnapshot(userId: string) {
  // 纯 SELECT，不做任何 UPDATE/DELETE
  return db.prepare(`
    SELECT status, position, total_ahead
    FROM llm_queue
    WHERE user_id = ?
    ORDER BY created_at ASC LIMIT 1
  `).get(userId);
}

// cleanup 由专用 worker loop 定时调用，不在读端点触发
function cleanupStaleRunning() { ... }
```

**第二步：用单一 worker loop 持有队列所有权**

Next.js API route 不应该同时做 enqueue 和 acquire。改为：

- API route 只负责 `INSERT` 一条 `queued` 记录
- 一个独立的 `setInterval` worker（在 `lib/llmQueue.ts` 模块初始化时启动）负责拉取队列头部、执行 LLM 调用、更新状态
- 这样写操作集中在一处，SQLite 锁压力大幅降低

**第三步：SSE 端点纯轮询，移除 `subscribe()` 依赖**

```typescript
// app/api/llm/events/route.ts
export async function GET(req: Request) {
  const stream = new ReadableStream({
    async start(controller) {
      const interval = setInterval(async () => {
        const state = await getQueueSnapshot(userId); // 纯读
        controller.enqueue(`data: ${JSON.stringify(state)}\n\n`);
      }, 1500); // 1.5s 轮询，足够用

      req.signal.addEventListener('abort', () => clearInterval(interval));
    }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}
```

这样 SSE 变成了"慢速 HTTP 长轮询"，不再依赖任何进程内事件，重载/多进程全部兼容 。

***

## 何时才应该引入 RabbitMQ 或 Redis

| 条件 | 结论 |
|---|---|
| 部署为单个 Node 进程（PM2 单实例或 Docker 单容器）| SQLite 够用，修完上面三点即可 |
| 需要多实例/水平扩展（Vercel Edge、多 PM2 worker）| 换 Redis（`ioredis` + `BLPOP` 或 `BullMQ`），比 RabbitMQ 轻量 |
| LLM 任务需要跨进程 ACK、retry、死信队列 | 此时 RabbitMQ 或 BullMQ on Redis 才有必要 |
| 队列任务需要在服务器重启后存活 | Redis AOF 持久化或 BullMQ 均可，SQLite 本身已经满足 |

对于你这个场景（小型平台、单 Node 进程、并发数固定为 1），**BullMQ + Redis 是比 RabbitMQ 更适合 Next.js 生态的中间档选择**，但目前都不需要，先把 SQLite 版本做干净。

***

## 立即可做的最小修复清单

1. **把 `cleanupStaleRunning()` 从 `snapshot()` 里移出**，改为 worker loop 每 30 秒调用一次
2. **`snapshot()` 改成纯 `SELECT`**，绝不触发写操作
3. **删除 `Set<Listener>` 的 subscribe/notify 机制**，SSE 改为纯定时 `getQueueSnapshot` 轮询
4. **给 SQLite 连接设置 `PRAGMA journal_mode=WAL`**，WAL 模式下读不阻塞写，可大幅降低 lock 错误频率：

```typescript
// lib/db.ts
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 3000');
```

5. **worker loop 用 `better-sqlite3` 的同步 API**，避免异步回调竞争同一锁

这五步不需要引入任何新依赖，改完后 UI 状态同步问题应该基本消失。
