# SigilKit — Verification & Testing Strategy (1/2)

> 日期 2026-09-25 · 5 个并行只读分析 agent（框架 / 合约层 / TS 服务层 / CI 自动化 / UAT 验收）
> 目标：把「工具是否通过」为中心的现状，转为「用户能否完成任务 + 运营者能否恢复」为中心的保证
> 承接：本文件含 VTS-A（框架）+ VTS-B（合约层）+ VTS-C（TS 服务层）；VTS-D（CI）+ VTS-E（UAT）见 `VERIFICATION-STRATEGY-2-CI-UAT.md`

## 四个改变策略优先级的实测发现

| # | 发现 | 证据 | 影响 |
|---|---|---|---|
| **F-A1** | **Foundry fuzz 层实际为空**：`fuzz.runs` 被 0 个测试消费 | 116 个 `test_*` 中带参数的仅 3 个（`Halmos.t.sol` 的 6 个 `check_`）；非 Halmos 文件中 `vm.assume`/`vm.bound` **0 处** | `[profile.ci.fuzz] runs=2000` 与 `deep 10000` **无消费者** —— 加深度不改变覆盖率。属性层实际只有 3 个来源（invariant/Echidna/Halmos） |
| **F-A2** | **HalmosAuth 5 个规格可被平凡满足** | `block.timestamp` 是 Halmos 的**自由符号变量**；`setUp` 授予 `expiresAt = GRANTED_AT + 1 days`，但 5 个 check **无任何时钟约束** → 求解器可取 `block.timestamp > expiresAt` 使一切 revert | `check_execute_WindowSpendNeverExceedsCap` 断言 `spent <= 2 ether` **恒为 `0 <= 2 ether`**；叠加 `_recover` 被 `SeamManager` 覆写 → 证明的是"过期时一切 revert"而非 replay/denylist/窗口上限 |
| **F-A3** | **合约侧覆盖率零门禁，与 TS 侧 4 个阈值门不对称** | TS 4 包有 vitest `thresholds`；`forge coverage` **仅 nightly 上传 artifact，无阈值** | vault `Audit Raw Findings` 与 Issues-Catalog-09-11 都要求"forge coverage with threshold gate (~85% lines / 75% branches)"—— **未实现** |
| **F-A4** | **覆盖率与测试计数有 4 套并存且互相矛盾的数字** | mcp branches：CHANGELOG 73.9% / 实际阈值 50 / 配置注释 53.8（**相差 23.9 个百分点**）；core：92.5/87.9（CHANGELOG）vs 88/74（阈值）vs 90/77（注释） | `check-doc-counts.mjs` 只校验 Foundry 与 job 计数，**对覆盖率与 TS 逐包计数无强制口径**，4 套数字可长期共存而不触发门 |

---

# 第一部 · VTS-A 整体测试策略框架

## 1.1 目标金字塔

```
                        ▲ L7 验收/UAT                    ~0.5%   发布门 + 人工
                      ─────────────────────────────────────────
                    ▲ L6 真实钱包 E2E                    ~3%    每周 → 提级为 PR 门
                  ───────────────────────────────────────────
                ▲ L5 属性/模糊（3 引擎）                    ~8%    PR 门(浅) + nightly(深)
              ───────────────────────────────────────────────
            ▲ L4 符号执行（Halmos）                        ~4%    发布门（需先脱空转）
          ───────────────────────────────────────────────────
        ▲ L3 集成/活链（Anvil / fork）                    ~12%    PR 门 + nightly
      ─────────────────────────────────────────────────────
    ▲ L2 不变量（stateful handler）                       ~10%    PR 门 + nightly
  ───────────────────────────────────────────────────────────
▲ L1 单元/契约测试（确定性）                              ~45%    PR 门
────────────────────────────────────────────────────────────────
▲ L0 静态（solc deny / linter / TS typecheck）            另计    提交前 + PR 门
```

## 1.2 分层定义表

| 层 | 范围 | 目标 | 频率 | 失败处理 | 现状 |
|---|---|---|---|---|---|
| **L0 静态** | solc 警告、forge-lint、TS `tsc --noEmit`、actionlint、gitleaks | 零成本拦截编译期/密钥错误 | 提交前 + PR | **阻断** | ✅ 强（`deny="warnings"` + 33 处 lint 均带书面豁免） |
| **L1 单元** | 116 合约 + 337 vitest | 精确行为契约 | 每次 PR | **阻断** | ✅ 强 |
| **L2 不变量** | 4 invariant × 256 runs × 500 calls，10 个 handler | 状态机全局性质 | 每次 PR | **阻断** | ⚠️ **有自污染** |
| **L3 集成/活链** | Anvil 部署+签名+执行+事件；Base fork | 端到端编排 | Anvil=PR；fork=nightly | Anvil **阻断**；fork **报告** | ⚠️ fork 缺 `secrets.RPC_BASE` 时**整 job 跳过** |
| **L4 符号执行** | 11 Halmos spec | 全输入空间证明 | 发布门 + main | **阻断** | 🔴 **5/11 空转** |
| **L5 属性/模糊** | Forge fuzz（**当前 0 个**）+ Echidna 4 属性 | 随机输入下的性质 | Echidna=nightly（豁免中） | **报告** | 🔴 Forge fuzz 空；Echidna 2 个恒真属性 |
| **L6 钱包 E2E** | MetaMask 13.49.0 + Coinbase designator | 真实钱包兼容 | 每周 | **报告**（豁免至 2026-10-12） | 🔴 断言重言式；Rabby/Biconomy 零覆盖 |
| **L7 UAT** | 真实用户旅程 | 产品可用性 | 发布前 | **阻断（发布）** | ❌ **完全缺失** |
| **横向：安全** | Slither `--fail-high`、gitleaks、依赖审计、形式化 | 已知漏洞类别 | PR | **阻断** | ✅ `contracts/src` 0 high/medium + 53 条分诊 |
| **横向：性能** | `GasBudget.t.sol` + `.gas-snapshot` + `benchmark-indexer.mjs` | 资源回归 | gas=PR；drift=报告；benchmark=**无门** | gas **阻断** | ⚠️ benchmark **未接入 CI** |

