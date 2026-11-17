# Precheck and execution modes

Every task runs in exactly one mode: **Simple**, **Medium**, or **Advanced**. The mode decides how many agents run, which models they use, and whether architect and reviewer passes are mandatory. Git, isolation, the full test suite gate, verification honesty, and PR delivery rules are identical in every mode.

## Precheck

Run the precheck before framing or design work. Classify inline (same rules and output, a few sentences, no separate agent) when: the human named a mode; the request is plainly trivial (a single obvious edit such as text, a color, a constant, a config line, or an ignore rule); or the caller already runs on the cheapest efficient model. Otherwise delegate to the cheapest efficient model at low effort.

1. If the human prompt names a mode (`mode=simple|medium|advanced` or equivalent plain language), use it, classify inline, and skip further classification. Still record a scope prediction.
2. Otherwise, if not inline, delegate one short classification to the cheapest efficient model at low effort. Give it only the request text, the repository name, a top-level file listing, and the repository's primary language/stack. Do not give it the full transcript or ask it to read source files in depth.
3. Ask for this compact answer:

```text
mode: simple | medium | advanced
reason: <one sentence>
predicted_files: <number of source/logic files; exclude tests, docs, config examples, lockfiles, generated files, and mirrored or vendored copies>
predicted_areas: <modules/components expected to change>
risk_flags: <none | security | auth | data/migration | concurrency>
notes: <optional: public API, build/deploy, or other context>
confidence: high | medium | low
```

4. Classify with these signals:
   - **Simple:** one obvious location, 1-2 logic files, no new interfaces or dependencies, no risk flags. Examples: change a web element's color, fix a simple logic error, add a small self-contained feature or option.
   - **Medium:** the default for everything that is neither Simple nor Advanced, e.g. about 3-15 logic files, a feature within the existing architecture even across several modules, multi-file refactoring, difficult logic, or one risk flag.
   - **Advanced:** ONLY a new repository or project, a whole-repository refactor, a new architecture or data model, or two or more distinct risk flags (security, auth, data/migration, concurrency). Size or "cross-cutting" alone is not Advanced.
5. Give an honest best guess and confidence; do not pick a higher mode to be safe. The caller applies exactly one uncertainty adjustment: low confidence together with a risk flag moves up one mode. Any risk flag still rules out Simple. Medium already adds an independent review when the change outgrows the prediction, so it is the safety net for uncertain cases.
6. Report the mode, reason, and prediction in one line before further work. The precheck's prediction is the baseline for later escalation checks.

The precheck is a routing decision, not a design. Do not spend strong-model tokens on it. If model selection is unavailable, the caller classifies with the same rules in a few sentences and says so. Record the precheck result next to the actual changed logic-file count in the report so mis-predictions can be calibrated over time.

## Simple

Optimized for speed and the lowest token usage.

- Workspace: new branch in the existing checkout (in place), via `start --in-place`. No worktree.
- One agent does the whole task in one pass: frame, isolate, edit, verify, commit, push, and open the PR. Use the cheapest efficient model that can use the required coding and Git tools. If the caller already is that model, it may do the work itself; otherwise delegate the whole task to one implementer with a self-contained brief.
- No architect and no reviewer. No multi-agent fan-out and no persistent plan record.
- Keep context small: read only the files needed, and skip broad exploration.
- Verify with the narrowest check that proves the behavior, such as the targeted test, a build, or one CLI/UI check of the changed element, and also run the complete test suite before and after the change (see the full test suite gate in SKILL.md). Keeping context small never means skipping the full suite.
- **Escalate** to Medium (or Advanced if it qualifies) and report why if any of these appear: the change needs more than about 3 logic files, a new interface or dependency, a risk flag, a failing fix that is not obvious after one repair, or an unclear root cause. Keep the existing branch and commits; continue under the new mode's rules. If the task is still in place, relocate it to a worktree first when escalating to Advanced, and also when escalating to Medium: an escalation trigger counts as "bigger than predicted" (see Mode changes).

## Medium

Optimized for balancing cost and correctness.

- Workspace: start in place. The coordinator watches for the reviewer rule's "bigger than predicted" triggers while working, not only at final review, and as soon as one fires it commits and `relocates` to a worktree, then continues (and runs the reviewer).
- The coordinator writes a short plan itself: acceptance criteria, units of work, and checks. The architect is not required. Consult it only for a bounded diagnosis after two failed repairs with the same unresolved cause, or when the work escalates to Advanced.
- Delegate each bounded subtask to cheap implementer subagents with exact files, worktree, branch, finish condition, and a runnable acceptance check. Keep one writer per branch at a time; parallelize only read-only exploration.
- Verify each unit before starting the next, then run the changed flow end to end and the complete test suite.
- **Reviewer rule:** before committing the final change, compare the actual diff with the precheck prediction. Run a fresh reviewer on the diff and evidence if any of these are true:
  - the changed logic-file count (same definition as the prediction) exceeds the prediction by more than half, or by 3 or more files;
  - the diff touches modules/components that were not in `predicted_areas`;
  - a risk flag appeared that the precheck did not list;
  - the coordinator needed the architect for diagnosis.
  Otherwise, skip the reviewer and state that the change stayed within the prediction.
- Escalate to Advanced if the work grows into cross-cutting architecture, a new data model, or whole-repository refactoring.

## Advanced

Optimized for correctness. These rules are non-negotiable while the task is in Advanced mode; only an explicit human instruction may relax one, and the report must say so.

- Workspace: always a separate worktree from the start.

1. **Architect plans first.** Before any implementation edit, the architect role produces the plan: architecture or design decisions, interfaces, risks, staged units with acceptance checks, and the verification path. Keep this plan in a persistent task record in the worktree.
2. **Cheap subagents implement.** Bounded units go to cheap, efficient implementer subagents, one writer per branch at a time. The coordinator and architect do not write bulk implementation. Each unit is verified before the next starts.
3. **Independent review is mandatory.** A fresh reviewer subagent with an architect-class model inspects the full diff against the base, the plan, and the verification evidence, including the baseline and final full-suite results. It must not be the same agent instance that wrote the plan or the code. Fix actionable findings on the task branch with new commits, rerun affected checks, and have the reviewer confirm the fixes. Do not open a non-draft PR before the review passes. If the review cannot run, open a draft PR and state the blocker.
4. Use [change-type guidance](change-types.md) for new-repository and large-feature specifics, including end-to-end slices and milestone delivery.

## Mode changes

- Escalation to a higher mode is always allowed. Announce it with the trigger and continue on the same branch; work already done counts but must satisfy the new mode's review rules. Escalation to Advanced while the task is still in place: commit, `relocate` to a worktree, then continue. Simple-to-Medium escalation also relocates, since an escalation trigger counts as "bigger than predicted" under the Medium workspace rule; after that, Medium relocates on any further trigger only if still in place.
- Never downgrade automatically. Only an explicit human instruction can lower the mode.
- The final report states the precheck result, any escalation and its trigger, and whether a reviewer ran and why.
