# AI Anchor Generator

Internal tool for generating link-building anchor texts in batches via AI providers (OpenRouter, GitHub Models, Google Gemini).

---

## For colleagues — first time using the tool

The tool is hosted at the internal URL your admin shared with you. Before you can reach it you need:

1. **Office VPN connected.** The URL is not reachable from the public internet.
2. **The basic-auth username + password** your admin gave you — your browser will prompt for these the first time you load the page.

Once you're in, here's what you should know:

### What's shared between everyone

- **The API keys are shared.** Everyone in the team uses the same OpenRouter / GitHub Models / Gemini key. Don't change them in Settings without asking the admin first — and never paste an unfamiliar URL into the "Base URL" field (it would send our API keys to that URL).
- **The job list is shared.** You can see, edit, and delete every job. Be polite — name your jobs clearly (e.g. `2026-05-acme-relaunch`) so others know what's yours.
- **The dofollow ratio + distribution + prompts** are job-level settings, not global. Tweak them per job.

### Don't do this

- ❌ **Don't open the same job in two browser tabs and click Resume in both.** The tool will warn you with a yellow banner ("This job is being run from another browser tab" or "...from another browser or laptop") and pause generation in the second window. Wait for the first to finish, or use the "take over" link only if the other window is genuinely stuck/closed. Both same-browser AND cross-laptop cases are guarded — the latter via a database-side runner lease.
- ❌ **Don't put random URLs in the "Base URL" field** in Settings → Providers. The provider URL has to point at the real provider — anything else leaks our API key to that destination.
- ❌ **Don't share the basic-auth password** outside the team or paste it into Slack / email screenshots.

### If something looks wrong

- Check the yellow/red banner at the top of the job page — it usually says exactly what failed.
- Hit `Test connection` in Settings → Providers to confirm the API key still works.
- If you're stuck, ping the admin in Slack before clicking around.

---

## For the admin — deployment

### Stack

- Next.js 15 (App Router) + TypeScript + Tailwind v4
- SQLite via `@libsql/client` (file at project root: `data.db`)
- Single-user data model — no per-user accounts. Auth is HTTP Basic at the edge + VPN.

### Local setup

```bash
git clone <repo-url>
cd ai-anchor-generator
npm install
npm run dev    # http://localhost:3000
```

For dev, leave `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` unset and the auth middleware skips itself.

### Internal-network deployment

**Required env vars in production:**

```bash
BASIC_AUTH_USER=team
BASIC_AUTH_PASS=<a long random string — share once via 1Password / Bitwarden>
DATABASE_URL=file:/var/lib/ai-anchor/data.db   # optional; defaults to ./data.db
```

When both `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` are set, the middleware in `src/middleware.ts` returns 401 + `WWW-Authenticate: Basic` for every request without a matching `Authorization` header. Constant-time comparison; skips static assets.

**Build + run:**

```bash
npm run build
BASIC_AUTH_USER=team BASIC_AUTH_PASS=... npm run start    # port 3000 by default
```

**What you still need to do at the network layer:**

- Bind to a LAN IP only OR put behind nginx that bound to the LAN IP.
- Confirm there's no port-forward / public DNS pointing to the box.
- Restrict by VPN allowlist if your firewall supports it.

Basic auth is the *secondary* control — the VPN is primary. If someone can reach the URL from the open internet, they'll just brute-force the basic-auth password eventually.

### API key handling — what the app does

- Keys are stored in `data.db` **in plaintext** (audit High #4 — not yet fixed).
- Reads via `actionGetSettings` are **redacted** before they leave the server: the client only ever sees `apiKeyPreview: "sk-or…7107"`. The Settings form rounds-trips empty key field as "keep existing".
- The `Test connection` button merges the form's redacted view with the stored key on the server, so unchanged keys still authenticate.

### Things to watch / known limits

- **Plaintext keys at rest.** Anyone with shell access to the box (or a backup of `data.db`) sees raw keys. Encrypt-at-rest is on the audit backlog.
- **Two-runner race is fully guarded.** Two layers: (a) localStorage heartbeat catches same-browser multi-tab cheaply; (b) DB-side runner lease (jobs.runner_id + runner_heartbeat_at, 120s TTL) catches cross-browser, cross-laptop, private-window cases. The first orchestrator to call `actionGenerateBatch` claims the lease atomically; subsequent runners see `status: "lease_lost"` and are blocked with a "take over" banner. The losing runner does NOT make an AI call — no double-spend.
- **Tab-closed = generation pauses.** Clicking Resume picks up at `batchesDone`. This is intentional (works on any host without long-running server processes) but means you can't close your browser if you want a 200-anchor job to finish overnight.
- **No per-user attribution.** All jobs look like they were created by "the team."

### Files

```
src/
  middleware.ts                 # Basic auth gate (env-controlled)
  app/
    layout.tsx                  # Reads settings.locale + theme, sets <html>
    page.tsx                    # Jobs list
    docs/page.tsx               # Russian-only user docs
    settings/                   # Providers / Models / Prompts / Defaults tabs
    jobs/[id]/
      JobView.tsx               # The big one — orchestrator, comparison, anchors
      useJobTabLock.ts          # Two-tab guard hook
  lib/
    db.ts                       # libsql client + schema + WAL
    settings.ts                 # JSON blob in settings table; redact + merge helpers
    actions.ts                  # All server actions (single file)
    jobs.ts                     # DAL (createJob, updateAnchorText, ...)
    types.ts                    # Shared types incl. KEY_CLEAR_SENTINEL
    anchors/
      compose.ts                # Prompt builder with batch hints
      parse.ts                  # JSON extraction + length caps
      batchPlan.ts              # Drift correction with Hamilton rounding
      rebalance.ts              # Per-brand rebalance
      brands.ts                 # matchBrand (host equality / .endsWith only)
    providers/
      index.ts                  # callProvider router, pingProvider
      openai-compat.ts          # OpenRouter (OpenAI SDK)
      github.ts                 # GitHub Models (custom — Authorization: Token)
      gemini.ts                 # Google Gemini
    i18n/messages.ts            # en + ru with TS-enforced parity
```

### Audit status

23 findings total; 6 quick-wins shipped + 3 internal-deploy hardening items (basic auth, key redaction, two-tab guard). Critical SSRF + auth-at-actions + encryption-at-rest items remain — see the `## Open work` section if you plan to expose this beyond the office VPN.

### Resetting / clearing data

```bash
rm data.db data.db-wal data.db-shm    # nukes everything: settings + jobs + anchors
```
