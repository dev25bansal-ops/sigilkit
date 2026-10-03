# scripts/ 架构评估：重复实现、依赖方向与进程契约

**日期**：2026-09-26 · **范围**：`d:/SigilKit/scripts/`
**作者**：sc-arch · **性质**：只读分析 + 新建共享模块，**未修改任何现有脚本**

> **行号快照声明**：本文所有 `路径:行号` 证据取自 2026-09-26 的工作树快照。当时
> `verify.mjs`、`check-doc-counts.mjs`、`check-runtime.mjs`、`clean.mjs`、`bootstrap.mjs`、
> `assurance-inventory.mjs`、`generate-vectors.mjs`、`validate-workflows.mjs`、
> `check-package-artifacts.mjs` 正被本团队其他成员并行修改。**行号可能已漂移**，
> 但函数名是稳定的锚点——迁移与引用请优先用函数名。

> **勘误（2026-09-26 晚，同日修正）**：本文 §1.2 最初断言
> `check-package-artifacts.mjs` 的入口判定"因缺 `resolve()` 而恒为 false，脚本 exit 0
> 且什么都没检查"。**该断言是错的，已撤回**，实测证据见 §1.2 的更正框。请勿据原文行动。

---

## 0. 执行摘要

| 结论 | 严重度 |
|---|---|
| **A. 无循环依赖**，依赖图是深度 1 的 DAG，但有 1 条脆弱边（门禁 import 门禁） | 低 |
| **B. exit code 语义不统一**：代码 2 在 3 个脚本里有 3 种含义；5 个脚本无显式 exit 0 | **中** |
| **C. `verify.mjs` 漏聚合 4 个测试套件和 2 个 CI 会跑的门禁** | **中** |
| **D. 9 类重复实现已识别**，6 类"重复且行为一致"已抽为 `scripts/lib/*.mjs`（98 测试全绿） | — |
| **E. 同一事实被两个门禁用不同方式判定**：`forge scope`、`node engine floor`、`forge 二进制路径` | **高** |
| **F. `bootstrap.mjs` 是第 3 份颜色实现，且是唯一不做 `NO_COLOR` 判断的一份** | **中** |
| **G. fixture 单文件拷贝模式与 `lib/` 共享库迁移直接冲突**（§1.10）——这是迁移的**硬阻塞**，改变了 §6 的顺序 | **高** |
| **H. `sync-facts.mjs` 不在 CI 里跑**，而它是全树唯一的跨文件事实守卫 | **高** |

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
差异仅在意图：13 个写 `join` 暗示"拼接"，`benchmark-indexer` 写 `resolve` 且后续确实依赖
绝对路径规范化。抽取为 `REPO_ROOT`（`resolve` 语义）是安全的超集。

抽取时必须保留的坑：`scripts/lib/*.mjs` 位于 `scripts/lib/`，比 `scripts/` **多一层**。
任何 lib 模块若自己写 `join(dirname(fileURLToPath(import.meta.url)), "..")`，会得到
`scripts/` 而不是仓库根。`paths.mjs` 因此把 `repoRootFrom()` 的跳数**固定为 1**，
并在 JSDoc 与 `paths.test.mjs` 中显式钉住这个差异。

---

### 1.2 "我是不是入口"判定 —— 9 处，3 种实现

```
scripts/check-doc-counts.mjs:984-991   isDirectInvocation()  win32-lowercase href 比较
scripts/check-waivers.mjs:485-492      isDirectInvocation()  win32-lowercase href 比较
scripts/check-vectors.mjs:721-728      isDirectInvocation()  win32-lowercase href 比较
scripts/sync-facts.mjs:1520-1524       内联 const             win32-lowercase href 比较
scripts/check-runtime.mjs:235-236      内联 const             裸 href 比较（无 win32 分支）
scripts/assurance-inventory.mjs:361    内联 if                裸 href 比较（无 win32 分支）
scripts/clean.mjs:367                  内联 if                fileURLToPath === resolve(argv[1])
scripts/check-package-artifacts.mjs:353 内联 if                fileURLToPath === argv[1]（无 resolve）
scripts/benchmark-indexer.mjs:747      isMain                 isMainThread && 裸 href 比较
```

> **勘误：撤回"缺 `resolve()` ⇒ 永久静默失效"的断言。**
> 我曾写道 `check-package-artifacts.mjs:342` 的 `fileURLToPath(import.meta.url) === process.argv[1]`
> 在相对入口下恒为 false，会让守卫 exit 0 且什么都不检查。**实测否证**：Node 24 会把
> `argv[1]` 解析成绝对路径。
>
> ```
> $ node outputs/_argv_probe.mjs        # 相对入口
> {"argv1":"D:\\SigilKit\\outputs\\_argv_probe.mjs",
>  "importMetaPath":"D:\\SigilKit\\outputs\\_argv_probe.mjs",
>  "equalUnresolved":true}             ← 两者本就相等
> ```
>
> 且 `node scripts/check-package-artifacts.mjs --jsno` 实测输出
> `unrecognized argument(s): --jsno` 且 `LASTEXITCODE=2`——`main()` **确实执行了**。
> 该行**不是**死代码。
>
> **仍然成立的真实风险**：这一族里 3 个"裸 href 比较"
> （`check-runtime.mjs:236`、`assurance-inventory.mjs:361`、`benchmark-indexer.mjs:747`）
> **没有 win32 大小写分支**。在同一台机器上以 `D:\sigilkit\...`（小写盘符）
> 调用 `D:\SigilKit\...` 的脚本时比较为 false。这是 §1.2 剩下的**唯一**实质问题，
> 严重度**低**（需要非常规的大小写写法才会触发），但会让守卫静默不运行。
> `paths.mjs` 的 `isDirectInvocation` 带 win32 分支，正是修这一条。

