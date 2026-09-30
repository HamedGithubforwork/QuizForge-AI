# Run on the owner's Windows signing machine. No certificate/key is exported.
param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ReviewedCommit,
  [Parameter(Mandatory)][ValidatePattern('^[0-9A-Fa-f]{40}$')][string]$CertificateThumbprint,
  [switch]$EnableUpdates
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Signed desktop builds require Windows PowerShell 7.' }
Push-Location (Join-Path $PSScriptRoot '..')
try {
  $head = git rev-parse HEAD
  if ($LASTEXITCODE -ne 0 -or $head -ne $ReviewedCommit) { throw 'Checkout must match the reviewed commit.' }
  $dirty = git status --porcelain
  if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Use a clean reviewed checkout.' }
  foreach ($name in @('CSC_LINK', 'WIN_CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_KEY_PASSWORD')) {
    if ([Environment]::GetEnvironmentVariable($name)) { throw 'Remove file-based signing overrides; use the selected Windows certificate.' }
  }
  $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$CertificateThumbprint" -ErrorAction SilentlyContinue
  if ($null -eq $certificate -or -not $certificate.HasPrivateKey -or $certificate.NotAfter -le (Get-Date)) {
    throw 'The selected current-user signing certificate and private key must be available and unexpired.'
  }
  $output = 'dist-signed'
  if (Test-Path $output) { throw 'Move the previous dist-signed output before building a new candidate.' }
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  & npm.cmd audit --audit-level=moderate
  if ($LASTEXITCODE -ne 0) { throw 'Dependency audit failed.' }
  & npm.cmd test
  if ($LASTEXITCODE -ne 0) { throw 'Desktop tests failed.' }
  $updateArguments = @()
  if ($EnableUpdates) { $updateArguments = @('--config', 'build/update-enabled.cjs') }
  & npx.cmd --no-install electron-builder @updateArguments --win nsis --x64 --publish never "-c.directories.output=$output" '-c.forceCodeSigning=true' "-c.win.signtoolOptions.certificateSha1=$CertificateThumbprint"
  if ($LASTEXITCODE -ne 0) { throw 'Signed packaging failed; do not distribute its output.' }
  $package = Get-Content package.json -Raw | ConvertFrom-Json
  $installers = @(Get-ChildItem $output -Filter '*.exe' -File)
  if ($installers.Count -ne 1) { throw 'Expected exactly one signed installer.' }
  $application = Join-Path $output "win-unpacked/$($package.build.productName).exe"
  foreach ($file in @($installers[0].FullName, $application)) {
    & (Join-Path $PSScriptRoot 'verify-signature.ps1') -Path $file -CertificateThumbprint $CertificateThumbprint
  }
  if ($EnableUpdates) {
    & node (Join-Path $PSScriptRoot 'verify-update-build.cjs') $output
    if ($LASTEXITCODE -ne 0) { throw 'Update metadata verification failed; do not publish.' }
  }
  [ordered]@{
    schema = 1
    updatesEnabled = [bool]$EnableUpdates
    version = $package.version
    commit = $head
    certificateThumbprint = $CertificateThumbprint.ToUpperInvariant()
    installer = $installers[0].Name
    sha256 = (Get-FileHash -LiteralPath $installers[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  } | ConvertTo-Json | Set-Content (Join-Path $output 'verified-candidate.json') -Encoding utf8
  Write-Host 'Signed internal candidate verified. Manual acceptance is still required; nothing was published.'
} finally { Pop-Location }
