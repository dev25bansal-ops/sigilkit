# scripts/ 架构评估：重复实现、依赖方向与进程契约

**日期**：2026-09-26 · **范围**：`d:/SigilKit/scripts/`（26 个 `.mjs` + 2 个 `.sh` + 2 个数据文件）
**作者**：sc-arch · **性质**：只读分析 + 新建共享模块，**未修改任何现有脚本**

> 行号快照声明：本文所有 `路径:行号` 证据取自 2026-09-26 的工作树快照。当时
> `scripts/verify.mjs`、`check-doc-counts.mjs`、`check-runtime.mjs`、`clean.mjs`、
> `bootstrap.mjs`、`assurance-inventory.mjs`、`generate-vectors.mjs` 正被本团队其他成员
> 并行修改（见 `git status`）。**行号可能已漂移**，但函数名与行为描述是稳定的锚点——
> 迁移时请以函数名为准。

---

## 0. 执行摘要

| 结论 | 严重度 |
|---|---|
| **A. 无循环依赖**，依赖图是深度 1 的 DAG，但有 1 条脆弱边（门禁 import 门禁） | 低 |
| **B. exit code 语义不统一**：代码 2 在 3 个脚本里有 3 种含义；5 个脚本无显式 exit 0 | **中** |
| **C. `verify.mjs` 漏聚合 4 个测试套件和 2 个 CI 会跑的门禁** | **中** |
| **D. 9 类重复实现已识别**，其中 6 类"重复且行为一致"已抽为 `scripts/lib/*.mjs`（98 测试全绿） | — |
| **E. 同一事实被两个门禁用不同方式判定**：`forge scope`、`node engine floor`、`forge 二进制路径` | **高** |
| **F. `bootstrap.mjs` 是第 3 份颜色实现，且是唯一不做 `NO_COLOR` 判断的一份** | **中** |

---

## 1. 重复实现清单（含 Grep 证据）

### 1.1 仓库根路径解析 —— 14 处，2 种写法

```
join(dirname(fileURLToPath(import.meta.url)), "..")     ← 13 处
resolve(dirname(fileURLToPath(import.meta.url)), "..") ← 1 处（拼写差异，grep 漏掉）
```

| 文件:行 | 写法 |
|---|---|
| `scripts/check-doc-counts.mjs:41` | `join(...)` |
| `scripts/check-runtime.mjs:25` | `join(...)` |
| `scripts/verify.mjs:55` | `join(...)` |
| `scripts/validate-workflows.mjs:23` | `join(...)` |
| `scripts/check-dockerfile.mjs:20` | `join(...)` |
| `scripts/sync-facts.mjs:73` | `join(...)` |
| `scripts/check-waivers.mjs:50` | `join(...)` |
| `scripts/check-vectors.mjs:40` | `join(...)` |
| `scripts/generate-vectors.mjs:21` | `join(...)` |
| `scripts/bootstrap.mjs:21` | `join(...)` |
| `scripts/assurance-inventory.mjs:322` | `join(...)`（内嵌在 `parseArgs` 默认值里） |
| `scripts/clean.mjs:82` | `join(...)`（导出为 `DEFAULT_ROOT`） |
| `scripts/check-vectors.test.mjs:36` | `join(...)` |
| `scripts/benchmark-indexer.mjs:62` | **`resolve(...)`** ← 唯一异形 |

**行为是否一致**：语义一致，算法一致。`join` 与 `resolve` 在此等价（`..` 已是绝对路径的父级）。
唯一实际差异是意图：13 个脚本写 `join`，暗示"拼接"；`benchmark-indexer` 写 `resolve`，
而它后续确实依赖绝对路径规范化。抽取为 `REPO_ROOT`（`resolve` 语义）是安全的超集。

抽取时必须保留的坑：`scripts/lib/*.mjs` 位于 `scripts/lib/`，比 `scripts/` **多一层**。
任何 lib 模块若自己写 `join(dirname(fileURLToPath(import.meta.url)), "..")`，会得到
`scripts/` 而不是仓库根。`paths.mjs` 因此把 `repoRootFrom()` 的跳数**固定为 1**，
并在 JSDoc 与 `paths.test.mjs` 中显式钉住这个差异。

---

### 1.2 "我是不是入口"判定 —— 9 处，5 种不同实现（最高风险的一类）

```
scripts/check-doc-counts.mjs:984-991   isDirectInvocation()  win32-lowercase href 比较
scripts/check-waivers.mjs:485-492      isDirectInvocation()  win32-lowercase href 比较
scripts/check-vectors.mjs:721-728      isDirectInvocation()  win32-lowercase href 比较
scripts/sync-facts.mjs:1520-1524       内联 const             win32-lowercase href 比较
scripts/check-runtime.mjs:235-236      内联 const             裸 href 比较（无 win32 分支）
scripts/assurance-inventory.mjs:361    内联 if                裸 href 比较（无 win32 分支）
scripts/clean.mjs:367                  内联 if                fileURLToPath === resolve(argv[1])
scripts/check-package-artifacts.mjs:342 内联 if                fileURLToPath === argv[1]  ← 无 resolve()
scripts/benchmark-indexer.mjs:747      isMain                 isMainThread && 裸 href 比较
```

