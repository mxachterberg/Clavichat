<#
  Clavichat - Update auf den Webserver bringen (WinSCP), nach publish-update.js.

  Reihenfolge: zuerst die Programme, zuletzt die Update-Liste - so laedt keine
  App eine Liste, deren Dateien noch fehlen. Danach loescht es auf dem Server
  aeltere Fassungen: jede Clavichat-*.exe im Download-Ordner, die die neue
  Liste nicht mehr nennt. Andere Dateien fasst es nicht an.

    powershell -ExecutionPolicy Bypass -File scripts\upload-update.ps1 -Dir "<Webroot>\downloads\clavichat"

  -Session  gespeicherte WinSCP-Sitzung (Standard: achterberg.dev; das
            Passwort steht nur dort, dieses Skript sieht es nie)
  -Remote   Ordner auf dem Server (Standard: /public_html/downloads/clavichat)
  -WhatIf   nur zeigen, was passieren wuerde
#>
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$Session = 'achterberg.dev',
  [string]$Remote = '/public_html/downloads/clavichat',
  [string]$WinScp = 'C:\Program Files (x86)\WinSCP\WinSCP.com',
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'

function Invoke-WinScp([string[]]$lines) {
  $file = [System.IO.Path]::GetTempFileName()
  try {
    Set-Content -LiteralPath $file -Value $lines -Encoding UTF8
    $out = & $WinScp /script="$file"
    if ($LASTEXITCODE -ne 0) { throw ("WinSCP endete mit Code $LASTEXITCODE`n" + ($out -join "`n")) }
    return $out
  } finally {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
}

# Die neue Update-Liste: Was sie nennt, kommt hoch und bleibt.
$listFile = Join-Path $Dir 'update.json'
if (-not (Test-Path -LiteralPath $listFile)) { throw "update.json fehlt in $Dir - zuerst publish-update.js." }
$manifest = (Get-Content -Raw -Encoding UTF8 -LiteralPath $listFile | ConvertFrom-Json).data | ConvertFrom-Json
$keep = @()
foreach ($f in $manifest.files.PSObject.Properties.Value) {
  $local = Join-Path $Dir $f.name
  if (-not (Test-Path -LiteralPath $local)) { throw "$($f.name) fehlt in $Dir." }
  if ((Get-Item -LiteralPath $local).Length -ne [long]$f.size) { throw "$($f.name) passt nicht zur Update-Liste (Groesse)." }
  $keep += $f.name
}
Write-Output ("Clavichat " + $manifest.version + ": " + ($keep -join ', '))

# Was liegt auf dem Server?
$listing = Invoke-WinScp @('option batch abort', 'option confirm off', "open $Session", "ls $Remote", 'exit')
$onServer = @()
foreach ($line in $listing) {
  if ($line -match '\s(Clavichat-[A-Za-z0-9.\-]+\.exe)\s*$') { $onServer += $Matches[1] }
}
# Nur Fassungen mit Versionsnummer loeschen - nie etwas anderes.
$old = @($onServer | Where-Object { ($keep -notcontains $_) -and ($_ -match '^Clavichat-(Setup-)?\d+\.\d+\.\d+(-portable)?\.exe$') })

if ($WhatIf) {
  Write-Output ('Hochladen (falls neuer): ' + ($keep -join ', ') + ', update.json')
  Write-Output ('Auf dem Server loeschen: ' + $(if ($old.Count) { $old -join ', ' } else { '(nichts)' }))
  return
}

$script = @('option batch abort', 'option confirm off', "open $Session", "cd $Remote")
# -neweronly: schon hochgeladene, gleiche Dateien nicht noch einmal uebertragen.
foreach ($name in $keep) { $script += 'put -neweronly -permissions=644 "' + (Join-Path $Dir $name) + '" ./' }
$script += 'put -neweronly -permissions=644 "' + $listFile + '" ./'
foreach ($name in $old) { $script += "rm `"$name`"" }
$script += @('ls', 'exit')
$out = Invoke-WinScp $script
$out | Where-Object { $_ -match '\.exe|update\.json' } | ForEach-Object { Write-Output $_ }
Write-Output ('Geloescht: ' + $(if ($old.Count) { $old -join ', ' } else { '(nichts)' }))
