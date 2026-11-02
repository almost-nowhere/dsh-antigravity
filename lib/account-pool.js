/**
 * Local, manually selected OAuth accounts. No network, account rotation, or replay.
 *
 * LocalAccountPool(file, legacyStore?)
 *   ensureMigrated(), list(), upsert(credentials, { select = true, label }?)
 *   select(id), remove(id), rename(id, label), storeFor(id), captureActiveStore()
 *
 * Fixed stores expose accountId, read/write/delete/modify. delete clears only that
 * account's credentials; remove is the only operation that removes its record.
 * Removing the active account leaves no selection. Neither operation falls back.
 * Legacy credentials are read once when creating the pool and never modified.
 * This is a process-local lock, not a cross-process storage protocol.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const pathLocks = new Map();
const accountLocks = new Map();
const VERSION = 1;

function serialize(locks, key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const result = previous.then(fn);
  const settled = result.then(() => {}, () => {});
  locks.set(key, settled);
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return result;
}

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function credentialsCopy(value) {
  if (!record(value)) throw error("ACCOUNT_POOL_CREDENTIALS", "Credentials must be a JSON object.");
  try {
    const result = clone(value);
    if (!record(result)) throw new Error();
    return result;
  } catch {
    // Never include credential values or JSON parser excerpts in errors.
    throw error("ACCOUNT_POOL_CREDENTIALS", "Credentials must be a JSON object.");
  }
}

function nonempty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identityOf(credentials) {
  const email = nonempty(credentials?.email).toLowerCase();
  const subject = nonempty(credentials?.accountId) || nonempty(credentials?.account_id) || nonempty(credentials?.sub);
  const refresh = nonempty(credentials?.refresh) || nonempty(credentials?.refreshToken) || nonempty(credentials?.refresh_token);
  return {
    email,
    subjectHash: subject ? digest(`google-subject:${subject}`) : "",
    // This token-derived digest is internal and is never returned by list().
    refreshHash: refresh ? digest(`google-refresh:${refresh}`) : "",
  };
}

function matches(account, identity) {
  return Boolean(
    (identity.email && account.email === identity.email) ||
    (identity.subjectHash && account.identity.subjectHash === identity.subjectHash) ||
    (identity.refreshHash && account.identity.refreshHash === identity.refreshHash),
  );
}

function labelValue(label) {
  if (typeof label !== "string" || !label.trim() || label.trim().length > 128) {
    throw error("ACCOUNT_POOL_LABEL", "Account label must contain 1 to 128 characters.");
  }
  return label.trim();
}

function validateState(state) {
  let valid = record(state) && state.version === VERSION && Array.isArray(state.accounts) &&
    (state.activeAccountId === null || typeof state.activeAccountId === "string");
  const ids = new Set();
  if (valid) {
    for (const account of state.accounts) {
      if (!record(account) || typeof account.id !== "string" || !account.id || ids.has(account.id) ||
          typeof account.label !== "string" || !account.label || account.label.length > 128 ||
          typeof account.email !== "string" || account.email !== account.email.trim().toLowerCase() ||
          !record(account.identity) ||
          typeof account.identity.subjectHash !== "string" || typeof account.identity.refreshHash !== "string" ||
          !/^(?:[a-f0-9]{64})?$/.test(account.identity.subjectHash) ||
          !/^(?:[a-f0-9]{64})?$/.test(account.identity.refreshHash) ||
          !Number.isSafeInteger(account.revision) || account.revision < 1 ||
          !(account.credentials === null || record(account.credentials))) {
        valid = false;
        break;
      }
      const identity = identityOf(account.credentials);
      if ((identity.email && identity.email !== account.email) ||
          (identity.subjectHash && identity.subjectHash !== account.identity.subjectHash) ||
          (identity.refreshHash && identity.refreshHash !== account.identity.refreshHash) ||
          state.accounts.some((other) => record(other) && ids.has(other.id) && matches(other, { email: account.email, ...account.identity }))) {
        valid = false;
        break;
      }
      ids.add(account.id);
    }
    if (state.activeAccountId !== null && !ids.has(state.activeAccountId)) valid = false;
  }
  if (!valid) {
    throw error("ACCOUNT_POOL_CORRUPT", "Local account pool is invalid. Preserve it and restore a valid backup before continuing.");
  }
  return state;
}

function requireAccount(state, id) {
  const account = state.accounts.find((item) => item.id === id);
  if (!account) throw error("ACCOUNT_POOL_NOT_FOUND", "Account no longer exists. Select an existing account or add it again.");
  return account;
}

function applyCredentials(state, account, incoming) {
  const credentials = { ...(account.credentials || {}), ...incoming };
  const identity = identityOf(credentials);
  const oldSubject = account.identity.subjectHash;
  if (oldSubject && identity.subjectHash && oldSubject !== identity.subjectHash) {
    throw error("ACCOUNT_POOL_IDENTITY", "Credentials belong to a different account. Add them separately.");
  }
  // A verified subject may keep its account when the Google email is renamed.
  if (account.email && identity.email && account.email !== identity.email &&
      !(oldSubject && oldSubject === identity.subjectHash)) {
    throw error("ACCOUNT_POOL_IDENTITY", "Credentials belong to a different account. Add them separately.");
  }
  if (state.accounts.some((other) => other.id !== account.id && matches(other, identity))) {
    throw error("ACCOUNT_POOL_IDENTITY", "Credentials already belong to another account.");
  }
  account.credentials = credentialsCopy(credentials);
  account.email = identity.email || account.email;
  account.identity = {
    subjectHash: identity.subjectHash || oldSubject,
    refreshHash: identity.refreshHash || account.identity.refreshHash,
  };
  account.revision += 1;
}

function newAccount(credentials, label, index) {
  const identity = identityOf(credentials);
  if (!identity.email && !identity.subjectHash && !identity.refreshHash) {
    throw error("ACCOUNT_POOL_IDENTITY", "Credentials need an email, account ID, or refresh token to identify the account.");
  }
  return {
    // Opaque IDs avoid exposing even a token-derived identity hash. Re-adding a
    // removed account gets a new ID, so old in-flight stores cannot resurrect it.
    id: `acct_${randomUUID()}`,
    label: label ?? (identity.email || `Account ${index + 1}`),
    email: identity.email,
    identity: { subjectHash: identity.subjectHash, refreshHash: identity.refreshHash },
    credentials: credentialsCopy(credentials),
    revision: 1,
  };
}

export class LocalAccountPool {
  #file;
  #legacyStore;

  constructor(file, legacyStore) {
    if (typeof file !== "string" || !file) throw new TypeError("An account pool file path is required.");
    this.#file = resolve(file);
    this.#legacyStore = legacyStore;
  }

  async #save(state) {
    validateState(state);
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.tmp-${process.pid}-${randomUUID()}`;
    // Verify the exact absolute temporary target before rename or cleanup.
    const verifyTemporary = () => {
      if (resolve(temporary) !== temporary || dirname(temporary) !== dirname(this.#file) ||
          !temporary.startsWith(`${this.#file}.tmp-`)) {
        throw error("ACCOUNT_POOL_PATH", "Invalid temporary account pool path.");
      }
    };
    let handle;
    let created = false;
    try {
      handle = await open(temporary, "wx", 0o600);
      created = true;
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      verifyTemporary();
      await rename(temporary, this.#file);
      created = false;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (created) {
        verifyTemporary();
        await unlink(temporary).catch((cause) => {
          if (cause?.code !== "ENOENT") throw cause;
        });
      }
    }
  }

  async #load() {
    try {
      const info = await lstat(this.#file);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw error("ACCOUNT_POOL_CORRUPT", "Local account pool must be a regular file, not a symbolic link.");
      }
      const text = await readFile(this.#file, "utf8");
      let parsed;
      try { parsed = JSON.parse(text); } catch {
        throw error("ACCOUNT_POOL_CORRUPT", "Local account pool is invalid. Preserve it and restore a valid backup before continuing.");
      }
      return validateState(parsed);
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
    }
    const state = { version: VERSION, activeAccountId: null, accounts: [] };
    const legacy = await this.#legacyStore?.read();
    if (legacy !== undefined && legacy !== null) {
      const credentials = credentialsCopy(legacy);
      const account = newAccount(credentials, undefined, 0);
      state.accounts.push(account);
      state.activeAccountId = account.id;
    }
    // Creating even an empty pool is the migration marker. Never delete or write
    // the injected legacy store, including when all pooled accounts are removed.
    await this.#save(state);
    return state;
  }

  #locked(fn) {
    return serialize(pathLocks, this.#file, async () => fn(await this.#load()));
  }

  async ensureMigrated() {
    await this.#locked(() => {});
  }

  async list() {
    return this.#locked((state) => ({
      activeAccountId: state.activeAccountId,
      accounts: state.accounts.map((account) => ({
        id: account.id,
        label: account.label,
        email: account.email,
        active: account.id === state.activeAccountId,
        hasCredential: account.credentials !== null,
      })),
    }));
  }

  async upsert(credentials, { select = true, label } = {}) {
    const incoming = credentialsCopy(credentials);
    if (typeof select !== "boolean") throw new TypeError("select must be a boolean.");
    const normalizedLabel = label === undefined ? undefined : labelValue(label);
    return this.#locked(async (state) => {
      const identity = identityOf(incoming);
      const candidates = state.accounts.filter((account) => matches(account, identity));
      if (candidates.length > 1) throw error("ACCOUNT_POOL_IDENTITY", "Credential identity conflicts with existing accounts.");
      let account = candidates[0];
      if (account) {
        applyCredentials(state, account, incoming);
        if (normalizedLabel !== undefined) account.label = normalizedLabel;
      } else {
        account = newAccount(incoming, normalizedLabel, state.accounts.length);
        state.accounts.push(account);
      }
      if (select) state.activeAccountId = account.id;
      await this.#save(state);
      return account.id;
    });
  }

  async select(id) {
    await this.#locked(async (state) => {
      requireAccount(state, id);
      state.activeAccountId = id;
      await this.#save(state);
    });
  }

  async remove(id) {
    await this.#locked(async (state) => {
      requireAccount(state, id);
      state.accounts = state.accounts.filter((account) => account.id !== id);
      if (state.activeAccountId === id) state.activeAccountId = null;
      await this.#save(state);
    });
  }

  async rename(id, label) {
    const normalizedLabel = labelValue(label);
    await this.#locked(async (state) => {
      requireAccount(state, id).label = normalizedLabel;
      await this.#save(state);
    });
  }

  storeFor(id) {
    if (typeof id !== "string" || !id) throw new TypeError("An account ID is required.");
    const pool = this;
    const key = `${this.#file}\0${id}`;
    return Object.freeze({
      accountId: id,
      async read() {
        return pool.#locked((state) => {
          const account = state.accounts.find((item) => item.id === id);
          return clone(account?.credentials ?? undefined);
        });
      },
      async write(credentials) {
        const incoming = credentialsCopy(credentials);
        return serialize(accountLocks, key, () => pool.#locked(async (state) => {
          applyCredentials(state, requireAccount(state, id), incoming);
          await pool.#save(state);
        }));
      },
      async delete() {
        return serialize(accountLocks, key, () => pool.#locked(async (state) => {
          const account = requireAccount(state, id);
          account.credentials = null;
          account.revision += 1;
          await pool.#save(state);
        }));
      },
      async modify(fn) {
        if (typeof fn !== "function") throw new TypeError("modify requires a function.");
        return serialize(accountLocks, key, async () => {
          const snapshot = await pool.#locked((state) => {
            const account = requireAccount(state, id);
            return { credentials: clone(account.credentials ?? undefined), revision: account.revision };
          });
          // OAuth refresh can wait here without blocking manual selection of a
          // different account. Only this fixed account's modifications serialize.
          const updated = await fn(clone(snapshot.credentials));
          if (updated === undefined) return clone(snapshot.credentials);
          const incoming = credentialsCopy(updated);
          return pool.#locked(async (state) => {
            const account = requireAccount(state, id);
            if (account.revision !== snapshot.revision) {
              throw error("ACCOUNT_POOL_STALE_WRITE", "Account credentials changed while updating. Retry using the current account credentials.");
            }
            applyCredentials(state, account, incoming);
            await pool.#save(state);
            return clone(account.credentials);
          });
        });
      },
    });
  }

  async captureActiveStore() {
    return this.#locked((state) => state.activeAccountId === null ? null : this.storeFor(state.activeAccountId));
  }
}
