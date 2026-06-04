$ErrorActionPreference = "Stop"
$pkgPath = "package.json"
if (Test-Path $pkgPath) {
  $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
  if (-not $pkg.engines) { $pkg | Add-Member -NotePropertyName engines -NotePropertyValue (@{}) }
  $pkg.engines | Add-Member -NotePropertyName node -NotePropertyValue ">=22" -Force
  ($pkg | ConvertTo-Json -Depth 100) | Set-Content $pkgPath -Encoding UTF8
  Write-Host "package.json updated: engines.node = >=22"
} else {
  Write-Host "package.json not found in current dir"
}
