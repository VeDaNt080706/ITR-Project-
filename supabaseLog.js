/* -------------------------------------------------
   daemon.js  –  background code that runs on each laptop.
   Replaces supabaseLog.js.

   Imports the ONE shared Supabase client – never
   calls createClient() itself.
   ------------------------------------------------- */
import { getSupabaseClient } from './src/supabaseClient.js';   // ← singleton client

let storedUserUuid = null;   // cached UUID for the signed‑in employee

/**
 * Run once after the employee signs in (or on daemon start‑up).
 * Fetches the JWT `sub` (the auth.users id) and caches it for the
 * lifetime of the process – no extra network round‑trips after that.
 */
export async function ensureUserUuid() {
  if (storedUserUuid) return storedUserUuid;   // already cached

  const supa = getSupabaseClient();
  if (!supa) throw new Error('Supabase client is not configured (missing URL / anon key).');

  const { data: { user }, error } = await supa.auth.getUser();
  if (error || !user) throw new Error(error?.message || 'User not signed in – daemon cannot start');

  storedUserUuid = user.id;   // this is the FK used by RLS policies
  return storedUserUuid;
}

/** Expose the cached UUID for read-only use in other modules. */
export function getStoredUserUuid() {
  return storedUserUuid;
}

/**
 * Insert a single activity event into the *already‑existing* table
 * employee_activity_logs.  The RLS policy `users_insert_own`
 * (WITH CHECK (auth.uid() = user_id)) will automatically accept the row
 * because we supply the correct user_id.
 *
 * @param {Object} ev – shape given by the OS‑hook code
 *   ev.action          – text, e.g. "pen_drive_insert", "file_moved", "pen_drive_eject"
 *   ev.details         – plain JS object; stored as jsonb column
 *     – may contain: file_path, pen_drive_serial, source_path, dest_path, …
 *   ev.device_id       – optional laptop hardware identifier (string)
 *   ev.pen_drive_id    – optional internal pen‑drive registry id (string)
 */
export async function logActivity(ev) {
  // 1️⃣ Guarantee we have a user UUID (throws if not signed in)
  await ensureUserUuid();

  const supa = getSupabaseClient();
  if (!supa) throw new Error('Supabase client not initialized');

  // 2️⃣ Build payload matching the exact columns of employee_activity_logs
  const action       = ev.action || ev.type || 'unknown_event';
  const sourcePath   = ev.source_path || ev.details?.source_path || ev.source || null;
  const destPath     = ev.dest_path   || ev.details?.dest_path   || ev.destination || ev.file || null;

  const payload = {
    user_id:        storedUserUuid,                          // FK to auth.users – required by RLS
    action:         action,
    details:        ev.details !== undefined ? ev.details : ev,  // jsonb – client auto‑stringifies
    device_id:      ev.device_id    || null,
    pen_drive_id:   ev.pen_drive_id || null,
    source_path:    sourcePath,
    dest_path:      destPath,
    admin_notified: false                                    // toggled later by a trigger / cron
    // timestamp omitted – Supabase sets DEFAULT now()
  };

  // 3️⃣ Insert – the RLS policy `users_insert_own` will accept/reject automatically
  const { data, error } = await supa
    .from('employee_activity_logs')
    .insert([payload]);

  if (error) {
    console.error('❌ Supabase log insert failed', error);
    // optional: add exponential‑back‑off retry here
    throw error;
  } else {
    console.log('✅ Log saved –', action);
    return data;
  }
}

/* -----------------------------------------------------------------
   Example – call this right after the OS hook detects an event.
   (Replace the object fields with the real data your monitor captures.)
------------------------------------------------------------------- */
//
// // After a USB‑insert:
// const usbEv = {
//   action:       'pen_drive_insert',
//   details: {
//     deviceId:       'USB\\VID_058F\\PID_6387\\...',
//     penDriveSerial: 'SN1234',
//     sourcePath:     null,
//     destPath:       'D:\\'
//   },
//   device_id:    'LAPTOP-ABC123',
//   pen_drive_id: null
// };
// await logActivity(usbEv);
//
// // After a file‑move to a removable drive:
// const fileEv = {
//   action:       'file_moved',
//   details: {
//     file_path: 'C:\\Reports\\budget.xlsx',
//     dest_path: 'E:\\'
//   },
//   device_id:    'LAPTOP-ABC123',
//   pen_drive_id: 'PN-7742'
// };
// await logActivity(fileEv);

/* -----------------------------------------------------------------
   Reminders (do NOT do these things)
   -----------------------------------------------------------------
   • Do NOT run CREATE TABLE / ALTER TABLE – the table and RLS policies
     already exist in your Supabase project (see All the SQL queries.sql).
   • Do NOT modify the existing RLS policies (`users_insert_own`,
     `users_select_own`). Changing them will break per‑user isolation.
   • Do NOT use the `service_role` key for daemon inserts.
     The anon key + `WITH CHECK (auth.uid() = user_id)` policy is the
     intended mechanism; the service key bypasses RLS entirely.
   • Do NOT forget to call `ensureUserUuid()` before the first
     `logActivity()` call – without a valid storedUserUuid the insert
     will be rejected by the policy.
   • Do NOT create a new Supabase client in each file.
     Always import from `./src/supabaseClient.js`.
   ----------------------------------------------------------------- */
