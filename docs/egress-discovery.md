# Production egress discovery – IP-001

This document implements the discovery step from the Design Reviewer plan for **DR-001 / RS-01 / IP-001**.

The purpose is to determine the real production network boundary before changing application code or Docker networking. The application already has URL/DNS validation, a validating HTTP/CONNECT proxy and Playwright request interception. IP-001 checks what network access still exists if those application-level controls are not part of the path.

## Scope

The discovery must be run in the actual Coolify deployment environment, or in an equivalent container attached to exactly the same Docker networks.

Repository inspection alone can establish that `docker-compose.coolify.yml` joins the external `coolify` network, but it cannot establish host firewall rules, Coolify-generated networking or other controls outside the repository.

Do not treat this discovery as a penetration test or network scan. Probe only destinations you own and explicitly name.

## What to record

Record:

- container user and effective runtime identity;
- Docker networks attached to the Browser Screenshot container;
- default route and resolver configuration;
- whether public HTTPS is reachable;
- whether the configured PostgreSQL host resolves and is reachable;
- whether explicitly selected internal/private destinations resolve and are reachable;
- any host-level nftables/iptables/firewall rules that apply to Docker egress;
- whether the deployment already has a control that remains effective if Chromium bypasses the Node validating proxy.

The key design question is:

> Can the Browser Screenshot workload reach unrelated private/internal services directly if the application-level proxy and Playwright interception are bypassed?

## Helper script

Inside the deployed application container run:

```bash
./scripts/inspect-egress.sh
```

The script reports:

- identity;
- routing;
- resolver configuration;
- a public HTTPS probe;
- PostgreSQL connectivity when `DB_HOST` is configured.

It intentionally does **not** scan networks.

For explicit internal destinations, supply only known hostnames or addresses:

```bash
EGRESS_DISCOVERY_INTERNAL_TARGETS="postgres:5432,traefik:80,10.0.0.1:80" \
  ./scripts/inspect-egress.sh
```

Use targets that are safe to probe in your own environment. A successful TCP connection means the container has network reachability to that destination; it does not imply authentication succeeded.

You can change the public target if needed:

```bash
EGRESS_DISCOVERY_PUBLIC_TARGET=https://example.org \
  ./scripts/inspect-egress.sh
```

## Host-side inspection

The container view is not sufficient to identify enforcement that lives on the host. On the Coolify host, record the Browser Screenshot container networks and relevant firewall state using the tools available on that host.

Typical Docker inspection:

```bash
docker inspect <browser-screenshot-container>
docker network inspect coolify
```

If the host uses nftables or iptables, inspect the active rules rather than assuming Docker defaults constitute an egress policy.

Do not change firewall rules during IP-001. This step is discovery only.

## Expected interpretation

### Outcome A – external enforcement already exists

IP-001 can conclude that DR-001 is largely an evidence/documentation gap if all of the following are true:

- public web targets required by Browser Screenshot remain reachable;
- PostgreSQL remains reachable only through the intended application path;
- unrelated private/internal destinations are blocked by a layer outside Browser Screenshot;
- the blocking layer remains effective even when the application validating proxy is bypassed.

Proceed to IP-004-style reproducible evidence after documenting the mechanism. IP-002/IP-003 may be minimal.

### Outcome B – private/internal services are directly reachable

DR-001 remains an implementation gap.

Proceed to IP-002 and define the desired egress policy before changing Compose, Docker networks or host firewall rules.

### Outcome C – result is ambiguous

Do not mark production egress as PASS.

Document what could and could not be verified, then continue IP-001 in the real deployment environment.

## IP-001 evidence template

Record the following in operational release evidence or an equivalent controlled location:

```text
Browser Screenshot IP-001 egress discovery
Date:
Deployment:
Image tag/digest:
Container:
Attached networks:
Default route:
DNS resolver:

Public HTTPS reachable: PASS/FAIL
PostgreSQL reachable: PASS/FAIL

Explicit internal probes:
- <target>: REACHABLE/BLOCKED
- <target>: REACHABLE/BLOCKED

External enforcement layer:
- none / nftables / iptables / platform policy / other

Can unrelated private/internal services be reached while bypassing app-level URL/proxy validation?
- YES / NO / UNKNOWN

Conclusion:
- DR-001 externally satisfied
- DR-001 implementation required
- insufficient evidence
```

## Exit criteria for IP-001

IP-001 is complete only when the actual deployment can answer all of these:

1. Which networks can the application container reach?
2. Which private/internal destinations are reachable?
3. Is blocking enforced outside the Chromium/Node application process?
4. Can the Node application still reach PostgreSQL and GitHub while the browser is constrained?
5. Does the current deployment already satisfy the architecture's final egress-boundary requirement?

No application security code should be weakened based on a positive result. The validating proxy, Playwright routing and URL/DNS checks remain defense in depth.