> **Unverified as of 2026-10-01 — 上表"现状"列是 2026-09-25 的快照；本轮未复测其中任何数字或判定，一律保持原文未改。**
> 同一审计集内的后续文件对其中若干项给出相反结论，本轮**不判定任何一方为错**、**不改写任何一个数字**：
>
> | 本表位置 | 本表写的 | 同一审计集内的相反记录 |
> |---|---|---|
> | L0 | 33 处 lint 注解 | `docs/NUMBERS-2026-09-26.md` §1 基线表 / §7 = **49**；`docs/PLAN-STATUS-2026-09-26.md` §9.1b = **54** |
> | L1 | 116 合约 + 337 vitest | `docs/NUMBERS-2026-09-26.md` §1 基线表 = Foundry **158 tests / 14 suites**；`docs/STALENESS-2026-09-26.md` §1.1 分类表的 `PROJECT-REVIEW-2026-09-17.md` 行称 "real is 158 / 337+" |
> | L4 | 🔴 5/11 空转 | `docs/NUMBERS-2026-09-26.md` §4.1 表记 harness 已有反空转守卫；同表记该 catalog 已被 `docs/ISSUES-CATALOG-2026-09-25.md` 取代、"时序正确，非当前态" |
> | L5 | Echidna 2 个恒真属性 | `docs/NUMBERS-2026-09-26.md` §4.2 表记 P0-2 已修复，两个属性已改为反驳式 |
> | L2 | 4 invariant × 256 runs × 500 calls，10 个 handler | 本轮未在任何同集文件内找到对这些数字的复测记录；保持原文 |
>
> 同文 §0 的 F-A1 / F-A2（"Foundry fuzz 层实际为空"、116 个 `test_*`、HalmosAuth 5 spec 可被平凡满足）受同样限制。重跑 `forge test`、Halmos、Echidna 与 `foundry.toml`
> profile 并记录日期前，**不得把本表"现状"列当作当前状态引用**。

**配比失衡**：属性层名义 8% 实际 ≈0%（128 个确定性测试给出"完备"错觉，边界之外无探测）；顶层 L6/L7 合计 3.5% 且全为报告级（兼容性声明无阻断性证据）。

## 1.3 每层具体策略

### 单元层：维持 + 补边界
**合约断言规范**：必须断言**具体 custom error**（`vm.expectRevert(Errors.X.selector)`），**禁止裸 revert 断言**（`test_RejectsWrongSigner` 曾是裸 revert）。**缺口**：`countersignAbove != 0` / `enforceNativeDelta: true` / 非空 `tokenWatchlist` 在 116 个测试中仅出现少数几次，**invariant 套件中全部为 0**。
**TS 隔离**：core 现状 `isolate:false` + `fileParallelism:false`（省 8.5% 的实测取舍），但**共享模块状态** —— `config.ts:48` 的 `dotEnvLoaded` 是确凿的模块级可变状态，注释"no cross-file module state"已被 `config.test.ts:168` 证伪（`SIGILKIT_TEST_PRESET` 写入后永不清除）。

### 属性层：**必须立即修复让 fuzz 配置真正被消费**
为 6 个高价值入口各新增带参 `testFuzz_`：

| 目标函数 | 属性 | 建议参数 |
|---|---|---|
| `executeWithSessionKey` | 任意 value/selector/data 下窗口支出不超上限 | `uint256 value, uint48 windowSeconds, uint256 perWindowCap, uint256 perActionCap` |
| `grantSessionKey` | 任何 scope 不满足校验必须 revert（无静默接受） | `uint48 expiresAt, uint48 windowSeconds, uint256 pac, uint256 pwc, uint48 csAbove` |
| `SpendPolicy.enforce` | rollover 判定在 3 态正确 | `uint48 windowStart, uint48 windowSeconds, uint256 spent` |
| `MerkleWhitelist.verify` | 排序对哈希与索引无关 | `bytes32 a, bytes32 b, uint8 depth` |
| `rotateSessionKey` | `overlapEnds <= now` 时旧 key 必被撤销 | `uint48 overlapEnds, uint256 delta` |
| EIP-712 digest | 任一字段变化 ⟹ digest 变化 | 逐字段 `uint256 salt` |

**收敛时间预算**（新增门）：Forge fuzz PR ≤ 90 s（阻断）· deep 10k ≤ 10 min（报告）· Echidna ≤ 30 min（报告）· **Halmos ≤ 15 min（阻断，发布门必须有确定性上界）**· Invariant ≤ 5 min（阻断）。

### 不变量层：handler 设计五准则

| # | ghost 缺陷 | 位置 | 为何不可信 |
|---|---|---|---|
| **G1** | `ghostMaxPerWindowCap` 单调抬高 | `:225-227` | `grantRandom` variant 0 可授予任意大 cap → ghost 随之上抬 → INV-1 **自动通过**。**断言基准被 owner handler 控制** |
| **G2** | `_syncScopeGhost` 跟随式接受 | `:221-235` 从合约读回 scope 写 ghost | ghost 永远等于合约 → INV-4 退化为 `x == x`，**恒真** |
| **G3** | `expectedWindowSpend` 死 ghost | `:259` 写入，**全文件无任何读取** | 死变量，本该是 INV-1 的核心对照量 |
| **G4** | `warpRandom` 跳 400 天 | `:198` | 单次跳过整个 scope 有效期（365 天）→ INV-2 的 expiry 分支与窗口 rollover **几乎必然被跳过** |

**五准则**：① **观察优于意图**（ghost 只能从合约公开视图回读）；② **单调量需可下调**（改为固定调色板 `PALETTE={1,2,3,5} ether`，fuzzer 无法无界抬高）；③ **事件型不变量缺失**（新增 INV-3 可执行不变量：`ActionLogged` 计数 == 成功执行计数 —— 实测 invariant 与 Echidna 文件中 `ActionLogged` **出现 0 次**，全仓仅 1 处 `vm.expectEmit`，而 README 将 INV-3 与 INV-1/2/4 并列呈现）；④ **handler 覆盖度**（缺 `withdraw`、`SessionKey7579Module` validate 路径）；⑤ **时间可控**（分层：70% 小幅、30% 跨窗/跨过期）。

### 集成/活链层
| 项 | 现状 | 策略 |
|---|---|---|
| Anvil 端口 | 硬编码 8545，core/demo 靠 `fileParallelism:false` 串行 | 改**动态端口分配**（`--port 0` + 读 stdout）→ 恢复并行度 |
| profile 污染 | `spawnAnvil` 检测到已有节点即**复用**并仅 `console.warn` | 改**默认 fail-closed**，复用需显式 flag。现状下"本机遗留节点"会让集成测试出现伪失败 |
| fork 静默 | `RPC_BASE` 未设则整 job 跳过（报 success） | 改**可观测跳过**：summary 打出 `⚠️ fork coverage: NOT EXERCISED`，并把"过去 30 天实际执行次数"作为发布门输入 |

