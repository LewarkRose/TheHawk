# Take a dated, self-contained snapshot of the whole of HAWK, for the case where
# GitHub is not there any more.
#
# Two halves, and the second is the one that matters:
#
#   1. The repository, INCLUDING .git. Not just the files — the whole history, so the
#      zip can be cloned straight back into a working repo with every commit intact.
#   2. The live data files. These are NOT in the repository: build_data.py and
#      grade.mjs generate them on each Action run and publish them to Pages, so they
#      exist only on the deployed site. graded.json and grading/state.json hold the
#      self-grading record — hundreds of matches that accumulated one run at a time
#      from predictions saved BEFORE each kick-off. Lose those and they cannot be
#      rebuilt from anything, at any price. The code could be rewritten; this could not.
#      (profiles/, players/ and props/ are deliberately skipped: they are rebuilt from
#      StatsHub and football-data every three hours, so they cost space and lose nothing.)
#
# The zip lands on the Desktop, in "HAWK Backup". Deliberately NOT OneDrive — asked for
# on the PC itself. Worth knowing what that costs: these copies live on one disk, so
# they cover GitHub going away but not the disk going with them. A copy onto any USB
# stick now and then closes that gap.
#
# Run it by right-clicking -> Run with PowerShell, or:  powershell -File backup-site.ps1
# Restoring: unzip, then `git clone repo TheHawk` for the code; the data folder is
# dropped back in beside index.html.

$ErrorActionPreference = "Stop"
$repo   = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest   = Join-Path ([Environment]::GetFolderPath('Desktop')) "HAWK Backup"
$site   = "https://lewarkrose.github.io/TheHawk"
$keep   = 4
$stamp  = Get-Date -Format "yyyy-MM-dd"
$stage  = Join-Path $env:TEMP "hawk-backup-$stamp"
$zip    = Join-Path $dest "TheHawk-full-$stamp.zip"

New-Item -ItemType Directory -Force -Path $dest | Out-Null
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $stage "data\grading") | Out-Null

# robocopy in one pass: it takes hidden folders (.git) without being asked, so there is
# no second copy of the history. Exit codes under 8 are success for robocopy.
Write-Host "1/3  copying the repository with its .git history..."
$null = robocopy $repo (Join-Path $stage "repo") /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }
$global:LASTEXITCODE = 0

Write-Host "2/3  downloading the live data files..."
$files = @("data/graded.json", "data/grading/state.json", "data/predictions.json", "data/fixtures.json")
$got = 0
foreach ($f in $files) {
    $out = Join-Path $stage $f.Replace("/", "\")
    try {
        Invoke-WebRequest -Uri "$site/$f`?t=$(Get-Random)" -OutFile $out -UseBasicParsing -TimeoutSec 60
        "     {0,-28} {1,9:N0} B" -f $f, (Get-Item $out).Length | Write-Host
        $got++
    } catch { Write-Warning "could not fetch $f - $($_.Exception.Message)" }
}
if ($got -eq 0) { throw "no data files downloaded - check the site is up before trusting this backup" }

Write-Host "3/3  zipping..."
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
# NOT Compress-Archive: it silently skips hidden items, so `.git` is left out and you
# get a backup that looks fine and has no history in it at all. ZipFile takes everything.
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
# Prove the history actually went in, rather than trusting that it did.
$z = [IO.Compression.ZipFile]::OpenRead($zip)
# .NET writes entry names with backslashes on Windows, so normalise before matching —
# checking for "repo/.git/" alone finds nothing and condemns a perfectly good backup.
$gitEntries = ($z.Entries | Where-Object { ($_.FullName -replace '\\', '/') -like "repo/.git/*" }).Count
$z.Dispose()
Remove-Item -LiteralPath $stage -Recurse -Force
if ($gitEntries -eq 0) { throw "the zip has no .git in it - the history did not get backed up" }
Write-Host "     .git objects included: $gitEntries"

Get-ChildItem $dest -Filter "TheHawk-full-*.zip" | Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $keep | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force; Write-Host "     removed old: $($_.Name)" }

"{0}  ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB) | Write-Host -ForegroundColor Green
Write-Host "Kept $((Get-ChildItem $dest -Filter 'TheHawk-full-*.zip').Count) snapshot(s) in $dest"
