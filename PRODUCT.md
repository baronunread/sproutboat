# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers building simple services and handlers.

## Product Purpose

Sproutboat is a proof of concept for compiling small JavaScript HTTP services into native binaries and hosting them on a VPS. Its success is making this workflow straightforward and inexpensive for developers.

## Positioning

Sproutboat turns small JavaScript services into locally compiled native artifacts, then deploys and runs those isolated artifacts on a provider-neutral VPS setup.

## Operating Context

Developers use the CLI to initialize, compile, authorize, deploy, inspect versions, tail logs, roll back, and delete projects. The web dashboard supports GitHub sign-in, namespace reservation, and CLI authorization.

## Capabilities and Constraints

- This is an early proof of concept intended for VPS hosting, not broad public adoption.
- Artifacts are compiled locally for Linux/amd64 and deployed as immutable units.
- The control API is artifact-only; the edge runtime is isolated.
- The platform is built with Bun, React, Vite, and TypeScript.

## Brand Commitments

Sproutboat is presented as a practical developer tool: simple, inexpensive, and direct. No broader brand or audience commitments are confirmed yet.

## Evidence on Hand

- The repository includes a working local end-to-end stack, CLI, control API, edge runtime, and React dashboard.
- No customer proof, production scale metrics, pricing, testimonials, or public adoption claims are available; future work must not fabricate them.

## Product Principles

- Make deployment of small services legible from source to running artifact.
- Favor a low-cost, provider-neutral VPS path.
- Keep immutable artifacts and operational actions explicit.
- Treat the current experience as a focused POC rather than a promise of broad platform maturity.
