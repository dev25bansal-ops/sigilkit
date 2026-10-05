# SigilKit — Advanced Features (3/3)：生态集成 + 市场定位

> 承接 `ADVANCED-FEATURES-1-CONTRACTS-DATA.md`（A 合约 + B 索引）与 `ADVANCED-FEATURES-2-SDK-OBS-ECO.md`（C SDK + D 可观测）
> 生态类建议技术工时不高，但**价值取决于外部决策**（scope 归属、仓库归属、审计档期、市场定位）

## 战略总纲

SigilKit 在生态里的正确身位不是"钱包"也不是"标准"，而是**跨钱包一致的策略执行层（policy runtime）+ 可导出的审计证据层**。

- 钱包（MetaMask / Safe / Kernel）应是**分发渠道**
- ERC-7579 应是**插槽**
- SigilKit 拥有插槽里三样东西：**scope 语义、错误契约、证据格式**

所有商业价值都挂在「集成方愿不愿意把审计证据交给自己的合规/风控/保险流程」上——**这是唯一别人不会自建、也自建不划算的环节**。

依据：`docs/WHITEPAPER-v2.1.md:25-29`（修订后 thesis 已锁定为 bundle）、`vault/Risk & De-risk Plan.md:15`（"Be standards-native, not a new standard"）、`docs/PROJECT-REVIEW-2026-09-17.md:74`（"own the policy/audit semantics, error contracts, and evidence format"）。

---

## E 分部总表（按投资产出比排序）

| # | 建议 | 工时 | 价值 | 风险 |
|---|---|---|---|---|
| **E-10** | **证据可信度（总闸门）** | 3.5–5 人日 | **定价前提** | 修复会暴露更多真实缺陷 |
| **E-07** | 定位修正（GTM 三段式） | 2–3 人日 | 立刻改善所有后续沟通 | 过度依赖 TAM 数字会被质疑 |
| **E-05** | 开发者生态（先修分发通道） | 1.5 人日 + 示例 2.5–3 人周 | **npm 装得上 = 所有生态动作的乘数** | scope 可能买不到 |
| **E-01** | 钱包生态位置（可选增强模块） | 5–10 人日 | 零改造 wallet 侧分发 | 钱包厂商自建同类模块 |
| **E-06** | 标准化提案 | 3–4 人日 + 0.5 registry | 标准位 = 议价权 | 消耗紧张的 30 天窗口 |
| **E-03** | 托管/合规（可选策略签发层） | 4–6 人日 | 切 MAS SAFR / Korea FSC | 被误认为 CASP（法务风险） |
| **E-02** | DeFi adapters + 白名单生成器 | ~5–6 人周 | 唯一能把策略配置变产品的一层 | leaf v3 扩大审计面 |
| **E-04** | 保险（配置错误保险） | 阶段 A 1–2 人日 | 战略价值最高、成熟度最低 | pre-audit 宣传 = 最严重信任事故 |
| **E-08** | 合作/集成清单 | 见下表 | 优先级清晰 | — |
| **E-09** | 公共采用度 dashboard | 5–8 人日 | 生态位空窗期有限 | **前置：indexer 正确性修复** |

---

## E-10 · 证据可信度（**所有生态工作的 P0 前置**）

当前有一组**「安全声明强度 > 证据强度」**的缺口，会在 Segment 1（钱包厂商尽调）与 Segment 3（机构合规）两个最高价值段直接暴露：

| 缺口 | 位置 | 后果 |
|---|---|---|
| **5/11 Halmos 规格恒真** | `HalmosAuth.t.sol:85` 传 3 参数调 4 参数函数 + 无时钟约束 | 恰好是重放/nonce/过期/denylist/窗口这五个核心授权属性 |
| Echidna 4 属性中 2 个恒真 + skm 零注资 | `EchidnaProperties.t.sol` | 涉 value 路径零覆盖；另两属性靠"不暴露 handler"与硬编码常量 |
| invariant ghost 三处自污染 | `SessionKeyManager.invariant.t.sol:221-235` | INV-1 断言被 owner 大 cap grant 永久放宽 |
| MCP `db` 无根目录约束 | `mcp/src/server.ts:198-206` | "合规模块"叙事下**不可接受的攻击面** |
| `docs/STATUS.md` 过期 | 自称权威索引但落后 2 周+、错 vault 文件数 | 文档体系信任锚断裂 |
| `README.md:20` 措辞 | "Implemented + formally verified" 与白皮书 pre-audit 警告直接矛盾 | 最容易被第三方抓到的自相矛盾 |

