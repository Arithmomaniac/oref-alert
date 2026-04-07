# Oref Alert Display

Fullscreen traffic-light alert monitor for Israeli cities.

A web-based alert display for Pikud HaOref (Israeli Home Front Command) alerts. Shows a fullscreen color (green → yellow → orange → amber → red) for a specific city, with statistical analysis of historical alert patterns. Designed for wall-mounted displays, kiosk mode, or personal use.

## Screenshots

| City picker | Green (all-clear) state | Missed-Us Threshold Report |
|:-----------:|:-----------------------:|:--------------------------:|
| ![City picker](docs/city-picker.png) | ![Green state](docs/green-state.png) | ![Report](docs/report.png) |

## Usage

```
https://orefalertst.z39.web.core.windows.net/?city=בית שמש
```

Replace `בית שמש` with your city name in Hebrew. The city name must match exactly as it appears in Pikud HaOref data.

## Usage Tips

### Choosing a city

Open the site without a `?city=` parameter to see the **city picker** page. Start typing a city name in Hebrew — an autocomplete dropdown will appear. You can also click the **📍 "Use my location"** button to detect the nearest city via browser geolocation.

### URL parameters

| Parameter | Example | Description |
|-----------|---------|-------------|
| `city` | `?city=בית שמש` | City to monitor (Hebrew, URL-encoded) |
| `missedus` | `?city=בית שמש&missedus=120` | Override the "missed us" threshold in **seconds** (default is per-city from historical data) |

### Report page

