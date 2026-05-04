<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  subctl dashboard launchd template.

  Placeholders substituted by the installer:
    __OWNER__      reverse-DNS prefix (e.g. com.example)
    __BUN__        absolute path to the bun binary (e.g. /opt/homebrew/bin/bun)
    __SERVER_TS__  absolute path to dashboard/server.ts
    __PORT__       port to listen on (e.g. 8787)
    __HOME__       absolute path to user's $HOME
-->
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>__OWNER__.subctl.dashboard</string>

    <key>ProgramArguments</key>
    <array>
        <string>__BUN__</string>
        <string>run</string>
        <string>__SERVER_TS__</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>__PORT__</string>
        <key>HOME</key>
        <string>__HOME__</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>__HOME__</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>NetworkState</key>
        <true/>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>ProcessType</key>
    <string>Background</string>

    <key>StandardOutPath</key>
    <string>__HOME__/Library/Logs/subctl/dashboard.out.log</string>

    <key>StandardErrorPath</key>
    <string>__HOME__/Library/Logs/subctl/dashboard.err.log</string>
</dict>
</plist>
