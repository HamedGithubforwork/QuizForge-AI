# Run only after build-signed.ps1 -EnableUpdates and manual Windows acceptance.
param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ReviewedCommit,
  [Parameter(Mandatory)][ValidatePattern('^[0-9A-Fa-f]{40}$')][string]$CertificateThumbprint,
  [Parameter(Mandatory)][string]$NotesFile
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Release verification requires Windows PowerShell 7.' }
$notes = (Resolve-Path -LiteralPath $NotesFile).Path
Push-Location (Join-Path $PSScriptRoot '..')
try {
  $head = git rev-parse HEAD
  if ($LASTEXITCODE -ne 0 -or $head -ne $ReviewedCommit) { throw 'Checkout must match the reviewed commit.' }
  $dirty = git status --porcelain
  if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Use a clean reviewed checkout.' }
  $candidate = Get-Content 'dist-signed/verified-candidate.json' -Raw | ConvertFrom-Json
  $package = Get-Content 'package.json' -Raw | ConvertFrom-Json
  if ($candidate.schema -ne 1 -or $candidate.updatesEnabled -ne $true -or
      $candidate.commit -ne $head -or $candidate.version -ne $package.version -or
      $candidate.certificateThumbprint -ne $CertificateThumbprint.ToUpperInvariant() -or
      [IO.Path]::GetFileName($candidate.installer) -ne $candidate.installer) {
    throw 'Candidate provenance does not match the reviewed signed build.'
  }
  $installer = Join-Path 'dist-signed' $candidate.installer
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidate.sha256) {
    throw 'Installer has changed since verification.'
  }
  & (Join-Path $PSScriptRoot 'verify-signature.ps1') -Path $installer -CertificateThumbprint $CertificateThumbprint
  & node (Join-Path $PSScriptRoot 'verify-update-build.cjs') 'dist-signed'
  if ($LASTEXITCODE -ne 0) { throw 'Update metadata verification failed.' }
  if (-not (Test-Path -LiteralPath "$installer.blockmap")) { throw 'Installer blockmap is missing.' }
  & gh release create "v$($package.version)" $installer "$installer.blockmap" 'dist-signed/latest.yml' 'dist-signed/verified-candidate.json' --repo HamedGithubforwork/QuizForge-AI --target $ReviewedCommit --draft --title "Quiz From Notes $($package.version)" --notes-file $notes
  if ($LASTEXITCODE -ne 0) { throw 'Draft creation failed; inspect existing releases before retrying.' }
  Write-Host 'Draft uploaded. Review and publish it only after Windows upgrade acceptance; installed apps ignore drafts.'
} finally { Pop-Location }
