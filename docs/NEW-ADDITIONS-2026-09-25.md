# SigilKit — New Additions：建议新增的模块、组件与集成

> 日期 2026-09-25 · 5 个并行只读分析 agent（新增模块 / 第三方集成 / 数据运维 / 治理安全 / 部署分发）
> 筛选标准：符合现有架构（npm workspaces + 4 包 + 5 语言混合 + Foundry）、可落地、有明确受益方

## 三个决定结论可信度的前置事实

| 事实 | 证据 | 对建议的影响 |
|---|---|---|
| **发布链路整体阻塞** | `docs/DEPLOYMENT.md:112-117`：`@sigilkit/core` 在 npm 上已被无关项目占用（v0.11.1），`indexer`/`mcp` 为 E404 | 所有新包**不宜设为独立发布物**；建议先作 workspace 内部包（`private: true`）落地，namespace 定了再转正 |
| **新包会被现有门禁脚本误伤** | `publish.yml:37` 硬编码 `['core','indexer','mcp']`；`ci.yml:165` 硬编码 `for p in core indexer mcp` | 新包需同步改这 2 处，否则 `npm pack` 预检与版本一致性校验直接漏检/误判 |
| **ABI 生成无脚本、仅存在于 CI inline** | `forge inspect` 全仓只出现在 `ci.yml:178`、`CONTRIBUTING.md`、`docs/`（`scripts/` 下零命中） | 建议 A-1 的价值被显著放大：它不是"锦上添花的生成器"，而是把 CI 内联逻辑收敛成可复用、可本地运行的构建期事实源 |

---

# 一、新增模块/包（A 分部，11 条）

| # | 包名 | 职责 | 依赖 | 与现有包关系 | 工时 | 优先级 |
|---|---|---|---|---|---|---|
| **A-1** | `@sigilkit/abi` | build 时从 `forge inspect` 生成 ABI JSON + `.d.ts` 常量类型 | dev: ts；`forge` 为**构建期**前置 | **从 `core` 抽出**（当前 `packages/core/abis/*.json` 4 份 + `src/abis.ts` 98 行手写均归入） | **2–3 日** | **P0** |
| **A-2** | `@sigilkit/whitelist-gen` | 从协议 ABI + 参数实例生成 v2 pinned 叶子、Merkle 根与证明 | `viem` + `@sigilkit/core` | 补 `core` 已有原语的"生产化外壳" | **3–4 日** | **P0** |
| **A-3** | `@sigilkit/policy` | Scope/Scope v2 DSL 编译器：YAML/TS → 链上 Scope + 链下预检规则 | `yaml`（已在 root devDeps）+ `core` | 与 `core` 的 `Scope` 类型、`mcp` 的 `build_scope` 并存，**消费**二者不重复实现 | 4–6 日 | P1 |
| **A-4** | `@sigilkit/verify` | 部署后配置正确性自检（attest）：读链上 Scope/denylist/owner 与期望比对 | `viem` + `core` | 复用 `core/logger` + `core/cli`；与 `scripts/verify.mjs`（本地门禁）**职责不同** | 3–4 日 | P1 |
| **A-5** | `@sigilkit/relayer` | 独立服务化 relayer：fee 策略、nonce 管理、MEV 保护、跨进程租约 | `viem` + `core` | 替换 `demo-agent` 的"owner 兼 relayer" demo 模式 | **6–9 日** | P1 |
| **A-6** | `@sigilkit/7702-bundler` | type-4 交易构造与发送封装 | `viem` + `core/eip7702` | 消费 `eip7702.ts` 已有原语 | 3–4 日 | P1 |
| **A-7** | `@sigilkit/chain-config` | chainId ↔ Manager/Delegator/7579 模块地址、确认数、RPC 端点策略注册表 | `viem/chains`（只读） | 消费 `core/config.ts` | 2–3 日 | P1 |
| **A-8** | `@sigilkit/fixtures` | Anvil 部署产物、golden 向量、假数据（供下游与多语言测试复用） | 零运行时依赖 | 消费 `vectors/*.json` + `abis/*.json` | 2–3 日 | P2 |
| **A-9** | `@sigilkit/testkit` | 给集成方的契约测试套件（让下游能在自己 CI 里验证 session key 集成） | `core` + `viem` + Foundry | 提炼自 `core/test` | 4–5 日 | P2 |
| **A-10** | `@sigilkit/observability` | OpenTelemetry 封装（span 定义、审计关联 id 贯穿） | `@opentelemetry/api`（api-only） | **构建于** `core/logger` 之上，不替代它 | 4–6 日 | P2 |
| ~~A-11~~ | ~~`@sigilkit/cli`~~ | ~~统一 CLI 框架~~ | — | **已被 `core/src/cli.ts` 实现** | **0** | **不做** |