**行为是否一致**：不一致，且不一致会造成静默失效。

`check-package-artifacts.mjs:342` 的 `fileURLToPath(import.meta.url) === process.argv[1]`
**没有 `resolve()`**。Node 在入口以相对路径给出时 `argv[1]` 可以是相对的，此时比较恒为
`false` → `main()` 永不执行 → 脚本 **exit 0 且什么都没检查**。一个"永远绿的守卫"比没有守卫更危险。

`check-runtime.mjs:235` 与 `assurance-inventory.mjs:361` 缺 win32 大小写分支，在
`C:\SigilKit` vs `c:\sigilkit` 下会同样失效。

**必须保留的差异**：`benchmark-indexer.mjs:747` 额外要求 `isMainThread`——该文件同时是
CLI 入口和 worker bootstrap（`:758`）。它必须保留自己的谓词并 `&&` 本模块的谓词。
这一点已写入 `paths.mjs` 的 JSDoc「THE DIVERGENCE THIS FIXES, AND THE ONE THAT MUST STAY」。

---

### 1.3 颜色 / 输出格式化 —— 3 份实现，其中 1 份违反硬性要求

| 位置 | 形态 | `NO_COLOR` / `CI` / `isTTY` 判断 |
|---|---|---|
| `scripts/verify.mjs:136-169` | `colorsEnabled()` + `envFlag()` + `paint(code, text)` + `STATUS` 表 | 完整（UX-02，`:29-36` 声明为硬性要求） |
| `packages/core/src/logger.ts:416-457` | `textColorsEnabled()` + `envFlag(env,name)` + `paint()` | 完整，且 JSDoc 声明"改一个必须改另一个" |
| `scripts/bootstrap.mjs:36-48` | `const c = { reset, bold, dim, green, yellow, red, cyan }` + `ok/warn/bad/step` | **完全没有**——无条件写 ESC |

**这是本次评估发现的最具体的 UX-02 违规**：`npm run setup` 在 GitHub Actions 日志里会留下
原始 ESC 字节，而 `verify.mjs:29-36` 明确把这定义为"把失败报告变成噪声"。

**状态词 vs 字形**（第二类重复）：

| 位置 | 载体 |
|---|---|
| `verify.mjs:589-601` | 文字 `PASS/FAIL/SKIP/TIMEOUT` + 固定宽度 ✓ |
| `bootstrap.mjs:45-47` | 字形 `✓` / `!` / `✗` ✗ |
| `check-vectors.mjs:695` | `ok  ` / `WRONG` / `none `（半文字） |
| `check-runtime.mjs:222` | `OK:` / `FAIL:`（文字）✓ |
| `check-package-artifacts.mjs:316-326` | `skip ` / `check ` / `warn  ` / `fail  `（动词词汇） |

`✓`/`✗` 在非 UTF-8 日志、屏幕阅读器、`grep "FAIL"` 下都会丢失。这是"重复且行为不一致"，
抽取时保留差异：`reporter.mjs` 的 `bullets` 布局统一 5 个同形脚本，`verb` 布局保留
`check-package-artifacts` 的四列词汇。

`envFlag` 本身重复 2 份：`verify.mjs:145-148` 与 `logger.ts:427`，两份 JSDoc 都写明
"必须同步修改"——靠人工纪律维持的重复。

---

### 1.4 findings 协议 —— 6 处同形 + 1 处异形

```
scripts/check-dockerfile.mjs:214-226          console.log(OK) / console.error(header + `  ${p}`)
scripts/check-vectors.mjs:700-717            同上
scripts/check-waivers.mjs:467-478            同上
scripts/check-doc-counts.mjs:635-645         checkDocument(): 同上（已内部收敛为一个函数）
scripts/validate-workflows.mjs:101-106       同上
scripts/check-package-artifacts.mjs:316-326  异形：四列动词
```

**行为是否一致**：前 5 个完全一致（成功走 stdout、失败走 stderr、每条缩进 2 空格）。
第 6 个是有意设计，**保留**。

另有一个已被单个脚本内部收敛、值得推广的收敛点：`check-doc-counts.mjs:635-645` 的
`checkDocument(relativePath, checker, log)` 已经是"读 → 委托 → 报告"的三段式。

---

### 1.5 参数解析 —— 9 处，3 种方言

| 位置 | 方言 | 未知参数策略 |
|---|---|---|
| `check-runtime.mjs:227` | `argv.includes("--json")` | **静默忽略** |
| `check-package-artifacts.mjs:299,311` | `argv.includes("--json")` | **静默忽略** |
| `check-doc-counts.mjs:867,873` | `argv.includes("--write")` | **静默忽略** |
| `check-waivers.mjs:461-463` | `includes` + `find(startsWith("--today="))` | **静默忽略** |
| `clean.mjs:86-98` | `Set(argv.filter(startsWith("--")))` + `--root <dir>` | **静默忽略** |
| `verify.mjs:57-60,180-201` | `includes` + `KNOWN_FLAGS` 白名单 + 显式 `--only=` 提取 | **拒绝（exit 2）** |
| `sync-facts.mjs:1413-1429` | `KNOWN_FLAGS` 集合 + 互斥检查 | **拒绝（return 2）** |
| `benchmark-indexer.mjs:136-169` | 严格 `--key=value`，范围校验 | **拒绝（throw）** |
| `assurance-inventory.mjs:321-335` | `--root <dir>` 位置参数 | **拒绝** |

