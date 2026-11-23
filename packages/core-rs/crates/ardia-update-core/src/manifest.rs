use ardia_crypto::Crypto;

use crate::{UpdateError, Version};

pub const LINUX_MANIFEST_HEADER: &str = "ardia-linux-update 1";
pub const MAX_MANIFEST_BYTES: usize = 4096;
pub const SIGNATURE_BYTES: usize = 64;
pub const PUBLIC_KEY_BYTES: usize = 32;
pub const SHA256_BYTES: usize = 32;
pub const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
pub const LINUX_UPDATE_PUBLIC_KEY: [u8; PUBLIC_KEY_BYTES] = [
    0x3a, 0x44, 0x92, 0xa1, 0x78, 0x01, 0x99, 0x25, 0x1f, 0xdf, 0x8b, 0x76, 0x3b, 0x0d, 0xf5, 0x36, 0xba, 0x62, 0x43,
    0xff, 0xb0, 0x45, 0x55, 0xc8, 0x7f, 0x92, 0xbb, 0x16, 0x9a, 0x1a, 0xff, 0x2c,
];

const VERSION_PREFIX: &str = "version ";
const MAX_SIZE_DIGITS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PackageKind {
    Deb,
    Tarball,
    AppImage,
}

impl PackageKind {
    pub const ALL: [PackageKind; 3] = [PackageKind::Deb, PackageKind::Tarball, PackageKind::AppImage];

    pub fn name(self) -> &'static str {
        match self {
            PackageKind::Deb => "deb",
            PackageKind::Tarball => "tarball",
            PackageKind::AppImage => "appimage",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            PackageKind::Deb => "deb",
            PackageKind::Tarball => "tar.xz",
            PackageKind::AppImage => "AppImage",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        PackageKind::ALL.into_iter().find(|kind| kind.name() == name)
    }

    pub fn package_name(self, version: &str) -> String {
        format!("Ardia-{version}-linux-x64.{}", self.extension())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Package {
    pub kind: PackageKind,
    pub name: String,
    pub sha256: [u8; SHA256_BYTES],
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxManifest {
    pub version: String,
    pub packages: Vec<Package>,
}

impl LinuxManifest {
    pub fn package(&self, kind: PackageKind) -> Option<&Package> {
        self.packages.iter().find(|package| package.kind == kind)
    }
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn sha256_hex(text: &str) -> Option<[u8; SHA256_BYTES]> {
    let bytes = text.as_bytes();
    if bytes.len() != SHA256_BYTES * 2 {
        return None;
    }
    let mut out = [0u8; SHA256_BYTES];
    for (index, pair) in bytes.as_chunks::<2>().0.iter().enumerate() {
        out[index] = hex_digit(pair[0])? << 4 | hex_digit(pair[1])?;
    }
    Some(out)
}

fn package_size(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_SIZE_DIGITS || bytes[0] == b'0' || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    text.parse().ok()
}

fn package_line(line: &str, version: &str) -> Result<Package, UpdateError> {
    let fields: Vec<&str> = line.split(' ').collect();
    let [kind, name, digest, size] = fields[..] else {
        return Err(UpdateError::Manifest);
    };
    let kind = PackageKind::from_name(kind).ok_or(UpdateError::Manifest)?;
    if name != kind.package_name(version) {
        return Err(UpdateError::Manifest);
    }
    let sha256 = sha256_hex(digest).ok_or(UpdateError::Manifest)?;
    let size = package_size(size).ok_or(UpdateError::Manifest)?;
    if size > MAX_PACKAGE_BYTES {
        return Err(UpdateError::Manifest);
    }
    Ok(Package {
        kind,
        name: name.to_owned(),
        sha256,
        size,
    })
}

pub fn parse_linux_manifest(manifest: &[u8]) -> Result<LinuxManifest, UpdateError> {
    if manifest.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::TooLarge);
    }
    let text = core::str::from_utf8(manifest).map_err(|_| UpdateError::Manifest)?;
    let body = text.strip_suffix('\n').ok_or(UpdateError::Manifest)?;
    let mut lines = body.split('\n');
    if lines.next() != Some(LINUX_MANIFEST_HEADER) {
        return Err(UpdateError::Manifest);
    }
    let version = lines
        .next()
        .and_then(|line| line.strip_prefix(VERSION_PREFIX))
        .ok_or(UpdateError::Manifest)?;
    Version::parse(version).map_err(|_| UpdateError::Manifest)?;
    let mut packages: Vec<Package> = Vec::new();
    for line in lines {
        let package = package_line(line, version)?;
        if packages.last().is_some_and(|last| last.kind >= package.kind) {
            return Err(UpdateError::Manifest);
        }
        packages.push(package);
    }
    Ok(LinuxManifest {
        version: version.to_owned(),
        packages,
    })
}

fn pick(manifest: LinuxManifest, kind: PackageKind) -> Result<Package, UpdateError> {
    manifest
        .packages
        .into_iter()
        .find(|package| package.kind == kind)
        .ok_or(UpdateError::Kind)
}

pub fn package_in_linux_manifest(manifest: &[u8], version: &str, kind: PackageKind) -> Result<Package, UpdateError> {
    if manifest.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::TooLarge);
    }
    Version::parse(version)?;
    let parsed = parse_linux_manifest(manifest)?;
    if parsed.version != version {
        return Err(UpdateError::Manifest);
    }
    pick(parsed, kind)
}

pub fn verify_linux_manifest<C: Crypto>(
    public_key: &[u8; PUBLIC_KEY_BYTES],
    manifest: &[u8],
    signature: &[u8],
) -> Result<LinuxManifest, UpdateError> {
    if manifest.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::TooLarge);
    }
    let signature: &[u8; SIGNATURE_BYTES] = signature.try_into().map_err(|_| UpdateError::Signature)?;
    if !C::ed25519_verify(public_key, manifest, signature) {
        return Err(UpdateError::Signature);
    }
    parse_linux_manifest(manifest)
}

pub fn verify_linux_update<C: Crypto>(
    public_key: &[u8; PUBLIC_KEY_BYTES],
    manifest: &[u8],
    signature: &[u8],
    version: &str,
    installed: &str,
    kind: PackageKind,
) -> Result<Package, UpdateError> {
    let wanted = Version::parse(version)?;
    let current = Version::parse(installed)?;
    let parsed = verify_linux_manifest::<C>(public_key, manifest, signature)?;
    if parsed.version != version {
        return Err(UpdateError::Manifest);
    }
    if wanted <= current {
        return Err(UpdateError::NotNewer);
    }
    pick(parsed, kind)
}