## A-1 · `@sigilkit/abi`（P0，价值高于预期）

**原以为是"消除手写声明"的一般性改进，实际核出**现有漂移门存在真实漏洞**：`abi-drift.test.ts:56` 只遍历 `abi-targets.txt` 的 4 个合约加载 `generated`，而 `abis.ts` 中的 `ACTION_LOGGER_ABI`（来自 `ActionLogger.sol`）和 `PerActionCapExceeded`/`PerWindowCapExceeded`（来自 `SpendPolicy.sol`）**恰好来自未列入该清单的 3 个合约**。

**后果**：改 `ActionLogger.sol` 的事件字段，本地 vitest 与 CI 漂移门**都无法察觉**（`generated` 里根本没有这两个合约的条目可比对）。这不只是"多一层生成"，而是补上一个真实的门禁漏洞 —— 使本条从 P1 上升为 P0。

**落地要点**：
- 以 `abi-targets.txt` 为唯一清单输入，生成器同时输出 `abis/*.json` 与 `generated.d.ts`（`as const satisfies Abi`）
- `abi-drift.test.ts` 两个方向都保留：手写项必须存在于生成物（防漏）、生成的新 error 必须被处理（防漂）
- 决策点：`abis.ts` 中**保留** `SIGILKIT_ERRORS_ABI` 作为"解码器注册表"（`errors.ts` 依赖它做 `decodeSigilKitError`），但其内容改为**从生成物 re-export**，而非从 Solidity 重新推导语义分组

## A-2 · `@sigilkit/whitelist-gen`（P0，能力缺口最明确）

**为什么 P0**：合约侧 v2 白名单**已完整实现并启用** —— `SessionKeyManager.sol:324-334`（pinned/wildcard 双叶子）与 `SessionKey7579Module.sol:226-230,286-290`（含 batch per-tuple proof）都在工作。**但链下没有任何工具能生成 pinned 叶子**：`mcp` 的 `build_scope:156` 写死 `targetLeaf(t.target, t.selector)`（第三参恒 undefined → wildcard）。

**现状是"合约有能力、链下无入口"** —— v2 白名单的核心安全价值（绑定精确 calldata，如固定金额的 token 转账）**对使用者不可达**。这是全清单中能力缺口最明确的一条。

**落地要点**：
- 输入形态 `[{ abi, function, args }]`，用 viem `encodeFunctionData` 产出 `data`，再 `targetLeaf(target, selector, data)`
- 复用 `core` 已导出的 `targetLeaf`/`merkleRoot`/`merkleProof`，**不重新实现哈希**（TS↔Solidity 32 项零硬不一致是本项目最大优势，重复实现会打破它）
- 必须显式拒绝 `merkleRoot == 0`（allow-all）除非调用方二次确认 —— `SessionKeyManager.sol:335-336` 明确标注 "dangerous"
- 输出需校验 proof 元素数 ≤ 32（对齐 `SessionKey7579Module.sol:88` 的 `MAX_TOTAL_PROOF_ELEMENTS`），这是当前 TS 侧**完全缺失**的约束

## A-5 · `@sigilkit/relayer`（P1，**必须复用而非重写**）

`FileLeaseStore` v2（`lease-fs.ts:24`，SQLite `BEGIN IMMEDIATE` + owner/epoch + reclaim 宽限期）**已在 core 完整实现并测过多进程 SIGKILL 场景**。`sendPrepared`（`client.ts:777`）已支持"prepared payload 交由不同 relayer 发送"，nonce 串行化已有 `nonceGate`。**本包不得重写租约**，应直接复用。

真实增量仅三块：**服务化外壳（HTTP/队列入口）、fee 策略、MEV 保护（private tx / 批处理）**。

