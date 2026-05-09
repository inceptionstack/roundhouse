# PR Merge Discipline

Never merge a PR without checking for review comments first.

## When to Use

Activate this skill when:
- About to merge a PR
- Using `gh pr merge`
- PR has been approved or CI passed

## Rules

1. **Always check PR comments before merging**: `gh pr view <number> --comments`
2. **If there are unresolved comments**, read and address them first
3. **If there are review requests**, wait for or acknowledge them
4. **Only merge when**: CI green + no unresolved comments + no pending reviews
5. **After merge**: pull main and verify clean state

## Workflow

```bash
# Before any merge:
gh pr view <number> --comments
gh pr checks <number>

# Only then:
gh pr merge <number> --squash --admin
```

## Anti-Patterns

- ❌ Merging immediately after CI passes without checking comments
- ❌ Using `sleep && gh pr merge` without a comment check in between
- ❌ Force-merging over unresolved review feedback
- ❌ Assuming "no issues found" from automated review means no human comments exist