### 端到端钱包测试分层（**关键交付**）
**当前真实状态**（逐条核实 `WALLET_BEHAVIOR_ALLOWLIST.json`）：

| 行为 | 声称 | 实际 | 差距 |
|---|---|---|---|
| `metamask:revoke-raw-rejected` | rejected | `run.ts` 历史活跑 | 有证据，**无门禁** |
| `coinbase:delegate-target-stable` | 固定地址 | **两条永真断言** + 一条真实探测 | 证据弱 |
| `metamask:type4-tx-accepts-authorization-list` | accepted | **自述"no live-harness coverage exists"** | **零覆盖且自认** |
| `metamask:13x-gesture-request-ui` | accepted | 仅人工 Brave 检查 | 人工 |
| `rabby` / `viem` / `biconomy` | absent/unsupported/parity | **零执行** | 文档对标 |

**「无覆盖」→「有记录的豁免」机制**：① **schema 扩展**：每条增必填 `enforcement`（`pr-gate`/`nightly`/`manual-evidence`/`documented-exempt`）、`harness`（exempt 时**必须** null）、`evidence{date,runId,logPath,verdict}`、`exemption{reason,owner,reviewBy,impactIfStale}`；② **新增守卫测试 `allowlist-integrity.test.ts`（必须进 PR 门）**：`pr-gate` ⇒ harness 文件必须存在；harness 非 null ⇒ 必须被 `run-all.ts` 实际引用；`reviewBy` 不得早于今天（**过期豁免自动失败**）；③ **三层门禁**：**T0 PR 门**（密码学等价物 —— 已对真实 MetaMask 做过 3 次成功，把已验证能力改写为不依赖扩展的回归测试）· **T1 nightly**（`viem` 注入式 mock provider 复现 MetaMask 已知行为，断言 SigilKit 的分支走向）· **T2 手工补证**（每 release 前签字）。

**决策规则写进 CONTRIBUTING**：密码学等价物可进 PR 门；真实扩展行为只能进 nightly 或 manual；**两者都做不到的必须显式登记为 `documented-exempt` 并带复审日期。禁止"既非 pr-gate 又无 exemption"的静默空白 —— 那是当前 `type4` 条目的真实状态。**

### 跨语言一致性
| 向量组 | 生成方式 | 外部锚定 |
|---|---|---|
| `eip7702.json` | viem `hashAuthorization` | ✅ 锚定 go-ethereum |
| `actionrequest.json` | `@sigilkit/core` **自身**的 `actionRequestDigest` | ❌ **自证** |
| `merkle-v2.json` | `@sigilkit/core` 自身的 `targetLeaf`/`merkleRoot`/`merkleProof` | ❌ **自证** |

消费侧 `GoldenVectors.t.sol` 又是**本地重算** EIP-712 domain/structHash 与最小 RLP → **两侧共享同一份对 EIP-712 结构的理解，若该理解有误，两侧同时错而测试全绿**。
**修复**：① `actionrequest.json` 改用 **viem `hashTypedData`**（0.5 d）；② 4 处计数双向校验（0.5 d）；③ `merkle-v2.json` 引入 **OZ `MerkleProof` 多层树**（≥16 叶、深度 ≥4）（1 d）；④ 单变量敏感性向量（0.5 d）。

### 性能/基准
- Gas 预算 ✅ 4 个测试（**设计良好**：绝对上限 + delta 隔离）→ 维持；补 **4337 batch 上界**与 **E11 + 8 token watchlist** 预算
- `benchmark-indexer.mjs` 🔴 **无任何 CI job 引用** → 接入 nightly，**且必须先确保 `validity.valid === true` 才接受数字**（脚本已实现 `assertValidReport` 七项合取，**问题在于没有调用者**）
- 性能回归预算：Issues-Catalog-09-17 明确"**proposed** 20% 告警，**非现有 SLO，基线方差未知前无意义**" → 先采集 ≥14 天基线再谈阈值

### UAT（**当前完全缺失**）
10 条场景（每条 = 可执行脚本 + 人工签字）：正常执行 / 超范围被拒 / 额度耗尽 / key 过期 / key 被吊销 / owner 治理恢复 / 7702 授权撤销 / 7579 安装验证执行 / 审计事件完整性 / indexer 续扫重组 / MCP 工具可用性。**UAT 必须自动化可重放**，人工只做签字；否则退化为形式主义。`Issues-Catalog-09-17:72-76` 的 SK-09 已给出范式（独立进程 + IPC 就绪握手 + `finally` 清理）。

## 1.4 质量门设计

| 门 | 触发 | 成员 | 阻断性 |
|---|---|---|---|
| **PR 门** | push/PR | L0 静态 · L1 单元 ×(合约+4 包 TS) · L2 invariant(256) · L3 Anvil · gas 预算 · Slither · gitleaks · **新增** npm audit · **新增** forge coverage 阈值 | 全阻断 |
| **nightly** | 03:17 UTC | deep fuzz(10k) · invariant(1k) · Base fork · Echidna · gas snapshot drift · **新增** benchmark-indexer | **全报告级** |
| **发布门** | tag `v*` | 全 PR 门 + Halmos · deep invariant · 白皮书计数(含 TS) · ABI 漂移 · pack preview · **新增** UAT 签字 · **新增** 30 天 fork 执行次数 | 全阻断 |

**三个 `continue-on-error` 的处置**：`docs/CI-WAIVERS.md` 是高质量登记册，但有**两个结构性缺陷** —— **D1 登记册与 YAML 无机器校验**（手工加豁免而不登记，CI 不会发现）→ 新增 `check-waivers.mjs` **双向 diff** + `Expiry` 未过期断言（**零新范式**，0.5 d）；**D2 判据不可自动验证**（"14 次连续绿"需人工查）→ 每次写 `waiver-progress.json`。
**到期硬处置**：`wallet-e2e-weekly`（2026-10-12）到期前必须先修断言重言式（否则升级为**跳过**而非绿灯）；`echidna-nightly`（2026-10-31）修弱属性后 14 次绿才可信；`foundry-canary`（2026-11-30）可自然达成。

