# Pokemon TCG Restock Monitor

Automatically watches **7 retailers** for Pokemon Trading Card Game products — new listings, restocks, and Pokemon Center queues — and sends alerts to Discord and/or email the moment they appear.

Runs free on GitHub Actions every 15 minutes. No server required.

---

## Features

- **7 retailers** — Target, Walmart, Best Buy, Amazon, GameStop, Barnes & Noble, and Pokemon Center scraped on every run
- **Pokemon Center queue detection** — monitors Queue-it for live restock queues; fires an immediate CRITICAL alert with queue position and wait time the moment a drop is detected
- **Smart change detection** — alerts only on genuinely new products and OOS/pre-order → in-stock transitions; no spam for products already seen
- **MSRP cross-reference** — compares prices against Pokemon Center's live catalog and shows the markup percentage in every alert
- **Discord webhooks** — rich embeds with product name, price, MSRP comparison, retailer badge, and a direct Shop Now link; @here mention for queue alerts (opt-in)
- **Email alerts** — styled HTML cards for regular restocks; urgent red-banner email for queue events
- **First-run baseline** — on initial setup, silently snapshots current inventory so only future changes trigger alerts
- **Dry-run mode** — full scrape and compare without sending notifications or writing state, for local testing
- **GitHub Actions ready** — built-in workflow with concurrency control, data file commits, and Discord failure alerts

---

## Retailers

