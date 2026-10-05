# `verify:` 字段设计规范（草案）

**日期**：2026-09-26 · **作者**：ck-test · **状态**：⚠️ **CRITERION PROPOSED, NOT YET MECHANICALLY VERIFIED**
**配套**：`docs/PROPERTY-TEST-PITFALLS-2026-09-26.md`（失效模式与自检方法）

> ## ⚠️ 本文档的效力声明
>
> **本文提出的 `verify-l2:` 判据尚未经过机械验证，可能重蹈 X-34 的覆辙。**
> §4 写明它"为什么不能自动化"以及它**已知不成立的场景**。
> **在有人构造出它的反例之前，请勿把它当作门禁实现依据。**
> 保留这份草案而非删掉，理由见 §8。

---

## 1. 要解决的问题

`ISSUES-CATALOG-2026-09-25.md` **没有 `status` 字段**（各条目只有
`位置` / `机制` / `修复` / `工时` / `依赖` / `时间线`）。
因此**没有任何机制阻止一个"处方已落地但未解决"的条目被读作"已解决"**。

已确认的两个实例：

| 条目 | 状态 |
|---|---|
| **SEC-08b**（Halmos check 可被平凡满足） | 曾被记为已修复；实为"修了 A、恒真变成 B"，经历**四步演进**才真正关闭 |
| **SEC-10**（轮换重置新 key 的窗口计数） | catalog `:163` 的三条建议**全部未落地**；缺陷代码仍在，仅补了特征测试 |

**目标**：让"处方是否落地"成为**可被机械核对的事实**，而不是读者的推断。

---

## 2. 已知会失败的朴素设计（不要重做这三遍）

本轮实测过三种"显然"的设计，**两种已被证伪**：

### 2.1 存在性检查（"该条目有测试引用它"）—— ❌ 已证伪

即 X-34。实测：INV-1（`SpendPolicy.sol:6`）被测试引用的文件数

| pattern | 命中 |
|---|---|
| `PerWindowCapExceeded\|getWindowState` | 8 个文件 |
| `perWindowCap\|getWindowState\|WindowCharged` | 18 个文件 |

**两者皆绿，而 SpendPolicy P0 期间它们确实全绿。**

决定性反例 `GasUncoveredPaths.t.sol:1017-1048`（`test_GasUncovered_Views`）：

```solidity
uint256 before = gasleft();
skm.getScope(agent);
emit log_named_uint("GAP view: getScope", before - gasleft());
before = gasleft();
skm.getWindowState(agent);        // ← :1026
emit log_named_uint("GAP view: getWindowState", before - gasleft());
```

**该函数体 `assert*` 出现 0 次。** "有引用"这个最弱的信号抓不到任何东西。

**附带结论**：引用计数**取决于 pattern 宽窄，而 pattern 是人选的**——
所以"引用计数"**不是一个稳定的门禁原语**。

### 2.2 函数级"有 `assert*`"检查 —— ⚠️ 是必要条件，**不是充分条件**

这是 team-lead 提出的 `verify-l2:` 机械约束：
> 引用的测试函数名必须真实存在，且该函数体内必须出现一个 `assert*` 调用。

**它确实挡住了 §2.1 的反例**（`test_GasUncovered_Views` 的 `assert* = 0`）。

**但它有一个已实测的残留漏洞**：同一文件里有 4 处真实 `assert*`：

```
:762   assertEq(vd, uint256(EXPIRES_AT) << 160, ...)   ← 7579 validationData
:795   assertEq(vd, uint256(EXPIRES_AT) << 160, ...)
:815   assertEq(vd, uint256(EXPIRES_AT) << 160, ...)
:917   assertEq(target.count(), 1, ...)                ← executor 内调落地
```

**无一断言 `perWindowCap` 或窗口支出。** 于是：

```
verify-l2: "GasUncoveredPaths.t.sol:test_GasUncovered_ValidateUserOpSingle"
  → 函数名存在 ✅
  → 函数体内有 assert* ✅
  → 门禁放行 ✅
  而 INV-1 在这个文件里仍无任何策略断言
```

**⇒ 门禁被"函数级"满足，缺口是"不变量级"。**

> **定位（team-lead 纠正，采纳）**：
> §2.2 是一个**必要条件的机械检查**——它减少误报，**不消除误报**。
> **它不能被称为"机械下限"**，因为那会暗示"过了它就说明覆盖了"。
> 真正的充分条件（L2 语义 + L3 变异验证）**不可自动化，必须由人回答**。

### 2.3 强制 `must-mention`（断言必须出现 `perWindowCap` 字面量）—— ❌ 判定为不可行

