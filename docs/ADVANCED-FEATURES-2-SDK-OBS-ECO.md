# SigilKit — Advanced Features (2/2)：SDK 生态 + 可观测治理 + 生态市场

> 日期 2026-09-25 · 承接 `ADVANCED-FEATURES-1-CONTRACTS-DATA.md`
> C 分部 10 条 + D 分部 10 条 = 本文件已写 20 条（E 分部 E1–E10 未写入本文件，见文末说明）

---

# 第三部 · SDK / Agent 生态（C1–C10）

## 五条设计红线

1. **不要直接修改 `ActionRequest` v1 的字段含义。** 新能力通过版本化 envelope 或 v2 entrypoint 引入，避免破坏已有 EIP-712 digest 和 relayer。
2. **Passport 不是第二个授权引擎。** 合约验证签名/hash/issuer/状态/`policyHash`；**JSON 语义正确性由编译器、schema、向量、链下预检保证** —— 合约不可能安全地解释任意 JSON。
3. **模拟结果必须标注覆盖度。** `eth_call` 只证明 calldata 在某区块上下文可执行；无 trace provider 时**必须返回 `partial` 或 `unknown`**，不能伪造"状态无变化"。
4. **relayer 只能影响 liveness 和费用，不能改变授权。** 不应能替换目标/金额/calldata/identity/policy；`request.value` 是钱包执行资金，**不应与 gas/service fee 混用**。
5. **`agentId` 不能继续承担 passport ID、trace ID 或签名者证明的全部语义。** 至少区分 `agentId`/`sessionKey`/`passportId`/`requestDigest`/`traceId`。

## C 分部总表

| # | 能力 | 工时 | 复杂度 | 生态价值 |
|---|---|---|---|---|
| **C-02** | 策略即代码（Policy as Code） | MVP 10–15 d / 稳健 25–35 d | 高 | 链上约束与链下 UX 不再漂移 |
| **C-01** | Agent 能力护照 | MVP 8–12 d / 稳健 20–30 d | 高 | 跨框架/跨运行时迁移；agent marketplace |
| **C-08** | Agent 可观测性与审计关联 | 7–12 d / +V2 20–30 d | 中高 | 事故调查 + 成本归因 |
| **C-06** | 可移植的离线签名流程 | MVP 7–10 d / 稳健 15–20 d | 中 | air-gapped agent/HSM/企业审批 |
| **C-03** | Simulate-Diff-Chain | MVP 8–12 d / 稳健 20–30 d | 高 | agent UX + 人工审批 |
| **C-09** | MCP 能力代理与执行闸门 | 7–12 d / 完整 18–28 d | 中高 | agent-facing control plane |
| **C-10** | Runtime-neutral Agent Adapter | 5–8 d / 3 框架 15–25 d | 中 | 降低框架锁定 |
| **C-04** | 预算代付（Gas Sponsorship） | relayer MVP 4–7 d / 4337 15–25 d | 中→高 | agent 无需持有 ETH；机器支付 |
| **C-07** | SIWx / ERC-4361 兼容 | 5–8 d / +registry 12–20 d | 中→高 | dapp 登录与 agent 身份互操作 |
| **C-05** | 多 Agent 协调原语 | 12–20 d / +链上 30–45 d | 很高 | task marketplace + A2A 支付 |

## C-02 · 策略即代码（**先于 Passport**，C 分部地基）

YAML/JSON policy → ①链上 `Scope` ②Merkle leaves/root ③selector denylist ④countersign ⑤tokenWatchlist ⑥链下预检规则 ⑦`policyHash` ⑧MCP capability 描述 ⑨human-readable grant calldata。
```typescript
// 三份输出
interface CompiledPolicy {
  onchainScope: Scope;        // 链上参数
  localPolicyIR: PolicyRule[]; // 链下预检规则（validateAgainstScope 消费）
  capabilityManifest: CapabilityDesc; // MCP/agent 消费
}
// target profile 感知：Manager 有 E10/E11，7579 没有 → 不支持的字段直接编译失败，
// 而不是静默丢弃（这正是 MCP coerceScope 当前的 S3 镜像问题）
```
**核心难点不是 YAML parser，是链上/链下语义一致性与双路径差异。** 测试和向量只能证明 conformance，**不等于数学上的形式化证明** —— 若要宣称"形式化保证"，需让 policy IR 生成链上断言或建立对应 Halmos spec。

