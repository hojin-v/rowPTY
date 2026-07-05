# rowpty

**Reserved-Row ConPTY Host** — Windows 터미널의 하단 한 줄을 상태줄 전용으로 예약한 채 TUI 프로그램을 실행하는 네이티브 ConPTY 호스트입니다.

![Platform](https://img.shields.io/badge/platform-Windows%2010%201903%2B-blue)
![Language](https://img.shields.io/badge/language-C%23%205%20(.NET%20Framework%204.8)-512BD4)
![Build](https://img.shields.io/badge/build-in--box%20csc.exe%20(zero%20install)-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-none-lightgrey)

## Overview

WSL/Linux/macOS에서는 POSIX PTY로 "자식에게 화면을 한 줄 짧게 알리고, 실제 하단 행에 상태줄을 그리는" 구성이 잘 동작하지만, native Windows에는 같은 일을 해주는 도구가 없었습니다. rowpty는 [ai-battery](../ai-battery)의 Windows 하단 상태줄을 위해 만들어졌고, 상태줄이 필요한 어떤 명령에도 범용으로 쓸 수 있습니다.

기존 접근과의 비교:

| 접근 | 스크롤백 | 키 입력 | 출력 타이밍 | 상태줄 깜빡임 |
| --- | --- | --- | --- | --- |
| node-pty (ConPTY relay) | 유실 | DEL→BS 변형, vk 소실 | 키 입력 전까지 지연 | 프로세스 간 경쟁 |
| Overlay (같은 콘솔 덧그리기) | 정상 | 정상 | 정상 | TUI와 화면 경쟁, 프롬프트 침범 |
| **rowpty** | **정상** | **win32 키 이벤트 무손실** | **정상** | **전용 행이라 경쟁 없음** |

## Features

| 기능 | 설명 |
| --- | --- |
| Reserved bottom row | 자식은 `rows - N` 크기의 ConPTY에서 실행되어 하단 N행(기본 1)을 침범할 수 없습니다 |
| win32-input-mode 입력 전달 | 키 이벤트를 `ESC[Vk;Sc;Uc;Kd;Cs;Rc_` 프로토콜로 전달해 Enter/Backspace/수정키가 crossterm TUI(Codex CLI 등)에서 온전히 동작합니다 |
| Settle-timed painting | 자식 출력이 50ms(조정 가능) 잠잠해진 뒤에만 상태줄을 그려 깜빡임이 없습니다 |
| Lock-serialized writes | 출력 펌프와 페인터가 단일 프로세스에서 직렬화되어 이스케이프 시퀀스가 끊기지 않습니다 |
| Status command | 임의의 명령을 주기 실행해 stdout을 상태줄로 표시, `{MAXWIDTH}` 토큰으로 가용 폭 전달 |
| Resize / clear-screen 대응 | 창 크기 변화를 감지해 ConPTY를 리사이즈하고, 화면 클리어 시퀀스 후 상태줄을 복구합니다 |
| Exit-code passthrough | 자식의 종료 코드를 그대로 반환합니다 |

## Quick Start

1. 저장소를 받은 뒤 빌드합니다 (추가 설치 불필요 — Windows 내장 컴파일러 사용):
   ```
   build.cmd
   ```
2. `bin\rowpty.exe`가 생성됩니다.
3. 상태줄과 함께 프로그램을 실행합니다:
   ```
   rowpty.exe --interval 10 --status-cmd "cmd /d /c echo width={MAXWIDTH}" -- codex
   ```
4. ai-battery와 함께 쓰려면 exe를 검색 경로에 복사합니다:
   ```
   copy bin\rowpty.exe %LOCALAPPDATA%\ai-battery\bin\rowpty.exe
   ```
   또는 환경변수 `AI_BATTERY_ROWPTY`에 exe 경로를 지정합니다. 이후 `codex`를 실행하면 ai-battery runner가 rowpty를 자동으로 사용합니다 (`ai-battery doctor`로 인식 여부 확인).

## CLI Options

```
rowpty.exe [options] -- CHILD.exe [ARGS...]
```

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `--interval SECONDS` | 10 (최소 0.5) | 상태 명령 실행 주기 |
| `--reserve N` | 1 (1..5) | 하단에 예약할 행 수 |
| `--status-cmd CMD` | 없음 | 상태 텍스트를 출력하는 전체 명령줄. 실행 전 `{MAXWIDTH}`가 `cols - 4`로 치환됩니다 |
| `--settle-ms N` | 50 | 자식 출력이 잠잠해진 후 상태줄을 그리기까지의 대기 시간 |
| `--version` / `--help` | | |

종료 코드: 자식의 종료 코드를 그대로 반환. 사용법 오류 또는 stdin/stdout이 실제 콘솔이 아니면 `2`.

## How It Works

```
Windows Terminal / conhost  (실제 콘솔, UTF-8 + VT 모드)
  │
  ├─ stdin  ─ InputPump ──── ReadConsoleInputW (win32 KEY_EVENT)
  │                            │  vk=0 이벤트 복구 (CR/BS/TAB/ESC + VkKeyScanW)
  │                            ▼
  │                          ESC[Vk;Sc;Uc;Kd;Cs;Rc_  ──►  ConPTY input
  │                                                          │
  │                                              ┌───────────▼───────────┐
  │                                              │  ConPTY (cols × rows-N) │
  │                                              │  └─ CHILD (Codex 등)    │
  │                                              └───────────┬───────────┘
  ├─ stdout ◄─ OutputPump ◄──────────────────────  ConPTY output
  │              │  ?9001h/l 감지, clear-screen 감지
  └─ stdout ◄─ Painter ── 출력 settle 후 하단 행에 상태줄 (콘솔 쓰기 락 공유)
```

핵심 설계 판단 (자세한 근거는 [DESIGN.md](DESIGN.md)):

- ConPTY 입력 파이프에 평문 VT 바이트를 쓰면 안쪽 conhost가 **가상키코드 없는(vk=0) 키 이벤트**를 합성해 crossterm TUI가 Enter/Backspace를 인식하지 못합니다. Windows Terminal이 ConPTY에 쓰는 것과 동일한 **win32-input-mode 프로토콜**로 전달해 이를 해결했습니다.
- 상태줄 페인터와 자식 출력이 **같은 프로세스에서 락으로 직렬화**되므로, 별도 프로세스가 화면을 덧그리는 방식에서 발생하던 깜빡임·시퀀스 끼어들기가 구조적으로 불가능합니다.

## Tech Stack

| Layer | Technology | Role |
| --- | --- | --- |
| PTY | Win32 ConPTY (`CreatePseudoConsole`) | 자식을 `rows - N` 크기 가상 콘솔에 연결 |
| Input | `ReadConsoleInputW` + win32-input-mode | 키 이벤트 무손실 전달 |
| Output | pipe → `WriteFile` 단일 홉 | 릴레이 계층 없이 콘솔에 직접 출력 |
| Language | C# 5, .NET Framework 4.8 | 모든 Windows 10/11에 런타임 내장 |
| Build | `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` | 툴체인 설치 없이 단일 exe 생성 |
| Tests | Node.js + node-pty 하니스 | ConPTY 안에서 실기동 검증 |

## Testing

```
node test\smoke.mjs
```

ai-battery 체크아웃이 형제 디렉터리(`..\ai-battery`)에 있어야 합니다 (node-pty 하니스 사용). 14개 체크:

- 자식 stdout 통과, **입력 없이 지연 출력 도착** (ConPTY 출력 지연 회귀 감지)
- 상태 텍스트가 하단 행에 그려지고 `{MAXWIDTH}` 치환 확인
- VT 모드 자식(node)과 **win32 이벤트 자식(`test/Win32KeyProbe.cs`)** 양쪽에서 Enter=VK_RETURN, Backspace=VK_BACK 확인 — crossterm TUI가 보는 그대로를 검증하는 회귀 테스트
- 종료 코드 전파, 비콘솔 환경 거부(exit 2)

## Source Environment

- 실행: Windows 10 1903+ / Windows 11 (ConPTY API), 별도 런타임 불필요
- 빌드: Windows 내장 .NET Framework 4.8 `csc.exe` — `build.cmd` 하나로 완료
- 테스트: Node.js 18+ 및 형제 디렉터리의 ai-battery 체크아웃(node-pty 제공)
- 소스는 `src/RowPty.cs` 단일 파일, 외부 패키지 의존성 없음

## Caution

- stdin/stdout이 실제 콘솔이어야 합니다. 파이프/리다이렉트 환경에서는 exit 2로 거부하므로, 호출 측(ai-battery runner)이 overlay 등으로 폴백해야 합니다.
- 상태줄 행은 rowpty가 소유합니다. 자식이 전체 화면 좌표로 그리는 비정상적인 경우(자신이 통보받은 행 수를 무시)는 지원하지 않습니다.
- `?9001h`/clear-screen 감지는 출력 청크 단위 스캔이라 시퀀스가 청크 경계에 걸치는 극단적 경우 한 번 놓칠 수 있습니다. 상태줄은 다음 주기 갱신에서 복구됩니다.
- Windows 10 1903 미만(ConPTY 부재)에서는 실행되지 않습니다.
- 상태 명령은 1.5초 타임아웃으로 실행되며 초과 시 종료됩니다. 상태 명령이 실패해도 이전 텍스트를 유지합니다.