**理由**：Solidity 里"这个断言在测哪个不变量"**不是语法属性**，只能靠约定或注释。
且许多真断言使用局部变量名而非字面量，强制匹配会产生**大量误报**。

**判据（团队标准）**：
> **一个无法机械化的强度要求，应该落到人工自检，
> 而不是落到一个假装能自动化的门禁上。**

---

## 3. 采纳的形态：存在性 + 显式强度等级 + **可复现三元组**

⚠️ **三元组是 ck-doc 实测后追加的（见 §3.2），它改变了字段的语义定义。**

```yaml
### SEC-08b · Halmos check 可被平凡满足
verify-l2: HalmosAuth.t.sol:test_execute_WindowSpendNeverExceedsCap
verify-covers: SpendPolicy.INV-1        # 该断言声称覆盖的不变量标识
verify:
  command: forge test --match-contract HalmosAuthTest   # 缺依赖时应 fail loudly
  at_commit: <40-hex sha>                # 在哪个提交上跑过
  deps_resolved: true                    # 依赖是否可解析（见 §3.2）
verify-residual-risk:                    # 必须显式写出，不得省略
  - 该断言可能恒真（需 L3 人工确认）
  - 该断言可能与所指不变量语义无关（见 §4）
```

**`verify-l2:` 当前落地处数：0** ⇒ **无回退成本，是修正的最佳时机。**

### 3.1 主要风险不是"恒真"，而是"无关"

**两层风险，按发生难度排序**：

| 层 | 风险 | 发生难度 |
|---|---|---|
| **L1** | 被指向的断言**与该不变量无关**（如 §2.2 的 4 处） | **低**——只需复制一个"看起来相关"的测试名 |
| L2 | 被指向的断言**恒真**（如 F4） | 中——需刻意构造 |

**⇒ L1 才是 `verify-l2:` 的主要风险。** 任何只描述 L2 的风险陈述都是**指错了重点**。

### 3.2 字段值必须是三元组，而非"跑过"（ck-doc 实测后追加）

**触发这次修改的实测**：`check-doc-counts` **从未对 `ce8eea2` 跑绿过**。

```
git show HEAD:docs/TROUBLESHOOTING.md  →  "There are 31 such annotations"
逐文件统计 HEAD 的 contracts/*.sol    →  28   （26 个 .sol 文件）
```

**⇒ 提交态的文档（31）与提交态的合约树（28）已经不一致并发布。**
**这正是 `check-doc-counts` 被写出来要防的失败模式本身，却在它自己的版本上失败了。**

**三次翻车是同一形状**：

| # | 事件 | 表面 | 实际 |
|---|---|---|---|
| 1 | `FORGE_BIN` 未设 | `exit 2` + `spawnSync forge ENOENT` | **环境没配**，不是门禁红 |
| 2 | `node_modules` 10→5→6 条目 | 同一会话内绿→不可运行→可运行 | 环境漂移 |
| 3 | 文档计数 31→28→57→56 | 数字与门禁不一致 | 门禁读**工作区**，数字跟着工作区漂 |

**⇒ 只记"跑过 / 红了"无法区分这三种，而三者的处置完全相反。**

**判据（写入字段语义）**：
> **`deps_resolved: false` 的绿色结果不得作为验收证据。**
> 环境失败与文档失败是两个不同的断言，混为一谈会让"门禁红"被修成"环境问题"。

**⇒ `verify:` 只记"跑过"会完整复制 `check-doc-counts` 的缺陷。这是本节的直接结论。**

### 3.3 `status` 必须区分"曾经为真"与"当前为真"（ck-doc 建议，采纳）

**触发实测**：本轮 `forge-lint` 计数出现过 **57**，它当时**通过门禁内容校验、
不是临时文件、是真实中间态**。**它不是错的，是过去了。**

**⇒ 不要用 `verified` / `unverified` 这种无时间维的二值**，
否则"我曾经验证过"与"现在仍然成立"会被同一个字段承载：

```
status: resolved-by:ck-arch@D-13     # 谁、哪一步、什么动作
verify: superseded                    # 曾为真但已不是当前值
                                      # —— 须显式区分于 unverified（从未验证）
```

**这条对本文自身同样适用**：若日后有人复核本文，
**"本文的 56 是某时点的实测值"这一事实本身也需要 `at_commit`**——
否则本文会重蹈它所批评的 `annotations: 49`。

---

## 4. 为什么 L2 语义不可自动化（`verify-covers` 无法机械校验）

§2.2 的机械检查能证明"**这个函数里有断言**"，不能证明"**这个断言关于该不变量**"。
**它使用的代理信号（函数内有 `assert*`）与目标（该不变量被断言）之间的关联，
本身就是"只能靠约定或注释"的东西。**

