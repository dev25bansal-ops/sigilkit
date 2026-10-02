# SigilKit — Enhancements & Modifications

> 日期 2026-09-25 · 25 个并行只读分析 agent · 每条给实现方法/收益/trade-off
> 5 分部：合约层(C) · SDK(S) · 服务层(I/M/D) · 工具链与文档(T/CI/DOC/ABI/VEC) · 开发者体验(UX)

## 汇总索引

| 分部 | 条目 | 编号范围 | 最高杠杆项 |
|---|---|---|---|
| 合约层 | 18 | C-01 ~ C-18 | C-03（pause，零 hot-path gas）、C-04（denylist 自封闭） |
| SDK | 20 | ENH-S-01 ~ 20 | S-20（模块拆分，零风险）、S-05/S-16（ErrorCode 体系） |
| 服务层 | 19 | ENH-I/M/D | M-01（MCP 路径白名单）、D-01（私钥分离） |
| 工具链/文档 | 21 | ENH-T/CI/DOC/ABI/VEC | T-01（verify timeout）、CI-02（豁免机器门） |
| 开发者体验 | 15 | ENH-UX-01 ~ 15 | UX-12（状态表动态生成） |

---

## 一、合约层（18 条）

**先确立四条跨切面决策**（决定下面每条的形态）：

| # | 决策 | 依据 | 影响 |
|---|---|---|---|
| D1 | **无代理 ⇒ 存储布局可自由重排/追加**，所有 struct 变更是"部署时迁移"而非"存储迁移" | `Deploy.s.sol:14-16` 明写 immutable-by-design | 追加 `Scope` 尾部字段合法；`paused` 可与 `reentrancyLocked` 打包进 slot0（**白拿零 gas 的 kill switch**）；唯一代价：一旦引入 UUPS，这 18 条全部变成存储迁移 |
| D2 | **管理面控制分两类**：selector 闸门（denylist，跨 target）防"agent 触达管理面"；storage 标志（pause）做"全局熔断执行面"。二者不可互替 | denylist 拦不住 owner 误操作；pause 拦不住"新 admin 函数忘了 denylist" | C-03 走 storage，C-04 管 selector 完整性 |
| D3 | **7579 的 E10/E11 落点不同**：E10 是纯签名校验 → validator；E11 是执行期属性，validator 物理上无法保证 → executor | `SessionKey7579Module.sol:29-33` 自述"validation passing ≠ execution landing" | C-10 两侧实现；**不做**"把 E11 硬塞进 validator"这个错误设计 |
| D4 | `Scope` 字段一律 append-only + 显式版本化 + 暴露 typehash | 两个 `Scope` 都在 mapping 里，**中间插字段会静默错解历史存储**（不 revert、无事件、测试可能因每次从零 grant 而全绿） | C-12 给出强制机制 |

### ENH-C 总表

