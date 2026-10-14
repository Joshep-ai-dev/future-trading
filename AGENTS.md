# Repository Guidelines

## Project Structure

- `src/` contains the React/TypeScript UI, charts, account settings and exchange execution.
- `server/` contains the Python API, strategy, trading logic and `test_*.py` tests.
- `data/` holds local market history/runtime state; `scripts/` has development helpers; `reports/` stores research output.
- Root config includes `package.json`, `requirements.txt`, `index.html` and `vite.config.ts`.

## Build, Test and Run

- `npm install` installs frontend dependencies.
- `npm run dev` starts the local API and Vite UI on loopback; `start.cmd` is the Windows launcher.
- `npm run build` runs the TypeScript project build and creates the production UI in `dist/`.
- `.venv/Scripts/python.exe -m unittest discover -s server -t .` runs Python tests on Windows; use `python -m unittest discover -s server -t .` elsewhere.

## Code Style and Naming

- Use two spaces in TypeScript/TSX, four in Python, semicolons in TypeScript and Python type annotations.
- Name React components/files in PascalCase (`AccountPage.tsx`), TypeScript values in camelCase, and Python modules/functions/tests in snake_case.
- Keep domain behavior in its existing module and reuse shared settings/helpers. No formatter or linter is configured; run `git diff --check`.

## Testing

- Backend tests use standard `unittest`: files `test_<feature>.py`, functions `test_<behavior>`.
- Cover strategy, API, market-data and paper-trading changes. For UI changes, run `npm run build` and review responsive layouts.
- No coverage threshold is configured.

## Commits and Pull Requests

- Recent history uses terse fix subjects (`fixed`, `critical fix`) without a consistent convention. Prefer an imperative, scoped subject, e.g. `Fix exchange selector state`.
- PRs should summarize behavior, link issues if available, list checks and results, and include UI screenshots. Flag live-trading or credential changes.

## Security and Local Data

- Never commit API keys, secrets, passphrases or account data. Keep live credentials in backend memory; disable withdrawals and limit key permissions.
- Treat `data/` and local environment files as runtime data. Preserve source market history; exclude generated and account-specific files from commits.
