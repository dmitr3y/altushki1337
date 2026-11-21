# Packs every .glb from the "models" folder into models.js so the game opens by double-click (no server).
$dir = Join-Path $PSScriptRoot 'models'
$items = @()
foreach ($f in Get-ChildItem (Join-Path $dir '*.glb')) {
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName))
  $name = $f.BaseName -replace "[^\w\-]", '_'
  $items += "{name:'$name',b64:'$b64'}"
  Write-Host "+ $($f.Name) ($([math]::Round($f.Length/1KB)) KB)"
}
$js = "window.ALT_MODELS=[`n" + ($items -join ",`n") + "`n];"
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'models.js'), $js, (New-Object Text.UTF8Encoding $false))
Write-Host "Done: $($items.Count) model(s) -> models.js"