**静默忽略是真实风险**：`check-runtime.mjs --jsno` 会照常运行并 exit 0，作者以为 JSON 输出
已开启。`verify.mjs:171-178` 的注释正是为了防这个。

**值语法的真实冲突**：`verify.mjs` 只接受 `--only=`，`clean.mjs` / `assurance-inventory.mjs`
只接受 `--root <空格>`。`cli.mjs` 的 `parseArgs` 两者都接受（超集），迁移时需确认没有
现有调用方把裸 `--root` 当成别的东西。

---

### 1.6 文件读取封装 —— 5 处，3 种失败语义

| 位置 | 失败行为 |
|---|---|
| `check-runtime.mjs:121-127` `readJson` | 吞掉一切，返回 `null` |
| `check-vectors.mjs:675` | 内联 `JSON.parse`，无 catch（由 `main` 的 try 兜） |
| `bootstrap.mjs:33` | 内联 `JSON.parse`，无 catch |
| `check-package-artifacts.mjs:232,247` | 内联 `JSON.parse`，无 catch（`read` 由 `:284` 注入） |
| `sync-facts.mjs:1396-1411` `makeIo` | 五方法 io 对象，已收敛 |

**三种失败语义都是对的**，取决于调用场景：`check-runtime` 是诊断报告（不能因为清单坏掉就死），
门禁则是"我被要求检查的文件读不了"= finding。抽取为 `readText` / `readJsonOrNull` / `readJson`
**三个函数**，而不是一个带开关的函数。

### 1.7 进程执行封装 —— 8 处，**两种互相矛盾的分类**

| 位置 | 子进程失败时 |
|---|---|
| `assurance-inventory.mjs:253-261` | 返回 `null`（`result.error` **或** 非零）——尽力而为的事实 |
| `benchmark-indexer.mjs:503-507` | catch → `{commit:null, dirty:null}`——同上 |
| `bootstrap.mjs:66,81,96` | 读 `r.status`，多处 `.stdout?.trim()` 无保护 |
| `bootstrap.mjs:118,140` | 读 `r.status`，`stdio:"inherit"` |
| `check-doc-counts.mjs:713-723` | `console.error` + **`process.exit(2)`**——必需工具 |
| `check-doc-counts.mjs:840-846` | 无自己的 catch，依赖 `:899-903` 的调用方 |
| `check-doc-counts.mjs:960-969` | 从抛出的 error 上读 `.status`（唯一的子进程码透传） |
| `verify.mjs:389,450-452,465` | 异步 spawn + 预算 + 日志 tee + taskkill |

**核心矛盾**：`git rev-parse` 失败不是 finding（`assurance-inventory` 对），
`forge test --list` 失败必须是 finding（`check-doc-counts` 对）。两者都对——
所以 `cli.mjs` 的 `runSync` 用**命名的** `Outcome.TOLERATE` / `Outcome.REQUIRE`，
而不是一个 `throwOnError` 布尔量，强制每个调用点显式声明自己属于哪一类。

`verify.mjs:411-530` 的 `run()` **不抽取**：它是编排器（预算 + 日志 + 进程树终止），
且已携带全树最详尽的文档。

### 1.8 错误消息提取 —— 8 处

```
check-doc-counts.mjs:90, 141, 720, 902
benchmark-indexer.mjs:327, 340, 468, 750
```

`benchmark-indexer.mjs:589` 是**异形**：只有 `String(error)`，没有 `Error` 分支，
所以一个 `Error` 在报告里会变成 `"Error: message"`。

`check-doc-counts.mjs:182-184` `exitStatusFromError` 是**唯一**的子进程码透传，
它让 `--write` 的重验证 exit code 有意义。

### 1.9 小枚举 —— 2 类

**workspace 包名**（4 处）：`clean.mjs:46`（已导出）、`check-doc-counts.mjs:63`、
`check-doc-counts.mjs:583`、`bootstrap.mjs:146`。

**workflow 文件后缀**（4 处）：`validate-workflows.mjs:31`、`check-waivers.mjs:403`、
`check-doc-counts.mjs:854`、`assurance-inventory.mjs:234`。
其中 `check-doc-counts.mjs:854` 写成 `if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;`
—— **同一表达式的另一种括号风格，导致只 grep 一种拼写只能找到 3 处**。

**`workspaces` glob 展开器**（2 处，**故意不统一**）：
`check-runtime.mjs:130-153` 排序 + 基目录缺失时静默跳过；
`check-package-artifacts.mjs:231-270` 对缺失的必需清单 `throw`，且对 `manifest.name` 作为
fallback key 的处理不同。强行统一会悄悄选出一个赢家。

---

## 2. 依赖图

