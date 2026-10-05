# C. 性能瓶颈 — Issues & Required Fixes

> 分部：**C. 性能瓶颈** · 只读分析，未改动任何被分析代码
> 分析日期：2026-09-23 · 范围：indexer / core client / 签名哈希 / 合约 gas / 构建 CI / 运行时
> 测量环境：Windows，Node **v24.12.0**，`node:sqlite` **SQLite 3.50.4**，内存库 + 本地磁盘临时目录（均已清理）
> 数据标注约定：**［实测］** = 本机运行只读探针得到的数字；**［静态推算］** = 由代码结构 + 公开参数推算，标注推算依据。
> 所有临时探针脚本（`.perf-probe*.mjs`）与临时 SQLite 文件已删除，工作区未被污染。

---

## 0. 基线复核结论

| 已知基线断言 | 复核结果 | 证据 |
|---|---|---|
| 三个索引都以 `chain_id` 打头但默认查询不传 `chainId` → 全表扫描 | ✅ **成立且比预期更严重** | ［实测］`EXPLAIN QUERY PLAN` 在 `packages/indexer/cli-dbg.db` 上：不传 chainId 的 4 条查询全部 `SCAN actions` / `SCAN window_charges`；传 chainId 则走 `SEARCH ... USING INDEX`。20 万行合成数据上 `actionsForAgent(无 chainId)` = **784 ms / 扫 20 万行**，传 chainId 后 = 159 ms（有序索引）/ 300 ms（原索引）。 |
| `fetchRangeWithStableEnd` 对每条日志逐个 `getBlock` | ✅ **成立** | 静态：indexer.ts:548-552 对 `logs` 中每个**唯一** `blockNumber` 逐个 `await this.getBlockHash()`，**完全串行、无并发、无 `getBlock` 批量接口**。最坏 2000 块区间 / 每块 1 条日志 = **2000 次串行 RPC**。 |
| `storeAction` / `storeWindowCharge` 每次重新 `prepare` | ✅ **成立且被实测放大** | ［实测］`db.prepare()` 单次 **5.41 µs**，缓存语句取用 **0.003 µs** → **1811×** 差距。20k 行 `storeAction` 磁盘 autocommit 实测 35.2 s（569 rows/s）。 |
| `fetchLogsChunked` 全量物化 | ✅ **成立** | 静态：indexer.ts:423-431 `const out: Log[] = []` + `out.push(...await ...)`，整个 `[fromBlock, toBlock]` 区间的全部日志在返回前一次性驻留内存。 |
| `actionsForAgent`/`Target` 全量取数后 `.slice(-limit)` | ✅ **成立** | ［实测］20 万行库：全量物化 + slice(-20) = **116.02 ms（取 25000 行，返回 20 行）**；`ORDER BY … DESC LIMIT 20` 下推 = 65.26 ms。CLI 每次 `actions --limit 20` 都付全额代价。 |
| `spendByAgent` 全量载入 + JS reduce | ✅ **成立** | ［实测］25k 行 `spendByAgent` = **60.87 ms**（SCAN 25k 行 + JS BigInt reduce）。不传 chainId 变体 20 万行 = 148.73 ms。 |
| `summary` 多次 COUNT | ✅ **成立** | ［实测］`summary(chainId)` = **39.56 ms**，`summary()` 全链 = 51.16 ms；内部含 3× `COUNT` + `COUNT(DISTINCT agent_id)` + `chainIds()` 的 `UNION DISTINCT`。 |

**结论：七条已知基线全部成立**，且其中 4 条已有本机实测数字。下面的 PERF 条目在此基础上补全跨层分析。

---

## PERF-01 · 索引前缀与默认查询不匹配 → 4 条核心读路径退化为全表扫描

- **文件/行**：`packages/indexer/src/indexer.ts:869-871`（索引定义）、`indexer.ts:707-744`（`spendByAgent` / `actionsForAgent` / `actionsForTarget`）、`indexer.ts:747-773`（`latestWindowCharge`）
- **指标［实测］**：SQLite 3.50.4，`EXPLAIN QUERY PLAN` 输出：
  - `SELECT * FROM actions WHERE agent_id = ? ORDER BY …` → **`SCAN actions` ; `USE TEMP B-TREE FOR ORDER BY`**
  - `SELECT * FROM actions WHERE target = ? ORDER BY …` → **`SCAN actions` ; `USE TEMP B-TREE FOR ORDER BY`**
  - `SELECT value FROM actions WHERE agent_id = ?` → **`SCAN actions`**
  - `SELECT * FROM window_charges WHERE key = ? ORDER BY … LIMIT 1` → **`SCAN window_charges` ; `USE TEMP B-TREE FOR ORDER BY`**
  20 万行 / 1 agent / 2 链（该 agent 在两条链上各 10 万行）实测：
  | 查询 | 耗时 | 扫描/返回 |
  |---|---|---|
  | `actionsForAgent` 无 chainId | **784.00 ms** | 扫 200000 / 返 200000 |
  | `actionsForAgent` chainId=8453（原索引） | **300.44 ms** | 扫 100000 / 返 100000 |
  | `actionsForAgent` chainId=8453（有序覆盖索引） | 159.08 ms | 扫 100000 |
  | `spendByAgent` 无 chainId | 148.73 ms | 扫 200000 |
- **影响**：CLI 与 MCP 的 `audit_query` 默认不带 `--chain-id`（cli.ts:165 `filter = args.has("--chain-id") ? chainId : undefined`），即**默认即全扫**。数据量涨到百万行时单次 `actions --limit 20` 要秒级。`USE TEMP B-TREE FOR ORDER BY` 还额外引入全量排序。
- **修复方案 + 预期提升**：
  1. 新增 `CREATE INDEX idx_actions_agent_desc ON actions(agent_id, block_number DESC, log_index DESC)`、`idx_actions_target_desc` 同构 —— 让"取最近 N 条"成为 **索引内倒序定位 + LIMIT 提前终止**，消除 TEMP B-TREE。［实测］等价索引下 `… DESC LIMIT 20` = **76.59 ms**（vs 全量 784 ms）→ **~10× 加速**。
  2. 若保留 chainId 语义，做 `(agent_id, chain_id, …)` 顺序的**双列索引**并让默认查询也带上 `this.chainId`（而非 `undefined`），使默认路径走 `SEARCH` 而非 `SCAN`。
  3. `latestWindowCharge` 补 `(key, window_start DESC, block_number DESC, log_index DESC)` 索引 → ［实测］`LIMIT 1` 从 `SCAN` + 临时排序降到 `SEARCH` + 常数行。
