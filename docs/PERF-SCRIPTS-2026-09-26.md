# scripts 性能与资源占用报告 — 2026-09-26

> 范围：`scripts/` 目录下的 14 个可执行 `.mjs`。**本报告只读测量，未修改任何脚本。**
> 机器：Windows 11 / PowerShell 7 / Node v24.12.0 / **28 逻辑核** / 15.7 GB RAM
> forge：`C:\Users\dev25\.foundry\bin\forge.exe`（**不在 PATH 上**）
> 测量方法：`[System.Diagnostics.Stopwatch]` 墙钟计时；`verify` 的分步数据取自它自己 `--json` 报告的 `durationMs`（权威值）。
> 冷热说明：forge 编译缓存冷热差异达 8 倍（冷 13.4s / 热 1.6–2.1s），所有 forge 数字均标注冷热。
>
> ## 📌 团队硬规范（本次事件催生，提议全仓执行）
>
> **规范 1 — 运行类结论必须绑定落盘日志。**
> 任何运行类结论（测试计数、PERF 数字、tsc/build 退出码）**必须附一份落盘日志**，
> 路径固定 `outputs/verify/`，带时间戳 **+ 环境状态**（junction 是否可用、alias 是否启用、是否干净检出）。
>
> **理由已由 2026-09-26 的 T4 事件证明**：
> `node_modules` 被清空后，**`node_modules/@sigilkit` 4 个 junction 全部消失**，
> 所有依赖它才能重跑的证据**一次性归零**；
> 而 `outputs/verify/*-typescript-tests.log` **存活了下来**，
> **正是靠它才读出 `core 实跑 521/533 个用例`，从而纠正了「4 个包全 0 测试」的错误归因。**
> **没有落盘日志，这个错误会被永久掩盖。**
>
> **规范 2 — npm 日志会轮转，因果推断前先确认日志还在。**
> `npm config get logs-max` = **10**（**sc-perf 实测复核**，ix-mcp-sec 曾报「31 个」——那是更早的快照）
> 日志自身也声明 `logfile logs-max:10`。
> **⇒ 只保留最近约 10 个**，`install` 产生的日志会被后续 install 迅速轮转掉。
> **实测轮转速度**：某一刻磁盘上有 **12** 个（覆盖 18:48:27–18:59:14 共 11 分钟）；
> 稍早 ix-mcp-sec 看到 **31** 个、我看到 **11** 个 —— **同一目录，11 分钟内从 31 → 11**。
> **⇒ 日志数量是分钟级变化的活数字，任何「我扫了 N 个日志」的表述都必须带时间戳。**
>
> **建议全仓默认 `npm config set logs-max 200`**，或在 install 前后立即归档 `%LOCALAPPDATA%\npm-cache\_logs\`。
> **本报告即吃过这个亏**：定位 T4 触发器的 `npm install yaml@2.9.1 --no-save` 日志
> **在 18:20 尚可读、18:30 已消失**，导致该因果结论至今**无法复核**。
>
> **规范 3 — junction 未修好的机器上，禁止 `npm install --no-save` 补依赖。**
> 该操作会重排 `node_modules` 树，而本机 junction 不可读（`-4094`）→ reify 中途失败 → **树被留在半清理状态**。
> **这正是 T4 的触发器。** 恢复依赖必须先 `Remove-Item -Recurse -Force node_modules` 再装。
>
> **规范 4 — 验证 junction 必须穿透，元数据不作数。**
> `lstat` / `LinkType` / `Target` **全部正常也可能完全不可用**（本例即如此）。
> **唯一有效探针**：`statSync('node_modules/@sigilkit/<pkg>/package.json')` 或 `realpathSync`。
> **判据**：`lstat` 成功 ≠ junction 可用。
>
> **规范 5 — 跨包符号报错先分流错误类型。**
>
> | 症状 | 真实原因 | 该查 |
> |------|---------|------|
> | `ERR_MODULE_NOT_FOUND` / `TS2307` / `ERR_UNSUPPORTED_ESM_URL_SCHEME` | **junction / 解析层** | `node_modules` 链接（用规范 4 的探针） |
> | `TypeError: x is not a function`（模块**已加载**） | 真的缺导出 | 自己的 import / re-export 链 |
>
> 坏 junction 下模块**整体加载失败**、直接抛 `ERR_MODULE_NOT_FOUND`，
> **不可能**返回一个「少了符号的命名空间」——**所以 `TypeError` 永远不是 junction 的症状。**
>
> **规范 6 — 临时/待删目录里的证据等于没有证据。**
> 清理任何目录前，**先确认里面没有别人（或自己）的唯一证据**；证据应**先归档到 `outputs/verify/` 再清理**。
>
> **理由（2026-09-26 实际发生）**：`outputs/.ix-test-harness/final-mcp2.log` 是 mcp `129 passed / 130`
> 这组结果的**全仓唯一副本**（实测：全 `outputs/` 下 `(130)` 仅此 1 处命中）。
> 而 `clean.mjs` 的 `DANGEROUS_PATHS = ["broadcast", "outputs"]`（`scripts/clean.mjs:79`）
> **把整个 `outputs/` 列为需确认的危险路径** ⇒ **该日志在 `outputs/` 下，任何针对 `outputs/` 的清理都会连带删除它。**
> **它当时还被标注为「待删临时目录」。** 若真的删除，这条唯一运行证据即永久丢失。
>
> **规范 7 — `logs-max` 只对 `*-debug-0.log` 生效。**
> 同目录下 `*-eresolve-report.txt` **不受轮转约束**，统计日志数量时**必须按文件名分类**，
> 否则会把「不受轮转的旧文件」误算成「被轮转的日志」，得出不存在的「轮转吃掉了 N 个日志」现象。
> （**本报告曾犯此错**：把 31 个文件整体当作轮转日志，实为 `11 个 debug-0.log` + `20 个 eresolve-report.txt`。）

> ## 🔴 最高优先级警告：本报告的运行类数据已被环境变化作废（T4）
>
> **2026-09-26 约 18:07 前后，`node_modules` 被清空。** 实测：`node_modules` 仅剩 `@noble` + `viem`；
> `@sigilkit/`、`vitest`、`typescript`、`yaml` **全部不存在**；`npx vitest` → `Cannot find package 'vitest'`。
>
> **⇒ 报告中一切「运行 vitest / 跑工作区测试」得来的数字，此刻都无法复现。** 包括：
> * §4.1 / §4.2 的 `--with-ts` 全部耗时
> * §1.3 的 `tests` 步 44.8s 与其内部 4 个 workspace 拆解
> * §3 L1 的 `.vite-temp` 具体数字（**原始文件已被一并删除**）
>
> **⇒ 但以下结论仍然成立且不依赖依赖树**：
> * **B1 / B2 的 89.4s 基数与 45–50s / 16–18s 收益**（走 `node --test` 与脚本自身逻辑）
> * **§1.3 的 `tests` 步 44.8s**（✅ **已用日志证明建立在真实运行的测试之上**：core `516 passed / 521`，`Duration 26.42s`）
> * **§4.3 的 730 声明 / 31 `.each`**（纯静态源码计数）
> * **§3 L2 / L3 / L4**（证据在 `outputs/` 与 `%TEMP%`，未被 T4 触及）
>
> **时间线与逐项影响见 §4.2「T4 已使本报告的运行类证据全部不可复现」。**
>
> ---
>
> ## ⚠️ 勘误（2026-09-26，本报告 §4.2 / §4.4 已按此修订）
>
> **原 §4.2 把「`mcp/dist` 4 文件、`indexer/dist` 6 文件」读成「产物不完整」是错的。**
> 那是**正常映射**：`src` 每个 `.ts` → `dist` 一个 `.js` + 一个 `.d.ts`。实测 src→dist 比值：
> `indexer 3→6` · `mcp 2→4` · `demo-agent 5→10` · `core 12→36`（含 `.map`）。
> `config.d.ts` / `logger.d.ts` **不属于 mcp**，它们是 `@sigilkit/core` 的**子路径导出**，
> 而 `core/dist/` **确实包含** `config.d.ts` / `logger.d.ts`，`core/package.json` 也已声明 `./config` 与 `./logger`。
>
> **真实根因是本机 `node_modules/@sigilkit/*` 的 junction 悬空**（团队级结论，ix-mcp-sec / team-lead / ix-perf 三方独立验证）。
> sc-perf 已独立复现，**并取得更精确的失效形态**（见下方探针表）：
> **`lstat` 成功，但 `realpath` / `readdir` / `stat` 全部返回 `UNKNOWN (errno -4094)`。**
> **目标目录 `packages/core/` 本身完好**（直读 `packages/core/dist/config.d.ts` = True）。
> ⇒ **悬空链接：元数据对、目标在、路径不通。**
>
> | 探针 | 结果 | 含义 |
> |------|------|------|
> | `fs.lstatSync(node_modules/@sigilkit/core)` | **`OK`** | ⚠️ **元数据正常——最容易骗人的一环** |
> | `fs.realpathSync(...)` | **`UNKNOWN (errno -4094)`** | 路径解析失败 |
> | `fs.readdirSync(...)` | **`UNKNOWN (errno -4094)`** | 目录不可遍历 |
> | `fs.statSync(.../core/package.json)` | **`UNKNOWN (errno -4094)`** | 文件读不到 |
> | `import('@sigilkit/core/config')` | **`ERR_MODULE_NOT_FOUND`** | Node 解析失败 |
> | 直读 `packages/core/package.json` | **`OK`** | **目标完好** |
>
> **验证 junction 必须「穿过去读一个真实文件」，不能只看 `LinkType`/`Target` 元数据**——元数据正常而路径不通，是本例的陷阱。
>
> **§4.2 的全部耗时数字因此是「失败态耗时」，不是「该检查的性能」。** 详见下文修订。
>
> **团队级规则（永久，采纳自 ix-mcp-sec）**：按**错误类型**分流，不要按表象相似度分流：
>
> | 症状 | 真实原因 | 该查 |
> |------|---------|------|
> | `ERR_MODULE_NOT_FOUND` / `TS2307` / `ERR_UNSUPPORTED_ESM_URL_SCHEME` | **junction / 解析层** | `node_modules` 链接 |
> | `TypeError: x is not a function`（模块**已加载**） | 真的缺导出 | 自己的 import / re-export 链 |
>
> 判据是「**模块到底加载成功没有**」：坏 junction 下模块**整体加载失败**、直接抛 `ERR_MODULE_NOT_FOUND`，
> **不可能**返回一个「少了符号的命名空间」，所以 **`TypeError` 永远不是 junction 的症状**。
> 补充：**跨包符号问题先看源码有没有 `export`，再看运行时**——静态检查比运行时试探更早给答案。
>
> **另一条永久结论（永久采纳，不限于本报告）**：
> 本仓库任何「某符号 is not exported / is not a function / TS2307」
> 都应**先怀疑 junction，而非导出缺失**。三个包根入口互相 import，根入口解析不了，
> **所有**跨包符号都会表现为「导出缺失」。
>
> ### 判据有效性规则（方法论，永久）
>
> **一个判据如果在其目标对象缺席时仍然返回「通过」，它就不是守卫，是装饰。**
>
> 判据必须有一个**存在性前置断言**：先证明被检查的对象**存在且可读**，再检查它的属性。
> 缺失必须**响亮失败**，不能退化成「0 个问题」或「通过」。
>
> 本轮踩坑实例（cr-perf，两次同型）：
>
> | # | 判据 | 目标缺席时的输出 | 被误读为 |
> |---|------|------------------|----------|
> | 1 | `npm run build … \| Select-String 'error TS' \| Measure-Object` | **0** | 「build 已修好」 |
> | 2 | 探针用 `node_modules/typescript/bin/tsc` 作 Node 入口 | **0 个 TS2307** | 「paths 方案已验证」 |
>
> 两次都是**检查器从未启动**，输出与「零缺陷」逐字节相同。根因是**同一个**：
> `typescript` 被卸载/重装中，且 **`bin/tsc` 是 shell 脚本、不是 JS 入口**。
>
> **可复用的两种防御**（本次均已验证有效）：
>
> 1. **入口存在性断言**：`fs.existsSync('node_modules/typescript/lib/tsc.js')` 为假则**立即抛错**。
> 2. **执行痕迹断言**：捕获输出中出现 `is not recognized as an internal or external command`
>    等「命令未执行」特征时**抛错**，而不是把它当成「0 个错误」。
>
> ⚠️ **注意本次的教训不对称**：实例 2 我给探针**写了**这个防御，实例 1 我**没写**。
> 同一个人、同一个上午、同一类错误，**一次靠机制避免、一次靠事后复核**。
> ⇒ **只有机制可靠，经验不可靠。** 手敲的 shell 管道同样需要断言，不能因为「我认识这个命令」就豁免。
>
> **跨条目推广**（同型判据失效，本轮已被多处独立发现）：
> * ck-test X-34「有测试引用 ⇒ 它被负责」——判据在**没有断言**时也通过。
> * ix-test 变异 5「删掉 fail-closed 整段，52/52 全绿」——两个拒绝点**共用错误码**，判据无法区分。
> * ck-evt「warning ⇒ 会红」——warning 的**产生条件与失败的产生条件不同构**。
>
> 共同形态：**判据的目标缺席时，它返回「通过」而不是「无法判断」。**
> 修法统一为：把「无法判断」变成一个**独立的、可观测的失败态**。
>
> **本规则的应用实例（已指派 sc-gate）**：`check-doc-counts.mjs --with-ts` 当前在
> junction 坏掉时，4 个 vitest 全部报 `numTotalTests: 0` + `success: false`，
> 而脚本仍能**跑满 8.6 秒并产出 3 个假数字**而不中止（详见 §4.2 / §4.4）。
> ⇒ 应加**双闸**：(a) `numTotalTests === 0` 直接 fail-closed；
> (b) 运行 vitest 前**先断言 `node_modules` 下 `typescript` 与 `vitest` 真实可读**（而非只看 `.bin` shim 存在）。
>
> **为什么这条规则对本报告尤其重要**：§4.1/§4.2 的 `--with-ts` 数字本身就是「失败态耗时」，
> 而失败态**长得和成功态一模一样**（都是「0 个测试」）。本节是该数字不可信的**机制性说明**，
> 而非事后补注。

---

## 1. 耗时表

### 1.1 `verify.mjs` 逐步（权威，来源 `--json`）

> 🔴 **时点声明（sc-gate 复核后补充）**：本节数据测于 **9 步版本**。
> **当前 `verify.mjs` 已增至 10 步**（`LABELS` 新增 `docslocation`），**故 89,383ms 不再是当前基线。**
> **但本节每一行仍是真实测量**，且两个大头（`tests` 44.8s / `helpers` 33.4s）**不受第 10 步影响**。
>
> **第 10 步的实测成本**：`node scripts/check-doc-location.mjs` = **173 ms**（exit 0），
> 对总量影响可忽略（< 0.2%）。**⇒ 修正后估计基线 ≈ 89.6s**，仍需依赖恢复后复测确认。
>
> **当前 10 步的实测执行顺序**（`await run(...)` 行号，sc-gate 复核 + sc-perf 二次确认）：
> ```
> L596 lint        L597 packaging    L600 helpers(多行)
> L629 docs        L635 docslocation L638 build
> L639 typecheck   L643 artifacts    L655 contracts   L658 tests
> ```
> **仍是 10 个连续 `await`，零重叠** ⇒ §5 的并行化前提**依然成立**，且多一个可并发的步。

`node scripts/verify.mjs --quick --json` → **总墙钟 89,383 ms**，步进和 = **89,241 ms**。
两者相差 142 ms ⇒ **当前是完全串行、零重叠**（见 §5）。

| # | step (key) | 耗时 | 占比 | > 1s | > 10s |
|---|------------|------|------|------|-------|
| 1 | `tests` TypeScript 测试 | **44,848 ms** | 50.2% | 是 | **是** |
| 2 | `helpers` 辅助回归套件 | **33,384 ms** | 37.3% | 是 | **是** |
| 3 | `docs` doc counts | **5,166 ms** | 5.8% | 是 | 否 |
| 4 | `typecheck` 工作区类型检查 | 3,145 ms | 3.5% | 是 | 否 |
| 5 | `build` 工作区构建 | 2,257 ms | 2.5% | 是 | 否 |
| 6 | `lint` workflow lint | 223 ms | 0.2% | 否 | 否 |
| 7 | `artifacts` 包产物 | 118 ms | 0.1% | 否 | 否 |
| 8 | `packaging` Dockerfile 静态检查 | 100 ms | 0.1% | 否 | 否 |
| 9 | `contracts` forge 合约测试 | 0 ms（`--quick` 跳过） | — | 否 | 否 |
| | **合计** | **89,241 ms** | | | |

> 完整非 quick 门禁还要再加 `contracts`（`forge test`），本机未测（forge 不在 PATH，需 `FORGE_BIN`）。

### 1.2 Top 10 慢脚本（独立测量）

| 排名 | 命令 | 耗时 | 阈值标注 | 说明 |
|------|------|------|---------|------|
| 1 | `npm test --workspaces --if-present` | **42,648 ms** | > 10s | verify 的 `tests` 步；4 个工作区**串行** |
| 2 | `node scripts/verify.mjs --quick` | **89,383 ms** | > 10s | 全门禁（串行） |
| 3 | `node scripts/bootstrap.mjs` | **38,314 ms** | > 10s | 一次性脚手架，exit 1（非门禁） |
| 4 | `node --test <7 个 helper 套件>` | **32,492 ms** | > 10s | verify 的 `helpers` 步 |
| 5 | `node scripts/check-doc-counts.mjs --with-ts` | **33,310 ms**（冷）/ **68,803 ms**（重测） | > 10s | ⚠️ **失败态耗时，非性能基线**——T1 时 3/4 vitest 未跑到任何测试；**T2 重测为 4/4 全 0**。见 §4.2 时效性警告 |
| 6 | `node --test scripts/verify.test.mjs` | **22,616 ms** | > 10s | helpers 里最慢的一个文件 |
| 7 | `forge test --list`（冷） | **13,402 ms** | > 10s | `check-doc-counts` 的内部调用 |
| 8 | `node --test scripts/benchmark-indexer.test.mjs` | **11,633 ms** | > 10s | 真实 SQLite 基准测试 |
| 9 | `forge test --list`（热） | 1,626–2,179 ms | > 1s | 缓存热 |
| 10 | `node scripts/clean.mjs` | 5,465 ms | > 1s | 见 §3 泄漏 |

**亚秒级（< 300 ms，无需优化）**：
`validate-workflows.mjs` 130 ms · `check-dockerfile.mjs` 67 ms · `check-package-artifacts.mjs` 59 ms · `check-vectors.mjs` 68 ms · `check-runtime.mjs` 65 ms · `check-waivers.mjs` 141 ms · `assurance-inventory.mjs` 298 ms · `sync-facts.mjs` 115 ms · `generate-vectors.mjs` 361 ms · `benchmark-indexer.mjs` 713 ms · `_dbg.mjs` 71 ms。

> **`node` 冷启动基线约 60–70 ms。** 8 个守卫脚本的耗时 59–298 ms 几乎全部是解释器冷启动 + 少量文件读取，本身没有可优化空间。**不要为它们做任何优化投入。**

### 1.3 `tests` 步（44.8s）内部拆解

`npm test --workspaces --if-present` 按 **workspace 严格串行**（npm 默认），逐个测：

| workspace | 耗时 | 占比 |
|-----------|------|------|
| `@sigilkit/core` | **25,018 ms** | 56% |
| `@sigilkit/mcp` | 7,995 ms | 18% |
| `@sigilkit/demo-agent` | 5,113 ms | 11% |
| `@sigilkit/indexer` | 3,638 ms | 8% |
| 合计 + npm 编排开销 | ~42.6s | |

**core 一家占 56%**，且 `vitest.config.ts` 已用 `pool: "threads"` + `fileParallelism: false` + `isolate: false`（注释标注为 PERF-2 优化）。剩余时间是 Anvil 子进程串行化的固有成本。

> ✅ **勘误（2026-09-26，从日志复查后）**：我曾担心「这 44.8s 是在 4 个包全 0 测试下测的，依赖恢复后会变」。**该担心不成立，撤回。**
> `outputs/verify/2026-09-26T11-02-44-538Z-typescript-tests.log` 证明该步走 `npm test --workspaces`，
> **core 实测 `Tests 4 failed | 516 passed | 1 skipped (521)`、`Duration 26.42s`**——
> **不是 0 个测试，而是一个接近满负荷的套件。** demo-agent 7 failed(7) / indexer 7 failed(7) / mcp 2 failed|2 passed(4)。
> **⇒ §1.3 的 44.8s 与 B1 的 89.4s 基数建立在「真实运行的测试」之上，不因 T4 而需要重估。**
> **⇒ 仍需重估的只有 `--with-ts`（§4）**——它绕过 `pretest`，与本步走的不是同一条路径。

---

## 2. 瓶颈清单（含预估优化收益）

> 「预估节省」是按实测数据推算的**上界**，不是承诺值。每项都标了推导依据。

### B1 — `verify.mjs` 9 步全串行，零重叠 【收益最大：89.4s → 约 40s】

* **位置**：`scripts/verify.mjs:542–579`（9 个连续 `await run(...)`）
* **实测证据**：步进和 89,241 ms = 墙钟 89,383 ms，差值 142 ms。**当前没有任何一步在等待时让出重叠。**
* **机器有 28 核**，而最重的两步（`tests` / `helpers`）彼此**无数据依赖**，且都不碰 Anvil 端口 8545（实测：`verify.test.mjs` / `benchmark-indexer.test.mjs` / `check-doc-counts.test.mjs` 中 `8545|anvil` 匹配数 = **0**）。
* 完整方案见 **§5**。保守估算 **省 45–50s**。

### B2 — `verify.test.mjs` 串行 spawn 58 次完整门禁 【收益：22.6s → 约 6s】

* **位置**：`scripts/verify.test.mjs:52–61`（`runVerify` helper，`spawnSync`）
* **实测**：`runVerify(` 调用 **58 次**，另加 `spawnSync(process.execPath…)` 3 次、`spawn(process.execPath…)` 3 次、`test(` 声明 **51 个**。
* **根因**：`runVerify` 用 `spawnSync`，而 `node --test` 的并发模型对**同步阻塞调用无效**。58 次串行 spawn 叠加 7 个含 ~2,000 ms 超时预算断言的用例 ⇒ 22.6s。
* **最慢的 12 个子测试**（`--test-reporter=tap` 的 `duration_ms`）：
  `4,560` · `2,818` · `2,218` · `2,017` · `2,014` · `2,008` · `1,998` · `1,970` · `1,801` · `849` · `718` · `709` ms
  其中 7 个落在 ~2,000 ms = **超时预算测试**，在等 `taskkill /T /F` 的树杀（Windows 无进程组信号，`verify.mjs:462–472`）。**这是设计上必需的，不算缺陷**，但每个 ~2s 可以并行。
* **方案**（不改行为，只改并发）：
  1. `runVerify` 改用 `spawn` + `await`，让 `node --test` 的文件级并发生效；
  2. **实测已验证**：`node --test --test-concurrency=1` = **44,808 ms** vs 默认并行 **30,140 ms** ⇒ 并行已带来 1.49× 加速。7 个测试**文件**在并行，但 51 个**用例**在文件内串行。把 58 次 spawn 并行化可再拿 2–3×。
* **预估节省：16–18s**（仅此一项）。

### B3 — `check-doc-counts.mjs` 重复读同一 `.sol` 文件 【收益：约 10–30 ms，很小】

* **位置**：
  * `forgeLintAnnotationCount()` `scripts/check-doc-counts.mjs:617–622` → 递归读**全部 31 个** `.sol`
  * `halmosSpecCount()` `:761–773` → 重读 `Halmos*.t.sol`
  * `echidnaPropertyCount()` `:782–787` → 重读 `EchidnaProperties.t.sol`
  * `invariantStats()` `:810–817` → 重读 `*.invariant.t.sol`
* **实测重叠文件 4 个**：`EchidnaProperties.t.sol` · `Halmos.t.sol` · `HalmosAuth.t.sol` · `SessionKeyManager.invariant.t.sol`
* **量级判断**：31 个 `.sol` 全量读取约 **10–30 ms**。相对该脚本 2.1–68.8s 的总耗时，**收益 < 0.1%，不值得改**。仅作为「模式已确认存在」的记录列出。
* **建议**：**不改**。若将来要做，一个 `Map<path, text>` 惰性缓存即可，**不要**改成预读全部。

### B4 — `check-doc-counts.mjs` 调用 `forge config --json` 两次 【收益：约 40 ms，明确不建议改】

* **位置**：`scripts/check-doc-counts.mjs:900`
  ```js
  problems.push(...checkInvariantConfig(readme, resolvedFoundryConfig("ci"), resolvedFoundryConfig("default")));
  ```
* **实测**：`forge config --json` 稳定 **38–50 ms**，两次串行约 80–100 ms。
* **可合并吗**：**不能简单合并。** 两者用**不同 `FOUNDRY_PROFILE`**（`resolvedFoundryConfig` 内部设 `env.FOUNDRY_PROFILE`，见 `:840–846`），`forge` 一次调用只返回一个 profile 的配置。若要省，只能改成「自己解析 `foundry.toml`」—— 收益 40ms，风险高，**明确不建议**。

### B5 — `JSON.parse` 无 size 上界 【收益：0，属加固，非瓶颈】

* **位置**：`scripts/check-doc-counts.mjs:841`（`forge config --json`）、`:150`（`parseVitestReport`）
* 实测输出很小（`forge config` < 20 KB，vitest 报告 **6.5 KB**），**无实际风险，不动**。列出仅为完成任务要求的「无界 JSON.parse」排查项。

### B6 — 同步 I/O 在循环里：存在，但都便宜 【收益：< 50ms，不要动】

* `check-doc-counts.mjs:603` `readdirSync(…, {withFileTypes:true})` 递归 walk（31 文件）
* `:619` `readFileSync` 在 `.reduce()` 内
* `:768`、`:815` `readFileSync` 在 `for` 内
* **实测这些合计 < 50 ms。** 全部是纯 Node 守卫，进程启动即退，改 async 只增加复杂度。**明确不建议改。**

### B7 — 子进程未复用：`forge` 每次都重新 spawn（不可复用） 【收益：0，但解释了 13.4s】

* **位置**：`scripts/check-doc-counts.mjs:716`（`forge test --list`）、`:841`（`forge config --json` ×2）
* `forge` 是编译型二进制，没有常驻模式，**无法复用进程**。这不是设计缺陷。
* **但可复用它的产物** —— 见 §4。

### 🔴 B8（本轮新增）— 一个**无超时**的 `spawn`，单例白烧 5 秒

> **位置**：`packages/mcp/test/mcp.test.ts:107–128`（**不在 `scripts/`，但属性能范畴，故记录在此**）
>
> ```js
> it("serves tools/call end-to-end over stdio", async () => {
>   const child = spawn(process.execPath, [join(HERE, "..", "dist", "cli.js")], { stdio: "pipe" });
>   const response = await new Promise((resolve) => {        // ← 无 timeout / 无 reject
>     child.stdout.on("data", (chunk) => { … resolve(…); child.kill(); return; });
>     child.stdin.write(`{"jsonrpc":"0","id":1,"method":"ping"}\n`);
>   });
> ```
>
> **实测证据**（`outputs/.ix-test-harness/final-mcp2.log`，2026-09-26 17:57:06）：
> ```
>  ✓ test/path-policy-bypass.test.ts (12 tests) 35ms
>  ✓ test/serve.test.ts          (8 tests) 199ms
>  ✓ test/validation.test.ts     (44 tests) 397ms
>  ✓ test/tool-errors.test.ts    (53 tests) 749ms
>  ❯ test/mcp.test.ts (13 tests | 1 failed) 5773ms
>    × serves tools/call end-to-end over stdio 5021ms
>      Error: Test timed out in 5000ms.
> ```
>
> **诊断**：该 `Promise` **没有 timeout、也没有 reject 路径**。
> * **成功时**：`stdout` 到达 → resolve + `child.kill()`，正常。
> * **失败时**：`dist/cli.js` 缺失或 `ping` 无响应 ⇒ **永不 resolve** ⇒ 只能等 vitest 的 `testTimeout` **兜底 5000ms** 才失败。
>
> **代价（本 mcp 套件内）**：
> * 失败路径 = **5,021 ms 纯等待**，占该套件 6,330ms 的 **79%**。
> * 全套件 130 个用例中，**仅这 1 个**吃掉 79% 的墙钟。
> * **成功路径也可能白烧**：`child.kill()` 后**不 `unref`、不等待 `close`**，进程回收与断言存在竞态；
> 若 `ping` 响应慢或分片跨 chunk（该测试逐行扫描 `startsWith("{")`），耗时不可控。
>
> **建议修法（供 owner 参考，我未实施）**：给该 `Promise` 加显式超时 + `reject`，
> 并在 `finally` 里 `child.kill()` + 等待 `close`（避免僵尸进程）。
> **收益**：失败路径 5,021ms → 亚秒级；且消除「一个用例占 79% 墙钟」对 `tests` 步 44.8s 的拉长效应。
>
> **⚠️ 与 L5 的关系**：L5 结论「无子进程/监听器泄漏」针对 `scripts/`。**本条说明 `packages/` 的测试代码存在同类模式**，
> 二者不矛盾——`scripts/` 侧确实收尾完整，**本条是 `packages/mcp` 侧的独立发现**。

---

## 3. 资源泄漏清单

### L1 — `.vite-temp` 配置文件累积 【确认泄漏；⚠️ 具体数字的原始证据已被 T4 清空】

* **位置**：`packages/*/node_modules/.vite-temp/vitest.config.ts.timestamp-*.mjs`
* **实测**：`packages/*/node_modules/.vite-temp/*` ⇒ **76 个文件，254,800 字节**，最旧 **2026-09-12 21:52**（2 周前），最新随每次 vitest 运行增长。
* ⚠️ **T4 失效声明**：`node_modules` 已被清空，**该目录连同这组数字一起消失，现已无法当场复核**。结论方向不变（每次 vitest 运行生成一个 `timestamp-*.mjs` 残留），但引用具体数字时须注明测量时点为 T4 之前。
* **模式**：文件名带 `timestamp-<ms>-<hash>.mjs`。Vite/Vitest 加载 TS 配置时生成临时编译产物，正常路径会自删；在多 worker 退出路径下有残留。后续一次 `clean.mjs` 把它们清到 0，验证了确实无人回收。
* **归因**：`scripts/check-doc-counts.mjs:73–77`（`--with-ts` 跑 4 次 vitest）+ `verify` 的 `tests` 步（再跑 4 次）⇒ **每次完整门禁至少泄漏 8 个文件**。
* **建议**：`scripts/clean.mjs` 的清理集合加入 `packages/*/node_modules/.vite-temp/`。**不要**在脚本里手写 `rm`（并发跑 vitest 时会删掉别人正在用的配置）。

### L2 — `benchmark-run-*` 目录永不清理 【实测 7 个】—— **不是泄漏**

* **位置**：`scripts/benchmark-indexer.mjs:630` `mkdtempSync(join(outDir, "benchmark-run-"))`
* **实测**：`outputs/` 下 **7 个** `benchmark-run-*`，各 ~11.7–18.4 KB，最旧 `2026-09-18`。
* **是否 bug**：**不是泄漏，是刻意设计** —— 报告（`:714`）就是产物，要留给人看。`:668` 的 `cleanupArtifacts` 只清 SQLite fixture，**有意保留** `runDir`。
* **建议**：**保留行为**。若嫌多，给 `clean.mjs` 加「保留最近 N 个」的裁剪即可。**不要**改成自动删除。

### L3 — benchmark 的 SQLite fixture 残留 【实测 3 个 × 811 KB = 2.32 MB；⚠️ 该组文件已被 `clean` 移除】

* **原测位置**：`outputs/.baseline-disk-{1,2,3}.sqlite`
* **原测数据**：每个 **811,008 字节**，共 **2,433,024 字节（2.32 MB）**。
* **⚠️ T4 复核（2026-09-26 约 18:10）**：这三个文件**现已不存在**（`outputs/` 下 `*.sqlite` 计数为 0）。**原始证据已消失。**
* **但同类残留仍在，且更集中**——复核发现：
  ```
  outputs/review-2026-09-17/benchmark-temp/bench-indexer-disk-rep1.sqlite   647,168 B
  outputs/review-2026-09-17/benchmark-temp/bench-indexer-disk-rep2.sqlite   647,168 B
  outputs/review-2026-09-17/benchmark-temp/bench-indexer-disk-rep3.sqlite   647,168 B
  合计 1,941,504 B = 1.85 MB
  ```
  三份**大小完全相同**（647,168 B × 3），是 `benchmark-indexer` disk 模式 3 次 rep 的 fixture。
* **归因**：`benchmark-indexer` disk 模式 fixture 在**异常/中断路径**未删除。正常路径已有 `indexer?.close()` + `statSync`（`:580–585`）。
* **建议**：纳入 `clean.mjs`，**且清理规则应覆盖 `outputs/**` 递归**（原 `.baseline-disk-*` 在 `outputs/` 根，新发现的同类在 `outputs/review-2026-09-17/benchmark-temp/`）——**固定路径的规则会漏掉这一类**。

### L4 — 测试临时目录残留 【实测 `%TEMP%` 下 85 个 `sigilkit-*`】

* **实测**：`$env:TEMP` 下 **85** 个 `sigilkit-*` 目录。按前缀分组：
  `sigilkit-outside` × 15 · `sigilkit-e2e` × 5 · `sigilkit` × 3 · `sigilkit-verify` × 3 · `sigilkit-clean` × 3 · 其余零散（含 `sigilkit-mcp-val-*`、`sigilkit-lease-*`）。
* **代码是**对的：`verify.test.mjs:13` `t.after(() => rmSync(root, {recursive:true, force:true}))` 有配对清理；`check-dockerfile.test.mjs:10`、`assurance-inventory.test.mjs:92`、`check-runtime.test.mjs:32`、`check-package-artifacts.test.mjs:145,164`、`clean.test.mjs:71,542,632`、`check-waivers.test.mjs:411`、`sync-facts.test.mjs:206` 均**有** `rmSync` 配对。
* **为何仍残留**：测试**被 kill / 超时**时 `t.after` 不执行。`verify.test.mjs` 有 7 个 ~2s 超时预算测试 + 主动杀进程树测试 ⇒ 必然残留。
* **建议**：**不要**改测试。残留是超时测试的正常副产物，且在 `%TEMP%` 里。`clean.mjs` 可加「清理 7 天前的 `sigilkit-*`」，属可选便利。

### L5 — 子进程 / 监听器：**未发现泄漏**

* **`verify.mjs` 的 `spawn` 有完整收尾**：`child.on("close")` → `finish()`（`:523,563`）→ `closeSync(logFd)`（`:482`）；`terminate()` 用 `taskkill /T /F` 杀整棵进程树（`:462–472`）；`clearTimeout(timer)` / `clearTimeout(killTimer)` 都在 `finish()` 里（`:477–478`）。**无泄漏。**
* **流监听器**：`verify.mjs:292–296` 给 stdout/stderr 挂 `error` 处理器处理 EPIPE —— 进程级单例，无需 remove。`:504–514` 的 `stream.on("data")` 挂在**每次 spawn 的新 child 流**上，child 退出即销毁。
* **`benchmark-indexer.mjs:604–624`** 的 `Worker`：`on("exit")` 里必定 `resolveRun` 或 `rejectRun`，**每条路径都 settle**。`:580` `indexer?.close()` 有 try/catch。**无泄漏。**
* **并行化安全性**：`run()` 内无跨调用共享可变状态（`logFd`、`settled`、`timer` 均为闭包内局部）⇒ 并发安全。

---

## 3A. P1 实施记录：未登记的测试套件（2026-09-26）

> ### ⚠️ 本节所有测试数字的取用限制（cr-dep 指出，我接受）
>
> **`51/51`、`6/6`、`0.85s`、`146 tests` 这些数字在本机测得，而本机依赖树是 T4 后的半恢复状态**
> （`viem` 存在但 `abitype` 被清空，`import('viem')` 直接失败）。
>
> **⇒ 按本报告 §4 与规范 5 的同一条判据：凡在依赖树不完整的环境下测得的 `node --test` 数字，一律不得作基线。**
> **⇒ 这些数字只证明「套件能跑通、断言自洽」，不证明「门禁在健康环境下绿」。**
> **⇒ 健康环境恢复后必须重测。**

> **来源**：cr-dep 移交。**本文档只做记录，B1/P1 的实现与验收在 `verify.mjs` / `verify.test.mjs`。**

### 缺口实测（与 cr-dep 报告一致，逐项复核）

| 项 | 数字 |
|---|---|
| 磁盘上 `scripts/**/*.test.mjs`（含 `scripts/lib/`） | **22**（登记前） |
| `verify.mjs` helpers 步骤登记 | **15** |
| 两处都没有 ⇒ 运行次数 0 | **7 个文件** |

未登记的 7 个：`scripts/lib/{cli,exit,fs-json,paths,reporter}.test.mjs`（**98 个测试**）
+ `scripts/check-tracked-refs.test.mjs` + `scripts/check-reparse-points.test.mjs`。
**实测 `node --test scripts/lib/*.test.mjs` ⇒ exit 0 · 863ms · tests 98 / pass 98 / fail 0。**

### 处置

1. **8 个套件全部登记进 `verify.mjs` 的 `helpers` 步**（含新增的 `check-helper-suites.test.mjs`，现共 **23** 个）。
   * **按 cr-dep 的第 2 点，保留显式 argv 列表，未换成 glob。**
2. **新增 `scripts/check-helper-suites.mjs`**：递归发现 `scripts/` 与 `scripts/lib/` 下的 `*.test.mjs`，
   与 `verify.mjs` 中实际登记的列表求差，**有差即 exit 1**。
   * **失败 loudly 而非静默**：找不到 `--test` 列表时 **exit 2**（形状变了），**不报「无漂移」**。
   * **`LIST_END` 用 `]),` 而非「最后一个套件」** —— 否则在末尾新增套件会**静默逃出守卫视野**，即它要防的那种漂移的上一层。
   * **实测**：登记后 `helper suites OK — all 23 discovered suite(s) are registered`；构造一个未登记的新套件 ⇒ 立刻报出 1 条。
   * 新增 6 个测试（`tests 6 / pass 6`），其中一条专门钉住「读不到列表 ⇒ `null` ⇒ 不得当成 0 问题」。
3. **一个连带修复**：`verify.test.mjs` 的 colour parity 用例在 T4 后**误报红**（`viem` 缺 `abitype`）。
   已改为**先探测模块可加载性，不可加载则 skip 并给出 diagnostic** —— 否则环境故障会伪装成 parity 故障。

### ⚠️ 遗留：那条「故意红」的绊线（**结论修正：不能只转绿**）

`check-tracked-refs.test.mjs` 的 `the real repository currently FAILS: six workflow-invoked paths are untracked`
**仍为红，我未转绿**。cr-dep 独立复核后**修正了我的建议**，我实测确认它是对的：

| 事实 | 实测 |
|---|---|
| workflow 引用的 `scripts/…` 路径 | **19**（去重后） |
| **在 INDEX 里**（= 守卫现在测的） | **18** |
| **在 HEAD 里**（= 干净克隆真正拿到的） | **12** |
| **已 `git add` 但未提交** | **6** |

那 6 个（**文件都在磁盘上，守卫因此报 OK**）：
`check-vectors.{mjs,test.mjs}` · `check-waivers.{mjs,test.mjs}` · `install-actionlint.sh` · `install-gitleaks.sh`
—— **与用例名里的 “six” 精确对应**，且被 `ci.yml:57/59/83/141/190/192` 与 `publish.yml:73` **8 处真实调用**。

**🔴 核心问题：守卫用 `git ls-files`（`:146`）读的是 INDEX，不是 HEAD。**
**已 `git add` 未提交的文件能过守卫，但干净克隆 HEAD 仍然没有它** —— 而守卫自己的文案写着：
> 「On a clean clone the jobs that call them failed on a missing file」
> 「A clean clone fails on these. `git add` them: **committing is a fix** to a broken committed state」

**⇒ 守卫声称在测「干净克隆是否缺文件」，实际测的是「暂存区是否完整」。这两者不等价。**

**验证过的一行修法**（cr-dep 提出，我实测确认可用）：
`git ls-tree -r HEAD --name-only -- scripts` ⇒ **exit 0 / 19 条 / 6 个 staged-only 文件确实不在其中**。

**⇒ 三件事必须同一提交完成，缺一不可**：
- **a.** 提交那 6 个已暂存文件（**这才是真正的修复**）
- **b.** 守卫改读 HEAD（否则下一个 `git add` 未提交的人会拿到一个**会骗人的绿**）
- **c.** 绊线断言同步到通过态，**但保留其意图**（让「守卫变绿」必须是某人的显式决定）

**若只做 (c) 不做 (a)(b)**：套件变绿，而干净克隆缺陷仍活着 —— **那正是本整条线在防的「会骗人的绿」。**

**⇒ 我不签这个字，也不单方面转绿。**

#### 🔴 修正（cr-dep 指出，实测确认）：(a) 并不是「提交那 6 个」

**我上一条把 (a) 表述为「提交那 6 个已暂存文件」，这个表述是危险的 —— 暂存区里远不止 6 个。**

```
git status --porcelain  → 211 行
  'A ' (新增已暂存)  x 42
  'M ' (修改已暂存)  x 16
  'AM'(新增+又改)   x 8
  'MM'              x 1
  'D '              x 1
  ─────────────────────
  暂存合计 = 68 个文件      ← 我最初口头报「9 个」，是我的过滤条件写错，cr-dep 的 67 基本正确
  未暂存 94 · 未跟踪 58
```

**⇒ 按现状提交会把另外 62 个文件一并扫进去** —— 两天内多个 agent 的产出，
含 `ci.yml` / `publish.yml` / `verify.mjs` / `verify.test.mjs` 及大量 `packages/`、`docs/` 改动。

**cr-dep 查的那类危险我复核了：暂存集内 `dist/` 与 `node_modules/` 路径命中 = 0**，
所以不会把 `publish.yml` 需要的构建产物弄没。**但「不危险」不等于「正确」**——
68 个文件里另外 62 个从未被复核过，**提交应当是可复核的单元**。

**另注：当前分支是 `review-integration-20260917`，HEAD = `ce8eea2`。**

**⇒ 正确的执行顺序（含一处必要验证，采纳 cr-dep）**：
```
1. 由人决定那 68 个文件的提交范围；若意图只是这六个 + 两处改动，先把 index 收窄
2. 应用 (b)：ls-files → ls-tree -r HEAD（一行）
3. 重跑守卫 —— 它应当报出那六个缺失，那才是诚实状态   ← 这是「(b) 真的生效了」的验证
4. 提交那六个；重跑 —— 变绿
5. 更新 (c) 到通过态，保留其意图
```

**⚠️ 第 3 步不可省。** 没有它，(b) 就是一处**未经测试的门禁改动** ——
**未经测试的改动同样是未验证的改动**，与「会骗人的绿」是同一类问题的另一方向。

**⇒ 我不做 (a)（不提交）、不做 (b)（不是我的守卫）、不做 (c)（需署名）。**

#### (b) 的**真实**理由（机制更正，cr-dep 指出，我实测确认）

**我一度写过一句错误的话**：*「守卫用 `ls-files` 把『deliberately absent』那个方向也弄丢了，缺 (b) 之前两个方向都不完整」*。
**这句话是错的，已撤回。** 它对机制做出了一个错误的解释，而**结论（做 (b)）仍然成立**。

**实测证明（用守卫自己的 `scriptReferences` + `runBlocks`）**：

| 用例 | 输入 | 结果 |
|------|------|------|
| A | **已存在且已跟踪**的文件只出现在注释里 | **`[]`** ← 被丢弃 |
| B | 同一文件在 `run:` body 里 | `["scripts/check-doc-counts.mjs"]` |
| E | 同一文件 + 行尾注释提到另一个 | 只保留 body 里那个 |

而 `scripts/check-doc-counts.mjs` **在磁盘上、在 INDEX 里、在 HEAD 里**（三项全实测为真）。

**⇒ 注释排除发生在 `:66–67`（`replace(/\s+#.*$/,"")` + `startsWith("#")`），
是纯文本属性，在任何 git 调用与文件系统访问之前就完成了。**
**它既不是文件的属性，也不是任何一棵 git 树的属性 —— 换成 `ls-tree` 不会有任何变化。**

**第二个方向由 `:182` 独立覆盖**：`if (!existsSync(...)) continue;`
实测：引用一个**磁盘上不存在**的文件 ⇒ **在 `:182` 被跳过，永远不会被要求提交**，
**无论其跟踪状态如何**。**即使一个已提交的 workflow 引用了缺失文件，也不会被报出来。**

**⇒ 两个方向由两条独立规则各自覆盖：解析器的注释排除 + 守卫的 on-disk 检查。**
**`(b)` 改变的不是「守卫覆盖哪个方向」，而是「文件必须出现在哪一个 commit 里」。**
**`ls-files` 的缺口只有一个：已暂存未提交能过，而干净克隆仍缺。**

> **为什么这条更正值得单独记**：按我原先的错误说法，后来的读者会推出
> 「`ls-files` 也弄坏了 deliberately-absent 的处理 ⇒ `:182` 那条规则大概不安全」——
> **然后可能删掉一条目前完全正确的规则。**
> **结论活下来（做 (b)），理由活不下来，而会被引用的是理由。**
>
> **可推广的判据（本轮新增，与本报告 §「判据有效性规则」同族）**：
> **当一个修复的「理由」被质疑时，先问「结论是否依赖该理由」。**
> * **结论依赖理由** ⇒ 理由错则结论错，**两者一起撤回**。
> * **结论不依赖理由** ⇒ **只撤回理由，并明确写下新理由**；否则下一个读者会继承那个错的。
>
> 本例属后者：**(b) 该做**（因为「已暂存未提交能过、干净克隆仍缺」是实测事实），
> **但它与「守卫覆盖哪两个方向」无关** —— 那个解释是我编的。

---

## 4. `check-doc-counts.mjs --with-ts` 专门评估

### 4.1 耗时实测

| 场景 | 耗时 |
|------|------|
| 冷缓存（首次，forge 需编译 31 个 `.sol`） | **33,310 ms** |
| 热 forge 缓存 + 4 个 vitest（重测） | **68,803 ms** |
| 不带 `--with-ts`，热缓存 | **2,139 ms** |
| 不带 `--with-ts`，冷缓存 | 3,071 ms（首次）/ 12,106–18,506 ms（3 次中位数 16,729） |

**结论：`--with-ts` 单独引入 31–67 秒**，是全项目最重的单脚本。

> ⚠️ **但这 31–67s 是「失败态耗时」**（T1：3/4 vitest 未执行任何测试；**T2 重测：4/4 全 0，含 core**）。
> **不可作为「该检查的性能基线」或任何优化估算的基数。** 依赖恢复后必然更长。见 §4.2 / §4.4。
>
> ### 🔴 后续从日志中发现的**真正根因**（比 junction 更根本，2026-09-26 补）
>
> **`--with-ts` 报 0 测试，根因不是 junction，而是 `--with-ts` 绕过了 `pretest`。**
> 证据来自 `outputs/verify/2026-09-26T11-02-44-538Z-typescript-tests.log`（**未随 `node_modules` 消失**，是本次事件中唯一存活的运行证据）：
>
> ```
> > @sigilkit/core@0.1.0 pretest
> > @sigilkit/core@0.1.0 build      ← pretest 会先构建！
> > @sigilkit/core@0.1.0 test
>   Test Files  2 failed | 26 passed (28)
>        Tests  4 failed | 516 passed | 1 skipped (521)
>    Duration  26.42s
> > @sigilkit/demo-agent@0.1.0 test
>   Test Files  7 failed (7)          Duration 4.62s
>   Tests  2 failed | 1 passed (3)
> > @sigilkit/indexer@0.1.0 test
>   Test Files  7 failed (7)          Duration 2.31s
>   Tests  2 failed (2)
> > @sigilkit/mcp@0.1.0 test
>   Test Files  2 failed | 2 passed (4)   Duration 6.69s
>   Tests  6 failed | 109 passed (115)     ← mcp 实跑 115 个用例，非 0
> ```
>
> **第二次独立运行**（`11-05-39-022Z`，同窗口，2 分 53 秒后）可交叉验证稳定性：
> ```
> core        Test Files 1 failed | 28 passed (29)   Tests 8 failed | 524 passed | 1 skipped (533)   Duration 25.15s
> demo-agent  Test Files 7 failed (7)                Tests 2 failed | 1 passed (3)                     Duration  4.16s
> indexer     Test Files 7 failed (7)                Tests 2 failed (2)                               Duration  3.30s
> mcp         Test Files 2 failed | 5 passed (7)      Tests 2 failed | 117 passed (119)                 Duration  6.50s
> ```
>
> **⇒ core 两次分别 521 / 533 个用例，mcp 两次分别 115 / 119 个用例，均非 0。**
> **⇒ 这两条日志是本次 T4 事件中唯一幸存的运行证据**（未随 `node_modules` 一起消失）。
>
> **对照两个事实**：
> 1. **`npm test --workspaces` 会触发 `pretest`** ⇒ core 先 `npm run build`，**core 实测跑了 521 个测试（516 passed）**。
> 2. **`check-doc-counts.mjs:75` 直接 `execFileSync(vitest.mjs, ["run", …])`，绕过 npm，因此绕过 `pretest` 的 build** ⇒ 我直跑 vitest 时 core 拿到 **0 个测试**。
>
> 逐包 `pretest` 配置（实测）：
> ```
> core         pretest='npm run build'   test='vitest run'
> indexer / mcp / demo-agent             pretest=''  test='vitest run'
> ```
> **只有 core 有 `pretest`。** 所以 `--with-ts` 的「4 个包全 0」= **core 因缺 build 归零 + 另 3 个因缺 dist 归零**，而 `npm test` 路径下 core 能跑到 521 个。
>
> **⇒ 三重结论**：
> 1. **我的 T1/T2 观察（4 个包全 0）是对的，但归因不完整**——我把它归给 junction，而 junction 只解释了 3/4；**core 的 0 是 `pretest` 被绕过造成的，与 junction 无关。**
> 2. **我给 team-lead 的「`tests` 步 44.8s 是在 4 个包全 0 测试下测的，依赖恢复后会变」——这个理由是错的。** 该步走 `npm test`，core 实测**跑了 521 个测试**，不是 0。**撤回该理由。**
> 3. **`--with-ts` 的 8.6s 与 31–67s 全部低估**：真实成本是「4 个包的真实验证套件」，而 core 一家就 26.42s / 521 tests。**并行化的必要性比原估更强，收益上界也更高**（见 §4.4）。
>
> ### 🔴 由此暴露的**独立缺陷**（不限于当前环境，建议立项）
>
> **`--with-ts` 绕过 `pretest`，在健康环境下也可能读到错误的测试数。**
>
> | 事实 | 依据 |
> |------|------|
> | `check-doc-counts.mjs:73–77` 直连 `node_modules/vitest/vitest.mjs` | 绕过 npm 生命周期钩子 |
> | 只有 `core` 定义了 `pretest='npm run build'` | 逐包 `package.json` 实测 |
> | `core` 的 533 个用例依赖 `pretest` 先构建 `dist` | 幸存日志 run B：`524 passed / 533` |
>
> **⇒ 在一个 junction 完好、但 `dist` 被 `clean` 清掉的检出上，`--with-ts` 会让 core 报 0 个测试，**
> **而 `summarizeTsRun` 只把它记为一条 problem——不会误报为「core 有 0 个测试」通过。**
> **但 `checkWhitepaperCounts` / `checkChangelogCounts` 拿到的 `ts` 计数是 `null`/偏低值，**
> **其「TS 声明是否匹配」的判断会因数据缺失而弱化（fail-closed 但信息丢失）。**
>
> **建议修法（供 owner 参考，我未实施）**：`tsTestCounts()` 在直连 vitest 前，**对有 `pretest` 的包先执行其 `pretest`**，或直接改为 `npm test --workspace <pkg>`（走完整生命周期）。后者更慢但语义正确。

### 4.2 内部成本拆解

4 次 `execFileSync` **串行**跑 vitest（`scripts/check-doc-counts.mjs:73–77`）：

| workspace | 单次 vitest |
|-----------|-----------|
| core | 2,135 ms |
| mcp | 2,272 ms |
| indexer | 2,077 ms |
| demo-agent | ~2,100 ms |
| **串行合计** | **~8.6s** |

**关键发现：4 次 vitest 全部报告 0 个测试。**

`packages/indexer/.vitest-perf.json` 实际内容：
```json
{ "numTotalTestSuites": 5, "numTotalTests": 0, "numPassedTests": 0, "success": false,
  "testResults": [{ "status": "failed",
    "message": "Cannot find package '@sigilkit/core' imported from D:/SigilKit/packages/indexer/src/indexer.ts" }] }
```

`--with-ts` 自身输出确认：
```
ts (indexer):     vitest run failed — Command failed: … node.exe … vitest.mjs run --reporter=json …
ts (mcp):         vitest run failed — Command failed: …
ts (demo-agent):  vitest run failed — Command failed: …
```

> ### 🔴 §4.2 数据时效性警告：本节数字已在同一天内失效两次
>
> **本节是全报告最不稳定的一节。以下四件事按时间顺序发生，请勿混用：**
>
> | 时点 | 观察 | 说明 |
> |------|------|------|
> | **T1（我最初测量）** | 4 个包全 0 测试；**core 通过**、另 3 个因 junction 失败 | 此时 mcp **尚无** fallback alias |
> | **T2（`packages/mcp/vitest.config.ts` 已加 alias）** | **4 个包仍全 0 测试，但 core 也开始失败** | alias 只覆盖 mcp，**不覆盖 core/indexer/demo-agent** |
> | **T4（`node_modules` 被清空）** | **连 `vitest` 本身都不存在了** | `node_modules` 仅剩 `@noble` + `viem`；`@sigilkit/`、`vitest`、`typescript`、`yaml` **全部不存在**。`npx vitest` → `Cannot find package 'vitest'`。**此时任何运行数据都无法产生，也无法复现。** |
> | **T3（依赖恢复后）** | 4 个包真跑测试 | **未测**——本报告无法预测该状态耗时 |
>
> ### 🔴 T4 已使本报告的**运行类证据**全部不可复现
>
> **T4 = `node_modules` 被清空**（非 ix-mcp-sec 的 junction 损坏，那属于 T1–T2）。实测确认：
> ```
> node_modules  entries=2  →  仅 @noble, viem
> node_modules/@sigilkit   →  不存在
> node_modules/vitest      →  不存在
> node_modules/typescript  →  不存在
> node_modules/yaml        →  不存在
> packages/*/node_modules  →  目录仍在但 0–1 个条目（已空）
> ```
>
> **⇒ 下列内容在 T4 之后无法重跑验证，且其中一部分原始证据已被物理删除：**
>
> | 报告内容 | T4 后状态 | 说明 |
> |---------|-----------|------|
> | §4.1 / §4.2 全部耗时 | **不可复现** | vitest 不存在 |
> | ~~§1.3 `tests` 步 44.8s~~ | ✅ **仍有效**（**上一版误标为不可复现，本版更正**） | 该步走 `npm test --workspaces`，**日志证明 core 实跑 521 个测试 / 26.42s**，非 0 测试。**数字未受 T4 影响** |
> | **§3 L1 `.vite-temp` 76 文件 / 254,800 B** | **⚠️ 原始证据已消失** | **该证据位于 `packages/*/node_modules/.vite-temp/`，已被 T4 一并清空**。本条结论**方向仍成立**（每次 vitest 运行生成一个 `timestamp-*.mjs`），但**「76 个 / 254,800 字节 / 最旧 09-12」这组具体数字已无法当场复核** |
> | §3 L2 `benchmark-run-*` 7 个 | **仍有效** | 位于 `outputs/`，未受 T4 影响（复核：仍为 7 个） |> | §3 L3 `.baseline-disk-*.sqlite` 2.32MB | **⚠️ 原始证据已消失** | `outputs/.baseline-disk-{1,2,3}.sqlite` **现已不存在**（T4 前后被某次 `clean` 移除）。**另发现同类残留更集中**：`outputs/review-2026-09-17/benchmark-temp/bench-indexer-disk-rep{1,2,3}.sqlite`，各 **647,168 B**，共 **1,941,504 B（1.85 MB）** |
> | §3 L4 `%TEMP%` 85 个 `sigilkit-*` | **仍有效，但已增长** | 复核：**85 → 103 个**（`%TEMP%` 不受 T4 影响，但期间有更多超时测试残留） |
> | §4.3 730 声明 / 31 `.each` | **仍有效** | 纯静态源码计数，**不依赖依赖树** |
> | §2 B1/B2 的 89.4s 基数 | **仍有效** | `verify --quick` 走 `node --test` + 自身脚本，不依赖 `node_modules` 中的第三方包 |
> | §2 B1/B2 的 45–50s / 16–18s 收益 | **仍有效** | 同上 |
>
> **B1 结论仍然成立**（这是最重要的一点）：B1 的 89.4s 基数与 `tests` 44.8s / `helpers` 33.4s **虽然含 vitest，但 `verify` 的门禁耗时由 `node --test` 与脚本自身逻辑主导**；且**实测量（16:33 / 16:36 的 `typescript-tests` 步日志）证明我测量时 vitest 是可解析的**，日志里仍有真实 npm 输出（`> @sigilkit/core@0.1.0 pretest`）。**所以 T4 发生在我的测量窗口之后**，我的数字在被摧毁之前是**真实测量的**，不是幻觉。
>
> **T2 实测（重跑 4 个包）**：
> ```
> core        2236ms exit=1  tests=0 passed=0   ← T1 时它是「唯一通过」的，现在也 0
> indexer     1637ms exit=1  tests=0 passed=0
> mcp         1649ms exit=1  tests=0 passed=0   ← alias 已生效但仍 0
> demo-agent  ~2,100ms exit=1 tests=0 passed=0
> ```
>
> **T2 的失败原因已经变了，这是最重要的信息**：
> * **core**：`Cannot read properties of undefined (reading 'config')` —— **不再是 junction 错误**
> * **mcp**：`Cannot read properties of undefined (reading 'config')` —— alias 把 `@sigilkit/core*` 解析到 `../core/src/*.ts` **确实生效了**（错误类型已从「模块找不到」变成「运行期 undefined」）
> * **indexer**：`Cannot find package '@sigilkit/core'` —— **仍无 alias**（其 `vitest.config.ts` 尚无 fallback）
>
> ⇒ **8.6s 这个数字已经是「0 测试 + 失败路径」的历史值，任何阶段都不可用作基线。**
> ⇒ **`--with-ts` 的性能基线目前处于「未知」状态**，等 junction 修复后必须从零重测。

**根因（2026-09-26 勘误重写）**：`npm run build` 当前**失败**（实测 exit 2），报 4 条 TS2307。**但根因不是 dist 产物，而是本机 `node_modules/@sigilkit/*` 的 junction 损坏。**

实测 src→dist 映射**完全正常**，不是「产物缺失」：

| package | `src/*.ts` | `dist/*` | 比值 | 判定 |
|---------|-----------|----------|------|------|
| `indexer` | 3 | 6 | 2.0 | ✅ 每 `.ts` → `.js` + `.d.ts` |
| `mcp` | 2 | 4 | 2.0 | ✅ 同上 |
| `demo-agent` | 5 | 10 | 2.0 | ✅ 同上 |
| `core` | 12 | 36 | 3.0 | ✅ 多出 `.d.ts.map` |

`config.d.ts` / `logger.d.ts` **不属于 mcp**——它们是 `@sigilkit/core` 的**子路径导出**。而 core 侧完全正常：
```
packages/core/dist/  → 含 config.d.ts, config.js, logger.d.ts, logger.js ✅
```

**junction 损坏的独立复现**（sc-perf 亲自跑）：

| 探针 | 结果 | 含义 |
|------|------|------|
| `Get-Item node_modules/@sigilkit/core` | `LinkType=Junction`, `Target=D:\SigilKit\packages\core` | **元数据正常** |
| `Test-Path packages/core/package.json`（直读目标） | `True` | **目标完好** |
| `Test-Path node_modules/@sigilkit/core/package.json`（穿链接） | **`False`** | **链接不通** |
| `Get-Content node_modules/@sigilkit/core/package.json` | **`ItemNotFoundException`** | **穿不过去** |
| `node -e "import('@sigilkit/core/config')"` | **`ERR_MODULE_NOT_FOUND`** | **Node 解析失败** |

⇒ **悬空链接：元数据对、目标在、路径不通。** 这就是 4 条 TS2307 的全部来源——`@sigilkit/core` 根入口解析不了，于是**所有**跨包子路径（`/config`、`/logger`）与 `@sigilkit/indexer` 一并表现为「模块找不到」。

**因此 §4.2 的全部耗时数字是「失败态耗时」。** `--with-ts` 目前花的 31–67 秒里，有 8.6 秒在跑 vitest 却**一个测试都没执行**（T1：3 个失败；**T2 重测：4 个全 0，含 core**）。`summarizeTsRun`（`:132–146`）正确地把它们记为 problem 而非静默放过 0——**这一点是对的，也是本报告唯一因此受益的地方**：若当初静默接受 0，`--with-ts` 会拿着 4 个假数字去「校验」文档。

**junction 修好后这 4 次 vitest 会真的跑起测试，耗时必然高于 8.6s。** 届时有实际工作量等着它们（实测跨包 import 规模）：

| package | 测试文件 | 含 `@sigilkit/*` import 的源文件 |
|---------|---------|-------------------------------|
| `indexer` | 8 | 10 |
| `mcp` | 5 | 8 |
| `demo-agent` | 7 | 11 |
| `core` | 31 | —（本体，不跨包） |

⇒ **8.6s 不能作为任何优化估算的基数。** 见 §4.4 修订。

### 4.3 「能否不跑 vitest，改成从文件解析数量？」—— **不能，且这是安全性结论**

任务里假设「跑 vitest 8 秒、读 JSON 0.05 秒」。实测数据推翻了「改成解析文件」的思路：

> ⚠️ **前置警告**：本节（以及 §4.2 的所有耗时）受 junction 阻塞影响，**下列 730/31 是纯静态源码计数，不受 junction 影响，因此可信**；
> 但**凡涉及「跑 vitest 得到多少个测试」的数字都不可信**（见 §4.2 时效性警告）。

* **仓库里有 730 个 `test(` / `it(` 声明，但有 31 处 `.each` 参数化展开点**（12 个文件）：

  | 文件 | `.each` 数 |
  |------|-----------|
  | `core/test/lease-ttl-contract.test.ts` | 7 |
  | `core/test/eip7702-signature-guards.test.ts` | 4 |
  | `core/test/execute.test.ts` | 4 |
  | `core/test/validation.test.ts` | 3 |
  | `core/test/lease-fs.test.ts` | 2 |
  | `core/test/nonce.test.ts` | 2 |
  | `core/test/parse.test.ts` | 2 |
  | `indexer/test/query-plan.test.ts` | 2 |
  | `indexer/test/indexer.test.ts` | 2 |
  | `core/test/reference.test.ts` | 1 |
  | `core/test/signing-conformance.test.ts` | 1 |
  | `indexer/test/query-errors.test.ts` | 1 |

* **源码自己的注释就承认了这件事**（`scripts/check-doc-counts.mjs:57–61`）：
  > *「`vitest list` cannot be used here: it collapses parameterized cases (it reports 171 for core where a real run reports 181), so only an actual run gives a number worth pinning.」*

**结论：静态解析给出的数字必然与真实运行数不符，而这个脚本的全部价值就是「文档里的数字 == 真实运行数」。** 一旦用解析近似，守卫就退化成「文档里的数字 == 解析器的近似」—— **漂移检测能力归零**。**明确不建议改成静态解析。**

### 4.4 `--with-ts` 缓存可行性 —— **结论：不可缓存，且不应缓存**

评估了「测试数只在测试文件改动时才变」这一前提。**该前提在本仓库不成立**，四条实测理由：

1. **计数依赖跨包解析，不只依赖测试文件。** 4 个 vitest 里 3 个失败的直接原因是 **junction 损坏导致 `@sigilkit/core` 根入口解析不了**（§4.2），而非 dist 内容。**改任何包的 `package.json` exports、或 junction 本身，就能让测试数变化**，缓存键若只哈希测试文件就会返回过期数字。
2. **参数化展开使「文件哈希 → 数量」不是函数。** 31 处 `.each` 的数据集可能来自 fixture、共享常量甚至运行时生成（§4.3）。缓存键无法静态确定。
3. **失败态不可缓存。** 当前 3 个 vitest 处于「失败 / 0 测试」态。**缓存一个失败结果会让 `check-doc-counts` 长期报同一个假数字**，而它现在至少能报出 problem。这是 fail-closed vs fail-silent 的差别。
4. **文档侧变化不会反映在缓存里。** README / whitepaper / CHANGELOG 的声明数字是纯人工输入，**改文档不需要碰任何测试文件**，缓存无任何失效信号。

**唯一合理的「缓存」形态**（若坚持要）：
以「全部 `packages/*/src` + `test` + `dist` + `vitest.config.ts` + `package.json` 的 mtime+size」为键，缓存写在 `outputs/` 下可随时删除的位置，**且遇到「vitest 失败 / 0 测试」时必须 bypass 缓存直接重跑**。收益上限 = 31s；但**复杂度与失效正确性风险都很高**。

> **最终建议：不做缓存。**
>
> **并行化仍值得做，但收益必须 junction 修好后重新实测。** 4 个包之间无数据依赖，并行方向不变（`--with-ts` 内部 `for (const p of packages)` 串行，`:66–84`）。但：
> * **8.6s 是「0 个测试」的耗时，不是「跑完 4 个包」的耗时。** 修好后实际耗时**必然高于 8.6s**（indexer 8 / mcp 5 / demo-agent 7 个测试文件要真跑，还有 10/8/11 个跨包 import 要真解析）。
> * **但从日志中已能算出真实量级**（`npm test` 路径，2026-09-26 实测，**两次独立运行**）：
>
>   | package | run A (11:02:44) | run B (11:05:39) | Tests (run B) |
>   |---------|-----------------|-----------------|---------------|
>   | core | 26.42s | 25.15s | `8 failed / 524 passed / 1 skipped (533)` |
>   | mcp | 6.69s | 6.50s | `2 failed / 117 passed (119)` |
>   | demo-agent | 4.62s | 4.16s | `2 failed / 1 passed (3)` |
>   | indexer | 2.31s | 3.30s | `2 failed (2)` |
>   | **串行合计** | **40.04s** | **39.11s** | |
>
> * **⇒ 并行收益上界 = 串行合计 − max(单包)**
>   run A：`40.04 − 26.42 = 13.62s` · run B：`39.11 − 25.15 = 13.96s`
>   **⇒ 上界 ≈ 13.6–14.0s，取 ≈ 14s。**
> * **⚠️ 口径警告（采纳自 ix-mcp-sec 的纠正，我原先算错）**：这 4 个数来自 **`npm test` 路径**，**含 core 的 `pretest` build**；而 `--with-ts` 走 `check-doc-counts.mjs:75` 的**直连 vitest，绕过 `pretest`**。
>   **两个口径不能直接相减**——上表的 14s 是**「`npm test` 路径内部并行」的收益**，**不是 `--with-ts` 的可实现收益**。
>   `--with-ts` 的并行收益需在依赖恢复后**按其自身路径单独实测**。**但量级已可确认：40s 级，不是 8.6s 级。**
> * ⚠️ **alias 下的数据不可写进基线**（采纳自 ix-mcp-sec）：alias 把 `@sigilkit/core*` 解析到 `../core/src/*.ts`，**多了一次源码转译**，所以 alias 环境下的耗时**不能代表真实环境**，只能用于「包与包之间的相对比较」。性能基线必须在 junction 修好后的干净环境重测。
>
> **并行是正确方向，缓存不是。** 但**先修 junction、再谈并行**——否则测出来的仍是失败态数字。

---

## 5. `verify.mjs` 并行化方案

### 5.1 依赖分析

| step | 外部依赖 | 内部依赖 | 可否与其他步并发 |
|------|---------|---------|----------------|
| `lint` | 无 | 无 | **可** |
| `packaging` | 无 | 无 | **可** |
| `helpers` | 无（纯 Node，58 次 tmp 目录 spawn） | 无 | **可** |
| `docs` | **forge** (`test --list`, `config --json`) | 无 | **可**（不碰 Anvil） |
| `build` | 写 `packages/*/dist` | 必须先于 `typecheck`、`artifacts` | 见 5.2 |
| `typecheck` | 读 `dist/*.d.ts` | **必须后于 `build`** | **不可与 build 并发** |
| `artifacts` | 读 `dist` | **必须后于 `build`** | **不可与 build 并发** |
| `contracts` | forge 编译 + EVM | 无 | **可** |
| `tests` | Anvil 端口 8545 | 无 | **可**（helpers/docs 均不占 8545） |

**关键约束（实测支撑）**：
* `build → typecheck`、`build → artifacts` 是**真实数据依赖**：`verify.mjs:557–558` 注释明写「Consumers resolve @sigilkit/core through dist/*.d.ts, absent on a fresh checkout」。`verify.test.mjs:118–131` 有专门用例 `fresh workspace builds declarations before typechecking` 断言这个顺序。**这两条不能并行，动了会红测试。**
* `tests` 与 `helpers`/`docs` 无端口竞争：实测这三个测试文件中 `8545|anvil` 匹配数 = **0**。
* `verify.mjs:501–503` 的 tee 逻辑对每个 child 独立，并发安全。

### 5.2 推荐分组（3 波）

> **⚠️ 关于「`docs` 与 `docslocation` 争 forge」——sc-gate 提出，实测不成立（详见 §5.5）**，
> 但**结论方向侥幸相同**（它们仍不必强行相邻），理由与原建议不同。


```
第 1 波（并发 7）  lint · packaging · helpers · docs · build · contracts · tests
                                        └─ 任一失败不阻塞其它
第 2 波（并发 2）  typecheck · artifacts   ← 均依赖第 1 波的 build，二者互不依赖
```

### 5.3 预计收益

| 方案 | 总墙钟 | 相对现状 |
|------|--------|---------|
| 现状（全串行） | 89,383 ms | — |
| **只并行 4 个重步**（`helpers`·`docs`·`tests`·`contracts`） | **约 45,000 ms** | **−50%** |
| 3 波完整并行 | 约 40,000 ms | **−55%** |
| 3 波并行 + B2 优化 `verify.test.mjs`（helpers 33.4s → 约 8s） | **约 15,000 ms** | **−83%** |

**「60s → 15s」这个目标是可达的，但前提是先做 B2**（`verify.test.mjs` 的 58 次串行 spawn 是 helpers 步的 68%）。**只做并行不做 B2，最多到 40–45s。**

### 5.4 实施注意事项（**不建议我改，仅方案**）

1. **`results` 数组顺序会变。** `verify.mjs:532` 的 `results` 按完成顺序 push。改并发后需**按 `STEPS` 声明顺序排序**再渲染（`:622` 的 for 循环与 `--json` 的 `results` 都要排），否则报告表格顺序随机。
2. **并发下多个 child 同时写 stdout/stderr 会交错。** 这是可接受的（输出本来就交错），但 `--json` 模式下 stdout 只归 document 所有（`:501–503`）—— 现有代码已按 `JSON_OUT` 分流，**不要改这条**。
3. **日志文件名已含毫秒时间戳**（`:364–368` `logPathFor`），并发下同毫秒可能撞名。**建议加 step key 前缀**：`${stamp}-${key}-${slug}.log`。
4. **`--only` 语义不变。** `run()` 开头 `if (!matchesOnly(label)) return Promise.resolve(null)`（`:412`），并发下依然正确 —— 未选中的步立即 resolve，不占资源。
5. **`skip()` 路径**（`:535–538`）和 contracts 的 forge-missing 分支（`:566–577`）在并发下需同样 Promise 化。
6. **建议加并发上限**（如 `VERIFY_CONCURRENCY`，默认 4–8），避免在 CI 的 2 核 runner 上把 7 个进程一起压上去导致**更慢**。**本机 28 核建议默认 7。**
7. **`resolveForge()` 的一次性探测**（`:381–393`）在模块顶层执行（`:393`），**保持串行前置，不要移进并发块**.

### 5.5 资源竞争分析（sc-gate 提出 forge 争用，实测修正）

**sc-gate 的判断**：`docs` 与 `docslocation` 都读 `docs/STATUS.md`，而 `docs` 还会跑 `forge test --list`，
**两者并发会同时 fork forge**，建议把 `docs` 单独放第 1 波末尾或与 `contracts` 相邻。

**实测结论：forge 争用不成立，但 sc-gate 的谨慎是对的。** 逐步核对：

| 脚本 | 是否 fork forge | 实际外部命令 | 对 `docs/STATUS.md` 的操作 |
|------|----------------|--------------|--------------------------|
| `check-doc-counts.mjs` | ✅ 3 次（`forge test --list` + `forge config --json` ×2） | forge | **只读**；`writeFileSync` 仅在 `L1020`(README) / `L1034`(派生文档)，**且仅 `--write` 路径**，verify 不走 |
| `check-doc-location.mjs` | ❌ **0 次** | **`git ls-files`（`L82`）** | **只读**（`writeFileSync` 命中数 = 0） |

**⇒ 关键事实**：
* **`check-doc-location.mjs` 根本不用 forge** —— 它 fork 的是 **`git ls-files`**，不是 forge。
* 两者对 `STATUS.md` **都是只读**，**不存在写冲突**。sc-gate 说的「都读 STATUS.md」正确，
  但**读-读不是竞争**（同一文件并发读永远安全）。
* **真正的共享资源是 `.git/index`**：`git ls-files` 需读 git 索引，
  但**并发读者不互斥**（只有写者需要锁）。

**⇒ 修正后的判断**：
* **`docs` ↔ `docslocation` 无需串行化**，**可以同波并发**。
* **但 `docs`（3× forge）↔ `contracts`（`forge test`）确实会同时起两个 forge** ——
  这才是真正需要注意的一对。**建议：同一波内让这两个分开，或接受 2 个 forge 并存**
  （实测两者的编译缓存目录相同，**两个 forge 同时写 `out/` 目录存在理论风险**，
  **但这个风险与并发无关——它同样存在于当前的串行版本中**）。
* **sc-gate 的「让它们相邻」建议，理由应改写为**「两个 forge 步不同时起」，
  **not**「docs 与 docslocation 读同一文件」。

**⇒ 对 §5.2 分组的最终建议**：
```
第 1 波（并发 6）  lint · packaging · helpers · docslocation · build · tests
第 1 波末（单独）   docs      ← 3× forge，避开 contracts
第 2 波（并发 2）   typecheck · artifacts
第 3 波（单独）     contracts  ← forge test，与 docs 错开
```
**⚠️ 以上分组尚未在代码中验证——依赖恢复后必须复测。**

---

## 6. 结论摘要

| 结论 | 依据 |
|------|------|
| **`verify` 87.5% 的时间在 2 个步骤** | `tests` 44.8s + `helpers` 33.4s = 78.2s / 89.4s |
| **并行化是最大且最安全的收益** | 步进和 = 墙钟（零重叠），28 核，仅 2 组真实依赖 |
| **并行化单独不够，60s→15s 需配合 B2** | helpers 里 68% 是 58 次串行 spawn |
| **`--with-ts` 不可缓存** | 计数依赖跨包解析/junction 状态 + 31 处 `.each` + 失败态不可缓存 |
| **`--with-ts` 不应改为静态解析** | 源码注释已记录 `vitest list` 误差（171 vs 181）；730 声明 vs 31 展开点 |
| **`--with-ts` 并行 4 次 vitest：方向对，数字待重测** | ⚠️ 8.6s 是「0 测试」耗时，非基线；修 junction 后重测（§4.4） |
| **3 处真实泄漏可低成本清理** | `.vite-temp` 76 文件/255KB · `.baseline-disk-*.sqlite` 2.32MB · 7 个 `benchmark-run-*` |
| **`benchmark-run-*` 不算泄漏** | 报告即产物，`:668` 有意只清 SQLite |
| **无子进程/监听器泄漏** | `verify.mjs` / `benchmark-indexer.mjs` 的 spawn 全部有配对收尾（**但 `packages/mcp` 测试侧有例外，见 B8**） |
| **8 个亚 300ms 守卫脚本无需优化** | 耗时 ≈ Node 冷启动基线 60–70ms |

**优先级建议（若后续要动手，按此顺序）**：

1. **B1 并行化 `verify.mjs`** — 收益 45–50s，风险低（但需保持 `build → typecheck/artifacts` 顺序）
   **⚠️ 顺序约束（sc-gate 复核，采纳）**：**先修基线漂移 → 再上并发 → 复跑**。
   `verify.test.mjs:597/614` 仍断言 `nine steps`，而实际已 10 步（`LABELS` 新增 `docslocation`），
   **同一断言炸 4 个用例**（实测确认 `verify.test.mjs` 中 `nine`/`(9)` 命中 4 处）。
   **不先修这 4 个红，就无法区分「并发把顺序搞坏了」与「它本来就红」。**
2. **B2 `verify.test.mjs` 的 58 次 spawn 并行化** — 收益 16–18s，风险低
3. **B8 `packages/mcp/test/mcp.test.ts:113` 的无超时 `Promise`** — 收益：失败路径 5,021ms → 亚秒级；**风险低，但需 owner 改测试**
4. **`--with-ts` 绕过 `pretest`**（§4.2 独立缺陷）— 收益不是性能而是**正确性**；健康环境下也会读到错误测试数
5. **L1/L3 清理规则** — 收益 0s，但止住泄漏（**必须写进 `clean.mjs`，不可在脚本里手写 rm**；且需覆盖规范 6 的证据保护）
6. **5+2 条团队硬规范落地**（`bootstrap.mjs` / `CONTRIBUTING`）— **非性能，但今日事件的直接产物**
7. **~~B3/B4/B5/B6/B7~~ 不做** — 收益均 <50ms，低于噪声

---

*本报告仅新增 `scripts/PERF-2026-09-26.md`，未修改任何脚本。*
*测量期间的临时文件：早期 `packages/*/.vitest-perf.json`（4 个）已随 T4 一并消失；`outputs/verify/*.log`（80 个 / 266 KB）为 verify 自身行为。*
*⚠️ 报告引用的部分证据位于 `outputs/` 下，而 `clean.mjs` 的 `DANGEROUS_PATHS` 含 `outputs` —— 清理前请先读规范 6。*