### 2.1 全量跨文件 import（3 条）

```
scripts/sync-facts.mjs:71        ──import──>  scripts/check-runtime.mjs   (parseNodeFloor)
scripts/_dbg.mjs:4               ──import──>  scripts/clean.mjs           (removeVerified)
scripts/check-waivers.test.mjs:7 ──import──>  scripts/check-waivers.mjs   (6 个导出)
```

（`scripts/lib/*.mjs` 是本次新增，只有它们内部互相 import。）

### 2.2 结论

- **无循环依赖**。依赖图是深度 1 的 DAG。
- **门禁脚本之间不互相调用**——这是对的。每个门禁独立跑，编排由 `verify.mjs` 用
  `process.execPath` 重新拉起子进程完成（`verify.mjs:542-579`），而不是 import。
  **不要**把"独立跑"改成"互相 import"：`verify.mjs:542-556` 的注释说明子进程边界是
  刻意的——它让每个门禁的 stdout/stderr/exit code 都可被 tee 和聚合。

### 2.3 一条脆弱边

`sync-facts.mjs:71` import 了一个**门禁脚本** `check-runtime.mjs`。目前安全，因为
`check-runtime.mjs:235-239` 的入口判定带 `invokedDirectly` 守卫，import 时不执行 `main()`。
但这是**隐式契约**：一旦 `check-runtime.mjs` 获得任何顶层副作用，`sync-facts` 会在
import 期就执行一个门禁。`sync-facts.mjs:87-91` 的 JSDoc 明确记录了它只取 `parseNodeFloor`
且只取"宽松读法"。

**建议**：迁移时把 `parseNodeFloor` / `parseVersion` / `meetsFloor` 下沉到 `scripts/lib/`，
让 `check-runtime.mjs` 和 `sync-facts.mjs` 都从 lib 取，删掉这条边。

### 2.4 同一事实被两个门禁用不同方式判定（最高风险）

| 事实 | 事实源 | 消费者 A | 消费者 B | 谁在断言一致性 |
|---|---|---|---|---|
| **forge test scope** | `scripts/foundry-scope.json` | `verify.mjs:576` 硬编码 argv `".*Invariant\|.*Fork"` | `check-doc-counts.mjs:45` `EXCLUDED = /Invariant\|Fork/` | `sync-facts.mjs:521-529` 声明 7 个消费者——**但 sync-facts 不在 CI 里跑** |
| **node engine floor** | `package.json` `engines.node` | `check-runtime.mjs:36-41` 宽松解析 + `DEFAULT_FLOOR=24` | `bootstrap.mjs:34` **digit-slice**（三位数 major 会静默截断） | `sync-facts.mjs:864-887` 专门报告这个脆弱解析——**同样不在 CI 里跑** |
| **node major（benchmark）** | 同上 | `benchmark-indexer.mjs:58` `REQUIRED_NODE_MAJOR = 24` **硬编码常量** | — | 无 |
| **CI job count** | `.github/workflows/*.yml` | `check-doc-counts.mjs:848-864` `ciJobCount()` | `assurance-inventory.mjs:230-243` `inventoryCi()` | 只有 `check-doc-counts` 断言文档数字；`assurance-inventory` 只发布不断言 |
| **forge 二进制路径** | `FORGE_BIN` / `~/.foundry/bin` / PATH | `verify.mjs:381-391` `resolveForge()` **校验存在性** | `check-doc-counts.mjs:42` `process.env.FORGE_BIN ?? "forge"` **不校验** | 无 |
| **ABI 清单** | `scripts/abi-targets.txt` | `ci.yml:226-234` shell 循环 | `packages/core/test/abi-drift.test.ts` | 两侧都读同一文件（`abi-targets.txt:4-6` 明确记录）——**这是全树唯一正确的双消费者模式** |

三条应当记录的结论：

1. **`sync-facts.mjs` 不在 CI 里跑**。`grep -rn "sync-facts"` 在 `*.yml`/`*.yaml`/`package.json`
   中**零命中**（唯一提及在 `scripts/foundry-scope.json:2` 的注释里）。它是全树唯一
   交叉验证 7 个 scope 消费者 + 5 个 engine floor 消费者的守卫，却只能手动运行。
   它的存在使 `verify.mjs:576` 与 `check-doc-counts.mjs:45` 的硬编码**当前是一致的**——
   但这个一致性没有任何自动化在守。

2. **`deriveJsExclude` 存在潜在语义断裂**（`sync-facts.mjs:253-262`）。它把
   `unitExclude` 每个分支的前导 `^` 和 `.*` 剥掉生成 JS 镜像。若将来 `unitExclude` 有一个
   分支是 `^Suite$`，镜像会变成 `Suite$`——作为**无锚点**的 `RegExp`
   （`sync-facts.mjs:230-231` 明确说明故意不加锚点）意思是"包含以 Suite 结尾的串"，
   而 forge 的 `^Suite$` 意思是"**恰好**是 Suite"。两者会静默分歧，且 `--write` 会
   自动把这个错误镜像写回文件。