| ID | 合约 | P | 改进点 | 实现方法 | 收益 | Trade-off | 工时 |
|---|---|---|---|---|---|---|---|
| C-01 | 7579 | **P0** | 单调用 proof 解析**无元素数上限** → validation gas 炸弹 | `_parseTrailingProof` 增 `MAX_SINGLE_PROOF_ELEMENTS`（建议 8）；`_whitelisted` 入口二次校验 | 封死 65k 元素 × 32B 的 calldata 放大 | +1 比较（≈10 gas） | 2 h |
| C-02 | Manager+7579 | **P0** | `merkleRoot==0` 静默全放行 | `Scope` 尾部加 `bool allowUnrestrictedTargets`；`_validateScope` + 执行期双检 | 危险默认值 → 必须显式声明 | **breaking**（TS + ~20 处 .sol 字面量）；SDK 侧 `signing.ts:336` 须同步 | 4 h |
| C-03 | Manager | **P0** | 全局熔断 pause | `paused` 与 `reentrancyLocked` 同 slot；检查放进**已在读该 slot** 的 `nonReentrant` modifier | 一键止血；**对 112,805 gas happy path 增量 ≈ 0** | 存储重排（但 D1 下零成本）；熔断期 owner 仍可 grant/revoke（正确） | 3 h |
| C-04 | Manager+Delegator | **P0** | 新增 admin 函数必被 agent 触达（denylist 靠人手、两处重复） | `onlyOwner` 内 `ownerOnlySelectors[msg.sig]=true` **自封闭** + `_seedAdminDenylist()` 单一来源 + `adminSelectorDigest()` | 结构性消灭整类缺陷；Delegator 从 7 行复制降到 2 行 | 每次 admin 调用 +1 SSTORE（冷 22.1k）；**热路径零影响** | 4 h |
| C-05 | Manager | P1 | Scope 注释宣称"授予后不可变"，代码却可静默覆写 | 存 `scopeHash`；3 参 `grantSessionKey(key, scope, expectedCurrentHash)`；`ScopeReplaced` 事件 | 活跃 key 的任何改动必须"命名被替换物" | grant 路径 +1 keccak +1 SSTORE | 4 h |
| C-06 | Manager | P1 | E11 declared 额度全局套用 + selector 表仅 2 项 + 溢出 Panic | `_declaredFor(token, target, selector, data)` 按 `target==token` 逐 token 解析；扩 `safeTransferFrom`/`WETH.withdraw`；差值比较防溢出 | 消除 WETH/Vault 合法操作**误杀**；杜绝"转 A 即容忍偷 B" | E11 开启时 +≤8×~60 gas | 6 h |
| C-07 | Manager | P1 | `transferOwnership` 一步即时，被盗 key 可单 tx 交出钱包 | 两步 `pendingOwner`+`acceptOwnership`（48h）；timelock 仅作用于 ownership 转移 + **denylist 移除**（权力放大），收紧保持瞬时 | 失窃从"瞬时全额失陷"降为"48h 可观测可取消" | 变 2 笔 tx；invariant handler 须改 | 6 h |
| C-08 | Manager+Deploy | P1 | "生产必须用 Safe"只是文档约定，链上零强制 | `ownerMode`(0=EOA/1=合约必需)；`extcodesize(owner)>0`；**部署侧零合约改动的强制**：`Deploy.s.sol` 检测 `owner.code.length==0 && !envOr(SIGILKIT_ALLOW_EOA_OWNER)` 则 revert | 关闭"生产部署出 EOA 拥有的资金合约"整类事故 | 每 admin +EXTCODESIZE(2.6k/100)；Anvil 本地流程需加 env | 3 h |
| C-09 | 7579 | P1 | 变长 proof 尾 + 无长度前缀 → 两种解析器、边界歧义、**1271 不可行** | 统一 `[uint16 sigLen][sig][定长 proof 尾]`，`PROOF_MAX_DEPTH=3`（97B）；`_splitSignature` 单一解析器 + 1271 分支 | C-01 根除；两条路径签名语义对等；calldata 定长可预测 | **breaking**（wire format）；定长尾把白名单深度硬限 3 | 8 h |
| C-10 | 7579+Executor | P1 | 两条路径能力不对等（7579 缺 E10/E11） | ① validator: per-account `approver` + 审批签名段；② executor: `maxValuePerExecution` + `enforceNativeDelta` + watchlist | 标准原生路径达到能力对等，落点正确 | validator +1 ecrecover；executor +2 staticcall/项 | 10 h |
| C-11 | 7579 | P1 | mode word 只读首字节、callType 不可配、空 calldata selector 撞 ERC-165 | 校验 `uint240(mode)==0`；per-account `allowedCallTypes` bitmap；`_selectorOf` 共享库（消除 validator/executor 两套语义） | 把"账户与验证器对 callData 解释一致"从运气变成链上强制 | `uint240(mode)!=0` 是**收紧**，须先对目标账户（Kernel v3/Safe{Core}）真机验证；建议先发事件告警再切硬校验 | 6 h |
| C-12 | Manager+7579 | P2 | Scope struct 无版本概念，插字段静默错解 | `SCOPE_VERSION` + `scopeVersion` + `SCOPE_TYPEHASH()` + golden vector 漂移测试 | 把 struct 变更从隐性破坏变成显式失败 | +1 byte/key（可打包，净 SSTORE≈0） | 3 h |
| C-13 | SpendPolicy | P2 | tumbling 边界可合法花掉 ~2× cap | ① **零 gas 配置规则**：`_validateScope` 强制 `perActionCap*4 <= perWindowCap`（边界 2× → ≤1.25×）；② 可选 `windowMode=1` 衰减结转（≈1.5×） | 先用配置消除 80% 抖动 | ① 会拒掉部分既有 scope（`GasBudget.t.sol:75` 是 1/5 ✓；`SessionKeyManager.t.sol:66` 是 1/2 **会被拒**）；② +1 slot | 2 h / 4 h |
| C-14 | SpendPolicy+7579 | P2 | 窗口只有全局一个维度；7579 batch `unchecked totalValue` 溢出可绕 cap | `TargetCap[≤8]`（共享同一窗口时钟）+ `TargetCapCharged` 事件；`checked` 求和 | 表达"按 target 的预算"；封掉溢出洞 | grant +≤16 slot；**per-target 状态只在 targetCaps 非空时产生任何 SLOAD/SSTORE** | 8 h |
| C-15 | Manager | P2 | 无批执行，多目标动作只能多笔 tx、多窗口、**中途失败留部分执行状态** | `executeBatch(requests[], sigs[], proofs[], approvals[])`，上限 8，全有或全无；`_executeOne` 提取现有逻辑 | 原子多目标；单窗口聚合；gas 摊薄 | **拒绝 try/catch**（失败的 item 如何退还计费无解，EVM 无法部分回滚 SSTORE）；锁持有期延长；易 stack-too-deep | 10 h |
| C-16 | Manager | P2 | 窗口滚动无事件；nonce 无救援通道；无单调性不变量 | `WindowRolled`/`ScopeReplaced`/`NonceSkipped` 事件；`bumpNonce`；`invariant_noncesMonotonic` | 卡死的 key 可自助恢复；把"nonce 不可重置"变成 CI 门禁 | 每次窗口首笔 +1 log（≈1.9k，相对 112.8k 的 1.7%） | 6 h |
| C-17 | script | P2 | 7579/Executor/Delegator **无部署脚本**；确定性脚本只覆盖 Manager；自检全靠人工 checklist | `DeployAll.s.sol` + `DeployDeterministic` 泛化到 4 合约 + 脚本内 `require` 自检 + `DeployScript.t.sol` | `DeployDeterministic` 原注释承诺的"multi-chain 同址"**首次真正兑现** | 脚本层复杂度；EOA-owner 拒绝（C-08）会让现有 Anvil 流程需加 env | 8 h |
| C-18 | test | P2 | E11/7579 无 property 覆盖；fork 只测 1 链；gas 预算缺 4 条关键路径 | `BalanceDeltaInvariant.t.sol`（**必须 vm.deal**）；4 条新 Halmos spec；`ForkMultiChain.t.sol`（含 CREATE2-on-fork）；4 条新 gas 预算 | 关闭形式化与性能盲区 | **前置：必须先修 `HalmosAuth.t.sol:85`**，否则新 spec 同样空转 | 10 h |