**信任边界收益最值得强调**：`demo-agent` 当前同一进程同时持有 owner 私钥与 agent 私钥（`agent.ts:69`），这与"agent 签名、第三方 relayer 提交"的设计意图不符。独立 relayer 进程让 owner key **完全不出现在执行路径**上 —— 这是架构性而非便利性改进。

## A-11 为什么不做

`core/src/cli.ts` 已是成熟框架（`parseArgs`/`helpText` 纯函数、`runCli` 统一退出码 0/1/2、未知选项 Levenshtein 建议、值类型校验 getter），且**三个 CLI 已全部复用**（`indexer/src/cli.ts:20`、`mcp/src/cli.ts:16`、`demo-agent/src/cli.ts:24`），已通过 `@sigilkit/core/cli` 子路径导出。

**结论**：三处 CLI **不存在重复实现**。此前提设与代码事实不符。**不建议**为它新增第 N 个包 —— 那反而会制造 core ↔ cli 的循环依赖风险。

---

# 二、第三方集成（B 分部，15 条）

## 五条结论先行

1. **不建议复活完整的 Component 3 Multi-RPC Provider。** 建议只恢复一个薄的"RPC 角色与健康策略层"：继续使用 viem，不自建 WebSocket/HTTP transport；按执行模拟、archive/index、fork、4337、私有交易拆分端点。
2. **`@sigilkit/indexer` 应继续作为 canonical evidence store。** The Graph、Subsquid、Envio、Goldsky 适合做镜像、查询 API 或对照实现，**不应取代**现有 SQLite 索引器。
3. **钱包托管平台不应成为核心默认依赖。** Privy、Turnkey、Fireblocks 更适合作为可选的 owner/countersign 远程签名器；agent session key 仍可保持 viem 私钥账户或 ERC-1271 路径。
4. **ERC-4337 bundler/paymaster 是条件性 P2。** 现有 `SessionKey7579Module` 已有验证层，但 `ActionLogged` 要由执行器在执行时产生；`SigilKitClient.assertAuditEmitted` 当前不覆盖 7579 executor 路径，接入 bundler 前必须补上专用 receipt/audit 验证。
5. **OpenZeppelin Upgrades 当前不应引入。** `SECURITY.md` 明确 immutable-by-design；`SigilKitDelegator` 的实现地址还要求保持 inert。

## 集成清单

