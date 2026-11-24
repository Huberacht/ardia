use std::collections::BTreeMap;

use zeroize::Zeroizing;

use crate::names;

pub const CHUNK_BYTES: usize = 5 * 512;
pub const MAX_CHUNKS: usize = 64;
pub const MAX_SECRET_BYTES: usize = CHUNK_BYTES * MAX_CHUNKS;

pub struct StoredCredential {
    pub target: String,
    pub comment: Option<String>,
    pub user: Option<String>,
    pub blob: Zeroizing<Vec<u8>>,
}

pub enum Assembled {
    Secret {
        account: String,
        secret: Zeroizing<Vec<u8>>,
    },
    Incomplete,
    Invalid,
    Orphan,
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

pub fn chunk_shaped(target: &str) -> bool {
    !chunk_bases(target).is_empty()
}

fn continuation(credential: &StoredCredential) -> bool {
    credential.comment.is_none() && chunk_shaped(&credential.target)
}

fn parts_of<'a>(
    base: &str,
    first: &'a StoredCredential,
    by_target: &'a BTreeMap<String, StoredCredential>,
) -> Option<Vec<&'a [u8]>> {
    let layout = layout_of(first.comment.as_deref());
    let mut parts = Vec::with_capacity(layout.chunks);
    parts.push(first.blob.as_slice());
    let mut total = first.blob.len();
    for index in 1..layout.chunks {
        let part = by_target.get(&chunk_target(base, layout.generation, index))?;
        if !continuation(part) || part.user != first.user {
            return None;
        }
        total += part.blob.len();
        if total > MAX_SECRET_BYTES {
            return None;
        }
        parts.push(part.blob.as_slice());
    }
    Some(parts)
}

pub fn assemble(prefix: &str, stored: Vec<StoredCredential>) -> Vec<Assembled> {
    let mut by_target: BTreeMap<String, StoredCredential> = BTreeMap::new();
    for credential in stored {
        if credential.target.starts_with(prefix) {
            by_target.insert(credential.target.clone(), credential);
        }
    }
    let mut used: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut assembled = Vec::new();
    for (base, first) in by_target.iter().filter(|(_, credential)| !continuation(credential)) {
        let account = &base[prefix.len()..];
        if !names::secret_account(account) {
            assembled.push(Assembled::Invalid);
            continue;
        }
        let Some(parts) = parts_of(base, first, &by_target) else {
            assembled.push(Assembled::Incomplete);
            continue;
        };
        let layout = layout_of(first.comment.as_deref());
        for index in 1..layout.chunks {
            used.insert(chunk_target(base, layout.generation, index));
        }
        let total = parts.iter().map(|part| part.len()).sum();
        let mut secret = Zeroizing::new(Vec::with_capacity(total));
        for part in parts {
            secret.extend_from_slice(part);
        }
        assembled.push(Assembled::Secret {
            account: account.to_string(),
            secret,
        });
    }
    let stale_generation = |target: &str, owner: &Option<String>| {
        chunk_bases(target).iter().any(|base| {
            by_target
                .get(*base)
                .is_some_and(|first| !continuation(first) && &first.user == owner)
        })
    };
    for (target, credential) in &by_target {
        if continuation(credential) && !used.contains(target) && !stale_generation(target, &credential.user) {
            assembled.push(Assembled::Orphan);
        }
    }
    assembled
}

pub fn rnw_user(account: &str) -> String {
    let wide: Vec<u16> = account.encode_utf16().take(256).collect();
    String::from_utf16_lossy(&wide)
}

pub fn rnw_layout(prefix: &str, account: &str, secret: &[u8], generation: usize) -> Vec<StoredCredential> {
    let base = format!("{prefix}{account}");
    let user = Some(rnw_user(account));
    let chunks = secret.len().div_ceil(CHUNK_BYTES).max(1);
    let mut stored = Vec::with_capacity(chunks);
    for index in 1..chunks {
        let start = index * CHUNK_BYTES;
        let end = (start + CHUNK_BYTES).min(secret.len());
        stored.push(StoredCredential {
            target: chunk_target(&base, generation, index),
            comment: None,
            user: user.clone(),
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
        user,
        blob: Zeroizing::new(secret[..secret.len().min(CHUNK_BYTES)].to_vec()),
    });
    stored
}
