use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

use crate::credentials::{self, Assembled, StoredCredential};
use crate::fsafe::{self, Entry, Fetched};
use crate::names;

pub const MARKER_VERSION: u64 = 1;
pub const DOCUMENT_LIMIT: u64 = 64 * 1024 * 1024;
pub const CONFIG_LIMIT: u64 = 4 * 1024 * 1024;
pub const SYNC_KEY_LIMIT: u64 = 64 * 1024;
pub const SECRET_FILE_LIMIT: u64 = 1024 * 1024;
pub const SYNC_KEY_BYTES: usize = 32;
const ATTEMPT_CAP: u64 = 1_000_000;

pub trait Sealer {
    fn seal(&self, plain: &[u8], purpose: &str) -> io::Result<Vec<u8>>;
    fn open(&self, sealed: &[u8], purpose: &str) -> Option<Zeroizing<Vec<u8>>>;
}

pub trait Vault {
    fn list(&self, prefix: &str) -> io::Result<Vec<StoredCredential>>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    pub rnw_data: PathBuf,
    pub rnw_config: PathBuf,
    pub webui_data: PathBuf,
    pub credential_prefix: String,
    pub test_instance: bool,
}

pub const WEBUI_FOLDER: &str = "Ardia WebUI";
pub const RNW_FOLDER: &str = "Ardia";

impl Layout {
    pub fn standard(local_app_data: &Path, roaming_app_data: &Path, test_instance: bool) -> Layout {
        Layout {
            rnw_data: local_app_data.join(RNW_FOLDER),
            rnw_config: roaming_app_data.join(RNW_FOLDER),
            webui_data: local_app_data.join(WEBUI_FOLDER),
            credential_prefix: names::credential_prefix(None),
            test_instance,
        }
    }

    pub fn custom(rnw_data: &str, webui_data: &Path, test_instance: bool) -> Layout {
        let rnw = PathBuf::from(rnw_data);
        Layout {
            rnw_config: rnw.join(names::CONFIG_FOLDER),
            rnw_data: rnw,
            webui_data: webui_data.to_path_buf(),
            credential_prefix: names::credential_prefix(Some(rnw_data)),
            test_instance,
        }
    }
}

#[derive(Default)]
pub struct Faults {
    pub fail_at_commit: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Migrated,
    MigratedWithSkips,
    AlreadyMigrated,
    NothingToMigrate,
    Busy,
    Refused,
    Failed,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Migrated => "migrated",
            Outcome::MigratedWithSkips => "migrated_with_skips",
            Outcome::AlreadyMigrated => "already_migrated",
            Outcome::NothingToMigrate => "nothing_to_migrate",
            Outcome::Busy => "busy",
            Outcome::Refused => "refused",
            Outcome::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Layout,
    Lock,
    Documents,
    Config,
    SyncKeys,
    Credentials,
    Marker,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Layout => "layout",
            Stage::Lock => "lock",
            Stage::Documents => "documents",
            Stage::Config => "config",
            Stage::SyncKeys => "sync_keys",
            Stage::Credentials => "credentials",
            Stage::Marker => "marker",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub documents: u64,
    pub placement: u64,
    pub config_files: u64,
    pub sync_keys: u64,
    pub credentials: u64,
    pub unchanged: u64,
    pub kept_aside: u64,
    pub skipped_links: u64,
    pub skipped_invalid: u64,
    pub skipped_too_large: u64,
    pub skipped_case_clash: u64,
    pub sync_keys_unreadable: u64,
    pub credentials_incomplete: u64,
    pub partials_swept: u64,
}

impl Counts {
    fn skipped(&self) -> u64 {
        self.skipped_links
            + self.skipped_invalid
            + self.skipped_too_large
            + self.skipped_case_clash
            + self.sync_keys_unreadable
            + self.credentials_incomplete
    }