**这不是"技术债清理"，这是定价前提。** 所有高价值段的成交条件都是"你们的验证是真的"。在 MVP 定义里，这批修复的优先级**高于任何 adapter、dashboard 或标准提案**。

**实施顺序（按杠杆）**：
1. 修 Halmos arity + 加"首次执行必须 ok==true"元测试（防同类复发）— 1 人日
2. Echidna harness 注资 + 两个恒真属性重写 — 1–2 人日
3. MCP `db` 路径约束到工作区根目录（fail-closed）— 0.5 人日
4. `docs/STATUS.md` 重建（先跑一次完整 inventory 再写）— 0.5 人日
5. `README.md:20` 措辞对齐白皮书 pre-audit 口径 — 0.5 人日
6. 外部审计（在 1–5 之后 booking，**避免为已知缺陷付费**）

**风险**：修复会暴露更多真实缺陷（尤其 Halmos 重新真跑后可能立刻红），需预留 2–3 天缓冲并接受生态任务顺延。

---

## E-07 · 定位修正（go-to-market）

**新定位一句话**：

> SigilKit 是 agent 钱包的运行时约束与审计证据层：跨钱包签名一致性 + 每次调用强制审计 + 形式化验证的策略核心。

**三段式 GTM，按「证据成熟度」而非「功能丰富度」推进**：

| Segment | 对象 | 卖点 | 证据 | 特点 |
|---|---|---|---|---|
| **1** | 钱包/账户集成方（Safe / Kernel / 托管钱包厂商） | "给你们的账户加 policy + audit，不用 fork" | 兼容矩阵 + 审计报告 | **最快付费意愿** |
| **2** | Agent 框架构建者（Coinbase AgentKit / ElizaOS / LangChain-MCP 系） | "MCP 四个工具 → 合规的 bounded autonomy" | SDK + MCP + 示例矩阵 | **最大数量** |
| **3** | 机构/受监管实体 | "向审计方出示运行时约束 + 逐调用轨迹" | MAS SAFR / Korea FSC 叙事 + 证据格式 | **最慢、最高价** |

**三段式的意义**：先用低门槛的 Segment 1/2 拿到真实使用与反馈，再用 Segment 3 的高价覆盖兑现。**当前直接冲机构会被 pre-audit 状态挡回来。**

**必须做的定位修正**：
- 停止说 "standard library nobody built"（`vault/Competitive Landscape.md:3` 已证伪）→ 改说 "the bundle nobody ships"
- 停止说 "formally verified" 直到 E-10 的闸门通过
- 停止说 "globally relevant / no KYC"（v2.1 白皮书已改，但 vault 文档需对齐）

**风险**：① 过度依赖 TAM 数字（`docs/RESEARCH-NUMBERS.md:23-27` 自己标了 "projections, not current revenue"）会被懂行买方质疑；② 定位摇摆（既想做 infra 又想做 app）；③ 合规叙事若无审计背书 = 空头支票。

**工时**：2–3 人日（Week 3 内）。**低成本、高优先级。**

---

## E-05 · 开发者生态（**先修分发通道，再谈模板市场**）

生态的第一性问题不是"demo 太少"，而是**装不上**。