The **Missed-Us Threshold Report** is available at [`/report.html`](https://orefalertst.z39.web.core.windows.net/report.html). It analyses historical pre-alert events to determine the optimal "missed us" threshold per city.

- Compare up to 3 cities side-by-side using the city picker at the top.
- City selections are stored in the URL hash — e.g. `report.html#כרמיאל,בית שמש,חריש` — so you can bookmark or share a comparison link.

### What does "כנראה עבר" (amber) mean?

When a PRE_ALERT (early warning) arrives and nearby cities in the same alert cohort receive sirens but **your city does not**, the display transitions to an amber/yellow-orange state labelled **כנראה עבר** ("probably passed"). This means at least 95% of historical events with the same pattern did not result in a siren for your city. Click the **?** button on screen for details about the specific threshold used.

## Colors

| Color | State | Meaning | Hebrew |
|-------|-------|---------|--------|
| 🟢 Green | `green` | All clear | הכל תקין |
| 🟡 Yellow | `pre_alert` | Early warning received | התראה מוקדמת |
| 🟠 Deep Orange | `siren_window` | Within the historical siren arrival window — a siren is plausible now | התראה מוקדמת |
| 🟡 Amber | `likely_passed` | Probably passed — cohort cities got sirens, yours did not within the threshold | כנראה עבר |
| 🔴 Red | `alert` | Active siren | !אזעקה |

### State transitions

```
green ──[pre-alert received]──→ pre_alert (yellow)
                                    │
                           [P5 siren time elapsed]
                                    │
                                    ▼
                               siren_window (deep orange)
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
     [cohort threshold met]    [siren arrives]       [expiry]
              │                     │                     │
              ▼                     ▼                     ▼
        likely_passed (amber)    alert (red)          green
```

- **pre_alert → siren_window**: Triggered when elapsed time since the pre-alert exceeds the city's P5 siren timing (i.e., 5% of historical sirens arrived by this point).
- **siren_window → likely_passed**: Triggered when nearby cities in the same alert cohort received sirens but your city did not, and the per-city "missed us" threshold (≥95% confidence) has been exceeded.
- Any state can transition directly to **red** if an actual siren is received.

## Features

- **Real-time polling** — 5-second update cycle with stale-data warning
- **Fullscreen traffic-light display** — responsive design for any screen size
- **Five-state alert engine** — green → pre_alert → siren_window → likely_passed → red
- **Per-city "missed us" thresholds** — computed from historical data at ≥95% confidence
- **Siren timing statistics** — P5/P25/median/P75/P95 percentile analysis per city
- **Siren window state** — warns when elapsed time enters the historical siren arrival window
- **City autocomplete** — Hebrew city picker with type-ahead validation
- **Geolocation** — detect nearest city via browser GPS (polygon containment + nearest-city fallback)
- **Missed-us threshold report** — interactive analysis page with charts and city comparison
- **Screen Wake Lock** — prevents the display from dimming
- **City name in browser tab** — easy identification across tabs
- **Hebrew-only UI** — with contextual help panels explaining each state
- **App versioning** — reload-prompt banner when a new version is deployed
- **Event log overlay** — scrolling log of recent alert events
- **7-day session timeout** — prevents abandoned tabs from polling indefinitely
- **Application Insights** — client-side telemetry for monitoring
- **No external runtime dependencies** — vanilla JavaScript, no frameworks

## Architecture

```
  ┌──────────────┐     every 5s     ┌──────────────────┐
  │  oref.org.il │ ◄──────────────  │  Azure Function  │
  │  (alerts +   │ ──────────────►  │  (Python, timer) │
  │   history)   │    JSON          └────────┬─────────┘
  └──────────────┘                           │
                                     writes state.json
                                             │
                                             ▼
                                   ┌──────────────────┐
                                   │  Azure Blob      │
                                   │  Storage ($web)  │ ◄── static HTML/JS
                                   └────────┬─────────┘
                                            │
                                     serves both API
                                     + static assets
                                            │
                                            ▼
                                   ┌──────────────────┐
                                   │  Browser client   │
                                   │  (alert-engine.js)│
                                   └──────────────────┘
```

- **Azure Function** (Python, timer trigger) polls oref.org.il from Israel Central every 5 seconds
- Writes combined alert + history state to **Azure Blob Storage** (`$web/api/state.json`)
- **Daily threshold job** streams historical CSV data, computes per-city thresholds + siren timing stats, and writes `thresholds.json`
- **Geolocation endpoint** (`/api/locate`) resolves lat/lng to a city using polygon containment with nearest-city fallback
- **Static HTML/JS** served from the same `$web` blob container (no CORS issues)
- **Client-side alert engine** (`alert-engine.js`) — pure business logic module with no DOM or fetch dependencies, fully testable with injected clock

## Testing

```bash
npm test              # Playwright integration tests (color states, report page, wake lock)
npm run test:unit     # Node.js unit tests for alert-engine.js
```

## Deployment

Requires an Azure subscription with the Israel Central region.

- Infrastructure deployed via **Bicep** (`infra/`)
- CI/CD via **GitHub Actions** with OIDC federated credentials
- Push to `main` triggers deployment automatically
  - Changes to `infra/**` trigger infrastructure deployment
  - All other changes trigger function + web deployment

### Required GitHub secrets

| Secret | Description |
|--------|-------------|
| `AZURE_CLIENT_ID` | App registration client ID (federated credential) |
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |

### Required GitHub variables

| Variable | Description |
|----------|-------------|
| `AZURE_FUNCTIONAPP_NAME` | Name of the Azure Function App |

## Credits & Acknowledgments

### Inspiration

- **[MamadLight](https://orshabbat.base44.app/en)** — the original inspiration for a quiet, fullscreen traffic-light alert display for the Israeli home.

### Code & Data

- **[amitfin/oref_alert](https://github.com/amitfin/oref_alert)** — alert classification logic (real-time category mapping, PRE_ALERT/ALERT/END detection) was ported from this Home Assistant integration.
- **[dleshem/israel-alerts-data](https://github.com/dleshem/israel-alerts-data)** — historical alert CSV dataset used for threshold computation and siren timing analysis.
- **[eladnava/redalert-android](https://github.com/eladnava/redalert-android)** — city geocoding coordinates and polygon boundary data used for the geolocation endpoint.

### Built with

This project was built with [GitHub Copilot](https://github.com/features/copilot) as an AI pair-programming assistant.
