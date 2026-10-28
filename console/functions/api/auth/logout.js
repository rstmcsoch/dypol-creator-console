import { json, CLEAR_COOKIE } from '../_lib/util.js';

export async function onRequestPost() {
  return json(null, 200, { ok: true }, { 'Set-Cookie': CLEAR_COOKIE });
}