## 1.5 可量化指标

| 类别 | 指标 | 现状 | 6 个月目标 |
|---|---|---|---|
| 覆盖 | 语句/分支/行/函数覆盖率 | TS 4 套矛盾数字；**Solidity 无门** | 统一口径 + **forge ≥85% lines / 75% branches** |
| 覆盖 | **属性层有效测试数** | **0 个 Forge fuzz** | ≥12 带参 fuzz + 8 不变量 + 20 Halmos spec |
| 强度 | Mutation score | **无** | TS ≥60%；`SpendPolicy` ≥80% |
| 缺陷 | 逃逸缺陷率 / MTTR | 未采集 | ≤10% / ≤48 h |
| 稳定性 | **Flaky 率 / MTTD** | **未采集** | ≤1%（单 job ≤0.5%）/ ≤30 min |
| 效率 | PR 门时长 / 本地回路 | 未记录 / 排除 invariant | ≤10 min / **≤60 s 且与 CI 门等价** |
| 一致性 | 向量数 / 外部锚定比例 | 14 / **仅 6** | ≥40 / **≥90%** |

**覆盖率单一事实源规则**：① 唯一测量（`test:coverage` 4 包 + `forge coverage`）；② 配置注释**只写阈值不写实测值**（当前 3 个 vitest.config 的"引入时实测"是 ③ 号数字来源）；③ 排除项必须同口径记录（否则 73.9% 与 53.8% 无法互相解释）；④ 扩展 `check-doc-counts.mjs --coverage`；⑤ **阈值只升不降**（防"调阈值让 PR 变绿"）；⑥ forge 侧建门。

## 1.6 非功能性测试
| 维度 | 策略 |
|---|---|
| 性能回归 | gas 4 条 ✅；indexer 先建基线，14 天后方可谈 20% 预算 |
| fuzz 收敛 | 首次纳入 CI 时采集墙钟基线，写入 `docs/` 并在 CI 打 time summary |
| **可访问性（CLI）** | **界定为机器可读性与脚本友好性**（非 GUI）：所有 CLI 支持 `--json`、stdout 仅数据/stderr 仅日志、退出码统一 0/1/2、错误含修复建议、断言 `NO_COLOR` 下无 ANSI 码 |
| 国际化 | 明确为**有意的英文单语产品决策**，写入 CONTRIBUTING；自定义 error 名是 ABI 稳定标识**永不翻译** |
| 兼容性 | CI matrix 加 25.x + **windows-latest 最小集**（`forge build` + core vitest + verify.mjs）—— 不追求全覆盖，但必须证明 Windows 开发者不被排除（`verify.mjs:104` 的 `.cmd` shim 即 Windows 专门代码） |
| 浏览器/链 | Chromium only（MV3 依赖，README 明示）；审计前可加 Sepolia fork |

## 1.7 测试数据管理
**向量**已是单一来源（**本仓最佳实践之一**）—— 缺陷是外部锚定不足、4 处计数无校验、无 `schema` 版本、重生成后 diff 无强制（加 `npm run vectors:generate && git diff --exit-code vectors/`，与既有 ABI 漂移门**完全同构，零新范式**）。

**Fixture 版本化评级**：ABI JSON 与 MetaMask 扩展（版本 pin + SHA256 + manifest 断言 + cache-key 后缀）**已达 L3 水准，作为其他漂移门模板**；合成 DB 数据（mulberry32 种子 + 独占 fixture 目录 + 拒绝覆盖 + 清理诊断）**优秀**；Anvil 账户建议集中到 `test/fixtures/accounts.sol`。

**环境隔离**：Anvil 端口共享 → 动态端口（1 d）· profile 污染 → 默认 fail-closed（0.5 d）· 模块状态共享 → 保留 `isolate:false` 但加守卫禁止 `beforeAll` 写模块级可变状态（0.5 d）· Windows TIME_WAIT（flake 主源）→ `withFreePort()` 集中管理（1.5 d）。

## 1.8 持续验证

| 层级 | 现状 | 问题 |
|---|---|---|
| **pre-commit** | ❌ **完全缺失** | `deny="warnings"` 这类廉价高价值检查不在提交时跑 |
| 本地全量 | ✅ `verify`（9 步，fail-closed） | 🔴 **不含 invariant** |
| PR CI | ✅ 12 job | 🔴 3 个豁免；无 forge coverage 门；无 npm audit |
| nightly/发布 | ✅ 3 档 cron + tag 门 | fork 缺 secret 时静默跳过；benchmark 未接入 |

> **Unverified as of 2026-10-01 — "✅ 12 job" 未在本轮重测，保持原文未改。** 同一审计集内对 job 数给出两种读法，本轮**不判定哪一种正确**：
> `docs/NUMBERS-2026-09-26.md` §1 基线表记 **CI job 14**（`ci.yml` 12 + `publish.yml` 2）——与本行不必矛盾，因为本行只说 PR workflow；
> 但 `docs/STALENESS-2026-09-26.md` §1.1 分类表判定 `VERIFICATION-STRATEGY-2-CI-UAT.md` 的 "12 job 分析" **"now 14"**，即把 12 当作已过时。同行的"✔️ 3 个豁免"也未在本轮复核。
> 本轮无法读 `.github/workflows/*.yml` 也无法运行任务计数。**在重跑 job 计数并记录日期前，不得把 12 或 14 写成已验证事实。**

**核心矛盾：本地绿灯 ≠ CI 绿灯**（差距在 **5 个维度**：invariant / fuzz 深度 / slither / gitleaks / fork——`verify.mjs` 与 `npm test` 都不含这些，且默认 `FOUNDRY_PROFILE` 为 `default`(256) 而非 `ci`(2000)）。

**修复四步**：① `test:invariant:quick`（新增 `[profile.quick.invariant] runs=32/depth=16` —— **注意 forge ≥1.x 已移除 `--invariant-runs` CLI flag，深度只能走 config**）；② `verify.mjs` 新增第 10 阶段；③ 新增 `verify:pr` 精确复刻；④ **报告尾打印"本次未覆盖的 CI 门"**（最诚实，成本极低）。

**pre-commit 建议（<2 min）**：`forge build` · `forge fmt --check` · `tsc --noEmit` · 快捷 invariant · `gitleaks protect --staged` · `check-doc-counts`（仅当改了 README/CHANGELOG）。**不建议**跑 Slither（>60 s）或钱包 E2E。

