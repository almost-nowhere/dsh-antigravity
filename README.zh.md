# dsh-antigravity

<p align="center">
  <img src="./assets/images/chat-model-picker.png" alt="dsh-antigravity" width="100%" />
</p>

[English](./README.md) | 简体中文

适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Google Antigravity / Cloud Code Assist 模型提供商插件。

基于 [LiZhenNet/dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity)，增加了账号池：可以登录多个 Google 账号，请求会在这些账号之间调度。调度方式见 [QUOTA-SCHEDULING.md](./QUOTA-SCHEDULING.md)。

> 非官方集成，与 Google 无关联，也未获其认可。请仅使用你有权访问的账号和服务。

---

## 安装到 DSH Web

### 方式一：直接从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:almost-nowhere/dsh-antigravity
```

### 方式二：通过本地 Release 包安装

```sh
npm run pack:dist
dsh plugin --profile web add ./dist/dsh-antigravity-0.0.9.tgz
```

或手动添加至 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: llm-antigravity
      name: dsh-antigravity
```

---

## 登录与授权

打开 **设置（Settings）> Antigravity** 并点击 **登录（Login）**，通过 Google OAuth 授权绑定账号。绑定后将自动刷新配额。支持在设置页面添加多个账号组成调度号池。

![Antigravity Settings - 已登录](./assets/images/settings-signed-in.png)

插件在本地启动 loopback OAuth 回调服务（`http://localhost:51121/oauth-callback`）。若浏览器未自动唤起，可运行终端登录助手：

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-antigravity/bin/antigravity-login.mjs"
```

凭证存储路径：`$DSH_HOME/storages/antigravity-oauth.json`。

---

## 模型列表

在 DSH 模型选择器中选择 **Antigravity** 提供商。可在 **设置 > Antigravity** 中按需启用或关闭特定模型。

| 模型 ID | 名称 | 额度池 |
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

支持推理的模型默认采用适度思考强度，流式输出自动映射为 DSH `reasoning` 内容块，可在模型选择器中自由调节思考档位。

---

## 许可证

[MIT](./LICENSE)