| ID | 集成 | 用途与落点 | 引入成本 | 优先级 | 锁定风险 |
|---|---|---|---|---|---|
| **B-1** | **RPC Provider 适配层**：Alchemy/QuickNode/Chainstack/Pimlico/1RPC | 不复活完整 C3；把单一 `SIGILKIT_RPC_URL` 拆为 execution/simulation、archive/index、fork、4337、private 端点，用 viem `fallback` + 健康评分 + 熔断 + block-lag 监控 | 配置低–中；完整健康评分中–高 | **P1** 生产 | 配额/SLA/端点迁移；不同供应商可能返回不同链视图；**不能把交易请求静默降级到会泄露的公共 RPC** |
| **B-2** | The Graph | 作为 `ActionLogged`/`WindowCharged` 的 GraphQL **镜像**，面向外部 dashboard 与生态查询；**不作为唯一审计证据** | 中（3–7 d）+ 托管费 | P2 | GraphQL entity/索引延迟；reorg 语义与当前 fail-closed 索引器不同 |
| **B-3** | Subsquid | 高吞吐多链 ETL 后端；把规范化审计事实表同步到 SQL/Arrow | 中（3–7 d） | P2（日志量大时升 P1） | Processor schema 迁移；自托管可降锁定但增运维 |
| **B-4** | Envio HyperIndex | 实时多链事件流；作为现有 SQLite 的**旁路读模型** | 中（3–7 d） | P2 | schema/adapter/cloud 绑定；迁移需保留原始事件与 block hash |
| **B-5** | Goldsky | 托管 GraphQL + 缓存 + federation，让前端/MCP 快速获得 schema | 低（1–3 d） | P2 | 缓存可能返回陈旧数据，**必须带 freshness watermark** |
| **B-6** | **Signer Adapter + Privy/Turnkey/Fireblocks** | 保留 viem `privateKeyToAccount` 作为本地 agent/test signer；远程托管**只作为 owner、治理和高价值动作的可选 signer** | 接口与 mock 中；接入一家**高** | P2 先做接口；具体商 **P3** | 托管信任、KYC/数据驻留、迁移成本；**远程 signer 失败时必须 fail closed**；EIP-7702 self-owned EOA 与托管智能账户**并不天然兼容** |
| **B-7** | ERC-4337 Bundler/Paymaster：Pimlico/Alchemy/Relay.link | `sendPrepared` 已允许任意 relayer，所以直接 relayer **不是核心缺口**；第三方 bundler 主要服务 4337 账户与 gas sponsorship | 中–高（3–7 d 起步） | P2 | 赞助滥用/审查/可用性风险；**对 7579 路径必须验证执行 receipt 中的 `ActionLogged`，不能把 validation 当作 execution** |
| **B-8** | **Flashbots Relay / Protect / `setPrivate`** | 高价值 treasury action 使用私有交易；**单独配置 private transport，不与普通公共 RPC 自动混用** | 中（2–5 d） | **P1** 高价值生产流 | **失败时若自动 fallback 到公共 RPC，会直接泄漏意图** |
| **B-9** | OpenZeppelin Defender + Forta | Defender 做定时模拟/事件监控/告警；Forta 做独立网络 bot 监测授权、撤销、异常 spend、`ActionLogged`/`WindowCharged` 模式 | 中（3–7 d）+ 服务费 | Defender **P1**；Forta P2 | 专有 dashboard/API、告警语义；**不应让监控服务自动执行资金操作** |
| **B-10** | OpenZeppelin Upgrades | **仅为未来可升级 Safe/Kernel 包装器预留**；当前 immutable manager 与 inert 7702 implementation **不需要它** | 评估低；改架构高 | **P3 / 暂缓** | 引入 proxy/升级权限/mutable admin surface，与当前安全承诺冲突 |
| **B-11** | Certora Prover / ProVerif | Certora 对 SpendPolicy/session auth/7579/7702 边界做独立证明；ProVerif 建模授权/撤销/重放协议 | Certora **高**（商业许可）；ProVerif 中 | Certora P1/P2（有预算时）；ProVerif P3 | **不能把模型结果称为完整审计**；模型假设可能与实际 EVM 语义不一致 |
| **B-12** | OpenTelemetry JS + prom-client | OTel 记录 RPC/lease/indexer poll/receipt trace；prom-client 暴露 cursor lag、RPC fallback、reorg stop、lease loss | 中（2–5 d） | **P1/P2**，生产前应完成最小指标集 | OTLP 后端、metric naming、label cardinality；trace 可能含地址/target/calldata |
| **B-13** | DuckDB + Parquet | 对 finalized audit export 做离线分析/BI；**不替换 `node:sqlite` writer、lease DB 或 MCP canonical read path** | 中（3–7 d） | P2 | SQL 方言、对象存储、schema 演进；**`uint256` 必须保持精确十进制/大整数，不能转 float** |
| **B-14** | **Sigstore/cosign + SLSA + GitHub Artifact Attestations** | 为 npm 之外的发布对象增加可验证证明：Foundry artifacts、ABI、Docker image digest、SBOM、release manifest | 低–中（1–3 d 接入） | **P1/P2** 发布硬化 | 必须保存**离线 bundle**，不能只依赖在线平台；**不证明合约正确性** |
| **B-15** | 钱包适配：MetaMask SDK/Coinbase Wallet SDK/WalletConnect v2/Reown AppKit | 放在独立 web/app 包，通过 EIP-1193 provider 连接 `core`；**不把钱包 SDK 依赖带入 MCP/indexer/server SDK** | 单适配器中（3–7 d）；持续维护成本高 | 一个 web adapter **P2**；广泛矩阵 P3 | SDK/projectId/UX 锁定；**WalletConnect 支持多钱包 ≠ 支持 7702/EIP-712 全部流程** |

## 必须保留的安全不变量（多 RPC 场景）