**优先级**：
1. **解决分发身份**：`@sigilkit` scope 被无关项目占据（README:120-126），仓库 URL 在两处有两个规范值 → **这是所有生态工作的总闸门**
2. **示例仓库矩阵**（不是 plugin 市场）：每个示例必须可独立 clone、可跑、且验证"未签名不会成功"的负例。目标 5 个：Aave repay、B+Uniswap withdraw、Safe 7579、Kernel 7579、7702 EOA
3. **MCP 作为分发面**：已有 4 工具，按 Week 3 计划扩到 grant 工具 → **MCP 是当下 agent 框架最低摩擦的接入面，优先级高于 CLI**
4. **模板市场推迟**：模板 = leaf v3 + 策略包的副产品，没有 v3 就没有可交易的模板。先建 GitHub Discussions 标签，不建 registry

**工时**：身份决策 1–2 人日 + 白皮书清理 0.5 人日 + 示例矩阵 2.5–3 人周。

---

## E-01 · 钱包生态位置：**做「可选增强模块」，不做钱包内置**

**建议**：双轨制，但明确主次——
- **主轨（90% 投入）**：ERC-7579 validation + executor 模块，插进 Safe{Core} / Kernel / RhinoStone。SigilKit 是**钱包的可选增强模块**，钱包厂商不需要改代码就能提供 SigilKit 的 policy+audit 能力
- **次轨（10% 投入）**：`SigilKitDelegator` 7702 路径只作为"给自建/托管钱包厂商的参考实现 + 一致性基准"，不做面向终端用户的钱包产品

**依据**：`vault/Competitive Landscape.md:17`（RhinoStone ModuleKit 是"the modular-account standard library SigilKit should build **on**, not against"）；`contracts/src/SessionKey7579Module.sol:115-117`（`isModuleType(1)`）+ `ActionLog7579Executor.sol:42-44`（`isModuleType(6)`）已经是纯插槽式接口。

**实施**：
1. 冻结模块 ABI 版本号，出 `COMPAT-<account>-<version>.md`（每账户一条完整 install→grant→execute→audit→revoke→uninstall 路径）
2. 提 erc7579.com registry 条目（module type / policy types / **诚实的 pre-audit 状态**）
3. 7702 路径只保留 conformance harness 用途，不投入钱包 UX

**风险**：① 钱包厂商自建同类模块（MetaMask Agent Wallet 的 Guard Mode / 每日限额 / 协议白名单已存在）；② ERC-7579 仍是 Draft，模块兼容面会 churn；③ 审计方会先打 4337 六项检查。

---

## E-06 · 标准化提案：**先做 registry 条目与语义收敛，不要抢 ERC 名**

**三步、按收益排序**：
1. **ERC-7579 registry + module 语义提案**（最高价值）：把 SigilKit 的 module type 语义（VALIDATION=1 / EXECUTOR=6、policy 字段、proof 编码格式）作为**模块实现规范**提交，目标是成为 7579 生态的"policy module 参考实现"。顺带把"审计要求（validator 不得 emit、执行审计必须走 executor）"写成模块一致性规则
2. **agent 审计事件 → 先做数据格式，不做事件名**：`ActionLogged` 保持自有事件，但把导出格式对齐 ERC-8004 的 agent identity 表达 → 提案内容应是"审计事件的最小字段集 + 幂等键"，不是新事件
3. **ERC 提案推迟**：在 ethresear.ch 发 Pre-EIP 讨论，积累 2–3 个外部实现后再考虑正式 ERC

**工时**：规范文档 3–4 人日 + registry 条目 0.5 人日。**Week 3 只做第 1 步。**

---

## E-03 · 托管与合规：**做「可选策略签发层」，不做 KYC 本身**

**建议**：不出 KYC 产品，出**机构可选模块**：
- **scope 签发工作流**：KYC/AML 结果 → 风控引擎 → 限额策略模板 → 链上 `Scope`。KYC 全在链外，SigilKit 只接收"已判定"的结果并把它编译成 grant 规格
- **限额策略模板库**：预置档位（个人 / 交易台 / 托管账户 / 受监管 SPV），每档给 `perActionCap`/`perWindowCap`/`windowSeconds`/`countersignAbove`/`tokenWatchlist` 推荐值 + 审批链（2-of-3 Safe 作为 owner）
- **明确对外措辞**：**integrator owns compliance**，SigilKit 是 non-custodial developer tooling