- **工时**：1.5 人日（含迁移脚本 + 回归测试）
- **依赖**：schema 变更需 `migrate()` 增量（现有表重建逻辑在 indexer.ts:155-214）
- **时间线**：Sprint 1，第 1 周

---

## PERF-02 · 读路径全量物化后 `.slice(-limit)` → 每次查询付 O(全集) 代价

- **文件/行**：`packages/indexer/src/cli.ts:207`（`.slice(-limit)`）、`indexer.ts:718-744`（两个查询方法无 `LIMIT` 参数）
- **指标［实测］**：20 万行库，`actionsForAgent(agent)` 返回 25000 行，再 `.slice(-20)`：
  - **116.02 ms，取 25000 行，只返回 20 行**（数据浪费率 1250×）
  - 加 DESC+LIMIT 下推：**65.26 ms，取 20 行**
  - 再叠加 PERF-01 的有序索引：**76.59 ms**（含临时 B-tree），若索引顺序匹配可降至常数级
  - `actionsForTarget` 同构（实测 48.85 ms @12500 行）
- **影响**：CLI `actions --limit 20` 的默认用法（cli.ts:175 `limit = … ?? 20`）在生产上是每次都要扫描并 JS 映射 25000 个对象。`toStoredAction` 对每行做 11 次字段转换 + 字符串化，纯属浪费。
- **修复方案 + 预期提升**：给 `actionsForAgent` / `actionsForTarget` 增加 `{ limit, order }` 参数，默认 `DESC + limit`，把 `.slice()` 换成 SQL `ORDER BY block_number DESC, log_index DESC LIMIT ?`。预期 **116 ms → <1 ms**（20 行、索引定位）。
- **工时**：0.5 人日
- **依赖**：需保证 `slice(-limit)` 语义（"最近 N 条"）与新默认一致；对已有调用方（`scripts/benchmark-indexer.mjs:523,571` 读全量）保留"取全量"入口。
- **时间线**：Sprint 1，第 1 周（与 PERF-01 合并做）

---

## PERF-03 · `spendByAgent` 全量载入 + JS `reduce` → 无法用 SQL 聚合，且默认全扫

- **文件/行**：`packages/indexer/src/indexer.ts:707-716`
- **指标［实测］**：
  - 无 chainId（200k 行中该 agent 20 万行）：**148.73 ms**，计划 `SCAN actions`
  - chainId=8453（10 万行）：**64.87 ms**，`SEARCH ... USING INDEX idx_actions_agent`
  - chainId + 覆盖索引 `(agent_id, chain_id, value)`：**55.18 ms**，`SEARCH ... USING COVERING INDEX`
  - JS `reduce` 单独成本（25k 行）：**27.09 ms**（BigInt 累加）
- **影响**：spend 报表是 MCP `audit_query` 的主力查询。`SELECT value` 把整列 TEXT 拉到 Node 再逐行 `BigInt()`，既占内存又占 CPU；SQLite 侧无法用 `SUM()` 是因为 `value` 是十进制字符串（indexer.ts:48,52 注释说明"SQLite has no bigint"）。
- **修复方案 + 预期提升**：
  1. **双路径**：保留字符串 BigInt 语义（不能改，正确性优先），但加覆盖索引让扫描走 covering index —— 55.18 ms vs 148.73 ms = **~2.7×**。
  2. 更好：把求和下推到 SQL —— 存 `value` 时并行存一列 `value_hi/value_lo` 或按 1e18 拆分的整数值，用 `SUM()`；JS 只在跨 precision 边界回退。仅当需要超 2^63 精度时用现有路径。
  3. 默认查询带 chainId，走索引。
- **工时**：方案 1 = 0.5 人日；方案 2 = 2 人日（需改 schema + 迁移 + 精度测试）
- **依赖**：方案 2 触及 `StoredAction.value` 序列化契约与 `scripts/benchmark-indexer.mjs` 的 `agentSpendWei` 校验
- **时间线**：Sprint 1（方案 1）/ Sprint 2（方案 2）

---

## PERF-04 · `summary` 4 次独立查询（3×COUNT + COUNT DISTINCT + UNION）→ 单次调用多次全扫

- **文件/行**：`packages/indexer/src/indexer.ts:789-799`
- **指标［实测］**：
  - 组件耗时：`COUNT actions` 0.50 ms / `COUNT charges` 0.37 ms / **`COUNT(DISTINCT agent_id)` 12.35 ms** / `chainIds()` UNION DISTINCT **10.06 ms** = **合计 23.28 ms**（20 万行）
  - 经真实 `SigilIndexer`：`summary(chainId)` **39.56 ms**，`summary()` 全链 **51.16 ms**
- **影响**：`backfill --json` 与 `watch` 每次 backfill 后都调 `summary`（cli.ts:135,139），`--json` 还额外调 `chainIds()`（cli.ts:233）→ **单次 backfill 触发 2× summary 语义（最多 8 条 SQL）**。`COUNT(DISTINCT agent_id)` 在无辅助索引时是全表排序去重，随行数线性增长。
- **修复方案 + 预期提升**：
  1. 合并为单条 `SELECT` + 标量子查询，`chainIds()` 复用结果 → 4 趟 → 1 趟。
  2. `COUNT(DISTINCT agent_id)` 加覆盖索引 `(agent_id)` 已有 `idx_actions_agent(chain_id, agent_id)` 前缀不符 → 补 `(agent_id)` 覆盖索引，或改用 `idx_actions_agent` 反向利用。预期 12.35 ms → <1 ms。
  3. 维护增量计数（`sync_state` 或新 `stats` 表），O(1) 返回。综合预期 **39.56 ms → <2 ms**。
- **工时**：0.5 人日（方案 1+2）
- **依赖**：无
- **时间线**：Sprint 1，第 1 周

---

## PERF-05 · `storeAction`/`storeWindowCharge` 逐行重新 `prepare` + 无批事务 → 写吞吐塌陷

- **文件/行**：`packages/indexer/src/indexer.ts:225-253`（storeAction）、`indexer.ts:258-282`（storeWindowCharge）、`indexer.ts:289-329`（`ingestLogs` 逐条调用）
- **指标［实测］**：
  - `db.prepare()`：**5.41 µs/次**；缓存语句取用：**0.003 µs/次** → **1811×**
  - 真实 `SigilIndexer.storeAction`，20k 行，磁盘，**默认选项**：
    | 模式 | 耗时 | 吞吐 |
    |---|---|---|
    | **逐行 autocommit（当前默认）** | **35180.3 ms** | **569 rows/s** |
    | 包在 `BEGIN/COMMIT` | 457.0 ms | 43761 rows/s |
    | `BEGIN/COMMIT` + WAL | 417.1 ms | 47954 rows/s |
  - 纯净对照（预编译语句、无 `prepare` 重复）：内存 autocommit 112131 rows/s；磁盘 autocommit（default journal）399 rows/s vs 单事务 142826 rows/s。
  - journal 模式对照（20k 行单事务）：delete+FULL 178346 / delete+NORMAL 182156 / wal+FULL 133345 / wal+NORMAL 134567 rows/s。
