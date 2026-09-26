# Vendored third-party libraries

These files are vendored locally so the dashboard works without a CDN or a build
step (and so the UI stays fully offline / local-first). They are **not** modified.

| Library | Version | License | Upstream | Vendored files |
|---|---|---|---|---|
| [Chart.js](https://www.chartjs.org) | 4.5.1 | [MIT](https://github.com/chartjs/Chart.js/blob/v4.5.1/LICENSE.md) | https://www.chartjs.org / npm `chart.js@4.5.1` | `chart.js/chart.umd.min.js` |
| [flatpickr](https://flatpickr.js.org) | 4.6.13 | [MIT](https://github.com/flatpickr/flatpickr/blob/v4.6.13/LICENSE.md) | https://flatpickr.js.org / npm `flatpickr@4.6.13` | `flatpickr/flatpickr.min.js`, `flatpickr/flatpickr.min.css` |
| [Tom Select](https://tom-select.js.org) | 2.6.2 | [Apache-2.0](https://github.com/orchidjs/tom-select/blob/v2.6.2/LICENSE) | https://tom-select.js.org / npm `tom-select@2.6.2` | `tom-select/tom-select.complete.min.js`, `tom-select/tom-select.min.css` |

## Upgrade notes

- Version info is embedded in the file headers (e.g. `Chart.js v4.5.1`,
  `flatpickr v4.6.13`, `Tom Select v2.6.2`) — verify the header when upgrading.
- `tom-select.complete.min.js` bundles Tom Select **plus** the Dropdown Input
  plugin, which the filter bar relies on.
- The dark-theme overrides for flatpickr and Tom Select live in
  `public/styles.css` (`.flatpickr-*` and `.filter-field .ts-*` rules) and may
  need a review after upgrading either library.
