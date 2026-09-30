$ErrorActionPreference = 'Stop'
foreach ($file in Get-ChildItem (Join-Path $PSScriptRoot '../scripts') -Filter '*.ps1') {
  $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$parseErrors) | Out-Null
  if ($parseErrors.Count) { throw 'Signing script contains syntax errors.' }
}
$installers = @(Get-ChildItem (Join-Path $PSScriptRoot '../dist') -Filter '*.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected the CI unsigned preview installer.' }
$rejected = $false
try {
  & (Join-Path $PSScriptRoot '../scripts/verify-signature.ps1') -Path $installers[0].FullName -CertificateThumbprint ('0' * 40)
} catch {
  if ($_.Exception.Message -ne 'Signed output requires a trusted, timestamped signature from the selected publisher certificate.') { throw }
  $rejected = $true
}
if (-not $rejected) { throw 'Unsigned preview passed the signed-output gate.' }
Write-Host 'Signing scripts parse, and the real unsigned installer is rejected.'
