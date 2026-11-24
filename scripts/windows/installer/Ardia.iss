#ifndef Shell
  #define Shell "rnw"
#endif
#if Shell == "webui"
  #define LaunchSwitch "--ardia-shell=webui"
  #define OpenSuffix " --ardia-shell=webui"
  #define ShellMarker "ardia-ui\index.html"
  #define RetiredShell "rnw"
  #define RetiredMarker "ArdiaApp.dll"
  #define RetiredMarkerAlt "ArdiaApp.dll"
#else
  #define LaunchSwitch ""
  #define OpenSuffix ""
  #define ShellMarker "ArdiaApp.dll"
  #define RetiredShell "webui"
  #define RetiredMarker "ardia-ui\index.html"
  #define RetiredMarkerAlt "ardia-webui-migrate.exe"
#endif

[Setup]
AppId={{47A92F18-32B0-4548-A1EF-72C217FE1836}
AppName=Ardia
AppVersion={#Version}
AppVerName=Ardia {#Version}
AppPublisher=Ardia
AppPublisherURL=https://ardia.dev
AppSupportURL=https://github.com/ardia-browser/ardia/issues
DefaultDirName={localappdata}\Programs\Ardia
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir={#Out}
OutputBaseFilename=Ardia-Setup-{#Cpu}
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
ArchitecturesAllowed={#Allowed}
ArchitecturesInstallIn64BitMode={#Allowed}
SetupIconFile={#Icon}
UninstallDisplayIcon={app}\Ardia.ico
UninstallDisplayName=Ardia
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
ChangesAssociations=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#Source}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#Icon}"; DestDir: "{app}"; DestName: "Ardia.ico"; Flags: ignoreversion
#ifdef ShellManifest
Source: "{#ShellManifest}"; DestDir: "{app}"; DestName: "ardia-{#Shell}-files.txt"; Flags: ignoreversion
#endif
#ifdef RetiredList
Source: "{#RetiredList}"; DestName: "retired-shell.txt"; Flags: dontcopy
#endif

[Dirs]
Name: "{localappdata}\Ardia\User Data"

[UninstallDelete]
Type: files; Name: "{app}\debug.log"
Type: dirifempty; Name: "{app}"

[Registry]
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM"; ValueType: string; ValueName: ""; ValueData: "Ardia HTML Document"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM"; ValueType: string; ValueName: "AppUserModelId"; ValueData: "Ardia.Browser"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\Application"; ValueType: string; ValueName: "ApplicationName"; ValueData: "Ardia"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\Application"; ValueType: string; ValueName: "ApplicationIcon"; ValueData: "{app}\Ardia.exe,0"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\Application"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Browse the web"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\Application"; ValueType: string; ValueName: "ApplicationCompany"; ValueData: "Ardia"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\Application"; ValueType: string; ValueName: "AppUserModelId"; ValueData: "Ardia.Browser"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\Ardia.exe,0"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Ardia.exe""{#OpenSuffix} --single-argument %1"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia"; ValueType: string; ValueName: ""; ValueData: "Ardia"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "Ardia"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities"; ValueType: string; ValueName: "ApplicationIcon"; ValueData: "{app}\Ardia.exe,0"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Browse the web"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".htm"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".html"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".shtml"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".svg"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".webp"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".xht"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".xhtml"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\StartMenu"; ValueType: string; ValueName: "StartMenuInternet"; ValueData: "Ardia"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\URLAssociations"; ValueType: string; ValueName: "http"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\URLAssociations"; ValueType: string; ValueName: "https"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\Ardia.exe,0"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Ardia.exe""{#OpenSuffix}"
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "Ardia"; ValueData: "Software\Clients\StartMenuInternet\Ardia\Capabilities"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.htm\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.html\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.shtml\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.svg\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.webp\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.xht\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.xhtml\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue

[Icons]
Name: "{autoprograms}\Ardia"; Filename: "{app}\Ardia.exe"; Parameters: "{#LaunchSwitch}"; IconFilename: "{app}\Ardia.ico"; AppUserModelID: "Ardia.Browser"
Name: "{autodesktop}\Ardia"; Filename: "{app}\Ardia.exe"; Parameters: "{#LaunchSwitch}"; IconFilename: "{app}\Ardia.ico"; AppUserModelID: "Ardia.Browser"; Tasks: desktopicon

[Run]
Filename: "{app}\Ardia.exe"; Parameters: "{#LaunchSwitch}"; Description: "Open Ardia"; Flags: nowait postinstall skipifsilent
Filename: "{app}\Ardia.exe"; Parameters: "{#LaunchSwitch}"; Flags: nowait skipifnotsilent; Check: RelaunchAsked

[Code]
function CreateFile(Name: String; Access, Share, Security, Disposition, Flags, Template: Cardinal): Cardinal;
  external 'CreateFileW@kernel32.dll stdcall';
function CloseHandle(Handle: Cardinal): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

function RelaunchAsked: Boolean;
begin
  Result := ExpandConstant('{param:relaunch|0}') = '1';
end;

function InUse(Path: String): Boolean;
var
  Handle: Cardinal;
begin
  Result := False;
  if not FileExists(Path) then Exit;
  Handle := CreateFile(Path, $40000000, 0, 0, 3, $80, 0);
  if Handle = $FFFFFFFF then
    Result := True
  else
    CloseHandle(Handle);
end;

function AppInUse: Boolean;
begin
  Result := InUse(ExpandConstant('{app}\Ardia.exe')) or InUse(ExpandConstant('{app}\chrome.dll')) or InUse(ExpandConstant('{app}\ArdiaApp.dll'));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Waited: Integer;
begin
  Result := '';
  if not RelaunchAsked then Exit;
  Waited := 0;
  while AppInUse and (Waited < 30000) do
  begin
    Sleep(250);
    Waited := Waited + 250;
  end;
end;

#ifdef RetiredList
var
  RetiredShellFound: Boolean;

function RetiredEntryValid(Entry: String): Boolean;
begin
  Result := (Entry <> '') and (Pos('..', Entry) = 0) and (Pos(':', Entry) = 0) and (Pos('/', Entry) = 0) and (Copy(Entry, 1, 1) <> '\');
end;

procedure RemoveRetiredFile(Path: String; Removed: TStringList);
begin
  if not FileExists(Path) then Exit;
  if DeleteFile(Path) then
    Removed.Add(Path)
  else
    Log('Retired shell: could not remove ' + Path);
end;

procedure RemoveEmptyFolders(Folder, Path: String);
var
  Dir: String;
begin
  Dir := ExtractFileDir(Path);
  while (Length(Dir) > Length(Folder)) and (CompareText(Copy(Dir, 1, Length(Folder) + 1), Folder + '\') = 0) do
  begin
    if not RemoveDir(Dir) then Exit;
    Dir := ExtractFileDir(Dir);
  end;
end;

procedure RemoveRetiredInEachFolder(Folder, Name: String; Removed: TStringList);
var
  Found: TFindRec;
begin
  if Pos('\', Name) > 0 then Exit;
  if not FindFirst(Folder + '\*', Found) then Exit;
  try
    repeat
      if ((Found.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0) and (Found.Name <> '.') and (Found.Name <> '..') then
        RemoveRetiredFile(Folder + '\' + Found.Name + '\' + Name, Removed);
    until not FindNext(Found);
  finally
    FindClose(Found);
  end;
end;

procedure RemoveRetiredShell;
var
  Folder, Manifest, Entry: String;
  Entries: TArrayOfString;
  Removed: TStringList;
  I: Integer;
begin
  if not RetiredShellFound then Exit;
  Folder := ExpandConstant('{app}');
  if not FileExists(Folder + '\{#ShellMarker}') then
  begin
    Log('Retired shell: {#ShellMarker} is not installed, so the other shell''s files stay');
    Exit;
  end;
  Manifest := Folder + '\ardia-{#RetiredShell}-files.txt';
  if FileExists(Manifest) then
  begin
    if not LoadStringsFromFile(Manifest, Entries) then
    begin
      Log('Retired shell: ' + Manifest + ' could not be read, so the other shell''s files stay');
      Exit;
    end;
  end
  else
  begin
    ExtractTemporaryFile('retired-shell.txt');
    if not LoadStringsFromFile(ExpandConstant('{tmp}\retired-shell.txt'), Entries) then
    begin
      Log('Retired shell: the list of the other shell''s files could not be read');
      Exit;
    end;
  end;
  Removed := TStringList.Create;
  try
    for I := 0 to GetArrayLength(Entries) - 1 do
    begin
      Entry := Trim(Entries[I]);
      if not RetiredEntryValid(Entry) then
        Continue;
      if Copy(Entry, 1, 2) = '*\' then
        RemoveRetiredInEachFolder(Folder, Copy(Entry, 3, Length(Entry) - 2), Removed)
      else
        RemoveRetiredFile(Folder + '\' + Entry, Removed);
    end;
    for I := 0 to Removed.Count - 1 do
      RemoveEmptyFolders(Folder, Removed[I]);
    if FileExists(Manifest) and not DeleteFile(Manifest) then
      Log('Retired shell: could not remove ' + Manifest);
  finally
    Removed.Free;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    RetiredShellFound := FileExists(ExpandConstant('{app}\{#RetiredMarker}')) or FileExists(ExpandConstant('{app}\{#RetiredMarkerAlt}')) or FileExists(ExpandConstant('{app}\ardia-{#RetiredShell}-files.txt'))
  else if CurStep = ssPostInstall then
    RemoveRetiredShell;
end;
#endif
