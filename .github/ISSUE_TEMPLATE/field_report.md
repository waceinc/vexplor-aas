---
name: PLC field report (PLC 실기 확인 보고)
about: You read a real S7, MC (MELSEC) or XGT (LS ELECTRIC) PLC — tell us what you saw, right or wrong (한국어로 적어도 됩니다)
labels: field-report
---

<!-- Thank you. S7, MC and XGT are built from the published specifications and tested against test servers only —
     no real PLC was available. Your report is how a protocol becomes "checked on a real PLC".
     Security problem? Do not post it here — report it through SECURITY.md. -->

## PLC

- Protocol: <!-- S7 / MC / XGT -->
- Maker and series: <!-- e.g. Siemens S7-1500 · MELSEC iQ-R · LS ELECTRIC XGK -->
- CPU type: <!-- the type printed on the CPU, e.g. XGK-CPUH -->
- Firmware / OS version of the CPU:
- Communication module: <!-- built-in port, or the module type (e.g. XGL-EFMT) with its OS version -->
- Settings you changed on the PLC side: <!-- S7: PUT/GET on, optimized block access off · MC: port, binary, 3E · XGT: XGT server, host table -->

## How it was read

- VEXPLOR AAS Studio version (server) or VEXPLOR Edge version:
- Endpoint (`base`), with the host replaced: <!-- e.g. s7://PLC?rack=0&slot=1 · melsec://PLC:5000?series=iQ-R · xgt://PLC:2004?series=XGI -->

## Result

<!-- One row per address. Result: right / wrong / not read. For "not read", copy the reason the tool showed. -->

| Address (`href`) | Data type | Expected value (what the engineering tool shows) | Value read | Result | Reason shown |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## Packet capture (optional, very helpful)

<!-- A Wireshark capture of one read (filter: tcp.port == 102 / your MC port / 2004) shows exactly what the PLC answered.
     Before attaching, remove or replace what identifies your plant or equipment: IP and MAC addresses, host names,
     and any value that is a recipe, a customer or product name, or a serial number. If you cannot clean the file,
     paste only the bytes of one request and its answer as hex instead.
     Do not attach PLC programs or project files. -->

## Anything else