## 1.9 测试成熟度模型

| 级 | 判据 | 本项目 |
|---|---|---|
| L0–L1 | 无自动化 → 有测试但无分层 | |
| **L2** | 分层 + PR 门 + 覆盖率阈值 | |
| **L3** | 属性/不变量**有效** + 跨层一致性守卫 + 豁免有到期判据 + 缺陷度量闭环 | **← 现状介于 L2/L3** |
| L4 | 形式化覆盖关键路径 + UAT + mutation + 非功能门 + 外部审计闭环 | |
| L5 | 预测性度量 + 混沌/回归自动挖掘 | |

**已达 L2 的真实资产（应予保护）**：三级 Foundry 深度配置就绪 · 33 条 lint/警告全部书面豁免（**高纪律**）· Slither 零 high/medium + 53 条分诊入册 · 全部工具版本 pin · 向量单一来源 + 双语言消费 · **4 个自检守卫（把"文档/流程腐化"变成可执行失败——本仓最强模式）** · CI-WAIVERS 制度 · gas 预算含 delta 隔离 · benchmark 的有效性七项合取。

**阻挠 L3 的 4 个缺口**：**G1** Forge fuzz 消费者为 0（2–3 d）· **G2** HalmosAuth 缺时钟约束（0.5 d）· **G3** forge coverage 无门 + 4 套矛盾数字（2 d）· **G4** 豁免无机器校验 + 本地≠CI（2 d）。

**次级缺口**：INV-3 无可执行不变量（2–3 d）· 钱包 E2E 断言重言式（1–3 d）· benchmark 未接 CI（1 d）· Anvil 端口+profile（1.5 d）· UAT 缺失（3–5 d）· Node/OS 矩阵（1 d）· mutation（2 d）· flaky 采集（1 d）。

### 到 L3 的投入
| 阶段 | 内容 | 工时 | 累计 |
|---|---|---|---|
| **P0 止血** | G1 补 6 个带参 fuzz + G2 时钟 assume + G4 修本地/CI 缺口 | **4 d** | 4 d |
| **P1 门禁对称化** | G3 forge coverage 门 + 覆盖率单一口径 + `check-waivers.mjs` + npm audit | **4.5 d** | 8.5 d |
| **P2 不变量加固** | INV-3 + ghost 三处修复 + handler 覆盖度 + `warpRandom` 分层 + Echidna 弱属性 | **5 d** | 13.5 d |
| **P3 一致性与隔离** | 向量外部锚定 + 计数双向校验 + 向量漂移门 + Anvil 动态端口 | **4 d** | 17.5 d |
| **P4 度量闭环** | flaky 采集 + MTTR 台账 + escape-defect 跟踪 + 墙钟基线 | **3 d** | **20.5 d** |
| **到 L4 追加** | E2E 修复+钱包扩展 · UAT · 形式化扩展到 7579 · 性能/兼容门 · mutation | **15–23 d** | **L3+L4 ≈ 36–44 d** |

---

# 第二部 · VTS-B 合约层验证方案

## 现状诊断

| 维度 | 现状 | 关键问题 |
|---|---|---|
| 源码分支覆盖 | 约 71% | 20 处确认缺口，其中 **6 处是真 bug 面** |
| 不变量可信度 | **不可信** | 4 个 ghost 缺陷使 INV-1/2/4 退化为近似恒真 |
| Echidna | **实质无效** | 2 个恒真属性 + 1 个注资缺失 |
| Halmos | **静默空转** | 见 F-A2 |
| Fork | 1 链 / 3 断言 | chainid 硬编码 8453；`vm.skip` 使"无 fork 环境"静默通过 |
| Gas | 4 个绝对预算 | 无 E11/E10 路径、7579 无 batch 规模曲线 |
| 形式化扩展 | Halmos 0.3.3 pin | **无覆盖率门禁**；E11 ERC20 delta 未进入符号模型 |

## 覆盖缺口（20 处，6 处为真 bug 面）

**SessionKeyManager**：`transferOwnership` 成功路径+事件（零断言）· `withdraw` 的 `TreasuryWithdrawal` 事件（只断言余额，无 `expectEmit`）· `withdraw` 目标 revert → `WithdrawFailed`（唯一触发路径无测试）· `withdraw` **重入** · `rotate` 的 `OverlapBeyondOldExpiry`（**注释声称覆盖但 `overlapEnds ∈ {now,now+1h}` 恒 ≤ 365 天 expiry，该 revert 数学上不可达——注释与实现不符**）· `_ecrecover` 的 `yParity ∉ {27,28}` / `ecrecover()==0` · ERC-1271 的 `length<20` / staticcall 失败 / 短返回 / **high-aligned magic**（`:537` 右对齐分支）· `_declaredTokenOutflow` 的 **`transferFrom` 分支完全零覆盖** · `_erc20BalanceOf` 非标准代币降级为 0 · E11 的 8 token 满配 / **净 delta（先+再-）从未验证** · `_revertInnerCall` 的 `PerActionCapExceeded`/`PerWindowCapExceeded` 透传 · `_validateScope` 的 `tokenWatchlist.length>8` / `key==address(0)` · `merkleRoot==0` **无显式语义测试**

**SessionKey7579Module**：`_parseTrailingProof` 4 边界 · `_parseBatchProofs` 4 边界 · **`MAX_TOTAL_PROOF_ELEMENTS`(=32) 上界零测试**（8 tuple×4 应过、33 应拒，无任何测试触及）· `callData.length==32` 恰好边界 · `callType ∉ {0,1}` 的 `UnsupportedCallType`（E2E 只测 account 侧，未过模块）· `onUninstall` 的 `ModuleUninstalled` 事件 · `ScopeGranted`/`ScopeRevoked`/`SelectorDenylistSet` **全部零 `expectEmit`**

**ActionLog7579Executor**：`msg.value != value` · `target == address(0)`（注释明确"避免烧毁 value"却无测试）· `onUninstall` 的 `AgentUnbound` · `setAgentId(0)` 显式解绑