3. **`FORGE_BIN` 校验不一致**。`verify.mjs:386` 检查 `existsSync`，`check-doc-counts.mjs:42`
   不检查。当 `FORGE_BIN` 指向不存在的路径时，`verify.mjs:556` 仍会把它传给
   `check-doc-counts`，后者在 `:722` `process.exit(2)`——**exit 2 会被 `verify.mjs:489`
   的 `passed = !timedOut && code === 0` 记为普通 FAIL**，报告说"doc counts 失败"，
   而真相是"工具跑不起来"。这直接连到下一节。

---

## 3. Exit code 对照表

### 3.1 目标契约

```
0  检查跑完，通过
1  检查跑完，发现问题
2  检查无法按要求执行（参数错误 / 工具缺失 / 输入不可读）
```

### 3.2 现状

| 脚本 | 0 | 1 | 2 | 备注 |
|---|---|---|---|---|
| `verify.mjs` | `:360`(`--list` 查询), `:703` | `:703` | `:177` `abort()` | 三值齐全 |
| `sync-facts.mjs` | `:1525` `exitCode=main()` | `:1366` verdict | `:1442` 参数错误, `:1450` **仓库读不了**, `:1465` 写白名单外 | **2 有 3 种含义** |
| `check-doc-counts.mjs` | `:931` | `:980` drift, `:973` 重验证状态 | `:722` **forge 缺失** | **2 = 工具缺失，与他处含义不同** |
| `check-runtime.mjs` | `:238` `exitCode=verdict.exitCode` | `:101` verdict | — | 无 2 |
| `check-waivers.mjs` | 隐式（`:483` 落到底） | `:477` | — | 无 2；**警告走 stdout，失败走 stderr** |
| `check-vectors.mjs` | `:708` | `:686` 解析失败, `:717` findings | — | 无 2 |
| `check-package-artifacts.mjs` | `:313`, `:339` | `:304`, `:313`, `:331` | — | 无 2 |
| `check-dockerfile.mjs` | `:221` | `:97`, `:226` | — | 无 2 |
| `validate-workflows.mjs` | 隐式（`:108`） | `:28` 无目录, `:34` 无文件, `:105` findings | — | **环境问题报成 1** |
| `assurance-inventory.mjs` | `:362` | `:344`, `:352` | — | **参数错误报成 1**（`:341-345`） |
| `bootstrap.mjs` | `:168` | `:171` | — | 无 2 |
| `clean.mjs` | 隐式 | `:363` `exitCode=1` | — | 无 2 |
| `benchmark-indexer.mjs` | 隐式 | `:752` `exitCode=1` | — | 无 2 |
| `generate-vectors.mjs` | 隐式 | 未捕获异常 → Node 默认 1 | — | 无显式 2 |

### 3.3 不一致清单

| # | 问题 | 证据 | 对 CI 的实际影响 |
|---|---|---|---|
| **X1** | **代码 2 语义分裂**：`verify`=参数错误，`sync-facts`=参数错误+仓库读不了+写白名单外，`check-doc-counts`=**forge 缺失** | `verify.mjs:177` / `sync-facts.mjs:1442,1450,1465` / `check-doc-counts.mjs:722` | 任何按 2 分支的包装器都无法判断该重试、该装工具、还是该改参数 |
| **X2** | **环境问题被报成 finding**：`validate-workflows.mjs:28,34`（无目录/无文件）、`assurance-inventory.mjs:344`（参数错误）、`:352`（root 不是目录）全部 exit 1 | 同左 | `continue-on-error` 无法区分"仓库坏了"和"检查发现问题" |
| **X3** | **编排器吞掉 2**：`verify.mjs:489` `const passed = !timedOut && code === 0;` —— 2 与 1 都记为 FAIL | `verify.mjs:489` | 报告说"doc counts FAIL"，真相是"forge 跑不起来"。**这是 X1 的实际危害** |
| **X4** | **5 个脚本无显式 exit 0**：`check-waivers` `validate-workflows` `clean` `benchmark-indexer` `generate-vectors` | 各见上表 | 靠"落到底"退出。若将来加了一个设置 `process.exitCode` 的早退分支，会静默变成非零 |
| **X5** | **子进程码透传只在一处**：`check-doc-counts.mjs:182-184` + `:973` | 同左 | 其余脚本即使包装了子进程也无法转发其码 |

关于 `continue-on-error`：`ci.yml` 里 3 个 `continue-on-error: true`
（`:335` wallet-e2e-weekly、`:400` echidna-nightly、`:418` foundry-canary）
**都不跑 `scripts/` 下的任何门禁**，所以 exit code 分裂**当前不会**直接使这 3 个
waiver 判断失效。真正受影响的是 `verify.mjs` 的聚合报告与任何未来按码分支的包装器。
但 `check-waivers.mjs` 正是这些 waiver 的守卫——**守卫本身的退出码语义是分裂的**
（X2），这个讽刺值得记一笔。

---

## 4. `verify.mjs` 作为编排器的正确性

### 4.1 9 个步骤（`verify.mjs:76-86` 的 `LABELS`）

`lint` → `packaging` → `helpers` → `docs` → `build` → `typecheck` → `artifacts` → `contracts` → `tests`

