# SigilKit — Advanced Features (1/2)：合约层 + 索引查询层

> 日期 2026-09-25 · 基于 25 个并行只读分析 agent 的深度分析
> 工时口径：1 名主工程师，1 人日 = 6–8 h；不含外部审计/形式化验证/多链 fork 测试
> 完整实现 A+B 分部 ≈ **13–19 人周**；全 5 分部 ≈ **49–73 人周**

---

# 第一部 · 合约层高级能力（A1–A10）

## 三个必须坚持的设计原则

1. **先统一策略语义，再扩展能力。** 当前 Manager 与 7579 在副签/余额差/审计落点存在能力差异（`SessionKey7579Module.sol:65-71` 少 3 个 Scope 字段）。意图、异常检测、审计若分别实现到两个路径，很快会变成两套安全模型。
2. **高级能力必须可降级到原有硬约束。** 意图、风险评分、策略升级、可插拔引擎都**不能突破** owner 已设定的单笔/窗口硬上限、目标白名单、可撤销性。
3. **ZKP、跨链、风险 oracle 是信任扩展，不是"自动安全"。** 真正可卖的不是"用了 ZK/4337/跨链"，而是能清楚证明：**哪些结论是链上强制的、哪些依赖 oracle、哪些可选、失效时如何降级。**

## A 分部总表

| # | 能力 | 推荐 | 难度 | 工时 | 架构契合 |
|---|---|---|---|---|---|
| **A8** | 可插拔可升级策略引擎 | **P0，先做** | 高 | 4–6 周 | **最高**（库已模块化，ERC-7201 已打基础） |
| **A2** | Session Key Lifecycle v2 | P0 基础设施 | 中高 | 4–6 周 | 高（替换 `Scope` 静态解析层） |
| **A3** | 原子批 + 条件执行 + 部分失败语义 | P0 | 高 | 6–9 周 | 高（7579 已有批量与 per-tuple proofs） |
| **A1** | 可验证财务意图 | P0 旗舰 | 高 | 6–9 周 | 中高 |
| **A10** | 分层子 Session Key 能力树 | P1 规模化 | 中高 | 5–6 周 | 中高 |
| **A5** | 链上欺诈检测 + 渐进降权 | P1 | 中高 | 4–6 周 | 高（对接 E10/Merkle/轮换） |
| **A4** | 可验证审计：累积证明 + ZK | P1 护城河 | 很高 | 8–12 周 | 高（扩展 ActionLogger/indexer） |
| **A7** | 7702 × 4337 × paymaster | P1 | 中高 | 2–4 周 | 高（7579 已有 UserOp 解码/批量/proof） |
| **A9** | 社交恢复与密钥分片 | P1/P2 | 中高 | 4–6 周 | 中高 |
| **A6** | 跨链同一 session key 域聚合 | P1/P2 | 高 | 6–9 周 | 中高 |

## A-08 · 可插拔可升级策略引擎（**先于其他所有项**）

把 `SpendPolicy` 的编译期逻辑升级为：
```
SessionKeyManager / 7579 / Delegator
             │
       统一 PolicyContext
             │
     PolicyEngine (可升级实现)
```
**关键不是"能升级"本身，而是升级只能收紧、不能绕过既有授权的策略集合。**
```solidity
struct PolicyContext { address account; address key; bytes32 scopeHash;
                      bytes32 policyParamsHash; bytes32 requestDigest; uint48 now; }
struct PolicyDecision { bool allowed; bool countersignRequired; uint256 charge; uint16 riskFlags; }
interface IPolicyEngine {
    function version() external view returns (bytes32);
    function check(PolicyContext calldata ctx, ExecBatch calldata batch)
        external view returns (PolicyDecision memory);
}
```
**策略引擎只做检查，不应在 `check` 中做 SSTORE 或 delegatecall。** Manager 负责 nonce、CEI、实际调用、余额差、审计。**推荐外部 UUPS PolicyEngine + 治理 Timelock**（比把全部逻辑放进可升级 delegatecall 更稳妥）。**不建议第一步就 Diamond 化整个 Manager**（当前没有足够多模块需要支付 selector 路由成本）。Gas 增量 +3k–8k/次（静态推算），升级/角色变更 +30k–150k（低频）。**安全 trade-off**：升级权限本身必须有 timelock/quorum/监控/紧急暂停；7702 EOA 的委托目标必须仍指向稳定入口，不能让 7702 指向不透明升级代理；引擎故障可 fail-closed 但不能通过普通回调静默修改 scope。

## A-04 · 可验证审计（最强护城河）

