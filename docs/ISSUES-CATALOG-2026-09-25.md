# SigilKit — Issues & Required Fixes 目录

> **日期**：2026-09-25 · **基线**：`review-integration-20260917` 工作区（204 文件 / 34,163 行）
> **方法**：25 个并行只读分析 agent，每条问题独立复核 file:line；性能项标注「实测 / 静态推算」
> **范围**：`contracts/`（7 合约 + 17 测试）、`packages/`（4 包 63 源文件）、`scripts/`（20）、`.github/workflows/`（14 job）、`docs/`+`vault/`（45）
> **排除**：`node_modules`、`outputs`、`out`、`cache`、MetaMask 扩展包、`lib/forge-std`、`broadcast`、`*/dist`、`*/coverage`

---

## 0. 执行摘要

| 类别 | 条目 | Critical | High | Medium | Low | 合计工时 |
|---|---|---|---|---|---|---|
| **A 安全漏洞** | 18 | 2 | 5 | 9 | 2 | 17.5–21.5 d |
| **B 软件缺陷** | 28 | — | 3 | 15 | 10 | 20–26 d |
| **C 性能瓶颈** | 16 | — | 1 | 6 | 9 | 5.5–48 d |
| **D 质量与技术债** | 26 | — | 1 | 9 | 16 | 15–22 d |
| **E 架构问题** | 12 | — | 6 | 4 | 2 | 22.5 d |
| **合计** | **100** | **2** | **16** | **43** | **39** | **80–140 人日** |

### 四条最紧急（P0，必须本周闭环）

| # | 问题 | 位置 | 为什么最急 |
|---|---|---|---|
| 1 | **Halmos 认证路径符号验证 5/11 规格恒真** | `HalmosAuth.t.sol:85` | 传 3 参数调 4 参数函数 → ABI 解码永远失败 → `if(first)` 永不进入 → 重放/nonce/过期/denylist/窗口这 5 条**核心授权属性**全部空转。这与 `SessionKeyManager.t.sol:303-311` 注释里已记录的 SEC-5 是**同一类缺陷的第二次重演** |
| 2 | **Echidna 4 属性中 2 个恒真 + skm 零注资** | `EchidnaProperties.t.sol` | 构造函数从未 `vm.deal` → 所有 `value>0` 执行因余额不足 revert；另 2 个属性靠"不暴露 handler"与硬编码常量返回 true。`echidna-nightly` 绿灯无信息量 |
| 3 | **MCP `audit_query` 的 `db` 参数无路径约束** | `mcp/src/server.ts:189-206` | 模型可让服务打开进程可读的任何 SQLite；`existsSync` + 差异化错误构成**文件存在性预言机**。MCP 是 agent-native 定位的主入口，prompt-injection 可直达 |
| 4 | **invariant ghost 三处自污染** | `SessionKeyManager.invariant.t.sol:221-235` | `_syncScopeGhost` 从合约回读（使 INV-4 退化为 `x==x`）；`ghostMaxPerWindowCap` 单调抬高（owner 一次大 cap grant 即永久放宽 INV-1）；`expectedWindowSpend` 是死 ghost（被写、无人读） |

### 三个被实测推翻的怀疑

| 怀疑 | 结论 | 证据 |
|---|---|---|
| `withdraw` 可被重入重复提取 | **推翻**。`onlyOwner` + 不写状态 + 余额硬约束 | 缺失修饰符属实但不可利用，降级 Low（SEC-16） |
| Foundry fuzz 层为空（`fuzz.runs` 无消费者） | **推翻**。116 个 `test_*` 中**带参数的有 3 个**（`Halmos.t.sol` 的 6 个 `check_`），且 `foundry.toml:23-39` 三档 profile 配置正确 | 我最初的全仓统计把 `check_` 误判为非 fuzz |
| 向量文件（`vectors/`）为空 | **推翻**。3 份 json 均存在且被 `GoldenVectors.t.sol` + `vectors.test.ts` 双侧消费 | 初始清单截断导致误判 |

---

## A. 安全漏洞（18 条）

### SEC-01 · 额度只计原生币，ERC-20 可零成本抽干 `Critical` CVSS 7.5
**位置**：`SessionKeyManager.sol:339-341`（计费）、`:415-424`（快照早退）、`:429-445`（校验）、`:113`（`MAX_WATCHED_TOKENS=8`）

**攻击场景**：owner 授予 `perActionCap=1 ether`、`merkleRoot=0x0`、`enforceNativeDelta=false`。被攻陷 agent 用 `value=0` 调 `transfer(attacker, type(uint256).max)` → `enforce` 记 `spent += 0` → `_snapshotBalances:416` 因 `enforceNativeDelta=false` 直接返回零值快照 → 代币全额转出 → `ActionLogged(value=0)` 审计显示"零支出"。

**实际 vs 预期**：实际 scope 对 ERC-20 持仓事实上是无限的；"spend cap"核心卖点在代币资产上不成立。预期：E11 开启时代币流出受 `tokenWatchlist` 约束。

**修复**：`Scope` 增 `bool capAppliesToTokens`；`merkleRoot==0` 时**强制** `enforceNativeDelta=true`；`_erc20BalanceOf:575-580` 失败时不得读作 0（当前失败=0=余额不降=检查失效），应 `revert`；`MAX_WATCHED_TOKENS` 在 allow-all 场景提升或改为按 selector 声明流出额。

**工时** 3–4 d · **依赖** 无 · **时间线** 立即，发布前必须闭环

---

### SEC-02 · `.codebuddy/models.json` 六个明文 apiKey 在 Git 历史中，且团队对事实存分歧 `Critical` CVSS 7.5
**位置**：`docs/AC-01-SCRUB-PLAN.md:3,9,42`、`docs/Issues-Catalog-2026-09-21-Agent-Review.md:26-27`

**事实分歧（必须先查清）**：09-21 目录断言"Currently gitignored…**so not in git history**"，与 AC-01 计划（`:9` 承认曾被提交）与 PROJECT-MAP（`:113`）直接冲突。**在事实查清前执行 `filter-repo` 或对外声明"已清理"，都可能是错的**。

**修复顺序**：① **先轮换**（6 个 apiKey + AC-05 RPC token 全量吊销重发，验证旧值 401）；② 跑 `AC-01-SCRUB-PLAN.md` Step 0 的 `gitleaks detect --report-format json` 并把报告作为工件留存，消除分歧；③ 修正 09-21 目录的错误结论；④ `.gitleaks.toml` 增 `apiKey` 字段通用规则（当前仅 allowlist 两个 Anvil 公钥）。

**工时** 1.5 d（轮换 1 h 外部控制台 + 清单核查 0.5 d + 改写历史 0.5 d + 协同通知 0.5 d）· **依赖** 外部账号权限；force-push 需全员停推 · **时间线** **立即 Day 0–1**

---

### SEC-03 · MCP `build_scope` 只能生成通配叶，参数绑定防御结构性不可达 `High` CVSS 7.5
**位置**：`mcp/src/server.ts:156`（`targetLeaf(t.target, t.selector)` 第三参恒 `undefined`）、`:153`（`targets` 空 → `ZERO_ROOT`）

**攻击**：owner 或被 prompt-injection 的模型调 `build_scope({targets:[{target: USDC, selector:"0xa9059cbb"}]})` → 生成通配叶 `keccak(target, selector, bytes32(0))` → agent 可用同一 selector + **任意 calldata**（任意收款人、任意金额）执行，`value=0` → 结合 SEC-01，USDC 全额抽走且计费为 0。

**修复**：`targets[].items.properties` 增 `data: {type:"string"}` 并传 `targetLeaf(target, selector, data)`；`targets` 缺失/为空时**抛 ValidationError**（删除 `ZERO_ROOT` 分支），allow-all 仅在显式 `allowAllTargets: true` 时允许；`targets.length` 上限 256；返回值加 `leafKind: "pinned"|"wildcard"`。

**工时** 0.5 d · **依赖** 无 · **时间线** Week 1 P1

---

### SEC-04 · MCP `audit_query` 任意路径只读打开，构成文件系统探测预言机 `High` CVSS 6.5
**位置**：`mcp/src/server.ts:189`（schema 主动暴露 `db` 自由文本）、`:198-206`、`:200`（`existsSync`）、`:218-219`

**攻击**：MCP server 由 agent 框架以 stdio 拉起，**tool schema 连同 `db` 的自由文本描述一起进入模型上下文** —— 现成的 prompt-injection 落点。模型调 `audit_query{db:"C:\\Users\\<user>\\.ssh\\id_rsa", query:"summary"}` → `existsSync` 命中则继续 → `DatabaseSync` 抛错 → 错误经 `:280` 原样回灌给模型，而**三种结局可区分**（不存在 / 存在但非 SQLite / 存在且是库）→ 逐字节探测用户文件存在性与类型。Windows 上追加 `\\.\pipe\<name>` 或 UNC 路径可命中命名管道/网络共享。

