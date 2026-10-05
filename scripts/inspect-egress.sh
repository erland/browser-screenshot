#!/usr/bin/env bash
set -euo pipefail

# IP-001 production egress discovery helper.
#
# Run inside the deployed Browser Screenshot container (or an equivalent
# container attached to the same networks). It deliberately does not scan
# address ranges. Optional explicit internal targets can be supplied through
# EGRESS_DISCOVERY_INTERNAL_TARGETS as a comma-separated list of host[:port].
#
# Example:
#   EGRESS_DISCOVERY_INTERNAL_TARGETS="postgres:5432,traefik:80,10.0.0.1:80" \
#     ./scripts/inspect-egress.sh

public_target="${EGRESS_DISCOVERY_PUBLIC_TARGET:-https://example.com}"
internal_targets="${EGRESS_DISCOVERY_INTERNAL_TARGETS:-}"

echo "== Browser Screenshot egress discovery =="
echo "Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo

echo "-- Identity --"
id || true
echo

echo "-- Routing --"
if command -v ip >/dev/null 2>&1; then
  ip route || true
else
  echo "ip command not available"
fi
echo

echo "-- Resolver configuration --"
cat /etc/resolv.conf 2>/dev/null || true
echo

echo "-- Public HTTPS reachability --"
node -e '
const target = process.argv[1];
const started = Date.now();
fetch(target, { redirect: "manual", signal: AbortSignal.timeout(10000) })
  .then(r => {
    console.log(JSON.stringify({ target, reachable: true, status: r.status, durationMs: Date.now() - started }));
  })
  .catch(err => {
    console.log(JSON.stringify({ target, reachable: false, error: err.name, durationMs: Date.now() - started }));
    process.exitCode = 1;
  });
' "$public_target"
echo

echo "-- Required application destinations --"
node - <<'NODE'
import dns from 'node:dns/promises';
import net from 'node:net';

const checks = [];
const dbHost = process.env.DB_HOST;
const dbPort = Number(process.env.DB_PORT || 5432);
if (dbHost) checks.push({ name: 'postgres', host: dbHost, port: dbPort });

for (const check of checks) {
  let addresses = [];
  try {
    addresses = (await dns.lookup(check.host, { all: true, verbatim: true })).map(r => r.address);
  } catch (error) {
    console.log(JSON.stringify({ ...check, resolved: false, error: error?.code || error?.name || 'error' }));
    continue;
  }

  const connected = await new Promise(resolve => {
    const socket = net.connect({ host: check.host, port: check.port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  console.log(JSON.stringify({ ...check, resolved: true, addresses, reachable: connected }));
}
NODE
echo

if [[ -n "$internal_targets" ]]; then
  echo "-- Explicit internal/private reachability probes --"
  EGRESS_DISCOVERY_INTERNAL_TARGETS="$internal_targets" node - <<'NODE'
import dns from 'node:dns/promises';
import net from 'node:net';

const raw = process.env.EGRESS_DISCOVERY_INTERNAL_TARGETS || '';
for (const entry of raw.split(',').map(v => v.trim()).filter(Boolean)) {
  const match = entry.match(/^\[([^\]]+)\](?::(\d+))?$|^([^:]+)(?::(\d+))?$/);
  if (!match) {
    console.log(JSON.stringify({ target: entry, valid: false }));
    continue;
  }
  const host = match[1] || match[3];
  const port = Number(match[2] || match[4] || 80);

  let addresses = [];
  try {
    addresses = (await dns.lookup(host, { all: true, verbatim: true })).map(r => r.address);
  } catch (error) {
    console.log(JSON.stringify({ target: entry, host, port, resolved: false, error: error?.code || error?.name || 'error' }));
    continue;
  }

  const reachable = await new Promise(resolve => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  console.log(JSON.stringify({ target: entry, host, port, resolved: true, addresses, reachable }));
}
NODE
  echo
else
  echo "-- Explicit internal/private reachability probes --"
  echo "Skipped: set EGRESS_DISCOVERY_INTERNAL_TARGETS to explicit host[:port] values."
  echo
fi

echo "Discovery complete. Interpret results using docs/egress-discovery.md."
