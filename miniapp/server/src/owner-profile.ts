/** Per-install personalization. Never embed a real owner's identity in shared source. */
import fs from 'node:fs';
import path from 'node:path';
import { defaultAsideRoot } from './config.js';
export interface OwnerProfile {
  privacyConfigured: boolean;
  shareProfileWithModels: boolean;
  displayName: string;
  schoolLabel: string;
  graduationYear: number | null;
  familyNames: string[];
  staffDomains: string[];
  studentDomains: string[];
  privateAppIds: string[];
}
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length <= 160).slice(0, 100) : [];
const domains = (v: unknown) => strings(v).map(s => s.trim().toLowerCase()).filter(s => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(s));
const text = (v: unknown) => typeof v === 'string' ? v.replace(/[\r\n\x00-\x1f]/g, ' ').trim().slice(0, 160) : '';
export function readOwnerProfile(): OwnerProfile {
  let value: Partial<OwnerProfile> = {};
  try { value = JSON.parse(fs.readFileSync(process.env.MINIAPP_OWNER_PROFILE_PATH || path.join(defaultAsideRoot(), 'owner-profile.json'), 'utf8')); } catch { /* Missing is a generic install, never another person's profile. */ }
  const privacyConfigured = Boolean(value && !Array.isArray(value) && Array.isArray(value.familyNames) && Array.isArray(value.privateAppIds));
  return { privacyConfigured, shareProfileWithModels: value?.shareProfileWithModels === true, displayName: text(value?.displayName), schoolLabel: text(value?.schoolLabel), graduationYear: Number.isInteger(value?.graduationYear) && Number(value.graduationYear) >= 2000 && Number(value.graduationYear) <= 2200 ? Number(value.graduationYear) : null,
    familyNames: strings(value?.familyNames), staffDomains: domains(value?.staffDomains), studentDomains: domains(value?.studentDomains), privateAppIds: strings(value?.privateAppIds) };
}