### C-01 详解（最高优先的零兼容代价项）
`_parseBatchProofs` 有 `if (totalElements > MAX_TOTAL_PROOF_ELEMENTS) revert`（`:377`），但**单调用路径完全没有对应约束**：
```solidity
uint16 count = (uint16(uint8(signature[65])) << 8) | uint16(uint8(signature[66]));
if (signature.length != 67 + uint256(count) * 32) revert InvalidSignature();
proof = new bytes32[](count);          // count 最大 65535
for (uint256 i = 0; i < count; ++i) { … }   // 65535 次 keccak
```
`count` 是 `uint16`，攻击者可构造 ~2 MB 签名段 → bundler 模拟时烧满 `verificationGasLimit`、分配 65535×32B；同 EntryPoint 上其他 op 被连带拖累。修复是 1 行：
```solidity
uint256 private constant MAX_SINGLE_PROOF_ELEMENTS = 8;
if (count > MAX_SINGLE_PROOF_ELEMENTS) revert InvalidSignature();
```
**纯收紧，无兼容代价**（现有测试最深 1 层）。

### C-04 详解（结构性消灭一整类缺陷）
两个真实缺陷：① `SessionKeyManager` 构造函数（`:145-150`）手列 6 个 selector，`SigilKitDelegator.initializeSelfOwned`（`:43-49`）**复制同一份并多加一条**。C-02/C-03/C-07/C-16 新增的每个 selector 都要改两处——而 `SigilKitDelegator.t.sol:161-182` **只验证了"非 owner 不可达"，没有任何测试断言"每个 admin selector 都在 denylist 里"**。② `DEPLOYMENT.md:97` 的自检是人工的。
```solidity
modifier onlyOwner() {
    ManagerStorage storage s = _manager();
    if (msg.sender != s.owner) revert NotOwner();
    _setSelectorDenied(msg.sig, true);   // msg.sig 即当前帧的 selector
    _;
}
function adminSelectorDigest() external pure returns (bytes32);  // 比对锚点
```
配套**回归锁**（必须新增）：`test_AdminSelectorDigest_MatchesHardcodedList` + `test_DenylistCoversManagerAdminSurface`——新增 admin 函数忘改清单 → digest 断言红。

### 明确否决的做法
- ❌ 把 E11 放进 7579 validator（D3）
- ❌ 引入 `try/catch` 的部分成功批执行（C-15）
- ❌ 真·滑动窗口（**数学上不改善上界**：任何允许"瞬时花掉 cap"的在线算法，在随后 W 秒内都能再观察到最多 `cap` 流入；令牌桶与 tumbling 最坏情况都是 2×）
- ❌ 保留 2 参 `grantSessionKey` 处理活跃 key（C-05 的全部价值就在这里）

**Phase 0 → 5 构建顺序**：Phase 1 P0 止血（C-01/03/04/08，无 breaking）→ Phase 2 **Scope 一次改到位**（C-02+05+12+14 合并成 1 次 breaking）→ Phase 3 7579 wire-format breaking（C-09+10+11 合并成 1 次）→ Phase 4 运营（C-15/16/13/17）→ Phase 5 验证（C-18）

---

## 二、TypeScript SDK（20 条）

**基线判断**：现有安全底座已完整（`NonceGate` 租约 + `ExecutionGuard` sign/send 双 fence + `executeSimulated` + revert 解码 + token path 预检）。以下均以**新增能力、默认不削弱现有属性**为原则。

**一个值得单独指出的发现**：`abis.ts:41-98` 的 `SIGILKIT_ERRORS_ABI` 实际声明 **27 个唯一 error name**（`KeyUnknown`/`KeyRevoked`/`KeyExpired`/`SelectorDenied`/`TargetNotAllowed`/`InvalidSignature` 在 manager 与 7579 间重名，数组内已去重）。

