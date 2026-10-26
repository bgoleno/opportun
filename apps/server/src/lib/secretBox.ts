// Secrets vault (NFR-SEC4, FR-A3): AES-256-GCM under the instance master key. Plaintext
// leaves this module only through getSecretValue, whose callers are provider adapters.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { newId } from '@opportun/core';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { SECRET_KINDS, secrets } from '../db/schema';
import type { Exec, UserCtx } from '../repos/base';
import { notFound } from './errors';

export type SecretKind = (typeof SECRET_KINDS)[number];

export interface Sealed {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

/** Metadata safe to return to clients: never the value or its ciphertext. */
export interface SecretMeta {
  id: string;
  kind: SecretKind;
  label: string;
  /** User-entered display name; the label stays the provider id for ai_api_key. */
  displayName: string | null;
  /** User-entered expiry (epoch ms); no provider exposes one to the key itself. */
  expiresAt: number | null;
  createdAt: number;
}

/** The user-editable metadata of a secret (never its value, kind or label). */
export interface SecretMetaPatch {
  displayName?: string | null;
  expiresAt?: number | null;
}

const META_COLUMNS = {
  id: secrets.id,
  kind: secrets.kind,
  label: secrets.label,
  displayName: secrets.displayName,
  expiresAt: secrets.expiresAt,
  createdAt: secrets.createdAt,
};

const ALGORITHM = 'aes-256-gcm';
const KEY_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function checkKey(masterKey: Buffer): void {
  if (masterKey.length !== 32) throw new Error('secretBox: master key must be 32 bytes');
}

export function seal(masterKey: Buffer, plaintext: string): Sealed {
  checkKey(masterKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyVersion: KEY_VERSION,
  };
}

/** Decrypts and authenticates; throws on any tampering, wrong key or unknown key version. */
export function open(masterKey: Buffer, sealed: Sealed): string {
  checkKey(masterKey);
  if (sealed.keyVersion !== KEY_VERSION) {
    throw new Error(`secretBox: unsupported key version ${sealed.keyVersion}`);
  }
  const iv = Buffer.from(sealed.iv, 'base64');
  const tag = Buffer.from(sealed.tag, 'base64');
  // A short tag would be accepted by GCM and weaken authentication: require the full 16 bytes.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('secretBox: malformed iv or tag');
  }
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

// The master key is bound to the database handle at boot (buildApp), so repo helpers keep
// the (db, ctx, ...) shape and several apps with different keys can coexist in one process.
const vaultKeys = new WeakMap<Db, Buffer>();

export function bindVaultKey(db: Db, masterKey: Buffer): void {
  checkKey(masterKey);
  vaultKeys.set(db, masterKey);
}

function keyFor(db: Db): Buffer {
  const key = vaultKeys.get(db);
  if (key === undefined) throw new Error('secretBox: no master key bound to this database');
  return key;
}

/**
 * Seals `plaintext` under this database's vault key for storage in a column of its own
 * (e.g. users.totp_secret), as the JSON of a Sealed envelope. Same key and cipher as the
 * secrets table; the plaintext never touches the database.
 */
export function encryptSecret(db: Db, plaintext: string): string {
  return JSON.stringify(seal(keyFor(db), plaintext));
}

/** Inverse of encryptSecret; throws on tampering, a wrong key or a malformed envelope. */
export function decryptSecret(db: Db, stored: string): string {
  const parsed = JSON.parse(stored) as Partial<Sealed>;
  if (
    typeof parsed.ciphertext !== 'string' ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.tag !== 'string' ||
    typeof parsed.keyVersion !== 'number'
  ) {
    throw new Error('secretBox: malformed sealed value');
  }
  return open(keyFor(db), parsed as Sealed);
}

export async function putSecret(
  db: Db,
  ctx: UserCtx,
  kind: SecretKind,
  label: string,
  value: string,
  meta: SecretMetaPatch = {},
): Promise<{ id: string }> {
  return await putSecretIn(db, db, ctx, kind, label, value, meta);
}

/**
 * putSecret inside an open transaction: `db` supplies the vault key, `exec` (the
 * transaction) does the write, so the secret commits or rolls back with the rest.
 */
export async function putSecretIn(
  exec: Exec,
  db: Db,
  ctx: UserCtx,
  kind: SecretKind,
  label: string,
  value: string,
  meta: SecretMetaPatch = {},
): Promise<{ id: string }> {
  const { id, row } = sealedRow(db, ctx, kind, label, value, meta);
  await exec.insert(secrets).values(row).run();
  return { id };
}

function sealedRow(
  db: Db,
  ctx: UserCtx,
  kind: SecretKind,
  label: string,
  value: string,
  meta: SecretMetaPatch,
) {
  const sealed = seal(keyFor(db), value);
  const id = newId();
  const now = Date.now();
  return {
    id,
    row: {
      id,
      userId: ctx.userId,
      kind,
      label,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      tag: sealed.tag,
      keyVersion: sealed.keyVersion,
      displayName: meta.displayName ?? null,
      expiresAt: meta.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** Plaintext of the caller's own secret; 404 HttpError when it is missing or not theirs. */
export async function getSecretValue(db: Db, ctx: UserCtx, id: string): Promise<string> {
  return await getSecretValueIn(db, db, ctx, id);
}

/** getSecretValue inside an open transaction: `exec` reads, `db` supplies the vault key. */
export async function getSecretValueIn(
  exec: Exec,
  db: Db,
  ctx: UserCtx,
  id: string,
): Promise<string> {
  const row = await exec
    .select({
      ciphertext: secrets.ciphertext,
      iv: secrets.iv,
      tag: secrets.tag,
      keyVersion: secrets.keyVersion,
    })
    .from(secrets)
    .where(and(eq(secrets.id, id), eq(secrets.userId, ctx.userId)))
    .get();
  if (row === undefined) throw notFound();
  return open(keyFor(db), row);
}

export async function getSecretMeta(db: Db, ctx: UserCtx, id: string): Promise<SecretMeta> {
  const row = await db
    .select(META_COLUMNS)
    .from(secrets)
    .where(and(eq(secrets.id, id), eq(secrets.userId, ctx.userId)))
    .get();
  if (row === undefined) throw notFound();
  return row;
}

export async function listSecrets(db: Db, ctx: UserCtx): Promise<SecretMeta[]> {
  return await db
    .select(META_COLUMNS)
    .from(secrets)
    .where(eq(secrets.userId, ctx.userId))
    .orderBy(desc(secrets.createdAt), desc(secrets.id))
    .all();
}

/** Deletes the caller's own secret; 404 HttpError when it is missing or not theirs. */
export async function deleteSecret(db: Db, ctx: UserCtx, id: string): Promise<SecretMeta> {
  const row = await db
    .delete(secrets)
    .where(and(eq(secrets.id, id), eq(secrets.userId, ctx.userId)))
    .returning(META_COLUMNS)
    .get();
  if (row === undefined) throw notFound();
  return row;
}

/** Updates only the display name and expiry of the caller's own secret; 404 otherwise. */
export async function updateSecretMeta(
  db: Db,
  ctx: UserCtx,
  id: string,
  patch: SecretMetaPatch,
): Promise<SecretMeta> {
  const set: { displayName?: string | null; expiresAt?: number | null; updatedAt: number } = {
    updatedAt: Date.now(),
  };
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
  const row = await db
    .update(secrets)
    .set(set)
    .where(and(eq(secrets.id, id), eq(secrets.userId, ctx.userId)))
    .returning(META_COLUMNS)
    .get();
  if (row === undefined) throw notFound();
  return row;
}
