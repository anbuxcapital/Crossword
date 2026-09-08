# Working agreements

## Tests

Do NOT write tests, and do NOT recommend writing tests, unless Peter explicitly asks.
This also applies to reviews: do not report missing test coverage or propose new test
cases. Running existing suites is encouraged. Updating existing test doubles so the
project compiles is allowed.

## Claude helpers

Always launch and coordinate Claude helpers through Herdr. Use the Herdr skill and
verify the caller is in a Herdr-managed pane before controlling the session. Do not
launch Claude as a standalone background CLI process.

For the Cloudflare materials research, Peter requested Opus; use low effort for that
bounded research task. Verify suggested materials against current primary sources
and the project's actual runtime/API versions before adopting them.

## Learning while implementing

Use `docs/CLOUDFLARE-LEARNING-PLAN.md` alongside the relevant implementation plan,
architecture, glossary, and current code. AI may write the implementation. Help Peter
learn through focused decisions, request tracing, and explanations of observed behavior.

## Design repository

`design/` is a separate Git submodule backed by `anbuxcapital/CrosswordDesign`.
`design/user-app/` holds the player prototype, handoff, references, and design QA.
`design/admin-console/` holds admin research and design concepts; these are not yet
a connected administration service.

Commit and push design changes inside the submodule first, then commit and push
the updated submodule reference in the main repository. Keep relative prototype
and asset links valid when moving files.
