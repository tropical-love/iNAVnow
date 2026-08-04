# iNAVnow 로컬 서버 관리
#   manage.bat 을 더블클릭하면 메뉴가 뜬다. 개별 동작만 하려면 -Op 로 직접 부른다.
#   예) powershell -File manage.ps1 -Op status
param([ValidateSet('install', 'uninstall', 'start', 'stop', 'status')][string]$Op)

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$TASK = 'ETF iNAV Local'
$PORT = 3456
$DIR = $PSScriptRoot
$URL = "http://localhost:$PORT"

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Get-Task { Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue }
function Get-ServerPid {
  (Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
}
function Wait-Port([int]$sec = 8) {
  for ($i = 0; $i -lt $sec * 2; $i++) { if (Get-ServerPid) { return $true }; Start-Sleep -Milliseconds 500 }
  return [bool](Get-ServerPid)
}

function Show-Status {
  $t = Get-Task
  $id = Get-ServerPid
  Write-Host ''
  if ($id) {
    $sess = (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).SessionId
    Write-Host "  서버   : 실행 중  ($URL, PID $id$(if ($sess -eq 0) { ', 창 없음' }))" -ForegroundColor Green
  }
  else { Write-Host '  서버   : 중지' -ForegroundColor DarkGray }
  if ($t) {
    $auto = if ($t.State -eq 'Disabled') { '사용 안 함' } else { '켜짐 (로그온 시 시작 + 1분마다 생존 확인)' }
    $win = if ($t.Principal.LogonType -eq 'S4U') { '창 없음' } else { '콘솔 창 뜸' }
    Write-Host "  자동시작: $auto"
    Write-Host "  등록방식: $($t.Principal.LogonType) — $win"
  }
  else { Write-Host '  자동시작: 등록 안 됨' -ForegroundColor DarkGray }
  Write-Host ''
}

function Install-Task {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    Write-Host '[X] Node.js를 찾을 수 없습니다. https://nodejs.org 에서 설치(18 이상, 20 권장) 후 다시 실행하세요.' -ForegroundColor Red
    return
  }
  if (-not (Test-Path (Join-Path $DIR 'server.js'))) {
    Write-Host "[X] 같은 폴더에 server.js가 없습니다: $DIR" -ForegroundColor Red
    return
  }
  $action = New-ScheduledTaskAction -Execute $node -Argument 'server.js' -WorkingDirectory $DIR
  $trigger = @(
    (New-ScheduledTaskTrigger -AtLogOn),
    (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1))
  )
  # IgnoreNew = 이미 돌고 있으면 새로 띄우지 않음. 1분 트리거가 곧 생존 확인이 된다.
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -Hidden
  $desc = "iNAVnow 로컬 서버 ($URL) - 로그온 시 시작, 1분마다 살아있는지 확인해 죽었으면 재시작"

  # S4U는 세션 0에서 돌아 콘솔 창이 아예 생기지 않는다. 권한이 없으면 Interactive로 내려간다.
  foreach ($logon in 'S4U', 'Interactive') {
    try {
      $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType $logon -RunLevel Limited
      Register-ScheduledTask -TaskName $TASK -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -Description $desc -Force -ErrorAction Stop | Out-Null
      Write-Host "[OK] 등록 완료 ($logon)" -ForegroundColor Green
      if ($logon -eq 'Interactive') {
        Write-Host '     콘솔 창이 함께 뜹니다. 관리자 권한으로 다시 등록하면 창 없이 돕니다.' -ForegroundColor Yellow
      }
      Start-ScheduledTask -TaskName $TASK
      if (Wait-Port) { Write-Host "[OK] $URL 접속 가능" -ForegroundColor Green }
      else { Write-Host '[!] 서버가 아직 안 떴습니다. 잠시 후 상태(5)를 확인하세요.' -ForegroundColor Yellow }
      return
    }
    catch { }
  }
  Write-Host '[X] 등록 실패 — 관리자 권한이 필요합니다.' -ForegroundColor Red
}

function Uninstall-Task {
  if (-not (Get-Task)) { Write-Host '[-] 등록된 작업이 없습니다.' -ForegroundColor DarkGray }
  else {
    Stop-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue
    try {
      Unregister-ScheduledTask -TaskName $TASK -Confirm:$false -ErrorAction Stop
      Write-Host '[OK] 자동 시작 등록을 삭제했습니다.' -ForegroundColor Green
    }
    catch {
      Write-Host '[X] 삭제 실패 — 관리자 권한이 필요합니다.' -ForegroundColor Red
      return
    }
  }
  Stop-Server
}

