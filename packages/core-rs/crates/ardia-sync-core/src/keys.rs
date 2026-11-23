use ardia_crypto::{Backend, Crypto, KEY_BYTES};
use base64::alphabet::STANDARD;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::base32::base32_encode;
use crate::Error;

pub const MAGIC: &[u8; 4] = b"NNS1";
pub const SALT: &[u8] = b"netnyahoo-sync/v1";
pub const PADDING: usize = 1024;
pub const PASSWORD_PADDING: usize = 32;
pub const PASSWORD_VERSION: u8 = 1;
pub const NONCE_BYTES: usize = ardia_crypto::NONCE_BYTES;
pub const TAG_BYTES: usize = ardia_crypto::TAG_BYTES;
pub const LOCAL_SCOPE_TAG: &str = "local";

const LENGTH_BYTES: usize = 4;

const BASE64: GeneralPurpose = GeneralPurpose::new(
    &STANDARD,
    GeneralPurposeConfig::new()
        .with_encode_padding(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireCanonical)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SyncKeys {
    file_key: [u8; KEY_BYTES],
    name_key: [u8; KEY_BYTES],
    password_key: [u8; KEY_BYTES],
    password_nonce_key: [u8; KEY_BYTES],
    #[zeroize(skip)]
    chain_tag: String,
}

fn derive(entropy: &[u8], info: &str) -> [u8; KEY_BYTES] {
    let mut key = [0u8; KEY_BYTES];
    Backend::hkdf_sha256(entropy, SALT, info.as_bytes(), &mut key).expect("32 bytes is a valid HKDF-SHA256 length");
    key
}

fn length_prefix(length: usize) -> Result<[u8; LENGTH_BYTES], Error> {
    u32::try_from(length).map(u32::to_be_bytes).map_err(|_| Error::Format)
}

fn framed(payload: &[u8], block: usize) -> Result<Zeroizing<Vec<u8>>, Error> {
    let header = length_prefix(payload.len())?;
    let length = LENGTH_BYTES + payload.len();
    let padded = length + (block - length % block) % block;
    let mut plain = Zeroizing::new(Vec::with_capacity(padded));
    plain.extend_from_slice(&header);
    plain.extend_from_slice(payload);
    plain.resize(padded, 0);
    Ok(plain)
}

fn unframed(plain: &[u8]) -> Result<&[u8], Error> {
    if plain.len() < LENGTH_BYTES {
        return Err(Error::Format);
    }
    let length = u32::from_be_bytes([plain[0], plain[1], plain[2], plain[3]]) as usize;
    if length > plain.len() - LENGTH_BYTES {
        return Err(Error::Format);
    }
    Ok(&plain[LENGTH_BYTES..LENGTH_BYTES + length])
}

fn split_box(body: &[u8]) -> ([u8; NONCE_BYTES], &[u8]) {
    let mut nonce = [0u8; NONCE_BYTES];
    nonce.copy_from_slice(&body[..NONCE_BYTES]);
    (nonce, &body[NONCE_BYTES..])
}

pub fn new_file_id() -> Result<String, Error> {
    let mut bytes = [0u8; 16];
    Backend::fill_random(&mut bytes).map_err(|_| Error::Random)?;
    Ok(base32_encode(&bytes))
}

impl SyncKeys {
    pub fn new(entropy: &[u8]) -> Self {
        let name_key = derive(entropy, "name-key");
        let chain_tag = Self::tag_with(&name_key, "chain");
        SyncKeys {
            file_key: derive(entropy, "file-key"),
            name_key,
            password_key: derive(entropy, "password-key"),
            password_nonce_key: derive(entropy, "password-nonce-key"),
            chain_tag,
        }
    }

    fn tag_with(name_key: &[u8; KEY_BYTES], label: &str) -> String {
        base32_encode(&Backend::hmac_sha256(name_key, &[label.as_bytes()])[..16])
    }

    pub fn chain_tag(&self) -> &str {
        &self.chain_tag
    }

    pub fn tag(&self, label: &str) -> String {
        Self::tag_with(&self.name_key, label)
    }

    pub fn scope_tag(&self, scope: &str) -> String {
        self.tag(&format!("scope/{scope}"))
    }

    pub fn associated_data(&self, scope_tag: &str, file_id: &str) -> Vec<u8> {
        let mut aad = Vec::with_capacity(MAGIC.len() + self.chain_tag.len() + scope_tag.len() + file_id.len() + 2);
        aad.extend_from_slice(MAGIC);
        aad.extend_from_slice(self.chain_tag.as_bytes());
        aad.push(b'/');
        aad.extend_from_slice(scope_tag.as_bytes());
        aad.push(b'/');
        aad.extend_from_slice(file_id.as_bytes());
        aad
    }

    pub fn seal(&self, payload: &[u8], scope_tag: &str, file_id: &str) -> Result<Vec<u8>, Error> {
        let mut nonce = [0u8; NONCE_BYTES];
        Backend::fill_random(&mut nonce).map_err(|_| Error::Random)?;
        self.seal_with_nonce(payload, scope_tag, file_id, &nonce)
    }

    pub fn seal_with_nonce(
        &self,
        payload: &[u8],
        scope_tag: &str,
        file_id: &str,
        nonce: &[u8; NONCE_BYTES],
    ) -> Result<Vec<u8>, Error> {
        let plain = framed(payload, PADDING)?;
        let sealed = Backend::aes256gcm_seal(&self.file_key, nonce, &self.associated_data(scope_tag, file_id), &plain)
            .map_err(|_| Error::Format)?;
        let mut file = Vec::with_capacity(MAGIC.len() + NONCE_BYTES + sealed.len());
        file.extend_from_slice(MAGIC);
        file.extend_from_slice(nonce);
        file.extend_from_slice(&sealed);
        Ok(file)
    }

    pub fn open(&self, file: &[u8], scope_tag: &str, file_id: &str) -> Result<Zeroizing<Vec<u8>>, Error> {
        if file.len() < MAGIC.len() + NONCE_BYTES + TAG_BYTES + LENGTH_BYTES || &file[..MAGIC.len()] != MAGIC {
            return Err(Error::Format);
        }
        let (nonce, sealed) = split_box(&file[MAGIC.len()..]);
        let plain = Backend::aes256gcm_open(
            &self.file_key,
            &nonce,
            &self.associated_data(scope_tag, file_id),
            sealed,
        )
        .map_err(|_| Error::Authentication)?;
        Ok(Zeroizing::new(unframed(&plain)?.to_vec()))
    }

    pub fn seal_local(&self, payload: &[u8], file_id: &str) -> Result<Vec<u8>, Error> {
        self.seal(payload, LOCAL_SCOPE_TAG, file_id)
    }

    pub fn open_local(&self, file: &[u8], file_id: &str) -> Result<Zeroizing<Vec<u8>>, Error> {
        self.open(file, LOCAL_SCOPE_TAG, file_id)
    }

    pub fn password_associated_data(origin: &str, username: &str) -> Result<Vec<u8>, Error> {
        let header = length_prefix(origin.len())?;
        let mut aad = Vec::with_capacity(MAGIC.len() + 9 + LENGTH_BYTES + origin.len() + username.len());
        aad.extend_from_slice(MAGIC);
        aad.extend_from_slice(b"password/");
        aad.extend_from_slice(&header);
        aad.extend_from_slice(origin.as_bytes());
        aad.extend_from_slice(username.as_bytes());
        Ok(aad)
    }

    pub fn seal_password(&self, password: &str, origin: &str, username: &str) -> Result<String, Error> {
        let plain = framed(password.as_bytes(), PASSWORD_PADDING)?;
        let aad = Self::password_associated_data(origin, username)?;
        let aad_length = length_prefix(aad.len())?;
        let synthetic = Backend::hmac_sha256(&self.password_nonce_key, &[&aad_length, &aad, &plain]);
        let mut nonce = [0u8; NONCE_BYTES];
        nonce.copy_from_slice(&synthetic[..NONCE_BYTES]);
        let sealed = Backend::aes256gcm_seal(&self.password_key, &nonce, &aad, &plain).map_err(|_| Error::Format)?;
        let mut data = Zeroizing::new(Vec::with_capacity(1 + NONCE_BYTES + sealed.len()));
        data.push(PASSWORD_VERSION);
        data.extend_from_slice(&nonce);
        data.extend_from_slice(&sealed);
        Ok(BASE64.encode(data.as_slice()))
    }

    pub fn open_password(&self, sealed: &str, origin: &str, username: &str) -> Result<Zeroizing<String>, Error> {
        let data = Zeroizing::new(BASE64.decode(sealed).map_err(|_| Error::Format)?);
        if data.len() < 1 + NONCE_BYTES + TAG_BYTES + LENGTH_BYTES || data[0] != PASSWORD_VERSION {
            return Err(Error::Format);
        }
        let (nonce, body) = split_box(&data[1..]);
        let aad = Self::password_associated_data(origin, username)?;
        let plain =
            Backend::aes256gcm_open(&self.password_key, &nonce, &aad, body).map_err(|_| Error::Authentication)?;
        let password = std::str::from_utf8(unframed(&plain)?).map_err(|_| Error::Format)?;
        Ok(Zeroizing::new(password.to_owned()))
    }
}