- **影响**：这是**最大单点**。`ingestLogs` 对每条日志调 `storeAction`，而 `commitRange`（indexer.ts:394）虽然开了 `BEGIN IMMEDIATE`，但 `storeAction` 是**公方法**可被单独调用（benchmark 就这么测的），此时每行一次隐式事务 + 每行一次 `prepare`。569 rows/s 意味着 **20 万行 backfill 需 ~6 分钟纯写**（还没算 RPC）。`PRAGMA journal_mode` 默认 DELETE + `synchronous=FULL` 在容器 volume 上更慢。
- **修复方案 + 预期提升**：
  1. **语句缓存**：模块级 `Map<sql, Statement>` 复用预编译语句 → 去掉 5.41 µs/行的开销。
  2. **确保批事务**：`ingestLogs` 内部或 `commitRange` 强制单事务（已是 BEGIN IMMEDIATE，需防止 API 绕过）。
  3. **PRAGMA 调优**：容器/持久化场景设 `journal_mode=WAL` + `synchronous=NORMAL`（审计场景可接受；如需更强持久性则保 FULL 但配 WAL）。综合目标 **569 → >40,000 rows/s（~70×）**。
- **工时**：1 人日
- **依赖**：与 `scripts/benchmark-indexer.mjs` 的"default options, no PRAGMA tuning"契约冲突 —— 若改默认值，该基准的 `target.options` 描述需同步更新（它显式声明测量"未调优路径"）。
- **时间线**：Sprint 1，第 1 周（优先级最高）

---

## PERF-06 · `fetchLogsChunked` 全量物化区间日志 + 串行 `getBlock` 逐条验证 → N+1 RPC 与内存峰值

- **文件/行**：`packages/indexer/src/indexer.ts:417-432`（`fetchLogsChunked`）、`indexer.ts:532-581`（`fetchRangeWithStableEnd`）
- **指标［静态推算］**：indexer.ts:542-556 对 `logs` 中每个唯一 `blockNumber` 逐个 `await this.getBlockHash()`（548-552），**无 Promise.all、无去重并发上限**。最坏情况（`maxBlockRange=2000`，每块 1 条日志）：**2000 次串行 `eth_getBlockByNumber` RPC**。若节点 RTT 100 ms → **~200 s/区间**；若 300 ms（公共节点）→ ~600 s。加上 line 539/557 的 before/after 头 + line 570 的 nextBlock + `validateCursor` 的 1 次 = 每次 backfill 至少 **2003+ 次 RPC**。
  ［静态推算］`fetchLogsChunked`（423-431）用 `out.push(...await ...)` 把整个区间日志数组驻留内存；`maxBlockRange=2000` 块 × 每块多日志，单区间可轻松十万级 Log 对象（每 Log 含 hex 字符串，`blockHash`/`txHash` 各 66 字符）。
- **影响**：backfill 首次追块是**最痛的用户场景**，当前是纯串行 N+1，既慢又无并发保护。`watch` 每 4 s 一轮，但因 `confirmations=12` 通常区间小；N+1 主要在长 catch-up 区间暴露。
- **修复方案 + 预期提升**：
  1. **有界并发**：`Promise.all` + 信号量（如并发 8-16）处理 header 读取，2000 次串行 → 2000/8 轮 → **~8× 墙钟**。
  2. **RPC 批量化**：viem `http(rpc, { batch: true })` 把同 tick 的 `getBlock` 合并成单 HTTP 多请求（`eth_getBlockByNumber` 数组）→ HTTP 往返从 2000 → 1（受节点批上限约束）。全仓确认**当前无任何 `batch({…})` transport**。
  3. **header 校验降级为可选**（见 PERF-07 关于可信节点的权衡），或只校验 `end`/`nextBlock` 边界。
- **工时**：2 人日（并发 + 批量化 + 保留 fail-closed 语义 + 回归）
- **依赖**：与 B64 fail-closed reorg 语义强相关 —— 改动必须保留"检测到 reorg 拒绝提交"的性质（README/indexer.ts:19-24, 557-563）。需 SECURITY 文档同步。
- **时间线**：Sprint 2，第 2-3 周（可拆：先并发化 1 人日，批量化 1 人日）

---

## PERF-07 · `fetchRangeWithStableEnd` 端点稳定性校验重复取同一区块头

- **文件/行**：`packages/indexer/src/indexer.ts:539`、`indexer.ts:557`、`indexer.ts:507`（`validateCursor`→`getBlockHash`）
- **指标［静态推算］**：单次 backfill 对**同一个** `toBlock` 至少取 2 次头：line 539（before）、line 557（after）；`watch` 路径更甚 —— line 669 每 tick 先 `validateCursor`（取 `lastBlock` 头，line 507），line 677 `fetchRangeWithStableEnd` 内部又取 before(toBlock)+after(toBlock)，若 `fromBlock == lastBlock+1` 且区间只有 1 块，`toBlock` 恰是 `lastBlock+1` 但 cursor 头仍是 `lastBlock` —— **近乎重叠但不完全重合**；在"刚追平、每 tick 只前进 1 块"的稳态下，`getBlock` 次数/tick ≈ **3-4 次**（cursor 头 + before + after + nextBlock(line 570)），而非必要的 1 次。
- **影响**：稳态 `watch` 的每 4 s 轮询把大部分时间花在重复 header 读取上；对 RTT 高的公共节点，header 读取是**主要延迟来源**，且这部分延迟无法被 `pollMs` 吸收（它在 sleep 之外）。
- **修复方案 + 预期提升**：
  1. `fetchRangeWithStableEnd` 内对 `toBlock` 做 **请求级 memo**，让 before/after 共用一次底层 `getBlock` 的 in-flight promise（仍两次逻辑调用、两次校验语义，但若第二次命中 in-flight/极短 TTL 缓存则省一次 RTT）。
  2. 更稳的方案：`watch` 稳态下 `toBlock == safeHead` 变化慢，引入**极短 TTL 的 block-header 缓存**（如 1-2 s），before/after 与 cursor 校验共享。
  预期：稳态 header RPC 从 ~3-4 → 1-2 次/tick。