`ActionLogged` 已保证成功执行有事件，但第三方仍需信任 RPC/indexer 才能获得完整日志。升级为：
- **Merkle 滚动累积器**：把 N 条规范审计叶压成一个链上根
- **周期性检查点**：由第三方提交日志 + 链上收据证明更新
- **可选 ZK 证明**：证明"检查点覆盖某段 ActionLogged 事件且满足审计规则"，不泄露多余事件
```solidity
struct AuditLeaf { address account; bytes32 agentId; address key; uint64 authorityEpoch;
                   bytes32 requestDigest; bytes32 userOpHash; bytes32 txHash;
                   uint256 blockNumber; uint256 logIndex; uint8 outcome;
                   bytes32 balanceDeltaRoot; bytes32 policyVersionHash; }
function anchorAuditRoot(bytes32 root, uint64 count, uint32 rangeStart, uint32 rangeEnd) external payable;
function verifyAuditProof(uint256 checkpointId, bytes calldata proof) external view returns (bool);
```
**Merkle 证明本身不是零知识**：若叶包含钱包/目标/金额，公开叶会暴露这些信息；**只有 ZK 电路才能隐藏不必要字段。** 累积根必须绑定链 ID、区间、block hash、账户、叶格式版本。**建议保留每个关键执行的可索引审计锚，不立即删除 `ActionLogged`**（否则改变 INV-3 语义）。Gas：每笔写叶 +25k–45k；但**只 append ActionLogged 而不落链累计状态**时额外通常 <3k。**ZK 验证必须在检查点结算时发生，不能放进每笔执行热路径。** 不可假设所有 L2 都支持 BN254/BLS12-381 预编译。

## A-01 · 可验证财务意图（旗舰）

Agent 不再只能声明"本次最多花多少 ETH"，而是声明一个**可验证的目标和后置条件**：例如"未来 1 小时内，将账户中最多 10% 的可验证协议 TVL 转换为 X 资产；最低到账、允许滑点、截止时间均受约束"。
```solidity
struct IntentSpec { bytes32 id; IntentKind kind; bytes32 paramsHash; address quoteAsset;
                    uint16 maxBpsOfTvl; uint16 maxPriceImpactBps; uint48 notBefore;
                    uint48 deadline; bytes32 oracleConfigHash; bytes32 adapterVersionHash; }
function declareIntent(IntentSpec calldata spec, bytes calldata ownerSig) external;
function consumeIntent(bytes32 intentId, bytes32 actionDigest,
                       bytes calldata preState, bytes calldata postState)
    external payable returns (bytes32 stateCommitment);
```
**"10% TVL"不能直接用任意 `balanceOf()` 求和**——必须由可信、**版本固定**的 TVL 估值适配器计算，统一为 quote asset 计价。**必须坚持的三条安全线**：① **Oracle 操纵**（闪电贷扭曲）→ 价格偏差检查 + TWAP/多源 + heartbeat + max slippage；② **前置条件 ≠ 最终收益**（价格可瞬间变化）→ 必须绑定 `minAmountOut`、滑点、可接受估值偏差；③ **后置检查无法追回已流出资产**（能阻止"超出意图"的成功结算，但不能撤销已发生的交易）。**"意图"不是任意自然语言或模型自我声明，必须落到有限可解释的 DSL。** Gas +8k–25k/次（多 oracle 可达 +30k）。真正护城河是**可信估值适配器与协议语义策略**，而非一个 Intent 结构体。

## A-02 · Session Key Lifecycle v2（时间旅行额度）

现有 `expiresAt`/轮换重叠窗口/固定 spend cap 是"静态授权 + 到期"。v2 增加**预授权临时权限时间线**：
```solidity
struct SessionRoot { address key; bytes32 baseScopeHash; bytes32 elevationRoot;
                     uint48 notBefore; uint48 notAfter; uint48 maxValidity; uint256 epoch; }
struct TimeLeaf { uint48 validAfter; uint48 validUntil; uint256 maxValue;
                  uint256 maxWindowSpend; bytes32 targetsRoot; uint8 actionMode; bool isElevation; }
function grantSessionRoot(SessionRoot calldata root, bytes calldata ownerSig) external;
function evaluateSession(SessionRoot calldata root, bytes calldata leafProof) external view;
```
实际执行时**使用实际生效 scope** 而非基础 scope。Owner 一次签名即可授权未来数小时的多个能力区间；agent 在每笔交易中只携带 leaf proof。**"时间旅行"是预授权未来权限，不是改变链上时间，也不能撤销已执行动作。** **安全边界**：owner 预授权了未来更高权限 → 密钥泄露后的**有效损失窗口可能延长**；必须有严格 `notAfter`、总损失上限、紧急 revoke epoch。**时间衰减不能替代资金上限。** Gas：稳态每笔 +1k–4k + proof calldata；新 root 签发 +20k–50k（低频）。