### 4.2 漏项

**A. `helpers` 步骤漏 4 个测试套件**（`verify.mjs:546-555` 只列了 7 个）：

| 测试文件 | 在 `verify` helpers？ | 在 CI？ |
|---|---|---|
| `check-dockerfile.test.mjs` | 有 `:548` | 有 `ci.yml:64` |
| `check-doc-counts.test.mjs` | 有 `:549` | 有 `ci.yml:68` |
| `verify.test.mjs` | 有 `:550` | 有 `ci.yml:68` |
| `check-package-artifacts.test.mjs` | 有 `:551` | 有 `ci.yml:74` |
| `check-runtime.test.mjs` | 有 `:552` | 有 `ci.yml:74` |
| `assurance-inventory.test.mjs` | 有 `:553` | 有 `ci.yml:74` |
| `benchmark-indexer.test.mjs` | 有 `:554` | 有 `ci.yml:74` |
| **`check-waivers.test.mjs`** | **缺** | 有 `ci.yml:57` |
| **`check-vectors.test.mjs`** | **缺** | 有 `ci.yml:192` |
| **`clean.test.mjs`** | 缺 | 也不在 CI |
| **`sync-facts.test.mjs`** | 缺 | 也不在 CI |

这与 `verify.mjs:19-20` 自己声明的意图（"守卫/辅助回归套件是门禁步骤，所以它们无法在门禁外腐烂"）
直接冲突。**本地 `npm run verify` 的绿色比 CI 的绿色覆盖更窄**，方向与
`verify.mjs:665-671` 那段"本地绿不等于 CI 绿"的告警相反——这里连列出的 CI-only 项都是错的。

**B. 两个 CI 会跑的门禁完全不在 `verify` 里**：

| 门禁 | CI | verify |
|---|---|---|
| `check-waivers.mjs` | 有 `ci.yml:59` | **无步骤** |
| `check-vectors.mjs` | 有 `ci.yml:190` | **无步骤** |
| `check-runtime.mjs` | 只跑它的测试 `ci.yml:74` | 无（同上） |
| `sync-facts.mjs` | 无 | 无 |
| `assurance-inventory.mjs` | 无 | 无 |

`check-waivers` 尤其值得注意：它是**唯一**让 `continue-on-error` 治理机器化的守卫
（`check-waivers.mjs:5-10`），而它不在本地门禁里。

**C. 顺序正确**：`build` 在 `typecheck`/`artifacts` 之前（`verify.mjs:557-564` 的注释
"与 CI 一致：先生成 workspace 输出再检查依赖它的类型"），与 `ci.yml:165,196` 一致。

**D. `verify.mjs:606` 的 `CI_ONLY_GATES` 名单**（`slither, gitleaks, halmos, fork, deep-fuzz`）
与 `ci.yml` 实际 job 对得上（`ci.yml:115` slither、`:133` secret-scan/gitleaks、
`:307` halmos、`:273` fork、`:237` deep-fuzz）。名单本身准确——但它没列出
`check-waivers`/`check-vectors`，因为那两个不是 CI-only，而是**本地也该跑却没跑**。

---

## 5. 共享模块设计（本次实际产出）

新建 5 个模块 + 5 个测试文件，全部在 `scripts/lib/`。**未修改任何现有脚本**
（`git status` 中 `scripts/lib/` 是本次唯一新增项；其余 `scripts/` 的 `M` 标记来自并行的其他成员）。

| 模块 | 抽自 | 消除的重复 | 测试数 |
|---|---|---|---|
| `paths.mjs` | 14 处根路径 + 9 处入口判定 | 1.1 / 1.2 | 12 |
| `exit.mjs` | 8 处消息提取 + 1 处子进程码透传 | 1.8 / 3 | 13 |
| `reporter.mjs` | 2 份完整颜色实现 + 6 处 findings 协议 + `envFlag` ×2 | 1.3 / 1.4 | 22 |
| `fs-json.mjs` | 5 处文件读取 + 2 类小枚举 | 1.6 / 1.9 | 21 |
| `cli.mjs` | 9 处参数解析 + 8 处进程执行 | 1.5 / 1.7 | 24 |

**合计 98 个测试，`node --test "scripts/lib/*.test.mjs"` 全绿。**

### 5.1 设计原则

1. **不改变行为**。每个模块的头部 JSDoc 写明"从哪些 `路径:行号` 抽取"、
   "哪些差异被刻意保留"、"将来谁该改用它"。`isWorkflowFile(".yml") === true` 这类
   与原实现一致但未必正确的行为，被测试**钉为 parity** 并注明"收紧它是另一个刻意行为"。
2. **差异用不同函数表达，不用开关**。三个 reader（`readText`/`readJsonOrNull`/`readJson`）、
   两个 `Outcome`、两种 reporter 布局——而不是 `failSilently: true`。
3. **注入优于全局**。所有 I/O 走参数注入（`io = undefined` 默认真实 fs），
   与 `check-package-artifacts.mjs:284` 和 `sync-facts.mjs:1396` 的现有风格一致。
