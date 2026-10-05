# SigilKit — Verification Strategy (2/2)：CI 自动化 + UAT 验收

> 承接 `VERIFICATION-STRATEGY-2026-09-25.md`（VTS-A 框架 + VTS-B 合约 + VTS-C TS 服务层）
> 本文件：VTS-D（CI/CD）+ VTS-E（UAT + 发布验证 + 生产运维）

---

# 第四部 · VTS-D CI/CD + 自动化验证

## 12 job 分析要点

| Job | 阻断性 | 关键问题 |
|---|---|---|
| `workflow-lint` | 阻断 | **actionlint 经 `curl | bash` 拉 `main` 分支脚本**（`ci.yml:60`），上游被投毒即 CI 全量 RCE |
| `forge-unit` | 阻断 | `deny="warnings"` 使**任何新 solc 警告即构建失败** —— 最易碎的 PR 门 |
| `secret-scan` | 阻断 | **gitleaks + gitleaks.tar.gz 产出均未被 gitignore** |
| `ts-sdk` | 阻断 | 12–20 min（最长门）；4 次 coverage 重复执行已跑过的 vitest |
| `forge-fork-base` | 报告 | secret 未设 → job 绿。**无人能区分"fork 通过"与"fork 没跑"** |
| `halmos` | **发布门但 PR 不跑** | 条件依赖 `github.ref` 而非 `event_name`；**且 5/11 规格空转** |
| `wallet-e2e-weekly` | 豁免 | Chromium + **74.7 MB** 扩展双重下载；`continue-on-error` 使红都不可见 |
| `echidna-nightly` | 豁免 | 第三方 action + 浮动 tag = 供应链面最大 |
| `foundry-canary` | 豁免 | `version: nightly` 不可复现；上游破坏最长 **30 天**才可见 |

**结构性观察**：PR 事件下 6 个 job **恒 skip** → **每个 PR 实际只有 6 个真跑**，却展示 12 个（含大量灰色），**严重稀释信号**。

> **Unverified as of 2026-10-01 (documentation-truthfulness pass):** the job counts in this
> section are **not re-measured** and could not be — the `needs:` graph lives in
> `.github/workflows/ci.yml`, which is outside this audit slice's editable set, and no CI run was
> performed. Specifically:
> - the heading says **12** jobs, but the table immediately below enumerates only **9**
>   (`workflow-lint`, `forge-unit`, `secret-scan`, `ts-sdk`, `forge-fork-base`, `halmos`,
>   `wallet-e2e-weekly`, `echidna-nightly`, `foundry-canary`). The other 3 are **never named in
>   this file**, so "12" cannot be verified from this document — the table is a selection, not the
>   full job list;
>   - **旁证（非已证）：** 仓库根 `README.md`（不在本切片可编辑清单内）2026-10-01 读到
>     「14 jobs across 2 workflows — `ci.yml` (12)」，与本标题的 **12** 一致；但根 README 同样
>     **未复测**，且根 README 的 Foundry 一行写 **220 tests**、与 `docs/ONBOARDING-2026-09-26.md`
>     引用的「158 tests」不一致。**本审计不选边，只登记不一致。**
> - the "6 个 job 恒 skip / 每个 PR 实际只有 6 个真跑 / 却展示 12 个" arithmetic above inherits
>   the same unverified 12;
> - the `halmos` row's "5/11 规格空转" — neither the 11 Halmos spec count nor the 5 vacuous ones
>   was re-checked (`docs/ONBOARDING-2026-09-26.md` records "11 Halmos specs", also unverified);
> - the cache table's "省 2–3 min × 6 job" and the Actions-minutes budget below it are
>   **estimates, not measurements**.
> All of the above are **left in place as the author's analysis**, not as current fact. Re-derive
> from `ci.yml` before citing. **The 门禁重构 1–11 recommendation rows are unaffected** — they
> are proposals, not measurements.

## 门禁重构（11 条）

