# ADS Registration – parentage field rebuild

Work folder for replacing the strict one-pod / one-pollen parent inputs on the ADS cultivar registration form with a structured, validated multi-generation parentage builder.

| Path | What it is |
|---|---|
| `ads-parentage/` | The WordPress plugin. Upload `ads-parentage.zip` or copy the folder into `wp-content/plugins/`. See `ads-parentage/README.md` for install, mapping, validation and configuration. |
| `ads-parentage.zip` | Zipped plugin, ready for **Plugins → Add New → Upload Plugin**. |
| `demo/index.html` | Standalone demo with the real field ids and a mocked registry lookup. Open it in a browser; no server needed. |
| `tests/core.test.js` | Node tests for the shared model (rendering, validation, string self-check, serialisation). Run `node tests/core.test.js`. |

Canonical format produced: `(Pod × Pollen)` with `×` U+00D7, one space each side, one pair of parentheses per `×`, leaves limited to a registered cultivar name, `sdlg` or `unknown`. Nested crosses are allowed up to a configurable depth, e.g. `((A × B) × (C × sdlg))`. Legacy strings are never parsed.