## C-01 · Agent 能力护照

版本化、可签名的 JSON 证明"哪个 agent/session key 被授权；在哪个 chain/manager 有效；允许的目标/selector/金额/时间窗口；issuer/签发/过期/撤销；对应 `policyHash` + Merkle root"。目标：agent 从 LangChain 换到 CrewAI/AutoGen 后，只要仍使用同一 session key 或已授权 child key，**不必重新授权**。
```typescript
interface CapabilityPassport {   // "capability-passport/1"
  subject: { agentId: Hash; sessionKey: Address };
  issuer: Address;
  audience: { chainId: number; manager: Address };
  scope: Scope;                   // target profile aware
  policyHash: Hash; merkleRoot: Hash;
  validAfter: number; validUntil: number;
  parentPassportId?: Hash;
  signature: Hex;
}
passportId = keccak256(canonicalJson(passport))
```
**用独立 EIP-712 domain**（`SigilKit Capability Passport`），**不要复用 ActionRequest domain**（避免两个授权面互相污染）。新增 `CapabilityPassportRegistry.sol`：`publish`/`revoke`/`isValid`，记录 `PassportPublished`/`PassportRevoked`/`PassportStatusChanged`。**第一阶段只在 `grantSessionKeyWithPassport` 或独立 registry 中验证**，不先改 `ActionRequest`。**不能宣称"链上验证 JSON 语义"** —— 合约只验证 hash，语义由编译器 + schema + precheck 保证。

## C-03 · Simulate-Diff-Chain

在真正发送前给出：当前动作是否可执行；与上次已确认动作的差异（目标/selector/金额/calldata hash/窗口预算变化）；预计 gas；目标状态和余额变化；风险警告和未知覆盖项；可供人工/owner 审批的 `reviewId`。
```typescript
// 复用 executeSimulated 的 prepared payload，避免重新读取 nonce
const reviewId = keccak256(canonicalJson({
  requestDigest, simulationDigest, policyHash, expiry
}));
// 发送前检查三个 digest 仍一致；链头或状态变化 → 要求重新模拟
```
**RPC trace 能力不一致，且任意合约调用的完整状态差异不一定可观测。** 已知 ERC-20/目标 ABI：读取 `balanceOf`/`allowance`/`nonce`/目标状态；无法推断时**必须返回 `coverage: partial|none`**，不能伪造"状态无变化"。
**重要边界**：current E10 owner approval 只签 `requestDigest`，**不天然证明"人类看过 simulation diff"** —— 若 diff 是审批条件，需新的 `ReviewApproval` type，**不能假设现有 countersign 已覆盖该语义**。

## C-06 · 可移植的离线签名流程

```typescript
interface SigningEnvelope {   // canonical JSON 序列化必须固定
  version: string; chainId: number; manager: Address; sessionKey: Address;
  request: ActionRequest; scopeSnapshot: Scope; merkleProof: Hex[];
  ownerApproval: Hex; requestDigest: Hash; policyHash: Hash;
  nonceSource: "chain" | "pinned"; createdAt: number; expiresAt: number;
  runtimeMetadata: Record<string, string>;
}
```
拆分 `prepareUnsigned`/`externalSign`/`verifyEnvelope`/`submitEnvelope`。**在线提交时重新读取 `getNonce`/`getWindowState`/key 是否 revoked/expired**；若 nonce 或窗口状态已变，**返回 `stale-signature` 要求重新签名，不能静默替换已签名字段**。外部 signer 可为远程 `HashSigner`/HSM/QR/文件/人工审批系统。**难点是 stale state、序列化兼容与跨进程 provenance**（当前 `sendPrepared` 的 WeakMap provenance 是进程内对象，跨进程序列化后需重新验证）。

## C-09 · MCP 能力代理与执行闸门

