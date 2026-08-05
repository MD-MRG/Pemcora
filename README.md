# Pemcora

Field console for AV service work: preventative maintenance, commissioning, and the
Excel reports that go back to the client.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:5173/.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with HMR |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the built output |
| `npm run lint` | Oxlint |

## How it fits together

React 19 + Vite + Tailwind v4, using **HashRouter** so deep links survive a hard reload
without a server-side rewrite, and `base: './'` so the build works at any sub-path.

Everything persists to `localStorage` behind three store modules, which are the single
place a backend swaps in:

- `src/lib/clientStore.js` — clients → locations → floors → rooms, and visits
- `src/lib/templateStore.js` — the maintenance, commissioning and custom test lists
- `src/lib/settingsStore.js` — company details, logos, brand colour, default technician

Preventative Maintenance and Commissioning are **the same page**. The whole workflow
lives in `src/workflows/WorkflowPage.jsx`; each page is about fifteen lines of config.
Change the workflow there, never by copying it.

Each room stores its own snapshot of the test list when first opened, so editing a list
in Settings can never rewrite work that has already been signed off.

## Tests

Headless suites in `tests/` drive the real UI and assert against `localStorage` and the
generated `.xlsx` files. Start the dev server first, then:

```bash
node tests/pm-workflow.mjs
```

See [tests/README.md](tests/README.md) for the full list and what each one covers.