> **一个门禁如果它自己也无法验证"这个断言与目标有关"，
> 那它验证的只是"有人在某个函数里写了 assert"——
> 这与 X-34 问错粒度是同一类错误的第三次重复。**
> **宁可承认需要人，也不要用一个可 grep 的弱判据制造"已覆盖"的错觉。**

---

## 5. 移交人工的部分：§3.1 必答项

**L2 语义 + L3 变异验证无法自动化**，因此落成 `PROPERTY-TEST-PITFALLS` §3.1 的**必答项**。
每条 `verify-l2:` 在评审时必须回答三个问题：

1. **写出这个断言量与该不变量的语义关系（一句话）。**
2. **写出"若该不变量被破坏，这个断言会如何失败"。**
   若答案是"**不会失败**"，则该断言对该不变变量的覆盖是 **0**，
   **无论它看起来多相关**。
3. **指出该断言是 L2（断言策略语义）还是仅 L1（引用状态）。**

### 5.1 样例：一个**不合格**的答案（真实反例）

用 §2.2 的反例当样例，因为读者需要看到"不合格答案长什么样"：

> **声明**：`verify-l2: GasUncoveredPaths.t.sol:test_GasUncovered_ValidateUserOpSingle`
> **声称覆盖**：`SpendPolicy.INV-1`（窗口内支出不超过 `perWindowCap`）
>
> **必答 1**：该函数断言 `validationData == EXPIRES_AT << 160`，
> 即"7579 验证成功并把授权绑定到 scope 过期时间"。**这与 `perWindowCap` 无关。**
>
> **必答 2**：若 `perWindowCap` 被破坏（例如 SpendPolicy P0 那样使窗口检查失效），
> **该断言不会失败**——因为它根本不看窗口支出。⇒ **覆盖为 0。**
>
> **必答 3**：**仅 L1**（引用 `EXPIRES_AT` 与 `validationData`），非 L2。
>
> **⇒ 判定：不合格。** 该 `verify-l2:` 应被拒绝。

**这个样例的作用**：让读者判断"合格答案"长什么样。
**一个只有合格示例的清单，无法让读者识别伪装成合格的不合格答案。**

---

## 6. 与 `check-waivers.mjs` 的强制协调

> **一个防漏的门禁，如果会促使人删掉唯一的缺陷证据，那它是负资产。**

`test_Sec10_LineageWindowCap` 是**故意红**的（SEC-10 的缺陷证据），
且 `docs/CI-WAIVERS.md` 有独立豁免行（Option A/B 移除判据 + Expiry 2026-10-31）。
> **2026-10-01 更正（引用失效）：** 本行原写作 `docs/CI-WAIVERS.md:63`。按 2026-10-01 的
> `docs/CI-WAIVERS.md` 实际内容，第 63 行是「immediately below as a record」这句说明文字，
> **不是** SEC-10 豁免行；该豁免行已于 **2026-09-28 关闭**，现只以
> 「### Closed entry — `test_Sec10_LineageWindowCap`」小节留存。引用请按小节标题，不要按行号。

⇒ **`verify:` 校验器必须把"故意红 + 已登记豁免"当作合法状态**，
且必须与 `check-waivers.mjs` **协调而非各自独立判断**。
**本条须出现在门禁设计文档里，不是"记得考虑"。**

> **⚠️ 2026-10-01 文档真实性审计：本段已被更晚的文档推翻，保留原文不予删除。**
> 本文件写于 2026-09-26。`docs/CI-WAIVERS.md`（L2 记录）中**自述的关闭日期为 2026-09-28**，
> 晚于本文件两天，其记载**取代**本段的事实前提：
> - CI-WAIVERS.md「Non-CI-job waivers」表现在声明为**空表** —— 「there are no deliberate
>   standing test failures」；
> - SEC-10 豁免行于 2026-09-28 **关闭**，理由记录在「### Closed entry」小节：
>   `test_Sec10_LineageWindowCap` 现为 **PASS**，该文件记载 `forge test --match-path
>   "contracts/test/Sec10WindowRotation.t.sol"` 于 2026-09-28 结果为
>   「6 passed; 0 failed; 0 skipped」；
> - 同文件并注明：「The prior "intentionally failing" claim was never re-executed before it
>   was written down」—— 即「故意红」的说法本身从未复跑验证。
> 因此「故意红 + 已登记豁免」在当前仓库**不是**一个存在的状态，据此推出的门禁要求
> （第 242-244 行）失去事实基础。**上文原文按审计规则保留在原处**，不删除、不改写；
> 引用前请以 `docs/CI-WAIVERS.md` 的 2026-09-28 条目为准。
> **Unverified as of 2026-10-01：** 本次审计**无法运行 `forge test`**，上面引用的 "6 passed"
> 是转引自 CI-WAIVERS.md 的记录，不是本次实测；重新断言该测试状态前请先复跑。

