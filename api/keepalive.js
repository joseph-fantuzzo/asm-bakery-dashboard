// /api/keepalive.js — Daily Supabase keep-alive ping
// Triggered by Vercel Cron once per day to prevent the free-tier 7-day pause.
// Performs a lightweight read against Supabase to register activity.

const SB_URL = process.env.SUPABASE_URL || 'https://ytzpfhjcaesgylodaasw.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async function handler(req, res) {
  if (!SB_KEY) {
    return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_KEY not set' });
  }

  try {
    // Lightweight read — just fetch one row from a small table.
    // 'profiles' always has at least the owner row.
    const r = await fetch(
      `${SB_URL}/rest/v1/profiles?select=id&limit=1`,
      {
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          Accept: 'application/json'
        }
      }
    );

    const ok = r.ok;
    const timestamp = new Date().toISOString();
    console.log(`Keep-alive ping at ${timestamp}: ${ok ? 'OK' : 'FAILED ' + r.status}`);

    return res.status(ok ? 200 : 500).json({
      ok,
      timestamp,
      status: r.status,
      message: ok ? 'Supabase pinged successfully' : 'Ping failed'
    });
  } catch (err) {
    console.error('Keep-alive error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
