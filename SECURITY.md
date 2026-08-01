# Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability). Please don't open a public issue for
something that would put users at risk before there's a fix.

I'll acknowledge within a week. This is a one-person project, so I can't
promise a fix window, but I'll tell you what I find and when a release goes
out, and I'll credit you unless you'd rather I didn't.

## What I care about most

Anything where a managed context's request reaches the network without going
through its assigned exit. That is the one property the extension exists to
provide, so a working proof of it is the most valuable thing you can send.
Concretely:

- A path where `decide()` returns `allow` for a managed context whose health
  is not `up`, or where the gate is bypassed entirely.
- Forging or replaying a probe token, or otherwise getting a request routed
  as if it were a health probe.
- Making `proxy.onRequest` return `direct`, or an unusable `ProxyInfo`, for a
  context that has an exit assigned.
- Traffic from one container leaving via another container's exit.
- Any way a web page can reach the extension's message handlers, read stored
  assignments, or change settings.
- A DNS lookup for a relay hostname escaping the tunnel.

Also in scope: the build tooling in `tools/`, since it runs on a machine that
signs releases.

## Out of scope

- The limits documented in the README under "What it does not protect
  against" — the window before a failure is noticed, DoH, requests issued
  before the background page is running, and the extension being disabled.
  Those are known and stated; a report that restates them isn't a finding,
  though a report that makes one of them *worse than documented* is.
- Anything requiring an already-compromised browser profile or physical
  access to an unlocked machine.
- Mullvad's own infrastructure. Report that to Mullvad.

## Verifying a report yourself

You don't need a Mullvad account to exercise the killswitch: assign any
container to an unreachable address in Mullvad's SOCKS range (for example
`10.124.255.254`) and the container's traffic should be blocked within about
ten seconds. `npm run test:e2e` drives that path against a real Firefox.
