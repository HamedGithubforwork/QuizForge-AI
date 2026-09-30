$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Installer acceptance is restricted to disposable Windows CI runners.'
}

$package = Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json
$product = $package.build.productName
# electron-builder defaults to "${productName} ${version}" in Add/Remove Programs.
$displayName = "$product $($package.version)"
$installers = @(Get-ChildItem (Join-Path $PSScriptRoot '../dist') -Filter '*.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one preview installer.' }
$registryRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
function Find-Registration {
    if (-not (Test-Path $registryRoot)) { return }
    @(Get-ChildItem $registryRoot | ForEach-Object { Get-ItemProperty $_.PSPath } |
        Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq $displayName })
}
if (@(Find-Registration).Count -ne 0) { throw 'A prior installation exists; refusing to alter it.' }

$installDir = Join-Path $env:LOCALAPPDATA ('Programs\QFN-Acceptance-' + [guid]::NewGuid().ToString('N'))
$executable = Join-Path $installDir ($product + '.exe')
$uninstaller = Join-Path $installDir ('Uninstall ' + $product + '.exe')
function Wait-Helper($process, [int]$milliseconds, [string]$label) {
    if (-not $process.WaitForExit($milliseconds)) {
        $process.Kill($true)
        if (-not $process.WaitForExit(10000)) { throw "$label could not be terminated." }
        throw "$label timed out and was terminated."
    }
    if ($process.ExitCode -ne 0) { throw "$label exit code $($process.ExitCode)." }
}
$running = $null
try {
    $install = Start-Process -FilePath $installers[0].FullName -ArgumentList @('/S', '/currentuser', "/D=$installDir") -PassThru
    Wait-Helper $install 120000 'Installation'
    if (-not (Test-Path $executable) -or -not (Test-Path $uninstaller)) { throw 'Installed files are missing.' }
    if (@(Find-Registration).Count -ne 1) { throw 'Per-user uninstall registration is missing.' }
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
    if ($null -ne $running -and -not $running.HasExited) {
        $running.Kill($true)
        if (-not $running.WaitForExit(10000)) { throw 'App cleanup did not finish.' }
    }
    try {
      if (Test-Path $uninstaller) {
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser', "_?=$installDir") -PassThru
        Wait-Helper $uninstall 60000 'Uninstallation'
        # NSIS can hand off to a temporary uninstaller process.
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while (((Test-Path $executable) -or @(Find-Registration).Count -ne 0) -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 500
        }
        if ((Test-Path $executable) -or @(Find-Registration).Count -ne 0) { throw 'Uninstallation left application files or registration.' }
        Write-Output 'Per-user uninstallation passed.'
      }
    } finally {
        # Only this invocation's generated directory may be removed. Never delete
        # arbitrary userData or a prior installation; those were rejected above.
        if (Test-Path $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
        foreach ($entry in @(Find-Registration)) {
            if ($entry.PSObject.Properties['UninstallString'] -and
                $entry.UninstallString.Contains($uninstaller)) {
                Remove-Item -LiteralPath $entry.PSPath -Recurse -Force
            }
        }
    }
}