    fn fields(&self) -> [(&'static str, u64); 14] {
        [
            ("documents", self.documents),
            ("placement", self.placement),
            ("config_files", self.config_files),
            ("sync_keys", self.sync_keys),
            ("credentials", self.credentials),
            ("unchanged", self.unchanged),
            ("kept_aside", self.kept_aside),
            ("skipped_links", self.skipped_links),
            ("skipped_invalid", self.skipped_invalid),
            ("skipped_too_large", self.skipped_too_large),
            ("skipped_case_clash", self.skipped_case_clash),
            ("sync_keys_unreadable", self.sync_keys_unreadable),
            ("credentials_incomplete", self.credentials_incomplete),
            ("partials_swept", self.partials_swept),
        ]
    }
}

#[derive(Clone, Debug)]
pub struct Report {
    pub outcome: Outcome,
    pub failed_stage: Option<Stage>,
    pub counts: Counts,
    pub duration_ms: u64,
    pub attempt: u64,
    pub run: String,
}

impl Report {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("version".into(), json!(MARKER_VERSION));
        object.insert("run".into(), json!(self.run));
        object.insert("outcome".into(), json!(self.outcome.as_str()));
        if let Some(stage) = self.failed_stage {
            object.insert("failed_stage".into(), json!(stage.as_str()));
        }
        object.insert("attempt".into(), json!(self.attempt));
        object.insert("duration_ms".into(), json!(self.duration_ms));
        let mut counts = Map::new();
        for (name, value) in self.counts.fields() {
            counts.insert(name.into(), json!(value));
        }
        object.insert("counts".into(), Value::Object(counts));
        Value::Object(object)
    }

    pub fn exit_code(&self) -> u8 {
        match self.outcome {
            Outcome::Migrated | Outcome::MigratedWithSkips | Outcome::AlreadyMigrated | Outcome::NothingToMigrate => 0,
            Outcome::Failed => 1,
            Outcome::Refused => 2,
            Outcome::Busy => 3,
        }
    }
}

enum Placed {
    Written,
    Unchanged,
    Skipped,
}

type StepResult = Result<(), (Stage, io::Error)>;

struct Migration<'a> {
    layout: &'a Layout,
    sealer: &'a dyn Sealer,
    vault: &'a dyn Vault,
    faults: &'a Faults,
    counts: Counts,
    commits: usize,
}

fn absolute(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
}