**实际 vs 预期**：MCP 层零路径约束（对比 indexer CLI `:107` 对 `--manager` 有正则、`:177` 有 `existsSync` 提示）。预期：`db` 只能落在运维预配置的审计根目录内。

**修复**：新增 `SIGILKIT_AUDIT_DB_ROOT`；`path.resolve` + `fs.realpathSync.native` 归一后校验 `startsWith(root + sep)`；拒绝 `\\`、`//`、`\\.\`、UNC、`.db` 以外的扩展名；合并 `:200` 与 `:206` 的错误为统一文案消除类型预言机；删除 `existsSync`（realpath 已覆盖）。

**工时** 0.5–1 d · **依赖** 需确定部署形态（容器 `/data` vs 本地），两者可用同一 root 约束 · **时间线** Week 1 P1

---

### SEC-05 · 7579 路径缺少 E11 代币保护，Module 与 Manager 能力严重不对等 `High` CVSS 7.5
**位置**：`SessionKey7579Module.sol:65-71`（Scope 无 E10/E11 三字段）、`:249-261`、`:263-300`、`ActionLog7579Executor.sol:104-127`（`execute` 除锁与事件外**零校验**）、`:126`（`rationaleHash` 硬编码 `bytes32(0)`）

**攻击**：账户同时装 validator + executor。session key 提交 `ExecTuple{target: token, data: transfer(attacker, max), value: 0}` → `_enforceSingle:258-260` 用 `value=0` 计费 → executor `:119` 直接 `target.call` 转发无额度/白名单/流出复核 → 代币抽走，链上只留 `WindowCharged(value=0)` 与 `ActionLogged(value=0, rationaleHash=0)`。

**修复**：① 7579 `Scope` 对齐 Manager 增 `enforceNativeDelta`/`tokenWatchlist`/`countersignAbove`；② **`ActionLog7579Executor` 增 `isValidatorInstalled(account)` 前置检查**（`SessionKey7579Module.isInitialized`），未装 validator 时 `execute` 直接 revert —— 把 AC-24 的"文档信任契约"变成**链上 fail-closed**；③ `rationaleHash` 从 callData 派生或经 validator 传入；④ 模块组合矩阵测试（validator×executor 4 种组合）。

**工时** 4–5 d · **依赖** SK-03/SK-04 闭环 · **时间线** Pre-mainnet P1

---

### SEC-06 · 演示/舰队拓扑中 owner 私钥与 agent 私钥同进程共存 `High` CVSS 6.6
**位置**：`demo-agent/src/agent.ts:69`（`relayer = privateKeyToAccount(config.ownerPrivateKey)`）、`:83`、`:107-115`；`fleet.ts:32-33`；`cli.ts:147,155-156`

**攻击**：agent 进程被攻陷（模型供应链、依赖投毒、prompt-injection 触发 RCE）→ 读取 `config.ownerPrivateKey` 或直接复用 `this.relayer` → 调 `withdraw(to, balance)` 一次性转走全部资金。`agent.ts:9` 与 README 的"blast radius = granted scope"在此拓扑下**不成立**。

**修复**：`TreasuryAgentConfig` 移除 `ownerPrivateKey`；`grantScope` 改为接收外部已构造的签名/已发送的交易哈希，agent 进程内**永不**实例化 owner account；`fleet.ts` 同样移除；README 增加显式警告"demo 拓扑不适用于生产"；启动时若 `SIGILKIT_RPC_URL` 非 loopback 且用 Anvil 默认 key 则**拒绝启动**（把 `devkeys.ts:16` 的注释提示升级为可执行约束）。

**工时** 1 d · **依赖** 无 · **时间线** Week 1 P1

---

### SEC-07 · CI 从未固定引用的 `main` 分支管道执行远程脚本（供应链 RCE） `High` CVSS 8.1
**位置**：`.github/workflows/ci.yml:60`（`bash <(curl -sSf https://raw.githubusercontent.com/rhysd/actionlint/**main**/scripts/download-actionlint.bash)`）

**攻击**：上游 `main` 被投毒 → SigilKit 在**每次 PR 与 push** 时 `curl` 并直接 `bash` 执行，**无 tag/SHA 固定、无 sha256 校验** → 该 job 已 `npm ci` 并持有 `GITHUB_TOKEN`，可读取仓库、污染缓存/工件。**同文件内两种标准并存**：MetaMask zip 已固定 `v13.49.0` + sha256（`:301-303`），gitleaks 已固定 + 校验（`install-gitleaks.sh:9-14`）—— 修复范式已在仓内，actionlint 是唯一遗漏。

**修复**：纳入 `scripts/install-actionlint.sh`（与 `install-gitleaks.sh` 同构：版本 + SHA256 校验）；全部 `uses:` 改钉 40 位 commit SHA + 行尾注释人类可读版本，Dependabot 已配 `github-actions` ecosystem 会自动提 PR；补 `permissions: contents: read` 顶层默认。

**工时** 0.5 d · **依赖** 无 · **时间线** Week 1 P1（CI 首次真实执行前完成，见 AC-28）

---

### SEC-08 · Halmos 认证路径符号验证套件因参数个数错误整体失效（假绿） `Medium` CVSS 5.3
**位置**：`contracts/test/HalmosAuth.t.sol:85` vs `SessionKeyManager.sol:276-281`

> 已独立复核确认，见 §0 执行摘要 #1。这是本目录的 P0 #1 项。

**修复**：`:85` 追加第 4 参 `bytes("")`；加**元测试**断言至少一条属性路径必须观测到 `ok==true`（防止全 false 的假绿模式复发）；更稳健：改用强类型封装 `SigilKitManager(address(skm)).executeWithSessionKey(req, sig, proof, approval)` 让编译器强制参数匹配。

**工时** 1 h · **依赖** 无 · **时间线** Week 1 P1（**先于**任何"符号验证已覆盖认证路径"的对外声明修正）

---

### SEC-08b · Halmos 把 `block.timestamp` 当自由符号变量，5 个 check 可被平凡满足 `High`
**位置**：`HalmosAuth.t.sol:57`（`setUp` 授予 `expiresAt = GRANTED_AT + 1 days`）、`:92-149`（5 个 `check_execute_*`）

**机制**（比 SEC-08 更深一层）：即使修好 arity，Halmos 仍可取 `block.timestamp > expiresAt`，使所有执行因 scope 过期而 revert，于是 `check_execute_WindowSpendNeverExceedsCap` 的 `assertLe(spentThisWindow, 2 ether)` **恒为 `0 <= 2 ether`**。叠加 `_recover` 被 `SeamManager` 覆写为固定地址，签名层被完全 stub。

**实际证明的内容**：不是"replay/nonce/denylist/窗口上限"，而是"**过期时一切 revert**"。

**修复**：`setUp` 后加 `vm.assume(block.timestamp < expiresAt)` 或在每个 check 开头断言时钟在有效期内；`check_execute_Replay_` 的 `if (first) { assertFalse(second) }` 是 **vacuous branch**（首调失败即跳过整条断言），必须改为无条件断言 replay 必 revert。

**工时** 0.5 d · **依赖** SEC-08 · **时间线** Week 1 P1

---

### SEC-09 · 已签名请求可被任意第三方单方面强制执行（无 relayer 绑定） `Medium` CVSS 7.5
**位置**：`SessionKeyManager.sol:264-266`（"Permissionless to call (anyone may relay)"）、`:276-281`；`core/src/client.ts:549-560`

**攻击**：SDK 生成签名请求后（本地 pre-flight `:541-543` 与 lease fence `:547` 都已通过），calldata 一旦离开进程（mempool、日志、第三方 relayer 池），任何地址可直接调用 —— 授权完全来自签名，无 relayer 白名单。攻击者抢在 operator 前广播。严格顺序 nonce 使这是**插入而非阻断**。

**修复**：`ActionRequest` 增 `address executor`（`address(0)` 表示任意人），纳入 `_ACTION_REQUEST_TYPEHASH` 并在 `:301` 前校验。**这是破坏性 ABI 变更**（typehash 改变 → 所有既有签名失效），须版本化（`executeWithSessionKeyV2` 或提升 domain `version`）。短期缓解（无 ABI 变更）：提供 `signOnly`/`relayLater` API 并在文档明示"签名即最终授权"。

**工时** 短缓解 2 h / 完整修复 2 d · **依赖** SEC-01 · **时间线** Pre-mainnet P2

---

### SEC-10 · 轮换重置新 key 的窗口计数，`perWindowCap` 可被跨轮换反复刷新 `Medium` CVSS 4.9
**位置**：`SessionKeyManager.sol:213-237`（`_grant`）、`:221-223`（写新 scope，**未触碰 `windows[newKey]`**）

**攻击**：session key 用满 `perWindowCap` → 调 `rotateSessionKey(oldKey, newKey, ...)` → `:221` 写新 scope，`:222` 清 revoked；`windows[newKey]` 是**从未使用的零值槽** → 窗口检查从 0 起算 → 新 key 立即获完整预算 → 可重复"用尽 → 轮换 → 再用尽"。**对称地**，`grantSessionKey` 覆盖同一 key（`:176`）**不**重置 `windows[key]` —— 所以同一 key 与不同 key 行为不一致。

**修复**：`_grant` 中当 `newKey != oldKey` 时显式结转 `s.windows[newKey] = s.windows[oldKey]`（或按 operator 选项）；若确定"轮换即重置"为有意设计，须在 NatSpec 显式记录并说明对运营预算模型的影响；加不变量测试。

**工时** 0.5 d · **依赖** 与 SEC-06 强耦合 · **时间线** Week 2 P2

**状态（2026-10-01 文档真实性审计补录）**：**已按 Option B 关闭 —— 原文保留，勿再当作未决缺陷引用。**
本条目写于 2026-09-25。`docs/CI-WAIVERS.md`（L2 记录）自述的 SEC-10 关闭日期为 **2026-09-28**，
**晚于本文件三天，其记载取代本条目的前提**：
- `SessionKeyManager._grant`（`contracts/src/SessionKeyManager.sol:412-453`）**从不写**
  `windows`，因此轮换在新 key 上开启全新窗口、同 key 重新授权保留已计费窗口 —— 这正是
  operator 裁定的 **Option B** 语义，已写入 `SpendPolicy` 的 NatSpec（"INV-1 scope" 子句）。
- `contracts/test/Sec10WindowRotation.t.sol` 现含 6 个测试（5 个 `test_Characterization_*` +
  `test_Sec10_LineageWindowCap`）；CI-WAIVERS 记录 2026-09-28 的 `forge test` 结果为
  「6 passed; 0 failed; 0 skipped」。
- CI-WAIVERS 同时注明：「The prior "intentionally failing" claim was never re-executed before
  it was written down」—— 此前流传的「故意红」说法本身从未复跑。
因此上面「**修复**」小节建议的 Option A（结转 `windows[oldKey]` → `windows[newKey]`）**未被采纳**，
「**时间线** Week 2 P2」也已完成；残余问题被 CI-WAIVERS 归类为 **owner 侧配置属性 / 运营约束**，
不是可被 agent 触达的绕过，不再按 Medium / CVSS 4.9 计。**原文按审计规则保留，不删除、不改写。**
> **Unverified as of 2026-10-01：** 本次审计**无法运行 `forge test`**，上述 6 passed 与
> `_grant` 行号均为转引自 `docs/CI-WAIVERS.md` 的记录，**不是本次实测**。重新断言 SEC-10 状态前
> 请先在装有 Foundry 的机器上复跑 `forge test --match-path
> "contracts/test/Sec10WindowRotation.t.sol"`。

---

### SEC-11 · ERC-1271 回退接受"高位对齐"magic value `Medium` CVSS 6.5
**位置**：`SessionKeyManager.sol:537`（`|| bytes4(ret) == bytes4(0x1626ba7e)`）

**攻击**：owner 误将非标准"签名服务合约"授予 scope。该合约的 `isValidSignature` 返回 32 字节，**高 4 字节**为 magic、低 28 字节任意 → `:537` 第二分支命中 → 接受该"签名"，而该合约从未真正验证过 EIP-712 digest。

**修复**：`:537` 删除右对齐分支，或限制为 `ret.length == 4`（非标准裸 bytes4）；补 `ERC1271Keys.t.sol` 用例：构造返回高位 magic + 垃圾低字节的 mock，断言**必须** revert。

**工时** 0.5 d · **依赖** 无 · **时间线** Week 2 P2

---

### SEC-12 · 日志层无脱敏，RPC 供应商密钥与绝对路径可进入日志 `Medium` CVSS 5.3
**位置**：`core/src/logger.ts:77-81`（`serialize` 原样透传）、`:112-117`（`formatJson` **写入 `err.stack`**）、`:99-110`

**攻击**：运维把 `SIGILKIT_RPC_URL` 设为带供应商密钥的 URL（Alchemy/Infura 惯例：路径末段即密钥），`config.ts:160` 接受任意 http(s)。RPC 抖动 → viem 抛错 → `client.ts:526` 把 `err.message`、JSON 下 `indexer.ts:690` 还附 `err.stack` → viem 的连接错误消息通常含完整请求 URL → **API key 明文进日志**。`err.stack` 含 `D:\SigilKit\packages\...` 绝对路径。

**实际 vs 预期**：`assertPrivateKey`（`validation.ts:82-89`）对私钥有 `redacted` 处理，`assertUrl` 也 withheld —— 项目已认识脱敏需求，但**脱敏只存在于入参校验层，日志输出层完全没有**。这是架构性缺陷：任何新增的 `log.warn({...})` 都会默认泄露。

**修复**：字段名黑名单（`/(key|secret|token|password|mnemonic|authorization|apikey|db|rpc)/i`）+ 值级启发式（32 字节 hex、私钥格式、URL 的 path/query）；`formatJson:116` 移除 `stack`，仅 debug 级别附加；`serialize` 递归处理嵌套（当前 `:80` 直接 `return value`）；`logger.test.ts` 用例断言输出不含明文。

**工时** 0.5 d · **依赖** 无 · **时间线** Week 2 P2

---

### SEC-13 · MCP 无输入长度上限 + per-call 句柄开关 → 进程级 DoS `Medium` CVSS 7.5
**位置**：`mcp/src/server.ts:296`（`createInterface({input})` **未设行长上限**）、`:309-322`（整行 `JSON.parse`）、`:206`（每次 `audit_query` 新建 `SigilIndexer`）、`:218-219`（`finally { ix.close() }`）

**攻击**：① **内存耗尽**：发单行 500 MB JSON → readline 无上限缓冲 → `JSON.parse` 构建完整对象树 → OOM。② **句柄/锁耗尽**：高频调 `audit_query`（同一 Windows 文件）→ 每次开关同一文件 → 退化为锁竞争风暴。③ **解析放大**：`build_scope` 的 `targets` 数组无上限（`:142` 全量展开）。

**修复**：`serveStdio:296` 前置 `if (trimmed.length > 1_048_576) → -32600`；`targets.length > 256` 抛错；`audit_query` 引入模块级 `Map<path, SigilIndexer>` 连接缓存（替代 per-call 开关）；加简单信号量限制同时在飞的 tool 调用数。

**工时** 0.5–1 d · **依赖** SEC-04（路径约束应与连接缓存一并设计）· **时间线** Week 2 P2

---

### SEC-14 · 索引器无界 SELECT → 内存耗尽 `Medium` CVSS 7.5
**位置**：`indexer/src/indexer.ts:710`（`SELECT value` 无 LIMIT）、`:722`（`SELECT *` 无 LIMIT）、`:732`

**攻击**：`agentId` 由签名者自由选择 → 可执行 N 次合法 action（`windowSeconds` 最小仅要求 `!= 0` → 可设 1 秒）→ 索引器写入 N 行 → `spendByAgent` 把**全部 N 行**载入内存逐行 `BigInt()` 相加。MCP `audit_query`（`server.ts:210`）直接调用该方法。

**实际 vs 预期**：CLI 侧 `cli.ts:207` 有 `slice(-limit)` 的**事后**裁剪，但裁剪发生在 DB 已返回全量之后 —— 保护是装饰性的。

**修复**：三处 SQL 加 `LIMIT`（上限做成构造参数，默认如 10,000），并在 `SigilKitClient` 文档化"此 API 返回有界样本，不是全量"；新增 `spendByAgentPaginated` 供精确总量调用方分块归约；MCP `actions` 分支加 limit 等价参数。

**工时** 0.5 d · **依赖** 无 · **时间线** Week 2 P2

---

### SEC-15 · 索引器把配置 chainId 无条件盖到日志上，跨链错配静默发生 `Medium` CVSS 6.5
**位置**：`indexer/src/indexer.ts:223`（`storeAction(..., chainId = this.chainId)`）、`:300`、`:313`、`:532-581`（`fetchRangeWithStableEnd` **从不校验 RPC 链身份**）、`:528-529`

**攻击**：运维误配 `--rpc`（指向 Base）但 `--chain-id` 保持默认 31337 → `:443` 返回 Base 真实日志 → `:543-555` 逐条校验 blockHash 与 header **全部通过**（Base 自己的链一致）→ `:300`/`:313` 把每行标记为 31337 → 审计库归属错误。`audit_query{chainId:8453}` 返回空（假阴性），`summary` 的链列表显示 31337（假事实）。叠加 31337 是 Anvil 默认值，本地开发极难察觉。

**修复**：`:539` 附近加 `const onChain = await client.getChainId(); if (onChain !== this.chainId) throw`；构造或 `backfill` 首次使用时把 chainId 持久化到 `sync_state` 或新表 `meta`，三方交叉校验；补测试：注入 chainId 不匹配的 stub RPC，断言 fail-closed 且不写任何行。

**工时** 1 d · **依赖** 无 · **时间线** Week 2 P2

---

### SEC-16 · `rollbackTo` 不按 manager 限定，删除同库内所有 manager 的行 `Medium` CVSS 5.5
**位置**：`indexer/src/indexer.ts:350-361`（两条无 manager 条件的 DELETE）、`:834-872`（`actions`/`window_charges` **均无 manager 列**，仅 `sync_state` 有）、`:22-24`（类注释自承）

**攻击**：单库承载多 manager（`sync_state` 主键 `(chain_id, manager)` 明确支持）→ 某 manager 检测 reorg，运维调 `rollbackTo(1234)` → `:352` 无 manager 过滤，删掉同链**其他所有 manager** 在 1234 之后的全部行 → 不可恢复，且它们的游标**未被回退**，重跑也不会补回。

**修复**：短期——`rollbackTo` 改为**拒绝**在 `sync_state` 中存在多于一行不同 manager 的库上调用（fail-secure），强制显式 `manager` 参数；长期——加 `manager` 列 + 迁移（按 `(chain_id, manager, tx_hash, log_index)` 重建，历史行标 `manager=''` unknown 桶，回填不完整时必须标 legacy 并拒绝 rollback）。

**修复成本** 短 0.5 d / 长 2 d · **时间线** Pre-mainnet P2

---

### SEC-17 · ERC-7201 存储槽全部正确，但零测试钉死 `Low` CVSS 5.9
**位置**：`SessionKeyManager.sol:73-74`、`ActionLog7579Executor.sol:28-29`、`SessionKey7579Module.sol:82-83`；`contracts/test/` 全目录 **0 处**引用 ERC-7201 或 slot

**审计结论（正面）**：已用 `keccak256(int256(keccak256(ns))-1) & ~0xff` 独立复算，三个常量与 `cast index-erc7201` 结果**逐字节一致**：`sigilkit.storage.SessionKeyManager` → `0xff085e…14800`、`sigilkit.storage.ActionLog7579Executor` → `0x609299…0200`、`sigilkit.storage.SessionKey7579Module` → `0x37fff5…8f00`。三槽互不冲突。三合约**无 `delegatecall`**（全量确认），7702 通过 designator 安装代码而非 delegatecall。

**残余风险**：槽常量是 `private constant` + 硬编码，零测试覆盖。任何人重命名 namespace 字符串都会得到**全新槽** → 部署后 `owner==0`、`scopes` 全空、已发 session key 全部 `KeyUnknown`。

**修复**：新增 `contracts/test/Erc7201Slots.t.sol`，**测试内按标准算法独立实现**计算逻辑（不复用合约代码，否则同源错误无法发现），`assertEq` 三个常量；加"namespace 一经发布即冻结"注释 + CODEOWNERS。

**工时** 2 h · **时间线** Week 3 P3

---

### SEC-18 · 供应��/泄露面：已复核项与残余缺口 `Low` CVSS 4.0
**(a) gitleaks allowlist 的 `paths` 口径过宽** — `.gitleaks.toml:28-30` 用正则 `packages/core/test/wallet-e2e/.*` 豁免**整个目录**，含 **8 个被 git 跟踪的 harness 源文件**（`coinbase.ts`、`run.ts`、`real-metamask.ts`、`dapp.html` 等）。任何人把私钥粘进 harness 源码都不被扫到。修复：收窄到只匹配下载产物 `metamask.*` / `metamask-.*`，加 CI 断言 allowlist 不得覆盖任何 `git ls-files` 命中的文件。**1 h**。
**(b) `install-gitleaks.sh` 复核通过** ✅ — 版本 + sha256 双固定，`sha256sum -c -` 在 `tar` 之前（顺序正确），`set -euo pipefail` 完备。
**(c) npm provenance 复核通过** ✅ — `publish.yml:114` `id-token: write` + `:178` `--provenance` 齐备；`:109` 的 `needs.assurance.outputs.sha == github.sha` + `:122-123` 双重复核。**这是本仓供应链做得最扎实的部分**。
**(d) @sigilkit scope 冲突** — `publish.yml:129-161` 已实现 fail-fast 的 maintainers 比对。残余是纯运营性：AC-29 记录 scope 由无关项目持有，迁移需同步改 4 个 `package.json` + `check-package-artifacts.mjs` + 全部文档。决策 0.5 d，迁移 1 d。
**(e) 额度精度** — `validation.ts:108` `BigInt(value)` 缺 `Number.isSafeInteger` 守卫。JSON 反序列化的 cap 若以 `>2^53` 浮点传入会被静默舍入（单向偏差 ≤ 数百 wei）。修复：加 `if (!Number.isSafeInteger(value)) throw`。**30 min**。
**(f) 个人身份** — `docs/AC-01-SCRUB-PLAN.md:57` 把个人 GitHub 账号硬编码进 force-push 计划；建议改用 org 级配置或 `${{ github.repository }}`。

---

## B. 软件缺陷（28 条）

> 完整 28 条（含逐步复现步骤）见独立交付文档。核心 12 条：

### BUG-01 · `parseActionRequest` 用 `BigInt()` 强制转换，接受非 uint 值 `High`
**位置**：`core/src/signing.ts:140-161`
**复现**：调 `parseActionRequest({...base, expiry: 1.5})` → **接受**，得 `expiry=1.5`（非整数 uint48 竟通过）。`value: true` → 1；`value: []` → 0；`value: "0x10"` → 16（十六进制串被接受，语义反直觉）。
**根因**：`bigintValue` 直接 `BigInt(v)`（`:142`）无类型白名单；`expiry` 用 `Number()` 且只校验 `isFinite`（`:155`），未校验 `isInteger`；`Number(null)===0`、`Number([])===0`、`Number(true)===1`。
**修复**：加类型白名单 + `Number.isSafeInteger` + `isInteger` 校验。**0.5 d**

### BUG-02/03 · 客户端预检用宿主墙钟，链上用 `block.timestamp`，无漂移容忍 `Medium`
**位置**：`core/src/signing.ts:299`（`nowSec = Math.floor(Date.now()/1000)`）
**复现**：令 `scope.expiresAt` 落在 `Date.now()/1000` 附近，在 anvil 上以不同 `block.timestamp` 执行同一请求 → 本地与链上结论相反（三个结论都可能：scope 硬过期 / request 过期 / 窗口重置）。
**修复**：`validateAgainstScope` 增可选 `nowSec?: number` 注入时钟（纯增量、零行为变更）；文档标注 SDK 时钟与链上时钟偏移从未被测。**1 d**

### BUG-04 · `SessionKeyManager.t.sol` 时间基准异常 `Medium`
**位置**：`contracts/test/SessionKeyManager.t.sol:56-73`（`setUp` 无 `vm.warp`）、`:184`、`:289`
**实际**：`setUp` 未 warp → `block.timestamp == 1`；`:184` 的 `block.timestamp - 1` 得 0（不是"真实的过去"），走的是"expiresAt 为 0（未初始化）"这一**不同语义**，而断言仍通过。掩盖了真实 epoch 下的边界回归。
**修复**：加 `vm.warp(1_700_000_000)`（同 `SessionKey7579Module.t.sol:52-54` 做法）。**1 h**

### BUG-05 · `coinbase.ts:110,129` 两处"常量比常量"永真断言 `Medium`
**位置**：`packages/core/test/wallet-e2e/coinbase.ts:110-120`、`:129-131`
**复现**：`getAddress(PINNED_PROXY) !== getAddress("0x7702cb…")` 而 `PINNED_PROXY` 本身就是该字面量 → **两分支完全相同，永不为真，永不失败**。第 2 个 test 的 `PINNED_IMPL` 同理完全空转。
**修复**：改为与 `WALLET_BEHAVIOR_ALLOWLIST.json` 比对（保留 `:110` 有效的 impl 比对）+ 对 impl 地址发起 `eth_getCode` 真实探测。**0.5 h**

### BUG-06 · MCP `decode_error` 测试断言恒真 `Medium`
**位置**：`packages/mcp/test/validation.test.ts:180-184`
**复现**：`expect(JSON.parse(text).name).toBeDefined()` —— `decodeSigilKitError:30-42` 对**任何**输入都返回对象（未知 selector 走 `UnknownError`），故必然 defined。测试名"decodes a known selector"与实际断言的 `UnknownError` 语义完全相反。
**修复**：改为 `toBe("UnknownError")` + 补一个真实 SigilKit 错误 selector 的正例。**30 min**

### BUG-07 · `indexer.migrate()` 非事务化，中途失败留下半迁移 `High`
**位置**：`indexer/src/indexer.ts:155-214`
**复现**：准备 pre-09-12 库（无 `log_index`），在 `:189` 的 `DROP TABLE actions_legacy` 之前注入失败 → 崩溃后 `actions` 已 RENAME、新表已建、行已拷、`actions_legacy` 未删；`window_charges` 未迁移 → 库进入**混合 schema**。更坏：若中断在 `:188` 之后 `:192` 之前，`window_charges` 永久停留旧 schema，而 `CREATE TABLE IF NOT EXISTS` 不会修正它。
**修复**：包 `BEGIN IMMEDIATE`/`ROLLBACK`；加"迁移中断"回归测试；引入 `PRAGMA user_version` + `_migrations` 表。**1 d**

### BUG-15 · `removeLog` 跨 manager 误删 `Medium`
**位置**：`indexer/src/indexer.ts:332-342`
**复现**：双链/多 manager 同库 → 以 chainId=1 的 indexer 调 `ingestLogs([{removed:true, txHash, logIndex}])` → `:337`/`:340` 只按 `(chain_id, tx_hash, log_index)` 删 → chain 8453 的行**仍在**（静默数据不一致）。注意方向修正：`removeLog` 在 backfill/watch 中**确实不可达**（`fetchRangeWithStableEnd:543` 会因 `log.removed` 直接抛错），但作为**公共 API** 对 embedder 可达。
**修复**：加 `manager` 列（见 SEC-16）。**1 d**

### BUG-16 · `SigilIndexer.backfill()` 显式 `--to` 时跳过短链防护 `Medium`
**位置**：`indexer/src/indexer.ts:606-630`
**复现**：head=5 的新链跑 `backfill --to 100` → `:609` 的短链守卫仅在 `toBlock === undefined` 时生效 → 完全绕过；`:618` `end < start` 时显式 `--to` 直接 `return 0` **无任何日志** → 返回"backfill stored 0 event(s)" + summary，**退出码 0**。AC-32 描述的"静默"在显式 flag 下**依然存在**。
**修复**：`:609` 守卫改为无论是否显式都生效；`:618` 加 `log.warn`。**0.5 d**

### BUG-17 · `SigilIndexer.watch()` 的 `stop()` 无法中断在途 sleep `Medium`
**位置**：`indexer/src/indexer.ts:653-702`
**复现**：`watch(client, manager, 60_000)` 后立即 `stop()` → `stopped` 只在循环边界检查（`:659`）→ 若正在 `await sleep(pollMs)` 则无法打断。CLI `:151-156` 在 `stop()` 后立刻 `resolve()` 进 `finally { indexer.close() }` → 与在途 tick 竞态（可能抛未捕获异常被 catch 吞掉后**在已关闭句柄上无限重试**）。
**修复**：引入 `AbortSignal` + 可中断 sleep；`watch` 返回 `{ stop(): Promise<void>; done: Promise<void> }`。**1 d**

### BUG-18 · `EchidnaProperties.t.sol` 的 skm 从上到下零注资 `High`
**位置**：`contracts/test/EchidnaProperties.t.sol:39`（构造 skm）、`:81-87`（`h_execute`）
**复现**：运行 echidna → `skm` 余额恒 0 → `value = valueSeed % 2 ether` 恒 > 0（除非 `valueSeed ≡ 0`）→ `request.target.call{value}` 余额不足 revert → `ok` 恒 false → `successes[a]` 恒 0 → 三个属性中两个退化为恒真通过。
**修复**：构造函数 `vm.deal`（Echidna 无 vm，用 `payable(address(skm)).transfer(100 ether)`）。**0.5 d**

### BUG-19 · `SessionKey7579Module.validateUserOp` 的 `callData.length < 32` 检查不足 `Medium`
**位置**：`SessionKey7579Module.sol:218-224`
**复现**：构造 `callData` 长度**恰好 32** → `:218` 通过 → `:220` `execPayload` 为空 → `abi.decode` 空数据 → 实际 revert 但是低层 ABI panic 而非语义化的 `MalformedExecutionData`（与 batch 路径 `:271` 的显式 `batch.length == 0` 检查风格不一致）。且 `_enforceSingle:256` 的 `bytes4(call_.data)` 在 `data.length < 4` 时静默补零 → 白名单可为 `0x00000000` 建叶。
**修复**：加 `if (execPayload.length == 0) revert MalformedExecutionData()`；统一 selector 派生规则。**0.5 d**

---

## C. 性能瓶颈（16 条）

> 性能 agent 实测：Node v24.12.0 / node:sqlite / Windows / 200,000 行合成 `actions` 表（97.7 MB）。SQL 与 CPU 数字为**实测**；gas 数字为 EIP-2929 公式推算（本地无 forge）。

### PERF-01 · 三个索引以 `chain_id` 打头，默认查询不传 chainId → 全表 SCAN
**实测（200k 行 / 2 chain）**：
| SQL | 计划 | 中位耗时 |
|---|---|---|
| `WHERE agent_id=?`（无 chain） | `SCAN actions` | **12.19 ms** |
| `WHERE agent_id=? AND chain_id=?` | `SEARCH USING INDEX idx_actions_agent` | **0.01 ms** |
| `SELECT * WHERE agent_id=? ORDER BY block_number,log_index` | `SCAN` + `USE TEMP B-TREE` | 13.53 ms |
**放大系数 1,200×**。修复：追加覆盖索引（不改现有，保持多链语义）：
```sql
CREATE INDEX idx_actions_agent_only ON actions(agent_id, block_number, log_index);
CREATE INDEX idx_actions_target_only ON actions(target, block_number, log_index);
CREATE INDEX idx_charges_key_only    ON window_charges(key, window_start DESC, block_number DESC, log_index DESC);
```
预期：**12.19 ms → <0.1 ms（>100×）**。**工时 2 h**

### PERF-02 · `.slice(-limit)` 在全量物化之后 `实测`
`:207` `actionsForAgent(...).slice(-limit)` → 1,000 行/11 列全部实例化，随后只保留 `limit`（默认 20）行 → **浪费 98%**。修复：limit 下推 SQL（子查询 `ORDER BY DESC LIMIT ?` 再外层升序）。**预期 13.53 ms → <0.2 ms**。**1 h**

### PERF-03 · 语句未缓存（`prepare` 每次重编译） `实测`
| 模式 | 1000 次 INSERT 耗时 |
|---|---|
| 语句缓存 | **4.25 ms** |
| 每次重新 prepare（当前） | **8.78 ms** |
**写放大 2.07×**（`node:sqlite` 不缓存 prepared statement）。修复：构造末尾一次性 `prepare` 存 `readonly` 字段（**必须在 `migrate()` 之后**）。**预期 4.25 ms → 2.9 ms（1.47×），写吞吐 +45%**。**2 h**

### PERF-04 · `spendByAgent` 全量载入 + JS reduce `实测`
1,000 行即 1,000 次字符串→BigInt + 1,000 次大整数加法。修复：主要靠 PERF-01 的索引（12.19 → 0.01 ms，1,200×）；**代码注释显式钉死"不要用 SQL SUM 替代，uint256 会溢出/丢精度"**。**1 h**

### PERF-05 · `actionsFor*` 无 LIMIT / 无分页 / 无列裁剪 `实测`
`SELECT *` 11 列物化 13.53 ms，**无上界**。修复：默认 `limit=1000`，超限抛错（fail-closed）；`SELECT` 显式列名替代 `*`。**3 h**

### PERF-06 · `summary()` 三次 COUNT + `chainIds()` 第四次全表 `实测`
`summary()` 11.88 ms + `chainIds()` 4.20 ms = **16.08 ms**（无 chain 过滤）。`COUNT(DISTINCT agent_id)` 是唯一无法走 covering index 的一项。修复：先做「单次扫描合并 COUNT」（1 h，11.88 → ~4 ms），汇总表延后（会与 `rollbackTo`/`removeLog` 耦合）。**6 h → 先做 1 h 部分**

### PERF-07 · `fetchLogsChunked` 全量物化 `实测建模`
1,000 日志 = 0.73 MB；**100,000 日志 = 73.2 MB**。修复：流式分块提交（**风险最高**，触及 fail-closed 语义）；**低风险替代：保留物化 + `maxLogs` 硬上限 50,000 + 超限抛错（1 h，彻底消除无界增长）**。**8 h 或 1 h**

### PERF-08 · `fetchRangeWithStableEnd` 对每条日志所在区块逐个 `getBlock`，**串行 await** `静态+计数`
RPC 数 = `ceil(span/2000) + 去重区块数 + 6`：

| 区间 | 日志 | 去重区块 | **总 RPC/tick** |
|---|---|---|---|
| 2,000 | 100 | 100 | **107** |
| 2,000 | 1,000 | 1,000 | **1,007** |
| 100,000 | 5,000 | 5,000 | **5,056** |
按 50 ms/RPC 计，1,000 区块 ≈ **50 s 串行**。修复：viem `http(url, {batch:true})` + `Promise.all` 限流批（20/批）。**预期 50 s → ~0.3 s（~150×）**。**4 h**

### PERF-09 · `waitForTransactionReceipt` 无 timeout `静态`
未传 `timeout`/`retryCount` → viem 默认 `pollingInterval=4000ms` **无限轮询**。若交易被同 nonce 另一笔替换（**本 SDK 正是 nonce 严格递增设计**），原 txHash 永远不上链 → **无限挂起**。`sendPrepared:810-814` 的 try/catch 只处理 reject，**挂起永不进 catch** → relayer 进程被永久占用（`NonceGate` 串行化 → **该 key 后续所有执行全部阻塞**）。修复：加 `timeout: 120_000, retryCount: 30, pollingInterval: 2_000`。**1 h**

### PERF-10 · `merkleProof` 无 `leaves` 长度上限 → CPU 线性放大 `实测`
| leaves n | merkleRoot | µs/leaf | keccak 总数 |
|---|---|---|---|
| 1,024 | 8.68 ms | 0.0083 | 1,023 |
| **16,384** | **136.06 ms** | 0.0084 | 16,383 |
**严格 O(n)**，无上限 → 1,000,000 leaves ≈ **8.4 s CPU + 数 GB 分配** = 事件循环阻塞 DoS。修复：`MAX_LEAVES = 65_536` 守卫 + 与链上 `MAX_TOTAL_PROOF_ELEMENTS = 32` 对齐。**2 h**

### PERF-11 · 链上 `proof.length` 无界 + `_targetAllowed` 跑两遍 verify `静态(gas)`
| proof 长度 | keccak gas | 相对 BUDGET_SIMPLE=150,000 |
|---|---|---|
| 16 | 2,496 | +3,008 |
| **256** | **39,936** | **+48,128 → 198,128** |
每元素约 74 gas。真实风险是**合法用户误传长 proof 直接超 block gas limit**。修复：加 `MAX_PROOF_LENGTH = 32` 常量 + 短路优化。**3 h**

### PERF-12 · `reentrancyLocked` 双 SSTORE 每次 ~14,000 gas `静态(gas)`
`nonReentrant` 占单次执行 gas 的 **~28%**（40,000 / 142,000）。修复：`bool` → **transient storage**（EIP-1153，`prague` 已支持），`TSTORE`/`TLOAD` 各 100 gas。**预期 -14,000 gas/次（-10%）**。**4 h**（需验证 transient storage 在 Base 可用 + 更新 GasBudget）

### PERF-13 · 7579 批量：每 tuple 独立 verify + `abi.decode` 全量物化 `静态+实测`
`.gas-snapshot:41` batch 全落地 = 302,945 gas；`:61` 8-tuple 上限 = **187,964 gas**。问题：`_whitelisted` 在 wildcard 路径最多跑 2 遍 verify，且 `bytes32[] memory proof` 每个 tuple 都要从 calldata 拷到内存。修复：`_parseBatchProofs` 守卫改 fail-fast；改 calldata 切片。**预期 187,964 → ~160,000 gas（-15%）**。**6 h**

### PERF-14 · CI：重复 forge 编译 + MetaMask 扩展缓存 `静态计数`
`checkout` 重复 11×；`foundry-toolchain` 重复 8×；`forge inspect` 在 ts-sdk 内跑 4 次。**MetaMask 实际 74.7 MB**（`ci.yml:291` 缓存路径是 `metamask/`；49.2 MB 是从未被 CI 使用的 `metamask-12.5.0/`），缓存 key 无 `restore-keys` 且 job 每周一 → 间隔恰好 7 天 → **缓存几乎必然每次过期重下**。**3 h**

### PERF-15 · 预检 RPC 编排（**否定结论**） `实测`
`Promise.all([getNonce, getWindowState])` 已并行；`checkTokenPath` 的 2 次读已并行；`getNonce` 在 nonce 已给时短路；`getWindowState` 失败降级。**此项已接近最优，0 提升**。**但需在文档显式记录"这三个点已优化，勿重复优化"**，防止后续 review 误判。

### PERF-16 · 7702 共享存储槽（**否定结论**） `实测`
三个 ERC-7201 命名空间常量**全部正确**（与 `cast index-erc7201` 逐字节一致），无碰撞。`SigilKitDelegator` 未重声明 `_STORAGE_LOCATION` → 1/2²⁵⁶ 静默状态别名。**建议仅在文档记录，不改代码**（破坏性，已有 EOA 委托状态不可读）。

---

## D. 代码质量 + 技术债（26 条）

> 完整 26 条见独立文档。核心 14 条：

### DEBT-01 · Node ≥24 事实源分裂 8 处 `P1 · 3–4 h`
`package.json:12` / 3 个包的 `engines` / `.nvmrc` / `check-runtime.mjs:26 DEFAULT_FLOOR=24` / `benchmark-indexer.mjs:58 REQUIRED_NODE_MAJOR=24` / `bootstrap.mjs:34` 脆弱字符串解析（`slice(0,2)` 对 `">=100"` 得 `"10"`）/ `Dockerfile:20,35` / 2 个 workflow 的 5 处 `node-version: "24"`。**业务影响**：Node 25 到来时 10 处需同步改。修复：新增 `scripts/sync-facts.mjs`（`--check`/`--write` 双模），事实源定为 `package.json` 的 `engines.node`。

### DEBT-02 · CI job 清单 3 处消费但无共享事实源 `P1 · 4 h`
`check-doc-counts.mjs:530-546`（真 YAML 解析）/ `assurance-inventory.mjs:151-184`（**手写缩进解析器**，对 `uses:` 折叠/`name:` 跨行脆弱）/ README+白皮书正则。**业务影响**：项目以 claim-rigor 为品牌，CI 规模是外部审阅者第一眼核对的数字；三处独立实现意味着漂移只会在其中一处显现。

### DEBT-03 · `Invariant|Fork` 排除语义 4 处 `P1 · 3 h`
`package.json:19,20` / `verify.mjs:179` / `check-doc-counts.mjs:33 EXCLUDED` / `ci.yml:76,205,360`（3 个 step）。新增含 `Invariant`/`Fork` 命名的套件会在 4 处同时被排除或不被排除，静默丢失覆盖率。

### DEBT-04 · `verify.mjs` 全链路无 timeout `P0 · 4 h`
`:118-122` `spawnSync` 无 `timeout`/`killSignal`；`stdio:"inherit"` 不捕获也无法回放。任何 npm/forge/vitest 挂死都会让闸门无限期挂起。**"一份 run 告诉你所有坏的东西"的设计承诺在挂死时退化为挂死**。修复：加 timeout + 日志落盘 + 失败回放。

### DEBT-05 · `clean.mjs` 会删 `broadcast/`（半不可再生）且无测试 `P1 · 3–4 h`
`:62-64` 已有 `--dry`（但 `npm run clean` 不暴露）；`:65` `rmSync(recursive, force)` **不校验结果**；`broadcast/`（306 文件/8.1 MB 本地部署记录，多链/主网部署无法从源码重新生成）在 TARGETS 里，注释只说"All of it is reproducible"——**这是错的**；**全目录唯一没有任何测试的主脚本**。

### DEBT-06 · 3 个零覆盖的提取/解析器 `P1 · 4–6 h`
`checkSecurityTxt`（RFC 9116 披露通道守卫，零测试）/ `halmosSpecCount`/`echidnaPropertyCount`/`forgeCounts` 三个计数正则（docs 数字的唯一来源）。**这 3 个是"docs 数字对得上"这一发布凭据的裸奔代码**。

**2026-10-04 部分关闭。** 第四项 `check-runtime.mjs collect()` 原记为「从未被调用」——该脚本有完整测试套件、也被 CI 跑，但**守卫本身从未被任何入口执行**，于是 `npm run verify` 报告了一次它从未运行的守卫的干净结果。现已接入 `verify.mjs` 的 `runtime` 步骤（LABELS/BUDGETS/STEPS 三处），`--only=runtime` 可单独运行。`check-runtime.test.mjs` 中断言「未被接线」的用例已反转为断言「已接线」，防止再次脱钩。

### DEBT-07 · `check-doc-counts.mjs` 文件头声称守 CHANGELOG 但代码没做 `P1 · 6–8 h`
`:5-8` 的设计目标是"测试/job 计数漂移"，代码只读 README + `docs/WHITEPAPER-v2.1.md`（`:334`）。CHANGELOG 贡献了本轮全部 6 处数字漂移却**完全不在守卫范围**。现有 `checkReadmeCounts`/`checkWhitepaperCounts` 是纯函数，扩展只需复用同模式。

### DEBT-07b · `docs/STATUS.md` 自称权威索引但已过期 2 周+且错数 `P0 · 2 h`
`:12` 称 `vault/` 有 21 notes，实际 **22**；完全不含 `PLAN-30-DAYS`（当前正在执行的计划）/ AC-32/33（已完成的修复）/ 威胁图 / `RESEARCH-NUMBERS`。**整个文档体系的信任锚断了**。修复：重写为四层权威（规范/记录/计划/背景）。

### DEBT-08 · CHANGELOG 6 处数字漂移 `P0 · 2 h`
core 180 vs 255、indexer 12 vs 34、MetaMask 12.5.0 vs 13.49.0、"4 invariant suites" vs 4/1、coverage 三套数字、test 计数 91/10 vs 115/11。**全部不在守卫范围**。

### DEBT-09 · `docs/STATUS.md` + `SigilKit_Whitepaper.txt` 身份分裂与已证伪断言 `P0 · 0.5–1 h`
`README.md:70` + `GETTING-STARTED:23` + `DEPLOYMENT.md:246` = `github.com/sigilkit/sigilkit`（记为 404）；`.well-known/security.txt:15-20` = `github.com/dev25bansal-ops/sigilkit`。三个文件两个规范 URL。`SigilKit_Whitepaper.txt`（v2.0）含 6 条已证伪断言（伪造 `0xcc…SecurityControl` 地址、伪造 IC3 引语、0 reactions 写成 25 upvotes、已关闭的 Optimism #274、已死 RPC 端点、虚构审计/Immunefi/Certora/UUPS）仍在仓库。修复：加 `SUPERSEDED` 横幅（0.5 h，today）；移出到 `docs/archive/`（1 h）。

### DEHT-10 · 两个 spec URL 规范 URL 未落定 + 绝对路径 + 个人身份 `P1 · 7.5 h`
两个 spec URL（sigilkit vs dev25bansal-ops）/ 绝对路径（`C:/Users/dev25/.foundry/bin/forge.exe`、`D:/SigilKit`）/ 个人身份（`dev25` 25+ 次）。**URL 统一依赖最终仓库归属决策（AC-28 无 remote），现在做可能被推翻**——建议做成"定一个变量 + 全局引用"。

### DEBT-11 · `adversarial.test.ts` 自述临时文件却仍在套件 + ESM 内 `require()` `P3 · 1 h`
`:1-2` 自称"temp file, deleted after run"；`:69` `require("viem")`（依赖 vitest CJS 垫片，vitest 升级或移到 Playwright 覆盖目录即 `ReferenceError`）。修复：改 import + 删"temp file"注释。

### DEBT-12 · `dapp-server.ts` + `playwright.config.ts` 无引用孤儿 `P3 · 1 h`
全仓检索无 import。`playwright.config.ts:10-12` 在**模块顶层** `throw new Error("MetaMask extension missing")` → 任何误将其纳入测试发现的改动会让整个 core 套件在收集阶段失败。且 `baseURL: "http://127.0.0.1:8545"` 指向 anvil，真实 dapp 在 `:8765`。

### DEBT-13 · `ENTRY_FIELDS` 死常量 + `check-runtime.mjs`/`assurance-inventory.mjs` 零调用方 `P3 · 1 h`
`check-package-artifacts.mjs:46` `export const ENTRY_FIELDS` 全仓 2 处引用（自身定义 + 描述），不被任何代码消费。Two 570 行的诊断脚本各带完整单测但零生产调用方。

### DEBT-14 · `vectors` 自证 + 双份漂移 `P0 · 5 h`
`generate-vectors.mjs:29-31` 对 actionrequest/merkle 的源是 `@sigilkit/core/dist` **自身**（自证），只有 eip7702 借 viem 外部权威；`eip7702.json`(6) vs `eip7702.test.ts` 硬编码 8 条**仅 1 条重合**；`casesCount`/`leafCasesCount`/`proofsCount`/`leavesCount` 四处手工计数**零断言**（Foundry 侧靠 `parseJsonUint` 循环、TS 侧与数组长度完全脱钩）；CI 无"重生成是否 no-op"门。修复：no-op 门 + 计数双向校验 + 补进 4 条非重合向量 + actionrequest 改用 viem `hashTypedData` 生成（外部锚定）。

---

## E. 架构问题（12 条）

> 完整 12 条见独立文档。核心 8 条（ARCH-7 ~ ARCH-18）：

### ARCH-7 · Manager 与 进一步的 7579 路径能力不对等 `High · 3 d`
**位置**：两处 `Scope` 结构体 + 2 份 ABI + 1 份 TS 类型 + MCP `coerceScope` = **4–5 处重复**，无 codegen、无 schema 版本、无字段级漂移门。`abis.ts:3-5` 明确说"必须与 `abis/*.json` 保持同步，靠 `abi-drift.test.ts` 保证"——但该门**只覆盖编译产物**，不覆盖手写片段 / `client.ts` 内联 ABI / `types.ts` 接口 / Sol 结构体。
**影响**：可扩展性——每个新安全特性要改 4–5 处，漏改无编译错误，只在运行时以 ABI 编解码错位暴露；可靠性——用户在 7579 账户上预期"跨钱包一致"的 E10 副签保护实际不存在；可维护性——`validateAgainstScope:277-291` 的 CONFORMANCE CONTRACT 5 项表只对应 Manager。
**修复方向**：① 单一权威 `schema/scope-v2.json` **代码生成** Sol 结构体 + TS interface + ABI tuple + MCP coerce；② 为 7579 补齐 E10/E11（**E11 落 executor 侧而非 validator**，因为 validation ≠ execution）；③ 路径矩阵测试（同一 Scope+request 跑两条路径，断言能力集一致或差异被显式 allowlist）。
**3 d**（schema/codegen 1 d + E10 7579 1 d + E11 executor 0.5 d + 矩阵测试 0.5 d）

### ARCH-8 · 无全局 pause / 治理恢复面 `High · 2 d`
owner 是唯一治理根。因不存在 pause/guardian/多签/timelock，任一已授出的未撤销 session key 可在其有效期内持续花费，而撤销本身也需 owner。**owner 私钥丢失后没有任何链上手段能阻止在途 key**。
**张力**：合约故意不加代理（pre-mainnet 最小攻击面选择），但**不可升级 ≠ 不可停机**。即使保持不可升级，也应有独立 kill-switch 面。
**修复方向**：① 保持合约不可升级，但新增 `setPaused`/`paused()`（`paused` 与 `reentrancyLocked` 同 slot → **净 gas ≈ 0**）；② 中期 timelock + 可选多签（**紧急 pause 即时、unpause 延迟**——不对称时间窗是业界惯例）；③ 明确文档化"immutable-by-design"的安全边界。

### ARCH-8b · E10 副签与 Safe owner 不兼容 `High · 0.5 d`
**位置**：`SessionKeyManager.sol:308`（`_ecrecover(approvalDigest, ownerApproval) != s.owner`）、`:602-616`（`_ecrecover` 只接受 65 字节 ECDSA）
**机制**：Safe 是合约，永远无法作为 `ecrecover` 结果出现 → 一旦按文档（`DEPLOYMENT.md:50-53`）把 owner 设为 Safe，**所有超阈值动作的 owner 副签路径永久不可用**。当前没有任何测试覆盖这一组合。
**修复**：新增 `ownerApproval` 的 ERC-1271 分支（复用 `:519-541` 已有的 1271 解析逻辑抽成共用 helper）。

### ARCH-9 · 无 scope 契约版本化 / 单一权威 schema `High · 2.5 d`
Scope 与 error 表面是**跨语言、跨路径的权威契约**，却以手写重复形式存在 5 处，**无 codegen、无 schema 版本、无字段级漂移门**。Scope 三处镜像（Sol×2 + TS + MCP `coerceScope` 68-77 + `build_scope` output 160-169 = **3 处**）新增字段需三处同步，遗漏是静默的（unknown 键被丢弃）。
**修复**：单一权威 schema + codegen + `scopeVersion` 字段与版本路由 + extend abi-drift 门至手写片段。

### ARCH-9b · E10/E11 本地预检不镜像链上 `High · 1 d`
`signing.ts:292-355` `validateAgainstScope` 精确镜像 5 项链上检查，但**不含** E10（`countersignAbove`）与 E11（`enforceNativeDelta`/`tokenWatchlist`）。**后果**：SDK 说"OK"但链上 revert（E10 缺副签 / E11 delta 超限）→ 零 gas 拒绝的卖点打折；用户签名前不知会失败。
**修复**：扩展 `validateAgainstScope`（E10 存在性预检 + E11 声明额推导 + denylist 查询），标 advisory。

---

### ARCH-10 · indexer reorg 恢复面缺失 `High · 2 d`
`validateCursor:479-524` 三种情形（null hash / mismatch / unavailable）**全部 throw**（注释明确"No automatic rollback"）；`rollbackTo:344-361` 删数据 + `setCursor(..., null)` → 游标 hash 置 null → **下次必然再次 fail-closed**（注释自己承认）。恢复链路上**没有任何自动化或半自动手段**。
**根因在 schema**：行自然键 `(chain_id, tx_hash, log_index)` **缺 `manager` 列** → 自动回滚无法安全执行（可能误删另一 manager 的行）。
**修复**：① 加 `manager` 列（含 backfill 迁移）；② 提供真正的恢复原语 `recoverFromReorg(manager, reorgHeight)`——删该 manager 在祖先之后的行，**同时**用链上 `getBlockHash(ancestor)` 回填游标 hash（不是 null），使其重新可验证；③ 分级响应（检测到 reorg → 尝试自动恢复到共同祖先 → 失败才升级为人工）。

---

### ARCH-11 · indexer 单写者 + 无增量/归档/多链协调 `Medium/High · 3 d`
三重约束锁死扩展性上限：① 单写者（SQLite 单写锁 + 显式 "one writer per database"）；② 构造时绑定单链（`this.chainId` 是实例字段）；③ 无归档策略（`rollbackTo` 是唯一清理手段且语义为破坏）。
**修复**：① 抽象 `Store` 接口（当前 `SigilIndexer` 为 SQLite 实现），预留 Postgres；② 复用 SDK 的 `LeaseStore` 提供 indexer 侧 leader 选举；③ `pruneBefore(blockNumber)` 归档而非删除。

---

### ARCH-12 · MCP 传输边界 `High · 2 d`
**位置**：`:9-11,290-344`（仅 `serveStdio`，**无 http/SSE**）、`:181-221`（`db` 任意路径）、`:309-338`（**无行长上限、无在途并发上限、无速率限制**）、`:34-36`（`protocolVersion` 硬编码 `2024-11-05`，无版本协商）。
**影响**：单行超长 JSON（100 MB）→ `JSON.parse` OOM 崩溃整个 MCP；无并发上限时 N 个 `audit_query` 同时打开 SQLite（Windows 独占锁）→ 大量失败。**stdio-only 使 MCP 只能作为子进程运行，无法作为共享服务**——这是 MCP 生态的主流部署形态。
**修复**：路径约束 + 资源上限 + 传输抽象（`Transport` 接口，`StdioTransport`/`HttpTransport`）+ protocolVersion 可配置。

---

### ARCH-13 · SDK 能力缺口 `High · 4 d`
**位置**：`:777-807` `sendPrepared` 只传 `{account, chain, to, data}` — **不传 gas/gasPrice/maxFeePerGas/maxPriorityFeePerGas/nonce/authorizationList/chainId**；`:587,811` `waitForTransactionReceipt` **无 timeout、无重试退避**；`eip7702.ts:114-167` 有原语但 **无 tx 组装/发送**（`toAuthorizationTuple` 返回 tuple 但无消费方）；`errors.ts` 有 `DecodedSigilKitError` 但 **无 ErrorCode 枚举**；`signing.ts:292-355` 预检不镜像 E10/E11。
**修复**：tx 参数透传 + 7702 type-4 发送闭环 + ErrorCode 分层 + 7579 签名工具（`buildUserOpSignature` + proof 尾编码）+ 预检扩展。**4 d**

---

### ARCH-14 · 扩展靠手工清单 + vectors 无 no-op 门 `Medium · 1.5 d`
`scripts/abi-targets.txt` 新增合约需手工加（漏加 → ABI 漂移门**不会**失败，而是静默跳过该合约）。`generate-vectors.mjs` 无 no-op 门 → 改坏向量不会触发 CI。钱包行为变化需手工更新 allowlist（正确的），但缺少"新行为未在 allowlist → 失败并提示更新"强制门。
**修复**：① 扫描 `contracts/src/*.sol` 自动枚举，**反向检查**清单（文件存在但清单无 → 失败）；② `npm run vectors:generate && git diff --exit-code vectors/`；③ allowlist 断言从 `continue-on-error` 的 weekly 提升为必过。

---

### ARCH-15 · scope 被占阻塞全链路 + 无 canary + Halmos/Echidna 不在 PR 门 `High · 2.5 d`
`publish.yml:130-160` 已实现 fail-fast 的 maintainers 比对逻辑。Current state: `@sigilkit/core` 在 npm 上已被无关项目占用（v0.11.1），`indexer`/`mcp` 为 E404。`halmos` 在 `ci.yml:243` 条件为 main/master/dispatch → **PR 不跑**；`echidna-nightly:334` `continue-on-error: true` → **不阻塞且不 PR 门**。
**修复**：① scope 决策（改个人/org scope）+ 迁移；② 分阶段发布（`next` dist-tag canary → 观察窗 → stable）；③ Halmos 进 PR 门（**前置：先修 SEC-08 + SEC-08b**）；④ Echidna 提升为必过 nightly（达到 CI-WAIVERS 判据）。

---

### ARCH-16 · 可观测性：日志无脱敏/metrics/tracing + 审计事件无版本 `Medium/High · 2.4 d`
**位置**：`logger.ts:77-127` 直接输出 `fields`（**no redaction**）；`indexer.ts:648-651,687-692` `watch` 失败仅 `log.error` + backoff（**no metrics**）；`ActionLogger.sol:11-18` `ActionLogged` **no version field** — 未来加字段破坏历史数据解码（`parseActionLogged` 按 topic0 匹配）。**可观测性是日志级、非运维级**：no metrics → 无法做容量规划，无法在规模化前预判瓶颈；no event version → 审计 schema 无法安全演进。

---

### ARCH-16b · governance 事件不足以重建状态 `High · 3–4 d`
**位置**：`SessionKeyManager.sol:90-92` (`SessionKeyGranted(key, expiresAt)` 只记 expiresAt, 不记 cap/merkleRoot/tokenWatchlist/denylist); 对**未撤销的已有 key** 再 `grantSessionKey` **静默覆盖整个 Scope** (`:176`) → **no `ScopeUpdated` event** → 事后无法从日志证明"某时刻 cap 是多少、是否被谁改过"。补充: 无 key 枚举能力 (`scopes` is `mapping`) → **"一键 revoke 所有 key" 当前在链上不可实现**.

---

### ARCH-17 · E10 副签与 Safe owner 不兼容 `High · 0.5 d`
（与 ARCH-8b 同一问题，从架构角度）

### ARCH-17b · 无 key 枚举 + no 一键全量 revoke `Medium · 3–5 d`
（与 ARCH-16b 同一问题）

---

## 依赖拓扑（实施顺序）

```
ARCH-9（scope 单一源）──→ ARCH-7（能力对齐）──→ ARCH-13（SDK 闭环）
        │                      │
        ↓                      ↓
ARCH-16b（governance 事件）    SEC-05（7579 E11）
        ↓
ARCH-10（reorg 恢复）──→ ARCH-11（多写者）
        ↓
ARCH-16（可观测）← ARCH-10/17b

SEC-01（ERC-20 抽干）──→ SEC-09（relayer 绑定）──→ SEC-10（轮换刷新）
SEC-08 + SEC-08b（Halmos）──→ ARCH-15（Halmos 进 PR 门）
SEC-02（密钥轮换）= Day 0 独立，外部阻塞
SEC-07（actionlint pin）──→ AC-28（CI 首次执行）
```

### 波次建议

| 波次 | 内容 | 工时 | 关键输出 |
|---|---|---|---|
| **Wave 0（Day 0–1）** | SEC-02（密钥轮换先于改写） | 1.5 d | 旧密钥 401 验证 |
| **Wave 1（Week 1）** | SEC-08/08b（Halmos 空转）、SEC-03/04（MCP）、SEC-06（私钥同进程）、SEC-07（actionlint） | ~6 d | 5 个 Halmos 规格首次真正执行；MCP 路径约束 fail-closed |
| **Wave 2（Week 2）** | SEC-01（ERC-20 抽干） + SEC-11/12/13/14/15/16 | 7–8 d | "spend cap" 在代币资产上成立；logger 脱敏；MCP 上矿 |
| **Wave 3（Week 3–4）** | BUG-07（migrate 事务）、BUG-18（Echidna 注资）、DEBT-04（verify timeout）、DEBT-07/08（CHANGELOG 守卫） | ~7 d | 库迁移全有全无；夜间属性测试有信息量 |
| **Wave 4（pre-mainnet）** | SEC-05（7579 E11）、ARCH-8（pause）、ARCH-8b（E10-1271）、DEBT-09（whitepaper banner） | ~7 d | 跨钱包一致性能兑现 |

---

## 附：三个被实测推翻的怀疑

| 怀疑 | 结论 | 证据 |
|---|---|
| `withdraw` 可被重入重复提取 | **推翻**。`onlyOwner` + 不写状态 + 余额硬约束 | 缺失修饰符属实但不可利用 → SEC-16 Low |
| Foundry fuzz 层为空 | **推翻**。116 个 `test_*` 中带参数的有 3 个（Halmos 的 6 `check_`), `founderry.toml:23-39` 三档 profile 配置正确 | 初始全仓统计把 `check_` 误判 |
| 向量文件为空 | **推翻**。3 份 json 均存在且双侧消费 | 初始清单截断导致误判 |

---

## 附：性能实测环境

**测量环境**：Node v24.12.0 / node:sqlite / Windows (win32) / 200,000 行合成 `actions` actions 表（97.7 MB）/ solc 0.8.36 + optimizer_runs=200. **本地无 forge**，故所有 gas 数字来源为「静态推算（EIP-2929 计价公式）」或「提交进 `.gas-snapshot` 的历史实测值」；SQL 与 CPU 数字为**实测**。