| Retailer | Method | Notes |
|----------|--------|-------|
| Target | Internal RedSky API | In-store availability included |
| Walmart | GraphQL API | Pickup availability included |
| Best Buy | Products API (free key) | Falls back to HTML if no key |
| Amazon | Product Advertising API v5 | Requires PA API credentials; Amazon.com-sold items only by default |
| GameStop | `__NEXT_DATA__` JSON | **Disabled by default** — Cloudflare Enterprise blocks GitHub Actions IPs; enable only with a residential proxy or local run |
| Barnes & Noble | Shopify predictive-search API | No credentials needed; detects new catalog listings |
| Pokemon Center | Queue-it polling + product pages | Queue detection works without credentials; full catalog scraping requires a browser session cookie |

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| npm | ≥ 9 | Bundled with Node |
| Git | any | [git-scm.com](https://git-scm.com) |
| Discord server | — | Only if using Discord notifications |
| Gmail account | — | Only if using email notifications |
| Best Buy API key | free | Only for Best Buy scraping — [developer.bestbuy.com](https://developer.bestbuy.com) |
| Amazon PA API credentials | free | Only for Amazon scraping — [affiliate-program.amazon.com](https://affiliate-program.amazon.com) |

---

## Local Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/pokemon-restock-monitor.git
cd pokemon-restock-monitor
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` and fill in your credentials. At minimum, set `DISCORD_WEBHOOK_URL` (see below).

### 3. Initialize the baseline

This first run snapshots everything currently in stock so future runs only alert on genuine changes:

```bash
node monitor.js --once --init
```

You should see output like:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pokemon TCG Monitor  ·  2026-05-27T10:00:00.000Z  [INIT]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[1/4] Pokemon Center queue check
      No active queue detected  (1.4s)

[2/4] MSRP database
   ✓ 847 products · 2m old  (3.2s)

[3/4] Scraping retailers  (Target + Walmart + Best Buy + Amazon + Barnes & Noble — parallel)
   ✓ Target          24 product(s)  (4.1s)
   ✓ Walmart         18 product(s)  (3.8s)
   ✓ Best Buy        31 product(s)  (2.2s)
   ✓ Amazon          12 product(s)  (3.5s)
   ✓ Barnes & Noble  33 product(s)  (5.1s)
      Disabled: GameStop

[4/4] Baseline initialization  (first run — no notifications)
   ✓ target          24 products baselined
   ✓ walmart         18 products baselined
   ✓ bestbuy         31 products baselined
   ✓ amazon          12 products baselined
   ✓ barnesandnoble  33 products baselined

     118 total products saved as baseline. Next run will detect changes.

Baseline complete  ·  18.4s
```

### 4. Run a dry-run to verify

```bash
node monitor.js --once --test
```

This scrapes and compares against the baseline but sends no notifications and writes no state.

### 5. Run continuously (local cron)

```bash
node monitor.js
```

Starts immediately, then repeats every 15 minutes using the built-in scheduler. Use GitHub Actions instead for unattended operation.

---

## `run_monitor` Bridge

For ChatGPT/tool integration, the repo includes a minimal local HTTP bridge around the existing safe dry-run monitor:

```bash
npm run serve:run-monitor
```

By default it binds to `127.0.0.1:8787` and exposes:

```http
GET /health
POST /run_monitor
```

`POST /run_monitor` takes no body and no arbitrary command input. It executes the current safe Barnes & Noble dry-run observation slice, disables notifications, avoids state persistence, preserves source timeouts, and returns structured JSON:

```json
{
  "run_id": "uuid",
  "status": "success",
  "started_at": "2026-09-15T00:00:00.000Z",
  "completed_at": "2026-09-15T00:00:20.500Z",
  "duration_ms": 20500,
  "sources": [
    {
      "source": "barnesandnoble",
      "status": "success",
      "product_count": 4,
      "elapsed_ms": 8032,
      "message": null
    }
  ],
  "observations": [
    {
      "source": "barnesandnoble",
      "source_type": "retail_listing",
      "source_listing_id": "9050817364209",
      "product_id": "820650856952",
      "name": "Pokemon Battle Academy Board Game",
      "price": 24.99,
      "currency": "USD",
      "availability": "in_stock",
      "url": "https://www.barnesandnoble.com/w/0820650856952/820650856952",
      "observed_at": "2026-09-15T00:00:00.000Z",
      "confidence": "verified",
      "source_status": "success",
      "raw_status": "in_stock"
    }
  ]
}
```

Set `RUN_MONITOR_TOKEN` to require `Authorization: Bearer <token>` on `POST /run_monitor`. Leave `RUN_MONITOR_HOST` unset for local-only binding. To make ChatGPT invoke it directly, deploy this service behind HTTPS and connect a custom tool/plugin/action that calls `POST /run_monitor` with that bearer token.

---

## Getting a Discord Webhook URL

1. Open Discord and go to the server where you want alerts
2. Click the gear icon next to any text channel → **Edit Channel**
3. Click **Integrations** in the left sidebar
4. Click **Webhooks** → **New Webhook**
5. Give it a name (e.g. "Pokemon TCG Monitor") and optionally set an avatar
6. Click **Copy Webhook URL**
7. Paste it into `.env` as `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...`

> The webhook URL contains a secret token — treat it like a password. Never commit `.env` to git.

---

## Setting Up Gmail for Email Alerts

Gmail requires an **App Password** (not your regular password) when SMTP authentication is used from a third-party app.

### Step 1 — Enable 2-Factor Authentication

Go to [myaccount.google.com/security](https://myaccount.google.com/security) and turn on 2-Step Verification if it isn't already on. App Passwords are unavailable without it.

### Step 2 — Create an App Password

1. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Sign in if prompted
3. Under "Select app", choose **Mail** (or type a custom name)
4. Under "Select device", choose **Other** and type `Pokemon Monitor`
5. Click **Generate**
6. Copy the 16-character password shown (spaces don't matter)

### Step 3 — Add to `.env`

```env
EMAIL_ENABLED=true
EMAIL_FROM=you@gmail.com
EMAIL_TO=you@gmail.com          # can be a different address
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=you@gmail.com
SMTP_PASS=abcd efgh ijkl mnop   # the 16-char app password
```

### Step 4 — Test it

```bash
node notifier.js --test --channel email
```

---

## Amazon Setup (optional)

Amazon scraping uses the **Product Advertising API v5** (PA API). It's free but requires an Amazon Associates account.

### Step 1 — Join Amazon Associates

Sign up at [affiliate-program.amazon.com](https://affiliate-program.amazon.com). Approval is usually instant for existing Amazon accounts.

### Step 2 — Get PA API credentials

1. Go to [webservices.amazon.com/paapi5/documentation](https://webservices.amazon.com/paapi5/documentation/)
2. Follow the link to the **PA API console** and create a new Access Key
3. Note your **Access Key ID**, **Secret Access Key**, and your **Associate Tag** (your `storename-20` ID)

### Step 3 — Add to `.env`

```env
AMAZON_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE
AMAZON_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AMAZON_PARTNER_TAG=yourstore-20
AMAZON_FBA_ONLY=false   # true to include 3rd-party FBA sellers; false = Amazon.com only
```

---

## Pokemon Center Cookie Setup (optional)

The Pokemon Center monitor has two modes:

- **Queue-only (no cookie)** — polls Queue-it subdomains every 15 minutes; detects live queues and fires a CRITICAL alert. No setup needed.
- **Full mode (with cookie)** — also scrapes the Pokemon Center product catalog for new listings and stock changes.

To enable full mode, you need a session cookie from a real browser:

### Step 1 — Extract your session cookie

1. Open Chrome and go to [pokemoncenter.com](https://www.pokemoncenter.com)
2. Open DevTools (F12) → **Network** tab
3. Reload the page and click on any request to `pokemoncenter.com`
4. In the **Request Headers** section, find the `Cookie:` header
5. Copy the entire value (it will be a long string of `key=value; key=value; ...` pairs)

### Step 2 — Add to `.env`

```env
PC_COOKIE=_pxvid=abc123; _px3=def456; ...  # paste the full cookie string here
```

### Step 3 — Optional: watch specific product pages

Set `PC_WATCH_URLS` to a comma-separated list of Pokemon Center product URLs you want to monitor for queue redirects. This improves queue detection accuracy for specific drops:

```env
PC_WATCH_URLS=https://www.pokemoncenter.com/product/...,https://www.pokemoncenter.com/product/...
```

> Cookie sessions expire after a few hours to a few days. When the cookie expires, the monitor automatically falls back to queue-only mode rather than erroring out.

---

## GitHub Actions Setup

Running on GitHub Actions means the monitor checks retailers every 15 minutes for free, even when your computer is off.

### Step 1 — Fork the repository

Click **Fork** on the GitHub repository page, then clone your fork:

```bash
git clone https://github.com/YOUR_USERNAME/pokemon-restock-monitor.git
cd pokemon-restock-monitor
```

### Step 2 — Enable Actions on your fork

Go to your fork's **Actions** tab and click **"I understand my workflows, go ahead and enable them"** if prompted.

### Step 3 — Add Secrets

Go to your fork → **Settings** → **Secrets and variables** → **Actions** → **Secrets** tab.

Click **New repository secret** for each credential:

| Secret name | Required | Description |
|-------------|----------|-------------|
| `DISCORD_WEBHOOK_URL` | Yes (for Discord) | Webhook URL from the Discord setup above |
| `BESTBUY_API_KEY` | Yes (for Best Buy) | Free key from [developer.bestbuy.com](https://developer.bestbuy.com) |
| `AMAZON_ACCESS_KEY` | Yes (for Amazon) | PA API access key ID |
| `AMAZON_SECRET_KEY` | Yes (for Amazon) | PA API secret access key |
| `AMAZON_PARTNER_TAG` | Yes (for Amazon) | Your Associates tag (e.g. `yourstore-20`) |
| `PC_COOKIE` | No | Full browser session cookie for Pokemon Center product scraping |
| `EMAIL_ENABLED` | No | Set to `true` to enable email |
| `EMAIL_FROM` | No | Sender Gmail address |
| `EMAIL_TO` | No | Recipient address |
| `SMTP_HOST` | No | `smtp.gmail.com` |
| `SMTP_PORT` | No | `587` |
| `SMTP_SECURE` | No | `false` |
| `SMTP_USER` | No | Your Gmail address |
| `SMTP_PASS` | No | 16-char App Password |

### Step 4 — Add Variables

Go to the same **Secrets and variables** page → **Variables** tab.

Click **New repository variable** for optional overrides:

| Variable name | Default | Description |
|---------------|---------|-------------|
| `NOTIFY_CHANNELS` | `discord` | `discord`, `email`, or `discord,email` |
| `TARGET_ENABLED` | `true` | Set to `false` to disable Target |
| `WALMART_ENABLED` | `true` | Set to `false` to disable Walmart |
| `BESTBUY_ENABLED` | `true` | Set to `false` to disable Best Buy |
| `AMAZON_ENABLED` | `true` | Set to `false` to disable Amazon |
| `AMAZON_FBA_ONLY` | `false` | `true` to include 3rd-party FBA/Prime sellers; `false` = Amazon.com only |
| `GAMESTOP_ENABLED` | `false` | Set to `true` only if running locally or with a residential proxy |
| `BN_ENABLED` | `true` | Set to `false` to disable Barnes & Noble |
| `PC_ENABLED` | `true` | Set to `false` to disable Pokemon Center queue monitoring |
| `PC_WATCH_URLS` | *(empty)* | Comma-separated Pokemon Center product URLs to probe for queue redirects |
| `PC_QUEUEIT_IDS` | `pokemoncenter,pokemon,tpci` | Queue-it customer IDs to poll |
| `PC_QUEUE_MENTION_EVERYONE` | `false` | Set to `true` to add @here to Discord queue alerts |
| `SEARCH_KEYWORDS` | *(see config.js)* | Comma-separated search terms |
| `FILTER_KEYWORDS` | *(see config.js)* | Notify only if name matches one of these |
| `MAX_PAGES` | `3` | Pages to fetch per retailer per run |

### Step 5 — Run initialization

Go to your fork's **Actions** tab → **Pokemon TCG Restock Monitor** → **Run workflow**.

Check the **Force initialization** box and click **Run workflow**. This baselines the current inventory so the first real run only alerts on changes.

### Step 6 — Verify it works

After the init run succeeds, trigger another manual run (without checking any boxes). Check Discord for any notification, or look at the run's summary for the counts of products checked.

From this point the schedule runs automatically every 15 minutes.

---

## Run Modes

### Normal run (cron)

```bash
node monitor.js
```

Runs once immediately, then repeats every 15 minutes. Ctrl-C to stop.

### One-shot (CI / manual)

```bash
node monitor.js --once
```

Runs once and exits. Used internally by the GitHub Actions workflow.

### Dry-run / test mode

```bash
node monitor.js --once --test
```

Full scrape and comparison. Logs everything it would notify but sends nothing and writes no state. Safe to run anytime.

### Force initialization

```bash
node monitor.js --once --init
```

Re-baselines all retailers from scratch. Use this after a long gap where many products changed, to avoid a flood of false "new" alerts.

### Test notifications

```bash
# Test all configured channels
node notifier.js --test

# Test only Discord
node notifier.js --test --channel discord

# Test only email
node notifier.js --test --channel email

# Check channel configuration status
node notifier.js
```

### Test individual scrapers

Each scraper can be run directly to verify it's working:

```bash
node scrapers/target.js
node scrapers/walmart.js
node scrapers/bestbuy.js
node scrapers/amazon.js
node scrapers/barnesandnoble.js
node scrapers/gamestop.js

# Pokemon Center — queue detection only (no cookie needed)
node scrapers/pokemoncenter.js --queue-only

# Pokemon Center — show all products (requires PC_COOKIE in .env)
node scrapers/pokemoncenter.js --all

# Show queue history
node scrapers/pokemoncenter.js --history
```

---

## Configuration Reference

All options are set via environment variables (`.env` locally, Secrets/Variables in GitHub Actions).

### Notification channels

| Variable | Default | Description |
|----------|---------|-------------|
| `NOTIFY_CHANNELS` | `discord,email` | Which channels to use. Comma-separated: `discord`, `email`, or both |
| `DISCORD_WEBHOOK_URL` | — | Discord webhook URL |
| `EMAIL_ENABLED` | `false` | Must be `true` to send emails |
| `EMAIL_FROM` | — | Sender address |
| `EMAIL_TO` | — | Recipient address |
| `SMTP_HOST` | `smtp.gmail.com` | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_SECURE` | `false` | `true` for port 465 (SSL), `false` for STARTTLS |
| `SMTP_USER` | — | SMTP username (usually your email) |
| `SMTP_PASS` | — | SMTP password or App Password |

### Retailers

| Variable | Default | Description |
|----------|---------|-------------|
| `TARGET_ENABLED` | `true` | Enable Target scraping |
| `WALMART_ENABLED` | `true` | Enable Walmart scraping |
| `BESTBUY_ENABLED` | `true` | Enable Best Buy scraping |
| `BESTBUY_API_KEY` | — | Best Buy Products API key (free) |
| `AMAZON_ENABLED` | `true` | Enable Amazon scraping |
| `AMAZON_ACCESS_KEY` | — | PA API access key ID |
| `AMAZON_SECRET_KEY` | — | PA API secret access key |
| `AMAZON_PARTNER_TAG` | — | Amazon Associates tag |
| `AMAZON_FBA_ONLY` | `false` | `true` to include FBA 3rd-party sellers |
| `GAMESTOP_ENABLED` | `false` | Enable GameStop (requires residential IP) |
| `BN_ENABLED` | `true` | Enable Barnes & Noble scraping |
| `PC_ENABLED` | `true` | Enable Pokemon Center queue monitoring |
| `PC_COOKIE` | — | Browser session cookie for PC product scraping |
| `PC_WATCH_URLS` | — | Comma-separated product URLs to probe for queue redirects |
| `PC_QUEUEIT_IDS` | `pokemoncenter,pokemon,tpci` | Queue-it customer IDs to poll |
| `PC_QUEUE_MENTION_EVERYONE` | `false` | Add @here to Discord queue alerts |

### Search and filtering

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARCH_KEYWORDS` | `pokemon trading card game, pokemon tcg booster, pokemon elite trainer box` | Terms used to search each retailer. Comma-separated. |
| `FILTER_KEYWORDS` | `booster,elite trainer,etb,tin,collection,bundle,box,pack` | Product name must contain at least one of these to trigger a notification. Leave blank to notify on all results. |
| `MAX_PAGES` | `3` | How many result pages to fetch per retailer per run |

### Schedule

The check interval is hardcoded in `config.js` as `*/15 * * * *` (every 15 minutes). To change it, edit `config.checkInterval` and update the cron expression in `.github/workflows/monitor.yml`.

---

## Troubleshooting

### "No products found" for a retailer

- **Target / Walmart**: Their websites use bot-detection. The scrapers use residential-browser headers but can still be blocked intermittently. Retry a few minutes later.
- **Best Buy**: Without `BESTBUY_API_KEY` set, Best Buy falls back to HTML scraping which Akamai Bot Manager frequently blocks. Register for a free key at [developer.bestbuy.com](https://developer.bestbuy.com).
- **Amazon**: If `AMAZON_ACCESS_KEY` / `AMAZON_SECRET_KEY` / `AMAZON_PARTNER_TAG` are not set, Amazon is automatically skipped with a warning. If credentials are set but results are empty, verify your Associate account is approved and the keys are active.
- **GameStop**: Cloudflare Enterprise blocks all datacenter IPs (including GitHub Actions). GameStop is disabled by default and only works from a residential IP or with a residential proxy.
- **Barnes & Noble**: No credentials required. If results are empty, B&N may have changed their Shopify API endpoint — check the comment at the top of `scrapers/barnesandnoble.js`.

### Pokemon Center queue alerts not firing

1. Run `node scrapers/pokemoncenter.js --queue-only` — it should log `No active queue detected` when no drop is in progress.
2. Verify `PC_ENABLED` is not set to `false`.
3. If you want @here pings, set `PC_QUEUE_MENTION_EVERYONE=true`.
4. To monitor specific product pages (improves detection), add their URLs to `PC_WATCH_URLS`.

### Pokemon Center product scraping not working

1. The `PC_COOKIE` must be set — without it the scraper runs in queue-only mode.
2. Cookies expire (typically within a few hours). Re-extract from Chrome DevTools and update the secret.
3. Pokemon Center uses Imperva for HTML pages and DataDome on API endpoints, both of which block datacenter IPs. Product scraping only works with a valid session cookie from a real browser.

### Discord notifications not arriving

1. Run `node notifier.js` to check channel status — the output shows whether Discord is `🟢 ready` or `🔴 missing credentials`.
2. Verify `DISCORD_WEBHOOK_URL` is set correctly in `.env`.
3. Run `node notifier.js --test --channel discord` to send a test message.
4. Check that the webhook hasn't been deleted in Discord (Server Settings → Integrations → Webhooks).

### Email not sending

1. Confirm `EMAIL_ENABLED=true` in `.env`.
2. Make sure `SMTP_PASS` is the 16-character App Password, not your Google account password.
3. Verify 2-Factor Authentication is enabled on the Gmail account (required for App Passwords).
4. Run `node notifier.js --test --channel email` — the error message will be specific (EAUTH = wrong credentials, ECONNREFUSED = wrong host/port).

### GitHub Actions: "push failed" or workflow doesn't commit

- The `GITHUB_TOKEN` secret is automatically available — you don't need to create it. Ensure `permissions: contents: write` is present in the workflow (it is by default in this repo).
- If your repo requires signed commits or branch protection, you may need to relax those rules for the `github-actions[bot]` user.

### GitHub Actions: workflow doesn't trigger every 15 minutes

GitHub's cron scheduler for Actions can have delays of up to 15–30 minutes on free accounts, and may pause entirely if the repository has had no activity for 60 days. To re-enable a paused schedule, push any commit or trigger a manual run. For guaranteed 15-minute cadence, set up an external trigger using a free service like [cron-job.org](https://cron-job.org) to POST to the workflow's `workflow_dispatch` endpoint.

### Too many notifications / alert spam

1. Tighten `FILTER_KEYWORDS` — add more specific product terms.
2. If you changed keywords or filter config and want a fresh baseline: `node monitor.js --once --init`.

### State file is missing or corrupt

Delete `data/products.json` and run `node monitor.js --once --init` to regenerate. The monitor will treat the missing file as a first run and create a clean baseline automatically.

---

## Project Structure

```
pokemon-restock-monitor/
├── monitor.js               # Main orchestrator — phases, logging, CLI
├── config.js                # All configuration (reads from .env)
├── stateManager.js          # State load/save, change detection, MSRP gate
├── notifier.js              # Notification routing (Discord + email)
├── msrpChecker.js           # Fetches MSRP data from Pokemon Center
├── scrapers/
│   ├── target.js            # Target scraper (RedSky API + in-store availability)
│   ├── walmart.js           # Walmart scraper (GraphQL + pickup status)
│   ├── bestbuy.js           # Best Buy scraper (Products API + HTML fallback)
│   ├── amazon.js            # Amazon scraper (PA API v5 with AWS Sig V4)
│   ├── gamestop.js          # GameStop scraper (disabled by default — Cloudflare)
│   ├── barnesandnoble.js    # Barnes & Noble scraper (Shopify predictive-search)
│   └── pokemoncenter.js     # Pokemon Center — queue detection + catalog scraping
├── notifiers/
│   ├── discord.js           # Discord webhook sender + queue alert
│   └── email.js             # Email sender (nodemailer) + queue alert email
├── utils/
│   └── retry.js             # withRetry / sleep shared utilities
├── data/
│   ├── products.json        # Persisted product state (auto-generated)
│   ├── msrp-database.json   # MSRP cache (auto-generated)
│   └── pc-queue-history.json # Pokemon Center queue event log (auto-generated)
├── .github/workflows/
│   └── monitor.yml          # GitHub Actions workflow
├── .env.example             # Template — copy to .env and fill in values
└── package.json
```

---

## License

MIT