| ID | 模块 | P | 改进点 | 关键设计决策 | 工时 |
|---|---|---|---|---|---|
| S-01 | client | 高 | gas/EIP-1559 + relayer tx nonce 透传 | **关键区分**：`prepareExecution` 的 `request.nonce` 是 SessionKeyManager 策略 nonce（链上严格递增），与 relayer 账户交易 nonce 是**两个不同概念**，不能共用字段 | 6 h |
| S-02 | client | 高 | EIP-7702 `authorizationList` 透传 | 授权对象是 relayer EOA，其 authorization nonce 与 `request.nonce` 各自独立；节点对 type-4 支持不一需前置校验 | 6 h |
| S-03 | client | 高 | 提交前 simulate 策略化 | 修正一处已存在的不一致：`simulateExecution` 默认 `from=managerAddress`（`:699`）而真实 send 的 `msg.sender` 是 relayer（`:799`）——**模拟与发送的 caller 不同，结论不可直接迁移** | 6 h |
| S-04 | client | 高 | 重试 + 指数退避 + 抖动 | **send 阶段存在二义性**（抛错时交易可能已广播）。`client.ts:425-428` 已有 "submission attempted" 保护 → send 阶段默认不重试，只对 preflight/simulate/receipt 开放 | 8 h |
| S-05 | client | 高 | 结构化 `ErrorCode` + 三分类 | 替代字符串前缀约定（`:542`/`:745`/`:816`/`:824`）；`isSubmissionUncertain()` 供 S-04 消费 | 6 h |
| S-06 | client | 中 | 批量执行 API | 同 key 多笔**必须完整串行**（每项独立 prepare→send→confirm），不能只并行签名——否则第二项 `getNonce` 会读到未确认的旧值 | 8 h |
| S-07 | client | 中 | 事件订阅代替轮询 | WS 断线**必须从最后游标回补**，否则丢事件；polling 保留为降级 | 6 h |
| S-08 | signing | 中 | EIP-1271 签名 | 链上 `:514-543` 已实现 1271 路径，SDK 无构造 API；注意不同钱包 1271 返回格式不统一（有的返回 magic value 而非签名） | 6 h |
| S-09 | signing | 中 | digest 导出 + 离线预签名 | 拆分 `prepareUnsigned`/`externalSign`/`verifyEnvelope`/`submitEnvelope`；canonical JSON 须固定大小写/字段序/hex 大小写 | 6 h |
| S-10 | signing | 中 | 签名域可配置 | 7579 用 `name="SigilKit7579"` 且 **verifyingContract 位置放的是 account 而非 manager**（`SessionKey7579Module.sol:424-428`）——两套域不可互换 | 4 h |
| S-11 | signing | 中 | E10/E11 本地预检 | **E10 只能做存在性预检**（approval 签名有效性需链上 ecrecover）；**E11 无法完整本地镜像**（依赖 inner call 前后真实余额）→ 都标 advisory | 6 h |
| S-12 | signing | 中 | data/leaves 长度上限 | 链上 `MAX_TOTAL_PROOF_ELEMENTS=32`，TS 侧**无对应约束**；不加上限则经 MCP 暴露时是 DoS 面 | 4 h |
| S-13 | eip7702 | 中 | type-4 构造+发送便捷 API | **不自造 RLP**——`eip7702.ts:61-68` 注释已记录地址定长编码的规范陷阱（`0x94‖20×0x00` vs `0x80`），发送层更应交给 viem | 6 h |
| S-14 | eip7702 | 低 | paymaster 赞助 + 批量授权 | paymaster 是**新增外部信任边界**（能看到 calldata 并决定是否代付）；批量授权要求每条 nonce 严格递增不重复，缺 `publicClient` 时必须全部显式提供否则 fail-closed | 10 h |
| S-15 | lease-fs | 中 | 权限掩码 + 网络 FS 检测 + metrics | `mkdirSync`（`:35`）与 SQLite 文件均未设 mode → 同机其他用户可读**并篡改**租约行；文件头注释明确"不要用网络 FS"（`:5`）但**无运行时检测** | 6 h |
| S-16 | errors | 高 | 错误码体系 + 27 条映射 + 原始 revert 保留 | 映射表需与 ABI 同步（已有 abi-drift 保 ABI 同步，可加映射表漂移测试）；`decorateWithDecodedRevert` 当前对未知错误**不保留 decoded 结构** | 8 h |
| S-17 | validation | 中 | 批量校验 + 聚合 + i18n | 现有 `assert*` 全是 throw-fast；`ValidationCollector` 只能同步 `check()`；i18n 需把 ~30 处英文串 key 化 | 10 h |
| S-18 | logger | 高 | 自动脱敏 + span + 可插拔 sink | 字段名黑名单不可能穷尽 → 递归 + 可扩展 `redact`；`createLogger` 内部多处调用需补齐选项透传，否则 `child` 会**丢失脱敏配置**（易漏回归点） | 8 h |
| S-19 | cli | 中 | 子命令框架扩展性 | 需重构三个包的 cli.ts；`indexer/src/cli.ts:96-241` 是 145 行 if/else（6 个子命令） | 12 h |
| S-20 | client | 中 | **模块拆分（零风险）** | 962 行混了 5 类职责；拆分后 `lease-fs.ts:15` 从 `./client.js` 改为 `./lease.js` **消除潜在循环依赖**；`index.ts` 已 `export *`，re-export 保兼容 | 4 h |

### S-20 详解（唯一"零 API 破坏 + 消除循环依赖"的高杠杆项）
| 行段 | 内容 | 行数 | 迁往 |
|---|---|---|---|
| `30-103` | `SESSION_KEY_MANAGER_ABI` | ~74 | `abis.ts` |
| `195-442` | 租约原语（`LeaseToken`/`LeaseStore`/`InMemoryLeaseStore`/`NonceGate`/`ExecutionGuard`/`LeaseLostError`） | **~248** | `src/lease.ts` |
| `448-828` | `SigilKitClient` 本体 | ~381 | `src/client.ts`（留） |
| `830-956` | ERC-20 ABI + `TokenPathReport` + `ActionLogRecord` + `parseActionLogged` | ~127 | `src/audit.ts` |

`client.ts` 962 → **约 425 行**。`lease-fs.ts:15` 当前从 `./client.js` import `LeaseStore`/`assertLeaseTtl`，而 `client.ts:118-125` 的文档又反向引用 `lease-fs`——**两个文件互为依赖来源**，拆分后变为 `lease-fs.ts → lease.ts` 单向。

### S-05/S-16 的 27 条错误映射（节选）
| Custom error | ErrorCode | category | retryable | 本地可预检 |
|---|---|---|---|---|
| `PerActionCapExceeded` / `PerWindowCapExceeded` | `POLICY_REJECTED` | policy | ✗ | ✓ |
| `RequestExpired` / `KeyExpired` | `POLICY_REJECTED` | policy | ✗ | ✓ |
| `TargetNotAllowed` / `SelectorDenied` | `POLICY_REJECTED` | policy | ✗ | ✓ |
| `OwnerCountersignRequired` | `POLICY_REJECTED` | policy | ✗ | ✓（E10 存在性） |
| `NonceUsed` | `ON_CHAIN_REVERT` | onchain | ✗ | 部分 |
| `InvalidSignature` | `ON_CHAIN_REVERT` | onchain | ✗ | ✗ |
| `NativeDeltaExceeded` | `ON_CHAIN_REVERT` | onchain | ✗ | ✗（E11 不可本地镜像） |
| `InnerCallFailed` | `ON_CHAIN_REVERT` | onchain | ✗ | ✗ |