Add 7 tools: `passport_describe`/`policy_compile`/`prepare_offline`/`simulate_diff`/`submit_signed`/`approval_status`/`relay_status`.
**MCP 侧原则**：① MCP **永远不接收 agent 私钥**；② Passport capability **只能缩小工具权限，不能扩大链上 Scope**；③ `submit_signed` 必须绑定完整 `requestDigest`；④ 工具声明 `readOnly`/`destructive`/`requiresApproval`；⑤ 保持 `2024-11-05` 兼容并设计版本协商；⑥ 所有 tool call 写入同一 `traceId`。

## C-10 · Runtime-neutral Agent Adapter（最低门槛，5–8 d）

In core define minimal interfaces: `Signer`/`PolicyEngine`/`SimulationAdapter`/`TransactionSubmitter`/`GasSponsor`/`Coordinator`/`TraceSink`/`Clock`. **core 只依赖接口**，不依赖 LangChain/CrewAI/AutoGen；各框架 adapter 只负责 tool schema + context 注入 + error 转换 + approval 回调；runtime/model 名称与版本作为 **metadata, not authorization core**. `passportId`+`envelope`= 跨框架最稳定的公共协议。**当前 `sendPrepared` 强耦合 viem `WalletClient`** → 通过 `TransactionSubmitter` 抽象解除（=ENH-S-01/S-02 已部分 solved）。

## C-04 · Gas Sponsorship

Distinguish ①**普通 relayer 代付**（agent 签好 ActionRequest，第三方 relayer 提交普通交易）；②**ERC-4337 paymaster 代付**（`paymasterAndData`，paymaster 收款）。
```typescript
interface SponsorshipRequest { requestDigest: Hash; sponsor: Address;
  maxGas: bigint; maxFee: bigint; serviceFee: bigint; validUntil: number; quoteId: string; }
```
**Service fee 不能复用 `request.value`**（后者是 Manager 钱包中要执行的金额，受 perActionCap/perWindowCap 约束；gas 和服务费属于 transport/settlement 层）。paymaster 有额外签名/format 需求，**与现有 sendPrepared 是 different code path**；**不要让第三方 paymaster become 链上 spend cap 的替代品。**

## C-05 · 多 Agent 协调原语

`TaskHandoff{taskId, parentAgentId, childAgentId, allowedActions, maxValue, deadline, inputHash, outputCommitment, parentSig}` + `BudgetPool`（`reserve`/`commit`/`release` + `allocationVersion` + 幂等 `actionId` + 过期自动释放）。**不共享 B 的私钥** —— A 只签发受限 capability delegation，B 再用自己的 session key 签具体 ActionRequest。**SDK 侧必须分离两个协调问题**：`NonceGate/LeaseStore`（同一 key 的交易序列）vs `ResourceCoordinator`（预算池、目标资源、任务依赖、业务冲突）。**共享 key 仅作为兼容模式，不作为多 agent 的推荐架构。**

---

# 第四部 · 可观测性 + 治理 + 合规（D1–D10）

| # | 功能 | 工时 | 复杂度 | 交付价值 |
|---|---|---|---|---|
| **D-1** | OpenTelemetry 原生 | 56–88 h | 中高 | 还原决策依据与授权链路 |
| **D-2** | 事件版本化 + Schema Registry | 40–64 h | 中 | 新旧消费者共存；历史按当时规则解释 |
| **D-7** | 密钥卫生自动化 | 24–40 h | 低至中 | 把 AC-01 从"有计划但未执行"变"可留证流程" |
| **D-10** | Audit Evidence Retention（hash chain + 锚定） | 40–64 h | 中 | 证明日志未被事后篡改 |
| **D-3** | Owner 治理仪表盘 | 80–120 h | 中 | 缩短异常发现/处置；责任到人 |
| **D-4** | Session Key 风险评分 | 72–112 h | 中高 | 持续风险评估 + 自动降权建议 |
| **D-9** | 事件响应自动化 | 72–120 h | 中高 | 缩短暴露窗口 |
| **D-5** | 多法域合规导出 | 64–104 h | 中 | 监管问询/内部审计/证据提交 |
| **D-8** | 多签/DAO 治理插件 | 80–120 h | 中高 | 职责分离 + 关键操作监督 |
| **D-6** | 证明式合规（ZK PoC） | 160–280 h | 高 | 不披露明细的可验证合规结论 |

