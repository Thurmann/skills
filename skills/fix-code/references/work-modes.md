# Select the work mode

## Bug

Capture expected/actual behavior and a runnable reproduction. Explore relevant code cheaply; have the architect confirm the causal mechanism and smallest sound fix. Add a failing regression first when there is a practical test path. Check failure before the fix and success afterward on the same surface; preserve commands and meaningful evidence. UI bugs need the actual flow or a truthful statement that UI proof was unavailable. Do not replace missing runtime evidence with confident prose.

## Feature

Turn the request into observable acceptance criteria. Architect the data model, interfaces, state changes, and integration with existing patterns. Prefer the repository's established stack. Have cheap workers implement small vertical units with behavioral checks, preserving unrelated behavior. Use the actual UI/CLI/API for the changed flow and review the integration boundaries. Do not add unrelated infrastructure or create a new repo when the user asked for a feature in an existing one.

## New repository / whole project

Inspect the requested destination before creation. Settle the goal, core user flow, smallest coherent architecture, dependency choices, and verification path. Resolve genuine product questions early while continuing scaffold-independent work. Use the Git reference's non-main baseline for empty repositories.

Build a working end-to-end slice first, then expand through verified milestones. The final branch must contain runnable setup, dependencies/lockfiles appropriate to the stack, configuration examples without secrets, and enough launch/test documentation to reproduce the result. Use a persistent decision/task record for long work rather than relying on a huge coordinator transcript. Keep that record in the worktree and commit it only when useful to the deliverable.

Whole-project work is not permission to buy services, deploy, expose secrets, or change production data. Prefer local/test services until the task authorizes more. Validate installation, app launch, primary flows, and relevant failure paths. The deliverable is the requested project plus a PR, not just a scaffold or plan. Large projects can use sequential PRs on fresh branches when milestones are independently reviewable and the user wants incremental delivery; preserve base/dependency relationships explicitly and never merge them automatically.

## Review and finish

Match verification to risk, not line count. A one-line permission change deserves care; an obvious text edit may need only a targeted check. Fresh reviewers inspect the diff/artifacts, not only author summaries. Fix real findings on the same task branch with new commits and rerun affected checks. If a check cannot run, show that limitation and choose draft delivery rather than inventing success.
