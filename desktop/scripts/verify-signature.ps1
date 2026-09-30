param(
  [Parameter(Mandatory)][string]$Path,
  [Parameter(Mandatory)][ValidatePattern('^[0-9A-Fa-f]{40}$')][string]$CertificateThumbprint
)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($signature.Status -ne 'Valid' -or
    $null -eq $signature.SignerCertificate -or
    $signature.SignerCertificate.Thumbprint -ne $CertificateThumbprint -or
    $null -eq $signature.TimeStamperCertificate) {
  throw 'Signed output requires a trusted, timestamped signature from the selected publisher certificate.'
}