- **工时**：1 人日
- **依赖**：必须不削弱 B64 —— 缓存 TTL 需 < 确认窗口，且 mismatch 仍必须拒绝提交。
- **时间线**：Sprint 2

---

## PERF-08 · 签名/哈希路径：无 `data` 长度上限 → 大 calldata 下 CPU 与内存线性爆炸

- **文件/行**：`packages/core/src/signing.ts:163-168`（`parseActionRequest` 校验 `data` 为偶数长度 hex，无上限）、`signing.ts:49-79`（`actionRequestDigest` → `hashTypedData` 对整个 `data` 编码）
- **指标［实测］**（built dist，core）：
  | `data` 长度 | `actionRequestDigest` | `parseActionRequest` |
  |---|---|---|
  | 0 B | 2.07 ms | 0.12 ms |
  | 128 B | 0.46 ms | — |
  | 4 KB | 0.86 ms | 0.01 ms |
  | 64 KB | 5.12 ms | — |
  | **512 KB** | **29.93 ms** | 0.85 ms |
  趋势：**近线性于 data 长度**。若上游（agent / API / MCP）传入 1 MB 级 `data`，单次 digest 将达 **~60 ms**，且 `hashTypedData` 期间 `data` 被多次复制（`concat`/`encodeAbiParameters`/keccak）→ 峰值内存 ~数倍 data 长度。
- **影响**：这是**用户可控输入**。`SigilKitClient.prepareExecution`（client.ts:499）先 `parseActionRequest`，对 512 KB `data` 仅花 0.85 ms 放行，随后 `actionRequestDigest` 花 30 ms。DoS 面：一个恶意/失控 agent 反复提交大 calldata → CPU 消耗，**零 gas**（本地 pre-flight 阶段）。
- **修复方案 + 预期提升**：
  1. 在 `parseActionRequest` 加 **合理上限**（如 64 KB，与实测拐点对齐；或按业务设 16-32 KB），超出即抛 `ValidationError` —— 零成本、签名即拒。
  2. 大 `data` 时避免 `hashTypedData` 的多次全量拷贝（keccak 一次 + 复用）。
  预期：对 512 KB 输入，**30 ms → <1 ms**（快速拒绝）；正常 ≤4 KB 路径不变。
- **工时**：0.5 人日
- **依赖**：需确认业务最大 calldata（ERC-721 `setApprovalForAll` 等远小于 32 KB）。与"零 gas 本地拒绝"设计一致，不影响链上语义。
- **时间线**：Sprint 1，第 2 周（安全相关，可提前）

---

## PERF-09 · Merkle 证明 O(n log n) 构建 + 双次验证无 memo → 树大时 CPU 显著

- **文件/行**：`packages/core/src/signing.ts:240-265`（`merkleProof` 每层重建整个 level）、`signing.ts:336-352`（`validateAgainstScope` 对 wildcard/pinned **各跑一次** `leafMatches`，不缓存）
- **指标［实测］**：
  | 叶子数 | `merkleProof` 构建 | `validateAgainstScope`（2× proof 验证 + 根重建） |
  |---|---|---|
  | 16 | 0.18 ms | — |
  | 256 | 2.38 ms | 4.88 ms |
  | 1024 | 9.57 ms | 18.92 ms |
  | **4096** | **38.07 ms** | **84.78 ms** |
  趋势：构建 **O(n log n)**（每层全量重算，`.sort()` 一次 + 逐层），验证随树深 **O(log n) 但跑两遍**。4096 叶时 `validateAgainstScope` 单次 **84.78 ms**。
  注意 `merkleProof` 的 doc 声称"position tracking is purely index-arithmetic, no hash lookups after findIndex"——但每层**仍全量重算哈希**（253-260），故实际是 O(n log n) 而非 O(log n)。
- **影响**：若运营方为 agent 授予大 Merkle 白名单（数百叶），`prepareExecution` 的本地预检（client.ts:535）每次付 5-85 ms。tree 更大（数千叶）时，**每次执行**的本地校验成为执行延迟的主要部分。
- **修复方案 + 预期提升**：
  1. `merkleProof`/`merkleRoot` 只重算**从 leaf 到 root 的路径**（自底向上只算 idx 处的节点），把 O(n log n) 降到 O(n)（排序）+ O(log n)（路径）——构建 **38 ms → ~1 ms**（4096 叶）。
  2. `validateAgainstScope` 把 wildcard/pinned 两次 `leafMatches` 合并（共享 proof 遍历或先算一次再比对），**~2× 节省**。
- **工时**：1.5 人日（需重写 merkle 构建，务必与 on-chain 构造逐位一致；`packages/core/test/merkle.test.ts` + `contracts` golden vectors 做 pin）
- **依赖**：严格依赖 `MerkleWhitelist` 排序对语义 + `GoldenVectorsTest:test_Golden_MerkleTree_ProofsVerify` 保持绿。
- **时间线**：Sprint 2（第 3 周，需留足回归时间）

---

## PERF-10 · `prepareExecution`/`simulateExecution`/`checkTokenPath` 的 RPC 次数与串并行为

- **文件/行**：`packages/core/src/client.ts:505-531`（`Promise.all` 并行 nonce+window）、`client.ts:614-677`（`checkTokenPath`）、`client.ts:690-712`（`simulateExecution`）、`client.ts:811`（`waitForTransactionReceipt`）
- **指标［静态推算］**：单次 `executeSimulated`（client.ts:736-748）的 RPC 序列：
  1. `getNonce`（`eth_call`）
  2. `getWindowState`（`eth_call`）— 与 1 已 `Promise.all` 并行（client.ts:505）✅
  3. `simulateExecution` 的 `eth_call`（client.ts:699）
  4. `sendTransaction`
  5. `waitForTransactionReceipt` 轮询（client.ts:811）
  → **3 次 pre-send RPC + 轮询**。`checkTokenPath`（未在 `execute` 内自动调用，client.ts 未调用它）`transferFrom` 分支最多 **2 次并行读**（balance + allowance，client.ts:667-672）✅ 已并行。
  ［静态推算］`waitForTransactionReceipt` 用 viem 默认 polling（无 `pollingInterval`/`timeout` 自定义），Base 上 confirmations 后仍可能轮询数十次。