---

## 三、服务层（19 条）

### indexer（ENH-I，6 条）

| ID | P | 改进点 | 实现 | 收益 | 工时 |
|---|---|---|---|---|---|
| **I-01** | P1 | 查询索引 + `--limit` 下推 + spend rollup | 追加 `(agent_id, block_number DESC, log_index DESC, chain_id)` 覆盖索引（实测 **12.19 ms → 0.01 ms，1,200×**）；keyset pagination 避免 OFFSET 退化；`agent_spend_rollup` 表事务内维护 | 消除全表扫描；spend O(n)→O(1) | 12–20 h |
| **I-02** | P1 | 语句缓存 + WAL + busy_timeout | 构造末尾一次性 `prepare` 4 条热点语句（实测 **写吞吐 +45%**）；`journal_mode=WAL` + `synchronous=FULL`（审计库**当前是 SQLite 默认**，而 `lease-fs` 都用了 FULL）+ `busy_timeout=5000` | WAL 允许读写并行 | 4–8 h |
| **I-03** | P1 | 区块头批量预取 | 收集本批次唯一 block number → JSON-RPC batch 或限流并发（20/批）；已确认区块有界 LRU；**`toBlock` 的 pre/post 稳定性检查必须标记为"强制重读"** | 1,000 串行 RPC（≈50 s）→ 50 批（≈0.3 s） | 8–16 h |
| **I-04** | **P0** | manager-scoped reorg 自动恢复 | 加 `manager_address` 列（历史行标 `manager=''` unknown 桶，**绝不静默归给当前 manager**）；`recoverFromReorg(manager, height)` **同时**用链上 `getBlockHash(ancestor)` 回填游标 hash（不是 null）；`IndexerCoordinator` 协调多 (chain, manager) 任务 | 从"人工重建整个库"变可审计局部恢复 | 20–32 h |
| **I-05** | P1 | 可等待优雅停机 + health + metrics | `watch` 返回 `{stop(): Promise<void>; done: Promise<void>}`；`AbortController` + 可中断 sleep + drain timeout；`/healthz`（liveness）`/readyz`（readiness）`/metrics`（`cursor_lag_blocks`/`rpc_errors_total`/`reorg_events_total`/`consecutive_failures`） | SIGTERM 不留半完成事务；能发现"进程活着但长期不追头" | 10–16 h |
| **I-06** | P2 | 增量归档 + 冷热分层 | block-range 分区（`hot-2026-09.db` / `archive-*.db` / `archive-manifest.json`）；5 步事务化归档（选范围→导出→校验行数+主键+最高 block hash→写 manifest→**仅在校验成功后**删源）；FTS5 待 `rationale` 存明文后再考虑 | 控制文件增长与备份时间 | 12–20 h |

### MCP（ENH-M，6 条）

| ID | P | 改进点 | 实现 | 工时 |
|---|---|---|---|---|
| **M-01** | **P0** | `audit_query` 路径白名单 + 根目录约束 | `db` 参数从任意路径改为**受控数据库 ID**：`SIGILKIT_MCP_DB_ROOTS` + `SIGILKIT_MCP_DATABASES=default=<path>`；realpath 归一 + `path.relative` 前缀校验 + 拒绝 symlink 逃逸；错误只返回 `DB_NOT_ALLOWED`/`DATABASE_NOT_FOUND`（不返回完整路径与目录列表） | 4–8 h |
| **M-02** | P1 | stdio 行长/并发/队列/速率/响应上限 | 在**读取 chunk 时**累计字节（不是等 readline 产出完整行才检查）；`MAX_IN_FLIGHT=8`/`MAX_QUEUE=32`/`MAX_RESPONSE_BYTES=1MB`；信号量限制在途 tool 调用；错误 `SERVER_BUSY{retryable:true}` | 6–10 h |
| **M-03** | P1 | 严格 JSON Schema + 运行时校验 | `additionalProperties:false`；嵌套对象字段约束；数组长度/字符串长度/数值范围；BigInt 统一规范化为十进制串（不接受浮点）；**消除 `Boolean(value)` 真值转换**（`"false"` 会变 true） | 8–12 h |
| **M-04** | P1 | HTTP+SSE（**必须先修 M-01**） | 默认仍只听 `127.0.0.1`；bearer/mTLS；禁 `Access-Control-Allow-Origin:*`；校验 `Origin`；body/行/响应/并发复用 M-02 限制；建议改用官方 MCP SDK 而非继续扩展手写协议 | 16–24 h |
| **M-05** | P2 | +4 工具（propose/simulate/explain/report） | `propose_action`（规范化+预检+生成可签 payload）、`simulate_action`（受限 `eth_call`，**RPC 地址来自服务端配置不接受任意 URL**）、`explain_revert`、`scope_audit_report`（**必须有 limit 与 cursor，不允许无界导出**） | 16–24 h |
| **M-06** | P1 | 统一错误 envelope + 错误码 + schema 版本 | 保留 MCP 兼容 `isError`，同时结构化 `{ok:false,error:{code,message,retryable,details}}`；内部错误只返回 correlation id，详细堆栈写 stderr | 6–10 h |

### demo-agent（ENH-D，7 条）

