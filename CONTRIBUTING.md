# Contributing

## Quick PR workflow

1. Create a feature branch from `main` (e.g., `chore/description`).
2. Keep PRs focused: one behavior change and related docs/tests in a single branch.
3. Include a test/verification plan in the PR description.
4. Reference existing constants and behavior in docs changes (e.g., framing limits, ownership/ownership boundaries).
5. Keep branch history clean (squash/finalize before opening).
6. Keep branch/PR names short and meaningful.

## Suggested checklist before opening a PR

- [ ] Does the change include required docs updates?
- [ ] Do README/typing/constants match implementation behavior?
- [ ] Are edge cases covered in tests when logic changes?
- [ ] Is branch cleanup handled (close duplicate PRs or obsolete branches)?
- [ ] Do CI instructions in PR description include a validation or verification plan?

## Branch note

- `main` is protected in this repository, so changes must be merged through PRs.
