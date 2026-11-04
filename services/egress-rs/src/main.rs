//! `sproutboat-egress --host 127.0.0.1 --port 8070 [--tcp-port 8071]`
//! Environment: `SB_EGRESS_TOKEN` (required), `SB_EGRESS_ALLOW`, `SB_EGRESS_STRICT`, `SB_EGRESS_CONNECT_TIMEOUT_MS`, `PORT`,
//! `SB_CA_BUNDLE`. See BEHAVIOUR.md.

use sproutboat_egress::addr::Allow;
use sproutboat_egress::resolve::default_resolver;
use sproutboat_egress::tunnel::{self, Tunnels};
use sproutboat_egress::{serve, Egress};
use std::sync::Arc;
use tokio::net::TcpListener;

fn arg(args: &[String], name: &str) -> Option<String> {
    let flag = format!("--{name}");
    let eq = format!("--{name}=");
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if *a == flag {
            return it.next().cloned();
        }
        if let Some(v) = a.strip_prefix(&eq) {
            return Some(v.to_string());
        }
    }
    None
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--print-ranges") {
        // The address table, for the differential harness to compare with the TS one.
        println!("{}", serde_json::json!(sproutboat_egress::addr::BLOCKED_RANGES));
        return;
    }
    let token = std::env::var("SB_EGRESS_TOKEN").unwrap_or_default();
    if token.is_empty() {
        eprintln!("sproutboat egress: SB_EGRESS_TOKEN is required");
        std::process::exit(1);
    }
    let host = arg(&args, "host").unwrap_or_else(|| "127.0.0.1".into());
    let port: u16 =
        match arg(&args, "port").or_else(|| std::env::var("PORT").ok().filter(|s| !s.is_empty())) {
            Some(p) => p.parse().unwrap_or_else(|_| {
                eprintln!("sproutboat egress: invalid port {p}");
                std::process::exit(1)
            }),
            None => 8070,
        };
    let tcp_port: u16 = match arg(&args, "tcp-port") {
        Some(p) => p.parse().unwrap_or_else(|_| {
            eprintln!("sproutboat egress: invalid tcp port {p}");
            std::process::exit(1)
        }),
        None => port.wrapping_add(1),
    };
    let allow =
        Allow::parse(std::env::var("SB_EGRESS_ALLOW").ok().as_deref()).unwrap_or_else(|e| {
            eprintln!("sproutboat egress: {e}");
            std::process::exit(1)
        });
    // The whole address table by default; `SB_EGRESS_STRICT=0` limits it to the
    // ranges the Bun service had before the table grew.
    let strict = !matches!(std::env::var("SB_EGRESS_STRICT").as_deref(), Ok("0"));
    let connect_timeout = match std::env::var("SB_EGRESS_CONNECT_TIMEOUT_MS") {
        Ok(v) if !v.trim().is_empty() => match v.trim().parse::<u64>() {
            Ok(ms) if ms > 0 => Some(std::time::Duration::from_millis(ms)),
            _ => {
                eprintln!(
                    "sproutboat egress: invalid SB_EGRESS_CONNECT_TIMEOUT_MS {v:?}: expected a positive number of milliseconds"
                );
                std::process::exit(1)
            }
        },
        _ => None,
    };

    // Two workers by default: the service is a loopback helper next to the edge, and more
    // threads only add cross-thread wake-ups (measured: 1.7x the CPU per request at 4).
    let threads = std::env::var("SB_EGRESS_THREADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(2);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(threads)
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async move {
        let mut egress = Egress::new(&token, allow.clone(), default_resolver()).expect("token");
        egress.strict = strict;
        if let Some(t) = connect_timeout {
            egress.client.connect_timeout = t;
        }
        if let Some(n) = std::env::var("SB_EGRESS_MAX_REQUEST_BYTES")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|n| *n > 0)
        {
            egress.max_request_bytes = n;
        }
        let tls = egress.client.tls.clone();
        let resolver: Arc<dyn sproutboat_egress::resolve::Resolve> = Arc::from(default_resolver());
        let mut tunnels = Tunnels::new(&token, allow, resolver, tls);
        tunnels.strict = strict;
        if let Some(t) = connect_timeout {
            tunnels.connect_timeout = t;
        }
        let tunnels = Arc::new(tunnels);

        let tcp = TcpListener::bind((host.as_str(), tcp_port))
            .await
            .unwrap_or_else(|e| {
                eprintln!("error: Failed to start tunnel listener on {host}:{tcp_port}: {e}");
                std::process::exit(1)
            });
        let http = TcpListener::bind((host.as_str(), port))
            .await
            .unwrap_or_else(|e| {
                eprintln!("error: Failed to start server. Is port {port} in use? ({e})");
                std::process::exit(1)
            });
        let tcp_actual = tcp.local_addr().map(|a| a.port()).unwrap_or(tcp_port);
        println!("sproutboat egress tunnels listening on port {tcp_actual}");
        let actual = http.local_addr().expect("addr");
        let shown = if actual.is_ipv6() {
            format!("[{}]", actual.ip())
        } else {
            actual.ip().to_string()
        };
        println!(
            "sproutboat egress listening on http://{shown}:{}/",
            actual.port()
        );

        tokio::spawn(tunnel::serve(tunnels, tcp));
        tokio::spawn(serve(Arc::new(egress), http));
        wait_for_signal().await;
    });
}

async fn wait_for_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("sigterm");
    let mut int = signal(SignalKind::interrupt()).expect("sigint");
    tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
}