## A-03 · 批执行与条件执行

```solidity
enum BatchMode { STRICT_ATOMIC, COLLECT_FAILURES, SWEEP_RESIDUE }
struct Condition { ConditionKind kind; address adapter; bytes payload; uint48 validUntil; }
function executeBatch(BatchRequest calldata req, Condition[] calldata conditions,
                      bytes calldata signature) external payable returns (BatchResult[] memory);
```
**部分失败不能伪装成原子。** EVM 外层交易仍是原子的；只有显式捕获失败并继续才形成"部分成功"。**条件应通过受限条件适配器执行**，而不是允许任意 call 充当"检查"（否则条件本身就能产生副作用）。**失败调用的额度也必须保守扣减**，否则可利用失败调用绕过速率限制。**E11 余额差不能按整批快照**（跨 item 归因会误杀），必须逐 item 成对采集。条件读取的 block 状态与后续外部调用之间存在竞态 → 需以调用自身状态承诺及 max slippage 约束。Gas：严格原子批每额外 tuple +15k–35k；条件 oracle 检查 +5k–15k。

## A-10 · 分层子 Session Key 能力树

让一个已受限的 session key 再派生短期、用途单一的子 key：
```solidity
struct ChildGrant { address parentKey; address childKey; bytes32 childScopeHash;
                    uint64 parentEpoch; uint48 validAfter; uint48 validUntil;
                    bytes32 targetsRoot; uint256 maxValue; uint256 maxWindowSpend; }
function grantChild(ChildGrant calldata grant, bytes calldata parentSig) external;
function revokeSubtree(address childKey, uint64 expectedEpoch) external;
```
**授权时强制验证 child 权限是 parent 权限的子集**；白名单必须以 parent root 的成员证明**证明是收窄**，不能把父级 pinned scope 升级为 wildcard。**层级过深会形成难以理解/撤销的权限传播；建议最多两层。** 使用 epoch 撤销比逐个遍历子树便宜得多。**这比所有 agent 共享一个高权限 key 更能形成规模化护城河。** Gas：派生授权 +15k–40k；子 key 每笔 +1k–4k。

## A-05 · 链上欺诈检测 + 渐进降权

检测同一 session key 的异常行为（短时频繁改目标、金额偏离历史分布、突然访问此前未用高危 selector、与正常用途不符的调用序列）。**不能把"链上统计学习模型"当作安全事实来源。** 可把**确定性规则和低成本统计指标**放在链上，将复杂风险评分交给**可替换的 risk oracle**。
```solidity
interface IPolicyRiskOracle { function assess(bytes32 contextHash) external view returns (uint64 risk, uint48 validUntil); }
function requireEscalation(bytes32 contextHash) external view returns (bool);
```
**风险升级路径**：普通策略 → 提高副签阈值 → 缩短窗口/降低上限 → 冷却期禁止某类目标 → owner/guardian quorum 副签。**四条安全边界**：① 小样本必然带来误报，不能只靠均值/方差阻止正常首笔交易；② 攻击者可以拆分交易/轮换 key/使用新会话躲避简单统计；③ 链上直接放"学习模型"会产生不可解释的授权结果；④ 风险 oracle 故障应触发**更保守模式**而非无条件放行；**降权必须是缩小已授予权限，不能演变为可任意没收资产的后台权限。**

## A-07 · 7702 × 4337 × Paymaster（名称必须准确）

**建议对外称"7702 原生钱包 + 4337 gas 赞助"，**而不是"7702 paymaster"。**必须澄清**：① 7702负责 **EOA 委托代码**，不负责代付 gas；② **一个没有原生币、没有已部署智能账户的 EOA 仍需要一次可付费的启动路径**完成首次 7702 授权；③ Paymaster 支付交易 gas，**不会自动支付 swap/transfer 的代币资金**；④ EOA 类型交易不能像 UserOp 一样由 paymaster 直接代付。
```solidity
function validateUserOp(PackedUserOperation calldata op, bytes32 userOpHash,
                        uint48 missingAccountFunds) external returns (uint256, uint256);
function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost) external payable;
```
**安全边界**：paymaster 是审查和拒绝服务的中心化点，但**不能绕过链上 scope 校验**；bundler 丢弃已验证 UserOp 时，现有窗口会保守扣减 → 需要补偿机制；paymaster 可能被诱导为无价值操作付费 → 需 Sponsorship Policy/每日预算/allowlist/速率限制。**差异化应落在"同一种 session scope 跨直接 EOA 与智能账户路线复用"，**而不是做一个普通 paymaster。

