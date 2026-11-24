use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use crate::names::PARTIAL_SUFFIX;

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
#[cfg(windows)]
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

#[cfg(windows)]
fn reparse_point(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn reparse_point(_meta: &Metadata) -> bool {
    false
}

pub fn is_link(meta: &Metadata) -> bool {
    meta.file_type().is_symlink() || reparse_point(meta)
}

pub enum Entry {
    Missing,
    Link,
    Directory,
    File,
    Other,
}

pub fn entry(path: &Path) -> io::Result<Entry> {
    match fs::symlink_metadata(path) {
        Ok(meta) if is_link(&meta) => Ok(Entry::Link),
        Ok(meta) if meta.is_dir() => Ok(Entry::Directory),
        Ok(meta) if meta.is_file() => Ok(Entry::File),
        Ok(_) => Ok(Entry::Other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Entry::Missing),
        Err(error) => Err(error),
    }
}

pub enum Fetched {
    Data(Zeroizing<Vec<u8>>),
    Missing,
    Link,
    NotRegular,
    HardLinked,
    TooLarge,
}

fn open_no_follow(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path)
}

pub fn read_regular(path: &Path, limit: u64) -> io::Result<Fetched> {
    match entry(path)? {
        Entry::Missing => return Ok(Fetched::Missing),
        Entry::Link => return Ok(Fetched::Link),
        Entry::File => {}
        Entry::Directory | Entry::Other => return Ok(Fetched::NotRegular),
    }
    let file = match open_no_follow(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Fetched::Missing),
        #[cfg(unix)]
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => return Ok(Fetched::Link),
        Err(error) => return Err(error),
    };
    let meta = file.metadata()?;
    if is_link(&meta) {
        return Ok(Fetched::Link);
    }
    if !meta.is_file() {
        return Ok(Fetched::NotRegular);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() > 1 {
            return Ok(Fetched::HardLinked);
        }
    }
    if meta.len() > limit {
        return Ok(Fetched::TooLarge);
    }
    let mut bytes = Zeroizing::new(Vec::with_capacity(meta.len() as usize));
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Ok(Fetched::TooLarge);
    }
    Ok(Fetched::Data(bytes))
}

pub fn list_names(dir: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(names),
        Err(error) => return Err(error),
    };
    for item in entries {
        let item = item?;
        if let Ok(name) = item.file_name().into_string() {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

#[derive(Debug)]
pub struct Unsafe(pub PathBuf);

impl std::fmt::Display for Unsafe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a folder on the way is a link or not a folder")
    }
}

impl std::error::Error for Unsafe {}

pub fn unsafe_path(path: PathBuf) -> io::Error {
    io::Error::other(Unsafe(path))
}

pub fn ensure_folder(root: &Path, parts: &[&str]) -> io::Result<PathBuf> {
    let mut path = root.to_path_buf();
    check_folder(&path)?;
    for part in parts {
        path.push(part);
        match entry(&path)? {
            Entry::Directory => {}
            Entry::Missing => match fs::create_dir(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            },
            _ => return Err(unsafe_path(path)),
        }
        check_folder(&path)?;
    }
    Ok(path)
}

pub fn check_folder(path: &Path) -> io::Result<()> {
    match entry(path)? {
        Entry::Directory => Ok(()),
        _ => Err(unsafe_path(path.to_path_buf())),
    }
}

fn random_hex(bytes: usize) -> String {
    let mut random = vec![0u8; bytes];
    if getrandom::getrandom(&mut random).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        for (index, byte) in random.iter_mut().enumerate() {
            *byte = (nanos >> ((index % 16) * 8)) as u8 ^ (std::process::id() as u8);
        }
    }
    random.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn run_id() -> String {
    random_hex(16)
}

pub fn partial_name(name: &str) -> String {
    format!(".{name}.{}{PARTIAL_SUFFIX}", random_hex(6))
}

pub struct Staged {
    pub temp: PathBuf,
    pub target: PathBuf,
}

pub fn stage(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<Staged> {
    check_folder(dir)?;
    let temp = dir.join(partial_name(name));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(Staged {
        temp,
        target: dir.join(name),
    })
}

pub fn commit(staged: Staged) -> io::Result<()> {
    let parent = staged.target.parent().map(Path::to_path_buf).unwrap_or_default();
    if let Err(error) = check_folder(&parent).and_then(|()| fs::rename(&staged.temp, &staged.target)) {
        let _ = fs::remove_file(&staged.temp);
        return Err(error);
    }
    sync_folder(&parent);
    Ok(())
}

#[cfg(unix)]
fn sync_folder(dir: &Path) {
    if let Ok(folder) = File::open(dir) {
        let _ = folder.sync_all();
    }
}

#[cfg(windows)]
fn sync_folder(dir: &Path) {
    use std::os::windows::fs::OpenOptionsExt;
    if let Ok(folder) = OpenOptions::new()
        .write(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(dir)
    {
        let _ = folder.sync_all();
    }
}

#[cfg(not(any(unix, windows)))]
fn sync_folder(_dir: &Path) {}

pub fn sweep_partials(dir: &Path) -> io::Result<usize> {
    let mut swept = 0;
    if !matches!(entry(dir)?, Entry::Directory) {
        return Ok(0);
    }
    for name in list_names(dir)? {
        if !(name.starts_with('.') && name.ends_with(PARTIAL_SUFFIX)) {
            continue;
        }
        let path = dir.join(&name);
        match entry(&path)? {
            Entry::File => fs::remove_file(&path)?,
            Entry::Link => fs::remove_file(&path).or_else(|_| fs::remove_dir(&path))?,
            _ => continue,
        }
        swept += 1;
    }
    Ok(swept)
}
