# Security policy

## Supported versions

Security fixes go into the latest release only. Please upgrade before reporting.

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/FireBolt922/ModbusOpen/security/advisories/new)
(Security tab → *Report a vulnerability*).

Include what you found, how to reproduce it, and what an attacker could do with it. You should get
a first response within a week. Once a fix is released, we'll credit you in the advisory unless
you'd rather stay anonymous.

## Scope

ModbusOpen talks to industrial devices, and Modbus itself has no authentication or encryption.
"Anyone on the network can read/write a Modbus device" is a property of the protocol, not a
vulnerability in this app. In scope, for example:

- Crashes, hangs or memory blow-ups from malformed Modbus frames sent by a device or simulator
- The app writing to a device without the user asking it to
- Unsafe handling of imported files (`.mbmeter.json`, session files)
- Issues in the release build or installer pipeline
