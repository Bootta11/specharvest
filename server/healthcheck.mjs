// Docker HEALTHCHECK: exits 0 when /api/health reports ready (DB reachable).
// Targets 127.0.0.1 rather than the 0.0.0.0 bind address. Plain JS so it runs without tsx.
const port = process.env.PORT || 3100;
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