## 不变量测试修复方案
- **G1**：`ghostMaxPerWindowCap` 单调 max → **固定调色板** `PALETTE={1,2,3,5} ether`（编译期常量，fuzzer 无法无界抬高）+ cap 变更时重置 `spent`。**为什么可信**：真实 bug（`spent > cap`）会被捕获
- **G2**：`_syncScopeGhost` 从合约回读 → **handler 用纯本地 `_buildScopeFromSeed(seed)` 计算应有 scope 并写 ghost**（绝不读回）。**为什么可信**：若非 owner 路径改了 scope，ghost 不跟着变 → 断言失败
- **G3 激活**：`expectedWindowSpend` 改为 INV-1 的**双侧对照** `assertLe(合约值, ghostCap)` + `assertEq(合约值, ghostSpent)` —— **differential invariant**
- **G4**：删 400 天跳跃，换三个定向 handler（`warp_small` / `warp_windowBoundary` / `warp_toExpiry`）
- **actor 分离**：新增 `relayer`（显式 prank 证明 permissionless）+ `thirdParty`（尝试所有 admin 路径断言全被 `NotOwner` 拒）

## Echidna 修复方案
- **E1 注资**：构造函数 `payable(address(skm)).transfer(100 ether)`（Echidna 无 `vm`）；`h_execute` 的 value 改 `valueSeed % 3 ether`（覆盖 0/小额/超 cap 三档，让两条 revert 分支都能被触达）
- **E2/E3 恒真属性重写**：`ownerImmutableByFuzzer`（恒真）→ 改暴露 `h_transferOwnership` + 新属性 **`echidna_attackerNeverSucceedsAtAdmin`**（low-level call 模拟 attacker 调所有 admin 函数，任一成功则失败）—— **现在有信息量**；`scopesMatchOwnerActions`（硬编码常量）→ 三个不同 shape 的 grant handler + 属性"perWindowCap 必须是 PALETTE 成员"
- **扩展到 E10/E11/merkleRoot/1271**：4 个新 harness。**注意**：Echidna 无 `vm.prank`，标准做法是让 harness 的 admin 函数无权限要求

## Halmos 修复方案
- **Step 1**（5 min）：`:85` 追加第 4 参 `bytes("")`
- **Step 2 元测试防复发**（关键）：`test_HalmosAuth_ArityIsFour` —— 3 参数形式证明它确实失败（防改回），4 参数形式证明**在合法请求下成功**。**更系统**：`_execute` 内加 `_successPathProbed` 标志，首次调用 `require(ok, "harness has no reachable success path — checks would be vacuous")` —— **任何使 check 变 vacuous 的改动都会立刻让 forge 失败，而非静默通过 Halmos**
- **Step 3 时钟约束**：`setUp` 后加 `vm.assume(block.timestamp < expiresAt)`；`check_execute_Replay_` 的 `if (first) { assertFalse(second) }` 是 **vacuous branch**，改为无条件断言
- **Step 4**：新增 4 个 check（`ExpiredKey` / `RevokedKey` / `KeyUnknown` / `WindowState_RollsAtBoundary`）
- **预留 triage**：修复后 Halmos 可能**首次发现真 bug**（之前从未真正验证）—— 预期收益

## Fork 测试策略
**链矩阵**：Base(8453) P0（强化）· Sepolia(11155111) P0（新增）· Mainnet(1) P1（nightly only）
**断言 3 → 12 条**：chainid · DOMAIN_SEPARATOR 链绑定 · Multicall3 · **EIP-4337 EntryPoint v0.7**（证明 7579 有真实对手方）· **EIP-7702 类型 0x04 可发** · 真实 ERC-20 `balanceOf` 返回 32 字节 · WETH 存在 · domain 不与真链上其他部署冲突 · `block.timestamp` 在 2024–2027 · **gas 价格 > 0**（证明是真实 fork）· E11 端到端
**关键决策**：把 `vm.skip`（静默）改为 `revert`（响亮）。**外部依赖最小化**：只依赖**确定性部署**；USDC 虽地址固定但可升级/可暂停 → 只读不 transfer，E11 端到端改用 MockERC20 或 WETH；**任何 DEX 池/价格明确禁用**（会漂移导致 flaky）。
**三态**：secret 未配置 → job 标 neutral + summary 警告（**不算绿**）· 配置了但测试内 skip → 已改为 revert · 主网 → 仅 dispatch。

## Gas 测试
**新增预算**（E11 native 0 token ≤200k · **E11 + 8 token 满配 ≤350k** · E10 有效副签 ≤200k · E10 缺副签 revert ≤60k · ERC-1271 ≤180k · per-window 命中 ≤160k · per-action 拒绝 ≤40k · **Merkle depth 8 ≤250k** · reentrancy lock 拒绝 ≤30k）
**7579 batch 曲线**（新建 `Gas7579Scaling.t.sol`）：断言 per-tuple 边际成本有界 + **8-tuple 含 32 proof 元素 < 120,000**
**流程固化**：预算 = 实测 × 1.3；上调必须 PR 说明 + 更新 `.gas-snapshot`

## 形式化验证扩展
**Certora 现阶段不值得**（年费 ~$50–150k）。**替代路径（成本 1/50）**：① 深化 Halmos（免费、已在 CI）；② 引入 **Medusa**（Trail of Bits 开源，多交易序列 + 并行 + ERC20 建模，比 Echidna 快）—— **建议与 Echidna 二选一**。
**E11 建模**：**Phase 1（推荐，2 d）** Halmos + 内存 mock（`_erc20BalanceOf` 改 virtual 返回 mapping），可证明 5 个**纯算术**不变量（`ZeroDelta` / `ExactDelta` / `OverDelta_Reverts` / `Overflow_Reverts` / `NetIncreaseThenDecrease`）—— **最佳性价比切入点，因为不需要真的调 ERC20**。**Phase 2（3 d）** Medusa 多 tx 序列建模真实时序攻击（先+10、再-15、声明 1 → 净 -5 必须 revert）。

## VTS-B 工时
| 阶段 | 内容 | 工时 |
|---|---|---|
| **P0** | Halmos arity+元测试+时钟（预留 2h triage）· invariant ghost 重写 · Echidna E1–E3 | **10.5 h** |
| **P1** | 覆盖缺口（4 文件）· Gas 预算 + 7579 曲线 | **22 h** |
| **P2** | Fork 多链 + 响亮 skip | 9 h |
| **P3** | E11 Halmos Phase 1（**强烈推荐**）· Medusa 试点 | 20 h |
| | **必须做（P0+P1）** | **≈ 32.5 h** |