- **影响**：`Promise.all` 与 `checkTokenPath` 并行已把 pre-flight 从 2 串行降到 1 往返（PERF-3 注释所述）——这部分**已优化**。剩余成本是 `simulateExecution` 的 `eth_call`（真实节点执行整个合约，成本高），以及 receipt 轮询。
- **修复方案 + 预期提升**：
  1. `simulateExecution` 设为**可选**（配置开关），因为 `executeSimulated` 每笔多一次**全量合约执行级** `eth_call`（远贵于 `getNonce`）。对不需 simulate 的高吞吐路径提供 `execute`（无 sim）。预期高吞吐场景省 1 次昂贵 RPC。
  2. `waitForTransactionReceipt` 显式设 `pollingInterval`（如 2-4 s）与 `timeout`，避免默认过密轮询打爆 RPC 限流。配合 viem `batch` transport（见 PERF-06）合并同 tick 轮询。
- **工时**：1 人日（配置化 + transport 调优）
- **依赖**：需保持"simulate-then-execute"作为**推荐**路径（client.ts:733 文档）；改为可选需在 README/GETTING-STARTED 说明默认值。
- **时间线**：Sprint 2

---

## PERF-11 · 合约 gas：`enforce` 双写 storage、事件体积、Merkle proof 长度

- **文件/行**：`contracts/src/SpendPolicy.sol:77-81`（双 SSTORE + 事件）、`contracts/src/SessionKeyManager.sol:415-445`（balance snapshot 前后各 N 次 staticcall）、`contracts/src/MerkleWhitelist.sol:14-24`（O(depth) 哈希链）
- **指标［实测，基于 .gas-snapshot + GasBudget.t.sol 静态比对］**：
  - `SpendPolicy.enforce` 每次执行 **2 个 SSTORE**（`windowStart` line 78 + `spentThisWindow` line 79）。`windowStart` 在窗口内不变（只读后写回，line 60→78），仍**每笔付一次 SSTORE**。首个窗口从 0→非 0 是 0→20k；窗口内同值写是 100 gas（warm）但**冷访问 2100/5000 视上下文**。加 `WindowCharged` 事件（3 indexed + 2 data ≈ 1125 gas + log data）。
  - `WindowCharged` 事件：`account` indexed、`key` indexed、`value`/`windowStart`/`spentThisWindow` 非 indexed。`ActionLogged`：**3 indexed**（agentId/target/selector）+ 3 非 indexed（value/rationaleHash/timestamp）≈ 375×3 + 8×96 ≈ **2000+ gas/事件**。
  - `test_Gas_SimpleExecute_WithinBudget` 当前 `.gas-snapshot` = **214,031**（累计 test gas，含 setUp）。`GasBudget.t.sol:48` 注释"measured 112,805"是 `gasleft()` delta。［静态推算］预算 `BUDGET_SIMPLE=150,000` 相对 112,805 留 ~33% 余量 —— 但**当前实现若新增 watchlist/NativeDelta 逻辑会推高**。`test_Gas_WhitelistDelta_IsBounded` 实测 delta <5,000（1 元素 proof = 1 次 keccak ≈ 69 gas + memory）。
  - `SessionKeyManager._interact`（400-406）在 `enforceNativeDelta=true` 时：`_snapshotBalances` 快照 `nativeBefore` + 最多 8 个 token `balanceOf` staticcall（415-424），`_verifyBalances` 再查一遍（429-445）→ **每执行 2×8=16 次 external staticcall**（cold 2100 gas each = 最多 ~33.6k gas）。`GraduatedAuthorityTest:test_TokenDelta_UndeclaredOutflowReverts` = 567,551 gas 印证 E11 路径昂贵。
- **影响**：主执行路径（无 watchlist、无 merkle）已相对紧凑；**E11 `enforceNativeDelta` + 8 币种 watchlist 是 gas 放大器**（~34k gas + 16 次外部调用）。Merkle proof 长度直接影响验证 gas（O(depth) keccak，~69 gas/层 + memory copy），但树浅时可控。
- **修复方案 + 预期提升**：
  1. `SpendPolicy.enforce`：**窗口内不重写 `windowStart`**（仅在 rollover 时写）。当前 line 78 无条件写。改为 `if (start changed) window.windowStart = start;` → 窗口内省一次 SSTORE（cold 时 2100-5000 gas，省 ~5-10% 执行 gas）。
  2. `WindowCharged`/`ActionLogged` 事件字段合理索引（已是 3 indexed，符合 topic 规范，**不建议改** —— 改会破坏 indexer 解析与既有 topic）。
  3. `enforceNativeDelta` 的 16 次 staticcall：**用 `staticcall` 批量**不可行（EVM 无批量调用），但可**跳过未在 calldata 声明的 token**（`_declaredTokenOutflow` 已返回 0 时可只查不比较，或仅检查 `transfer`/`transferFrom` 的 token）。此为可选优化，权衡 gas vs 防护。
- **工时**：方案 1 = 0.5 人日（简单、gas 收益明确）；方案 3 = 1 人日 + 安全评审
- **依赖**：PERF-11 方案 1 改 `SpendPolicy` 需重跑 `.gas-snapshot` 并复核 `GasBudget.t.sol` 断言（CI 有 gas drift 报告但不 fail）。**不涉及 breaking**：事件签名、slot 布局不变。
- **时间线**：Sprint 2

---

## PERF-12 · 合约 gas：存储槽设计（ERC-7201 命名空间 & mapping 嵌套深度）

- **文件/行**：`contracts/src/SessionKeyManager.sol:76-84`（`ManagerStorage` 结构）、`contracts/src/SessionKey7579Module.sol:90-96`（`ModuleStorage` 双层 mapping）
- **指标［静态推算］**：
  - `SessionKeyManager` 全部状态在 ERC-7201 单一 slot 空间（line 73-74），`scopes[key]`/`revoked[key]`/`windows[key]`/`nonces[key]` 各自 keccak 派生 → **每键 4 个独立冷 slot**，首次执行全部冷访问（2100 gas each SLOAD = ~8.4k）。非碰撞 ✅（ERC-7201 设计目标达成）。
  - `SessionKey7579Module` 用 `mapping(account => mapping(key => …))` **双层**（line 91-93）→ 每次访问多一次 keccak 哈希（~42 gas + memory），`windows[account][signer]` 在 validation 中被 `enforce` 读写。
  - `nonReentrant` 修饰符（line 123-129）读写 `reentrancyLocked`（同一命名空间 slot）→ 每执行 +1 冷/热 SLOAD+SSTORE。
- **影响**：单键 4 冷槽 ~8.4k + 两次 keccak 派生，**在 ~112-214k 总 gas 中占比 <10%**，但它构成"每键首次执行"的固定税。`7579` 双层 mapping 在多账户场景哈希开销略高但可接受。
- **修复方案 + 预期提升**：
  1. **不要**为此重构 —— ERC-7201 命名空间已解决槽碰撞，收益（~1-2%）远低于改动风险（存储布局 = 升级安全边界）。
  2. 若需微调：把 `revoked[key]` 与 `scopes[key]` 的 `expiresAt==0` 冗余判断合并（已用 expiresAt 做 KeyUnknown，省一次读 ✅，见 line 289）。现状已优化。