---

## 7. 判据被钉死：门禁层的同一类错误

本轮已确认四个层次出现同一模式，**第五个在门禁层**：

| 层 | 案例 | 未经测试的断言 |
|---|---|---|
| 属性 | F1 / F2 / F3 | "加 `vm.assume` 就消除了平凡满足" |
| 证据 | 变异测试 | "它是唯一能抓恒真的手段" |
| 修法 | 抬高 cap / 加 assume | "合法即可行"（合法 ≠ 有效） |
| 元判据 | X-34 | "有测试引用 ⇒ 它被负责" |
| **门禁** | **`check-doc-counts.test.mjs`** | **"硬编码 `annotations: 49` 就是真值"** |

### 7.1 门禁层的实例（sc-gate 交付，ck-test 独立复核）
**原测试**（`scripts/check-doc-counts.test.mjs`）硬编码 `{ annotations: 49 }`。
**仓库实际为 56**（ck-test 于 18:40:27 实测：`forge-lint:` 出现 **56** 次）。

> **2026-10-01 交叉标注（未验证）：** 上方紧邻的「仓库实际为 56」与
> `docs/SUPPLYCHAIN-2026-09-26.md`「文档门禁」小节声称的 **49** 互相矛盾。两份文件都自标
> 2026-09-26（mtime：本文件 17:37Z，SUPPLYCHAIN 11:11Z），**均早于本次审计**，因此无法
> 据日期判定谁取代谁。本次审计**未复跑** `forge-lint:` 计数，**两个数字都不作为已证事实**；
> SUPPLYCHAIN 侧已加同样的未验证标注。引用任一数字前请重跑计数。

**它自己的注释写着**"应该测量而不是钉死"，**代码却钉死了**。
⇒ 同事**合法地**加 lint 豁免时它变红，**而不是在真有缺陷时变红**。
**一个只能因无关原因失败的测试，比没有测试更坏**——因为它训练团队忽略红灯。

**已由 sc-gate 改为实测**（`countRealAnnotations()`，`:775-781`）。
**注意该修复的注释本身就记录了这次教训**（"previously passed 49 while the
repository held 54 and then 56"）——**这正是 §8 要求保留修正过程的理由。**

> **与 F1/F2/F3 并列**：恒真属性"总是绿"、X-34"引用计数"、
> 本条"硬编码 49"——**三者都是"断言了某个具体值，而那个值会随时间漂移"**。
> **门禁层的修法与属性层相同：测出来，不要钉死。**

### 7.2 更严重的一层：门禁在自己的版本上就失败（ck-doc 实测，ck-test 复核）

**§7.1 是"测试写错了"，§7.2 是"门禁从未生效过"。**

```
git show HEAD:docs/TROUBLESHOOTING.md  →  "There are 31 such annotations"
逐文件统计 HEAD 的 contracts/*.sol    →  28
```

**（ck-test 于 2026-09-26 23:0x 独立复核：HEAD 的 `contracts/` 下 26 个 `.sol`，
逐文件累计 `forge-lint:` 出现 28 次；文档声称 31。差 3。）**

**⇒ 已提交的文档与已提交的合约树不一致，且这个不一致已发布。**
**`check-doc-counts` 正是为防这个而写的，而它在被提交的那个版本上就是错的。**

**⇒ 门禁的失效可以追溯到"它第一次被引入"那一刻，而不是某个回归点。**
**这比"某个测试被写错"严重一个量级**：它意味着
**"该门禁通过"这句话在此前所有提交上都不可作为证据。**

**⇒ 直接影响本文 §3.2**：`verify:` 字段若只记"跑过"，
**就会把这个"从未生效"的属性继承下去**。

---

## 8. 本文自身的处置

**本文标为 `CRITERION PROPOSED, NOT YET MECHANICALLY VERIFIED`，而非删除。**

理由：X-34 被提出、被采纳（连同"会在 P0 引入时抓到它"这个承诺）、
然后被实测证伪。**那段过程本身就是"判据必须先被测试"的唯一存在证明**——
删掉它，就等于删掉这条教训。

**因此本文也适用同一条要求**：
**若有人构造出 `verify-l2:` 的反例，请标注 `CRITERION FALSIFIED` 并保留修正过程，
不要直接删除，也不要直接换成正确判据。**
