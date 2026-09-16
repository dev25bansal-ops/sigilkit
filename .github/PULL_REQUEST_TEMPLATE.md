<!--
  Keep this short. A reviewer should be able to tell what changed and why in under a minute.
  Delete any section that does not apply.
-->

## What and why

<!-- What changed, and what problem it solves. If it fixes an issue, link it: "Fixes #123". -->

## How

<!-- The approach, and any trade-off you accepted. Mention what you rejected and why. -->

## Verification

<!-- Paste the commands you ran and their result. "npm run verify" passing is the baseline. -->

- [ ] `npm run verify` passes
- [ ] Added or updated a test that fails without this change
- [ ] `CHANGELOG.md` updated under `## [Unreleased]` (user-visible changes only)

## Checklist

- [ ] No `as any` / `as never` added to silence a type error
- [ ] New environment variables documented in `.env.example` **and** `docs/CONFIGURATION.md`
- [ ] New contracts added to `scripts/abi-targets.txt` (the ABI gate reads that file)
- [ ] Any `deny = "warnings"` lint finding is annotated in place with a reason
- [ ] Docs updated if behaviour or interfaces changed

## Risk

<!--
  Anything a reviewer should look at hardest: contract logic, error-handling paths,
  migration of existing data, changes to the trust model.
  Write "none" if genuinely nothing.
-->