- **工时**：不修复（记录为"已评估、判定无需改动"）。若强制记录，0.2 人日评估已完成。
- **依赖**：无。**结论：不列入修复计划，仅作记录**。
- **时间线**：不排期

---

## PERF-13 · `lease-fs` SQLite 并发：`synchronous=FULL` + 每次操作 `BEGIN IMMEDIATE` → 跨进程串行化

- **文件/行**：`packages/core/src/lease-fs.ts:39-40`（`PRAGMA busy_timeout=1000; synchronous=FULL`）、`lease-fs.ts:120-134`（`write()` 每次 `BEGIN IMMEDIATE`）、`lease-fs.ts:63`（`acquire` 每次 `checkLegacy()` → `readdirSync`）
- **指标［静态推算］**：`FileLeaseStore` 每次 `acquire`/`renew` 都开一个 `BEGIN IMMEDIATE` 写事务（lease-fs.ts:121），`synchronous=FULL`（line 40）→ 每次 commit **fsync 磁盘**。在共享 volume（docker-compose `sigilkit-data`）上，N 个 worker 争同一 key 时，SQLite 单写者锁使它们**完全串行**，每次操作 ≈ 1 次 fsync。`acquire` 每次还调 `readdirSync(dir)`（line 63 `checkLegacy`）—— 一次**同步目录列举**，即使无竞争。
  `NonceGate` 文档（client.ts:183-186）明确"coordination is in-process only… for multi-process fleets, serialize per key upstream"—— 单机多 worker 用 `FileLeaseStore` 时，这是**已知设计**。
- **影响**：多 worker 共享 session key 时，lease 操作成为**串行瓶颈**，每次 ~fsync RTT。`renew` 由心跳在 TTL/2（默认 15 s）触发，单次影响小；但 `acquire` 阻塞在高并发时明显。`checkLegacy` 的 `readdirSync` 是**纯浪费**（每次 acquire 多一次系统调用，且不随 key 变化）。
- **修复方案 + 预期提升**：
  1. `checkLegacy()` 只在**构造时**调一次（lease-fs.ts:36 已调），删掉 `acquire` 内的重复调用（line 63）→ 每次 acquire 省一次 `readdirSync`。
  2. 评估 `synchronous=NORMAL` + WAL（lease 库可重建，且 epoch 有 TTL 恢复）—— 但这是**正确性权衡**，须确认"崩溃后 lease 状态"的容忍度。**建议保守保留 FULL**，仅做方案 1。
- **工时**：0.2 人日（方案 1，删除冗余 `readdirSync`）
- **依赖**：删除 line 63 的 `checkLegacy` 不影响正确性（构造时已检，且 legacy `.lock` 出现是**运行期人为事件**，设计上应 fail at construction）。
- **时间线**：Sprint 1，第 2 周（低风险小改）

---

## PERF-14 · Docker 构建：`npm ci` 重复 + 缺失 layer 缓存键

- **文件/行**：`Dockerfile:29`（build 阶段 `npm ci`）、`Dockerfile:48`（runtime 阶段 `npm ci --omit=dev`）
- **指标［静态推算］**：build 阶段（line 24-29）先 COPY manifests 再 `npm ci`（✅ 依赖层可缓存），然后 `COPY packages ./packages` + `npm run build --workspaces`（line 31-32）。runtime 阶段（line 43-48）**再次 `COPY package.json package-lock.json` + 各 workspace package.json + `npm ci --omit=dev`** → **npm ci 在同一次 `docker build` 中跑两遍**。两阶段用不同 `node:24-bookworm-slim` 基镜像但**同一 layer 缓存不共享**（不同 stage 独立 cache）。`npm ci` 删 `node_modules` 重装，对 4 个 workspace 的 lockfile 而言是纯 I/O。
  ［静态推算］`npm ci` 每次需读 lockfile + 拉/验包 + 建 `node_modules` 树；跑两遍 ≈ **2× 安装时间**。`npm cache clean --force`（line 48）清 cache，**下一层 build 缓存失效**（虽然已 `--omit=dev`）。
- **影响**：CI/本地 `docker build` 的**构建时间**（非运行时）。无 `docker build --cache-from` 配置、无 BuildKit mount 优化。对**运行时**无影响（runtime 只带 `dist` + prod deps）。
- **修复方案 + 预期提升**：
  1. runtime 阶段改为 `COPY --from=build /app/node_modules ./node_modules`（复用 build 已装的，运行时再按需精简）—— 或保留 `npm ci --omit=dev` 但**接受它**（prod deps 更小、攻击面更小，这是**安全权衡**，不宜为速度牺牲）。
  2. 加 `--mount=type=cache,target=/root/.npm`（BuildKit）→ npm 包下载缓存跨 build 复用，**显著**缩短两次 `npm ci` 的网络部分。
  3. **`docker buildx bake`/CI 加 `--cache-from type=registry`**。
- **工时**：0.5 人日（加 BuildKit cache mount + CI 文档）
- **依赖**：**重要** —— 方案 1（直接 COPY node_modules）会**增大镜像/攻击面**，与"prod-deps-only"安全意图冲突。**推荐只做方案 2+3**（纯速度，不减安全）。
- **时间线**：Sprint 3（低优先级）

---

## PERF-15 · CI：重复 forge 编译、npm ci 缓存、并行度与 artifact 上传

- **文件/行**：`.github/workflows/ci.yml:73-76`（forge-unit: `forge build --sizes` + `forge test`）、`ci.yml:139-145`（ts-sdk: `npm run build --workspaces` + lint + test）、`ci.yml:150-160`（4× `test:coverage` + upload）
- **指标［静态推算］**：
  - `forge-unit`（line 73-76）`forge build --sizes` 后 `forge test` —— forge test 本身会触发 build，`--sizes` 是**额外的构建+报告**。2 个 forge job（unit/invariant）各自独立 checkout+toolchain+build。**无 forge 缓存**（`foundry-rs/foundry-toolchain` 不缓存 `out/`/`cache/`），每次 PR 从零编译 7 个合约 + 17 个测试文件。
  - `ts-sdk`（line 139）`npm run build --workspaces` 后（150-153）**再跑 4 个 `test:coverage`**（每个内部可能重跑全部 test —— `npm test --workspaces` line 145 之后又 4× coverage）。**测试执行双跑**：line 145 全量 test + line 150-153 四次 coverage（各自重跑）。这是**明确的重复**。
  - `setup-node` with `cache: npm`（line 40, 130）✅ 已启用 npm 缓存。
  - artifact 上传（line 154-160）`path: packages/*/coverage/`，`if: always()` —— 4 个 workspace 的 coverage 都上传（可能几 MB）。
