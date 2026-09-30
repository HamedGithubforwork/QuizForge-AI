# Disposable CI only: no release certificate, private-key export or publication.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Update signature acceptance is restricted to disposable Windows CI runners.'
}
$installers = @(Get-ChildItem (Join-Path $PSScriptRoot '../dist') -Filter '*.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one unsigned preview installer.' }
if ((Get-AuthenticodeSignature $installers[0].FullName).Status -ne 'NotSigned') {
    throw 'This test requires the unsigned preview, not a release signing key.'
}
$root = Join-Path $env:RUNNER_TEMP ('qfn-update-signatures-' + [guid]::NewGuid().ToString('N'))
$certificates = @()
New-Item -ItemType Directory -Path $root | Out-Null
try {
    foreach ($name in @('expected', 'other')) {
        $subject = 'CN=QFN CI ' + $name + ' ' + [guid]::NewGuid().ToString('N')
        $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject `
            -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy NonExportable `
            -HashAlgorithm SHA256 -NotAfter (Get-Date).AddHours(6)
        $certificates += $certificate
        $publicFile = Join-Path $root "$name.cer"
        Export-Certificate -Cert $certificate -FilePath $publicFile | Out-Null
        Import-Certificate -FilePath $publicFile -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
        Import-Certificate -FilePath $publicFile -CertStoreLocation 'Cert:\CurrentUser\TrustedPublisher' | Out-Null
        $file = Join-Path $root "$name.exe"
        Copy-Item -LiteralPath $installers[0].FullName -Destination $file
        $signature = Set-AuthenticodeSignature -FilePath $file -Certificate $certificate -HashAlgorithm SHA256
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
            throw 'Disposable signing fixture could not be verified by Windows.'
        }
    }
    Copy-Item -LiteralPath $installers[0].FullName -Destination (Join-Path $root 'unsigned.exe')
    $tampered = Join-Path $root 'tampered.exe'
    Copy-Item -LiteralPath (Join-Path $root 'expected.exe') -Destination $tampered
    # Change a byte in the PE DOS stub, outside the checksum/security-directory exceptions.
    $stream = [IO.File]::Open($tampered, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite)
    try {
        $stream.Position = 80
        $byte = $stream.ReadByte()
        if ($byte -lt 0) { throw 'Invalid PE fixture.' }
        $stream.Position = 80
        $stream.WriteByte([byte]($byte -bxor 1))
    } finally { $stream.Dispose() }
    if ((Get-AuthenticodeSignature $tampered).Status -eq 'Valid') { throw 'Tampering did not invalidate the fixture.' }
    @{ publisherName = $certificates[0].Subject } | ConvertTo-Json |
        Set-Content (Join-Path $root 'publisher.json') -Encoding utf8NoBOM
    & (Join-Path $PSScriptRoot '../node_modules/.bin/electron.cmd') (Join-Path $PSScriptRoot 'update-signatures.cjs') $root
    if ($LASTEXITCODE -ne 0) { throw 'Real Windows update signature acceptance failed.' }
} finally {
    foreach ($certificate in $certificates) {
        foreach ($store in @('Root', 'TrustedPublisher', 'My')) {
            $certificatePath = "Cert:\CurrentUser\$store\$($certificate.Thumbprint)"
            if (Test-Path $certificatePath) {
                if ($store -eq 'My') { Remove-Item -LiteralPath $certificatePath -DeleteKey -Force }
                else { Remove-Item -LiteralPath $certificatePath -Force }
            }
        }
    }
    if (Test-Path $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
Write-Output 'Disposable update certificates and signed fixtures removed; nothing published.'
