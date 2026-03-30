# Oref Alert Display

Fullscreen traffic-light alert for Israeli cities.

A web-based alert display for Pikud HaOref (Israeli Home Front Command) alerts. Shows a fullscreen color (green/yellow/red) for a specific city. Designed for wall-mounted displays, kiosk mode, or personal use.

## Usage

```
https://orefalertst.z39.web.core.windows.net/?city=בית שמש
```

Replace `בית שמש` with your city name in Hebrew. The city name must match exactly as it appears in Pikud HaOref data.

## Colors

| Color | Meaning | Hebrew |
|-------|---------|--------|
| 🟢 Green | All clear | הכל תקין |
| 🟡 Yellow | Early warning | התראה מוקדמת |
| 🔴 Red | Active siren | !אזעקה |

## Features

- Real-time polling (5-second updates)
- Responsive design (works on any screen size)
- Clock display
- Event log overlay
- 7-day session timeout (prevents abandoned tabs)
- No external dependencies

## Architecture

- **Azure Function** (Python, timer trigger) polls oref.org.il from Israel Central
- Writes raw alert data to **Azure Blob Storage**
- **Static HTML** served from same blob storage (no CORS issues)
- Client-side JavaScript classifies alerts for the specified city

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

## Based on

Alert classification logic ported from [amitfin/oref_alert](https://github.com/amitfin/oref_alert) Home Assistant integration.
