use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

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

#[derive(Debug)]
pub struct Unsafe(pub PathBuf);

impl std::fmt::Display for Unsafe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a folder on the way is a link, not a folder, or leads outside its root")
    }
}

impl std::error::Error for Unsafe {}

pub fn unsafe_path(path: PathBuf) -> io::Error {
    io::Error::other(Unsafe(path))
}

pub fn plain(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

fn folded_parts(path: &Path) -> Vec<String> {
    path.components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect()
}

pub fn within(inner: &Path, outer: &Path) -> bool {
    let (inner, outer) = (folded_parts(inner), folded_parts(outer));
    inner.len() >= outer.len() && inner[..outer.len()] == outer[..]
}

pub fn same_place(a: &Path, b: &Path) -> bool {
    folded_parts(a) == folded_parts(b)
}

pub fn check_ancestors(path: &Path) -> io::Result<()> {
    let mut walked = PathBuf::new();
    for component in path.components() {
        walked.push(component);
        if matches!(component, Component::Prefix(_) | Component::RootDir) {
            continue;
        }
        match entry(&walked)? {
            Entry::Directory => {}
            Entry::Missing => return Ok(()),
            _ if walked == path => return Ok(()),
            _ => return Err(unsafe_path(walked)),
        }
    }
    Ok(())
}

#[cfg(windows)]
pub fn final_path(file: &File) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let handle = file.as_raw_handle();
    let mut buffer = vec![0u16; 1024];
    loop {
        let length = unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) } as usize;
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if length < buffer.len() {
            buffer.truncate(length);
            return Ok(plain(PathBuf::from(std::ffi::OsString::from_wide(&buffer))));
        }
        if buffer.len() >= 32_768 {
            return Err(io::Error::other("path too long"));
        }
        buffer.resize(length + 1, 0);
    }
}

#[cfg(target_os = "macos")]
pub fn final_path(file: &File) -> io::Result<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::AsRawFd;
    let mut buffer = vec![0 as libc::c_char; libc::PATH_MAX as usize + 1];
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let text = unsafe { CStr::from_ptr(buffer.as_ptr()) };
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(text.to_bytes())))
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn final_path(file: &File) -> io::Result<PathBuf> {
    use std::os::unix::io::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(windows)]
fn link_count(file: &File) -> io::Result<u64> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(u64::from(info.nNumberOfLinks))
}

#[cfg(unix)]
fn link_count(file: &File) -> io::Result<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(file.metadata()?.nlink())
}

fn no_follow(options: &mut OpenOptions, directory: bool) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let folder = if directory { libc::O_DIRECTORY } else { 0 };
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | folder);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let folder = if directory { FILE_FLAG_BACKUP_SEMANTICS } else { 0 };
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | folder);
    }
}

fn open_folder(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    no_follow(&mut options, true);
    let folder = options.open(path).map_err(|_| unsafe_path(path.to_path_buf()))?;
    let meta = folder.metadata()?;
    if is_link(&meta) || !meta.is_dir() {
        return Err(unsafe_path(path.to_path_buf()));
    }
    Ok(folder)
}

pub struct Root {
    pub path: PathBuf,
    pub resolved: PathBuf,
}

impl Root {
    pub fn new(path: &Path) -> io::Result<Root> {
        check_ancestors(path)?;
        if !matches!(entry(path)?, Entry::Directory) {
            return Err(unsafe_path(path.to_path_buf()));
        }
        let resolved = final_path(&open_folder(path)?)?;
        if !same_place(&resolved, &plain(fs::canonicalize(path)?)) {
            return Err(unsafe_path(path.to_path_buf()));
        }
        Ok(Root {
            path: path.to_path_buf(),
            resolved,
        })
    }

    pub fn holds(&self, file: &File) -> io::Result<bool> {
        Ok(within(&final_path(file)?, &self.resolved))
    }