## D-1 · OpenTelemetry（成本最低，先做）

Define 5 spans: `agent.decision`→`policy.evaluate`→`action.sign`→`action.submit`→`chain.confirmed`. **提交 span 先记录 pending，收到交易回执后关联确认结果**，避免把"广播成功"误当"链上成功"（current demo-agent tick 重复等待 receipt = 证据链断裂）。**Trace 与 audit 关联**：在 `sendPrepared` 中计算并记录 `requestDigest`，在 receipt 解析后绑定 `txHash`/`logIndex`/`ActionLogged`/`WindowCharged`.
**Metrics**：`sigil_indexer_rpc_requests_total`, `sigil_indexer_blocks_behind_head`, `sigil_indexer_reorg_recoveries_total`, `sigil_agent_actions_total`, `sigil_agent_audit_missing_total`（**INV-3 violation 实时告警!**）。**不要 bind 具体警告厂商**（demo 包内）。

## D-2 · 事件版本化（防止 breaking historical decode）

Current `ActionLogged` is 6 fixed fields；加字段破坏 topic0 → 旧事件无法识别。Use "versioned event envelope + field catalog": `schema_version`/`event_id`/`trace_id`/payload/`created_at`; register 表维护字段类型、required、sensitivity、compatibility; verifier 按版本解码. **升级规则变化与字段变化分开管理。** Existing 6 fields = v1 payload（**do not** break `parseActionLogged` topic0 matching for v1）。

## D-9 · 事件响应自动化（**设计要避免 DoS 可滥用**）

Detect → grade → act：① 签名节奏异常/目标切换/额度利用异常 → **告警 only**；② 自动限流/shorten expiry/limit targets；③ **auto revoke（高误报风险场景必须二次确认**，avoid 攻击者借异常触发 DoS）；④ human intervention. **撤销 service 需独立授权**（not just the same key that might be compromised）；idempotent key + 冷却期 + 人工恢复路径.

## D-6 · 证明式合规（ZK PoC）

Prove "统计期间交易均未超出批准额度，且无 denylist 命中"，**不公开交易明细**。Compile 额度约束/交易分类/排除规则 into ZKP constraints；由链下服务生成月度证明；验证合约只验证额度上限/有效范围/denylist 分类承诺。**先做小范围 PoC**，再评估证明成本/规模/审计要求. **需引入成熟证明库和独立审计**（circuit 漏项 = 新的信任边界）。**成本最大（160–280 h）但高价值**；**不应声称 ZKP proves correctness of the entire system** —— 只是一个 specific compliance claim。

## D 分部四条验收红线

① 事件版本和规则版本**共同**解释历史行为；② 风险分/event count/ZKP **不能替代法定的记录/披露/报告义务**（MiCA/SEC/DORA 实际适用性取决于产品类型/业务主体/数据类型/法域）；③ 事件响应撤销**必须幂等 + 授权审计 + 恢复路径**，误报不会直接升级为无限期 DoS；④ 撤销 service 需**独立授权**（not just the same key that might be compromised）；workbook: SEV-1/2 every 15 min updates.

---

# 第五部 · 生态集成 + 市场（E1–E10）

**战略总纲**：SigilKit 在生态里的正确身位不是"钱包"也不是"标准"，而是**跨钱包一致的策略执行层（policy runtime）+ 可导出的审计证据层**。钱包（MetaMask/Safe/Kernel）应是分发渠道；ERC-7579 应是插槽；SigilKit 拥有插槽里"**scope 语义、错误契约、证据格式**"这三样东西。All commercial value depends on "集成方愿

---

> 注：E 分部（生态集成 + 市场定位）因内容超长未能完整写入，将单独交付。见 ADVANCED-FEATURES-3-ECOSYSTEM.md。
