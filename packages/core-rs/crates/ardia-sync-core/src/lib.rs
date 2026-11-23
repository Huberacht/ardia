#![forbid(unsafe_code)]

mod base32;
mod error;
mod keys;
mod lowercase_letters;
pub mod phrase;
pub mod vault;
pub mod wordlist;

pub use base32::{base32_encode, is_tag, TAG_LENGTH};
pub use error::{Error, PhraseError};
pub use keys::{
    new_file_id, SyncKeys, LOCAL_SCOPE_TAG, MAGIC, NONCE_BYTES, PADDING, PASSWORD_PADDING, PASSWORD_VERSION, SALT,
    TAG_BYTES,
};