    fn relative<'a>(&self, path: &'a Path) -> io::Result<&'a Path> {
        path.strip_prefix(&self.path)
            .map_err(|_| unsafe_path(path.to_path_buf()))
    }

    pub fn check_chain(&self, dir: &Path) -> io::Result<File> {
        let relative = self.relative(dir)?;
        let mut walked = self.path.clone();
        let mut folder = open_folder(&walked)?;
        for component in relative.components() {
            if !matches!(component, Component::Normal(_)) {
                return Err(unsafe_path(dir.to_path_buf()));
            }
            walked.push(component);
            if !matches!(entry(&walked)?, Entry::Directory) {
                return Err(unsafe_path(walked));
            }
            folder = open_folder(&walked)?;
        }
        if !self.holds(&folder)? {
            return Err(unsafe_path(dir.to_path_buf()));
        }
        Ok(folder)
    }

    pub fn ensure_folder(&self, parts: &[&str]) -> io::Result<PathBuf> {
        let mut path = self.path.clone();
        self.check_chain(&path)?;
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
            self.check_chain(&path)?;
        }
        Ok(path)
    }

    pub fn read_regular(&self, path: &Path, limit: u64) -> io::Result<Fetched> {
        if let Some(parent) = path.parent() {
            self.check_chain(parent)?;
        }
        match entry(path)? {
            Entry::Missing => return Ok(Fetched::Missing),
            Entry::Link => return Ok(Fetched::Link),
            Entry::File => {}
            Entry::Directory | Entry::Other => return Ok(Fetched::NotRegular),
        }
        let mut options = OpenOptions::new();
        options.read(true);
        no_follow(&mut options, false);
        let mut file = match options.open(path) {
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
        if !self.holds(&file)? {
            return Ok(Fetched::Link);
        }
        if link_count(&file)? > 1 {
            return Ok(Fetched::HardLinked);
        }
        if meta.len() > limit {
            return Ok(Fetched::TooLarge);
        }
        let mut bytes = Zeroizing::new(vec![0u8; meta.len() as usize]);
        file.read_exact(&mut bytes)?;
        let mut more = [0u8; 1];
        if file.read(&mut more)? != 0 {
            return Ok(Fetched::TooLarge);
        }
        Ok(Fetched::Data(bytes))
    }

    pub fn stage(&self, dir: &Path, name: &str, bytes: &[u8]) -> io::Result<Staged> {
        let folder = self.check_chain(dir)?;
        let temp = dir.join(partial_name(name));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        no_follow(&mut options, false);
        let mut file = options.open(&temp)?;
        let placed = final_path(&file)
            .map(|at| at.parent().map(Path::to_path_buf).unwrap_or_default())
            .and_then(|parent| Ok(same_place(&parent, &final_path(&folder)?)));
        let written = match placed {
            Ok(true) => file.write_all(bytes).and_then(|()| file.sync_all()),
            Ok(false) => Err(unsafe_path(temp.clone())),
            Err(error) => Err(error),
        };
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

    pub fn commit(&self, staged: Staged) -> io::Result<()> {
        let parent = staged.target.parent().map(Path::to_path_buf).unwrap_or_default();
        let checked = self.check_chain(&parent).and_then(|_| match entry(&staged.target)? {
            Entry::Missing | Entry::File => Ok(()),
            _ => Err(unsafe_path(staged.target.clone())),
        });
        if let Err(error) = checked.and_then(|()| fs::rename(&staged.temp, &staged.target)) {
            let _ = fs::remove_file(&staged.temp);
            return Err(error);
        }
        sync_folder(&parent);
        Ok(())
    }

    pub fn sweep_partials(&self, dir: &Path) -> io::Result<usize> {
        if self.check_chain(dir).is_err() {
            return Ok(0);
        }
        let mut swept = 0;
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

    pub fn open_lock(&self, name: &str) -> io::Result<File> {
        let path = self.path.join(name);
        if !matches!(entry(&path)?, Entry::Missing | Entry::File) {
            return Err(unsafe_path(path));
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        no_follow(&mut options, false);
        let lock = options.open(&path)?;
        let meta = lock.metadata()?;
        if is_link(&meta) || !meta.is_file() || !self.holds(&lock)? {
            return Err(unsafe_path(path));
        }
        Ok(lock)
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
