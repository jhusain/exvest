# Exvest

See the [specification](./SPEC.md) for detailed information on this App, it's UX, interactions, and so forth.

This app will eventually be hosted in a Chrome extension which forwards data from the Schwab website to the app, and then forwards commands from the app to Schwab. However at the moment it's hosted in a website which mocks Schwab data to simplify testing.
  
Split by **logic** (`src/logic.js`), **utilities** (`src/util.js`), **broker** (`src/broker.js`), and **views** (`src/views.jsx`). Built with **Vite**, tested with **Vitest**, deployed to **GitHub Pages** via **GitHub Actions**.

---

## Quick start

```bash
npm ci
npm run dev
````

Open the URL that Vite prints (e.g., `http://localhost:5173/`).

---

## Scripts

| Script                 | Purpose                                                      | Output     | Source maps |
| ---------------------- | ------------------------------------------------------------ | ---------- | ----------: |
| `npm run dev`          | Local development server with HMR                            | —          |           ✅ |
| `npm run build:dev`    | Build the **dev** bundle used by GitHub Pages                | `dist-dev` |           ✅ |
| `npm run build:prod`   | Build the **production** bundle                              | `dist`     |           ❌ |
| `npm run preview:dev`  | Serve the **dev** bundle locally (exactly what Pages serves) | —          |           ✅ |
| `npm run preview:prod` | Serve the **prod** bundle locally                            | —          |           ❌ |
| `npm test`             | Run unit tests with Vitest                                   | —          |           — |

Common flows:

```bash
# Development with HMR
npm run dev

# Validate what GitHub Pages will serve
npm run build:dev
npm run preview:dev

# Production bundle (if you switch Pages to prod later)
npm run build:prod
npm run preview:prod
```

---

## GitHub Pages (deployment)

This repository uses a workflow that builds the **dev** bundle (`dist-dev/`) and publishes it to GitHub Pages on every push to the default branch.

1. In your repository, open **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.
2. Push to your default branch (`master` or `main`). The workflow will:

   * install dependencies with `npm ci`
   * run `npm run build:dev`
   * publish `dist-dev/` to Pages

Your site will be available at:

```
https://<your-user>.github.io/<your-repo>/
```

### Base path (important)

On GitHub Pages, the app is hosted under `/<your-repo>/`.
`vite.config.js` sets the correct `base` automatically in CI using the repository name, so **no changes** are required. When running locally, the base is `/`.

**Tip:** In `index.html`, reference assets without a leading slash (e.g., `favicon.svg`, not `/favicon.svg`).

### Workflow files location

Workflows must live at `.github/workflows/*.yml` (all lowercase).

---

## Continuous Integration

* **`.github/workflows/ci.yml`** runs `npm ci` and tests on pull requests to `master`/`main`.
* **`.github/workflows/pages.yml`** builds and deploys the dev bundle to Pages on pushes to `master`/`main`.

You can view runs in the repository’s **Actions** tab.

---

## Tests

A smoke test is included to keep CI green. Add your tests under `tests/`:

```bash
npm test
```

Vitest uses the `jsdom` environment for React component testing.

---

## Project structure

```
.github/workflows/ci.yml          # PR tests
.github/workflows/pages.yml       # Pages deploy (dev bundle)
public/favicon.svg
src/logic.js                      # state slices and store
src/broker.js                     # mock brokerage
src/util.js                       # selectors and shared helpers
src/views.jsx                     # all React components
src/main.jsx                      # entrypoint
src/styles.css
tests/smoke.test.js               # placeholder tests
index.html
package.json
vite.config.js
```

* **State and actions** live in `src/logic.js`; **mock brokerage** in `src/broker.js`; **selectors and utilities** in `src/util.js`.
* **All views** are in `src/views.jsx`. The historical chart is SVG; gridlines and PAS layout are memoized via Reselect.
* **Styles** are in `src/styles.css`.

---

## Contributing workflow

```bash
git checkout -b feat/your-change
# edit code
npm test
npm run build:dev && npm run preview:dev   # optional local verification
git add -A && git commit -m "feat: your change"
git push -u origin feat/your-change        # open a PR
# CI runs tests; merging to default branch deploys to Pages automatically
```
