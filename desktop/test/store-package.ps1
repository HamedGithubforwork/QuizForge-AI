$ErrorActionPreference = 'Stop'
# Inspect the actual unsigned build. No certificate import, installation or upload.
$packages = @(Get-ChildItem (Join-Path $PSScriptRoot '../dist/store') -Filter '*.appx' -File)
if ($packages.Count -ne 1) { throw 'Expected one Store package.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($packages[0].FullName)
try {
  $entry = $zip.GetEntry('AppxManifest.xml')
  if (-not $entry) { throw 'Store manifest missing.' }
  $reader = [System.IO.StreamReader]::new($entry.Open())
  try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
  if ($manifest.Package.Identity.Name -cne $env:QFN_STORE_IDENTITY_NAME -or
      $manifest.Package.Identity.Publisher -cne $env:QFN_STORE_PUBLISHER -or
      $manifest.Package.Properties.PublisherDisplayName -cne $env:QFN_STORE_PUBLISHER_DISPLAY_NAME -or
      $manifest.Package.Properties.DisplayName -cne $env:QFN_STORE_DISPLAY_NAME) { throw 'Store identity mismatch.' }
  $version = (Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
  if ($manifest.Package.Identity.Version -cne "$version.0") { throw 'Unexpected Store version.' }
  $app = $manifest.Package.Applications.Application
  if ($app.Id -cne 'QuizFromNotes' -or $app.EntryPoint -cne 'Windows.FullTrustApplication') { throw 'Unexpected application entry point.' }
  $protocols = @($app.Extensions.Extension | Where-Object Category -eq 'windows.protocol')
  $expectedProtocol = (& node -e "process.stdout.write(require('./src/native-protocol.cjs').PROTOCOL)")
  if ($LASTEXITCODE -ne 0 -or $protocols.Count -ne 1 -or $protocols[0].Protocol.Name -cne $expectedProtocol) { throw 'Browser callback protocol missing.' }
  if (@($app.Extensions.Extension | Where-Object Category -eq 'windows.startupTask').Count) { throw 'Unexpected automatic startup.' }
  if ($zip.Entries.FullName -match '(^|/)app-update.yml$' -or $zip.GetEntry('AppxSignature.p7x')) { throw 'Fixture must be unsigned and have no external update feed.' }
  if (-not $zip.GetEntry('app/resources/app.asar')) { throw 'Packaged app missing.' }
  $capabilities = @($manifest.Package.Capabilities.ChildNodes | Where-Object NodeType -eq 'Element' | ForEach-Object { $_.Name })
  if ((($capabilities | Sort-Object) -join ',') -cne 'internetClient,runFullTrust') { throw 'Unexpected Store capabilities.' }
  Write-Host 'Unsigned Store fixture: identity, version, callback protocol, capabilities, packaged app and absence of an external update feed verified. Not installed or submitted.'
} finally { $zip.Dispose() }