**关键限制必须在销售材料里说清楚**：`tokenWatchlist` 是**净减少校验**（E11），**不是价值上限** —— 这一点若不提前澄清，会在客户实测时变成信任危机。

**风险**：① 被误认为 CASP/提供合规服务（法务风险）；② 限额模板给错档位会造成真实资金损失（责任归属合同层划清）；③ 非标准代币回退为 0 会让模板产生虚假安全感。

---

## E-02 · DeFi adapters：**先做 leaf v3 字段级绑定，再做协议 adapter**

**当前阻塞**：leaf 只有两档——pinned（`argsHash = keccak(data)`）与 wildcard（`argsHash = 0`），而 `withdraw/repay/swapExactTokensForTokens` 这类 calldata 几乎必带动态字段（receiver、assets、shares、amountOutMin、deadline…）。**pinned leaf 生成的 root 一次就作废，wildcard leaf 等于把白名单退化成"选器允许"。**

**顺序**：
1. **leaf v3：字段级绑定**（field-mask / 规范化 argsHash — 把指定 ABI 槽位固定、其余字段归一化或留给运行时约束）
2. 基于 v3 写协议 adapter，每个产出「参数化白名单模板」而非一次性 root
3. 附带"风险面分级器"：`withdraw/repay`（降敞口）默认走 wildcard + `countersignAbove` + `tokenWatchlist`；`swap/borrow`（升敞口）强制 pinned + delta 校验

**商业价值**：这是**唯一能把"不可见的策略配置"变成"可交付产品"**的一层。集成方不需要理解 leaf 哈希，只需要说"我要 Aave repaying-USDC、receiver 是我、amount ≤ X"，SigilKit 产出可审计的 grant 规格。

**工时**：~5–6 人周 + 外部审计追加。**应排在审计 booking 之后。**

---

## E-04 · 保险：**做，但必须重定义承保触发条件**

**SigilKit 的链上 caps 让"超范围使用"在协议层就 revert，所以保险不可能覆盖"超范围"**——那正是产品承诺已消除的场景。可承保的是**误配置导致的敞口**：owner 签发了 wildcard leaf、限额档位设错、adapter 模板指向攻击者可控地址。

**前提条件（缺一不可）**：
1. **可信事件源**：`ActionLogged` 的 `agentId` 目前是 account 自述（`ActionLog7579Executor.sol:63-71` 明确写"not a third-party attestation"），承保必须有第三方见证/预言机或时间戳证明
2. **可归因的策略版本**：leaf v3 落地后 grant 才有可寻址的 `policyId`
3. **通过外部审计 + 真实资金规模**（无审计和 TVL，承保方不会来）
4. **独立损失评估**：indexer 的对账能力需先解决 reorg/receipt 缺陷

**实施**：阶段 A（现在，零成本）把"配置错误"作为文档里的一等公民（`SECURITY.md` 增加"本设计不防什么"清单 + grant 规格导出格式）；阶段 C 与项目方谈，**SigilKit 不承保、只供证**。

**风险**：① **在 pre-audit 状态下宣传保险 = 最严重的信任事故**；② 归因链条依赖自述 agentId，证据强度不足会被承保方直接否；③ 误配置与被盗在链上往往不可区分。

---

## E-08 · 合作/集成清单与优先级