**两个额外发现**：① **`SpendPolicy.sol:74` 的 `projected = spent + value`**：grant `perWindowCap = max` 且首次 `value = max` 后，第二次 `value=1` 会因溢出 panic 而非 `PerWindowCapExceeded`。**语义安全但错误类型不同** —— 必须测试钉住，防止未来有人加 `unchecked{}` 时静默打开花销绕过（`max+1=0`，`0 <= max` 恒真）。② **`rotateSessionKey` 的 `OverlapBeyondOldExpiry` 在现有 invariant 中不可达**：需构造"先 rotate 缩短 expiry，再 rotate 用大于新 expiry 的 overlapEnds"。

---

# 第三部 · VTS-C TypeScript / 服务层验证方案

## 两处与初始假设**不一致**的核实结果
> **修正 1**：`validate.test.ts` **不是** flaky。真实缺陷是**结构性**的：同一文件并存两套时钟（live clock 的 describe + 硬编码 `NOW=1_900_000_000`），且 `it("accepts a request valid through its expiry second")` 存在 **1 秒竞态窗口**（`nowSec` 计算与 `validateAgainstScope` 内部再次取 `Date.now()` 之间跨秒即失败）。修法是**注入时钟**，不是"修 flaky"。
> **修正 2**：`eip7702.json`(6) 与 `eip7702.test.ts` 硬编码(8) 的重合数是 **1 条**（不是 2）。另 test.ts 内部 `FIXTURE` 与第 8 条**完全重复**，是第二处漂移源。

## 覆盖缺口（按风险排序）
| # | 缺口 | 工时 |
|---|---|---|
| **C1-P0-1** | `migrate()` 的 rowid 兜底 / `getLogsWithRetry` 退避序列与耗尽 / `fetchLogsChunked` 中途失败**全无守**。最后一条是 **fail-closed 核心不变量**（断言 `commitRange` 未被调用、cursor 未动） | 4.5 h |
| **C1-P0-2** | `removeLog` 跨链：双链库中以 chainId=1 调 `ingestLogs([{removed:true}])` → chain 8453 行**仍在**。**不改生产代码，但把限制登记进 docs 并在豁免清单引用** | 2 h |
| **C1-P0-3** | **E10/E11 本地预检镜像**（安全关键）：E10 后果是"缺副签 → 照常签名发送 → 链上 revert 浪费 gas"。**建议先落 2.5 h 的"只加断言+文档契约"版**，行为变更单独 PR 评审 | 2.5–6 h |
| **C1-P0-4** | `LeaseLostError` 契约：`instanceof` / `name` / message / `cause` / **`signal.reason === err` 身份相等**（最易被重构破坏） | 1.5 h |
| **C1-P1-5** | RLP 单测：`rlpEncodeScalar` 的 0→`0x80`；**`rlpEncodeList` 的 55/56/57 三点跨越 `0xc0`/`0xf7` 阈值 —— 现有向量全部落在 <56 分支，长列表分支零覆盖** | 2 h |
| **C1-P1-6** | MCP `audit_query` 剩余：`actions`+agentId / **缺 agentId**（`assertHash32` 从未触发）/ 跨链过滤（现有只验单链无区分力）/ 负数小数串 | 2 h |
| **C1-P1-7** | indexer CLI（243 行只有 2 e2e）：子命令矩阵 + **每用例断言 exit code + stdout 契约 + stderr 指引三件套**；`spend --json` 用 `JSON.parse` 断言结构（当前无人验证） | 3 h |
| **C1-P1-8** | `fleet.ts` 零测试 + `deployOut.match(...)![1]` 非断言式解构（格式一变就 `TypeError` 且信息不可读）；**双 agent 共享单 key 的 nonce 严格递增**是 fleet 的全部意义，当前零守 | 3 h |
| **C1-P2-9** | `watch` 正常推进：先写 happy-path 并**确认它通过**（现有 4 个测试全是失败路径） | 0.5–1.5 h |

## 测试可信度修复（**最高 ROI，2.5 h**）
| # | 位置 | 现状 | 修复 | h |
|---|---|---|---|---|
| T1 | `vectors.test.ts:82` | 注释承诺"独立验证 argsHash"实际只比 leaf；`c.argsHash` 从未被读取（僵尸字段） | 补 `expect(keccak256(args)).toBe(c.argsHash)` | 0.5 |
| T2 | `coinbase.ts:118,129` | 常量比常量，**数学上不可能失败** | 删自比断言，改与 allowlist 比对 + `eth_getCode` 真实探测 | 0.5 |
| T3 | `eip7702.test.ts:44-64` vs `vectors/eip7702.json` | 两份互不断言，重合 1/8 | 删 `CANONICAL_VECTORS`，全部从 json 读 | 0.5 |
| T4 | `vectors.test.ts:48-75` | `casesCount` 无断言 | 顶部 `expect(v.cases.length).toBe(v.casesCount)` | 0.2 |
| T5 | `conformance.test.ts:360-364` | `topics.length===3` 只筛长度，**不校验 `topics[0]===keccak("WindowCharged(...)")`** | 引入 event topic 常量精确断言 | 0.3 |
| T6 | `adversarial.test.ts:69` | ESM 中 `require("viem")` | 顶部静态 import | 0.2 |
| T7 | `validate.test.ts` | 双时钟 + 1 秒竞态 | `validateAgainstScope` 增可选 `nowSec`（纯增量零行为变更） | 0.5 |

## 套件隔离修复（3 h，**优先级等同 T 类**）
**问题**：`core/vitest.config.ts:12` `isolate:false` + `:6` `fileParallelism:false`，注释断言"无跨文件模块状态" —— **已被 `config.test.ts` 证伪**：`SIGILKIT_TEST_PRESET` 在 `:168` 写入后**永不清除**，在 `isolate:false` 下泄漏给同 worker 后续所有文件。
**步骤**：① `setEnv` 清理从 `afterAll` 前移到 `afterEach`，且**记录旧值精确还原**（而非 `delete`，后者抹掉调用者本就存在的变量）；② 全仓扫直接写 `process.env` 的点；③ `tests/setup-env.ts` 兜底；④ **污染探针测试**（故意泄漏 → 断言下一个文件看不到 → 需 `isolate:true` 才能通过，**是隔离性的活体检测**）；⑤ **分档配置**（快档保留 `isolate:false`，另加 `vitest.strict.ts` 仅跑 config/logger/lease，纳入 nightly）。

