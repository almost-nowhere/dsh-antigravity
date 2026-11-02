# dsh-antigravity

<p align="center">
  <img src="./assets/images/chat-model-picker.png" alt="dsh-antigravity" width="100%" />
</p>

English | [简体中文](./README.zh.md)

Google Antigravity / Cloud Code Assist model provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Provides Google OAuth authentication, **multi-account pool scheduling**, live quota monitoring, seamless failover, and full internationalization (i18n).

> **Credits**: This project is built upon [Miyamiz39/dsh-antigravity](https://github.com/Miyamiz39/dsh-antigravity). Special thanks to the original author for the foundational integration work. This project extends it with multi-account pool scheduling, health awareness, automatic failover, and diagnostics.

---

## Features

- **Multi-Account Scheduling**: Manage multiple Google accounts with automatic load-aware scheduling across active sessions. Preserves session affinity while providing seamless failover when quota is depleted or throttled.
- **Live Quota Monitoring**: Real-time visualization for Gemini and 3P (Claude / GPT) quota buckets, including 5-hour and weekly reset tracking.
- **Model Support**: Full support for `gemini-3.8-flash`, `gemini-3.7-flash`, `claude-opus-4-6`, `claude-sonnet-4-6`, etc., with customizable reasoning effort tiers.
- **Diagnostics**: Built-in structured diagnostics logging to easily inspect and resolve request errors.

---

## Installation

### Method 1: Install from GitHub (Recommended)

```sh
dsh plugin --profile web add github:almost-nowhere/dsh-antigravity
```

### Method 2: Local Release Package

```sh
npm run pack:dist
dsh plugin --profile web add ./dist/dsh-antigravity-0.0.9.tgz
```

Or add to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: llm-antigravity
      name: dsh-antigravity
```

---

## Login & Authentication

Open **Settings > Antigravity** and click **Login** to authorize via Google OAuth. The settings page automatically refreshes your quota upon login. You can add multiple accounts in the settings view to configure a pool.

![Antigravity Settings - Signed In with Quota](./assets/images/settings-signed-in.png)

The plugin starts a loopback OAuth callback server at `http://localhost:51121/oauth-callback`. If your browser does not open automatically, run the CLI helper:

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-antigravity/bin/antigravity-login.mjs"
```

Credentials are saved at: `$DSH_HOME/storages/antigravity-oauth.json`.

---

## Models

Select **Antigravity** in the DSH model picker. You can configure individual models in **Settings > Antigravity**.

| Model ID | Name | Quota pool |
|---|---|---|
| `gemini-3.8-flash` | Gemini 3.8 Flash | Gemini |
| `gemini-3.7-flash` | Gemini 3.7 Flash | Gemini |
| `gemini-3.6-flash` | Gemini 3.6 Flash | Gemini |
| `gemini-3.5-flash` | Gemini 3.5 Flash | Gemini |
| `gemini-3.1-pro` | Gemini 3.1 Pro | Gemini |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | Gemini |
| `gemini-3-flash` | Gemini 3 Flash | Gemini |
| `gemini-2.5-pro` | Gemini 2.5 Pro | Gemini |
| `gemini-2.5-flash` | Gemini 2.5 Flash | Gemini |
| `claude-opus-4-6` | Claude Opus 4.6 | Claude & GPT (3P) |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | Claude & GPT (3P) |
| `gpt-oss-120b` | GPT-OSS 120B | Claude & GPT (3P) |

Reasoning-capable models map thinking tokens into DSH's native `reasoning` blocks, with configurable effort tiers.

---

## License

[MIT](./LICENSE)
