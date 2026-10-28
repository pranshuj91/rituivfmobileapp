$ErrorActionPreference = 'Continue'
Write-Output ("PROCESS=" + $env:JAVA_HOME)
Write-Output ("USER=" + [Environment]::GetEnvironmentVariable('JAVA_HOME','User'))
Write-Output ("MACHINE=" + [Environment]::GetEnvironmentVariable('JAVA_HOME','Machine'))

# Check project overrides
$files = @(
  'android\gradle.properties',
  'android\local.properties',
  '.env',
  'android\gradle\wrapper\gradle-wrapper.properties'
)
foreach ($f in $files) {
  $p = Join-Path 'C:\Users\vibha\Desktop\Mobile call recording app\rituivfmobileapp' $f
  if (Test-Path $p) {
    Write-Output ("FILE: " + $f)
    Select-String -Path $p -Pattern 'JAVA|jdk|org.gradle.java' -SimpleMatch:$false | ForEach-Object { Write-Output ("  " + $_.Line) }
  }
}

# Check if Cursor/terminal injects JAVA_HOME via env files
$candidates = @(
  "$env:USERPROFILE\.gradle\gradle.properties",
  "$env:USERPROFILE\.cursor\argv.json"
)
foreach ($c in $candidates) {
  if (Test-Path $c) {
    Write-Output ("CHECK: " + $c)
    Select-String -Path $c -Pattern 'JAVA_HOME|jdk-17\.0\.19' -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ("  " + $_.Line) }
  }
}

Write-Output ("jdk17 exists=" + (Test-Path 'C:\Program Files\Java\jdk-17\bin\java.exe'))
Write-Output ("jdk21 exists=" + (Test-Path 'C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot\bin\java.exe'))
