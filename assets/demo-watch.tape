Output assets/demo-watch.gif
Set Width 800
Set Height 640
Set FontSize 14
Set Padding 24
Set TypingSpeed 12ms
Set Theme "Dracula"
Set Framerate 24

Type "export KIMI_GUARD_HOME=/tmp/kg/guard"
Enter
Sleep 200ms
Type "export KIMI_CONFIG_PATH=/tmp/kg/config.toml"
Enter
Sleep 200ms
Type 'agentguard run "find all TODO markers" --exec env FAKE_SCENARIO=loop FAKE_STEP_DELAY_MS=1200 node test/wire/fake-kimi.mjs > /dev/null 2>&1 &'
Enter
Sleep 1200ms
Type "agentguard watch"
Enter
Sleep 9000ms
Type "q"
Sleep 600ms
Type "agentguard replay"
Enter
Sleep 2600ms