| # | 建议 | 工时 |
|---|---|---|
| 1 | **删 `continue-on-error`，改 `allow-failure` 语义**：汇总 job 以 `needs.X.result` 聚合出独立 `WAIVED` 状态。**让"豁免"不再等于"静默"** | 2 h |
| 2 | **`halmos` 条件改事件语义**（`event_name != pull_request`） | 30 min |
| 3 | **豁免机器化**：`check-waivers.mjs` 双向 diff + `Expiry` 未过期断言 → **过期未处理时 job 变红** | 2 h |
| 4 | **`forge-fork-base` 显式化**：写 job output 供汇总 job 把"skip"与"pass"分列 | 30 min |
| 5 | **`.gas-snapshot` 漂移设阈值**（当前只报告不失败） | 1 h |
| 6 | **G0 快速门**：读 `engines` → `npm ci`，不满足即红，**不编译** | 1 h |
| 7 | **G2 合并** `forge-unit`+`forge-invariant` → **省一次 solc 编译** | 30 min |
| 8 | **统一 `npm run test:coverage --workspaces`** | 5 min |
| 9 | **汇总 job 作单一 required check**：**没有它，PR 可合入全红 CI** | 1 h |
| 10 | **`timeout-minutes` 加到全部 job**（挂死当前烧满 360 min） | 20 min |
| 11 | **缓存优化**（forge `out/`+`cache/` artifact 复用） | 1.5 h |

## 缓存收益

| 缓存项 | 现状问题 | 收益 |
|---|---|---|
| **forge `out/`+`cache/`** | 无（6 job 各自编译） | **省 2–3 min × 6 job** |
| **MetaMask 扩展** | 实际 **74.7 MB**（非 49.2 MB）；key 无 restore-keys 且 job 每周一 → **间隔恰好 7 天，缓存几乎必然每次过期重下** | 每周省 24.4+ MB（也是最不可靠 job 的主要 flake 源） |
| Playwright | `hashFiles('package-lock.json')` → **任何依赖变更都击穿**；改 `package.json` | ~1 min |
| pip / solc | 每次装/下载 | ~70 s × 2 |
| node_modules | 每次全量 | **不建议缓存**（跨平台污染） |

**Actions 分钟数**：单 PR 20→12（**-29%**）· nightly 70→48（**-31%**）· canary 12→8（**-33%**）· 发布 35→26（**-26%**）。

## 自举一致性（单一事实源）

| 事实源 | 消除清单 |
|---|---|
| **`package.json` 的 `engines.node`** | ci.yml ×3 + publish.yml ×2 → `node-version-file: .nvmrc`；`.nvmrc` 降为派生产物；Dockerfile 改 `ARG NODE_VERSION`；删 `check-runtime.mjs:26` 与 `bootstrap.mjs:34` 的 fallback（**解析失败即红**）→ 新增 `scripts/sync-facts.mjs` |
| **新增 `scripts/foundry-scope.json`** | `Invariant/Fork` 语义 **7 个消费点** → 改读 JSON，新增 suite 只改 1 处 |
| **`scripts/abi-targets.txt`（已是）** | ci.yml:175-181 与 publish.yml:76-81 的 ABI 循环**逐字重复** → 提取 `scripts/regen-abi.mjs`（**本仓正确范式的推广**） |
| **`check-ci-consistency.mjs`（新）** | 版本一致性 + profile 存在性 + `check_*` 数 == inventory 报告数；放 `workflow-lint`（**~1 min 处发现问题，而非 20 min 处**） |

## 发布门禁强化

**现有 14 步中 0 步涉及：供应链完整性、依赖漏洞、产物签名、canary 观测。**

| 新增 | 阻断 |
|---|---|
| SBOM 生成（`npm sbom`） | **是** |
| 依赖漏洞审计（`npm audit --audit-level=high`） | 是（豁免可放行） |
| 产物签名验证（`--provenance` 已启用 → 补 `attestation verify` + `git tag -v`） | **是** |
| **scope 冲突前移为 preflight job**（当前仅在末尾报错，**整条 assurance 35 min 白跑**） | 是 |
| canary 冒烟（发布后真实 `npm pack` + smoke import，失败自动 deprecate） | 是 |

## 本地/CI 一致性（**差距在 5 个维度**）

`verify.mjs` 与 `npm test` **都不跑 invariant**；**默认 `FOUNDRY_PROFILE=default`(fuzz 256) 而非 `ci`(2000)**；**也不含 slither 与 gitleaks**。