## 属性/模糊测试（TS 侧从 0 → 1，11.5 h）
**安全视角定位**：不是"找 bug"，是**证明 fail-closed 不变式** —— 每条拒绝路径都不得抛异常、不得误放行。
| 项 | 属性 | h |
|---|---|---|
| `actionRequestDigest`/`parseActionRequest` | 往返 · **字段敏感性**（8 字段各 2 组扰动 → digest 必不等）· 幂等 · **恶意输入只允许抛 `ValidationError` 绝不抛 `TypeError`**（防栈信息泄露）· 三种 coercion 等价 | 3 |
| **`validateAgainstScope` 单��性** | **fail-closed 形式化**：scope 收紧时 `ok` 只允许 true→false **不得 false→true**；`perActionCap` 递增时通过集只增；`merkleRoot=0` ⇒ 恒 ok；任意输入不得抛 | 3 |
| `merkleProof`/`merkleRoot` | 完备性（proof 长度 === ceil(log2 n)）· 篡改 sibling 必失败 · 幂等 · **n=0 先测出当前行为再决定契约** | 2 |
| `rlpEncode*` | 单调性 + 前缀规则 + 与 viem `rlp.encode` 交叉 oracle | 1.5 |
| indexer 往返/幂等 | **`ingestLogs(seq ++ seq)` ⇒ 行数 === `ingestLogs(seq)`**（现有是固定 2 条，属性化后可发现去重竞态）· `storeAction`→`actionsForAgent` ≡ 原记录（**bigint 不丢精度**）· `fc.string()` 只允许跳过不得抛未捕获 | 2 |

**预计发现 2–4 个真实边界 bug**（`merkleRoot([])`、`parseActionRequest` 的非 ValidationError 路径最可能）。

## 集成测试策略
| 项 | 要点 | h |
|---|---|---|
| **C4-1 Anvil 池化** | `AnvilPool`（`port:0` 自分配、`{url, release()}`、`maxAnvils=2`）；保留 8545 但改为池首个实例；每个测试自清理（`eip7702.test.ts:158` 是好范例）；**与隔离修复联动后可放宽 `fileParallelism` 为 `true`，换回 8.5% 性能并消除顺序耦合** | 4 |
| **C4-2 harness 可扩展化** | `execute.test.ts:50-56` 的 `readContract` 对 `getNonce`/`getWindowState` 之外任何函数名**直接抛 `unexpected read`** → 一旦 `client.ts` 新增一次读（E10 副签验证很可能触发）**整个 execute 套件全线红**且报错误导。改注册表 + 缺省失败（信息含"若 client.ts 新增读取，请在此注册"+file:line） | 2.5 |
| **C4-3 MCP dist 构建契约** | `mcp` **无 `pretest`**（core 有）→ 未构建时测试**失败**（不是 skip），干净 clone 上"红但原因误导"。补 `pretest` + `expect(existsSync(CLI_JS))` + 子进程清理兜底 | 1.5 |
| **C4-4 demo-agent 假绿** | `smoke.e2e.test.ts:68-72` `if (!available) { return; }` → **`it` 正常通过**。forge 缺失时 **CI 全绿而覆盖为零**。改 `it.skipIf`（**显示为 skipped = 可见的零覆盖，而非绿色的假通过**） | 1 |

## 性能测试（8 h）
| # | 目标 | h |
|---|---|---|
| P1 | **indexer 基准进 CI**：`benchmark-indexer.mjs` 零调用方；`perf/indexer.bench.ts`（1000/10k 行吞吐 + 查询 p50/p95 + DB 体积）；**PR 门只跑 1000 行设宽松上限，nightly 跑 50k** | 2.5 |
| P2 | **查询计划守卫**：`EXPLAIN QUERY PLAN` 断言命中索引（`USING INDEX`）→ **索引被误删即失败** | 1.5 |
| P3 | 租约延迟：N=50 并发 acquire 同一 key ⇒ **恰 1 成功** | 1.5 |
| P4 | merkleProof 大规模（n ∈ {1k,16k,65k}） | 1 |
| P5–P6 | RLP 批量计时 · SDK 签名吞吐（**捕获依赖升级导致的 10× 回归**而非微优化） | 1 |
| P7 | gas 回归（TS 侧职责）：`conformance.test.ts` 采集 gasUsed 与基线对比 | 0.5 |

**基准卫生**：全部 `performance.now()`、预热 3 轮、**结果只写 artifact 不做硬断言**（除 P2 —— 那是正确性）。基线存 `perf/baseline.json`，>20% PR 评论提示，>50% 失败。

## 可访问性/鲁棒性（5.5 h）
R1 **CLI 输出契约**（三个 cli.ts 每条输出路径快照测试 —— **新增 flag/字段即需更新快照**，防止重构悄悄改掉 agent 依赖的输出）· R2 错误消息质量（`field` 必填；100KB 恶意输入的错误 **<200 字符**；私钥**永不出现在 message**）· **R3 logger 脱敏**（`serialize` **不做脱敏** → 私钥作为 field 会原样落盘）· R4 大输入（1MB data、10k logs、10MB JSON）· R5 超时与取消（`serveStdio` 无超时；`watch.stop()` 响应延迟）。

## 测试基础设施（7 h）
共享 fixture（当前 6+ 文件各写一份且不一致）· 端口管理 · **确定性种子**（CI 固定可精确复现，本地随机；`endOnFailure:true` 但必须在报告回显缩减后种子与 counterexample）· 并行度矩阵（快档/strict/活链档）· 环境隔离（禁止字面量 DB 路径）· 快照纪律（入库、CI 禁自动更新、**diff 必须在 PR 评论展示**）。

## VTS-C 工时
| 优先级 | 工时 |
|---|---|
| P0 可信度与假绿 | **6.5 h** |
| P0 安全关键覆盖 | **8.5–12 h** |
| P1 补齐缺口 | **12.5–13.5 h** |
| P1 隔离与集成 | **8 h** |
| P1 钱包分层 | **8.5 h** |
| P2 属性/性能/鲁棒性/基础设施 | **32 h** |
| | **≈ 67–70.5 h（9 个工作日）** |

**三个不可跳过的交付物**：① `docs/VERIFICATION-COVERAGE.md`（缺口清单单一真源）· ② `docs/TESTING.md`（分层/矩阵/seed/快照/豁免流程）· ③ `WALLET_BEHAVIOR_ALLOWLIST.json` schema + `allowlist-integrity.test.ts`（**必须进 PR 门，否则它自己也会变成新的静默空白**）。