① 多 RPC **不能解决链视图不一致问题**；② `eth_getLogs`/block header/receipt 应按 provider affinity 或 hash 校验；③ 发送已签名交易时**不应因为一次 RPC 超时就盲目改变执行路径**；④ **私有交易失败时必须明确报错或由用户确认，不能自动公开广播**；⑤ 第三方 RPC 能看到 IP/地址/target/calldata/时序，隐私敏感场景需单独审查数据政策。

## 索引后端专项判断

现有 `@sigilkit/indexer` 已具备：`(chain_id, tx_hash, log_index)` 幂等键、`block_hash` 记录、cursor hash 校验、confirmations、chunked `getLogs`、exponential backoff、reorg fail-closed、事务内 cursor 校验和提交。

**建议架构**：
```
RPC raw logs → @sigilkit/indexer (canonical) → node:sqlite
                                    ↓ mirror
              The Graph / Subsquid / Envio / Goldsky
                                    ↓ finalized export
                          Parquet → DuckDB
```
外部后端应定期回传或对账：`chain_id`/`tx_hash`/`log_index`/`block_hash`/`value`/`spentThisWindow`（精确大整数）/finalized watermark。**外部后端不可用时应报告 `unknown` 或 `stale`，不能显示成"零次操作"。**

---

# 三、数据/运维/可观测性资产（C 分部，12 条）

## 复核结果：对"现状要点"的修正

| 原要点 | 修正 |
|---|---|
| "无 manager 列" | **部分不成立**。`actions`/`window_charges` 无 manager 列，但 `sync_state` 是 `(chain_id, manager)` 主键 —— **游标按 manager 隔离、数据按 chain 全局**。这个不对称是 `removeLog`/`rollbackTo` 只能 `WHERE chain_id=?` 的根因 |
| "无备份/恢复脚本" | 更严重：**文档推荐的恢复命令在交付镜像里跑不了**。`docs/DEPLOYMENT.md:191` 写 `sqlite3 audit.db ".backup"`，但 Dockerfile 是 `node:24-bookworm-slim`（未装 sqlite3） |
| "migrate() 无事务包裹" | 确认，且**无任何版本标记**。`lease-fs.ts:39-47` 已有 `BEGIN IMMEDIATE` + `STRICT` 的成熟范式可抄 |
| "3 表 3 索引" | 补：3 个索引全是 `(chain_id, …)` 前缀，但默认查询不传 chainId（`:710`）→ **走不上任何索引**；且**无 `block_number` 索引**，而 rollback/reorg/归档都要它 |
| — | **审计库未启用 `synchronous=FULL`，也没开 WAL**。`lease-fs` 对租约用了 FULL，审计库反而用 SQLite 默认 —— 对"审计制品"这是不该省的 |
| "check-doc-counts 声称守 CHANGELOG 但没做" | 确认（`:5-8` 声称 vs `:334` 只读 README+白皮书） |
| — | 补：`serve-manual.mjs:35` 的证据写入**无 schema 且 `catch {}` 静默吞错**；目标是 gitignored 的 `outputs/` → **旗舰 claim（真 MetaMask 签了 ActionRequest）的证据会蒸发且无人察觉** |
| — | 补：`storeAction(r, blockHash = null)`（`:223`）默认 blockHash 为 null → 经此路径写入的行**无法做 reorg 校验** |
| — | 补：`SessionKeyGranted/Revoked/Rotated/Reinstated`（`SessionKeyManager.sol:90-92`）**索引器完全不采集** → "session key 疑似泄露"场景下审计库答不出"该 key 存活期间做了什么" |

## C 分部清单

