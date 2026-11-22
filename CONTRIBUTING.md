# Contributing

## Setup

```bash
npm ci            # also installs the git hooks (husky, via the "prepare" script)
npm run typecheck
HOME=$(mktemp -d) npm test
```

## Secret scanning

Secrets must never reach the repository. Two layers enforce it:

- **Pre-commit hook** (`.husky/pre-commit`, installed by `npm ci`). It scans the
  *staged* version of every added or changed file with
  [secretlint](https://github.com/secretlint/secretlint) (`.secretlintrc.json`,
  recommended preset), then runs the pattern check in `.githooks/pre-commit`
  (Telegram, Anthropic, OpenAI, AWS, npm). A hit blocks the commit and prints
  the file and line with the value masked. Nothing needs to be installed
  besides the npm dev dependencies.
- **CI** (`secret-scan` job in `.github/workflows/test.yml`). It runs a pinned,
  checksum-verified [gitleaks](https://github.com/gitleaks/gitleaks) over the
  full git history on every push to `main` and every pull request.

If the hook blocks you, remove the secret, rotate it if it was real, and commit
again. Do not bypass with `git commit --no-verify`: CI scans every commit, so a
secret that slips past the hook still fails the build, and it is already in
history by then.

False positives (fake tokens in tests): prefer an obviously fake value. If a
test needs a realistic shape, allow that exact shape in `.secretlintrc.json`
(the Slack rule's `allows` list) and, for a commit gitleaks flags, add its
fingerprint (`commit:file:rule:line`) to `.gitleaksignore` after checking it.

To run the history scan locally, download gitleaks from its releases page and run
`gitleaks git --redact --log-opts=HEAD .`.

Set `HUSKY=0` to skip installing hooks (e.g. in a packaging environment).
