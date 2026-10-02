---
audience: [user, contributor, security-auditor, researcher]
status: active
updated: 2026-09-26
---

# `docs/` — 文档入口

> **完整索引是 [`INDEX-2026-09-26.md`](INDEX-2026-09-26.md)。本文只是入口** —— 按「我想…」给最短路径，每条一行。找特定文档请去 INDEX。
> **权威层级不由本文决定** —— 见 [`STATUS.md`](STATUS.md)（L1 代码 > L2 记录 > L3 计划 > L4 语境；L5 参考层对 L1 让位）。
> **写法规范**见 [`STYLE-2026-09-26.md`](STYLE-2026-09-26.md)，**术语与命名**见 [`GLOSSARY-2026-09-26.md`](GLOSSARY-2026-09-26.md)。

## 我想…

| 我想… | 去看 |
|---|---|
| **跑起来**（第一次上手） | [`GETTING-STARTED.md`](GETTING-STARTED.md) · 实测踩坑记录见 [`ONBOARDING-2026-09-26.md`](ONBOARDING-2026-09-26.md) |
| **部署 / 运维** | [`DEPLOYMENT.md`](DEPLOYMENT.md) · 深度评估见 [`DEPLOY-OPS-2026-09-26.md`](DEPLOY-OPS-2026-09-26.md) |
| **配环境变量 / CLI flag** | [`CONFIGURATION.md`](CONFIGURATION.md) |
| **它坏了** | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) |
| **贡献代码** | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) · `scripts/` 契约见 [`SCRIPTS-2026-09-26.md`](SCRIPTS-2026-09-26.md) |
| **看懂某个概念 / 术语** | [`GLOSSARY-2026-09-26.md`](GLOSSARY-2026-09-26.md)（118 条术语） |
| **做安全审计 / 看威胁模型** | [`../SECURITY.md`](../SECURITY.md) · 7702 威胁地图见 [`SECURITY-7702-THREAT-MAP.md`](SECURITY-7702-THREAT-MAP.md) |
| **知道项目被审计过没有** | **没有外部审计。** 横幅见 [`WHITEPAPER-v2.1.md`](WHITEPAPER-v2.1.md)，规则见 `STATUS.md` 的「audited」陷阱 |
| **看验证与形式化证明** | [`VERIFICATION-STRATEGY-2026-09-25.md`](VERIFICATION-STRATEGY-2026-09-25.md) · CI/UAT 部分见 [`VERIFICATION-STRATEGY-2-CI-UAT.md`](VERIFICATION-STRATEGY-2-CI-UAT.md) · 豁免登记册见 [`CI-WAIVERS.md`](CI-WAIVERS.md) |
| **知道现在该做什么** | [`PLAN-30-DAYS-2026-09-23-to-2026-10-22.md`](PLAN-30-DAYS-2026-09-23-to-2026-10-22.md) · 最新问题目录见 [`ISSUES-CATALOG-2026-09-25.md`](ISSUES-CATALOG-2026-09-25.md) |
| **核对一个数字** | `node scripts/check-doc-counts.mjs` —— **工具链赢过所有散文**（含本文与 `STATUS.md`） |
| **了解设计动机 / 竞品 / 研究** | [`WHITEPAPER-v2.1.md`](WHITEPAPER-v2.1.md) · 生态调研见 [`ECOSYSTEM-RESEARCH-2026-09-23.md`](ECOSYSTEM-RESEARCH-2026-09-23.md) · 私密研究笔记见 [`../vault/00 MOC.md`](../vault/00%20MOC.md) |
| **知道哪份文档说了算** | [`STATUS.md`](STATUS.md) |
| **找任意一份文档** | [`INDEX-2026-09-26.md`](INDEX-2026-09-26.md)（12 组按意图分类，67 份全覆盖） |

> **Unverified as of 2026-10-01 (documentation-truthfulness pass)：** 上表最后一行
> 「12 组按意图分类，**67 份全覆盖**」中，
> - **「12 组」是已证的** —— `INDEX-2026-09-26.md` 确有 `## 组 1` 至 `## 组 12` 共 12 个小节；
> - **「67 份全覆盖」未复测**，且与 `INDEX-2026-09-26.md` 自身表头声明的
>   `docs/` 45 + `vault/` 22 = 67 **同样未复测**（该文件已就此加注）。**两处一致，但一致不等于为真。**
>   引用「全覆盖」前请重跑 `node scripts/check-doc-counts.mjs` 或直接列举 `docs/` 与 `vault/`。

## 三条读前须知

1. **代码是规范。** 任何 `docs/` 里的行为描述都是便利说明，与 `contracts/src/`、`packages/*/src/` 冲突时**代码赢**，文档是 bug。
2. **数字以工具链为准。** 测试数 / CI job / 覆盖率 / Halmos 规格数由 `npm run check:docs` 机器校验，散文里的数字不是事实源。
3. **本项目尚无外部审计。** 「audited」在本仓库里目前是一句**不准确的话** —— 写安全结论时必须同时说明「未经外部审计」并列出验证工具。
