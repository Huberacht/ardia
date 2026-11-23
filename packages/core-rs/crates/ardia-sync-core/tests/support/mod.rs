#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use ardia_sync_core::SyncKeys;
use base64::Engine;
use serde_json::Value;

pub fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..")
        .canonicalize()
        .unwrap()
}

pub fn fixtures() -> PathBuf {
    repo().join("packages/sync/tests/fixtures")
}

pub fn vectors() -> PathBuf {
    fixtures().join("sync-vectors")
}

pub fn json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap()
}

pub fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

pub fn hex_string(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn base64_decode(text: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(text).unwrap()
}

pub fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn str<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("missing string {key} in {value}"))
}

pub fn entropy32(text: &str) -> [u8; 32] {
    hex(text).try_into().unwrap()
}

pub fn tree(folder: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, folder: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(entries) = fs::read_dir(folder) else { return };
        for entry in entries {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                out.insert(relative, fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(folder, folder, &mut out);
    out
}

pub fn names(folder: &Path) -> Vec<String> {
    match fs::read_dir(folder) {
        Ok(entries) => entries
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    }
}

pub fn read_scope(vault: &Path, keys: &SyncKeys, scope: &str) -> ScopeRead {
    let folder = vault.join(keys.chain_tag()).join(keys.scope_tag(scope));
    let names = names(&folder);
    let listing = ardia_sync_core::vault::list(names.iter().map(String::as_str), &[]);
    let mut read = ScopeRead {
        pending: listing.pending,
        present: listing.present,
        ..ScopeRead::default()
    };
    let scope_tag = keys.scope_tag(scope);
    for id in listing.open {
        let data = fs::read(folder.join(ardia_sync_core::vault::file_name(&id))).unwrap();
        match keys.open(&data, &scope_tag, &id) {
            Ok(payload) => read.files.push((id, payload.to_vec())),
            Err(_) => read.damaged.push(id),
        }
    }
    read
}

#[derive(Default, Debug)]
pub struct ScopeRead {
    pub files: Vec<(String, Vec<u8>)>,
    pub damaged: Vec<String>,
    pub pending: Vec<String>,
    pub present: Vec<String>,
}