**必须保留的差异**：`benchmark-indexer.mjs:747` 额外要求 `isMainThread`——该文件同时是
CLI 入口和 worker bootstrap（`:758`）。它必须保留自己的谓词并 `&&` 本模块的谓词。
已写入 `paths.mjs` 的 JSDoc「THE DIVERGENCE THIS FIXES, AND THE ONE THAT MUST STAY」。

---

### 1.3 颜色 / 输出格式化 —— 3 份实现，其中 1 份违反硬性要求

| 位置 | 形态 | `NO_COLOR` / `CI` / `isTTY` 判断 |
|---|---|---|
| `scripts/verify.mjs:136-169` | `colorsEnabled()` + `envFlag()` + `paint(code, text)` + `STATUS` 表 | 完整（UX-02，`:29-36` 声明为硬性要求） |
| `packages/core/src/logger.ts:416-457` | `textColorsEnabled()` + `envFlag(env,name)` + `paint()` | 完整，JSDoc 声明"改一个必须改另一个" |
| `scripts/bootstrap.mjs:36-48` | `const c = { reset, bold, dim, green, yellow, red, cyan }` + `ok/warn/bad/step` | **完全没有**——无条件写 ESC |

**这是本次评估发现的最具体的 UX-02 违规**：`npm run setup` 在 GitHub Actions 日志里留下
原始 ESC 字节，而 `verify.mjs:29-36` 明确把这定义为"把失败报告变成噪声"。

**状态词 vs 字形**：

