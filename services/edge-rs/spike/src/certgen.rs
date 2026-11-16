//! Writes N account wildcard certificates in the layout the lego issuer uses
//! (`<out>/<account>/{fullchain,privkey}.pem`, leaf then issuer, ECDSA P-256 like lego's default)
//! and, optionally, the Caddy drop-in `sbcloud cert` renders for each account.
//!
//! certgen --out DIR --accounts N [--prefix acct-] [--caddy-dir DIR --cert-root PATH --edge ADDR]
use rcgen::{CertificateParams, CustomExtension, DistinguishedName, DnType, IsCa, BasicConstraints, KeyPair};
use std::path::PathBuf;

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1).cloned())
}

fn main() {
    let out = PathBuf::from(arg("--out").expect("--out"));
    let n: usize = arg("--accounts").expect("--accounts").parse().unwrap();
    let prefix = arg("--prefix").unwrap_or_else(|| "acct-".into());
    let domain = arg("--domain").unwrap_or_else(|| "sproutboat.app".into());
    std::fs::create_dir_all(&out).unwrap();

    // One issuer, like Let's Encrypt's intermediate. The client in these benchmarks does not verify.
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.distinguished_name = DistinguishedName::new();
    ca_params.distinguished_name.push(DnType::CommonName, "Spike Issuer E5");
    let ca = ca_params.self_signed(&ca_key).unwrap();
    std::fs::write(out.join("ca.pem"), ca.pem()).unwrap();

    // A real Let's Encrypt leaf carries a signed-certificate-timestamp list of about 250 bytes
    // plus AIA/CRL pointers; pad ours to the same size so memory per certificate is not understated.
    let mut pad = vec![0x04, 0x82, 0x01, 0xa4];
    pad.extend(std::iter::repeat(0x5au8).take(420));
    let sct = CustomExtension::from_oid_content(&[1, 3, 6, 1, 4, 1, 11129, 2, 4, 2], pad);

    for i in 0..n {
        let account = format!("{prefix}{i:05}");
        let dir = out.join(&account);
        std::fs::create_dir_all(&dir).unwrap();
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(vec![format!("*.{account}.{domain}")]).unwrap();
        params.distinguished_name = DistinguishedName::new();
        params.distinguished_name.push(DnType::CommonName, format!("*.{account}.{domain}"));
        params.custom_extensions.push(sct.clone());
        let leaf = params.signed_by(&key, &rcgen::Issuer::new(ca_params.clone(), &ca_key)).unwrap();
        std::fs::write(dir.join("fullchain.pem"), format!("{}{}", leaf.pem(), ca.pem())).unwrap();
        std::fs::write(dir.join("privkey.pem"), key.serialize_pem()).unwrap();
        if let (Some(cd), Some(root), Some(edge)) = (arg("--caddy-dir"), arg("--cert-root"), arg("--edge")) {
            std::fs::create_dir_all(&cd).unwrap();
            std::fs::write(
                format!("{cd}/sproutboat-cloudcert-{account}.caddy"),
                format!(
                    "*.{account}.{domain} {{\n\ttls {root}/{account}/fullchain.pem {root}/{account}/privkey.pem\n\treverse_proxy {edge}\n}}\n"
                ),
            )
            .unwrap();
        }
    }
    println!("wrote {n} certificates under {}", out.display());
}