function Stop-Server {
  # 작업을 사용 안 함으로 바꿔야 1분 트리거가 다시 띄우지 않는다.
  if (Get-Task) {
    Disable-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue | Out-Null
    Stop-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue
  }
  # 작업 밖에서 직접 띄운 경우 대비 (세션 0 프로세스는 여기서 안 죽지만 위에서 이미 내려간다)
  # 포트만 보고 죽이면 3456을 쓰는 남의 프로그램을 끈다 — 서버가 남긴 PID 파일과 일치할 때만 죽인다.
  # (명령줄에 server.js가 있는지 보는 폴백은 다른 폴더의 동명 서버까지 오인해서 뺐다)
  $id = Get-ServerPid
  if ($id) {
    $recorded = Get-Content (Join-Path $DIR 'server.pid') -ErrorAction SilentlyContinue
    if ($recorded -eq "$id") { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    else { Write-Host "[!] 포트 $PORT 의 PID $id 가 server.pid($recorded)와 달라 건드리지 않았습니다. 직접 확인하세요." -ForegroundColor Yellow }
  }
  Start-Sleep -Milliseconds 900
  if (Get-ServerPid) { Write-Host "[!] 포트 $PORT 가 아직 열려 있습니다." -ForegroundColor Yellow }
  else { Write-Host '[OK] 서버를 종료했습니다 (자동 재시작도 중지).' -ForegroundColor Green }
}

function Start-Server {
  if (-not (Get-Task)) { Write-Host '[X] 먼저 [1] 서비스 등록을 해주세요.' -ForegroundColor Red; return }
  Enable-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue | Out-Null
  Start-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue
  if (Wait-Port) { Write-Host "[OK] $URL 접속 가능" -ForegroundColor Green; Start-Process $URL }
  else { Write-Host '[!] 아직 안 떴습니다. 상태(5)를 확인하세요.' -ForegroundColor Yellow }
}

# 등록·삭제만 관리자 권한이 필요하다. 메뉴 전체를 관리자로 띄우면 매번 UAC가 뜨므로 그 동작만 올려 보낸다.
function Invoke-Elevated([string]$op) {
  try {
    Start-Process -FilePath (Get-Process -Id $PID).Path -Verb RunAs -Wait -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Op', $op)
  }
  catch { Write-Host '[X] 관리자 권한 요청이 취소되었습니다.' -ForegroundColor Yellow }
}

switch ($Op) {
  'install' { Install-Task; Write-Host ''; Read-Host '엔터를 누르면 닫힙니다'; return }
  'uninstall' { Uninstall-Task; Write-Host ''; Read-Host '엔터를 누르면 닫힙니다'; return }
  'start' { Start-Server; return }
  'stop' { Stop-Server; return }
  'status' { Show-Status; return }
}

while ($true) {
  Clear-Host
  Write-Host '  iNAVnow 로컬 서버 관리' -ForegroundColor Cyan
  Write-Host "  $DIR" -ForegroundColor DarkGray
  Show-Status
  Write-Host '   1) 서비스 등록 + 시작   (관리자 권한 필요)'
  Write-Host '   2) 서비스 삭제          (관리자 권한 필요)'
  Write-Host '   3) 서버 시작'
  Write-Host '   4) 서버 종료            (자동 재시작도 중지)'
  Write-Host '   5) 브라우저로 열기'
  Write-Host '   0) 나가기'
  Write-Host ''
  switch (Read-Host '  번호') {
    '1' { if (Test-Admin) { Install-Task } else { Invoke-Elevated 'install' }; Read-Host '  엔터' | Out-Null }
    '2' { if (Test-Admin) { Uninstall-Task } else { Invoke-Elevated 'uninstall' }; Read-Host '  엔터' | Out-Null }
    '3' { Start-Server; Read-Host '  엔터' | Out-Null }
    '4' { Stop-Server; Read-Host '  엔터' | Out-Null }
    '5' { Start-Process $URL }
    '0' { return }
    default { }
  }
}