## A-09 · 社交恢复与密钥分片

```solidity
struct RecoveryConfig { address[] guardians; uint8 threshold; uint48 recoveryDelay;
                        uint64 recoveryEpoch; bytes32 guardianConfigHash; }
function proposeRecovery(address newOwner, uint48 validAfter, uint64 expectedEpoch,
                         bytes[] calldata guardianSignatures) external payable;
function finalizeRecovery(uint64 expectedEpoch) external;
function cancelRecovery(uint64 expectedEpoch) external;
```
**"社交图"是治理关系的表达；真正的安全性来自独立密钥、阈值、延迟、可验证提案**，不应依赖一个可被随时更改的社交平台分数。**安全边界**：恢复延迟降低突袭风险但延长 owner 私钥泄露后的暴露期 → 需 guardian **立即 revoke 通道**；5-of-9 不天然比 3-of-5 更安全，关键是**独立性和密钥隔离**；**7702 owner 可以主动撤销委托/清空代码/放弃使用 SigilKit——guardian 无法阻止 owner 放弃系统** → 产品不能宣称"恢复即可绝对阻止盗取"。分片密钥（降低备份泄露）与 quorum 恢复（恢复控制权）是**不同能力**。

## A-06 · 跨链域聚合（**不是**"同一签名字节可重放"）

**EIP-712 绑定 chainId 是正确安全属性，不应削弱。** 所谓"跨链同一 session key"应设计为：**一次签署一个包含多链清单的 session root；每条链从本地注册的域描述中派生出自己的 EIP-712 digest。**
```solidity
struct ChainScopeCommit { uint256 chainId; address verifyingContract;
                          bytes32 policyConfigHash; bytes32 adapterRoot;
                          bytes32 effectiveScopeHash; uint48 notBefore; uint48 validUntil; }
function installChainRoot(ChainScopeCommit[] calldata commits, bytes32 merkleProof,
                          bytes calldata sessionSig) external;
```
**三条安全边界**：① **不是跨链原子执行**（同一 key 在两条链的额度可能被分别用完）；② 同一 EOA 在多链的 nonce 仍是链本地状态；③ chainId=0、通配 verifyingContract、未经验证的地址列表不应作为"便捷兼容"绕过域隔离。Gas：链配置已注册并缓存时 +2k–6k；未缓存 +8k–20k。

## A 分部构建顺序

```
Phase 1（P0 基础设施，2–3 月）: A8 策略引擎 → A2 生命周期 v2 → A3 批执行 → A10 子 key 树
Phase 2（金融护城河，2–3 月）: A1 意图 → A5 欺诈检测 → A4 可验证审计
Phase 3（跨链/gas，2–3 月）: A7 paymaster → A9 社交恢复 → A6 跨链域聚合
```
**明确否决**：❌ 把 E11 放进 7579 validator；❌ `try/catch` 部分成功批执行；❌ 真·滑动窗口（数学上不改善上界）；❌ 保留 2 参 `grantSessionKey` 处理活跃 keys。

---

# 第二部 · 索引与查询层（B1–B10）

## 四个必须在立项时明确的边界

① `ActionLogged` **不等于 EVM 的全部资金流**（不代表内部所有 ERC-20 Transfer、桥接到账可由这些事件独立重建）；② **"rebalance" 是业务解释，不是事件原生字段**（`selector` 只有 `bytes4`，需要版本化的目标/ABI/业务标签映射，**未知目标必须返回 `UNKNOWN` 不能默认归类**）；③ `block_hash` 可为空、缺 manager 列、省略 chainId 的 `spendByAgent` 聚合各链原生币 wei **不是**跨链经济总额；④ **Merkle 根只能证明报告内容一致，不能单独证明链上采集完整。**

## 共用数据基础

由 B1 负责，**不要让每个功能各自往 `actions` 加字段**：追加式 `audit_events`（`event_id` 由 `chainId+txHash+logIndex+eventType` 域分隔确定性生成；含 `legacy/receipt_verified/anchored` 证明等级）+ `event_revocations`（重组后撤销，**不抹去历史事实**）+ `ingest_batches/source_checkpoints`（采集范围/端点区块哈希/事件计数/前序批次哈希）+ `source_managers` + `action_definitions`（目标身份/selector 解释/标签/生效区间）。历史回填明确标记 `legacy`，**不能自动升级成"可证明"的来源。**

## B 分部总表