| # | 条目 | P | 工时 | 收益 |
|---|---|---|---|---|
| **C-1** | 审计库 schema 版本化 + 迁移链 | **P0** | 1–1.5 d | 把 schema 从"构造器里一段 if/else"变成声明式可审计制品；`PRAGMA user_version` + `_migrations` 表 + checksum（发布后改动 = 硬失败）；runner 照抄 `lease-fs.ts:120-134` 的 `BEGIN IMMEDIATE` |
| **C-2** | 备份/恢复/完整性验证（`VACUUM INTO`） | **P0** | 1–1.5 d | **不依赖外部 sqlite3 二进制**（当前文档推荐的命令在镜像里跑不了）；verify 走 `PRAGMA integrity_check` + 逐表 COUNT 对账 + `manifest.json`（含 sha256/blockRange/rowCounts） |
| **C-3** | `manager` 归属列 + 作用域化重放 | P1 | 2–3 d | 让多 manager 共库安全；reorg 恢复从全量重索引降为增量。**历史行无法归属** → 统一标 `manager=''` unknown 桶，**绝不静默归给当前 manager** |
| **C-4** | `sigilkit-indexer` 运维子命令集 | P1 | 2–3 d | `status`（schema 版本/游标滞后/行数/`rows_ahead_of_cursor`/`block_hash IS NULL` 占比）、`doctor`（每项失败给下一条命令）、`reorg-recover`（建新库→重放→diff 表→`--promote` 才切换）、`compact` |
| **C-5** | 指标端点 + 告警规则 + 看板 | P1 | 3 d | **最高杠杆**。当前 healthcheck 是 `accessSync(dbPath)` —— 进程卡在 60 s 退避循环里**依然报 healthy**。埋点全部落在已有代码行上；`cursor_validation_failures_total` 的 reason code **错误文案已天然区分三种原因**（legacy-null / header-unavailable / hash-mismatch），计数几乎零成本 |
| **C-6** | 链上对账引擎 + 数据质量监控 | P1 | 3–4 d | **全套里正确性价值最高**。四类判定各自独立结论：`on_chain_not_in_db`（漏事件）/ `in_db_not_on_chain`（孤儿行 = removeLog 漏删的 reorg-out **或跨链孤儿 bug**）/ `value mismatch`（ABI 漂移）/ `null_block_hash_ratio`。顺带采集 key 生命周期事件 |
| **C-7** | 运维 Runbook（6 场景 → 处置） | P1 | 1.5 d | 六个场景：reorg / 游标损坏 / RPC 挂 / 库锁 / session key 泄露 / relayer 故障。**当前 `TROUBLESHOOTING.md` 27 节全是开发环境，零生产内容** |
| **C-8** | 配置即代码 + 多环境矩阵 + 漂移门 | P1 | 1 d | `deployments/{env}.json` 机器可读部署记录（当前 `Deploy.s.sol:39-42` 只 console.log，文档直言"记在你自己的 runbook 里"）；`check-config.mjs` 扫 `readEnv*` 调用点 vs `.env.example` 双向校验 |
| **C-9** | Node 验证器族 + 证据归档 | P1 | 1.5 d | 覆盖 C-8 的漂移门 + CHANGELOG 6 处漂移 + `serve-manual.mjs` 的证据静默蒸发（改为**证据文件缺失 = 运行失败**） |
| **C-10** | lease/relayer 可观测 | P2 | 1.5 d | `lease-fs.ts` 质量很高但**零观测点**（`isHeld()` 自述"Diagnostic only"）；每次抢占静默 `epoch+1`，没人知道发生过 |
| **C-11** | 容量规划 + 保留期 + 磁盘告警 | P2 | 1.5 d | 用数字回答"什么时候磁盘满"。行成本基线：11 列中 5 个是 32 字节 hex + 2 个十进制串 → 含两个组合索引估 **180–260 B/行** |
| **C-12** | 审计导出（JSONL/CSV） | P2 | 1.5–2 d | **Parquet 明确列为 v0 非目标**（真正的 writer 是重依赖）→ 改出 `.jsonl.zst`，文档给一行 DuckDB 替代方案。**CSV 的 `value` 必须是十进制字符串**（`SUM(value)` 是正确性地雷） |

## C-5 最小指标集

`cursor_lag_blocks`/`cursor_age_seconds`/`rows_ahead_of_cursor`/`events_ingested_total{chain,kind}`/`rpc_errors_total{method,reason}`/`rpc_retries_total`/`poll_failures_total`/`reorg_events_total`/`cursor_validation_failures_total{chain,reason}`/`db_rows_total{table}`/`db_size_bytes`/`build_info{version,node,schema_version}`。

**告警规则**：`cursor_lag_blocks > 500` 持续 10 m；`rate(poll_failures_total[15m]) > 0.5` 持续 30 m；`increase(reorg_events_total[1h]) > 0` → **呼叫**（fail-closed 意味着它不会自愈）；`absent(build_info) 5m` → 进程死亡（**替代 `accessSync` healthcheck**）。