4. **测试是真进程**。`cli.test.mjs` 用真实 `spawnSync` 而非 stub，因为
   `TOLERATE`/`REQUIRE` 的分歧恰恰在于 `spawnSync` 的 `status` vs `error` 语义。

### 5.2 关键 API

```js
// paths.mjs
REPO_ROOT, SCRIPTS_DIR, LIB_DIR      // 常量
repoRootFrom(importMetaUrl)          // 固定 1 跳（lib 模块必须用 REPO_ROOT）
repoPath(root, rel)                  // "docs/STATUS.md" → 绝对路径
isDirectInvocation(moduleUrl, entry?)// win32 容错 + resolve；null/"" = 无入口

// exit.mjs
EXIT = { OK: 0, FAIL: 1, USAGE: 2 }  // frozen
messageOf(err)                       // Error → .message，无 "Error: " 前缀
exitStatusFromChild(err)             // err.status ?? EXIT.FAIL
reportUsage(tool, msg, usage?, write?)

// reporter.mjs
colorsEnabled(env?, isTty?)          // 与 verify.mjs:136-142 / logger.ts:416-424 同序
paint(code, text, on?)               // 复合属性只发一个 reset
bareWord(status, on?) / statusWord(status, on?)   // 前者无填充（独立标签）/ 后者定宽（表格列）
createReporter({ name, layout, stdout, stderr, handlePipeErrors, colors })

// fs-json.mjs
WORKSPACES, WORKFLOW_SUFFIXES        // frozen
isWorkflowFile(name) / workflowFiles(entries)
readText(path, io?) / readJsonOrNull(path, io?) / readJson(path, io?) / listDir(dir, io?)

// cli.mjs
parseArgs(argv, spec, { allowUnknown })   // 默认拒绝未知参数；错误带 .usageError
isUsageError(err) / usage(lines, spec, extra?)
Outcome.TOLERATE | Outcome.REQUIRE
runSync(file, args, opts)            // 默认 TOLERATE；.text 仅成功时非 null
runJsonSync(file, args, opts)        // 任何失败 → null
```

### 5.3 已知的一处 API 陷阱（已文档化 + 已测试）

`isDirectInvocation(moduleUrl, entry = process.argv[1])`——**传 `undefined` 会选默认值**，
所以"无入口"必须传 `null` 或 `""`。这已写入 JSDoc 的 `@param` 并由
`paths.test.mjs` 的 `"falls back to process.argv[1] when the entry is omitted"` 钉住。

---

## 6. 迁移计划

**总原则**：一次一个脚本，每个 PR 只碰一个门禁 + 它的测试，跑完 6.1 的四道验证再进下一个。
`scripts/lib/` 的存在不改变任何现有行为，所以第一批迁移可以是纯机械替换。

### 6.1 每步的验证清单（缺一不可）

```bash
node --test "scripts/lib/*.test.mjs"           # 1. 共享模块自身仍绿
node --test scripts/<name>.test.mjs            # 2. 该门禁的既有测试仍绿（不允许改断言）
node scripts/<name>.mjs; echo "exit=$?"       # 3. 退出码与迁移前逐字节一致
node scripts/verify.mjs --only=<step> --json   # 4. 编排器视角：该步骤 ok/passed 不变
```

**第 3 步是关键的**：迁移前后各跑一次，把 stdout / stderr / exit code 存下来 `diff`。
若不一致，先判断是行为变化还是 bug 修复——两者都需要在 PR 里显式说明，不能顺手带过。

### 6.2 迁移顺序（按风险从低到高）

