// Stage 2 — identity resolver. Exact identifiers only (case-insensitive email, email hash, user_id, phone digits):
// lookalikes such as g.silva76.jr@gmail.com never match g.silva76@gmail.com.
import { createHash } from "node:crypto";
import type { AuditRow, Identity } from "./load.ts";

export interface Person { userId: string; name: string; emails: Set<string>; hashes: Set<string>; phones: Set<string> }
export const normEmail = (e: string) => e.trim().toLowerCase();
export const phoneKey = (p: string) => p.replace(/\D/g, "");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class IdentityResolver {
  readonly people = new Map<string, Person>();
  private byKey = new Map<string, string>();

  constructor(identities: Identity[], audit: AuditRow[]) {
    for (const i of identities)
      this.people.set(i.user_id, { userId: i.user_id, name: i.name, emails: new Set([normEmail(i.email)]), hashes: new Set([i.email_hash.toLowerCase()]), phones: new Set([phoneKey(i.phone)]) });
    for (const a of audit) {
      const p = this.people.get(a.user_id);
      if (!p) continue;
      const vals = [a.old_value, a.new_value].filter(Boolean);
      if (a.field_name === "email") vals.forEach((v) => { p.emails.add(normEmail(v)); p.hashes.add(sha256(normEmail(v))); });
      if (a.field_name === "email_hash") vals.forEach((v) => p.hashes.add(v.toLowerCase()));
      if (a.field_name === "phone") vals.forEach((v) => p.phones.add(phoneKey(v)));
    }
    for (const p of this.people.values()) {
      this.byKey.set(p.userId, p.userId);
      for (const k of [...p.emails, ...p.hashes, ...p.phones]) this.byKey.set(k, p.userId);
    }
  }

  /** user_id owning an identifier value, or undefined. Accepts raw field values of any kind. */
  resolve(value: string | null | undefined): string | undefined {
    if (!value) return undefined;
    const v = value.trim();
    if (/^user_\d+$/.test(v)) return this.people.has(v) ? v : undefined;
    if (v.includes("@")) return this.byKey.get(normEmail(v));
    if (/^[0-9a-f]{64}$/i.test(v)) return this.byKey.get(v.toLowerCase());
    if (/^\+?[\d\s().-]{8,}$/.test(v)) return this.byKey.get(phoneKey(v));
    return undefined;
  }
}
