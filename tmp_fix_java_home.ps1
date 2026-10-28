$ErrorActionPreference = 'Stop'

# Prefer JDK 17 if present, else Adoptium 21
$candidates = @(
  'C:\Program Files\Java\jdk-17',
  'C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'
)

$jdk = $null
foreach ($c in $candidates) {
  if (Test-Path (Join-Path $c 'bin\java.exe')) {
    $jdk = $c
    break
  }
}
if (-not $jdk) { throw 'No valid JDK found' }

[Environment]::SetEnvironmentVariable('JAVA_HOME', $jdk, 'User')
$env:JAVA_HOME = $jdk

# Remove broken Adoptium 17 path from User PATH if present
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
  $parts = @($userPath -split ';' | Where-Object {
    $_ -and ($_ -notmatch 'jdk-17\.0\.19\.10-hotspot')
  })
  $bin = Join-Path $jdk 'bin'
  if ($parts -notcontains $bin) { $parts = @($bin) + $parts }
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
}

Write-Output ("SET_JAVA_HOME=" + $jdk)
& (Join-Path $jdk 'bin\java.exe') -version 2>&1 | ForEach-Object { "$_" }