## 明确**不**建议做的

1. **换数据库**。`node:sqlite` 零原生依赖、Node ≥24 已声明、`lease-fs` 已证明它能扛跨进程互斥。当前瓶颈是**运维缺位**，不是引擎能力。
2. **上 Prometheus 完整栈**。手写 ~200 行 registry 就够；引入 client 库会给这个"零运行时依赖"的项目增加发布负担。
3. **Parquet 一期做**（见 C-12 的 trade-off）。

---

# 四、治理 + 安全运营（D 分部，12 条）

## 三个"地基级"发现

1. **E10 副签与 Safe owner 不兼容**：`SessionKeyManager.sol:308` 用 `_ecrecover(approvalDigest, ownerApproval) != s.owner` 校验，而 `_ecrecover`（`:602-616`）只接受 65 字节 ECDSA。**Safe 是合约，永远无法作为 `ecrecover` 结果出现** → 一旦按文档把 owner 设为 Safe，**所有超阈值动作的 owner 副签路径永久不可用**。
2. **治理事件不足以重建状态**：`SessionKeyGranted(key, expiresAt)` 只记 expiresAt，不记 cap/merkleRoot/tokenWatchlist/denylist；而对**未撤销的已有 key** 再 grant **静默覆盖整个 Scope**（`:176`），**无 `ScopeUpdated` 事件** → 事后无法从日志证明"某时刻 cap 是多少、是否被谁改过"。
3. **无 key 枚举能力**：`scopes` 是 `mapping` → **"一键 revoke 所有 key" 当前在链上不可实现**。

## D 分部清单

| # | 条目 | P | 工时 | 前置 |
|---|---|---|---|---|
| **D-1** | 预签名治理：Safe 强制化 + **E10-1271 修复** | **P0** | 2–3 d | — |
| **D-2** | Timelock 治理层（48h/6h/0h 分级） | **P0** | 4–6 d | D-1 |
| **D-3** | 四角色权限分层（owner/auditor/operator/agent） | **P0** | 4–5 d | D-2 |
| **D-4** | 治理事件补全 + 链式摘要证明 | **P0** | 3–4 d | D-1 |
| **D-5** | 紧急响应 SDK（全量 revoke / freeze / 时间线） | **P0** | 3–5 d | D-4、D-2 |
| **D-6** | 部署后自动验证器 | **P0** | 2–3 d | D-1、D-2 |
| **D-7** | 密钥轮换自动化 + KeyEpoch/ScopeRevision | P1 | 4–6 d | D-3、D-4 |
| **D-8** | 私钥零知识处理（AA/KMS/一次性 deployer） | P1 | 2–3 d | D-1 |
| **D-9** | osv-scanner + CycloneDX SBOM + 签名 | P1 | 2–3 d | — |
| **D-10** | 漏洞自动分诊（form → 矩阵 → 跟踪） | P1 | 2 d | 仓库/URL 落地 |
| **D-11** | On-call 轮换 + 响应 SLO | P2 | 1–2 d | D-5、D-10 |
| **D-12** | Policy-as-Code 声明式 scope 治理 | P2 | 3–4 d | D-3、D-4、D-6 |

## D-6 部署后验证器应断言什么（fail-closed）

① `owner` 为 Safe 2-of-3（或 timelock）且**不是** deployer EOA；② **全管理 selector denylist 覆盖**（6 个 admin 函数全部 `isSelectorDenied == true` —— 当前 owner 可事后 `setSelectorDenied(sel, false)` 解除，**无任何 invariant 保护**）；③ 每个已登记 key：`perActionCap > 0`、`perWindowCap >= perActionCap`、`expiresAt > now`、**`merkleRoot != 0`**；④ countersign 阈值不为 0 或 Safe-1271 路径已验证；⑤ timelock 最小延迟与角色存在。输出 `deployment-attestation.json`，CI/发布门禁消费。

## 明确范围护栏