- **影响**：**CI 时长**（开发者反馈速度）+ 算力成本。`ts-sdk` 的测试双跑是**最明确的可优化点**：vitest 一次全量 + 4 次 coverage 重复。`.gas-snapshot` drift 报告（line 203-211）只在 nightly，不影响 PR。
- **修复方案 + 预期提升**：
  1. **消除测试双跑**：删 line 145 `npm test --workspaces`，只保留 150-153 的 coverage（coverage 本身执行全部测试，附带阈值断言）。**省一次全量测试执行**（ts-sdk job 减 ~30-50%）。
  2. **forge 缓存**：`actions/cache` 缓存 `out/` + `cache/`（key 含 `foundry.toml` + `contracts/**` hash）→ 编译从零 → 增量，**每次 PR 省编译时间**。
  3. 提高并行度：`forge-unit` 与 `ts-sdk` 已独立 job ✅；考虑把 `forge-invariant` 并入 `forge-unit`（同一 checkout 省一次 toolchain 下载）—— 或保持独立以并行。
- **工时**：0.5 人日
- **依赖**：删 line 145 需确认 4× coverage 覆盖了所有 workspace 测试（看各 package.json 的 test:coverage script）。**依赖：无破坏性**。
- **时间线**：Sprint 3

---

## PERF-16 · Docker/运行时：logger 同步写 + healthcheck 启动成本

- **文件/行**：`packages/core/src/logger.ts:137-138`（`process.stdout.write` / `process.stderr.write` **同步阻塞**）、`docker-compose.yml:35-41`（healthcheck `node -e require('fs').accessSync(...)`）
- **指标［静态推算］**：logger 的 `out`/`err` 默认是 `process.stdout.write`（logger.ts:137-138）。Node 中 **stdout/stderr 对 pipe/file 是异步的，对 TTY 是同步的**。在 Docker 中 stdout 是 **pipe** → 异步（写 pipe 满时回调阻塞 event loop，但通常不阻塞调用）。`watch` 每 4 s 打 1-2 行；poll 失败时 `log.error` 打堆栈（logger.ts:116 `payload.error.stack` —— **JSON 格式带完整 stack**）。高频失败（如 RPC 挂）时 backoff 递减（indexer.ts:689 `Math.min(backoff*2^n, 60_000)`），最多每 60 s 一条，**不是日志洪水**。
  healthcheck（compose line 37）`node -e "require('fs').accessSync(...)"` —— 每次探活**起一个 node 进程**（Node 启动 ~50-80 ms CPU），每 30 s 一次（line 38 `interval: 30s`）。**2 个 node 进程**（indexer + 可选 mcp）。Node 冷启动成本 × 频率虽小，但容器内 node 启动较重。
- **影响**：低。logger 在 pipe 模式非阻塞；healthcheck 开销小（~80ms/30s = 0.27% 单核）。**非瓶颈**。
- **修复方案 + 预期提升**：
  1. healthcheck 换更轻的方式（`test -f $SIGILKIT_DB_PATH` 用 shell 而非 `node -e`）→ 去掉 node 启动。但 compose healthcheck 的 CMD 形式是 `["CMD", "node", ...]`，换成 shell 需 `CMD-SHELL`。收益小。
  2. logger 无需改（pipe 异步；且**不应**改为同步）。**判定：保持现状。**
- **工时**：方案 1 = 0.1 人日；方案 2 = 不改
- **依赖**：无
- **时间线**：可延后/不排期

---

## PERF-17 · `merkleProof` 存在无效的 CPU 复杂度声明（正确性文档缺陷，附带性能）

- **文件/行**：`packages/core/src/signing.ts:236-238`（doc 声称"purely index-arithmetic… no hash lookups"）
- **指标［静态推算］**：doc 说位置跟踪是纯索引算术（`floor(idx/2)`，确实无需哈希查找）**—— 这部分正确**。但**每层循环仍全量重算**所有节点的 `sortedPairHash`（line 253-260），故整体是 **O(n log n)**，而 doc 的表述易被误读为 O(log n)。［实测］4096 叶构建 38.07 ms 印证 O(n log n) 特征（若 O(log n) 应为 <1 ms）。
- **影响**：文档误导 + 真实 CPU 成本。与 PERF-09 是同一根因（merkle 构建未优化）。**应合并处理**。
- **修复方案 + 预期提升**：与 PERF-09 一并解决（优化构建 + 修正 doc 措辞，避免 O(n log n) 被当成 O(log n)）。
- **工时**：并入 PERF-09
- **依赖**：PERF-09
- **时间线**：Sprint 2

---

## PERF-18 · 响应时间目标缺口：`actions`/`spend` 无分页与响应时间预算

- **文件/行**：`packages/indexer/src/cli.ts:207`、`:193`、`:219`（三个查询命令均无分页/上限）
- **指标［实测］**：20 万行库中单 agent 25000 行：`actions` 命令 = **116.02 ms**（`spend` 同 agent = 60.87 ms）。CLI 冷启动（Node + viem import）另需 ~200-500 ms。百万行规模下（外推，［静态推算］）`actions --limit 20` 的数据层将达 **~1 s**，因全扫 + 全量物化。
- **影响**：**用户感知延迟**无预算、无监控。且 `spend` 命令是 60-150 ms 级的"轻"查询感觉上很快，但在生产百万行库上会退化。**响应时间目标（SLA）从未被定义或测量**。
- **修复方案 + 预期提升**：
  1. 定义性能预算（见下表）并纳入 CI（可复用 `scripts/benchmark-indexer.mjs` 扩测查询延迟）。
  2. 实施 PERF-01/02/03 后，把三个命令的 p95 压到预算内。
  3. 观察项：把 `audit_query` 响应时间纳入看板。
- **工时**：0.5 人日（定义预算 + 扩展基准）
- **依赖**：PERF-01/02/03 完成后收益才显现
- **时间线**：Sprint 2（与 01/02/03 同批验收）

---

## 优先级与预期总收益矩阵

