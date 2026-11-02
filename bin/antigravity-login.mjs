#!/usr/bin/env node
// The old command mutated the legacy single-account file, bypassing the pool.
// Account changes are now serialized by the running DSH host, not another process.
console.error("此本地账户池版本请在 DSH 设置 → Antigravity → 账户池中添加、切换或退出账户。旧单账户 CLI 已停用，未修改任何凭证。\nUse DSH Settings → Antigravity → Account Pool. The legacy single-account CLI is disabled; no credentials were changed.");
process.exitCode = 1;