| 位置 | 载体 |
|---|---|
| `verify.mjs:589-601` | 文字 `PASS/FAIL/SKIP/TIMEOUT` + 固定宽度 ✓ |
| `bootstrap.mjs:45-47` | 字形 `✓` / `!` / `✗` ✗ |
| `check-vectors.mjs:695` | `ok  ` / `WRONG` / `none `（半文字） |
| `check-runtime.mjs:222` | `OK:` / `FAIL:`（文字）✓ |
| `check-package-artifacts.mjs:327-337` | `skip ` / `check ` / `warn  ` / `fail  `（动词词汇） |

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
scripts/validate-workflows.mjs:117-122       同上
scripts/check-package-artifacts.mjs:327-343  异形：四列动词
```

**行为是否一致**：前 5 个完全一致（成功走 stdout、失败走 stderr、每条缩进 2 空格）。
第 6 个是有意设计，**保留**。

`check-doc-counts.mjs:635-645` 的 `checkDocument(relativePath, checker, log)` 已经是
"读 → 委托 → 报告"的三段式，是好模式但只有一处调用点，不宜抽成公共 API。

---

### 1.5 参数解析 —— 3 种方言（**本日已变化，见下**）

| 位置 | 方言 | 未知参数策略 |
|---|---|---|
| `check-runtime.mjs:227` | `argv.includes("--json")` | **静默忽略** ← 仍在飞行中，警告仍有效 |
| `check-doc-counts.mjs:867,873` | `argv.includes("--write")` | **静默忽略** |
| `check-waivers.mjs:461-463` | `includes` + `find(startsWith("--today="))` | **静默忽略** |
| `clean.mjs:86-98` | `Set(argv.filter(startsWith("--")))` | **静默忽略** |
| **`validate-workflows.mjs:36-40`** | `process.argv.length > 2` → exit 2 | **拒绝** ← **本日新增** |
| **`check-package-artifacts.mjs:287-292`** | `slice(2).filter(a => a !== "--json")` → exit 2 | **拒绝** ← **本日新增** |
| `verify.mjs:57-60,180-186` | `includes` + `KNOWN_FLAGS` 白名单 + 显式 `--only=` 提取 | 拒绝（exit 2） |
| `sync-facts.mjs:1413-1429` | `KNOWN_FLAGS` 集合 + 互斥检查 | 拒绝（return 2） |
| `benchmark-indexer.mjs:136-169` | 严格 `--key=value`，范围校验 | 拒绝（throw） |
| `assurance-inventory.mjs:321-335` | `--root <dir>` 位置参数 | 拒绝 |

**静默忽略仍是真实风险**：`check-runtime.mjs:227` 至今用 `argv.includes("--json")`，
`--jsno` 会照常运行并 exit 0，作者以为 JSON 输出已开启。
`validate-workflows` 与 `check-package-artifacts` 已由 sc-e2e 的 D1 工作修掉，
两处都打印了"我检查的是哪个树"——这比只报错更好，因为它排除了最危险的误读
（以为在检查别的 checkout）。

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
| `check-package-artifacts.mjs:232,247` | 内联 `JSON.parse`，无 catch（`read` 由 `:295` 注入） |
| `sync-facts.mjs:1396-1411` `makeIo` | 五方法 io 对象，已收敛 |

**三种失败语义都是对的**：`check-runtime` 是诊断报告（不能因清单坏掉就死），
门禁则是"我被要求检查的文件读不了"= finding。抽取为 `readText` / `readJsonOrNull` /
`readJson` **三个函数**，而不是一个带开关的函数。

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
而不是 `throwOnError` 布尔量，强制每个调用点显式声明属于哪一类。

`verify.mjs:411-530` 的 `run()` **不抽取**：它是编排器（预算 + 日志 + 进程树终止），
已携带全树最详尽的文档。

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

**workflow 文件后缀**（4 处）：`validate-workflows.mjs:47`、`check-waivers.mjs:403`、
`check-doc-counts.mjs:854`、`assurance-inventory.mjs:234`。
其中 `check-doc-counts.mjs:854` 写成 `if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;`
—— **同一表达式的另一种括号风格，只 grep 一种拼写只能找到 3 处**。

**`workspaces` glob 展开器**（2 处，**故意不统一**）：
`check-runtime.mjs:130-153` 排序 + 基目录缺失时静默跳过；
`check-package-artifacts.mjs:231-270` 对缺失的必需清单 `throw`，
且对 `manifest.name` 作为 fallback key 的处理不同。强行统一会悄悄选出一个赢家。

### 1.10 fixture 单文件拷贝模式 —— 与 `lib/` 迁移**直接冲突**（硬阻塞）

**这是本次评估最重要的可执行发现，且它改变了 §6 的迁移顺序。**

三个门禁的测试套件把**门禁脚本单独拷进一个临时仓库**再执行：

```
scripts/validate-workflows.test.mjs:50-60      writeFileSync(join(root,"scripts","validate-workflows.mjs"), readFileSync(SCRIPT_SRC))
scripts/check-dockerfile.test.mjs:13           copyFileSync(new URL("./check-dockerfile.mjs", import.meta.url), join(root,"scripts/check-dockerfile.mjs"))
scripts/check-package-artifacts.test.mjs:186   spawnSync(process.execPath, [join(root,"scripts/check-package-artifacts.mjs"), ...])
```

这三个 fixture **只拷那一个文件**，不拷 `scripts/lib/`。因此一旦门禁脚本
`import ... from "./lib/exit.mjs"`，fixture 里的副本就找不到该模块，
**每一个 fixture 都会以 `ERR_MODULE_NOT_FOUND` 失败**。

sc-e2e 已经踩到并做了正确的规避：`validate-workflows.mjs:31-35` 内联了 `reportUsage`
的两行，并留下注释说明原因（"Two duplicated lines beat a broken suite"）。
`check-package-artifacts.mjs:287-292` 同样内联。

**两种解法，推荐第二种**：

| 方案 | 做法 | 代价 |
|---|---|---|
| A. 保持内联 | 每个门禁各自写 `{tool}: {msg}` 两行，接受重复 | 3 处重复，且 `reportUsage` 的存在名不副实 |
| **B. 修 fixture（推荐）** | 让 `fixture()` 额外拷 `scripts/lib/`（或整个 `scripts/` 目录树） | 需要改 3 个测试文件，但一次性解开**所有** lib 模块对这 3 个门禁的阻塞 |

**B 的可行性已被验证**：`validate-workflows.test.mjs:50-60` 的 fixture 特意建在
`REPO_ROOT/outputs/` 而非 `os.tmpdir()`，注释（`:43-49`）说明原因是
"tmpdir 可能在另一个 Windows 卷（D: vs C:），目录联接无法跨卷"。
既然 fixture 已经在仓库树内、且已用 `mkdtemp` + `t.after` 清理，
多拷一个 `scripts/lib/` 目录没有任何额外代价。

**§6 的迁移顺序据此调整**：任何门禁在迁移到 `lib/` 之前，必须先修它自己的 fixture（或 §6.0 一次性全修）。

---

## 2. 依赖图

### 2.1 全量跨文件 import

```
scripts/sync-facts.mjs:71        ──import──>  scripts/check-runtime.mjs   (parseNodeFloor)
scripts/_dbg.mjs:4               ──import──>  scripts/clean.mjs           (removeVerified)
scripts/check-waivers.test.mjs:7 ──import──>  scripts/check-waivers.mjs   (6 个导出)
scripts/lib/cli.mjs              ──import──>  scripts/lib/exit.mjs        (messageOf)
```

（`scripts/lib/*` 是本次新增。）

### 2.2 结论

- **无循环依赖**。依赖图是深度 1 的 DAG。
- **门禁之间不互相调用**——这是对的。编排由 `verify.mjs` 用 `process.execPath`
  重新拉起子进程完成（`:542-579`），而不是 import。**不要**改成互相 import：
  `verify.mjs:542-556` 的注释说明子进程边界是刻意的——它让每个门禁的
  stdout/stderr/exit code 都可被 tee 和聚合。

### 2.3 一条脆弱边

`sync-facts.mjs:71` import 了一个**门禁脚本** `check-runtime.mjs`。目前安全，因为
`check-runtime.mjs:235-239` 的入口判定带守卫，import 时不执行 `main()`。
但这是**隐式契约**：一旦 `check-runtime.mjs` 获得任何顶层副作用，`sync-facts` 会在
import 期执行一个门禁。`sync-facts.mjs:87-91` 的 JSDoc 明确记录了它只取
`parseNodeFloor` 且只取"宽松读法"。

**建议**：把 `parseVersion` / `parseNodeFloor` / `meetsFloor` 下沉到 `scripts/lib/`，
两边都从 lib 取，删掉这条边。

### 2.4 同一事实被两个门禁用不同方式判定

| 事实 | 事实源 | 消费者 A | 消费者 B | 谁在断言一致性 |
|---|---|---|---|---|
| **forge test scope** | `scripts/foundry-scope.json` | `verify.mjs:576` 硬编码 argv `".*Invariant\|.*Fork"` | `check-doc-counts.mjs:45` `EXCLUDED = /Invariant\|Fork/` | `sync-facts.mjs:521-529` 声明 7 个消费者——**但 sync-facts 不在 CI 里跑** |
| **node engine floor** | `package.json` `engines.node` | `check-runtime.mjs:36-41` 宽松解析 + `DEFAULT_FLOOR=24` | `bootstrap.mjs:34` **digit-slice**（三位数 major 静默截断） | `sync-facts.mjs:864-887` 专门报告它——**同样不在 CI** |
| **node major（benchmark）** | 同上 | `benchmark-indexer.mjs:58` `REQUIRED_NODE_MAJOR = 24` **硬编码常量** | — | 无 |
| **CI job count** | `.github/workflows/*.yml` | `check-doc-counts.mjs:848-864` `ciJobCount()` | `assurance-inventory.mjs:230-243` `inventoryCi()` | 只有 `check-doc-counts` 断言文档数字；`assurance-inventory` 只发布不断言 |
| **forge 二进制路径** | `FORGE_BIN` / `~/.foundry/bin` / PATH | `verify.mjs:381-391` `resolveForge()` **校验 existsSync** | `check-doc-counts.mjs:42` `process.env.FORGE_BIN ?? "forge"` **不校验** | 无 → 直接导致 X3 |
| **ABI 清单** | `scripts/abi-targets.txt` | `ci.yml:226-234` shell 循环 | `packages/core/test/abi-drift.test.ts` | 两侧读同一文件（`abi-targets.txt:4-6` 明确记录）——**全树唯一正确的双消费者模式** |

三条结论：

1. **`sync-facts.mjs` 不在 CI 里跑**。`grep -rn "sync-facts"` 在 `*.yml`/`*.yaml`/`package.json`
   中**零命中**（唯一提及是 `scripts/foundry-scope.json:2` 的注释）。它是全树唯一
   交叉验证 7 个 scope 消费者 + 5 个 engine floor 消费者的守卫，却只能手动运行。
   它的存在使 `verify.mjs:576` 与 `check-doc-counts.mjs:45` 的硬编码**当前一致**——
   但这个一致性没有任何自动化在守。

2. **`deriveJsExclude` 存在潜在语义断裂**（`sync-facts.mjs:253-262`）。它把
   `unitExclude` 每个分支的前导 `^` 和 `.*` 剥掉生成 JS 镜像。若将来某分支是 `^Suite$`，
   镜像变成 `Suite$`；作为**无锚点** `RegExp`（`:230-231` 明确说故意不加锚点）
   意思是"包含以 Suite 结尾的串"，而 forge 的 `^Suite$` 是"恰好是 Suite"。
   两者静默分歧，且 `--write` 会把这个错误镜像写回文件。

3. **`FORGE_BIN` 校验不一致**。`verify.mjs:386` 检查 `existsSync`，
   `check-doc-counts.mjs:42` 不检查。当 `FORGE_BIN` 指向不存在的路径时，
   `verify.mjs:556` 仍会把它传给 `check-doc-counts`，后者在 `:722` `process.exit(2)`——
   **exit 2 会被 `verify.mjs:489` 的 `passed = !timedOut && code === 0` 记为普通 FAIL**，
   报告说"doc counts 失败"，真相是"工具跑不起来"。

---

## 3. Exit code 契约

### 3.1 目标契约

```
0  检查跑完，通过
1  检查跑完，发现问题
2  检查无法按要求执行（参数错误 / 工具缺失 / 输入不可读）
```

### 3.2 现状（**推断自源码，未实测**）

> ⚠️ 本表是**读代码推断**的。sc-e2e 已产出**实测**版（11 门禁 × 成功/失败双路径真实 spawn），
> 见 §3.4。**实测版取代本表**——两表并存就是本文 §2.4 批评的"同一事实两个来源"。

| 脚本 | 0 | 1 | 2 | 备注 |
|---|---|---|---|---|
| `verify.mjs` | `:360`(`--list`), `:703` | `:703` | `:177` `abort()` | 三值齐全 |
| `sync-facts.mjs` | `:1525` | `:1366` verdict | `:1442` 参数, `:1450` **仓库读不了**, `:1465` 写白名单外 | **2 有 3 种含义** |
| `check-doc-counts.mjs` | `:931` | `:980` drift, `:973` 重验证 | `:722` **forge 缺失** | **2 = 工具缺失** |
| `check-runtime.mjs` | `:238` | `:101` verdict | — | 无 2 |
| `check-waivers.mjs` | 隐式 | `:477` | — | 无 2；警告走 stdout |
| `check-vectors.mjs` | `:708` | `:686`, `:717` | — | 无 2 |
| `check-package-artifacts.mjs` | `:324`, `:350` | `:315`, `:324`, `:342` | **`:291`（本日新增）** | |
| `check-dockerfile.mjs` | `:221` | `:97`, `:226` | — | 无 2 |
| `validate-workflows.mjs` | 隐式（`:124`） | `:44` 无目录, `:50` 无文件, `:121` findings | **`:39`（本日新增）** | **环境问题仍报 1** |
| `assurance-inventory.mjs` | `:362` | `:344`, `:352` | — | **参数错误报 1** |
| `bootstrap.mjs` | `:168` | `:171` | — | 无 2 |
| `clean.mjs` | 隐式 | `:363` | — | 无 2 |
| `benchmark-indexer.mjs` | 隐式 | `:752` | — | 无 2 |
| `generate-vectors.mjs` | 隐式 | 未捕获异常 → Node 默认 1 | — | 无显式 2 |

### 3.3 不一致清单

| # | 问题 | 证据 | 实际影响 |
|---|---|---|---|
| **X1** | **代码 2 有 3 种含义** | `verify.mjs:177`=参数错误；`sync-facts.mjs:1442,1450,1465`=参数+仓库读不了+写白名单外；`check-doc-counts.mjs:722`=**forge 缺失** | 任何按 2 分支的包装器都无法判断该重试、装工具还是改参数 |
| **X2** | **环境问题报成 finding** | `validate-workflows.mjs:44,50`（无目录/无文件）、`assurance-inventory.mjs:344`（参数错误）、`:352`（root 非目录）全 exit 1 | 无法区分"仓库坏了"和"检查发现问题" |
| **X3** | **编排器吞掉 2** | `verify.mjs:489` `passed = !timedOut && code === 0` | 报告说"doc counts FAIL"，真相是"forge 跑不起来"。**X1 的实际危害** |
| **X4** | **5 个脚本无显式 exit 0** | `check-waivers`/`validate-workflows`/`clean`/`benchmark-indexer`/`generate-vectors` 靠落到底退出 | 将来加一个设置 `process.exitCode` 的早退分支会静默变成非零 |
| **X5** | 子进程码透传只在一处 | `check-doc-counts.mjs:182-184` + `:973` | 其余脚本即使包装了子进程也无法转发其码 |

关于 `continue-on-error`：`ci.yml` 的 3 个 waiver（`:335`/`:400`/`:418`）
**都不跑 `scripts/` 下的任何门禁**，所以 exit code 分裂**当前不会**直接使它们失效。
真正受影响的是 `verify.mjs` 的聚合报告与任何未来按码分支的包装器。
讽刺之处：`check-waivers.mjs` 正是这些 waiver 的守卫，而它自己的退出码语义是分裂的（X2）。

### 3.4 实测复核（sc-e2e，2026-09-26）

3.1–3.3 是**静态推导**：读源码推断每个分支会返回什么码。本节是**实测**：把每个门禁作为
真实子进程跑成功与失败两条路径，看它实际上返回什么。两者的差集就是静态分析漏掉的东西。

证据脚本：`scripts/e2e-gates.test.mjs`（20 个测试）。它 spawn 真实门禁二进制，断言的是
**进程边界**——退出码、stdout/stderr 分离、幂等、门禁间不干扰——这些在单元测试里看不到，
因为它们只存在于进程边界。

**结论：11 个门禁逐一实测，P0 假阴性 0 个。没有一个门禁在失败时返回 0。**

| 门禁 | 干净树 | 破坏后 | 崩溃码? | findings→stderr | 计数可解析 |
|---|---|---|---|---|---|
| `validate-workflows` | 0 | 1 | 无 | ✅ | ✅ `N problem(s):` |
| `check-waivers` | 0 | 1 | 无 | ✅ findings→stderr，warnings→stdout | ✅ `N problem(s)` |
| `check-vectors` | 0 | 1 | 无（JSON 解析失败被捕获→1） | ✅ | ✅ `N problem(s)` |
| `check-dockerfile` | 0 | 1 | 无 | ✅ | ✅ `problems (N):` |
| `check-package-artifacts` | 0 | 1 | 无（顶层 throw 被捕获→1） | ✅ | ✅ `N problem(s)` |
| `check-runtime` | 0 | 1 | 无 | ✅ | ❌ `FAIL: <一句话>`，无计数 |
| `check-doc-counts` | 0 | 1 | **2 = forge 缺失**（有意，见 X1） | ✅ | ✅ `drift (N):` |
| `verify.mjs` | 0 | 1 | **2 = 参数/环境错误**（`abort()`，有意） | ✅ `--json` 时 stdout 独占 JSON | ✅ 有 `--json` |
| `assurance-inventory` | 0 | 0 | 无（只读报告，无失败模式） | — | — |
| `sync-facts` | 0 | 1 | — | — | — |
| `clean.mjs` | 0 | 1 | — | — | — |

#### 实测修正了静态表的一处

`validate-workflows.mjs` 在 3.2 里记为「无 2」且「环境问题报成 1」（X2）。实测确认
「无目录 → 1」仍然成立（这是**真 finding**：没有 workflow 就是仓库坏了），但参数路径已改：

```
$ node scripts/validate-workflows.mjs --root /tmp/nope
validate-workflows: takes no arguments, got --root /tmp/nope
it validates the workflows in the repository this script lives in (…\.github\workflows).
exit 2
```

`check-package-artifacts.mjs` 同步（它有合法的 `--json`，所以只拒绝未知参数）。两者都改为
**exit 2 + 明确说明**，理由见 3.5。

#### 一处刻意的例外：warnings 走 stdout 是对的

`check-waivers.mjs` 把 **warnings 打到 stdout，findings 打到 stderr**。这不是不一致，
是正确的：warning 不让运行失败，混进 stderr 会污染失败信号。测试里为此单独开了例外
并写明理由，以免后人"修正"它。

#### 两条无法用计数聚合的失败路径

`check-runtime` 的 `FAIL: <一句话>` 没有数字；`check-vectors` 的 JSON 解析失败路径直接
`exit 1` 不输出计数。后者是**正当做法**——读不出来时不该编造"0 problems"，但 CI 聚合器
刮 `N problem(s)` 时会把它读成"无问题"。测试里显式记录为**不对称**而非缺陷。

#### 非恒真证据

断言"退出码是 0 或 1，而不是崩溃码 2"这种测试最容易恒真——因为一个什么都不做的门禁也能
通过。所以每个断言都用**变异测试**验证过：在门禁**副本**上做 8 种手术式变异（失败时
`exit 0`、findings 打到 stdout、抛未捕获异常、计数不符、问题列表与计数不符……），
整套测试 **8/8 全部变红**，control（无变异）20/20 绿。

变异只在副本上做，不改仓库原文件——当时 9 个 agent 正并行编辑 `scripts/`。

> **交叉印证**：本节的 CI-only 清单（`check-waivers` `check-vectors` `sync-facts`
> `generate-vectors` 从不在 `verify` 里跑）与 4.2-A 的静态发现、sc-test 独立跑出的
> CI-parity 缺口三条路径指向同一结论。已在 `verify.mjs` 的 `CI_ONLY_GATES` 常量里
> 补齐这 4 项——该常量原先只列 `slither, gitleaks, halmos, fork, deep-fuzz`，
> 读起来像"CI 独有"的完整清单，实际漏了一半。

### 3.5 `--root` 静默吞掉：门在，但没连上它声称校验的那一端

1.1 记录了 14 处根路径解析全部是 `dirname(import.meta.url) + "/.."`。实测补上了这个设计的
**后果**：11 个门禁里只有 3 个真的接受根目录，其余的接受一个 `--root` 然后**完全无视它**，
并报告自己所在仓库的结果。

```
$ node scripts/check-vectors.mjs --root /tmp/nope-xyz
ok   actionrequest.json   generator=@sigilkit/core (self-certified)
...
exit 0
```

**这是本轮最危险的静默失败模式**，因为它同时骗过两方：

- **测试**：一个 fixture 测试可以通过，但它实际检查的是真实仓库——你以为在测坏树，其实在测好树。
- **调用方**：任何想把门禁指向另一个 checkout 的人，会拿到一个"干净"的判决，而那棵树
  从来没被打开过。

**修法选择**：不是实现 `--root`（改动面 8 个门禁 + 它们的测试，而当前**没有真实调用方
需要它**），而是**明确拒绝**——exit 2 + 一行说明。理由：静默吞掉 flag 比拒绝它危险得多，
因为调用方会以为检的是另一棵树。这与 1.5 记录的 `KNOWN_FLAGS` 拒绝机制同形，仓库已有
这个模式，8 个门禁没跟上。

**已修（2/8）**：`validate-workflows.mjs`（不接受任何参数）、`check-package-artifacts.mjs`
（有合法 `--json`，只拒绝未知参数）。

> 实施注记：拒绝逻辑**故意内联**而非调用 `lib/exit.mjs` 的 `reportUsage`——
> `validate-workflows.test.mjs:50-60` 把脚本**单独**复制进 fixture 仓库，import 相邻模块
> 会让每个 fixture 都 `ERR_MODULE_NOT_FOUND`。**fixture 复制模式与 lib 迁移直接冲突**，
> 这是修 fixture 而不是回避 import 的理由。

**未修（6/8）**：`check-waivers` `check-vectors` `check-dockerfile` `check-runtime`
`check-doc-counts` `generate-vectors` —— 测量时正被其他 agent 编辑，未触碰。

> `generate-vectors` 比其他几个更糟：它无视 `--root` 的同时**还往仓库里写文件**
> （`vectors/*.json`）。一个指向别处的 `--root` 会静默改写**本**仓库。

**测试如何固定这个契约**：`e2e-gates.test.mjs` 的 `ROOT_CONTRACT` 逐条断言每个门禁的
当前行为。`ignored` 行断言 exit 0（把缺陷钉住，防止被遗忘），`rejected` 行断言 exit 2 +
消息点名被拒的 flag + **stdout 不得同时出现判决**。`R4` 双向校验这张表与源码，防止
陈言。变异测试证明这些断言非恒真：把两个门禁改回静默吞掉，测试立刻变红。

---

## 4. `verify.mjs` 作为编排器的正确性

### 4.1 9 个步骤

`lint` → `packaging` → `helpers` → `docs` → `build` → `typecheck` → `artifacts` → `contracts` → `tests`

### 4.2 漏项

**A. `helpers` 步骤漏 4 个测试套件**（`verify.mjs:546-555` 只列 7 个）：

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

这与 `verify.mjs:19-20` 自己声明的意图（"辅助套件是门禁步骤，无法在门外腐烂"）直接冲突。

**B. 两个 CI 会跑的门禁完全不在 `verify` 里**：

| 门禁 | CI | verify |
|---|---|---|
| `check-waivers.mjs` | 有 `ci.yml:59` | **无步骤** |
| `check-vectors.mjs` | 有 `ci.yml:190` | **无步骤** |
| `check-runtime.mjs` | 只跑它的测试 `ci.yml:74` | 无 |
| `sync-facts.mjs` | 无 | 无 |
| `assurance-inventory.mjs` | 无 | 无 |

`check-waivers` 尤其重要：它是**唯一**让 `continue-on-error` 治理机器化的守卫
（`check-waivers.mjs:5-10`），却不在本地门禁里。

**C. 顺序正确** ✓：`build` 在 `typecheck`/`artifacts` 之前，与 `ci.yml:165,196` 一致。

**D. `CI_ONLY_GATES` 名单准确** ✓（对齐 `ci.yml:115/133/307/273/237`），
但没列 waivers/vectors，因为那两个不是 CI-only，而是**本地也该跑却没跑**。

---

## 5. 共享模块设计（本次实际产出）

新建 5 个模块 + 5 个测试文件，全部在 `scripts/lib/`。**未修改任何现有脚本**
（`git status` 中 `scripts/lib/` 是我的唯一新增项）。

| 模块 | 抽自 | 消除的重复 | 测试数 |
|---|---|---|---|
| `paths.mjs` | 14 处根路径 + 9 处入口判定 | 1.1 / 1.2 | 12 |
| `exit.mjs` | 8 处消息提取 + 1 处子进程码透传 | 1.8 / §3 | 13 |
| `reporter.mjs` | 2 份完整颜色实现 + 6 处 findings 协议 + `envFlag` ×2 | 1.3 / 1.4 | 22 |
| `fs-json.mjs` | 5 处文件读取 + 2 类小枚举 | 1.6 / 1.9 | 21 |
| `cli.mjs` | 9 处参数解析 + 8 处进程执行 | 1.5 / 1.7 | 24 |

**合计 98 个测试，`node --test "scripts/lib/*.test.mjs"` 全绿。**

### 5.1 设计原则

1. **不改变行为**。每个模块头部 JSDoc 写明"从哪些 `路径:行号` 抽取 /
   哪些差异刻意保留 / 将来谁该改用它"。`isWorkflowFile(".yml") === true` 这类
   与原实现一致但未必正确的行为，被测试**钉为 parity** 并注明"收紧它是另一个刻意行为"。
2. **差异用不同函数表达，不用开关**。三个 reader、两个 `Outcome`、两种 reporter 布局
   ——而不是 `failSilently: true`。
3. **注入优于全局**。所有 I/O 走参数注入（`io = undefined` 默认真实 fs），
   与 `check-package-artifacts.mjs:295` 和 `sync-facts.mjs:1396` 的现有风格一致。
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
bareWord(status, on?) / statusWord(status, on?)   // 前者无填充 / 后者定宽（表格列）
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

### 5.3 一处 API 陷阱（已文档化 + 已测试）

`isDirectInvocation(moduleUrl, entry = process.argv[1])`——**传 `undefined` 会选默认值**，
所以"无入口"必须传 `null` 或 `""`（因为 `pathToFileURL(resolve(""))` 解析到 cwd，
不加守卫会把未设置的选项当成匹配）。已写入 JSDoc `@param` 并由
`paths.test.mjs` 的 `"falls back to process.argv[1] when the entry is omitted"` 钉住。

---

## 6. 迁移计划

**总原则**：一次一个脚本，每个 PR 只碰一个门禁 + 它的测试，跑完 6.2 的四道验证再进下一个。

### 6.0 前置（**新增，因 §1.10**）

**先修 3 个 fixture 的单文件拷贝**，否则这 3 个门禁无法迁移到 `lib/`：

```js
// scripts/validate-workflows.test.mjs:50-60 等三处
// 现状：只拷那一个 .mjs
// 改为：额外拷 scripts/lib/ 整个目录（已验证可行——fixture 已建在 REPO_ROOT/outputs/，
//       跨卷问题已由目录联接方案解决，见该文件 :43-49 的注释）
```

**这一步单独一个 PR，零行为变化，只让 3 个测试套件多拷一个目录。** 做完之后
§6.2 的第 1-6 步全部解锁。

### 6.1 已完成的迁移（他人）

| 脚本 | 做了什么 | 来源 |
|---|---|---|
| `validate-workflows.mjs:36-40` | 拒绝任何参数 → exit 2 | sc-e2e D1 |
| `check-package-artifacts.mjs:287-292` | 拒绝 `--json` 以外的参数 → exit 2 | sc-e2e D1 |

两者都内联了 `reportUsage` 的两行并留注释说明原因（fixture 拷贝限制）——
§6.0 完成后应改回 import。

### 6.2 每步的验证清单（缺一不可）

```bash
node --test "scripts/lib/*.test.mjs"           # 1. 共享模块自身仍绿
node --test scripts/<name>.test.mjs            # 2. 该门禁的既有测试仍绿（不允许改断言）
node scripts/<name>.mjs; echo "exit=$LASTEXITCODE"   # 3. 退出码与迁移前逐字节一致
node scripts/verify.mjs --only=<step> --json   # 4. 编排器视角：该步骤 ok/passed 不变
```

**第 3 步是关键的**：迁移前后各跑一次，stdout / stderr / exit code 存下来 `diff`。
若不一致，先判断是行为变化还是 bug 修复——两者都需在 PR 里显式说明。
（PowerShell 下用 `$LASTEXITCODE`，`$?` 是布尔值——我自己在核实过程中就踩了这个坑。）

### 6.3 迁移顺序（按风险从低到高）

| # | 目标 | 动作 | 风险 | 备注 |
|---|---|---|---|---|
| **0** | **3 个 fixture** | 额外拷 `scripts/lib/`（§6.0） | 极低 | **前置**，零行为变化 |
| **1** | `check-dockerfile.mjs` | `REPO_ROOT` + `reporter` | 低 | 已有测试断言 `status` 与合并输出 |
| **2** | `check-vectors.mjs` | `REPO_ROOT` + `isDirectInvocation` + `readJsonOrNull` + `bareWord`（替 `:695` 的 `ok `/`WRONG`） | 低 | `:695` 三态标记改文字状态词 = **可见输出变化** |
| **3** | `check-waivers.mjs` | `REPO_ROOT` + `isDirectInvocation` + `reporter` + `workflowFiles` | 低 | 加进 `verify` 门禁须排在其 PR 之后（避免冲突） |
| **4** | `check-doc-counts.mjs` | `EXIT` + `messageOf`(4 处) + `REPO_ROOT` + `repoPath`(2 处) + `reporter` + `runSync`(`:716` REQUIRE) + `runJsonSync`(`:841`) | 中 | `:722` 的 exit 2 语义是"工具缺失"，与 `EXIT.USAGE` 不同——**保留原样加注释**，或与 X1 一起决策 |
| **5** | `check-package-artifacts.mjs` | `REPO_ROOT` + `isDirectInvocation` + `readJson`(注入) + `reporter`(**verb 布局**) | 中 | 换掉 `:287-292` 的内联 `reportUsage` |
| **6** | `validate-workflows.mjs` | `REPO_ROOT` + `reporter` + `workflowFiles` | 中 | 换掉 `:36-40` 的内联；**顺带修 X2**（`:44,:50` 的 exit 1 → 2） |
| **7** | `check-runtime.mjs` | `parseVersion`/`parseNodeFloor`/`meetsFloor` **下沉到 lib**，`sync-facts.mjs` 改从 lib 导入 | 中 | 消除 §2.3 脆弱边。⚠️ 会改 `sync-facts.mjs:71` 的 import——**与其他成员协商** |
| **8** | `verify.mjs` | 采纳 `reporter.STATUS`；补 4 个 helpers；补 `waivers`/`vectors` 两步骤 | 中 | 风险不在抽取而在**补漏**：会改 `--list` 输出与 `--json` 形状，`verify.test.mjs` 需同步。**必须等 1-7 落地后单独做** |
| **9** | `bootstrap.mjs` | `REPO_ROOT` + `parseArgs` + `reporter`（替 `ok/warn/bad/step`） | 中 | **顺带修颜色违规**（§1.3）：CI 日志不再有裸 ESC。可见行为变化 |
| **10** | `sync-facts` / `clean` / `benchmark-indexer` / `assurance-inventory` / `generate-vectors` | 各自 `REPO_ROOT` + `EXIT` + `messageOf` | 低 | 机械替换，可并行 |

### 6.4 明确不迁移

| 不迁移 | 原因 |
|---|---|
| `verify.mjs:411-530` 的 `run()` | 编排器（预算 + 日志 tee + 进程树终止），不是 helper；已携带全树最详尽的文档 |
| `check-doc-counts.mjs:635-645` 的 `checkDocument()` | 已单脚本收敛，但只有一个调用点，抽成公共 API 是负债 |
| `check-runtime.mjs:130-153` 与 `check-package-artifacts.mjs:231-270` 的 workspaces 展开器 | 行为**真的不同**（静默跳过 vs throw；`manifest.name` fallback 不同）。统一会悄悄选赢家 |
| `check-waivers.mjs:78-91` `makeLocator` / `sync-facts.mjs:364-435` `blankComments` | 都是各自领域专用的源码扫描器，虽形似（都保留行号/偏移）但正则与状态机不同，合并等于重写 |
| `bootstrap.mjs:76-84` `resolveFoundry` | 与 `verify.mjs:381-391` `resolveForge()` 逐行同构，**应当合并**，但需改 `bootstrap.mjs`（他人正在改）。见 §6.5 |

### 6.5 一个应当合并但需单独 PR 的点

`bootstrap.mjs:76-84` `resolveFoundry(name)` 与 `verify.mjs:381-391` `resolveForge()`：

```
FORGE_BIN/ANVIL_BIN env + existsSync  →  ~/.foundry/bin/{name[.exe]} + existsSync
→  spawnSync(name, ["--version"]) 探测
```

逻辑逐行同构。差异：`bootstrap` 泛化到 `anvil`（`:99`）、用 `shell:true` 跑 npm（`:66`）、
且 `verify` 有测试钩子 `VERIFY_FORCE_NO_FORGE`（`:385`）而 `bootstrap` 没有。
建议抽 `lib/forge.mjs: resolveFoundryBin(name, { env, home, platform, probe })`，
两边各传自己的 `probe`。**本次不实施**。

---

## 7. 给团队的具体请求

1. **§6.0 的 fixture 修复需要有人认领**——它阻塞 3 个门禁迁移到 `lib/`，
   是一行 `cp -r` 换掉三处内联。
2. **`sync-facts.mjs` 应该进 CI**（§2.4 结论 1）。它是全树唯一的跨文件事实守卫，
   目前只能手动运行。加一行 `ci.yml` 成本极低，收益是让 7 个 scope 消费者
   和 5 个 engine floor 消费者的自动一致性。
3. **`verify.mjs` 的 4 个 helpers + 2 个门禁漏项需要认领**（§4.2A/B）。
   这不是我的独占范围，但发现记录在此。
4. **X3 值得单独修**：`verify.mjs:489` 应把子进程的 exit 2 单独呈现
   （"could not run" 而非 "FAILED"），否则 `FORGE_BIN` 配错时报错误导。
5. **引用本文行号请优先用函数名**——并行修改会使行号漂移。