**修复**：① `verify.mjs` 增 `invariants` 阶段（**注意 forge ≥1.x 已移除 `--invariant-runs` CLI flag，深度只能走 config**）+ `--profile` 默认 `ci`；② `verify:pr` 精确复刻；③ **报告尾打印"本次未覆盖的 CI 门"**（最诚实，成本极低）。

## 安全 CI（3 条 P0）

| # | 问题 | 修复 |
|---|---|---|
| 1 | **actionlint `curl | bash` 执行 `main` 分支** → 上游被投毒 = CI 全量 RCE | 固定版本 + SHA256，或 `docker://rhysd/actionlint:1.7.7` |
| 2 | **gitleaks allowlist 过宽** → 排除整个 `wallet-e2e/` 含 **8 个被跟踪的 harness 源文件** | 收窄到只匹配 `metamask.*`；加 CI 断言 allowlist 不得覆盖任何 `git ls-files` 命中的文件 |
| 3 | **gitleaks 产出未 gitignore**（~40 MB + tar.gz） | 加进 `.gitignore`；或输出到 `${RUNNER_TEMP}` |

其余 P1：fork PR secrets 守卫 · **全部 action pin 40 位 SHA**（Dependabot 已配 `github-actions` ecosystem）· echidna 脱离第三方 action · `permissions: contents: read` 顶层。

**正面样板**：MetaMask zip 的 **SHA256 校验 + fail-closed**（AC-04）是本仓安全实践标杆，应作为其他远程获取物的模板。

## VTS-D 优先级

| 优先级 | 内容 | 成本 |
|---|---|---|
| **P0 本周** | 修 actionlint + 收窄 allowlist + gitignore gitleaks + fork 显式 skip | **1.3 h** |
| **P1 两周** | check-waivers · verify 补 invariant+profile+timeout+日志 · 合并 forge job · cache-forge · action pin SHA · 汇总 job · timeout-minutes | **~10 h** |
| **P2 一月** | sync-facts · foundry-scope.json · regen-abi · SBOM+audit · preflight job · flaky-report | **~14 h** |

---

# 第五部 · VTS-E UAT + 发布验证 + 生产运维

## 就绪度判定

| 发布目标 | 判定 | 主要原因 |
|---|---|---|
| 本地 Anvil 演示、开发者内部验证 | **条件 Go** | 须针对当前提交重新执行完整验证，不能复用历史日志 |
| 封闭 Beta、从源码/本地 tarball | **条件 Go** | 仅限测试网、限额、短 session key、Safe 治理、人工监控 |
| 公共 npm 发布 | **No-Go** | `@sigilkit/*` scope 被占；`@sigilkit/core` 会安装错误包 |
| 公共生产服务 / indexer / MCP | **No-Go** | 无正式 UAT、SLO、Dashboard、值班、发布后验证 |
| 持有真实资产的主网发布 | **硬 No-Go** | 未外部审计；钱包 E2E、真实 7579 账户/bundler、immutable 回退均未形成保证 |

**系统性根因**：assurance 以"工具是否通过"为中心，而非"用户能否完成任务、运营者能否恢复"为中心 —— `publish.yml:19-20` 明确说 fork/钱包 E2E/Echidna/canary **不是发布门禁**；`continue-on-error` 和"skip but success" 使未执行项看起来像绿色。

**立即缓解措施**：① 只用 Anvil 或测试网，**禁止真实资金**；② owner 必须 2-of-3 Safe/Timelock，**广播 key 与 owner 分离**；③ session key 短有效期、低额度、精确白名单；④ 单 indexer writer，SQLite **不放 NFS**；⑤ 每日备份，reorg 恢复**用新库不改游标**；⑥ **不发布、不推广 `@sigilkit/*`**；⑦ 疑似泄露立即撤销换新地址，**禁止重新授予原泄露地址**。

## UAT 分层与通过条件