| ID | P | 改进点 | 实现 | 工时 |
|---|---|---|---|---|
| **D-01** | **P0** | 分离 owner / relayer / session key | `TreasuryAgentConfig` 移除 `ownerPrivateKey`；拆 `OwnerGrantService`（Safe/HSM）+ `RelayerService`（只发已签 payload）+ `TreasuryAgent`（只签）。**agent 进程被攻陷时最多损失 session scope，而非 owner 钱包** | 12–20 h |
| **D-02** | P1 | 重试/退避/超时/未知提交 | `RetryClass` 分类（RPC_TRANSIENT/RATE_LIMITED/TIMEOUT/REVERT/POLICY_REJECTED/**SUBMISSION_UNKNOWN**）；`sendTransaction` 已调但超时 → 先按 tx hash/nonce 查询，**不直接重发**；直接复用已获得的 receipt 解析 `ActionLogged`（当前 tick 重复等待） | 8–12 h |
| **D-03** | P1 | 持久化幂等 ledger + outbox | `intentId = H(chainId, manager, sessionKey, agentId, target, selector, calldata, value, nonce, expiry)`；状态机 planned→signed→submitted→confirmed→audit_verified；`submitted → unknown → reconciled` | 12–20 h |
| **D-04** | P2 | 策略插件化 + dry-run + 模拟优先 | `Strategy{id, describe(), evaluate(ctx)}`；CLI `--strategy`/`--dry-run`；顺序：validate→**simulate**→relay→confirm→verify→ledger。直接复用 `executeSimulated()`；**插件只返回声明式 decision，不得直接访问私钥或任意 RPC** | 10–16 h |
| **D-05** | **P0** | 模拟链/真实链硬护栏 | 默认只允许本地链（31337/1337）；启动时 `eth_chainId` 与 `--chain-id` 不一致立即失败；对 1/10/8453/11155111 **默认拒绝**，需显式 `--allow-live-chain`；**拒绝已知 Anvil dev key 与非本地 RPC 的组合** | 4–8 h |
| **D-06** | P1 | fleet 跨进程协调 + scope 分区 | 同机多进程复用 `core` 的 `FileLeaseStore`；多机用 Redis `SET NX PX`/etcd；lease key 至少含 `chainId+manager+sessionKey`；**共享 key 时把 window cap/target partition/idempotency domain 明确拆开**（nonce 只能解决序号冲突，不能解决业务重复执行） | 8–16 h |
| **D-07** | P1 | 结构化指标 + 失败计数 + 告警 | `AgentState` 增 `consecutiveFailures`/`pendingTxHash`/`lastError`/`lastSuccessAt`；`demo_agent_{ticks,actions,failures,reverts,timeouts,unknown_submissions,audit_missing,nonce_conflicts}_total`；**不绑定具体告警厂商** | 6–10 h |

### 跨包收敛（3 条）
1. **CLI 框架已下沉**——`core/src/cli.ts` 完整实现且三包**全部已 import**（`indexer/src/cli.ts:20`、`mcp/src/cli.ts:16`、`demo-agent/src/cli.ts:24`），**不存在重复实现**（此前提设与代码事实不符）。应抽的是运行时公共部分：`createServiceContext({service, env, cwd})` 统一 `.env` 加载/logger/config/signal/exit code。**注意**：MCP 的 `defaultLogger` 在模块加载时读 `process.env`，而 CLI 之后才 `loadDotEnv()` → 嵌入式调用 `serveStdio()` 时 `.env` 可能不生效。
2. **统一错误类型**——`core` 增 `AppError{code, retryable, operation, details}`，统一 `ValidationError`/`ConfigurationError`/`RpcUnavailableError`/`ReorgDetectedError`/`StaleCursorError`/`DatabaseBusyError`/`LeaseLostError`/`SubmissionUnknownError`/`AuditMissingError`。
3. **明确服务边界**——indexer 只负责链上→审计存储；mcp 只负责协议/校验/资源限制/编排（**MCP 不应持有私钥**）；demo 只负责策略/签名/编排（**不应绕过 core 的 guard 或 scope 校验**）。

---

## 四、工具链 + CI + 文档（21 条）

### 工具链（ENH-T，7 条）

| ID | P | 改进点 | 关键事实 | 工时 |
|---|---|---|---|---|
| **T-01** | **P0** | `verify.mjs` 每步 timeout + 失败输出捕获回放 | `:118-122` `stdio:"inherit"` 子进程输出直接串流，gate 自身不留记录；`spawnSync` 无 `timeout`/`killSignal` → 任何 npm/forge/vitest 挂死无限期挂起。**"一份 run 告诉你所有坏的东西"在挂死时退化为挂死** | 4–6 h |
| **T-02** | P1 | `check-doc-counts` 守卫扩到 CHANGELOG/STATUS/TROUBLESHOOTING/vault | 当前守卫面只有 README + 白皮书；CHANGELOG 贡献了本轮全部 6 处漂移却**完全不在范围**。CHANGELOG 历史节不能全量守卫（旧版本号是当时真实的）→ 需 `--only-current` 语义 | 6–8 h |
| **T-03** | P1 | 补齐 4 个零覆盖提取器 | `checkSecurityTxt`（RFC 9116 披露通道守卫，**零测试**）+ 3 个计数正则（docs 数字的唯一来源）+ `check-runtime.collect()`（唯一真正碰盘的代码，**从未被调用**）。重构为"纯函数 + 薄 I/O"（脚本目录既有模式） | 5–7 h |
| **T-04** | P1 | 新增 `check-hygiene.mjs` 接为 verify gate #10 | 补 `PLAN-30-DAYS` W2-2.1 欠的债；AC-02/03 从"归档但无门"变"归档且有门"；`cli-dbg.db` 被跟踪这类问题会自动抓住 | 4–5 h |
| **T-05** | **P0** | 向量生成器 no-op 门 | `npm run vectors:generate && git diff --exit-code vectors/`——**破坏性 SDK 改动不能再无声通过**；+ `casesCount`/`leafCasesCount`/`proofsCount`/`leavesCount` 双向断言 | 4–5 h |
| **T-06** | P1 | 单一事实源 registry | Node 8 处 / forge 版本 2 处 / 排除语义 4 处 / 测试清单 2 处 / vitest 入口 2 处。**注意**：`ci.yml` 的 `env` 不能读 JSON → 建议保持字面量 + 一致性断言（零 workflow 改动） | 4–6 h |
| **T-07** | P1 | `clean.mjs` 加删除校验 + 测试 | `rmSync(force:true)` **不校验结果**；`broadcast/`（306 文件/8.1MB 本地部署记录，多链/主网部署**无法从源码重新生成**）在 TARGETS 里而注释称"All of it is reproducible"——**这是错的**；**全目录唯一没有任何测试的主脚本** | 3–4 h |

### CI（ENH-CI，6 条）

| ID | P | 改进点 | 工时 |
|---|---|---|---|
| **CI-01** | P1 | Halmos/Echidna 提升为 PR 门 | **前置不可跳过**：先修 `HalmosAuth.t.sol:85` arity + 加时钟约束，否则提门即红 | 2 h |
| **CI-02** | **P0** | **豁免过期机器门**（最高杠杆） | 新增 `check-waivers.mjs`：解析 `ci.yml` 的 `continue-on-error` job 集合与 `CI-WAIVERS.md` 表格**双向 diff** + 断言 `Expiry` 未过期。**这把 CI-WAIVERS 从"人类纪律"变成"CI 强制"**，零新范式（复制 check-doc-counts 模式） | 3–4 h |
| **CI-03** | P1 | 覆盖率阈值与实际对齐 | 消除三套矛盾数字（vitest 注释"90/77"、CHANGELOG "92.5/87.9"、实际阈值 "88/74"）。**必须严格区分"阈值（稳定可守）"与"实测（易变，只守最新节且容忍下降）"** | 3–4 h |
| **CI-04** | P1 | lint（biome）+ 依赖审计 | 当前**无对 `scripts/*.mjs` 的通用 lint、无依赖漏洞扫描**；建议 biome **只作用于 scripts/**，不碰 packages（那里已有 lint） | 4–6 h |
| **CI-05** | P1 | job 依赖图化 + 缓存 | 12 job 全并行无 `needs`；`workflow-lint` 声称"runs first so it fails fastest"但**无依赖保证**；`forge-unit`+`forge-invariant` 合并省一次完整 solc 编译；新增 `cache-forge` job 上传 `out/`+`cache/` 供下游复用 | 3–4 h |
| **CI-06** | P1 | `aggregate` 汇总 job 作单一 required check | 没有 required checks，PR 可合入全红 CI（因为没人被阻塞）。aggregate 让"新增一个门"自动变成"新增一个 required check"，零维护 | 2–3 h |

### 文档（ENH-DOC，5 条）

| ID | P | 改进点 | 工时 |
|---|---|---|---|
| **DOC-01** | **P0** | `STATUS.md` 重写为四层权威 | L1 规范（代码）/ L2 记录（CHANGELOG+CI-WAIVERS）/ L3 计划（PLAN-30-DAYS+catalog）/ L4 背景（白皮书+vault）。修 vault 文件数 21→**22** | 2 h |
| **DOC-02** | **P0** | v2.0 白皮书加 SUPERSEDED 横幅 | 含 6 条已证伪断言仍在仓库。**建议先做横幅（今天就能做，零风险）**，移出到 `docs/archive/` 后续做 | 0.5 h |
| **DOC-03** | P1 | CHANGELOG 纳入守卫 | 见 T-02。独立列出因为它是审计与资助方会读的第二重要文档 | 2 h |
| **DOC-04** | P1 | 统一规范 URL + vault 过期标记 + 移除绝对路径/个人身份 | **URL 统一依赖最终仓库归属（AC-28 无 remote），现在做可能被推翻** → 做成"定一处变量 + 全局引用" | 7.5 h |
| **DOC-05** | P2 | 从代码自动生成 API 参考 | typedoc 从 `dist/*.d.ts` 生成 + no-op 门；约定"生成物纯自动，手写说明放别处或用 `@remarks` 注解" | 4–5 h |

### ABI + 向量门禁（3 条）

| ID | P | 改进点 | 关键事实 | 工时 |
|---|---|---|---|---|
| **ABI-01** | P1 | `contracts/src` 全部 7 个 `.sol` 纳入 | 当前只 4 个；**`ActionLogger`（INV-3 审计事件发出方）、`SpendPolicy`（INV-1 核心）、`MerkleWhitelist` 完全不在门禁内**。改用**目录扫描**替代手写清单作为完整性来源 | 3–4 h |
| **ABI-02** | P1 | `signatureOf` 补 mutability+outputs + 按合约归属 + 本地可检测 | ① 当前只比 `name(inputs)` → `view` 改 `nonpayable` **检测不到**；② error 用 **4 份 ABI 并集** → 无法定位"哪个合约新增了 error"；③ **漂移只有 CI 能拦**，本地 `npm test` 全绿 | 6–8 h |
| **VEC-01** | P1 | 计数断言 + 双份统一 + 外部权威 | ① 4 处手工计数零断言；② `eip7702.json`(6) vs `eip7702.test.ts` 硬编码 8 条**仅 1 条重合**（那 4 条非重合向量**有价值，应反向补进 json** 而非删）；③ actionrequest/merkle **自证** → actionrequest 改用 viem `hashTypedData` 生成 | 5 h |

---

## 五、开发者体验（15 条）

| ID | P | 改进点 | 关键设计决策 | 工时 |
|---|---|---|---|---|
| **UX-01** | P1 | 全局统一 `--json` 输出契约 | 统一信封 `{ok, command, version, data｜error:{code,message,hint}, meta}`；bigint 一律十进制串。**唯一 breaking 项**，需版本字段+兼容开关 | 12–16 h |
| **UX-02** | **P0** | 颜色治理（tty/NO_COLOR/语义不依赖颜色） | `verify.mjs:50-58`/`bootstrap.mjs:36-48` 直接输出 `\u001b[32m`，不看 `isTTY`/`NO_COLOR`/`TERM=dumb` → CI/管道里满是转义序列；状态**始终**带文字标签（`PASS/FAIL/SKIP`），颜色只做强化 | 4–6 h |
| **UX-03** | P2 | 危险操作交互式确认 | `isTTY && !--yes` → 提示（默认 No）；**非 TTY 且无 `--yes` → fail-closed**（提示加 `--yes`）；`--force` 仅脚本化绕过并记审计 | 6–8 h |
| **UX-04** | P1 | 错误建议目录 + `sigilkit doctor` | `ErrorCode → {message, remedy, docsAnchor}`；doctor 探测 Node/forge/anvil/RPC/DB 逐项 PASS/FAIL + 修复建议，一次性回答"为什么跑不起来" | 8–10 h |
| **UX-05** | P1 | 分层 help + `help <topic>` | 当前只有一页全局帮助，所有 flag 平铺；`indexer` 的 `backfill` 与 `actions` 差异很大却共用一张 options 表 | 8–12 h |
| **UX-06** | P1 | Shell 补全 | 补全数据**直接来自同一份 `CliSpec`**，避免第二真相源；Windows PowerShell 补全生态弱，主投 bash/zsh/fish | 6–8 h |
| **UX-07** | P1 | 一条命令的端到端 demo | 检测 8545 已有链则复用、无则 spawn anvil，轮询就绪后跑完整流程，结束/Ctrl-C 回收子进程。**Windows 用 job object / detached 处理**（主要平台风险） | 12–16 h |
| **UX-08** | P1 | `--dry-run` 广泛覆盖 | `backfill --dry-run` 解析 from/to、估算将写入事件数但**不落盘/不推进游标**；dry-run 与真实路径**共享同一"计划生成"函数**避免两套代码漂移 | 8–12 h |
| **UX-09** | **P0** | verify 失败时给可复制的最小复现命令 | `--only=<label>` 能力已存在却未在失败输出中提示；新增 `verify --list` 与 `verify --json`；失败行前置 + 文字状态 | 4–6 h |
| **UX-10** | P1 | 覆盖率与 gas 报告可读化 | `coverage --summary` 终端表格（未过阈值非零退出）；gas 表标出逼近预算者；窄终端自动降级为 `key: value` | 8–10 h |
| **UX-11** | P1 | 审计查询的自然语言入口 | **受限查询构建器优先**（`report --agent <id> --last 1h --format text\|markdown\|json` + `--explain` 打印等价 SQL）；NL 入口只做"NL→受限参数"，**不做自由 SQL** | 10–12 h |
| **UX-12** | **P0** | 状态表动态生成 | marker 块包裹 README 表格 + `npm run docs:status` 从 `forge test --list`/workflow YAML/vitest JSON 生成整表；`check:docs` 改为"生成物必须与工作区一致"的一致性门禁 | 8–12 h |
| **UX-13** | P1 | 快速开始故障分支 + ADR 机制 | 每步下挂折叠的"若失败"分支（复用 UX-04 错误目录避免文案漂移）；`docs/adr/` 编号模板 + 索引；CONTRIBUTING 要求架构/契约/CLI 改动须附 ADR | 6–8 h |
| **UX-14** | P1 | 无障碍与国际化 | 表格提供 `--plain`/窄屏降级为 `label: value`；日期用 `Intl.DateTimeFormat`；错误改 `code + messageKey`；`--lang`/`SIGILKIT_LANG` 贯通。**注意**：JSON 仍输出原始十进制串，不本地化 | 12–16 h |
| **UX-15** | P2 | 可选只读审计面板 | 评估两方案：**A. 静态 HTML + 极薄 Node 服务（推荐，零前端工具链、复用 node:sqlite、只读）** vs B. 完整前端（引入构建/依赖/安全面，对 v0 过重）。MVP：概览+actions 表+window 表+过滤+Export JSON，只绑 `127.0.0.1`。补 `PLAN-30-DAYS` W3-7.2 的欠账 | 16–24 h |

---

## 实施顺序建议

| 阶段 | 内容 | 理由 |
|---|---|---|
| **第一批（零风险高杠杆）** | UX-02、UX-09、T-05、T-01、CI-02、ABI-01、BUG 类小修 | 全部纯局部改动，收益立即可见 |
| **第二批（能力解锁）** | S-20（模块拆分，为后续 SDK 改动铺路）、C-03/C-04（pause+denylist 自封闭）、M-01、D-01/D-05 | 拆分先行避免后续冲突；安全边界先行 |
| **第三批（一致性对齐）** | ARCH-9（scope 单一源）→ C-02/C-05/C-12/C-14 合并为**一次** breaking → S-11/E10 预检 | 把 4 处 breaking 合并成 1 次 |
| **第四批（规模化）** | I-01/I-02/I-05、M-02/M-03/M-06、UX-01/S-05/S-16/S-18 | 建立在稳定 schema 与错误体系之上 |
| **第五批（7579 对等）** | C-09/C-10/C-11 合并为**一次** wire-format breaking | 单独一次，配 CHANGELOG major 标注 |
