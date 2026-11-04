//! Sproutboat edge router (Rust). A one-for-one replacement of services/edge:
//! same environment, same routes.json, same request log. The supervisor pool
//! stays in Bun, behind a lazily started sidecar (see `sidecar.rs`).

mod activation;
mod app;
mod assets;
mod backend;
mod body;
mod cache;
mod config;
mod idle;
mod logs;
mod proxy;
mod reload;
mod routes;
mod server;
mod sidecar;
mod util;
mod websocket;

use app::{read_routes, read_snapshot, App};
use config::Config;
use logs::LogSink;
use routes::Routes;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::signal::unix::{signal, SignalKind};

fn main() {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(error) => {
            eprintln!("could not start the runtime: {error}");
            std::process::exit(1);
        }
    };
    let code = runtime.block_on(run());
    // Do not wait on stray blocking tasks (a reload mid-read) once the edge has drained.
    runtime.shutdown_timeout(Duration::from_secs(1));
    std::process::exit(code);
}

async fn run() -> i32 {
    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    let (routes, loaded) = match initial_routes(&cfg).await {
        Ok(r) => r,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    // Supervisor routes need the Bun sidecar script. Say so now rather than on the first request;
    // it is not fatal because sproutd-only deployments never start it.
    if routes.iter().any(|(_, r)| r.backend.is_none()) {
        if let Err(error) = sidecar::sidecar_script() {
            eprintln!("warning: {error}");
        }
    }
    let log = cfg
        .log_path
        .as_deref()
        .map_or_else(LogSink::disabled, LogSink::open);
    let listener = match TcpListener::bind((cfg.bind_host.as_str(), cfg.port)).await {
        Ok(l) => l,
        Err(error) => {
            eprintln!(
                "Failed to start server. Is port {} in use? ({error})",
                cfg.port
            );
            return 1;
        }
    };
    let port = listener.local_addr().map_or(cfg.port, |a| a.port());
    let bind_host = cfg.bind_host.clone();
    let activation_dir = cfg.activation_dir.clone();
    let app = App::new(cfg, routes, loaded, log);

    // #48 - service bindings are forwarded back through this server, so every broker the
    // sidecar spawns needs our own address. Set before any sprout starts.
    app.sidecar
        .set_edge_url(format!("http://127.0.0.1:{port}/"));

    // Start only active timer-driven routes after the edge can accept broker callbacks.
    app.reconcile_timed();

    println!("Sproutboat edge router listening on http://{bind_host}:{port}");

    let (stop_timers, _) = tokio::sync::watch::channel(false);
    // Deployments update routes.json atomically. HTTP requests and SIGHUP reload it promptly
    // already, but timer-only deployments may have neither, so keep a cheap mtime poll
    // independent of traffic.
    {
        let (app, mut stop) = (app.clone(), stop_timers.subscribe());
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            tick.tick().await;
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        if let Err(error) = app.refresh_routes().await {
                            eprintln!("route snapshot reload failed: {error}");
                        }
                    }
                    _ = stop.changed() => return,
                }
            }
        });
    }
    // #141: control asks for each new version to be started before it is routed. The request
    // is a one-entry route snapshot, so it gets the same validation as routes.json.
    if let Some(dir) = activation_dir {
        let (app, mut stop) = (app.clone(), stop_timers.subscribe());
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let started = app.clone();
                        let result = activation::serve_activations(&dir, move |request| {
                            let app = started.clone();
                            async move { start_candidate(&app, &request).await }
                        })
                        .await;
                        if let Err(error) = result {
                            eprintln!("activation request failed: {error}");
                        }
                    }
                    _ = stop.changed() => return,
                }
            }
        });
    }

    // SIGHUP is the authoritative reload path.
    if let Ok(mut hup) = signal(SignalKind::hangup()) {
        let app = app.clone();
        tokio::spawn(async move {
            while hup.recv().await.is_some() {
                match app.reload_routes().await {
                    Ok(()) => println!("route snapshot reloaded"),
                    Err(error) => eprintln!("route snapshot reload failed: {error}"),
                }
            }
        });
    }

    let serving = tokio::spawn(server::serve(app.clone(), listener));
    let (Ok(mut int), Ok(mut term)) = (
        signal(SignalKind::interrupt()),
        signal(SignalKind::terminate()),
    ) else {
        eprintln!("could not install signal handlers");
        return 1;
    };
    tokio::select! {
        _ = int.recv() => {}
        _ = term.recv() => {}
    }

    // Graceful shutdown: stop accepting, stop the timers, let in-flight requests finish (up to
    // 30 s), flush the request log, then stop the sidecar (which disposes every sprout).
    let _ = stop_timers.send(true);
    let _ = app.shutdown.send(true);
    let _ = serving.await;
    tokio::select! {
        _ = async {
            app.in_flight.drain(Duration::from_secs(30)).await;
            app.log.flush().await;
            app.sidecar.shutdown().await;
        } => {}
        // A second signal means "now".
        _ = int.recv() => {}
        _ = term.recv() => {}
    }
    0
}

async fn initial_routes(cfg: &Config) -> Result<(Routes, reload::Loaded), String> {
    if reload::stamp_of(&cfg.routes_path).await?.exists {
        read_snapshot(&cfg.routes_path).await
    } else {
        Ok((Routes::default(), reload::Loaded::default()))
    }
}

/// Activation: start the candidate version named by a one-route snapshot, or fail with why.
async fn start_candidate(app: &Arc<App>, request: &std::path::Path) -> Result<(), String> {
    let routes = read_routes(request).await?;
    let route = routes
        .iter()
        .next()
        .map(|(_, r)| r.clone())
        .ok_or("empty activation request")?;
    if route.backend.is_some() {
        return Ok(()); // sproutd loads and checks the version itself (deploy is the activation)
    }
    app.sidecar.endpoint(&route.runtime, true).await.map(|_| ())
}