| 层级 | 内容 | 频率 | 阻断发布 |
|---|---|---|---|
| L0 开发者冒烟 | 部署、SDK 执行、indexer/MCP 启动 | 每次提交 | 是 |
| L1 发布候选 UAT | UAT-01～11 | 每 RC | 是（P0/P1 100%） |
| L2 运维演练 | key 泄露、RPC 故障、DB 恢复、reorg、回滚 | 上线前 + 每月 | 主网是 |
| L3 审计/合规验收 | 导出、独立重算、重组后重发 | 每 RC + 季度 | 对外合规声明是 |
| L4 Beta soak | 真实使用、反馈、事故观察 | 2–4 周 | 扩大用户前 |

**通过条件**：① P0/P1 用例 100% 通过；② **0 次越权执行、0 次 owner 绕过、0 次"成功但无 `ActionLogged`"**；③ 实际钱包 + 实际 relayer + 至少一个真实 7579 账户均有证据；④ MANUAL 证据必含 commit/链/钱包版本/运行 ID/预期/实际/审查人/证据 SHA-256；⑤ **`continue-on-error`、缺环境而 skip、仅静态 inventory 均不得计为绿色**；⑥ P0/P1 缺陷关闭，P2 有 owner+到期日+workaround+风险接受人；⑦ 文档无事实矛盾；⑧ **回滚演练与索引恢复演练必须成功，而不只是书面描述**。

## 11 条验收用例

| ID | 场景 | 关键判据 | 验收人 |
|---|---|---|---|
| UAT-01 | agent 正常执行 | 逐笔核对 receipt/目标/`ActionLogged`/`WindowCharged`；indexer backfill 后**链/SDK/SQLite 三方一致** | Dev + QA |
| UAT-02 | **agent 被攻陷后超范围** | 5 种绕过（树外 target/selector/calldata 不匹配/owner-only selector/超 cap）；**即使完全控制 SDK+relayer+key 也不能突破** | **Security（否决权）** |
| UAT-03 | 额度耗尽 | 第三笔必 `PerWindowCapExceeded` 且 **nonce/余额/事件/窗口全回滚**；报告须说明 tumbling 跨边界语义，**不能宣传为严格滑动窗口** | Contract + Security |
| UAT-04 | key 过期 | 无 inner call/余额变化/nonce 变化/成功事件；**过期请求不能靠重放或换 relayer 恢复** | Security |
| UAT-05 | key 被吊销 | 撤销后**已签名**的请求也必拒；**不得误把原泄露 key 重新启用**；Safe 单签名者无法撤销 | DAO Owner + Security |
| UAT-06 | owner 治理恢复 | 单 signer 全失败 → 2-of-3 成功；**5 分钟内完成**；**广播 deployer key 不具备 owner 权限** | DAO Owner + Ops |
| UAT-07 | 7702 授权与撤销 | 撤销后 code 为 `0x`；**非 7702 code 必须被拒绝解释**；**不得依赖已知会被拒绝的 raw zero-address `eth_sendTransaction`**；钱包提示须说明**一次 delegation 签名 = 持久账户控制而非单次授权** | Wallet + Security |
| UAT-08 | 7579 安装/验证/执行 | **不得以当前 mock `Account7579` 代替**；**验证所有执行路径都先经 validator，不能仅装 executor 绕过 validation** | Account + Security |
| UAT-09 | 审计事件完整性 | 100 成功 action **100% 有记录**、25 失败 **0 条成功记录**、同 tx 多 log 不合并、**三方差异为 0**；**`agentId` 在 7579 路径不是第三方身份认证** | 独立审计员 |
| UAT-10 | indexer 续扫与重组 | `commitRange` 已把日志与 cursor 放入**同一事务**；hash mismatch → **写入前 fail closed**；**`rollbackTo` 会清空 hash，不是恢复路径**；恢复必须新库 + diff + 切换 | Ops + 审计员 |
| UAT-11 | MCP 工具可用性 | **`audit_query` 严格只读，不创建目录/表/数据；缺 DB 返回 not found 不静默创建** | Dev + QA |

**UAT-10 发现的文档缺陷**：`docs/DEPLOYMENT.md:270` 仍称事件行与 cursor **分开提交**，已与 `indexer.ts:390-410`（同一事务）不一致，**发布前必须修正**。

## Go/No-Go 关键项

