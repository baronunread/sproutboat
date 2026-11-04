//! Sproutboat egress: the token-gated, private-address-blocking service that every
//! outbound `fetch()` and `connect()` of an app goes through. A Rust port of
//! `@sproutboat/wire`'s `egress.ts` (and `tcp.ts`'s tunnel endpoint). The library holds
//! everything; `src/main.rs` is a thin binary, so the service can later run inside the
//! edge process. Contract: `BEHAVIOUR.md`.

pub mod addr;
pub mod http;
pub mod resolve;
pub mod tunnel;
pub mod upstream;

pub use http::{handle, serve, Egress};
