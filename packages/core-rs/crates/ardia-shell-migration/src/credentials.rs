use std::collections::BTreeMap;

use zeroize::Zeroizing;

use crate::names;

pub const CHUNK_BYTES: usize = 5 * 512;
pub const MAX_CHUNKS: usize = 64;
pub const MAX_SECRET_BYTES: usize = CHUNK_BYTES * MAX_CHUNKS;

pub struct StoredCredential {
    pub target: String,
    pub comment: Option<String>,
    pub blob: Zeroizing<Vec<u8>>,
}

pub enum Assembled {
    Secret {
        account: String,
        secret: Zeroizing<Vec<u8>>,
    },
    Incomplete,
    Invalid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    pub chunks: usize,
    pub generation: usize,
}

pub fn generation_of(comment: Option<&str>) -> usize {
    let Some(comment) = comment else {
        return 0;
    };
    let chars: Vec<char> = comment.chars().collect();
    let Some(marker) = find(&chars, &[' ', 'g']) else {
        return 0;
    };
    if marker + 3 >= chars.len() || chars[marker + 3] != ' ' {
        return 0;
    }
    match chars[marker + 2] {
        '1' => 1,
        '2' => 2,
        _ => 0,
    }
}

fn find(haystack: &[char], needle: &[char]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

pub fn chunk_count(comment: Option<&str>) -> usize {
    let Some(comment) = comment else {
        return 1;
    };
    let Some(space) = comment.rfind(' ') else {
        return 1;
    };
    let mut count = 0usize;
    for c in comment[space + 1..].chars() {
        let Some(digit) = c.to_digit(10) else {
            return 1;
        };
        count = count * 10 + digit as usize;
        if count > MAX_CHUNKS {
            return 1;
        }
    }
    if count == 0 {
        1
    } else {
        count
    }
}

pub fn layout_of(comment: Option<&str>) -> Layout {
    Layout {
        chunks: chunk_count(comment),
        generation: generation_of(comment),
    }
}

pub fn chunk_target(base: &str, generation: usize, index: usize) -> String {
    if generation == 0 {
        format!("{base}#{index}")
    } else {
        format!("{base}#g{generation}#{index}")
    }
}

fn chunk_bases(target: &str) -> Vec<&str> {
    let mut bases = Vec::new();
    let Some(hash) = target.rfind('#') else {
        return bases;
    };
    let index = &target[hash + 1..];
    if index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) {
        return bases;
    }
    let before = &target[..hash];
    for generation in ["#g1", "#g2"] {
        if let Some(base) = before.strip_suffix(generation) {
            bases.push(base);
        }
    }
    bases.push(before);
    bases
}

pub fn assemble(prefix: &str, stored: Vec<StoredCredential>) -> Vec<Assembled> {
    let mut by_target: BTreeMap<String, StoredCredential> = BTreeMap::new();
    for credential in stored {
        if credential.target.starts_with(prefix) {
            by_target.insert(credential.target.clone(), credential);
        }
    }
    let is_chunk = |target: &str| chunk_bases(target).iter().any(|base| by_target.contains_key(*base));
    let bases: Vec<String> = by_target.keys().filter(|target| !is_chunk(target)).cloned().collect();
    let mut assembled = Vec::new();
    for base in bases {
        let account = &base[prefix.len()..];
        if !names::secret_account(account) {
            assembled.push(Assembled::Invalid);
            continue;
        }
        let first = &by_target[&base];
        let layout = layout_of(first.comment.as_deref());
        let mut secret = Zeroizing::new(Vec::with_capacity(first.blob.len()));
        secret.extend_from_slice(&first.blob);
        let mut complete = true;
        for index in 1..layout.chunks {
            match by_target.get(&chunk_target(&base, layout.generation, index)) {
                Some(part) if secret.len() + part.blob.len() <= MAX_SECRET_BYTES => {
                    secret.extend_from_slice(&part.blob)
                }
                _ => {
                    complete = false;
                    break;
                }
            }
        }
        if !complete || secret.len() > MAX_SECRET_BYTES {
            assembled.push(Assembled::Incomplete);
            continue;
        }
        assembled.push(Assembled::Secret {
            account: account.to_string(),
            secret,
        });
    }
    assembled
}

pub fn rnw_layout(prefix: &str, account: &str, secret: &[u8], generation: usize) -> Vec<StoredCredential> {
    let base = format!("{prefix}{account}");
    let chunks = secret.len().div_ceil(CHUNK_BYTES).max(1);
    let mut stored = Vec::with_capacity(chunks);
    for index in 1..chunks {
        let start = index * CHUNK_BYTES;
        let end = (start + CHUNK_BYTES).min(secret.len());
        stored.push(StoredCredential {
            target: chunk_target(&base, generation, index),
            comment: None,
            blob: Zeroizing::new(secret[start..end].to_vec()),
        });
    }
    let comment = if generation == 0 {
        format!("Ardia {chunks}")
    } else {
        format!("Ardia g{generation} {chunks}")
    };
    stored.push(StoredCredential {
        target: base,
        comment: Some(comment),
        blob: Zeroizing::new(secret[..secret.len().min(CHUNK_BYTES)].to_vec()),
    });
    stored
}