**安全**：外部审计状态明确 · 0 个未解决 Critical/High · Medium 有签字+期限+缓解 · 真实钱包 7702 通过 · 真实 7579+bundler 通过 · **所有 release-critical waiver 已清除或书面限时接受**。

**文档**：STATUS 指向真正 active catalog · README/白皮书/SECURITY/CHANGELOG 对「未审计/是否发布/测试数/Halmos 数/immutable 恢复」一致 · **不存在"按文档会安装错误包"的路径** · **Slither 统计范围有一份规范快照**（当前 `SECURITY.md` 与 `CI-WAIVERS.md` 范围/时间不同，**不能不解释地并列**）。

**发布**：namespace 已解决 · 三 tarball 在 clean-room fixture 安装通过（**不得 fallback 到 registry 同名包**）· tag/provenance/checksum/SBOM 齐全 · 预发布用独立 dist-tag。

**运维**：metrics/Dashboard/告警可用 · 至少完成一次 RPC/DB/key/reorg 演练 · 备份可恢复且 RTO 达标 · **SLO 有可查询的 SLI 数据，而不是文档目标**。

**回滚**：四层分别演练 · **immutable 合约恢复 = 资金迁移 + 旧权限撤销 + 7702 重新授权** · **参与方知道：合约不能通过切换镜像回滚**。

## immutable 设计下的回滚

| 发布面 | 可否回退 | 策略 |
|---|---|---|
| npm | 可"逻辑回退"，**不能依赖 unpublish** | `npm deprecate` + 发布修复版 + 文档指向最后良好版本 |
| Indexer | 可回退镜像，**but DB migration 未必可逆** | 升级前备份；停 writer；恢复前验证 schema 兼容 |
| MCP | 可回退镜像 | 只读服务回退；核对查询 schema |
| **Contracts** | **不能原地回滚** | 部署新版本并**迁移资金、权限和用户** |

**合约恢复流程**：冻结所有 agent/relayer/新 key → 宣布旧版本受影响 → 部署新合约 + Safe ownership/code hash 验证 → 撤销旧 session keys（overlap=0）→ 7702 用户撤销旧 delegation 并授权新 canonical → Safe 迁移资金 → 7579 装新 module/executor 并移除旧权限 → 更新 SDK/indexer/配置 → 验证旧权限/key/delegation 均无法再生效 → 清空后保留**只读归档而非假装可升级**。

**不能依赖"从旧 manager transfer ownership 到新代码"实现代码升级** —— 迁移的是资产和用户授权，不是合约实现。

## 生产运维

**监控缺口**：① **进程活着不代表数据新鲜**；② **文件存在不代表 SQLite 未锁/未损坏/RPC 正常**；③ 无 metrics/cursor lag 告警/SLO 仪表板；④ 无 reorg、owner mismatch、delegation 定期 probe；⑤ **项目没有内建 relayer**，其 SLA 由部署方承担。

| 告警 | 阈值 | 等级 |
|---|---|---|
| scope 绕过 / owner mismatch / 非预期 delegation | **任意一次** | **SEV-1** |
| **成功交易缺 `ActionLogged`** | **任意一次** | **SEV-1**（INV-3 违规） |
| cursor 重组 / 校验失败 | 任意一次 | SEV-1/2 |
| cursor lag | >2 min warning；>5 min critical | SEV-2 |
| RPC 连续失败 | 3 poll 或 5 min | SEV-2 |
| SQLite lock | >30 s warning；>60 s critical | SEV-2 |
| 磁盘 | >80% / >90% | SEV-2 |
| **revoke 失败/无法执行** | **任意一次** | **SEV-1** |

**最小 SLO（待校准目标，非已达成；先采集 ≥14 天基线）**：越权执行/owner 绕过/成功审计丢失 = **0 容忍 ×3**；Indexer freshness 99.5% 采样中 cursor ≤ `max(12, 2×confirmations)` 块；可用性 Beta 99.5% / 主网 99.9%；摄入延迟 P95 ≤30 s、P99 ≤2 min；**Session key 紧急撤销告警后 5 分钟内 100% 完成**；Indexer 恢复 RTO ≤60 min、**逻辑 RPO=0**。