fn resolved(path: &Path) -> io::Result<PathBuf> {
    let mut existing = path.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match fs::canonicalize(&existing) {
            Ok(canonical) => {
                let mut full = canonical;
                for part in rest.iter().rev() {
                    full.push(part);
                }
                return Ok(full);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let Some(name) = existing.file_name().map(|n| n.to_os_string()) else {
                    return Err(error);
                };
                rest.push(name);
                if !existing.pop() {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
    }
}

fn folded_parts(path: &Path) -> Vec<String> {
    path.components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect()
}

pub fn overlapping(a: &Path, b: &Path) -> bool {
    let (a, b) = (folded_parts(a), folded_parts(b));
    let shorter = a.len().min(b.len());
    a[..shorter] == b[..shorter]
}

pub fn check_layout(layout: &Layout) -> io::Result<()> {
    for path in [&layout.rnw_data, &layout.rnw_config, &layout.webui_data] {
        if !absolute(path) {
            return Err(fsafe::unsafe_path(path.clone()));
        }
    }
    let webui = resolved(&layout.webui_data)?;
    let rnw_user_data = layout.rnw_data.join(names::CHROMIUM_USER_DATA);
    for theirs in [&layout.rnw_data, &layout.rnw_config, &rnw_user_data] {
        if overlapping(&webui, &resolved(theirs)?) || overlapping(&layout.webui_data, theirs) {
            return Err(fsafe::unsafe_path(theirs.clone()));
        }
    }
    for root in [&layout.rnw_data, &layout.rnw_config, &layout.webui_data] {
        if matches!(fsafe::entry(root)?, Entry::Link | Entry::File | Entry::Other) {
            return Err(fsafe::unsafe_path(root.clone()));
        }
    }
    Ok(())
}

fn read_report(path: &Path) -> Option<Value> {
    match fsafe::read_regular(path, SECRET_FILE_LIMIT) {
        Ok(Fetched::Data(bytes)) => serde_json::from_slice::<Value>(&bytes).ok().filter(Value::is_object),
        _ => None,
    }
}

pub fn read_marker(webui_data: &Path) -> Option<Value> {
    read_report(&webui_data.join(names::MARKER_NAME))
        .filter(|marker| marker.get("version").and_then(Value::as_u64) == Some(MARKER_VERSION))
}

pub fn read_attempt(webui_data: &Path) -> Option<Value> {
    read_report(&webui_data.join(names::ATTEMPT_NAME))
}

fn write_report(webui_data: &Path, name: &str, report: &Report) -> io::Result<()> {
    let text = serde_json::to_vec_pretty(&report.to_json()).map_err(io::Error::other)?;
    fsafe::commit(fsafe::stage(webui_data, name, &text)?)
}

impl Migration<'_> {
    fn commit(&mut self, staged: fsafe::Staged) -> io::Result<()> {
        self.commits += 1;
        if self.faults.fail_at_commit == Some(self.commits) {
            return Err(io::Error::other("stopped before a rename"));
        }
        fsafe::commit(staged)
    }

    fn write(&mut self, dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
        let staged = fsafe::stage(dir, name, bytes)?;
        self.commit(staged)
    }

    fn keep_aside(&mut self, kept_parts: &[&str], name: &str, bytes: &[u8]) -> io::Result<()> {
        let mut parts = vec![names::KEPT_FOLDER];
        parts.extend_from_slice(kept_parts);
        let kept = fsafe::ensure_folder(&self.layout.webui_data, &parts)?;
        if matches!(fsafe::entry(&kept.join(name))?, Entry::Missing) {
            self.write(&kept, name, bytes)?;
            self.counts.kept_aside += 1;
        }
        Ok(())
    }

    fn place(&mut self, parts: &[&str], name: &str, bytes: &[u8], same: &dyn Fn(&[u8]) -> bool) -> io::Result<Placed> {
        let dir = fsafe::ensure_folder(&self.layout.webui_data, parts)?;
        match fsafe::read_regular(&dir.join(name), DOCUMENT_LIMIT)? {
            Fetched::Missing => {}
            Fetched::Data(existing) if same(&existing) => {
                self.counts.unchanged += 1;
                return Ok(Placed::Unchanged);
            }
            Fetched::Data(existing) => self.keep_aside(parts, name, &existing)?,
            Fetched::Link => {
                self.counts.skipped_links += 1;
                return Ok(Placed::Skipped);
            }
            Fetched::NotRegular | Fetched::HardLinked | Fetched::TooLarge => {
                self.counts.skipped_invalid += 1;
                return Ok(Placed::Skipped);
            }
        }
        self.write(&dir, name, bytes)?;
        Ok(Placed::Written)
    }

    fn skip(&mut self, fetched: &Fetched) {
        match fetched {
            Fetched::Link => self.counts.skipped_links += 1,
            Fetched::TooLarge => self.counts.skipped_too_large += 1,
            Fetched::NotRegular | Fetched::HardLinked => self.counts.skipped_invalid += 1,
            Fetched::Missing | Fetched::Data(_) => {}
        }
    }

    fn copy_folder(
        &mut self,
        source: &Path,
        parts: &[&str],
        limit: u64,
        accept: &dyn Fn(&str) -> bool,
        counted: &dyn Fn(&mut Counts, &str),
    ) -> io::Result<()> {
        match fsafe::entry(source)? {
            Entry::Directory => {}
            Entry::Missing => return Ok(()),
            Entry::Link => {
                self.counts.skipped_links += 1;
                return Ok(());
            }
            Entry::File | Entry::Other => {
                self.counts.skipped_invalid += 1;
                return Ok(());
            }
        }
        let mut seen = BTreeSet::new();
        for name in fsafe::list_names(source)? {
            if !accept(&name) {
                continue;
            }
            let path = source.join(&name);
            if matches!(fsafe::entry(&path)?, Entry::Directory) {
                continue;
            }
            if !seen.insert(names::folded(&name)) {
                self.counts.skipped_case_clash += 1;
                continue;
            }
            match fsafe::read_regular(&path, limit)? {
                Fetched::Data(bytes) => {
                    let wanted = bytes.clone();
                    match self.place(parts, &name, &bytes, &move |existing| existing == wanted.as_slice())? {
                        Placed::Written | Placed::Unchanged => counted(&mut self.counts, &name),
                        Placed::Skipped => {}
                    }
                }
                other => self.skip(&other),
            }
        }
        Ok(())
    }

    fn documents(&mut self) -> io::Result<()> {
        let source = self.layout.rnw_data.clone();
        self.copy_folder(&source, &[], DOCUMENT_LIMIT, &names::document_name, &|counts, name| {
            if name.eq_ignore_ascii_case(names::PLACEMENT_NAME) {
                counts.placement += 1;
            } else {
                counts.documents += 1;
            }
        })
    }

    fn config(&mut self) -> io::Result<()> {
        let source = self.layout.rnw_config.clone();
        let is_config = |name: &str| names::CONFIG_FILES.contains(&name);
        self.copy_folder(
            &source,
            &[names::CONFIG_FOLDER],
            CONFIG_LIMIT,
            &is_config,
            &|counts, _| counts.config_files += 1,
        )?;
        if !matches!(fsafe::entry(&source)?, Entry::Directory) {
            return Ok(());
        }
        self.copy_folder(
            &source.join(names::THEMES_FOLDER),
            &[names::CONFIG_FOLDER, names::THEMES_FOLDER],
            CONFIG_LIMIT,
            &names::theme_file_name,
            &|counts, _| counts.config_files += 1,
        )
    }

    fn sync_keys(&mut self) -> io::Result<()> {
        let source = self.layout.rnw_data.join(names::SYNC_FOLDER);
        if !matches!(fsafe::entry(&self.layout.rnw_data)?, Entry::Directory) {
            return Ok(());
        }
        match fsafe::entry(&source)? {
            Entry::Directory => {}
            Entry::Missing => return Ok(()),
            Entry::Link => {
                self.counts.skipped_links += 1;
                return Ok(());
            }
            Entry::File | Entry::Other => {
                self.counts.skipped_invalid += 1;
                return Ok(());
            }
        }
        let mut seen = BTreeSet::new();
        for name in fsafe::list_names(&source)? {
            let Some(account) = names::sync_key_account(&name) else {
                continue;
            };
            if !seen.insert(names::folded(&name)) {
                self.counts.skipped_case_clash += 1;
                continue;
            }
            let bytes = match fsafe::read_regular(&source.join(&name), SYNC_KEY_LIMIT)? {
                Fetched::Data(bytes) => bytes,
                other => {
                    self.skip(&other);
                    continue;
                }
            };
            let purpose = names::sync_purpose(account, self.layout.test_instance);
            let opens = self
                .sealer
                .open(&bytes, &purpose)
                .is_some_and(|plain| plain.len() == SYNC_KEY_BYTES);
            if !opens {
                self.counts.sync_keys_unreadable += 1;
                continue;
            }
            let wanted = bytes.clone();
            match self.place(&[names::SYNC_FOLDER], &name, &bytes, &move |existing| {
                existing == wanted.as_slice()
            })? {
                Placed::Written | Placed::Unchanged => self.counts.sync_keys += 1,
                Placed::Skipped => {}
            }
        }
        Ok(())
    }

    fn credentials(&mut self, stored: Vec<StoredCredential>) -> io::Result<()> {
        for assembled in credentials::assemble(&self.layout.credential_prefix, stored) {
            let (account, secret) = match assembled {
                Assembled::Secret { account, secret } => (account, secret),
                Assembled::Incomplete => {
                    self.counts.credentials_incomplete += 1;
                    continue;
                }
                Assembled::Invalid => {
                    self.counts.skipped_invalid += 1;
                    continue;
                }
            };
            let purpose = names::secret_purpose(&account, self.layout.test_instance);
            let sealed = self.sealer.seal(&secret, &purpose)?;
            let sealer = self.sealer;
            let same = |existing: &[u8]| {
                sealer
                    .open(existing, &purpose)
                    .is_some_and(|plain| plain[..] == secret[..])
            };
            match self.place(&[names::SECRETS_FOLDER], &names::secret_file(&account), &sealed, &same)? {
                Placed::Written | Placed::Unchanged => self.counts.credentials += 1,
                Placed::Skipped => {}
            }
        }
        Ok(())
    }

    fn sweep(&mut self) -> io::Result<()> {
        let webui = self.layout.webui_data.clone();
        let mut folders = vec![webui.clone()];
        for base in [webui.clone(), webui.join(names::KEPT_FOLDER)] {
            folders.push(base.join(names::CONFIG_FOLDER));
            folders.push(base.join(names::CONFIG_FOLDER).join(names::THEMES_FOLDER));
            folders.push(base.join(names::SYNC_FOLDER));
            folders.push(base.join(names::SECRETS_FOLDER));
        }
        folders.push(webui.join(names::KEPT_FOLDER));
        for folder in folders {
            self.counts.partials_swept += fsafe::sweep_partials(&folder)? as u64;
        }
        Ok(())
    }

    fn steps(&mut self) -> StepResult {
        self.sweep().map_err(|e| (Stage::Lock, e))?;
        self.documents().map_err(|e| (Stage::Documents, e))?;
        self.config().map_err(|e| (Stage::Config, e))?;
        self.sync_keys().map_err(|e| (Stage::SyncKeys, e))?;
        let stored = self
            .vault
            .list(&self.layout.credential_prefix)
            .map_err(|e| (Stage::Credentials, e))?;
        self.credentials(stored).map_err(|e| (Stage::Credentials, e))
    }
}

fn nothing_there(layout: &Layout, vault: &dyn Vault) -> io::Result<bool> {
    let missing = |path: &Path| fsafe::entry(path).map(|e| matches!(e, Entry::Missing));
    Ok(missing(&layout.rnw_data)? && missing(&layout.rnw_config)? && vault.list(&layout.credential_prefix)?.is_empty())
}

pub fn migrate(layout: &Layout, sealer: &dyn Sealer, vault: &dyn Vault, faults: &Faults) -> Report {
    let started = Instant::now();
    let mut report = Report {
        outcome: Outcome::Failed,
        failed_stage: None,
        counts: Counts::default(),
        duration_ms: 0,
        attempt: 1,
        run: fsafe::run_id(),
    };
    let finish = |mut report: Report| {
        report.duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        report
    };

    if check_layout(layout).is_err() {
        report.outcome = Outcome::Refused;
        report.failed_stage = Some(Stage::Layout);
        return finish(report);
    }
    let webui = &layout.webui_data;
    if matches!(fsafe::entry(webui), Ok(Entry::Missing)) {
        if let Err(_error) = fs::create_dir_all(webui) {
            report.failed_stage = Some(Stage::Layout);
            return finish(report);
        }
    }
    if fsafe::check_folder(webui).is_err() {
        report.outcome = Outcome::Refused;
        report.failed_stage = Some(Stage::Layout);
        return finish(report);
    }

    let lock_path = webui.join(names::LOCK_NAME);
    if !matches!(fsafe::entry(&lock_path), Ok(Entry::Missing | Entry::File)) {
        report.outcome = Outcome::Refused;
        report.failed_stage = Some(Stage::Lock);
        return finish(report);
    }
    let lock = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
    {
        Ok(lock) => lock,
        Err(_) => {
            report.failed_stage = Some(Stage::Lock);
            return finish(report);
        }
    };
    match lock.try_lock() {
        Ok(()) => {}
        Err(fs::TryLockError::WouldBlock) => {
            report.outcome = Outcome::Busy;
            report.failed_stage = Some(Stage::Lock);
            return finish(report);
        }
        Err(fs::TryLockError::Error(_)) => {
            report.failed_stage = Some(Stage::Lock);
            return finish(report);
        }
    }

    if matches!(fsafe::entry(&webui.join(names::MARKER_NAME)), Ok(Entry::Link)) {
        report.outcome = Outcome::Refused;
        report.failed_stage = Some(Stage::Marker);
        return finish(report);
    }
    if read_marker(webui).is_some() {
        report.outcome = Outcome::AlreadyMigrated;
        return finish(report);
    }
    report.attempt = read_attempt(webui)
        .and_then(|previous| previous.get("attempt").and_then(Value::as_u64))
        .map_or(1, |previous| (previous + 1).min(ATTEMPT_CAP));

    let nothing = match nothing_there(layout, vault) {
        Ok(nothing) => nothing,
        Err(_) => {
            report.failed_stage = Some(Stage::Credentials);
            let report = finish(report);
            let _ = write_report(webui, names::ATTEMPT_NAME, &report);
            return report;
        }
    };

    let mut migration = Migration {
        layout,
        sealer,
        vault,
        faults,
        counts: Counts::default(),
        commits: 0,
    };
    let stepped = if nothing { Ok(()) } else { migration.steps() };
    report.counts = migration.counts.clone();
    if let Err((stage, _error)) = stepped {
        report.failed_stage = Some(stage);
        let report = finish(report);
        if faults.fail_at_commit.is_none() {
            let _ = write_report(webui, names::ATTEMPT_NAME, &report);
        }
        return report;
    }
    report.outcome = if nothing {
        Outcome::NothingToMigrate
    } else if report.counts.skipped() > 0 {
        Outcome::MigratedWithSkips
    } else {
        Outcome::Migrated
    };
    let mut report = finish(report);
    let marker = fsafe::stage(
        webui,
        names::MARKER_NAME,
        &serde_json::to_vec_pretty(&report.to_json()).unwrap_or_default(),
    )
    .and_then(|staged| migration.commit(staged));
    if marker.is_err() {
        report.outcome = Outcome::Failed;
        report.failed_stage = Some(Stage::Marker);
        if faults.fail_at_commit.is_some() {
            return report;
        }
    }
    let _ = write_report(webui, names::ATTEMPT_NAME, &report);
    drop(lock);
    report
}