| # | 目标 | 动作 | 风险 | 备注 |
|---|---|---|---|---|
| **1** | `validate-workflows.mjs` | 换 `REPO_ROOT` + `isDirectInvocation` + `reporter`（bullets）+ `workflowFiles` | 最低 | 109 行，无导出纯函数。**顺带修 `:28,:34` 的 exit 1 → 2**（X2） |
| **2** | `check-dockerfile.mjs` | 换 `REPO_ROOT` + `reporter` | 低 | 已有 `check-dockerfile.test.mjs`，断言 `status` 与合并输出 |
| **3** | `check-vectors.mjs` | 换 `REPO_ROOT` + `isDirectInvocation` + `readJsonOrNull` + `bareWord`（替 `:695` 的 `ok  `/`WRONG`） | 低 | 已有 43KB 测试；`:695` 的三态标记改为 `PASS`/`FAIL`/`WARN` 文字，**这是可见的输出变化，需在 PR 说明** |
| **4** | `check-waivers.mjs` | 换 `REPO_ROOT` + `isDirectInvocation` + `reporter` + `workflowFiles` | 低 | 已有 22KB 测试。顺带把它加进 `verify.mjs` 的门禁（4.2B）——但这会碰 `verify.mjs`，与其他成员冲突，**必须排在其 PR 之后** |
| **5** | `check-doc-counts.mjs` | 换 `EXIT` + `messageOf`（4 处）+ `REPO_ROOT` + `repoPath`（2 处）+ `reporter` + `cli.runSync`（`:716` forge，REQUIRE）+ `runJsonSync`（`:841`） | 中 | 已有 33KB 测试。`:722` 的 `exit(2)` 语义与 `EXIT.USAGE` 不同（是工具缺失），**保留原样并加注释**，或与 3.3 X1 一起决策 |
| **6** | `check-package-artifacts.mjs` | 换 `REPO_ROOT` + `isDirectInvocation` + `readJson`（注入 `read`）+ `reporter`（**verb 布局**） | 中 | `:342` 的无 `resolve()` 比较会**改变行为**（守卫开始真的运行）。这是**修 bug**，PR 必须显式声明 |
| **7** | `check-runtime.mjs` | 把 `parseVersion`/`parseNodeFloor`/`meetsFloor` **下沉到 `lib/`**，`sync-facts.mjs` 改从 lib 导入 | 中 | 消除 2.3 的脆弱边。会改 `sync-facts.mjs:71` 的 import——**与其他成员协商** |
| **8** | `verify.mjs` | 采纳 `reporter.STATUS` 表；补 4 个 helpers；补 `waivers`/`vectors` 两个步骤 | 中 | 风险不在抽取而在**补漏**：新增步骤会改变 `--list` 输出与 `--json` 文档形状，`verify.test.mjs` 需同步。**必须等 1-7 全部落地后单独做** |
| **9** | `bootstrap.mjs` | 换 `REPO_ROOT` + `cli.parseArgs` + `reporter`（替 `ok/warn/bad/step`） | 中 | **顺带修 1.3 的颜色违规**：加 `colorsEnabled` 判断后，CI 日志不再有裸 ESC。这是可见行为变化 |
| **10** | `sync-facts.mjs` / `clean.mjs` / `benchmark-indexer.mjs` / `assurance-inventory.mjs` / `generate-vectors.mjs` | 各自换 `REPO_ROOT` + `EXIT` + `messageOf` | 低 | 机械替换，可并行 |

### 6.3 明确不迁移的部分

| 不迁移 | 原因 |
|---|---|
| `verify.mjs:411-530` 的 `run()` | 编排器（预算 + 日志 tee + 进程树终止），不是 helper；已携带全树最详尽的文档 |
| `check-doc-counts.mjs:635-645` 的 `checkDocument()` | 已被单脚本内部收敛，是好模式但只此一处；抽到 lib 会引入"只有一个调用点"的公共 API |
| `check-runtime.mjs:130-153` 与 `check-package-artifacts.mjs:231-270` 的 workspaces 展开器 | 行为**真的不同**（静默跳过 vs throw；`manifest.name` fallback 不同）。统一会悄悄选赢家 |
| `check-waivers.mjs:78-91` `makeLocator` / `sync-facts.mjs:364-435` `blankComments` | 都是各自领域专用的源码扫描器，虽形似（都保留行号/偏移）但正则与状态机不同，合并等于重写 |
| `bootstrap.mjs:76-84` `resolveFoundry` | 与 `verify.mjs:381-391` `resolveForge()` 形似，但前者还要解析 `ANVIL_BIN`（`:99`）且不校验 `existsSync(env)` 之后的 PATH 探测行为不同。**这个应当合并但需要单独一个 PR**——见 6.4 |

### 6.4 一个应当合并但需单独 PR 的点

`bootstrap.mjs:76-84` `resolveFoundry(name)` 与 `verify.mjs:381-391` `resolveForge()`：

```
FORGE_BIN/ANVIL_BIN env + existsSync  →  ~/.foundry/bin/{name[.exe]} + existsSync
→  spawnSync(name, ["--version"]) 探测
```

逻辑逐行同构，差异是：`bootstrap` 泛化到 `anvil`（`:99`）、用 `shell:true` 跑 npm（`:66`）、
且 `verify` 有测试钩子 `VERIFY_FORCE_NO_FORGE`（`:385`）而 `bootstrap` 没有。
建议抽 `lib/forge.mjs: resolveFoundryBin(name, { env, home, platform, probe })`，
两个脚本各自传入自己的 `probe`。**这是本次评估之外的新增建议**，因为它需要改
`bootstrap.mjs`（其他成员在改），本次不实施。

---

## 7. 给团队的具体请求

1. **§4.2A/B 的漏项需要有人认领**。`verify.mjs` 的 `helpers` 少 4 个套件、少 2 个门禁，
   这不是我的独占范围（`verify.mjs` 正被他人修改），但发现记录在此。
2. **`sync-facts.mjs` 应该进 CI**（§2.4 结论 1）。它是全树唯一的跨文件事实守卫，
   目前只能手动运行。加一行 `ci.yml` 即可，成本极低，收益是让 7 个 scope 消费者
   和 5 个 engine floor 消费者的自动一致性。
3. **迁移请按 6.2 的顺序**，且每个 PR 附上 6.1 第 3 步的 stdout/exit code diff。
   `scripts/lib/` 已经全绿且零行为变更，任何一个门禁的迁移失败都能立刻定位到
   "是抽取错了还是原实现有 bug"。
4. **本文件的行号会随并行修改漂移**。函数名（`isDirectInvocation`、`resolveForge`、
   `checkDocument`、`makeIo`）是稳定锚点，引用时请优先用函数名。