- ❌ **不引入 UUPS/可升级代理**：`SECURITY.md:46-50` 已决定 immutable-by-design，本组所有条目均通过"换 key / 重部署 + timelock"实现治理。`vault/Build Plan.md:40` 的 "UUPS under Safe + 24h Timelock" 与现行决策矛盾，应在文档层统一（**Timelock 保留、UUPS 移除**）。
- ❌ **SDK 不托管 owner 私钥**：D-5/D-7 的 SDK 只构造交易 payload，签名权始终在 Safe/operator 侧。
- ❌ **7579 模块不套 owner/operator 角色**：其管理面是账户自管理（`:147-163`），强行套用会破坏 ERC-7579 语义。

---

# 五、部署形态 + 分发渠道（E 分部，12 条）

## 两个发布硬阻塞

① `@sigilkit` scope 被他人占用；② `github.com/sigilkit/sigilkit` 返回 404。**发布前必须先解决命名空间与仓库归属。**

## E 分部清单

| # | 建议 | P | 工时 | 月度成本 |
|---|---|---|---|---|
| **E-1** | 发布 scope 策略（改个人/自有组织 scope 解锁） | **P0** | 一次性 | $0 |
| **E-2** | 容器分发：GHCR + 多架构（amd64/arm64）+ 生产 compose profile | **P0** | 1–2 d | $0 |
| **E-3** | npm 可执行入口（`indexer` 补 `bin` 字段） | **P0** | 30 min | $0 |
| **E-4** | 生产 compose profile（资源上限/日志轮转/read_only+tmpfs） | P1 | 0.5 d | $0 |
| **E-5** | CD 流程：`next` dist-tag canary + 容器并入发布链 | P1 | 1–2 d | $0 |
| **E-6** | 多包版本策略：core 独立 SemVer + peerDependencies | P1 | 1 d | $0 |
| **E-7** | 文档托管：Docusaurus（静态自托管，GitHub Pages 免费） | P1 | 1 d | $0 |
| **E-8** | 二进制分发：Node SEA / `bun build --compile`（先 indexer 单文件验证可行性） | P1 | 1–2 d | $0 |
| **E-9** | Helm chart | P2 | 1–2 d | $0 |
| **E-10** | pnpm 迁移 | P2 | 1–2 d | $0 |
| **E-11** | 边缘只读查询（Workers/D1，**写路径永不迁**） | P2 | 2–3 d | $0–5 |
| **E-12** | 托管 SaaS | **P2 / 暂缓** | 4–8 d | $25–70 |

## 关键判断

**E-3 为什么是缺陷修复**：`packages/indexer/package.json` **无 `bin` 字段**（只有 `exports["./cli"]`），而 `mcp` 有 `bin:"sigilkit-mcp"` → 当前 `npx @sigilkit/indexer` **装不出命令**，而 `DEPLOYMENT.md` 的 `sigilkit-indexer backfill` 只在仓库内 `node …/cli.js` 才成立。属文档/分发不一致。**注意**：`check-package-artifacts.mjs` 会校验 `bin` 路径必须在 `files[]` 内（现为 `["dist","README.md"]`）。

**E-11 为什么写路径永不迁**：`node:sqlite`（`DatabaseSync`）是**同步 + 本地文件 + 单写者**；`watch` 是常驻 `eth_getLogs` 轮询 + confirmations —— 与边缘无状态/短生命周期/只读 FS **完全冲突**。正确拆法是「写路径留常驻容器、读路径才上 edge」。

**E-12 为什么暂缓**：MCP 仅 stdio、审计库是本地 SQLite，**不存在任何 HTTP/API/认证/多租户面** —— SaaS 需从零建服务层；安全审计数据还带合规负担。起步 infra ≈$25–70/月**另加不可忽略的运维/合规人力**，收入未验证前为净负。**有 ≥3 个付费意向客户再启动。**

## 部署路线图

| 阶段 | 内容 | 关键产出 |
|---|---|---|
| **0–30 天（P0，解锁发布）** | E-1 定 scope + 修仓库 URL → E-3 补 bin → E-2 上 GHCR 多架构 | 跑通首个 `v*` tag 全链 |
| **30–60 天（P1）** | E-5 canary + 容器并入发布链 → E-6 分组版本 + peerDeps → E-4 生产 compose → E-7 文档站 | 版本策略与文档入口 |
| **60–90 天（P2）** | E-8 二进制 → E-9 Helm → E-10 评估 pnpm → E-11 边缘读路径（有需求再做） | 安装门槛再降一档 |