**值班**：主网真实资金 = **24×7 primary/secondary**；SEV-1/2 每 15 min 状态更新；涉及安全由 Security + Safe owner 共同决策；**交接含未解决告警、当前 cursor、备份、开放 key revoke、临时 workaround**。

## Runbook（8 场景要点）

| 场景 | 止损 | 恢复 | 退出标准 |
|---|---|---|---|
| **Reorg / cursor hash mismatch** | 停写者或保持 fail-closed；**保存 DB；禁止 `rollbackTo`** | **新 DB 从部署块重建**；双 RPC 交叉验证；diff 后切换 | 两周期无 mismatch，lag 恢复 |
| 游标损坏 / legacy null hash | 保留原库+备份；**禁止手工改 hash** | 新库从部署块重建 | 新 cursor 有有效 hash，对账零差异 |
| RPC 挂 | **停止依赖不可信 RPC 写入** | 切换到交叉验证过的 RPC | 连续成功 commit，lag 回落 |
| DB 锁 | 找第二个 writer；**Windows `EBUSY` 关闭所有持有句柄进程** | 干净重启；必要时从备份/链上重建 | 唯一 writer，`integrity_check` 通过 |
| **Session key 疑似泄露** | **立即停 agent/relayer；Safe revoke；换新地址** | 新 key/scope；查 nonce/事件/余额 | 旧 key `KeyRevoked`，**无后续成功 action** |
| Owner/Safe 失控 | 冻结发布；准备新 Safe | 旧 owner 转新 Safe；撤销全部 key；迁移资产 | 旧 owner 失效，新 Safe 验证成功 |
| **成功交易缺审计事件** | **立即停 agent/relayer，撤销 key，保留 receipt** | 安全事件调查；评估补偿与合约修复 | 根因/影响/修复/回归测试完成 |
| 7702 delegation 泄露 | 暂停签名与部署 | 撤销旧 delegation，授权新 implementation | `getCode` 为 `0x` 或仅指向新 canonical |

**Reorg 特别规则**：hash mismatch 时**不自动回滚**；**`rollbackTo` 会清空 cursor hash，不是恢复路径**；**一个 DB 只放一个 manager**（当前删除/rewind 是 chain-wide）；深重组需两个独立 RPC。

**DB 锁特别规则**：**不使用 NFS/网络共享目录**；**Windows `EBUSY` 时关闭所有持有 SQLite handle 的进程**；完整性检查失败时**不在原库反复修补**，保留证据并从链上重建。

**事故复盘**：2 个工作日初版时间线、5 个工作日完成复盘、每周跟踪至关闭。必含：**为什么现有测试/告警/runbook 没提前发现**。

## Beta 与合规验收

**8–12 个 design partners**：Cohort A（5 个开发者团队，含至少一个非 SigilKit 框架）· Cohort B（3 个 DAO，**至少两名 signer 参加撤销/恢复演练**）· Cohort C（1–2 个审计方，**对外声明口径有否决权**）。

**退出 Beta 最低条件**：连续两周无 P0/P1 · **100% 用户完成撤销演练** · 90% 核心任务无需维护者实时介入 · UAT/审计导出无完整性差异。

**AC-09 手工证据可规模化条件**：① MANUAL leg 在 release gate 中**单独签核**（不能仅靠自动腿决定绿色）；② 每 leg 用**稳定 ID** 而非自由文本；③ 记录 commit/runner/wallet 版本/chain/预期签名与结果；④ **安全相关的 connect/sign/revoke 由第二人复核**；⑤ 证据按 wallet/framework/version 设**有效期**；⑥ **尽量自动比较签名/receipt/delegation 状态，不能只依靠截图**；⑦ MANUAL 数量应持续下降；⑧ 证据存为结构化 JSONL/制品并签名。

**合规验收四条限制**：① actions 表**无 manager ownership 列** → 正式导出必须坚持**一库一 manager**；② `agentId` 是声明/账户绑定，**不是 attestation**；③ `rationaleHash` 只有外部保存了明文+签名才能证明；④ **不能把 native `value` 当作全部资产流**（token 内部转账需依赖余额 delta/reconciliation）。

**在 Advanced 能力实现前，对外统一称"可查询/可对账审计导出"，不称"密码学证明式审计"**。
