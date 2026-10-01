# A9T SDKs

This folder contains the official **TypeScript** (`typescript/`) and **Python** (`python/`) client libraries for the A9T MCP API. They are published as separate packages: **npm** for TS, **PyPI** for Python.

## License

The text is the [MIT License](https://opensource.org/licenses/MIT). The canonical copy is [`LICENSE`](LICENSE) in this folder. The same text is duplicated as [`typescript/LICENSE`](typescript/LICENSE) and [`python/LICENSE`](python/LICENSE) so npm and PyPI artifacts ship the full notice—update all three if the license changes.

---

## Before you publish

1. **Bump the version** in the package you are releasing (keep TS and Python in sync unless you intentionally diverge):
   - TypeScript: [`typescript/package.json`](typescript/package.json) — field `"version"`
   - Python: [`python/pyproject.toml`](python/pyproject.toml) — `[project]` → `version`, and [`python/src/a9t_sdk/__init__.py`](python/src/a9t_sdk/__init__.py) — `__version__` if you expose it publicly
2. Commit and tag if your release process uses git tags (optional but recommended).
3. Use a **clean build** from the relevant subfolder; do not publish from uncommitted experiments.

---

## TypeScript — publish to npm

**Package name:** `@a9t/a9t-sdk` (scoped). Published files come from `dist/` after `tsc`.

### Prerequisites

- An [npm](https://www.npmjs.com/) account with permission to publish under the **`@a9t`** scope (organization on npm).
- Node.js ≥ 18 (see `engines` in `package.json`).
- Logged in locally: `npm login` (or `npm login --auth-type=web` if you use web auth).

### Steps

```bash
cd typescript
npm ci          # or: npm install
npm run build   # produces dist/
npm pack --dry-run   # optional: see what would be included
npm publish --access public
```

Scoped packages default to **restricted** visibility unless you pay for private packages; **`--access public`** is required for a free public package under `@a9t/`.

### Notes

- If publish fails with “402” or scope errors, confirm org membership and that the package name in `package.json` matches what npm expects.
- Enable **2FA** on npm; you may need an automation token or OTP for publish, depending on account settings.
- After publish, consumers install with: `npm install @a9t/a9t-sdk`.

---

## Python — publish to PyPI

**Distribution name:** `a9t-sdk` (import package: `a9t_sdk`). Build with standard PEP‑517 tooling.

### Prerequisites

- A [PyPI](https://pypi.org/) account (and typically [TestPyPI](https://test.pypi.org/) for a trial upload).
- Tools: `pip install build twine` (or use [uv](https://docs.astral.sh/uv/) / [hatch](https://hatch.pypa.io/) if you prefer).

Configure PyPI credentials (choose one):

- **API token** (recommended): create a token on PyPI and put it in `~/.pypirc` or use `twine upload` with `TWINE_USERNAME=__token__` and `TWINE_PASSWORD=pypi-...`.
- Or username/password (legacy; tokens are preferred).

### Steps

```bash
cd python
python -m venv .venv && source .venv/bin/activate   # optional
pip install build twine

python -m build        # creates dist/*.whl and dist/*.tar.gz
twine check dist/*     # validate metadata and files

# Dry run on TestPyPI first (recommended)
twine upload --repository testpypi dist/*

# Production
twine upload dist/*
```

After upload, install with: `pip install a9t-sdk`.

### Notes

- Clear old `dist/` between releases if you do not use a clean CI artifact directory.
- PyPI does not allow **reusing the same version**; bump `pyproject.toml` for each release.
- If you use **Trademark / name squatting** protections on PyPI, ensure the owning account matches your org policy.

---

## Quick reference

| Channel | Package ID        | Build command        | Publish command                            |
| ------- | ----------------- | -------------------- | ------------------------------------------ |
| npm     | `@a9t/a9t-sdk`    | `cd typescript && npm run build` | `npm publish --access public`    |
| PyPI    | `a9t-sdk`         | `cd python && python -m build`   | `twine upload dist/*`            |

For day-to-day usage of each SDK, see [`typescript/README.md`](typescript/README.md) and [`python/README.md`](python/README.md).