| 优先级 | 对象 | 动作 | 成本 |
|---|---|---|---|
| **P0** | 自身 npm scope / 仓库身份 | 决策 + 对齐 + 清理 v2.0 白皮书 | 1.5 人日 |
| **P0** | 外部审计（Cantina/Sherlock + 私有档） | Week 1 booking，Arbitrum 补贴 | $20k–$120k / 2–3 月 |
| **P0** | Safe{Core} + Kernel | 7579 兼容矩阵 | 5–10 人日 |
| **P0** | erc7579.com registry | 模块条目提交 | 0.5 人日 |
| **P1** | Rhinestone（ModuleKit / Nexus / Registry） | 在其 registry/SDK 体系内落地 module | 3–5 人日 |
| **P1** | Aave v3 / Compound v3 / Uniswap v3 | 协议 adapter + 参数化模板（**依赖 leaf v3**） | 9–15 人日 |
| **P1** | Coinbase AgentKit / MCP 系框架 | MCP 工具扩到 7 个 + 官方接入示例 | 3–4 人日 |
| **P1** | MetaMask / Coinbase Wallet | 维持每周 conformance canary，不追 UI 集成 | 0.5 人日/周 |
| **P2** | Biconomy Smart Sessions / DAN | 差异化叙事对标（最直接竞品） | 1 人日（文档） |
| **P2** | ZeroDev Kernel / Safe Agent Kit | 兼容矩阵扩项 | 2–3 人日/家 |
| **P2** | 公共采用度 dashboard | 占住"无人做的生态位" | 5–8 人日 |
| **P3** | EF / Arbitrum / RetroPGF | 审计后 + 有 traction 后再申请 | 申请文书 |

**明确不做**：自建 bundler/paymaster（`vault/Risk & De-risk Plan.md:9` 已判 deferrable）；自建钱包 App；KYC 服务；token 价值预言机定价（Scope 的 caps 是 wei/native 语义，引入价格源会把核心合约变成依赖外部预言机的审计噩梦）。

---

## E-09 · 公共「session-key / module 采用度」dashboard

**这是研究里明确点出、且当前无人占的生态位**（`docs/ECOSYSTEM-RESEARCH-2026-09-23.md:48`：**No session-key/module-usage-specific dashboard exists**）。它同时是营销资产、采用度证据和 grant 申请材料。

**实施**：
1. 把 indexer 事件 schema 扩到能识别 7579 `ScopeGranted`/`ScopeRevoked`/`SelectorDenylistSet` 而不只 `ActionLogged`（**从"查自己的数据"到"查生态数据"的关键一步**）
2. Dune dashboard 先行（零运维成本），自建只读站后置
3. 只收公开链上事件，不收客户数据——保持 MIT/非托管叙事

**风险**：**必须先修 indexer 缺陷**（reorg 孤儿行、无事务 migrate、索引与默认查询不匹配）——**把有 bug 的聚合数据公开发布是负资产**。

---

## 生态路线图

| 阶段 | 内容 | 关键产出 |
|---|---|---|
| **Week 1（P0 前置）** | E-10（证据可信度 6 步） | 定价前提成立；Halmos 真跑；MCP 路径约束 |
| **Week 2** | E-07（定位）+ E-05（分发身份） | 规范 URL 统一；白皮书横幅；scope 决策 |
| **Week 3** | E-01（兼容矩阵）+ E-06（registry） | `COMPAT-*.md`；erc7579.com 条目 |
| **Week 4** | E-03（限额模板）+ 审计 booking | 机构叙事有据；外部审计启动 |
| **Post-audit** | E-02（leaf v3 + adapters）+ E-04（保险） | 可交付产品层；承保谈判 |
| **持续** | E-09（dashboard） | 生态公共品 + grant 材料 |

---

---|---|---|
| **Week 1（P0 前置）** | E-10（证据可信度 6 步） | 定价前提成立；Halmos 真跑；MCP 路径约束 |
| **Week 2** | E-07（定位）+ E-05（分发身份） | 规范 URL 统一；白皮书横幅；scope 决策 |
| **Week 3** | E-01（兼容矩阵）+ E-06（registry） | `COMPAT-*.md`；erc7579.com 条目 |
| **Week 4** | E-03（限额模板）+ 审计 booking | 机构叙事有据；外部审计启动 |
| **Post-audit** | E-02（leaf v3 + adapters）+ E-04（保险） | 可交付产品层；承保谈判 |
| **持续** | E-09（dashboard） | 生态公共品 + grant 材料 |

---

## 一句话给决策者

**SigilKit 现在缺的不是生态位，是可信度证据 + 可安装性。** 这两样在 30 天内可修；DeFi adapter、标准化提案、保险都应排在它们之后。E-10 的 3.5 人日是整个生态分部投入产出比最高的一笔。