| # | 功能 | 复杂度 | 工时 | 差异化 |
|---|---|---|---|---|
| **B1** | 审计事件契约 + 可重放摄取层 | 6/10 | 40–64 h | 基础（语义/证明可信度地基） |
| **B2** | 行为图 + 受限语义查询（DSL） | 7/10 | 56–80 h | **很高** |
| **B3** | 可解释统计异常检测 | 6/10 | 40–64 h | 高 |
| **B4** | 证明式审计报告 | 8/10 | 72–104 h | **极高** |
| **B5** | 累积承诺 + 「某时点未发生」证明 | 9/10 | 80–120 h | **极高** |
| **B6** | 实时审计流 + 可恢复订阅 | 5/10 | 40–64 h | 中高 |
| **B7** | 冷热分层 + 归档 | 7/10 | 64–96 h | 中高（规模化） |
| **B8** | 受限 NL 审计查询 | 6/10 | 32–48 h | 高（**建立在 B2 之上**） |
| **B9** | 跨链身份 + 统一行为视图 | 7/10 | 48–72 h | 中高 |
| **B10** | 链上动作 vs 外部账本对账引擎 | 8/10 | 64–96 h | 高（机构客户） |

## B-04 · 证明式审计报告

报告需含：报告 ID、范围、事件数量、规范化叶子排序规则、排序后叶子的 Merkle 根、证明版本、链游标、可选发布者签名。**三种证明强度必须分清**：
| 证明 | 能证明什么 |
|---|---|
| 叶子包含证明 | 某笔事件确实在报告中 |
| 报告完整性 | 报告覆盖声明的集合未被事后修改 |
| 来源真实性 | 事件确实来自声明的链/manager/交易/规范区块 |
**第一项不能自动推出后两项。** 离线验证还需 receipt/header 证据 + 外部锚定或受信采集者声明。
```solidity
// 规范化叶（可跨语言复现，域分隔避免二阶原像）
keccak256(abi.encode(LEAF_DOMAIN, chainId, txHash, logIndex, eventType, blockHash, canonicalEventHash))
```
**Events must 按规范顺序排列并去重** — 不能只对 SQL 返回的任意顺序求根。If 允许 anybody 更新根，需加入保证金/争议期/受治理 attester 限制。

## B-05 · 证明「某时点未发生」（最难也最有价值）

支持："截至 2026-03-31，agent X 在已覆盖的 manager 集合和时间区间内，**没有**执行过已定义的资产转移操作"。
**不能仅依赖"过滤结果为空"** — 数据库没有一条记录，可能只是漏采、范围不全或规则被改写。**必须用范围覆盖证明 + 明确空子树 + 进度检查点 + 累积根。** 缺失 manager、未确认区块、未完成分页、旧版本分类规则，**都必须使结论降级**：接口明确返回 `EXPLICIT_COVERAGE`/`INCOMPLETE_COVERAGE`/`UNKNOWN` 三种状态（e.g. `absenceProof({agent, predicate, from, to})` + `replayAsOf(checkpoint)`）。

## B-02 · 行为图与受限 DSL（"只做过 rebalance"）

Graph = agent → action → target → selector 的时序行为图，**not a full EVM call tree**（现有事件无嵌套调用关系，同 tx 内只能按 `logIndex` 建立顺序）。受限 AST/DSL 编译为参数化 SQL，模板限定为 `onlyLabels`/`forbidsSelectors`/`distinctTargets`/`countAtLeast`/`sequenceAll`/`sequenceNever`. **Key rule**： "只做过 rebalance" 只能在**全部相关事件均被分类、来源覆盖完整**时返回 `YES`；出现未知目标/缺失 manager/未验证分类时**必须返回 `UNKNOWN`，不能只对已分类事件做过滤。**

## B-10 · 对账引擎

**这是独立财务数据源接入，不能把 SQLite 自查询称为对账。** 口径必须把 **native action value / 实际原生币资金变化 / 内部 Transfer / gas 费用 / 外部会计金额分开。** SigilKit 动作的 `value` **不等于**整笔交易的净资金变化；ERC-20 需通过已定义的 `Transfer` 范围或业务适配器另行采集. 金额用十进制定点数，链上原始值用 `bigint`，**不能用浮点数对账。** Four mismatch classes each with independent conclusion: `missing_on_chain`/`missing_in_ledger`/`amount_mismatch`/`duplicate`/`orphan`/`pending_finality`.

## 四条验收红线（B 分部全部）

1. **未知 selector 不能被伪解释**
2. **空查询不能自动变成"无操作"证明**
3. **Merkle 根不能脱离来源覆盖和链锚定单独宣称完整性**
4. **MCP 查询/报告验证/对账查询不得对审计库执行 DDL 或写入**
