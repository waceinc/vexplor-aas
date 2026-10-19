VEXPLOR AAS Studio — 현장 서버 설치 안내 (Linux)
==============================================

이 패키지는 공장 서버 한 대에 AAS Studio 와 시계열 DB 를 함께 올립니다(어느 버전인지는 이 쪽 위의 고지).
원격 수집기(VEXPLOR Edge)도 들어 있어, 같은 서버에서 PLC 를 읽게 할 수 있습니다.
인터넷이 없어도 설치됩니다(프로그램 이미지가 패키지 안에 있습니다).

준비물
------
- Linux 서버(x86_64, systemd) — 최소 사양과 디스크 산정은 현장설치.md
- Docker Engine 과 Compose 플러그인
    Ubuntu:  sudo apt install docker.io docker-compose-v2

설치 (명령 하나)
----------------
    tar xzf VEXPLOR-AAS-Studio-<버전>-linux.tar.gz
    cd VEXPLOR-AAS-Studio-<버전>-linux
    sudo ./install.sh                  # AAS Studio + TimescaleDB
    sudo ./install.sh --with-edge      # + 같은 서버의 원격 수집기

끝나면 화면에 주소와 첫 관리자 코드가 나옵니다. 브라우저에서 그 주소로 들어갑니다.
원격 수집기는 서버 화면(또는 관리 API)에서 읽을 목록을 승인해야 읽기 시작합니다.

평소 사용
---------
  상태:   cd /opt/vexplor-aas && docker compose ps
  기록:   docker compose logs -f app
  중지:   docker compose down        (자료는 남습니다)
  다시:   docker compose up -d
  재부팅하면 스스로 다시 올라옵니다.

새 버전으로 올릴 때는 새 패키지에서 같은 명령(sudo ./install.sh)을 다시 실행합니다.
설정(.env)과 자료는 그대로 남습니다.

Windows 서버용 안내는 추후 드립니다.