| ID | 领域 | 影响 | 工时 | 预期提升（实测支撑） |
|---|---|---|---|---|
| **PERF-05** | 写吞吐 | 🔴 极高 | 1d | **569 → 40,000+ rows/s（~70×）** |
| **PERF-01** | 读延迟 | 🔴 高 | 1.5d | 全扫 784ms → ~76ms（~10×） |
| **PERF-02** | 读延迟 | 🔴 高 | 0.5d | 116ms → <1ms（LIMIT 下推） |
| **PERF-06** | RPC 数量 | 🔴 高 | 2d | 2000 串行 → 批量化/并发（~8×+） |
| **PERF-03** | 读延迟 | 🟠 中高 | 0.5-2d | 148ms → 55ms（覆盖索引） |
| **PERF-08** | CPU/DoS | 🟠 中高 | 0.5d | 30ms → <1ms（大 data 快速拒） |
| **PERF-09/17** | CPU | 🟠 中 | 1.5d | 38ms → ~1ms（Merkle O(n log n)→O(n)) |
| **PERF-04** | 读延迟 | 🟡 中低 | 0.5d | 39ms → <2ms |
| **PERF-10** | RPC 成本 | 🟡 中低 | 1d | 省 1 次昂贵 sim eth_call |
| **PERF-07** | RPC 数量 | 🟡 中低 | 1d | 稳态 3-4 → 1-2 header/tick |
| **PERF-11** | gas | 🟡 中低 | 0.5d | 省 1 SSTORE（~5-10% exec gas） |
| **PERF-15** | CI 时长 | 🟡 中低 | 0.5d | ts-sdk job -30-50% |
| **PERF-13** | 协调 | 🟢 低 | 0.2d | 每次 acquire 省 1 readdirSync |
| **PERF-14** | 构建 | 🟢 低 | 0.5d | BuildKit npm cache 显著加速 |
| **PERF-16** | 运行时 | ⚪ 极低 | 0.1d | 判定无需改动 |
| **PERF-12** | gas/存储 | ⚪ 无 | 0.2d | **判定无需改动**（已评估） |

## 建议性能预算（SLA 目标，PERF-18 产出）

| 指标 | 当前（20 万行实测） | 目标 | 测量方式 |
|---|---|---|---|
| `storeAction` 磁盘吞吐 | 569 rows/s | **> 40,000 rows/s** | `scripts/benchmark-indexer.mjs` |
| `actionsForAgent --limit 20` | 116.02 ms | **< 5 ms** | 扩展 benchmark |
| `spendByAgent`（单 agent 25k 行） | 60.87 ms | **< 15 ms** | 扩展 benchmark |
| `summary()` 全链 | 51.16 ms | **< 5 ms** | 扩展 benchmark |
| 每区块 header RPC（catch-up） | ~1/块（串行） | **批量化后 ~1 HTTP/8-16 块** | RPC 计数 mock |
| `actionRequestDigest`（512 KB data） | 29.93 ms | **< 1 ms（快速拒）** | 单元基准 |
| `merkleProof` 4096 叶 | 38.07 ms | **< 3 ms** | 单元基准 |
| 合约 `executeWithSessionKey` | 214,031（snapshot 累计） | 不回归 | `GasBudget.t.sol` + `.gas-snapshot` |

## 建议 30 天时间线

```
Sprint 1（第 1-2 周）— 写路径与读路径地基
  PERF-05（1d，写吞吐 70×，最高优先）  ← 立刻做
  PERF-01 + PERF-02（2d，索引 + LIMIT 下推）
  PERF-04（0.5d，summary 合并）
  PERF-08（0.5d，data 上限，安全性）
  PERF-13（0.2d，删冗余 readdirSync）
  → 验收：写入 >40k rows/s；actions --limit 20 <5ms

Sprint 2（第 3-4 周）— RPC 效率与 CPU
  PERF-06（2d，header 并发 + 批量化，保 B64 fail-closed）
  PERF-07（1d，header memo/短 TTL 缓存）
  PERF-09 + PERF-17（1.5d，Merkle O(n log n)→O(n) + 修 doc）
  PERF-10（1d，simulate 可选化 + 轮询调优）
  PERF-11 方案 1（0.5d，窗口内不重写 windowStart）
  PERF-03 方案 1（0.5d，spend 覆盖索引）
  PERF-18（0.5d，定义性能预算 + 扩展 benchmark）
  → 验收：catch-up header RPC 有界；Merkle 4096 叶 <3ms

Sprint 3（第 5 周及以后）— 构建/CI/记录项
  PERF-15（0.5d，CI 去双跑 + forge 缓存）
  PERF-14（0.5d，BuildKit cache mount，不减安全）
  PERF-03 方案 2（2d，spend SQL SUM 下推）
  PERF-12 / PERF-16：已评估，判定不改，记录归档
```

## 验证方式

- **写路径**：扩展 `scripts/benchmark-indexer.mjs`（已有 Node-24 断言、build 指纹、cleanup 断言）覆盖新默认；`disk` 模式 rows/s 需 >40k。
- **读路径**：在同一 benchmark 加查询延迟用例（actions/spend/summary），断言 <5ms。
- **RPC 数量**：用 viem mock transport 统计 `eth_getBlockByNumber` 调用数（批量化前后对比）。
- **CPU**：为 `actionRequestDigest` / `merkleProof` 加微基准（可复用 core 的 vitest）。
- **gas**：`forge test --match-contract GasBudget` + `.gas-snapshot` drift（CI nightly 已有报告）。
- **CI 时长**：对比 PR 上 ts-sdk job 优化前后耗时。

---

## 附录 A：本次分析使用的只读探针（已删除）

| 探针 | 目的 | 关键输出 |
|---|---|---|
| `.perf-probe.mjs` | 20 万行查询计划/延迟/写吞吐 | 全扫 vs 索引、journal 模式、autocommit vs 批事务 |
| `.perf-probe2.mjs` | 链范围对比、`prepare()` 开销、签名/Merkle CPU | 5.41µs vs 0.003µs（1811×）、digest 512KB=29.93ms、Merkle 4096=38ms |
| `.perf-probe3.mjs` | spend 覆盖索引、journal×sync、真实写路径 | covering idx 55ms、wal/delete 对比、569 vs 43761 rows/s |
| `.perf-probe4.mjs` | 构建产物级 `SigilIndexer` 读路径 | `actionsForAgent+slice` 116ms、`summary` 39-51ms |

所有探针在内存库 / 系统临时目录运行，退出前 `rmSync` 清理；工作区 `git status` 未因本次分析新增文件。

## 附录 B：复核的既有基线（与目录已有 PERF 编号对照）

本目录已有 PERF-1/3/4/5 编号被代码注释引用（如 client.ts:611 "Cost (PERF-1)"、indexer.ts:25 "PERF-5/ARCH-3"、client.ts:731 "PERF-3"、GasBudget.t.sol:19 "PERF-4"）。本分部沿用该编号空间，未复用旧编号以避免冲突 —— **建议发布前与既有 catalog 对齐编号**。
