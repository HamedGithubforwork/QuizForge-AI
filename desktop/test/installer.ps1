$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Installer acceptance is restricted to disposable Windows CI runners.'
}

$package = Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json
$product = $package.build.productName
$installers = @(Get-ChildItem (Join-Path $PSScriptRoot '../dist') -Filter '*.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one preview installer.' }
$registryRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
function Find-Registration {
    @(Get-ChildItem $registryRoot | ForEach-Object { Get-ItemProperty $_.PSPath } |
        Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq $product })
}
if ((Find-Registration).Count -ne 0) { throw 'A prior installation exists; refusing to alter it.' }

$installDir = Join-Path $env:LOCALAPPDATA ('Programs\QFN-Acceptance-' + [guid]::NewGuid().ToString('N'))
$executable = Join-Path $installDir ($product + '.exe')
$uninstaller = Join-Path $installDir ('Uninstall ' + $product + '.exe')
$running = $null
try {
    $install = Start-Process -FilePath $installers[0].FullName -ArgumentList @('/S', '/currentuser', "/D=$installDir") -PassThru
    if (-not $install.WaitForExit(120000)) { throw 'Installation timed out.' }
    if ($install.ExitCode -ne 0) { throw "Installer exit code $($install.ExitCode)." }
    if (-not (Test-Path $executable) -or -not (Test-Path $uninstaller)) { throw 'Installed files are missing.' }
    if ((Find-Registration).Count -ne 1) { throw 'Per-user uninstall registration is missing.' }
    Write-Output 'Per-user installation passed.'

    $running = Start-Process -FilePath $executable -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        Start-Sleep -Milliseconds 500
        $running.Refresh()
        if ($running.HasExited) { throw 'Packaged application exited before displaying a window.' }
    } while ($running.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($running.MainWindowHandle -eq 0) { throw 'Packaged application did not display a window.' }
    if ($running.MainWindowTitle -notlike 'Quiz From Notes*') { throw 'Packaged application displayed an unexpected window.' }
    if (-not $running.CloseMainWindow() -or -not $running.WaitForExit(15000)) {
        throw 'Packaged application did not close cleanly.'
    }
    Write-Output 'Packaged application launch and graceful close passed.'
} finally {
    if ($null -ne $running -and -not $running.HasExited) { Stop-Process -Id $running.Id -Force }
    if (Test-Path $uninstaller) {
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser') -PassThru
        if (-not $uninstall.WaitForExit(60000)) { throw 'Uninstallation timed out.' }
        if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exit code $($uninstall.ExitCode)." }
        # NSIS can hand off to a temporary uninstaller process.
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while (((Test-Path $executable) -or (Find-Registration).Count -ne 0) -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 500
        }
        if ((Test-Path $executable) -or (Find-Registration).Count -ne 0) { throw 'Uninstallation left application files or registration.' }
        Write-Output 'Per-user uninstallation passed.'
    }
}
